# health-mcp · 自托管健康数据服务端

把手环的步数、心率、睡眠、运动记录、血氧、压力、HRV、体温等健康数据落到你自己的服务器，并通过 MCP 暴露给 AI 助手读取。

配合手机端的 Gadgetbridge fork 使用：

```text
手环 ──蓝牙──> 手机 App ──HTTPS 上传──> 本服务 ──MCP──> ChatGPT / Claude / Codex / 其他客户端
```

Express + MCP SDK，需 Node 20+。手机端 App 与完整图文教程见文末链接。

## 安装

```bash
git clone https://github.com/xiaoyou5602/health-mcp.git && cd health-mcp
npm install
cp .env.example .env
```

## 配置

编辑 `.env`。两个 token 用随机值，且**必须不一样**——一个在手机 App 里、一个在 AI 客户端里，泄露一个不至于连带另一个：

```bash
openssl rand -hex 24   # → HEALTH_INGEST_TOKEN（上传）
openssl rand -hex 24   # → HEALTH_MCP_ACCESS_TOKEN（读取）
```

| 变量 | 说明 |
| --- | --- |
| `HEALTH_INGEST_TOKEN` | 上传门锁，手机 App 用，至少 16 字符，服务端强制 |
| `HEALTH_MCP_ACCESS_TOKEN` | 读取门锁，AI 客户端用；**留空则任何人可读** |
| `HEALTH_DATA_DIR` | 数据落盘目录，默认 `/var/lib/health-mcp` |
| `HEALTH_MCP_PUBLIC_URLS` | 可选。对外域名白名单，多个逗号分隔；留空则不校验 Host |
| `HEALTH_MCP_PORT` | 监听端口，默认 `3100` |
| `HEALTH_MCP_HOST` | 监听地址，默认 `127.0.0.1`（只回环，公网由反代 / Tunnel 转入）|
| `HEALTH_TZ` | 按天落盘、睡眠按「醒来日期」归属、时间显示所用的时区，默认 `Asia/Shanghai` |

## 运行

```bash
npm start        # 等价于 node health-server.js
```

自测服务是否活着：

```bash
curl http://127.0.0.1:3100/healthz   # 返回 {"ok":true,...}
```

生产环境建议配成 systemd 服务（模板见 [`deploy/health-mcp.service`](deploy/health-mcp.service)），别用 `nohup` 裸跑。公网入口用 Caddy / Nginx 反代，或 Cloudflare Tunnel。**必须走 HTTPS**——token 和健康数据都在明文 body 里。

## MCP 工具

服务暴露两个工具：读取的 `health_read`，和等待夜醒的 `health_wait_for_wake`（见本节末尾）。先看 `health_read`：

- `data_type`：`current_status`、`steps`、`heart_rate`、`sleep`、`workouts`、`daily_summary`、`series`、`body_battery`、`training_load`、`all`
- `time_range`：`today` 或 `three_days`
- `days`：除 `current_status` 外可自定义读取 1～62 天；传入后优先于 `time_range`
- `heart_rate_detail`：仅用于 `heart_rate`，可选 `daily` 或 `hourly`；小时模式只返回每小时统计，不返回原始样本
- `method`、`activity`、`training_load_detail`：仅用于 `training_load`，见下

不传参数时返回紧凑的当前状态。`daily_summary` 每天包含步数、卡路里、距离、心率、静息心率、血氧、
压力、HRV、体温、睡眠分数、睡眠摘要和手环的夜间报告；`current_status` 额外给出各指标当天最新一次读数；`workouts`
返回最近的运动记录（类型、起止、时长、距离、卡路里、步数、活动时长、平均/最大/最小心率、心率区间分布、配速、步频、workout load、有氧训练效果、恢复时间；字段名自带单位。这里只有手环真会报的字段——跑姿、游泳、跳绳、骑行功率、海拔爬升不上传，因为手环没有对应传感器，App 侧也就不会发），`all` 还会附带睡眠明细。
`sleep` 返回最近的睡眠会话（类型、起止、时长，以及深睡/浅睡/REM/清醒分钟数。时长是睡着的时间，
不含清醒，清醒分钟数单独给，两者相加就是这段睡眠在床上的跨度）和手环自己的夜间报告列表
`recent_sleep_stats_list`（上床、入睡、醒来、起身时刻，睡眠效率、入睡潜伏期、RDI 呼吸紊乱指数，当晚心率/血氧/
呼吸率/HRV 及其个人基线区间；`*_day_to_baseline` 是评估基线所需的佩戴天数，单位为天，不是生理偏差。
`deep_part` 是深睡连续性得分，不是深睡分钟数或占比。打鼾、数据质量、醒来感受、醒来与翻身次数的
具体口径尚未确认；可选字段仅在手环上报时出现，负数哨兵不上传）。
小睡（`type: nap`）只给起止和时长，不带夜间各阶段的分钟数。
读取结果可能附带 `cycle` 经期上下文和 `profile` 个人资料。

