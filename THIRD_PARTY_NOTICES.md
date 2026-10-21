# Third-party dependencies

The MIT license at the repository root covers NetScope's own source code. Dependencies retain their respective licenses. The source tree contains references rather than runtime binaries; Windows Release installers bundle the dependencies listed below and their license notices in the installed `licenses/` directory.

| Component | Version / use | License / upstream |
|---|---|---|
| Microsoft.Diagnostics.Tracing.TraceEvent | 4.0.0, Windows ETW sensor | MIT; [PerfView / TraceEvent](https://github.com/microsoft/perfview) |
| System.Management | 9.0.0, Windows process information | MIT; [.NET runtime](https://github.com/dotnet/runtime) |
| Microsoft.Web.WebView2 | 1.0.4258.31, desktop WebView | Microsoft license shipped in the NuGet package as `LICENSE.txt`; [SDK package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31) |
| Node.js | >=22.19.0 for development; pinned runtime bundled in Windows installers | MIT and bundled third-party notices; [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) |
| .NET / Windows Desktop Runtime | 9.0; self-contained runtimes bundled in Windows installers | MIT and bundled notices; [.NET runtime license](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT) |
| Microsoft Edge WebView2 Runtime | Microsoft-signed offline prerequisite installer bundled; used when absent | Microsoft terms; [distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) |

NuGet restores the referenced SDK packages during the build. The packaging script collects original NuGet metadata, declared license files, MIT permission notices and available third-party notices for transitive packages and self-contained runtime packs. Node's complete LICENSE is bundled. The WebView2 SDK and Runtime are not relicensed under this project's MIT license; the Microsoft-signed prerequisite installer retains its own terms.

Installer dependency versions and hashes are in `packaging/dependencies.json`; each release records actual versions and source revision in `build-info.json`. Inno Setup is a build tool on the CI runner; its compiler is not installed with NetScope.

Mihomo / Clash Verge Rev are optional, separately installed integrations. Their software, configurations and subscription data are not included here. The HTML/CSS/JavaScript interface has no npm runtime dependencies, remote fonts or CDN assets.
