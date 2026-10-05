require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { hostHeaderValidation } = require("@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js");
const { z } = require("zod");
const { buildAllowedHosts, installRequestObservability, mountMcpEndpoint } = require("./shared/http-runtime");
const { METHODS: TRAINING_LOAD_METHODS, METHOD_UNITS, addDays, computeTrainingLoad } = require("./training-load");

const DEFAULT_DATA_DIR = "/var/lib/health-mcp";
const VALID_TYPES = new Set(["steps", "heart_rate", "sleep", "workouts", "all"]);
const DATA_TYPES = ["current_status", "steps", "heart_rate", "sleep", "workouts", "daily_summary", "series", "body_battery", "training_load", "all"];
const TIME_RANGES = ["three_days", "today"];
const HEART_RATE_DETAILS = ["daily", "hourly"];
const TRAINING_LOAD_DETAILS = ["summary", "workouts"];
const MAX_READ_DAYS = 62;
const TZ = process.env.HEALTH_TZ || "Asia/Shanghai";

// Built once: the body battery walk asks for the local date every quarter hour of the whole history.
const LOCAL_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatLocalDate(date) {
  return LOCAL_DATE_FORMAT.format(date);
}

function validDate(value) {
  return parseDateDay(value) !== null;
}

function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function recordPath(dataDir, date) {
  if (!validDate(date)) throw new Error("date must be YYYY-MM-DD");
  return path.join(ensureDataDir(dataDir), `${date}.json`);
}

function writeRecordAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readRecord(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseDateDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const millis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(millis);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
    ? Math.floor(millis / 86400000) : null;
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function normalizeCycleConfig(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  if (body.enabled === false) return { enabled: false };
  if (body.enabled !== true) throw new Error("enabled must be true or false");
  const lastStart = String(body.last_start || "");
  const lastConfirmed = body.last_confirmed ? String(body.last_confirmed) : null;
  if (parseDateDay(lastStart) === null) throw new Error("last_start must be YYYY-MM-DD");
  if (lastConfirmed !== null && parseDateDay(lastConfirmed) === null) throw new Error("last_confirmed must be YYYY-MM-DD");
  const cycleLengthDays = normalizePositiveInteger(body.cycle_length_days, "cycle_length_days");
  const cyclePeriodDays = normalizePositiveInteger(body.cycle_period_days, "cycle_period_days");
  if (cyclePeriodDays > cycleLengthDays) throw new Error("cycle_period_days must not exceed cycle_length_days");
  return { enabled: true, last_start: lastStart, cycle_length_days: cycleLengthDays, cycle_period_days: cyclePeriodDays, ...(lastConfirmed === null ? {} : { last_confirmed: lastConfirmed }) };
}

function cyclePath(dataDir) { return path.join(ensureDataDir(dataDir), "cycle.json"); }
function readCycleConfig(dataDir) {
  const config = readRecord(cyclePath(dataDir), null);
  if (!config) return null;
  try { const normalized = normalizeCycleConfig(config); return normalized.enabled ? normalized : null; } catch { return null; }
}
function storeCycleConfig(dataDir, body) {
  const config = normalizeCycleConfig(body);
  if (!config.enabled) { try { fs.unlinkSync(cyclePath(dataDir)); } catch (error) { if (error.code !== "ENOENT") throw error; } return config; }
  writeRecordAtomic(cyclePath(dataDir), config);
  return config;
}
function cycleContextForDate(config, date) {
  if (!config || config.enabled !== true) return null;
  const targetDay = parseDateDay(date); const anchorDay = parseDateDay(config.last_start);
  const cycleLengthDays = Number(config.cycle_length_days); const cyclePeriodDays = Number(config.cycle_period_days);
  if (targetDay === null || anchorDay === null || !Number.isSafeInteger(cycleLengthDays) || cycleLengthDays <= 0 || !Number.isSafeInteger(cyclePeriodDays) || cyclePeriodDays <= 0 || cyclePeriodDays > cycleLengthDays) return null;
  const offset = ((targetDay - anchorDay) % cycleLengthDays + cycleLengthDays) % cycleLengthDays;
  const cycleStartDay = targetDay - offset;
  const confirmedDay = parseDateDay(config.last_confirmed);
  const confirmed = confirmedDay !== null && confirmedDay >= cycleStartDay && confirmedDay < cycleStartDay + cycleLengthDays;
  const periodDay = offset + 1;
  if (periodDay <= cyclePeriodDays) return { period_day: periodDay, confirmed };
  const daysUntilPeriod = cycleLengthDays - offset;
  return daysUntilPeriod <= 3 ? { days_until_period: daysUntilPeriod, confirmed } : null;
}

// Same shape of problem as the cycle config: the body profile is not day-scoped, so the server
// keeps one copy of it. It arrives inside a day body because that is the only authenticated channel
// the app has, and is hoisted straight back out into its own file here.
function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("profile must be an object");
  const profile = {};
  const heightCm = nullableNumber(raw.height_cm);
  const weightKg = nullableNumber(raw.weight_kg);
  const age = nullableNumber(raw.age);
  if (heightCm !== null) profile.height_cm = heightCm;
  if (weightKg !== null) profile.weight_kg = weightKg;
  if (age !== null) profile.age = age;
  if (typeof raw.gender === "string" && raw.gender) profile.gender = raw.gender;
  if (validDate(raw.birthday)) profile.birthday = String(raw.birthday);
  return profile;
}

function profilePath(dataDir) { return path.join(ensureDataDir(dataDir), "profile.json"); }

function storeProfile(dataDir, raw) {
  const profile = normalizeProfile(raw);
  const filePath = profilePath(dataDir);
  // The app repeats the profile on every day body of every run, so this would otherwise rewrite an
  // identical file several times per sync. normalizeProfile fixes the key order, so a plain string
  // compare tells an unchanged profile from an edited one.
  if (JSON.stringify(readRecord(filePath, null)) === JSON.stringify(profile)) {
    return profile;
  }
  writeRecordAtomic(filePath, profile);
  return profile;
}

function readProfile(dataDir) {
  const profile = readRecord(profilePath(dataDir), null);
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : null;
}

