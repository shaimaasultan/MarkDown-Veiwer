// Markdown Viewer (WebView2) - desktop app.
//
// Opens a .md file in the HTML viewer (ReadMe.html) inside the program's own window, using Microsoft's
// WebView2 control. The page lives at a private address (https://mdviewer.example) that exists only inside
// this window: every request it makes is intercepted and answered in-process. There is no web server
// and no network port at all.
//
// Build: build.ps1 -WebView2 (uses the C# compiler that ships with Windows / .NET Framework 4,
// plus the WebView2 SDK files in ..\webview2).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Markdown Viewer (WebView2, preview only)")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyDescription("Previews Markdown files with figures, math and diagrams. Never runs code from a document.")]
[assembly: AssemblyCopyright("Markdown Viewer")]
[assembly: AssemblyVersion("1.4.0.0")]
[assembly: AssemblyFileVersion("1.4.0.0")]
[assembly: AssemblyInformationalVersion("1.4.0")]

static class Program
{
    const string AppName = "Markdown Viewer (WebView2)";
    const string DataFolder = "MarkdownViewerWebView2";     // %APPDATA% (settings) and %LOCALAPPDATA% (browser data)
    const string AppVersion = "1.4.0";
    // Exists only inside this program's windows. Not a .local name: Windows would first spend ~2 s
    // looking for a device called "mdviewer" on the local network before the page could load.
    const string PrivateHost = "https://mdviewer.example";

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

