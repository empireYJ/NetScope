using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

// Keep window controls native so they remain usable while the local page loads.
class BorderlessWindow : Form {
    protected readonly Panel ContentHost=new(){Dock=DockStyle.Fill,Margin=Padding.Empty,BackColor=Color.FromArgb(8,12,10)};
    readonly TableLayoutPanel layout=new(){Dock=DockStyle.Fill,RowCount=2,ColumnCount=1,Margin=Padding.Empty,Padding=Padding.Empty,BackColor=Color.FromArgb(8,12,10)};
    readonly TableLayoutPanel titleBar=new(){Dock=DockStyle.Fill,RowCount=1,ColumnCount=2,Margin=Padding.Empty,Padding=Padding.Empty,BackColor=Color.FromArgb(8,12,10)};
    readonly ToolTip hints=new(){ShowAlways=true};
    protected readonly CaptionButton BackgroundButton=new(CaptionAction.Background);
    protected readonly CaptionButton MaximizeButton=new(CaptionAction.Maximize);
    protected readonly CaptionButton CloseButton=new(CaptionAction.Close);
    Point? dragOrigin;int systemDragStarts,nonClientPaintsBlocked,activationPaintsBlocked;
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr handle,int index);
    [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong32(IntPtr handle,int index);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr handle,int message,IntPtr wParam,IntPtr lParam);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr handle,int attribute,ref int value,int size);

    protected BorderlessWindow() {
        FormBorderStyle=FormBorderStyle.None;AutoScaleMode=AutoScaleMode.Dpi;
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute,40));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        titleBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));titleBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,144));
        titleBar.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        var title=new Label{Text="墨流  /  NETSCOPE",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,Padding=new Padding(17,0,0,0),Margin=Padding.Empty,ForeColor=Color.FromArgb(166,210,137),Font=new Font("Microsoft YaHei UI",9,FontStyle.Regular),AutoEllipsis=true};
        var controls=new TableLayoutPanel{Dock=DockStyle.Fill,RowCount=1,ColumnCount=3,Margin=Padding.Empty,Padding=Padding.Empty};
        controls.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        for(int i=0;i<3;i++)controls.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100f/3));
        controls.Controls.Add(BackgroundButton,0,0);controls.Controls.Add(MaximizeButton,1,0);controls.Controls.Add(CloseButton,2,0);
        titleBar.Controls.Add(title,0,0);titleBar.Controls.Add(controls,1,0);
        layout.Controls.Add(titleBar,0,0);layout.Controls.Add(ContentHost,0,1);Controls.Add(layout);
        BackgroundButton.AccessibleName="后台运行";MaximizeButton.AccessibleName="最大化";CloseButton.AccessibleName="关闭并停止采集";
        hints.SetToolTip(BackgroundButton,"后台运行 · 收起到托盘，继续采集");hints.SetToolTip(MaximizeButton,"最大化 / 还原");hints.SetToolTip(CloseButton,"关闭墨流并停止采集");
        BackgroundButton.Click+=(_,_)=>OnBackgroundRequested();MaximizeButton.Click+=(_,_)=>ToggleMaximize();CloseButton.Click+=(_,_)=>OnCloseRequested();
        foreach(Control surface in new Control[]{title,titleBar}) {
            surface.MouseDown+=TitleDown;surface.MouseMove+=TitleMove;surface.MouseUp+=TitleUp;
            surface.MouseCaptureChanged+=(_,_)=>{if(!surface.Capture)dragOrigin=null;};
        }
        Resize+=(_,_)=>{MaximizeButton.Restore=WindowState==FormWindowState.Maximized;MaximizeButton.AccessibleName=MaximizeButton.Restore?"还原窗口":"最大化";MaximizeButton.Invalidate();};
        HandleCreated+=(_,_)=>{int disabled=1;DwmSetWindowAttribute(Handle,2,ref disabled,4);int noBorder=unchecked((int)0xFFFFFFFE);DwmSetWindowAttribute(Handle,34,ref noBorder,4);int square=1;DwmSetWindowAttribute(Handle,33,ref square,4);};
    }
    protected virtual void OnBackgroundRequested()=>Hide();
    protected virtual void OnCloseRequested()=>Close();
    protected virtual void OnTitleInteraction(){}
    protected void ToggleMaximize() {if(WindowState==FormWindowState.Maximized)WindowState=FormWindowState.Normal;else{MaximizedBounds=Screen.FromHandle(Handle).WorkingArea;WindowState=FormWindowState.Maximized;}}
    void TitleDown(object? sender,MouseEventArgs e) {
        if(e.Button!=MouseButtons.Left)return;
        dragOrigin=null;OnTitleInteraction();
        if(e.Clicks==2){ToggleMaximize();return;}
        if(sender is Control surface){dragOrigin=surface.PointToScreen(e.Location);surface.Capture=true;}
    }
    void TitleMove(object? sender,MouseEventArgs e) {
        if(e.Button!=MouseButtons.Left||dragOrigin is not Point origin||sender is not Control surface)return;
        var screen=surface.PointToScreen(e.Location);var threshold=SystemInformation.DragSize;
        if(Math.Abs(screen.X-origin.X)<threshold.Width/2&&Math.Abs(screen.Y-origin.Y)<threshold.Height/2)return;
        dragOrigin=null;ReleaseCapture();systemDragStarts++;
        // Only a real drag enters the native move loop. Use signed screen
        // coordinates so monitors to the left/above the primary also work.
        long packed=unchecked((ushort)screen.X)|((long)unchecked((ushort)screen.Y)<<16);
        SendMessage(Handle,0xA1,(IntPtr)2,(IntPtr)packed);
    }
    void TitleUp(object? sender,MouseEventArgs e) {
        dragOrigin=null;if(sender is Control surface)surface.Capture=false;
    }
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.Style=(p.Style&~0x00C00000)|0x00040000|0x00020000|0x00010000|0x00080000;return p;}}
    [StructLayout(LayoutKind.Sequential)] struct NativePoint {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct MinMaxInfo {public NativePoint Reserved,MaxSize,MaxPosition,MinTrackSize,MaxTrackSize;}
    protected override void WndProc(ref Message m) {
        if(m.Msg==0x83){m.Result=IntPtr.Zero;return;}
        // Default processing paints a classic caption when the custom title
        // region activates or starts moving, despite having no visible frame.
        if(m.Msg==0x85){nonClientPaintsBlocked++;m.Result=IntPtr.Zero;return;}
        if(m.Msg==0x86&&WindowState!=FormWindowState.Minimized){activationPaintsBlocked++;m.Result=(IntPtr)1;return;}
        if(m.Msg==0x24) {
            base.WndProc(ref m);var info=Marshal.PtrToStructure<MinMaxInfo>(m.LParam);var screen=Screen.FromHandle(Handle);
            info.MaxPosition=new(){X=screen.WorkingArea.Left-screen.Bounds.Left,Y=screen.WorkingArea.Top-screen.Bounds.Top};
            info.MaxSize=new(){X=screen.WorkingArea.Width,Y=screen.WorkingArea.Height};
            info.MinTrackSize=new(){X=MinimumSize.Width,Y=MinimumSize.Height};Marshal.StructureToPtr(info,m.LParam,false);return;
        }
        if(m.Msg==0x84&&WindowState==FormWindowState.Normal) {
            long raw=m.LParam.ToInt64();var p=PointToClient(new Point(unchecked((short)raw),unchecked((short)(raw>>16))));
            int hit=ResizeHitTest(p,ClientSize,Math.Max(5,DeviceDpi*6/96));
            if(hit!=1){m.Result=(IntPtr)hit;return;}
        }
        base.WndProc(ref m);
    }
    internal static int ResizeHitTest(Point p,Size size,int edge) {
        bool left=p.X<edge,right=p.X>=size.Width-edge,top=p.Y<edge,bottom=p.Y>=size.Height-edge;
        if(top&&left)return 13;if(top&&right)return 14;if(bottom&&left)return 16;if(bottom&&right)return 17;
        return left?10:right?11:top?12:bottom?15:1;
    }
    protected object ChromeState()=>new{borderless=FormBorderStyle==FormBorderStyle.None,nativeCaptionPresent=HasNativeCaption(),nonClientPaintsBlocked,activationPaintsBlocked,systemDragStarts,windowState=WindowState.ToString(),visible=Visible,titleBarHeight=titleBar.Height,contentTop=ContentHost.Top,bounds=new{Left,Top,Width,Height},workArea=Screen.FromHandle(Handle).WorkingArea,buttons=new[]{new{name=BackgroundButton.AccessibleName,enabled=BackgroundButton.Enabled,visible=BackgroundButton.Visible,bounds=BackgroundButton.Bounds},new{name=MaximizeButton.AccessibleName,enabled=MaximizeButton.Enabled,visible=MaximizeButton.Visible,bounds=MaximizeButton.Bounds},new{name=CloseButton.AccessibleName,enabled=CloseButton.Enabled,visible=CloseButton.Visible,bounds=CloseButton.Bounds}}};
    bool HasNativeCaption()=>((IntPtr.Size==8?GetWindowLongPtr64(Handle,-16).ToInt64():GetWindowLong32(Handle,-16))&0x00C00000)!=0;
    protected object VerifyTitleClicks() {
        var initial=Bounds;int dragsBefore=systemDragStarts;
        for(int i=0;i<5;i++) {
            TitleDown(titleBar,new MouseEventArgs(MouseButtons.Left,1,100,20,0));
            TitleMove(titleBar,new MouseEventArgs(MouseButtons.Left,0,101,20,0));
            TitleUp(titleBar,new MouseEventArgs(MouseButtons.Left,1,101,20,0));
            SendMessage(Handle,0x86,IntPtr.Zero,IntPtr.Zero);SendMessage(Handle,0x86,(IntPtr)1,IntPtr.Zero);SendMessage(Handle,0x85,(IntPtr)1,IntPtr.Zero);
        }
        bool clickDoesNotMove=Bounds==initial&&systemDragStarts==dragsBefore;
        TitleDown(titleBar,new MouseEventArgs(MouseButtons.Left,2,100,20,0));bool doubleClickMaximizes=WindowState==FormWindowState.Maximized;
        TitleDown(titleBar,new MouseEventArgs(MouseButtons.Left,2,100,20,0));bool doubleClickRestores=WindowState==FormWindowState.Normal&&Bounds==initial;
        return new{clickDoesNotMove,doubleClickMaximizes,doubleClickRestores,nativeCaptionAbsent=!HasNativeCaption(),nonClientPaintingIntercepted=nonClientPaintsBlocked>=5&&activationPaintsBlocked>=10};
    }
    protected void CaptureTitleBar(string path) {using var bitmap=new Bitmap(titleBar.Width,titleBar.Height);titleBar.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);}
    protected override void Dispose(bool disposing) {if(disposing)hints.Dispose();base.Dispose(disposing);}
}