function normalizeSleepSession(rawSession) {
  if (!rawSession || typeof rawSession !== "object") return null;
  const endDate = new Date(rawSession.session_end_time || rawSession.end || "");
  const durationSeconds = Math.max(0, Number(rawSession.duration_seconds || 0));
  if (Number.isNaN(endDate.getTime()) || durationSeconds <= 0) return null;

  const stages = (Array.isArray(rawSession.stages) ? rawSession.stages : [])
    .map((stage) => {
      const start = new Date(stage.start_time || "");
      const end = new Date(stage.end_time || "");
      const seconds = Math.max(0, Number(stage.duration_seconds || 0));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
      return {
        stage: String(stage.stage || "unknown"),
        start: start.toISOString(),
        end: end.toISOString(),
        duration_seconds: seconds || Math.round((end - start) / 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));

  const explicitStart = new Date(rawSession.session_start_time || rawSession.start || "");
  const derivedStart = stages[0]?.start || new Date(endDate.getTime() - durationSeconds * 1000).toISOString();
  const start = Number.isNaN(explicitStart.getTime()) ? derivedStart : explicitStart.toISOString();
  const end = endDate.toISOString();
  return {
    session_key: `${end}|${Math.round(durationSeconds)}`,
    start,
    end,
    duration_min: Math.round(durationSeconds / 60),
    score: Number(rawSession.score || 0),
    stages,
  };
}

function sleepStageMetricKey(stage) {
  const name = String(stage ?? "").trim().toLowerCase();
  if (name === "1" || name === "3" || name === "7" || name.includes("awake") || name.includes("out_of_bed")) {
    return "awake_min";
  }
  // The app's fifth stage, tagged on the watch's own naps. No other bucket claims the name, so it
  // does not matter where it sits in the chain; without it a nap's minutes would be counted in the
  // day's sleep total but in no stage of it.
  if (name.includes("nap")) return "nap_min";
  if (name === "4" || name.includes("light")) return "light_min";
  if (name === "5" || name.includes("deep")) return "deep_min";
  if (name === "6" || name.includes("rem")) return "rem_min";
  return null;
}

function summarizeSleepSessions(sessions, updatedAt) {
  const summary = {
    duration_min: 0,
    deep_min: 0,
    light_min: 0,
    rem_min: 0,
    awake_min: 0,
    nap_min: 0,
    start: sessions[0]?.start || "",
    end: sessions[sessions.length - 1]?.end || "",
    score: 0,
    updatedAt,
  };
  let scored = 0;
  for (const session of sessions) {
    summary.duration_min += Number(session.duration_min || 0);
    if (session.score > 0) {
      summary.score += session.score;
      scored += 1;
    }
    for (const stage of session.stages || []) {
      const minutes = Math.round(Number(stage.duration_seconds || 0) / 60);
      const key = sleepStageMetricKey(stage.stage);
      if (key) summary[key] += minutes;
    }
  }
  summary.score = scored ? Math.round(summary.score / scored) : 0;
  return summary;
}

// Two sessions are the same night when their [start, end] spans overlap. A night that grew between
// uploads (a later fetch extended its tail) comes back with a later end; keyed on end|duration it
// would land beside the stored short version and be summed twice, so instead it replaces it. Truly
// separate sessions on one day (a nap and the night) do not overlap and are both kept.
function sleepSessionsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 较晚结束或捕获更多睡眠的版本更完整；同一起止、时长的补传则更新阶段和评分。
function moreCompleteSleepSession(a, b) {
  if (a.end !== b.end) return a.end > b.end ? a : b;
  if (a.start === b.start && a.duration_min === b.duration_min) return b;
  return Number(b.duration_min || 0) > Number(a.duration_min || 0) ? b : a;
}

function upsertSleepSession(sessions, incoming) {
  const overlapIndex = sessions.findIndex((existing) => sleepSessionsOverlap(existing, incoming));
  if (overlapIndex === -1) {
    sessions.push(incoming);
  } else {
    sessions[overlapIndex] = moreCompleteSleepSession(sessions[overlapIndex], incoming);
  }
}

function mergeSleepSessionsForDate(dataDir, date, incoming, updatedAt) {
  const filePath = recordPath(dataDir, date);
  const record = readRecord(filePath, { date });
  const stored = Array.isArray(record.sleep_sessions) ? record.sleep_sessions : [];
  // Rebuild through the same overlap rule so a file written by the old end|duration merge, which
  // could hold one night twice, heals itself the next time any data for its date arrives.
  const sessions = [];
  for (const session of stored) upsertSleepSession(sessions, session);
  for (const session of incoming) upsertSleepSession(sessions, session);
  record.sleep_sessions = sessions.sort((a, b) => a.end.localeCompare(b.end));
  record.sleep = summarizeSleepSessions(record.sleep_sessions, updatedAt);
  writeRecordAtomic(filePath, record);
  return record;
}

// 夜醒通知：睡眠阶段随 App 每次同步上传——后台按小时、解锁屏幕后立刻一次——所以夜里的清醒时段
// 当晚就能到服务器。MCP 客户端都是自己发起请求的拉取方，服务端把见过的夜醒事件记在
// wake-events.json 里，谁问就给谁；health_wait_for_wake 把请求挂住直到事件到达，于是拉取就成了推送。
// 阈值和等待时长在项目根目录的 wake-notify.json 里，每次调用重新读取。
const WAKE_NOTIFY_PARAMS_PATH = path.join(__dirname, "wake-notify.json");

function readWakeNotifyParams() {
  return JSON.parse(fs.readFileSync(WAKE_NOTIFY_PARAMS_PATH, "utf8"));
}

function wakeEventsPath(dataDir) { return path.join(ensureDataDir(dataDir), "wake-events.json"); }

function readWakeEventStore(dataDir) {
  return readRecord(wakeEventsPath(dataDir), { events: [] });
}

function sleepStageSeconds(stages, keys) {
  return stages.reduce((total, stage) => keys.has(sleepStageMetricKey(stage.stage)) ? total + Number(stage.duration_seconds || 0) : total, 0);
}

const SLEEPING_MIN_KEYS = new Set(["deep_min", "light_min", "rem_min"]);

function sleepSessionNight(session) { return formatLocalDate(new Date(session.end)); }

// 夜醒 = 一夜的睡眠里头、后面还接着睡眠的清醒时段。收尾那次醒来是起床不是夜醒，小睡也不算
// （它整段都是清醒推断出来的，本就没有「夜里」可言）。时长阈值不在这里判，留给读取时按当时的
// wake-notify.json 过滤，改了阈值对全部历史立刻生效。
function wakeEventsForSession(session) {
  const stages = Array.isArray(session.stages) ? session.stages : [];
  if (sleepStageSeconds(stages, SLEEPING_MIN_KEYS) === 0) return [];
  if (sleepStageSeconds(stages, new Set(["nap_min"])) > 0) return [];
  const night = sleepSessionNight(session);
  const events = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (sleepStageMetricKey(stage.stage) !== "awake_min") continue;
    const sleptAgain = stages.slice(index + 1).some((later) => SLEEPING_MIN_KEYS.has(sleepStageMetricKey(later.stage)));
    if (!sleptAgain) continue;
    events.push({
      id: `${night}|${stage.start}`,
      night,
      start: stage.start,
      end: stage.end,
      awake_minutes: Math.round(Number(stage.duration_seconds || 0) / 60),
    });
  }
  return events;
}

// 见过的事件不重发：同一夜每次同步都会重传，重传不是新的夜醒。首次见到的时间就是它的 received_at，
// seq 也一并保留，所以客户端带上次的 next_since 回来，只会拿到此后新收到的事件——同一次上传里的
// 多条也不会漏。这次上传碰到的夜以落盘结果为准，被修正掉的那条不留影子；别的夜原样不动。
function recordWakeEvents(dataDir, sessions, receivedAt) {
  const filePath = wakeEventsPath(dataDir);
  const store = readWakeEventStore(dataDir);
  const nights = new Set(sessions.map(sleepSessionNight));
  const events = store.events.filter((event) => !nights.has(event.night));
  const priorById = new Map(store.events.filter((event) => nights.has(event.night)).map((event) => [event.id, event]));
  let seq = store.events.reduce((max, event) => Math.max(max, event.seq), 0);
  let changed = events.length !== store.events.length;
  for (const event of sessions.flatMap((session) => wakeEventsForSession(session))) {
    const prior = priorById.get(event.id);
    if (prior) {
      events.push(prior);
      priorById.delete(event.id);
      continue;
    }
    seq += 1;
    events.push({ ...event, seq, received_at: receivedAt });
    changed = true;
  }
  if (!changed) return;
  writeRecordAtomic(filePath, { events: events.sort((a, b) => a.seq - b.seq) });
}

function wakeEventCursor(dataDir) {
  return readWakeEventStore(dataDir).events.reduce((max, event) => Math.max(max, event.seq), 0);
}

// 轮询文件而不是等进程内事件：上传端和 MCP server 谁先谁后、服务重启过几次，都不影响结果，
// 事件一旦落盘就有定论。
async function waitForWakeEvents(dataDir, { since, timeoutSeconds, pollIntervalSeconds }) {
  const params = readWakeNotifyParams();
  const cursor = since === undefined ? wakeEventCursor(dataDir) : since;
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const events = readWakeEventStore(dataDir).events
      .filter((event) => event.seq > cursor && event.awake_minutes >= params.min_awake_minutes);
    if (events.length) return { timed_out: false, since: cursor, next_since: events[events.length - 1].seq, events };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { timed_out: true, since: cursor, next_since: cursor, events: [] };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalSeconds * 1000, remainingMs)));
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function roundOrNull(value) {
  return value === null || value === undefined ? null : round1(value);
}

// SpO2, stress, HRV, skin temperature and resting heart rate all arrive as timestamped readings
// and are stored the same way: dedup on the ISO timestamp, so a re-sent window overwrites instead
// of appending. `extraFields` keeps the per-reading detail (stress level) alongside the value.
function mergeSeries(record, key, entries, updatedAt, extraFields = []) {
  if (!record[key] || !Array.isArray(record[key].samples)) {
    record[key] = { samples: [] };
  }
  const samples = record[key].samples;
  for (const entry of entries) {
    const ts = entry.timestamp || entry.ts || entry.time;
    const value = Number(entry.value);
    if (!ts || !Number.isFinite(value)) continue;
    let sample = samples.find((existing) => existing.ts === ts);
    if (!sample) {
      sample = { ts, value };
      samples.push(sample);
    } else {
      sample.value = value;
    }
    for (const field of extraFields) {
      if (entry[field] !== undefined) sample[field] = entry[field];
    }
  }
  samples.sort((a, b) => a.ts.localeCompare(b.ts));
  const values = samples.map((sample) => sample.value).filter(Number.isFinite);
  record[key].avg = values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  record[key].updatedAt = updatedAt;
}

