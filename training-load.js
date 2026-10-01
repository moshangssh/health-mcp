// 训练负荷：三种口径各自独立递推，只接收原始运动与配置，读文件、时区和响应组装都在 health-server.js。
//
//   trimp_average    运动时长 × 平均心率     默认主序列，适合历史摘要记录
//   trimp_integrated 运动期间心率序列积分    保留强度变化，作为独立序列
//   device_load      设备 workout_load       设备口径，作为独立序列
//
// 不跨方法补值：积分法缺数据时不回落平均法，设备负荷缺失时不记零。某天有运动无法计算时，该方法
// 当天及之后的指标保持缺失状态，不用小计冒充完整日负荷。不同方法互不影响。

const METHODS = ["trimp_average", "trimp_integrated", "device_load"];

const METHOD_UNITS = {
  trimp_average: "trimp",
  trimp_integrated: "trimp",
  device_load: "workout_load",
};

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTime(value) {
  // 空值不能落进 new Date(null) = 1970-01-01，那会把没有时间的运动归到创世那天。
  if (value === null || value === undefined || value === "") return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
}

function dateFromDayNumber(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDays(date, delta) {
  return dateFromDayNumber(dayNumber(date) + delta);
}

// 当地日期 date 的起点。任何时区偏移都在 ±15 小时内，边界必定落在该 UTC 日期午夜前后 15 小时内，
// 二分找到当地日期第一次变到 date 的那一刻，不另建时区规则。
function localDateStart(date, formatDate) {
  const utcMidnight = dayNumber(date) * 86400000;
  let low = utcMidnight - 15 * 3600000;
  let high = utcMidnight + 15 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatDate(middle) < date) low = middle + 1; else high = middle;
  }
  return low;
}

// [startMs, endMs) 覆盖的当地日期，以及每天与这段区间相交的本地起止时刻。
function localDateRanges(startMs, endMs, formatDate) {
  const sameDay = formatDate(startMs);
  if (formatDate(endMs - 1) === sameDay) return [{ date: sameDay, from: startMs, to: endMs }];
  const ranges = [];
  let date = formatDate(startMs);
  let from = localDateStart(date, formatDate);
  let to = localDateStart(addDays(date, 1), formatDate);
  while (from < endMs) {
    const partFrom = Math.max(startMs, from);
    const partTo = Math.min(endMs, to);
    if (partTo > partFrom) ranges.push({ date, from: partFrom, to: partTo });
    date = addDays(date, 1);
    from = to;
    to = localDateStart(addDays(date, 1), formatDate);
  }
  return ranges;
}

// Banister 1991：TRIMP = 时长(分钟) × HRr × a × e^(b × HRr)。HRr 按公式定义域截到 [0, 1]。
function trimpRate(heartRate, restingHeartRate, maxHeartRate, params) {
  const hrRatio = Math.min(1, Math.max(0, (heartRate - restingHeartRate) / (maxHeartRate - restingHeartRate)));
  return { hrRatio, rate: hrRatio * params.trimp_coefficient_a * Math.exp(params.trimp_coefficient_b * hrRatio) };
}

// 静息心率规则：取运动开始日当天的一条；当天没有则沿用最近一个更早的日期，与身体电量同一条规则。
function restingHeartRateLookup(restingByDate) {
  const dates = [...restingByDate.keys()].sort();
  return (date) => {
    let found = null;
    for (const candidate of dates) {
      if (candidate > date) break;
      found = candidate;
    }
    return found === null ? null : { date: found, value: restingByDate.get(found) };
  };
}

// 运动心率序列：按时间排序，同一时刻只保留排序后最后出现的一条，非正数和无法解析的读数丢弃。
function heartRateSamples(rawSamples) {
  const parsed = [];
  for (const sample of Array.isArray(rawSamples) ? rawSamples : []) {
    const ms = parseTime(sample?.timestamp ?? sample?.ts ?? sample?.time);
    const bpm = finiteNumber(sample?.value ?? sample?.bpm);
    if (ms === null || bpm === null || bpm <= 0) continue;
    parsed.push({ ms, bpm });
  }
  parsed.sort((a, b) => a.ms - b.ms);
  const unique = [];
  for (const sample of parsed) {
    if (unique.length && unique[unique.length - 1].ms === sample.ms) unique[unique.length - 1] = sample;
    else unique.push(sample);
  }
  return unique;
}

