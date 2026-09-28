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

- `data_type`：`current_status`、`steps`、`heart_rate`、`sleep`、`workouts`、`daily_summary`、`series`、`all`
- `time_range`：`today` 或 `three_days`
- `days`：除 `current_status` 外可自定义读取 1～62 天；传入后优先于 `time_range`
- `heart_rate_detail`：仅用于 `heart_rate`，可选 `daily` 或 `hourly`；小时模式只返回每小时统计，不返回原始样本

不传参数时返回紧凑的当前状态。`daily_summary` 每天包含步数、卡路里、距离、心率、静息心率、血氧、
压力、HRV、体温、睡眠分数和睡眠摘要；`current_status` 额外给出各指标当天最新一次读数；`workouts`
返回最近的运动记录（类型、起止、时长、距离、卡路里、平均心率、步数），`all` 还会附带睡眠明细。
读取结果可能附带 `cycle` 经期上下文和 `profile` 个人资料。

`series` 返回窗口内每天的原始带时间戳读数，不做任何聚合：`heart_rate`（`bpm`）、`steps`、
`resting_heart_rate`、`spo2`、`stress`（含 `level`）、`hrv`、`temperature`，
以及 `sleep_sessions` 的逐段 `stages`（`stage`/`start`/`end`/`duration_seconds`）。某天没有的序列不出现。
数值口径与落盘一致，怎么分析由调用方决定。注意体积：本机实测 2 天约 56 KB（≈14k token），
按此比例 62 天约 1.7 MB，远超一般客户端的上下文，所以拉长窗口时建议只取需要分析的序列。

经期配置使用上传门锁调用 `POST /cycle`，请求体包含 `enabled`、`last_start`、
`cycle_length_days`、`cycle_period_days`，以及可选的 `last_confirmed`。关闭时发送 `{ "enabled": false }`，
服务会删除独立的 `cycle.json`，不会写入每日健康记录。

个人资料（身高、体重、年龄、性别、生日）没有单独的端点：App 把它捎在 `POST /api/health` 的日
body 里，服务端收到后提到独立的 `profile.json`，读取时挂在结果顶层。App 只发填过的字段，
没填的键不出现。

MCP 入口 `https://你的域名/mcp`（Streamable HTTP）。若设了读取 token，客户端请求头需加 `Authorization: Bearer <读取token>`。

## 数据

按天落盘为 `<HEALTH_DATA_DIR>/YYYY-MM-DD.json`。同一天重复上传自动合并：步数与心率按时间戳去重（同一时间戳传新值即替换；App 每次都从本地零点重发一天，所以仍在长的最后一个 5 分钟桶下一轮会被改写，当日步数总数由各桶求和重算）；卡路里、距离取较大值；血氧、压力、HRV、体温、静息心率按时间戳去重（同一时间戳传新值即替换）；睡眠 session 按时间跨度重叠判断同一晚并保留更完整版本；睡眠统计、情绪、睡眠呼吸暂停、运动记录按时间戳整条替换（运动记录用开始时间做键，手环从不改开始时间，所以改过数据的同一次运动是覆盖而不是并存）。所以重复上传或手动补传历史都不会把数据搞乱。个人资料单独存成 `profile.json`，后者覆盖前者，内容没变就不重写。

## 许可

MIT（本服务端为独立代码）。手机端 Gadgetbridge fork 是 AGPLv3、单独的仓库。

---

完整端到端图文教程（含手机端安装、连手环、接入 AI）：
<https://github.com/xiaoyou5602/band-health-sync/blob/master/docs/GUIDE.md>
