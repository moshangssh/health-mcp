const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { buildSummaryText, createApp, createHealthMcpServer, cycleContextForDate, dailySummary, formatLocalDate, mergeHealthData, normalizeSleepSession, readHealthRecords, readHealthToolResult, readProfile, storeCycleConfig } = require("./health-server");

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-mcp-test-"));
}

function readDay(dir, date) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), "utf8"));
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
  assert.deepEqual(Object.keys(nap).sort(), ["duration_text", "end", "start", "total_minutes", "type"], "a nap carries no night's stage minutes");
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

test("a night with no stages reads its minutes off the day's own fields", (t) => {
  freezeClock(t);
  const dir = tmpDataDir();
  mergeHealthData(dir, {
    date: "2026-09-06",
    type: "sleep",
    data: { duration_min: 480, deep_min: 180, light_min: 260, rem_min: 40, awake_min: 25, start: "2026-09-06T00:00:00+08:00", end: "2026-09-06T08:25:00+08:00" },
  });

  const [night] = readHealthToolResult(dir, { data_type: "sleep", time_range: "today" }).recent_sleep_list;
  assert.equal(night.type, "sleep");
  assert.equal(night.awake_minutes, 25);
  assert.equal(night.deep_sleep_minutes, 180);
  assert.equal(night.rem_sleep_minutes, 40);
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
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["health_read"]);
  assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties), ["data_type", "time_range", "heart_rate_detail", "days"]);
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
