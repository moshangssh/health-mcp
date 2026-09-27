const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { buildSummaryText, createApp, createHealthMcpServer, cycleContextForDate, dailySummary, formatLocalDate, mergeHealthData, normalizeSleepSession, readHealthRecords, readHealthToolResult, storeCycleConfig } = require("./health-server");

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

test("invalid calendar dates are rejected and repeated clear stays successful", () => {
  const dir = tmpDataDir();
  assert.throws(() => storeCycleConfig(dir, { ...confirmedCycle, last_start: "2026-02-30" }), /last_start/);
  storeCycleConfig(dir, confirmedCycle);
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
});