enum CaptionAction {Background,Maximize,Close}
sealed class CaptionButton : Button {
    readonly CaptionAction action;bool hover;
    internal bool Restore;
    internal CaptionButton(CaptionAction action) {
        this.action=action;Dock=DockStyle.Fill;Margin=Padding.Empty;Padding=Padding.Empty;TabStop=true;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;AccessibleRole=AccessibleRole.PushButton;
        SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
    }
    protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
    protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
    protected override void OnPaint(PaintEventArgs e) {
        var g=e.Graphics;g.Clear(hover?(action==CaptionAction.Close?Color.FromArgb(170,58,55):Color.FromArgb(28,44,31)):Color.FromArgb(8,12,10));
        g.SmoothingMode=SmoothingMode.AntiAlias;float s=DeviceDpi/96f,cx=Width/2f,cy=Height/2f;
        using var pen=new Pen(hover?Color.White:Color.FromArgb(170,192,170),1.2f*s);
        if(action==CaptionAction.Background)g.DrawLine(pen,cx-5*s,cy+3*s,cx+5*s,cy+3*s);
        else if(action==CaptionAction.Close){g.DrawLine(pen,cx-4*s,cy-4*s,cx+4*s,cy+4*s);g.DrawLine(pen,cx+4*s,cy-4*s,cx-4*s,cy+4*s);}
        else if(Restore){g.DrawLines(pen,new[]{new PointF(cx-2*s,cy-5*s),new PointF(cx+5*s,cy-5*s),new PointF(cx+5*s,cy+2*s)});g.DrawRectangle(pen,cx-5*s,cy-2*s,7*s,7*s);}
        else g.DrawRectangle(pen,cx-4.5f*s,cy-4.5f*s,9*s,9*s);
        if(Focused&&ShowFocusCues)ControlPaint.DrawFocusRectangle(g,new Rectangle(5,5,Width-10,Height-10),Color.FromArgb(177,248,106),BackColor);
    }
}
