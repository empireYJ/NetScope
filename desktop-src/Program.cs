using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program {
    [STAThread] static void Main(string[] args) {
        ApplicationConfiguration.Initialize();
        using var mutex=new Mutex(true,DesktopIdentity.MutexName,out bool first);
        if(!first) {
            if(!args.Contains("--background")) try {using var pipe=new NamedPipeClientStream(".",DesktopIdentity.ControlPipe,PipeDirection.Out);pipe.Connect(1500);using var writer=new StreamWriter(pipe){AutoFlush=true};writer.WriteLine(args.Contains("--verify-chrome")?"verify-chrome":args.Contains("--verify-ui")?"verify":args.Contains("--hide")?"hide":"show");}catch{}
            return;
        }
        Application.Run(new MainWindow(args.Contains("--background")||args.Contains("--hide"),args.Contains("--verify-ui"),args.Contains("--verify-chrome")));
    }
}
class MainWindow:BorderlessWindow {
    readonly string root=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,".."));
    readonly HttpClient client=new(new HttpClientHandler{UseProxy=false}){Timeout=TimeSpan.FromSeconds(4)};
    readonly NotifyIcon tray=new();
    readonly System.Windows.Forms.Timer timer=new(){Interval=5000};
    WebView2? view; bool exiting,busy,initialBackground,loaded,ready,verifyUI,verifyChrome;
    string address="http://127.0.0.1:47831",lastStatusIssue="";
    string Data=>Path.Combine(root,"data");
    readonly Label loading=new(){Dock=DockStyle.Fill,Text="墨流 NETSCOPE\n\n正在连接本机流量账本…",ForeColor=Color.FromArgb(177,248,106),BackColor=Color.FromArgb(8,12,10),Font=new Font("Microsoft YaHei UI",16),TextAlign=ContentAlignment.MiddleCenter};
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd,int attr,ref int value,int size);
    public MainWindow(bool background,bool verify,bool chrome) {
        verifyUI=verify;
        verifyChrome=chrome;
        initialBackground=background;Text="墨流 NetScope · 网络观测台";StartPosition=FormStartPosition.CenterScreen;Size=new Size(1440,1000);MinimumSize=new Size(520,640);BackColor=Color.FromArgb(8,12,10);
        Directory.CreateDirectory(Data);try{File.Delete(Path.Combine(Data,"desktop-stop.flag"));}catch{}
        try{using var cfg=JsonDocument.Parse(File.ReadAllText(Path.Combine(Data,"settings.json")));address="http://127.0.0.1:"+cfg.RootElement.GetProperty("port").GetInt32();}catch{}
        var ico=Path.Combine(root,"public","app.ico");if(File.Exists(ico))Icon=new Icon(ico);
        ContentHost.Controls.Add(loading);
        var menu=new ContextMenuStrip {BackColor=Color.FromArgb(18,29,19),ForeColor=Color.FromArgb(217,237,203)};
        menu.Items.Add("打开墨流",null,async(_,_)=>await ShowWindow());
        menu.Items.Add("暂停采集",null,async(_,_)=>await Control("pause"));
        menu.Items.Add("恢复采集",null,async(_,_)=>await Control("resume"));
        menu.Items.Add("设置",null,async(_,_)=>{await ShowWindow();view?.CoreWebView2?.Navigate(address+"/#settings");});
        menu.Items.Add("打开数据文件夹",null,(_,_)=>Process.Start(new ProcessStartInfo("explorer.exe",Data){UseShellExecute=true}));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出并停止采集",null,async(_,_)=>await ExitApplication());
        tray.Text="墨流 NetScope · 后台流量采集";tray.Icon=Icon;tray.ContextMenuStrip=menu;tray.Visible=true;
        tray.DoubleClick+=async(_,_)=>await ShowWindow();
        tray.BalloonTipClicked+=async(_,_)=>await ShowWindow();
        timer.Tick+=async(_,_)=>await Tick();
        Shown+=async(_,_)=>{await Tick();if(!initialBackground)await LoadView();};
        Load+=(_,_)=>{int dark=1;DwmSetWindowAttribute(Handle,20,ref dark,4);int rectangular=1;DwmSetWindowAttribute(Handle,33,ref rectangular,4);};
        FormClosing+=(_,e)=>{if(!exiting&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;BeginInvoke(new Action(async()=>await ExitApplication()));}else{exiting=true;timer.Stop();tray.Visible=false;view?.Dispose();tray.Dispose();}};
        _=Listen();timer.Start();
    }
    protected override void SetVisibleCore(bool value) {if(initialBackground&&!IsHandleCreated){CreateHandle();value=false;_ = Tick();}base.SetVisibleCore(value);}
    protected override void OnBackgroundRequested(){Hide();if(view!=null)view.Visible=false;}
    protected override async void OnTitleInteraction(){try{if(view?.CoreWebView2!=null)await view.CoreWebView2.ExecuteScriptAsync("window.getSelection()?.removeAllRanges()");}catch{}}
    protected override async void OnCloseRequested()=>await ExitApplication();
    async Task ExitApplication(){if(exiting)return;exiting=true;timer.Stop();if(await Control("stop")){Close();return;}exiting=false;timer.Start();tray.ShowBalloonTip(5000,"墨流 NetScope","暂时无法停止本机采集，窗口已保留，请稍后重试关闭。",ToolTipIcon.Warning);}
    async Task Listen() {
        while(!exiting)try{await using var pipe=new NamedPipeServerStream(DesktopIdentity.ControlPipe,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous);await pipe.WaitForConnectionAsync();using var reader=new StreamReader(pipe);var command=await reader.ReadLineAsync();BeginInvoke(new Action(async()=>{try{if(command=="hide")OnBackgroundRequested();else if(command=="show"||command=="verify"||command=="verify-chrome"){await ShowWindow();if(command=="verify")await CaptureUI();if(command=="verify-chrome")await VerifyChrome();}}catch(Exception e){Log("desktop-control",e.Message);}}));}catch{if(!exiting)await Task.Delay(1000);}
    }
    async Task<JsonElement?> Status() {try{var text=await client.GetStringAsync(address+"/api/v1/status");using var doc=JsonDocument.Parse(text);lastStatusIssue="";return doc.RootElement.GetProperty("app").GetString()=="NetScope"?doc.RootElement.Clone():null;}catch(Exception e){var issue=e.GetBaseException().Message;if(issue!=lastStatusIssue){Log("status-connection",issue);lastStatusIssue=issue;}return null;}}
    async Task<bool> EnsureBackend() {
        if(await Status()!=null)return true;
        // A slow status response does not mean the process has exited. Never
        // launch a second backend against a port that is still listening.
        try {using var probe=new TcpClient();using var timeout=new CancellationTokenSource(700);var uri=new Uri(address);await probe.ConnectAsync(uri.Host,uri.Port,timeout.Token);return false;}catch{}
        // Some local networking stacks reject individual fresh sockets. A live
        // process from our own startup descriptor must not be duplicated either.
        try {using var descriptor=JsonDocument.Parse(File.ReadAllText(Path.Combine(Data,"server.json")));int pid=descriptor.RootElement.GetProperty("pid").GetInt32();var running=Process.GetProcessById(pid);var started=descriptor.RootElement.GetProperty("startedAt").GetDateTimeOffset();if(!running.HasExited&&string.Equals(running.ProcessName,"node",StringComparison.OrdinalIgnoreCase)&&Math.Abs((running.StartTime.ToUniversalTime()-started.UtcDateTime).TotalSeconds)<10)return false;}catch{}
        var node=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe");
        var start=new ProcessStartInfo(File.Exists(node)?node:"node.exe"){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root,RedirectStandardError=true,RedirectStandardOutput=true};
        start.ArgumentList.Add("--disable-warning=ExperimentalWarning");start.ArgumentList.Add(Path.Combine(root,"server.mjs"));
        var child=Process.Start(start);
        if(child!=null){child.OutputDataReceived+=(_,e)=>{if(e.Data!=null)Log("backend",e.Data);};child.ErrorDataReceived+=(_,e)=>{if(e.Data!=null)Log("backend-error",e.Data);};child.BeginOutputReadLine();child.BeginErrorReadLine();}
        for(int i=0;i<30;i++){if(await Status()!=null)return true;await Task.Delay(200);}return false;
    }
    void Log(string kind,string text) {try{var file=Path.Combine(Data,"desktop.log");if(File.Exists(file)&&new FileInfo(file).Length>200000)File.WriteAllText(file,"");File.AppendAllText(file,DateTimeOffset.UtcNow.ToString("O")+" "+kind+" "+text+Environment.NewLine);}catch{}}
    async Task Tick() {
        if(busy||exiting)return;busy=true;
        try {
            if(File.Exists(Path.Combine(Data,"desktop-stop.flag"))){exiting=true;Close();return;}
            bool wasReady=ready;ready=await EnsureBackend();
            if(ready) {
                var s=await Status();bool paused=s?.GetProperty("paused").GetBoolean()??false;
                tray.Text=paused?"墨流 NetScope · 采集已暂停":"墨流 NetScope · 正在记录流量";
                if(s.HasValue)NotifyUsage(s.Value);
                if(!wasReady&&view?.CoreWebView2!=null)view.CoreWebView2.Reload();
                if(!wasReady&&Visible)await LoadView();
            } else {tray.Text="墨流 NetScope · 本机服务连接中";loading.Text="本机采集服务暂未连接\n\n程序会自动重试。诊断见 data / desktop.log";}
        }catch(Exception e){Log("desktop-error",e.Message);loading.Text="暂时无法连接\n"+e.Message;}finally{busy=false;}
    }
    void NotifyUsage(JsonElement status) {
        if(!status.TryGetProperty("alert",out var alert)||alert.ValueKind!=JsonValueKind.Object||!status.GetProperty("settings").GetProperty("alertEnabled").GetBoolean()||status.GetProperty("paused").GetBoolean())return;
        if(alert.TryGetProperty("belowThreshold",out var below)&&below.ValueKind==JsonValueKind.True)return;
        long id=alert.GetProperty("id").GetInt64();var file=Path.Combine(Data,"desktop-alert-id");
        if(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-id>300000||File.Exists(file)&&File.ReadAllText(file).Trim()==id.ToString())return;
        var gb=alert.GetProperty("totalBytes").GetDouble()/1e9;var top=alert.GetProperty("topProgram").GetString();
        var title=alert.TryGetProperty("title",out var titleValue)?titleValue.GetString():"VPN 流量提醒";
        var message=alert.TryGetProperty("message",out var messageValue)?messageValue.GetString():$"最近一小时已记录 {gb:F2} GB，最多来自 {top}。联网任务继续运行。";
        tray.ShowBalloonTip(10000,title??"墨流流量提醒",message??"已触发本机流量提醒，联网任务继续运行。",ToolTipIcon.Warning);
        File.WriteAllText(file,id.ToString());Log("traffic-alert",id.ToString());
    }
    async Task<bool> Control(string action) {
        try {
            if(!ready)await EnsureBackend();
            using var req=new HttpRequestMessage(HttpMethod.Post,address+"/api/v1/control");req.Headers.Add("X-NetScope-Key",File.ReadAllText(Path.Combine(Data,"api-token")).Trim());req.Content=new StringContent(JsonSerializer.Serialize(new{action}),Encoding.UTF8,"application/json");
            using var response=await client.SendAsync(req);response.EnsureSuccessStatusCode();return true;
        }catch(Exception e){Log("control-error",e.Message);if(!exiting)tray.ShowBalloonTip(5000,"墨流 NetScope","操作暂未完成，请稍后重试。",ToolTipIcon.Warning);return false;}
    }
    async Task CaptureUI() {
        if(view?.CoreWebView2==null){verifyUI=true;return;}
        await Task.Delay(2500);
        var folder=Path.Combine(root,"qa-output");Directory.CreateDirectory(folder);
        var dom=await view.CoreWebView2.ExecuteScriptAsync("JSON.stringify({title:document.title,rankings:document.querySelector('#rankings')?.innerText,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth})");
        File.WriteAllText(Path.Combine(folder,"desktop-ui.json"),JsonSerializer.Serialize(new{time=DateTimeOffset.UtcNow,visible=Visible,handle=Handle.ToInt64(),chrome=ChromeState(),dom=JsonSerializer.Deserialize<string>(dom)}));
        CaptureTitleBar(Path.Combine(folder,"desktop-titlebar.png"));
        using var file=File.Create(Path.Combine(folder,"desktop-webview.png"));await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,file);
    }
    async Task ShowWindow() {initialBackground=false;Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();if(view!=null)view.Visible=true;await Tick();await LoadView();}
    async Task VerifyChrome() {
        await Task.Delay(600);if(WindowState==FormWindowState.Maximized)MaximizeButton.PerformClick();
        var titleInput=VerifyTitleClicks();
        var initial=Bounds;var normal=ChromeState();MaximizeButton.PerformClick();await Task.Delay(250);
        bool maximized=WindowState==FormWindowState.Maximized;var maximizedBounds=Bounds;var work=Screen.FromHandle(Handle).WorkingArea;
        BackgroundButton.PerformClick();bool background=!Visible;await ShowWindow();bool restoredFromTray=Visible&&WindowState==FormWindowState.Maximized;
        MaximizeButton.PerformClick();await Task.Delay(250);bool restored=WindowState==FormWindowState.Normal&&Bounds==initial;
        bool hitTests=ResizeHitTest(new Point(1,1),new Size(100,100),6)==13&&ResizeHitTest(new Point(99,99),new Size(100,100),6)==17&&ResizeHitTest(new Point(50,50),new Size(100,100),6)==1;
        var folder=Path.Combine(root,"qa-output");Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder,"desktop-chrome.json"),JsonSerializer.Serialize(new{time=DateTimeOffset.UtcNow,titleInput,normal,maximized,maximizedBounds,workArea=work,background,restoredFromTray,restored,resizeHitTests=hitTests,closeButtonEnabled=CloseButton.Enabled,closeAction="ExitApplication: stop recording then exit; action not exercised by this non-destructive verification",backend=await Status()}));
        await CaptureUI();
    }
    async Task LoadView() {
        if(loaded||!ready)return;loaded=true;
        try {
            view=new WebView2 {Dock=DockStyle.Fill,DefaultBackgroundColor=Color.FromArgb(8,12,10)};
            ContentHost.Controls.Add(view);view.BringToFront();
            var options=new CoreWebView2EnvironmentOptions("--disable-background-networking --disable-component-update --disable-sync");
            var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Data,"webview-profile"),options);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.Settings.IsStatusBarEnabled=false;view.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
            view.CoreWebView2.Settings.IsZoomControlEnabled=true;
            view.CoreWebView2.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith(address+"/",StringComparison.OrdinalIgnoreCase))e.Cancel=true;};
            view.CoreWebView2.NewWindowRequested+=(_,e)=>{e.Handled=true;};
            view.CoreWebView2.NavigationCompleted+=async(_,e)=>{
                try {var info=new {ready=e.IsSuccess,title=await view.CoreWebView2.ExecuteScriptAsync("document.title"),url=view.Source?.ToString(),time=DateTimeOffset.UtcNow};
                File.WriteAllText(Path.Combine(Data,"desktop-status.json"),JsonSerializer.Serialize(info));
                if(verifyUI){verifyUI=false;await CaptureUI();}}catch(Exception error){Log("webview-navigation",error.Message);}
                if(verifyChrome){verifyChrome=false;try{await VerifyChrome();}catch(Exception error){Log("chrome-verification",error.Message);}}
            };
            view.CoreWebView2.Navigate(address+"/#overview");loading.Hide();
        }catch(Exception e){loaded=false;view?.Dispose();view=null;loading.Show();loading.Text="桌面界面加载失败\n"+e.Message;Log("webview-error",e.Message);}
    }
}