function averageTrimpLoad(raw, { durationSeconds, restingHeartRate, maxHeartRate, params, startDate }) {
  if (durationSeconds === null || durationSeconds <= 0) return { load: null, status: "uncomputable", reason: "missing_duration_seconds", basis: { field: params.duration_field } };
  const averageHeartRate = finiteNumber(raw?.avg_heart_rate);
  const basis = { duration_seconds: durationSeconds, average_heart_rate: averageHeartRate, resting_heart_rate: restingHeartRate?.value ?? null, resting_heart_rate_date: restingHeartRate?.date ?? null, max_heart_rate: maxHeartRate };
  if (averageHeartRate === null || averageHeartRate <= 0) return { load: null, status: "uncomputable", reason: "missing_average_heart_rate", basis };
  if (restingHeartRate === null) return { load: null, status: "uncomputable", reason: "missing_resting_heart_rate", basis: { ...basis, date: startDate } };
  if (!(maxHeartRate > restingHeartRate.value)) return { load: null, status: "uncomputable", reason: "invalid_heart_rate_range", basis };
  const { hrRatio, rate } = trimpRate(averageHeartRate, restingHeartRate.value, maxHeartRate, params);
  return { load: (durationSeconds / 60) * rate, status: "computed", basis: { ...basis, hr_ratio: hrRatio } };
}

function integratedTrimpLoad(raw, { startMs, endMs, spanKnown, restingHeartRate, maxHeartRate, params, formatDate }) {
  const samples = heartRateSamples(raw?.heart_rate);
  // 运动结束后的恢复心率随运动一起存储，按运动开始、结束裁剪，不产生训练负荷。
  const recoverySamples = samples.filter((sample) => sample.ms > endMs).length;
  const leadingSamples = samples.filter((sample) => sample.ms < startMs).length;
  if (!spanKnown) {
    return {
      load: null,
      status: "uncomputable",
      reason: "unknown_workout_span",
      coverage: { span_seconds: null, sample_count: samples.length - recoverySamples - leadingSamples, excluded_recovery_samples: recoverySamples, excluded_leading_samples: leadingSamples },
    };
  }
  const spanMs = endMs - startMs;
  const inWorkout = samples.filter((sample) => sample.ms >= startMs && sample.ms <= endMs);
  const coverageOf = (coveredMs) => ({
    span_seconds: spanMs / 1000,
    covered_seconds: coveredMs / 1000,
    uncovered_seconds: (spanMs - coveredMs) / 1000,
    coverage_ratio: coveredMs / spanMs,
    sample_count: inWorkout.length,
    excluded_recovery_samples: recoverySamples,
    excluded_leading_samples: leadingSamples,
  });
  const uncomputable = (reason, extra = {}) => ({ load: null, status: "uncomputable", reason, coverage: coverageOf(0), ...extra });
  if (!inWorkout.length) return uncomputable("no_heart_rate_samples");
  if (restingHeartRate === null) return uncomputable("missing_resting_heart_rate", { date: formatDate(startMs) });
  if (!(maxHeartRate > restingHeartRate.value)) return uncomputable("invalid_heart_rate_range");

  const holdMs = params.hr_hold_seconds * 1000;
  const byDate = new Map();
  let coveredMs = 0;
  for (let index = 0; index < inWorkout.length; index += 1) {
    const sample = inWorkout[index];
    const nextMs = index + 1 < inWorkout.length ? inWorkout[index + 1].ms : Infinity;
    // 一个读数只在自己之后 hr_hold_seconds 内有效；下一个读数一到就接管，超过有效期的缺口不计入。
    const to = Math.min(sample.ms + holdMs, nextMs, endMs);
    if (to <= sample.ms) continue;
    const { rate } = trimpRate(sample.bpm, restingHeartRate.value, maxHeartRate, params);
    for (const range of localDateRanges(sample.ms, to, formatDate)) {
      byDate.set(range.date, (byDate.get(range.date) ?? 0) + ((range.to - range.from) / 60000) * rate);
    }
    coveredMs += to - sample.ms;
  }
  if (coveredMs <= 0) return uncomputable("no_heart_rate_coverage");
  const by_date = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, load]) => ({ date, load }));
  return {
    load: by_date.reduce((sum, part) => sum + part.load, 0),
    status: "computed",
    by_date,
    coverage: coverageOf(coveredMs),
    basis: { resting_heart_rate: restingHeartRate.value, resting_heart_rate_date: restingHeartRate.date, max_heart_rate: maxHeartRate, hr_hold_seconds: params.hr_hold_seconds },
  };
}

