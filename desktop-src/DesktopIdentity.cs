using System.Security.Cryptography;
using System.Text;

static class DesktopIdentity {
    // Same UTF-8 hash as the Node backend and PowerShell sensor launcher.
    internal static readonly string UserId=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Environment.UserName.ToLowerInvariant()))).ToLowerInvariant()[..16];
    internal static readonly string MutexName="Local\\NetScope-Desktop-"+UserId;
    internal static readonly string ControlPipe="NetScope-Desktop-Control-"+UserId;
}
