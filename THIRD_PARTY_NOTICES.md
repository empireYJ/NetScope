# Third-party dependencies

The MIT license at the repository root covers NetScope's own source code. Dependencies retain their respective licenses; this source repository does not redistribute their binaries.

| Component | Version / use | License / upstream |
|---|---|---|
| Microsoft.Diagnostics.Tracing.TraceEvent | 4.0.0, Windows ETW sensor | MIT; [PerfView / TraceEvent](https://github.com/microsoft/perfview) |
| System.Management | 9.0.0, Windows process information | MIT; [.NET runtime](https://github.com/dotnet/runtime) |
| Microsoft.Web.WebView2 | 1.0.4258.31, desktop WebView | Microsoft license shipped in the NuGet package as `LICENSE.txt`; [SDK package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31) |
| Node.js | >=22.19.0, separately installed runtime | MIT and bundled third-party notices; [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) |
| .NET / Windows Desktop Runtime | 9.0, separately installed runtime | MIT and bundled notices; [.NET runtime license](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT) |
| Microsoft Edge WebView2 Runtime | separately installed runtime | Microsoft terms; [distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) |

NuGet restores the referenced SDK packages during the build. Review each package's included license and notices before redistributing a compiled application. The WebView2 SDK and Runtime are not relicensed under this project's MIT license.

Mihomo / Clash Verge Rev are optional, separately installed integrations. Their software, configurations and subscription data are not included here. The HTML/CSS/JavaScript interface has no npm runtime dependencies, remote fonts or CDN assets.
