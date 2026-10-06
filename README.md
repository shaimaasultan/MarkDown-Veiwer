# Markdown Viewer (WebView2)

A preview-only Markdown viewer for Windows. Double-click a `.md` file and it opens in the app's own
window with figures, math, code colouring and diagrams — and the app never runs code from a document
and never goes online.

[![Watch the one-minute promo video](docs/promo-poster.png)](docs/promo.mp4)

▶ **[Watch the one-minute promo video](docs/promo.mp4)** (MP4, 1080p, no sound)

## Features

- **Markdown rendering** with [marked](https://github.com/markedjs/marked), including tables, task lists and inline HTML (sanitised)
- **Math** with [KaTeX](https://katex.org) (`$…$`, `$$…$$`, ```` ```math ````)
- **Code colouring** with [highlight.js](https://highlightjs.org)
- **Diagrams** with [Mermaid](https://mermaid.js.org) (```` ```mermaid ````)
- **Folder sidebar** with every Markdown file next to the opened one, a table of contents, and a picture/diagram viewer
- **Images list** (🖼️ Images, Ctrl+Shift+G): every picture in the document as a thumbnail; click to go to it, double-click to enlarge, and step through them in the viewer with ‹ › or the arrow keys
- **Links list** (🔗 Links, Ctrl+Shift+L): every link with its text and real address (web, e-mail, other Markdown files, sections, disabled files); links flagged by the safety check are marked ⚠. Clicking an entry goes to the link in the document without opening it; ⧉ copies the address
- **Counts**: lines, characters, words, sentences, paragraphs, reading time, images, links, tables, code blocks, equations
- **Breakdown** that reconciles the source file with what is shown, and a **Characters** inspector (encoding, escapes, zero-width and hidden characters, leftover placeholders)
- **Safety check**: a ✓ Safe / ⚠ / ✗ Unsafe badge for every document, with a report of tricks aimed at you, at AI assistants or at other apps. It looks for scripts and active content, links whose text shows another address, look-alike addresses and letters, links to programs, network-share links, tracking pixels, hidden text and copy-paste traps, hidden instructions for AI tools, commands that download and run code, and Trojan Source text-direction tricks
- **¶ Hidden** highlighting, **Find & Replace**, **Export** (save or copy without hidden characters), **Save as PDF**
- **Auto-reload**: when another program saves the open file, the new version is shown at the same place (unsaved replacements are never thrown away)
- **Back / Forward** (← → buttons, Alt+← / Alt+→, mouse side buttons) between documents reached through links or the file list
- **Source view** (`</> Source`, Ctrl+Shift+U): the Markdown with line numbers beside the document, scrolling together; invisible characters show as markers, and the line numbers in the safety report open it there
- **Right-to-left text**: Arabic, Hebrew and other paragraphs, lists, headings and tables follow their own direction; code and math stay left to right
- **GitHub-style callouts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`
- **Copy buttons** on code blocks, and **click an equation to copy its LaTeX**
- **Broken links**: links to missing files or sections are underlined and marked in the Links list
- **Diagram export**: save a Mermaid diagram as SVG or PNG from the figure viewer
- **Save as web page**: one self-contained .html file with pictures, math fonts and diagrams embedded, and no scripts
- **Save as PDF** with a contents page, the file name at the top and page numbers ("2 / 5") at the bottom of every page
- **Video and audio**: `![clip](clip.mp4)` (as on GitHub) or `<video src="clip.mp4" controls>` plays in the page; .mp4, .webm, .mp3, .wav, .ogg. Videos are read a few MB at a time as they play, so any size works and seeking is instant
- **Open pictures, video and audio directly**: right-click a file › Open with › Markdown Viewer (WebView2) shows it on its own page (the installer adds it to Open with only, never as the default app)
- **Pictures on / off** (Ctrl+Shift+B, remembered): with pictures off, documents open without loading any picture - each shows its text (or file name) instead; right-click a placeholder › Load picture (or Load all pictures) to show it
- **Picture as text**: "</> Text" in the picture viewer shows the picture file the way Notepad would open it (SVG as its text, PNG/JPG as their bytes)
- **Text size and page width**: A− / A+ (small to largest) and ↔ (normal, wide, full window), remembered; printing keeps its own size
- **Footnotes**: `[^1]` in the text and `[^1]: note` anywhere - numbered in order of use and listed at the end with links both ways, as on GitHub
- **Table tools**: click a column header to sort (numbers sort as numbers; again to reverse, a third time for the original order); ⧉ Copy pastes the table into Excel or Word as cells; ⬇ CSV saves it
- **Compare two versions** (⇄ Compare): this document against another Markdown file from the folder or anywhere on the PC - lines only in one version in red or green, changed words marked inside changed lines, unchanged stretches folded, Previous / Next change, optional "ignore spaces"
- Light / dark / automatic theme; view settings are remembered

## Security

Every point below, with where it is implemented and how it was tested, is listed in
[SECURITY-CHECKLIST.md](SECURITY-CHECKLIST.md).

- **Preview only.** Scripts, event handlers, `javascript:` links, frames, forms and plugins in a document are removed before display and also blocked by the window's Content-Security-Policy. Only Markdown, text, images, audio and video files are read from disk.
- **No network port.** The page lives at a private address (`https://mdviewer.example`) that exists only inside the app window; every request is answered by the program itself.
- **Never goes online.** All libraries are bundled (`src\lib\`) and packed into the signed Content DLL. The WebView2 engine is started so that it cannot look up any internet address, without background networking, component updates, pings, SmartScreen checks or Microsoft-account sign-in. Pictures a document links to on the web are shown as *not loaded*. (Only the optional `Check-Updates.cmd`, when you run it, asks two fixed sites for version numbers - see [Checking for updates](#checking-for-updates).)
- **Links ask first.** Web and mail links open outside the app only after a question that shows the real address.
- **Private.** The window runs InPrivate, so no history of the documents you view is kept. Camera, microphone, location, notifications and clipboard reading are refused; downloads come only from the viewer itself; the right-click menu has no Share, web capture or other browser extras.
- **Stays in the document's folder.** Folder links (junctions, symbolic links) cannot lead outside it, and very large files (over 50 MB of text or 200 MB of media) are not opened. A document cannot draw over the viewer's own controls, and a diagram cannot add CSS of its own.
- **Blocked-code alert.** When a file contains code (scripts, event handlers, code links), a popup says so when it opens: nothing ran, and it is a file to be careful with elsewhere. If the window's security policy ever has to stop code itself, that is shown too.
- **No copy-paste traps.** Text inside code examples cannot be hidden or restyled, so what you copy is what you see.
- **Signed, no loose script files.** The page and every library are packed into `MarkdownViewerWebView2.Content.dll`. It and the program are signed with the same Authenticode certificate. At every start the program checks both signatures, plus Microsoft's signature on the WebView2 files, without going online, before any of them is loaded. The WebView2 files must also be exactly the ones the program was built with (their SHA-256 is part of the signed program), so an older or different Microsoft file is refused as well. If any of these files is changed, swapped or missing, the app does not start. See [Signing](#signing).
- **Nothing extra in the program's folder.** Windows looks in a program's folder first for many DLLs, and .NET for its configuration. Anything there that isn't part of the app (a planted DLL, a `.config`, `.manifest` or `.local` file or folder) stops the start; reinstalling removes it. The app is installed in Program Files, so the folder cannot be changed without administrator rights at all - the only full protection, because .NET itself loads a few Windows DLLs (`cryptbase`, `cryptsp`, `profapi`) from a program's folder before the program's first line runs.
- **Checked files stay locked.** From the check until the app closes, the program, the Content DLL and the WebView2 files cannot be changed, replaced, renamed or deleted, and neither can their folder, so what was checked is what gets loaded.
- **Safe DLL loading.** The app turns on Windows' image-load protections at start: system DLLs come from System32 before any copy elsewhere, and never from a network share, a file written by a sandboxed process, the current folder or PATH. The program's own calls into Windows DLLs load them from System32 only. The legacy ways other programs push a DLL into every process - AppInit_DLLs, global window hooks, legacy (non-TSF) input methods and Winsock layered providers - are switched off as well.
- **No crash dumps.** An unexpected error is logged (`%LOCALAPPDATA%\MarkdownViewerWebView2\errors.log`: its type and stack only, never its message, which could quote document text) and the window keeps running; an error on a background thread, which cannot be survived, ends the app right after logging. Either way Windows Error Reporting never receives a memory dump that could hold the open document. Settings are saved through a new temporary file with a random name (which must not exist yet) and an atomic replace, so a crash cannot leave them half written and nothing can place a file there beforehand to redirect the write.
- **One viewer at a time.** Only one copy runs per user and Windows session. Opening another document (a double-click, the Start menu) hands it to the running viewer, which shows it in a window of its own - and each window can read only its own document's folder. The hand-over is a named pipe that only your account can open and never the network can; the viewer accepts a request only from this same program file (after its start-up checks), and the second copy hands its document over only after checking that the other end is this same program, so a look-alike learns nothing. A request is one path to an existing file of a type the viewer shows; requests are rate-limited and windows are capped at 20. If the running viewer cannot be verified, the second copy simply runs on its own.
- **Fresh browser data.** The WebView2 engine starts with a new, empty data folder at every start; folders of ended runs are deleted. Nothing left in that folder by an earlier run or another program is read.
- **No startup hooks.** If environment variables would make .NET load a profiler or an AppDomain manager into the app (`COR_ENABLE_PROFILING`, `COR_PROFILER*`, `APPDOMAIN_MANAGER_*`), it refuses to start. `DOTNET_STARTUP_HOOKS` belongs to .NET Core and is never read by this .NET Framework app.
- **Never as administrator by accident.** Opened with administrator rights (for example from an administrator prompt) while a normal start is possible, the app refuses and asks you to open the file normally. `Install.cmd` refuses to be started as administrator too: it builds, signs and registers the app as you, and asks for administrator rights only for the copy into Program Files.
- **Windows entries stay pointed at the installed copy.** At start, an installed copy corrects the entries that open `.md` files, pictures and media when they point to a deleted copy (a place any program running as you could fill with its own program); the Program Files copy also corrects them when they point to any other copy. Development builds and copies run from other folders never touch them, and the installer reads them back and warns if a change did not stick.
- **Genuine engine.** After the WebView2 engine starts, the app checks that it is Microsoft's `msedgewebview2.exe`, signed and under Program Files (which only an administrator can change); otherwise no document is shown.
- **No developer access.** Developer tools are off; the app refuses to show documents if WebView2 remote debugging has been switched on, or if it cannot check.
- **Safe install.** The app is installed in Program Files, where only an administrator can change it. Only the copy itself runs with administrator rights, through a short readable command - what the administrator prompt's "Show more details" shows: `place.ps1`'s path and SHA-256 and every file's SHA-256. The elevated side runs exactly the `place.ps1` bytes it checked, so a swapped file never runs; and it trusts nothing it is handed: it works out the folder itself, compares every copy with the SHA-256 taken from the build and checks the signatures in a staging folder only administrators can change, and writes nothing into your folders. All scripts use only Windows PowerShell's own modules (limited with plain text before any command runs, so not even that step can be hijacked) and start PowerShell and cmd by full path; neither the build nor the installer runs from an administrator window. See [Install](#install).
- **Optional firewall rules.** `Firewall-Block.cmd` blocks all traffic in and out of `MarkdownViewerWebView2.exe` (needs administrator rights; the result is shown in its own window); `Firewall-Unblock.cmd` removes the rules. Updates keep the rules on the installed copy. The administrator step always runs the firewall script installed in Program Files (only an administrator can change it), never the copy in the project folder, and works out the program path itself - it takes no path from outside, so the rules can only ever be made for this app.
- **Check the project folder.** Every install records the SHA-256 of every project file (all except `.git\` and `app\dist\`) in Program Files, next to the program, where only an administrator can change the record. `app\Check-Source.cmd` runs the checker installed beside the record (so it cannot be altered either) and lists every file changed, added or removed since the last install - also changes made by another program running as you, which can change neither the record nor the checker to hide them. `Install.cmd` runs the same installed checker before it builds: if the folder changed since the last install, it lists the changes and builds only after you answer Y. The new record is taken before the build and compared again after it: if the sources change while building, nothing is installed. Run it before installing an update you did not expect: changes you made or pulled yourself show up too, so only unexplained ones are a warning.

**What this does not cover.** Windows' administrator prompt is not a security boundary against programs
already running as you: they could change this repository's scripts or sources before you run
`Install.cmd`, and Windows would still show its usual prompt. Keep the repository in your own folders, run
`Check-Source.cmd` (and `git status`) before installing if in doubt, and confirm a signing request only while
a build you started is running. A build in `app\dist` is for testing; only the installed copy in Program Files has the full protection.
Signatures carry no timestamp (builds never go online): the signing certificate is valid until October 2036,
after which the app's start-up check refuses the program - install a build signed with a new certificate
before then. `Install.cmd` warns once less than a year is left.

## Requirements

- Windows 10 or 11 (64-bit)
- Microsoft Edge WebView2 Runtime — included with Windows 11
- .NET Framework 4.x — included with Windows; its C# compiler builds the app, nothing else to install
- Administrator rights once per install or update (for the copy into Program Files); on a standard account,
  Windows asks for an administrator's password

## Install

1. Download or clone this repository.
2. Run `app\Install.cmd` (double-click it; not "Run as administrator"). It builds and signs the app as you,
   then asks once for administrator rights to copy it to `C:\Program Files\MarkdownViewerWebView2`, where only
   an administrator can change the program's files: no program running as you can replace them or put a DLL
   or `.config` file next to them. Start menu entries, a Settings › Apps entry and the `.md` / `.markdown` /
   `.mdown` / `.mkd` file association are made for your own account.
3. If Windows asks which app to use the next time you open a `.md` file, pick **Markdown Viewer (WebView2)** and click **Always**.

Run `Install.cmd` again to update (one administrator prompt each time). A copy that earlier versions installed
in `%LOCALAPPDATA%\Programs\MarkdownViewerWebView2` is removed, and existing firewall block rules are moved to
the Program Files copy. The installer, uninstaller and firewall scripts use only Windows PowerShell's own
modules (never look-alikes from your Documents module folder) and start PowerShell and cmd by their full
paths, so nothing planted in your account runs with the administrator rights you grant. The administrator
step is a short readable command - the prompt's "Show more details" shows `place.ps1`'s path and SHA-256,
every file's SHA-256 and any certificate you accepted. Elevated, it reads `place.ps1` once, checks that
SHA-256 and runs exactly those bytes, so a file swapped after you started the install never runs. It
works out the Program Files folder itself (not from an environment variable), copies into a staging folder
there that only administrators can change, compares every copy with the SHA-256 taken from the build and
checks the signatures in that folder, and only then swaps it in - a difference stops the install, a copy in
use is never left half replaced - and it writes no log files into your folders. The installer does not run
from an administrator window, and stops with a message if it cannot ask you a question (e.g. in PowerShell ISE). Afterwards the
installer checks, as you, that Program Files holds exactly the files that were built.

### Setup for other PCs

Every install (and `app\build.ps1`) also makes `app\release\MarkdownViewer-Setup-<version>.exe`: one signed
file with the built program inside, for installing on another PC without building - or here, without the
console window. Double-click it (not "Run as administrator"): a window with the logo shows the version, who
signed it and whether the viewer is installed, with **Install** / **Update**, **Uninstall**, **Open the viewer**
and **Close**; progress and questions appear in that window.

- The files are resources of Setup, listed with their SHA-256 inside it, so Setup's signature covers them all.
  Setup checks its own signature at start (a changed Setup does not run) and keeps its file locked until it ends.
- The copy into Program Files is the only step with administrator rights, and Setup does not run elevated
  itself: Windows asks for **Windows PowerShell**, whose short readable command ("Show more details") reads
  Setup's bytes once, checks them against the SHA-256 Setup took of its checked file and runs only the copy
  step from those bytes in memory - nothing is started from the Downloads folder with administrator rights,
  where a planted DLL could be loaded with it. The copy step writes into a staging folder in Program Files,
  checks every file's SHA-256, that the program and Content DLL are signed by Setup's certificate and the
  WebView2 files by Microsoft, then swaps the folders (a copy in use is never left half replaced).
- An installed copy signed by another certificate is replaced only after you answer Yes.
- File types, Open with, Start menu and Settings › Apps are set up for your account by `register.ps1`, run
  from Program Files (the same step `Install.cmd` uses). **Uninstall** runs the installed `uninstall.ps1`.
- Setup installs `uninstall.ps1`, `register.ps1` and `firewall.ps1` with the program, not `trust.ps1`: certificate trust is only for the PC that holds the signing key.
- On another PC the certificate is not in Windows' trusted list, so Windows may show the publisher as unknown;
  the viewer itself only needs its files intact and signed by one certificate. Compare the thumbprint Setup
  shows with yours. The other PC needs the Microsoft Edge WebView2 Runtime (part of Windows 11); Setup says
  if it is missing.

To remove it: Settings › Apps › Markdown Viewer (WebView2) › Uninstall, run `app\Uninstall.cmd`, or use **Uninstall** in Setup. It removes
the Program Files copy and the firewall block rules (if you added them) with one administrator prompt - a
short readable command, no script file - and any per-user copy from earlier versions, the file-type entries
(your previous `.md` default comes back), shortcuts, the Settings › Apps entry, saved settings, browser data,
the error log and the certificate trust (if you added it). Entries that start another copy of the viewer are
left alone and listed. The signing certificate stays in your certificate store for later builds.

## Build only

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

Output goes to `app\dist\` (for testing; it is not installed). The build checks the compiler's and the
WebView2 files' Microsoft signatures and the WebView2 files' exact SHA-256, that the bundled libraries match
the versions listed in `viewer.js` and that the page loads nothing from the internet. It then packs the page
and libraries into `MarkdownViewerWebView2.Content.dll` and signs the program and that DLL (Windows asks you
to confirm the signing). Run it from a normal window: it refuses to build with administrator rights.

## Signing

The program and `MarkdownViewerWebView2.Content.dll` are Authenticode-signed by every build, and the program checks both signatures - plus Microsoft's on the WebView2 files and their exact SHA-256 - at every start (see [Security](#security)).

The first build creates a code-signing certificate on your PC named
"Markdown Viewer" (publisher; builds before 1.10 used "Markdown Viewer (WebView2) Code Signing"). It is stored in your personal certificate store, its private
key cannot be exported, and the key is **protected**: Windows asks you to confirm every time something signs
with it, so no other program running as you can quietly sign a changed program or Content DLL. Later builds
reuse it (you confirm when a build signs). Certificates from earlier versions had no such protection; the build
no longer uses them, and you can delete them in certmgr.msc › Personal › Certificates.

**Only fresh, untouched files are signed.** The build signs just the program and Content DLL it has compiled
moments before. The WebView2 files are never signed by the build: they must carry Microsoft's valid signature
and match the SHA-256 recorded in `build.ps1`, otherwise the build stops before anything is compiled or
signed. The compiler, PowerShell and its modules are used from Windows' own folders by full path, never
looked up on PATH or in your Documents module folder.

**Updates keep the certificate.** The installer only replaces an installed copy with a build signed by the
same certificate. When the certificate has changed (for example right after the protected one was made),
it shows both thumbprints and installs only after you answer Y.

To sign with a certificate bought from a certificate authority instead, run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1 -CertificateThumbprint <thumbprint>
```

Windows doesn't trust a certificate made on your own PC by default. The app's start-up check works either
way. If you also want Windows (file Properties › Digital Signatures) to show the signature as valid, run
`app\Trust-Certificate.cmd`. It adds the certificate to your Trusted Roots only, not to Trusted Publishers
(Office macros and AllSigned PowerShell scripts from those publishers run without asking). It takes the
certificate only from the program installed in Program Files, only if that is signed by your own signing
certificate (the one on this PC with its private key), and adds it straight from memory - no temporary file
that could be swapped.
`Untrust-Certificate.cmd` undoes that, and so does uninstalling the app.

## Checking for updates

```bash
app\Check-Updates.cmd
```

Shows whether a newer stable WebView2 SDK is out on nuget.org, and newer releases of the bundled libraries
(marked, KaTeX, highlight.js, Mermaid) on the npm registry, next to the versions this project builds with -
plus the WebView2 Runtime installed on your PC (which Windows keeps up to date). It only reports: nothing is
downloaded or installed. The viewer itself never goes online; this script does only when you run it - HTTPS
to `api.nuget.org` and `registry.npmjs.org` only, no redirects, a time and size limit on every answer, and
only version numbers are read from them. `Install.cmd` reminds you (without going online) when the last check
found updates, or when it is more than 30 days old.

### Updating the WebView2 SDK and libraries

The SDK files are pinned by SHA-256, so an update is a deliberate step:

1. **WebView2 SDK:** download the `Microsoft.Web.WebView2` package of the new version from nuget.org (a
   `.nupkg` is a zip file). Take `lib\net462\Microsoft.Web.WebView2.Core.dll`,
   `lib\net462\Microsoft.Web.WebView2.WinForms.dll` and `runtimes\win-x64\native\WebView2Loader.dll` and
   replace the three files in `webview2\`. Check that each carries Microsoft's valid signature (file
   Properties › Digital Signatures), then put their SHA-256 (`Get-FileHash`) into `$sdkHashes` in
   `app\build.ps1` and the new version in its comment and in the table below.
2. **Libraries:** double-click `app\Update-Libraries.cmd`. It first shows the plan - for each library the
   new version, the exact download and which files in `src\` it replaces - and asks before downloading
   anything. Then it downloads each package from registry.npmjs.org only (HTTPS, no redirects, size limit),
   checks it against the SHA-512 the registry publishes, takes out only the expected files (never anything
   else, never outside `src\`), checks they really are the new version (as the build does) and only then
   replaces them and updates the version in `viewer.js` and in the table below. A release that lacks an
   expected file (e.g. no ready-made browser file) is left untouched with an explanation. For one library:
   `app\update-libs.ps1 -Library KaTeX` (plan) or add `-Apply`. Undo with `git checkout -- src README.md`.
   A release published less than 7 days ago is held back (a release pushed through a hijacked npm account
   is usually withdrawn within days); add `-AllowNew` to take it anyway. After replacing files it runs the
   viewer test (below) and says "Do not install this" if it fails. A new major version can change how
   documents look - check a few before installing.
3. Run `Install.cmd`. It lists the changed files since the last install and asks for Y; then run
   `Check-Updates.cmd` again.

### Testing the viewer page

Double-click `app\Test-Viewer.cmd` (it changes nothing). It opens every document in `test\` in the viewer
page, in Microsoft Edge without a window, and fails unless each one is shown, its breakdown adds up (✓), no
element, attribute or address that could run code reaches the page, no payload in `test\attack.md` ran and
all four libraries load. Add your own documents with `Test-Viewer.cmd -Folder C:\path\to\folder`. The page
runs from a temporary copy of `src\` (removed afterwards), served on 127.0.0.1 only under a random path, in
a new empty Edge profile that cannot look up any host name.

## Project layout

| Path | Contents |
|---|---|
| `src\viewer.html`, `src\viewer.js` | The viewer page and its logic (packed into the Content DLL at build time) |
| `src\marked.min.js`, `src\lib\` | Bundled libraries (marked, KaTeX, highlight.js, Mermaid) |
| `app\MarkdownViewerWebView2.cs` | The Windows app (C# 5, Windows Forms + WebView2) |
| `app\Content.cs` | Resource-only `MarkdownViewerWebView2.Content.dll` that carries the page and the libraries |
| `app\build.ps1` | Checks, compiles and signs the app into `app\dist\` |
| `app\install.ps1`, `app\place.ps1` | Install for your account; `place.ps1` is the one administrator step (copy into Program Files) |
| `app\register.ps1` | File types, Open with, Start menu and Settings › Apps for your account; installed in Program Files and run from there by `install.ps1` and Setup |
| `app\Setup.cs` | Setup for other PCs (`app\release\MarkdownViewer-Setup-<version>.exe`, built by `build.ps1`): the signed program inside one signed file, with Install and Uninstall |
| `app\uninstall.ps1`, `app\firewall.ps1`, `app\trust.ps1` | Uninstall, optional firewall block rules, optional certificate trust (also copied next to the program) |
| `app\check-source.ps1` | Records the project files' SHA-256 at install time; installed in Program Files with the record, where `Check-Source.cmd` runs it to compare the folder with that record |
| `app\check-updates.ps1` | Reports newer versions of the WebView2 SDK and the bundled libraries (only when you run it) |
| `app\update-libs.ps1` | Downloads, checks and replaces the bundled libraries in `src\` (plan first; asks before downloading; holds back releases under 7 days old) |
| `app\test-viewer.ps1` | Tests the viewer page with the documents in `test\` (display, breakdown, nothing that could run code) |
| `app\*.cmd` | Double-click launchers: `Install`, `Uninstall`, `Check-Source`, `Check-Updates`, `Update-Libraries`, `Test-Viewer`, `Firewall-Block` / `-Unblock`, `Trust-` / `Untrust-Certificate` |
| `test\` | Test documents (formatting, lists, UTF-16, `attack.md` with harmless payloads) and `selftest.js`, which the test adds to its temporary copy of the page |
| `webview2\` | Microsoft WebView2 SDK files needed to build the app, with their license |
| `docs\` | Promo video and its poster picture |

## Third-party components

| Component | Version | License |
|---|---|---|
| marked | 18.1.0 | MIT |
| KaTeX | 0.19.0 | MIT |
| highlight.js | 11.12.0 | BSD-3-Clause |
| Mermaid | 12.1.0 | MIT |
| Microsoft WebView2 SDK | 1.0.4258.31 | see `webview2\WebView2-SDK-LICENSE.txt` |

The original viewer was made using GPT-5; this version was extended and tested with Claude Code (Anthropic).