`series` 返回窗口内每天的原始带时间戳读数，不做任何聚合：`heart_rate`（`bpm`）、`steps`、
`resting_heart_rate`、`spo2`、`stress`（含 `level`）、`hrv`、`temperature`，
`sleep_stats`（一夜一条）、`emotions`（`valence`/`arousal` 是 0–100 的连续值，`status` 是手环自己的
分类码，各级含义未定义）、`sleep_apnea`（`level` 取 1–4，同样只有等级没有各级含义），
以及 `sleep_sessions` 的逐段 `stages`（`stage`/`start`/`end`/`duration_seconds`）。新增 `workouts`
保留运动原始对象及 `heart_rate: [{timestamp, value}]`，含运动后恢复心率；`heart_rate_coverage`
保留原始活动历史的心率覆盖区间；`steps_bucket_seconds` 表示已知的步数桶粒度。`workouts` 专用读取仍是
紧凑摘要，高频明细在 `series` 中。某天没有的序列不出现。
数值口径与落盘一致，怎么分析由调用方决定。注意体积：本机实测 2 天约 150 KB（≈38k token），
按此比例 62 天约 4.8 MB，远超一般客户端的上下文，所以拉长窗口时建议只取需要分析的序列。

`body_battery` 返回仿佳明身体电量的储能估算：`level`（当前电量）、`as_of`（已计算到的数据时刻），
`initial`（第一晚入睡时的配置初值，`source: configured`，不是测量值），`daily`（每天最高、最低、
累计充电、累计耗电、缺测估算分钟数），`events`（睡眠、活动、未佩戴、缺测估算、高压力时段）和 `curve`。
时间通常显示到分钟，非整分钟的起止和终点保留秒及非零毫秒。`max_heart_rate_setting` 是配置最大心率，
`observed_max_heart_rate` 是普通及运动心率中观测到的最高值，不自动代替配置值。

`estimated` 表示从历史起点至今包含缺测估算；曲线每点的同名标记也是累计口径，恢复观测不会清除。
新增 `interval_estimated` 表示从上一绘图点到该点的区间是否包含缺测。顶层 `estimation` 给出全历史
估算的 `minutes`、`charged`、`drained`；这不是置信区间，也不等于最终分数的误差。
`contributions` 按 `sleep_recovery`、`rest_recovery`、`activity`、`stress`、`unworn`、`heart_rate_missing`、
`heart_rate_unavailable`、`stress_unavailable` 给出互斥的分钟数和实际充耗电贡献；事件可能相互重叠，不能再把事件变化相加。
`estimation` 是这些贡献中的估算部分，不能另外加到收支上。两者始终包含全历史，不随显示天数截断。

`data_gap` 事件带 `reason`：`heart_rate_missing` 表示原始历史已取得但无有效
心率；`heart_rate_unavailable` 表示没有可用心率且没有明确的缺测覆盖证据；`stress_unavailable`
表示心率可用但压力过期或缺失。活动期间压力缺失也会注明估算。

手环没有离腕模式，只能从数据推断：**既没有有效期内的普通/运动心率读数，也没有步数活动**，
两条证据同时缺失即为疑似的未佩戴。为避免瞬时抖动误判，静默需连续达到 `unworn_min_minutes`
（默认 60 分钟）才转为 `unworn` 事件；期间的缺测仍按低强度速率估算，转为 `unworn` 后电量保持在
当时的值，既不充电也不消耗，也不计入缺测估算。重新出现心率或步数活动即结束该事件。

算法从有记录的第一晚入睡开始，**从不按天重置**，所以每次调用都会重算全部历史，
`days` / `time_range` 只决定输出显示多少天。每分钟内按新读数、读数过期和睡眠阶段的真实时间再切分，
只积分 `[起点, 终点)` 的实际时长，不足一分钟按比例计算；曲线起点是初始电量，其他点表示已积分到
该时刻，事件不会越过 `as_of`。每日收支记录受电量上下限约束后的实际变化。

每个区间按以下优先顺序取第一条成立的规则：

1. 无有效期内的运动/普通心率、且步数活动也超出 `unworn_after_minutes`，静默连续达到
   `unworn_min_minutes` → 判为未佩戴，电量保持不变；
