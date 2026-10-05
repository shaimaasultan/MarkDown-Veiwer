// Markdown Viewer (WebView2) - desktop app.
//
// Opens a .md file in the HTML viewer (viewer.html) inside the program's own window, using Microsoft's
// WebView2 control. The page and its libraries are resources of the signed MarkdownViewerWebView2.Content.dll
// (no loose script files); at every start the program checks its own signature, the Content DLL's (same
// certificate) and Microsoft's on the WebView2 files. The page lives at a private address (https://mdviewer.example) that exists only inside
// this window: every request it makes is intercepted and answered in-process. There is no web server
// and no network port at all.
//
// Build: build.ps1 (uses the C# compiler that ships with Windows / .NET Framework 4, plus the WebView2
// SDK files in ..\webview2), which also builds and signs the Content DLL.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

[assembly: AssemblyTitle("Markdown Viewer (WebView2, preview only)")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyDescription("Previews Markdown files with figures, math and diagrams. Never runs code from a document.")]
[assembly: AssemblyCopyright("Markdown Viewer")]
// The program's own calls into Windows DLLs (user32, kernel32, advapi32, wintrust) load them from System32
// only, never from the program's folder or anywhere else on the search path.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
[assembly: AssemblyVersion("1.8.8.0")]
[assembly: AssemblyFileVersion("1.8.8.0")]
[assembly: AssemblyInformationalVersion("1.8.8")]

static class Program
{
    const string AppName = "Markdown Viewer (WebView2)";
    const string DataFolder = "MarkdownViewerWebView2";     // %APPDATA% (settings) and %LOCALAPPDATA% (browser data)
    const string AppVersion = "1.8.8";
    // Exists only inside this program's windows. Not a .local name: Windows would first spend ~2 s
    // looking for a device called "mdviewer" on the local network before the page could load.
    const string PrivateHost = "https://mdviewer.example";

