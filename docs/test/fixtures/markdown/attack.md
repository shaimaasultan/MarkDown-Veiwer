# Preview-only test

Every item below tries to run code. Each one would only set `window.PWN` (a harmless marker);
`Test-Viewer.cmd` fails if any of them got through.

<script>window.PWN = 'script tag'</script>

<img src="x" onerror="window.PWN = 'img onerror'">

<svg onload="window.PWN = 'svg onload'"><circle r="5"></circle></svg>

<details open ontoggle="window.PWN = 'details ontoggle'"><summary>s</summary>t</details>

<a href="javascript:window.PWN = 'html link'">html link</a>

[markdown link](javascript:window.PWN='md-link')

[data link](data:text/html,<script>window.PWN='data-link'</script>)

<iframe src="javascript:window.PWN = 'iframe'"></iframe>

<object data="javascript:window.PWN = 'object'"></object>

<embed src="javascript:window.PWN = 'embed'">

<form action="javascript:window.PWN = 'form'"><button>go</button></form>

<input type="text" value="not a checkbox" onfocus="window.PWN = 'input'" autofocus>

<meta http-equiv="refresh" content="0;url=javascript:window.PWN='meta'">

<base href="javascript:window.PWN = 'base'//">

<style>body { background: url("javascript:window.PWN = 'style'") }</style>

<a id="pdfBtn">element named like a viewer control</a>

Math link: $\href{javascript:window.PWN='katex'}{click}$

```mermaid
%%{init: {"securityLevel": "loose"}}%%
graph LR
  A[Start] --> B[End]
  click A call PWN()
  click B href "javascript:window.PWN='mermaid'"
```

- [x] a real task box (the only kind of input allowed)
