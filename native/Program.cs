using System.Diagnostics;
using System.Management;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

class Program
{
    static readonly object Gate = new();
    static Dictionary<string, Flow> Pending = new();
    static readonly Dictionary<string, (int index, long time)> Routes = new();
    static TraceEventSession? Session;
    static volatile bool Quit;
    static string StopPath = "";
    static long Sequence;
    static HashSet<string> LocalAddresses = new();
    static readonly string Instance = Guid.NewGuid().ToString("N");
    [DllImport("iphlpapi.dll")] static extern uint GetBestInterfaceEx(byte[] address, out uint index);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    record Flow(int pid, string local, int localPort, string remote, int remotePort, string protocol, int routeIndex)
    { public long up {get;set;} public long down {get;set;} }
    static void Emit(object value) { lock (Console.Out) Console.WriteLine(JsonSerializer.Serialize(value)); }
    static int Route(IPAddress ip)
    {
        var key=ip.ToString(); var now=Environment.TickCount64;
        if (Routes.TryGetValue(key,out var old) && now-old.time<30000) return old.index;
        var buf=new byte[28]; var v6=ip.AddressFamily==System.Net.Sockets.AddressFamily.InterNetworkV6;
        buf[0]=(byte)(v6?23:2); ip.GetAddressBytes().CopyTo(buf,v6?8:4);
        int result=GetBestInterfaceEx(buf,out var idx)==0?(int)idx:-1;
        if(Routes.Count>20000) Routes.Clear(); Routes[key]=(result,now); return result;
    }
    static void Capture(int pid, int size, IPAddress src, int sport, IPAddress dst, int dport, bool send, string protocol)
    {
        if(size<=0 || pid<0) return;
        // TCP receive events keep connection endpoint order, while UDP uses packet order.
        bool sourceLocal=LocalAddresses.Contains(src.ToString());
        bool destinationLocal=LocalAddresses.Contains(dst.ToString());
        bool localIsSource=sourceLocal&&!destinationLocal ? true : destinationLocal&&!sourceLocal ? false : protocol=="TCP" || send;
        var local=localIsSource?src:dst; var remote=localIsSource?dst:src;
        if(IPAddress.IsLoopback(local)||IPAddress.IsLoopback(remote)) return;
        var localPort=localIsSource?sport:dport; var remotePort=localIsSource?dport:sport;
        var key=$"{pid}|{local}|{localPort}|{remote}|{remotePort}|{protocol}";
        lock(Gate) {
            if(!Pending.TryGetValue(key,out var f)) {
                if(Pending.Count>=50000) return;
                Pending[key]=f=new Flow(pid,local.ToString(),localPort,remote.ToString(),remotePort,protocol,Route(remote));
            }
            if(send) f.up+=size; else f.down+=size;
        }
    }
    static object[] Interfaces() => NetworkInterface.GetAllNetworkInterfaces().Select(n => {
        var p=n.GetIPProperties(); var s=n.GetIPv4Statistics();
        var virtualName=System.Text.RegularExpressions.Regex.IsMatch(n.Description+" "+n.Name,"virtual|vmware|hyper-v|wsl|wintun|mihomo|loopback|bluetooth|tap-|vpn|tailscale",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        int index=-1; try {index=p.GetIPv4Properties()?.Index??-1;} catch {}
        if(index<0) return null!;
        return (object)new {name=n.Name, description=n.Description, index, up=s.BytesSent, down=s.BytesReceived,
            physical=!virtualName && (n.NetworkInterfaceType==NetworkInterfaceType.Wireless80211 || n.NetworkInterfaceType==NetworkInterfaceType.Ethernet),
            online=n.OperationalStatus==OperationalStatus.Up, addresses=p.UnicastAddresses.Select(x=>x.Address.ToString()).ToArray()};
    }).OfType<object>().ToArray();
    static object[] Processes() {
        var rows=new List<object>();
        using var query=new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate FROM Win32_Process");
        foreach(ManagementObject p in query.Get()) {
            string? created=null; try {created=ManagementDateTimeConverter.ToDateTime((string)p["CreationDate"]).ToUniversalTime().ToString("O");} catch {}
            rows.Add(new {pid=Convert.ToInt32(p["ProcessId"]),parentPid=Convert.ToInt32(p["ParentProcessId"]),name=p["Name"]?.ToString(),path=p["ExecutablePath"]?.ToString(),started=created});
        }
        return rows.ToArray();
    }
    static object[] Sockets() {
        var list=new List<object>();
        foreach(var family in new[]{2,23}) foreach(var tcp in new[]{true,false}) {
            int size=0; if(tcp) GetExtendedTcpTable(IntPtr.Zero,ref size,false,family,5,0); else GetExtendedUdpTable(IntPtr.Zero,ref size,false,family,1,0);
            if(size<=0||size>20000000)continue;
            var ptr=Marshal.AllocHGlobal(size);
            try {
                uint status=tcp?GetExtendedTcpTable(ptr,ref size,false,family,5,0):GetExtendedUdpTable(ptr,ref size,false,family,1,0);
                if(status!=0)continue; int count=Marshal.ReadInt32(ptr);int stride=tcp?(family==2?24:56):(family==2?12:28);
                for(int i=0;i<count && 4+(i+1)*stride<=size;i++) {
                    var row=IntPtr.Add(ptr,4+i*stride);int portOffset=tcp?(family==2?8:20):(family==2?4:20);
                    int port=(Marshal.ReadByte(row,portOffset)<<8)|Marshal.ReadByte(row,portOffset+1);
                    int pid=Marshal.ReadInt32(row,stride-4); if(pid<=0)continue;
                    list.Add(new {pid,localPort=port,protocol=tcp?"TCP":"UDP"});
                }
            }finally {Marshal.FreeHGlobal(ptr);}
        }
        return list.Distinct().ToArray();
    }
    static void StartTrace() {
        Session=new TraceEventSession("NetScope-Network-"+Process.GetCurrentProcess().SessionId);
        Session.StopOnDispose=true;
        Session.EnableKernelProvider(KernelTraceEventParser.Keywords.NetworkTCPIP);
        var k=Session.Source.Kernel;
        k.TcpIpSend += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,true,"TCP");
        k.TcpIpRecv += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,false,"TCP");
        k.TcpIpSendIPV6 += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,true,"TCP");
        k.TcpIpRecvIPV6 += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,false,"TCP");
        k.UdpIpSend += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,true,"UDP");
        k.UdpIpRecv += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,false,"UDP");
        k.UdpIpSendIPV6 += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,true,"UDP");
        k.UdpIpRecvIPV6 += e=>Capture(e.ProcessID,e.size,e.saddr,e.sport,e.daddr,e.dport,false,"UDP");
        Task.Run(()=> {try { Session.Source.Process(); } catch(Exception e) {Emit(new {type="error",message=e.Message});} });
    }
    static int Main(string[] args) {
        var pipeArg=Array.IndexOf(args,"--pipe");
        NamedPipeClientStream? pipe=null;
        if(pipeArg>=0) {
            try {pipe=new NamedPipeClientStream(".",args[pipeArg+1],PipeDirection.Out);pipe.Connect(10000);Console.SetOut(new StreamWriter(pipe){AutoFlush=true});}
            catch{return 2;}
        }
        bool etw=args.Contains("--etw");
        var stop=Array.IndexOf(args,"--stop-file"); if(stop>=0) StopPath=args[stop+1];
        var limit=Array.IndexOf(args,"--seconds"); var seconds=limit>=0?int.Parse(args[limit+1]):0;
        var elevated=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        if(etw&&!elevated) { Emit(new {type="error",code="ADMIN_REQUIRED",message="System network events require administrator permission."});return 5;}
        using var mutex=new Mutex(true,"Local\\NetScope-Sensor-"+(etw?"ETW":"INFO"),out bool acquired);
        if(!acquired) return 0;
        Console.CancelKeyPress+=(s,e)=> { e.Cancel=true;Quit=true; };
        try {
            if(etw) StartTrace();
            Emit(new {type="ready",etw,elevated,pid=Environment.ProcessId,instance=Instance});
            long start=Environment.TickCount64, lastProcesses=0;
            while(!Quit && (StopPath=="" || !File.Exists(StopPath)) && (seconds==0 || Environment.TickCount64-start<seconds*1000)) {
                var now=Environment.TickCount64;
                if(etw) {
                    if(now-lastProcesses>10000) {
                        LocalAddresses=NetworkInterface.GetAllNetworkInterfaces().SelectMany(n=>n.GetIPProperties().UnicastAddresses).Select(a=>a.Address.ToString()).ToHashSet();
                        lastProcesses=now;
                    }
                    Flow[] flows;lock(Gate) {flows=Pending.Values.ToArray();Pending.Clear();}
                    Emit(new {type="network",instance=Instance,sequence=++Sequence,time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),lost=Session?.Source.EventsLost??0,flows});
                } else {
                    Emit(new {type="interfaces",time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),interfaces=Interfaces()});
                    Emit(new {type="sockets",time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),sockets=Sockets()});
                    if(now-lastProcesses>10000) { Emit(new {type="processes",time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),processes=Processes()});lastProcesses=now; }
                }
                Thread.Sleep(1000);
            }
            return 0;
        } catch(IOException) {return 2;}
        catch(Exception e) {try {Emit(new {type="error",message=e.Message});} catch{} return 1;}
        finally {Session?.Dispose();pipe?.Dispose();}
    }
}
