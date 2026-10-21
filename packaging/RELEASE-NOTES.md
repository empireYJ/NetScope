Windows x64 完整安装包。下载下方 **NetScope-*-windows-x64-setup.exe**，双击安装即可使用。

- 内置 Node.js 与自包含 .NET 运行环境，无需单独安装开发工具。
- 附带 Microsoft WebView2 离线安装程序，检测到缺少时自动安装。
- 默认安装到当前用户目录，提供开始菜单、可选桌面快捷方式及登录自启动。
- 支持保留账本和设置的原位升级；卸载保留 `data` 历史目录。
- CLI/MCP 同样使用随包运行环境。四榜分流依赖兼容的 Clash Verge Rev/Mihomo；Windows 增强采集在设置中按需启用，首次需要 UAC。

安装包未配置商业代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示。请确认来自本仓库，并使用 SHA256SUMS.txt 核对文件。

构建来源、依赖版本及安装/启动/升级/卸载检查结果分别见 build-info.json 与 verification-report.json。测试在 GitHub 托管 Windows 构建机中完成，并不等同于对所有干净 Windows 10/11 机器的兼容性保证。默认不会上传私人流量库、日志或凭据。
