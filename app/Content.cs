// Markdown Viewer (WebView2) - page and libraries.
//
// Resource-only assembly (no code): viewer.html, viewer.js, marked and the bundled libraries are packed
// into this DLL by build.ps1 and signed with the same certificate as the program, so there are no loose
// script files to edit. The program checks the signature at every start before it reads anything from it.

using System.Reflection;

[assembly: AssemblyTitle("Markdown Viewer (WebView2) - page and libraries")]
[assembly: AssemblyProduct("Markdown Viewer (WebView2)")]
[assembly: AssemblyDescription("The viewer page and its bundled libraries (marked, KaTeX, highlight.js, Mermaid) as signed resources.")]
[assembly: AssemblyCopyright("Markdown Viewer")]
[assembly: AssemblyVersion("1.8.3.0")]
[assembly: AssemblyFileVersion("1.8.3.0")]
[assembly: AssemblyInformationalVersion("1.8.3")]
