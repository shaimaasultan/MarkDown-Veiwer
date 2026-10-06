# Security checklist — Markdown Viewer (WebView2)

Every hardening point added to this app, where it lives and how it was checked. `[x]` = done and tested;
`[ ]` = done, but still to be confirmed on a real run (these steps need a Windows administrator or signing
prompt, which the automated tests cannot click). Version numbers show when each point was added.
`[ ] To do:` = not done yet. (The points found by comparing with the CloClo widget were all done in 1.8.6–1.8.8; none are open.)

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
- [x] **Every file opened on its own stays sandboxed** (no scripts, so even an SVG cannot run code); because a sandboxed page cannot play video or audio, links to video and audio open in a new viewer window with its player instead of the raw file (1.9.1) — reproduced: the app's headers on the promo video gave "no source", without the sandbox it played
  - [ ] Confirm on a real run: in the installed viewer, click the promo video (poster or link) in README.md → it plays in a new window

## 2. Never online, private

- [x] No network port: the page lives at a private in-app address; every request is answered by the program
- [x] All libraries bundled; the engine cannot resolve any internet name; no background networking, component updates, pings, SmartScreen or account sign-in
- [x] Web and mail links open outside only after a question showing the real address (1.5.0)
- [x] Only `http:`, `https:` and `mailto:` addresses are ever handed to Windows; any other scheme is ignored (`AskOpenOutside`)
- [x] Settings saved through a temporary file and an atomic replace, so a crash while saving cannot corrupt `settings.ini` and silently reset choices such as Pictures off (1.8.6) — tested: saved value present, no temporary file left
- [x] The temporary settings file gets a random name and is created with `CreateNew`, so nothing can place a file or link there beforehand to redirect the write (1.8.8) — tested: two saves, no temporary file left
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
- [x] **Legacy injection points off:** AppInit_DLLs, global window hooks, legacy (non-TSF) input methods and Winsock layered providers are disabled for the process (`ProcessExtensionPointDisablePolicy`) (1.8.8) — confirmed ON with `Get-ProcessMitigation`; documents still open normally
- [x] **No startup hooks:** `COR_ENABLE_PROFILING`, `COR_PROFILER*`, `APPDOMAIN_MANAGER_*` refuse the start (`DOTNET_STARTUP_HOOKS` does not apply to .NET Framework) (1.8.2) — tested with profiler variables set
  - Note: .NET has already loaded a profiler when this check runs, so it limits the damage rather than preventing it
- [x] **Not as administrator by accident:** started elevated while a normal start is possible, the app refuses (1.8.2)
  - [x] Confirmed on a real run: open a `.md` from an administrator prompt → refusal message (2026-10-06)
- [x] **Genuine engine:** the started `msedgewebview2.exe` must be Microsoft-signed and under Program Files (1.8.1) — tested with the real engine and with `powershell.exe` as a stand-in
- [x] Unexpected errors on the window thread and in background tasks are caught and logged to `%LOCALAPPDATA%\MarkdownViewerWebView2\errors.log` (type and stack only, never the message, which can quote document text) instead of crashing - a crash hands Windows Error Reporting a memory dump that can hold the open document; an error on another thread ends the app without a dump (1.8.6) — tested: type logged, message not
  - Verified against Windows Error Reporting (1.8.8 review): without the handler a background-thread crash started WerFault and logged crash events 1000/1026; with it the process ended with code 3, no WerFault, no crash events
- [x] DLL planting checked for 28 DLL names: 25 caught by the folder check; `cryptbase`, `cryptsp`, `profapi` are loaded by .NET before any app code → only the Program Files install fully protects (documented)

## 5. Windows entries (file types, Open with)

- [x] **Self-repair:** an installed copy re-points the `.md` / Open with / media entries when they point to a deleted copy; the Program Files copy also when they point to any other copy; development builds never touch them (1.8.4) — 9 decision cases + end-to-end repair tested
- [x] The installer reads the entries back and warns if a change did not stick (1.8.4)
- [x] Uninstall entry runs PowerShell by full path (1.8.4)
- [x] Real registry confirmed pointing to Program Files (read from outside the test session)

