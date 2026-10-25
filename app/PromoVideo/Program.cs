using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MiniCloClo;
using NAudio.Wave;
using Windows.Media.Editing;
using Windows.Media.SpeechSynthesis;
using Windows.Storage;
using Brush = System.Windows.Media.Brush;
using Color = System.Windows.Media.Color;
using FontFamily = System.Windows.Media.FontFamily;

namespace PromoVideo;

// Makes the Mini CloClo promo video, offline:
//   PromoVideo.exe <output.mp4> [work folder] [--arabic]
//   PromoVideo.exe --screenshots <folder>   (README pictures; see Screenshots.cs)
// --arabic: narrated by Microsoft Hoda, laid out right to left.
// Each scene is drawn with WPF at 1920x1080 (the avatar is the app's own
// KeeperView), its narration is spoken by a Windows voice into a WAV, the
// scene lasts as long as its narration plus a pause, scenes cross-fade, and
// Windows' own encoder (Windows.Media.Editing) writes the MP4.
public static class Program
{
    private const int W = 1920, H = 1080;
    private const double Pause = 1.1;          // seconds after each narration
    private const int FadeFrames = 10;         // cross-fade frames between scenes
    private const double FadeFrameSeconds = 0.04;

    private static readonly Brush Ink = Frozen(0x1b, 0x14, 0x0d);
    private static readonly Brush Card = Frozen(0x2a, 0x20, 0x19);
    private static readonly Brush Edge = Frozen(0x8a, 0x6a, 0x2f);
    private static readonly Brush Gold = Frozen(0xe6, 0xc4, 0x76);
    private static readonly Brush Cream = Frozen(0xf3, 0xec, 0xdd);
    private static readonly Brush Muted = Frozen(0xcb, 0xbf, 0xa8);
    private static readonly Brush Green = Frozen(0x5f, 0x8f, 0x4e);
    private static readonly FontFamily Ui = new("Segoe UI");
    private static readonly FontFamily Arabic = new("Sakkal Majalla, Traditional Arabic, Segoe UI");
    private static readonly FontFamily Emoji = new("Segoe UI Emoji");

    private sealed record Scene(string Name, string Narration, Func<UIElement> Draw);

