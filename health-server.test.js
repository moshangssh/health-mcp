const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { buildSummaryText, createApp, createHealthMcpServer, cycleContextForDate, dailySummary, formatLocalDate, mergeHealthData, normalizeSleepSession, readHealthRecords, readHealthToolResult, readProfile, storeCycleConfig, walkBodyBattery } = require("./health-server");

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-mcp-test-"));
}

function readDay(dir, date) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), "utf8"));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
}

// The read path resolves "today" from the wall clock, and these two flows use fixtures pinned to
// 2026-09-06. Freezing Date there keeps the suite independent of the day it runs on.
const FROZEN_NOW = new Date("2026-09-06T04:00:00Z");

function freezeClock(t) {
  mock.timers.enable({ apis: ["Date"], now: FROZEN_NOW });
  t.after(() => mock.timers.reset());
}

// A night starting 23:00 the previous evening and ending at `endHour` on 2026-09-02 (Shanghai),
// with `durationHours` of sleep captured.
function night(endHour, durationHours) {
  return {
    session_start_time: "2026-09-01T23:00:00+08:00",
    session_end_time: `2026-09-02T${String(endHour).padStart(2, "0")}:00:00+08:00`,
    duration_seconds: durationHours * 3600,
    stages: [],
  };
}

test("the body profile rides in a day body but is stored once for the whole server", () => {
  const dir = tmpDataDir();
  const profile = { height_cm: 175, weight_kg: 70, age: 36, gender: "male", birthday: "1990-05-01" };
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 1000 }, profile });
  mergeHealthData(dir, { date: "2026-09-07", steps: { total: 2000 }, profile });

  assert.deepEqual(readProfile(dir), profile);
  assert.equal(readDay(dir, "2026-09-06").profile, undefined, "the day file stays day data");
  assert.equal(readDay(dir, "2026-09-07").profile, undefined);
  assert.deepEqual(readHealthToolResult(dir, { data_type: "daily_summary" }).profile, profile);
});

test("an unchanged profile is not rewritten on every day body", (t) => {
  const dir = tmpDataDir();
  const profile = { height_cm: 175, weight_kg: 70, age: 36, gender: "male", birthday: "1990-05-01" };
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 1000 }, profile });

  const writeFileSync = mock.method(fs, "writeFileSync");
  t.after(() => writeFileSync.mock.restore());
  mergeHealthData(dir, { date: "2026-09-07", steps: { total: 2000 }, profile });

  const profileWrites = writeFileSync.mock.calls
    .filter((call) => String(call.arguments[0]).endsWith("profile.json"));
  assert.equal(profileWrites.length, 0, "the day still gets written, the profile does not");

  // An edited profile does have to land.
  mergeHealthData(dir, { date: "2026-09-08", steps: { total: 3000 }, profile: { ...profile, weight_kg: 71 } });
  assert.equal(readProfile(dir).weight_kg, 71);
});

test("no profile uploaded means no profile in the answer", () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 1000 } });

  assert.equal(readProfile(dir), null);
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary" }).profile, undefined);
});

test("a grown re-send overwrites the short night instead of doubling it", () => {
  const dir = tmpDataDir();
  // First upload: the fetch stopped mid-morning, so the night looks 5h long.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(4, 5)] });
  // Second upload: a later fetch extended the same night to 8h.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "the night must not be stored twice");
  assert.equal(record.sleep_sessions[0].duration_min, 480);
  assert.equal(record.sleep.duration_min, 480, "the summary must not double-count");
});

test("two separate sessions on one day are both kept", () => {
  const dir = tmpDataDir();
  const nap = {
    session_start_time: "2026-09-02T13:00:00+08:00",
    session_end_time: "2026-09-02T14:00:00+08:00",
    duration_seconds: 3600,
    stages: [],
  };
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });
  mergeHealthData(dir, { date: "2026-09-02", sleep: [nap] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 2, "a nap and the night are distinct sessions");
  assert.equal(record.sleep.duration_min, 480 + 60);
});

test("a stage the watch tagged as a nap reads as a nap, not as the day's night", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    sleep: [
      {
        session_start_time: "2026-09-06T00:00:00+08:00",
        session_end_time: "2026-09-06T08:00:00+08:00",
        duration_seconds: 28800,
        stages: [
          { stage: "deep", start_time: "2026-09-06T00:00:00+08:00", end_time: "2026-09-06T06:00:00+08:00", duration_seconds: 21600 },
          { stage: "light", start_time: "2026-09-06T06:00:00+08:00", end_time: "2026-09-06T08:00:00+08:00", duration_seconds: 7200 },
        ],
      },
      {
        session_start_time: "2026-09-06T11:00:00+08:00",
        session_end_time: "2026-09-06T12:00:00+08:00",
        duration_seconds: 3600,
        stages: [
          { stage: "nap", start_time: "2026-09-06T11:00:00+08:00", end_time: "2026-09-06T12:00:00+08:00", duration_seconds: 3600 },
        ],
      },
    ],
  });

  const record = readDay(dir, "2026-09-06");
  assert.equal(record.sleep.deep_min, 360);
  assert.equal(record.sleep.nap_min, 60, "the nap is a stage of the day, not part of light sleep");
  assert.equal(record.sleep.duration_min, 540, "both sessions still make up the day's sleep");

  const sessions = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  const nap = sessions.find((session) => session.start === "9/6 11:00");
  assert.equal(nap.type, "nap");
  assert.deepEqual(Object.keys(nap).sort(), ["duration_text", "end", "end_at", "start", "start_at", "total_minutes", "type"], "a nap carries no night's stage minutes");
  assert.equal(nap.start_at, "2026-09-06T03:00:00.000Z", "the clock reading is local; the instant beside it is absolute");
  const night = sessions.find((session) => session.start === "9/6 00:00");
  assert.equal(night.type, "sleep");
  assert.equal(night.deep_sleep_minutes, 360);
});

test("a session with nothing but awake stages is still inferred as a nap", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    sleep: [{
      session_start_time: "2026-09-06T11:00:00+08:00",
      session_end_time: "2026-09-06T11:10:00+08:00",
      duration_seconds: 600,
      stages: [
        { stage: "awake", start_time: "2026-09-06T11:00:00+08:00", end_time: "2026-09-06T11:10:00+08:00", duration_seconds: 600 },
      ],
    }],
  });

  const sessions = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  assert.equal(sessions[0].type, "nap", "a source that reports no nap tag is inferred from its stages");
});

test("a night reports the time it spent awake, which only its own stages know", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    sleep: [{
      session_start_time: "2026-09-06T00:00:00+08:00",
      session_end_time: "2026-09-06T08:20:00+08:00",
      // What the app sends: time actually asleep, the waking excluded.
      duration_seconds: 27600,
      stages: [
        { stage: "deep", start_time: "2026-09-06T00:00:00+08:00", end_time: "2026-09-06T03:00:00+08:00", duration_seconds: 10800 },
        { stage: "awake", start_time: "2026-09-06T03:00:00+08:00", end_time: "2026-09-06T03:20:00+08:00", duration_seconds: 1200 },
        { stage: "light", start_time: "2026-09-06T03:20:00+08:00", end_time: "2026-09-06T08:20:00+08:00", duration_seconds: 18000 },
      ],
    }],
  });

  const [night] = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  assert.equal(night.awake_minutes, 20);
  assert.equal(night.deep_sleep_minutes, 180);
  assert.equal(night.light_sleep_minutes, 300);
  assert.equal(night.total_minutes, 460, "the duration stays time asleep; the waking is the extra");
  assert.equal(night.end, "9/6 08:20", "the span still covers the waking, so both figures read together");
});

test("a night the day holds whole reads its minutes off its own block", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  // The old whole-night upload: one object, no sessions stored beside it, so record.sleep is this
  // night itself and its fields are the night's own.
  mergeHealthData(dir, {
    date: "2026-09-06",
    type: "sleep",
    data: { duration_min: 480, deep_min: 180, light_min: 260, rem_min: 40, awake_min: 25, start: "2026-09-06T00:00:00+08:00", end: "2026-09-06T08:25:00+08:00" },
  });
  assert.equal(readDay(dir, "2026-09-06").sleep_sessions, undefined, "the block path stores no sessions of its own");

  const [night] = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  assert.equal(night.type, "sleep");
  assert.equal(night.total_minutes, 480);
  assert.equal(night.awake_minutes, 25, "with no separate sessions the day's fields are this night's");
  assert.equal(night.deep_sleep_minutes, 180);
  assert.equal(night.rem_sleep_minutes, 40);
});

test("a stage-less session beside an independent one reports no minutes of its own", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    sleep: [
      { session_start_time: "2026-09-06T00:00:00+08:00", session_end_time: "2026-09-06T08:00:00+08:00", duration_seconds: 28800, stages: [] },
      {
        session_start_time: "2026-09-06T13:00:00+08:00",
        session_end_time: "2026-09-06T14:00:00+08:00",
        duration_seconds: 3600,
        stages: [{ stage: "light", start_time: "2026-09-06T13:00:00+08:00", end_time: "2026-09-06T14:00:00+08:00", duration_seconds: 3600 }],
      },
    ],
  });
  assert.equal(readDay(dir, "2026-09-06").sleep.light_min, 60, "the day's light minutes belong to the afternoon session");

  const night = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list.find((session) => session.start === "9/6 00:00");
  assert.equal(night.total_minutes, 480, "the span is still the session's own");
  assert.equal(night.light_sleep_minutes, null, "the day's 60 minutes are not this night's");
  assert.equal(night.deep_sleep_minutes, null);
  assert.equal(night.awake_minutes, null);
});

test("a nap's minutes do not stand in for a stage-less night's", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    sleep: [
      { session_start_time: "2026-09-06T00:00:00+08:00", session_end_time: "2026-09-06T08:00:00+08:00", duration_seconds: 28800, stages: [] },
      {
        session_start_time: "2026-09-06T11:00:00+08:00",
        session_end_time: "2026-09-06T11:10:00+08:00",
        duration_seconds: 600,
        stages: [{ stage: "awake", start_time: "2026-09-06T11:00:00+08:00", end_time: "2026-09-06T11:10:00+08:00", duration_seconds: 600 }],
      },
    ],
  });

  const record = readDay(dir, "2026-09-06");
  assert.equal(record.sleep.awake_min, 10, "the day's awake minutes are the nap's, the night's being unsaid");

  const sessions = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  assert.equal(sessions.find((session) => session.start === "9/6 11:00").type, "nap");
  assert.equal(sessions.find((session) => session.start === "9/6 00:00").awake_minutes, null, "the day's total is not the night's");
});