function deviceLoad(raw) {
  const basis = { field: "workout_load" };
  const value = finiteNumber(raw?.workout_load);
  if (value === null) return { load: null, status: "uncomputable", reason: "missing_workout_load", basis };
  return { load: value, status: "computed", basis };
}

// 平均法和设备负荷按运动墙钟区间的实际时间比例分日，标明是分配估计；积分法按心率所在时间区间分日。
function proportionalSplit(load, ranges) {
  if (ranges.length === 1) return [{ date: ranges[0].date, load, allocation: "exact" }];
  const totalMs = ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
  return ranges.map((range) => ({ date: range.date, load: (load * (range.to - range.from)) / totalMs, allocation: "proportional" }));
}

function prepareWorkout(raw, { restingLookup, maxHeartRate, params, formatDate }) {
  const startMs = parseTime(raw?.timestamp);
  if (startMs === null) return null;
  const statedEndMs = parseTime(raw?.end_time);
  const durationSeconds = finiteNumber(raw?.duration_seconds);
  // 分日所需的墙钟区间：优先用 end_time，缺失时用时长的秒级原始值推算，两者都没有则无法分日。
  const endMs = statedEndMs ?? (durationSeconds !== null && durationSeconds > 0 ? startMs + durationSeconds * 1000 : null);
  const spanKnown = endMs !== null && endMs > startMs;
  const ranges = spanKnown ? localDateRanges(startMs, endMs, formatDate) : null;
  const startDate = formatDate(startMs);
  const restingHeartRate = restingLookup(startDate);
  const loads = {
    trimp_average: averageTrimpLoad(raw, { durationSeconds, restingHeartRate, maxHeartRate, params, startDate }),
    trimp_integrated: integratedTrimpLoad(raw, { startMs, endMs, spanKnown, restingHeartRate, maxHeartRate, params, formatDate }),
    device_load: deviceLoad(raw),
  };
  const splits = {};
  for (const method of METHODS) {
    const entry = loads[method];
    if (entry.status !== "computed" || ranges === null) continue;
    splits[method] = method === "trimp_integrated"
      ? entry.by_date.map((part) => ({ ...part, allocation: "exact" }))
      : proportionalSplit(entry.load, ranges);
  }
  return {
    activity: String(raw?.activity || "unknown"),
    name: typeof raw?.name === "string" && raw.name ? raw.name : null,
    start_ms: startMs,
    end_ms: spanKnown ? endMs : null,
    start_date: startDate,
    span_known: spanKnown,
    span_dates: ranges === null ? null : ranges.map((range) => range.date),
    duration_seconds: durationSeconds,
    loads,
    splits,
  };
}

