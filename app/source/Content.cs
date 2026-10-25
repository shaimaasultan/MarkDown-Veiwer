// Markdown Viewer (WebView2) - page and libraries.
//
// Resource-only assembly (no code): viewer.html, viewer.js, marked, the bundled libraries and the fixed-host
// WebView2 update-check helper are packed into this DLL by build.ps1 and signed with the same certificate as
// the program, so there are no loose runtime scripts. The program checks the signature before reading them.

using System.Reflection;

[assembly: AssemblyTitle("Markdown Viewer (WebView2) - page and libraries")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyDescription("The viewer page and its bundled libraries (marked, KaTeX, highlight.js, Mermaid) as signed resources.")]
[assembly: AssemblyCompany("Markdown Viewer")]
[assembly: AssemblyCopyright("Markdown Viewer")]
[assembly: AssemblyVersion("1.15.1.0")]
[assembly: AssemblyFileVersion("1.15.1.0")]
[assembly: AssemblyInformationalVersion("1.15.1")]
