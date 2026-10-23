using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using Windows.Media.Editing;
using Windows.Storage;

namespace PromoVideo;

// Creates the Markdown Viewer promo locally. The app window is drawn from the current
// viewer toolbar and feature layout; Windows Media Foundation writes the silent MP4.
internal static class ViewerPromo
{
    private const int Width = 1920, Height = 1080;
    private const double FadeSeconds = .4;
    private static readonly FontFamily Ui = new("Segoe UI");
    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas");
    private static readonly Brush Ink = Solid(0x1c, 0x1e, 0x23);
    private static readonly Brush Muted = Solid(0x62, 0x70, 0x8a);
    private static readonly Brush Border = Solid(0xcf, 0xd8, 0xe2);
    private static readonly Brush Panel = Solid(0xf5, 0xf7, 0xfa);
    private static readonly Brush Blue = Solid(0x08, 0x77, 0xd1);
    private static readonly Brush Green = Solid(0x17, 0x8a, 0x4a);

    private sealed record Scene(string FileName, string Heading, string Caption, int View, double Seconds);

    [STAThread]
    private static int Main(string[] args)
    {
        var output = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine("docs", "promo.mp4"));
        var ownsWork = args.Length <= 1;
        var work = Path.GetFullPath(args.Length > 1 ? args[1] : Directory.CreateTempSubdirectory("MarkdownViewer-promo-").FullName);
        if (args.Length > 1 && Directory.Exists(work)) throw new IOException("Choose a new, empty work folder; existing folders are never deleted.");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        _ = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };

        var scenes = new[]
        {
            new Scene("welcome", "Your files, clearly in view", "A focused Windows viewer for Markdown, code, tables, and more.", 0, 9),
            new Scene("folders", "A folder view that stays organized", "Browse supported files together, with type filters and a single document sidebar.", 1, 10),
            new Scene("search", "Find the passage you need", "Search across a folder, see matching excerpts, and jump back to the highlighted text.", 2, 10),
            new Scene("compare", "Read and compare with ease", "Open readable source, compare versions, and export or save as PDF.", 3, 10),
            new Scene("html", "Inspect HTML safely", "Read source or use the isolated preview, with scripts disabled.", 4, 10),
            new Scene("private", "Private by design", "Local files stay in the viewer. No network port, no code execution, no online dependencies.", 5, 9),
        };

        var clips = new List<(string Path, double Seconds)>();
        string? previous = null;
        for (var i = 0; i < scenes.Length; i++)
        {
            var scene = scenes[i];
            var path = Path.Combine(work, $"{i:00}-{scene.FileName}.png");
            Save(Render(DrawFrame(scene)), path);
            if (i == 0)
            {
                var poster = Path.Combine(Path.GetDirectoryName(output)!, "promo-poster.png");
                Save(Render(DrawFrame(scene, poster: true)), poster);
            }
            if (previous is not null)
            {
                for (var f = 1; f <= 10; f++)
                {
                    var fade = Path.Combine(work, $"{i:00}-fade-{f:00}.png");
                    Save(Blend(previous, path, f / 11.0), fade);
                    clips.Add((fade, FadeSeconds / 10));
                }
            }
            clips.Add((path, scene.Seconds - (previous is null ? 0 : FadeSeconds)));
            previous = path;
            Console.WriteLine($"{scene.FileName}: {scene.Seconds}s");
        }

        RenderVideo(clips, output).GetAwaiter().GetResult();
        Console.WriteLine($"Created {output} ({new FileInfo(output).Length / 1048576.0:0.0} MB)");
        if (ownsWork && Directory.Exists(work)) Directory.Delete(work, recursive: true);
        return 0;
    }

    private static UIElement DrawFrame(Scene scene, bool poster = false)
    {
        var root = new Grid { Width = Width, Height = Height };
        root.Background = new LinearGradientBrush(Color.FromRgb(0x0d, 0x30, 0x48), Color.FromRgb(0x10, 0x69, 0x78), 25);
        var layout = new Grid { Margin = new Thickness(78, 44, 78, 208) };
        layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var app = new Border
        {
            Background = Brushes.White,
            BorderBrush = Solid(0x9d, 0xb4, 0xc4),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(13),
            Effect = new DropShadowEffect { BlurRadius = 30, ShadowDepth = 10, Opacity = .3, Color = Colors.Black },
            Child = AppWindow(scene.View),
        };
        layout.Children.Add(app);
        var strapline = new StackPanel { Margin = new Thickness(12, 20, 12, 0), HorizontalAlignment = HorizontalAlignment.Center };
        strapline.Children.Add(T(scene.Heading, 42, Brushes.White, FontWeights.SemiBold, center: true));
        strapline.Children.Add(T(scene.Caption, 23, Solid(0xd1, 0xea, 0xf0), center: true));
        Grid.SetRow(strapline, 1);
        layout.Children.Add(strapline);
        root.Children.Add(layout);
        return root;
    }

    private static UIElement AppWindow(int view)
    {
        var root = new Grid { Background = Brushes.White };
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(38) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(54) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(53) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.Children.Add(TitleBar(view));
        var row1 = ToolbarOne(); Grid.SetRow(row1, 1); root.Children.Add(row1);
        var row2 = ToolbarTwo(); Grid.SetRow(row2, 2); root.Children.Add(row2);
        var body = MainBody(view); Grid.SetRow(body, 3); root.Children.Add(body);
        return root;
    }

    private static UIElement TitleBar(int view)
    {
        var title = view == 4 ? "page.html — Markdown Folder Viewer" : view == 3 ? "README.md — Markdown Folder Viewer" : "Markdown Viewer — Markdown Folder Viewer";
        var grid = new Grid { Background = Solid(0xf4, 0xf5, 0xf7) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var left = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(14, 0, 0, 0) };
        left.Children.Add(T("📁", 15, Ink)); left.Children.Add(T("  " + title, 14, Ink));
        grid.Children.Add(left);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 12, 0) };
        foreach (var s in new[] { "—", "□", "×" }) buttons.Children.Add(T("   " + s + "   ", 15, Muted));
        Grid.SetColumn(buttons, 1); grid.Children.Add(buttons);
        return new Border { BorderBrush = Border, BorderThickness = new Thickness(0, 0, 0, 1), Child = grid };
    }

    private static UIElement ToolbarOne()
    {
        var grid = ToolbarGrid();
        var left = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        left.Children.Add(B("☰", false, 40)); left.Children.Add(B("←", false, 40)); left.Children.Add(B("→", false, 40));
        left.Children.Add(T("  📁  Markdown Viewer  ", 23, Ink, FontWeights.Bold));
        left.Children.Add(new Border { Margin = new Thickness(0, 0, 22, 0), Padding = new Thickness(9, 4, 9, 4), Background = Solid(0xe1, 0xf8, 0xe8), BorderBrush = Green, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Child = T("WebView2", 13, Green) });
        grid.Children.Add(left);
        var right = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right };
        right.Children.Add(B("📂 Open ▾", true, 136)); right.Children.Add(B("💾 Export ▾", false, 140)); right.Children.Add(B("⇄ Compare", false, 130));
        right.Children.Add(B("📚 Document ▾", false, 154));
        Grid.SetColumn(right, 1); grid.Children.Add(right);
        return ToolFrame(grid);
    }

    private static UIElement ToolbarTwo()
    {
        var grid = ToolbarGrid();
        var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(B("¶ Hidden", false, 104)); row.Children.Add(B("☷ View File types ▾", false, 175));
        row.Children.Add(B("🔎 Find", false, 97)); row.Children.Add(B("🙈 Hide pictures", false, 150));
        row.Children.Add(B("A−", false, 54)); row.Children.Add(B("A+", false, 54)); row.Children.Add(B("↔", false, 54));
        row.Children.Add(B("🎨 Theme: Light ▾", false, 151)); row.Children.Add(B("ℹ About", false, 100));
        grid.Children.Add(row);
        return ToolFrame(grid);
    }

    private static Grid ToolbarGrid()
    {
        var grid = new Grid { Margin = new Thickness(14, 0, 14, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        return grid;
    }

    private static UIElement ToolFrame(UIElement child) => new Border { BorderBrush = Border, BorderThickness = new Thickness(0, 0, 0, 1), Background = Solid(0xf8, 0xfa, 0xfc), Child = child };

    private static UIElement MainBody(int view)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(294) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(28) });
        var side = Sidebar(view);
        grid.Children.Add(side);
        var content = Content(view);
        Grid.SetColumn(content, 1); grid.Children.Add(content);
        var status = new Border { Background = Brushes.White, BorderBrush = Border, BorderThickness = new Thickness(0, 1, 0, 0), Child = T("Created by Shaimaa Soltan  ·  Markdown Viewer  ·  2026", 12, Muted, center: true) };
        Grid.SetRow(status, 1); Grid.SetColumn(status, 0); Grid.SetColumnSpan(status, 2); grid.Children.Add(status);
        return grid;
    }

    private static UIElement Sidebar(int view)
    {
        var panel = new StackPanel { Background = Panel, Margin = new Thickness(0), ClipToBounds = true };
        panel.Children.Add(new Border { Margin = new Thickness(12, 12, 12, 7), Padding = new Thickness(10, 8, 10, 8), Background = Brushes.White, BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6), Child = T("⌕  Filter files...", 14, Muted) });
        var toggles = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(12, 0, 8, 7) };
        toggles.Children.Add(B("☷ All files", view != 2, 105)); toggles.Children.Add(B("🔎 Search results", view == 2, 145)); panel.Children.Add(toggles);
        var rows = view == 2
            ? new[] { "📄  README.md", "⚙  viewer.js", "📄  SECURITY-CHECKLIST.md", "</>  Content.cs", "🌐  page.html", "📄  hardening-history.txt" }
            : new[] { "📄  README.md", "⚙  .gitattributes", "⚙  .gitignore", "📄  SECURITY-CHECKLIST.md", "🌐  page.html", "</>  viewer.js", "📊  sample.csv", "{}  settings.json", "▤  notes.txt" };
        panel.Children.Add(new Border { Margin = new Thickness(12, 0, 12, 9), Padding = new Thickness(9, 6, 9, 6), Background = Brushes.White, BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6), Child = T(view == 2 ? "🔎 Search folder  ·  6 files" : "☷ View File types  ·  9 types", 13, Ink, FontWeights.SemiBold) });
        foreach (var (name, i) in rows.Select((n, i) => (n, i)))
        {
            var selected = view == 4 ? name.Contains("page.html") : name.Contains("README.md");
            panel.Children.Add(new Border { Background = selected ? Solid(0xd9, 0xf0, 0xfc) : Brushes.Transparent, BorderBrush = selected ? Blue : Brushes.Transparent, BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(11, 7, 8, 7), Child = T(name, 14, Ink, selected ? FontWeights.SemiBold : FontWeights.Normal) });
        }
        return new Border { Background = Panel, BorderBrush = Border, BorderThickness = new Thickness(0, 0, 1, 0), Child = panel };
    }

    private static UIElement Content(int view)
    {
        var root = new Grid { Margin = new Thickness(28, 12, 28, 12) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        if (view == 2) root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(220) });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var path = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
        path.Children.Add(T(view == 4 ? "C:/Projects/MarkdownViewer/docs/test/fixtures/html/page.html" : "C:/Projects/MarkdownViewer/README.md", 14, Muted));
        path.Children.Add(T(view == 4 ? "HTML  ·  2,397 lines  ·  source shown as text   ·   🔒 Private in-app connection" : "Markdown  ·  297 lines  ·  6,842 characters   ·   ✓ Safe   ·   ● Firewall blocked", 13, Muted));
        root.Children.Add(path);
        var row = 1;
        if (view == 2)
        {
            var results = SearchResults(); Grid.SetRow(results, 1); root.Children.Add(results); row = 2;
        }
        var document = view switch
        {
            2 => MarkdownText(),
            3 => CompareText(),
            4 => HtmlSource(),
            5 => SecurityText(),
            _ => MarkdownText(),
        };
        var scroller = new Border { Background = Brushes.White, BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(7), Padding = new Thickness(24), Child = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = document } };
        Grid.SetRow(scroller, row); root.Children.Add(scroller);
        return root;
    }

    private static UIElement MarkdownText()
    {
        var stack = new StackPanel { MaxWidth = 1120, HorizontalAlignment = HorizontalAlignment.Left };
        stack.Children.Add(T("# Markdown Viewer (WebView2)", 36, Ink, FontWeights.Bold));
        stack.Children.Add(T("A focused place to read your project files.", 20, Muted));
        stack.Children.Add(T("## Markdown that feels at home", 26, Ink, FontWeights.SemiBold));
        stack.Children.Add(T("Read headings, lists, tables, math, diagrams, pictures, and code in one clean view.", 17, Ink));
        stack.Children.Add(B("✓  Math equations     ✓  Diagrams     ✓  Tables     ✓  Code blocks", false, 680));
        stack.Children.Add(T("## Your work, at a glance", 26, Ink, FontWeights.SemiBold));
        stack.Children.Add(T("The sidebar keeps nearby files close. Open a folder, filter by type, and move between documents without losing your place.", 17, Ink));
        stack.Children.Add(Quote("Read your project. Keep your focus."));
        stack.Children.Add(T("### Made for everyday files", 21, Ink, FontWeights.SemiBold));
        stack.Children.Add(T("Markdown · CSV / TSV · JSON · Excel · XML · notebooks · source code · HTML", 16, Muted));
        stack.Children.Add(CodeBlock("```mermaid\nflowchart LR\n  Files --> ClearView\n  ClearView --> Focus\n```"));
        return stack;
    }

    private static UIElement SearchResults()
    {
        var stack = new StackPanel();
        stack.Children.Add(new Border { Background = Solid(0xf4, 0xf8, 0xfc), BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(7), Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 0, 6), Child = T("Find in folder   “safe local preview”      7 matches in 4 files      [≈ Similar]      [⌄ Search details]", 14, Ink) });
        stack.Children.Add(ResultLine("README.md", "Local files stay in the viewer. No network port is opened.", "92% similar"));
        stack.Children.Add(ResultLine("SECURITY-CHECKLIST.md", "HTML preview is sandboxed; document scripts cannot run.", "87% similar"));
        return stack;
    }

    private static UIElement ResultLine(string file, string excerpt, string score) => new Border { BorderBrush = Border, BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(8, 4, 8, 4), Child = new StackPanel { Children = { T(file + "  ·  3 matches  ·  line 42  ·  " + score, 14, Ink, FontWeights.SemiBold), T(excerpt, 14, Muted) } } };

    private static UIElement CompareText()
    {
        var stack = new StackPanel();
        stack.Children.Add(T("Compare versions   README.md  ⇄  README-old.md", 21, Ink, FontWeights.SemiBold));
        stack.Children.Add(T("Unchanged sections fold away. Changed words are easy to spot.", 15, Muted));
        stack.Children.Add(CodeLine("  12  - Only Markdown and images are supported.", Solid(0xf9, 0xe2, 0xe2), Solid(0xa3, 0x28, 0x28)));
        stack.Children.Add(CodeLine("  12  + Markdown, tables, code, XML, and more are supported.", Solid(0xe3, 0xf7, 0xe7), Solid(0x17, 0x73, 0x3a)));
        stack.Children.Add(T("Open   ·   Export   ·   Compare", 28, Ink, FontWeights.SemiBold));
        stack.Children.Add(T("Save a clean copy, make a self-contained web page, or save as PDF from Export.", 17, Muted));
        return stack;
    }

    private static UIElement HtmlSource()
    {
        var stack = new StackPanel();
        stack.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Children = { B("🌐 Preview", true, 128), B("</> Source", false, 128), B("⚠ Contains code · shown as text", false, 280) } });
        var lines = new[] { "<!DOCTYPE html>", "<html lang=\"en\">", "  <head>", "    <meta charset=\"utf-8\">", "    <title>Project notes</title>", "  </head>", "  <body>", "    <h1>Welcome</h1>", "    <p>HTML can be previewed safely.</p>", "    <script>/* shown as source, never run */</script>", "  </body>", "</html>" };
        foreach (var (line, i) in lines.Select((s, i) => (s, i + 1)))
            stack.Children.Add(new TextBlock { Text = $"{i,3}   {line}", FontFamily = Mono, FontSize = 15, Foreground = i == 10 ? Solid(0xa5, 0x32, 0x32) : Solid(0x16, 0x4d, 0x9a), Margin = new Thickness(0, 2, 0, 2) });
        stack.Children.Add(Quote("Preview is isolated. Scripts are disabled and external requests are blocked."));
        return stack;
    }

    private static UIElement SecurityText()
    {
        var stack = new StackPanel();
        stack.Children.Add(T("Safe to browse. Private by design.", 31, Ink, FontWeights.Bold));
        stack.Children.Add(T("Files are shown as data. Nothing in a document is executed.", 19, Muted));
        stack.Children.Add(B("●  Firewall: blocked in & out     🔒 Private in-app connection — no network port", true, 800));
        stack.Children.Add(T("✓  Active content blocked     ✓  External resources not loaded     ✓  Local libraries", 18, Green, FontWeights.SemiBold));
        stack.Children.Add(T("Search your folder and keep the results private on your device.", 17, Ink));
        return stack;
    }

    private static UIElement CodeBlock(string text) => new Border { Background = Solid(0xf6, 0xf8, 0xfa), BorderBrush = Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6), Padding = new Thickness(12), Margin = new Thickness(0, 12, 0, 0), Child = T(text, 15, Ink, font: Mono) };
    private static UIElement CodeLine(string text, Brush bg, Brush fg) => new Border { Background = bg, Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 3, 0, 3), Child = T(text, 16, fg, font: Mono) };
    private static UIElement Quote(string text) => new Border { BorderBrush = Blue, BorderThickness = new Thickness(4, 0, 0, 0), Background = Solid(0xf4, 0xf8, 0xfc), Padding = new Thickness(14), Margin = new Thickness(0, 14, 0, 14), Child = T(text, 17, Ink) };

    private static Border B(string text, bool primary, double width) => new()
    {
        Width = width, Margin = new Thickness(3, 0, 3, 0), Padding = new Thickness(8, 7, 8, 7),
        Background = primary ? Blue : Brushes.White, BorderBrush = primary ? Blue : Border, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(6),
        Child = T(text, 14, primary ? Brushes.White : Ink, primary ? FontWeights.SemiBold : FontWeights.Normal, center: true),
    };

    private static TextBlock T(string text, double size, Brush color, FontWeight? weight = null, FontFamily? font = null, bool center = false) => new()
    {
        Text = text, FontFamily = font ?? Ui, FontSize = size, Foreground = color, FontWeight = weight ?? FontWeights.Normal,
        TextWrapping = TextWrapping.Wrap, TextAlignment = center ? TextAlignment.Center : TextAlignment.Left,
        VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 4, 0, 4),
    };

    private static BitmapSource Render(UIElement ui)
    {
        ui.Measure(new Size(Width, Height)); ui.Arrange(new Rect(0, 0, Width, Height)); ui.UpdateLayout();
        var bitmap = new RenderTargetBitmap(Width, Height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(ui); bitmap.Freeze(); return bitmap;
    }

    private static BitmapSource Blend(string from, string to, double amount)
    {
        var grid = new Grid { Width = Width, Height = Height };
        grid.Children.Add(new Image { Source = Load(from) });
        grid.Children.Add(new Image { Source = Load(to), Opacity = amount });
        return Render(grid);
    }

    private static BitmapImage Load(string path)
    {
        var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.UriSource = new Uri(path); image.EndInit(); image.Freeze(); return image;
    }

    private static void Save(BitmapSource bitmap, string path)
    {
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var file = File.Create(path); encoder.Save(file);
    }

    private static async Task RenderVideo(List<(string Path, double Seconds)> clips, string output)
    {
        var composition = new MediaComposition();
        foreach (var (path, seconds) in clips)
            composition.Clips.Add(await MediaClip.CreateFromImageFileAsync(await StorageFile.GetFileFromPathAsync(path), TimeSpan.FromSeconds(seconds)));
        var encoded = Path.Combine(Path.GetTempPath(), "MarkdownViewer-promo-" + Guid.NewGuid().ToString("N") + ".mp4");
        var folder = await StorageFolder.GetFolderFromPathAsync(Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar));
        var target = await folder.CreateFileAsync(Path.GetFileName(encoded), CreationCollisionOption.FailIfExists);
        var profile = Windows.Media.MediaProperties.MediaEncodingProfile.CreateMp4(Windows.Media.MediaProperties.VideoEncodingQuality.HD1080p);
        profile.Video.Bitrate = 5_000_000;
        var result = await composition.RenderToFileAsync(target, MediaTrimmingPreference.Precise, profile);
        if (result != Windows.Media.Transcoding.TranscodeFailureReason.None)
            throw new InvalidOperationException($"Windows video encoding failed: {result}");
        File.Copy(encoded, output, overwrite: true);
        File.Delete(encoded);
    }

    private static Brush Solid(byte r, byte g, byte b) { var brush = new SolidColorBrush(Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }
}
