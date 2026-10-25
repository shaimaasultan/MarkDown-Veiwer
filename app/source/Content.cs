// ReadSafe Viewer - page and libraries.
//
// Resource-only assembly (no code): viewer.html, viewer.js, marked and the bundled libraries are packed into
// this DLL by build.ps1 and signed with the same certificate as the program, so there are no loose runtime
// scripts. The program checks the signature before reading them.

using System.Reflection;

[assembly: AssemblyTitle("ReadSafe Viewer - page and libraries")]
[assembly: AssemblyProduct("ReadSafe Viewer")]
[assembly: AssemblyDescription("The viewer page and its bundled libraries (marked, KaTeX, highlight.js, Mermaid) as signed resources.")]
[assembly: AssemblyCompany("Markdown Viewer")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Shaimaa Said Soltan - MIT License")]
[assembly: AssemblyVersion("1.16.0.0")]
[assembly: AssemblyFileVersion("1.16.0.0")]
[assembly: AssemblyInformationalVersion("1.16.0")]
