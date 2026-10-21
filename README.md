# 墨流 NetScope

**看清谁在上传、谁在下载，以及流量为什么走了代理。**

A local-first Windows desktop network observatory with direct/proxy traffic rankings, process attribution, diagnostics, and CLI/MCP access.

[![License: MIT](https://img.shields.io/badge/license-MIT-a3ff5b?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-101a13?style=flat-square)](#从源码运行)

NetScope 使用无边框黑绿界面、单边缺角卡片和可关闭的点阵流效果。网络账本与诊断数据保存在本机 SQLite 中。当前版本 **1.1.0**；目前提供源码构建，尚未提供签名安装包。

## 能做什么

| 能力 | 说明 |
|---|---|
| 四个独立榜单 | 直连上传、直连下载、VPN／代理上传、VPN／代理下载，支持历史时间范围 |
| 程序与任务详情 | 程序路径、PID、父进程、进程创建时间、目标域名／IP、路由证据与分钟流量 |
| 诊断工作台 | 峰值回溯、前后时段对比、代理规则／链路解释、采集可信度和缺口 |
| 项目归组 | 显式绑定程序、域名或带创建时间的进程树，标明项目间重叠 |
| 预算与异常提醒 | 小时／日／月预算、突增、新程序和新目标发现；只提醒，不打断任务 |
| AI 请求元数据 | 可选读取已有 Codex 压缩大小日志，或导入 SDK／JSONL 元数据；不保存请求正文 |
| 连接诊断 | 按需检查系统路由或 Clash CONNECT 路径的 DNS／TCP／TLS，限制采样次数 |
| 本地自动化 | JSON CLI、回环 HTTP API、默认只读的 stdio MCP，支持脱敏诊断导出 |
| 桌面集成 | 托盘、暂停／恢复、最大化／还原、设置中切换开机自启动 |

## 从源码运行

需要 **Windows 10/11**、**Node.js >=22.19.0**、**.NET 9 SDK**（构建）及 Windows Desktop Runtime、**Edge WebView2 Runtime**。前端无 npm 运行时依赖，无须 `npm install`。

```powershell
git clone https://github.com/empireYJ/NetScope.git
cd NetScope
npm test
npm run build
.\desktop\NetScope.exe
```

也可分别构建：

```powershell
dotnet publish native/NetScope.Sensor.csproj -c Release -o runtime/sensor
dotnet publish desktop-src/NetScope.csproj -c Release -o desktop
.\start.ps1 -Open
```

请将 `desktop`、`runtime`、`public`、`lib`、脚本和后端源码一起保留在项目目录。桌面外壳会启动本机 Node 后端；默认界面地址为 `http://127.0.0.1:47831`，仅绑定回环地址。

在设置中启用 **Windows 增强采集**会弹出一次 UAC，注册当前用户的高权限只读 ETW 传感器任务。界面与后端保持普通权限。关闭增强采集后仍可观察代理连接与整机网卡计数。设置中的开机自启动在登录后收起到托盘。

### 代理采集要求

当前代理适配器针对 **Clash Verge Rev / Mihomo 的 Windows 本地命名管道**：从 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml` 读取 `external-controller-pipe` 和控制密钥；密钥只在本机用于访问 `/connections`，不写入流量账本。代理需提供进程元数据，才能得到较完整的程序归属。

其他 VPN 客户端尚无通用适配；Windows ETW 可以补充程序计数，但无法凭字节数猜测它是否经过 VPN。配置不兼容或服务未就绪时，界面保留采集状态和错误。

## 终端与 AI harness

```powershell
.\netscope.cmd status --json
.\netscope.cmd top --route direct --direction upload --range 24h --json
.\netscope.cmd top --route vpn --direction download --range 24h --json
.\netscope.cmd process --name codex.exe --json
.\netscope.cmd peaks --range 24h --direction upload --json
.\netscope.cmd trust --json
.\netscope.cmd config set --retention-days 90 --hourly-gb 1 --json
.\netscope.cmd bundle --range 1h --out diagnostic.json --json
.\netscope.cmd mcp-config --json
```

MCP 使用 `node mcp.mjs`，默认只开放读取；`--allow-control` 开放配置与控制，`--allow-probes` 开放主动连接诊断。完整字段、权限、分页与计量规则见 [HARNESS.md](HARNESS.md)，新增功能用法见 [RELEASE-1.1.md](RELEASE-1.1.md)。

## 数据、精度和隐私

- `data/traffic.sqlite` 使用 SQLite WAL、规范化维度和分钟聚合，每 5 秒批量提交。默认保存 30 天；0 为永久，最大 3650 天。每 15 分钟清理一次，缩短期限时立即清理；整理功能可回收空闲页。
- 代理快照、Windows 网络事件和物理网卡是不同计量层。内部代理转发独立归档为 `TRANSPORT`，不重复加入应用四榜与提醒；物理网卡量不与应用量相加。
- 代理采用连接快照，极短连接和连接结束前尾部可能漏记；增强采集也可能丢失事件。未能证明的程序或路线保持未知。工具记录启动后的观测，不能还原安装前丢失的按程序历史。
- VPN／代理流量是本机观测值；服务商倍率、协议开销与其他设备会造成套餐账单差异。多个 AI 对话或浏览器标签共享同一进程时，不能仅靠网络计数精确拆分。
- 不解密 TLS，不采集请求正文、图片原件、完整命令行或认证头。流量库仍含程序路径、域名／IP 等敏感元数据；原始账本、密钥、日志、诊断文件、导出和浏览器缓存均不应直接公开。
- AI 日志自动读取默认关闭；`prepared` 元数据不证明上传成功，请求大小不可叠加到网络流量总量。主动连接诊断由用户触发，不下载大体积测速文件。
- 保留期限覆盖生产账本中的历史；手动导出、独立备份和 WebView 缓存需自行管理。代码仓库已忽略本地数据和构建目录。

`NETSCOPE_DATA_DIR` 可指定独立数据目录；`NETSCOPE_OFFLINE=1` 只浏览历史、不启动采集器。桌面及系统启动脚本使用默认安装内的 `data/`，环境变量主要供后端开发和测试隔离使用。

## 开发与贡献

后端和 CLI 为 Node.js ES Modules；原生采集器使用 .NET / Microsoft TraceEvent；桌面采用 WinForms + WebView2，前端为原生 HTML/CSS/JavaScript。自动测试使用 `node:test`，覆盖计量去重、历史清理、路由证据、预算、元数据隐私、HTTP 鉴权及 MCP。

欢迎通过 Issue 和 Pull Request 提交问题及改进。报告问题时请提供 Windows、Node、.NET 和代理版本、复现步骤及脱敏输出；不要上传数据库、控制密钥或私人日志。提交前执行 `npm test` 和 `npm run build`。参见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

项目源码采用 [MIT 许可证](LICENSE)。依赖保留各自许可证，尤其 WebView2 SDK／Runtime；详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