// 每天汇总：没有已入库运动的日期，已记录负荷为 0；有运动缺少计算字段时保留小计并标记不完整。
function buildDailySeries(workouts, method, params, formatDate, today) {
  if (!workouts.length) return [];
  const buckets = new Map();
  const bucketOf = (date) => {
    if (!buckets.has(date)) buckets.set(date, { load: 0, workouts: 0, uncomputable: [] });
    return buckets.get(date);
  };
  for (const workout of workouts) {
    const touched = workout.span_dates ?? [workout.start_date];
    for (const date of touched) bucketOf(date).workouts += 1;
    const entry = workout.loads[method];
    if (entry.status !== "computed") {
      for (const date of touched) bucketOf(date).uncomputable.push({ activity: workout.activity, reason: entry.reason });
      continue;
    }
    if (workout.span_dates === null) {
      for (const date of touched) bucketOf(date).uncomputable.push({ activity: workout.activity, reason: "unallocatable_span" });
      continue;
    }
    for (const part of workout.splits[method]) bucketOf(part.date).load += part.load;
  }

  const startDate = workouts.reduce((earliest, workout) => (workout.start_date < earliest ? workout.start_date : earliest), workouts[0].start_date);
  const lastDate = dayNumber(today) > dayNumber(startDate) ? today : startDate;
  const ctlDecay = 1 - Math.exp(-1 / params.ctl_time_constant_days);
  const atlDecay = 1 - Math.exp(-1 / params.atl_time_constant_days);
  const ctlByDate = new Map();
  const daily = [];
  let ctl = params.initial_ctl;
  let atl = params.initial_atl;
  let blockedSince = null;
  for (let date = startDate; dayNumber(date) <= dayNumber(lastDate); date = addDays(date, 1)) {
    const found = buckets.get(date);
    const uncomputable = found?.uncomputable ?? [];
    if (uncomputable.length && blockedSince === null) blockedSince = date;
    const day = {
      date,
      load: found?.load ?? 0,
      load_status: uncomputable.length ? "partial" : "complete",
      workouts: found?.workouts ?? 0,
      uncomputable,
      ctl: null,
      atl: null,
      tsb: null,
      balance_end_of_day: null,
      ramp_rate: null,
      metrics_status: blockedSince === null ? "computed" : "blocked",
    };
    if (blockedSince !== null) {
      // 已知有一场算不出来的运动，这一天的完整负荷和之后的递推都无从确定，保留缺失状态。
      if (blockedSince !== date) day.blocked_since = blockedSince;
    } else {
      const previousCtl = ctl;
      const previousAtl = atl;
      ctl = previousCtl + (day.load - previousCtl) * ctlDecay;
      atl = previousAtl + (day.load - previousAtl) * atlDecay;
      day.ctl = ctl;
      day.atl = atl;
      day.tsb = previousCtl - previousAtl;
      day.balance_end_of_day = ctl - atl;
      const past = ctlByDate.get(addDays(date, -params.ramp_rate_days));
      day.ramp_rate = past === undefined ? null : ctl - past;
      ctlByDate.set(date, ctl);
    }
    if (date === today) day.provisional = true;
    daily.push(day);
  }
  return daily;
}

function computeTrainingLoad({ workouts: rawWorkouts = [], restingByDate, maxHeartRate, params, formatDate, today }) {
  const restingLookup = restingHeartRateLookup(restingByDate);
  const workouts = [];
  let unplacedWorkouts = 0;
  for (const raw of rawWorkouts) {
    const workout = prepareWorkout(raw, { restingLookup, maxHeartRate, params, formatDate });
    if (workout === null) unplacedWorkouts += 1;
    else workouts.push(workout);
  }
  workouts.sort((a, b) => a.start_ms - b.start_ms);
  const activityNames = [...new Set(workouts.map((workout) => workout.activity))].sort();

  const methods = {};
  for (const method of METHODS) {
    methods[method] = {
      all: buildDailySeries(workouts, method, params, formatDate, today),
      activities: Object.fromEntries(activityNames.map((activity) => [
        activity,
        buildDailySeries(workouts.filter((workout) => workout.activity === activity), method, params, formatDate, today),
      ])),
    };
  }
  return {
    methods,
    workouts,
    activities: activityNames,
    unplaced_workouts: unplacedWorkouts,
    start_date: workouts.length ? workouts[0].start_date : null,
    end_date: workouts.length ? methods.trimp_average.all.at(-1).date : null,
  };
}

module.exports = { METHODS, METHOD_UNITS, addDays, computeTrainingLoad, localDateRanges, localDateStart, trimpRate };