2. 优先选有效期内的运动/恢复心率（默认 5 秒），否则选更新且仍有效的普通心率（默认 15 分钟）。
   原始历史 `missing` 可来自正常智能采样间隙，不缩短普通心率有效期；只有心率已过期或缺失时，
   才用覆盖状态区分已取得历史但无心率与缺少覆盖证据。高频末点过期后不复活比它更早的普通点。
   没有可用心率时，按低强度速率估算耗电；
3. 心率储备（`(心率 − 静息心率) / (最大心率 − 静息心率)`）高于 0.3 → 活动耗电取
   `max(低强度耗电速率, 活动系数 × 超出阈值的储备比例)`；若还有有效的净压力耗电，再取二者较大值，
   不叠加。高频和普通心率重叠时只用一个值；
4. 没有压力读数，或最近一次读数已满 30 分钟 → 按低强度耗电；
5. 否则使用局部连续压力映射。设阈值 `T = stress_threshold`、过渡半宽 `w = stress_transition_half_width`，
   `q = clamp((压力 − T + w) / (2w), 0, 1)`；恢复分支为
   `C = max(T − 压力, 0) × 恢复系数`（睡眠与清醒系数不同），耗损分支为
   `D = 压力 × stress_drain_per_stress_point`，净变化率为 `(1−q) × C − q × D`。
   默认仅在 25–35 压力分范围混合，两侧严格保持原公式；30 不再是跳变点，也不被假定为零变化点。

读数的有效期统一为 `[读数时间, 读数时间 + 保留时长)`，到期就不再沿用。积分终点由最后心率、压力、
睡眠结束或已取得活动历史覆盖终点确定，不外推至服务器当前时钟。恢复心率可超过运动的 `end_time`，
也可跨午夜；数组仍随运动开始日保存，计算时按全历史时间排序。
睡眠会话（包括其中的夜醒）使用**醒来日**最新一条手环静息心率；非睡眠区间使用当日的最新值，
当日没有则明确沿用最近历史日期的值。有有效心率、需要计算心率储备但缺少相应静息基线时，
工具报错并指出缺少数据的日期，不默认一个静息心率，也不返回假装确定的电量；心率缺测估算无需该基线。

所有阈值和速率都在项目根目录的 [`body-battery.json`](body-battery.json) 里，每次调用重新读取，
所以改完参数立刻对全部历史生效，不用重启。沿用历史配置键 `unworn_after_minutes`，它同时是普通心率
读数和步数活动证据的有效期；`unworn_min_minutes` 是判定未佩戴所需的连续静默时长，两者都改完立即生效。
新增 `workout_heart_rate_hold_seconds`、`stress_transition_half_width` 和 `unworn_min_minutes`，
部署新代码时需一起更新参数文件。
过渡半宽 5 只是可调工程平滑宽度，不是华为官方参数或个体生理校准值。
默认速率不是佳明的真实算法，也没有实测校准过；初始电量和充放电速率是模型假设，分数不代表真实剩余能量百分比。
睡眠心率、静息心率取自手环。HRV、血氧、夜间基线、深睡连续性得分和步数
继续保留查询，本轮不增加其电量权重；`*_day_to_baseline` 只是天数进度，不能作为生理偏差加减分。

最大心率（默认 190）在 [`heart-rate.json`](heart-rate.json) 里，身体电量和训练负荷共用同一个值，
两个算法不各存一份；`body_battery` 输出的 `max_heart_rate_setting` 和 `training_load` 的
`metadata.parameters.max_heart_rate` 都来自这里。训练负荷的公式系数、时间常数与采样规则在
[`training-load.json`](training-load.json) 里，同样是每次调用重新读取。夜醒通知的时长阈值与等待时长在
[`wake-notify.json`](wake-notify.json) 里，同样每次调用重新读取。四个参数文件在容器里都挂了只读卷，
改完不用重启、也不用重建镜像。

`training_load` 返回训练负荷：由已入库运动算出的每日负荷，以及在该负荷上按指数时间常数递推的
CTL、ATL、TSB 和 7 天 Ramp Rate。参数为 `method`（`trimp_average` 默认、`trimp_integrated`、`device_load`）、
`activity`（按运动类型读取，默认全部运动）和 `training_load_detail`（`summary` 默认、`workouts` 附带单场明细）。
返回结构分四块：

