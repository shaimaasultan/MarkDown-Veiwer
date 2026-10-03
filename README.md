# Markdown Viewer (WebView2)

A preview-only Markdown viewer for Windows. Double-click a `.md` file and it opens in the app's own
window with figures, math, code colouring and diagrams — and the app never runs code from a document
and never goes online.

## Features

- **Markdown rendering** with [marked](https://github.com/markedjs/marked), including tables, task lists and inline HTML (sanitised)
- **Math** with [KaTeX](https://katex.org) (`$…$`, `$$…$$`, ```` ```math ````)
- **Code colouring** with [highlight.js](https://highlightjs.org)
- **Diagrams** with [Mermaid](https://mermaid.js.org) (```` ```mermaid ````)
- **Folder sidebar** with every Markdown file next to the opened one, a table of contents, and a picture/diagram viewer
- **Images list** (🖼️ Images, Ctrl+Shift+G): every picture in the document as a thumbnail; click to go to it, double-click to enlarge, and step through them in the viewer with ‹ › or the arrow keys
- **Counts**: lines, characters, words, sentences, paragraphs, reading time, images, links, tables, code blocks, equations
- **Breakdown** that reconciles the source file with what is shown, and a **Characters** inspector (encoding, escapes, zero-width and hidden characters, leftover placeholders)
- **Safety check**: a ✓ Safe / ⚠ / ✗ Unsafe badge for every document, with a report of tricks aimed at you, at AI assistants or at other apps. It looks for scripts and active content, links whose text shows another address, look-alike addresses and letters, links to programs, network-share links, tracking pixels, hidden text and copy-paste traps, hidden instructions for AI tools, commands that download and run code, and Trojan Source text-direction tricks
- **¶ Hidden** highlighting, **Find & Replace**, **Export** (save or copy without hidden characters), **Save as PDF**
- Light / dark / automatic theme; view settings are remembered

## Security

- **Preview only.** Scripts, event handlers, `javascript:` links, frames, forms and plugins in a document are removed before display and also blocked by the window's Content-Security-Policy. Only Markdown, text, images, audio and video files are read from disk.
- **No network port.** The page lives at a private address (`https://mdviewer.example`) that exists only inside the app window; every request is answered by the program itself.
- **Never goes online.** All libraries are bundled (`src\lib\`) and packed into the signed Content DLL. The WebView2 engine is started so that it cannot look up any internet address, without background networking, component updates, pings, SmartScreen checks or Microsoft-account sign-in. Pictures a document links to on the web are shown as *not loaded*.
- **Links ask first.** Web and mail links open outside the app only after a question that shows the real address.
- **Private.** The window runs InPrivate, so no history of the documents you view is kept. Camera, microphone, location, notifications and clipboard reading are refused; downloads come only from the viewer itself; the right-click menu has no Share, web capture or other browser extras.
- **Stays in the document's folder.** Folder links (junctions, symbolic links) cannot lead outside it, and very large files (over 50 MB of text or 200 MB of media) are not opened. A document cannot draw over the viewer's own controls, and a diagram cannot add CSS of its own.
- **No copy-paste traps.** Text inside code examples cannot be hidden or restyled, so what you copy is what you see.
- **Signed, no loose script files.** The page and every library are packed into `MarkdownViewerWebView2.Content.dll`. It and the program are signed with the same Authenticode certificate. At every start the program checks both signatures, plus Microsoft's signature on the WebView2 files, without going online. If any of these files is changed, swapped or missing, the app does not start.
- **No developer access.** Developer tools are off; the app refuses to show documents if WebView2 remote debugging has been switched on, or if it cannot check.
- **Optional firewall rules.** `Firewall-Block.cmd` blocks all traffic in and out of `MarkdownViewerWebView2.exe` (needs administrator rights); `Firewall-Unblock.cmd` removes the rules.

## Requirements

- Windows 10 or 11 (64-bit)
- Microsoft Edge WebView2 Runtime — included with Windows 11
- .NET Framework 4.x — included with Windows; its C# compiler builds the app, nothing else to install

## Install

1. Download or clone this repository.
2. Run `app\Install.cmd`. It builds the app and installs it for the current user (no administrator rights) to
   `%LOCALAPPDATA%\Programs\MarkdownViewerWebView2`, with Start menu entries, a Settings › Apps entry and the
   `.md` / `.markdown` / `.mdown` / `.mkd` file association.
3. If Windows asks which app to use the next time you open a `.md` file, pick **Markdown Viewer (WebView2)** and click **Always**.

To remove it: Settings › Apps › Markdown Viewer (WebView2) › Uninstall, or run `app\Uninstall.cmd`.

## Build only

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

Output goes to `app\dist\`. The build checks that the bundled libraries match the versions listed in
`viewer.js` and that the page loads nothing from the internet. It then packs the page and libraries into
`MarkdownViewerWebView2.Content.dll` and signs the program and that DLL.

**Signing certificate.** The first build creates a code-signing certificate on your PC named
"Markdown Viewer (WebView2) Code Signing". It is stored in your personal certificate store, and its private
key cannot be exported. Later builds reuse it. To sign with a certificate bought from a certificate
authority instead, run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1 -CertificateThumbprint <thumbprint>
```

Windows doesn't trust a certificate made on your own PC by default. The app's start-up check works either
way. If you also want Windows (file Properties › Digital Signatures) to show the program as signed by a
trusted publisher, run `app\Trust-Certificate.cmd`. `Untrust-Certificate.cmd` undoes that, and so does
uninstalling the app.

## Project layout

| Path | Contents |
|---|---|
| `src\viewer.html`, `src\viewer.js` | The viewer page and its logic (packed into the Content DLL at build time) |
| `src\marked.min.js`, `src\lib\` | Bundled libraries (marked, KaTeX, highlight.js, Mermaid) |
| `app\MarkdownViewerWebView2.cs` | The Windows app (C# 5, Windows Forms + WebView2) |
| `app\Content.cs` | Resource-only `MarkdownViewerWebView2.Content.dll` that carries the page and the libraries |
| `app\*.ps1`, `app\*.cmd` | Build, install, uninstall and firewall scripts |
| `webview2\` | Microsoft WebView2 SDK files needed to build the app, with their license |

## Third-party components

| Component | Version | License |
|---|---|---|
| marked | 15.0.12 | MIT |
| KaTeX | 0.16.22 | MIT |
| highlight.js | 11.9.0 | BSD-3-Clause |
| Mermaid | 11.4.1 | MIT |
| Microsoft WebView2 SDK | 1.0.4258.31 | see `webview2\WebView2-SDK-LICENSE.txt` |

The original viewer was made using GPT-5; this version was extended and tested with Claude Code (Anthropic).
