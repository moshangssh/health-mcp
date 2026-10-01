const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { addDays, computeTrainingLoad, trimpRate } = require("./training-load");

const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, "training-load.json"), "utf8"));
const MAX_HR = JSON.parse(fs.readFileSync(path.join(__dirname, "heart-rate.json"), "utf8")).max_heart_rate;
const DATE_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const formatDate = (millis) => DATE_FORMAT.format(new Date(millis));
const RESTING = 50;

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} 实际 ${actual}，预期 ${expected}`);
}

// 配置里声明的公式，测试里按定义重算一遍，用来对照模块的积分与递推。
function rate(bpm, resting = RESTING) {
  return trimpRate(bpm, resting, MAX_HR, PARAMS).rate;
}

function restingDays(from, to) {
  const map = new Map();
  for (let date = from; date <= to; date = addDays(date, 1)) map.set(date, RESTING);
  return map;
}

function dayStart(date) {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function workout({ date, fromSecond = 3600, durationSeconds = 3600, activity = "running", avgHeartRate = 140, workoutLoad = 42, heartRateSeconds = null, heartRate = null }) {
  const start = dayStart(date) + fromSecond * 1000;
  const samples = heartRate ?? heartRateSeconds?.map(([offset, value]) => [offset, value]);
  return {
    timestamp: new Date(start).toISOString(),
    end_time: new Date(start + durationSeconds * 1000).toISOString(),
    duration_seconds: durationSeconds,
    activity,
    avg_heart_rate: avgHeartRate,
    workout_load: workoutLoad,
    ...(samples === null || samples === undefined ? {} : { heart_rate: samples.map(([offset, value]) => ({ timestamp: new Date(start + offset * 1000).toISOString(), value })) }),
  };
}

function everySeconds(step, toSeconds, value = 140) {
  const samples = [];
  for (let second = 0; second <= toSeconds; second += step) samples.push([second, value]);
  return samples;
}

function compute(workouts, { resting = new Map(), today = "2026-09-12", maxHeartRate = MAX_HR, params = PARAMS } = {}) {
  return computeTrainingLoad({ workouts, restingByDate: resting, maxHeartRate, params, formatDate, today });
}

const series = (result, method = "trimp_average", activity = null) => (activity === null ? result.methods[method].all : result.methods[method].activities[activity]);

test("TRIMP 系数取自配置，按 Banister 公式给出强度权重", () => {
  // HRr = (120 − 50) / (190 − 50) = 0.5，权重 = 0.5 × 0.64 × e^(1.92 × 0.5)
  near(trimpRate(120, RESTING, MAX_HR, PARAMS).rate, 0.8357428714953977);
  assert.equal(trimpRate(120, RESTING, MAX_HR, PARAMS).hrRatio, 0.5);
  // 低于静息心率或高于最大心率时按公式定义域截断，不产生负负荷。
  assert.equal(trimpRate(40, RESTING, MAX_HR, PARAMS).hrRatio, 0);
  assert.equal(trimpRate(210, RESTING, MAX_HR, PARAMS).hrRatio, 1);
});

test("单次运动的平均心率 TRIMP 与递推和手算一致，中间不提前四舍五入", () => {
  const result = compute([workout({ date: "2026-09-01" })], { resting: restingDays("2026-09-01", "2026-09-01") });
  const [day] = series(result);
  const load = 60 * rate(140);
  near(day.load, load, "60 分钟 × 平均心率权重");
  near(day.ctl, load * (1 - Math.exp(-1 / PARAMS.ctl_time_constant_days)), "CTL 是首日负荷按 42 天时间常数递推");
  near(day.atl, load * (1 - Math.exp(-1 / PARAMS.atl_time_constant_days)), "ATL 按 7 天时间常数递推");
  assert.equal(day.tsb, 0, "第一天之前没有 CTL、ATL");
  assert.equal(day.balance_end_of_day, day.ctl - day.atl);
  assert.equal(day.ramp_rate, null, "不足七天没有可比的前值");
  assert.equal(day.workouts, 1);
  assert.equal(day.load_status, "complete");
});

test("恒定负荷下 CTL、ATL 收敛到该负荷，TSB 回到零", () => {
  const dates = [];
  for (let index = 0; index < 300; index += 1) dates.push(addDays("2026-01-01", index));
  const workouts = dates.map((date) => workout({ date, avgHeartRate: 140, durationSeconds: 3600 }));
  const daily = series(compute(workouts, { resting: restingDays("2026-01-01", "2026-12-31"), today: dates.at(-1) }));
  const load = 60 * rate(140);
  for (const [index, day] of daily.entries()) {
    near(day.ctl, load * (1 - Math.exp(-(index + 1) / 42)), `第 ${index + 1} 天的 CTL`);
    near(day.atl, load * (1 - Math.exp(-(index + 1) / 7)), `第 ${index + 1} 天的 ATL`);
  }
  assert.ok(Math.abs(daily.at(-1).ctl - load) < load * 0.001);
  assert.ok(Math.abs(daily.at(-1).atl - load) < load * 1e-6);
  assert.ok(Math.abs(daily.at(-1).tsb) < load * 0.001);
});

test("零负荷日期按时间常数衰减", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  const daily = series(compute([workout({ date: dates[0] })], { resting: restingDays("2026-09-01", "2026-09-05"), today: dates.at(-1) }));
  const load = 60 * rate(140);
  assert.equal(daily[1].load, 0, "没有已入库运动的日期，已记录负荷为 0");
  assert.equal(daily[1].workouts, 0);
  near(daily[2].ctl, load * (1 - Math.exp(-1 / 42)) * Math.exp(-2 / 42));
  near(daily[2].atl, load * (1 - Math.exp(-1 / 7)) * Math.exp(-2 / 7));
  assert.equal(daily[2].load_status, "complete", "没有运动记录与运动算不出来是两种状态");
});

test("TSB 取前一天的 CTL 与 ATL，Ramp Rate 比较七天前的 CTL", () => {
  const dates = [];
  for (let index = 0; index < 20; index += 1) dates.push(addDays("2026-09-01", index));
  const workouts = dates.filter((_, index) => index % 3 === 0).map((date) => workout({ date }));
  const daily = series(compute(workouts, { resting: restingDays("2026-09-01", "2026-09-30"), today: dates.at(-1) }));
  for (const [index, day] of daily.entries()) {
    if (index === 0) {
      assert.equal(day.tsb, 0);
      continue;
    }
    assert.equal(day.tsb, daily[index - 1].ctl - daily[index - 1].atl, "TSB 是当天训练前的状态，没有日期错位");
    assert.equal(day.balance_end_of_day, day.ctl - day.atl);
    assert.equal(day.ramp_rate, index < 7 ? null : day.ctl - daily[index - 7].ctl);
  }
});

test("同日多场运动相加，按运动类型拆分与全部运动负荷总量一致", () => {
  const resting = restingDays("2026-09-01", "2026-09-03");
  const workouts = [
    workout({ date: "2026-09-01", fromSecond: 3600, durationSeconds: 3600, avgHeartRate: 140, workoutLoad: 42 }),
    workout({ date: "2026-09-01", fromSecond: 36000, durationSeconds: 1800, activity: "indoor_cycling", avgHeartRate: 120, workoutLoad: 20 }),
    workout({ date: "2026-09-02", fromSecond: 3600, durationSeconds: 1200, activity: "indoor_cycling", avgHeartRate: 130, workoutLoad: 11 }),
  ];
  const result = compute(workouts, { resting, today: "2026-09-03" });
  const daily = series(result);
  near(daily[0].load, 60 * rate(140) + 30 * rate(120));
  assert.equal(daily[0].workouts, 2);
  const total = daily.reduce((sum, day) => sum + day.load, 0);
  const running = series(result, "trimp_average", "running").reduce((sum, day) => sum + day.load, 0);
  const cycling = series(result, "trimp_average", "indoor_cycling").reduce((sum, day) => sum + day.load, 0);
  near(running + cycling, total);
  near(running, 60 * rate(140));
  assert.deepEqual(result.activities, ["indoor_cycling", "running"]);
});

test("跨午夜时积分法按实际时间分日，平均法与设备负荷按墙钟比例分日", () => {
  const resting = restingDays("2026-09-01", "2026-09-02");
  const crossMidnight = workout({
    date: "2026-09-01", fromSecond: 23 * 3600 + 1800, durationSeconds: 3600, workoutLoad: 42,
    heartRate: everySeconds(5, 3600),
  });
  const result = compute([crossMidnight], { resting, today: "2026-09-02" });
  const load = 60 * rate(140);
  const [first, second] = series(result);

  near(first.load, load / 2, "墙钟比例正好一半");
  near(second.load, load / 2);
  const [split] = result.workouts;
  assert.deepEqual(split.splits.trimp_average.map((part) => [part.date, part.allocation]), [["2026-09-01", "proportional"], ["2026-09-02", "proportional"]]);
  near(split.splits.trimp_average.reduce((sum, part) => sum + part.load, 0), load, "分日和等于原值");
  near(split.splits.device_load.reduce((sum, part) => sum + part.load, 0), 42);
  assert.deepEqual(series(result, "device_load").map((day) => day.load), [21, 21]);

  const integrated = result.methods.trimp_integrated.all;
  near(integrated[0].load, load / 2, "心率区间按实际时间落在两天");
  near(integrated[1].load, load / 2);
  assert.equal(result.workouts[0].loads.trimp_integrated.coverage.coverage_ratio, 1, "五秒采样在十秒有效期内全覆盖");
  near(result.workouts[0].splits.trimp_integrated.reduce((sum, part) => sum + part.load, 0), integrated[0].load + integrated[1].load);
});

test("运动结束后的恢复心率不产生训练负荷", () => {
  const resting = restingDays("2026-09-01", "2026-09-01");
  const inWorkout = everySeconds(5, 1800);
  const withRecovery = workout({ date: "2026-09-01", durationSeconds: 1800, heartRate: [...inWorkout, ...everySeconds(5, 3000).slice(361).map(([second, value]) => [second, value + 30])] });
  const withoutRecovery = workout({ date: "2026-09-01", durationSeconds: 1800, heartRate: inWorkout });
  const recovered = compute([withRecovery], { resting, today: "2026-09-01" }).workouts[0];
  const plain = compute([withoutRecovery], { resting, today: "2026-09-01" }).workouts[0];
  near(recovered.loads.trimp_integrated.load, plain.loads.trimp_integrated.load);
  assert.equal(recovered.loads.trimp_integrated.coverage.excluded_recovery_samples, 240);
  assert.equal(recovered.loads.trimp_integrated.coverage.covered_seconds, 1800);
  assert.equal(recovered.loads.trimp_integrated.coverage.coverage_ratio, 1);
});

test("不规则采样按实际间隔积分，重复点取后到的，超过有效期的缺口不计入", () => {
  const result = compute([workout({
    date: "2026-09-01", durationSeconds: 120,
    heartRate: [[0, 120], [5, 140], [5, 160], [100, 170]],
  })], { resting: restingDays("2026-09-01", "2026-09-01"), today: "2026-09-01" });
  const integrated = result.workouts[0].loads.trimp_integrated;
  // 0–5 秒用 120；5 秒的重复点保留后到的 160，覆盖到 15 秒；15–100 秒超过有效期不计；100–110 秒用 170。
  near(integrated.load, (5 / 60) * rate(120) + (10 / 60) * rate(160) + (10 / 60) * rate(170));
  assert.equal(integrated.coverage.covered_seconds, 25);
  assert.equal(integrated.coverage.uncovered_seconds, 95);
  assert.equal(integrated.coverage.sample_count, 3, "同一时刻只留一条");
});

test("缺平均心率、缺静息心率、缺设备负荷都不记为零负荷", () => {
  const resting = restingDays("2026-09-01", "2026-09-01");
  const workouts = [
    workout({ date: "2026-09-01", avgHeartRate: null, workoutLoad: 7, heartRate: everySeconds(5, 600), durationSeconds: 600 }),
    workout({ date: "2026-09-01", fromSecond: 36000, workoutLoad: null, durationSeconds: 600 }),
  ];
  const result = compute(workouts, { resting, today: "2026-09-01" });
  const [first, second] = result.workouts;
  assert.equal(first.loads.trimp_average.load, null);
  assert.equal(first.loads.trimp_average.reason, "missing_average_heart_rate");
  assert.equal(first.loads.device_load.load, 7, "一场缺平均心率的运动不影响它的设备负荷");
  assert.equal(second.loads.device_load.load, null);
  assert.equal(second.loads.device_load.reason, "missing_workout_load");
  assert.ok(second.loads.trimp_average.load > 0);

  const [day] = series(result);
  assert.equal(day.load_status, "partial", "已计算部分的负荷小计不冒充完整日负荷");
  assert.equal(day.load, second.splits.trimp_average[0].load);
  assert.deepEqual(day.uncomputable, [{ activity: "running", reason: "missing_average_heart_rate" }]);
  assert.equal(day.ctl, null, "完整日负荷无从确定，当天及之后保留缺失状态");
  assert.equal(day.metrics_status, "blocked");

  // 静息心率取自运动开始日或最近一个更早的日期，早于全部记录的日期没有可用的基线。
  const noBaseline = compute([workout({ date: "2026-09-01", heartRate: everySeconds(5, 600), durationSeconds: 600 })], { resting: new Map([["2026-09-03", RESTING]]), today: "2026-09-01" });
  assert.equal(noBaseline.workouts[0].loads.trimp_average.reason, "missing_resting_heart_rate");
  assert.equal(noBaseline.workouts[0].loads.trimp_integrated.reason, "missing_resting_heart_rate");
});

test("一场算不出来的运动让该方法后续递推保持缺失，另一种方法照常给出结果", () => {
  const resting = restingDays("2026-09-01", "2026-09-05");
  const workouts = [
    workout({ date: "2026-09-01", workoutLoad: 30, heartRate: everySeconds(5, 1800), durationSeconds: 1800 }),
    workout({ date: "2026-09-02", workoutLoad: null, heartRate: everySeconds(5, 1800), durationSeconds: 1800 }),
    workout({ date: "2026-09-04", workoutLoad: 30, heartRate: everySeconds(5, 1800), durationSeconds: 1800 }),
  ];
  const result = compute(workouts, { resting, today: "2026-09-05" });
  const device = series(result, "device_load");
  assert.equal(device[1].metrics_status, "blocked");
  assert.equal(device[2].blocked_since, "2026-09-02", "缺失状态一直保留到之后的日期");
  assert.equal(device[2].ctl, null);
  assert.equal(device[3].load, 30, "第四天仍给出已计算部分的日负荷小计");
  assert.equal(device[3].ctl, null);
  const average = series(result, "trimp_average");
  assert.ok(average.every((day) => day.metrics_status === "computed"), "平均法的输入齐全，不受设备负荷缺失影响");
  assert.ok(average[3].ctl > 0);
  const integrated = series(result, "trimp_integrated");
  assert.ok(integrated[3].ctl > integrated[1].ctl);
});

test("查询范围之外的历史照常递推，只影响返回的日期窗口", () => {
  const resting = restingDays("2026-09-01", "2026-09-10");
  const workouts = [workout({ date: "2026-09-01" }), workout({ date: "2026-09-02" })];
  const short = series(compute(workouts, { resting, today: "2026-09-03" }));
  const long = series(compute(workouts, { resting, today: "2026-09-10" }));
  assert.deepEqual(short.slice(0, 2), long.slice(0, 2));
});