| 部分 | 内容 |
| --- | --- |
| `metadata` | 方法、单位、时区、公式与参数依据、静息心率取值规则、数据范围与同步完整状态 |
| `initialization` | 递推起始日期、初值及来源、已计算天数、是否假设用户此前没有训练 |
| `summary` / `daily` | 最新一天与窗口内每天的负荷、CTL、ATL、TSB、`balance_end_of_day`、`ramp_rate`、运动场数与缺失情况 |
| `activities` / `workouts` | 按运动类型拆分（仅全部运动时给出），以及按开始时间倒序的单场明细 |

三种口径**分开计算、分别维护指标，不跨方法补值、不混加单位**：

| 方法 | 输入 | 定位 |
| --- | --- | --- |
| `trimp_average` | 秒级运动时长 × 平均心率 | 默认主序列，适合历史摘要记录 |
| `trimp_integrated` | 运动期间的心率序列积分 | 保留强度变化，作为独立序列 |
| `device_load` | 设备上报的 `workout_load` | 展示设备口径，作为独立序列 |

两个 TRIMP 都用 `TRIMP = 时长(分钟) × HRr × a × e^(b × HRr)`，`HRr = (心率 − 静息心率) / (最大心率 − 静息心率)`，
系数 `a`、`b` 和模型来源写在 `training-load.json` 里，不按性别或年龄自动切换。积分法按每个读数的实际采样
间隔积分，读数只在自己之后 `hr_hold_seconds` 内有效；同一时刻的重复点取排序后最后一条；心率裁剪到运动
开始与结束之间，**结束后的恢复心率不产生负荷**。单场明细里的 `coverage` 给出所用时长、覆盖时间、未覆盖
时间和采样条数，可以自己判断积分依据有多厚。

递推用指数时间常数形式，时间常数、Ramp Rate 周期和初值都在 `training-load.json` 里，不写死在计算函数中：

```
CTL_d = CTL_{d-1} + (Load_d − CTL_{d-1})(1 − e^(−1/42))
ATL_d = ATL_{d-1} + (Load_d − ATL_{d-1})(1 − e^(−1/7))
TSB_d = CTL_{d-1} − ATL_{d-1}        当天训练前的状态
Balance_d = CTL_d − ATL_d            日末平衡
RampRate_d = CTL_d − CTL_{d−7}       不足七天为 null
```

**数据范围**：只描述已入库运动，`sync_completeness` 恒为 `unverified`。没有已入库运动的日期按已记录负荷
为 0 参与衰减，但不声称这一天确实休息；当天标记 `provisional`，随补传更新。某场运动缺少该口径需要的
输入时，单场 `load` 为 `null` 并给出 `reason`（`missing_average_heart_rate`、`missing_resting_heart_rate`、
`missing_duration_seconds`、`no_heart_rate_samples`、`no_heart_rate_coverage`、`unknown_workout_span`、
`unallocatable_span`、`missing_workout_load`、`invalid_heart_rate_range`），该天的 `load` 只作为已计算部分的
小计、`load_status` 为 `partial`，并且**该口径当天及之后的 CTL、ATL、TSB、Ramp Rate 保持 `null`**
（`metrics_status: blocked`，`blocked_since` 指明从哪天起）——完整日负荷无从确定时不跳过后继续输出貌似完整的
指标。不同口径互不影响：某一场缺心率序列只挡住积分法，设备负荷和平均法照常。

跨午夜时，积分法按心率所在的实际时间区间分日，平均法和设备负荷按运动墙钟区间的时间比例分日并在
`daily_split` 里标记 `allocation: proportional`（同一天内为 `exact`）；分日后的负荷之和等于该场运动的原值。
缺少能定出墙钟区间的信息时返回 `unallocatable_span`，不猜。

静息心率取运动开始日当天的一条，当日没有则沿用最近一个更早的日期，不用全天最低心率代替；早于全部
历史记录的日期没有可用基线，对应的两种 TRIMP 标记为不可计算。

从本地最早运动日期起、以配置中明确声明的零初值递推，每次读取重算全历史，所以补传、同开始时间的修正
和改配置都自然生效，不需要缓存失效机制；`days` 只决定返回多少天，不改变同一天的结果。`activities` 里每个
运动类型的序列从该类型自己的首场运动起算，是它独立的 CTL/ATL，不是全身负荷的一部分。全历史没有已入库
运动时返回 `null`。

这个模型是从现有记录建立的：`initialization.assumes_no_prior_training` 恒为 `false`，零初值不代表用户
此前没有训练，也不声称 42 天后初值的影响完全消失，`days_computed` 说明递推跑了多少天。