    // Bundled libraries: only these file types, and only from inside the lib folder.
    static readonly HashSet<string> LibTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".js", ".css", ".woff2", ".woff", ".ttf" };

    static string appDir, startFile, startDir, repoRoot, allowRoot;

    // Random per-run token every page address must start with.
    static readonly string Token = RandomHex(16);
    static string AppBase { get { return PrivateHost + "/" + Token + "/app/"; } }

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
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();

        foreach (string a in args)
        {
            if (a == "--about")
            {
                ShowAboutWindow();
                return 0;
            }
            if (startFile == null) startFile = Path.GetFullPath(a);
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

        string startUrl = AppBase + "ReadMe.html";
        if (startFile != null) startUrl += "?file=" + Uri.EscapeDataString(ToWeb(startFile));
        Application.Run(new ViewerForm(startUrl));
        return 0;
    }

    // ------------------------------------------------------------------ status for the page

    // Firewall rules are not needed (nothing listens on the network); only Windows Firewall itself is reported.
    static bool WindowsFirewallOn()
    {
        try
        {
            dynamic fwPolicy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
            int prof = fwPolicy.CurrentProfileTypes;
            foreach (int bit in new[] { 1, 2, 4 })
                if ((prof & bit) != 0 && !(bool)fwPolicy.FirewallEnabled[bit]) return false;
        }
        catch { }
        return true;
    }

    const string FirewallSummary = "Not needed - no network port";
    const string FirewallDetail = "This app shows documents inside its own window (WebView2); nothing listens on the network, so there is nothing for firewall rules to protect.";

    static string FirewallJson()
    {
        return "{\"readable\":true,\"firewallOn\":" + (WindowsFirewallOn() ? "true" : "false") +
               ",\"state\":\"nonetwork\",\"summary\":" + Json(FirewallSummary) +
               ",\"detail\":" + Json(FirewallDetail) + ",\"rules\":[]}";
    }

    // ------------------------------------------------------------------ about

    class Library { public string Name, Use, Version, File; }

    // Library versions, read from the installed viewer files so they always match what actually loads
    // (same rule as the About window inside the viewer).
    static List<Library> Libraries()
    {
        string html = "";
        try { html = File.ReadAllText(Path.Combine(appDir, "ReadMe.html"), Encoding.UTF8); } catch { }
        // Versions of the bundled copies, recorded by build.ps1.
        Dictionary<string, string> versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        Match vm = Regex.Match(html, "name=\"mdv-lib-versions\" content=\"([^\"]*)\"");
        if (vm.Success)
            foreach (string pair in vm.Groups[1].Value.Split(';'))
            {
                string[] kv = pair.Split('=');
                if (kv.Length == 2) versions[kv[0].Trim()] = kv[1].Trim();
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
        libs.Add(new Library { Name = "marked", Use = "Markdown to HTML", Version = markedVersion, File = "marked.min.js" });
        string[,] known =
        {
            { "KaTeX", "Math equations", "katex", @"lib\katex" },
            { "highlight.js", "Code colouring", "highlight.js", @"lib\highlight" },
            { "Mermaid", "Diagrams", "mermaid", @"lib\mermaid" }
        };
        for (int i = 0; i < known.GetLength(0); i++)
        {
            string v;
            if (!versions.TryGetValue(known[i, 2], out v)) v = "?";
            libs.Add(new Library { Name = known[i, 0], Use = known[i, 1], Version = v, File = known[i, 3] });
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
        sb.AppendLine("NO NETWORK PORT: the page is shown at a private address inside this window and every");
        sb.AppendLine("request is answered by the program itself. Developer tools are off, and the app will not");
        sb.AppendLine("show documents if WebView2 debugging has been switched on.");
        sb.AppendLine();
        sb.AppendLine("LIBRARIES (all bundled - this app never needs the internet):");
        foreach (Library lib in Libraries())
        {
            sb.AppendLine();
            sb.AppendLine("- " + lib.Name + " " + lib.Version + "  (" + lib.Use + ")");
            sb.AppendLine("     " + lib.File + " (bundled)");
        }
        sb.AppendLine();
        sb.AppendLine("BUILT WITH:");
        sb.AppendLine("- Windows app: C# 5, compiled with csc.exe from .NET Framework 4 (included with Windows);");
        sb.AppendLine("     running on .NET Framework CLR " + Environment.Version);
        string wvRuntime, wvSdk;
        WebView2Versions(out wvRuntime, out wvSdk);
        sb.AppendLine("- Window: own window with the WebView2 control - WebView2 Runtime " + (wvRuntime ?? "(not found)") +
                      ", WebView2 SDK " + (wvSdk ?? "?") + " (Microsoft.Web.WebView2)");
        sb.AppendLine("- Installer: PowerShell scripts (build, install, uninstall); per-user file association, no admin rights");
        sb.AppendLine("- Viewer: HTML, CSS and JavaScript, no frameworks");
        sb.AppendLine("- Made using: GPT-5 (original viewer); extended and tested with Claude Code (Anthropic)");
        sb.AppendLine();
        sb.AppendLine("FIREWALL RULES: " + FirewallSummary + (WindowsFirewallOn() ? " (Windows Firewall is on)" : " (Windows Firewall is OFF)"));
        sb.AppendLine("     " + FirewallDetail);
        sb.AppendLine();
        sb.Append("Installed in: " + appDir.TrimEnd('\\'));
        return sb.ToString();
    }

    // Installed WebView2 Runtime (updates with Windows/Edge) and the SDK this program was built with.
    static void WebView2Versions(out string runtime, out string sdk)
    {
        runtime = null; sdk = null;
        try { runtime = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
        try { sdk = FileVersionInfo.GetVersionInfo(typeof(CoreWebView2Environment).Assembly.Location).FileVersion; } catch { }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    // Native About window: a green "no network port" marker above the full About text.
    static void ShowAboutWindow()
    {
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
        bool fwOn = WindowsFirewallOn();
        Label marker = new Label();
        marker.AutoSize = false;
        marker.Location = new System.Drawing.Point(16, 50);
        marker.Size = new System.Drawing.Size(748, 46);
        marker.Padding = new Padding(10, 0, 10, 0);
        marker.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
        marker.Font = new System.Drawing.Font("Segoe UI Semibold", 10.5f);
        marker.ForeColor = System.Drawing.Color.FromArgb(0x1A, 0x7F, 0x37);
        marker.BackColor = System.Drawing.Color.FromArgb(0xDA, 0xFB, 0xE1);
        marker.BorderStyle = BorderStyle.FixedSingle;
        marker.Text = "\u25CF  Firewall: no network port   \u2014   " + FirewallSummary +
                      (fwOn ? " \u00B7 Windows Firewall on" : " \u00B7 Windows Firewall OFF");
        ToolTip tip = new ToolTip();
        tip.SetToolTip(marker, FirewallDetail);
        marker.AccessibleName = "Firewall: no network port";

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

    // ------------------------------------------------------------------ viewer window
    // Every request the page makes to the private address is intercepted (WebResourceRequested) and
    // answered by HandleStream through an in-memory stream.

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
                    // Browser data (cache, page storage) stays in this app's own folder.
                    string data = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), DataFolder), "WebView2");
                    // Developer access stays off: WebView2 would otherwise accept extra browser switches
                    // (e.g. --remote-debugging-port) or another browser/data folder from WEBVIEW2_* variables.
                    foreach (string name in new System.Collections.ArrayList(Environment.GetEnvironmentVariables().Keys))
                        if (name.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase))
                            Environment.SetEnvironmentVariable(name, null);
                    CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                    // No background traffic from the engine itself: no component updates, field trials,
                    // reliability reports, hyperlink pings or other background requests.
                    options.AdditionalBrowserArguments = "--disable-background-networking --disable-component-update" +
                                                         " --disable-domain-reliability --no-pings";
                    options.IsCustomCrashReportingEnabled = true;           // crash reports stay on this PC
                    options.AllowSingleSignOnUsingOSPrimaryAccount = false; // never signs in with the Windows account
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
            // SmartScreen would send addresses to Microsoft for checking. This window only ever shows the
            // private address; web links open in the default browser, which does its own checking.
            core.Settings.IsReputationCheckingRequired = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;

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
            // Hand the request line to the handler, then turn its HTTP-style response
            // (status, headers incl. Content-Security-Policy, body) into a WebView2 response.
            Uri u = new Uri(e.Request.Uri);
            byte[] request = Encoding.ASCII.GetBytes(e.Request.Method + " " + u.PathAndQuery + " HTTP/1.1\r\n\r\n");
            InMemoryExchange io = new InMemoryExchange(request);
            try { HandleStream(io); } catch { }
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

    // A stream that reads a prepared request and collects the response.
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

    // ------------------------------------------------------------------ request handler

    // One request in, one response out.
    static void HandleStream(Stream stream)
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

        // Every address must start with this run's token.
        string prefix = "/" + Token + "/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal)) { NotFound(stream); return; }
        string rest = path.Substring(prefix.Length);

        if (rest == "firewall")
            Send(stream, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(FirewallJson()), null, headOnly);
        else if (rest == "pref")
        {
            foreach (Match m in Regex.Matches(q >= 0 ? target.Substring(q + 1) : "", @"(?:^|&)(\w+)=(\w+)"))
                SavePref(m.Groups[1].Value, m.Groups[2].Value);
            Send(stream, 204, "text/plain", new byte[0], null, headOnly);
        }
        else if (rest == "info") SendInfo(stream, headOnly);
        else if (rest.StartsWith("app/", StringComparison.Ordinal)) SendAppFile(stream, Uri.UnescapeDataString(rest.Substring(4)), headOnly);
        else if (rest.StartsWith("fs/", StringComparison.Ordinal)) SendDiskFile(stream, Uri.UnescapeDataString(rest.Substring(3)), headOnly);
        else NotFound(stream);
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

    static void SendAppFile(Stream s, string name, bool headOnly)
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
            // Only the viewer's own script files and the bundled libraries may run; no inline code and
            // no internet address at all.
            csp =
                "default-src 'none'; " +
                "script-src " + AppBase + "; " +
                "style-src 'self' 'unsafe-inline'; " +
                "font-src 'self' data:; " +
                "img-src * data: blob:; media-src * data: blob:; connect-src 'self'; " +
                "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
        }
        Send(s, 200, Mime(full), body, csp, headOnly);
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
        string wvRuntime, wvSdk;
        WebView2Versions(out wvRuntime, out wvSdk);
        sb.Append("\"app\":{\"name\":").Append(Json(AppName))
          .Append(",\"version\":").Append(Json(AppVersion))
          .Append(",\"runtime\":").Append(Json(".NET Framework CLR " + Environment.Version))
          .Append(",\"installDir\":").Append(Json(appDir.TrimEnd('\\')))
          .Append(",\"readableFolder\":").Append(Json(allowRoot))
          .Append(",\"servedTypes\":").Append(Json(string.Join(" ", served.ToArray())))
          .Append(",\"webview2Runtime\":").Append(Json(wvRuntime))
          .Append(",\"webview2Sdk\":").Append(Json(wvSdk))
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
        h.Append("Cache-Control: no-store\r\n");
        h.Append("X-Content-Type-Options: nosniff\r\n");
        h.Append("Referrer-Policy: no-referrer\r\n");
        if (csp != null) h.Append("Content-Security-Policy: ").Append(csp).Append("\r\n");
        h.Append("\r\n");
        byte[] hb = Encoding.ASCII.GetBytes(h.ToString());
        s.Write(hb, 0, hb.Length);
        if (!headOnly && body.Length > 0) s.Write(body, 0, body.Length);
        s.Flush();
    }

    // ------------------------------------------------------------------ settings

    // View settings the page may store, with their allowed values (the first one is the default).
    static readonly Dictionary<string, string[]> PrefValues = new Dictionary<string, string[]>
    {
        { "theme",   new[] { "auto", "light", "dark" } },
        { "sidebar", new[] { "shown", "hidden" } },
        { "toc",     new[] { "shown", "hidden" } },
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