test("a read carries the time of the last upload the server saw", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary" }).last_ingest_at, null, "a server that has heard nothing says so");

  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 1000 } });
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary", time_range: "today" }).last_ingest_at, FROZEN_NOW.toISOString());

  // 白天断联：最后一次上传停在那一刻，read 的答案也就停在哪一刻。
  mock.timers.setTime(FROZEN_NOW.getTime() + 4 * 3600 * 1000);
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary", time_range: "today" }).last_ingest_at, FROZEN_NOW.toISOString());
});

test("an upload that only touches a list, the coverage or the profile still stamps the time", (t) => {
  freezeClock(t);
  // 这几条写入路径一个 updatedAt 都不写，戳必须由写入侧记下，读端才推断得出来。
  const bodies = {
    workouts: [{ timestamp: "2026-09-06T07:30:00+08:00", activity: "running", end_time: "2026-09-06T08:05:00+08:00", duration_seconds: 2100 }],
    sleep_stats: [{ timestamp: "2026-09-06T07:00:00+08:00", sleep_score: 88 }],
    heart_rate_coverage: [{ timestamp: "2026-09-06T00:00:00+08:00", end_time: "2026-09-06T01:00:00+08:00", status: "observed" }],
    profile: { height_cm: 175, weight_kg: 70, age: 36, gender: "male", birthday: "1990-05-01" },
  };
  for (const [key, value] of Object.entries(bodies)) {
    const dir = tmpDataDir();
    mergeHealthData(dir, { date: "2026-09-06", [key]: value });
    assert.equal(readDay(dir, "2026-09-06").ingestedAt, FROZEN_NOW.toISOString(), `${key}: the write path leaves the stamp`);
    assert.equal(readHealthToolResult(dir, { data_type: "daily_summary", time_range: "today" }).last_ingest_at, FROZEN_NOW.toISOString(), key);
  }
});

test("the last upload time follows the newest upload in the window", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, { date: "2026-09-05", steps: { total: 1000 } });
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 2000 } });
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary", days: 3 }).last_ingest_at, FROZEN_NOW.toISOString());

  const later = new Date(FROZEN_NOW.getTime() + 3600 * 1000).toISOString();
  mock.timers.setTime(FROZEN_NOW.getTime() + 3600 * 1000);
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 3000 } });
  assert.equal(readHealthToolResult(dir, { data_type: "daily_summary", days: 3 }).last_ingest_at, later, "the newest upload wins");
});

test("a night that lands on another day's file stamps that file too", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  // The night ends 2026-09-02, so it is stored under that date even though the body says 09-06.
  mergeHealthData(dir, { date: "2026-09-06", sleep: [night(7, 8)] });
  assert.equal(readDay(dir, "2026-09-02").ingestedAt, FROZEN_NOW.toISOString(), "the file the night landed in carries the stamp");
  assert.equal(fs.existsSync(path.join(dir, "2026-09-05.json")), false, "a day nothing landed in is not created");
});

test("every read type carries the last-upload time", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, { date: "2026-09-06", steps: { total: 1000 } });

  for (const data_type of ["current_status", "steps", "heart_rate", "sleep", "workouts", "daily_summary", "series", "body_battery", "training_load", "all"]) {
    assert.equal(readHealthToolResult(dir, { data_type }).last_ingest_at, FROZEN_NOW.toISOString(), data_type);
  }
});

test("the daily summary's sleep keeps when the night landed and its span", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const day = readHealthToolResult(dir, { data_type: "daily_summary", days: 10 }).summaries.find((summary) => summary.date === "2026-09-02");
  assert.equal(day.sleep.updated_at, FROZEN_NOW.toISOString(), "the night's data says when it arrived");
  assert.equal(day.sleep.start, "2026-09-01T15:00:00.000Z");
  assert.equal(day.sleep.end, "2026-09-01T23:00:00.000Z");

  const empty = readHealthToolResult(tmpDataDir(), { data_type: "daily_summary", time_range: "today" }).summaries;
  assert.deepEqual(empty, [], "a day with no file has no summary at all");
});

test("a session carries the absolute instant beside the local clock", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const [session] = readHealthToolResult(dir, { data_type: "sleep", days: 10 }).recent_sleep_list;
  assert.equal(session.start, "9/1 23:00", "the human clock reading is unchanged");
  assert.equal(session.end, "9/2 07:00");
  assert.equal(session.start_at, "2026-09-01T15:00:00.000Z");
  assert.equal(session.end_at, "2026-09-01T23:00:00.000Z");
});

test("a sleep read carries the watch's own report for each night", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  const date = formatLocalDate(new Date());
  mergeHealthData(dir, {
    date,
    sleep_stats: [{
      timestamp: `${date}T07:00:00+08:00`,
      sleep_score: 88,
      bed_time: `${date}T22:40:00+08:00`,
      fall_asleep_time: `${date}T23:12:00+08:00`,
      wakeup_time: `${date}T07:00:00+08:00`,
      rising_time: `${date}T07:05:00+08:00`,
    }],
  });
  mergeHealthData(dir, {
    date: "2026-09-05",
    sleep_stats: [{ timestamp: "2026-09-05T07:10:00+08:00", sleep_score: 74, rising_time: "2026-09-05T07:20:00+08:00" }],
  });

  const result = readHealthToolResult(dir, { data_type: "sleep", days: 3 });
  assert.deepEqual(
    result.recent_sleep_stats_list.map((report) => report.timestamp),
    [`${date}T07:00:00+08:00`, "2026-09-05T07:10:00+08:00"],
    "the newest night comes first",
  );
  assert.equal(result.recent_sleep_stats_list[0].bed_time, `${date}T22:40:00+08:00`, "the times a session cannot show come with the read");
  assert.equal(result.recent_sleep_stats_list[1].rising_time, "2026-09-05T07:20:00+08:00");
  assert.deepEqual(result.recent_sleep_list, [], "a day the watch reported on but recorded no session for has none");
});

test("a file left duplicated by the old merge heals on the next upload", () => {
  const dir = tmpDataDir();
  // Simulate a record written by the old end|duration merge: the same night stored twice.
  fs.writeFileSync(
    path.join(dir, "2026-09-02.json"),
    JSON.stringify({
      date: "2026-09-02",
      sleep_sessions: [normalizeSleepSession(night(4, 5)), normalizeSleepSession(night(7, 8))],
    }),
  );

  // Any further upload for that date triggers the self-heal.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "pre-existing duplicates collapse to one");
  assert.equal(record.sleep.duration_min, 480);
});

// 23:00–07:00（+08:00）的一夜，中间一段 `awakeMinutes` 的清醒，之后接着睡回去；`tail` 让清醒落在末尾，
// 也就是天亮那次起床。
function nightWithWaking(awakeMinutes, { awakeAt = "2026-09-01T17:00:00Z", tail = false } = {}) {
  const awakeEnd = new Date(Date.parse(awakeAt) + awakeMinutes * 60000).toISOString();
  const stages = [
    { stage: "light", start_time: "2026-09-01T15:00:00Z", end_time: awakeAt, duration_seconds: (Date.parse(awakeAt) - Date.parse("2026-09-01T15:00:00Z")) / 1000 },
    { stage: "awake", start_time: awakeAt, end_time: awakeEnd, duration_seconds: awakeMinutes * 60 },
  ];
  if (!tail) stages.push({ stage: "light", start_time: awakeEnd, end_time: "2026-09-01T23:00:00Z", duration_seconds: (Date.parse("2026-09-01T23:00:00Z") - Date.parse(awakeEnd)) / 1000 });
  return { session_start_time: "2026-09-01T15:00:00Z", session_end_time: "2026-09-01T23:00:00Z", duration_seconds: 28800, stages };
}

function readWakeEvents(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "wake-events.json"), "utf8")).events;
}

async function connectHealthMcp(dir) {
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "wake-notify-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function callWaitForWake(client, args) {
  return JSON.parse((await client.callTool({ name: "health_wait_for_wake", arguments: args })).content[0].text);
}

test("a night waking is recorded once, and re-sending the night does not make it new again", () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { sleep: [nightWithWaking(10)] });
  const first = readWakeEvents(dir);
  assert.deepEqual(first.map(({ seq, night, start, end, awake_minutes }) => ({ seq, night, start, end, awake_minutes })), [
    { seq: 1, night: "2026-09-02", start: "2026-09-01T17:00:00.000Z", end: "2026-09-01T17:10:00.000Z", awake_minutes: 10 },
  ]);

  mergeHealthData(dir, { sleep: [nightWithWaking(10)] });
  const second = readWakeEvents(dir);
  assert.equal(second.length, 1, "the same waking must not be read as a new one");
  assert.equal(second[0].seq, 1);
  assert.equal(second[0].received_at, first[0].received_at);
});

test("a night restated without its waking drops the event it used to have", () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { sleep: [nightWithWaking(10)] });
  const restated = nightWithWaking(10);
  restated.stages[1] = { ...restated.stages[1], stage: "light" };
  mergeHealthData(dir, { sleep: [restated] });
  assert.deepEqual(readWakeEvents(dir), []);
});

test("an awake stretch under the threshold is kept but never handed out", async () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { sleep: [nightWithWaking(3)] });
  assert.equal(readWakeEvents(dir).length, 1, "the threshold is applied on read, so it stays in the store");

  const { client, server } = await connectHealthMcp(dir);
  assert.deepEqual(await callWaitForWake(client, { since: 0, timeout_seconds: 0 }), { timed_out: true, since: 0, next_since: 0, events: [] });
  await client.close();
  await server.close();
});

test("the morning wake-up, and a nap, are not night wakings", async () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { sleep: [nightWithWaking(10, { tail: true })] });
  mergeHealthData(dir, {
    date: "2026-09-02",
    sleep: [{
      session_start_time: "2026-09-02T11:00:00+08:00",
      session_end_time: "2026-09-02T13:00:00+08:00",
      duration_seconds: 7200,
      stages: [
        { stage: "nap", start_time: "2026-09-02T11:00:00+08:00", end_time: "2026-09-02T11:30:00+08:00", duration_seconds: 1800 },
        { stage: "light", start_time: "2026-09-02T11:30:00+08:00", end_time: "2026-09-02T12:00:00+08:00", duration_seconds: 1800 },
        { stage: "awake", start_time: "2026-09-02T12:00:00+08:00", end_time: "2026-09-02T12:10:00+08:00", duration_seconds: 600 },
        { stage: "light", start_time: "2026-09-02T12:10:00+08:00", end_time: "2026-09-02T13:00:00+08:00", duration_seconds: 3000 },
      ],
    }],
  });

  const { client, server } = await connectHealthMcp(dir);
  assert.deepEqual((await callWaitForWake(client, { since: 0, timeout_seconds: 0 })).events, []);
  await client.close();
  await server.close();
});