// Whole-object entries keyed on their timestamp: one sleep report per night, one emotion or sleep
// apnea reading per slot, one workout per start time. A re-send replaces that slot instead of
// growing the list.
function mergeDatedList(record, key, entries) {
  if (!Array.isArray(record[key])) record[key] = [];
  for (const entry of entries) {
    const ts = entry.timestamp;
    if (!ts) continue;
    const index = record[key].findIndex((existing) => existing.timestamp === ts);
    if (index === -1) {
      record[key].push(entry);
    } else {
      record[key][index] = entry;
    }
  }
  record[key].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

// A later upload is the day's authoritative snapshot: a corrected (smaller) total replaces the
// stored one, so a bad reading washes out instead of being pinned forever by Math.max.
function mergeTotal(record, key, incoming, updatedAt) {
  record[key] = { total: incoming, updatedAt };
}

function latestSeriesValue(record, key) {
  const samples = record?.[key]?.samples;
  if (!Array.isArray(samples) || !samples.length) return null;
  return nullableNumber(samples[samples.length - 1].value);
}

function latestSleepStats(record) {
  const stats = record?.sleep_stats;
  return Array.isArray(stats) && stats.length ? stats[stats.length - 1] : null;
}

function mergeHealthData(dataDir, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  const date = body.date || formatLocalDate(new Date());
  const filePath = recordPath(dataDir, date);
  let current = readRecord(filePath, { date });
  if (!current.date) current.date = date;

  const type = body.type;
  const data = body.data || {};
  const now = new Date().toISOString();
  const sleepSessionsByDate = new Map();

  if (Array.isArray(body.sleep)) {
    for (const rawSession of body.sleep) {
      const session = normalizeSleepSession(rawSession);
      if (!session) continue;
      const sessionDate = formatLocalDate(new Date(session.end));
      if (!sleepSessionsByDate.has(sessionDate)) sleepSessionsByDate.set(sessionDate, []);
      sleepSessionsByDate.get(sessionDate).push(session);
    }
    const storedSessions = [];
    for (const [sessionDate, sessions] of sleepSessionsByDate) {
      const merged = mergeSleepSessionsForDate(dataDir, sessionDate, sessions, now);
      storedSessions.push(...merged.sleep_sessions);
    }
    // 从落盘后的会话推导，而不是从这次上传的原文：合并规则可能保留了更完整的那一版。
    recordWakeEvents(dataDir, storedSessions, now);
    if (sleepSessionsByDate.has(date)) {
      current = readRecord(filePath, current);
    } else if (current.sleep?.end) {
      const incomingEnds = new Set([...sleepSessionsByDate.values()].flat().map((session) => session.end));
      const oldEnd = new Date(current.sleep.end);
      if (!Number.isNaN(oldEnd.getTime()) && incomingEnds.has(oldEnd.toISOString())) {
        delete current.sleep;
        delete current.sleep_sessions;
      }
    }
  }

  if (type === "steps" || body.steps !== undefined) {
    if (Array.isArray(body.steps)) {
      // 带粒度的上传是本地截至当前的整日快照；重建可移除旧粒度桶和已纠正的零步数桶。
      if (body.steps_bucket_seconds !== undefined) {
        current.steps = { samples: [], bucket_seconds: normalizePositiveInteger(body.steps_bucket_seconds, "steps_bucket_seconds") };
      }
      mergeSeries(current, "steps", body.steps, now);
      // mergeSeries publishes a mean, and for steps that would read as a per-bucket average next to
      // every other series' per-day one. The figure that means something here is the day's sum.
      delete current.steps.avg;
      current.steps.total = current.steps.samples.reduce((sum, sample) => sum + sample.value, 0);
    } else {
      const value = type === "steps" ? data : (body.steps || {});
      current.steps = { total: Number(value.total || value.count || value.value || 0), updatedAt: now };
    }
  }

  if (type === "heart_rate" || body.heart_rate !== undefined) {
    if (!current.heart_rate) current.heart_rate = { samples: [] };
    if (!Array.isArray(current.heart_rate.samples)) current.heart_rate.samples = [];
    const entries = Array.isArray(body.heart_rate)
      ? body.heart_rate
      : [(type === "heart_rate" ? data : (body.heart_rate || {}))];
    for (const entry of entries) {
      const ts = entry.timestamp || entry.ts || entry.time || now;
      const bpm = Number(entry.value || entry.bpm || 0);
      // A re-sent reading replaces the one already stored for that timestamp instead of being
      // ignored: the app always sends the day from local midnight, so a reading that changed
      // between uploads arrives again, and the later value is the one worth keeping.
      const existing = current.heart_rate.samples.find((sample) => sample.ts === ts);
      if (bpm > 0) {
        if (existing) existing.bpm = bpm;
        else current.heart_rate.samples.push({ ts, bpm });
      }
      if (entry.resting || entry.resting_bpm) {
        current.heart_rate.resting = Number(entry.resting || entry.resting_bpm);
      }
    }
    current.heart_rate.samples.sort((a, b) => a.ts.localeCompare(b.ts));
    const bpms = current.heart_rate.samples.map((sample) => sample.bpm).filter((bpm) => bpm > 0);
    if (bpms.length) current.heart_rate.avg = Math.round(bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length);
    current.heart_rate.updatedAt = now;
  }

  for (const caloriesType of ["active_calories", "total_calories"]) {
    if (body[caloriesType] !== undefined) {
      const total = Array.isArray(body[caloriesType])
        ? body[caloriesType].reduce((sum, entry) => sum + Number(entry.calories || 0), 0)
        : Number(body[caloriesType].total || body[caloriesType].count || body[caloriesType].value || 0);
      mergeTotal(current, caloriesType, total, now);
    }
  }
  if (body.distance !== undefined) {
    mergeTotal(current, "distance", Number(body.distance.total || 0), now);
  }
  if (type === "calories" || type === "active_calories") {
    if (!current.active_calories) current.active_calories = { total: 0, updatedAt: now };
    current.active_calories.total += Number(data.calories || data.total || 0);
    current.active_calories.updatedAt = now;
  }

  for (const [key, extraFields] of [
    ["spo2", []],
    ["stress", ["level"]],
    ["hrv", []],
    ["temperature", []],
    ["resting_heart_rate", []],
  ]) {
    if (Array.isArray(body[key])) mergeSeries(current, key, body[key], now, extraFields);
  }
  for (const key of ["sleep_stats", "emotions", "sleep_apnea", "workouts"]) {
    if (Array.isArray(body[key])) mergeDatedList(current, key, body[key]);
  }
  if (Array.isArray(body.heart_rate_coverage)) {
    // 原始活动历史的整日覆盖快照，不是佩戴状态或所有传感器同步完成的证明。
    current.heart_rate_coverage = body.heart_rate_coverage.map(({ timestamp, end_time, status }) => {
      const start = Date.parse(timestamp); const end = Date.parse(end_time);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !["observed", "missing"].includes(status)) {
        throw new Error("heart_rate_coverage requires timestamp < end_time and status observed or missing");
      }
      return { timestamp: new Date(start).toISOString(), end_time: new Date(end).toISOString(), status };
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  if (body.profile !== undefined) storeProfile(dataDir, body.profile);

  if (type === "sleep" || (body.sleep !== undefined && !Array.isArray(body.sleep))) {
    const value = type === "sleep" ? data : (body.sleep || {});
    current.sleep = {
      duration_min: Number(value.duration_min || value.duration || 0),
      deep_min: Number(value.deep_min || value.deep || 0),
      light_min: Number(value.light_min || value.light || 0),
      rem_min: Number(value.rem_min || value.rem || 0),
      awake_min: Number(value.awake_min || value.awake || 0),
      start: value.start || value.startTime || "",
      end: value.end || value.endTime || "",
      score: Number(value.score || 0),
      updatedAt: now,
    };
  }

  writeRecordAtomic(filePath, current);
  return current;
}

function readHealthRecords(dataDir, days, type, now = new Date()) {
  const records = [];
  const cycleConfig = readCycleConfig(dataDir);
  for (let index = 0; index < days; index += 1) {
    const dateValue = new Date(now);
    dateValue.setDate(dateValue.getDate() - index);
    const date = formatLocalDate(dateValue);
    const filePath = recordPath(dataDir, date);
    if (!fs.existsSync(filePath)) continue;
    const record = readRecord(filePath, null);
    if (!record) continue;
    const cycle = cycleContextForDate(cycleConfig, record.date || date);
    if (type && type !== "all") {
      const filtered = { date: record.date || date };
      if (record[type]) filtered[type] = record[type];
      if (type === "sleep" && record.sleep_sessions) filtered.sleep_sessions = record.sleep_sessions;
      if (cycle) filtered.cycle = cycle;
      records.push(filtered);
    } else {
      if (cycle) record.cycle = cycle;
      records.push(record);
    }
  }
  return records;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function latestSample(record) {
  return (record?.heart_rate?.samples || [])
    .map((sample) => ({ time: new Date(sample.ts || sample.timestamp || sample.time || ""), value: nullableNumber(sample.bpm ?? sample.value) }))
    .filter((sample) => !Number.isNaN(sample.time.getTime()) && sample.value !== null)
    .sort((a, b) => a.time - b.time).at(-1)?.value ?? null;
}

function heartRateSummary(record) {
  const values = (record?.heart_rate?.samples || []).map((sample) => nullableNumber(sample.bpm ?? sample.value)).filter((value) => value !== null);
  return {
    hr_max: values.length ? Math.max(...values) : null,
    hr_min: values.length ? Math.min(...values) : null,
    hr_avg: nullableNumber(record?.heart_rate?.avg) ?? (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null),
    hr_resting: nullableNumber(record?.heart_rate?.resting),
  };
}

function dailySummary(record) {
  return {
    date: record.date,
    steps: nullableNumber(record?.steps?.total),
    calories: nullableNumber(record?.active_calories?.total ?? record?.total_calories?.total),
    distance_m: nullableNumber(record?.distance?.total),
    ...heartRateSummary(record),
    resting_hr: nullableNumber(record?.resting_heart_rate?.avg) ?? nullableNumber(record?.heart_rate?.resting),
    stress_avg: nullableNumber(record?.stress?.avg),
    spo2_avg: nullableNumber(record?.spo2?.avg),
    hrv_avg: nullableNumber(record?.hrv?.avg),
    temperature_avg: nullableNumber(record?.temperature?.avg),
    sleep_score: nullableNumber(latestSleepStats(record)?.sleep_score),
    // The night's report goes out whole rather than field by field: its names are the watch's own,
    // and the app writes only what the watch reported, so passing it through shows the assistant
    // every figure the watch sent and promises none it did not. Null, not an empty object, on a day
    // the watch sent no report for.
    sleep_stats: latestSleepStats(record),
    sleep: record.sleep ? {
      duration_min: nullableNumber(record.sleep.duration_min), deep_min: nullableNumber(record.sleep.deep_min),
      light_min: nullableNumber(record.sleep.light_min), rem_min: nullableNumber(record.sleep.rem_min),
      awake_min: nullableNumber(record.sleep.awake_min), nap_min: nullableNumber(record.sleep.nap_min),
      score: nullableNumber(record.sleep.score),
    } : null,
  };
}

function formatLocalClock(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function sleepSession(record, session) {
  const stages = Array.isArray(session.stages) ? session.stages : [];
  const stageMinutes = (names) => stages.reduce((total, stage) => String(stage.stage ?? "").toLowerCase() && names.some((name) => String(stage.stage ?? "").toLowerCase() === name || String(stage.stage ?? "").toLowerCase().includes(name)) ? total + Math.round(Number(stage.duration_seconds || 0) / 60) : total, 0);
  const deep = stageMinutes(["5", "deep"]); const light = stageMinutes(["4", "light"]); const rem = stageMinutes(["6", "rem"]); const awake = stageMinutes(["1", "3", "7", "awake", "out_of_bed"]);
  const nap = stageMinutes(["nap"]);
  const duration = nullableNumber(session.duration_min) ?? 0;
  // A session the watch tagged as a nap is one, whatever its stage mix looks like. The awake-only
  // rule stays for sources that carry no nap tag: theirs is inferred from a session spent entirely
  // awake. A nap reports no deep, light or rem of its own, and the day's totals must not stand in
  // for them, or the whole night's stages would be read back as this nap's.
  const isNap = nap > 0 || (awake > 0 && deep === 0 && light === 0 && rem === 0);
  const result = { type: isNap ? "nap" : "sleep", start: formatLocalClock(session.start), end: formatLocalClock(session.end), total_minutes: duration, duration_text: `${Math.floor(duration / 60)}h ${duration % 60}min` };
  if (isNap) return result;
  // A session that carries stages is summed from them — a zero here is the watch saying it spent no
  // time in that stage tonight, never another session's figure standing in. The awake minutes are
  // what only a session can give: the summary has them by the day, and the day is not the night.
  if (!stages.length) return Object.assign(result, { deep_sleep_minutes: nullableNumber(record?.sleep?.deep_min) || 0, light_sleep_minutes: nullableNumber(record?.sleep?.light_min) || 0, rem_sleep_minutes: nullableNumber(record?.sleep?.rem_min) || 0, awake_minutes: nullableNumber(record?.sleep?.awake_min) || 0 });
  return Object.assign(result, { deep_sleep_minutes: deep, light_sleep_minutes: light, rem_sleep_minutes: rem, awake_minutes: awake });
}

function sleepSessions(records) {
  return records.flatMap((record) => {
    const sessions = Array.isArray(record.sleep_sessions) && record.sleep_sessions.length ? record.sleep_sessions : (record.sleep?.start || record.sleep?.end ? [record.sleep] : []);
    return sessions.map((session) => ({ session: sleepSession(record, session), end: new Date(session.end || "").getTime() }));
  }).sort((a, b) => b.end - a.end).map(({ session }) => session);
}

// The watch's own report for each night, newest first, beside the sessions. It is the only place the
// times a stage-only session cannot show live — the night the watch was gone to bed, the time it
// took to fall asleep, the waking and rising times — so a sleep read carries it rather than making
// the assistant ask for it under another data type.
function sleepStatsList(records) {
  return records
    .flatMap((record) => (Array.isArray(record.sleep_stats) ? record.sleep_stats : []))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// The aggregates a workout carries, under the names the app writes them: totals, heart rate and the
// time it spent in each zone, then what the watch derived from the session. Each name says its own
// unit, so they are passed through as they arrive.
//
// These are the metrics the watch that fills a workout row actually reports. The running form, swim,
// jump rope, power and elevation entries the app's summary class also defines belong to watches with
// sensors this one has not got, and copying them here would only promise the assistant fields that
// never arrive.
const WORKOUT_AGGREGATES = [
  "distance_m", "calories", "steps", "active_seconds",
  "avg_heart_rate", "max_heart_rate", "min_heart_rate",
  "hr_zone_warm_up_seconds", "hr_zone_fat_burn_seconds", "hr_zone_aerobic_seconds",
  "hr_zone_anaerobic_seconds", "hr_zone_extreme_seconds",
  "workout_load", "aerobic_training_effect", "recovery_time_hours",
];

// Pace and step rate share one key across sports but not one unit — seconds per km on land, seconds
// per 100 m in the water — so the app ends their name in the unit it stored. Whatever unit arrived
// is the one that goes back out.
const WORKOUT_UNIT_NAMED = ["avg_pace_", "max_pace_", "avg_step_rate_"];

// One workout as the assistant reads it: the span, then whichever aggregates the watch reported.
// The app leaves a metric out entirely when it was never measured, so an absent one stays absent
// here instead of coming back as a zero that reads like a measured value. The zones are the
// exception the app does send a zero for: the watch splits every workout it has a heart rate for
// across all five, so a zero there means it measured no time in that zone.
function workoutEntry(entry) {
  const minutes = Math.round(Number(entry.duration_seconds || 0) / 60);
  const result = {
    type: String(entry.activity || "unknown"),
    start: formatLocalClock(entry.timestamp),
    end: formatLocalClock(entry.end_time),
    duration_minutes: minutes,
    duration_text: `${Math.floor(minutes / 60)}h ${minutes % 60}min`,
  };
  if (entry.name) result.name = entry.name;
  // The only value dropped here is one that is not a number at all.
  const aggregates = [
    ...WORKOUT_AGGREGATES,
    ...Object.keys(entry).filter((key) => WORKOUT_UNIT_NAMED.some((prefix) => key.startsWith(prefix))),
  ];
  for (const key of aggregates) {
    const value = nullableNumber(entry[key]);
    if (value !== null) result[key] = value;
  }
  return result;
}

function workoutEntries(records) {
  return records
    .flatMap((record) => (Array.isArray(record.workouts) ? record.workouts : []))
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .map(workoutEntry);
}

// Every timestamped series a day file holds, under the keys it stores them as. This is the raw
// material an assistant needs to integrate its own curve — e.g. stress against the sleep window —
// which the per-day aggregates elsewhere in this file have already averaged away.
const SERIES_KEYS = ["steps", "heart_rate", "resting_heart_rate", "spo2", "stress", "hrv", "temperature"];

// Whole-object readings the day file keeps as plain arrays rather than samples, one entry per slot
// the watch reported. Their field names and shapes are the watch's own — an emotion's valence and
// arousal, an apnea reading's level, a night's sleep figures — so they come through as they were
// sent. A series the day holds no entry for stays absent, like the ones above it.
const DATED_LIST_KEYS = ["sleep_stats", "emotions", "sleep_apnea", "workouts", "heart_rate_coverage"];

function seriesForRecord(record) {
  const day = { date: record.date };
  if (record.steps?.bucket_seconds !== undefined) day.steps_bucket_seconds = record.steps.bucket_seconds;
  for (const key of SERIES_KEYS) {
    const samples = record[key]?.samples;
    if (Array.isArray(samples) && samples.length) day[key] = samples;
  }
  for (const key of DATED_LIST_KEYS) {
    if (Array.isArray(record[key]) && record[key].length) day[key] = record[key];
  }
  if (Array.isArray(record.sleep_sessions) && record.sleep_sessions.length) {
    // session_key is the storage-side dedup key, not something the watch reported.
    day.sleep_sessions = record.sleep_sessions.map(({ session_key, ...session }) => session);
  }
  return day;
}

function hourlyHeartRateSummaries(records) {
  const buckets = new Map();
  for (const record of records) for (const sample of record?.heart_rate?.samples || []) {
    const value = nullableNumber(sample.bpm ?? sample.value); const date = new Date(sample.ts || sample.timestamp || sample.time || "");
    if (value === null || Number.isNaN(date.getTime())) continue;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(date).reduce((result, part) => { result[part.type] = part.value; return result; }, {});
    const hour = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00`;
    if (!buckets.has(hour)) buckets.set(hour, []); buckets.get(hour).push(value);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, values]) => ({ hour, hr_max: Math.max(...values), hr_min: Math.min(...values), hr_avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), sample_count: values.length }));
}

// Body battery: a Garmin-style energy reserve walked minute by minute from the first night on record,
// never reset. Every rate and threshold lives in body-battery.json at the project root and is read on
// each call, so a tuned value applies to the whole history at once.
const BODY_BATTERY_PARAMS_PATH = path.join(__dirname, "body-battery.json");
// 最大心率只有这一份，身体电量和训练负荷都读它，两个算法不各存一个值。
const HEART_RATE_PARAMS_PATH = path.join(__dirname, "heart-rate.json");
const TRAINING_LOAD_PARAMS_PATH = path.join(__dirname, "training-load.json");
const MINUTE_MS = 60000;

function readMaxHeartRate() {
  return JSON.parse(fs.readFileSync(HEART_RATE_PARAMS_PATH, "utf8")).max_heart_rate;
}
const BODY_BATTERY_EVENTS = ["sleep", "activity", "unworn", "data_gap", "high_stress"];

// Only the readings the walk needs, pulled out of each day file as it is read, so a year of history
// never sits in memory as whole records.
function readBodyBatteryInputs(dataDir) {
  const heartRate = []; const workoutHeartRate = new Map(); const heartRateCoverage = [];
  const stress = []; const restingByDate = new Map(); const sleeps = []; const steps = [];
  let observedMaxHeartRate = 0;
  const files = fs.readdirSync(dataDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  for (const name of files) {
    const record = readRecord(path.join(dataDir, name), null);
    for (const sample of record.heart_rate?.samples || []) {
      heartRate.push([Date.parse(sample.ts), sample.bpm]);
      observedMaxHeartRate = Math.max(observedMaxHeartRate, sample.bpm);
    }
    for (const workout of record.workouts || []) {
      if (Number.isFinite(workout.max_heart_rate)) observedMaxHeartRate = Math.max(observedMaxHeartRate, workout.max_heart_rate);
      // 恢复心率仍随运动开始日存储，不能按 end_time 截断；全历史按实际时间排序。
      for (const sample of workout.heart_rate || []) {
        const t = Date.parse(sample.timestamp); const bpm = Number(sample.value);
        if (Number.isFinite(t) && Number.isFinite(bpm) && bpm > 0) {
          workoutHeartRate.set(t, bpm);
          observedMaxHeartRate = Math.max(observedMaxHeartRate, bpm);
        }
      }
    }
    for (const interval of record.heart_rate_coverage || []) {
      heartRateCoverage.push({ start: Date.parse(interval.timestamp), end: Date.parse(interval.end_time), status: interval.status });
    }
    for (const sample of record.stress?.samples || []) stress.push([Date.parse(sample.ts), sample.value]);
    // 只有走过路才算活动证据；静止桶的零增量不进列表。
    for (const sample of record.steps?.samples || []) {
      const t = Date.parse(sample.ts); const value = Number(sample.value);
      if (Number.isFinite(t) && Number.isFinite(value) && value > 0) steps.push([t, value]);
    }
    // The day's latest resting figure stands for the whole local day (Q29).
    const resting = (record.resting_heart_rate?.samples || []).reduce((latest, sample) => (!latest || Date.parse(sample.ts) > Date.parse(latest.ts) ? sample : latest), null);
    if (resting) restingByDate.set(record.date, resting.value);
    for (const session of record.sleep_sessions || []) {
      sleeps.push({
        start: Date.parse(session.start),
        end: Date.parse(session.end),
        awake: session.stages.filter((stage) => sleepStageMetricKey(stage.stage) === "awake_min").map((stage) => [Date.parse(stage.start), Date.parse(stage.end)]),
      });
    }
  }
  const byTime = (a, b) => a[0] - b[0];
  return {
    heartRate: heartRate.sort(byTime), workoutHeartRate: [...workoutHeartRate].sort(byTime),
    heartRateCoverage: heartRateCoverage.sort((a, b) => a.start - b.start),
    stress: stress.sort(byTime), steps: steps.sort(byTime),
    restingByDate, sleeps: sleeps.sort((a, b) => a.start - b.start), observedMaxHeartRate,
  };
}

// 从第一晚入睡积分到最后一条数据，始终计算 [t, next) 的实际时长。
// 每分钟内再按读数、有效期和睡眠阶段边界切分，状态点表示已经积分到该时刻。
function walkBodyBattery(inputs, params) {
  const { heartRate, workoutHeartRate = [], heartRateCoverage = [], stress, steps = [], restingByDate, sleeps } = inputs;
  const restingDates = [...restingByDate.keys()].sort();
  const wakingDates = sleeps.map((session) => formatLocalDate(new Date(session.end)));
  const start = sleeps[0].start;
  const end = Math.max(heartRate.at(-1)?.[0] ?? 0, workoutHeartRate.at(-1)?.[0] ?? 0, stress.at(-1)?.[0] ?? 0,
    ...sleeps.map((session) => session.end), heartRateCoverage.reduce((latest, interval) => Math.max(latest, interval.end), 0));
  const curveMs = params.curve_interval_minutes * MINUTE_MS;
  let level = params.initial_level;
  let hrIndex = 0; let workoutIndex = 0; let coverageIndex = 0; let stressIndex = 0; let sleepIndex = 0; let restingIndex = -1; let stepIndex = 0;
  let lastHr = null; let lastWorkoutHr = null; let lastStress = null; let lastStep = null; let silentSince = null; let date = null;
  let intervalEstimated = false;
  const estimation = { minutes: 0, charged: 0, drained: 0 };
  const contributions = {};
  const days = new Map(); const curve = [{ t: start, level, estimated: false, interval_estimated: false }]; const events = []; const open = {};
  const close = (run, endMs, to) => {
    if (run.type === "high_stress" && endMs - run.start < params.high_stress_min_minutes * MINUTE_MS) return;
    events.push({ type: run.type, start: run.start, end: endMs, change: round1(to - run.from), ...(run.reason ? { reason: run.reason } : {}) });
  };

  for (let t = start; t < end;) {
    while (hrIndex < heartRate.length && heartRate[hrIndex][0] <= t) lastHr = heartRate[hrIndex++];
    while (workoutIndex < workoutHeartRate.length && workoutHeartRate[workoutIndex][0] <= t) lastWorkoutHr = workoutHeartRate[workoutIndex++];
    while (coverageIndex < heartRateCoverage.length && heartRateCoverage[coverageIndex].end <= t) coverageIndex += 1;
    const coverage = heartRateCoverage[coverageIndex]?.start <= t ? heartRateCoverage[coverageIndex] : null;
    while (stressIndex < stress.length && stress[stressIndex][0] <= t) lastStress = stress[stressIndex++];
    while (stepIndex < steps.length && steps[stepIndex][0] <= t) lastStep = steps[stepIndex++];
    while (sleepIndex < sleeps.length && sleeps[sleepIndex].end <= t) sleepIndex += 1;
    const session = sleeps[sleepIndex]?.start <= t ? sleeps[sleepIndex] : null;
    const asleep = session !== null && !session.awake.some(([from, to]) => from <= t && t < to);
    // 步长经过每个整分钟；时区偏移为整刻钟，当地日期也只在整刻钟边界变化。
    if (date === null || t % (15 * MINUTE_MS) === 0) date = formatLocalDate(new Date(t));
    while (restingIndex + 1 < restingDates.length && restingDates[restingIndex + 1] <= date) restingIndex += 1;

    const workoutExpires = lastWorkoutHr === null ? t : lastWorkoutHr[0] + params.workout_heart_rate_hold_seconds * 1000;
    const workoutFresh = t < workoutExpires;
    // 沿用历史配置键；它同时是普通心率有效期和步数活动的有效期，两者都过期才判离腕。
    const ordinaryExpires = lastHr === null ? t : lastHr[0] + params.unworn_after_minutes * MINUTE_MS;
    // 高频点过期后只用更新的普通点。missing 可来自智能采样间隙，不缩短普通点的有效期。
    const ordinaryFresh = lastHr !== null && t < ordinaryExpires
      && (lastWorkoutHr === null || lastHr[0] > lastWorkoutHr[0]);
    const selectedHr = workoutFresh ? lastWorkoutHr : ordinaryFresh ? lastHr : null;
    const hrFresh = selectedHr !== null;
    const hrExpires = workoutFresh ? workoutExpires : ordinaryExpires;
    const stressExpires = lastStress === null ? t : lastStress[0] + params.stress_hold_minutes * MINUTE_MS;
    const stressFresh = t < stressExpires;
    // 手环没有离腕模式：无心率读数、且阈值内也没有步数活动，两条证据都缺失。短暂的抖动不判离腕，
    // 静默连续超过 unworn_min_minutes 才认定为未佩戴。
    const stepExpires = lastStep === null ? t : lastStep[0] + params.unworn_after_minutes * MINUTE_MS;
    const stepFresh = lastStep !== null && t < stepExpires;
    const silent = !hrFresh && !stepFresh;
    if (silent) { if (silentSince === null) silentSince = t; } else silentSince = null;
    const unworn = silentSince !== null && t - silentSince >= params.unworn_min_minutes * MINUTE_MS;
    // 只平滑阈值附近：区间外保持原恢复/耗损速率，不整体平移高压力区的消耗。
    let pressureDelta = 0;
    if (stressFresh) {
      const score = lastStress[1];
      const charge = (asleep ? params.sleep_charge_per_stress_point : params.rest_charge_per_stress_point) * Math.max(0, params.stress_threshold - score);
      const weight = Math.min(1, Math.max(0, (score - params.stress_threshold + params.stress_transition_half_width) / (2 * params.stress_transition_half_width)));
      pressureDelta = (1 - weight) * charge - weight * params.stress_drain_per_stress_point * score;
    }
    const stressDrain = Math.max(0, -pressureDelta);
    let state; let delta; let gapReason = null;
    if (unworn) {
      // 离腕期间电量保持不变，既不充电也不消耗，也不计入缺测估算。
      state = "unworn"; delta = 0;
    } else if (!hrFresh) {
      gapReason = coverage?.status === "missing" ? "heart_rate_missing" : "heart_rate_unavailable";
      state = gapReason; delta = -params.low_intensity_drain_per_minute;
    } else {
      // 睡眠会话（含夜醒）取醒来日静息心率，清醒区间沿用当日或最近历史值。
      const restingDate = session ? wakingDates[sleepIndex] : restingDates[restingIndex];
      const resting = restingByDate.get(restingDate);
      if (resting === undefined) throw new Error(`身体电量缺少 ${session ? wakingDates[sleepIndex] : date} 的静息心率数据`);
      const reserve = (selectedHr[1] - resting) / (params.max_heart_rate - resting);
      if (!stressFresh) gapReason = "stress_unavailable";
      if (reserve > params.activity_reserve_threshold) {
        const activityDrain = Math.max(params.low_intensity_drain_per_minute, params.activity_drain_per_reserve * (reserve - params.activity_reserve_threshold));
        state = "activity"; delta = -Math.max(activityDrain, stressDrain);
      } else if (!stressFresh) {
        state = "stress_unavailable"; delta = -params.low_intensity_drain_per_minute;
      } else {
        state = pressureDelta > 0 ? (asleep ? "sleep_recovery" : "rest_recovery") : "stress";
        delta = pressureDelta;
      }
    }

    const flags = { sleep: session !== null, activity: state === "activity", unworn, data_gap: gapReason !== null, high_stress: !unworn && stressFresh && lastStress[1] >= params.high_stress_level };
    for (const type of BODY_BATTERY_EVENTS) {
      const reason = type === "data_gap" ? gapReason : null;
      if (open[type] && (!flags[type] || open[type].reason !== reason)) { close(open[type], t, level); open[type] = null; }
      if (flags[type] && !open[type]) open[type] = { type, reason, start: t, from: level };
    }

    let next = Math.min(end, (Math.floor(t / MINUTE_MS) + 1) * MINUTE_MS, (Math.floor(t / curveMs) + 1) * curveMs);
    if (hrIndex < heartRate.length) next = Math.min(next, heartRate[hrIndex][0]);
    if (workoutIndex < workoutHeartRate.length) next = Math.min(next, workoutHeartRate[workoutIndex][0]);
    if (coverage) next = Math.min(next, coverage.end);
    else if (coverageIndex < heartRateCoverage.length) next = Math.min(next, heartRateCoverage[coverageIndex].start);
    if (stressIndex < stress.length) next = Math.min(next, stress[stressIndex][0]);
    if (stepIndex < steps.length) next = Math.min(next, steps[stepIndex][0]);
    if (hrFresh) next = Math.min(next, hrExpires);
    if (stressFresh) next = Math.min(next, stressExpires);
    if (stepFresh) next = Math.min(next, stepExpires);
    if (silent && !unworn) next = Math.min(next, silentSince + params.unworn_min_minutes * MINUTE_MS);
    if (session) {
      next = Math.min(next, session.end);
      for (const [from, to] of session.awake) {
        if (from > t) next = Math.min(next, from);
        if (to > t) next = Math.min(next, to);
      }
    } else if (sleepIndex < sleeps.length) next = Math.min(next, sleeps[sleepIndex].start);

    const before = level; const minutes = (next - t) / MINUTE_MS;
    level = Math.min(params.max_level, Math.max(params.min_level, level + delta * minutes));
    const charged = Math.max(0, level - before); const drained = Math.max(0, before - level);
    if (!days.has(date)) days.set(date, { date, max: before, min: before, charged: 0, drained: 0, estimated_minutes: 0 });
    const day = days.get(date);
    day.max = Math.max(day.max, level); day.min = Math.min(day.min, level);
    day.charged += charged; day.drained += drained;
    if (!contributions[state]) contributions[state] = { minutes: 0, charged: 0, drained: 0 };
    contributions[state].minutes += minutes; contributions[state].charged += charged; contributions[state].drained += drained;
    if (gapReason !== null) {
      estimation.minutes += minutes; estimation.charged += charged; estimation.drained += drained;
      day.estimated_minutes += minutes; intervalEstimated = true;
    }
    if (next % curveMs === 0 || next === end) {
      curve.push({ t: next, level, estimated: estimation.minutes > 0, interval_estimated: intervalEstimated });
      intervalEstimated = false;
    }
    t = next;
  }
  for (const type of BODY_BATTERY_EVENTS) if (open[type]) close(open[type], end, level);
  return { level, start, end, estimation, contributions, days: [...days.values()], curve, events: events.sort((a, b) => a.start - b.start) };
}

function formatBodyBatteryClock(ms) {
  const clock = formatLocalClock(ms);
  return ms % MINUTE_MS === 0 ? clock : `${clock}:${new Date(ms).toISOString().slice(17, 23).replace(/\.000$/, "")}`;
}

function bodyBattery(dataDir, days) {
  const params = { ...JSON.parse(fs.readFileSync(BODY_BATTERY_PARAMS_PATH, "utf8")), max_heart_rate: readMaxHeartRate() };
  const inputs = readBodyBatteryInputs(dataDir);
  // The walk starts at the first night's sleep; before one is on record there is no battery yet.
  if (!inputs.sleeps.length) return null;
  const walk = walkBodyBattery(inputs, params);
  // The history is always walked whole; `days` only picks how many local days of it are shown.
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fromDate = formatLocalDate(since);
  const shown = (ms) => formatLocalDate(new Date(ms)) >= fromDate;
  const rounded = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round1(value)]));
  return {
    level: Math.round(walk.level),
    as_of: formatBodyBatteryClock(walk.end),
    initial: { time: formatBodyBatteryClock(walk.start), level: params.initial_level, source: "configured" },
    estimated: walk.estimation.minutes > 0,
    estimation: rounded(walk.estimation),
    contributions: Object.fromEntries(Object.entries(walk.contributions).map(([key, values]) => [key, rounded(values)])),
    max_heart_rate_setting: params.max_heart_rate,
    observed_max_heart_rate: inputs.observedMaxHeartRate,
    daily: walk.days.filter((day) => day.date >= fromDate).map((day) => ({ date: day.date, max: Math.round(day.max), min: Math.round(day.min), charged: Math.round(day.charged), drained: Math.round(day.drained), estimated_minutes: round1(day.estimated_minutes) })),
    events: walk.events.filter((event) => shown(event.end)).map((event) => ({ type: event.type, start: formatBodyBatteryClock(event.start), end: formatBodyBatteryClock(event.end), change: event.change, ...(event.reason ? { reason: event.reason } : {}) })),
    curve: walk.curve.filter((point) => shown(point.t)).map((point) => ({ time: formatBodyBatteryClock(point.t), level: Math.round(point.level), ...(point.estimated ? { estimated: true } : {}), ...(point.interval_estimated ? { interval_estimated: true } : {}) })),
  };
}

// 训练负荷：只读历史日文件里的运动原始对象和秒级时长，不用展示层已经四舍五入到整数分钟的结果。
// 每次调用重算全历史，补传、修正和配置改动自然生效，不设缓存失效机制。
function readTrainingLoadInputs(dataDir) {
  const workouts = [];
  const restingByDate = new Map();
  const files = fs.readdirSync(dataDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  for (const name of files) {
    const record = readRecord(path.join(dataDir, name), null);
    for (const workout of record.workouts || []) workouts.push(workout);
    // 当日最新一条静息心率代表这一天，与身体电量同一条取值规则。
    const latest = (record.resting_heart_rate?.samples || []).reduce((newest, sample) => (!newest || Date.parse(sample.ts) > Date.parse(newest.ts) ? sample : newest), null);
    const value = nullableNumber(latest?.value);
    if (value !== null) restingByDate.set(record.date || name.slice(0, 10), value);
  }
  return { workouts, restingByDate };
}

function trainingLoadDay(day) {
  return {
    date: day.date,
    load: round1(day.load),
    load_status: day.load_status,
    workouts: day.workouts,
    ...(day.uncomputable.length ? { uncomputable: day.uncomputable } : {}),
    ctl: roundOrNull(day.ctl),
    atl: roundOrNull(day.atl),
    tsb: roundOrNull(day.tsb),
    balance_end_of_day: roundOrNull(day.balance_end_of_day),
    ramp_rate: roundOrNull(day.ramp_rate),
    metrics_status: day.metrics_status,
    ...(day.blocked_since ? { blocked_since: day.blocked_since } : {}),
    ...(day.provisional ? { provisional: true } : {}),
  };
}

function trainingLoadWorkout(workout, method) {
  const loads = {};
  for (const name of TRAINING_LOAD_METHODS) {
    const entry = workout.loads[name];
    loads[name] = { load: roundOrNull(entry.load), status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}) };
    if (entry.coverage) {
      loads[name].coverage = {
        span_seconds: roundOrNull(entry.coverage.span_seconds),
        covered_seconds: roundOrNull(entry.coverage.covered_seconds),
        uncovered_seconds: roundOrNull(entry.coverage.uncovered_seconds),
        coverage_ratio: entry.coverage.coverage_ratio === undefined ? null : round3(entry.coverage.coverage_ratio),
        sample_count: entry.coverage.sample_count,
        excluded_recovery_samples: entry.coverage.excluded_recovery_samples,
        excluded_leading_samples: entry.coverage.excluded_leading_samples,
      };
    }
    if (entry.basis) {
      loads[name].basis = entry.basis.hr_ratio === undefined ? entry.basis : { ...entry.basis, hr_ratio: round3(entry.basis.hr_ratio) };
    }
  }
  return {
    type: workout.activity,
    ...(workout.name ? { name: workout.name } : {}),
    start: formatLocalClock(workout.start_ms),
    end: workout.end_ms === null ? null : formatLocalClock(workout.end_ms),
    duration_seconds: workout.duration_seconds,
    dates: workout.span_dates ?? [workout.start_date],
    loads,
    daily_split: (workout.splits[method] ?? []).map((part) => ({ date: part.date, load: round1(part.load), allocation: part.allocation })),
  };
}

function trainingLoad(dataDir, days, args = {}, now = new Date()) {
  const params = JSON.parse(fs.readFileSync(TRAINING_LOAD_PARAMS_PATH, "utf8"));
  const maxHeartRate = readMaxHeartRate();
  const method = TRAINING_LOAD_METHODS.includes(args.method) ? args.method : TRAINING_LOAD_METHODS[0];
  const activity = typeof args.activity === "string" && args.activity.trim() ? args.activity.trim() : null;
  const today = formatLocalDate(now);
  const fromDate = addDays(today, -(days - 1));
  const computed = computeTrainingLoad({
    ...readTrainingLoadInputs(dataDir),
    maxHeartRate,
    params,
    formatDate: (millis) => formatLocalDate(new Date(millis)),
    today,
  });
  // 全历史没有已入库运动时没有可递推的序列；「有运动但算不出来」是另一回事，由每天的缺失状态表达。
  if (computed.start_date === null) return null;
  const full = activity === null ? computed.methods[method].all : (computed.methods[method].activities[activity] ?? []);
  const daily = full.filter((day) => day.date >= fromDate).map(trainingLoadDay);
  const inWindow = (workout) => (workout.span_dates ?? [workout.start_date]).some((date) => date >= fromDate);
  const windowWorkouts = computed.workouts.filter(inWindow);
  const dayLoad = (series) => round1(series.filter((day) => day.date >= fromDate).reduce((sum, day) => sum + day.load, 0));
  return {
    method,
    unit: METHOD_UNITS[method],
    activity: activity ?? "all",
    metadata: {
      timezone: TZ,
      formula: params.formula,
      formula_source: params.formula_source,
      parameters: {
        max_heart_rate: maxHeartRate,
        max_heart_rate_source: "heart-rate.json",
        trimp_coefficient_a: params.trimp_coefficient_a,
        trimp_coefficient_b: params.trimp_coefficient_b,
        ctl_time_constant_days: params.ctl_time_constant_days,
        atl_time_constant_days: params.atl_time_constant_days,
        ramp_rate_days: params.ramp_rate_days,
        initial_ctl: params.initial_ctl,
        initial_atl: params.initial_atl,
        duration_field: params.duration_field,
        hr_hold_seconds: params.hr_hold_seconds,
      },
      resting_heart_rate_rule: "运动开始日当天的一条静息心率，当日没有则沿用最近一个更早的日期，不用全天最低心率代替",
      data_scope: "recorded_workouts",
      sync_completeness: "unverified",
      available_methods: TRAINING_LOAD_METHODS.map((name) => ({ method: name, unit: METHOD_UNITS[name] })),
      workouts_in_history: computed.workouts.length,
      workouts_in_window: windowWorkouts.length,
      unplaced_workouts: computed.unplaced_workouts,
    },
    // 从本地最早运动日期起、以配置里明确声明的初值递推：这是从现有记录建立的模型，不假设用户此前没有训练。
    initialization: {
      start_date: full[0]?.date ?? null,
      initial_ctl: params.initial_ctl,
      initial_atl: params.initial_atl,
      initial_value_source: "configured",
      days_computed: full.length,
      assumes_no_prior_training: false,
    },
    window: { from_date: fromDate, to_date: today, days },
    window_load: dayLoad(full),
    summary: daily.at(-1) ?? null,
    daily,
    ...(activity === null ? {
      activities: computed.activities.map((name) => {
        const series = computed.methods[method].activities[name];
        return {
          activity: name,
          start_date: series[0].date,
          days_computed: series.length,
          load: dayLoad(series),
          workouts: computed.workouts.filter((workout) => workout.activity === name && inWindow(workout)).length,
          summary: trainingLoadDay(series.filter((day) => day.date >= fromDate).at(-1)),
        };
      }),
    } : {}),
    ...(args.training_load_detail === "workouts"
      ? { workouts: [...windowWorkouts].sort((a, b) => b.start_ms - a.start_ms).map((workout) => trainingLoadWorkout(workout, method)) }
      : {}),
  };
}

function parseHealthToolRequest(args = {}) {
  const dataType = DATA_TYPES.includes(args.data_type) ? args.data_type : "current_status";
  const customDays = Number.isSafeInteger(args.days) && args.days >= 1 && args.days <= MAX_READ_DAYS ? args.days : null;
  const timeRange = customDays !== null ? "custom" : (args.time_range === "today" ? "today" : "three_days");
  return { dataType, timeRange, days: customDays ?? (timeRange === "today" ? 1 : 3) };
}

function readHealthToolResult(dataDir, args = {}) {
  const { dataType, timeRange, days } = parseHealthToolRequest(args);
  const today = formatLocalDate(new Date());
  const records = readHealthRecords(dataDir, dataType === "current_status" ? 3 : days, "all");
  const summaries = records.map(dailySummary).sort((a, b) => a.date.localeCompare(b.date));
  const todayRecord = records.find((record) => record.date === today) || {};
  const sleep = sleepSessions(records);
  const resultBase = { success: true, data_type: dataType };
  // The profile describes the person, not the day, so it is attached once to every answer rather
  // than repeated per day summary.
  const profile = readProfile(dataDir);
  const withContext = (result) => ({ ...result, ...(profile ? { profile } : {}), ...(todayRecord.cycle ? { cycle: todayRecord.cycle } : {}) });
  if (dataType === "current_status") return withContext({ ...resultBase, today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, today_calories: summaries.find((summary) => summary.date === today)?.calories ?? null, heart_rate: latestSample(todayRecord), spo2: latestSeriesValue(todayRecord, "spo2"), stress: latestSeriesValue(todayRecord, "stress"), hrv: latestSeriesValue(todayRecord, "hrv"), temperature: latestSeriesValue(todayRecord, "temperature"), sleep_score: nullableNumber(latestSleepStats(todayRecord)?.sleep_score), sleep_stats: latestSleepStats(todayRecord), latest_sleep: sleep[0] || null });
  const range = { ...resultBase, time_range: timeRange, days };
  if (dataType === "steps") return withContext({ ...range, today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, summaries: summaries.map(({ date, steps, calories }) => ({ date, steps, calories })) });
  if (dataType === "heart_rate") {
    const result = withContext({ ...range, latest_heart_rate: records.map(latestSample).find((value) => value !== null) ?? null, daily_summaries: summaries.map(({ date, hr_max, hr_min, hr_avg, hr_resting }) => ({ date, hr_max, hr_min, hr_avg, hr_resting })) });
    return args.heart_rate_detail === "hourly" ? { ...result, detail: "hourly", hourly_summaries: hourlyHeartRateSummaries(records) } : result;
  }
  if (dataType === "sleep") return withContext({ ...range, recent_sleep_list: sleep, recent_sleep_stats_list: sleepStatsList(records) });
  if (dataType === "workouts") return withContext({ ...range, recent_workout_list: workoutEntries(records) });
  if (dataType === "daily_summary") return withContext({ ...range, summaries });
  if (dataType === "series") return withContext({ ...range, series: records.map(seriesForRecord) });
  if (dataType === "body_battery") return withContext({ ...range, body_battery: bodyBattery(dataDir, days) });
  if (dataType === "training_load") return withContext({ ...range, training_load: trainingLoad(dataDir, days, args) });
  return withContext({ ...range, latest_heart_rate: records.map(latestSample).find((value) => value !== null) ?? null, today_heart_rate: latestSample(todayRecord), spo2: latestSeriesValue(todayRecord, "spo2"), stress: latestSeriesValue(todayRecord, "stress"), hrv: latestSeriesValue(todayRecord, "hrv"), temperature: latestSeriesValue(todayRecord, "temperature"), sleep_score: nullableNumber(latestSleepStats(todayRecord)?.sleep_score), today_steps: summaries.find((summary) => summary.date === today)?.steps ?? null, today_calories: summaries.find((summary) => summary.date === today)?.calories ?? null, recent_sleep_list: sleep, summaries });
}

function buildSummaryText(records) {
  if (!records.length) return "No health data available.";
  return records.map((record) => {
    const parts = [];
    if (record.steps?.total) parts.push(`步数 ${record.steps.total}`);
    if (record.heart_rate?.avg) {
      const resting = record.heart_rate.resting ? `（静息 ${record.heart_rate.resting}）` : "";
      parts.push(`心率均值 ${record.heart_rate.avg} bpm${resting}`);
    }
    if (record.sleep) {
      const minutes = Number(record.sleep.duration_min || 0);
      const duration = minutes ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : "";
      const deep = record.sleep.deep_min ? ` 深睡 ${record.sleep.deep_min}min` : "";
      parts.push(`睡眠 ${duration}${deep}${record.sleep.score ? ` 评分${record.sleep.score}` : ""}`);
    }
    if (record.cycle?.period_day) {
      parts.push(`${record.cycle.confirmed ? "" : "预计"}经期第${record.cycle.period_day}天`);
    } else if (record.cycle?.days_until_period) {
      parts.push(`预计${record.cycle.days_until_period}天后来经期`);
    }
    return `${record.date}: ${parts.join(", ") || "无数据"}`;
  }).join("\n");
}

function createHealthMcpServer(dataDir) {
  const server = new McpServer({ name: "health", version: "1.1.0" });
  server.tool("health_read", "读取健康数据：当前状态、步数、心率、睡眠、运动记录、每日摘要、带时间戳的原始序列、身体电量、训练负荷或完整数据。", {
    data_type: z.enum(DATA_TYPES).optional(),
    time_range: z.enum(TIME_RANGES).optional(),
    heart_rate_detail: z.enum(HEART_RATE_DETAILS).optional(),
    training_load_detail: z.enum(TRAINING_LOAD_DETAILS).optional(),
    method: z.enum(TRAINING_LOAD_METHODS).optional(),
    activity: z.string().optional(),
    days: z.number().int().min(1).max(MAX_READ_DAYS).optional(),
  }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify(readHealthToolResult(dataDir, args), null, 2) }],
  }));
  server.tool(
    "health_wait_for_wake",
    "等待新的「睡眠中醒来」事件：夜里睡着后又醒、之后接着睡回去的时段，清醒时长达到 wake-notify.json 里的阈值（收尾那次起床不算，小睡不算）。手机把睡眠数据传上来时事件入库，后台按小时、每次解锁屏幕都会同步，所以半夜醒来通常几秒到一小时内到达。请求会一直挂到事件到达或超时。不传 since 表示只等这次调用之后新收到的事件；把上次返回的 next_since 传回来，可以补上断开期间收到的事件，不重不漏。",
    {
      since: z.number().int().min(0).optional(),
      timeout_seconds: z.number().int().min(0).optional(),
    },
    async (args) => {
      const params = readWakeNotifyParams();
      const result = await waitForWakeEvents(dataDir, {
        since: args.since,
        timeoutSeconds: args.timeout_seconds ?? params.default_wait_seconds,
        pollIntervalSeconds: params.poll_interval_seconds,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
  return server;
}

function bearerMiddleware(token) {
  if (!token) return [];
  return [(req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }];
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.HEALTH_DATA_DIR || DEFAULT_DATA_DIR;
  const jsonLimit = options.jsonLimit || process.env.HEALTH_JSON_LIMIT || "16mb";
  const publicUrls = options.publicUrls || String(
    options.publicUrl || process.env.HEALTH_MCP_PUBLIC_URLS || process.env.HEALTH_MCP_PUBLIC_URL || "",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const ingestToken = options.ingestToken ?? process.env.HEALTH_INGEST_TOKEN ?? "";
  const readToken = options.readToken ?? process.env.HEALTH_MCP_ACCESS_TOKEN ?? "";
  if (!ingestToken || ingestToken.length < 16) throw new Error("HEALTH_INGEST_TOKEN must be at least 16 characters");

  const app = express();
  installRequestObservability(app, { service: "health-mcp" });
  app.use(express.json({ limit: jsonLimit }));
  // 配了才校验 Host；留空 = 任意 Host 放行（反代域名不用登记）
  if (publicUrls.length) app.use(hostHeaderValidation([...new Set(publicUrls.flatMap(buildAllowedHosts))]));
  app.get(["/health", "/healthz"], (_req, res) => res.json({ ok: true, service: "health-mcp" }));
  app.get("/", (_req, res) => res.json({ service: "health-mcp" }));
  app.post("/api/health", ...bearerMiddleware(ingestToken), (req, res) => {
    try {
      const result = mergeHealthData(dataDir, req.body);
      res.json({ ok: true, date: result.date });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/cycle", ...bearerMiddleware(ingestToken), (req, res) => {
    try {
      const config = storeCycleConfig(dataDir, req.body);
      res.json({ ok: true, enabled: config.enabled });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.get("/api/health", ...bearerMiddleware(readToken), (req, res) => {
    const days = Math.min(62, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
    const type = VALID_TYPES.has(req.query.type) ? req.query.type : "all";
    res.json(readHealthRecords(dataDir, days, type));
  });
  mountMcpEndpoint(app, {
    path: "/mcp",
    middleware: bearerMiddleware(readToken),
    createServer: () => createHealthMcpServer(dataDir),
  });
  return app;
}

function main() {
  const port = Number(process.env.HEALTH_MCP_PORT || 3100);
  const host = process.env.HEALTH_MCP_HOST || "127.0.0.1";
  const app = createApp();
  // A port already taken by another instance still runs this callback — the line below is printed and
  // the process then exits 0 with nothing on stderr, which reads as a successful start. The error
  // event is the only place the bind failure shows up.
  app.listen(port, host, () => console.log(`Health MCP listening on ${host}:${port}`))
    .on("error", (error) => {
      console.error(`Health MCP failed to start on ${host}:${port}: ${error.message}`);
      process.exitCode = 1;
    });
}

if (require.main === module) main();

module.exports = {
  buildSummaryText,
  cycleContextForDate,
  createApp,
  createHealthMcpServer,
  dailySummary,
  formatLocalDate,
  mergeHealthData,
  normalizeSleepSession,
  readHealthRecords,
  readHealthToolResult,
  readProfile,
  storeCycleConfig,
  storeProfile,
  trainingLoad,
  walkBodyBattery,
};
