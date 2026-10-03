// Markdown Viewer \u2014 desktop launcher.
//
// Opens a .md file in the HTML viewer (ReadMe.html) inside a Microsoft Edge app window.
// The viewer can't read files from disk by itself, so this program runs a tiny HTTP server
// on 127.0.0.1 that serves the viewer and the files next to the markdown document.
// Every URL carries a random token, and the server exits once the window has been closed.
//
// Build: see build.ps1 (uses the C# compiler that ships with Windows / .NET Framework 4).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
#if WEBVIEW2
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
#endif

// Two editions are built from this one file (see build.ps1):
//   online  - MarkdownViewer.exe: math, code colouring and diagrams load from the internet
//   offline - MarkdownViewerOffline.exe (compiled with /define:OFFLINE): every library is bundled in lib\,
//             and the window's security policy allows no internet addresses at all.
//   webview2 - MarkdownViewerWebView2.exe (compiled with /define:WEBVIEW2): bundled libraries like the offline
//             edition, shown in the program's own window through the WebView2 control. Requests are answered
//             inside the program - no localhost server, no network port at all.
#if WEBVIEW2
[assembly: AssemblyTitle("Markdown Viewer (WebView2, preview only)")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
#elif OFFLINE
[assembly: AssemblyTitle("Markdown Viewer (Offline, preview only)")]
[assembly: AssemblyProduct("Markdown Viewer (Offline)")]
#else
[assembly: AssemblyTitle("Markdown Viewer (preview only)")]
[assembly: AssemblyProduct("Markdown Viewer")]
#endif
[assembly: AssemblyDescription("Previews Markdown files with figures, math and diagrams. Never runs code from a document.")]
[assembly: AssemblyCopyright("Markdown Viewer")]
[assembly: AssemblyVersion("1.4.0.0")]
[assembly: AssemblyFileVersion("1.4.0.0")]
[assembly: AssemblyInformationalVersion("1.4.0")]

static class Program
{
#if WEBVIEW2
    const string AppName = "Markdown Viewer (WebView2)";
    const string Edition = "webview2";
    const string FirewallGroup = "Markdown Viewer (WebView2)";   // not used: this edition has no network port
    const string DataFolder = "MarkdownViewerWebView2";
    const string FirewallScript = "";
#elif OFFLINE
    const string AppName = "Markdown Viewer (Offline)";
    const string Edition = "offline";
    const string FirewallGroup = "Markdown Viewer (Offline)";
    const string DataFolder = "MarkdownViewerOffline";      // %APPDATA% folder for settings
    const string FirewallScript = "Firewall-Add-Offline.cmd";
#else
    const string AppName = "Markdown Viewer";
    const string Edition = "online";
    const string FirewallGroup = "Markdown Viewer";
    const string DataFolder = "MarkdownViewer";
    const string FirewallScript = "Firewall-Add.cmd";
#endif
    const string AppVersion = "1.4.0";
    static readonly TimeSpan IdleLimit = TimeSpan.FromMinutes(10);     // window closed (no pings)
    static readonly TimeSpan StartupLimit = TimeSpan.FromMinutes(2);   // window never connected

    static readonly string[] AppFiles = { "ReadMe.html", "viewer.js", "marked.min.js", "favicon_readme.png" };

    // Preview only: the only files handed out from disk are documents and media that cannot run code.
    // HTML, scripts, PDFs, programs etc. are refused (403) even if a document links to them.
    static readonly HashSet<string> ServedTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        ".md", ".markdown", ".mdown", ".mkd", ".txt",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg",
        ".mp4", ".webm", ".mp3", ".wav", ".ogg"
    };
    static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "node_modules", ".git", ".venv", "venv", "__pycache__", "bin", "obj" };

    static string appDir, startFile, startDir, repoRoot, allowRoot;
    static long lastSeenTicks = DateTime.UtcNow.Ticks;
    static volatile bool connected;

    // ------------------------------------------------------------------ endpoints & port rotation
    // An endpoint is one listening port (127.0.0.1 only, chosen by Windows from the dynamic range)
    // plus the random token every URL on it must start with. While the window stays open, the server
    // periodically opens a new endpoint; the page moves to it (at a quiet moment) and the old one closes.
    class Endpoint
    {
        public TcpListener Listener;
        public int Port;
        public string Token;
        public string Origin = null;     // null = http://127.0.0.1:<port>; WebView2 edition: https://mdviewer.local
        public string AppBase { get { return (Origin ?? "http://127.0.0.1:" + Port) + "/" + Token + "/app/"; } }
        public string AppUrl { get { return AppBase + "ReadMe.html"; } }
    }
    static Endpoint current, pending;
    static readonly object epLock = new object();
    static DateTime nextRotation = DateTime.MaxValue;
    static int rotateTestSeconds;           // --rotate-test=N: rotate every N seconds (testing only)
    static bool testSkipFirstClose;         // --rotate-test-noclose: pretend the first old port fails to close (testing only)

    // The previous endpoint after a move: closed once its grace period ends, then checked.
    static readonly TimeSpan CloseGrace = TimeSpan.FromSeconds(30);
    static Endpoint closing;                // old endpoint waiting to close (or that failed to close)
    static DateTime closeAt;
    static bool closeFailed;                // the deadline passed but the old port still accepts connections
    static int closedPort;                  // last old port confirmed closed (for the "closed \u2713" note)
    static DateTime closedAt;

    static Endpoint OpenEndpoint()
    {
        TcpListener l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        Endpoint ep = new Endpoint { Listener = l, Port = ((IPEndPoint)l.LocalEndpoint).Port, Token = RandomHex(16) };
        Thread t = new Thread(() => AcceptLoop(ep));
        t.IsBackground = true;
        t.Start();
        return ep;
    }

    static TimeSpan RotateInterval()
    {
        if (rotateTestSeconds > 0) return TimeSpan.FromSeconds(rotateTestSeconds);
        string v;
        if (!LoadPrefs().TryGetValue("rotate", out v)) v = PrefValues["rotate"][0];
        int minutes;
        return int.TryParse(v, out minutes) ? TimeSpan.FromMinutes(minutes) : TimeSpan.Zero;   // "off" -> zero
    }

    // Called every few seconds: opens the next endpoint when it's time (once the window is connected).
    static void RotationTick()
    {
        TimeSpan interval = RotateInterval();
        lock (epLock)
        {
            if (interval == TimeSpan.Zero) { nextRotation = DateTime.MaxValue; return; }
            DateTime due = DateTime.UtcNow + interval;
            if (nextRotation == DateTime.MaxValue || nextRotation > due) nextRotation = due;   // started, or interval shortened
            if (pending == null && connected && DateTime.UtcNow >= nextRotation) pending = OpenEndpoint();
        }
    }

    // The page has arrived on the new endpoint: make it current and close the old port after a grace period.
    static void Promote(Endpoint ep)
    {
        Endpoint old;
        lock (epLock)
        {
            if (ep != pending) return;
            old = current;
            current = pending;
            pending = null;
            TimeSpan interval = RotateInterval();
            nextRotation = interval == TimeSpan.Zero ? DateTime.MaxValue : DateTime.UtcNow + interval;
            // A port that failed to close earlier is closed now, before tracking the next one.
            if (closing != null && closing != old) { try { closing.Listener.Stop(); } catch { } }
            closing = old;
            closeAt = DateTime.UtcNow + CloseGrace;
            closeFailed = false;
        }
        Thread closer = new Thread(() =>
        {
            Thread.Sleep(CloseGrace);            // let requests already in flight on the old port finish
            bool skip = testSkipFirstClose;
            testSkipFirstClose = false;
            if (!skip) { try { old.Listener.Stop(); } catch { } }
            bool stillOpen = IsPortOpen(old.Port);
            lock (epLock)
            {
                if (closing != old) return;
                if (stillOpen) closeFailed = true;
                else { closing = null; closedPort = old.Port; closedAt = DateTime.UtcNow; }
            }
        });
        closer.IsBackground = true;
        closer.Start();
    }

    // Asked for by the user (pop-up "Force close"): stop the old listener now and check again.
    static void ForceCloseOld()
    {
        Endpoint old;
        lock (epLock) old = closing;
        if (old == null) return;
        try { old.Listener.Stop(); } catch { }
        try { old.Listener.Server.Close(); } catch { }
        bool stillOpen = IsPortOpen(old.Port);
        lock (epLock)
        {
            if (closing != old) return;
            if (stillOpen) closeFailed = true;
            else { closing = null; closeFailed = false; closedPort = old.Port; closedAt = DateTime.UtcNow; }
        }
    }

    // True when something still accepts connections on 127.0.0.1:port.
    static bool IsPortOpen(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                bool done = ar.AsyncWaitHandle.WaitOne(1000);
                if (!done) return false;
                try { c.EndConnect(ar); return true; } catch { return false; }
            }
        }
        catch { return false; }
    }

    // ------------------------------------------------------------------ firewall status (read-only)
    // Reads this edition's firewall rules (added by Firewall-Add.cmd) through Windows' firewall API
    // (HNetCfg.FwPolicy2). Reading needs no administrator rights; nothing is ever changed here.
    class FirewallStatus
    {
        public bool Readable, FirewallOn;
        public string State = "unknown", Summary = "", Detail = "";
        public List<string> Rules = new List<string>();
    }

    static FirewallStatus GetFirewallStatus()
    {
        FirewallStatus st = new FirewallStatus();
#if WEBVIEW2
        // Nothing listens on the network in this edition, so there is nothing for firewall rules to protect.
        st.Readable = true;
        st.FirewallOn = true;
        try
        {
            dynamic fwPolicy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
            int prof = fwPolicy.CurrentProfileTypes;
            foreach (int bit in new[] { 1, 2, 4 })
                if ((prof & bit) != 0 && !(bool)fwPolicy.FirewallEnabled[bit]) st.FirewallOn = false;
        }
        catch { }
        st.State = "nonetwork";
        st.Summary = "Not needed - no network port";
        st.Detail = "This edition shows documents inside its own window (WebView2); nothing listens on the network, so there is nothing for firewall rules to protect.";
        return st;
#else
        try
        {
            dynamic policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
            int profiles = policy.CurrentProfileTypes;
            st.FirewallOn = true;
            foreach (int bit in new[] { 1, 2, 4 })                 // domain, private, public
                if ((profiles & bit) != 0 && !(bool)policy.FirewallEnabled[bit]) st.FirewallOn = false;

            string exe = Application.ExecutablePath;
            int allowIn = 0, allowOut = 0, blockIn = 0, blockOut = 0, disabled = 0, otherProgram = 0;
            string ruleProgram = null;
            foreach (dynamic r in policy.Rules)
            {
                string group = r.Grouping;
                if (group != FirewallGroup) continue;
                string app = r.ApplicationName;
                bool enabled = r.Enabled;
                int dir = r.Direction, action = r.Action;          // dir 1 = in, 2 = out; action 0 = block, 1 = allow
                if (!enabled) disabled++;
                if (app == null || !string.Equals(Path.GetFullPath(app), Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase))
                {
                    otherProgram++;
                    if (app != null) ruleProgram = app;
                }
                if (action == 1 && dir == 1) allowIn++;
                if (action == 1 && dir == 2) allowOut++;
                if (action == 0 && dir == 1) blockIn++;
                if (action == 0 && dir == 2) blockOut++;
                st.Rules.Add((action == 1 ? "Allow " : "Block ") + (dir == 1 ? "inbound" : "outbound") + (enabled ? "" : " (disabled)"));
            }
            st.Readable = true;
            int total = st.Rules.Count;
            if (total == 0)
            {
                st.State = "none";
                st.Summary = "Not added";
                st.Detail = "Optional: the helper only listens on 127.0.0.1 anyway. Run " + FirewallScript + " to add the 4 protective rules.";
            }
            else if (total == 4 && allowIn == 1 && allowOut == 1 && blockIn == 1 && blockOut == 1 && disabled == 0 && otherProgram == 0)
            {
                st.State = "active";
                st.Summary = "Active - 4 rules";
                st.Detail = "Allow loopback (127.0.0.1) in and out on the dynamic ports; block every other address in and out.";
            }
            else if (total == 4 && otherProgram == 4 && disabled == 0 && ruleProgram != null)
            {
                // The rules are fine but protect another copy of the program (usually the installed one,
                // while this is e.g. the build output in app\dist-offline).
                st.State = "othercopy";
                st.Summary = "Not this copy";
                st.Detail = "The 4 rules protect " + ruleProgram + ", but this window runs " + exe +
                            ". Open .md files with the installed app (Start menu > " + AppName + ") to be covered.";
            }
            else
            {
                List<string> issues = new List<string>();
                if (total != 4) issues.Add(total + " of 4 rules present");
                if (allowIn != 1 || allowOut != 1) issues.Add("allow rules missing or duplicated");
                if (blockIn != 1 || blockOut != 1) issues.Add("block rules missing or duplicated");
                if (disabled > 0) issues.Add(disabled + " disabled");
                if (otherProgram > 0) issues.Add(otherProgram + " point to a different program file");
                st.State = "incomplete";
                st.Summary = "Incomplete";
                st.Detail = string.Join("; ", issues.ToArray()) + ". Run " + FirewallScript + " again to repair them.";
            }
            if (!st.FirewallOn) st.Detail += " Note: Windows Firewall is OFF for the current network, so no rules are applied.";
        }
        catch (Exception ex)
        {
            st.Readable = false;
            st.Summary = "Unknown";
            st.Detail = "Could not read the firewall settings: " + ex.Message;
        }
        return st;
#endif
    }

    static string FirewallJson()
    {
        FirewallStatus st = GetFirewallStatus();
        StringBuilder sb = new StringBuilder("{");
        sb.Append("\"readable\":").Append(st.Readable ? "true" : "false");
        sb.Append(",\"firewallOn\":").Append(st.FirewallOn ? "true" : "false");
        sb.Append(",\"state\":").Append(Json(st.State));
        sb.Append(",\"summary\":").Append(Json(st.Summary));
        sb.Append(",\"detail\":").Append(Json(st.Detail));
        sb.Append(",\"rules\":[");
        for (int i = 0; i < st.Rules.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Json(st.Rules[i])); }
        return sb.Append("]}").ToString();
    }

    static string RotationJson()
    {
        lock (epLock)
        {
            TimeSpan interval = RotateInterval();
            long next = nextRotation == DateTime.MaxValue ? -1 : (long)Math.Max(0, (nextRotation - DateTime.UtcNow).TotalSeconds);
            long closeLeft = closing == null ? -1 : (long)Math.Max(0, (closeAt - DateTime.UtcNow).TotalSeconds);
            bool recentlyClosed = closedPort > 0 && DateTime.UtcNow - closedAt < TimeSpan.FromSeconds(10);
            return "{\"transport\":" + Json(Edition == "webview2" ? "webview2" : "tcp") +
                   ",\"port\":" + current.Port +
                   ",\"rotate\":" + Json(pending == null ? null : pending.AppUrl) +
                   ",\"rotateMinutes\":" + Json(interval == TimeSpan.Zero ? "off" : rotateTestSeconds > 0 ? rotateTestSeconds + "s" : ((int)interval.TotalMinutes).ToString()) +
                   ",\"nextRotationSeconds\":" + next +
                   ",\"closingPort\":" + (closing == null ? 0 : closing.Port) +
                   ",\"closeSecondsLeft\":" + closeLeft +
                   ",\"closeFailed\":" + (closeFailed ? "true" : "false") +
                   ",\"closedPort\":" + (recentlyClosed ? closedPort : 0) + "}";
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static int Run(string[] args)
    {
        appDir = AppDomain.CurrentDomain.BaseDirectory;
#if !WEBVIEW2
        bool noOpen = false;                              // the WebView2 edition opens its own window, not Edge
#endif
        foreach (string a in args)
        {
            if (a == "--about")
            {
                ShowAboutWindow();
                return 0;
            }
            if (a == "--no-open")                         // testing: print the URL instead of opening Edge
            {
#if !WEBVIEW2
                noOpen = true;
#endif
            }
            else if (a.StartsWith("--rotate-test=")) int.TryParse(a.Substring(14), out rotateTestSeconds);   // testing
            else if (a == "--rotate-test-noclose") testSkipFirstClose = true;                                 // testing
            else if (startFile == null) startFile = Path.GetFullPath(a);
        }

        if (startFile != null && !File.Exists(startFile))
        {
            MessageBox.Show("File not found:\n" + startFile, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        if (startFile != null)
        {
            startDir = Path.GetDirectoryName(startFile);
            string git = FindGitRoot(startDir);
            repoRoot = git ?? startDir;
            // Allow one level up so "../images/x.png" from a docs folder still works.
            DirectoryInfo parent = Directory.GetParent(startDir);
            allowRoot = git ?? (parent != null ? parent.FullName : startDir);
        }

#if WEBVIEW2
        // No server: the page lives at a private address that exists only inside this window, and every
        // request it makes is answered in-process by the same handler the other editions use over TCP.
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        current = new Endpoint { Origin = PrivateHost, Token = RandomHex(16) };
        connected = true;
        string startUrl = current.AppUrl;
        if (startFile != null) startUrl += "?file=" + Uri.EscapeDataString(ToWeb(startFile));
        Application.Run(new ViewerForm(startUrl));
        return 0;
#else
        current = OpenEndpoint();

        string url = current.AppUrl;
        if (startFile != null) url += "?file=" + Uri.EscapeDataString(ToWeb(startFile));

        if (noOpen) { Console.WriteLine(url); Console.Out.Flush(); } else OpenWindow(url);

        while (true)
        {
            Thread.Sleep(rotateTestSeconds > 0 ? 1000 : 5000);
            TimeSpan idle = DateTime.UtcNow - new DateTime(Interlocked.Read(ref lastSeenTicks), DateTimeKind.Utc);
            if (idle > (connected ? IdleLimit : StartupLimit)) break;
            RotationTick();
        }
        return 0;
#endif
    }

    // ------------------------------------------------------------------ about

    class Library { public string Name, Use, Version; public List<string> Urls = new List<string>(); public string Bundled; }

    // Library versions and online addresses, read from the installed viewer files so they always
    // match what actually loads (same rule as the About window inside the viewer).
    static List<Library> Libraries()
    {
        string html = "";
        try { html = File.ReadAllText(Path.Combine(appDir, "ReadMe.html"), Encoding.UTF8); } catch { }
        // Online edition: the libraries' internet addresses. Offline edition: the bundled lib\ files.
        List<string> urls = new List<string>();
        foreach (Match m in Regex.Matches(html, "(?:src|href)=\"((?:https?://|\\./lib/)[^\"]+)\""))
            if (!urls.Contains(m.Groups[1].Value)) urls.Add(m.Groups[1].Value);
        // Offline edition: versions of the bundled copies, recorded by build.ps1.
        Match vm = Regex.Match(html, "name=\"mdv-lib-versions\" content=\"([^\"]*)\"");
        Dictionary<string, string> bundledVersions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (vm.Success)
            foreach (string pair in vm.Groups[1].Value.Split(';'))
            {
                string[] kv = pair.Split('=');
                if (kv.Length == 2) bundledVersions[kv[0].Trim()] = kv[1].Trim();
            }

        string markedVersion = "?";
        try
        {
            string head = File.ReadAllText(Path.Combine(appDir, "marked.min.js"));
            Match mv = Regex.Match(head.Substring(0, Math.Min(400, head.Length)), @"marked v(\d+\.\d+\.\d+)");
            if (mv.Success) markedVersion = mv.Groups[1].Value;
        }
        catch { }

        List<Library> libs = new List<Library>();
        Library marked = new Library { Name = "marked", Use = "Markdown to HTML", Version = markedVersion };
        marked.Bundled = "marked.min.js (bundled)";
        marked.Urls.Add("online copy: https://cdn.jsdelivr.net/npm/marked@" + markedVersion + "/marked.min.js");
        libs.Add(marked);

        string[,] known = { { "KaTeX", "Math equations", "katex" }, { "highlight.js", "Code colouring", "highlight.js" }, { "Mermaid", "Diagrams", "mermaid" } };
        for (int i = 0; i < known.GetLength(0); i++)
        {
            Library lib = new Library { Name = known[i, 0], Use = known[i, 1], Version = "?" };
            string key = known[i, 2] == "highlight.js" ? "highlight" : known[i, 2];
            foreach (string u in urls)
            {
                if (u.IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) continue;
                lib.Urls.Add(u.StartsWith("./lib/") ? u.Substring(2).Replace('/', '\\') + " (bundled)" : u);
                Match v = Regex.Match(u, @"[@/](\d+\.\d+\.\d+)/");
                if (v.Success) lib.Version = v.Groups[1].Value;
            }
            string bv;
            if (lib.Version == "?" && bundledVersions.TryGetValue(known[i, 2], out bv)) lib.Version = bv;
            libs.Add(lib);
        }
        return libs;
    }

    static string AboutText()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine(AppName + " " + AppVersion);
        sb.AppendLine();
        sb.AppendLine("PREVIEW ONLY: Markdown files are displayed, never executed. Scripts, event handlers,");
        sb.AppendLine("javascript: links, frames, forms and plugins in a document are removed before display");
        sb.AppendLine("and also blocked by the window's security policy. Only Markdown, text, images, audio and");
        sb.AppendLine("video files are ever read from disk; HTML, scripts, PDFs and programs are refused.");
        sb.AppendLine();
        sb.AppendLine(Edition != "online"
            ? "LIBRARIES (all bundled - this edition never needs the internet):"
            : "LIBRARIES (loaded online when a document opens; marked is bundled):");
        foreach (Library lib in Libraries())
        {
            sb.AppendLine();
            sb.AppendLine("- " + lib.Name + " " + lib.Version + "  (" + lib.Use + ")");
            if (lib.Bundled != null) sb.AppendLine("     " + lib.Bundled);
            foreach (string u in lib.Urls) sb.AppendLine("     " + u);
        }
        sb.AppendLine();
        sb.AppendLine(Edition != "online"
            ? "Works fully offline: math, code colouring and diagrams come from the bundled lib folder."
            : "Without internet, Markdown and images still work; math shows as raw TeX and diagrams as code.");
        sb.AppendLine();
        sb.AppendLine("BUILT WITH:");
        sb.AppendLine("- Windows app: C# 5, compiled with csc.exe from .NET Framework 4 (included with Windows);");
#if WEBVIEW2
        sb.AppendLine("     running on .NET Framework CLR " + Environment.Version + "; no network port - requests are answered in-process");
        string wvRuntime = null, wvSdk = null;
        try { wvRuntime = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
        try { wvSdk = FileVersionInfo.GetVersionInfo(typeof(CoreWebView2Environment).Assembly.Location).FileVersion; } catch { }
        sb.AppendLine("- Window: own window with the WebView2 control - WebView2 Runtime " + (wvRuntime ?? "(not found)") +
                      ", WebView2 SDK " + (wvSdk ?? "?") + " (Microsoft.Web.WebView2)");
#else
        sb.AppendLine("     running on .NET Framework CLR " + Environment.Version + "; built-in local web server (127.0.0.1 only)");
        string edge = FindEdge();
        string edgeVersion = null;
        try { if (edge != null) edgeVersion = FileVersionInfo.GetVersionInfo(edge).ProductVersion; } catch { }
        sb.AppendLine("- Window: Microsoft Edge " + (edgeVersion ?? "(not found \u2014 default browser is used)") + " in app mode");
#endif
        sb.AppendLine("- Installer: PowerShell scripts (build, install, uninstall); per-user file association, no admin rights");
        sb.AppendLine("- Viewer: HTML, CSS and JavaScript, no frameworks");
        sb.AppendLine("- Made using: GPT-5 (original viewer); extended and tested with Claude Code (Anthropic)");
        FirewallStatus fw = GetFirewallStatus();
        sb.AppendLine();
        sb.AppendLine("FIREWALL RULES: " + fw.Summary + (fw.Readable ? (fw.FirewallOn ? " (Windows Firewall is on)" : " (Windows Firewall is OFF)") : ""));
        sb.AppendLine("     " + fw.Detail);
        sb.AppendLine();
        sb.Append("Installed in: " + appDir.TrimEnd('\\'));
        return sb.ToString();
    }

    // Native About window: a coloured firewall marker (green = all 4 rules active and Windows Firewall
    // on, red = anything less) above the full About text.
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    static void ShowAboutWindow()
    {
        // Draw at the screen's real scaling (e.g. 150%) instead of being stretched by Windows,
        // which otherwise leaves the window larger than its contents on scaled displays.
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        FirewallStatus fw = GetFirewallStatus();
        bool ok = fw.Readable && (fw.State == "active" && fw.FirewallOn || fw.State == "nonetwork");
        string label = fw.State == "nonetwork" ? "no network port" : ok ? "on"
            : !fw.Readable ? "status unknown"
            : fw.State == "none" ? "rules not added"
            : fw.State == "othercopy" ? "not this copy"
            : fw.State == "nonetwork" ? "no network port"
            : !fw.FirewallOn ? "Windows Firewall is off"
            : "rules incomplete";

        System.Drawing.Font ui = new System.Drawing.Font("Segoe UI", 9.5f);
        Form form = new Form();
        form.SuspendLayout();
        // Layout below is in 96-DPI units; Windows Forms scales it to the screen's DPI.
        form.AutoScaleDimensions = new System.Drawing.SizeF(96F, 96F);
        form.AutoScaleMode = AutoScaleMode.Dpi;
        form.Text = "About " + AppName;
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.ClientSize = new System.Drawing.Size(780, 600);
        form.Font = ui;
        try { form.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        Label title = new Label();
        title.Text = AppName + " " + AppVersion;
        title.Font = new System.Drawing.Font("Segoe UI Semibold", 13f);
        title.AutoSize = true;
        title.Location = new System.Drawing.Point(16, 12);

        // The marker: a coloured bar with a dot, like the badge in the viewer window.
        Label marker = new Label();
        marker.AutoSize = false;
        marker.Location = new System.Drawing.Point(16, 50);
        marker.Size = new System.Drawing.Size(748, 46);
        marker.Padding = new Padding(10, 0, 10, 0);
        marker.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
        marker.Font = new System.Drawing.Font("Segoe UI Semibold", 10.5f);
        marker.ForeColor = ok ? System.Drawing.Color.FromArgb(0x1A, 0x7F, 0x37) : System.Drawing.Color.FromArgb(0xCF, 0x22, 0x2E);
        marker.BackColor = ok ? System.Drawing.Color.FromArgb(0xDA, 0xFB, 0xE1) : System.Drawing.Color.FromArgb(0xFF, 0xEB, 0xE9);
        marker.BorderStyle = BorderStyle.FixedSingle;
        marker.Text = "\u25CF  Firewall: " + label + "   \u2014   " + fw.Summary +
                      (fw.Readable ? (fw.FirewallOn ? " \u00B7 Windows Firewall on" : " \u00B7 Windows Firewall OFF") : "");
        ToolTip tip = new ToolTip();
        tip.SetToolTip(marker, fw.Detail);
        marker.AccessibleName = "Firewall: " + label;

        TextBox text = new TextBox();
        text.Multiline = true;
        text.ReadOnly = true;
        text.ScrollBars = ScrollBars.Both;
        text.WordWrap = false;
        text.BackColor = System.Drawing.SystemColors.Window;
        text.Font = new System.Drawing.Font("Consolas", 9.5f);
        text.Location = new System.Drawing.Point(16, 108);
        text.Size = new System.Drawing.Size(748, 436);
        text.Text = AboutText().Replace("\r\n", "\n").Replace("\n", "\r\n");

        Button okButton = new Button();
        okButton.Text = "OK";
        okButton.DialogResult = DialogResult.OK;
        okButton.Size = new System.Drawing.Size(96, 32);
        okButton.Location = new System.Drawing.Point(668, 556);
        form.AcceptButton = okButton;
        form.CancelButton = okButton;

        form.Controls.AddRange(new Control[] { title, marker, text, okButton });
        form.ResumeLayout(true);
        form.Shown += (s, e) => { okButton.Focus(); text.SelectionLength = 0; };
        form.ShowDialog();
    }

#if WEBVIEW2
    // ------------------------------------------------------------------ WebView2 window (no network port)
    // The page lives at a private address that only exists inside this window. Every request it makes is
    // intercepted (WebResourceRequested) and answered by HandleStream - the very same handler the other
    // editions run behind their localhost port - through an in-memory stream instead of a socket.
    const string PrivateHost = "https://mdviewer.local";

    class ViewerForm : Form
    {
        static CoreWebView2Environment env;
        readonly WebView2 web = new WebView2();
        readonly string startUrl;

        public ViewerForm(string url)
        {
            startUrl = url;
            SuspendLayout();
            AutoScaleDimensions = new System.Drawing.SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = AppName;
            ClientSize = new System.Drawing.Size(1200, 860);
            StartPosition = FormStartPosition.WindowsDefaultLocation;
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            web.Dock = DockStyle.Fill;
            Controls.Add(web);
            ResumeLayout(true);
            Load += async (s, e) => await StartAsync();
        }

        async Task StartAsync()
        {
            try
            {
                if (env == null)
                {
                    // Browser data (cache, page storage) stays in this edition's own folder.
                    string data = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), DataFolder), "WebView2");
                    // Developer access stays off: WebView2 would otherwise accept extra browser switches
                    // (e.g. --remote-debugging-port) or another browser/data folder from WEBVIEW2_* variables.
                    foreach (string name in new System.Collections.ArrayList(Environment.GetEnvironmentVariables().Keys))
                        if (name.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase))
                            Environment.SetEnvironmentVariable(name, null);
                    CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                    options.AdditionalBrowserArguments = "";
                    env = await CoreWebView2Environment.CreateAsync(null, data, options);
                }
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show("The Microsoft Edge WebView2 Runtime could not be started:\n" + ex.Message +
                                "\n\nIt is part of Windows 11; it can also be installed from developer.microsoft.com/microsoft-edge/webview2.",
                                AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            CoreWebView2 core = web.CoreWebView2;
            // Last check: if debugging was switched on some other way (e.g. an administrator policy),
            // do not show any document in this window.
            if (DebuggingSwitchedOn((int)core.BrowserProcessId))
            {
                MessageBox.Show("Developer debugging is switched on for WebView2 on this computer, so " + AppName +
                                " will not open documents.\n\nRemove the WebView2 debugging setting (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS or an\n" +
                                "AdditionalBrowserArguments policy) and start it again.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
                return;
            }
            core.Settings.AreDevToolsEnabled = false;          // no F12 / Inspect
            core.Settings.AreHostObjectsAllowed = false;       // the page gets no access to .NET objects
            core.Settings.IsWebMessageEnabled = false;         // ...and no message channel to the program
            core.Settings.IsStatusBarEnabled = false;

            core.AddWebResourceRequestedFilter(PrivateHost + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnRequest;

            // The window only ever shows the private address. Web links open in the default browser;
            // anything else (file:, other schemes) is simply blocked.
            core.NavigationStarting += (s, e) =>
            {
                if (!IsPrivate(e.Uri)) { e.Cancel = true; OpenOutside(e.Uri); }
            };
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (IsPrivate(e.Uri)) new ViewerForm(e.Uri).Show();   // e.g. a linked image from the document's folder
                else OpenOutside(e.Uri);
            };
            core.DocumentTitleChanged += (s, e) => { Text = core.DocumentTitle; };
            core.Navigate(startUrl);
        }

        static bool DebuggingSwitchedOn(int browserPid)
        {
            try
            {
                using (System.Management.ManagementObjectSearcher q = new System.Management.ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + browserPid))
                    foreach (System.Management.ManagementObject o in q.Get())
                    {
                        string cmd = (o["CommandLine"] as string) ?? "";
                        if (cmd.IndexOf("--remote-debugging", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            cmd.IndexOf("--auto-open-devtools", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
            }
            catch { }
            return false;
        }

        static bool IsPrivate(string uri)
        {
            return uri.StartsWith(PrivateHost + "/", StringComparison.OrdinalIgnoreCase);
        }

        static void OpenOutside(string uri)
        {
            if (!(uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                  uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                  uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))) return;
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        void OnRequest(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            // Rebuild the request line exactly as a browser would send it over TCP, run the shared handler,
            // then turn its HTTP response (status, headers incl. Content-Security-Policy, body) into a WebView2 response.
            Uri u = new Uri(e.Request.Uri);
            byte[] request = Encoding.ASCII.GetBytes(e.Request.Method + " " + u.PathAndQuery + " HTTP/1.1\r\n\r\n");
            InMemoryExchange io = new InMemoryExchange(request);
            try { HandleStream(io, current); } catch { }
            e.Response = ToResponse(io.Output.ToArray());
        }

        static CoreWebView2WebResourceResponse ToResponse(byte[] raw)
        {
            int sep = -1;
            for (int i = 0; i + 3 < raw.Length; i++)
                if (raw[i] == 13 && raw[i + 1] == 10 && raw[i + 2] == 13 && raw[i + 3] == 10) { sep = i; break; }
            if (sep < 0) return env.CreateWebResourceResponse(null, 500, "Internal Error", "Content-Type: text/plain");

            string[] lines = Encoding.ASCII.GetString(raw, 0, sep).Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] status = lines[0].Split(new[] { ' ' }, 3);
            int code;
            if (status.Length < 2 || !int.TryParse(status[1], out code)) code = 500;
            StringBuilder headers = new StringBuilder();
            for (int i = 1; i < lines.Length; i++)
            {
                // Length and connection handling are WebView2's job here.
                if (lines[i].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) ||
                    lines[i].StartsWith("Connection:", StringComparison.OrdinalIgnoreCase)) continue;
                if (headers.Length > 0) headers.Append("\r\n");
                headers.Append(lines[i]);
            }
            MemoryStream body = new MemoryStream(raw, sep + 4, raw.Length - sep - 4, false);
            return env.CreateWebResourceResponse(body, code, status.Length > 2 ? status[2] : "", headers.ToString());
        }
    }

    // A stream that reads a prepared request and collects the response - stands in for a TCP socket.
    class InMemoryExchange : Stream
    {
        readonly MemoryStream input;
        public readonly MemoryStream Output = new MemoryStream();
        public InMemoryExchange(byte[] request) { input = new MemoryStream(request); }
        public override int Read(byte[] buffer, int offset, int count) { return input.Read(buffer, offset, count); }
        public override int ReadByte() { return input.ReadByte(); }
        public override void Write(byte[] buffer, int offset, int count) { Output.Write(buffer, offset, count); }
        public override void Flush() { }
        public override bool CanRead { get { return true; } }
        public override bool CanWrite { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
    }
#endif

    // ------------------------------------------------------------------ browser window

    static void OpenWindow(string url)
    {
        string edge = FindEdge();
        if (edge != null)
        {
            ProcessStartInfo psi = new ProcessStartInfo(edge, "--app=\"" + url + "\" --window-size=1200,900");
            psi.UseShellExecute = false;
            Process.Start(psi);
        }
        else
        {
            Process.Start(url); // default browser
        }
    }

    static string FindEdge()
    {
        foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using (RegistryKey k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"))
            {
                string p = k == null ? null : k.GetValue("") as string;
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }
        }
        foreach (string env in new[] { "ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA" })
        {
            string root = Environment.GetEnvironmentVariable(env);
            if (string.IsNullOrEmpty(root)) continue;
            string p = Path.Combine(root, @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }

    // ------------------------------------------------------------------ HTTP server

    static void AcceptLoop(Endpoint ep)
    {
        while (true)
        {
            TcpClient client;
            try { client = ep.Listener.AcceptTcpClient(); }
            catch { return; }                    // listener stopped (old port closed after a rotation)
            ThreadPool.QueueUserWorkItem(_ => Handle(client, ep));
        }
    }

    static void Handle(TcpClient client, Endpoint ep)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 10000;
                HandleStream(client.GetStream(), ep);
            }
            catch { /* client went away */ }
        }
    }

    // One HTTP request in, one response out. Used for TCP connections (online/offline editions) and,
    // through an in-memory stream, for the WebView2 edition's in-app requests - so all editions share
    // exactly the same rules for what may be served.
    static void HandleStream(Stream stream, Endpoint ep)
    {
        {
            {
                string head = ReadHead(stream);
                if (head == null) return;

                string[] requestLine = head.Split(new[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
                if (requestLine.Length < 2) { Send(stream, 400, "text/plain", Encoding.UTF8.GetBytes("Bad request"), null, false); return; }
                string method = requestLine[0];
                bool headOnly = method == "HEAD";
                if (method != "GET" && !headOnly) { Send(stream, 405, "text/plain", Encoding.UTF8.GetBytes("Method not allowed"), null, false); return; }

                string target = requestLine[1];
                int q = target.IndexOf('?');
                string path = q >= 0 ? target.Substring(0, q) : target;

                // Each port only answers to its own token.
                string prefix = "/" + ep.Token + "/";
                if (!path.StartsWith(prefix, StringComparison.Ordinal)) { NotFound(stream); return; }
                string rest = path.Substring(prefix.Length);

                Interlocked.Exchange(ref lastSeenTicks, DateTime.UtcNow.Ticks);
                if (ep == pending) Promote(ep);     // the window has moved to the new port

                if (rest == "ping")
                {
                    connected = true;
                    Send(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(RotationJson()), null, headOnly);
                }
                else if (rest == "firewall")
                {
                    Send(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(FirewallJson()), null, headOnly);
                }
                else if (rest == "forceclose")
                {
                    if (ep == current) ForceCloseOld();
                    Send(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(RotationJson()), null, headOnly);
                }
                else if (rest == "pref")
                {
                    foreach (Match m in Regex.Matches(q >= 0 ? target.Substring(q + 1) : "", @"(?:^|&)(\w+)=(\w+)"))
                        SavePref(m.Groups[1].Value, m.Groups[2].Value);
                    Send(stream, 204, "text/plain", new byte[0], null, headOnly);
                }
                else if (rest == "info") { connected = true; SendInfo(stream, headOnly); }
                else if (rest.StartsWith("app/", StringComparison.Ordinal)) SendAppFile(stream, ep, Uri.UnescapeDataString(rest.Substring(4)), headOnly);
                else if (rest.StartsWith("fs/", StringComparison.Ordinal)) SendDiskFile(stream, Uri.UnescapeDataString(rest.Substring(3)), headOnly);
                else NotFound(stream);
            }
        }
    }

    static string ReadHead(Stream s)
    {
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = s.ReadByte()) != -1)
        {
            sb.Append((char)b);
            if (sb.Length > 16384) return null;
            if (sb.Length >= 4 && sb[sb.Length - 1] == '\n' && sb[sb.Length - 2] == '\r' && sb[sb.Length - 3] == '\n' && sb[sb.Length - 4] == '\r')
                return sb.ToString();
        }
        return null;
    }

    // Bundled libraries (offline edition): only these file types, and only from inside the lib folder.
    static readonly HashSet<string> LibTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".js", ".css", ".woff2", ".woff", ".ttf" };

    static void SendAppFile(Stream s, Endpoint ep, string name, bool headOnly)
    {
        string full;
        if (name.StartsWith("lib/", StringComparison.Ordinal))
        {
            string libDir = Path.Combine(appDir, "lib");
            try { full = Path.GetFullPath(Path.Combine(appDir, name.Replace('/', '\\'))); }
            catch { NotFound(s); return; }
            if (!IsUnder(full, libDir) || !LibTypes.Contains(Path.GetExtension(full))) { NotFound(s); return; }
        }
        else
        {
            if (Array.IndexOf(AppFiles, name) < 0) { NotFound(s); return; }
            full = Path.Combine(appDir, name);
        }
        if (!File.Exists(full)) { NotFound(s); return; }

        string csp = null;
        byte[] body = File.ReadAllBytes(full);
        if (name == "ReadMe.html")
        {
            // Apply saved view settings before the page is shown (no flash of the wrong theme/layout).
            StringBuilder attrs = new StringBuilder();
            foreach (KeyValuePair<string, string> p in LoadPrefs())
                attrs.Append(" data-").Append(p.Key).Append("=\"").Append(p.Value).Append('"');
            if (attrs.Length > 0)
            {
                string html = Encoding.UTF8.GetString(body);
                body = Encoding.UTF8.GetBytes(html.Replace("<html lang=\"en\">", "<html lang=\"en\"" + attrs + ">"));
            }
            // Only the viewer's own script files and the pinned libraries may run; no inline code at all.
            // The offline edition allows no internet address at all (its libraries are under app/lib/).
            string self = ep.AppBase;
            string cdnScripts = Edition != "online" ? "" : " https://cdn.jsdelivr.net https://cdnjs.cloudflare.com";
            string cdnFonts = Edition != "online" ? "" : " https://cdn.jsdelivr.net";
            csp =
                "default-src 'none'; " +
                "script-src " + self + cdnScripts + "; " +
                "style-src 'self' 'unsafe-inline'" + cdnScripts + "; " +
                "font-src 'self' data:" + cdnFonts + "; " +
                "img-src * data: blob:; media-src * data: blob:; connect-src 'self'; " +
                "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
        }
        Send(s, 200, Mime(full), body, csp, headOnly);
    }

    // ------------------------------------------------------------------ settings

    // View settings the page may store, with their allowed values (the first one is the default).
    static readonly Dictionary<string, string[]> PrefValues = new Dictionary<string, string[]>
    {
        { "theme",   new[] { "auto", "light", "dark" } },
        { "sidebar", new[] { "shown", "hidden" } },
        { "toc",     new[] { "shown", "hidden" } },
        { "rotate",  new[] { "15", "off", "5", "30", "60" } },     // minutes between port rotations
        { "hiddenchars", new[] { "off", "on" } }
    };
    static readonly object prefLock = new object();

    static string PrefsFile()
    {
        return Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), DataFolder), "settings.ini");
    }

    // Saved non-default values only (defaults need no attribute on the page).
    static Dictionary<string, string> LoadPrefs()
    {
        Dictionary<string, string> prefs = new Dictionary<string, string>();
        lock (prefLock)
        {
            string[] lines;
            try { lines = File.ReadAllLines(PrefsFile()); } catch { return prefs; }
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string k = line.Substring(0, eq).Trim(), v = line.Substring(eq + 1).Trim();
                string[] allowed;
                if (PrefValues.TryGetValue(k, out allowed) && Array.IndexOf(allowed, v) > 0) prefs[k] = v;
            }
        }
        return prefs;
    }

    static void SavePref(string name, string value)
    {
        string[] allowed;
        if (!PrefValues.TryGetValue(name, out allowed) || Array.IndexOf(allowed, value) < 0) return;
        lock (prefLock)
        {
            try
            {
                Dictionary<string, string> prefs = LoadPrefs();
                prefs[name] = value;
                StringBuilder sb = new StringBuilder();
                foreach (KeyValuePair<string, string> p in prefs)
                    if (Array.IndexOf(PrefValues[p.Key], p.Value) > 0) sb.Append(p.Key).Append('=').Append(p.Value).Append("\r\n");
                Directory.CreateDirectory(Path.GetDirectoryName(PrefsFile()));
                File.WriteAllText(PrefsFile(), sb.ToString());
            }
            catch { }
        }
    }

    static void SendDiskFile(Stream s, string webPath, bool headOnly)
    {
        string full;
        try { full = Path.GetFullPath(webPath.Replace('/', '\\')); }
        catch { NotFound(s); return; }

        if (allowRoot == null || !IsUnder(full, allowRoot) || !ServedTypes.Contains(Path.GetExtension(full)))
        {
            Send(s, 403, "text/plain", Encoding.UTF8.GetBytes("Forbidden"), null, headOnly);
            return;
        }
        if (!File.Exists(full)) { NotFound(s); return; }

        // Every file from disk is sandboxed with no script permission, so even an SVG opened
        // on its own (not as an <img>) can never run code.
        const string csp = "sandbox; default-src 'none'; img-src * data:; media-src *; style-src 'unsafe-inline' *; font-src *";
        Send(s, 200, Mime(full), File.ReadAllBytes(full), csp, headOnly);
    }

    static void SendInfo(Stream s, bool headOnly)
    {
        List<string> files = new List<string>();
        if (startDir != null) CollectMarkdown(startDir, 0, files);

        StringBuilder sb = new StringBuilder("{");
        sb.Append("\"file\":").Append(Json(startFile == null ? null : ToWeb(startFile))).Append(',');
        sb.Append("\"dir\":").Append(Json(startDir == null ? null : ToWeb(startDir) + "/")).Append(',');
        sb.Append("\"repoRoot\":").Append(Json(repoRoot == null ? null : ToWeb(repoRoot) + "/")).Append(',');
        sb.Append("\"files\":[");
        for (int i = 0; i < files.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Json(ToWeb(files[i]))); }
        sb.Append("],");
        List<string> served = new List<string>(ServedTypes);
        served.Sort(StringComparer.OrdinalIgnoreCase);
        sb.Append("\"app\":{\"name\":").Append(Json(AppName))
          .Append(",\"version\":").Append(Json(AppVersion))
          .Append(",\"edition\":").Append(Json(Edition))
          .Append(",\"runtime\":").Append(Json(".NET Framework CLR " + Environment.Version))
          .Append(",\"installDir\":").Append(Json(appDir.TrimEnd('\\')))
          .Append(",\"readableFolder\":").Append(Json(allowRoot))
          .Append(",\"servedTypes\":").Append(Json(string.Join(" ", served.ToArray())))
          .Append("}}");
        Send(s, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(sb.ToString()), null, headOnly);
    }

    static void CollectMarkdown(string dir, int depth, List<string> files)
    {
        if (files.Count >= 500) return;
        try
        {
            foreach (string f in Directory.GetFiles(dir))
            {
                string ext = Path.GetExtension(f).ToLowerInvariant();
                if (ext == ".md" || ext == ".markdown" || ext == ".mdown" || ext == ".mkd") files.Add(f);
                if (files.Count >= 500) return;
            }
            if (depth >= 4) return;
            foreach (string d in Directory.GetDirectories(dir))
            {
                if (SkipDirs.Contains(Path.GetFileName(d))) continue;
                if ((File.GetAttributes(d) & FileAttributes.ReparsePoint) != 0) continue;
                CollectMarkdown(d, depth + 1, files);
            }
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
    }

    static void NotFound(Stream s)
    {
        Send(s, 404, "text/plain", Encoding.UTF8.GetBytes("Not found"), null, false);
    }

    static void Send(Stream s, int status, string mime, byte[] body, string csp, bool headOnly)
    {
        string reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 403 ? "Forbidden"
                      : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Bad Request";
        StringBuilder h = new StringBuilder();
        h.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        h.Append("Content-Type: ").Append(mime).Append("\r\n");
        h.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        h.Append("Cache-Control: no-store\r\n");
        h.Append("X-Content-Type-Options: nosniff\r\n");
        h.Append("Referrer-Policy: no-referrer\r\n");
        if (csp != null) h.Append("Content-Security-Policy: ").Append(csp).Append("\r\n");
        h.Append("Connection: close\r\n\r\n");
        byte[] hb = Encoding.ASCII.GetBytes(h.ToString());
        s.Write(hb, 0, hb.Length);
        if (!headOnly && body.Length > 0) s.Write(body, 0, body.Length);
        s.Flush();
    }

    // ------------------------------------------------------------------ helpers

    static string FindGitRoot(string dir)
    {
        DirectoryInfo d = new DirectoryInfo(dir);
        while (d != null)
        {
            if (Directory.Exists(Path.Combine(d.FullName, ".git")) || File.Exists(Path.Combine(d.FullName, ".git")))
                return d.FullName;
            d = d.Parent;
        }
        return null;
    }

    static bool IsUnder(string full, string root)
    {
        string r = root.TrimEnd('\\') + "\\";
        return full.StartsWith(r, StringComparison.OrdinalIgnoreCase);
    }

    static string ToWeb(string p) { return p.Replace('\\', '/').TrimEnd('/'); }

    static string RandomHex(int bytes)
    {
        byte[] b = new byte[bytes];
        using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
        return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    }

    static string Json(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string Mime(string path)
    {
        switch (Path.GetExtension(path).ToLowerInvariant())
        {
            case ".html": case ".htm": return "text/html; charset=utf-8";
            case ".js": case ".mjs": return "text/javascript; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".md": case ".markdown": case ".mdown": case ".mkd": case ".txt": return "text/plain; charset=utf-8";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".gif": return "image/gif";
            case ".webp": return "image/webp";
            case ".avif": return "image/avif";
            case ".bmp": return "image/bmp";
            case ".ico": return "image/x-icon";
            case ".svg": return "image/svg+xml";
            case ".mp4": return "video/mp4";
            case ".webm": return "video/webm";
            case ".mp3": return "audio/mpeg";
            case ".wav": return "audio/wav";
            case ".ogg": return "audio/ogg";
            case ".woff2": return "font/woff2";
            case ".woff": return "font/woff";
            case ".ttf": return "font/ttf";
            default: return "application/octet-stream";
        }
    }
}