    // Page files: resources of the signed Content DLL (named by their path, e.g. "lib/katex/katex.min.js").
    const string ContentDll = "MarkdownViewerWebView2.Content.dll";
    static readonly string[] AppFiles = { "viewer.html", "viewer.js", "marked.min.js", "favicon_readme.png" };
    static readonly string[] MicrosoftFiles = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };

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

    // Largest file handed out from disk (it is read into memory whole): text and SVG, and media.
    static readonly HashSet<string> TextTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".md", ".markdown", ".mdown", ".mkd", ".txt", ".svg" };
    const long MaxTextBytes = 50L << 20, MaxMediaBytes = 200L << 20;

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
            appDir = AppDomain.CurrentDomain.BaseDirectory;
            ProtectDllLoading();
            // Before anything is loaded from the WebView2 files or the Content DLL.
            string problem = CheckElevation() ?? CheckStartupHooks() ?? CheckFolder() ?? CheckSignatures();
            if (problem != null)
            {
                MessageBox.Show(problem, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            try { RepairRegistrations(Application.ExecutablePath); } catch { }
            try { CatchUnexpectedErrors(); } catch { }
            return Run(args);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // Kept out of Main so that nothing from the WebView2 files is loaded before CheckSignatures has run.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(string[] args)
    {
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

        string startUrl = AppBase + "viewer.html";
        if (startFile != null) startUrl += "?file=" + Uri.EscapeDataString(ToWeb(startFile));
        Application.Run(new ViewerForm(startUrl));
        return 0;
    }

    // ------------------------------------------------------------------ signatures

    class SignatureInfo
    {
        public int Status = unchecked((int)0x800B0100);     // TRUST_E_NOSIGNATURE
        public string Subject, Thumbprint;
        // The file is exactly as it was signed. A certificate made on this PC is not in Windows' trusted
        // list (untrusted root), but the check of the file's contents is the same.
        public bool Intact
        {
            get { return Subject != null && (Status == 0 || Status == unchecked((int)0x800B0109) || Status == unchecked((int)0x800B010A)); }
        }
        public bool Trusted { get { return Status == 0; } }
        public string Signer
        {
            get
            {
                if (Subject == null) return null;
                Match m = Regex.Match(Subject, @"CN=(""[^""]*""|[^,]*)");
                return m.Success ? m.Groups[1].Value.Trim('"') : Subject;
            }
        }
    }

    static SignatureInfo signature;          // this program's, after a successful check

    // Windows' DLL-loading rules for this process, from here on: system DLLs from System32 before any copy
    // in the program's folder, never from a network share or from files written by low-integrity
    // (sandboxed) processes, and never from the current folder or PATH. The legacy ways other programs push
    // a DLL into every process are switched off too: AppInit_DLLs, global window hooks, legacy (non-TSF)
    // input methods and Winsock layered providers.
    static void ProtectDllLoading()
    {
        try { SetDefaultDllDirectories(0x1000); } catch { }        // LOAD_LIBRARY_SEARCH_DEFAULT_DIRS
        try
        {
            // ProcessImageLoadPolicy: NoRemoteImages | NoLowMandatoryLabelImages | PreferSystem32Images
            int flags = 0x1 | 0x2 | 0x4;
            SetProcessMitigationPolicy(10, ref flags, (IntPtr)4);
        }
        catch { }
        try
        {
            // ProcessExtensionPointDisablePolicy: DisableExtensionPoints
            int flags = 0x1;
            SetProcessMitigationPolicy(6, ref flags, (IntPtr)4);
        }
        catch { }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetDefaultDllDirectories(uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessMitigationPolicy(int policy, ref int buffer, IntPtr length);

    // A document viewer never needs administrator rights. Started elevated by accident (a .md opened from
    // an administrator prompt or another elevated program) while a normal start is possible, it refuses.
    // With User Account Control off there is no normal start to fall back on, so it runs as it is.
    static string CheckElevation()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out token)) return null;
        try
        {
            int type, size;
            if (GetTokenInformation(token, 18 /* TokenElevationType */, out type, 4, out size) && type == 2 /* Full */)
                return AppName + " was started with administrator rights. It never needs them, and a document\n" +
                       "should not be viewed with them.\n\nOpen the file again normally (double-click it in File Explorer).";
        }
        finally { CloseHandle(token); }
        return null;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    // .NET Framework loads a profiler DLL (COR_ENABLE_PROFILING / COR_PROFILER) or an AppDomain manager
    // (APPDOMAIN_MANAGER_ASM / _TYPE) named by environment variables into any .NET program at start. Neither
    // has a place in this app: if one is set, it refuses to go on. (DOTNET_STARTUP_HOOKS is a .NET Core
    // feature; .NET Framework never reads it.)
    static string CheckStartupHooks()
    {
        List<string> found = new List<string>();
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
        {
            string name = ((string)e.Key).ToUpperInvariant(), value = (e.Value as string ?? "").Trim();
            if (value.Length == 0) continue;
            if ((name == "COR_ENABLE_PROFILING" || name == "COMPLUS_ENABLEPROFILING") && value != "0") found.Add(e.Key as string);
            else if (name.StartsWith("COR_PROFILER", StringComparison.Ordinal) || name.StartsWith("APPDOMAIN_MANAGER_", StringComparison.Ordinal))
                found.Add(e.Key as string);
        }
        if (found.Count == 0) return null;
        found.Sort(StringComparer.OrdinalIgnoreCase);
        return "These settings would make .NET load extra code into " + AppName + ":\n\n  " + string.Join("\n  ", found) +
               "\n\n" + AppName + " will not start. Remove them (Settings > System > About > Advanced system settings >\n" +
               "Environment Variables) unless you know which program added them and why.";
    }

    // Only the program's own files may be in its folder. Windows looks there first for many DLLs, and .NET
    // for configuration; an extra file or folder (a planted DLL, a ".local" redirection folder) stops the start.
    // source-manifest.txt: the project files' SHA-256 at install time (a text file, never loaded as code);
    // check-source.ps1: the checker Check-Source.cmd runs from here.
    static readonly string[] FolderFiles = { "MarkdownViewer.ico", "uninstall.ps1", "firewall.ps1", "trust.ps1", "source-manifest.txt", "check-source.ps1" };

    static string CheckFolder()
    {
        HashSet<string> allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFileName(Application.ExecutablePath), ContentDll };
        allowed.UnionWith(MicrosoftFiles);
        allowed.UnionWith(FolderFiles);
        List<string> extra = new List<string>();
        foreach (string e in Directory.GetFileSystemEntries(appDir))
            if (!allowed.Contains(Path.GetFileName(e)) || Directory.Exists(e)) extra.Add(Path.GetFileName(e));
        if (extra.Count == 0) return null;
        return "The program's folder contains " + (extra.Count == 1 ? "something that is" : "things that are") + " not part of " + AppName + ":\n\n  " +
               string.Join("\n  ", extra.GetRange(0, Math.Min(extra.Count, 8))) + (extra.Count > 8 ? "\n  ..." : "") +
               "\n\nWindows or .NET could load code from there into the program, so " + AppName + " will not start.\n" +
               "Reinstall it (app\\Install.cmd), which removes them, or delete them from\n" + appDir;
    }

    // The checked files stay open until the program ends, shared for reading only: they cannot be changed,
    // replaced, renamed or deleted between the check and the moment they are loaded (the Content DLL only
    // when the page first asks for a file). The folder itself cannot be renamed either.
    static readonly List<IDisposable> locks = new List<IDisposable>();

    static void Lock(string path)
    {
        if (!File.Exists(path)) return;     // reported as missing by the signature check
        locks.Add(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read));
    }

    static void LockFolder()
    {
        // FILE_LIST_DIRECTORY, shared for read and write but not delete (so no rename), FILE_FLAG_BACKUP_SEMANTICS
        SafeFileHandle h = CreateFileW(appDir.TrimEnd('\\'), 0x1, 0x1 | 0x2, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (h.IsInvalid) throw new IOException("The program's folder could not be opened (error " + Marshal.GetLastWin32Error() + ").");
        locks.Add(h);
    }

    // The program and its Content DLL must be signed by the same certificate and unchanged since; the
    // WebView2 files must carry Microsoft's valid signature and be exactly the files the program was built
    // with (their SHA-256 is part of the signed program, so an older or other Microsoft file is refused too).
    // A .config file next to the program could send .NET to load copies from elsewhere, unchecked: refused.
    static string CheckSignatures()
    {
        string config = AppDomain.CurrentDomain.SetupInformation.ConfigurationFile;
        if (!string.IsNullOrEmpty(config) && File.Exists(config))
            return Path.GetFileName(Application.ExecutablePath) + ".config was found next to the program. It could make " + AppName +
                   " load files other than the ones it checks.\n\n" + AppName + " will not start. Delete that file or reinstall it (app\\Install.cmd).";
        if (AppDomain.CurrentDomain.DomainManager != null)
            return "Something has changed how .NET starts this program.\n\n" + AppName + " will not start. Reinstall it (app\\Install.cmd).";
        // Locked first, so the files checked below are the files that will be loaded.
        LockFolder();
        Lock(Application.ExecutablePath);
        Lock(Path.Combine(appDir, ContentDll));
        foreach (string f in MicrosoftFiles) Lock(Path.Combine(appDir, f));
        SignatureInfo self = Signature(Application.ExecutablePath);
        if (!self.Intact) return Tampered(Path.GetFileName(Application.ExecutablePath), self);
        SignatureInfo content = Signature(Path.Combine(appDir, ContentDll));
        if (!content.Intact) return Tampered(ContentDll, content);
        if (content.Thumbprint != self.Thumbprint)
            return ContentDll + " is signed by \"" + content.Signer + "\", not by the certificate of this program.\n\nReinstall " + AppName + ".";
        foreach (string f in MicrosoftFiles)
        {
            SignatureInfo ms = Signature(Path.Combine(appDir, f));
            if (!ms.Trusted || ms.Subject.IndexOf("O=Microsoft Corporation,", StringComparison.Ordinal) < 0) return Tampered(f, ms);
            if (!PinnedFiles.Matches(f, Sha256(Path.Combine(appDir, f))))
                return f + " cannot be trusted: it is signed by Microsoft but is not the version " + AppName +
                       " was built with.\n\n" + AppName + " will not start. Reinstall it (app\\Install.cmd).";
        }
        signature = self;
        return null;
    }

    static string Sha256(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream fs = File.OpenRead(path))
            return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "");
    }

    static string Tampered(string file, SignatureInfo s)
    {
        string why = !File.Exists(Path.Combine(appDir, file)) ? "it is missing"
                   : s.Subject == null ? "it is not signed"
                   : s.Status == unchecked((int)0x80096010) ? "it has been changed since it was signed"
                   : "its signature is not valid (0x" + s.Status.ToString("X8") + ")";
        return file + " cannot be trusted: " + why + ".\n\n" + AppName + " will not start. Reinstall it (app\\Install.cmd).";
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    class WinTrustFileInfo
    {
        public uint cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo));
        public string pcwszFilePath;
        public IntPtr hFile = IntPtr.Zero, pgKnownSubject = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    class WinTrustData
    {
        public uint cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustData));
        public IntPtr pPolicyCallbackData = IntPtr.Zero, pSIPClientData = IntPtr.Zero;
        public uint dwUIChoice = 2;                 // WTD_UI_NONE
        public uint fdwRevocationChecks = 0;        // WTD_REVOKE_NONE
        public uint dwUnionChoice = 1;              // WTD_CHOICE_FILE
        public IntPtr pFile;
        public uint dwStateAction = 0;
        public IntPtr hWVTStateData = IntPtr.Zero, pwszURLReference = IntPtr.Zero;
        // Never goes online for the check: cached certificate data only, no revocation lookups.
        public uint dwProvFlags = 0x1000 /* WTD_CACHE_ONLY_URL_RETRIEVAL */ | 0x10 /* WTD_REVOCATION_CHECK_NONE */;
        public uint dwUIContext = 0;
        public IntPtr pSignatureSettings = IntPtr.Zero;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, WinTrustData data);

    static readonly Guid VerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");   // WINTRUST_ACTION_GENERIC_VERIFY_V2

    static SignatureInfo Signature(string path)
    {
        SignatureInfo s = new SignatureInfo();
        if (!File.Exists(path)) return s;
        WinTrustFileInfo file = new WinTrustFileInfo { pcwszFilePath = path };
        WinTrustData data = new WinTrustData();
        data.pFile = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WinTrustFileInfo)));
        try
        {
            Marshal.StructureToPtr(file, data.pFile, false);
            s.Status = WinVerifyTrust(IntPtr.Zero, VerifyV2, data);
        }
        finally
        {
            Marshal.DestroyStructure(data.pFile, typeof(WinTrustFileInfo));
            Marshal.FreeCoTaskMem(data.pFile);
        }
        try
        {
            X509Certificate2 cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            s.Subject = cert.Subject;
            s.Thumbprint = cert.Thumbprint;
        }
        catch { }
        return s;
    }

    // ------------------------------------------------------------------ unexpected errors

    // An unexpected error is logged and the window keeps running, instead of a crash: a crash would hand
    // Windows Error Reporting a memory dump of the process, which can hold the open document. The log
    // (%LOCALAPPDATA%\MarkdownViewerWebView2\errors.log) gets the error's type and stack only - never its
    // message, which can quote document text or file paths.
    static void CatchUnexpectedErrors()
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => LogError(e.Exception);
        TaskScheduler.UnobservedTaskException += (s, e) => { LogError(e.Exception); e.SetObserved(); };
        // An error on another thread cannot be survived: log it and end without a crash dump.
        AppDomain.CurrentDomain.UnhandledException += (s, e) => { LogError(e.ExceptionObject as Exception); Environment.Exit(3); };
    }

    static void LogError(Exception ex)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), DataFolder);
            Directory.CreateDirectory(dir);
            string log = Path.Combine(dir, "errors.log");
            if (File.Exists(log) && new FileInfo(log).Length > 256 * 1024) File.Delete(log);
            StringBuilder sb = new StringBuilder();
            sb.Append(DateTime.Now.ToString("s")).Append("  ").Append(AppName).Append(' ').Append(AppVersion).Append("\r\n");
            for (Exception e = ex; e != null; e = e.InnerException)
                sb.Append(e.GetType().FullName).Append("\r\n").Append(e.StackTrace).Append("\r\n");
            File.AppendAllText(log, sb.Append("\r\n").ToString());
        }
        catch { }
    }

    // ------------------------------------------------------------------ Windows registrations

    // The entries the installer made (Open for .md files, "Open with", pictures/video/audio). An entry that
    // points to a deleted copy is a risk: any program running as you could put its own program there, and
    // opening a .md file would start it. An installed copy corrects such entries at start; the Program Files
    // copy also corrects entries pointing to any other copy. Development builds and copies run from other
    // folders never touch them, and entries that are not there (e.g. after uninstalling) are not added.
    static readonly string[] RegistrationKeys =
    {
        @"Software\Classes\" + DataFolder + ".md",
        @"Software\Classes\" + DataFolder + ".media",
        @"Software\Classes\Applications\" + DataFolder + ".exe"
    };

    static void RepairRegistrations(string self)
    {
        string dir = Path.GetDirectoryName(self);
        string programFiles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), DataFolder);
        string perUser = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"), DataFolder);
        bool inProgramFiles = SamePath(dir, programFiles);
        if (!inProgramFiles && !SamePath(dir, perUser)) return;
        foreach (string key in RegistrationKeys)
            using (RegistryKey command = Registry.CurrentUser.OpenSubKey(key + @"\shell\open\command", true))
            {
                if (command == null) continue;
                if (!NeedsRepair(CommandExe(command.GetValue("") as string), self, inProgramFiles, File.Exists)) continue;
                command.SetValue("", "\"" + self + "\" \"%1\"");
                using (RegistryKey icon = Registry.CurrentUser.CreateSubKey(key + @"\DefaultIcon"))
                    icon.SetValue("", "\"" + self + "\",0");
            }
    }

    // Whether an entry that starts `registered` must be pointed at this copy (`self`) instead.
    static bool NeedsRepair(string registered, string self, bool selfInProgramFiles, Func<string, bool> exists)
    {
        if (string.IsNullOrEmpty(registered)) return true;                     // no program in the entry
        if (SamePath(registered, self)) return false;                          // already this copy
        if (!exists(registered)) return true;                                  // a deleted copy
        return selfInProgramFiles;                                             // the Program Files copy wins
    }

    // The program an Open command starts: "C:\path\app.exe" "%1"  ->  C:\path\app.exe
    static string CommandExe(string command)
    {
        if (string.IsNullOrEmpty(command)) return null;
        Match m = Regex.Match(command, @"^\s*(?:""([^""]+)""|(\S+))");
        return m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value) : null;
    }

    static bool SamePath(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    // ------------------------------------------------------------------ page files (signed Content DLL)

    static Assembly content;
    static readonly object contentLock = new object();

    // A page file or bundled library by its path ("viewer.html", "lib/katex/katex.min.js"); null if absent.
    static byte[] ContentFile(string name)
    {
        lock (contentLock)
        {
            if (content == null) content = Assembly.LoadFrom(Path.Combine(appDir, ContentDll));
            using (Stream s = content.GetManifestResourceStream(name))
            {
                if (s == null) return null;
                MemoryStream m = new MemoryStream();
                s.CopyTo(m);
                return m.ToArray();
            }
        }
    }

    // ------------------------------------------------------------------ status for the page

    // Firewall (read-only). Nothing listens on the network, so no rules are needed. The optional block rules
    // added by Firewall-Block.cmd make Windows refuse any traffic in or out of this program as well.
    const string FirewallGroup = "Markdown Viewer (WebView2)";
    const string FirewallDetail = "Nothing listens on the network. Optional block rules (Firewall-Block.cmd) make Windows refuse any traffic in or out of MarkdownViewerWebView2.exe itself. They do not cover the WebView2 engine (msedgewebview2.exe), which Windows shares with other apps.";

    class FirewallStatus
    {
        public bool FirewallOn = true, BlockIn, BlockOut;
        public List<string> Rules = new List<string>();
        public bool Blocked { get { return BlockIn && BlockOut; } }
        public string Label { get { return Blocked ? "blocked in & out" : "no network port"; } }
        public string Summary
        {
            get
            {
                if (Blocked) return "Blocked in and out for MarkdownViewerWebView2.exe - and no network port";
                if (BlockIn || BlockOut) return "Partly blocked (" + (BlockIn ? "incoming" : "outgoing") + " only) - no network port";
                return "Not needed - no network port (block rules not added)";
            }
        }
    }

    static FirewallStatus GetFirewallStatus()
    {
        FirewallStatus st = new FirewallStatus();
        try
        {
            dynamic fwPolicy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
            int prof = fwPolicy.CurrentProfileTypes;
            foreach (int bit in new[] { 1, 2, 4 })
                if ((prof & bit) != 0 && !(bool)fwPolicy.FirewallEnabled[bit]) st.FirewallOn = false;
            // Only enabled block rules in this app's group that point at this very program count.
            string self = Path.GetFullPath(Application.ExecutablePath);
            foreach (dynamic r in fwPolicy.Rules)
            {
                string group = r.Grouping as string, app = r.ApplicationName as string;
                if (group != FirewallGroup || string.IsNullOrEmpty(app)) continue;
                if (!string.Equals(Path.GetFullPath(Environment.ExpandEnvironmentVariables(app)), self, StringComparison.OrdinalIgnoreCase)) continue;
                if (!(bool)r.Enabled || (int)r.Action != 0) continue;          // 0 = block
                if ((int)r.Direction == 1) st.BlockIn = true;                   // 1 = incoming
                else if ((int)r.Direction == 2) st.BlockOut = true;             // 2 = outgoing
                st.Rules.Add((string)r.Name);
            }
        }
        catch { }
        return st;
    }

    static string FirewallJson()
    {
        FirewallStatus st = GetFirewallStatus();
        StringBuilder rules = new StringBuilder();
        foreach (string r in st.Rules) { if (rules.Length > 0) rules.Append(','); rules.Append(Json(r)); }
        return "{\"readable\":true,\"firewallOn\":" + (st.FirewallOn ? "true" : "false") +
               ",\"state\":" + Json(st.Blocked ? "blocked" : "nonetwork") +
               ",\"label\":" + Json(st.Label) + ",\"summary\":" + Json(st.Summary) +
               ",\"detail\":" + Json(FirewallDetail) + ",\"rules\":[" + rules + "]}";
    }

    // ------------------------------------------------------------------ about

    class Library { public string Name, Use, Version, File; }

    // Library versions come from the list in viewer.js (LIBRARIES) inside the Content DLL, so both About
    // windows show the same thing; build.ps1 checks that each bundled file really is that version.
    static List<Library> Libraries()
    {
        string js = "";
        try { js = Encoding.UTF8.GetString(ContentFile("viewer.js")); } catch { }
        Dictionary<string, string> versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in Regex.Matches(js, @"name: '([^']+)', version: '([^']+)'"))
            versions[m.Groups[1].Value] = m.Groups[2].Value;

        List<Library> libs = new List<Library>();
        string[,] known =
        {
            { "marked", "Markdown to HTML", "marked.min.js" },
            { "KaTeX", "Math equations", @"lib\katex" },
            { "highlight.js", "Code colouring", @"lib\highlight" },
            { "Mermaid", "Diagrams", @"lib\mermaid" }
        };
        for (int i = 0; i < known.GetLength(0); i++)
        {
            string v;
            if (!versions.TryGetValue(known[i, 0], out v)) v = "?";
            libs.Add(new Library { Name = known[i, 0], Use = known[i, 1], Version = v, File = known[i, 2] });
        }
        return libs;
    }

    static string AboutText()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine(AppName + " " + AppVersion);
        sb.AppendLine("Created by Shaimaa Soltan");
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
        sb.AppendLine("NEVER GOES ONLINE: the WebView2 engine cannot look up internet addresses, and the window");
        sb.AppendLine("loads nothing from the web - pictures or media a document links to online are not shown.");
        sb.AppendLine("Web and mail links open outside this window only after you have seen the real address.");
        sb.AppendLine();
        sb.AppendLine("PRIVATE: the window runs InPrivate - no history of the documents you view is kept. No camera,");
        sb.AppendLine("microphone, location, notification or clipboard-reading access; downloads only from the viewer.");
        sb.AppendLine("Folder links (junctions, symbolic links) cannot lead outside the document's folder.");
        sb.AppendLine();
        if (signature != null)
        {
            sb.AppendLine("SIGNED: the program and " + ContentDll + " (the page and every");
            sb.AppendLine("library - there are no loose script files) are signed by \"" + signature.Signer + "\"");
            sb.AppendLine("and checked at every start; the WebView2 files must carry Microsoft's signature and be");
            sb.AppendLine("the exact versions it was built with. A changed, swapped or missing file, or anything");
            sb.AppendLine("extra in the program's folder, stops the app. The checked files stay locked while it");
            sb.AppendLine("runs, Windows loads system DLLs only from System32, and the WebView2 engine must be");
            sb.AppendLine("Microsoft's, from Program Files.");
            sb.AppendLine("     certificate " + signature.Thumbprint);
            sb.AppendLine("     " + (signature.Trusted ? "trusted by Windows"
                          : "made on this PC, not in Windows' trusted list (Trust-Certificate.cmd adds it)"));
            sb.AppendLine();
        }
        sb.AppendLine("LIBRARIES (all bundled - this app never needs the internet):");
        foreach (Library lib in Libraries())
        {
            sb.AppendLine();
            sb.AppendLine("- " + lib.Name + " " + lib.Version + "  (" + lib.Use + ")");
            sb.AppendLine("     " + lib.File + " (inside the signed " + ContentDll + ")");
        }
        sb.AppendLine();
        sb.AppendLine("BUILT WITH:");
        sb.AppendLine("- Windows app: C# 5, compiled with csc.exe from .NET Framework 4 (included with Windows);");
        sb.AppendLine("     running on .NET Framework CLR " + Environment.Version);
        string wvRuntime, wvSdk;
        WebView2Versions(out wvRuntime, out wvSdk);
        sb.AppendLine("- Window: own window with the WebView2 control - WebView2 Runtime " + (wvRuntime ?? "(not found)") +
                      ", WebView2 SDK " + (wvSdk ?? "?") + " (Microsoft.Web.WebView2)");
        sb.AppendLine("- Installer: PowerShell scripts (build, install, uninstall); installed in Program Files (one administrator prompt, for the copy only), file association for your account");
        sb.AppendLine("- Viewer: HTML, CSS and JavaScript, no frameworks");
        sb.AppendLine("- Created by: Shaimaa Soltan");
        sb.AppendLine("- Made using: GPT-5 (original viewer); extended and tested with Claude Code (Anthropic)");
        sb.AppendLine();
        FirewallStatus fw = GetFirewallStatus();
        sb.AppendLine("FIREWALL: " + fw.Summary + (fw.FirewallOn ? " (Windows Firewall is on)" : " (Windows Firewall is OFF)"));
        foreach (string r in fw.Rules) sb.AppendLine("     rule: " + r);
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

    // Native About window: a green firewall marker ("no network port", or "blocked in & out" with the
    // optional block rules) above the full About text.
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
        FirewallStatus fw = GetFirewallStatus();
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
        marker.UseMnemonic = false;                     // show "&" as text (not a keyboard-shortcut marker)
        marker.Text = "\u25CF  Firewall: " + fw.Label + "   \u2014   " + fw.Summary +
                      (fw.FirewallOn ? " \u00B7 Windows Firewall on" : " \u00B7 Windows Firewall OFF");
        ToolTip tip = new ToolTip();
        tip.SetToolTip(marker, FirewallDetail);
        marker.AccessibleName = "Firewall: " + fw.Label;

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
                    // Browser data starts empty at every start, in a new folder of its own: nothing left there
                    // earlier (by this app or another program) is read by the engine.
                    string data = FreshDataFolder();
                    // Developer access stays off: WebView2 would otherwise accept extra browser switches
                    // (e.g. --remote-debugging-port) or another browser/data folder from WEBVIEW2_* variables.
                    foreach (string name in new System.Collections.ArrayList(Environment.GetEnvironmentVariables().Keys))
                        if (name.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase))
                            Environment.SetEnvironmentVariable(name, null);
                    CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                    // No background traffic from the engine itself: no component updates, field trials,
                    // reliability reports, hyperlink pings or other background requests.
                    // msOneAuthWAM off: the engine otherwise signs in to the Windows/Microsoft account through
                    // Windows' account manager at start-up and contacts Microsoft 365 servers.
                    // host-resolver-rules: the engine cannot look up any internet name, so it cannot connect
                    // anywhere (the page's own address is answered in-process and never looked up).
                    options.AdditionalBrowserArguments = "--disable-background-networking --disable-component-update" +
                                                         " --disable-domain-reliability --no-pings" +
                                                         " --disable-features=msOneAuthWAM" +
                                                         " \"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE mdviewer.example\"";
                    options.IsCustomCrashReportingEnabled = true;           // crash reports stay on this PC
                    options.AllowSingleSignOnUsingOSPrimaryAccount = false; // never signs in with the Windows account
                    env = await CoreWebView2Environment.CreateAsync(null, data, options);
                }
                // InPrivate: nothing about the documents viewed (history, cache, page data) is written to disk.
                CoreWebView2ControllerOptions controller = env.CreateCoreWebView2ControllerOptions();
                controller.IsInPrivateModeEnabled = true;
                await web.EnsureCoreWebView2Async(env, controller);
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
                MessageBox.Show("Developer debugging is switched on for WebView2 on this computer (or the app could not check it), so " + AppName +
                                " will not open documents.\n\nRemove the WebView2 debugging setting (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS or an\n" +
                                "AdditionalBrowserArguments policy) and start it again.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
                return;
            }
            // The engine that was started must be Microsoft's WebView2 Runtime from a folder only an
            // administrator can change, not another browser picked by a setting.
            string engineProblem = CheckEngine((int)core.BrowserProcessId);
            if (engineProblem != null)
            {
                MessageBox.Show(engineProblem + "\n\n" + AppName + " will not open documents. Repair or reinstall the Microsoft Edge WebView2 Runtime\n" +
                                "(Settings > Apps) and remove any setting that points WebView2 to another browser folder.",
                                AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
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

            // No camera, microphone, location, notifications, clipboard reading etc. Writing to a file the user
            // picked in the Save As dialog (Export / Save) is left to WebView2's own question.
            core.PermissionRequested += (s, e) =>
            {
                e.State = e.PermissionKind == CoreWebView2PermissionKind.FileReadWrite && IsPrivate(e.Uri)
                    ? CoreWebView2PermissionState.Default : CoreWebView2PermissionState.Deny;
            };
            // Downloads only from the viewer itself (Export / Save, "Save image as" on a picture it shows).
            core.DownloadStarting += (s, e) =>
            {
                string uri = e.DownloadOperation.Uri;
                if (!IsPrivate(uri) && !uri.StartsWith("blob:" + PrivateHost + "/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
            };
            // Right-click menu: copying, saving pictures, opening links and printing only (no Share, web
            // capture, QR codes or other browser extras).
            core.ContextMenuRequested += (s, e) => TrimMenu(e.MenuItems);

            core.AddWebResourceRequestedFilter(PrivateHost + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnRequest;

            // The window only ever shows the private address. Web links open in the default browser;
            // anything else (file:, other schemes) is simply blocked.
            core.NavigationStarting += (s, e) =>
            {
                if (!IsPrivate(e.Uri)) { e.Cancel = true; AskOpenOutside(e.Uri); }
            };
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (IsPrivate(e.Uri)) new ViewerForm(e.Uri).Show();   // e.g. a linked image from the document's folder
                else AskOpenOutside(e.Uri);
            };
            core.DocumentTitleChanged += (s, e) => { Text = core.DocumentTitle; };
            core.Navigate(startUrl);
        }

        // If the engine's command line cannot be read, debugging counts as switched on.
        static bool DebuggingSwitchedOn(int browserPid)
        {
            bool found = false;
            try
            {
                using (System.Management.ManagementObjectSearcher q = new System.Management.ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + browserPid))
                    foreach (System.Management.ManagementObject o in q.Get())
                    {
                        string cmd = o["CommandLine"] as string;
                        if (cmd == null) return true;
                        found = true;
                        if (cmd.IndexOf("--remote-debugging", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            cmd.IndexOf("--auto-open-devtools", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
            }
            catch { return true; }
            return !found;
        }

        // null if the engine process is msedgewebview2.exe under Program Files with Microsoft's valid signature.
        static string CheckEngine(int browserPid)
        {
            string path = ProcessPath(browserPid);
            if (path == null) return "The WebView2 engine could not be checked.";
            string real = RealPath(path) ?? path;
            bool inProgramFiles = false;
            foreach (Environment.SpecialFolder f in new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles })
            {
                string root = Environment.GetFolderPath(f);
                if (root.Length > 0 && real.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) inProgramFiles = true;
            }
            if (!inProgramFiles || !Path.GetFileName(real).Equals("msedgewebview2.exe", StringComparison.OrdinalIgnoreCase))
                return "The WebView2 engine was started from an unexpected place:\n" + real;
            SignatureInfo s = Signature(real);
            if (!s.Trusted || s.Subject.IndexOf("O=Microsoft Corporation,", StringComparison.Ordinal) < 0)
                return "The WebView2 engine is not signed by Microsoft:\n" + real;
            return null;
        }

        static string ProcessPath(int pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);       // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return null;
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
            }
            finally { CloseHandle(h); }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

        // %LOCALAPPDATA%\MarkdownViewerWebView2\WebView2\<random>: a new, empty folder for this run. Each run
        // keeps a lock file open in its folder; folders without a held lock (ended runs, and the single shared
        // folder of earlier versions with its caches and history) are deleted. The last run's folder goes at
        // the next start, as the engine may still be closing when this program ends.
        static FileStream dataLock;

        static string FreshDataFolder()
        {
            string root = Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), DataFolder), "WebView2");
            Directory.CreateDirectory(root);
            foreach (string dir in Directory.GetDirectories(root))
            {
                string lockFile = Path.Combine(dir, ".inuse");
                try
                {
                    if (File.Exists(lockFile)) new FileStream(lockFile, FileMode.Open, FileAccess.ReadWrite, FileShare.None).Dispose();
                    Directory.Delete(dir, true);
                }
                catch { }   // in use by another open viewer window
            }
            string data = Path.Combine(root, RandomHex(8));
            Directory.CreateDirectory(data);
            dataLock = new FileStream(Path.Combine(data, ".inuse"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            return data;
        }

        static readonly HashSet<string> MenuKeep = new HashSet<string>(StringComparer.Ordinal)
        {
            "copy", "selectAll", "openLinkInNewWindow", "copyLinkLocation", "copyImage", "copyImageLocation",
            "saveImageAs", "saveMediaAs", "copyVideoFrame", "loop", "showAllControls", "back", "forward", "reload", "print"
        };

        static void TrimMenu(IList<CoreWebView2ContextMenuItem> items)
        {
            for (int i = items.Count - 1; i >= 0; i--)
                if (items[i].Kind != CoreWebView2ContextMenuItemKind.Separator &&
                    (items[i].Kind == CoreWebView2ContextMenuItemKind.Submenu || !MenuKeep.Contains(items[i].Name))) items.RemoveAt(i);
            // No separators at the ends or next to each other.
            for (int i = items.Count - 1; i >= 0; i--)
                if (items[i].Kind == CoreWebView2ContextMenuItemKind.Separator &&
                    (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator)) items.RemoveAt(i);
        }

        static bool IsPrivate(string uri)
        {
            return uri.StartsWith(PrivateHost + "/", StringComparison.OrdinalIgnoreCase);
        }

        // Web and mail links open outside this window, and only after the user has seen the real address
        // (a link's text can show one address and point to another).
        void AskOpenOutside(string uri)
        {
            bool mail = uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase);
            if (!(mail || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                  uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) return;
            BeginInvoke((Action)(() =>
            {
                string shown = uri.Length > 600 ? uri.Substring(0, 600) + "..." : uri;
                string question = (mail ? "Write an e-mail with your mail app?" : "Open this web address in your browser?") +
                                  "\n\n" + shown + "\n\nThis window never goes online; the link opens outside it.";
                if (MessageBox.Show(this, question, AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                                    MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
                try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
            }));
        }

        void OnRequest(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            // Hand the request line to the handler, then turn its HTTP-style response
            // (status, headers incl. Content-Security-Policy, body) into a WebView2 response.
            Uri u = new Uri(e.Request.Uri);
            // A video player asks for pieces of the file ("Range: bytes=start-end").
            string range = null;
            try { if (e.Request.Headers.Contains("Range")) range = e.Request.Headers.GetHeader("Range"); } catch { }
            if (range != null && !Regex.IsMatch(range, @"^bytes=\d{0,18}-\d{0,18}$")) range = null;
            byte[] request = Encoding.ASCII.GetBytes(e.Request.Method + " " + u.PathAndQuery + " HTTP/1.1\r\n" +
                                                     (range != null ? "Range: " + range + "\r\n" : "") + "\r\n");
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
        string range = null;
        foreach (string line in head.Split(new[] { "\r\n" }, StringSplitOptions.None))
            if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) range = line.Substring(6).Trim();
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
        else if (rest.StartsWith("fs/", StringComparison.Ordinal)) SendDiskFile(stream, Uri.UnescapeDataString(rest.Substring(3)), headOnly, range);
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

    // Page files and bundled libraries come only from the signed Content DLL, never from loose files.
    static void SendAppFile(Stream s, string name, bool headOnly)
    {
        bool lib = name.StartsWith("lib/", StringComparison.Ordinal);
        if (lib ? !LibTypes.Contains(Path.GetExtension(name)) : Array.IndexOf(AppFiles, name) < 0) { NotFound(s); return; }
        byte[] body = ContentFile(name);
        if (body == null) { NotFound(s); return; }

        string csp = null;
        if (name == "viewer.html")
        {
            // Apply saved view settings before the page is shown (no flash of the wrong theme/layout).
            StringBuilder attrs = new StringBuilder();
            foreach (KeyValuePair<string, string> p in LoadPrefs())
                attrs.Append(" data-").Append(p.Key).Append("=\"").Append(p.Value).Append('"');
            string html = Encoding.UTF8.GetString(body);
            if (attrs.Length > 0) html = html.Replace("<html lang=\"en\">", "<html lang=\"en\"" + attrs + ">");
            // The page's own policy allows file: for opening viewer.html straight from disk; not in the app.
            html = Regex.Replace(html, "<meta http-equiv=\"Content-Security-Policy\" content=\"[^\"]*\"",
                                 m => m.Value.Replace(" file:", ""));
            body = Encoding.UTF8.GetBytes(html);
            // Only the viewer's own script files and the bundled libraries may run; no inline code, and
            // nothing at all (scripts, styles, fonts, pictures, media) from an internet address.
            csp =
                "default-src 'none'; " +
                "script-src " + AppBase + "; " +
                "style-src 'self' 'unsafe-inline'; " +
                "font-src 'self' data:; " +
                "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; " +
                "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
        }
        Send(s, 200, Mime(name), body, csp, headOnly);
    }

    static void SendDiskFile(Stream s, string webPath, bool headOnly, string range)
    {
        string full;
        try { full = Path.GetFullPath(webPath.Replace('/', '\\')); }
        catch { NotFound(s); return; }

        if (allowRoot == null || !IsUnder(full, allowRoot))
        {
            Send(s, 403, "text/plain", Encoding.UTF8.GetBytes("Forbidden"), null, headOnly);
            return;
        }
        // Missing first, so the page can tell a broken link from a file type it is not given.
        if (!File.Exists(full)) { NotFound(s); return; }
        if (!ServedTypes.Contains(Path.GetExtension(full)))
        {
            Send(s, 403, "text/plain", Encoding.UTF8.GetBytes("Forbidden"), null, headOnly);
            return;
        }
        // A folder link (junction, symbolic link) inside the allowed folder could lead anywhere: the file's
        // real location must be inside the allowed folder too.
        string real = RealPath(full), realRoot = RealPath(allowRoot);
        if (real == null || realRoot == null || !IsUnder(real, realRoot))
        {
            Send(s, 403, "text/plain", Encoding.UTF8.GetBytes("Forbidden"), null, headOnly);
            return;
        }
        FileInfo info = new FileInfo(full);
        bool text = TextTypes.Contains(Path.GetExtension(full));
        if (text && info.Length > MaxTextBytes)
        {
            Send(s, 413, "text/plain", Encoding.UTF8.GetBytes("File too large"), null, headOnly);
            return;
        }

        // Every file from disk is sandboxed with no script permission, so even an SVG opened
        // on its own (not as an <img>) can never run code.
        const string csp = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'self'";
        // The version stamp lets the page notice when the file is saved again (auto-reload); a HEAD
        // request only asks for it, so the file itself is not read.
        string etag = "\"" + info.LastWriteTimeUtc.Ticks.ToString("x") + "-" + info.Length.ToString("x") + "\"";
        if (!text) { SendMedia(s, full, info, csp, etag, headOnly, range); return; }
        Send(s, 200, Mime(full), headOnly ? new byte[0] : File.ReadAllBytes(full), csp, headOnly, etag);
    }

    // Pictures, video and audio. A player asks for pieces ("Range: bytes=start-end"), so a long video is
    // read a few megabytes at a time and seeking is immediate, whatever the file's size. A file is read
    // whole only when nothing asks for a piece, and then only up to MaxMediaBytes.
    const long MaxChunk = 4L << 20;

    static void SendMedia(Stream s, string full, FileInfo info, string csp, string etag, bool headOnly, string range)
    {
        long len = info.Length, start = 0, end = len - 1;
        Match m = range == null ? Match.Empty : Regex.Match(range, @"^bytes=(\d{0,18})-(\d{0,18})$");
        bool partial = m.Success && (m.Groups[1].Length > 0 || m.Groups[2].Length > 0);
        if (partial)
        {
            if (m.Groups[1].Length == 0) start = Math.Max(0, len - long.Parse(m.Groups[2].Value));    // the last N bytes
            else
            {
                start = long.Parse(m.Groups[1].Value);
                if (m.Groups[2].Length > 0) end = Math.Min(long.Parse(m.Groups[2].Value), len - 1);
            }
            if (len == 0 || start >= len || start > end)
            {
                Send(s, 416, "text/plain", new byte[0], null, headOnly, null, "Content-Range: bytes */" + len + "\r\n");
                return;
            }
            end = Math.Min(end, start + MaxChunk - 1);
        }
        else if (len > MaxMediaBytes)
        {
            Send(s, 413, "text/plain", Encoding.UTF8.GetBytes("File too large"), null, headOnly);
            return;
        }

        byte[] body = new byte[0];
        if (!headOnly && len > 0)
        {
            body = new byte[end - start + 1];
            using (FileStream f = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                f.Seek(start, SeekOrigin.Begin);
                int read = 0;
                while (read < body.Length)
                {
                    int n = f.Read(body, read, body.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
            }
        }
        string extra = "Accept-Ranges: bytes\r\n" + (partial ? "Content-Range: bytes " + start + "-" + end + "/" + len + "\r\n" : "");
        Send(s, partial ? 206 : 200, Mime(full), body, csp, headOnly, etag, extra);
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
          .Append(",\"signature\":").Append(signature == null ? "null" :
              "{\"signer\":" + Json(signature.Signer) + ",\"thumbprint\":" + Json(signature.Thumbprint) +
              ",\"trusted\":" + (signature.Trusted ? "true" : "false") + ",\"content\":" + Json(ContentDll) + "}")
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

    static void Send(Stream s, int status, string mime, byte[] body, string csp, bool headOnly, string etag = null, string extra = null)
    {
        string reason = status == 200 ? "OK" : status == 204 ? "No Content" : status == 206 ? "Partial Content"
                      : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed"
                      : status == 413 ? "Payload Too Large" : status == 416 ? "Range Not Satisfiable" : "Bad Request";
        StringBuilder h = new StringBuilder();
        h.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        h.Append("Content-Type: ").Append(mime).Append("\r\n");
        h.Append("Cache-Control: no-store\r\n");
        h.Append("X-Content-Type-Options: nosniff\r\n");
        h.Append("Referrer-Policy: no-referrer\r\n");
        if (csp != null) h.Append("Content-Security-Policy: ").Append(csp).Append("\r\n");
        if (etag != null) h.Append("ETag: ").Append(etag).Append("\r\n");
        if (extra != null) h.Append(extra);
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
        { "hiddenchars", new[] { "off", "on" } },
        { "pictures", new[] { "shown", "blocked" } },
        { "size", new[] { "normal", "small", "large", "larger", "largest" } },
        { "width", new[] { "normal", "wide", "full" } }
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
                // Written to a temporary file first and then swapped in, so a crash or power cut while saving
                // can never leave a half-written settings.ini (which would silently reset e.g. Pictures off).
                // The temporary file has a random name and must not exist yet (CreateNew): nothing can place a
                // file or link there beforehand to redirect the write.
                string file = PrefsFile(), temp = file + "." + RandomHex(8) + ".new";
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                try
                {
                    using (FileStream fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (StreamWriter w = new StreamWriter(fs, new UTF8Encoding(false)))
                        w.Write(sb.ToString());
                    if (File.Exists(file)) File.Replace(temp, file, null);
                    else File.Move(temp, file);
                }
                finally
                {
                    if (File.Exists(temp)) File.Delete(temp);
                }
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);

    // Where a file or folder really is, after following junctions, symbolic links and short names
    // (null if it cannot be opened). Opening without read access does not download cloud files.
    static string RealPath(string path)
    {
        using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3 /* OPEN_EXISTING */, 0x02000000 /* BACKUP_SEMANTICS: folders too */, IntPtr.Zero))
        {
            if (h.IsInvalid) return null;
            StringBuilder sb = new StringBuilder(1024);
            uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
            if (n == 0 || n >= sb.Capacity) return null;
            string p = sb.ToString();
            if (p.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + p.Substring(8);
            if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p.Substring(4);
            return p;
        }
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
