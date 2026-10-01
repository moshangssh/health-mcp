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

服务只暴露一个 `health_read` 工具：

- `data_type`：`current_status`、`steps`、`heart_rate`、`sleep`、`workouts`、`daily_summary`、`series`、`body_battery`、`all`
- `time_range`：`today` 或 `three_days`
- `days`：除 `current_status` 外可自定义读取 1～62 天；传入后优先于 `time_range`
- `heart_rate_detail`：仅用于 `heart_rate`，可选 `daily` 或 `hourly`；小时模式只返回每小时统计，不返回原始样本

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
累计充电、累计耗电、缺测估算分钟数），`events`（睡眠、活动、缺测估算、高压力时段）和 `curve`。
时间通常显示到分钟，非整分钟的起止和终点保留秒及非零毫秒。`max_heart_rate_setting` 是配置最大心率，
`observed_max_heart_rate` 是普通及运动心率中观测到的最高值，不自动代替配置值。

`estimated` 表示从历史起点至今包含缺测估算；曲线每点的同名标记也是累计口径，恢复观测不会清除。
新增 `interval_estimated` 表示从上一绘图点到该点的区间是否包含缺测。顶层 `estimation` 给出全历史
估算的 `minutes`、`charged`、`drained`；这不是置信区间，也不等于最终分数的误差。
`contributions` 按 `sleep_recovery`、`rest_recovery`、`activity`、`stress`、`heart_rate_missing`、
`heart_rate_unavailable`、`stress_unavailable` 给出互斥的分钟数和实际充耗电贡献；事件可能相互重叠，不能再把事件变化相加。
`estimation` 是这些贡献中的估算部分，不能另外加到收支上。两者始终包含全历史，不随显示天数截断。

`data_gap` 事件替代原来的 `unworn`，带 `reason`：`heart_rate_missing` 表示原始历史已取得但无有效
心率；`heart_rate_unavailable` 表示没有可用心率且没有明确的缺测覆盖证据；`stress_unavailable`
表示心率可用但压力过期或缺失。任何一种都不代表确定离腕，活动期间压力缺失也会注明估算。

算法从有记录的第一晚入睡开始，**从不按天重置**，所以每次调用都会重算全部历史，
`days` / `time_range` 只决定输出显示多少天。每分钟内按新读数、读数过期和睡眠阶段的真实时间再切分，
只积分 `[起点, 终点)` 的实际时长，不足一分钟按比例计算；曲线起点是初始电量，其他点表示已积分到
该时刻，事件不会越过 `as_of`。每日收支记录受电量上下限约束后的实际变化。

每个区间按以下优先顺序取第一条成立的规则：

1. 优先选有效期内的运动/恢复心率（默认 5 秒），否则选更新且仍有效的普通心率（默认 15 分钟）。
   原始历史 `missing` 可来自正常智能采样间隙，不缩短普通心率有效期；只有心率已过期或缺失时，
   才用覆盖状态区分已取得历史但无心率与缺少覆盖证据。高频末点过期后不复活比它更早的普通点。
   没有可用心率时，按低强度速率估算耗电；
2. 心率储备（`(心率 − 静息心率) / (最大心率 − 静息心率)`）高于 0.3 → 活动耗电取
   `max(低强度耗电速率, 活动系数 × 超出阈值的储备比例)`；若还有有效的净压力耗电，再取二者较大值，
   不叠加。高频和普通心率重叠时只用一个值；
3. 没有压力读数，或最近一次读数已满 30 分钟 → 按低强度耗电；
4. 否则使用局部连续压力映射。设阈值 `T = stress_threshold`、过渡半宽 `w = stress_transition_half_width`，
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
所以改完参数立刻对全部历史生效，不用重启。保留历史配置键 `unworn_after_minutes`，它仅表示普通心率
有效期，不代表确认离腕；新旧代码读取同一键，避免运行中的旧进程在配置更新后失去该参数。
新增 `workout_heart_rate_hold_seconds` 和 `stress_transition_half_width`，部署新代码时需一起更新参数文件。
过渡半宽 5 只是可调工程平滑宽度，不是华为官方参数或个体生理校准值。
默认速率不是佳明的真实算法，也没有实测校准过；初始电量和充放电速率是模型假设，分数不代表真实剩余能量百分比。
睡眠心率、静息心率取自手环，最大心率是参数（默认 190）。HRV、血氧、夜间基线、深睡连续性得分和步数
继续保留查询，本轮不增加其电量权重；`*_day_to_baseline` 只是天数进度，不能作为生理偏差加减分。

经期配置使用上传门锁调用 `POST /cycle`，请求体包含 `enabled`、`last_start`、
`cycle_length_days`、`cycle_period_days`，以及可选的 `last_confirmed`。关闭时发送 `{ "enabled": false }`，
服务会删除独立的 `cycle.json`，不会写入每日健康记录。

个人资料（身高、体重、年龄、性别、生日）没有单独的端点：App 把它捎在 `POST /api/health` 的日
body 里，服务端收到后提到独立的 `profile.json`，读取时挂在结果顶层。App 只发填过的字段，
没填的键不出现。

MCP 入口 `https://你的域名/mcp`（Streamable HTTP）。若设了读取 token，客户端请求头需加 `Authorization: Bearer <读取token>`。

## 数据

按天落盘为 `<HEALTH_DATA_DIR>/YYYY-MM-DD.json`。新 App 上传一分钟步数并带 `steps_bucket_seconds: 60`，
表示该日从当地零点到当前已取得数据的整日快照；收到时重建当天步数序列，总数从新桶求和，空数组清零，
因此不会把旧五分钟桶与新一分钟桶重复累计。没有粒度标记的旧客户端仍按时间戳合并；同一设备升级后不要
交替发送未标粒度的旧桶。普通心率按时间戳去重；卡路里、距离使用后到的总量；血氧、压力、HRV、体温、
静息心率按时间戳去重。睡眠 session 按时间跨度重叠判断同一晚并保留更完整版本，同一起止和时长的补传
更新阶段与评分；睡眠统计、情绪、睡眠呼吸暂停、运动记录按时间戳整条替换。个人资料单独存成 `profile.json`，
后者覆盖前者，内容没变就不重写。

`workouts[].heart_rate` 为 `[{"timestamp":"ISO 时间","value":心率}]`，运动及恢复点合并、相同时间去重，
保留原始秒级时间；`end_time` 仍为实际运动结束时间，不限制恢复点范围。缺少该数组的历史运动继续使用普通心率。
`heart_rate_coverage` 是按当地日切分的半开区间数组：
`[{"timestamp":"开始时间","end_time":"结束时间","status":"observed 或 missing"}]`。
`observed` 仅表示该原始活动历史区间报告了有效心率，`missing` 表示历史已取得但无有效心率；没有区间是未知，
不是离腕。收到该数组时替换整日覆盖快照（空数组清空，未提供字段则保留旧值），避免重分段产生残留。
这些快照表示手机当前已有记录，不保证手环所有通道已同步完整；本次不改变手机同步调度、上传频率或通知功能。

## 许可

MIT（本服务端为独立代码）。手机端 Gadgetbridge fork 是 AGPLv3、单独的仓库。

---

完整端到端图文教程（含手机端安装、连手环、接入 AI）：
<https://github.com/xiaoyou5602/band-health-sync/blob/master/docs/GUIDE.md>
