using System.ComponentModel;

// Keep the entire popup on the same palette. BackColor alone does not theme
// WinForms' image gutter, selection gradients, border, or separators.
sealed class TrayMenu : ContextMenuStrip {
    readonly Font menuFont = new("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

    public TrayMenu() {
        Font = menuFont;
        BackColor = TrayMenuColors.Background;
        ForeColor = TrayMenuColors.Text;
        ShowImageMargin = false;
        ShowCheckMargin = false;
        Renderer = new TrayMenuRenderer();
        ApplySpacing();
    }

    protected override void OnOpening(CancelEventArgs e) {
        // Recalculate from logical pixels each time, so moving between displays
        // cannot accumulate scaling or leave the last row against the border.
        ApplySpacing();
        base.OnOpening(e);
    }

    protected override void OnItemAdded(ToolStripItemEventArgs e) {
        base.OnItemAdded(e);
        ApplyItemSpacing(e.Item);
    }

    int Px(int logical) => (int)Math.Round(logical * DeviceDpi / 96F);

    // ToolStripDropDownMenu reapplies DefaultPadding while measuring its columns.
    protected override Padding DefaultPadding {
        get {
            var padding = base.DefaultPadding;
            return new Padding(padding.Left, Px(6), padding.Right, Px(6));
        }
    }

    void ApplySpacing() {
        Padding = DefaultPadding;
        foreach (ToolStripItem item in Items) ApplyItemSpacing(item);
    }

    void ApplyItemSpacing(ToolStripItem? item) {
        if (item is not ToolStripMenuItem) return;
        item.AutoSize = true;
        // Horizontal spacing belongs to the menu's shared text column. Adding
        // it here makes WinForms widen items without widening the popup itself.
        item.Padding = new Padding(0, Px(6), 0, Px(6));
    }

    protected override void Dispose(bool disposing) {
        base.Dispose(disposing);
        if (disposing) menuFont.Dispose();
    }
}

sealed class TrayMenuRenderer : ToolStripProfessionalRenderer {
    public TrayMenuRenderer() : base(new TrayMenuColors()) { RoundedEdges = false; }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
        e.TextColor = !e.Item.Enabled ? Color.FromArgb(113, 134, 111)
            : e.Item.Selected ? Color.FromArgb(177, 248, 106) : TrayMenuColors.Text;
        base.OnRenderItemText(e);
    }
}

sealed class TrayMenuColors : ProfessionalColorTable {
    public static readonly Color Background = Color.FromArgb(18, 29, 19);
    public static readonly Color Text = Color.FromArgb(217, 237, 203);
    static readonly Color Highlight = Color.FromArgb(37, 57, 32);
    static readonly Color Border = Color.FromArgb(64, 86, 55);

    public TrayMenuColors() { UseSystemColors = false; }
    public override Color ToolStripDropDownBackground => Background;
    public override Color ImageMarginGradientBegin => Background;
    public override Color ImageMarginGradientMiddle => Background;
    public override Color ImageMarginGradientEnd => Background;
    public override Color MenuBorder => Border;
    public override Color MenuItemBorder => Border;
    public override Color MenuItemSelected => Highlight;
    public override Color MenuItemSelectedGradientBegin => Highlight;
    public override Color MenuItemSelectedGradientEnd => Highlight;
    public override Color MenuItemPressedGradientBegin => Highlight;
    public override Color MenuItemPressedGradientMiddle => Highlight;
    public override Color MenuItemPressedGradientEnd => Highlight;
    public override Color SeparatorDark => Border;
    public override Color SeparatorLight => Background;
}
