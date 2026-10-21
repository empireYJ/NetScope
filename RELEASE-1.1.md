# 墨流 NetScope 1.1 · 诊断工作台

Windows 本机网络诊断桌面工具。新增入口在左侧“诊断工作台”，保留原有四个直连/VPN 上下行排行榜和无边框黑绿界面。

## 已交付

| 能力 | 使用方式与证据边界 |
|---|---|
| 峰值回溯和时段对比 | 点击总览曲线或诊断页峰值卡，回看分钟活动、进程实例、目标和采集事件；可与前一等长时段比较。不是瞬时速率或请求内容推断。 |
| 代理路线解释 | 展示应用、入站方式、命中规则、Clash 链路和目标。旧流缺少的规则明确显示未保存；内部转发独立留档。 |
| 项目／任务归组 | 显式绑定程序路径、目标域名或 PID + 创建时间的进程树。依赖保留的父进程生命周期证据；跨项目重叠会显示，不能把重叠总量相加。 |
| 计数可信度 | 显示程序归属未知、路线未知、Clash 采样覆盖、无样本时段、ETW 状态和修正事件；过期删除不标为采集缺口。 |
| AI 请求元数据 | 一次性读取现有 Codex 大小日志，或开启自动读取。通用元数据 SDK/JSONL 导入支持图片哈希、编码大小和尝试序号；不保存正文、图片或认证头。 |
| 按程序预算和异常提醒 | 小时／日／月额度、流量突增、首次联网和新目标发现；支持方向和路线过滤、开启／关闭／删除、冷却和通知去重。所有规则只提醒。 |
| 按需连接诊断 | 系统路由或 Clash CONNECT 两种路径；DNS、TCP、TLS 阶段计时、证书校验、连接成功率和耗时波动。最多 5 个样本，不下载测速文件。 |
| 脱敏包、CLI、MCP | 一键导出带范围和条数边界的 JSON；扩展结构化终端接口和 stdio MCP。MCP 默认 13 个只读工具，控制与主动联网要在启动参数中显式启用。 |

## 快速使用

```powershell
.\netscope.cmd open
.\netscope.cmd peaks --range 24h --direction upload --json
.\netscope.cmd replay --at 2026-10-21T13:00:00Z --minutes 5 --json
.\netscope.cmd routes --range 1h --search codex.exe --json
.\netscope.cmd trust --range 24h --json
.\netscope.cmd projects create --name "本次构建" --json
# 用上一步返回的 id 和 top/process 返回的程序 key：
.\netscope.cmd projects bind --id PROJECT_ID --program PROGRAM_KEY --json
# 或绑定当前根进程及其子进程，CLI 自动核对创建时间：
.\netscope.cmd projects bind --id PROJECT_ID --pid 12345 --json
.\netscope.cmd ai scan --json
.\netscope.cmd probe --host example.com --mode clash --count 3 --json
.\netscope.cmd bundle --range 1h --out diagnostic.json --json
.\netscope.cmd mcp-config --json
```

MCP 配置由 `mcp-config` 生成，默认只读，不自动安装进任何 AI 客户端。使用 Node 直接启动 `mcp.mjs`，stdout 只输出 JSON-RPC。可选参数 `--allow-control` 开放显式采集控制、创建项目和只读日志导入；`--allow-probes` 开放主动连接诊断。

预算 JSON 示例，保存为文件后执行 `rules add --file rule.json --json`：

```json
{
  "name": "开发工具每日 VPN 上传预算",
  "kind": "budget",
  "programKey": "",
  "route": "PROXY",
  "direction": "upload",
  "period": "day",
  "limitBytes": 1000000000,
  "enabled": true
}
```

`kind` 还可为 `spike`、`new-program`、`new-destination`；突增用 `factor` 和 `limitBytes` 指定倍数及最小字节。项目和提醒是用户配置，不预置验收规则。自动 Codex 日志读取默认关闭。

## AI 元数据适配

`lib/ai-recorder.mjs` 导出 `measureRequest(body, metadata)` 和 `reportRequestMetric(base, token, metric)`。前者在本地计算 JSON 编码大小和内嵌图像 SHA-256，返回的对象不含正文；后者只向本机 NetScope 写入元数据。`postBytes` 应由调用方填写实际压缩后大小；尝试序号也必须来自调用方证据。

元数据字段：`provider, requestId, time, sessionId/sessionRef, label, preBytes, postBytes, imageBytes, imageCount, attempt, status, evidence, images`。图片条目只有 `hash, encodedBytes, occurrences`。拒绝正文、认证头及其他字段；每批最多 100 条，导入文件最大 1 MB，HTTP 请求体最大 256 KB。

Codex 日志适配器只查询最近 24 小时的压缩大小行，不读取会话标题、请求正文、附件或认证字段。日志中的 `prepared` 证明正文已准备，不证明请求上传成功。未提供的图片和重试信息保持未知。请求正文统计与网络账本不相加；重试次数未知不等于零。

## 存储和隐私

SQLite schema 3。目标流保存规则和归属依据，进程库存按 PID + 创建时间归一化，每分钟最多更新一次持续活动记录。历史流量、进程库存、AI 元数据、探测和通知事件都按既有保留期限清理；项目及提醒配置单独保留。AI 图像仅保存哈希及字节数。

诊断包默认匿名化域名/IP/节点/项目标识，移除本机路径、自由文本事件、会话标题、认证数据和请求正文；保留程序名称。用户可显式选择保留域名/IP。明细最多 500 条，并明确标注截断；MCP 默认导出 100 条。

系统路由探测可能经过 TUN；Clash 模式不虚构代理端的 DNS/TCP 独立耗时。连接失败率不等于 IP 丢包率。旧进程树缺少生命周期记录时不猜测补齐。

## 验证范围

自动测试覆盖记账去重、保留期限、回溯对比、进程生命周期、提醒、元数据隐私、HTTP 鉴权与 MCP。Windows 桌面已进行交互与窄窗口检查。真实网络流量、日志和验收数据库不随源码发布。使用 `npm test` 在当前环境重新验证；系统采集、桌面通知、代理路径和开机启动仍取决于本机 Windows 与代理配置。

## 从源码构建

需要 Node.js >= 22.19、.NET 9 SDK/Windows Desktop Runtime 和 WebView2 Runtime：

```powershell
npm test
dotnet publish native/NetScope.Sensor.csproj -c Release -o runtime/sensor
dotnet publish desktop-src/NetScope.csproj -c Release -o desktop
.\start.ps1 -Open
```

`NETSCOPE_DATA_DIR` 可指定独立数据目录；`NETSCOPE_OFFLINE=1` 为历史查看/验收模式，不连接传感器。不要把离线模式的静态快照视为实时采集。