test("health_wait_for_wake returns as soon as the night's data lands", async () => {
  const dir = tmpDataDir();
  const { client, server } = await connectHealthMcp(dir);
  const pending = client.callTool({ name: "health_wait_for_wake", arguments: { since: 0, timeout_seconds: 10 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  mergeHealthData(dir, { sleep: [nightWithWaking(10)] });

  const result = JSON.parse((await pending).content[0].text);
  assert.equal(result.timed_out, false);
  assert.deepEqual(result.events.map((event) => event.awake_minutes), [10]);
  assert.equal(result.next_since, 1);
  await client.close();
  await server.close();
});

test("a call with no since waits for what arrives next, and next_since carries the cursor on", async () => {
  const dir = tmpDataDir();
  mergeHealthData(dir, { sleep: [nightWithWaking(10)] });
  const { client, server } = await connectHealthMcp(dir);
  assert.deepEqual(await callWaitForWake(client, { timeout_seconds: 0 }), { timed_out: true, since: 1, next_since: 1, events: [] }, "an event already in the store is not new");

  mergeHealthData(dir, { sleep: [nightWithWaking(12, { awakeAt: "2026-09-01T19:00:00Z" })] });
  const caught = await callWaitForWake(client, { since: 1, timeout_seconds: 0 });
  assert.equal(caught.timed_out, false);
  assert.deepEqual(caught.events.map(({ seq, awake_minutes }) => ({ seq, awake_minutes })), [{ seq: 2, awake_minutes: 12 }]);
  await client.close();
  await server.close();
});

test("MCP exposes the public health read contract and custom day ranges", async (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  for (const [date, total] of [["2026-09-02", 2000], ["2026-09-03", 3000], ["2026-09-04", 4000], ["2026-09-05", 5000], ["2026-09-06", 6000]]) {
    mergeHealthData(dir, { date, type: "steps", data: { total } });
  }
  mergeHealthData(dir, { date: "2026-09-06", heart_rate: [
    { timestamp: "2026-09-06T00:10:00Z", bpm: 60, resting_bpm: 58 },
    { timestamp: "2026-09-06T00:50:00Z", bpm: 80 },
  ], sleep: [{
    session_start_time: "2026-09-05T15:30:00Z", session_end_time: "2026-09-05T23:30:00Z",
    duration_seconds: 28800, stages: [],
  }] });
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "public-health-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["health_read", "health_wait_for_wake"]);
  assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties), ["data_type", "time_range", "heart_rate_detail", "training_load_detail", "method", "activity", "days"]);
  const steps = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "steps", days: 5 } })).content[0].text);
  assert.equal(steps.summaries.length, 5);
  const hourly = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "heart_rate", heart_rate_detail: "hourly", time_range: "today" } })).content[0].text);
  assert.equal(hourly.hourly_summaries.length, 1);
  const summary = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "daily_summary", time_range: "today" } })).content[0].text);
  assert.equal(summary.summaries[0].sleep.duration_min, 480);
  await client.close();
  await server.close();
});

test("cycle endpoint stores and clears independent cycle context", async (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  const app = createApp({ dataDir: dir, ingestToken: "1234567890abcdef" });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const config = { enabled: true, last_start: "2026-09-01", cycle_length_days: 28, cycle_period_days: 5, last_confirmed: "2026-09-05" };
  let response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  mergeHealthData(dir, { date: "2026-09-05", type: "steps", data: { total: 100 } });
  const result = require("./health-server").readHealthRecords(dir, 2, "all");
  assert.deepEqual(result.find((record) => record.date === "2026-09-05").cycle, { period_day: 5, confirmed: true });
  response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
  await new Promise((resolve) => listener.close(resolve));
});

const confirmedCycle = {
  enabled: true,
  last_start: "2026-09-01",
  cycle_length_days: 28,
  cycle_period_days: 5,
  last_confirmed: "2026-09-05",
};

test("cycle context includes only period days and the three-day warning", () => {
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-01"), { period_day: 1, confirmed: true });
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-05"), { period_day: 5, confirmed: true });
  assert.equal(cycleContextForDate(confirmedCycle, "2026-09-06"), null);
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-26"), { days_until_period: 3, confirmed: true });
});

test("cycle annotations are dynamic and never written into day files", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "2026-09-05.json"), JSON.stringify({ date: "2026-09-05", steps: { total: 8234 } }));
  storeCycleConfig(dir, confirmedCycle);
  const records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(records[0].cycle, { period_day: 5, confirmed: true });
  assert.match(buildSummaryText(records), /经期第5天/);
  assert.equal(readDay(dir, "2026-09-05").cycle, undefined);
});