    // The Arabic version: right-to-left text, Hoda's voice, Arabic labels.
    private static bool Rtl;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--screenshots") return Screenshots.Run(args[1]);
        Rtl = args.Contains("--arabic");
        args = args.Where(a => a != "--arabic").ToArray();
        var output = Path.GetFullPath(args.Length > 0 ? args[0] : Rtl ? "MiniCloClo-promo-ar.mp4" : "MiniCloClo-promo.mp4");
        var work = Path.GetFullPath(args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), Rtl ? "minicloclo-promo-ar" : "minicloclo-promo"));
        if (Directory.Exists(work)) Directory.Delete(work, recursive: true);
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        _ = new System.Windows.Application();

        var scenes = Rtl ? ArabicScenes() : Scenes();
        var clips = new List<(string Image, double Seconds)>();
        var narration = new List<(string Wav, double Seconds)>();
        string? previous = null;
        for (var i = 0; i < scenes.Count; i++)
        {
            var scene = scenes[i];
            var image = Path.Combine(work, $"{i:00}-{scene.Name}.png");
            Save(Frame(scene.Draw(), scene.Narration), image);
            var wav = Path.Combine(work, $"{i:00}-{scene.Name}.wav");
            var speech = SpeakAsync(scene.Narration, wav).GetAwaiter().GetResult();
            var seconds = speech + Pause;
            narration.Add((wav, seconds));

            // The cross-fade from the previous scene takes the start of this one.
            var fadeTime = 0.0;
            if (previous != null)
            {
                for (var f = 1; f <= FadeFrames; f++)
                {
                    var blend = Path.Combine(work, $"{i:00}-fade{f:00}.png");
                    Save(Blend(previous, image, f / (double)(FadeFrames + 1)), blend);
                    clips.Add((blend, FadeFrameSeconds));
                    fadeTime += FadeFrameSeconds;
                }
            }
            clips.Add((image, seconds - fadeTime));
            previous = image;
            Console.WriteLine($"{scene.Name}: {seconds:0.0} s");
        }

        var soundtrack = Path.Combine(work, "narration.wav");
        Concatenate(narration, soundtrack);
        RenderAsync(clips, soundtrack, output).GetAwaiter().GetResult();
        Console.WriteLine($"{output}: {clips.Sum(c => c.Seconds):0.0} s, {new FileInfo(output).Length / 1048576.0:0.0} MB");
        return 0;
    }

    // ------------------------------------------------------------ the scenes

    private static List<Scene> Scenes()
    {
        var zone = PrayerTimeZone.Resolve("Egypt Standard Time");
        var date = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone).Date;
        var times = PrayerTimesCalculator.ForDate(date, 30.04, 31.24, "egyptian", "standard")
            .Select(p => (p.Name, TimeZoneInfo.ConvertTime(p.StartsAtUtc, zone).ToString("h:mm tt"))).ToList();
        var (_, fatiha) = QuranText.GetAyah(1, 2);
        var fatihaEnglish = QuranText.GetEnglish(1, 2);

        return
        [
            new("title",
                "Meet Mini CloClo. A small desktop companion, made for people who can't see the screen well. Everything it shows, it also says out loud.",
                () => Split(Stack(
                        Text("Mini CloClo", 120, Gold, FontWeights.Bold),
                        Text("A talking desktop companion\nfor people who can't see the screen well", 48, Cream),
                        Gap(30),
                        Text("Everything it shows, it also says.", 40, Muted)),
                    Avatar(v => v.SetNextPrayer("Next: Asr 3:52 PM", null), "3:12 PM"))),

            new("voice",
                "Just hold the right mouse button anywhere, wait for the chime, and ask. What time is it? What's the date? When is the next prayer?",
                () => Split(Stack(
                        Text("Just ask", 96, Gold, FontWeights.Bold),
                        Text("Hold right-click anywhere,\nwait for the chime, and talk.", 46, Cream),
                        Gap(40),
                        Bubble("“What time is it?”", right: false),
                        Bubble("It's 3:12 PM.", right: true),
                        Bubble("“When is the next prayer?”", right: false)),
                    Avatar(v =>
                    {
                        v.SetVoiceStatus("armed");
                        v.SetNowPlaying("Listening", "Say a command, like \"what time is it\"", "🎤");
                    }, "3:12 PM"))),

            new("clock",
                "The time is always large and easy to read, with the date, the Hijri date, and the next prayer right underneath. Click the avatar, and it tells you the time.",
                () => Split(Stack(
                        Text("Easy to read", 96, Gold, FontWeights.Bold),
                        Text("A large clock, the date,\nthe Hijri date and the next prayer.", 46, Cream),
                        Gap(30),
                        Text("Up to twice the normal size.\nClick the head to hear the time.", 40, Muted)),
                    Avatar(v => v.SetNextPrayer("Next: Asr 3:52 PM", null), "3:12 PM"))),

            new("prayer",
                "At every prayer time, Mini CloClo announces it and plays the azan, and the avatar changes into prayer clothes until you say: I prayed. Prayer times are worked out right on your PC, for your city.",
                () => Split(Stack(
                        Text("Prayer times & azan", 88, Gold, FontWeights.Bold),
                        Text("Announced out loud, then the azan.\nWorked out on your PC, for your city.", 44, Cream),
                        Gap(30),
                        CardOf("Today in Cairo", times.Select(t => $"{t.Name,-9}{t.Item2}").ToArray(), mono: true)),
                    Avatar(v =>
                    {
                        v.SetActivity("prayer");
                        v.SetNowPlaying("Asr prayer time", "Cairo", "🕌");
                    }, "3:52 PM"))),

            new("quran",
                "Memorize the Quran, one ayah at a time. The recitation repeats on a loop, and you move on by voice or keyboard: next, previous, or hear the meaning.",
                () => Split(Stack(
                        Text("Quran memorization", 88, Gold, FontWeights.Bold),
                        Text("Recited on a loop, ayah by ayah.\nSay next, previous — or hear the meaning.", 44, Cream),
                        Gap(30),
                        QuranCard(fatiha, fatihaEnglish)),
                    Avatar(v =>
                    {
                        v.SetReading(true);
                        v.SetNowPlaying("Quran · Al-Fatiha 1:2", "Ayah 2 of 1–7 · heard 3 times", "📗");
                    }, "8:05 PM", night: true))),

            new("reminders",
                "Set your own reminders, like drinking water or taking your medicine. Each one is spoken out loud, at the times you choose.",
                () => Split(Stack(
                        Text("Your reminders, spoken", 84, Gold, FontWeights.Bold),
                        Text("Every 15 minutes to 4 hours,\nduring the hours you choose.", 44, Cream),
                        Gap(30),
                        CardOf("Reminders", ["⏰  Drink a glass of water — every hour", "💊  Take your medicine — 9 AM to 9 PM", "🚶  Stand up and stretch — every 2 hours"])),
                    Avatar(v =>
                    {
                        v.SetCustomReminderActive(true);
                        v.SetNowPlaying("Drink a glass of water.", "Reminder", "⏰");
                    }, "11:00 AM"))),

            new("calling",
                "Say: call Mom. Confirm with yes, and your mobile phone places the call, over Bluetooth.",
                () => Split(Stack(
                        Text("Call by voice", 96, Gold, FontWeights.Bold),
                        Text("Your saved contacts, called through\nyour own phone over Bluetooth.", 44, Cream),
                        Gap(40),
                        Bubble("“Call Mom.”", right: false),
                        Bubble("Call Mom, 416 555 0123? Say yes, or cancel.", right: true),
                        Bubble("“Yes.”", right: false),
                        Bubble("📞  Calling Mom on your phone.", right: true)),
                    Avatar(v =>
                    {
                        v.SetVoiceStatus("complete");
                        v.SetNowPlaying("Calling Mom", "on your phone", "📞");
                    }, "5:30 PM"))),

            new("keyboard",
                "Prefer the keyboard? Control plus Alt shortcuts work from any app. T for the time, P for the next prayer, Q for the Quran, K to call someone.",
                () => Split(Stack(
                        Text("Or use the keyboard", 88, Gold, FontWeights.Bold),
                        Text("Ctrl + Alt shortcuts, from any app.", 44, Cream),
                        Gap(36),
                        Keys([("T", "The time"), ("D", "The date"), ("P", "Next prayer"), ("Q", "Quran"),
                              ("R", "Reminders"), ("K", "Call someone"), ("V", "Talk"), ("H", "Help")])),
                    Avatar(v => v.SetNextPrayer("Next: Maghrib 6:18 PM", null), "4:40 PM"))),

            new("privacy",
                "And it's private by design. Mini CloClo never connects to the internet. Speech is recognized on your PC, and nothing you say is ever saved.",
                () => Centered(Stack(
                    Text("🔒", 150, Gold, font: Emoji, center: true),
                    Text("Private by design", 104, Gold, FontWeights.Bold, center: true),
                    Gap(20),
                    Text("Never connects to the internet.\nSpeech is recognized on your PC.\nNothing you say is ever saved.", 52, Cream, center: true)))),

            new("arabic",
                "It speaks English and Arabic, and you can choose Keeper, or Lady Keeper.",
                () => Split(Stack(
                        Text("English & العربية", 96, Gold, FontWeights.Bold),
                        Text("الساعة كام؟  ·  الصلاة الجاية؟  ·  اتصل بماما", 58, Cream, font: Arabic, rtl: true),
                        Gap(30),
                        Text("Choose Keeper or Lady Keeper,\nin your favourite colour.", 44, Muted)),
                    Avatar(v =>
                    {
                        v.SetAvatar("lady");
                        v.SetOutfit("ocean");
                        v.SetArabicDates(true);
                        v.SetNextPrayer("Next: Isha 7:35 PM", null);
                    }, "6:40 PM", night: true))),

            new("outro",
                "Mini CloClo. Made to be heard. Find it on GitHub.",
                () => Centered(Stack(
                    Avatar(v => v.Salute(), "3:12 PM", height: 520),
                    Text("Mini CloClo", 120, Gold, FontWeights.Bold, center: true),
                    Text("Made to be heard.", 56, Cream, center: true),
                    Gap(20),
                    Text("github.com/shaimaasultan/mini-CloClo-Widget", 38, Muted, center: true)))),
        ];
    }

    // The Arabic version, narrated by Hoda. The narration is in clear Modern
    // Standard Arabic, which the synthetic voice pronounces well; the
    // commands are quoted the way the app understands them (Egyptian).
    private static List<Scene> ArabicScenes()
    {
        var zone = PrayerTimeZone.Resolve("Egypt Standard Time");
        var date = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone).Date;
        static string Clock(DateTime t) => $"{(t.Hour % 12 == 0 ? 12 : t.Hour % 12)}:{t.Minute:00} {(t.Hour < 12 ? "ص" : "م")}";
        var times = PrayerTimesCalculator.ForDate(date, 30.04, 31.24, "egyptian", "standard")
            .Select(p => $"{SpokenTime.ArabicPrayerName(p.Name),-8}   {Clock(TimeZoneInfo.ConvertTime(p.StartsAtUtc, zone).DateTime)}").ToArray();
        var (_, fatiha) = QuranText.GetAyah(1, 2);

        return
        [
            new("title",
                "تعرّف على ميني كلوكلو. رفيقٌ صغير على سطح المكتب، صُمّم لمن لا يرى الشاشة جيداً. كلُّ ما يُظهره، يقوله أيضاً بصوتٍ مسموع.",
                () => Split(Stack(
                        Text("ميني كلوكلو", 120, Gold, FontWeights.Bold),
                        Text("رفيقٌ ناطق على سطح المكتب\nلمن لا يرى الشاشة جيداً", 52, Cream),
                        Gap(30),
                        Text("كلُّ ما يُظهره، يقوله.", 44, Muted)),
                    Avatar(v => { v.SetArabicDates(true); v.SetNextPrayer("التالية: العصر 3:52 م", null); }, "3:12 م"))),

            new("voice",
                "فقط اضغط مطوّلاً على زر الفأرة الأيمن في أي مكان، وانتظر صوت التنبيه، ثم اسأل: الساعة كام؟ النهارده كام؟ امتى الصلاة الجاية؟",
                () => Split(Stack(
                        Text("فقط اسأل", 100, Gold, FontWeights.Bold),
                        Text("اضغط مطوّلاً على الزر الأيمن في أي مكان،\nانتظر التنبيه، ثم تكلّم.", 46, Cream),
                        Gap(40),
                        Bubble("«الساعة كام؟»", right: false),
                        Bubble("الساعة 3:12 مساءً.", right: true),
                        Bubble("«امتى الصلاة الجاية؟»", right: false)),
                    Avatar(v =>
                    {
                        v.SetArabicDates(true);
                        v.SetVoiceStatus("armed");
                        v.SetNowPlaying("أنا سامعك", "قل أمراً، مثل: الساعة كام؟", "🎤");
                    }, "3:12 م"))),

            new("clock",
                "الوقتُ دائماً كبيرٌ وسهلُ القراءة، ومعه التاريخ الميلادي والهجري، والصلاةُ القادمة أسفله مباشرة. اضغط على الشخصية، فتُخبرك بالوقت.",
                () => Split(Stack(
                        Text("سهلُ القراءة", 100, Gold, FontWeights.Bold),
                        Text("ساعةٌ كبيرة، والتاريخ الميلادي والهجري،\nوالصلاة القادمة.", 46, Cream),
                        Gap(30),
                        Text("حتى ضعفِ الحجم العادي.\nاضغط على الرأس لتسمع الوقت.", 42, Muted)),
                    Avatar(v => { v.SetArabicDates(true); v.SetNextPrayer("التالية: العصر 3:52 م", null); }, "3:12 م"))),

            new("prayer",
                "عند كلِّ صلاة، يُعلن ميني كلوكلو دخول الوقت ويرفع الأذان، وترتدي الشخصيةُ ملابسَ الصلاة حتى تقول: صلّيت. ومواقيتُ الصلاة تُحسب على جهازك، لمدينتك.",
                () => Split(Stack(
                        Text("مواقيت الصلاة والأذان", 92, Gold, FontWeights.Bold),
                        Text("إعلانٌ بصوتٍ مسموع، ثم الأذان.\nتُحسب على جهازك، لمدينتك.", 46, Cream),
                        Gap(30),
                        CardOf("اليوم في القاهرة", times)),
                    Avatar(v =>
                    {
                        v.SetArabicDates(true);
                        v.SetActivity("prayer");
                        v.SetNowPlaying("صلاة العصر", "القاهرة", "🕌");
                    }, "3:52 م"))),

            new("quran",
                "احفظ القرآن آيةً بعد آية. تتكرر التلاوة باستمرار، وتنتقل بصوتك أو بلوحة المفاتيح: الآية التالية، أو السابقة.",
                () => Split(Stack(
                        Text("حفظ القرآن", 100, Gold, FontWeights.Bold),
                        Text("تلاوةٌ متكررة، آيةً بعد آية.\nقل: «اللي بعده» أو «اللي قبله».", 46, Cream),
                        Gap(30),
                        QuranCard(fatiha, null)),
                    Avatar(v =>
                    {
                        v.SetArabicDates(true);
                        v.SetReading(true);
                        v.SetNowPlaying("الفاتحة · الآية 2", "سُمعت 3 مرات", "📗");
                    }, "8:05 م", night: true))),

            new("reminders",
                "اضبط تذكيراتك الخاصة، مثل شرب الماء أو موعد الدواء. وكلُّ تذكيرٍ يُقال بصوتٍ مسموع، في الأوقات التي تختارها.",
                () => Split(Stack(
                        Text("تذكيراتك، بصوتٍ مسموع", 88, Gold, FontWeights.Bold),
                        Text("من كلِّ ربع ساعة إلى كلِّ أربع ساعات،\nفي الساعات التي تختارها.", 46, Cream),
                        Gap(30),
                        CardOf("التذكيرات", ["⏰  اشرب كوب ماء — كل ساعة", "💊  موعد الدواء — من 9 ص إلى 9 م", "🚶  قم وتحرّك — كل ساعتين"])),
                    Avatar(v =>
                    {
                        v.SetArabicDates(true);
                        v.SetCustomReminderActive(true);
                        v.SetNowPlaying("اشرب كوب ماء.", "تذكير", "⏰");
                    }, "11:00 ص"))),

            new("calling",
                "قل: اتصل بماما. ثم أكِّد بقول: أيوه، فيتّصل هاتفُك المحمول، عبر البلوتوث.",
                () => Split(Stack(
                        Text("اتصل بصوتك", 100, Gold, FontWeights.Bold),
                        Text("بجهات الاتصال المحفوظة، عبر\nهاتفك أنت، بالبلوتوث.", 46, Cream),
                        Gap(40),
                        Bubble("«اتصل بماما»", right: false),
                        Bubble("أتصل بماما، 416 555 0123؟ قل أيوه، أو إلغاء.", right: true),
                        Bubble("«أيوه»", right: false),
                        Bubble("📞  بتصل بماما على تليفونك.", right: true)),
                    Avatar(v =>
                    {
                        v.SetArabicDates(true);
                        v.SetVoiceStatus("complete");
                        v.SetNowPlaying("بتصل بماما", "على تليفونك", "📞");
                    }, "5:30 م"))),

            new("keyboard",
                "تفضّل لوحة المفاتيح؟ اختصاراتُ كنترول مع ألت تعمل من أي برنامج: حرفُ تي للوقت، وبي للصلاة القادمة، وكيو للقرآن، وكيه للاتصال.",
                () => Split(Stack(
                        Text("أو استخدم لوحة المفاتيح", 90, Gold, FontWeights.Bold),
                        Text("اختصارات Ctrl + Alt، من أي برنامج.", 46, Cream),
                        Gap(36),
                        Keys([("T", "الوقت"), ("D", "التاريخ"), ("P", "الصلاة القادمة"), ("Q", "القرآن"),
                              ("R", "التذكيرات"), ("K", "اتصال"), ("V", "تحدّث"), ("H", "مساعدة")])),
                    Avatar(v => { v.SetArabicDates(true); v.SetNextPrayer("التالية: المغرب 6:18 م", null); }, "4:40 م"))),

            new("privacy",
                "وهو يحمي خصوصيتك. ميني كلوكلو لا يتصل بالإنترنت أبداً. يُفهَم الكلامُ على جهازك، ولا يُحفَظ أيُّ شيءٍ تقوله.",
                () => Centered(Stack(
                    Text("🔒", 150, Gold, font: Emoji, center: true),
                    Text("خصوصيتك محفوظة", 110, Gold, FontWeights.Bold, center: true),
                    Gap(20),
                    Text("لا يتصل بالإنترنت أبداً.\nيُفهَم الكلام على جهازك.\nولا يُحفَظ أيُّ شيءٍ تقوله.", 56, Cream, center: true)))),

            new("languages",
                "يتحدّث العربية والإنجليزية، ويمكنك أن تختار كيبر، أو ليدي كيبر.",
                () => Split(Stack(
                        Text("العربية و English", 100, Gold, FontWeights.Bold),
                        Text("What time is it?  ·  Next prayer  ·  Call Mom", 46, Cream, rtl: false),
                        Gap(30),
                        Text("اختر كيبر أو ليدي كيبر،\nبلونك المفضّل.", 46, Muted)),
                    Avatar(v =>
                    {
                        v.SetAvatar("lady");
                        v.SetOutfit("ocean");
                        v.SetArabicDates(true);
                        v.SetNextPrayer("التالية: العشاء 7:35 م", null);
                    }, "6:40 م", night: true))),

            new("outro",
                "ميني كلوكلو. صُنع لِيُسمَع. تجده على جيت هَب.",
                () => Centered(Stack(
                    Avatar(v => { v.SetArabicDates(true); v.Salute(); }, "3:12 م", height: 520),
                    Text("ميني كلوكلو", 120, Gold, FontWeights.Bold, center: true),
                    Text("صُنع لِيُسمَع.", 60, Cream, center: true),
                    Gap(20),
                    Text("github.com/shaimaasultan/mini-CloClo-Widget", 38, Muted, center: true, rtl: false)))),
        ];
    }

    // ------------------------------------------------------------ drawing

    // The whole frame: a warm dark background, the scene, and the narration
    // as a caption at the bottom (so it also works with the sound off).
    private static UIElement Frame(UIElement content, string caption)
    {
        var root = new Grid { Width = W, Height = H };
        root.Background = new RadialGradientBrush(Color.FromRgb(0x3a, 0x2a, 0x18), Color.FromRgb(0x12, 0x0d, 0x08))
        {
            Center = new Point(0.7, 0.4), GradientOrigin = new Point(0.7, 0.4), RadiusX = 0.9, RadiusY = 1.1,
        };
        root.Children.Add(content);
        var bar = new Border
        {
            VerticalAlignment = VerticalAlignment.Bottom,
            Background = new SolidColorBrush(Color.FromArgb(0xcc, 0x0c, 0x09, 0x06)),
            Padding = new Thickness(120, 18, 120, 22),
            Child = new TextBlock
            {
                Text = caption, FontFamily = Ui, FontSize = Rtl ? 33 : 30, Foreground = Cream, TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center, FlowDirection = Rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
            },
        };
        root.Children.Add(bar);
        return root;
    }

    // The words beside the picture: words on the left (on the right in Arabic).
    private static UIElement Split(UIElement words, UIElement picture)
    {
        var grid = new Grid { Margin = Rtl ? new Thickness(110, 70, 130, 150) : new Thickness(130, 70, 110, 150) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Rtl ? 1 : 1.25, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Rtl ? 1.25 : 1, GridUnitType.Star) });
        words.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        Grid.SetColumn(words, Rtl ? 1 : 0);
        Grid.SetColumn(picture, Rtl ? 0 : 1);
        grid.Children.Add(words);
        grid.Children.Add(picture);
        return grid;
    }

    private static UIElement Centered(UIElement content)
    {
        content.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        content.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        return new Grid { Margin = new Thickness(0, 0, 0, 120), Children = { content } };
    }

    private static StackPanel Stack(params UIElement[] children)
    {
        var stack = new StackPanel();
        foreach (var child in children) stack.Children.Add(child);
        return stack;
    }

    private static UIElement Gap(double height) => new Border { Height = height };

    private static TextBlock Text(string text, double size, Brush color, FontWeight? weight = null,
        FontFamily? font = null, bool center = false, bool? rtl = null) => TextBlockOf(text, size, color, weight, font, center, rtl ?? Rtl);

    private static TextBlock TextBlockOf(string text, double size, Brush color, FontWeight? weight,
        FontFamily? font, bool center, bool rtl) => new()
    {
        Text = text, FontSize = size, Foreground = color, FontFamily = font ?? Ui, FontWeight = weight ?? FontWeights.Normal,
        TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 14), LineHeight = size * 1.2,
        // Left is the start of the line: the right edge when right to left.
        TextAlignment = center ? TextAlignment.Center : TextAlignment.Left,
        FlowDirection = rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
        HorizontalAlignment = center ? HorizontalAlignment.Center : HorizontalAlignment.Stretch,
    };

    // A speech bubble: what you say on the left, what CloClo says on the right.
    // A speech bubble: what you say on the reading side (left, or right in
    // Arabic), what CloClo says on the other.
    private static UIElement Bubble(string text, bool right) => BubbleOf(text, right, Rtl ? !right : right);

    private static UIElement BubbleOf(string text, bool cloclo, bool right) => new Border
    {
        Background = cloclo ? Green : Card,
        BorderBrush = cloclo ? Brushes.Transparent : Edge,
        BorderThickness = new Thickness(cloclo ? 0 : 2),
        CornerRadius = new CornerRadius(26, 26, right ? 6 : 26, right ? 26 : 6),
        Padding = new Thickness(30, 16, 30, 18),
        Margin = new Thickness(right ? 120 : 0, 0, right ? 0 : 120, 18),
        HorizontalAlignment = right ? HorizontalAlignment.Right : HorizontalAlignment.Left,
        Child = new TextBlock
        {
            Text = text, FontFamily = Ui, FontSize = 38, Foreground = Cream, TextWrapping = TextWrapping.Wrap,
            FlowDirection = Rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
        },
    };

    private static UIElement CardOf(string heading, string[] lines, bool mono = false)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock { Text = heading, FontFamily = Ui, FontSize = 34, FontWeight = FontWeights.Bold, Foreground = Gold, Margin = new Thickness(0, 0, 0, 12) });
        foreach (var line in lines)
            stack.Children.Add(new TextBlock
            {
                Text = line, FontSize = 36, Foreground = Cream, Margin = new Thickness(0, 4, 0, 4),
                FontFamily = mono ? new FontFamily("Cascadia Mono, Consolas, Segoe UI") : new FontFamily("Segoe UI, Segoe UI Emoji"),
            });
        return new Border
        {
            Background = Card, BorderBrush = Edge, BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(22),
            Padding = new Thickness(36, 26, 36, 26), HorizontalAlignment = Rtl ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            FlowDirection = Rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight, Child = stack,
        };
    }

    private static UIElement QuranCard(string arabic, string? english) => new Border
    {
        Background = Card, BorderBrush = Edge, BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(22),
        Padding = new Thickness(40, 24, 40, 28), HorizontalAlignment = Rtl ? HorizontalAlignment.Right : HorizontalAlignment.Left,
        Child = Stack(
            new TextBlock { Text = arabic + " ﴿٢﴾", FontFamily = Arabic, FontSize = 80, Foreground = Gold, FlowDirection = FlowDirection.RightToLeft, TextAlignment = TextAlignment.Center },
            new TextBlock
            {
                Text = english ?? "", FontFamily = Ui, FontSize = 32, Foreground = Muted, TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center, MaxWidth = 780, Visibility = english == null ? Visibility.Collapsed : Visibility.Visible,
            }),
    };

    private static UIElement Keys((string Key, string Label)[] keys)
    {
        var grid = new System.Windows.Controls.Primitives.UniformGrid
        {
            Columns = 2, HorizontalAlignment = Rtl ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            FlowDirection = Rtl ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
        };
        foreach (var (key, label) in keys)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 50, 8) };
            row.Children.Add(new Border
            {
                Width = 74, Height = 74, CornerRadius = new CornerRadius(14), Background = Cream,
                BorderBrush = Edge, BorderThickness = new Thickness(0, 0, 0, 6),
                Child = new TextBlock { Text = key, FontFamily = Ui, FontSize = 40, FontWeight = FontWeights.Bold, Foreground = Ink, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
            });
            row.Children.Add(new TextBlock { Text = label, FontFamily = Ui, FontSize = 38, Foreground = Cream, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(20, 0, 0, 0) });
            // The key letter itself stays Latin, as printed on the keyboard.
            ((Border)row.Children[0]).Child.SetValue(FrameworkElement.FlowDirectionProperty, FlowDirection.LeftToRight);
            grid.Children.Add(row);
        }
        return grid;
    }

    // The app's own avatar, in a given look, scaled up to fill its column.
    // Its clock shows a chosen time rather than the moment of rendering.
    private static UIElement Avatar(Action<KeeperView> look, string time, bool night = false, double height = 860)
    {
        var view = new KeeperView();
        view.SetSize(2);
        view.SetMotionMode("still");
        view.SetNight(night);
        look(view);
        if (view.FindName("ClockTime") is TextBlock clock) clock.Text = time;
        // The app writes the date in Windows' own language; the Arabic video
        // shows it in Arabic.
        if (Rtl && view.FindName("ClockDate") is TextBlock clockDate)
        {
            var today = DateTime.Today;
            string[] days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
            string[] months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
            clockDate.Text = $"{days[(int)today.DayOfWeek]} {today.Day} {months[today.Month - 1]} {today.Year}";
            clockDate.FlowDirection = FlowDirection.RightToLeft;
        }
        // The shirt shows the Windows account name of whoever renders the
        // video - never put that in a published video.
        if (view.FindName("WorkoutCountdown") is TextBlock shirtName) shirtName.Visibility = Visibility.Collapsed;
        return new Viewbox { Height = height, Child = view, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    }

    // ------------------------------------------------------------ images

    private static BitmapSource Render(UIElement visual)
    {
        visual.Measure(new Size(W, H));
        visual.Arrange(new Rect(0, 0, W, H));
        visual.UpdateLayout();
        var bitmap = new RenderTargetBitmap(W, H, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return bitmap;
    }

    private static void Save(UIElement visual, string path) => Save(Render(visual), path);

    private static void Save(BitmapSource bitmap, string path)
    {
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var file = File.Create(path);
        encoder.Save(file);
    }

    private static BitmapSource Blend(string from, string to, double amount)
    {
        var grid = new Grid { Width = W, Height = H };
        grid.Children.Add(new Image { Source = Load(from) });
        grid.Children.Add(new Image { Source = Load(to), Opacity = amount });
        return Render(grid);
    }

    private static BitmapImage Load(string path)
    {
        var image = new BitmapImage();
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.UriSource = new Uri(path);
        image.EndInit();
        image.Freeze();
        return image;
    }

    // ------------------------------------------------------------ sound

    // Speaks the text with Zira - or Hoda in Arabic - into a WAV and
    // returns its length in seconds.
    private static async Task<double> SpeakAsync(string text, string path)
    {
        using var synth = new SpeechSynthesizer();
        synth.Voice = Rtl
            ? SpeechSynthesizer.AllVoices.FirstOrDefault(v => v.DisplayName.Contains("Hoda"))
              ?? SpeechSynthesizer.AllVoices.First(v => v.Language.StartsWith("ar", StringComparison.OrdinalIgnoreCase))
            : SpeechSynthesizer.AllVoices.FirstOrDefault(v => v.DisplayName.Contains("Zira"))
              ?? SpeechSynthesizer.AllVoices.First(v => v.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase));
        synth.Options.SpeakingRate = 1.0;
        using var stream = await synth.SynthesizeTextToStreamAsync(text);
        using (var file = File.Create(path))
        using (var read = System.IO.WindowsRuntimeStreamExtensions.AsStreamForRead(stream))
            await read.CopyToAsync(file);
        using var reader = new WaveFileReader(path);
        return reader.TotalTime.TotalSeconds;
    }

    // One soundtrack: each narration followed by silence up to its scene's length.
    private static void Concatenate(List<(string Wav, double Seconds)> parts, string path)
    {
        WaveFormat format;
        using (var first = new WaveFileReader(parts[0].Wav)) format = first.WaveFormat;
        using var writer = new WaveFileWriter(path, format);
        foreach (var (wav, seconds) in parts)
        {
            using var reader = new WaveFileReader(wav);
            reader.CopyTo(writer);
            var total = (long)(seconds * format.AverageBytesPerSecond);
            total -= total % format.BlockAlign;
            var silence = total - reader.Length;
            if (silence > 0) writer.Write(new byte[silence], 0, (int)silence);
        }
    }

    private static async Task RenderAsync(List<(string Image, double Seconds)> clips, string soundtrack, string output)
    {
        var composition = new MediaComposition();
        foreach (var (image, seconds) in clips)
        {
            var file = await StorageFile.GetFileFromPathAsync(image);
            composition.Clips.Add(await MediaClip.CreateFromImageFileAsync(file, TimeSpan.FromSeconds(seconds)));
        }
        composition.BackgroundAudioTracks.Add(await BackgroundAudioTrack.CreateFromFileAsync(await StorageFile.GetFileFromPathAsync(soundtrack)));
        var folder = await StorageFolder.GetFolderFromPathAsync(Path.GetDirectoryName(output)!);
        var target = await folder.CreateFileAsync(Path.GetFileName(output), CreationCollisionOption.ReplaceExisting);
        var profile = Windows.Media.MediaProperties.MediaEncodingProfile.CreateMp4(Windows.Media.MediaProperties.VideoEncodingQuality.HD1080p);
        // Mostly still pictures: 5 Mbps is plenty (the default is ~17).
        profile.Video.Bitrate = 5_000_000;
        profile.Audio.Bitrate = 128_000;
        var result = await composition.RenderToFileAsync(target, MediaTrimmingPreference.Precise, profile);
        if (result != Windows.Media.Transcoding.TranscodeFailureReason.None)
            throw new InvalidOperationException($"Windows couldn't encode the video: {result}");
    }

    private static Brush Frozen(byte r, byte g, byte b)
    {
        var brush = new SolidColorBrush(Color.FromRgb(r, g, b));
        brush.Freeze();
        return brush;
    }
}