## 6. Signing key and builds

- [x] **Protected signing key:** a new certificate whose key needs your confirmation for every signing (`-KeyProtection Protect`); unprotected certificates are no longer used (1.8.3) — new key confirmed at `ForceHighProtection`
  - [x] The old unprotected certificate `56EB660C…D72F` is deleted; your only signing certificate is now the protected `3EA8DD95…` (key protection `ForceHighProtection`), which signed the installed 1.8.8 (checked 2026-10-05)
- [x] **Only fresh files are signed:** the build signs just the program and Content DLL it has compiled; WebView2 files are never signed by the build (1.8.4)
- [x] **Tampered SDK stops the build** before anything is compiled or signed: Microsoft signature + pinned SHA-256 in `build.ps1` (1.8.4) — tested: one byte changed in `WebView2Loader.dll`, other Microsoft DLL as `Core.dll`
- [x] Compiler found via Windows' own folder (not `WINDIR`) and must be Microsoft-signed (1.8.4)
- [x] Generated source written next to the build, not into the shared Temp folder (1.8.4)
- [x] `build.ps1` run on its own refuses an administrator window (as `Install.cmd` already does), so the compiler never runs elevated (1.8.6)
- [x] **Trust-Certificate adds Trusted Roots only**, not Trusted Publishers (Office macros / AllSigned scripts) (1.8.3)
- [x] **Expiry warning a year ahead:** signatures carry no timestamp, so the viewer stops starting when the certificate expires; `Install.cmd` warns once less than 365 days are left and says what to do (1.9.0) — tested with 3650 / 200 / 10 days left: quiet / warning / warning
- [x] **Trust-Certificate takes the right certificate:** only from the program installed in Program Files (no per-user or `dist\` copy, no environment variable), only if it is intact and signed by your own signing certificate (the one with its private key on this PC), added straight from memory with no temporary file (1.8.8) — tested: not installed, unsigned and Microsoft-signed programs all refused; nothing added

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
- [x] Confirmed on a real run: version 1.8.7 installed through `Install.cmd` with the readable UAC prompt - Program Files holds exactly the 11 expected files, signed with the protected certificate `3406AF05…1A18` (checked 2026-10-05)

## 8. Admin-step hygiene (all scripts)

- [x] **Only Windows PowerShell's own modules** (`PSModulePath` = `$PSHOME\Modules`, set before any command) in every script — reproduced the look-alike module attack first, then fixed (1.8.2+)
- [x] The limit is set with plain text (`$PSHOME + '\Modules'`), never with a command such as `Join-Path`, which would itself be looked up before the limit applies (1.8.2+) — verified in the 1.8.8 review: no command before the limit in any of the 7 scripts; 31 look-alike commands planted first on the module path, none ran
- [x] PowerShell and cmd started by full path in scripts, all `.cmd` launchers and the uninstall entry (1.8.2–1.8.4)
- [x] Program Files from `GetFolderPath`, never from an environment variable — also for the elevated folder delete in uninstall (1.8.4)
- [x] Firewall script: results in its own window, no log file (1.8.4)
- [x] **Firewall launchers elevate only the installed copy:** `firewall.ps1` relaunches the copy in Program Files (only an administrator can change it), never the project-folder file, which could be swapped between the prompt and its start (1.8.7)
- [x] **The firewall step takes no program path from outside:** both sides work out the Program Files path themselves; an unknown `-Exe` is refused before anything runs (1.8.8) — tested: `-Exe <other program>` refused in 0.3 s, no prompt
- [x] `firewall.ps1` and `trust.ps1` refuse unknown parameters (`[CmdletBinding()]`), so a stray path is rejected before anything runs, never silently ignored (1.8.8)
  - [x] Confirmed on a real run: `Firewall-Block.cmd` / `Firewall-Unblock.cmd` (2026-10-06)
- [x] Uninstall removes the Program Files copy, per-user leftovers, entries, settings, browser data, firewall rules and certificate trust; restores the previous `.md` default
- [x] **Uninstall removes only its own entries** (file types, Open with, shortcuts, Settings › Apps entry that start the installed copy or a program that no longer exists; others are kept and listed) and uses **one administrator prompt** - a readable command, no script file - for the firewall rules and the folder together (1.8.7) — tested: 7 ownership cases
  - [x] Confirmed on a real run (2026-10-06)

## 9. Checking the project folder

- [x] **Install record:** every install records the SHA-256 of every project file (except `.git\`, `app\dist\`; links not followed) in Program Files, where only an administrator can change it (1.8.5)
- [x] `app\Check-Source.cmd` lists files changed, added or removed since the last install (1.8.5) — tested unchanged / changed / added / removed
- [x] Line endings fixed per file type (`.gitattributes`), so a checkout or pull never rewrites a file and causes false alarms — fresh clone compared byte for byte
  - [x] Confirmed on the real install: the checker installed in Program Files runs against the project folder and lists exactly the files changed since that install (the 1.8.8 work) (checked 2026-10-05)
- [x] `check-source.ps1` is installed in Program Files with the record, and `Check-Source.cmd` runs that copy (found through Windows' own Program Files lookup) - not the copy in the project folder, which a program running as you could change to always report "No changes" (1.8.6) — tested: installed checker with -Root and with the recorded folder; "not installed yet" message
- [x] `Check-Source.cmd` passes the project folder through an environment variable, so a folder name with quotes or apostrophes cannot break the command or add PowerShell (1.8.8) — tested with `it's a test` and `x'; Write-Host INJECTED; '` folders
- [x] No script builds a path from `$env:LOCALAPPDATA` (the installer's per-user leftover path now comes from `GetFolderPath`) (1.8.8)
- [x] The record is taken before the build and compared again after it; the install is refused if the sources changed while building (1.8.6) — tested: unchanged → 0, changed → 1

## 10. Clean-up after testing

- [x] No test DLLs, look-alike modules, test folders or profiler variables left anywhere (searched scratchpad, Temp, project, install folders, Documents modules)
- [x] All installed WebView2 DLLs carry Microsoft's signature and the pinned hashes

## 11. One viewer at a time

- [x] **Single instance per user and session:** a named mutex in the session's own `Local\` namespace, named with the user's SID (1.8.9) — tested: a second launch hands its document over and ends in 0.2 s; one process, two windows
- [x] **Each window reads only its own document's folder** (per-window scope instead of one global folder) (1.8.9) — tested through the request handler: window A refused folder B and the other way round; a window without a document reads nothing
- [x] **Hand-over pipe only for this user, never the network:** permissions are exactly "deny NETWORK" and "allow this user" (1.8.9) — read back from the running pipe
- [x] **Only this same program may ask:** the viewer accepts a request only from a process running this very program file (checked by path), which has passed all start-up checks before it connects (1.8.9) — tested: PowerShell sending a document was cut off, nothing opened
- [x] **The second copy checks the other end first:** it hands its document over only to this same program, connecting at identification level so the other end can never act as the user (1.8.9) — tested: a look-alike pipe created first received 0 bytes, and the second copy ran on its own
- [x] **Requests are narrow:** one path, at most 8 KB, read within 3 seconds; it must be an existing file of a type the viewer shows; at most 5 requests in 5 seconds and 20 windows (1.8.9) — tested: `run.cmd` refused with a message, nothing opened
- [x] **Never blocked:** if the running viewer cannot be verified (or something else holds the name), the second copy runs on its own; a refusal from the verified viewer ends the second copy with a message (1.8.9)
- [x] `--about` stays a short-lived window of its own and never touches the running viewer (1.8.9)
## 12. Update check (WebView2 SDK and libraries)

- [x] **`Check-Updates.cmd`:** reports newer stable versions of the WebView2 SDK (nuget.org) and of marked, KaTeX, highlight.js and Mermaid (npm registry), plus the local WebView2 Runtime (1.9.0) — first run: SDK 1.0.4258.31 up to date; marked 18.1.0, KaTeX 0.19.0, highlight.js 11.12.0, Mermaid 12.1.0 available
- [x] **The viewer never goes online;** only this script does, and only when you run it (1.9.0)
- [x] HTTPS only, to two fixed hosts; redirects not followed; 15-second time limit and a size limit on every answer; only plain version numbers are accepted (1.9.0) — tested: other host refused before any request, plain http refused, unreachable host and oversized answer reported as "could not check", `12.0.0-beta.1` and `<script>` rejected
- [x] **Report only:** nothing is downloaded or installed; the SDK stays pinned by SHA-256, so an update is a deliberate step (README › Updating the WebView2 SDK and libraries) (1.9.0)
- [x] Same script rules as the others: module limit first, refuses an administrator window, folders from `GetFolderPath` (1.9.0)
- [x] **Install reminder without going online:** `Install.cmd` reads the last result and lists found updates, or suggests a check when the last one is over 30 days old (1.9.0) — tested: updates found / 40 days old / fresh and clean (quiet)
- [x] **`Update-Libraries.cmd` / `update-libs.ps1`:** shows the plan first (version, exact download, files replaced) and asks before downloading; downloads from registry.npmjs.org only (HTTPS, no redirects, 60 MB limit), checks the SHA-512 the registry publishes, reads the archive itself and takes out only the expected files (never anything else, never outside `src\`), checks the new version string as the build does, then updates `viewer.js` and the README table; never builds, signs or installs (1.9.0) — used for KaTeX 0.19.0, highlight.js 11.12.0, Mermaid 12.1.0 and marked 18.1.0 (all SHA-512 matched); since marked 16 its browser file is `lib/marked.umd.js`, still saved as `src\marked.min.js`
- [x] The updated libraries were checked in a test build (throwaway certificate, deleted afterwards): math, flowchart and sequence diagrams, code colouring, table; safety badge and Breakdown still pass (1.9.0)
- [x] **New releases are held back for 7 days:** `update-libs.ps1` reads each version's publish date from the registry and skips a release younger than 7 days (or with no date) unless `-AllowNew` is given; a release pushed through a hijacked npm account is usually withdrawn within days, which the SHA-512 check cannot see (1.9.0) — tested: marked 18.1.0 (1 day old) and Mermaid 12.1.0 (4 days) held, KaTeX 0.16.22 not held, `-AllowNew` takes them
- [x] **Viewer test (`Test-Viewer.cmd` / `test-viewer.ps1`):** opens every document in `test\` (and optionally `-Folder`) in the viewer page, in Microsoft Edge without a window, and fails unless each one shows, its breakdown adds up and no script/iframe/object/embed/form/base/meta element, `on…` attribute, `javascript:` or `data:text/html` address or non-checkbox input reaches the page, and no payload in `test\attack.md` ran; all four libraries must load (1.9.0) — tested: 12 documents pass (`test\` plus `BAD\`); with the sanitizer switched off `attack.md` fails on four counts (and no payload ran even then: the page's security policy blocked them)
  - [x] The test changes nothing: a copy of `src\` in a new folder under `%LOCALAPPDATA%\Temp` (removed afterwards), served on 127.0.0.1 only, on a free port, under a random 128-bit path, everything else refused; Edge by full path with a valid Microsoft signature, a new empty profile, no extensions, no host names resolved; the page gets the app's policy (no `file:`)
  - [x] `update-libs.ps1` runs it after replacing files and says "Do not install this" (exit 1) when it fails — tested both ways
- [x] **marked 18.1.0:** the viewer's breakdown handles the new task-box token (marked 17) and entities marked already decodes (marked 18); 11 documents compared before and after: viewed counts unchanged, no unsafe output (1.9.0)

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
- One viewer at a time is per program file: a test build in `app\dist` and the installed copy are different files, so each runs as its own viewer.
- The library update checks each package against the SHA-512 published by the same registry: it catches a damaged or swapped download, not a release published through a compromised npm account. The 7-day hold and the viewer test reduce that risk; still check the changes (`git diff --stat src`) before installing.
- The update check trusts what nuget.org and the npm registry report as the latest version; it only reports, and every update is still checked (Microsoft signature, pinned hashes, the build's version checks) before it is built.
- Not applicable from the CloClo comparison (this app has no such feature): weather and network requests,
  clipboard and selection reading, screen-capture exclusion, dictation, colour picker, HTTP limits,
  notification logos, `.pfx` signing.