test("step buckets are stored as a series and sum to the day total", () => {
  const dir = tmpDataDir();
  const date = "2026-09-02";
  const at = (hour, minute) => `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;
  mergeHealthData(dir, { date, steps: [
    { timestamp: at(8, 0), value: 100 },
    { timestamp: at(8, 5), value: 250 },
  ] });
  // A later upload re-sends the day from local midnight, so the still-growing last bucket arrives
  // again with more steps in it.
  mergeHealthData(dir, { date, steps: [
    { timestamp: at(8, 0), value: 100 },
    { timestamp: at(8, 5), value: 320 },
  ] });

  const record = readDay(dir, date);
  assert.equal(record.steps.samples.length, 2, "the same bucket must overwrite, not append");
  assert.equal(record.steps.total, 420, "the total follows the corrected bucket");
  assert.equal(dailySummary(record).steps, 420);
});

test("a re-sent heart rate reading replaces the one stored for its minute", () => {
  const dir = tmpDataDir();
  const date = "2026-09-02";
  // 08:17 upload: the watch reported 72 for the minute that began at 08:15.
  mergeHealthData(dir, { date, heart_rate: [{ timestamp: `${date}T08:15:00+08:00`, bpm: 72 }] });
  // 08:47 upload: that same minute comes back corrected, with the day from local midnight.
  mergeHealthData(dir, { date, heart_rate: [{ timestamp: `${date}T08:15:00+08:00`, bpm: 110 }] });

  const record = readDay(dir, date);
  assert.equal(record.heart_rate.samples.length, 1, "the same minute must overwrite, not append");
  assert.equal(record.heart_rate.samples[0].bpm, 110, "the corrected reading wins over the early one");
  assert.equal(record.heart_rate.avg, 110);
});

test("a full day of one-minute heart rate readings is kept whole", () => {
  const dir = tmpDataDir();
  const date = "2026-09-02";
  const at = (i) => `${date}T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+08:00`;
  // The watch now reports heart rate once a minute, so a day holds 1440 readings rather than 288.
  // The app sends the day from local midnight, which bounds the array; nothing may cap it.
  const heartRate = [];
  for (let i = 0; i < 1440; i += 1) heartRate.push({ timestamp: at(i), bpm: 60 + (i % 40) });
  mergeHealthData(dir, { date, heart_rate: heartRate });

  const record = readDay(dir, date);
  assert.equal(record.heart_rate.samples.length, 1440, "the whole day must survive the merge");
  assert.equal(record.heart_rate.samples[0].ts, at(0), "the earliest reading of the day is still there");
});

test("extra readings merge by timestamp and feed the daily summary", () => {
  const dir = tmpDataDir();
  const date = "2026-09-02";
  mergeHealthData(dir, {
    date,
    spo2: [
      { timestamp: `${date}T08:00:00+08:00`, value: 96 },
      { timestamp: `${date}T09:00:00+08:00`, value: 98 },
    ],
    stress: [{ timestamp: `${date}T08:00:00+08:00`, value: 40, level: 2 }],
    hrv: [{ timestamp: `${date}T08:00:00+08:00`, value: 42 }],
    temperature: [{ timestamp: `${date}T08:00:00+08:00`, value: 36.5 }],
    resting_heart_rate: [{ timestamp: `${date}T08:00:00+08:00`, value: 55 }],
    steps: { total: 8000 },
    active_calories: { total: 320 },
    distance: { total: 4200 },
    sleep_stats: [{ timestamp: `${date}T07:00:00+08:00`, sleep_score: 88 }],
    emotions: [{ timestamp: `${date}T10:00:00+08:00`, status: 2 }],
    sleep_apnea: [{ timestamp: `${date}T03:00:00+08:00`, level: 1 }],
  });
  // A re-sent window corrects the reading in place, and a corrected (smaller) total replaces the
  // stored one instead of being pinned by Math.max.
  mergeHealthData(dir, {
    date,
    spo2: [{ timestamp: `${date}T08:00:00+08:00`, value: 97 }],
    steps: { total: 3000 },
    active_calories: { total: 300 },
    distance: { total: 4000 },
  });

  const record = readDay(dir, date);
  assert.equal(record.spo2.samples.length, 2, "the same timestamp must overwrite, not append");
  assert.equal(record.spo2.samples[0].value, 97);
  assert.equal(record.active_calories.total, 300, "a corrected total replaces the larger one");
  assert.equal(record.steps.total, 3000, "steps follow the same replace-on-correction rule");
  assert.equal(record.distance.total, 4000);
  assert.equal(record.sleep_stats.length, 1, "a night is stored once");
  assert.equal(record.sleep_stats[0].sleep_score, 88);

  const summary = dailySummary(record);
  assert.equal(summary.spo2_avg, 97.5);
  assert.equal(summary.stress_avg, 40);
  assert.equal(summary.hrv_avg, 42);
  assert.equal(summary.temperature_avg, 36.5);
  assert.equal(summary.resting_hr, 55);
  assert.equal(summary.distance_m, 4000);
  assert.equal(summary.sleep_score, 88);
});

test("current status surfaces the latest extra reading", () => {
  const dir = tmpDataDir();
  const today = formatLocalDate(new Date());
  mergeHealthData(dir, {
    date: today,
    spo2: [{ timestamp: `${today}T08:00:00+08:00`, value: 96 }, { timestamp: `${today}T09:00:00+08:00`, value: 97 }],
    stress: [{ timestamp: `${today}T08:00:00+08:00`, value: 40 }],
    hrv: [{ timestamp: `${today}T08:00:00+08:00`, value: 42 }],
    temperature: [{ timestamp: `${today}T08:00:00+08:00`, value: 36.5 }],
    sleep_stats: [{ timestamp: `${today}T07:00:00+08:00`, sleep_score: 88 }],
  });

  const status = readHealthToolResult(dir, { data_type: "current_status" });
  assert.equal(status.spo2, 97, "the newest reading wins");
  assert.equal(status.stress, 40);
  assert.equal(status.hrv, 42);
  assert.equal(status.temperature, 36.5);
  assert.equal(status.sleep_score, 88);
});

test("the night's report reads back whole, not just its score", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  const today = formatLocalDate(new Date());
  // What the app sends: the watch's own field names, with everything it did not report left out.
  mergeHealthData(dir, {
    date: today,
    sleep_stats: [{
      timestamp: `${today}T07:00:00+08:00`,
      sleep_score: 88,
      bed_time: `${today}T22:40:00+08:00`,
      fall_asleep_time: `${today}T23:12:00+08:00`,
      wakeup_time: `${today}T07:00:00+08:00`,
      rising_time: `${today}T07:05:00+08:00`,
      sleep_efficiency: 92,
      sleep_latency: 12,
      deep_part: 21,
      min_hrv_baseline: 35,
      hrv_day_to_baseline: 7,
      sleep_version: 2,
    }],
  });
  // A day the watch sent no report for carries null, not an empty object.
  mergeHealthData(dir, { date: "2026-09-05", steps: { total: 1000 } });

  const summaries = readHealthToolResult(dir, { data_type: "daily_summary", time_range: "today" }).summaries;
  assert.deepEqual(summaries[0].sleep_stats, readDay(dir, today).sleep_stats[0], "the report goes out as it was sent");
  assert.equal(summaries[0].sleep_stats.fall_asleep_time, `${today}T23:12:00+08:00`);
  assert.equal(summaries[0].sleep_stats.min_hrv_baseline, 35);
  assert.equal(summaries[0].sleep_stats.sleep_version, 2);
  assert.equal(summaries[0].sleep_score, 88, "the single-figure field stays for its existing readers");
  assert.equal(dailySummary(readDay(dir, "2026-09-05")).sleep_stats, null);

  const status = readHealthToolResult(dir, { data_type: "current_status" });
  assert.deepEqual(status.sleep_stats, readDay(dir, today).sleep_stats[0]);
});

test("workouts merge by start time and read back on their own", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  const date = "2026-09-06";
  const run = {
    timestamp: `${date}T07:30:00+08:00`,
    activity: "running",
    name: "Morning run",
    end_time: `${date}T08:05:00+08:00`,
    duration_seconds: 2100,
    distance_m: 5200,
    calories: 310,
    avg_heart_rate: 148,
    steps: 4900,
  };
  mergeHealthData(dir, { date, workouts: [run] });
  // A re-send of the same workout, corrected by the watch, replaces it in place.
  mergeHealthData(dir, { date, workouts: [{ ...run, distance_m: 5150 }] });

  const record = readDay(dir, date);
  assert.equal(record.workouts.length, 1, "the same start time must overwrite, not append");
  assert.equal(record.workouts[0].distance_m, 5150);

  const result = readHealthToolResult(dir, { data_type: "workouts", time_range: "today" });
  assert.deepEqual(result.recent_workout_list, [{
    type: "running",
    name: "Morning run",
    start: "9/6 07:30",
    end: "9/6 08:05",
    duration_minutes: 35,
    duration_text: "0h 35min",
    distance_m: 5150,
    calories: 310,
    avg_heart_rate: 148,
    steps: 4900,
  }]);
});

test("a workout reads back with its zones and the watch's own figures", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    workouts: [{
      timestamp: "2026-09-06T07:30:00+08:00",
      activity: "indoor_walking",
      end_time: "2026-09-06T08:05:00+08:00",
      duration_seconds: 2100,
      max_heart_rate: 153,
      min_heart_rate: 91,
      workout_load: 19,
      aerobic_training_effect: 1.3,
      recovery_time_hours: 8,
      hr_zone_fat_burn_seconds: 110,
      hr_zone_aerobic_seconds: 1005,
      hr_zone_extreme_seconds: 0,
      avg_pace_seconds_km: 906.8,
      avg_step_rate_spm: 74,
      // A metric the watch never reports, on a row that somehow carries one.
      avg_ground_contact_ms: 248,
    }],
  });

  const [workout] = readHealthToolResult(dir, { data_type: "workouts", time_range: "today" }).recent_workout_list;

  assert.equal(workout.end, "9/6 08:05");
  assert.equal(workout.max_heart_rate, 153);
  assert.equal(workout.min_heart_rate, 91);
  assert.equal(workout.workout_load, 19);
  assert.equal(workout.aerobic_training_effect, 1.3);
  assert.equal(workout.recovery_time_hours, 8);
  assert.equal(workout.avg_pace_seconds_km, 906.8);
  assert.equal(workout.avg_step_rate_spm, 74);
  // The watch split the workout across all five zones, so zero time in one of them is a reading.
  assert.equal(workout.hr_zone_extreme_seconds, 0);
  // A zone the watch did not split stays out of the answer.
  assert.equal(workout.hr_zone_warm_up_seconds, undefined);
  // And so does a metric it has no sensor for, however the row came to hold one.
  assert.equal(workout.avg_ground_contact_ms, undefined);
});

test("a workout the watch reported no numbers for reads as its span alone", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    workouts: [{
      timestamp: "2026-09-06T18:00:00+08:00",
      activity: "walking",
      end_time: "2026-09-06T18:20:00+08:00",
      duration_seconds: 1200,
    }],
  });

  const result = readHealthToolResult(dir, { data_type: "workouts", time_range: "today" });
  assert.deepEqual(Object.keys(result.recent_workout_list[0]).sort(), ["duration_minutes", "duration_text", "end", "start", "type"]);
});

test("series returns the day's timestamped readings and sleep stages unaggregated", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    stress: [{ timestamp: "2026-09-06T08:00:00+08:00", value: 40, level: 2 }],
    hrv: [{ timestamp: "2026-09-06T08:00:00+08:00", value: 42 }],
    sleep_stats: [{ timestamp: "2026-09-06T07:00:00+08:00", sleep_score: 88, bed_time: "2026-09-05T22:40:00+08:00" }],
    emotions: [{ timestamp: "2026-09-06T10:00:00+08:00", last_timestamp: "2026-09-06T09:55:00+08:00", status: 2, valence: 3, arousal: 4 }],
    sleep_apnea: [{ timestamp: "2026-09-06T03:00:00+08:00", last_timestamp: "2026-09-06T02:55:00+08:00", level: 1 }],
    sleep: [{
      session_start_time: "2026-09-05T15:30:00Z",
      session_end_time: "2026-09-05T23:30:00Z",
      duration_seconds: 28800,
      stages: [{ start_time: "2026-09-05T15:30:00Z", end_time: "2026-09-05T16:00:00Z", duration_seconds: 1800, stage: "deep" }],
    }],
  });
  mergeHealthData(dir, { date: "2026-09-05", steps: { total: 1000 } });

  const result = readHealthToolResult(dir, { data_type: "series", days: 2 });
  assert.equal(result.data_type, "series");
  const day = result.series[0];
  assert.deepEqual(day.stress, [{ ts: "2026-09-06T08:00:00+08:00", value: 40, level: 2 }]);
  assert.deepEqual(day.hrv, [{ ts: "2026-09-06T08:00:00+08:00", value: 42 }]);
  assert.equal(day.heart_rate, undefined, "a series the day holds no readings for stays absent");
  assert.deepEqual(day.sleep_sessions[0].stages, [{ stage: "deep", start: "2026-09-05T15:30:00.000Z", end: "2026-09-05T16:00:00.000Z", duration_seconds: 1800 }]);
  assert.equal(day.sleep_sessions[0].session_key, undefined, "the storage dedup key is not part of the series");
  // The readings the day file keeps as whole objects travel with the series, under the watch's names.
  assert.deepEqual(day.sleep_stats, [{ timestamp: "2026-09-06T07:00:00+08:00", sleep_score: 88, bed_time: "2026-09-05T22:40:00+08:00" }]);
  assert.deepEqual(day.emotions[0], { timestamp: "2026-09-06T10:00:00+08:00", last_timestamp: "2026-09-06T09:55:00+08:00", status: 2, valence: 3, arousal: 4 });
  assert.deepEqual(day.sleep_apnea[0], { timestamp: "2026-09-06T03:00:00+08:00", last_timestamp: "2026-09-06T02:55:00+08:00", level: 1 });
  assert.equal(result.series[1].emotions, undefined, "a day the watch reported none for carries none");
  assert.equal(result.series[1].sleep_stats, undefined);
});

test("invalid calendar dates are rejected and repeated clear stays successful", () => {
  const dir = tmpDataDir();
  assert.throws(() => storeCycleConfig(dir, { ...confirmedCycle, last_start: "2026-02-30" }), /last_start/);
  storeCycleConfig(dir, confirmedCycle);
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
});

// Body battery: the walk runs on constructed minute series, so each rule shows on its own against the
// shipped parameter file.
// 最大心率搬到了身体电量和训练负荷共用的 heart-rate.json，walkBodyBattery 收到的仍是合并后的参数。
const BB_PARAMS = { ...readJson("body-battery.json"), ...readJson("heart-rate.json") };
const BB_T0 = Date.parse("2026-09-01T23:00:00+08:00");
const at = (minute) => BB_T0 + minute * 60000;

function readings(from, to, step, value) {
  const list = [];
  for (let minute = from; minute <= to; minute += step) list.push([at(minute), value]);
  return list;
}

function batteryInputs({ heartRate, workoutHeartRate = [], heartRateCoverage = [], stress = [], steps = [], sleeps, restingByDate = new Map([["2026-09-01", 50], ["2026-09-02", 50]]) }) {
  return { heartRate, workoutHeartRate, heartRateCoverage, stress, steps, restingByDate, sleeps, observedMaxHeartRate: 0 };
}

test("a calm night charges the battery, slower in its awake stages", () => {
  // Five hours at the shipped rates, so the level stays under the ceiling and the two charge rates
  // can be told apart.
  const night = (awake) => batteryInputs({ heartRate: readings(0, 300, 1, 50), stress: readings(0, 300, 10, 25), sleeps: [{ start: at(0), end: at(300), awake }] });
  const calm = walkBodyBattery(night([]), BB_PARAMS);
  assert.ok(calm.level > BB_PARAMS.initial_level + 30, `a calm night charges well, got ${calm.level}`);
  assert.ok(calm.events.find((event) => event.type === "sleep").change > 0);

  const woke = walkBodyBattery(night([[at(120), at(240)]]), BB_PARAMS);
  assert.ok(calm.level - woke.level > 5, "two hours awake in the night charge at the resting rate");
});

test("a stressed night drains instead of charging", () => {
  const walk = walkBodyBattery(batteryInputs({ heartRate: readings(0, 60, 1, 50), stress: readings(0, 60, 10, 40), sleeps: [{ start: at(0), end: at(60), awake: [] }] }), BB_PARAMS);
  assert.ok(walk.level < BB_PARAMS.initial_level);
  assert.ok(walk.events.find((event) => event.type === "sleep").change < 0);
});

test("长时间无心率也无步数判为离腕并冻结，有步数活动仍按缺测消耗", () => {
  const input = (steps) => batteryInputs({
    heartRate: [...readings(0, 60, 1, 50), [at(180), 50]],
    stress: readings(0, 60, 10, 18), steps,
    sleeps: [{ start: at(0), end: at(60), awake: [] }],
  });
  const walk = walkBodyBattery(input([]), BB_PARAMS);
  const gap = walk.events.find((event) => event.type === "data_gap" && event.reason === "heart_rate_unavailable");
  const unworn = walk.events.find((event) => event.type === "unworn");
  assert.equal(gap.start, at(60) + BB_PARAMS.unworn_after_minutes * 60000);
  assert.ok(gap.change < 0);
  assert.equal(unworn.start, gap.end, "静默够久才由缺测转为离腕");
  assert.equal(unworn.end, at(180));
  near(unworn.change, 0);
  assert.equal(walk.curve.at(-1).estimated, true, "前面的缺测仍标在曲线上");
  assert.equal(walk.end, at(180), "no minute past the last reading is walked");

  const worn = walkBodyBattery(input(Array.from({ length: 9 }, (_, i) => [at(70 + i * 12), 30])), BB_PARAMS);
  assert.ok(worn.events.every((event) => event.type !== "unworn"), "缺测期间有步数活动，说明仍戴着");
  assert.ok(worn.level < walk.level, "戴着时缺测继续消耗，不像离腕那样冻结");
});

test("a heart rate reserve above the threshold drains as activity", () => {
  const walk = walkBodyBattery(batteryInputs({ heartRate: readings(0, 30, 1, 140), sleeps: [{ start: at(0), end: at(1), awake: [] }] }), BB_PARAMS);
  assert.ok(walk.events.find((event) => event.type === "activity").change < -10);
});

test("the battery stays within its bounds", () => {
  const long = walkBodyBattery(batteryInputs({ heartRate: readings(0, 960, 1, 50), stress: readings(0, 960, 10, 15), sleeps: [{ start: at(0), end: at(960), awake: [] }] }), BB_PARAMS);
  assert.equal(long.level, BB_PARAMS.max_level);
  near(long.days.reduce((sum, day) => sum + day.charged - day.drained, 0), BB_PARAMS.max_level - BB_PARAMS.initial_level);
  const hard = walkBodyBattery(batteryInputs({ heartRate: readings(0, 120, 1, 160), sleeps: [{ start: at(0), end: at(1), awake: [] }] }), BB_PARAMS);
  assert.equal(hard.level, BB_PARAMS.min_level);
  near(hard.days.reduce((sum, day) => sum + day.charged - day.drained, 0), BB_PARAMS.min_level - BB_PARAMS.initial_level);
});

test("body battery reads through the tool, and is absent before the first night", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  assert.equal(readHealthToolResult(dir, { data_type: "body_battery" }).body_battery, null);

  const minutes = Array.from({ length: 420 }, (_, index) => new Date(Date.parse("2026-09-05T23:00:00+08:00") + index * 60000).toISOString());
  mergeHealthData(dir, {
    date: "2026-09-06",
    heart_rate: minutes.map((timestamp) => ({ timestamp, value: 52 })),
    stress: minutes.filter((_, index) => index % 10 === 0).map((timestamp) => ({ timestamp, value: 18, level: 1 })),
    resting_heart_rate: [{ timestamp: "2026-09-06T06:00:00+08:00", value: 50 }],
    sleep: [{ session_start_time: "2026-09-05T23:00:00+08:00", session_end_time: "2026-09-06T06:00:00+08:00", duration_seconds: 25200, stages: [] }],
  });
  const battery = readHealthToolResult(dir, { data_type: "body_battery", time_range: "today" }).body_battery;
  assert.ok(battery.level > BB_PARAMS.initial_level);
  assert.equal(battery.as_of, "9/6 06:00", "the walk ends at the latest reading, here the night's end");
  assert.equal(battery.observed_max_heart_rate, 52);
  assert.equal(battery.max_heart_rate_setting, BB_PARAMS.max_heart_rate);
  assert.deepEqual(battery.daily.map((day) => day.date), ["2026-09-06"], "only the asked days are shown");
  const history = readHealthToolResult(dir, { data_type: "body_battery", days: 3 }).body_battery;
  assert.equal(history.level, battery.level);
  assert.equal(history.as_of, battery.as_of);
  assert.deepEqual(history.curve.filter((point) => point.time.startsWith("9/6 ")), battery.curve);
});

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `实际 ${actual}，预期 ${expected}`);
}

test("跨过活动阈值不能降低压力或低强度耗电", () => {
  for (const pressure of [null, 18, 70]) {
    const levels = [91, 92, 93, 100, 140].map((bpm) => walkBodyBattery(batteryInputs({
      heartRate: readings(0, 10, 1, bpm),
      stress: pressure === null ? [] : readings(0, 10, 1, pressure),
      sleeps: [{ start: at(0), end: at(10), awake: [] }],
    }), BB_PARAMS).level);
    for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1], `压力 ${pressure}：心率增加后不能少耗电`);
    if (pressure === 70) near(levels[2], BB_PARAMS.initial_level - 10 * BB_PARAMS.stress_drain_per_stress_point * pressure);
    if (pressure === null) near(levels[2], BB_PARAMS.initial_level - 10 * BB_PARAMS.low_intensity_drain_per_minute);
  }
});

test("首夜及其夜醒使用醒来日静息心率而非入睡日基线", () => {
  const input = (restingByDate) => batteryInputs({
    heartRate: readings(0, 90, 1, 95), stress: readings(0, 90, 10, 25),
    sleeps: [{ start: at(0), end: at(90), awake: [[at(10), at(20)]] }], restingByDate,
  });
  const onlyWakingDay = walkBodyBattery(input(new Map([["2026-09-02", 50]])), BB_PARAMS);
  const previousDayDifferent = walkBodyBattery(input(new Map([["2026-09-01", 100], ["2026-09-02", 50]])), BB_PARAMS);
  near(onlyWakingDay.level, BB_PARAMS.initial_level - 90 * BB_PARAMS.low_intensity_drain_per_minute);
  assert.deepEqual(previousDayDifferent, onlyWakingDay);
});

test("缺少必需的静息心率明确失败，心率缺测估算无需基线", () => {
  const inputs = batteryInputs({
    heartRate: readings(0, 1, 1, 140), stress: readings(0, 1, 1, 18),
    sleeps: [{ start: at(0), end: at(1), awake: [] }], restingByDate: new Map(),
  });
  assert.throws(() => walkBodyBattery(inputs, BB_PARAMS), /静息心率.*2026-09-01|2026-09-01.*静息心率/);
  const noHeartRate = walkBodyBattery({ ...inputs, heartRate: [] }, BB_PARAMS);
  near(noHeartRate.level, BB_PARAMS.initial_level - BB_PARAMS.low_intensity_drain_per_minute);
  assert.equal(noHeartRate.curve.at(-1).estimated, true);
});

test("一分钟和不足一分钟只按实际经过时长积分", () => {
  for (const duration of [1, 0.5, 1.25]) {
    const start = at(0.25); const end = start + duration * 60000;
    const walk = walkBodyBattery(batteryInputs({
      heartRate: [[start, 140], [end, 50]], stress: [[start, 40]],
      sleeps: [{ start, end, awake: [] }],
    }), BB_PARAMS);
    const activityDrain = BB_PARAMS.activity_drain_per_reserve * ((140 - 50) / (BB_PARAMS.max_heart_rate - 50) - BB_PARAMS.activity_reserve_threshold);
    near(walk.level, BB_PARAMS.initial_level - duration * activityDrain);
    assert.equal(walk.end, end);
    assert.deepEqual(walk.curve[0], { t: start, level: BB_PARAMS.initial_level, estimated: false, interval_estimated: false });
    assert.equal(walk.curve.at(-1).t, end);
    near(walk.curve.at(-1).level, walk.level);
    assert.ok(walk.events.every((event) => event.start >= start && event.end <= end));
    assert.equal(walk.events.find((event) => event.type === "activity").end, end);
    near(walk.days[0].max, BB_PARAMS.initial_level);
    near(walk.days[0].drained, BB_PARAMS.initial_level - walk.level);
  }
});

test("读数和清醒阶段在带秒的真实边界切换", () => {
  const start = at(0.1); const end = at(1.6);
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [[start, 50], [end, 50]],
    stress: [[start, 25], [at(0.9), 40]],
    sleeps: [{ start, end: at(1.2), awake: [[at(0.4), at(0.7)]] }],
  }), BB_PARAMS);
  const charged = 0.5 * BB_PARAMS.sleep_charge_per_stress_point * 5 + 0.3 * BB_PARAMS.rest_charge_per_stress_point * 5;
  const drained = 0.7 * BB_PARAMS.stress_drain_per_stress_point * 40;
  near(walk.level, BB_PARAMS.initial_level + charged - drained);
  near(walk.days[0].charged, charged);
  near(walk.days[0].drained, drained);
  assert.equal(walk.events.find((event) => event.type === "sleep").end, at(1.2));
});

test("心率和压力在有效期结束的瞬间过期", () => {
  const start = at(0.25);
  const hrEnd = start + (BB_PARAMS.unworn_after_minutes + 0.5) * 60000;
  const hrWalk = walkBodyBattery(batteryInputs({
    heartRate: [[start, 50]], stress: [[start, 25]],
    sleeps: [{ start, end: hrEnd, awake: [] }],
  }), BB_PARAMS);
  near(hrWalk.level, BB_PARAMS.initial_level + BB_PARAMS.unworn_after_minutes * BB_PARAMS.sleep_charge_per_stress_point * 5 - 0.5 * BB_PARAMS.low_intensity_drain_per_minute);
  assert.equal(hrWalk.events.find((event) => event.reason === "heart_rate_unavailable").start, start + BB_PARAMS.unworn_after_minutes * 60000);

  const stressDuration = BB_PARAMS.stress_hold_minutes + 0.5;
  const stressEnd = start + stressDuration * 60000;
  const stressWalk = walkBodyBattery(batteryInputs({
    heartRate: Array.from({ length: Math.ceil(stressDuration) }, (_, i) => [start + i * 60000, 50]),
    stress: [[start, 25]], sleeps: [{ start, end: stressEnd, awake: [] }],
  }), BB_PARAMS);
  near(stressWalk.level, BB_PARAMS.initial_level + BB_PARAMS.stress_hold_minutes * BB_PARAMS.sleep_charge_per_stress_point * 5 - 0.5 * BB_PARAMS.low_intensity_drain_per_minute);
  assert.equal(stressWalk.curve.at(-1).estimated, true);
});

test("活动时缺少压力仍标明估算，追加终点读数不会倒改已积分时段", () => {
  const input = batteryInputs({ heartRate: readings(0, 5, 1, 100), sleeps: [{ start: at(0), end: at(5), awake: [] }] });
  const walk = walkBodyBattery(input, BB_PARAMS);
  assert.equal(walk.curve.at(-1).estimated, true);
  const terminalReading = walkBodyBattery({ ...input, stress: [[at(5), 99]] }, BB_PARAMS);
  assert.deepEqual(terminalReading, walk);
});

test("午夜分摊真实时长，跨日充放电收支守恒", () => {
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [[at(59.5), 50], [at(60.5), 50]], stress: [[at(59.5), 40]],
    sleeps: [{ start: at(59.5), end: at(60.5), awake: [] }],
  }), BB_PARAMS);
  assert.deepEqual(walk.days.map((day) => day.date), ["2026-09-01", "2026-09-02"]);
  const halfMinuteDrain = BB_PARAMS.stress_drain_per_stress_point * 40 / 2;
  near(walk.days[0].drained, halfMinuteDrain);
  near(walk.days[1].drained, halfMinuteDrain);
  near(walk.days[0].max, BB_PARAMS.initial_level);
  near(walk.days[1].max, walk.days[0].min);
  near(walk.level, BB_PARAMS.initial_level + walk.days.reduce((sum, day) => sum + day.charged - day.drained, 0));
});

test("补传同一睡眠的清醒阶段和评分，与一次完整上传得到相同电量", (t) => {
  freezeClock(t);
  const resentDir = tmpDataDir(); const completeDir = tmpDataDir();
  const start = Date.parse("2026-09-06T01:00:00+08:00");
  const timestamp = (m) => new Date(start + m * 60000).toISOString();
  const sleep = { session_start_time: timestamp(0), session_end_time: timestamp(240), duration_seconds: 14400, stages: [] };
  const corrected = { ...sleep, score: 90, stages: [{ stage: "awake", start_time: timestamp(60), end_time: timestamp(180), duration_seconds: 7200 }] };
  const data = {
    date: "2026-09-06",
    heart_rate: Array.from({ length: 241 }, (_, m) => ({ timestamp: timestamp(m), value: 50 })),
    stress: Array.from({ length: 25 }, (_, m) => ({ timestamp: timestamp(m * 10), value: 25 })),
    resting_heart_rate: [{ timestamp: timestamp(0), value: 50 }],
  };
  mergeHealthData(resentDir, { ...data, sleep: [sleep] });
  mergeHealthData(resentDir, { date: data.date, sleep: [corrected] });
  mergeHealthData(completeDir, { ...data, sleep: [corrected] });
  assert.deepEqual(readDay(resentDir, data.date).sleep_sessions, readDay(completeDir, data.date).sleep_sessions);
  assert.equal(readDay(resentDir, data.date).sleep_sessions[0].score, 90);
  const query = { data_type: "body_battery", time_range: "today" };
  const resent = readHealthToolResult(resentDir, query).body_battery;
  assert.deepEqual(resent, readHealthToolResult(completeDir, query).body_battery);
  assert.equal(resent.level, Math.round(BB_PARAMS.initial_level + 120 * (BB_PARAMS.sleep_charge_per_stress_point + BB_PARAMS.rest_charge_per_stress_point) * 5));
  mergeHealthData(resentDir, { date: data.date, sleep: [corrected] });
  assert.deepEqual(readHealthToolResult(resentDir, query).body_battery, resent);
});

test("电量工具保留非整分钟时间，缺少基线通过 MCP 明确报错", async (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  const start = "2026-09-06T01:00:15.250+08:00";
  const end = "2026-09-06T01:01:45.500+08:00";
  mergeHealthData(dir, {
    date: "2026-09-06", heart_rate: [{ timestamp: start, value: 140 }, { timestamp: end, value: 140 }],
    sleep: [{ session_start_time: start, session_end_time: end, duration_seconds: 90.25, stages: [] }],
  });
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "body-battery-error-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const failed = await client.callTool({ name: "health_read", arguments: { data_type: "body_battery" } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /2026-09-06.*静息心率/);

  mergeHealthData(dir, { date: "2026-09-06", resting_heart_rate: [{ timestamp: end, value: 50 }] });
  const battery = readHealthToolResult(dir, { data_type: "body_battery", days: 1 }).body_battery;
  assert.equal(battery.as_of, "9/6 01:01:45.500");
  assert.equal(battery.curve[0].time, "9/6 01:00:15.250");
  assert.equal(battery.curve.at(-1).time, battery.as_of);
  assert.equal(battery.events.find((event) => event.type === "activity").end, battery.as_of);
});

test("一分钟步数整日快照替换旧五分钟桶，重传和清空都不重复累计", (t) => {
  freezeClock(t);
  const dir = tmpDataDir(); const date = "2026-09-06";
  mergeHealthData(dir, { date, steps: [{ timestamp: `${date}T08:00:00+08:00`, value: 50 }, { timestamp: `${date}T08:05:00+08:00`, value: 30 }] });
  const snapshot = { date, steps_bucket_seconds: 60, steps: Array.from({ length: 8 }, (_, i) => ({ timestamp: `${date}T08:0${i}:00+08:00`, value: 10 })) };
  mergeHealthData(dir, snapshot);
  assert.equal(readDay(dir, date).steps.total, 80);
  assert.equal(readDay(dir, date).steps.samples.length, 8);
  mergeHealthData(dir, snapshot);
  assert.equal(readDay(dir, date).steps.total, 80);
  assert.equal(readHealthToolResult(dir, { data_type: "series" }).series[0].steps_bucket_seconds, 60);
  mergeHealthData(dir, { date, steps_bucket_seconds: 60, steps: [] });
  assert.equal(readDay(dir, date).steps.total, 0);
  assert.deepEqual(readDay(dir, date).steps.samples, []);
});

test("覆盖区间采用整日替换，空快照移除旧分段，省略字段保留历史", (t) => {
  freezeClock(t);
  const dir = tmpDataDir(); const date = "2026-09-06";
  const range = (from, to, status) => ({ timestamp: `${date}T${from}:00+08:00`, end_time: `${date}T${to}:00+08:00`, status });
  mergeHealthData(dir, { date, heart_rate_coverage: [range("08:00", "09:00", "missing")] });
  const snapshot = { date, heart_rate_coverage: [range("08:00", "08:30", "observed"), range("08:30", "09:00", "missing")] };
  mergeHealthData(dir, snapshot);
  mergeHealthData(dir, snapshot);
  assert.equal(readDay(dir, date).heart_rate_coverage.length, 2);
  mergeHealthData(dir, { date, stress: [] });
  assert.equal(readDay(dir, date).heart_rate_coverage.length, 2);
  assert.equal(readHealthToolResult(dir, { data_type: "series" }).series[0].heart_rate_coverage.length, 2);
  mergeHealthData(dir, { date, heart_rate_coverage: [] });
  assert.deepEqual(readDay(dir, date).heart_rate_coverage, []);
  assert.throws(() => mergeHealthData(dir, { date, heart_rate_coverage: [range("09:00", "08:00", "missing")] }), /heart_rate_coverage/);
});

test("压力局部过渡连续，区间外睡眠清醒活动三条分支保持原速率", () => {
  const level = (pressure, awake, bpm = 50) => walkBodyBattery(batteryInputs({
    heartRate: readings(0, 1, 1, bpm), stress: [[at(0), pressure]],
    sleeps: [{ start: at(0), end: at(1), awake: awake ? [[at(0), at(1)]] : [] }],
  }), BB_PARAMS).level;
  const threshold = BB_PARAMS.stress_threshold; const width = BB_PARAMS.stress_transition_half_width;
  for (const awake of [false, true]) {
    for (const bpm of [50, 93, 140]) {
      for (const edge of [threshold - width, threshold, threshold + width]) {
        assert.ok(Math.abs(level(edge - 0.00001, awake, bpm) - level(edge + 0.00001, awake, bpm)) < 0.00001);
      }
      for (const pressure of [0, threshold - width, threshold + width, 60, 100]) {
        const charge = (awake ? BB_PARAMS.rest_charge_per_stress_point : BB_PARAMS.sleep_charge_per_stress_point) * (threshold - pressure);
        const stressDrain = pressure >= threshold ? BB_PARAMS.stress_drain_per_stress_point * pressure : 0;
        const reserve = (bpm - 50) / (BB_PARAMS.max_heart_rate - 50);
        const delta = reserve > BB_PARAMS.activity_reserve_threshold
          ? -Math.max(BB_PARAMS.low_intensity_drain_per_minute, BB_PARAMS.activity_drain_per_reserve * (reserve - BB_PARAMS.activity_reserve_threshold), stressDrain)
          : pressure < threshold ? charge : -stressDrain;
        near(level(pressure, awake, bpm), BB_PARAMS.initial_level + delta);
      }
    }
    near(level(threshold, awake), BB_PARAMS.initial_level - 0.5 * BB_PARAMS.stress_drain_per_stress_point * threshold);
  }
  const missing = batteryInputs({ heartRate: [], stress: [[at(0), threshold]], sleeps: [{ start: at(0), end: at(1), awake: [] }] });
  near(walkBodyBattery(missing, BB_PARAMS).level, BB_PARAMS.initial_level - BB_PARAMS.low_intensity_drain_per_minute);
  near(walkBodyBattery(missing, { ...BB_PARAMS, stress_transition_half_width: 10 }).level, walkBodyBattery(missing, BB_PARAMS).level);
});

test("五秒运动心率覆盖分钟心率，点数增加不重复累计时长", () => {
  const workoutHeartRate = Array.from({ length: 13 }, (_, i) => [at(i / 12), 140]);
  const input = batteryInputs({ heartRate: [], workoutHeartRate, stress: [[at(0), 30]], sleeps: [{ start: at(0), end: at(1), awake: [] }] });
  const walk = walkBodyBattery(input, BB_PARAMS);
  const withMinute = walkBodyBattery({ ...input, heartRate: readings(0, 1, 1, 180) }, BB_PARAMS);
  assert.deepEqual(withMinute, walk);
  const rate = BB_PARAMS.activity_drain_per_reserve * ((140 - 50) / (BB_PARAMS.max_heart_rate - 50) - BB_PARAMS.activity_reserve_threshold);
  near(walk.level, BB_PARAMS.initial_level - rate);
  near(walk.contributions.activity.minutes, 1);
  assert.equal(walk.end, at(1));
});

test("高频末点五秒后过期，不复活更早的分钟心率", () => {
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [[at(0), 180]], workoutHeartRate: [[at(0.5), 140]], stress: [[at(0), 30]],
    sleeps: [{ start: at(0), end: at(1), awake: [] }],
  }), BB_PARAMS);
  const gap = walk.events.find((event) => event.reason === "heart_rate_unavailable");
  assert.equal(gap.start, at(0.5) + 5000);
  near(walk.estimation.minutes, 25 / 60);
  const withNewMinute = walkBodyBattery(batteryInputs({
    heartRate: [[at(0), 180], [at(0.75), 50]], workoutHeartRate: [[at(0.5), 140]], stress: [[at(0), 30]],
    sleeps: [{ start: at(0), end: at(1), awake: [] }],
  }), BB_PARAMS);
  near(withNewMinute.estimation.minutes, 10 / 60);
});

test("心率按有效期过期后才用原始覆盖区分缺测和未知", () => {
  const expiry = BB_PARAMS.unworn_after_minutes;
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [[at(0), 50]], stress: [[at(0), 25]],
    heartRateCoverage: [{ start: at(1), end: at(expiry + 0.5), status: "missing" }],
    sleeps: [{ start: at(0), end: at(expiry + 1), awake: [] }],
  }), BB_PARAMS);
  assert.deepEqual(walk.events.filter((event) => event.type === "data_gap").map(({ start, end, reason }) => ({ start, end, reason })), [
    { start: at(expiry), end: at(expiry + 0.5), reason: "heart_rate_missing" },
    { start: at(expiry + 0.5), end: at(expiry + 1), reason: "heart_rate_unavailable" },
  ]);
  near(walk.contributions.heart_rate_missing.minutes, 0.5);
  near(walk.contributions.heart_rate_unavailable.minutes, 0.5);
  near(walk.estimation.minutes, 1);
});

test("正常十分钟夜间采样的missing分钟不缩短有效期或扩大估算", () => {
  const input = batteryInputs({
    heartRate: readings(0, 60, 10, 50), stress: readings(0, 60, 10, 25),
    sleeps: [{ start: at(0), end: at(60), awake: [] }],
  });
  const coverage = Array.from({ length: 6 }, (_, i) => [
    { start: at(i * 10), end: at(i * 10 + 1), status: "observed" },
    { start: at(i * 10 + 1), end: at(i * 10 + 10), status: "missing" },
  ]).flat();
  const without = walkBodyBattery(input, BB_PARAMS);
  const withCoverage = walkBodyBattery({ ...input, heartRateCoverage: coverage }, BB_PARAMS);
  assert.deepEqual(withCoverage, without);
  near(withCoverage.estimation.minutes, 0);
});

test("五秒心率过期后按原始覆盖区分缺测，不复用更早普通点", () => {
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [[at(0), 50]], workoutHeartRate: [[at(0.5), 140]], stress: [[at(0), 30]],
    heartRateCoverage: [{ start: at(0.25), end: at(0.75), status: "missing" }],
    sleeps: [{ start: at(0), end: at(1), awake: [] }],
  }), BB_PARAMS);
  near(walk.contributions.activity.minutes, 5 / 60);
  near(walk.contributions.heart_rate_missing.minutes, 10 / 60);
  near(walk.contributions.heart_rate_unavailable.minutes, 15 / 60);
});

test("覆盖区间跨午夜按半开边界切换，已有覆盖不会伪造有效心率", () => {
  const walk = walkBodyBattery(batteryInputs({
    heartRate: [], stress: [],
    heartRateCoverage: [
      { start: at(59.5), end: at(60), status: "missing" },
      { start: at(60), end: at(60.5), status: "observed" },
    ],
    sleeps: [{ start: at(59.5), end: at(59.6), awake: [] }],
  }), BB_PARAMS);
  assert.equal(walk.end, at(60.5));
  near(walk.days[0].estimated_minutes, 0.5);
  near(walk.days[1].estimated_minutes, 0.5);
  assert.equal(walk.events.find((event) => event.reason === "heart_rate_missing").end, at(60));
  assert.equal(walk.events.find((event) => event.reason === "heart_rate_unavailable").start, at(60));
});

test("恢复观测后累计估算仍保留，贡献收支等于电量变化", () => {
  const walk = walkBodyBattery(batteryInputs({
    heartRate: readings(20, 60, 1, 50), stress: readings(20, 60, 10, 25),
    sleeps: [{ start: at(0), end: at(60), awake: [] }],
  }), BB_PARAMS);
  assert.equal(walk.curve.at(-1).estimated, true);
  assert.equal(walk.curve.at(-1).interval_estimated, false);
  near(walk.estimation.minutes, 20);
  near(walk.estimation.drained, 20 * BB_PARAMS.low_intensity_drain_per_minute);
  const contributions = Object.values(walk.contributions);
  near(contributions.reduce((sum, value) => sum + value.minutes, 0), 60);
  near(contributions.reduce((sum, value) => sum + value.charged - value.drained, 0), walk.level - BB_PARAMS.initial_level);
});

test("运动恢复心率跨午夜不被运动结束截断，补传与一次上传一致", (t) => {
  freezeClock(t);
  const partialDir = tmpDataDir(); const fullDir = tmpDataDir();
  const day = "2026-09-05"; const nextDay = "2026-09-06";
  const start = Date.parse(`${day}T23:59:30+08:00`);
  const stamp = (seconds) => new Date(start + seconds * 1000).toISOString();
  const points = Array.from({ length: 13 }, (_, i) => ({ timestamp: stamp(i * 5), value: i < 6 ? 140 : 80 }));
  const workout = { timestamp: stamp(0), end_time: stamp(30), duration_seconds: 30, activity: "indoor_cycling", heart_rate: points };
  const base = { date: day, stress: [{ timestamp: stamp(0), value: 30 }], resting_heart_rate: [{ timestamp: stamp(0), value: 50 }] };
  const sleep = { date: day, sleep: [{ session_start_time: stamp(0), session_end_time: stamp(10), duration_seconds: 10, stages: [] }] };
  for (const dir of [partialDir, fullDir]) { mergeHealthData(dir, base); mergeHealthData(dir, sleep); }
  mergeHealthData(partialDir, { date: day, workouts: [{ ...workout, heart_rate: points.slice(0, 6) }] });
  mergeHealthData(partialDir, { date: day, workouts: [workout] });
  mergeHealthData(fullDir, { date: day, workouts: [workout] });
  const request = { data_type: "body_battery", days: 3 };
  const result = readHealthToolResult(partialDir, request).body_battery;
  assert.deepEqual(result, readHealthToolResult(fullDir, request).body_battery);
  assert.equal(result.as_of, "9/6 00:00:30");
  assert.deepEqual(result.daily.map((value) => value.date), [day, nextDay]);
  assert.equal(result.observed_max_heart_rate, 140);
  assert.equal(result.initial.source, "configured");
  assert.equal(result.estimated, false);
  const raw = readHealthToolResult(partialDir, { data_type: "series", days: 3 }).series[0];
  assert.deepEqual(raw.workouts[0].heart_rate, points);
  const today = readHealthToolResult(partialDir, { data_type: "body_battery", days: 1 }).body_battery;
  assert.equal(today.level, result.level);
  assert.deepEqual(today.contributions, result.contributions);
  mergeHealthData(partialDir, { date: day, workouts: [workout] });
  assert.deepEqual(readHealthToolResult(partialDir, request).body_battery, result);
});

// 训练负荷：走完整读取路径，从落盘的原始运动对象算出三种口径，再按方法和运动类型读回。
const TL_PARAMS = readJson("training-load.json");
const MAX_HEART_RATE = readJson("heart-rate.json").max_heart_rate;

function workoutHeartRate(startIso, segments) {
  const samples = [];
  let second = 0;
  for (const [minutes, bpm] of segments) {
    for (let index = 0; index < minutes * 12; index += 1) {
      samples.push({ timestamp: new Date(Date.parse(startIso) + second * 1000).toISOString(), value: bpm });
      second += 5;
    }
  }
  return samples;
}

// 2026-09-05 一小时跑（心率分段），2026-09-06 半小时骑行，两天各有一条静息心率。
function trainingFixtures(dir) {
  const resting = (date) => ({ resting_heart_rate: [{ timestamp: `${date}T06:00:00+08:00`, value: 50 }] });
  mergeHealthData(dir, { date: "2026-09-05", ...resting("2026-09-05"), workouts: [{
    timestamp: "2026-09-05T07:00:00+08:00", end_time: "2026-09-05T08:00:00+08:00", duration_seconds: 3600,
    activity: "running", avg_heart_rate: 140, workout_load: 42,
    heart_rate: workoutHeartRate("2026-09-05T07:00:00+08:00", [[10, 120], [40, 140], [10, 160]]),
  }] });
  mergeHealthData(dir, { date: "2026-09-06", ...resting("2026-09-06"), workouts: [{
    timestamp: "2026-09-06T07:00:00+08:00", end_time: "2026-09-06T07:30:00+08:00", duration_seconds: 1800,
    activity: "indoor_cycling", avg_heart_rate: 130, workout_load: 21,
    heart_rate: workoutHeartRate("2026-09-06T07:00:00+08:00", [[30, 130]]),
  }] });
  return dir;
}

const tlRead = (dir, args) => readHealthToolResult(dir, { data_type: "training_load", ...args }).training_load;

test("训练负荷按方法和运动类型读取，今天标记为暂定", (t) => {
  freezeClock(t);
  const dir = trainingFixtures(tmpDataDir());
  const result = tlRead(dir, { days: 3 });

  assert.equal(result.method, "trimp_average");
  assert.equal(result.unit, "trimp");
  assert.equal(result.activity, "all");
  assert.equal(result.metadata.parameters.max_heart_rate, MAX_HEART_RATE);
  assert.equal(result.metadata.parameters.max_heart_rate_source, "heart-rate.json");
  assert.equal(result.metadata.parameters.ctl_time_constant_days, TL_PARAMS.ctl_time_constant_days);
  assert.equal(result.metadata.formula_source, TL_PARAMS.formula_source);
  assert.equal(result.metadata.data_scope, "recorded_workouts");
  assert.equal(result.metadata.sync_completeness, "unverified");
  assert.deepEqual(result.initialization, {
    start_date: "2026-09-05", initial_ctl: 0, initial_atl: 0,
    initial_value_source: "configured", days_computed: 2, assumes_no_prior_training: false,
  });
  // 只返回查询窗口内的日期，窗口外的历史照常参与递推。
  assert.deepEqual(result.daily.map((day) => day.date), ["2026-09-05", "2026-09-06"]);
  assert.equal(result.window.days, 3);
  assert.equal(result.daily[0].load, 84.8, "一小时 × 平均心率 140 的 TRIMP");
  assert.equal(result.daily[0].ctl, 2, "首日 CTL 是当日负荷按 42 天时间常数递推");
  assert.equal(result.daily[1].provisional, true);
  assert.equal(result.summary.date, "2026-09-06");
  assert.equal(result.summary.tsb, -9.3, "TSB 是当天训练前的 CTL 与 ATL 之差");
  assert.equal(result.summary.provisional, true);
  assert.equal(result.window_load, 117.7);

  // 三种口径各自独立：设备负荷用 workout_load，积分法按心率序列积分。
  assert.equal(tlRead(dir, { days: 3, method: "device_load" }).daily[0].load, 42);
  assert.equal(tlRead(dir, { days: 3, method: "device_load" }).unit, "workout_load");
  assert.equal(tlRead(dir, { days: 3, method: "trimp_integrated" }).daily[0].load, 87.6);

  const cycling = tlRead(dir, { days: 3, activity: "indoor_cycling" });
  assert.equal(cycling.activity, "indoor_cycling");
  assert.equal(cycling.initialization.start_date, "2026-09-06");
  assert.deepEqual(cycling.daily.map((day) => day.load), [32.9], "按类型读取时序列从该类型的首场运动起算");
  assert.equal(cycling.activities, undefined, "按类型读取时不再另外拆分");

  assert.deepEqual(result.activities.map((entry) => entry.activity), ["indoor_cycling", "running"]);
  near(result.activities.reduce((sum, entry) => sum + entry.load, 0), result.window_load, "全部运动等于各类型之和");
  assert.equal(result.activities[0].workouts, 1);
});

test("训练负荷明细给出每场运动的三种口径、覆盖时间与分日依据", (t) => {
  freezeClock(t);
  const dir = trainingFixtures(tmpDataDir());
  const [cycling, running] = tlRead(dir, { days: 3, training_load_detail: "workouts" }).workouts;

  assert.equal(running.type, "running");
  assert.equal(running.start, "9/5 07:00");
  assert.equal(running.end, "9/5 08:00");
  assert.equal(running.duration_seconds, 3600);
  assert.deepEqual(running.dates, ["2026-09-05"]);
  assert.deepEqual(running.daily_split, [{ date: "2026-09-05", load: 84.8, allocation: "exact" }]);
  assert.deepEqual(running.loads.trimp_average.basis, {
    duration_seconds: 3600, average_heart_rate: 140, resting_heart_rate: 50,
    resting_heart_rate_date: "2026-09-05", max_heart_rate: MAX_HEART_RATE, hr_ratio: 0.643,
  });
  assert.equal(running.loads.trimp_integrated.coverage.covered_seconds, 3600);
  assert.equal(running.loads.trimp_integrated.coverage.uncovered_seconds, 0);
  assert.deepEqual(running.loads.device_load, { load: 42, status: "computed", basis: { field: "workout_load" } });

  assert.equal(cycling.type, "indoor_cycling");
  assert.equal(cycling.loads.trimp_integrated.load, 32.9);
});

test("改查询窗口不改变同一天的训练负荷结果", (t) => {
  freezeClock(t);
  const dir = trainingFixtures(tmpDataDir());
  const short = tlRead(dir, { days: 2 });
  const long = tlRead(dir, { days: 30 });
  assert.deepEqual(short.daily, long.daily.slice(-2));
  assert.deepEqual(short.summary, long.summary);
  assert.deepEqual(short.initialization, long.initialization);
});

test("补传和修正后的运动会重算训练负荷", (t) => {
  freezeClock(t);
  const partial = tmpDataDir();
  const complete = tmpDataDir();
  const running = {
    timestamp: "2026-09-05T07:00:00+08:00", end_time: "2026-09-05T08:00:00+08:00", duration_seconds: 3600,
    activity: "running", avg_heart_rate: 140, workout_load: 42,
    heart_rate: workoutHeartRate("2026-09-05T07:00:00+08:00", [[10, 120], [40, 140], [10, 160]]),
  };
  const firstHalf = { ...running, heart_rate: running.heart_rate.slice(0, 2400) };
  for (const dir of [partial, complete]) mergeHealthData(dir, { date: "2026-09-05", resting_heart_rate: [{ timestamp: "2026-09-05T06:00:00+08:00", value: 50 }] });
  // 先传一段残缺的心率序列，再补一次完整的：与一次传完整结果一致。
  mergeHealthData(partial, { date: "2026-09-05", workouts: [firstHalf] });
  mergeHealthData(partial, { date: "2026-09-05", workouts: [running] });
  mergeHealthData(complete, { date: "2026-09-05", workouts: [running] });
  assert.deepEqual(tlRead(partial, { days: 2 }), tlRead(complete, { days: 2 }));

  // 同一开始时间的记录被修正后，负荷跟着变。
  const before = tlRead(complete, { days: 2 }).daily[0].load;
  mergeHealthData(complete, { date: "2026-09-05", workouts: [{ ...running, duration_seconds: 1800, end_time: "2026-09-05T07:30:00+08:00" }] });
  assert.equal(tlRead(complete, { days: 2 }).daily[0].load, before / 2);
});

test("没有运动记录与运动算不出来是两种状态", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  assert.equal(readHealthToolResult(dir, { data_type: "training_load", days: 3 }).training_load, null, "全历史没有运动时没有可递推的序列");

  // 有运动但缺平均心率、缺设备负荷，也不产生静息心率：算不出来的一天保留缺失状态。
  mergeHealthData(dir, { date: "2026-09-05", workouts: [{ timestamp: "2026-09-05T07:00:00+08:00", duration_seconds: 3600, activity: "running" }] });
  const result = tlRead(dir, { days: 3 });
  assert.deepEqual(result.daily.map((day) => day.date), ["2026-09-05", "2026-09-06"]);
  assert.equal(result.daily[0].load_status, "partial");
  assert.equal(result.daily[0].workouts, 1);
  // 每种口径只报自己的缺失原因，互不影响。
  assert.deepEqual(result.daily[0].uncomputable, [{ activity: "running", reason: "missing_average_heart_rate" }]);
  assert.deepEqual(tlRead(dir, { days: 3, method: "trimp_integrated" }).daily[0].uncomputable, [{ activity: "running", reason: "no_heart_rate_samples" }]);
  assert.deepEqual(tlRead(dir, { days: 3, method: "device_load" }).daily[0].uncomputable, [{ activity: "running", reason: "missing_workout_load" }]);
  assert.equal(result.daily[0].load, 0, "已计算部分的负荷小计");
  assert.equal(result.daily[0].ctl, null, "不把缺失的负荷当作零，不给貌似完整的指标");
  assert.equal(result.daily[0].metrics_status, "blocked");
  assert.equal(result.daily[1].metrics_status, "blocked", "缺失状态保留到之后的日期");
  assert.equal(result.daily[1].blocked_since, "2026-09-05");
  assert.equal(result.daily[1].load_status, "complete", "这一天没有已入库运动，不是算不出来");
  assert.equal(result.daily[1].workouts, 0);
  assert.equal(result.summary.ctl, null);

  // 静息心率缺失只影响两种 TRIMP，设备负荷照常。
  mergeHealthData(dir, { date: "2026-09-05", workouts: [{ timestamp: "2026-09-05T07:00:00+08:00", duration_seconds: 3600, activity: "running", workout_load: 30 }] });
  const deviceOnly = tlRead(dir, { days: 3, method: "device_load" });
  assert.equal(deviceOnly.daily[0].load, 30);
  assert.equal(deviceOnly.daily[0].ctl, 0.7, "设备负荷的输入齐全，照常递推");
});

test("最大心率取自两个算法共用的配置文件", (t) => {
  freezeClock(t);
  const dir = trainingFixtures(tmpDataDir());
  const minutes = Array.from({ length: 420 }, (_, index) => new Date(Date.parse("2026-09-05T23:00:00+08:00") + index * 60000).toISOString());
  mergeHealthData(dir, {
    date: "2026-09-06",
    heart_rate: minutes.map((timestamp) => ({ timestamp, value: 52 })),
    stress: minutes.filter((_, index) => index % 10 === 0).map((timestamp) => ({ timestamp, value: 18, level: 1 })),
    sleep: [{ session_start_time: "2026-09-05T23:00:00+08:00", session_end_time: "2026-09-06T06:00:00+08:00", duration_seconds: 25200, stages: [] }],
  });
  const battery = readHealthToolResult(dir, { data_type: "body_battery", days: 3 }).body_battery;
  assert.equal(battery.max_heart_rate_setting, MAX_HEART_RATE);
  assert.equal(readJson("body-battery.json").max_heart_rate, undefined, "身体电量参数文件里不再另存一份最大心率");
  assert.equal(tlRead(dir, { days: 3 }).metadata.parameters.max_heart_rate, MAX_HEART_RATE);
});
