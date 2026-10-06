// Markdown Viewer (WebView2) - Setup.
//
// One signed file that carries the built, signed program and installs it on any PC: the program and its
// files are resources of this file, listed with their SHA-256 (payload.sha256), so its signature covers them.
//
// Install (run as the user):
//   - this file is locked for the whole run, its signature checked and its SHA-256 taken;
//   - the copy into Program Files is the only step with administrator rights. What runs elevated is Windows
//     PowerShell from System32 with a short readable command (shown under "Show more details" in the UAC
//     prompt): it reads this file's bytes once, checks them against that SHA-256 and runs Setup.Place from
//     those bytes in memory. So the administrator step never starts a program from the Downloads folder,
//     where a planted DLL could be loaded with it, and a file swapped after the check never runs (exit 8);
//   - Place writes the files into a staging folder inside Program Files (only administrators can change it),
//     checks each one's SHA-256, the program's and Content DLL's signature (this file's certificate) and
//     Microsoft's on the WebView2 files, then swaps the folders (exit codes as in place.ps1);
//   - the file types, Open with, Start menu and Settings > Apps entries are made for the user by register.ps1,
//     run from Program Files.
// Uninstall runs the installed uninstall.ps1 (it asks for administrator rights itself).
//
// Build: build.ps1 (after the program), which embeds the files and signs this file with the same certificate.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Markdown Viewer (WebView2) Setup")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyDescription("Installs or uninstalls Markdown Viewer (WebView2).")]
[assembly: AssemblyCompany("Markdown Viewer")]
[assembly: AssemblyCopyright("Markdown Viewer")]
// Windows DLLs this file calls (kernel32, advapi32, wintrust) come from System32 only.
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class Setup
{
    const string AppName = "Markdown Viewer (WebView2)";
    const string Key = "MarkdownViewerWebView2";
    const string ExeName = Key + ".exe";
    const string ContentDll = Key + ".Content.dll";
    static readonly string[] MicrosoftFiles = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };

    static string ProgramFolder { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Key); } }
    static string PowerShellExe { get { return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"); } }

    // ------------------------------------------------------------------ start (as the user)

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            ProtectDllLoading();
            string problem = CheckStartupHooks() ?? CheckConfig() ?? CheckElevation();
            if (problem == null && !Environment.Is64BitProcess) problem = "Setup needs 64-bit Windows.";
            if (problem != null) { MessageBox.Show(problem, AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }

            // Locked first (others may read it, nobody may change, rename or delete it until Setup ends), so the
            // file whose signature and SHA-256 are checked is the file the administrator step reads.
            string self = Assembly.GetExecutingAssembly().Location;
            FileStream selfLock = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read);
            string selfHash;
            using (SHA256 sha = SHA256.Create()) selfHash = Hex(sha.ComputeHash(selfLock));
            SignatureInfo sig = Signature(self);
            if (!sig.Intact)
            {
                MessageBox.Show("This Setup file cannot be trusted: " + Why(sig) + ".\n\nNothing was installed. Get a new copy from the person who gave it to you.",
                                AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(self, selfHash, sig));
            GC.KeepAlive(selfLock);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, AppName + " Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

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

    // .NET would load a profiler or AppDomain manager named by these variables into Setup.
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
        return "These settings would make .NET load extra code into Setup:\n\n  " + string.Join("\n  ", found) +
               "\n\nSetup will not run. Remove them (Settings > System > About > Advanced system settings > Environment Variables).";
    }

    // A .config file next to Setup could send .NET to other code.
    static string CheckConfig()
    {
        string config = AppDomain.CurrentDomain.SetupInformation.ConfigurationFile;
        if (!string.IsNullOrEmpty(config) && File.Exists(config))
            return Path.GetFileName(config) + " was found next to Setup. It could change what Setup loads.\n\nSetup will not run. Delete that file or move Setup to another folder.";
        if (AppDomain.CurrentDomain.DomainManager != null) return "Something has changed how .NET starts Setup.\n\nSetup will not run.";
        return null;
    }

    // Started with "Run as administrator": the entries would be made for the administrator account, and a
    // program started from the Downloads folder should not run elevated. Setup asks for that one step itself.
    static string CheckElevation()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return null;
        try
        {
            int type, size;
            if (GetTokenInformation(token, 18, out type, 4, out size) && type == 2)
                return "Start Setup normally (double-click it), not with \"Run as administrator\".\n\n" +
                       "Setup asks for administrator rights itself, only to copy the program into Program Files.";
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

    // ------------------------------------------------------------------ the files inside this Setup

    // name -> SHA-256 of every file to install (a resource of this signed file).
    static Dictionary<string, string> Manifest()
    {
        Dictionary<string, string> want = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.sha256"))
        using (StreamReader r = new StreamReader(s, Encoding.UTF8))
        {
            string line;
            while ((line = r.ReadLine()) != null)
            {
                Match m = Regex.Match(line, @"^([A-Za-z0-9_.\-]+)=([0-9A-F]{64})$");
                if (m.Success) want[m.Groups[1].Value] = m.Groups[2].Value;
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

    // ------------------------------------------------------------------ the administrator step

    // Run elevated, from this file's bytes in memory (see the top of this file). Trusts nothing it is handed
    // but the certificate the user's Setup was signed with: the folder comes from Windows' own record of
    // Program Files, and the files come from this (hash-checked) assembly. Writes no log; the result is the
    // exit code: 0 done, 2 program/Content DLL not signed by `signer`, 3 an installed copy signed by another
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
            SignatureInfo exe = Signature(Path.Combine(stage, ExeName)), content = Signature(Path.Combine(stage, ContentDll));
            if (!exe.Intact || !content.Intact || exe.Thumbprint != signer || content.Thumbprint != signer) return Fail(stage, 2);
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
            // Renaming fails as a whole while a file in the old folder is in use: a running copy is never left
            // half replaced. Anything else that was in the old folder goes with it.
            if (Directory.Exists(dest)) Directory.Move(dest, old);
            try { Directory.Move(stage, dest); }
            catch { if (Directory.Exists(old) && !Directory.Exists(dest)) Directory.Move(old, dest); throw; }
            try { ClearDir(old); } catch { }
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

    // ------------------------------------------------------------------ install and uninstall (as the user)

    internal sealed class Step
    {
        public Action<string> Log;
        public Func<string, bool> Ask;
    }

    static readonly string[] PlaceErrors =
    {
        null, null, "the program or its Content DLL is not signed by this Setup's certificate, or was changed after signing",
        "the installed copy is signed by a different certificate", "a WebView2 file does not carry a valid Microsoft signature",
        null, "the files could not be copied (is the viewer open in another account?)", "a file differs from the list inside Setup",
        "this Setup file changed after it was checked"
    };

    internal static bool Install(string self, string selfHash, SignatureInfo sig, Step ui)
    {
        if (!CloseViewers(ui)) { ui.Log("Nothing was changed."); return false; }
        string dest = ProgramFolder, installedExe = Path.Combine(dest, ExeName);
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

        ui.Log("Copying the program to " + dest + " ...");
        ui.Log("Windows asks for administrator rights for Windows PowerShell: it runs only the copy step from this Setup file\r\n" +
               "(\"Show more details\" shows the command, with this file's path and SHA-256).");
        string bootstrap = string.Join("; ", new[]
        {
            "$env:PSModulePath = $PSHOME + '\\Modules'",
            "$ErrorActionPreference = 'Stop'",
            "$codeFile = " + Quote(self),
            "$codeHash = '" + selfHash + "'",
            "$bytes = [IO.File]::ReadAllBytes($codeFile)",
            "if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace '-', '') -ne $codeHash) { exit 8 }",
            "$r = [Reflection.Assembly]::Load($bytes).GetType('Setup').GetMethod('Place').Invoke($null, [object[]]@(" + Quote(sig.Thumbprint) + ", " + Quote(accept) + "))",
            // Firewall block rules (firewall.ps1) name the program's path: keep them on the installed copy.
            "if ($r -eq 0) { try { $rules = @(Get-NetFirewallRule -Group " + Quote(AppName) + " -ErrorAction SilentlyContinue); if ($rules.Count) { $rules | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program " + Quote(installedExe) + " } } catch { } }",
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
            if (!want.ContainsKey(Path.GetFileName(e))) differs.Add(Path.GetFileName(e));
        if (differs.Count > 0) ui.Log("WARNING: in " + dest + " these do not match this Setup: " + string.Join(", ", differs));
        else ui.Log("Copied to " + dest + " and checked: exactly the files inside this Setup.");

        // File types, Open with, Start menu, Settings > Apps: register.ps1 from Program Files, as the user.
        int registered = RunPowerShell(Path.Combine(dest, "register.ps1"), ui);
        if (registered != 0) ui.Log("Some Windows entries could not be set (see above).");

        string version = FileVersionInfo.GetVersionInfo(installedExe).ProductVersion;
        ui.Log("\r\nInstalled " + AppName + " " + version + ".");
        int left = (int)Math.Floor((sig.NotAfter - DateTime.Now).TotalDays);
        if (left < 365)
            ui.Log("Note: the signing certificate expires on " + sig.NotAfter.ToString("yyyy-MM-dd") + " (" + left + " days); after that the viewer refuses to start. Ask for a new Setup before then.");
        if (!WebView2RuntimeFound()) ui.Log("Note: the Microsoft Edge WebView2 Runtime was not found. The viewer needs it: install it from Microsoft (\"WebView2 Runtime\").");
        return true;
    }

    internal static bool Uninstall(Step ui)
    {
        string script = Path.Combine(ProgramFolder, "uninstall.ps1");
        if (!File.Exists(script)) { ui.Log(AppName + " is not installed in " + ProgramFolder + "."); return false; }
        if (!CloseViewers(ui)) { ui.Log("Nothing was changed."); return false; }
        ui.Log("Uninstalling (Windows asks for administrator rights to remove the program from Program Files) ...");
        // The installed uninstall.ps1: only an administrator can change it there.
        int code = RunPowerShell(script, ui);
        bool gone = !File.Exists(Path.Combine(ProgramFolder, ExeName));
        ui.Log(gone ? "\r\n" + AppName + " was uninstalled." : "\r\nThe program is still in " + ProgramFolder + " (exit " + code + ").");
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

    // A script from Program Files, by Windows PowerShell's full path, as the user; its output goes to the log.
    static int RunPowerShell(string script, Step ui)
    {
        ProcessStartInfo psi = new ProcessStartInfo(PowerShellExe, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + NativeArgument(script));
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
        string exe = Path.Combine(ProgramFolder, ExeName);
        return File.Exists(exe) ? FileVersionInfo.GetVersionInfo(exe).ProductVersion : null;
    }

    internal static string LaunchViewer()
    {
        string exe = Path.Combine(ProgramFolder, ExeName);
        if (!File.Exists(exe)) return "Not installed.";
        Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = ProgramFolder });
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
    readonly Label status = new Label(), signer = new Label();
    readonly TextBox log = new TextBox();
    readonly Button install = new Button(), uninstall = new Button(), open = new Button(), close = new Button();
    bool busy;

    public SetupForm(string self, string selfHash, Setup.SignatureInfo sig)
    {
        this.self = self; this.selfHash = selfHash; this.sig = sig;
        Text = "Markdown Viewer (WebView2) Setup";
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
        Label sub = new Label { Text = "Setup  ·  version " + SetupBuild.Version, ForeColor = Color.FromArgb(0xC8, 0xD6, 0xE8), Font = new Font("Segoe UI", 10.5f), AutoSize = true, Location = new Point(115, 60), BackColor = Color.Transparent };
        header.Controls.AddRange(new Control[] { logo, title, sub });

        Label about = new Label
        {
            Text = "Previews Markdown files with figures, math and diagrams in its own window. It never runs code from a document and never goes online.\r\n\r\n" +
                   "Install puts the program in Program Files - Windows asks for administrator rights once, for that copy only - and sets up .md files, Open with, the Start menu and Settings › Apps for your account.",
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
        uninstall.Text = "Uninstall"; open.Text = "Open the viewer"; close.Text = "Close";
        install.Click += (s, e) => Run(true);
        uninstall.Click += (s, e) => Run(false);
        open.Click += (s, e) => { string err = Setup.LaunchViewer(); if (err != null) MessageBox.Show(this, err, Text); };
        close.Click += (s, e) => Close();
        AcceptButton = install; CancelButton = close;

        Controls.AddRange(new Control[] { header, about, status, signer, log, install, uninstall, open, close });
        FormClosing += (s, e) => { if (busy) e.Cancel = true; };
        Refresh2();
    }

    void Refresh2()
    {
        string v = Setup.InstalledVersion();
        status.Text = v == null ? "Not installed on this PC." : v == SetupBuild.Version ? "Version " + v + " is installed." : "Version " + v + " is installed; this Setup has " + SetupBuild.Version + ".";
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
            try { ok = doInstall ? Setup.Install(self, selfHash, sig, ui) : Setup.Uninstall(ui); }
            catch (Exception ex) { ok = false; ui.Log("Stopped: " + ex.Message); }
            BeginInvoke(new Action(() =>
            {
                busy = false; UseWaitCursor = false;
                close.Enabled = true; install.Enabled = true;
                Refresh2();
                if (ok && doInstall) open.Focus();
            }));
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
    }
}
