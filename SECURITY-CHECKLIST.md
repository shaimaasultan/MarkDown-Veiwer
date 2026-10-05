# Security checklist — Markdown Viewer (WebView2)

Every hardening point added to this app, where it lives and how it was checked. `[x]` = done and tested;
`[ ]` = done, but still to be confirmed on a real run (these steps need a Windows administrator or signing
prompt, which the automated tests cannot click). Version numbers show when each point was added.
`[ ] To do:` = not done yet. (The points found by comparing with the CloClo widget's hardening history were all done in 1.8.6.)

**How to re-check:** `app\Check-Source.cmd` (project files unchanged since the last install) and the
tamper tests described under each section.

---

## 1. Documents never run code (preview only)

- [x] Scripts, event handlers, `javascript:` links, frames, forms and plugins are removed before display (sanitizer allowlist) — `src\viewer.js`
- [x] The window's Content-Security-Policy blocks them as well; `file:` removed from the policy — `src\viewer.html` (1.5.0)
- [x] Only Markdown, text, images, audio and video are read from disk; HTML, scripts, PDFs and programs are refused (403) — `ServedTypes` in `app\MarkdownViewerWebView2.cs`
- [x] Size limits: 50 MB of text, 200 MB of media (media streamed in 4 MB ranges) (1.5.0)
- [x] Folder links (junctions, symbolic links) cannot lead outside the document's folder (`RealPath`) (1.5.0)
- [x] A document cannot draw over the viewer's controls; a diagram cannot add its own CSS (CSS containment) (1.5.0)
- [x] Blocked-code alert: a popup says when a file contained code that was removed
- [x] Safety check badge and report: phishing links, look-alike addresses and letters, hidden text, AI-aimed instructions, download-and-run commands, Trojan Source (1.7.0)
- [x] Code examples cannot be hidden or restyled (no copy-paste traps)

## 2. Never online, private

- [x] No network port: the page lives at a private in-app address; every request is answered by the program
- [x] All libraries bundled; the engine cannot resolve any internet name; no background networking, component updates, pings, SmartScreen or account sign-in
- [x] Web and mail links open outside only after a question showing the real address (1.5.0)
- [x] Only `http:`, `https:` and `mailto:` addresses are ever handed to Windows; any other scheme is ignored (`AskOpenOutside`)
- [x] Settings saved through a temporary file and an atomic replace, so a crash while saving cannot corrupt `settings.ini` and silently reset choices such as Pictures off (1.8.6) — tested: saved value present, no temporary file left
- [x] InPrivate window; camera, microphone, location, notifications, clipboard reading refused; downloads only from the viewer; trimmed right-click menu (1.5.0)
- [x] Developer tools off; documents refused if WebView2 remote debugging is on or cannot be checked (fail closed) (1.5.0)
- [x] `WEBVIEW2_*` environment variables cleared before the engine starts
- [x] **Fresh browser data:** a new, empty WebView2 data folder at every start; ended runs' folders (and the old shared folder) deleted (1.8.3) — tested with two windows open and after a restart

## 3. Signed program, no loose script files

- [x] The page and every library packed into `MarkdownViewerWebView2.Content.dll`; program and DLL Authenticode-signed with the same certificate (1.6.0)
- [x] Both signatures checked at every start, offline, before anything is loaded (1.6.0)
- [x] WebView2 files must carry Microsoft's valid signature (1.6.0)
- [x] **Exact WebView2 files:** their SHA-256 is compiled into the signed program; an older or other Microsoft-signed file is refused (1.8.0) — tested: junk `Core.dll`, other Microsoft DLL as `Core.dll`
- [x] Microsoft's name matched exactly (`O=Microsoft Corporation,`)
- [x] The Microsoft root itself is not pinned, but each WebView2 file's exact SHA-256 is - so only the very files the app was built with pass
- [x] Not a single-file build: no runtime DLLs are unpacked to `%TEMP%`; every DLL ships beside the program and is checked there (CloClo's extraction-folder issue does not apply)

## 4. Start-up checks (before any DLL from the app folder is used)

- [x] **No `.config` file** next to the program (it could redirect .NET to unchecked copies) — reproduced the bypass first, then fixed
- [x] Custom AppDomain manager refused
- [x] `Run` kept out of `Main` (`NoInlining`), so nothing from WebView2 loads before the checks
- [x] **Folder allow-list:** anything not part of the app in its folder (planted DLL, `.config`, `.manifest`, `.local` folder) stops the start (1.8.1) — tested with junk `version.dll`, `.exe.local`, `.exe.config`, `.exe.manifest`
- [x] **Checked files stay locked** (read sharing only) until the app closes; the folder cannot be renamed (1.8.1) — tested: write and rename refused while running
- [x] **Safe DLL loading:** System32 first, no network-share or low-integrity images, no current folder/PATH (`SetProcessMitigationPolicy`, `SetDefaultDllDirectories`) (1.8.1) — confirmed ON with `Get-ProcessMitigation`
- [x] The app's own calls into Windows DLLs load from System32 only (`DefaultDllImportSearchPaths`) (1.8.3)
- [x] **No startup hooks:** `COR_ENABLE_PROFILING`, `COR_PROFILER*`, `APPDOMAIN_MANAGER_*` refuse the start (`DOTNET_STARTUP_HOOKS` does not apply to .NET Framework) (1.8.2) — tested with profiler variables set
  - Note: .NET has already loaded a profiler when this check runs, so it limits the damage rather than preventing it
- [x] **Not as administrator by accident:** started elevated while a normal start is possible, the app refuses (1.8.2)
  - [ ] Confirm on a real run: open a `.md` from an administrator prompt → refusal message
- [x] **Genuine engine:** the started `msedgewebview2.exe` must be Microsoft-signed and under Program Files (1.8.1) — tested with the real engine and with `powershell.exe` as a stand-in
- [x] Unexpected errors on the window thread and in background tasks are caught and logged to `%LOCALAPPDATA%\MarkdownViewerWebView2\errors.log` (type and stack only, never the message, which can quote document text) instead of crashing - a crash hands Windows Error Reporting a memory dump that can hold the open document; an error on another thread ends the app without a dump (1.8.6) — tested: type logged, message not
- [x] DLL planting checked for 28 DLL names: 25 caught by the folder check; `cryptbase`, `cryptsp`, `profapi` are loaded by .NET before any app code → only the Program Files install fully protects (documented)

## 5. Windows entries (file types, Open with)

- [x] **Self-repair:** an installed copy re-points the `.md` / Open with / media entries when they point to a deleted copy; the Program Files copy also when they point to any other copy; development builds never touch them (1.8.4) — 9 decision cases + end-to-end repair tested
- [x] The installer reads the entries back and warns if a change did not stick (1.8.4)
- [x] Uninstall entry runs PowerShell by full path (1.8.4)
- [x] Real registry confirmed pointing to Program Files (read from outside the test session)

## 6. Signing key and builds

- [x] **Protected signing key:** a new certificate whose key needs your confirmation for every signing (`-KeyProtection Protect`); unprotected certificates are no longer used (1.8.3) — new key confirmed at `ForceHighProtection`
  - [ ] Delete the old unprotected certificate `56EB660C…D72F` in certmgr.msc › Personal › Certificates
- [x] **Only fresh files are signed:** the build signs just the program and Content DLL it has compiled; WebView2 files are never signed by the build (1.8.4)
- [x] **Tampered SDK stops the build** before anything is compiled or signed: Microsoft signature + pinned SHA-256 in `build.ps1` (1.8.4) — tested: one byte changed in `WebView2Loader.dll`, other Microsoft DLL as `Core.dll`
- [x] Compiler found via Windows' own folder (not `WINDIR`) and must be Microsoft-signed (1.8.4)
- [x] Generated source written next to the build, not into the shared Temp folder (1.8.4)
- [x] `build.ps1` run on its own refuses an administrator window (as `Install.cmd` already does), so the compiler never runs elevated (1.8.6)
- [x] **Trust-Certificate adds Trusted Roots only**, not Trusted Publishers (Office macros / AllSigned scripts) (1.8.3)

## 7. Install in Program Files (one installer)

- [x] `Install.cmd` always installs to `C:\Program Files\MarkdownViewerWebView2`; the per-user copy of earlier versions is removed (1.8.2 → single installer in 1.8.4)
- [x] Build, signing and registrations run as you; **only the copy** (`place.ps1`) runs as administrator
- [x] `Install.cmd` refuses to be started as administrator (1.8.2)
- [x] The installer never starts the app, so it can never leave a copy running with administrator rights
- [x] The administrator step is passed to the elevated PowerShell inline (`-EncodedCommand`, read from `place.ps1` at that moment) instead of running a file from the project folder, so no file can be swapped between the UAC prompt and its start (1.8.6) — tested: inline step installs all 11 files — replaced in 1.8.7 by the readable bootstrap below
- [x] **Readable administrator prompt:** the elevated PowerShell gets a short readable command - what "Show more details" shows: `place.ps1`'s path and SHA-256, every file's SHA-256 and an accepted certificate. Elevated, it reads `place.ps1` once, checks the SHA-256 and runs exactly those bytes (a swapped file → exit 8) (1.8.7) — tested: install 0, swapped after hashing 8, refusal inside passed back 3, byte-order mark accepted
- [x] **Source checked before building:** `Install.cmd` runs the installed checker against the project folder first; changes since the last install are listed and built only after you answer Y (1.8.7)
- [x] Every copied file is compared, inside the administrator step, with the SHA-256 taken from the build just before; a difference or an unlisted file removes the staging folder and stops the install with the installed copy untouched (exit 7) (1.8.6) — tested: wrong hash, unlisted file
- [x] The installer stops with a message instead of waiting forever when it cannot read the keyboard for the certificate question (e.g. PowerShell ISE, redirected input) (1.8.6) — tested with redirected input
- [x] **Updates keep the certificate:** a build signed by another certificate is refused unless you confirm both thumbprints with Y (1.8.3) — tested exit 3 / accept
- [x] The admin step works out the Program Files folder itself (not `$env:ProgramFiles`) and accepts no target from outside (1.8.4)
- [x] **Staging folder:** files copied into an admin-only staging folder, checked there, then swapped in; a copy in use is never half replaced (1.8.4) — tested all exit codes 0/2/3/4/6, no leftovers
- [x] Source files that are links are refused (1.8.4)
- [x] No log files from administrator steps in your folders (exit codes instead) (1.8.4)
- [x] After the copy, the installer checks as you that Program Files holds exactly the built files (1.8.4)
- [x] Firewall block rules moved to the new path on update
- [ ] Confirm on a real run: `app\Install.cmd` → signing confirmation → UAC prompt → "Copied to … and checked"

## 8. Admin-step hygiene (all scripts)

- [x] **Only Windows PowerShell's own modules** (`PSModulePath` = `$PSHOME\Modules`, set before any command) in every script — reproduced the look-alike module attack first, then fixed (1.8.2+)
- [x] PowerShell and cmd started by full path in scripts, all `.cmd` launchers and the uninstall entry (1.8.2–1.8.4)
- [x] Program Files from `GetFolderPath`, never from an environment variable — also for the elevated folder delete in uninstall (1.8.4)
- [x] Firewall script: results in its own window, no log file (1.8.4)
- [x] **Firewall launchers elevate only the installed copy:** `firewall.ps1` relaunches the copy in Program Files (only an administrator can change it), never the project-folder file, which could be swapped between the prompt and its start (1.8.7)
  - [ ] Confirm on a real run: `Firewall-Block.cmd` / `Firewall-Unblock.cmd`
- [x] Uninstall removes the Program Files copy, per-user leftovers, entries, settings, browser data, firewall rules and certificate trust; restores the previous `.md` default
- [x] **Uninstall removes only its own entries** (file types, Open with, shortcuts, Settings › Apps entry that start the installed copy or a program that no longer exists; others are kept and listed) and uses **one administrator prompt** - a readable command, no script file - for the firewall rules and the folder together (1.8.7) — tested: 7 ownership cases
  - [ ] Confirm on a real run (only when you want to uninstall)

## 9. Checking the project folder

- [x] **Install record:** every install records the SHA-256 of every project file (except `.git\`, `app\dist\`; links not followed) in Program Files, where only an administrator can change it (1.8.5)
- [x] `app\Check-Source.cmd` lists files changed, added or removed since the last install (1.8.5) — tested unchanged / changed / added / removed
- [x] Line endings fixed per file type (`.gitattributes`), so a checkout or pull never rewrites a file and causes false alarms — fresh clone compared byte for byte
  - [ ] After the next install, run `Check-Source.cmd` → "No changes"
- [x] `check-source.ps1` is installed in Program Files with the record, and `Check-Source.cmd` runs that copy (found through Windows' own Program Files lookup) - not the copy in the project folder, which a program running as you could change to always report "No changes" (1.8.6) — tested: installed checker with -Root and with the recorded folder; "not installed yet" message
- [x] The record is taken before the build and compared again after it; the install is refused if the sources changed while building (1.8.6) — tested: unchanged → 0, changed → 1

## 10. Clean-up after testing

- [x] No test DLLs, look-alike modules, test folders or profiler variables left anywhere (searched scratchpad, Temp, project, install folders, Documents modules)
- [x] All installed WebView2 DLLs carry Microsoft's signature and the pinned hashes

---

## Known limits (by design)

- Windows' administrator prompt is not a security boundary against programs already running as you: they
  could change this repository's scripts or sources before you install. Use `Check-Source.cmd` and
  `git status` before installing, and confirm a signing request only while a build you started is running.
- `app\dist\` is for testing only; full protection applies to the installed copy in Program Files.
- The optional firewall rules cover `MarkdownViewerWebView2.exe`, not the shared WebView2 engine.
- Signatures carry no timestamp (builds never go online). The signing certificate is valid until October
  2036; after that the start-up check refuses the program, so install a build signed with a new
  certificate before then.
- Not applicable from the CloClo comparison (this app has no such feature): weather and network requests,
  clipboard and selection reading, screen-capture exclusion, dictation, colour picker, HTTP limits,
  notification logos, `.pfx` signing.
