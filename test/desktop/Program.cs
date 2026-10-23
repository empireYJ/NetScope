using System.Drawing.Imaging;
using System.Text.Json;

static class Program {
    [STAThread] static int Main(string[] args) {
        ApplicationConfiguration.Initialize();
        string output = Path.GetFullPath(args.FirstOrDefault() ?? "qa-output/tray-menu");
        Directory.CreateDirectory(output);
        var cases = new List<object>();
        try {
            foreach (float scale in new[] { 1F, 1.25F, 1.5F, 2F }) {
                using var font = new Font("Microsoft YaHei UI", 9F * scale);
                using var menu = new TrayMenu { Font = font };
                int clicks = 0;
                foreach (string label in new[] { "打开墨流", "暂停采集", "恢复采集", "设置", "打开数据文件夹" })
                    menu.Items.Add(label, null, (_, _) => clicks++);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("退出并停止采集", null, (_, _) => clicks++);
                menu.Show(new Point(40, 40));
                Application.DoEvents();

                foreach (int selected in new[] { -1, 0, 6 }) {
                    if (selected >= 0) menu.Items[selected].Select();
                    var textBounds = new Dictionary<string, object>();
                    ToolStripItemTextRenderEventHandler inspect = (_, e) => {
                        if (string.IsNullOrEmpty(e.Text)) return;
                        var required = TextRenderer.MeasureText(e.Graphics, e.Text, e.TextFont,
                            Size.Empty, e.TextFormat | TextFormatFlags.NoPadding);
                        if (e.TextRectangle.Width < required.Width || e.TextRectangle.Height < required.Height)
                            throw new Exception($"Clipped text at {scale}: {e.Text} ({e.TextRectangle.Size} < {required})");
                        textBounds[e.Text ?? ""] = new { text = e.Text, width = e.TextRectangle.Width, height = e.TextRectangle.Height };
                    };
                    menu.Renderer.RenderItemText += inspect;
                    using var bitmap = new Bitmap(menu.Width, menu.Height);
                    menu.DrawToBitmap(bitmap, new Rectangle(Point.Empty, menu.Size));
                    menu.Renderer.RenderItemText -= inspect;
                    if (textBounds.Count != 6) {
                        bitmap.Save(Path.Combine(output, "failed-render.png"), ImageFormat.Png);
                        throw new Exception($"Expected six menu labels, painted {textBounds.Count}; popup {menu.Size}, visible={menu.Visible}, items={string.Join(';', menu.Items.Cast<ToolStripItem>().Select(x => $"{x.Text}:{x.Bounds}:{x.Available}"))}");
                    }
                    if (selected >= 0 && !menu.Items[selected].Selected) throw new Exception("Selection was not rendered");
                    foreach (ToolStripItem item in menu.Items) {
                        if (!menu.ClientRectangle.Contains(item.Bounds)) throw new Exception("Menu item exceeds popup bounds");
                    }
                    // The previous default image gutter was white even on dark menus.
                    for (int y = 2; y < bitmap.Height - 2; y++) {
                        var pixel = bitmap.GetPixel(2, y);
                        if (pixel.R > 100 || pixel.G > 120 || pixel.B > 100)
                            throw new Exception($"Light gutter/border at y={y}: {pixel}");
                    }
                    string state = selected < 0 ? "normal" : selected == 0 ? "first-selected" : "last-selected";
                    string name = $"font-{scale * 100:0}-{state}.png";
                    bitmap.Save(Path.Combine(output, name), ImageFormat.Png);
                    cases.Add(new { textScale = scale, state, width = menu.Width, height = menu.Height, screenshot = name, textBounds });
                }
                foreach (ToolStripItem item in menu.Items) if (item is ToolStripMenuItem) item.PerformClick();
                if (clicks != 6) throw new Exception("A menu command did not dispatch exactly once");
            }
            File.WriteAllText(Path.Combine(output, "report.json"), JsonSerializer.Serialize(new {
                ok = true, checks = cases.Count, cases,
                coverage = "Native menu painting, selection, full label bounds, dark gutter and command dispatch at 100/125/150/200 percent font sizes; not a multi-monitor DPI hardware test"
            }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"PASS: {cases.Count} native tray renders; six commands dispatch at all four font sizes.");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
