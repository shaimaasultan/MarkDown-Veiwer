using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MiniCloClo;

namespace PromoVideo;

// "PromoVideo.exe --screenshots <folder>": pictures of the app's real
// windows, filled with sample data, for the README. Each window is shown far
// off-screen (nothing appears on the desktop), drawn to a PNG with a title
// bar added, and closed. Speech is muted, and the Quran window keeps its
// progress in a throwaway folder (QuranStore.FolderOverride).
internal static class Screenshots
{
    private const double Scale = 1.5;   // drawn at 150% for crisp text

    public static int Run(string folder)
    {
        folder = Path.GetFullPath(folder);
        Directory.CreateDirectory(folder);
        _ = new System.Windows.Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        Voice.Muted = true;

        var contacts = new List<ContactSettings>
        {
            new() { Name = "Mom", OtherName = "ماما", Number = "4165550123" },
            new() { Name = "Ahmed", OtherName = "أحمد", Number = "+201005550142" },
            new() { Name = "Dr. Sara's clinic", Number = "4165550199" },
        };
        Capture(new ContactsWindow(contacts, "sample-phone", "My iPhone"), Path.Combine(folder, "contacts.png"), window =>
        {
            // The window lists this PC's paired phones once loaded; show a
            // sample one instead of whatever is paired here.
            if (Find<ComboBox>(window) is { } phone)
            {
                phone.ItemsSource = new List<BluetoothDialer.PairedDevice> { new("sample-phone", "My iPhone") };
                phone.SelectedIndex = 0;
            }
            if (Find<ListBox>(window) is { } list) { list.SelectedIndex = 1; list.SelectedIndex = 0; }
        });
        Capture(new ContactEditorWindow(new ContactSettings { Name = "Mom", OtherName = "ماما", Number = "416 555 0123" }, isNew: true),
            Path.Combine(folder, "contact-editor.png"));

        var reminders = new List<CustomReminderSettings>
        {
            new() { Message = "Drink a glass of water.", IntervalMinutes = 60, StartHour = 9, EndHour = 21 },
            new() { Message = "Take your medicine.", IntervalMinutes = 240, StartHour = 8, EndHour = 20 },
            new() { Message = "Stand up and stretch.", IntervalMinutes = 120, StartHour = 10, EndHour = 18, Enabled = false },
        };
        Capture(new CustomRemindersWindow(reminders), Path.Combine(folder, "reminders.png"));
        Capture(new CustomReminderEditorWindow(new CustomReminderSettings { Message = "Take your medicine.", IntervalMinutes = 240, StartHour = 8, EndHour = 20 }, isNew: true),
            Path.Combine(folder, "reminder-editor.png"));

        // The Quran window saves its place as it opens: keep that in a
        // throwaway folder, never the person's own progress file.
        QuranStore.FolderOverride = Path.Combine(Path.GetTempPath(), "MiniCloClo-screenshots");
        var store = new QuranStore { Surah = 1, Ayah = 2, AyahEnd = 2, ShowEnglish = true, GapSeconds = 2, ReminderMinutes = 60 };
        store.Memorized.AddRange([0]);
        Capture(new QuranWindow(store), Path.Combine(folder, "quran.png"));
        return 0;
    }

    private static void Capture(Window window, string path, Action<Window>? prepare = null)
    {
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = -20000;
        window.Top = 0;
        window.ShowActivated = false;
        window.ShowInTaskbar = false;
        window.Show();
        Pump(900);
        prepare?.Invoke(window);
        Pump(300);

        // The window's own root (its client area, background included): its
        // content has margins, and drawn on its own would come out shifted.
        var root = (FrameworkElement)VisualTreeHelper.GetChild(window, 0);
        var width = root.ActualWidth;
        var height = root.ActualHeight;
        var client = new RenderTargetBitmap((int)Math.Ceiling(width * Scale), (int)Math.Ceiling(height * Scale), 96 * Scale, 96 * Scale, PixelFormats.Pbgra32);
        client.Render(root);
        window.Close();

        // A plain Windows 11-style title bar, so it reads as a window.
        var frame = new Border
        {
            BorderBrush = new SolidColorBrush(Color.FromRgb(0x9a, 0x9a, 0x9a)),
            BorderThickness = new Thickness(1),
            Child = new DockPanel
            {
                Children =
                {
                    TitleBar(window.Title, width),
                    new Image { Source = client, Width = width, Height = height },
                },
            },
        };
        DockPanel.SetDock(((DockPanel)frame.Child).Children[0], Dock.Top);
        frame.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        frame.Arrange(new Rect(frame.DesiredSize));
        var image = new RenderTargetBitmap((int)Math.Ceiling(frame.ActualWidth * Scale), (int)Math.Ceiling(frame.ActualHeight * Scale), 96 * Scale, 96 * Scale, PixelFormats.Pbgra32);
        image.Render(frame);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(image));
        using var file = File.Create(path);
        encoder.Save(file);
        Console.WriteLine($"{Path.GetFileName(path)}: {image.PixelWidth}x{image.PixelHeight}");
    }

    private static UIElement TitleBar(string title, double width)
    {
        var bar = new Grid { Width = width, Height = 32, Background = new SolidColorBrush(Color.FromRgb(0xf3, 0xf3, 0xf3)) };
        bar.Children.Add(new TextBlock { Text = title, FontFamily = new FontFamily("Segoe UI"), FontSize = 12, Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
        bar.Children.Add(new TextBlock
        {
            Text = "            ", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 10,
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0),
        });
        return bar;
    }

    private static T? Find<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T match) return match;
            if (Find<T>(child) is { } deeper) return deeper;
        }
        return null;
    }

    private static void Pump(int milliseconds)
    {
        var frame = new DispatcherFrame();
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(milliseconds) };
        timer.Tick += (_, _) => { timer.Stop(); frame.Continue = false; };
        timer.Start();
        Dispatcher.PushFrame(frame);
    }
}