经期配置使用上传门锁调用 `POST /cycle`，请求体包含 `enabled`、`last_start`、
`cycle_length_days`、`cycle_period_days`，以及可选的 `last_confirmed`。关闭时发送 `{ "enabled": false }`，
服务会删除独立的 `cycle.json`，不会写入每日健康记录。

个人资料（身高、体重、年龄、性别、生日）没有单独的端点：App 把它捎在 `POST /api/health` 的日
body 里，服务端收到后提到独立的 `profile.json`，读取时挂在结果顶层。App 只发填过的字段，
没填的键不出现。

MCP 入口 `https://你的域名/mcp`（Streamable HTTP）。若设了读取 token，客户端请求头需加 `Authorization: Bearer <读取token>`。

### health_wait_for_wake

`health_wait_for_wake` 用来等**夜醒**：同一夜里先有睡眠、中间一段清醒、之后还有睡眠，清醒时长达到
[`wake-notify.json`](wake-notify.json) 里的 `min_awake_minutes`（默认 5 分钟）。天亮那次收尾的醒来是起床，
不算；小睡也不算。事件在手机把睡眠数据传上来时入库——后台按小时、每次解锁屏幕也同步一次——所以
半夜醒来通常几秒到一小时内到达。请求一直挂到事件到达或超时，于是「拉取」在客户端看来就是「推送」，
不需要客户端支持服务端主动通知（Streamable HTTP 入口只收 POST，本来也没有推送通道）。

参数只有两个：`since`（整数游标，可选）和 `timeout_seconds`（可选，默认 `default_wait_seconds`）。
不传 `since` 表示只等这次调用之后新收到的事件；把上次返回的 `next_since` 传回来，就能取到断开期间
积累的事件。同一夜重传不会重复，同一次上传里的多条也不会漏。返回 `timed_out`、`events` 和 `next_since`，
事件带 `night`（属于哪一夜）、`start`/`end`（那段清醒的起止，ISO）、`awake_minutes`、`received_at`。

同一夜每次同步都会整段重传，服务端按事件自身的起止去重，只认第一次见到的时间；被修正掉的那条
（这一夜重传后已经没有它）会随之消失。事件存在 `<HEALTH_DATA_DIR>/wake-events.json`，服务重启和客户端
断开都不影响。阈值在读取时生效，所以改完立刻对全部历史有效；`poll_interval_seconds` 是等待时的轮询间隔。

## 数据

按天落盘为 `<HEALTH_DATA_DIR>/YYYY-MM-DD.json`。新 App 上传一分钟步数并带 `steps_bucket_seconds: 60`，
表示该日从当地零点到当前已取得数据的整日快照；收到时重建当天步数序列，总数从新桶求和，空数组清零，
因此不会把旧五分钟桶与新一分钟桶重复累计。没有粒度标记的旧客户端仍按时间戳合并；同一设备升级后不要
交替发送未标粒度的旧桶。普通心率按时间戳去重；卡路里、距离使用后到的总量；血氧、压力、HRV、体温、
静息心率按时间戳去重。睡眠 session 按时间跨度重叠判断同一晚并保留更完整版本，同一起止和时长的补传
更新阶段与评分；睡眠统计、情绪、睡眠呼吸暂停、运动记录按时间戳整条替换。个人资料单独存成 `profile.json`，
夜醒事件单独存成 `wake-events.json`（同一夜重传不重复，被修正掉的那条随之消失）；两者内容没变就不重写。

`workouts[].heart_rate` 为 `[{"timestamp":"ISO 时间","value":心率}]`，运动及恢复点合并、相同时间去重，
保留原始秒级时间；`end_time` 仍为实际运动结束时间，不限制恢复点范围。缺少该数组的历史运动继续使用普通心率。
`heart_rate_coverage` 是按当地日切分的半开区间数组：
`[{"timestamp":"开始时间","end_time":"结束时间","status":"observed 或 missing"}]`。
`observed` 仅表示该原始活动历史区间报告了有效心率，`missing` 表示历史已取得但无有效心率；没有区间是未知，
本身不等于离腕（离腕由心率与步数两条证据推断，见上文）。收到该数组时替换整日覆盖快照（空数组清空，
未提供字段则保留旧值），避免重分段产生残留。
这些快照表示手机当前已有记录，不保证手环所有通道已同步完整；本次不改变手机同步调度、上传频率或通知功能。

## 许可

MIT（本服务端为独立代码）。手机端 Gadgetbridge fork 是 AGPLv3、单独的仓库。

---

完整端到端图文教程（含手机端安装、连手环、接入 AI）：
<https://github.com/xiaoyou5602/band-health-sync/blob/master/docs/GUIDE.md>
