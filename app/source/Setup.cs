// Markdown Viewer (WebView2) - Setup and Uninstall.exe.
//
// build.ps1 compiles this file twice, both signed with the program's certificate:
//   - Setup (app\release\MarkdownViewer-Setup-<version>.exe): carries the built, signed program and its files as
//     resources, listed with their SHA-256 (payload.sha256), so its signature covers them. It installs (copy
//     into Program Files), registers (file types, Open with, Start menu, Settings > Apps) and adds the firewall
//     rules that block the installed program's network traffic. Install.cmd installs through it too (--install).
//   - Uninstall.exe (no files inside): installed next to the program, the opposite - it uninstalls,
//     unregisters and removes the firewall rules. Only the copy in Program Files (only an administrator can
//     change it) runs. So no .ps1 file is installed.
//
// Install with Setup (run as the user):
//   - this file is locked for the whole run, its signature checked and its SHA-256 taken;
//   - the copy into Program Files is the only step with administrator rights. What runs elevated is Windows
//     PowerShell from System32 with a short readable command (shown under "Show more details" in the UAC
//     prompt): it reads this file's bytes once, checks them against that SHA-256 and runs Setup.Place from
//     those bytes in memory. So the administrator step never starts a program from the Downloads folder,
//     where a planted DLL could be loaded with it, and a file swapped after the check never runs (exit 8);
//   - Place writes the files into a staging folder inside Program Files (only administrators can change it),
//     checks each one's SHA-256, that the program, Content DLL and Uninstall.exe are signed by this file's
//     certificate and the WebView2 files by Microsoft, swaps the folders and adds the firewall rules for the
//     installed program (exit codes below);
//   - Setup then makes the user's entries (Register) and checks that the rules are in place.
//
// Build: build.ps1 (after the program).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyCompany("Markdown Viewer")]
[assembly: AssemblyCopyright("Markdown Viewer")]
// Windows DLLs this file calls (kernel32, advapi32, wintrust, shell32) come from System32 only.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class Setup
{
    const string AppName = "Markdown Viewer (WebView2)";
    const string Key = "MarkdownViewerWebView2";
    const string ExeName = Key + ".exe";
    const string ContentDll = Key + ".Content.dll";
    const string UninstallerName = "Uninstall.exe";
    // The project record Install.cmd installs (for Check-Source.cmd). A Setup that carries none keeps the one
    // already installed, so reinstalling with Setup does not drop it.
    const string RecordName = "source-manifest.txt";
    const string ProgId = Key + ".md", MediaProgId = Key + ".media";
    const string FirewallGroup = AppName;
    static readonly string[] MicrosoftFiles = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };
    static readonly string[] MdExts = { ".md", ".markdown", ".mdown", ".mkd" };
    // Pictures, video and audio: in each type's "Open with" list (never their default app).
    static readonly string[] MediaExts = { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg", ".mp4", ".webm", ".mp3", ".wav", ".ogg" };
    // Data and text the viewer shows that other programs open (Excel, editors, browsers): offered only under
    // Open with > Choose another app (the application's SupportedTypes), never added to the type itself - adding
    // a program to a type's own list makes Windows ask "How do you want to open this file?" on the next
    // double-click. Files that Windows or other programs run (.cmd, .bat, .ps1, .js, .py, .html…) are not
    // registered at all: the viewer still shows them from its file list, links or a drop.
    static readonly string[] OfferedExts = { ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xlsx", ".xml", ".ipynb", ".txt", ".log",
                                             ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf" };
    // Every type an earlier version added to its own "Open with" list (1.12 - 1.14): taken back out.
    static readonly string[] EarlierExts = { ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xlsx", ".xml", ".ipynb", ".txt", ".log", ".yaml", ".yml",
                                             ".toml", ".ini", ".cfg", ".conf", ".ps1", ".psm1", ".py", ".js", ".ts", ".cs", ".java", ".sql", ".sh",
                                             ".bat", ".cmd", ".c", ".cpp", ".h", ".go", ".rs", ".rb", ".php", ".css", ".html", ".htm", ".diff", ".patch" };
    // This app's certificate names: the current one and the one earlier versions used.
    static readonly string[] CertSubjects = { "CN=Markdown Viewer, O=Markdown Viewer", "CN=Markdown Viewer (WebView2) Code Signing" };
    // Setup: no option (a window) or --install (no window: used by Install.cmd). Uninstall.exe: no option (a
    // window: Settings > Apps) or --uninstall (no window: Uninstall.cmd, Setup's Uninstall button).
    static readonly string[] SetupOptions = { "--install" }, UninstallOptions = { "--uninstall" };

    // Folders and the registry as Windows records them - never from environment variables, which any program
    // running as the user can change.
    static string ProgramFolder { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Key); } }
    static string StartMenuFolder { get { return Environment.GetFolderPath(Environment.SpecialFolder.Programs); } }
    static string RoamingFolder { get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
    static string LocalFolder { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    static RegistryKey UserRoot { get { return Registry.CurrentUser; } }
    static string PowerShellExe { get { return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"); } }
    static string InstalledExe { get { return Path.Combine(ProgramFolder, ExeName); } }
    static string InstalledUninstaller { get { return Path.Combine(ProgramFolder, UninstallerName); } }
    static string LegacyFolder { get { return Path.Combine(Path.Combine(LocalFolder, "Programs"), Key); } }    // earlier versions

    internal static bool IsSetup { get { return Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.sha256") != null; } }
    internal static string Title { get { return AppName + (IsSetup ? " Setup" : " - Uninstall"); } }

    // ------------------------------------------------------------------ start

    [STAThread]
    static int Main(string[] args)
    {
        string option = args.Length == 1 ? args[0] : "";
        bool console = option == "--install";           // run by Install.cmd: progress on standard output
        try
        {
            ProtectDllLoading();
            string self = Assembly.GetExecutingAssembly().Location;
            string problem = null;
            if (args.Length > 1 || (option != "" && Array.IndexOf(IsSetup ? SetupOptions : UninstallOptions, option) < 0))
                problem = "Unknown option: " + string.Join(" ", args);
            problem = problem ?? CheckStartupHooks() ?? CheckConfig() ?? CheckElevation();
            if (problem == null && !Environment.Is64BitProcess) problem = "This needs 64-bit Windows.";
            // Uninstall.exe acts only as the copy in Program Files, which only an administrator can change.
            if (problem == null && !IsSetup && !SamePath(self, InstalledUninstaller))
                problem = UninstallerName + " works only from " + ProgramFolder + ".";
            if (problem != null) return Report(console, problem, 1);

            // Locked first (others may read it, nobody may change, rename or delete it until this ends), so the
            // file whose signature and SHA-256 are checked is the file the administrator step reads.
            FileStream selfLock = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read);
            string selfHash;
            using (SHA256 sha = SHA256.Create()) selfHash = Hex(sha.ComputeHash(selfLock));
            SignatureInfo sig = Signature(self);
            if (!sig.Intact)
                return Report(console, "This file cannot be trusted: " + Why(sig) + ".\n\nNothing was changed." +
                              (IsSetup ? " Get a new copy from the person who gave it to you." : " Reinstall " + AppName + "."), 1);
            int code;
            switch (option)
            {
                case "--install":
                {
                    // Questions (certificate change, open windows) still get a Yes/No box.
                    Step step = new Step { Log = line => { Console.WriteLine(line); Console.Out.Flush(); },
                                           Ask = q => ShowOnTop(q, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes };
                    code = Install(self, selfHash, sig, step) ? 0 : 1;
                    break;
                }
                case "--uninstall":
                {
                    // Run by Setup (its output is read): the lines go to Setup's window, no message box. Run from
                    // Uninstall.cmd: one message with the result, on top.
                    bool toCaller = Console.IsOutputRedirected;
                    StringBuilder log = new StringBuilder();
                    Step step = new Step { Log = line => { if (toCaller) { Console.WriteLine(line); Console.Out.Flush(); } else log.AppendLine(line); },
                                           Ask = q => ShowOnTop(q, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes };
                    bool ok = Uninstall(step);
                    if (!toCaller) ShowOnTop(log.ToString().Trim(), MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                    code = ok ? 0 : 1;
                    break;
                }
                default:
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new SetupForm(self, selfHash, sig));
                    code = 0;
                    break;
            }
            GC.KeepAlive(selfLock);
            return code;
        }
        catch (Exception ex) { return Report(console, ex.Message, 1); }
    }

    static int Report(bool console, string text, int code)
    {
        if (console) { Console.WriteLine(text); Console.Out.Flush(); }
        else ShowOnTop(text, MessageBoxButtons.OK, code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Error);
        return code;
    }

    // A message shown without a window of our own: owned by a hidden top-most form that takes the focus, so it
    // never opens behind other windows (where it would look as if the uninstall had stopped).
    static DialogResult ShowOnTop(string text, MessageBoxButtons buttons, MessageBoxIcon icon)
    {
        using (Form owner = new Form { TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None,
                                       StartPosition = FormStartPosition.CenterScreen, Size = new Size(1, 1), Opacity = 0 })
        {
            owner.Show();
            owner.Activate();
            SetForegroundWindow(owner.Handle);
            return MessageBox.Show(owner, text, Title, buttons, icon,
                                   buttons == MessageBoxButtons.YesNo ? MessageBoxDefaultButton.Button2 : MessageBoxDefaultButton.Button1);
        }
    }

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);

    // The same DLL-loading rules as the viewer: system DLLs from System32, nothing from the current folder,
    // PATH, network shares or low-integrity files; legacy injection points (AppInit_DLLs, hooks) off.
    static void ProtectDllLoading()
    {
        try { SetDefaultDllDirectories(0x800); } catch { }         // LOAD_LIBRARY_SEARCH_SYSTEM32
        try { int flags = 0x1 | 0x2 | 0x4; SetProcessMitigationPolicy(10, ref flags, (IntPtr)4); } catch { }
        try { int flags = 0x1; SetProcessMitigationPolicy(6, ref flags, (IntPtr)4); } catch { }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetDefaultDllDirectories(uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessMitigationPolicy(int policy, ref int buffer, IntPtr length);

    // .NET would load a profiler or AppDomain manager named by these variables.
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
        return "These settings would make .NET load extra code:\n\n  " + string.Join("\n  ", found) +
               "\n\nNothing was changed. Remove them (Settings > System > About > Advanced system settings > Environment Variables).";
    }

    // A .config file next to this program could send .NET to other code.
    static string CheckConfig()
    {
        string config = AppDomain.CurrentDomain.SetupInformation.ConfigurationFile;
        if (!string.IsNullOrEmpty(config) && File.Exists(config))
            return Path.GetFileName(config) + " was found next to this program. It could change what it loads.\n\nNothing was changed. Delete that file.";
        if (AppDomain.CurrentDomain.DomainManager != null) return "Something has changed how .NET starts this program.\n\nNothing was changed.";
        return null;
    }

    // Started with "Run as administrator": the entries would be made for the administrator account, and a
    // program started from the Downloads folder should not run elevated. Each step asks for that itself.
    static string CheckElevation()
    {
        return ElevationType() == 2
            ? "Start this normally (double-click it), not with \"Run as administrator\".\n\nIt asks for administrator rights itself, only for the step that needs them."
            : null;
    }

    static int ElevationType()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return 0;
        try { int type, size; return GetTokenInformation(token, 18 /* TokenElevationType */, out type, 4, out size) ? type : 0; }
        finally { CloseHandle(token); }
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

    // ------------------------------------------------------------------ the files inside Setup

    // name -> SHA-256 of every file to install (a resource of this signed file).
    static Dictionary<string, string> Manifest()
    {
        Dictionary<string, string> want = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.sha256"))
        {
            if (s == null) return want;
            using (StreamReader r = new StreamReader(s, Encoding.UTF8))
            {
                string line;
                while ((line = r.ReadLine()) != null)
                {
                    Match m = Regex.Match(line, @"^([A-Za-z0-9_.\-]+)=([0-9A-F]{64})$");
                    if (m.Success) want[m.Groups[1].Value] = m.Groups[2].Value;
                }
            }
        }
        return want;
    }

    static byte[] Payload(string name)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload/" + name))
        {
            if (s == null) return null;
            MemoryStream m = new MemoryStream();
            s.CopyTo(m);
            return m.ToArray();
        }
    }

    static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", ""); }
    static string Sha256(byte[] b) { using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(b)); }
    static string Sha256(string path) { using (SHA256 sha = SHA256.Create()) using (FileStream fs = File.OpenRead(path)) return Hex(sha.ComputeHash(fs)); }

    static bool SamePath(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    // ------------------------------------------------------------------ the administrator copy step (Setup)

    // Run elevated, from Setup's bytes in memory (see the top of this file). Trusts nothing it is handed but
    // the certificate the user's Setup was signed with: the folder comes from Windows' own record of Program
    // Files, and the files come from this (hash-checked) assembly. Writes no log; the result is the exit code:
    // 0 done, 2 program/Content DLL/Uninstall.exe not signed by `signer`, 3 an installed copy signed by another
    // certificate (unless `accept` is that certificate), 4 a WebView2 file not signed by Microsoft,
    // 6 in use / other, 7 a file differs from the list.
    public static int Place(string signer, string accept)
    {
        if (!Environment.Is64BitProcess || string.IsNullOrEmpty(signer)) return 6;
        string dest = ProgramFolder, stage = dest + ".new", old = dest + ".old";
        try
        {
            ClearDir(stage); ClearDir(old);
            Directory.CreateDirectory(stage);
            Dictionary<string, string> want = Manifest();
            if (want.Count == 0) return 7;
            foreach (KeyValuePair<string, string> f in want)
            {
                byte[] b = Payload(f.Key);
                if (b == null || Sha256(b) != f.Value) return Fail(stage, 7);
                File.WriteAllBytes(Path.Combine(stage, f.Key), b);
            }
            // Checked again where they now are, a folder only administrators can change.
            string[] staged = Directory.GetFileSystemEntries(stage);
            if (staged.Length != want.Count) return Fail(stage, 7);
            foreach (string f in staged)
            {
                string n = Path.GetFileName(f);
                if (!want.ContainsKey(n) || !File.Exists(f) || Sha256(f) != want[n]) return Fail(stage, 7);
            }
            foreach (string f in new[] { ExeName, ContentDll, UninstallerName })
            {
                SignatureInfo s = Signature(Path.Combine(stage, f));
                if (!s.Intact || s.Thumbprint != signer) return Fail(stage, 2);
            }
            string installed = Path.Combine(dest, ExeName);
            if (File.Exists(installed))
            {
                string was = Signature(installed).Thumbprint;
                if (was != null && was != signer && accept != signer) return Fail(stage, 3);
            }
            foreach (string f in MicrosoftFiles)
            {
                SignatureInfo ms = Signature(Path.Combine(stage, f));
                if (!ms.Trusted || ms.Subject.IndexOf("O=Microsoft Corporation,", StringComparison.Ordinal) < 0) return Fail(stage, 4);
            }
            // The project record of the last Install.cmd: kept from the installed copy when this Setup has none (a
            // plain text file, never loaded; copied between two folders only administrators can change).
            string keptRecord = Path.Combine(dest, RecordName);
            if (!want.ContainsKey(RecordName) && File.Exists(keptRecord) && (File.GetAttributes(keptRecord) & FileAttributes.ReparsePoint) == 0 &&
                new FileInfo(keptRecord).Length <= 8L << 20)
                File.Copy(keptRecord, Path.Combine(stage, RecordName));
            // Renaming fails as a whole while a file in the old folder is in use: a running copy is never left
            // half replaced. Anything else that was in the old folder goes with it.
            if (Directory.Exists(dest)) Directory.Move(dest, old);
            try { Directory.Move(stage, dest); }
            catch { if (Directory.Exists(old) && !Directory.Exists(dest)) Directory.Move(old, dest); throw; }
            try { ClearDir(old); } catch { }
            // Block rules for the installed program; Setup checks afterwards (as the user) that they are there.
            try { AddFirewallRules(Path.Combine(dest, ExeName)); } catch { }
            return 0;
        }
        catch
        {
            try { ClearDir(stage); } catch { }
            try { if (Directory.Exists(old) && !Directory.Exists(dest)) Directory.Move(old, dest); } catch { }
            return 6;
        }
    }

    static int Fail(string stage, int code) { try { ClearDir(stage); } catch { } return code; }

    // A link is removed as a link (never followed); a folder with everything in it.
    static void ClearDir(string path)
    {
        if (!Directory.Exists(path)) return;
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) Directory.Delete(path, false);
        else Directory.Delete(path, true);
    }

    // ------------------------------------------------------------------ install (Setup, as the user)

    internal sealed class Step
    {
        public Action<string> Log;
        public Func<string, bool> Ask;
    }

    static readonly string[] PlaceErrors =
    {
        null, null, "the program, its Content DLL or Uninstall.exe is not signed by this Setup's certificate, or was changed after signing",
        "the installed copy is signed by a different certificate", "a WebView2 file does not carry a valid Microsoft signature",
        null, "the files could not be copied (is the viewer open in another account?)", "a file differs from the list inside Setup",
        "this Setup file changed after it was checked"
    };

    internal static bool Install(string self, string selfHash, SignatureInfo sig, Step ui)
    {
        if (!CloseViewers(ui)) { ui.Log("Nothing was changed."); return false; }
        string dest = ProgramFolder, installedExe = InstalledExe;
        string accept = "";
        if (File.Exists(installedExe))
        {
            string was = Signature(installedExe).Thumbprint;
            if (was != null && was != sig.Thumbprint)
            {
                ui.Log("The installed copy is signed by a different certificate:\r\n  installed: " + was + "\r\n  this Setup: " + sig.Thumbprint);
                if (!ui.Ask("The installed copy of " + AppName + " is signed by a different certificate than this Setup:\n\n" +
                            "  installed:   " + was + "\n  this Setup:  " + sig.Thumbprint + "\n\n" +
                            "That is expected only if the developer made a new signing certificate. Replace the installed copy?"))
                { ui.Log("Nothing was changed."); return false; }
                accept = sig.Thumbprint;
            }
        }

        ui.Log("Copying the program to " + dest + " and adding its firewall rules ...");
        ui.Log("Windows asks for administrator rights for Windows PowerShell: it runs only this Setup's own copy step (files and\r\n" +
               "firewall rules), from this file's checked bytes (\"Show more details\" shows the command, this file's path and SHA-256).");
        string bootstrap = string.Join("; ", new[]
        {
            "$env:PSModulePath = $PSHOME + '\\Modules'",
            "$ErrorActionPreference = 'Stop'",
            "$codeFile = " + Quote(self),
            "$codeHash = '" + selfHash + "'",
            "$bytes = [IO.File]::ReadAllBytes($codeFile)",
            "if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace '-', '') -ne $codeHash) { exit 8 }",
            "$r = [Reflection.Assembly]::Load($bytes).GetType('Setup').GetMethod('Place').Invoke($null, [object[]]@(" + Quote(sig.Thumbprint) + ", " + Quote(accept) + "))",
            "exit $r"
        });
        int code;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " + NativeArgument(bootstrap));
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process p = Process.Start(psi)) { p.WaitForExit(); code = p.ExitCode; }
        }
        catch (Win32Exception) { ui.Log("Administrator rights were not granted; nothing was installed."); return false; }
        if (code != 0)
        {
            string why = code > 0 && code < PlaceErrors.Length && PlaceErrors[code] != null ? PlaceErrors[code] : "the copy step stopped (exit " + code + ")";
            ui.Log("Not installed: " + why + ". The installed copy was left as it was.");
            return false;
        }

        // Check, as the user, that Program Files now holds exactly the files inside this Setup.
        Dictionary<string, string> want = Manifest();
        List<string> differs = new List<string>();
        foreach (KeyValuePair<string, string> f in want)
        {
            string p = Path.Combine(dest, f.Key);
            if (!File.Exists(p) || Sha256(p) != f.Value) differs.Add(f.Key);
        }
        foreach (string e in Directory.GetFileSystemEntries(dest))
            if (!want.ContainsKey(Path.GetFileName(e)) && Path.GetFileName(e) != RecordName) differs.Add(Path.GetFileName(e));
        if (!want.ContainsKey(RecordName) && File.Exists(Path.Combine(dest, RecordName)))
            ui.Log("Kept the project record of the last Install.cmd (" + RecordName + ", for Check-Source.cmd).");
        if (differs.Count > 0) ui.Log("WARNING: in " + dest + " these do not match this Setup: " + string.Join(", ", differs));
        else ui.Log("Copied to " + dest + " and checked: exactly the files inside this Setup.");

        // Firewall rules (made by the administrator step) and the user's entries (file types, Open with,
        // Start menu, Settings > Apps).
        List<string> rules = FirewallRules();
        if (rules.Count == 2) ui.Log("Firewall: all network traffic in and out of " + installedExe + " is blocked (2 rules).");
        else ui.Log("WARNING: the firewall rules for " + installedExe + " could not be checked or added (" + rules.Count + " found).");
        int registered = Register(ui.Log);
        if (registered != 0) ui.Log("Some Windows entries could not be set (see above).");

        string version = FileVersionInfo.GetVersionInfo(installedExe).ProductVersion;
        ui.Log("\r\nInstalled " + AppName + " " + version + ".");
        int left = (int)Math.Floor((sig.NotAfter - DateTime.Now).TotalDays);
        if (left < 365)
            ui.Log("Note: the signing certificate expires on " + sig.NotAfter.ToString("yyyy-MM-dd") + " (" + left + " days); after that the viewer refuses to start. Ask for a new Setup before then.");
        if (!WebView2RuntimeFound()) ui.Log("Note: the Microsoft Edge WebView2 Runtime was not found. The viewer needs it: install it from Microsoft (\"WebView2 Runtime\").");
        return true;
    }

    // Setup's Uninstall button: the installed Uninstall.exe does it (a copy installed before 1.11 has uninstall.ps1).
    internal static bool UninstallInstalled(Step ui)
    {
        int code;
        if (File.Exists(InstalledUninstaller))
        {
            ui.Log("Uninstalling with " + InstalledUninstaller + " ...");
            // Its output comes into this window; it shows no message box of its own.
            code = RunAndLog(InstalledUninstaller, "--uninstall", ui);
        }
        else if (File.Exists(Path.Combine(ProgramFolder, "uninstall.ps1")))
            code = RunAndLog(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + NativeArgument(Path.Combine(ProgramFolder, "uninstall.ps1")), ui);
        else { ui.Log(AppName + " is not installed in " + ProgramFolder + "."); return false; }
        // The folder is removed once the uninstaller has closed.
        for (int i = 0; i < 40 && Directory.Exists(ProgramFolder); i++) Thread.Sleep(250);
        bool gone = !Directory.Exists(ProgramFolder);
        ui.Log(gone ? "Checked: " + ProgramFolder + " is gone." : "The program is still in " + ProgramFolder + " (exit " + code + ").");
        return gone;
    }

    // Windows can't replace or remove a running program.
    static bool CloseViewers(Step ui)
    {
        Process[] running = Process.GetProcessesByName(Key);
        if (running.Length == 0) return true;
        if (!ui.Ask(running.Length + " " + AppName + " window(s) are open. Close them to continue? (Reopen your documents afterwards.)")) return false;
        foreach (Process p in running)
        {
            try { p.CloseMainWindow(); if (!p.WaitForExit(3000)) { p.Kill(); p.WaitForExit(3000); } } catch { }
        }
        return true;
    }

    // A program as the user, without a window; its output goes to the log.
    static int RunAndLog(string program, string arguments, Step ui)
    {
        ProcessStartInfo psi = new ProcessStartInfo(program, arguments);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        using (Process p = Process.Start(psi))
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null && e.Data.Trim().Length > 0) ui.Log(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null && e.Data.Trim().Length > 0) ui.Log(e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    internal static string InstalledVersion()
    {
        return File.Exists(InstalledExe) ? FileVersionInfo.GetVersionInfo(InstalledExe).ProductVersion : null;
    }

    internal static string LaunchViewer()
    {
        if (!File.Exists(InstalledExe)) return "Not installed.";
        Process.Start(new ProcessStartInfo(InstalledExe) { UseShellExecute = false, WorkingDirectory = ProgramFolder });
        return null;
    }

    static bool WebView2RuntimeFound()
    {
        const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        foreach (string k in new[] { @"SOFTWARE\WOW6432Node\" + client, @"SOFTWARE\" + client })
            foreach (RegistryKey hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
                using (RegistryKey r = hive.OpenSubKey(k))
                {
                    string v = r == null ? null : r.GetValue("pv") as string;
                    if (!string.IsNullOrEmpty(v) && v != "0.0.0.0") return true;
                }
        return false;
    }

    // ------------------------------------------------------------------ register (Uninstall.exe --register)

    // The user's entries for the program installed in Program Files: .md / .markdown / .mdown / .mkd, "Open
    // with" for pictures, video and audio, Start menu shortcuts and the Settings > Apps entry. Takes no paths
    // from outside. Returns 0, 1 when an entry did not keep its new value, 2 when not installed.
    internal static int Register(Action<string> log)
    {
        string exe = InstalledExe;
        if (!File.Exists(exe)) { log(AppName + " is not installed in " + ProgramFolder + "."); return 2; }
        // A copy from earlier versions is no longer used.
        if (File.Exists(Path.Combine(LegacyFolder, ExeName)))
        {
            try { ClearDir(LegacyFolder); log("Removed the earlier copy in " + LegacyFolder); } catch { log("Could not remove the earlier copy in " + LegacyFolder + "."); }
        }
        string command = "\"" + exe + "\" \"%1\"", icon = "\"" + exe + "\",0";
        string app = @"Applications\" + ExeName;
        using (RegistryKey classes = UserRoot.CreateSubKey(@"Software\Classes"))
        using (RegistryKey backup = UserRoot.CreateSubKey(@"Software\" + Key))
        {
            // File type (ProgID)
            SetValue(classes, ProgId, "", "Markdown Document");
            SetValue(classes, ProgId + @"\DefaultIcon", "", icon);
            SetValue(classes, ProgId + @"\shell\open\command", "", command);
            SetValue(classes, ProgId + @"\shell\open", "FriendlyAppName", AppName);
            // Application entry (name + icon in "Open with" lists)
            SetValue(classes, app + @"\shell\open\command", "", command);
            SetValue(classes, app, "FriendlyAppName", AppName);
            SetValue(classes, app + @"\DefaultIcon", "", icon);
            foreach (string ext in MdExts)
            {
                using (RegistryKey ek = classes.CreateSubKey(ext))
                {
                    using (RegistryKey ow = ek.CreateSubKey("OpenWithProgids")) ow.SetValue(ProgId, new byte[0], RegistryValueKind.Binary);
                    SetValue(classes, app + @"\SupportedTypes", ext, "");
                    // The default for this extension (the previous one is kept for uninstalling).
                    string prev = ek.GetValue("") as string;
                    if (!string.IsNullOrEmpty(prev) && prev != ProgId) backup.SetValue("Prev" + ext, prev);
                    ek.SetValue("", ProgId);
                    ek.SetValue("Content Type", "text/markdown");
                    ek.SetValue("PerceivedType", "text");
                }
            }
            // "Open with" for pictures, video and audio: shown in the viewer's own page.
            SetValue(classes, MediaProgId, "", "Picture, video or audio");
            SetValue(classes, MediaProgId + @"\DefaultIcon", "", icon);
            SetValue(classes, MediaProgId + @"\shell\open\command", "", command);
            SetValue(classes, MediaProgId + @"\shell\open", "FriendlyAppName", AppName);
            foreach (string ext in MediaExts)
            {
                using (RegistryKey ow = classes.CreateSubKey(ext + @"\OpenWithProgids")) ow.SetValue(MediaProgId, new byte[0], RegistryValueKind.Binary);
                SetValue(classes, app + @"\SupportedTypes", ext, "");
            }
            foreach (string ext in OfferedExts) SetValue(classes, app + @"\SupportedTypes", ext, "");
            // Out of every other type's own "Open with" list again (earlier versions put the viewer there), and out of
            // the offered list for types no longer offered.
            foreach (string ext in EarlierExts)
                if (Array.IndexOf(MediaExts, ext) < 0) RemoveOpenWith(classes, ext, MediaProgId);
            using (RegistryKey st = classes.OpenSubKey(app + @"\SupportedTypes", true))
                if (st != null)
                    foreach (string ext in st.GetValueNames())
                        if (Array.IndexOf(MdExts, ext) < 0 && Array.IndexOf(MediaExts, ext) < 0 && Array.IndexOf(OfferedExts, ext) < 0) st.DeleteValue(ext, false);
        }

        // Start menu shortcuts: the viewer (no file: choose a folder / drag & drop) and the About window.
        Shortcut(Path.Combine(StartMenuFolder, AppName + ".lnk"), exe, "", "View Markdown files with figures and math - own window, no network port");
        Shortcut(Path.Combine(StartMenuFolder, "About " + AppName + ".lnk"), exe, "--about", "Version, preview-only security, WebView2 and library versions");

        // Settings > Apps entry (version, size, Uninstall button: the installed Uninstall.exe)
        string version = FileVersionInfo.GetVersionInfo(exe).ProductVersion;
        long size = 0;
        foreach (string f in Directory.GetFiles(ProgramFolder)) size += new FileInfo(f).Length;
        using (RegistryKey un = UserRoot.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key))
        {
            un.SetValue("DisplayName", AppName);
            un.SetValue("DisplayVersion", version);
            un.SetValue("Publisher", "Markdown Viewer");
            un.SetValue("Comments", "Preview-only Markdown viewer with figures, math and diagrams - WebView2 window, no network port");
            un.SetValue("DisplayIcon", exe + ",0");
            un.SetValue("InstallLocation", ProgramFolder);
            un.SetValue("EstimatedSize", (int)(size / 1024), RegistryValueKind.DWord);
            un.SetValue("NoModify", 1, RegistryValueKind.DWord);
            un.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            un.SetValue("UninstallString", "\"" + InstalledUninstaller + "\"");
        }

        // Read the entries back: Windows must now start this copy. (Something else holding on to the old
        // values, e.g. a security tool undoing changes to file types, would otherwise go unnoticed.)
        List<string> stale = new List<string>();
        foreach (string k in new[] { ProgId + @"\shell\open\command", app + @"\shell\open\command", MediaProgId + @"\shell\open\command" })
            using (RegistryKey r = UserRoot.OpenSubKey(@"Software\Classes\" + k))
            {
                string v = r == null ? null : r.GetValue("") as string;
                if (v != command) stale.Add("  " + k + " = " + v);
            }
        using (RegistryKey r = UserRoot.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key))
            if (r == null || (r.GetValue("DisplayVersion") as string) != version) stale.Add("  Settings > Apps entry (version)");
        if (stale.Count > 0)
        {
            log("WARNING: these entries did not take the new values, so Windows may still start another copy:");
            foreach (string s in stale) log(s);
        }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);       // file associations changed

        log("Registered " + AppName + " " + version + " for your account: .md files, Open with, Start menu, Settings > Apps.");
        // If the user picked a default app in Windows ("Always"), that choice wins over the installer.
        List<string> other = new List<string>();
        foreach (string ext in MdExts)
            using (RegistryKey r = UserRoot.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\" + ext + @"\UserChoice"))
            {
                string p = r == null ? null : r.GetValue("ProgId") as string;
                if (!string.IsNullOrEmpty(p) && p != ProgId) other.Add(ext + " -> " + p);
            }
        if (other.Count > 0)
        {
            log("Windows still has another default app for: " + string.Join(", ", other));
            log("To switch: right-click a .md file > Open with > Choose another app > " + AppName + " > Always.");
        }
        else log("If Windows asks which app to use the next time you open a .md file, pick " + AppName + " and click Always.");
        return stale.Count > 0 ? 1 : 0;
    }

    // Takes the ProgId out of a type's "Open with" list; an OpenWithProgids key or a type key left with nothing
    // in it at all (no values, no subkeys) is removed too - one that holds anything else is kept as it is.
    static void RemoveOpenWith(RegistryKey classes, string ext, string progId)
    {
        using (RegistryKey ow = classes.OpenSubKey(ext + @"\OpenWithProgids", true))
        {
            if (ow == null) return;
            ow.DeleteValue(progId, false);
            if (ow.ValueCount > 0 || ow.SubKeyCount > 0) return;
        }
        classes.DeleteSubKey(ext + @"\OpenWithProgids", false);
        using (RegistryKey ek = classes.OpenSubKey(ext))
            if (ek == null || ek.ValueCount > 0 || ek.SubKeyCount > 0) return;
        classes.DeleteSubKey(ext, false);
    }

    // Creates the key if it is missing (an existing key keeps its other values - e.g. other apps' entries under .md).
    static void SetValue(RegistryKey root, string path, string name, string value)
    {
        using (RegistryKey k = root.CreateSubKey(path)) k.SetValue(name, value);
    }

    static void Shortcut(string link, string target, string arguments, string description)
    {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try
        {
            object sc = Invoke(shell, "CreateShortcut", link);
            Set(sc, "TargetPath", target);
            Set(sc, "Arguments", arguments);
            Set(sc, "WorkingDirectory", Path.GetDirectoryName(target));
            Set(sc, "IconLocation", target + ",0");
            Set(sc, "Description", description);
            Invoke(sc, "Save");
            Marshal.ReleaseComObject(sc);
        }
        finally { Marshal.ReleaseComObject(shell); }
    }

    static string ShortcutTarget(string link)
    {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try
        {
            object sc = Invoke(shell, "CreateShortcut", link);
            string t = Get(sc, "TargetPath") as string;
            Marshal.ReleaseComObject(sc);
            return t;
        }
        finally { Marshal.ReleaseComObject(shell); }
    }

    static object Invoke(object o, string method, params object[] a) { return o.GetType().InvokeMember(method, BindingFlags.InvokeMethod, null, o, a); }
    static object Get(object o, string name) { return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null); }
    static void Set(object o, string name, object value) { o.GetType().InvokeMember(name, BindingFlags.SetProperty, null, o, new[] { value }); }

    // ------------------------------------------------------------------ uninstall (Uninstall.exe)

    // Removes the Program Files copy, any per-user copy from earlier versions and this account's entries, and
    // restores the previous .md defaults. Entries are removed only when they belong to the installed copy (or
    // point to a program that no longer exists): another copy's file types, "Open with", shortcuts and Settings
    // > Apps entry are left alone. One administrator prompt, for the firewall rules (if added) and the Program
    // Files folder together: a short readable PowerShell command, which waits until this program has closed
    // (it lives in that folder) and then removes the folder. The signing certificate is never touched; the
    // trust Trust-Certificate.cmd added for it is removed.
    internal static bool Uninstall(Step ui)
    {
        string machineDest = ProgramFolder, userDest = LegacyFolder;
        string dest = File.Exists(Path.Combine(machineDest, ExeName)) ? machineDest : userDest;
        string exe = Path.Combine(dest, ExeName), legacyExe = Path.Combine(userDest, ExeName);
        Func<string, bool> ours = program =>
        {
            if (string.IsNullOrWhiteSpace(program)) return true;
            program = program.Trim().Trim('"');
            return SamePath(program, exe) || SamePath(program, legacyExe) || !File.Exists(program);
        };
        bool failed = false;

        // Close the installed copy (any other copy is left running).
        foreach (Process p in Process.GetProcessesByName(Key))
        {
            try { if (ours(p.MainModule.FileName)) { p.Kill(); p.WaitForExit(3000); } } catch { }
        }

        // The trust Trust-Certificate.cmd added for the signing certificate (Windows asks to confirm a root removal).
        if (File.Exists(exe))
        {
            string thumb = Signature(exe).Thumbprint;
            if (thumb != null)
                foreach (StoreName name in new[] { StoreName.TrustedPublisher, StoreName.Root })
                {
                    X509Store store = new X509Store(name, StoreLocation.CurrentUser);
                    try
                    {
                        store.Open(OpenFlags.ReadWrite);
                        bool trusted = false;
                        foreach (X509Certificate2 c in store.Certificates) if (c.Thumbprint == thumb) trusted = true;
                        if (!trusted) continue;
                        List<X509Certificate2> remove = new List<X509Certificate2>();
                        foreach (X509Certificate2 c in store.Certificates)
                            if (c.Thumbprint == thumb || Array.IndexOf(CertSubjects, c.Subject) >= 0) remove.Add(c);
                        foreach (X509Certificate2 c in remove) { try { store.Remove(c); } catch { } }
                        ui.Log("Removed the certificate trust (" + name + ").");
                    }
                    catch { }
                    finally { store.Close(); }
                }
        }

        // File types and "Open with" - only those that start the installed copy (or nothing that exists any more).
        List<string> kept = new List<string>();
        using (RegistryKey classes = UserRoot.CreateSubKey(@"Software\Classes"))
        {
            foreach (string k in new[] { ProgId, MediaProgId, @"Applications\" + ExeName })
            {
                string program;
                using (RegistryKey c = classes.OpenSubKey(k + @"\shell\open\command"))
                {
                    if (c == null) { using (RegistryKey e = classes.OpenSubKey(k)) if (e == null) continue; program = null; }
                    else program = CommandExe(c.GetValue("") as string);
                }
                if (ours(program)) classes.DeleteSubKeyTree(k, false); else kept.Add(k + " -> " + program);
            }
            if (classes.OpenSubKey(ProgId) == null)
            {
                using (RegistryKey backup = UserRoot.OpenSubKey(@"Software\" + Key))
                    foreach (string ext in MdExts)
                        using (RegistryKey ek = classes.OpenSubKey(ext, true))
                        {
                            if (ek == null) continue;
                            using (RegistryKey ow = ek.OpenSubKey("OpenWithProgids", true)) if (ow != null) ow.DeleteValue(ProgId, false);
                            if ((ek.GetValue("") as string) == ProgId)
                            {
                                string prev = backup == null ? null : backup.GetValue("Prev" + ext) as string;
                                if (!string.IsNullOrEmpty(prev)) ek.SetValue("", prev); else ek.DeleteValue("", false);
                            }
                        }
                UserRoot.DeleteSubKeyTree(@"Software\" + Key, false);
            }
            if (classes.OpenSubKey(MediaProgId) == null)
                foreach (string ext in MediaExts.Concat(EarlierExts)) RemoveOpenWith(classes, ext, MediaProgId);
        }

        // Start menu shortcuts and the Settings > Apps entry - only those of the installed copy.
        foreach (string link in new[] { Path.Combine(StartMenuFolder, AppName + ".lnk"), Path.Combine(StartMenuFolder, "About " + AppName + ".lnk") })
        {
            try { if (File.Exists(link) && ours(ShortcutTarget(link))) File.Delete(link); } catch { }
        }
        string unKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Key;
        bool removeEntry = false;
        using (RegistryKey un = UserRoot.OpenSubKey(unKey))
            if (un != null)
            {
                string loc = un.GetValue("InstallLocation") as string;
                removeEntry = string.IsNullOrEmpty(loc) || SamePath(loc, dest) || !Directory.Exists(loc);
            }
        if (removeEntry) UserRoot.DeleteSubKeyTree(unKey, false);

        // Saved view settings; browser data and the error log.
        foreach (string d in new[] { Path.Combine(RoamingFolder, Key), Path.Combine(LocalFolder, Key) })
        {
            try { ClearDir(d); } catch { ui.Log("Could not remove " + d + " (in use?)."); }
        }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);

        // One administrator step for the firewall rules and the Program Files folder. It works the folder out itself.
        bool hasRules = FirewallRules().Count > 0, hasFolder = Directory.Exists(machineDest);
        string self = Assembly.GetExecutingAssembly().Location;
        bool inside = SamePath(Path.GetDirectoryName(self), machineDest);
        if (hasRules || hasFolder)
        {
            List<string> steps = new List<string> { "$env:PSModulePath = $PSHOME + '\\Modules'", "$ErrorActionPreference = 'Stop'" };
            if (hasRules) steps.Add("Remove-NetFirewallRule -Group " + Quote(FirewallGroup) + " -ErrorAction SilentlyContinue");
            if (hasFolder)
            {
                steps.Add("Set-Location -LiteralPath " + Quote(Environment.SystemDirectory));
                steps.Add("$dir = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) " + Quote(Key));
                // This program lives in that folder: wait until it has closed.
                if (inside) steps.Add("Wait-Process -Id " + Process.GetCurrentProcess().Id + " -Timeout 120 -ErrorAction SilentlyContinue");
                steps.Add("try { if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force } } catch { Add-Type -AssemblyName System.Windows.Forms; " +
                          "[void][System.Windows.Forms.MessageBox]::Show('Could not remove ' + $dir + '. Close " + AppName.Replace("'", "''") + " and uninstall again.', " + Quote(AppName) + "); exit 1 }");
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command " + NativeArgument(string.Join("; ", steps)));
                psi.Verb = "runas";
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process p = Process.Start(psi))
                {
                    if (!inside)
                    {
                        p.WaitForExit();
                        if (p.ExitCode != 0) { ui.Log("Could not remove " + machineDest + " (is the viewer still open?). Uninstall again."); failed = true; }
                    }
                    else ui.Log("The program folder " + machineDest + (hasRules ? " and the firewall rules are" : " is") + " removed as soon as " + UninstallerName + " has closed.");
                }
            }
            catch (Win32Exception)
            {
                ui.Log("Administrator rights were not granted: " + machineDest + (hasRules ? " and the firewall rules" : "") + " remain. Uninstall again to finish.");
                failed = true;
            }
        }

        // A per-user copy from earlier versions needs no administrator rights.
        if (Directory.Exists(userDest)) { try { ClearDir(userDest); } catch { ui.Log("Could not remove " + userDest + "; delete it later."); } }

        if (kept.Count > 0)
        {
            ui.Log("Left in place because they belong to another copy:");
            foreach (string k in kept) ui.Log("  " + k);
        }
        ui.Log(AppName + " was uninstalled" + (failed ? ", except as noted above." : "."));
        return !failed;
    }

    // The program an Open command starts: "C:\path\app.exe" "%1"  ->  C:\path\app.exe
    static string CommandExe(string command)
    {
        if (string.IsNullOrEmpty(command)) return null;
        Match m = Regex.Match(command, @"^\s*(?:""([^""]+)""|(\S+))");
        return m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value) : null;
    }

    // ------------------------------------------------------------------ firewall

    // Rules that block all network traffic in and out of the installed program. It needs no network access,
    // so they change nothing in how it works. They do not cover the WebView2 engine (msedgewebview2.exe),
    // which Windows shares with other apps. Added only by the administrator copy step (Place), for the program
    // it has just installed - no path is taken from outside; removed by Uninstall.exe's administrator step.
    static void AddFirewallRules(string program)
    {
        object policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
        object rules = Get(policy, "Rules");
        // This app's earlier rules first (a name can belong to several rules: until none is left).
        for (int i = 0; i < 20; i++)
        {
            List<string> names = FirewallRules();
            if (names.Count == 0) break;
            foreach (string n in names) Invoke(rules, "Remove", n);
        }
        foreach (int dir in new[] { 1, 2 })        // NET_FW_RULE_DIR_IN, _OUT
        {
            object rule = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule"));
            Set(rule, "Name", FirewallGroup + (dir == 1 ? " - block incoming" : " - block outgoing"));
            Set(rule, "Description", AppName + " needs no network access.");
            Set(rule, "ApplicationName", program);
            Set(rule, "Direction", dir);
            Set(rule, "Action", 0);                 // NET_FW_ACTION_BLOCK
            Set(rule, "Grouping", FirewallGroup);
            Set(rule, "Profiles", 0x7FFFFFFF);      // all profiles
            Set(rule, "Enabled", true);
            Invoke(rules, "Add", rule);
        }
    }

    // This app's firewall rules (read-only; works without administrator rights).
    internal static List<string> FirewallRules()
    {
        List<string> names = new List<string>();
        try
        {
            object policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2"));
            foreach (object r in (System.Collections.IEnumerable)Get(policy, "Rules"))
            {
                if ((Get(r, "Grouping") as string) == FirewallGroup) names.Add(Get(r, "Name") as string);
                Marshal.ReleaseComObject(r);
            }
        }
        catch { }
        return names;
    }

    // ------------------------------------------------------------------ helpers

    // A PowerShell string literal.
    static string Quote(string s) { return "'" + (s ?? "").Replace("'", "''") + "'"; }

    // One command-line argument, quoted by Windows' rules (CommandLineToArgvW).
    static string NativeArgument(string text)
    {
        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char ch in text)
        {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"') sb.Append('\\', 2 * backslashes + 1).Append('"');
            else sb.Append('\\', backslashes).Append(ch);
            backslashes = 0;
        }
        return sb.Append('\\', 2 * backslashes).Append('"').ToString();
    }

    // ------------------------------------------------------------------ signatures

    internal sealed class SignatureInfo
    {
        public int Status = unchecked((int)0x800B0100);     // TRUST_E_NOSIGNATURE
        public string Subject, Thumbprint;
        public DateTime NotAfter;
        // Exactly as signed. A developer's own certificate is not in Windows' trusted list (untrusted root),
        // but the check of the file's contents is the same.
        public bool Intact { get { return Subject != null && (Status == 0 || Status == unchecked((int)0x800B0109) || Status == unchecked((int)0x800B010A)); } }
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

    static string Why(SignatureInfo s)
    {
        return s.Subject == null ? "it is not signed"
             : s.Status == unchecked((int)0x80096010) ? "it has been changed since it was signed"
             : "its signature is not valid (0x" + s.Status.ToString("X8") + ")";
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
        public uint dwProvFlags = 0x1000 | 0x10;
        public uint dwUIContext = 0;
        public IntPtr pSignatureSettings = IntPtr.Zero;
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, WinTrustData data);

    static readonly Guid VerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    internal static SignatureInfo Signature(string path)
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
            s.NotAfter = cert.NotAfter;
        }
        catch { }
        return s;
    }

    internal static Image Logo()
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png"))
            return s == null ? null : new Bitmap(Image.FromStream(s));
    }
}

// ---------------------------------------------------------------------- the window

sealed class SetupForm : Form
{
    readonly string self, selfHash;
    readonly Setup.SignatureInfo sig;
    readonly bool setup = Setup.IsSetup;
    readonly Label status = new Label(), signer = new Label();
    readonly TextBox log = new TextBox();
    readonly Button install = new Button(), uninstall = new Button(), open = new Button(), close = new Button();
    bool busy, removed;

    public SetupForm(string self, string selfHash, Setup.SignatureInfo sig)
    {
        this.self = self; this.selfHash = selfHash; this.sig = sig;
        Text = Setup.Title;
        try { Icon = Icon.ExtractAssociatedIcon(self); } catch { }
        Font = new Font("Segoe UI", 9.5f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(640, 520);
        BackColor = SystemColors.Window;

        Panel header = new Panel { Dock = DockStyle.Top, Height = 104, BackColor = Color.FromArgb(0x1F, 0x3A, 0x5F) };
        PictureBox logo = new PictureBox { Image = Setup.Logo(), SizeMode = PictureBoxSizeMode.Zoom, Bounds = new Rectangle(24, 16, 72, 72), BackColor = Color.Transparent };
        Label title = new Label { Text = "Markdown Viewer (WebView2)", ForeColor = Color.White, Font = new Font("Segoe UI Semibold", 17f), AutoSize = true, Location = new Point(112, 22), BackColor = Color.Transparent };
        Label sub = new Label { Text = (setup ? "Setup" : "Uninstall") + "  ·  version " + SetupBuild.Version, ForeColor = Color.FromArgb(0xC8, 0xD6, 0xE8), Font = new Font("Segoe UI", 10.5f), AutoSize = true, Location = new Point(115, 60), BackColor = Color.Transparent };
        header.Controls.AddRange(new Control[] { logo, title, sub });

        Label about = new Label
        {
            Text = "Previews Markdown files with figures, math and diagrams in its own window. It never runs code from a document and never goes online.\r\n\r\n" +
                   (setup ? "Install puts the program in Program Files and blocks its network traffic (one administrator prompt), and sets up .md files, Open with and the Start menu for your account."
                          : "Uninstall removes the program from Program Files and its firewall rules (one administrator prompt), and its entries, settings and data for your account; your previous .md app comes back."),
            Location = new Point(24, 120), Size = new Size(592, 92)
        };
        status.Location = new Point(24, 216); status.Size = new Size(592, 22); status.Font = new Font("Segoe UI Semibold", 10f);
        signer.Location = new Point(24, 240); signer.Size = new Size(592, 70); signer.ForeColor = SystemColors.GrayText;
        signer.Text = "Publisher: " + (sig.Signer ?? "?") + "  ·  certificate " + sig.Thumbprint +
                      (sig.Trusted ? "" : "\r\nWindows does not know this certificate (a developer's own), so it may show the publisher as unknown. Compare the certificate with the one the developer gave you.");

        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.WordWrap = true;
        log.Font = new Font("Consolas", 9f); log.BackColor = SystemColors.Control;
        log.Location = new Point(24, 314); log.Size = new Size(592, 146); log.Visible = false;

        foreach (Button b in new[] { install, uninstall, open, close }) { b.Size = new Size(140, 32); b.Top = 474; b.UseVisualStyleBackColor = true; }
        install.Left = 24; uninstall.Left = 172; open.Left = 330; close.Left = 476;
        if (!setup) { install.Visible = false; uninstall.Left = 24; }
        uninstall.Text = "Uninstall"; open.Text = "Open the viewer"; close.Text = "Close";
        install.Click += (s, e) => Run(true);
        uninstall.Click += (s, e) => Run(false);
        open.Click += (s, e) => { string err = Setup.LaunchViewer(); if (err != null) MessageBox.Show(this, err, Text); };
        close.Click += (s, e) => Close();
        AcceptButton = setup ? install : uninstall; CancelButton = close;

        Controls.AddRange(new Control[] { header, about, status, signer, log, install, uninstall, open, close });
        FormClosing += (s, e) => { if (busy) e.Cancel = true; };
        Refresh2();
    }

    void Refresh2()
    {
        string v = Setup.InstalledVersion();
        if (removed) v = null;
        status.Text = v == null ? (removed ? "Uninstalled." : "Not installed on this PC.")
                    : !setup || v == SetupBuild.Version ? "Version " + v + " is installed."
                    : "Version " + v + " is installed; this Setup has " + SetupBuild.Version + ".";
        install.Text = v == null ? "Install" : v == SetupBuild.Version ? "Reinstall" : "Update";
        uninstall.Enabled = v != null;
        open.Enabled = v != null;
    }

    void Run(bool doInstall)
    {
        if (busy) return;
        if (!doInstall && MessageBox.Show(this, "Uninstall Markdown Viewer (WebView2)?\n\nThis removes the program from Program Files (Windows asks for administrator rights), its Windows entries, settings and browser data.",
                                          Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        busy = true;
        log.Visible = true; log.Clear();
        foreach (Button b in new[] { install, uninstall, open, close }) b.Enabled = false;
        UseWaitCursor = true;
        Setup.Step ui = new Setup.Step
        {
            Log = line => BeginInvoke(new Action(() => { log.AppendText(line.Replace("\n", "\r\n").Replace("\r\r\n", "\r\n") + "\r\n"); })),
            Ask = question => (bool)Invoke(new Func<bool>(() =>
                MessageBox.Show(this, question, Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes))
        };
        Thread t = new Thread(() =>
        {
            bool ok;
            try
            {
                ok = doInstall ? Setup.Install(self, selfHash, sig, ui)
                   : setup ? Setup.UninstallInstalled(ui)
                   : Setup.Uninstall(ui);          // Uninstall.exe itself: its folder goes once this window closes
            }
            catch (Exception ex) { ok = false; ui.Log("Stopped: " + ex.Message); }
            BeginInvoke(new Action(() =>
            {
                busy = false; UseWaitCursor = false;
                close.Enabled = true; install.Enabled = true;
                removed = ok && !doInstall;
                Refresh2();
                if (ok && doInstall) open.Focus(); else close.Focus();
            }));
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
    }
}
