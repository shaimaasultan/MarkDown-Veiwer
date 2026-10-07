// Markdown Folder Viewer — page logic (kept out of viewer.html so the page can forbid inline scripts).
"use strict";

document.getElementById('year').textContent = new Date().getFullYear();

const picker = document.getElementById('picker');
const filePicker = document.getElementById('filePicker');
const output = document.getElementById('output');
const content = document.getElementById('content');
const dropHint = document.getElementById('drop');
const sidebar = document.getElementById('sidebar');
const fileList = document.getElementById('fileList');
const filter = document.getElementById('filter');

const MD_RE = /\.(md|markdown|mdown|mkd)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.venv|venv|__pycache__)\//i;

const fileMap = new Map();   // lowercase path -> { path, file }
const urlCache = new Map();  // lowercase path -> blob URL
let mdPaths = [];
let currentPath = null;

// App mode: shown by MarkdownViewerWebView2.exe at its private address, which hands out files from disk
// at <token>/fs/<path>.
const APP = location.hostname === 'mdviewer.example' && /\/app\/[^/]*$/.test(location.pathname);
const apiBase = APP ? location.pathname.replace(/app\/[^/]*$/, '') : '';
let source = 'local';        // 'local' = files picked/dropped in the page, 'app' = files on disk via the exe
let repoRoot = '';           // app mode: folder that "/x" links resolve against
let listBase = '';           // app mode: folder the sidebar paths are shown relative to
const fsURL = p => apiBase + 'fs/' + p.split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------------- paths
const norm = p => p.replace(/\\/g, '/').replace(/\/+/g, '/');
const key = p => norm(p).toLowerCase();
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
const rootOf = p => {
  if (source === 'app') return repoRoot;
  const i = p.indexOf('/'); return i < 0 ? '' : p.slice(0, i + 1);
};

function isExternal(href) {
  return !href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
}

// Resolve a relative (or repo-root "/x") reference against the current document's folder.
function resolve(baseDir, href) {
  let p = href.split('#')[0].split('?')[0];
  try { p = decodeURIComponent(p); } catch {}
  p = norm(p);
  const start = p.startsWith('/') ? rootOf(baseDir) : baseDir;
  const out = [];
  for (const seg of (start + p.replace(/^\//, '')).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

function localEntry(baseDir, href) {
  if (isExternal(href)) return null;
  if (source === 'app') return { path: resolve(baseDir, href) };  // existence is checked when it loads
  return fileMap.get(resolve(baseDir, href).toLowerCase()) || null;
}

function blobURL(entry) {
  if (source === 'app') return fsURL(entry.path);
  const k = key(entry.path);
  if (!urlCache.has(k)) urlCache.set(k, URL.createObjectURL(entry.file));
  return urlCache.get(k);
}

// This app never goes online: pictures and media a document links to on the web are not loaded.
const isWeb = href => /^(?:https?:)?\/\//i.test((href || '').trim());

function markWeb(el, src) {
  el.removeAttribute('src');
  el.dataset.webSrc = src;
  if (el.tagName === 'IMG') {
    el.classList.remove('zoomable');
    el.classList.add('web');
    el.dataset.origAlt = el.getAttribute('alt') || '';
    el.alt = `🌐 Web picture not loaded (this app never goes online): ${src}`;
  }
  el.title = `Not loaded — this app never goes online: ${src}`;
}

// ---------------------------------------------------------------- sanitizer
// Preview only: nothing in a Markdown file may run. Rendered HTML is parsed into an inert document
// (scripts never execute, images never load there), filtered against an allowlist, and only then
// moved into the page. The page's Content-Security-Policy blocks anything that would slip through.

const ALLOWED_TAGS = new Set((
  // HTML
  'a abbr address article aside audio b bdi bdo blockquote br caption center cite code col colgroup ' +
  'dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img input ' +
  'ins kbd li main mark nav ol p picture pre q rp rt ruby s samp section small source span strike strong ' +
  'sub summary sup table tbody td tfoot th thead time tr track tt u ul var video wbr ' +
  // SVG (inline figures; no script, animation or foreignObject)
  'svg g path circle ellipse line polygon polyline rect text tspan textpath defs lineargradient ' +
  'radialgradient stop clippath mask use symbol marker pattern image title desc ' +
  // MathML (KaTeX output)
  'math semantics annotation mrow mi mo mn ms mtext mspace msup msub msubsup mfrac msqrt mroot mtable ' +
  'mtr mtd mlabeledtr mstyle mpadded mphantom menclose munder mover munderover mmultiscripts mprescripts none merror'
).split(/\s+/));

// Removed together with everything inside them.
const DROP_TAGS = new Set((
  'script noscript style template iframe frame frameset object embed applet param form button select ' +
  'option optgroup textarea datalist output meta link base noembed noframes xmp plaintext portal ' +
  'foreignobject annotation-xml animate animatemotion animatetransform set discard handler listener'
).split(/\s+/));

const DROP_ATTRS = new Set(['srcdoc', 'action', 'formaction', 'ping', 'background', 'dynsrc', 'lowsrc',
  'longdesc', 'target', 'is', 'contenteditable', 'autofocus', 'autoplay', 'data', 'codebase', 'attributename',
  'http-equiv', 'xmlns:xlink', 'popover', 'popovertarget', 'popovertargetaction', 'nonce', 'download']);

const scheme = v => {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v.replace(/[\u0000- \u007f-\u009f]/g, ''));
  return m ? m[1].toLowerCase() : '';
};
const SAFE_IMG_DATA = /^data:image\/(png|gif|jpe?g|webp|bmp|avif|svg\+xml)[;,]/i;
const safeLink = v => ['', 'http', 'https', 'mailto'].includes(scheme(v));
const safeSrc = v => ['', 'http', 'https'].includes(scheme(v)) || SAFE_IMG_DATA.test(v.trim());

function sanitize(html, { diagram = false } = {}) {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  cleanChildren(doc.body, diagram);
  const frag = document.createDocumentFragment();
  while (doc.body.firstChild) frag.appendChild(document.adoptNode(doc.body.firstChild));
  return frag;
}

function cleanChildren(node, diagram) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }  // comments, PIs, …
    const tag = child.localName.toLowerCase();
    // Mermaid's own diagram output needs its <style> sheet and HTML labels; both are still filtered.
    const diagramExtra = diagram && (tag === 'style' || tag === 'foreignobject');
    if (DROP_TAGS.has(tag) && !diagramExtra) { child.remove(); continue; }
    cleanChildren(child, diagram);
    if (!ALLOWED_TAGS.has(tag) && !diagramExtra) { child.replaceWith(...child.childNodes); continue; }
    cleanAttributes(child, tag, diagram);
  }
}

function cleanAttributes(el, tag, diagram) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    let ok = !name.startsWith('on') && !DROP_ATTRS.has(name) && !name.startsWith('data-');
    if (ok && (name === 'href' || name === 'xlink:href')) {
      if (tag === 'use') ok = value.trim().startsWith('#');     // same-document references only
      else if (tag === 'image') ok = safeSrc(value);
      else ok = safeLink(value);
    } else if (ok && (name === 'src' || name === 'poster')) {
      ok = safeSrc(value);
    } else if (ok && name === 'srcset') {
      ok = value.split(',').every(part => safeSrc(part.trim().split(/\s+/)[0] || ''));
    } else if (ok && name === 'style') {
      ok = !/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i.test(value) &&
           !el.closest('pre, code');          // nothing hidden inside code: what you copy is what you see
    } else if (ok && name === 'hidden') {
      ok = !el.closest('pre, code');
    } else if (ok && (name === 'id' || name === 'name') && !diagram) {
      // Like GitHub: keep document ids from clashing with the viewer's own.
      el.setAttribute(attr.name, 'user-content-' + value);
      continue;
    }
    if (!ok) el.removeAttribute(attr.name);
  }
  if (tag === 'input') {               // only GFM task-list checkboxes, read-only
    if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox') { el.remove(); return; }
    el.setAttribute('disabled', '');
  }
  if (tag === 'a' && el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer');
}

// ---------------------------------------------------------------- math
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KATEX_OPTIONS = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 50 };

function renderMath(tex, display) {
  let html;
  if (typeof window.katex?.renderToString === 'function') {
    try {
      html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
    } catch (e) { /* fall through to raw */ }
  }
  if (!html) html = `<code class="math-raw" title="Math renderer unavailable">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  return display ? `<div class="math-display">${html}</div>` : html;
}

const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    const m = /(^|\n) {0,3}(\$\$|\\\[)/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src)
           || /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer(t) { return renderMath(t.text, true); }
};

const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start(src) {
    const i = src.search(/(?<!\\)\$|\\\(/);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    let m;
    if ((m = /^\$`([^`]+?)`\$/.exec(src)))              // GitHub: $`x^2`$
      return { type: 'mathInline', raw: m[0], text: m[1], display: false };
    if ((m = /^\$\$([\s\S]+?)\$\$/.exec(src)))           // $$ … $$ inside a paragraph
      return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
    if ((m = /^\\\(([\s\S]+?)\\\)/.exec(src)))           // \( … \)
      return { type: 'mathInline', raw: m[0], text: m[1], display: false };
    // $ … $ — no space just inside the dollars, no digit right after (avoids "$5 and $10")
    if ((m = /^\$(?![\s$])((?:\\[\s\S]|[^\\$\n]|\n(?!\n))+?)(?<!\s)\$(?!\d)/.exec(src)))
      return { type: 'mathInline', raw: m[0], text: m[1], display: false };
  },
  renderer(t) { return renderMath(t.text, t.display); }
};

// ---------------------------------------------------------------- markdown
let slugCounts = new Map();
function slugify(text) {
  let s = text.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const n = slugCounts.get(s) || 0;
  slugCounts.set(s, n + 1);
  return n ? `${s}-${n}` : s;
}

// ---------------------------------------------------------------- footnotes
// [^label] in the text and "[^label]: note" anywhere in the file: numbered in order of first use and listed
// at the end with links both ways, as on GitHub. Notes nobody refers to are not shown; a [^label] without
// a note stays as plain text.
const footnoteStore = { defs: new Map(), html: new Map(), order: new Map(), uses: new Map() };
let lastFootnoteOrder = new Map();      // numbering of the last rendered document (for the Breakdown)
const fnId = label => label.replace(/[^\p{L}\p{N}_-]/gu, c => '_' + c.codePointAt(0).toString(16));

const footnoteDef = {
  name: 'footnoteDef',
  level: 'block',
  start(src) {
    const m = /(^|\n) {0,3}\[\^[^\]\s]+\]:/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    // The note: the rest of the line, plus following lines indented by 2+ spaces or a tab.
    const m = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
    if (!m) return;
    const label = m[1].toLowerCase();
    const token = { type: 'footnoteDef', raw: m[0], label, text: m[2].replace(/\n[ \t]+/g, '\n').trim(), tokens: [] };
    this.lexer.inline(token.text, token.tokens);
    if (!footnoteStore.defs.has(label)) footnoteStore.defs.set(label, token);
    return token;
  },
  renderer(t) {
    if (!footnoteStore.html.has(t.label)) footnoteStore.html.set(t.label, this.parser.parseInline(t.tokens));
    return '';
  }
};

const footnoteRef = {
  name: 'footnoteRef',
  level: 'inline',
  start(src) {
    const i = src.indexOf('[^');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^\[\^([^\]\s]+)\]/.exec(src);
    if (!m || !footnoteStore.defs.has(m[1].toLowerCase())) return;
    return { type: 'footnoteRef', raw: m[0], label: m[1].toLowerCase() };
  },
  renderer(t) {
    if (!footnoteStore.order.has(t.label)) footnoteStore.order.set(t.label, footnoteStore.order.size + 1);
    const k = (footnoteStore.uses.get(t.label) || 0) + 1;
    footnoteStore.uses.set(t.label, k);
    const id = fnId(t.label);
    return `<sup class="fn-ref"><a class="fn-link" href="#fn-${id}" id="fnref-${id}${k > 1 ? '-' + k : ''}">${footnoteStore.order.get(t.label)}</a></sup>`;
  }
};

function footnotesHtml() {
  lastFootnoteOrder = new Map(footnoteStore.order);
  if (!footnoteStore.order.size) return '';
  const items = [...footnoteStore.order.keys()].map(label => {
    const id = fnId(label);
    return `<li id="fn-${id}">${footnoteStore.html.get(label) || ''}<a class="fn-link fn-back" href="#fnref-${id}" aria-label="Back to the text"></a></li>`;
  }).join('');
  return `\n<section class="footnotes"><ol>${items}</ol></section>\n`;
}

const footnoteHooks = {
  preprocess(src) {
    footnoteStore.defs.clear(); footnoteStore.html.clear(); footnoteStore.order.clear(); footnoteStore.uses.clear();
    return src;
  },
  postprocess(html) { return html + footnotesHtml(); }
};

const md = new marked.Marked({ gfm: true });
md.use({ hooks: footnoteHooks });
md.use({
  extensions: [mathBlock, mathInline, footnoteDef, footnoteRef],
  renderer: {
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${esc(slugify(text))}">${inner}</h${depth}>\n`;
    },
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (l === 'math') return renderMath(text, true);
      if (l === 'mermaid') return `<pre class="mermaid">${esc(text)}</pre>\n`;
      return false; // default renderer
    }
  }
});

// ---------------------------------------------------------------- loading
function loadEntries(entries) {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  fileMap.clear();

  for (const e of entries) fileMap.set(key(e.path), { path: norm(e.path), file: e.file });
  source = 'local';
  listBase = '';

  mdPaths = [...fileMap.values()]
    .map(e => e.path)
    .filter(p => DOC_RE.test(p) && !SKIP_DIRS.test(p))
    .sort((a, b) => depth(a) - depth(b) || isReadme(b) - isReadme(a) || a.localeCompare(b));

  buildList();
  updateSidebarAvailability();
  if (!mdPaths.length) {
    currentPath = null;
    pdfBtn.disabled = true;
    dropHint.hidden = true;
    output.innerHTML = '<p>No markdown file found in the selected folder.</p>';
    document.getElementById('docPath').textContent = '';
    document.getElementById('stats').replaceChildren();
    buildToc();
    return;
  }
  openDoc(mdPaths.find(isReadme) || mdPaths[0]);
}

const depth = p => p.split('/').length;
const isReadme = p => /(^|\/)readme\.[^/]+$/i.test(p) ? 1 : 0;

function buildList() {
  const q = filter.value.trim().toLowerCase();
  fileList.innerHTML = '';
  for (const p of mdPaths) {
    const shown = listBase && key(p).startsWith(key(listBase)) ? p.slice(listBase.length) : p;
    if (q && !shown.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    const d = dirOf(shown), name = shown.slice(d.length);
    li.innerHTML = `<span class="dir">${esc(d)}</span>${esc(name)}`;
    li.title = p;
    li.dataset.path = p;
    if (currentPath && key(p) === key(currentPath)) li.className = 'active';
    li.onclick = () => openDoc(p);
    fileList.appendChild(li);
  }
}

async function readDoc(path) {
  if (source === 'app') {
    let res;
    try { res = await fetch(fsURL(path)); }
    catch { throw new Error('The Markdown Viewer helper has closed. Open the file again from Explorer.'); }
    if (!res.ok) throw new Error(res.status === 403
      ? `Can't open files outside the document's folder: ${path}`
      : res.status === 413 ? `File is too large to show: ${path}`
      : `File not found: ${path}`);
    return { path, stamp: res.headers.get('ETag'), ...decodeBytes(await res.arrayBuffer()) };
  }
  const entry = fileMap.get(key(path));
  if (!entry) throw new Error(`File not found: ${path}`);
  return { path: entry.path, ...decodeBytes(await entry.file.arrayBuffer()) };
}

// Reads the file's bytes in the right encoding and describes it: byte-order mark (BOM) first,
// then UTF-16 without a BOM, then strict UTF-8, and Windows-1252 as the fallback.
function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  const info = { bytes: b.length, bom: 'none', name: '', validUtf8: false, note: '' };
  const dec = (label, bytes) => new TextDecoder(label).decode(bytes);
  if (b[0] === 0xFF && b[1] === 0xFE && b[2] === 0 && b[3] === 0) {
    Object.assign(info, { name: 'UTF-32 LE', bom: 'FF FE 00 00', note: 'UTF-32 cannot be displayed properly; re-save the file as UTF-8.' });
    return { text: dec('utf-16le', b.subarray(4)), info };
  }
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    Object.assign(info, { name: 'UTF-8 with BOM', bom: 'EF BB BF (UTF-8)', validUtf8: true });
    return { text: dec('utf-8', b.subarray(3)), info };
  }
  if (b[0] === 0xFF && b[1] === 0xFE) { Object.assign(info, { name: 'UTF-16 LE', bom: 'FF FE (UTF-16 little-endian)' }); return { text: dec('utf-16le', b.subarray(2)), info }; }
  if (b[0] === 0xFE && b[1] === 0xFF) { Object.assign(info, { name: 'UTF-16 BE', bom: 'FE FF (UTF-16 big-endian)' }); return { text: dec('utf-16be', b.subarray(2)), info }; }
  // UTF-16 without a BOM: plain-text characters leave a zero byte in every other position.
  const n = Math.min(b.length, 4096);
  if (n >= 4) {
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i < n; i++) if (b[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
    if (oddZero > n / 4 && evenZero < n / 50) { info.name = 'UTF-16 LE (no BOM, detected)'; return { text: dec('utf-16le', b), info }; }
    if (evenZero > n / 4 && oddZero < n / 50) { info.name = 'UTF-16 BE (no BOM, detected)'; return { text: dec('utf-16be', b), info }; }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    info.validUtf8 = true;
    info.name = b.every(x => x < 0x80) ? 'ASCII (7-bit, also valid UTF-8)' : 'UTF-8 (no BOM)';
    return { text, info };
  } catch {
    info.name = 'Windows-1252 / ANSI (not valid UTF-8)';
    info.note = 'This file is not valid UTF-8, so it was read as Windows-1252 (Western European). If letters look wrong, re-save it as UTF-8.';
    return { text: dec('windows-1252', b), info };
  }
}

// A picture, video or audio file opened on its own ("Open with"): shown as a one-line document with its
// player or picture, so the viewer's tools (picture viewer, Images list, Save as PDF…) work on it too.
function mediaEntry(path) {
  const name = path.split('/').pop();
  const alt = name.replace(/[\\[\]]/g, '\\$&');
  return {
    path, stamp: null,
    text: `# ${alt}\n\n![${alt}](<${name.replace(/[<>]/g, encodeURIComponent)}>)\n`,
    info: { bytes: 0, bom: 'none', name: 'picture, video or audio file (shown, not read as text)', validUtf8: true, note: '' }
  };
}

// Documents visited by following links or the file list, for Back / Forward.
const navBack = [], navFwd = [];
let fileStamp = null;          // version of the open file on disk (auto-reload)

async function openDoc(path, anchor, { fromHistory = false, scroll = null } = {}) {
  if (isEdited() && key(path) !== key(currentPath || '') &&
      !confirm('This document has unsaved replacements. Open another document and discard them?')) return false;
  const from = currentPath ? { path: currentPath, scroll: content.scrollTop } : null;
  let entry;
  try { entry = MEDIA_FILE.test(path) && !MD_RE.test(path) ? mediaEntry(path) : await readDoc(path); }
  catch (e) { alert(e.message); return false; }
  if (!fromHistory && from && key(from.path) !== key(entry.path)) { navBack.push(from); navFwd.length = 0; }
  currentPath = entry.path;
  fileStamp = entry.stamp || null;
  if (source === 'app') history.replaceState(null, '', '?file=' + encodeURIComponent(entry.path));
  currentSource = entry.text;
  currentInfo = entry.info;
  resetEdits();
  renderDoc({ anchor });
  if (scroll !== null) content.scrollTop = scroll;
  updateNavButtons();
  alertBlockedCode();
  return true;
}

// ---------------------------------------------------------------- back / forward
const backBtn = document.getElementById('backBtn');
const fwdBtn = document.getElementById('fwdBtn');
const fileName = p => p.split('/').pop();

function updateNavButtons() {
  backBtn.disabled = !navBack.length;
  fwdBtn.disabled = !navFwd.length;
  backBtn.title = navBack.length ? `Back to ${fileName(navBack[navBack.length - 1].path)} (Alt+←)` : 'Back (Alt+←)';
  fwdBtn.title = navFwd.length ? `Forward to ${fileName(navFwd[navFwd.length - 1].path)} (Alt+→)` : 'Forward (Alt+→)';
}

async function goHistory(from, to) {
  if (!from.length) return;
  const target = from.pop();
  const here = currentPath ? { path: currentPath, scroll: content.scrollTop } : null;
  if (await openDoc(target.path, null, { fromHistory: true, scroll: target.scroll })) { if (here) to.push(here); }
  else from.push(target);
  updateNavButtons();
}
const goBack = () => goHistory(navBack, navFwd);
const goForward = () => goHistory(navFwd, navBack);
backBtn.addEventListener('click', goBack);
fwdBtn.addEventListener('click', goForward);
// The mouse's own back / forward buttons.
window.addEventListener('mouseup', ev => {
  if (ev.button === 3) { ev.preventDefault(); goBack(); }
  else if (ev.button === 4) { ev.preventDefault(); goForward(); }
});

// ---------------------------------------------------------------- auto-reload
// When another program saves the open file, show the new version and keep the reading position.
// Unsaved Find & Replace edits are never thrown away: the viewer only says the file changed.
let reloadBusy = false, reloadWarned = null;
setInterval(async () => {
  if (source !== 'app' || !currentPath || reloadBusy || document.hidden || !fileStamp) return;
  reloadBusy = true;
  try {
    const res = await fetch(fsURL(currentPath), { method: 'HEAD', cache: 'no-store' });
    const stamp = res.ok ? res.headers.get('ETag') : null;
    if (!stamp || stamp === fileStamp) return;
    if (isEdited()) {
      if (reloadWarned !== stamp) {
        reloadWarned = stamp;
        showToast('The file was changed on disk. Your unsaved replacements are kept — open it again to see the new version.');
      }
      return;
    }
    const entry = await readDoc(currentPath);
    fileStamp = entry.stamp || stamp;
    currentSource = entry.text;
    currentInfo = entry.info;
    resetEdits();
    renderDoc({ keepScroll: true });
    showToast('Updated — the file was changed on disk.');
  } catch { /* file gone or app closing: try again next time */ }
  finally { reloadBusy = false; }
}, 1500);

// Renders currentSource (the file as read, or as edited by Find & Replace).
function renderDoc({ anchor = null, keepScroll = false } = {}) {
  const scroll = content.scrollTop;
  if (TABLE_RE.test(currentPath)) {
    // A table file: never parsed as Markdown, so there is no code to report and no source view to map.
    dropHint.hidden = true;
    lastSafety = null;
    renderTableDocument();
    buildToc();
    buildImageList();
    buildLinkList();
    document.getElementById('docPath').textContent = currentPath + (isEdited() ? '  •  edited (unsaved)' : '');
    document.title = `${isEdited() ? '• ' : ''}${currentPath.split('/').pop()} — Markdown Folder Viewer`;
    pdfBtn.disabled = false;
    pdfBtn.title = 'Print or save the rows drawn on the page as a PDF';
    findBtn.disabled = false;
    copyBtn.disabled = true;
    srcBtn.disabled = true;
    cmpBtn.disabled = true;
    for (const li of fileList.children) li.classList.toggle('active', key(li.dataset.path) === key(currentPath));
    if (!findBar.hidden) runFind(keepScroll);
    content.scrollTop = keepScroll ? scroll : 0;
    return;
  }
  const text = currentSource.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // strip YAML front matter

  slugCounts = new Map();
  dropHint.hidden = true;
  output.replaceChildren(sanitize(md.parse(text)));

  fixResources(output, dirOf(currentPath));
  markCallouts(output);
  setDirections(output);
  renderLeftoverMath(output);
  highlightCode(output);
  markHiddenChars(output);
  addCopyButtons(output);
  addTableTools(output);
  output.querySelectorAll('.katex').forEach(k => { k.title = 'Click to copy the LaTeX'; });
  markZoomable(output);
  buildToc();
  buildImageList();
  mapSourceLines();
  if (srcIsOpen()) buildSource(); else srcDirty = true;

  document.getElementById('docPath').textContent = currentPath + (isEdited() ? '  •  edited (unsaved)' : '');
  updateStats();
  buildLinkList();
  // Diagrams draw asynchronously; refresh what depends on them once they're done.
  renderDiagrams(output).then(() => {
    markZoomable(output);
    updateStats();
    if (!findBar.hidden) runFind(true);      // diagram labels are searchable once drawn
  });
  if (!findBar.hidden) runFind(keepScroll);

  document.title = `${isEdited() ? '• ' : ''}${currentPath.split('/').pop()} — Markdown Folder Viewer`;
  pdfBtn.disabled = false;
  pdfBtn.title = 'Print or save this document as a PDF';
  copyBtn.disabled = false;
  findBtn.disabled = false;
  srcBtn.disabled = false;
  cmpBtn.disabled = false;
  for (const li of fileList.children) li.classList.toggle('active', key(li.dataset.path) === key(currentPath));

  if (keepScroll) content.scrollTop = scroll;
  else if (anchor) scrollToAnchor(anchor);
  else content.scrollTop = 0;
}

// Local files a link may open in a new window. Anything that could run code when opened directly
// (HTML, SVG, scripts, PDFs, programs, …) is never linked; the link text stays but is inactive.
const OPENABLE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mp3|wav|ogg|txt)$/i;

// Video and audio files the viewer plays (the app hands these out).
const VIDEO_EXT = /\.(mp4|webm)$/i, AUDIO_EXT = /\.(mp3|wav|ogg)$/i;
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mp3|wav|ogg)$/i;

// Point images/figures/links at the files inside the chosen folder.
function fixResources(root, baseDir) {
  // Video and audio written like a picture - ![clip](clip.mp4), as GitHub allows - play in a player.
  root.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    const file = src.split(/[?#]/)[0];
    const kind = VIDEO_EXT.test(file) ? 'video' : AUDIO_EXT.test(file) ? 'audio' : null;
    if (!kind || isWeb(src)) return;
    const media = document.createElement(kind);
    media.setAttribute('src', src);
    media.controls = true;
    media.preload = 'metadata';
    if (img.getAttribute('alt')) media.title = img.getAttribute('alt');
    for (const a of ['width', 'height']) if (img.getAttribute(a)) media.setAttribute(a, img.getAttribute(a));
    img.replaceWith(media);
  });
  // Pictures switched off: no picture in a document is loaded (a picture opened on its own still shows).
  const block = picturesBlocked() && !(currentPath && MEDIA_FILE.test(currentPath) && !MD_RE.test(currentPath));
  root.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach(el => {
    const src = el.getAttribute('src');
    el.dataset.origSrc = src;
    if (block && (el.tagName === 'IMG' || (el.tagName === 'SOURCE' && el.parentElement?.tagName === 'PICTURE')) && !isWeb(src)) {
      markBlocked(el, src);
      return;
    }
    const entry = localEntry(baseDir, src);
    const isImg = el.tagName === 'IMG';
    if (entry) {
      if (isImg && source === 'app') el.addEventListener('error', () => markMissing(el, src, baseDir), { once: true });
      el.src = blobURL(entry);
      return;
    }
    if (isWeb(src)) { markWeb(el, src); return; }
    if (!isExternal(src) && isImg) markMissing(el, src, baseDir);
  });
  root.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
    if (block && (el.tagName === 'IMG' || el.parentElement?.tagName === 'PICTURE')) { el.removeAttribute('srcset'); return; }
    el.srcset = el.getAttribute('srcset').split(',').map(part => {
      const [url, ...rest] = part.trim().split(/\s+/);
      const entry = localEntry(baseDir, url);
      return isWeb(url) ? '' : [entry ? blobURL(entry) : url, ...rest].join(' ');
    }).filter(Boolean).join(', ');
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    a.dataset.origHref = href;
    if (href.startsWith('#')) {
      a.addEventListener('click', ev => { ev.preventDefault(); scrollToAnchor(href.slice(1)); });
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      a.target = '_blank';
      return;
    }
    const entry = isExternal(href) ? null : (localEntry(baseDir, href) || { path: resolve(baseDir, href), missing: true });
    if (entry && DOC_RE.test(entry.path)) {
      const anchor = href.includes('#') ? href.split('#')[1] : '';
      a.addEventListener('click', ev => { ev.preventDefault(); openDoc(entry.path, anchor); });
    } else if (entry && !entry.missing && OPENABLE.test(entry.path)) {
      // In the app a file opened on its own is sandboxed, and a sandboxed page cannot play video or audio:
      // those open in a new viewer window with its player instead (as "Open with" does).
      a.href = source === 'app' && (VIDEO_EXT.test(entry.path) || AUDIO_EXT.test(entry.path))
        ? new URL('viewer.html?file=' + encodeURIComponent(entry.path), location.href).href
        : blobURL(entry);
      a.target = '_blank';
    } else {
      disableLink(a, entry && !entry.missing
        ? 'Opening this type of file is disabled in preview mode'
        : 'Link target not available');
    }
  });
}

// GitHub-style callouts: a quote whose first line is [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
// The marker is removed and the title is drawn by CSS (so it is not counted as document text).
const CALLOUT_RE = /^[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
function markCallouts(root) {
  root.querySelectorAll('blockquote').forEach(bq => {
    const p = bq.firstElementChild;
    const first = p && p.tagName === 'P' ? p.firstChild : null;
    if (!first || first.nodeType !== Node.TEXT_NODE) return;
    const m = CALLOUT_RE.exec(first.data);
    if (!m) return;
    first.data = first.data.slice(m[0].length);
    if (p.firstChild && p.firstChild.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent.trim() && !p.querySelector('img, svg, .katex, input')) p.remove();
    bq.classList.add('callout', 'callout-' + m[1].toLowerCase());
  });
}

// Each block follows its own language: Arabic, Hebrew… right to left, others left to right.
function setDirections(root) {
  root.querySelectorAll('p, ul, ol, li, h1, h2, h3, h4, h5, h6, blockquote, table, th, td, dl, dt, dd, figcaption, details, summary, caption')
    .forEach(el => { if (!el.hasAttribute('dir')) el.dir = 'auto'; });
}

// A copy button on every code block.
function addCopyButtons(root) {
  root.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains('code-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.append(pre);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'code-copy';
    b.title = 'Copy the code';
    b.setAttribute('aria-label', 'Copy the code');
    b.addEventListener('click', async ev => {
      ev.stopPropagation();
      const clean = code.cloneNode(true);
      clean.querySelectorAll('.hc-badge').forEach(x => x.remove());   // ¶ Hidden labels are not part of the code
      const ok = await copyToClipboard(clean.textContent);
      b.classList.toggle('done', ok);
      if (!ok) showToast('Could not copy the code.');
      setTimeout(() => b.classList.remove('done'), 1500);
    });
    wrap.append(b);
  });
}

// Tables: click a column header to sort by it (again: reverse; a third time: the original order).
// "⧉ Copy" puts the table on the clipboard so it pastes into Excel or Word as cells; "⬇ CSV" saves it.
// (Button labels are drawn by CSS, so they are not part of the document's text.)
function tableCells(table) {
  return [...table.rows].map(row => [...row.cells].map(cell => {
    const c = cell.cloneNode(true);
    c.querySelectorAll('.hc-badge').forEach(x => x.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }));
}
const tableTsv = table => tableCells(table).map(r => r.join('\t')).join('\r\n');
const tableCsv = table => tableCells(table)
  .map(r => r.map(v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\r\n');

function sortValue(text) {
  const n = text.replace(/[\s,%$€£]/g, '');
  return /\d/.test(n) && n !== '' && isFinite(Number(n)) ? Number(n) : null;
}

function addTableTools(root) {
  root.querySelectorAll('table').forEach((table, index) => {
    if (table.parentElement.classList.contains('table-tools')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-tools';
    table.replaceWith(wrap);
    wrap.append(table);
    const bar = document.createElement('div');
    bar.className = 'table-bar';
    const button = (cls, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      bar.append(b);
    };
    button('table-copy', 'Copy the table — pastes into Excel or Word as cells', async () => {
      showToast(await copyToClipboard(tableTsv(table)) ? 'Table copied — paste it into Excel or Word.' : 'Could not copy the table.');
    });
    button('table-csv', 'Save the table as a CSV file', async () => {
      const base = (currentPath || 'table').split('/').pop().replace(MD_RE, '');
      const csv = String.fromCharCode(0xFEFF) + tableCsv(table);         // the mark makes Excel read it as UTF-8
      try {
        const saved = await saveFileAs(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${base}-table-${index + 1}.csv`,
          { description: 'CSV table', accept: { 'text/csv': ['.csv'] } });
        if (saved) showToast(`Saved “${saved}”.`);
      } catch (e) { showToast(`Saving failed: ${e.message}`); }
    });
    wrap.prepend(bar);

    const head = table.tHead && table.tHead.rows[0];
    const body = table.tBodies[0];
    if (!head || !body || body.rows.length < 2) return;
    const original = [...body.rows];
    [...head.cells].forEach((th, col) => {
      th.classList.add('sortable');
      th.tabIndex = 0;
      th.title = 'Click to sort by this column';
      const sort = () => {
        const next = th.dataset.sort === 'asc' ? 'desc' : th.dataset.sort === 'desc' ? '' : 'asc';
        head.querySelectorAll('th').forEach(h => { delete h.dataset.sort; });
        let rows = original;
        if (next) {
          const key = r => (r.cells[col] ? r.cells[col].textContent.trim() : '');
          rows = [...original].sort((a, b) => {
            const x = key(a), y = key(b), nx = sortValue(x), ny = sortValue(y);
            const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
            return next === 'asc' ? c : -c;
          });
          th.dataset.sort = next;
        }
        body.append(...rows);
      };
      th.addEventListener('click', sort);
      th.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); sort(); } });
    });
  });
}

// ---------------------------------------------------------------- CSV / TSV tables
// A .csv or .tsv file is shown as a table of plain text: every cell goes into the page with textContent,
// so nothing in the file can become markup, a link, a picture or code. Rows are sorted and filtered in
// memory and drawn a page at a time, so large files stay quick.
const TABLE_RE = /\.(csv|tsv)$/i;
const DOC_RE = /\.(md|markdown|mdown|mkd|csv|tsv)$/i;
const CSV_PAGE = 500;
const csvCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'vertical bar' };
let csvState = null;

// Rows of delimited text (RFC 4180: a quoted field may hold the delimiter, line breaks and "" for a quote).
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], start = 0, i = 0;
  const n = text.length;
  while (i <= n) {
    if (i < n && text[i] === '"' && i === start) {           // quoted field
      let value = '', j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { value += text.slice(j); j = n; break; }
        value += text.slice(j, q);
        if (text[q + 1] === '"') { value += '"'; j = q + 2; continue; }
        j = q + 1; break;
      }
      // Anything between the closing quote and the next delimiter or line break is kept as written.
      let k = j;
      while (k < n && text[k] !== delim && text[k] !== '\n' && text[k] !== '\r') k++;
      row.push(value + text.slice(j, k));
      i = k;
    } else {
      let k = i;
      while (k < n && text[k] !== delim && text[k] !== '\n' && text[k] !== '\r') k++;
      row.push(text.slice(i, k));
      i = k;
    }
    if (i >= n) { rows.push(row); break; }
    if (text[i] === delim) { i++; start = i; if (i === n) { row.push(''); rows.push(row); break; } continue; }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;      // line break
    rows.push(row); row = []; start = i;
    if (i === n) break;
  }
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

// The separator: an Excel "sep=" first line, tab for .tsv, else the one that splits the first lines most evenly.
function detectDelimiter(text, path) {
  const sep = /^sep=([,;\t|])\r?\n/i.exec(text);
  if (sep) return { delim: sep[1], skip: sep[0].length };
  if (/\.tsv$/i.test(path)) return { delim: '\t', skip: 0 };
  const lines = text.slice(0, 50000).split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 25);
  let best = ',', bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map(l => l.replace(/"[^"]*"/g, '').split(d).length - 1);
    if (!counts.length || !counts[0]) continue;
    const score = counts.filter(c => c === counts[0]).length * 1000 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return { delim: best, skip: 0 };
}

// A column filter: plain text matches anywhere in the cell (case does not matter); >, <, >=, <=, = and !=
// followed by a number compare numbers; = and != followed by text compare the whole cell.
function compileFilter(text) {
  const t = text.trim();
  if (!t) return null;
  const m = /^(>=|<=|!=|>|<|=)\s*(.*)$/.exec(t);
  if (m) {
    const op = m[1], arg = m[2].trim(), num = sortValue(arg);
    if (num !== null) {
      return cell => {
        const v = sortValue(cell.trim());
        if (v === null) return false;
        return op === '>' ? v > num : op === '<' ? v < num : op === '>=' ? v >= num : op === '<=' ? v <= num : op === '=' ? v === num : v !== num;
      };
    }
    if (op === '=' || op === '!=') {
      const want = arg.toLocaleLowerCase();
      return op === '=' ? cell => cell.trim().toLocaleLowerCase() === want : cell => cell.trim().toLocaleLowerCase() !== want;
    }
  }
  const want = t.toLocaleLowerCase();
  return cell => cell.toLocaleLowerCase().includes(want);
}

function renderTableDocument() {
  const text = currentSource.replace(/^﻿/, '');
  const { delim, skip } = detectDelimiter(text, currentPath);
  const rows = parseDelimited(text.slice(skip), delim);
  let width = 0;
  for (const r of rows) if (r.length > width) width = r.length;
  const keep = csvState && csvState.path === currentPath ? csvState : null;     // same file again (reload): keep the view
  csvState = { path: currentPath, delim, rows, width, header: keep ? keep.header : true,
               sortCol: keep ? keep.sortCol : -1, sortDir: keep ? keep.sortDir : '',
               filter: keep ? keep.filter : '', colFilters: keep ? keep.colFilters : [], shown: CSV_PAGE };
  buildCsvView();
}

function buildCsvView() {
  const s = csvState;
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const blank = Array.from({ length: s.width }, (_, i) => `Column ${i + 1}`);
  s.head = s.header && s.rows.length ? blank.map((b, i) => (s.rows[0][i] || '').trim() || b) : blank;
  s.data = s.header ? s.rows.slice(1) : s.rows;
  // Columns that hold numbers (most filled cells) sort as numbers and line up on the right.
  s.numeric = s.head.map((_, c) => {
    let filled = 0, num = 0;
    for (let r = 0; r < s.data.length && r < 2000; r++) {
      const v = (s.data[r][c] || '').trim();
      if (!v) continue;
      filled++;
      if (sortValue(v) !== null) num++;
    }
    return filled > 0 && num / filled >= 0.8;
  });

  const view = make('div', 'csv-view');
  const bar = make('div', 'csv-bar');
  const search = make('input', 'csv-search');
  search.type = 'search';
  search.placeholder = 'Filter all columns…';
  search.value = s.filter;
  search.setAttribute('aria-label', 'Filter all columns');
  const headerLabel = make('label', 'csv-option');
  const headerBox = make('input');
  headerBox.type = 'checkbox';
  headerBox.checked = s.header;
  headerLabel.append(headerBox, document.createTextNode(' First row is the header'));
  const clear = make('button', 'csv-btn', 'Clear filters');
  clear.type = 'button';
  const info = make('span', 'csv-info');
  const copy = make('button', 'csv-btn', '⧉ Copy');
  copy.type = 'button';
  copy.title = 'Copy the rows shown by the filters, in this order — pastes into Excel or Word as cells';
  const save = make('button', 'csv-btn', '⬇ Save CSV');
  save.type = 'button';
  save.title = 'Save the rows shown by the filters, in this order, as a CSV file';
  bar.append(search, headerLabel, clear, info, copy, save);

  const scroll = make('div', 'csv-scroll');
  const table = make('table', 'csv-table');
  const thead = make('thead');
  const headRow = make('tr');
  const filterRow = make('tr', 'csv-filters');
  s.head.forEach((name, c) => {
    const th = make('th', 'sortable', name);
    th.tabIndex = 0;
    th.title = 'Click to sort by this column (again to reverse, a third time for the file order)';
    if (s.numeric[c]) th.classList.add('num');
    if (s.sortCol === c && s.sortDir) th.dataset.sort = s.sortDir;
    const sort = () => {
      s.sortDir = s.sortCol !== c ? 'asc' : s.sortDir === 'asc' ? 'desc' : s.sortDir === 'desc' ? '' : 'asc';
      s.sortCol = s.sortDir ? c : -1;
      headRow.querySelectorAll('th').forEach(h => { delete h.dataset.sort; });
      if (s.sortDir) th.dataset.sort = s.sortDir;
      refreshCsv();
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); sort(); } });
    headRow.append(th);
    const fth = make('th');
    const input = make('input', 'csv-col-filter');
    input.type = 'search';
    input.placeholder = s.numeric[c] ? 'e.g. >100' : 'filter';
    input.title = 'Text anywhere in the cell; or >, <, >=, <=, =, != followed by a number; = or != followed by text for the whole cell';
    input.setAttribute('aria-label', `Filter ${name}`);
    input.value = s.colFilters[c] || '';
    input.addEventListener('input', debounce(() => { s.colFilters[c] = input.value; s.shown = CSV_PAGE; refreshCsv(); }, 150));
    fth.append(input);
    filterRow.append(fth);
  });
  thead.append(headRow, filterRow);
  const tbody = make('tbody');
  table.append(thead, tbody);
  scroll.append(table);
  const more = make('button', 'csv-btn csv-more');
  more.type = 'button';
  view.append(bar, scroll, more);
  s.dom = { tbody, info, more, search, filterRow, headRow };

  search.addEventListener('input', debounce(() => { s.filter = search.value; s.shown = CSV_PAGE; refreshCsv(); }, 150));
  headerBox.addEventListener('change', () => { s.header = headerBox.checked; s.sortCol = -1; s.sortDir = ''; s.colFilters = []; buildCsvView(); });
  clear.addEventListener('click', () => {
    s.filter = ''; s.colFilters = []; s.shown = CSV_PAGE;
    search.value = '';
    filterRow.querySelectorAll('input').forEach(i => { i.value = ''; });
    refreshCsv();
  });
  more.addEventListener('click', () => { s.shown += CSV_PAGE; refreshCsv(false); });
  copy.addEventListener('click', async () => {
    const text = csvRowsShown().map(r => r.map(c => /[\t\r\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join('\t')).join('\r\n');
    showToast(await copyToClipboard(text) ? `Copied ${plural(s.view.length, 'row')} — paste them into Excel or Word.` : 'Could not copy the rows.');
  });
  save.addEventListener('click', async () => {
    const csv = String.fromCharCode(0xFEFF) + csvRowsShown().map(r => r.map(c => /[,"\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\r\n') + '\r\n';
    const base = currentPath.split('/').pop().replace(TABLE_RE, '');
    try {
      const saved = await saveFileAs(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${base}-filtered.csv`,
        { description: 'CSV table', accept: { 'text/csv': ['.csv'] } });
      if (saved) showToast(`Saved “${saved}”.`);
    } catch (e) { showToast(`Saving failed: ${e.message}`); }
  });

  output.replaceChildren(view);
  refreshCsv();
}

// The header and the rows the filters keep, in the shown order (all of them, not just the drawn page).
function csvRowsShown() {
  const s = csvState;
  return [s.head, ...s.view.map(i => s.head.map((_, c) => s.data[i][c] || ''))];
}

// redraw: filter and sort again, then draw the first page. Without it (Show more): only draw the next rows.
function refreshCsv(redraw = true) {
  const s = csvState;
  if (redraw) csvApplyView(s);
  csvDraw(s, redraw);
}

function csvApplyView(s) {
  const all = s.filter.trim().toLocaleLowerCase();
  const tests = s.head.map((_, c) => compileFilter(s.colFilters[c] || ''));
  const view = [];
  for (let i = 0; i < s.data.length; i++) {
    const row = s.data[i];
    if (all && !row.some(c => c.toLocaleLowerCase().includes(all))) continue;
    let keep = true;
    for (let c = 0; c < tests.length; c++) if (tests[c] && !tests[c](row[c] || '')) { keep = false; break; }
    if (keep) view.push(i);
  }
  if (s.sortCol >= 0 && s.sortDir) {
    const c = s.sortCol, dir = s.sortDir === 'asc' ? 1 : -1, numeric = s.numeric[c];
    const key = numeric ? view.map(i => sortValue((s.data[i][c] || '').trim())) : null;
    const order = view.map((_, k) => k);
    order.sort((a, b) => {
      let r;
      if (numeric) {
        const x = key[a], y = key[b];
        if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;     // empty / text cells last
        r = x - y;
      } else r = csvCollator.compare(s.data[view[a]][c] || '', s.data[view[b]][c] || '');
      return r * dir || a - b;
    });
    s.view = order.map(k => view[k]);
  } else s.view = view;
}

function csvDraw(s, redraw) {
  const { tbody, info, more } = s.dom;
  const from = redraw ? 0 : tbody.rows.length;
  const to = Math.min(s.view.length, s.shown);
  const frag = document.createDocumentFragment();
  for (let k = from; k < to; k++) {
    const row = s.data[s.view[k]];
    const tr = document.createElement('tr');
    for (let c = 0; c < s.width; c++) {
      const td = document.createElement('td');
      td.textContent = row[c] || '';
      if (s.numeric[c]) td.className = 'num';
      tr.append(td);
    }
    frag.append(tr);
  }
  if (redraw) tbody.replaceChildren(frag); else tbody.append(frag);
  const filtered = s.view.length !== s.data.length;
  info.textContent = `${filtered ? `${fmt(s.view.length)} of ${fmt(s.data.length)}` : fmt(s.data.length)} row${s.data.length === 1 ? '' : 's'}` +
                     (to < s.view.length ? ` · first ${fmt(to)} shown` : '');
  more.hidden = to >= s.view.length;
  more.textContent = `Show ${fmt(Math.min(CSV_PAGE, s.view.length - to))} more`;
  updateCsvStats();
}

function updateCsvStats() {
  const s = csvState;
  const stats = document.getElementById('stats');
  if (!s || !TABLE_RE.test(currentPath || '')) return;
  const group = (title, text) => { const g = document.createElement('span'); g.className = 'group'; g.title = title; g.textContent = text; return g; };
  stats.replaceChildren(
    group('The table in this file', `Table: ${plural(s.data.length, 'row')} · ${plural(s.width, 'column')} · separator: ${DELIM_NAMES[s.delim] || s.delim}` +
          (s.header ? ' · first row is the header' : '')),
    group('Rows kept by the filters', `Shown: ${plural(s.view.length, 'row')}`),
    group('How this file is shown', 'Shown as plain text: nothing in a table can run, link or load anything'));
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function disableLink(a, reason) {
  a.removeAttribute('href');
  a.classList.add('link-disabled');
  a.title = reason;
}

// ---------------------------------------------------------------- counts
let currentSource = '';
const fmt = n => n.toLocaleString();
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
// Characters = Unicode characters including spaces, not counting line breaks or invisible
// zero-width characters (math layout inserts some; they are never seen).
const charCount = s => [...s.replace(/\r\n|\r|\n/g, '').replace(/[​-‍⁠\uFEFF]/g, '')].length;

// Words in any language (Arabic, Chinese… too); numbers count as words, punctuation doesn't.
const wordSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
function countWords(text) {
  if (wordSegmenter) {
    let n = 0;
    for (const s of wordSegmenter.segment(text)) if (s.isWordLike) n++;
    return n;
  }
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}

// Sentences in any language, using the browser's sentence rules (which know that "e.g. x" or
// "3.14" don't end a sentence). Each list item or line without a full stop still counts as one.
const sentenceSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
function countSentences(text) {
  // Needs at least one letter: "1." or "(2)" on its own is a numbering label, not a sentence.
  const hasWord = s => /\p{L}/u.test(s);
  if (sentenceSegmenter) {
    let n = 0;
    for (const s of sentenceSegmenter.segment(text)) if (hasWord(s.segment)) n++;
    return n;
  }
  return text.split(/(?<=[.!?。！？])\s+|\n+/).filter(hasWord).length;
}

// Average adult silent-reading speed for non-fiction.
const READING_WPM = 230;
function readingTime(words) {
  const minutes = words / READING_WPM;
  if (!words) return '0 min read';
  if (minutes < 1) return '&lt; 1 min read';
  if (minutes < 60) return `${Math.round(minutes)} min read`;
  return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min read`;
}

function updateStats() {
  const stats = document.getElementById('stats');
  if (!currentPath) { stats.replaceChildren(); return; }
  if (TABLE_RE.test(currentPath)) { updateCsvStats(); return; }

  // Original file: every line, as an editor numbers them (a final line break doesn't add a line).
  const src = currentSource.replace(/^\uFEFF/, '');
  const srcLines = src === '' ? 0 : src.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(src) ? 1 : 0);

  // Viewed document: the text actually shown on screen (paragraphs, list items, table rows,
  // code lines, labels in diagrams…), counting non-empty lines.
  output.classList.add('measuring');
  const shown = output.innerText;
  // Words: the readable text only, so code, equations and diagram labels are left out.
  output.classList.add('words-only');
  const prose = output.innerText;
  // Sentences: running text only (headings and table cells are labels, not sentences).
  output.classList.add('sentences-only');
  const sentenceText = output.innerText;
  output.classList.remove('measuring', 'words-only', 'sentences-only');
  const shownLines = shown.split('\n').filter(l => l.trim()).length;
  const words = countWords(prose);
  const sentences = countSentences(sentenceText);
  // Paragraphs: visible text paragraphs (not headings, list bullets, table cells or picture-only lines).
  const paragraphs = [...output.querySelectorAll('p')].filter(p =>
    !p.closest('table') && /[\p{L}\p{N}]/u.test(p.textContent) && (p.checkVisibility ? p.checkVisibility() : true)).length;

  // Links: everything that is a link in the document, including ones disabled in preview mode.
  const linkEls = [...output.querySelectorAll('a')].filter(a => (a.hasAttribute('href') || a.classList.contains('link-disabled')) && !a.classList.contains('fn-link'));
  const disabledLinks = linkEls.filter(a => a.classList.contains('link-disabled')).length;

  const images = output.querySelectorAll('img').length;
  const missing = output.querySelectorAll('img.missing').length;
  const web = output.querySelectorAll('img.web').length;
  const blocked = output.querySelectorAll('img.blocked').length;
  const tables = output.querySelectorAll('table').length;
  const codeBlocks = output.querySelectorAll('pre > code').length;   // diagrams and ```math aren't code blocks
  const equations = output.querySelectorAll('.katex').length;
  const diagrams = output.querySelectorAll('pre.mermaid').length;

  const group = (title, html) => {
    const span = document.createElement('span');
    span.className = 'group';
    span.title = title;
    span.innerHTML = html;   // numbers and fixed words only
    return span;
  };
  // Explain the difference and check the explanation adds up exactly.
  let analysis = null;
  try { analysis = analyzeDocument(currentSource); } catch (e) { console.warn('Breakdown:', e); }
  lastBreakdown = {
    path: currentPath,
    source: { lines: srcLines, chars: charCount(src), words: countWords(src) },
    viewed: { lines: shownLines, chars: charCount(shown), words },
    analysis
  };
  // ✓ only when the categories explain the source → viewed difference for lines, chars and words.
  const ok = analysis && ['lines', 'chars', 'words'].every(k =>
    lastBreakdown.source[k] - analysis.cats.reduce((s, c) => s + c[k], 0) === lastBreakdown.viewed[k]);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'breakdown-btn ' + (ok ? 'ok' : 'bad');
  btn.textContent = ok ? '✓ Breakdown' : '✗ Breakdown';
  btn.title = ok
    ? 'Every removed line, character and word is accounted for — click for the full breakdown'
    : 'The breakdown does not fully explain the difference — click for details';
  btn.addEventListener('click', showBreakdown);

  // Encoding & hidden-characters inspector; flags the document when something invisible is found.
  lastInspection = inspectCharacters(currentSource, currentInfo);
  const warn = lastInspection.warnings;
  const holders = lastInspection.placeholders.reduce((s, p) => s + p.count, 0);
  const insBtn = document.createElement('button');
  insBtn.type = 'button';
  insBtn.className = 'breakdown-btn ' + (warn || holders ? 'warn' : 'neutral');
  const parts = [warn && fmt(warn), holders && `${fmt(holders)} placeholder${holders === 1 ? '' : 's'}`].filter(Boolean);
  insBtn.textContent = parts.length ? `⚠ Characters (${parts.join(' · ')})` : '🔍 Characters';
  insBtn.title = [warn && `${fmt(warn)} invisible or unusual character(s)`,
                  holders && `${fmt(holders)} leftover placeholder text(s) such as TODO or [Insert …]`].filter(Boolean).join(' and ') +
    (parts.length ? ' found — click for the full list' : 'Encoding, escapes, hidden characters and placeholder text — click for details');
  insBtn.addEventListener('click', showInspection);

  stats.replaceChildren(
    group('Content in this document: pictures, links, tables, code blocks, equations and diagrams',
      [plural(images, 'image') + (missing ? ` (${fmt(missing)} missing)` : '') + (web ? ` (${fmt(web)} from the web, not loaded)` : '') +
         (blocked ? ` (${fmt(blocked)} not loaded — pictures are off)` : ''),
       plural(linkEls.length, 'link') + (disabledLinks ? ` (${fmt(disabledLinks)} disabled)` : ''),
       plural(tables, 'table'), plural(codeBlocks, 'code block'), plural(equations, 'equation'),
       diagrams ? plural(diagrams, 'diagram') : '']
        .filter(Boolean).join(' · ')),
    group('The Markdown file as saved on disk (characters include spaces, not line breaks); ' +
          'words are every word in the file, including code, link addresses and math commands',
      `Source file: <b>${fmt(srcLines)}</b> lines · <b>${fmt(charCount(src))}</b> chars · <b>${fmt(countWords(src))}</b> words`),
    group('Text shown in the viewer: non-empty lines and characters (spaces included, line breaks not); ' +
          'words count the readable text, not code, equations or diagram labels; ' +
          'sentences count running text (not headings or table cells); ' +
          'paragraphs are text paragraphs (not headings, list items, table cells or picture-only lines); ' +
          `reading time at ${READING_WPM} words per minute`,
      `Viewed: <b>${fmt(shownLines)}</b> lines · <b>${fmt(charCount(shown))}</b> chars · <b>${fmt(words)}</b> words · ` +
      `<b>${fmt(sentences)}</b> sentences · <b>${fmt(paragraphs)}</b> paragraphs · ${readingTime(words)}`),
    safetyButton(), btn, insBtn);
}

let lastBreakdown = null;

function showBreakdown() {
  const d = lastBreakdown;
  if (!d) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const num = n => (n < 0 ? '+' : n > 0 ? '−' : '') + fmt(Math.abs(n));   // removed shown as −, added as +
  const KEYS = ['lines', 'chars', 'words'];
  const row = (cls, label, v, signed) => {
    const tr = el('tr', cls);
    tr.append(el('td', '', label), ...KEYS.map(k => el('td', 'n', signed ? num(v[k]) : fmt(v[k]))));
    return tr;
  };

  document.getElementById('bdFile').textContent = d.path;
  const tbody = document.querySelector('#bdTable tbody');
  tbody.replaceChildren();
  tbody.append(row('total', 'Source file', d.source, false));

  const cats = d.analysis ? [...d.analysis.cats].sort((a, b) =>
    Math.abs(b.chars) - Math.abs(a.chars) || Math.abs(b.words) - Math.abs(a.words) || Math.abs(b.lines) - Math.abs(a.lines)) : [];
  for (const c of cats) tbody.append(row('', c.name, c, true));

  const expected = {}, gap = {};
  for (const k of KEYS) {
    expected[k] = d.source[k] - cats.reduce((s, c) => s + c[k], 0);
    gap[k] = expected[k] - d.viewed[k];
  }
  const ok = d.analysis && KEYS.every(k => !gap[k]);
  if (!ok) tbody.append(row('bad', 'Not explained', gap, true));

  tbody.append(row('total', 'Expected on screen (source − formatting)', expected, false));
  tbody.append(row('total', 'Actually on screen (measured)', d.viewed, false));

  const status = document.getElementById('bdStatus');
  status.className = 'bd-status ' + (ok ? 'ok' : 'bad');
  const missed = KEYS.filter(k => gap[k]).map(k => `${fmt(Math.abs(gap[k]))} ${k === 'chars' ? 'character' : k.slice(0, -1)}(s)`);
  status.textContent = !d.analysis
    ? '✗ The breakdown could not be calculated for this document.'
    : ok
      ? '✓ Every line, character and word of difference is accounted for.'
      : `✗ ${missed.join(', ')} of difference ${missed.length > 1 ? 'are' : 'is'} not explained by the categories above.`;
  document.getElementById('breakdown').showModal();
}
document.getElementById('bdClose').addEventListener('click', () => document.getElementById('breakdown').close());

// ---------------------------------------------------------------- encoding & characters inspector
let currentInfo = null;      // encoding of the open document (from decodeBytes)
let lastInspection = null;

const CHAR_NAMES = {
  0x0000: 'NULL', 0x0007: 'BELL', 0x0008: 'BACKSPACE', 0x0009: 'TAB', 0x000B: 'VERTICAL TAB', 0x000C: 'FORM FEED',
  0x001B: 'ESCAPE (ESC)', 0x007F: 'DELETE', 0x0085: 'NEXT LINE (NEL)', 0x00A0: 'NO-BREAK SPACE', 0x00AD: 'SOFT HYPHEN',
  0x034F: 'COMBINING GRAPHEME JOINER', 0x061C: 'ARABIC LETTER MARK', 0x115F: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER', 0x1680: 'OGHAM SPACE MARK', 0x17B4: 'KHMER VOWEL INHERENT AQ',
  0x17B5: 'KHMER VOWEL INHERENT AA', 0x180E: 'MONGOLIAN VOWEL SEPARATOR',
  0x2000: 'EN QUAD', 0x2001: 'EM QUAD', 0x2002: 'EN SPACE', 0x2003: 'EM SPACE', 0x2004: 'THREE-PER-EM SPACE',
  0x2005: 'FOUR-PER-EM SPACE', 0x2006: 'SIX-PER-EM SPACE', 0x2007: 'FIGURE SPACE', 0x2008: 'PUNCTUATION SPACE',
  0x2009: 'THIN SPACE', 0x200A: 'HAIR SPACE', 0x200B: 'ZERO WIDTH SPACE', 0x200C: 'ZERO WIDTH NON-JOINER',
  0x200D: 'ZERO WIDTH JOINER', 0x200E: 'LEFT-TO-RIGHT MARK', 0x200F: 'RIGHT-TO-LEFT MARK',
  0x2028: 'LINE SEPARATOR', 0x2029: 'PARAGRAPH SEPARATOR', 0x202A: 'LEFT-TO-RIGHT EMBEDDING',
  0x202B: 'RIGHT-TO-LEFT EMBEDDING', 0x202C: 'POP DIRECTIONAL FORMATTING', 0x202D: 'LEFT-TO-RIGHT OVERRIDE',
  0x202E: 'RIGHT-TO-LEFT OVERRIDE', 0x202F: 'NARROW NO-BREAK SPACE', 0x205F: 'MEDIUM MATHEMATICAL SPACE',
  0x2060: 'WORD JOINER', 0x2061: 'FUNCTION APPLICATION', 0x2062: 'INVISIBLE TIMES', 0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS', 0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE', 0x3000: 'IDEOGRAPHIC SPACE',
  0x3164: 'HANGUL FILLER', 0xFEFF: 'ZERO WIDTH NO-BREAK SPACE (BOM)', 0xFFA0: 'HALFWIDTH HANGUL FILLER',
  0xFFFD: 'REPLACEMENT CHARACTER', 0xFFFC: 'OBJECT REPLACEMENT CHARACTER', 0x2800: 'BRAILLE PATTERN BLANK',
  0xFFF9: 'INTERLINEAR ANNOTATION ANCHOR', 0xFFFA: 'INTERLINEAR ANNOTATION SEPARATOR', 0xFFFB: 'INTERLINEAR ANNOTATION TERMINATOR',
  0x206A: 'INHIBIT SYMMETRIC SWAPPING', 0x206B: 'ACTIVATE SYMMETRIC SWAPPING', 0x206C: 'INHIBIT ARABIC FORM SHAPING',
  0x206D: 'ACTIVATE ARABIC FORM SHAPING', 0x206E: 'NATIONAL DIGIT SHAPES', 0x206F: 'NOMINAL DIGIT SHAPES',
  0x180B: 'MONGOLIAN FREE VARIATION SELECTOR ONE', 0x180C: 'MONGOLIAN FREE VARIATION SELECTOR TWO',
  0x180D: 'MONGOLIAN FREE VARIATION SELECTOR THREE', 0x180F: 'MONGOLIAN FREE VARIATION SELECTOR FOUR', 0xE0001: 'LANGUAGE TAG'
};

const CHAR_KINDS = {
  zero: { label: 'Zero-width (invisible, takes no space)', warn: true },
  bidi: { label: 'Text-direction control (can reorder how text is displayed)', warn: true },
  control: { label: 'Control character', warn: true },
  separator: { label: 'Unicode line/paragraph separator', warn: true },
  replacement: { label: 'Replacement character (sign of a decoding error)', warn: true },
  privateUse: { label: 'Private-use character (no standard meaning)', warn: true },
  nonchar: { label: 'Noncharacter (should not appear in text)', warn: true },
  placeholder: { label: 'Placeholder for a missing object or image (left over from copy-paste)', warn: true },
  blank: { label: 'Blank-looking character (looks like a space but is a letter or symbol)', warn: true },
  unassigned: { label: 'Unassigned code point (no character; may show as nothing or a box)', warn: true },
  space: { label: 'Unusual space (looks like a normal space)', warn: false },
  tab: { label: 'Tab', warn: false }
};

// Unicode "format" characters (Cf) are invisible by definition; these few draw a visible sign.
const VISIBLE_FORMAT = new Set([0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x110BD, 0x110CD]);
const FORMAT_RE = /\p{Cf}/u, UNASSIGNED_RE = /\p{Cn}/u;

function charKind(cp) {
  if (cp === 0xFFFC) return 'placeholder';
  if (cp === 0x2800 || cp === 0x3164 || cp === 0xFFA0 || cp === 0x115F || cp === 0x1160) return 'blank';
  if ((cp >= 0x200B && cp <= 0x200D) || cp === 0x2060 || cp === 0xFEFF || cp === 0x180E || (cp >= 0x2061 && cp <= 0x2064) ||
      cp === 0x034F || cp === 0x00AD || cp === 0x17B4 || cp === 0x17B5 ||
      (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF) || (cp >= 0xE0000 && cp <= 0xE007F) ||
      (cp >= 0x180B && cp <= 0x180F)) return 'zero';
  if (cp === 0x200E || cp === 0x200F || cp === 0x061C || (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if (cp === 0x09) return 'tab';
  if ((cp < 0x20 && cp !== 0x0A && cp !== 0x0D) || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F)) return 'control';
  if (cp === 0x00A0 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0x1680) return 'space';
  if (cp === 0x2028 || cp === 0x2029) return 'separator';
  if (cp === 0xFFFD) return 'replacement';
  if ((cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE) return 'nonchar';
  if ((cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) return 'privateUse';
  if (cp < 0x80) return null;
  const ch = String.fromCodePoint(cp);
  if (FORMAT_RE.test(ch) && !VISIBLE_FORMAT.has(cp)) return 'zero';   // any other invisible format character
  if (UNASSIGNED_RE.test(ch)) return 'unassigned';
  return null;
}

function charName(cp) {
  if (CHAR_NAMES[cp]) return CHAR_NAMES[cp];
  if (cp >= 0xFE00 && cp <= 0xFE0F) return `VARIATION SELECTOR-${cp - 0xFE00 + 1}` + (cp === 0xFE0F ? ' (emoji style — normal after emoji)' : '');
  if (cp >= 0xE0100 && cp <= 0xE01EF) return `VARIATION SELECTOR-${cp - 0xE0100 + 17}`;
  if (cp >= 0xE0020 && cp <= 0xE007E) return `TAG ${JSON.stringify(String.fromCharCode(cp - 0xE0000))} (invisible copy of an ASCII character)`;
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'TAG CHARACTER';
  if (cp < 0x20 || (cp >= 0x80 && cp <= 0x9F)) return 'CONTROL CHARACTER';
  if ((cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) return 'PRIVATE USE CHARACTER';
  if (cp >= 0x1D173 && cp <= 0x1D17A) return 'MUSICAL FORMATTING CHARACTER';
  const kind = charKind(cp);
  if (kind === 'unassigned') return 'UNASSIGNED';
  if (kind === 'zero') return 'FORMAT CHARACTER';
  return 'NONCHARACTER';
}

const uPlus = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

const ESCAPE_MEANINGS = {
  '\\': 'a backslash', '*': 'an asterisk (not bold/italic)', '_': 'an underscore (not bold/italic)',
  '#': 'a # (not a heading)', '`': 'a backtick (not code)', '[': 'a [ (not a link)', ']': 'a ] (not a link)',
  '(': 'a (', ')': 'a )', '!': 'an ! (not an image)', '<': 'a < (not HTML)', '>': 'a > (not a quote)',
  '|': 'a | (not a table border)', '-': 'a - (not a bullet or rule)', '+': 'a + (not a bullet)',
  '.': 'a . (not a numbered list)', '$': 'a $ (not math)', '~': 'a ~ (not strikethrough)',
  '{': 'a {', '}': 'a }', '"': 'a "', "'": "a '", ':': 'a :', '=': 'an = (not a heading underline)'
};

// Emoji are built from invisible pieces: VS-16 (U+FE0F) makes ✔ draw as ✔\uFE0F, and zero-width
// joiners glue 👨 + 👩 + 👧 into one family emoji. Those are normal, not hidden tricks.
const PICTO = /\p{Extended_Pictographic}/u;
const BLACK_FLAG = String.fromCodePoint(0x1F3F4);
function partOfEmoji(chars, i) {
  const cp = chars[i].codePointAt(0), prev = chars[i - 1], next = chars[i + 1];
  if (cp === 0xFE0E || cp === 0xFE0F) return !!prev && (PICTO.test(prev) || /[0-9#*]/.test(prev));
  if (cp === 0x200D) return !!prev && !!next && (PICTO.test(prev) || prev.codePointAt(0) === 0xFE0F || /\p{Emoji_Modifier}/u.test(prev)) && PICTO.test(next);
  if (cp >= 0xE0020 && cp <= 0xE007F) {
    // Tag characters only belong in subdivision flags (black flag + tags, e.g. Scotland); elsewhere they hide text.
    let j = i - 1;
    while (j >= 0 && chars[j].codePointAt(0) >= 0xE0020 && chars[j].codePointAt(0) <= 0xE007F) j--;
    return chars[j] === BLACK_FLAG;
  }
  return false;
}

function inspectCharacters(text, info) {
  // ---- every character, with its line number
  const found = new Map();      // cp -> { kind, count, lines:Set }
  let line = 1, crlf = 0, lf = 0, cr = 0, nonAscii = 0, total = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], cp = ch.codePointAt(0);
    total++;
    if (cp === 0x0D) { if (chars[i + 1] === '\n') { crlf++; i++; total++; } else cr++; line++; continue; }
    if (cp === 0x0A) { lf++; line++; continue; }
    if (cp > 0x7F) nonAscii++;
    const kind = charKind(cp);
    if (!kind) continue;
    const e = found.get(cp) || { cp, kind, count: 0, benign: 0, lines: new Set() };
    e.count++; e.lines.add(line);
    if (partOfEmoji(chars, i)) e.benign++;
    found.set(cp, e);
  }
  const lineCount = text === '' ? 0 : line - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);

  // ---- Markdown backslash escapes and HTML entities, as the parser actually reads them
  const escapes = new Map(), entities = new Map();
  const walk = tokens => {
    for (const t of tokens || []) {
      if (t.type === 'escape') { const k = t.raw; escapes.set(k, (escapes.get(k) || 0) + 1); }
      if (t.type === 'br' && t.raw.startsWith('\\')) escapes.set('\\⏎', (escapes.get('\\⏎') || 0) + 1);
      if ((t.type === 'text' && !t.tokens) || t.type === 'html') {
        for (const m of (t.type === 'html' ? t.raw : t.text).matchAll(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi)) {
          decoder.innerHTML = m[0];
          if (decoder.value !== m[0]) entities.set(m[0], (entities.get(m[0]) || 0) + 1);
        }
      }
      walk(t.tokens);
      if (t.items) walk(t.items);
      if (t.header) t.header.forEach(c => walk(c.tokens));
      if (t.rows) t.rows.forEach(r => r.forEach(c => walk(c.tokens)));
    }
  };
  const normalized = text.replace(/\r\n|\r/g, '\n');
  try { walk(md.lexer(normalized.replace(/^---\n[\s\S]*?\n---\n/, ''))); } catch (e) { console.warn(e); }

  // Line numbers for escapes/entities: where the sequence appears outside fenced code blocks.
  const srcLines = normalized.split('\n');
  const trailing = new Set();
  srcLines.forEach((l, i) => { if (/\S[ \t]+$/.test(l)) trailing.add(i + 1); });
  const inFence = []; let fence = null;
  srcLines.forEach((l, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) { inFence[i] = true; if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; }
    else if (m) { fence = m[1]; inFence[i] = true; }
  });
  const linesOf = seq => {
    const out = new Set();
    srcLines.forEach((l, i) => {
      if (inFence[i]) return;
      if (seq === '\\⏎' ? /\\$/.test(l) : l.includes(seq)) out.add(i + 1);
    });
    return out;
  };

  const placeholders = findPlaceholders(srcLines, inFence);

  const zeroWidth = [...found.values()].filter(e => e.kind === 'zero');
  const hidden = [...found.values()].filter(e => e.kind !== 'zero');
  const warnings = [...found.values()].filter(e => CHAR_KINDS[e.kind].warn).reduce((s, e) => s + e.count - e.benign, 0);
  const endings = [crlf && 'CRLF (Windows)', lf && 'LF (Unix/macOS)', cr && 'CR (old Mac)'].filter(Boolean);

  return {
    info: info || { bytes: 0, bom: '?', name: 'unknown' },
    total, nonAscii, lineCount, crlf, lf, cr, endings,
    finalNewline: /(\r\n|\r|\n)$/.test(text),
    escapes: [...escapes].map(([seq, count]) => ({ seq, count, lines: linesOf(seq) })),
    entities: [...entities].map(([seq, count]) => { decoder.innerHTML = seq; return { seq, shows: decoder.value, count, lines: linesOf(seq) }; }),
    zeroWidth, hidden, trailing, warnings, placeholders
  };
}

// Leftover template text: to-do markers, {{tags}}, [Insert …] prompts, lorem ipsum… Checked in the
// Markdown source outside code blocks and inline `code` (where template syntax is usually intended).
// Patterns are tried in this order; a later one never re-reports text an earlier one already found.
const PLACEHOLDER_PATTERNS = [
  { kind: 'To-do marker', re: /\b(?:TODO|FIXME|TBD|TBC|TBA|XXX|HACK)\b/g },
  { kind: 'Template tag', re: /\{\{[^{}\n]{0,80}\}\}|\{%[^\n]{0,80}?%\}|<%[^\n]{0,80}?%>/g },
  { kind: 'Template variable', re: /\$\{[A-Za-z_][\w.]{0,40}\}(?!\$)/g },
  { kind: 'Fill-in prompt', ref: true, re: /(?<!\])\[(?:insert|add|enter|your|put|fill[ -]?in|replace|todo|tbd|placeholder|name|full name|date|title|company|organi[sz]ation|author|link|url|e-?mail|address|phone|image|figure|citation|ref|reference|source|number|amount|description)\b[^\]\n]{0,60}\](?![(\[:])/gi },
  { kind: 'Fill-in prompt', re: /<(?:your|insert|placeholder|project[-_ ]?name|user[-_ ]?name|username|e-?mail|password|token|api[-_ ]?key|version|description|value|repo(?:sitory)?[-_ ]?name|owner|org(?:anization)?)\b[^<>\n]{0,40}>/gi },
  { kind: '"…here" prompt', re: /\b(?:insert|add|put|paste|write|enter|type)\b[^.\n]{0,40}?\bhere\b/gi },
  { kind: 'Filler text', re: /\blorem ipsum\b|\bdolor sit amet\b/gi },
  { kind: 'Question-mark placeholder', re: /\?{3,}/g },
  { kind: 'Empty link', re: /\[[^\]\n]*\]\(\s*#?\s*\)/g },
  { kind: 'Date-format placeholder', re: /\b(?:YYYY-MM-DD|MM\/DD\/YYYY|DD\/MM\/YYYY|DD\.MM\.YYYY)\b/g }
];

function findPlaceholders(srcLines, inFence) {
  const groups = new Map();          // kind + text -> { kind, text, count, lines }
  // Reference-link labels defined in the document ([id]: url) are links, not prompts.
  const refIds = new Set();
  srcLines.forEach((l, i) => { const m = !inFence[i] && /^\s{0,3}\[([^\]]+)\]:/.exec(l); if (m) refIds.add(m[1].trim().toLowerCase()); });
  srcLines.forEach((line, i) => {
    if (inFence[i]) return;
    // Blank out inline code spans (same length, so positions still line up).
    const text = line.replace(/(`+)[^`]*?\1/g, m => ' '.repeat(m.length));
    const taken = [];                // [start, end) already reported on this line
    for (const { kind, re, ref } of PLACEHOLDER_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const s = m.index, e = s + m[0].length;
        if (ref && refIds.has(m[0].slice(1, -1).trim().toLowerCase())) continue;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        taken.push([s, e]);
        const shown = m[0].trim();
        const k = kind + '|' + shown.toLowerCase();
        const g = groups.get(k) || { kind, text: shown, count: 0, lines: new Set(), inComment: 0 };
        g.count++; g.lines.add(i + 1);
        // Inside an HTML comment on this line: not shown on the page, but still left in the file.
        const before = line.slice(0, s), after = line.slice(e);
        if (before.lastIndexOf('<!--') > before.lastIndexOf('-->') && after.includes('-->')) g.inComment++;
        groups.set(k, g);
      }
    }
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

function showInspection() {
  const r = lastInspection;
  if (!r) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const lineList = set => {
    const all = [...set].sort((a, b) => a - b);
    return all.length > 12 ? `${all.slice(0, 12).join(', ')} … +${all.length - 12} more` : all.join(', ');
  };
  const table = (headers, rows, empty) => {
    if (!rows.length) return el('p', 'ins-none', '✓ ' + empty);
    const t = el('table', 'ins-table');
    const hr = el('tr');
    headers.forEach((h, i) => hr.append(el('th', i && h !== 'Lines' ? 'n' : '', h)));
    t.append(el('thead'), el('tbody'));
    t.tHead.append(hr);
    for (const cells of rows) {
      const tr = el('tr');
      cells.forEach(c => tr.append(typeof c === 'object' ? c : el('td', '', c)));
      t.tBodies[0].append(tr);
    }
    const wrap = el('div', 'ins-wrap');
    wrap.append(t);
    return wrap;
  };
  const code = text => { const td = el('td'); td.append(el('code', '', text)); return td; };
  const num = n => el('td', 'n', fmt(n));
  const section = (title, ...content) => { const s = el('section', 'ins-section'); s.append(el('h3', '', title), ...content); return s; };

  // Encoding
  const info = r.info;
  const dl = el('dl', 'ins-dl');
  const add = (k, v, cls) => dl.append(el('dt', '', k), el('dd', cls || '', v));
  add('Encoding', info.name);
  add('Byte-order mark (BOM)', info.bom);
  if (/UTF-(16|32)/.test(info.name)) add('Valid UTF-8', 'not applicable (UTF-16/32 file)');
  else add('Valid UTF-8', info.validUtf8 ? 'yes' : 'no', info.validUtf8 ? '' : 'bad');
  add('File size', `${fmt(info.bytes)} bytes` + (info.bytes >= 1024 ? ` (${(info.bytes / 1024).toFixed(1)} KB)` : ''));
  add('Characters', `${fmt(r.total)} (${fmt(r.nonAscii)} non-ASCII)`);
  add('Lines', fmt(r.lineCount));
  add('Line endings', r.endings.length
    ? [r.crlf && `CRLF ×${fmt(r.crlf)}`, r.lf && `LF ×${fmt(r.lf)}`, r.cr && `CR ×${fmt(r.cr)}`].filter(Boolean).join(', ') +
      (r.endings.length > 1 ? ' — mixed line endings' : ` — ${r.endings[0]}`)
    : 'none (single line)', r.endings.length > 1 ? 'bad' : '');
  add('Ends with a line break', r.finalNewline ? 'yes' : 'no');
  if (info.note) add('Note', info.note, 'bad');

  // Escapes, entities, zero-width, hidden
  const escRows = r.escapes.sort((a, b) => b.count - a.count).map(e => {
    const ch = e.seq === '\\⏎' ? null : e.seq.slice(1);
    return [code(e.seq), e.seq === '\\⏎' ? 'backslash at end of line: a hard line break' : `shows ${ESCAPE_MEANINGS[ch] || `"${ch}"`}`, num(e.count), lineList(e.lines)];
  });
  const entRows = r.entities.sort((a, b) => b.count - a.count).map(e => [code(e.seq), `shows “${e.shows}”`, num(e.count), lineList(e.lines)]);
  const charRows = list => list.sort((a, b) => b.count - a.count).map(e =>
    [code(uPlus(e.cp)),
     `${charName(e.cp)} — ${CHAR_KINDS[e.kind].label}` +
       (e.benign ? ` · ${e.benign === e.count ? 'all' : fmt(e.benign)} inside emoji (normal, not a warning)` : ''),
     num(e.count), lineList(e.lines)]);
  const controls = r.hidden.filter(e => e.kind === 'control');

  const body = document.getElementById('insBody');
  body.replaceChildren(
    section('Encoding', dl),
    section('Escapes',
      el('h4', '', 'Markdown backslash escapes'),
      table(['Escape', 'Meaning', 'Count', 'Lines'], escRows, 'No backslash escapes.'),
      el('h4', '', 'HTML entities (character references)'),
      table(['Entity', 'Meaning', 'Count', 'Lines'], entRows, 'No HTML entities.'),
      el('h4', '', 'Control / escape characters (ESC, NUL, BEL…)'),
      table(['Code', 'Character', 'Count', 'Lines'], charRows(controls), 'No control characters.')),
    section('Zero-width characters',
      table(['Code', 'Character', 'Count', 'Lines'], charRows(r.zeroWidth), 'No zero-width characters.')),
    section('Other hidden & unusual characters',
      table(['Code', 'Character', 'Count', 'Lines'], charRows(r.hidden.filter(e => e.kind !== 'control')), 'No hidden or unusual characters.'),
      el('h4', '', 'Trailing spaces / tabs at the end of lines'),
      r.trailing.size
        ? el('p', '', `${fmt(r.trailing.size)} line(s): ${lineList(r.trailing)}. (Two trailing spaces are a deliberate Markdown line break; others are usually leftovers.)`)
        : el('p', 'ins-none', '✓ No trailing spaces.')),
    section('Placeholder text',
      el('p', 'ins-note', 'Leftover template text in the Markdown source (code blocks and inline code are skipped).'),
      table(['Text', 'Kind', 'Count', 'Lines', ''], r.placeholders.map(p => {
        const find = el('td');
        const b = el('button', 'find-btn', 'Find');
        const allHidden = p.inComment === p.count;
        b.title = allHidden ? 'Inside an HTML comment — not shown on the page' : 'Show it in the document';
        b.disabled = allHidden;
        b.addEventListener('click', () => {
          document.getElementById('inspect').close();
          openFind();
          if (replaceMode) setReplaceMode(false);
          findOpts.regex.checked = false; findOpts.word.checked = false; findOpts.case.checked = true;
          findInput.value = p.text;
          runFind(false);
        });
        find.append(b);
        const note = !p.inComment ? '' : p.inComment === p.count ? ' (in an HTML comment, not shown)' : ` (${fmt(p.inComment)} in HTML comments, not shown)`;
        return [code(p.text), p.kind + note, num(p.count), lineList(p.lines), find];
      }), 'No placeholder text found.')));

  const status = document.getElementById('insStatus');
  const holders = r.placeholders.reduce((s, p) => s + p.count, 0);
  status.className = 'bd-status ' + (r.warnings || holders ? 'warn' : 'ok');
  status.textContent = [
    r.warnings ? `⚠ ${fmt(r.warnings)} invisible or unusual character(s) that could hide or change text.`
               : '✓ No invisible characters that could hide or change text.',
    holders ? `⚠ ${fmt(holders)} leftover placeholder text(s) — see “Placeholder text” below.` : '✓ No placeholder text.'
  ].join('  ');
  document.getElementById('insFile').textContent = currentPath;
  document.getElementById('inspect').showModal();
}
document.getElementById('insClose').addEventListener('click', () => document.getElementById('inspect').close());
document.getElementById('insHighlight').addEventListener('click', () => {
  if (loadPrefLive('hiddenchars') !== 'on') toggleHidden();
  document.getElementById('inspect').close();
});

// ---------------------------------------------------------------- safety check
// Is this Markdown file safe? Looks for tricks aimed at the reader, at AI assistants, or at other apps
// that may open the file next (GitHub, VS Code, browsers). Active content is already removed here before
// display; the check says that it was there. Nothing in the file is run: it is parsed into an inert
// document (scripts never execute, pictures never load) only to be looked at.

// What is checked, in the order the report lists it.
const SAFETY_CHECKS = [
  'Scripts and other active content',
  'Links and addresses that run code or open Windows features',
  'Links whose text shows a different address',
  'Look-alike web addresses',
  'Links to programs and scripts',
  'Shortened, numeric or unencrypted links',
  'Windows network-share links',
  'Web pictures and tracking pixels',
  'Hidden text',
  'Instructions aimed at AI assistants',
  'Commands that download and run code',
  'Text-direction tricks (Trojan Source)',
  'Look-alike letters',
  'Math and diagram commands',
  'Size and nesting'
];

const RISKY_FILE = /\.(exe|msi|msix|appx|appxbundle|bat|cmd|com|scr|pif|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|dll|cpl|ocx|sys|jar|reg|inf|iso|img|vhd|vhdx|docm|xlsm|pptm|dotm|xlam|apk|dmg|pkg|deb|rpm|sh|run|application|appref-ms|library-ms|search-ms|searchconnector-ms|settingcontent-ms|diagcab|msc|chm)$/i;
// Endings that make link text look like a web address (not file names such as highlight.js or README.md).
const WEB_TLDS = /\.(com|net|org|gov|edu|mil|int|info|biz|io|co|ai|app|dev|me|us|uk|ca|au|de|fr|nl|it|es|ru|cn|jp|kr|in|br|sa|ae|eg|qa|kw|xyz|online|site|shop|store|tech|cloud|ly|gl|gg|tv|cc|ws|mobi|pro|name|link|live|bank|pay|support|help|login|secure|account)$/i;
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|rb\.gy|cutt\.ly|shorturl\.at|tiny\.cc|buff\.ly|rebrand\.ly|s\.id|t\.ly|lnkd\.in|v\.gd|qr\.ae|bl\.ink|shorte\.st|adf\.ly)$/i;

// [pattern, what it does, level]
const RISKY_COMMANDS = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i, 'downloads a script and runs it straight away (… | sh)', 'caution'],
  [/\b(iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+(system\.)?net\.webclient)\b[^\n]*\|\s*(iex|invoke-expression)\b/i, 'downloads a PowerShell script and runs it straight away (… | iex)', 'caution'],
  [/\b(iex|invoke-expression)\s*[(\s]\s*[(\s]*(new-object|\[|irm|iwr|invoke-)/i, 'runs downloaded or built-up text as PowerShell code (Invoke-Expression)', 'caution'],
  [/\s-(e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{24,}/i, 'runs a hidden, base64-encoded PowerShell command', 'risk'],
  [/\bbase64\s+(-d|--decode|-D)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, 'decodes hidden text and runs it as a script', 'risk'],
  [/\bmshta(\.exe)?\s+["']?(https?:|vbscript:|javascript:)/i, 'runs a web page as a program (mshta)', 'risk'],
  [/\bcertutil(\.exe)?\b[^\n]*-urlcache/i, 'downloads a file with certutil (a common malware trick)', 'risk'],
  [/\bbitsadmin(\.exe)?\b[^\n]*\/transfer/i, 'downloads a file in the background with bitsadmin', 'caution'],
  [/\b(regsvr32|rundll32)(\.exe)?\b[^\n]*(https?:|\\\\)/i, 'loads code from the network with regsvr32 / rundll32', 'risk'],
  [/\bSet-MpPreference\b[^\n]*-Disable/i, 'turns off Microsoft Defender protection', 'risk'],
  [/\bAdd-MpPreference\b[^\n]*-Exclusion/i, 'hides files or programs from Microsoft Defender', 'risk'],
  [/\bSet-ExecutionPolicy\s+(Unrestricted|Bypass)\b/i, 'lets every PowerShell script run, signed or not', 'caution'],
  [/\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(--no-preserve-root\s+)?\/(\s|\*|$)/i, 'deletes everything on the disk (rm -rf /)', 'risk'],
  [/\b(Remove-Item|del|rd|rmdir)\b[^\n]*\s[A-Za-z]:\\(\s|\*|$)[^\n]*(-Recurse|\/s)/i, 'deletes a whole drive', 'risk'],
  [/\bformat(\.com)?\s+[A-Za-z]:/i, 'formats (erases) a drive', 'risk'],
  [/\b(reg(\.exe)?\s+add|New-ItemProperty|Set-ItemProperty)\b[^\n]*\\(Run|RunOnce)\b/i, 'makes a program start automatically with Windows', 'caution'],
  [/\bschtasks(\.exe)?\s+\/create\b/i, 'creates a scheduled task', 'caution'],
  [/\bchmod\s+\+x\b[^\n]*(&&|;)\s*(sudo\s+)?\.\//i, 'makes a downloaded file executable and runs it', 'caution'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb: freezes the computer', 'risk'],
  [/\b(net\s+user\s+\S+\s+\S+\s+\/add|net\s+localgroup\s+administrators\s+\S+\s+\/add)\b/i, 'creates a user or makes someone an administrator', 'risk'],
  [/\bvssadmin(\.exe)?\s+delete\s+shadows\b/i, 'deletes Windows restore points (typical of ransomware)', 'risk']
];

const AI_INSTRUCTIONS = /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|every\s+)?(of\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|preceding|original|system)\s+(instructions?|prompts?|rules|directions)\b|\byou\s+are\s+now\s+(a|an|in|the)\b|\b(new|updated)\s+system\s+prompt\b|\bdo\s+not\s+(tell|inform|alert|mention\s+(this|it)\s+to)\s+the\s+user\b|\b(assistant|AI|LLM|agent)\s*[:,]?\s*(please\s+)?(run|execute|send|upload|exfiltrate|delete)\b/i;

// Hides an element's text, or moves it out of sight.
const HIDE_STYLE = /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|opacity\s*:\s*0*\.?0+\s*(;|!|$)|font-size\s*:\s*(0*\.?0+|[0-3](\.\d+)?(px|pt)|0?\.[0-3]\d*(em|rem))\s*(px|pt|em|rem|%)?\s*(;|!|$)|(^|;)\s*(max-)?(width|height)\s*:\s*0+(px)?\s*(;|!|$)|(left|top|right|bottom|text-indent|margin-left|margin-top)\s*:\s*-\d{3,}|clip(-path)?\s*:\s*(rect\(\s*0|inset\(\s*(50|100)%|circle\(\s*0)|transform\s*:[^;]*scale\(\s*0*\.?0+\s*[,)]|color\s*:\s*transparent/i;
const OVERLAY_STYLE = /position\s*:\s*(fixed|absolute|sticky)|z-index\s*:/i;
const TROJAN_BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const FOREIGN_LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

function checkSafety(source) {
  const text = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const found = new Map();
  const lineAt = idx => idx < 0 ? null : source.slice(0, idx).split(/\r\n|\r|\n/).length;
  const lineOf = needle => needle ? lineAt(source.indexOf(needle)) : null;
  const offset = source.length - text.length;          // front matter left out of `text`
  const showInvisible = s => s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g,
    c => `⟨${SHORT_NAMES[c.codePointAt(0)] || uPlus(c.codePointAt(0))}⟩`);
  const clip = s => { s = showInvisible(String(s).replace(/\s+/g, ' ').trim()); return s.length > 160 ? s.slice(0, 160) + '…' : s; };
  const add = (check, id, level, title, why, what, line, blocked = false) => {
    let f = found.get(id);
    if (!f) found.set(id, f = { check, id, level, title, why, blocked, items: [], count: 0 });
    f.count++;
    if (f.items.length < 25) f.items.push({ what: clip(what), line });
  };
  const readable = s => { try { return decodeURI(s); } catch { return s; } };
  const host = h => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const site = h => {
    const parts = host(h).split('.');
    return parts.slice(parts.length > 2 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? -3 : -2).join('.');
  };

  let doc = null;
  try { doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${md.parse(text)}`, 'text/html'); } catch (e) { console.warn('Safety:', e); }

  if (doc) {
    const ACTIVE = {
      script: 'script', noscript: 'script', iframe: 'embedded page (iframe)', frame: 'embedded page (frame)',
      frameset: 'embedded page (frameset)', object: 'embedded object / plugin', embed: 'embedded object / plugin',
      applet: 'Java applet', form: 'form (can send what you type to a server)', meta: 'meta tag (can redirect the page)',
      base: 'base address (silently changes where every link goes)', link: 'linked style sheet or resource',
      portal: 'embedded page (portal)', handler: 'SVG script handler', listener: 'SVG script listener',
      foreignobject: 'HTML hidden inside a picture (SVG foreignObject)', animate: 'SVG animation (can change links)',
      set: 'SVG animation (can change links)', animatemotion: 'SVG animation', animatetransform: 'SVG animation',
      textarea: 'text box', select: 'drop-down list', button: 'button', template: 'template'
    };
    const flagged = new Set();
    let maxDepth = 0;

    for (const el of doc.body.querySelectorAll('*')) {
      if (el.closest('.katex, .katex-display')) continue;
      const tag = el.localName.toLowerCase();
      const outer = () => el.outerHTML.slice(0, 160);
      const where = () => lineOf(`<${el.localName}`);

      if (ACTIVE[tag] || (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() !== 'checkbox') || tag === 'style') {
        if (tag === 'style') add(SAFETY_CHECKS[0], 'stylesheet', 'caution', 'Style sheet',
          'A <style> block can restyle the whole page in other viewers — hide text, fake buttons or cover the real content. Removed here.', outer(), where(), true);
        else add(SAFETY_CHECKS[0], 'active', 'risk', 'Scripts or other active content',
          'Code, embedded pages, plugins or forms. They are removed here before display, but a browser or another Markdown viewer may run them.',
          `${ACTIVE[tag] || 'form field'}: ${outer()}`, where(), true);
      }

      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase(), value = attr.value;
        if (name.startsWith('on')) {
          add(SAFETY_CHECKS[0], 'handlers', 'risk', 'Event handlers (code that runs on click, hover or load)',
            'Attributes such as onclick or onerror run code. Removed here; other viewers may run them.', `${name}="${value}"`, lineOf(attr.name + '=') || where(), true);
          continue;
        }
        if (name === 'srcdoc') {
          add(SAFETY_CHECKS[0], 'active', 'risk', 'Scripts or other active content', '', `srcdoc on <${tag}>`, where(), true);
          continue;
        }
        if (!['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'srcset', 'ping', 'cite', 'longdesc'].includes(name)) continue;
        const urls = name === 'srcset' ? value.split(',').map(p => p.trim().split(/\s+/)[0]) : [value];
        for (const u of urls) {
          const s = scheme(u);
          if (['javascript', 'vbscript', 'livescript'].includes(s) || (s === 'data' && !SAFE_IMG_DATA.test(u.trim()))) {
            add(SAFETY_CHECKS[1], 'codelink', 'risk', 'Links or addresses that run code (javascript:, data:)',
              'Clicking such a link runs code in a browser or another viewer. Removed here.', u, lineOf(u.slice(0, 40)), true);
          } else if (s && !['http', 'https', 'mailto', 'data'].includes(s)) {
            add(SAFETY_CHECKS[1], 'scheme', 'risk', 'Links that open Windows features, programs or local files',
              'Addresses such as file:, ms-…:, search-ms: or other app protocols can open programs, search remote folders or run Windows tools without a browser. Removed here.',
              u, lineOf(u.slice(0, 40)), true);
          }
          if (/^\\\\[^\\]/.test(u.trim()) || /^file:\/\/[^/]/i.test(u.trim()))
            add(SAFETY_CHECKS[6], 'unc', 'risk', 'Links or pictures on Windows network shares',
              'Opening a \\\\server\\share address can make Windows send your sign-in (NTLM) to that server — even just showing a picture from it in some apps. Not opened here.',
              u, lineOf(u.slice(0, 40)));
          if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(u))
            add(SAFETY_CHECKS[3], 'zwlink', 'risk', 'Invisible characters inside a link address',
              'The address contains characters you cannot see, so it is not what it looks like.', u, lineOf(u.slice(0, 20)));
        }
      }

      // Hidden text: hidden from the reader but still read by AI tools, search, copy & paste…
      const style = el.getAttribute('style') || '';
      const hides = el.hasAttribute('hidden') || HIDE_STYLE.test(style);
      const styleLine = () => (el.textContent.trim() && lineOf(el.textContent.trim().slice(0, 30))) || (style && lineOf(style)) || where();
      if (hides && ![...flagged].some(f => f.contains(el))) {
        const hiddenText = el.textContent.trim();
        if (hiddenText || el.querySelector('a, img')) {
          flagged.add(el);
          const what = `${el.hasAttribute('hidden') ? 'hidden' : `style="${style}"`}: ${hiddenText || '(link or picture)'}`;
          if (el.closest('pre, code')) {
            add(SAFETY_CHECKS[8], 'copytrap', 'risk', 'Hidden text inside code (copy-paste trap)',
              'Text you cannot see sits inside a code example: what you copy and paste is not what you read. Shown openly here.', what, styleLine());
          } else if (AI_INSTRUCTIONS.test(hiddenText)) {
            add(SAFETY_CHECKS[9], 'aihidden', 'risk', 'Hidden instructions for AI assistants',
              'Invisible text that tries to give orders to an AI tool that reads this file (prompt injection).', what, styleLine());
          } else {
            add(SAFETY_CHECKS[8], 'hidden', 'caution', 'Hidden text',
              'Text that is in the file but made invisible. It is still read by AI tools and search, and may be copied with the visible text.', what, styleLine());
          }
        }
      }
      if (OVERLAY_STYLE.test(style))
        add(SAFETY_CHECKS[8], 'overlay', 'caution', 'Content placed over other content',
          'position or z-index can lay fake buttons or text over the real content in other viewers. Here it stays inside the document area.', `style="${style}"`, styleLine());
      const cssUrl = /url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/i.exec(style);
      if (cssUrl) add(SAFETY_CHECKS[7], 'webmedia', 'note', 'Web pictures (not loaded here)',
        'Other viewers load these from the internet, which tells the server that the file was opened. This viewer never loads them.', cssUrl[1], lineOf(cssUrl[1]));

      // Web pictures and tracking pixels.
      if (['img', 'video', 'audio', 'source', 'image', 'input'].includes(tag)) {
        const srcs = [el.getAttribute('src'), el.getAttribute('poster'), el.getAttribute('href'), el.getAttribute('xlink:href'),
                      ...(el.getAttribute('srcset') || '').split(',').map(p => p.trim().split(/\s+/)[0])].filter(Boolean);
        for (const src of srcs.filter(isWeb)) {
          const w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
          if ((w <= 2 || h <= 2) || /(width|height)\s*:\s*[0-2](px)?\s*(;|$)/i.test(style))
            add(SAFETY_CHECKS[7], 'pixel', 'caution', 'Tracking pixels',
              'Tiny web pictures that exist only to report when, where and how often the file is opened. Not loaded here.', src, lineOf(src));
          else add(SAFETY_CHECKS[7], 'webmedia', 'note', 'Web pictures (not loaded here)',
            'Other viewers load these from the internet, which tells the server that the file was opened. This viewer never loads them.', src, lineOf(src));
        }
      }

      let depth = 0;
      for (let p = el; p && p !== doc.body; p = p.parentElement) depth++;
      if (depth > maxDepth) maxDepth = depth;
    }

    // Links.
    for (const a of doc.body.querySelectorAll('a[href], area[href]')) {
      const href = a.getAttribute('href').trim();
      const shown = a.textContent.trim();
      const line = lineOf(href) || lineOf(shown);
      let u = null;
      try { if (/^(https?:)?\/\//i.test(href)) u = new URL(href, 'https://document.invalid/'); } catch { }
      if (u) {
        const h = host(u.hostname);
        // Text that looks like an address, but the link goes somewhere else.
        const t = /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})(?::\d+)?(?:[/?#]\S*)?$/u.exec(shown);
        if (t && (/^(https?:\/\/|www\.)/i.test(shown) || WEB_TLDS.test(t[1]))) {
          let th = '';
          try { th = host(new URL('https://' + t[1]).hostname); } catch { }
          if (th && site(th) !== site(h))
            add(SAFETY_CHECKS[2], 'mismatch', 'risk', 'Links whose text shows a different address',
              'The link shows one web address but takes you to another — a classic phishing trick. This viewer always shows the real address before opening a link.',
              `shows “${shown}” but goes to ${u.href}`, line);
        }
        if (u.hostname.includes('xn--') || /[^\x00-\x7F]/.test(href.split(/[/?#]/)[2] || ''))
          add(SAFETY_CHECKS[3], 'idn', 'risk', 'Look-alike web addresses',
            'The address uses letters from other alphabets that look like ordinary letters (e.g. Cyrillic “а” in “pаypal.com”).',
            `${readable(href)} → really ${u.hostname}`, line);
        if (u.username || u.password)
          add(SAFETY_CHECKS[3], 'userinfo', 'risk', 'Addresses with a hidden real site after “@”',
            'In https://trusted.com@other.site the part before “@” is only a user name; the link really goes to the site after it.',
            `${href} → really ${u.hostname}`, line);
        if (RISKY_FILE.test(decodeURIComponent(u.pathname)))
          add(SAFETY_CHECKS[4], 'program', 'risk', 'Links that download programs or scripts',
            'The link points at a file that can run code on your computer (.exe, .ps1, .bat, .msi, .lnk, Office files with macros…).', href, line);
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith('['))
          add(SAFETY_CHECKS[5], 'ip', 'caution', 'Links to a numeric (IP) address',
            'Real sites rarely use a bare number as their address; it hides who runs the server.', href, line);
        if (SHORTENERS.test(h))
          add(SAFETY_CHECKS[5], 'short', 'caution', 'Shortened links',
            'A link shortener hides where the link really goes until you open it.', href, line);
        if (u.protocol === 'http:')
          add(SAFETY_CHECKS[5], 'http', 'note', 'Unencrypted (http:) links',
            'The connection is not encrypted, so the page can be read or changed on the way.', href, line);
      } else if (!href.startsWith('#') && !scheme(href) && RISKY_FILE.test(href.split(/[?#]/)[0])) {
        add(SAFETY_CHECKS[4], 'localprogram', 'caution', 'Links to programs or scripts next to the document',
          'The link points at a file that can run code. This viewer never opens it; other apps may.', href, line);
      }
      if (/^mailto:/i.test(href)) {
        const to = decodeURIComponent(href.slice(7).split('?')[0]).toLowerCase();
        if (/^\S+@\S+\.\S+$/.test(shown) && shown.toLowerCase() !== to)
          add(SAFETY_CHECKS[2], 'mismatch', 'risk', 'Links whose text shows a different address',
            'The link shows one address but goes to another.', `shows “${shown}” but writes to ${to}`, line);
      }
    }

    // Comments: invisible in every viewer.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
    for (let c = walker.nextNode(); c; c = walker.nextNode()) {
      const body = c.data.trim();
      if (body.length < 3 || /^(markdownlint|prettier|toc|end ?toc|vale|lint|cspell|textlint|omit in toc|no ?toc)\b/i.test(body)) continue;
      const line = lineOf(c.data.slice(0, 40));
      if (AI_INSTRUCTIONS.test(body))
        add(SAFETY_CHECKS[9], 'aihidden', 'risk', 'Hidden instructions for AI assistants',
          'Invisible text that tries to give orders to an AI tool that reads this file (prompt injection).', `<!-- ${body} -->`, line);
      else add(SAFETY_CHECKS[8], 'comment', 'note', 'Hidden comments',
        'HTML comments are not shown by any viewer, but AI tools and anyone reading the raw file see them.', `<!-- ${body} -->`, line);
    }

    // Visible text addressed to AI tools.
    const visible = doc.body.textContent;
    const ai = AI_INSTRUCTIONS.exec(visible);
    if (ai && !found.has('aihidden'))
      add(SAFETY_CHECKS[9], 'aivisible', 'caution', 'Text addressed to AI assistants',
        'Sentences that try to give orders to an AI tool reading the file (prompt injection).', visible.slice(Math.max(0, ai.index - 40), ai.index + 120), lineOf(ai[0]));

    // Commands people are invited to copy and run.
    for (const el of doc.body.querySelectorAll('pre, code')) {
      if (el.localName === 'code' && el.closest('pre')) continue;
      if (el.closest('pre.mermaid, .katex')) continue;
      const code = el.textContent;
      for (const [re, does, level] of RISKY_COMMANDS) {
        const m = re.exec(code);
        if (!m) continue;
        const lineText = code.slice(code.lastIndexOf('\n', m.index) + 1, (code.indexOf('\n', m.index) + 1 || code.length + 1) - 1);
        add(SAFETY_CHECKS[10], 'cmd-' + level, level,
          level === 'risk' ? 'Commands that can harm your computer' : 'Commands that download or change things — check before running',
          level === 'risk' ? 'Code examples that are typical of malware: running hidden code, turning off protection, or deleting data.'
                           : 'Code examples that run something from the internet or change Windows settings. Only run them if you trust the source.',
          `${does}: ${lineText}`, lineOf(m[0].slice(0, 30)));
      }
    }

    if (maxDepth > 100)
      add(SAFETY_CHECKS[14], 'deep', 'caution', 'Very deep nesting',
        `Elements nested ${fmt(maxDepth)} levels deep can make other viewers freeze or crash.`, `${fmt(maxDepth)} levels`, null);
  }

  // Text-direction tricks: the order you see is not the order of the characters.
  const srcLines = source.split(/\r\n|\r|\n/);
  srcLines.forEach((l, i) => {
    if (TROJAN_BIDI.test(l))
      add(SAFETY_CHECKS[11], 'bidi', 'risk', 'Text-direction tricks (Trojan Source)',
        'Direction-override characters make text show in a different order than it really is — e.g. “invoice⟨RLO⟩fdp.exe” is shown as “invoiceexe.pdf”. Turn on ¶ Hidden to see them.', l, i + 1);
    TROJAN_BIDI.lastIndex = 0;
  });

  // Look-alike letters: a word mixing Latin with Cyrillic/Greek letters that look the same.
  const seenWords = new Set();
  for (const m of text.matchAll(/[\p{L}\p{M}]{2,}/gu)) {
    const w = m[0];
    if (seenWords.has(w) || !/\p{Script=Latin}/u.test(w) || !FOREIGN_LOOKALIKE.test(w)) continue;
    seenWords.add(w);
    const odd = [...w].filter(ch => FOREIGN_LOOKALIKE.test(ch))
      .map(ch => `“${ch}” ${uPlus(ch.codePointAt(0))} ${/\p{Script=Cyrillic}/u.test(ch) ? 'Cyrillic' : /\p{Script=Greek}/u.test(ch) ? 'Greek' : 'other alphabet'}`);
    add(SAFETY_CHECKS[12], 'mixed', 'caution', 'Words mixing look-alike letters from other alphabets',
      'A word that looks ordinary but contains letters from another alphabet — used to dodge searches and filters or to fake names.',
      `${w} — ${[...new Set(odd)].join(', ')}`, lineOf(w));
  }

  // Math and diagram commands that would make links or load things (switched off here).
  for (const m of text.matchAll(/\\(href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\s*\{[^}\n]{0,120}\}?/g))
    add(SAFETY_CHECKS[13], 'mathcmd', 'note', 'Math commands that make links or load pictures',
      'KaTeX commands such as \\href and \\includegraphics. Switched off in this viewer.', m[0], lineAt(m.index + offset), true);
  for (const m of text.matchAll(/^(`{3,}|~{3,})\s*mermaid[^\n]*\n([\s\S]*?)^\1/gm)) {
    const block = m[2];
    const start = lineAt(m.index + offset) + 1;
    block.split('\n').forEach((l, i) => {
      if (/^\s*(click|callback)\s/i.test(l) || /%%\{\s*init/i.test(l) || /javascript:/i.test(l))
        add(SAFETY_CHECKS[13], 'diagramcmd', /javascript:/i.test(l) ? 'risk' : 'note', 'Diagram links, actions or settings',
          'Mermaid click actions, links and %%{init}%% settings. Switched off in this viewer (strict mode).', l, start + i, true);
    });
  }

  if (source.length > 5e6)
    add(SAFETY_CHECKS[14], 'size', 'note', 'Very large file', 'Big files can make other viewers slow.', `${fmt(source.length)} characters`, null);

  const order = { risk: 0, caution: 1, note: 2 };
  const findings = [...found.values()].sort((a, b) => order[a.level] - order[b.level]);
  const count = level => findings.filter(f => f.level === level).reduce((s, f) => s + f.count, 0);
  const counts = { risk: count('risk'), caution: count('caution'), note: count('note') };
  return { findings, counts, level: counts.risk ? 'risk' : counts.caution ? 'caution' : 'safe' };
}

let lastSafety = null;

function safetyButton() {
  if (!lastSafety || lastSafety.source !== currentSource) lastSafety = { source: currentSource, ...checkSafety(currentSource) };
  const r = lastSafety;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'breakdown-btn ' + (r.level === 'risk' ? 'bad' : r.level === 'caution' ? 'warn' : 'ok');
  btn.textContent = r.level === 'risk' ? `✗ Unsafe (${fmt(r.counts.risk)})`
                  : r.level === 'caution' ? `⚠ Safety (${fmt(r.counts.caution)})` : '✓ Safe';
  btn.title = (r.level === 'risk' ? 'This file contains tricks that can harm you or other apps'
             : r.level === 'caution' ? 'This file contains things to check before you trust it'
             : 'No tricks found in this file') + ' — click for the safety report';
  btn.addEventListener('click', showSafety);
  return btn;
}

function showSafety() {
  const r = lastSafety;
  if (!r) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const status = document.getElementById('sfStatus');
  const blockedRisks = r.findings.filter(f => f.level === 'risk' && f.blocked).length;
  status.className = 'bd-status ' + (r.level === 'risk' ? 'bad' : r.level === 'caution' ? 'warn' : 'ok');
  status.textContent = r.level === 'risk'
    ? `✗ Not safe — ${plural(r.counts.risk, 'risk')}` + (r.counts.caution ? ` and ${plural(r.counts.caution, 'caution')}` : '') +
      (blockedRisks ? '. Active content is removed in this viewer, but the file is dangerous in other apps.' : '. Read the items below before you trust this file.')
    : r.level === 'caution'
      ? `⚠ Use caution — ${plural(r.counts.caution, 'thing')} to check before you trust this file.`
      : '✓ Safe — no tricks found.' + (r.counts.note ? ` ${plural(r.counts.note, 'note')} below, for your information.` : '');

  const finding = f => {
    const box = el('div', `sf-finding ${f.level}`);
    const h = el('h4', '', `${f.title} (${fmt(f.count)})`);
    if (f.blocked) h.append(el('span', 'sf-tag', 'removed here'));
    box.append(h, el('p', 'sf-why', f.why));
    const t = el('table', 'ins-table sf-table');
    for (const it of f.items) {
      const tr = el('tr');
      const lineCell = el('td', 'n');
      if (it.line) {
        const go = el('button', 'sf-line', `line ${fmt(it.line)}`);
        go.type = 'button';
        go.title = 'Show this line in the Markdown source';
        go.addEventListener('click', () => { document.getElementById('safety').close(); showSourceLine(it.line); });
        lineCell.append(go);
      }
      tr.append(lineCell);
      const td = el('td');
      td.append(el('code', '', it.what));
      tr.append(td);
      t.append(tr);
    }
    const wrap = el('div', 'ins-wrap');
    wrap.append(t);
    box.append(wrap);
    if (f.count > f.items.length) box.append(el('p', 'ins-note', `… and ${fmt(f.count - f.items.length)} more`));
    return box;
  };
  const section = (title, list) => {
    if (!list.length) return null;
    const s = el('section', 'ins-section');
    s.append(el('h3', '', title), ...list.map(finding));
    return s;
  };
  const checked = el('section', 'ins-section');
  const ul = el('ul', 'sf-checks');
  for (const c of SAFETY_CHECKS) {
    const fs = r.findings.filter(f => f.check === c);
    const worst = fs.find(f => f.level === 'risk') ? 'risk' : fs.find(f => f.level === 'caution') ? 'caution' : fs.length ? 'note' : 'ok';
    ul.append(el('li', worst, `${{ risk: '✗', caution: '⚠', note: 'ℹ', ok: '✓' }[worst]} ${c}`));
  }
  checked.append(el('h3', '', 'What was checked'), ul,
    el('p', 'ins-note', 'Line numbers point into the Markdown file. Nothing in the file was run to check it.'));

  document.getElementById('sfBody').replaceChildren(...[
    section('Risks', r.findings.filter(f => f.level === 'risk')),
    section('Check before you trust it', r.findings.filter(f => f.level === 'caution')),
    section('For your information', r.findings.filter(f => f.level === 'note')),
    checked].filter(Boolean));
  document.getElementById('sfFile').textContent = currentPath;
  const dlg = document.getElementById('safety');
  dlg.showModal();
  dlg.scrollTop = 0;          // start at the verdict, not at the focused Close button
}
document.getElementById('sfClose').addEventListener('click', () => document.getElementById('safety').close());

// ---------------------------------------------------------------- blocked-code alert
// Code in a document never runs here (preview only). When a file contains code, the viewer says so
// once, when the file is opened. And if the window's security policy ever has to stop something, code
// got past the sanitizer: that is shown too, as a viewer bug to report.
const CODE_FINDINGS = new Set(['active', 'handlers', 'codelink', 'scheme']);

function showCodeAlert(text, items, policy) {
  const dlg = document.getElementById('codeAlert');
  document.getElementById('caTitle').textContent = policy
    ? '⚠ The security policy stopped code from running'
    : '⚠ This file contains code — it was blocked';
  document.getElementById('caFile').textContent = currentPath || '';
  document.getElementById('caText').textContent = text;
  document.getElementById('caList').replaceChildren(...items.map(t => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
  document.getElementById('caReport').hidden = !lastSafety;
  if (!dlg.open) dlg.showModal();
}

function alertBlockedCode() {
  if (!lastSafety || lastSafety.source !== currentSource) return;      // e.g. a table: nothing was parsed as Markdown
  const found = (lastSafety?.findings || [])
    .filter(f => CODE_FINDINGS.has(f.id) || (f.id === 'diagramcmd' && f.level === 'risk'));
  if (!found.length) return;
  showCodeAlert('Nothing in it ran here: the code was removed before the file was shown. ' +
    'In a browser or another Markdown viewer it could run, so be careful where else you open this file.',
    found.map(f => `${f.title} (${fmt(f.count)})`), false);
}

// The browser's own report when the security policy blocks something. Only code-related blocks count;
// eval inside the bundled libraries is not something a document can cause.
const CODE_DIRECTIVES = /^(script-src|script-src-elem|script-src-attr|object-src|frame-src|child-src|worker-src|form-action|base-uri)$/;
const policyBlocks = [];
document.addEventListener('securitypolicyviolation', e => {
  const directive = e.effectiveDirective || e.violatedDirective || '';
  if (!CODE_DIRECTIVES.test(directive) || /^(wasm-)?eval$/.test(e.blockedURI)) return;
  policyBlocks.push(`${directive}: ${e.blockedURI || 'code written into the page'}` +
                    (e.sample ? ` — “${e.sample.slice(0, 60)}”` : ''));
  showCodeAlert('The window refused to run it, so nothing happened. It should already have been removed ' +
    'before display, so this is a gap in the viewer worth reporting (with the file).', policyBlocks.slice(-8), true);
});

document.getElementById('caOk').addEventListener('click', () => document.getElementById('codeAlert').close());
document.getElementById('caReport').addEventListener('click', () => {
  document.getElementById('codeAlert').close();
  showSafety();
});

// ---------------------------------------------------------------- ¶ Hidden: show invisible characters in place
const SHORT_NAMES = {
  0x0000: 'NUL', 0x0007: 'BEL', 0x0008: 'BS', 0x0009: '→', 0x000B: 'VT', 0x000C: 'FF', 0x001B: 'ESC', 0x007F: 'DEL',
  0x0085: 'NEL', 0x00A0: 'NBSP', 0x00AD: 'SHY', 0x034F: 'CGJ', 0x061C: 'ALM', 0x180E: 'MVS', 0x1680: 'OGSP',
  0x2000: 'NQSP', 0x2001: 'MQSP', 0x2002: 'ENSP', 0x2003: 'EMSP', 0x2004: '3/MSP', 0x2005: '4/MSP', 0x2006: '6/MSP',
  0x2007: 'FIGSP', 0x2008: 'PUNCSP', 0x2009: 'THSP', 0x200A: 'HSP', 0x200B: 'ZWSP', 0x200C: 'ZWNJ', 0x200D: 'ZWJ',
  0x200E: 'LRM', 0x200F: 'RLM', 0x2028: 'LSEP', 0x2029: 'PSEP', 0x202A: 'LRE', 0x202B: 'RLE', 0x202C: 'PDF',
  0x202D: 'LRO', 0x202E: 'RLO', 0x202F: 'NNBSP', 0x205F: 'MMSP', 0x2060: 'WJ', 0x2061: 'FA', 0x2062: 'IT',
  0x2063: 'IS', 0x2064: 'IP', 0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI', 0x3000: 'IDSP',
  0xFFFC: 'OBJ', 0x2800: 'BRBL', 0x3164: 'HF', 0xFFA0: 'HWHF', 0x115F: 'HCF', 0x1160: 'HJF',
  0xFFF9: 'IAA', 0xFFFA: 'IAS', 0xFFFB: 'IAT', 0xE0001: 'LANG',
  0xFEFF: 'BOM', 0xFFFD: '�?'
};
const MORE_SHORT = { 0x206A: 'ISS', 0x206B: 'ASS', 0x206C: 'IAFS', 0x206D: 'AAFS', 0x206E: 'NADS', 0x206F: 'NODS',
  0x180B: 'FVS1', 0x180C: 'FVS2', 0x180D: 'FVS3', 0x180F: 'FVS4', 0xE007F: 'TAG-END' };
const shortName = cp => SHORT_NAMES[cp] || MORE_SHORT[cp] ||
  (cp >= 0xFE00 && cp <= 0xFE0F ? `VS${cp - 0xFE00 + 1}` : cp >= 0xE0100 && cp <= 0xE01EF ? `VS${cp - 0xE0100 + 17}` :
   // Tag characters mirror ASCII invisibly — show the hidden letter they carry.
   cp >= 0xE0020 && cp <= 0xE007E ? `TAG:${String.fromCharCode(cp - 0xE0000)}` : uPlus(cp));
// Shown in place of the character: it's invisible (or reorders text) anyway. Others keep the character and get a label.
const REPLACE_KINDS = new Set(['zero', 'bidi', 'control', 'separator', 'nonchar', 'placeholder', 'unassigned']);

let hiddenMarked = 0;
function markHiddenChars(root) {
  hiddenMarked = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest('.katex, svg, .hc') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const nodes = [];
  for (let n; (n = walker.nextNode());) nodes.push(n);
  for (const node of nodes) {
    const chars = [...node.data];
    if (!chars.some(c => charKind(c.codePointAt(0)))) continue;
    const frag = document.createDocumentFragment();
    let run = '';
    chars.forEach((ch, i) => {
      const cp = ch.codePointAt(0), kind = charKind(cp);
      if (!kind || partOfEmoji(chars, i)) { run += ch; return; }
      if (run) { frag.append(run); run = ''; }
      const wrap = document.createElement('span');
      wrap.className = `hc hc-${kind}` + (REPLACE_KINDS.has(kind) ? ' hc-hide' : ' hc-soft');
      wrap.title = `${uPlus(cp)} ${charName(cp)} — ${CHAR_KINDS[kind].label}`;
      const orig = document.createElement('span');
      orig.className = 'hc-orig';
      orig.textContent = ch;
      const badge = document.createElement('span');
      badge.className = 'hc-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = shortName(cp);
      // Text-direction controls: show the label where the control sits, before or after the character.
      wrap.append(badge, orig);
      frag.append(wrap);
      hiddenMarked++;
    });
    if (run) frag.append(run);
    node.replaceWith(frag);
  }
  updateHiddenButton();
}

const hiddenBtn = document.getElementById('hiddenBtn');
function updateHiddenButton() {
  const on = loadPrefLive('hiddenchars') === 'on';
  hiddenBtn.classList.toggle('on', on);
  hiddenBtn.textContent = on ? `¶ Hidden: ${fmt(hiddenMarked)}` : '¶ Hidden';
  hiddenBtn.title = (on ? 'Hide the labels' : 'Show invisible characters in the document') +
    ` — ${fmt(hiddenMarked)} found in the rendered text (Ctrl+Shift+H)`;
}
function toggleHidden() {
  const next = loadPrefLive('hiddenchars') === 'on' ? 'off' : 'on';
  setRootPref('hiddenchars', next);
  savePref('hiddenchars', next);
  updateHiddenButton();
}
hiddenBtn.addEventListener('click', toggleHidden);

// ---------------------------------------------------------------- 🔎 Find in document
// Matches are drawn with the browser's highlight layer (CSS Custom Highlight API), so the
// document itself is never changed — counts, the breakdown and ¶ Hidden are unaffected.
const findBar = document.getElementById('findBar');
const findInput = document.getElementById('findInput');
const findCount = document.getElementById('findCount');
const findBtn = document.getElementById('findBtn');
const findOpts = { case: document.getElementById('findCase'), word: document.getElementById('findWord'), regex: document.getElementById('findRegex') };
const canHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, figcaption, summary, div, table, tr';
let findMatches = [];      // Range objects
let findIndex = -1;

// The searchable text: visible text nodes in reading order, with a line break between blocks
// so a match never runs from one paragraph, list item or table cell into the next.
function searchIndex() {
  const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const el = n.parentElement;
      if (!n.data || el.closest('.katex, .hc-badge, script, style')) return NodeFilter.FILTER_REJECT;
      if (el.checkVisibility && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const parts = [];
  let text = '', lastBlock = null;
  for (let n; (n = walker.nextNode());) {
    const block = n.parentElement.closest(BLOCKS);
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    parts.push({ node: n, start: text.length });
    text += n.data;
  }
  return { text, parts };
}

function locate(parts, pos, isEnd) {
  // Last part starting at or before pos (for an end position, strictly before when on a boundary).
  let lo = 0, hi = parts.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parts[mid].start < pos || (!isEnd && parts[mid].start === pos)) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const p = parts[found];
  return { node: p.node, offset: Math.min(pos - p.start, p.node.data.length) };
}

function buildPattern(q) {
  let src = findOpts.regex.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (findOpts.word.checked) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, 'gu' + (findOpts.case.checked ? '' : 'i'));
}

function runFind(keepPosition) {
  const q = findInput.value;
  findMatches = [];
  findInput.classList.remove('invalid');
  if (!q || !currentPath) { renderFind(-1); return; }
  let re;
  try { re = buildPattern(q); }
  catch { findInput.classList.add('invalid'); findCount.textContent = 'Invalid pattern'; findCount.className = 'none'; clearFindHighlights(); return; }
  const { text, parts } = searchIndex();
  if (!parts.length) { renderFind(-1); return; }
  for (const m of text.matchAll(re)) {
    if (!m[0].length || m[0].includes('\n')) continue;
    const a = locate(parts, m.index, false), b = locate(parts, m.index + m[0].length, true);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    findMatches.push(range);
    if (findMatches.length >= 5000) break;
  }
  // Start at the first match below the top of the view (like a browser's find).
  let start = 0;
  if (!keepPosition) {
    const top = content.getBoundingClientRect().top;
    start = Math.max(0, findMatches.findIndex(r => r.getBoundingClientRect().bottom >= top));
  } else start = Math.min(Math.max(findIndex, 0), findMatches.length - 1);
  renderFind(findMatches.length ? start : -1, !keepPosition);
}

function clearFindHighlights() {
  if (canHighlight) { CSS.highlights.delete('find'); CSS.highlights.delete('find-current'); }
}

function renderFind(index, scroll = true) {
  findIndex = index;
  clearFindHighlights();
  if (replaceMode) updateSourceMatches();
  if (!findInput.value) { findCount.textContent = ''; findCount.className = ''; return; }
  if (replaceMode) {
    // Replace works on the Markdown source: the counter follows source matches; the page still shows highlights.
    if (canHighlight && findMatches.length) CSS.highlights.set('find', new Highlight(...findMatches));
    if (scroll && srcMatches.length === findMatches.length && findMatches[srcIndex]) scrollToRange(findMatches[srcIndex]);
    return;
  }
  if (!findMatches.length) { findCount.textContent = 'No results'; findCount.className = 'none'; return; }
  findCount.className = '';
  findCount.textContent = `${fmt(index + 1)} of ${fmt(findMatches.length)}${findMatches.length >= 5000 ? '+' : ''}`;
  const current = findMatches[index];
  if (canHighlight) {
    CSS.highlights.set('find', new Highlight(...findMatches.filter(r => r !== current)));
    CSS.highlights.set('find-current', new Highlight(current));
  }
  if (scroll) {
    scrollToRange(current);
    if (!canHighlight) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(current); }
  }
}

function scrollToRange(range) {
  const r = range.getBoundingClientRect(), c = content.getBoundingClientRect();
  if (r.top < c.top + 60 || r.bottom > c.bottom - 20) content.scrollTop += r.top - c.top - c.height / 3;
}

function stepFind(dir) {
  if (replaceMode) {
    if (!srcMatches.length) return;
    srcIndex = (srcIndex + dir + srcMatches.length) % srcMatches.length;
    showSourceMatch();
    if (srcMatches.length === findMatches.length && findMatches[srcIndex]) {
      if (canHighlight) CSS.highlights.set('find-current', new Highlight(findMatches[srcIndex]));
      scrollToRange(findMatches[srcIndex]);
    }
    return;
  }
  if (!findMatches.length) { runFind(false); return; }
  renderFind((findIndex + dir + findMatches.length) % findMatches.length);
}

function openFind() {
  if (!currentPath) return;
  findBar.hidden = false;
  findBtn.classList.add('on');
  // Start with the selected text, if any (like Ctrl+F in an editor).
  const sel = String(getSelection()).trim();
  if (sel && !sel.includes('\n') && sel.length < 200) findInput.value = sel;
  findInput.focus();
  findInput.select();
  runFind(false);
}

function closeFind() {
  findBar.hidden = true;
  findBtn.classList.remove('on');
  findMatches = [];
  clearFindHighlights();
}

let findTimer = 0;
findInput.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(false), 120); });
findInput.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
});
Object.values(findOpts).forEach(cb => cb.addEventListener('change', () => { runFind(false); findInput.focus(); }));
document.getElementById('findNext').addEventListener('click', () => stepFind(1));
document.getElementById('findPrev').addEventListener('click', () => stepFind(-1));
document.getElementById('findClose').addEventListener('click', closeFind);
findBtn.addEventListener('click', () => (findBar.hidden ? openFind() : closeFind()));

// ---------------------------------------------------------------- ⇄ Find & replace (edits the Markdown source)
// The page is a rendering, so replacements are made in the Markdown text and the page is redrawn.
// Nothing is written to disk until Save…, which goes through the Save As dialog.
let replaceMode = false;
let originalSource = null;            // the text as last read or saved
const undoStack = [];
let srcMatches = [];                  // { index, text } in currentSource
let srcIndex = -1;
const isEdited = () => originalSource !== null && currentSource !== originalSource;

const replaceRow = document.getElementById('replaceRow');
const replaceInput = document.getElementById('replaceInput');
const replaceToggle = document.getElementById('replaceToggle');
const replaceContext = document.getElementById('replaceContext');

function resetEdits() {
  originalSource = currentSource;
  undoStack.length = 0;
  srcIndex = -1;
  updateReplaceUi();
}

function sourcePattern() {
  try { return buildPattern(findInput.value); } catch { return null; }
}

function updateSourceMatches() {
  const q = findInput.value, re = q && currentPath ? sourcePattern() : null;
  srcMatches = [];
  if (re) for (const m of currentSource.matchAll(re)) if (m[0].length) srcMatches.push({ index: m.index, text: m[0] });
  if (srcIndex < 0 || srcIndex >= srcMatches.length) srcIndex = srcMatches.length ? 0 : -1;
  showSourceMatch();
}

function showSourceMatch() {
  if (!findInput.value) { findCount.textContent = ''; findCount.className = ''; replaceContext.textContent = ''; updateReplaceUi(); return; }
  if (!sourcePattern()) { findCount.textContent = 'Invalid pattern'; findCount.className = 'none'; replaceContext.textContent = ''; updateReplaceUi(); return; }
  if (!srcMatches.length) {
    findCount.textContent = 'No results in source'; findCount.className = 'none';
    replaceContext.textContent = '';
  } else {
    findCount.className = '';
    findCount.textContent = `${fmt(srcIndex + 1)} of ${fmt(srcMatches.length)} in source`;
    // Show the source line around the match: "Line 42: …text [match] text…"
    const m = srcMatches[srcIndex];
    const lineStart = currentSource.lastIndexOf('\n', m.index - 1) + 1;
    let lineEnd = currentSource.indexOf('\n', m.index); if (lineEnd < 0) lineEnd = currentSource.length;
    const lineNo = currentSource.slice(0, m.index).split('\n').length;
    const from = Math.max(lineStart, m.index - 50), to = Math.min(lineEnd, m.index + m.text.length + 50);
    const codeEl = document.createElement('code');
    const mark = document.createElement('mark');
    mark.textContent = m.text;
    codeEl.append((from > lineStart ? '…' : '') + currentSource.slice(from, m.index), mark,
      currentSource.slice(m.index + m.text.length, to).replace(/\r$/, '') + (to < lineEnd ? '…' : ''));
    replaceContext.replaceChildren(`Line ${fmt(lineNo)}: `, codeEl);
  }
  updateReplaceUi();
}

function updateReplaceUi() {
  const has = srcMatches.length > 0;
  document.getElementById('replaceOne').disabled = !has;
  document.getElementById('replaceAll').disabled = !has;
  document.getElementById('replaceUndo').disabled = !undoStack.length;
  const save = document.getElementById('replaceSave');
  save.disabled = !isEdited();
  save.textContent = isEdited() ? `💾 Save… (${fmt(undoStack.length)} change${undoStack.length === 1 ? '' : 's'})` : '💾 Save…';
}

// The text that replaces one match: literal, or with $1, $2… when "Regular expression" is on.
function replacementFor(matchText) {
  const repl = replaceInput.value;
  if (!findOpts.regex.checked) return repl;
  const re = sourcePattern();
  const single = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''));
  return matchText.replace(single, repl);
}

function applyEdit(newSource, message) {
  undoStack.push(currentSource);
  currentSource = newSource;
  renderDoc({ keepScroll: true });
  if (message) showToast(message);
}

function replaceOne() {
  if (!srcMatches.length) return;
  const m = srcMatches[srcIndex];
  const rep = replacementFor(m.text);
  const at = m.index + rep.length;
  applyEdit(currentSource.slice(0, m.index) + rep + currentSource.slice(m.index + m.text.length));
  // Continue with the next match after the replaced text.
  updateSourceMatches();
  const next = srcMatches.findIndex(x => x.index >= at);
  srcIndex = next >= 0 ? next : (srcMatches.length ? 0 : -1);
  showSourceMatch();
}

function replaceAll() {
  const re = sourcePattern();
  if (!re || !srcMatches.length) return;
  const n = srcMatches.length;
  const repl = replaceInput.value;
  const result = findOpts.regex.checked ? currentSource.replace(re, repl) : currentSource.replace(re, () => repl);
  applyEdit(result, `Replaced ${fmt(n)} match${n === 1 ? '' : 'es'} in the Markdown source. Use 💾 Save… to keep the changes.`);
  srcIndex = -1;
  updateSourceMatches();
}

function undoEdit() {
  if (!undoStack.length) return;
  currentSource = undoStack.pop();
  renderDoc({ keepScroll: true });
  updateSourceMatches();
  showToast('Undid the last replacement.');
}

// Saves the edited Markdown as UTF-8 through the Save As dialog (choose the original file to overwrite it).
async function saveEdited() {
  if (!isEdited()) return;
  const name = currentPath.split('/').pop();
  const blob = new Blob([currentSource], { type: 'text/markdown;charset=utf-8' });
  const done = shown => {
    originalSource = currentSource;
    undoStack.length = 0;
    renderDoc({ keepScroll: true });
    updateReplaceUi();
    showToast(shown);
  };
  if (window.showSaveFilePicker) {
    let handle = null;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }] }); }
    catch (e) {                     // cancelled → nothing to do; failed → say so (never download silently)
      if (e.name !== 'AbortError') showToast('The Save As window could not open — close any other Save As window and try again.');
      return;
    }
    try { const w = await handle.createWritable(); await w.write(blob); await w.close(); }
    catch (e) { showToast(`Saving failed: ${e.message}`); return; }
    done(`Saved “${handle.name}” (UTF-8).` + (currentInfo && !/UTF-8|ASCII/.test(currentInfo.name) ? ` The original was ${currentInfo.name}.` : ''));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  done(`Downloaded “${name}” (UTF-8) to your Downloads folder.`);
}

function setReplaceMode(on) {
  replaceMode = on;
  replaceRow.hidden = !on;
  replaceToggle.classList.toggle('on', on);
  replaceToggle.setAttribute('aria-expanded', String(on));
  srcIndex = -1;
  runFind(false);
  if (!on) replaceContext.textContent = '';
}

replaceToggle.addEventListener('click', () => { setReplaceMode(!replaceMode); (replaceMode ? replaceInput : findInput).focus(); });
document.getElementById('replaceOne').addEventListener('click', replaceOne);
document.getElementById('replaceAll').addEventListener('click', replaceAll);
document.getElementById('replaceUndo').addEventListener('click', undoEdit);
document.getElementById('replaceSave').addEventListener('click', saveEdited);
replaceInput.addEventListener('keydown', ev => {
  if (ev.key === 'Enter') { ev.preventDefault(); if (ev.ctrlKey) replaceAll(); else replaceOne(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
});
window.addEventListener('beforeunload', ev => { if (isEdited()) { ev.preventDefault(); ev.returnValue = ''; } });

// ---------------------------------------------------------------- 📋 Copy clean
// Removes invisible characters that can hide or change text; unusual spaces become normal
// spaces and Unicode separators become line breaks. Tabs, emoji pieces and visible marks stay.
function cleanText(text) {
  const removed = new Map(), replaced = new Map();
  const chars = [...text];
  let out = '';
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0), kind = charKind(cp);
    if (!kind || kind === 'tab' || kind === 'privateUse' || kind === 'replacement' || partOfEmoji(chars, i)) { out += ch; return; }
    if (kind === 'space' || kind === 'blank') { out += ' '; replaced.set(cp, (replaced.get(cp) || 0) + 1); return; }
    if (kind === 'separator') { out += '\n'; replaced.set(cp, (replaced.get(cp) || 0) + 1); return; }
    removed.set(cp, (removed.get(cp) || 0) + 1);       // zero-width, direction controls, control codes, noncharacters
  });
  return { text: out, removed, replaced };
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // Fallback for pages where the clipboard API isn't available.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

let toastTimer = 0;
function showToast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

// The cleaned Markdown source, or the readable text as shown (formulas as one run of symbols,
// no ¶ Hidden labels). Text keeps the document's Windows line breaks if it had them.
function cleanExport(what) {
  let text;
  if (what === 'source') text = currentSource;
  else {
    output.classList.add('measuring');
    text = output.innerText;
    output.classList.remove('measuring');
    text = text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
    if (/\r\n/.test(currentSource)) text = text.replace(/\n/g, '\r\n');
  }
  return cleanText(text);
}

function cleanSummary(r) {
  const list = m => [...m].map(([cp, n]) => `${shortName(cp)}${n > 1 ? ' ×' + fmt(n) : ''}`).join(', ');
  const nRemoved = [...r.removed.values()].reduce((a, b) => a + b, 0);
  const nReplaced = [...r.replaced.values()].reduce((a, b) => a + b, 0);
  return nRemoved || nReplaced
    ? [nRemoved && `Removed ${fmt(nRemoved)} hidden: ${list(r.removed)}.`,
       nReplaced && `Replaced ${fmt(nReplaced)} with normal spaces/line breaks: ${list(r.replaced)}.`].filter(Boolean).join(' ')
    : 'No hidden characters were found.';
}

async function copyClean(what) {
  if (!currentPath) return;
  const r = cleanExport(what);
  if (!await copyToClipboard(r.text)) { showToast('Copying failed — your browser blocked access to the clipboard.'); return; }
  showToast(`Copied the ${what === 'source' ? 'Markdown source' : 'text as shown'} (${fmt(charCount(r.text))} characters). ${cleanSummary(r)}`);
}

// Saves as UTF-8 through Windows' Save As dialog where available, otherwise as a download.
async function saveClean(what) {
  if (!currentPath) return;
  const r = cleanExport(what);
  const base = currentPath.split('/').pop().replace(MD_RE, '');
  const name = what === 'source' ? `${base}.clean.md` : `${base}.txt`;
  const type = what === 'source' ? { description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }
                                 : { description: 'Plain text', accept: { 'text/plain': ['.txt'] } };
  const blob = new Blob([r.text], { type: what === 'source' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
  let savedAs = name;
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [type] }); }
    catch (e) {                     // cancelled → nothing to do; failed → say so (never download silently)
      if (e.name !== 'AbortError') showToast('The Save As window could not open — close any other Save As window and try again.');
      return;
    }
    try {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      savedAs = handle.name;
    } catch (e) { showToast(`Saving failed: ${e.message}`); return; }
    showToast(`Saved “${savedAs}” (UTF-8, ${fmt(charCount(r.text))} characters). ${cleanSummary(r)}`);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  showToast(`Downloaded “${name}” (UTF-8, ${fmt(charCount(r.text))} characters). ${cleanSummary(r)}`);
}

const copyBtn = document.getElementById('copyBtn');
const copyMenu = document.getElementById('copyMenu');
function setCopyMenu(open) {
  copyMenu.hidden = !open;
  copyBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    // Open towards the side with room: under the button's right edge, or its left edge when the
    // button sits near the left of the window (e.g. when the toolbar wraps).
    copyMenu.classList.remove('align-left');
    if (copyMenu.getBoundingClientRect().left < 8) copyMenu.classList.add('align-left');
    copyMenu.querySelector('button').focus();
  }
}
copyBtn.addEventListener('click', ev => { ev.stopPropagation(); setCopyMenu(copyMenu.hidden); });
copyMenu.addEventListener('click', ev => {
  const item = ev.target.closest('[data-action]');
  if (!item) return;
  setCopyMenu(false);
  if (item.dataset.action === 'save') saveClean(item.dataset.what);
  else if (item.dataset.action === 'html') exportHtml();
  else copyClean(item.dataset.what);
});
document.addEventListener('click', ev => { if (!copyMenu.hidden && !ev.target.closest('.menu-wrap')) setCopyMenu(false); });
copyMenu.addEventListener('keydown', ev => {
  const items = [...copyMenu.querySelectorAll('button[data-action]')];
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'Escape') { setCopyMenu(false); copyBtn.focus(); }
  else if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

// ---------------------------------------------------------------- source → viewed breakdown
// Explains the difference between the source file and the text shown, category by category.
// The source is walked with the same Markdown parser the viewer renders with; each block's
// expected on-screen text is modelled, and the formatting removed (or added) is booked to a
// category. The model's predicted totals are then checked against what is actually measured
// on screen: ✓ when they agree exactly, ✗ with a "Not explained" row when they don't.

const CAT = {
  frontMatter: 'Front matter (--- YAML ---)',
  footnote: 'Footnote markers ([^1] and [^1]: …)',
  callout: 'Callout markers ([!NOTE] …)',
  blankLines: 'Empty lines',
  blankSpaces: 'Spaces on empty lines',
  softBreaks: 'Wrapped lines joined into one paragraph',
  softSpaces: 'Line breaks shown as spaces',
  collapsed: 'Extra spaces collapsed / trimmed',
  imageOnly: 'Lines with only images or HTML (no text)',
  headingMarks: 'Heading markers (#)',
  headingUnderline: 'Heading underlines (=== / ---)',
  bold: 'Bold markers (** or __)',
  italic: 'Italic markers (* or _)',
  strike: 'Strikethrough markers (~~)',
  codeTicks: 'Inline code backticks (`)',
  link: 'Link brackets & addresses [text](url)',
  image: 'Images (![alt](path) — shown as pictures)',
  escape: 'Backslash escapes (\\)',
  entity: 'HTML entities (&amp; → &)',
  hardBreak: 'Hard line-break marks (two spaces or \\)',
  inlineHtml: 'Inline HTML tags (<kbd>, <span>…)',
  listMarks: 'List markers & indentation (-, *, +, 1.)',
  taskBoxes: 'Task-list boxes ([ ] / [x])',
  quoteMarks: 'Quote markers (>)',
  codeFences: 'Code fences & language names (``` / ~~~)',
  codeIndent: 'Code block indentation (4 spaces)',
  table: 'Table borders (|) & cell padding',
  tableSep: 'Table separator rows (|---|)',
  hr: 'Horizontal rules (---, ***)',
  refDefs: 'Link reference definitions ([id]: url)',
  math: 'Math (TeX source → rendered symbols)',
  diagram: 'Diagrams (source → drawn labels)',
  html: 'HTML blocks: tags, attributes & comments',
  filtered: 'Removed by preview-only filter (scripts, styles…)',
  details: 'Inside collapsed <details> sections',
  codeWords: 'Code block contents (shown, not counted as words)',
  wordJoin: 'Words joined or split by formatting',
  other: 'Other formatting'
};

// Text that is shown but deliberately not counted as words (code blocks, equations, diagram
// labels) is wrapped in these two non-characters inside the model's predicted text.
const NW_START = '\uFDD0', NW_END = '\uFDD1';
const noWords = s => NW_START + s + NW_END;
const stripMarks = s => s.replace(/[\uFDD0\uFDD1]/g, '');
const wordText = s => s.replace(/\uFDD0[\s\S]*?\uFDD1/g, '');

let measureBox = null;
// Renders HTML off-screen with the page's styles and returns its text exactly as innerText sees it.
// With wordsOnly, returns the text the word count would see (code, equations, diagrams left out).
function measureHtml(html, leftoverMath, wordsOnly) {
  if (!measureBox) {
    measureBox = document.createElement('div');
    measureBox.className = 'markdown-body measuring measure-box';
    measureBox.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measureBox);
  }
  measureBox.replaceChildren(sanitize(html));
  if (leftoverMath) renderLeftoverMath(measureBox);
  measureBox.classList.toggle('words-only', !!wordsOnly);
  const text = measureBox.innerText;
  measureBox.classList.remove('words-only');
  measureBox.replaceChildren();
  return text;
}

const decoder = document.createElement('textarea');   // RCDATA: decodes entities, never parses tags
const decodeEntities = s => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, m => { decoder.innerHTML = m; return decoder.value; });

function analyzeDocument(source) {
  const cats = new Map();
  let bookedChars = 0, bookedLines = 0, bookedWords = 0;
  const book = (name, lines, chars, words = 0) => {
    if (!lines && !chars && !words) return;
    const e = cats.get(name) || { lines: 0, chars: 0, words: 0 };
    e.lines += lines; e.chars += chars; e.words += words;
    cats.set(name, e);
    bookedChars += chars; bookedLines += lines; bookedWords += words;
  };
  const len = s => charCount(stripMarks(s || ''));
  const W = s => countWords(wordText(s || ''));          // words as the word count sees them
  const nonBlank = s => (s || '').split('\n').filter(l => l.trim()).length;
  const visLines = s => s.split('\n').filter(l => l.trim()).length;
  const blankWs = s => len((s || '').split('\n').filter(l => !l.trim()).join(''));   // spaces on empty lines
  // Container markers (list bullets and numbers, quote >) minus any whitespace that just sits on empty lines.
  const bookContainer = (cat, raw, inner) => {
    const ws = Math.max(0, blankWs(raw) - blankWs(inner));
    book(CAT.blankSpaces, 0, ws);
    book(cat, nonBlank(raw) - nonBlank(inner), len(raw) - len(inner) - ws, W(raw) - W(inner));
  };
  const collapseLines = s => s.split('\n').map(l => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim()).join('\n');

  let text = source.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (fm) { book(CAT.frontMatter, fm[0].split('\n').length - 1, len(fm[0]), W(fm[0])); text = text.slice(fm[0].length); }

  // Every whitespace-only line is an empty line on screen (code blocks included).
  const srcLinesArr = text.split('\n'); if (srcLinesArr[srcLinesArr.length - 1] === '') srcLinesArr.pop();
  book(CAT.blankLines, srcLinesArr.filter(l => !l.trim()).length, 0);

  const OBJ = '\uFDD2';             // internal placeholder for an inline picture while modelling spaces
                                    // (a noncharacter, so it can't collide with a real U+FFFC in the document)
  const diagrams = [...output.querySelectorAll('pre.mermaid')];
  let diagramIndex = 0;
  const detailsStack = [];          // true = collapsed <details> currently open
  const hidden = () => detailsStack.includes(true);

  // ---- inline: returns visible text; soft breaks stay "\n", hard breaks become "\u2028"
  let dropDepth = 0;                // inside an inline tag the filter removes (e.g. <script>)
  function inline(tokens) {
    let out = '';
    for (const t of tokens || []) {
      const raw = t.raw || '';
      if (dropDepth > 0 && t.type !== 'html') { book(CAT.filtered, 0, len(raw), W(raw)); continue; }
      // Formatting around inner content: what's left after the content and its own categories.
      const wrap = (cat, v, c0, w0) => book(cat, 0, len(raw) - len(v) - (bookedChars - c0), W(raw) - W(v) - (bookedWords - w0));
      switch (t.type) {
        case 'text': {
          if (t.tokens && t.tokens.length) { const c0 = bookedChars, w0 = bookedWords; const v = inline(t.tokens); wrap(CAT.other, v, c0, w0); out += v; break; }
          const v = decodeEntities(t.text);
          // marked may already have decoded some entities (&#169; → ©) in t.text; those count as entities too.
          const from = decodeEntities(raw) === v ? raw : t.text;
          book(CAT.entity, 0, len(from) - len(v), W(from) - W(v));
          book(CAT.other, 0, len(raw) - len(from), W(raw) - W(from));
          out += v; break;
        }
        case 'escape': book(CAT.escape, 0, len(raw) - len(t.text), W(raw) - W(t.text)); out += t.text; break;
        case 'strong': case 'em': case 'del': {
          const c0 = bookedChars, w0 = bookedWords; const v = inline(t.tokens);
          wrap(t.type === 'strong' ? CAT.bold : t.type === 'em' ? CAT.italic : CAT.strike, v, c0, w0);
          out += v; break;
        }
        case 'codespan': book(CAT.codeTicks, 0, len(raw) - len(t.text), W(raw) - W(t.text)); out += t.text; break;
        case 'link': {
          const c0 = bookedChars, w0 = bookedWords; const v = inline(t.tokens);
          wrap(CAT.link, v, c0, w0);
          out += v; break;
        }
        case 'image': book(CAT.image, 0, len(raw), W(raw)); out += OBJ; break;
        case 'br': book(CAT.hardBreak, 0, len(raw), W(raw)); out += '\u2028'; break;
        case 'html': {
          const tag = /^<\/?\s*([a-z][a-z0-9-]*)/i.exec(raw);
          const name = tag ? tag[1].toLowerCase() : '';
          if (name && DROP_TAGS.has(name)) { dropDepth += raw.startsWith('</') ? -1 : (/\/>$/.test(raw) ? 0 : 1); dropDepth = Math.max(0, dropDepth); book(CAT.filtered, 0, len(raw), W(raw)); }
          else {
            book(CAT.inlineHtml, 0, len(raw), W(raw));
            if (name === 'br') out += '\u2028';
            else if (/^(img|input|video|audio|picture|svg)$/.test(name) && !raw.startsWith('</')) out += OBJ;
          }
          break;
        }
        case 'footnoteRef': {          // shown as its number
          const v = String(lastFootnoteOrder.get(t.label) || '');
          book(CAT.footnote, 0, len(raw) - len(v), W(raw) - W(v));
          out += v; break;
        }
        case 'mathInline': {
          // Shown as symbols, but equations aren't counted as words.
          const v = noWords(measureHtml(renderMath(t.text, t.display)).replace(/\n+/g, ' ').trim());
          book(CAT.math, 0, len(raw) - len(v), W(raw));
          out += t.display ? `\u2028${v}\u2028` : v; break;
        }
        default: {
          const v = t.text || '';
          book(CAT.other, 0, len(raw) - len(v), W(raw) - W(v));
          out += v;
        }
      }
    }
    return out;
  }

  // Paragraph-like text as the browser lays it out: soft breaks become spaces, runs of spaces collapse.
  function flow(rawVis) {
    const softs = (rawVis.match(/\n/g) || []).length;
    const spaced = rawVis.replace(/\n/g, ' ').replace(/\u2028/g, '\n');
    // Pictures are boxes on the line: spaces on both sides of one don't merge, so collapse around a placeholder.
    const v = collapseLines(spaced).replaceAll(OBJ, '');
    book(CAT.softSpaces, 0, -softs);
    book(CAT.collapsed, 0, len(spaced.replaceAll(OBJ, '')) - len(v));
    return v;
  }

  // ---- blocks: each returns its visible text and books its own formatting
  // Whatever this block's categories haven't covered yet goes to its main category; leftover
  // words in running text come from words that formatting joined or split (e.g. **un**done).
  function leaf(t, vis, mainCat, c0, l0, w0, wordsCat = CAT.wordJoin, visWords = null) {
    book(mainCat, nonBlank(t.raw) - visLines(vis) - (bookedLines - l0), len(t.raw) - len(vis) - (bookedChars - c0));
    book(wordsCat, 0, 0, W(t.raw) - (visWords === null ? W(vis) : countWords(visWords)) - (bookedWords - w0));
    return vis;
  }

  function blocks(tokens) {
    const parts = [];
    for (const t of tokens || []) {
      const v = block(t);
      if (v !== null) parts.push(v);
    }
    return parts.join('\n');
  }

  function block(t) {
    const raw = t.raw || '';
    const c0 = bookedChars, l0 = bookedLines, w0 = bookedWords;
    if (hidden() && t.type !== 'html') { book(CAT.details, nonBlank(raw), len(raw), W(raw)); return null; }
    switch (t.type) {
      case 'space': book(CAT.blankSpaces, 0, len(raw)); return null;
      case 'heading': {
        const v = flow(inline(t.tokens));
        const setext = /\n[ \t]*(=+|-+)[ \t]*\n*$/.exec(raw);
        if (setext) book(CAT.headingUnderline, 1, len(setext[0]));
        return leaf(t, v, CAT.headingMarks, c0, l0, w0);
      }
      case 'paragraph': case 'text': {
        const v = flow(t.tokens ? inline(t.tokens) : decodeEntities(t.text || ''));
        return leaf(t, v, visLines(v) ? CAT.softBreaks : CAT.imageOnly, c0, l0, w0);
      }
      case 'code': {
        const lang = (t.lang || '').trim().split(/\s+/)[0].toLowerCase();
        const fenced = /^ {0,3}(`{3,}|~{3,})/.test(raw);
        const fenceCat = fenced ? CAT.codeFences : CAT.codeIndent;
        const fenceLines = fenced ? nonBlank(raw) - nonBlank(t.text) : 0;
        if (lang === 'mermaid') {
          const pre = diagrams[diagramIndex++];
          const v = noWords(pre ? pre.innerText : t.text);
          book(fenceCat, fenceLines, len(raw) - len(t.text), W(raw) - W(t.text));
          return leaf(t, v, CAT.diagram, c0, l0, w0, CAT.diagram);
        }
        if (lang === 'math') {
          const v = noWords(measureHtml(renderMath(t.text, true)));
          book(fenceCat, fenceLines, len(raw) - len(t.text), W(raw) - W(t.text));
          return leaf(t, v, CAT.math, c0, l0, w0, CAT.math);
        }
        book(CAT.codeWords, 0, 0, W(t.text));
        return leaf(t, noWords(t.text), fenceCat, c0, l0, w0, fenceCat);
      }
      case 'mathBlock': return leaf(t, noWords(measureHtml(renderMath(t.text, true))), CAT.math, c0, l0, w0, CAT.math);
      case 'blockquote': {
        const inner = (t.tokens || []).map(c => c.raw).join('');
        bookContainer(CAT.quoteMarks, raw, inner);
        const callout = CALLOUT_RE.exec(inner);
        if (callout) {        // [!NOTE] … : the marker line is not shown (the title is drawn by CSS)
          book(CAT.callout, 1, len(callout[0].trim()), W(callout[0]));
          return blocks(md.lexer(inner.slice(callout[0].length)));
        }
        return blocks(t.tokens);
      }
      case 'list': {
        bookContainer(CAT.listMarks, raw, t.items.map(i => i.raw).join(''));
        const out = [];
        for (const item of t.items) {
          // The task box "[x] " is its own token (in the item, or first in a loose item's paragraph);
          // it is booked from item.raw below, so leave it out of the item's content.
          const tokens = (item.tokens || []).filter(c => c.type !== 'checkbox').map(c =>
            c.type === 'paragraph' && c.tokens && c.tokens[0] && c.tokens[0].type === 'checkbox'
              ? { ...c, raw: c.raw.slice(c.tokens[0].raw.length), text: c.text.slice(c.tokens[0].raw.length), tokens: c.tokens.slice(1) } : c);
          const inner = tokens.map(c => c.raw).join('');
          const task = item.task ? /^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s*)/.exec(item.raw) : null;
          if (task) book(CAT.taskBoxes, 0, len(task[1]) - 1, W(task[1]));   // the box is drawn followed by a space
          // (the task text "[x] " is part of the item's markers, not of its content)
          bookContainer(CAT.listMarks, item.raw, task ? task[1] + inner : inner);
          if (task) book(CAT.listMarks, 0, 0, W(task[1] + inner) - W(task[1]) - W(inner));   // keep word sums exact
          const v = blocks(tokens);
          out.push(task ? ' ' + v : v);
        }
        return out.join('\n');
      }
      case 'table': {
        const lines = raw.split('\n');
        const sep = lines[1] || '';
        book(CAT.tableSep, 1, len(sep), W(sep));
        const row = cells => cells.map(c => collapseLines(inline(c.tokens).replace(/\n/g, ' ').replace(/\u2028/g, '\n')).replaceAll(OBJ, '')).join('\t');
        const v = [row(t.header), ...t.rows.map(row)].join('\n');
        return leaf(t, v, CAT.table, c0, l0, w0, CAT.table);
      }
      case 'hr': return leaf(t, '', CAT.hr, c0, l0, w0, CAT.hr);
      case 'footnoteDef': {           // listed at the end when something refers to it
        if (!lastFootnoteOrder.has(t.label)) return leaf(t, '', CAT.footnote, c0, l0, w0, CAT.footnote);
        return leaf(t, flow(inline(t.tokens)), CAT.footnote, c0, l0, w0);
      }
      case 'def': return leaf(t, '', CAT.refDefs, c0, l0, w0, CAT.refDefs);
      case 'html': {
        const wasHidden = hidden();
        // Track <details> sections: everything inside a collapsed one is not shown.
        for (const m of raw.matchAll(/<(\/?)details\b([^>]*)>/gi)) {
          if (m[1]) detailsStack.pop(); else detailsStack.push(!/\bopen\b/i.test(m[2]));
        }
        if (wasHidden) { book(CAT.details, nonBlank(raw), len(raw), W(raw)); return null; }
        const v = measureHtml(raw, true);
        const vWords = measureHtml(raw, true, true);
        const unsafe = new DOMParser().parseFromString(`<!DOCTYPE html><body>${raw}`, 'text/html').body.textContent;
        const safe = new DOMParser().parseFromString('<!DOCTYPE html><body>', 'text/html').body;
        safe.appendChild(sanitize(raw));
        const removed = len(unsafe.replace(/\s+/g, '')) - len(safe.textContent.replace(/\s+/g, ''));
        if (removed > 0) book(CAT.filtered, 0, removed, Math.max(0, countWords(unsafe) - countWords(safe.textContent)));
        return leaf(t, v, CAT.html, c0, l0, w0, CAT.html, vWords);
      }
      default: {
        // Anything else: render that block alone and measure it.
        const html = md.parser([t]);
        return leaf(t, measureHtml(html), CAT.other, c0, l0, w0, CAT.other, measureHtml(html, false, true));
      }
    }
  }

  const tokens = md.lexer(text);
  // The parser swallows link reference definitions ([id]: url) without a token; book those gaps.
  const bookGap = gap => book(/^\s{0,3}\[[^\]]+\]:/m.test(gap) ? CAT.refDefs : CAT.other, nonBlank(gap), len(gap), W(gap));
  let pos = 0;
  const pieces = [];
  for (const t of tokens) {
    const i = text.indexOf(t.raw, pos);
    if (i > pos) bookGap(text.slice(pos, i));
    if (i >= 0) pos = i + t.raw.length;
    const v = block(t);
    if (v !== null) pieces.push(v);
  }
  if (pos < text.length) bookGap(text.slice(pos));
  const visible = pieces.join('\n');

  return {
    cats: [...cats].map(([name, v]) => ({ name, ...v })).filter(c => c.lines || c.chars || c.words),
    expected: { lines: visLines(visible), chars: len(visible), words: W(visible) },
    visible: stripMarks(visible),
    visibleWords: wordText(visible)
  };
}

let statsTimer = 0;
const picturesBlocked = () => loadPrefLive('pictures') === 'blocked';

function markBlocked(el, src) {
  el.removeAttribute('src');
  el.removeAttribute('srcset');
  if (el.tagName !== 'IMG') return;
  el.classList.remove('zoomable');
  el.classList.add('blocked');
  let file = src;
  try { file = decodeURIComponent(src.split(/[?#]/)[0].split('/').pop()); } catch { }
  el.dataset.origAlt = el.getAttribute('alt') || '';
  el.alt = `🖼 ${el.dataset.origAlt || file} — picture not loaded (pictures are off)`;
  el.title = `Pictures are off — right-click › Load picture to show it (${src})`;
}

function markMissing(img, src, baseDir) {
  img.classList.remove('zoomable');
  img.classList.add('missing');
  // Images found missing while loading: refresh the counts once they've all reported.
  clearTimeout(statsTimer);
  statsTimer = setTimeout(updateStats, 200);
  img.alt = `⚠ Image not found: ${src}`;
  img.title = `Not found in folder: ${resolve(baseDir, src)}`;
}

function scrollToAnchor(id) {
  try { id = decodeURIComponent(id); } catch {}
  const uid = 'user-content-' + id.replace(/^user-content-/, '');
  const target = document.getElementById(uid) || output.querySelector(`a[name="${CSS.escape(uid)}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Math that Markdown couldn't see (e.g. inside raw HTML blocks like <div align="center">).
// Single "$" is left out here: in plain text it's too often a price.
function renderLeftoverMath(root) {
  if (typeof window.renderMathInElement !== 'function') return;
  try {
    renderMathInElement(root, {
      ...KATEX_OPTIONS,
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false }
      ],
      ignoredClasses: ['katex', 'math-raw', 'mermaid']
    });
  } catch (e) { console.warn(e); }
}

function highlightCode(root) {
  if (typeof window.hljs?.highlightElement !== 'function') return;
  root.querySelectorAll('pre > code').forEach(el => {
    try { hljs.highlightElement(el); } catch {}
  });
}

// Diagram sources, kept so diagrams can be re-drawn (e.g. light theme for the PDF).
const diagramSource = new WeakMap();
let diagramCounter = 0;

function mermaidConfig(theme) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',   // no click handlers / links that run code inside diagrams
    // A diagram's %%{init}%% line may not change these (no CSS of its own for the page).
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
             'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily'],
    theme
  };
}

async function renderDiagrams(root, forceTheme) {
  const nodes = root.querySelectorAll('pre.mermaid');
  if (!nodes.length || typeof window.mermaid?.render !== 'function') return;
  try {
    mermaid.initialize(mermaidConfig(forceTheme || (isDark() ? 'dark' : 'default')));
  } catch (e) { console.warn('Mermaid:', e); return; }
  for (const n of nodes) {
    if (!diagramSource.has(n)) diagramSource.set(n, n.textContent);
    const src = diagramSource.get(n);
    try {
      const { svg } = await mermaid.render(`mermaid-diagram-${++diagramCounter}`, src);
      n.replaceChildren(sanitize(svg, { diagram: true }));
    } catch (e) {
      n.textContent = src;
      console.warn('Mermaid:', e);
    }
  }
}

// ---------------------------------------------------------------- preferences
// Remembered view settings. The app stores them itself (in its settings file) and puts them on
// <html data-…> before the page is shown; the standalone page uses localStorage. The first value is the default.
const PREFS = { theme: ['auto', 'light', 'dark'], sidebar: ['shown', 'hidden'], toc: ['shown', 'hidden'], hiddenchars: ['off', 'on'],
                pictures: ['shown', 'blocked'], size: ['normal', 'small', 'large', 'larger', 'largest'], width: ['normal', 'wide', 'full'] };

function loadPref(name) {
  const values = PREFS[name];
  let v;
  if (APP) v = document.documentElement.dataset[name];
  else try { v = localStorage.getItem('mdv-' + name); } catch {}
  return values.includes(v) ? v : values[0];
}

function savePref(name, value) {
  if (APP) fetch(`${apiBase}pref?${name}=${value}`).catch(() => {});
  else try { localStorage.setItem('mdv-' + name, value); } catch {}
}

// Non-default values live on <html data-…> so the CSS can apply them.
function setRootPref(name, value) {
  if (value === PREFS[name][0]) delete document.documentElement.dataset[name];
  else document.documentElement.dataset[name] = value;
}

// ---------------------------------------------------------------- theme
// Auto follows Windows; Light/Dark override it.
const THEME_LABELS = { auto: '🖥\uFE0F Auto', light: '☀\uFE0F Light', dark: '🌙 Dark' };
const themeBtn = document.getElementById('themeBtn');
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let theme = 'auto';
const isDark = () => theme === 'dark' || (theme === 'auto' && systemDark.matches);

function applyTheme(next, save) {
  theme = next in THEME_LABELS ? next : 'auto';
  setRootPref('theme', theme);
  // Code colouring: switch which highlight.js sheet applies on screen (print always uses light).
  document.getElementById('hljsLight').media =
    theme === 'auto' ? 'print, (prefers-color-scheme: light)' : theme === 'light' ? 'all' : 'print';
  document.getElementById('hljsDark').media =
    theme === 'auto' ? 'screen and (prefers-color-scheme: dark)' : theme === 'dark' ? 'screen' : 'not all';
  themeBtn.textContent = THEME_LABELS[theme];
  themeBtn.title = `Theme: ${theme === 'auto' ? 'follows Windows' : theme} (click to change)`;
  if (save) savePref('theme', theme);
}

themeBtn.addEventListener('click', () => {
  const order = Object.keys(THEME_LABELS);
  applyTheme(order[(order.indexOf(theme) + 1) % order.length], true);
  if (currentPath) renderDiagrams(output);
});
systemDark.addEventListener('change', () => { if (theme === 'auto' && currentPath) renderDiagrams(output); });
applyTheme(loadPref('theme'), false);

// ---------------------------------------------------------------- file list (left) show/hide
const sidebarBtn = document.getElementById('sidebarBtn');

function setSidebar(state, save) {
  setRootPref('sidebar', state);
  sidebarBtn.classList.toggle('on', state === 'shown' && !sidebarBtn.disabled);
  if (save) savePref('sidebar', state);
}

// The list only appears when the folder has two or more Markdown files.
function updateSidebarAvailability() {
  sidebar.hidden = mdPaths.length < 2;
  sidebarBtn.disabled = sidebar.hidden;
  setSidebar(loadPrefLive('sidebar'), false);
}

function toggleSidebar() {
  if (sidebarBtn.disabled) return;
  setSidebar(loadPrefLive('sidebar') === 'shown' ? 'hidden' : 'shown', true);
}
sidebarBtn.addEventListener('click', toggleSidebar);

// Current value (the <html> attribute, which already holds the loaded preference).
const loadPrefLive = name => document.documentElement.dataset[name] || PREFS[name][0];
setRootPref('sidebar', loadPref('sidebar'));

// ---------------------------------------------------------------- table of contents (right)
const toc = document.getElementById('toc');
const tocList = document.getElementById('tocList');
const tocBtn = document.getElementById('tocBtn');
const narrowScreen = matchMedia('(max-width: 1000px)');
let tocEntries = [];   // { heading, link }

function buildToc() {
  const headings = [...output.querySelectorAll('h1[id], h2[id], h3[id], h4[id]')];
  tocList.replaceChildren();
  tocEntries = [];
  const useful = headings.length >= 2;
  toc.hidden = !useful;
  tocBtn.disabled = !useful;
  updateTocButton();
  if (!useful) return;

  const top = Math.min(...headings.map(h => +h.tagName[1]));
  for (const heading of headings) {
    const link = document.createElement('a');
    link.href = '#' + heading.id.replace(/^user-content-/, '');
    link.textContent = heading.textContent.trim();
    link.title = link.textContent;
    link.style.setProperty('--lvl', +heading.tagName[1] - top);
    link.addEventListener('click', ev => {
      ev.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      delete document.documentElement.dataset.tocOpen;   // close the overlay on narrow windows
    });
    const li = document.createElement('li');
    li.append(link);
    tocList.append(li);
    tocEntries.push({ heading, link });
  }
  updateTocActive();
}

// Highlight the section being read: the last heading above the top of the view.
function updateTocActive() {
  if (!tocEntries.length) return;
  const line = content.getBoundingClientRect().top + 90;
  let current = tocEntries[0];
  for (const e of tocEntries) {
    if (e.heading.getBoundingClientRect().top <= line) current = e; else break;
  }
  if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) current = tocEntries[tocEntries.length - 1];
  for (const e of tocEntries) e.link.classList.toggle('active', e === current);
  const r = current.link.getBoundingClientRect(), t = toc.getBoundingClientRect();
  if (r.top < t.top || r.bottom > t.bottom) toc.scrollTop += r.top - t.top - t.height / 3;
}

let tocFrame = 0;
content.addEventListener('scroll', () => {
  if (!tocFrame) tocFrame = requestAnimationFrame(() => { tocFrame = 0; updateTocActive(); });
});

function updateTocButton() {
  const open = !('imgsOpen' in document.documentElement.dataset) && !('linksOpen' in document.documentElement.dataset) &&
    !('srcOpen' in document.documentElement.dataset) &&
    (narrowScreen.matches ? 'tocOpen' in document.documentElement.dataset : loadPrefLive('toc') === 'shown');
  tocBtn.classList.toggle('on', open && !tocBtn.disabled);
}

function toggleToc() {
  if (tocBtn.disabled) return;
  const root = document.documentElement;
  if ('imgsOpen' in root.dataset || 'linksOpen' in root.dataset || 'srcOpen' in root.dataset) {   // same place: back to Contents
    closeImages();
    closeLinks();
    closeSource();
    if (narrowScreen.matches ? 'tocOpen' in root.dataset : loadPrefLive('toc') === 'shown') { updateTocButton(); updateTocActive(); return; }
  }
  if (narrowScreen.matches) {
    // Narrow windows: the panel slides over the document and isn't remembered.
    if ('tocOpen' in root.dataset) delete root.dataset.tocOpen; else root.dataset.tocOpen = '';
  } else {
    const next = loadPrefLive('toc') === 'shown' ? 'hidden' : 'shown';
    setRootPref('toc', next);
    savePref('toc', next);
  }
  updateTocButton();
  updateTocActive();
}
tocBtn.addEventListener('click', toggleToc);
narrowScreen.addEventListener('change', () => { delete document.documentElement.dataset.tocOpen; updateTocButton(); });
content.addEventListener('click', () => {
  if ('tocOpen' in document.documentElement.dataset) { delete document.documentElement.dataset.tocOpen; updateTocButton(); }
  if (narrowScreen.matches && 'imgsOpen' in document.documentElement.dataset) closeImages();
  if (narrowScreen.matches && 'linksOpen' in document.documentElement.dataset) closeLinks();
});
setRootPref('toc', loadPref('toc'));
setRootPref('hiddenchars', loadPref('hiddenchars'));
updateHiddenButton();

// ---------------------------------------------------------------- pictures on / off
// Off: documents open without loading any picture; each shows its text (or file name) instead. Remembered.
const picBtn = document.getElementById('picBtn');
function updatePicButton() {
  const off = picturesBlocked();
  picBtn.textContent = off ? '🚫 Pictures off' : '🖼️ Pictures on';
  picBtn.classList.toggle('pic-off', off);
  picBtn.setAttribute('aria-pressed', String(!off));
  picBtn.title = off ? 'Pictures are off: documents open without loading pictures — click to show them (Ctrl+Shift+B)'
                     : 'Pictures are on — click to open documents without loading pictures (Ctrl+Shift+B)';
}
function togglePictures() {
  const next = picturesBlocked() ? 'shown' : 'blocked';
  setRootPref('pictures', next);
  savePref('pictures', next);
  updatePicButton();
  if (currentPath) renderDoc({ keepScroll: true });
  showToast(next === 'blocked' ? 'Pictures are off — documents open without loading pictures.' : 'Pictures are on.');
}
picBtn.addEventListener('click', togglePictures);
// ---------------------------------------------------------------- text size and page width
// A− / A+ change the document's text size; ↔ switches the page between normal, wide and full width.
// Both are remembered. (Printing and PDF keep their own size.)
const SIZE_STEPS = ['small', 'normal', 'large', 'larger', 'largest'];
const SIZE_NAMES = { small: 'Small', normal: 'Normal', large: 'Large', larger: 'Larger', largest: 'Largest' };
const WIDTH_STEPS = ['normal', 'wide', 'full'];
const WIDTH_NAMES = { normal: 'Normal', wide: 'Wide', full: 'Full window' };
const sizeDown = document.getElementById('sizeDown');
const sizeUp = document.getElementById('sizeUp');
const widthBtn = document.getElementById('widthBtn');

function updateSizeButtons() {
  const i = SIZE_STEPS.indexOf(loadPrefLive('size'));
  sizeDown.disabled = i <= 0;
  sizeUp.disabled = i >= SIZE_STEPS.length - 1;
  const name = SIZE_NAMES[SIZE_STEPS[i]];
  sizeDown.title = `Smaller text (now: ${name})`;
  sizeUp.title = `Larger text (now: ${name})`;
  const w = loadPrefLive('width');
  widthBtn.setAttribute('aria-label', `Page width: ${WIDTH_NAMES[w]}`);
  widthBtn.title = `Page width: ${WIDTH_NAMES[w]} — click to change`;
}
function setViewPref(name, value) {
  const scroll = content.scrollTop / Math.max(1, content.scrollHeight - content.clientHeight);
  setRootPref(name, value);
  savePref(name, value);
  updateSizeButtons();
  content.scrollTop = scroll * (content.scrollHeight - content.clientHeight);   // stay at the same place
}
function stepSize(dir) {
  const i = SIZE_STEPS.indexOf(loadPrefLive('size'));
  const next = SIZE_STEPS[Math.max(0, Math.min(SIZE_STEPS.length - 1, i + dir))];
  if (next !== SIZE_STEPS[i]) setViewPref('size', next);
}
sizeDown.addEventListener('click', () => stepSize(-1));
sizeUp.addEventListener('click', () => stepSize(1));
widthBtn.addEventListener('click', () => {
  const w = loadPrefLive('width');
  setViewPref('width', WIDTH_STEPS[(WIDTH_STEPS.indexOf(w) + 1) % WIDTH_STEPS.length]);
});
setRootPref('size', loadPref('size'));
setRootPref('width', loadPref('width'));
updateSizeButtons();

setRootPref('pictures', loadPref('pictures'));
updatePicButton();

// With pictures off, a picture loads only when asked: right-click its placeholder › "Load picture".
function loadBlocked(img) {
  const src = img.dataset.origSrc;
  if (!src || !img.classList.contains('blocked')) return;
  img.classList.remove('blocked');
  img.alt = img.dataset.origAlt || '';
  img.removeAttribute('title');
  const entry = localEntry(dirOf(currentPath || ''), src);
  if (entry) {
    if (source === 'app') img.addEventListener('error', () => markMissing(img, src, dirOf(currentPath || '')), { once: true });
    img.src = blobURL(entry);
  } else if (/^data:image\//i.test(src)) img.src = src;
  else markMissing(img, src, dirOf(currentPath || ''));
}

const picMenu = document.createElement('div');
picMenu.className = 'menu pic-menu';
picMenu.setAttribute('role', 'menu');
picMenu.hidden = true;
picMenu.innerHTML =
  '<button role="menuitem" data-pic="one"><b>🖼️ Load picture</b><span>Show this picture</span></button>' +
  '<button role="menuitem" data-pic="all"><b>🖼️ Load all pictures</b><span>Show every picture in this document (pictures stay off for other documents)</span></button>';
document.body.append(picMenu);
let picMenuTarget = null;

function closePicMenu() { picMenu.hidden = true; picMenuTarget = null; }

output.addEventListener('contextmenu', ev => {
  const img = ev.target.closest('img.blocked');
  if (!img) return;
  ev.preventDefault();
  picMenuTarget = img;
  picMenu.hidden = false;
  const w = picMenu.offsetWidth, h = picMenu.offsetHeight;
  picMenu.style.left = Math.max(8, Math.min(ev.clientX, innerWidth - w - 8)) + 'px';
  picMenu.style.top = Math.max(8, Math.min(ev.clientY, innerHeight - h - 8)) + 'px';
  picMenu.querySelector('button').focus();
});
picMenu.addEventListener('click', ev => {
  const item = ev.target.closest('[data-pic]');
  if (!item) return;
  const targets = item.dataset.pic === 'all' ? [...output.querySelectorAll('img.blocked')] : [picMenuTarget].filter(Boolean);
  closePicMenu();
  targets.forEach(loadBlocked);
  markZoomable(output);
  buildImageList();
  clearTimeout(statsTimer);
  statsTimer = setTimeout(updateStats, 200);
});
document.addEventListener('click', ev => { if (!picMenu.hidden && !picMenu.contains(ev.target)) closePicMenu(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !picMenu.hidden) closePicMenu(); }, true);
content.addEventListener('scroll', () => { if (!picMenu.hidden) closePicMenu(); });

// ---------------------------------------------------------------- images list (right)
// Every picture in the document, in order: click one to go to it, double-click to enlarge it.
const imgPanel = document.getElementById('imgPanel');
const imgList = document.getElementById('imgList');
const imgBtn = document.getElementById('imgBtn');
let imgEntries = [];   // { img, button }

const imageFile = img => {
  const src = img.dataset.webSrc || img.dataset.origSrc || '';
  try { return decodeURIComponent(src.split(/[?#]/)[0].split(/[\\/]/).pop() || ''); } catch { return src; }
};
const imageLabel = img => {
  const alt = (img.dataset.origAlt ?? img.getAttribute('alt') ?? '').replace(/^🌐 Web picture not loaded.*$/s, '').trim();
  return alt || imageFile(img) || 'Picture';
};

function buildImageList() {
  const imgs = [...output.querySelectorAll('img')].filter(img => !img.closest('.katex'));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  imgList.replaceChildren();
  imgEntries = [];
  imgBtn.disabled = !imgs.length;
  imgBtn.textContent = imgs.length ? `🖼️ Images (${fmt(imgs.length)})` : '🖼️ Images';
  document.getElementById('imgTitle').textContent = `Images (${fmt(imgs.length)})`;
  if (!imgs.length) closeImages();

  imgs.forEach((img, i) => {
    const button = el('button');
    button.type = 'button';
    const thumb = el('span', 'img-thumb');
    const web = img.classList.contains('web'), missing = img.classList.contains('missing'), off = img.classList.contains('blocked');
    if (off) thumb.textContent = '🚫';
    else if (web) thumb.textContent = '🌐';
    else if (missing) thumb.textContent = '⚠';
    else {
      const t = new Image();
      t.alt = '';
      t.addEventListener('error', () => {     // found missing only once it fails to load
        thumb.textContent = '⚠';
        if (!label.querySelector('.img-note')) label.append(el('span', 'img-note', 'not found'));
      }, { once: true });
      t.src = img.currentSrc || img.src;
      thumb.append(t);
    }
    const label = el('span', 'img-label');
    label.append(el('span', 'img-num', `${i + 1}. `), document.createTextNode(imageLabel(img)));
    const note = off ? 'not loaded — pictures are off' : web ? 'web picture — not loaded' : missing ? 'not found' : img.closest('a') ? 'inside a link' : '';
    if (note) label.append(el('span', 'img-note', note));
    button.title = (imageFile(img) || imageLabel(img)) +
      (img.classList.contains('zoomable') ? ' — click to go to it, double-click to enlarge' : ' — click to go to it');
    button.append(thumb, label);
    button.addEventListener('click', () => goToImage(img));
    button.addEventListener('dblclick', () => { if (img.classList.contains('zoomable')) openImage(img); });
    const li = el('li');
    li.append(button);
    imgList.append(li);
    imgEntries.push({ img, button });
  });
  updateImgButton();
  updateImagesActive();
}

let imgPin = null, imgPinUntil = 0;
function goToImage(img) {
  imgPin = img;
  imgPinUntil = performance.now() + 1500;
  const details = img.closest('details');
  if (details && !details.open) details.open = true;
  img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  img.classList.remove('img-flash');
  void img.offsetWidth;
  img.classList.add('img-flash');
  setTimeout(() => img.classList.remove('img-flash'), 1600);
  updateImagesActive();
  if (narrowScreen.matches) closeImages();
}

// Highlight the picture being looked at: the last one above the middle of the view.
function updateImagesActive() {
  if (!imgEntries.length || !('imgsOpen' in document.documentElement.dataset)) return;
  const mid = content.getBoundingClientRect().top + content.clientHeight / 2;
  let current = imgEntries[0];
  for (const e of imgEntries) {
    const r = e.img.getBoundingClientRect();
    if (r.height && r.top <= mid) current = e;
  }
  if (imgPin && performance.now() < imgPinUntil) current = imgEntries.find(e => e.img === imgPin) || current;
  for (const e of imgEntries) e.button.classList.toggle('active', e === current);
  const r = current.button.getBoundingClientRect(), t = imgPanel.getBoundingClientRect();
  if (r.top < t.top || r.bottom > t.bottom) imgPanel.scrollTop += r.top - t.top - t.height / 3;
}

let imgFrame = 0;
content.addEventListener('scroll', () => {
  if (!imgFrame) imgFrame = requestAnimationFrame(() => { imgFrame = 0; updateImagesActive(); });
});

function updateImgButton() {
  imgBtn.classList.toggle('on', 'imgsOpen' in document.documentElement.dataset && !imgBtn.disabled);
}

function closeImages() {
  delete document.documentElement.dataset.imgsOpen;
  updateImgButton();
  updateTocButton();
}

function toggleImages() {
  if (imgBtn.disabled) return;
  const root = document.documentElement;
  if ('imgsOpen' in root.dataset) closeImages();
  else {
    root.dataset.imgsOpen = '';
    delete root.dataset.tocOpen;
    closeLinks();
    closeSource();
    updateImgButton();
    updateTocButton();
    updateImagesActive();
  }
}
imgBtn.addEventListener('click', toggleImages);

// ---------------------------------------------------------------- links list (right)
// Every link in the document, in order, with its text and its real address. Clicking an entry only
// goes to the link in the document; ⧉ copies the address. Links the safety check flagged are marked.
const linkPanel = document.getElementById('linkPanel');
const linkList = document.getElementById('linkList');
const linkBtn = document.getElementById('linkBtn');
let linkEntries = [];   // { a, button }

const LINK_CHECKS = SAFETY_CHECKS.slice(1, 7);     // the safety checks that are about links
function linkFlags(href) {
  let full = href;
  try { full = new URL(href).href; } catch { }
  return (lastSafety?.findings || [])
    .filter(f => LINK_CHECKS.includes(f.check) && f.level !== 'note' &&
                 f.items.some(it => it.what.includes(href.slice(0, 120)) || it.what.includes(full.slice(0, 120))))
    .map(f => f.title);
}

function linkInfo(a) {
  const href = a.dataset.origHref || a.getAttribute('href') || '';
  const readable = s => { try { return decodeURI(s); } catch { return s; } };
  if (a.classList.contains('link-disabled')) return { icon: '⛔', address: href, note: a.title || 'disabled in preview mode' };
  if (href.startsWith('#')) return { icon: '#', address: href, note: 'section of this document' };
  if (/^mailto:/i.test(href)) return { icon: '✉', address: readable(href.slice(7)), note: '' };
  if (/^https?:/i.test(href)) return { icon: '🌐', address: readable(href), note: '' };
  if (MD_RE.test(href.split(/[?#]/)[0])) return { icon: '📄', address: readable(href), note: 'Markdown file' };
  return { icon: '📎', address: readable(href), note: 'file next to the document' };
}

function buildLinkList() {
  const links = [...output.querySelectorAll('a')].filter(a => (a.dataset.origHref || a.hasAttribute('href')) && !a.classList.contains('fn-link'));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  linkList.replaceChildren();
  linkEntries = [];
  linkBtn.disabled = !links.length;
  linkBtn.textContent = links.length ? `🔗 Links (${fmt(links.length)})` : '🔗 Links';
  const flagged = links.filter(a => linkFlags(a.dataset.origHref || a.getAttribute('href')).length).length;
  document.getElementById('linkTitle').textContent = `Links (${fmt(links.length)})` + (flagged ? ` · ⚠ ${fmt(flagged)} flagged` : '');
  if (!links.length) closeLinks();

  links.forEach((a, i) => {
    const info = linkInfo(a);
    const text = a.textContent.trim() || (a.querySelector('img') ? imageLabel(a.querySelector('img')) : '') || '(no text)';
    const go = el('button', 'link-go');
    go.type = 'button';
    const body = el('span', 'link-body');
    const t = el('span', info.address === text ? 'link-text wrap' : 'link-text');   // text is the address: show all of it
    t.append(el('span', 'img-num', `${i + 1}. `), document.createTextNode(text));
    body.append(t);
    if (info.address && info.address !== text) body.append(el('span', 'link-url', info.address));
    if (info.note) body.append(el('span', 'img-note', info.note));
    const flags = linkFlags(a.dataset.origHref || a.getAttribute('href'));
    for (const f of flags) body.append(el('span', 'link-flag', '⚠ ' + f));
    go.append(el('span', 'link-icon', info.icon), body);
    go.title = `${text}\n${info.address}` + (flags.length ? `\n⚠ ${flags.join('\n⚠ ')}` : '') + '\nClick to go to this link in the document';
    go.addEventListener('click', () => goToLink(a));
    const copy = el('button', 'link-copy', '⧉');
    copy.type = 'button';
    copy.title = 'Copy the address';
    copy.setAttribute('aria-label', `Copy the address of link ${i + 1}`);
    copy.addEventListener('click', async () => {
      showToast(await copyToClipboard(info.address) ? 'Address copied.' : 'Could not copy the address.');
    });
    const li = el('li');
    li.append(go, copy);
    linkList.append(li);
    linkEntries.push({ a, button: go });
  });
  updateLinkButton();
  updateLinksActive();
  checkBrokenLinks();
}

let linkPin = null, linkPinUntil = 0;     // the entry just clicked stays highlighted while the view scrolls to it
// Does a link lead somewhere? Sections must exist in this document; local files on disk (asked of the
// app, which answers "not found" for missing files); web addresses are not checked (never online).
function findAnchor(id) {
  try { id = decodeURIComponent(id); } catch { }
  const uid = 'user-content-' + id.replace(/^user-content-/, '');
  return document.getElementById(uid) || output.querySelector(`a[name="${CSS.escape(uid)}"]`);
}

let linkCheckRun = 0;
async function checkBrokenLinks() {
  const run = ++linkCheckRun, doc = currentPath;
  let broken = 0;
  for (const e of linkEntries) {
    const href = e.a.dataset.origHref || e.a.getAttribute('href') || '';
    let missing = false;
    if (href.startsWith('#')) missing = href.length > 1 && !findAnchor(href.slice(1));
    else if (!isExternal(href) && doc) {
      const path = resolve(dirOf(doc), href);
      if (source === 'app') {
        try { missing = (await fetch(fsURL(path), { method: 'HEAD', cache: 'no-store' })).status === 404; } catch { }
      } else missing = !fileMap.has(key(path));
    }
    if (run !== linkCheckRun) return;          // another document or a newer check took over
    if (!missing) continue;
    broken++;
    e.a.classList.add('link-broken');
    e.a.title = href.startsWith('#') ? 'This section does not exist in the document' : 'File not found';
    const body = e.button.querySelector('.link-body');
    if (body && !body.querySelector('.link-missing')) {
      const note = document.createElement('span');
      note.className = 'link-flag link-missing';
      note.textContent = href.startsWith('#') ? '⚠ section not found' : '⚠ file not found';
      body.append(note);
    }
  }
  if (broken) document.getElementById('linkTitle').textContent += ` · ${fmt(broken)} broken`;
}

function goToLink(a) {
  linkPin = a;
  linkPinUntil = performance.now() + 1500;
  const details = a.closest('details');
  if (details && !details.open) details.open = true;
  a.scrollIntoView({ behavior: 'smooth', block: 'center' });
  a.classList.remove('img-flash');
  void a.offsetWidth;
  a.classList.add('img-flash');
  setTimeout(() => a.classList.remove('img-flash'), 1600);
  updateLinksActive();
  if (narrowScreen.matches) closeLinks();
}

// Highlight the link being read: the last one above the middle of the view.
function updateLinksActive() {
  if (!linkEntries.length || !('linksOpen' in document.documentElement.dataset)) return;
  const mid = content.getBoundingClientRect().top + content.clientHeight / 2;
  let current = linkEntries[0];
  for (const e of linkEntries) {
    const r = e.a.getBoundingClientRect();
    if (r.height && r.top <= mid) current = e;
  }
  if (linkPin && performance.now() < linkPinUntil) current = linkEntries.find(e => e.a === linkPin) || current;
  for (const e of linkEntries) e.button.classList.toggle('active', e === current);
  const r = current.button.getBoundingClientRect(), t = linkPanel.getBoundingClientRect();
  if (r.top < t.top || r.bottom > t.bottom) linkPanel.scrollTop += r.top - t.top - t.height / 3;
}

let linkFrame = 0;
content.addEventListener('scroll', () => {
  if (!linkFrame) linkFrame = requestAnimationFrame(() => { linkFrame = 0; updateLinksActive(); });
});

function updateLinkButton() {
  linkBtn.classList.toggle('on', 'linksOpen' in document.documentElement.dataset && !linkBtn.disabled);
}

function closeLinks() {
  delete document.documentElement.dataset.linksOpen;
  updateLinkButton();
  updateTocButton();
}

function toggleLinks() {
  if (linkBtn.disabled) return;
  const root = document.documentElement;
  if ('linksOpen' in root.dataset) closeLinks();
  else {
    closeImages();
    closeSource();
    root.dataset.linksOpen = '';
    delete root.dataset.tocOpen;
    updateLinkButton();
    updateTocButton();
    updateLinksActive();
  }
}
linkBtn.addEventListener('click', toggleLinks);

// ---------------------------------------------------------------- source view (right)
// The Markdown file with line numbers next to the document. Both scroll together: each top-level block
// of the document knows the source line it starts on. Invisible characters show as ⟨markers⟩.
const srcPanel = document.getElementById('srcPanel');
const srcView = document.getElementById('srcView');
const srcBtn = document.getElementById('srcBtn');
const SRC_MAX_LINES = 30000;
let srcDirty = true;
const srcIsOpen = () => 'srcOpen' in document.documentElement.dataset;

// Top-level blocks → the source line they start on (front matter counted).
const BLOCK_TAGS = {
  heading: /^H[1-6]$/, paragraph: /^(P|DIV)$/, code: /^(PRE|DIV)$/, mathBlock: /^DIV$/, list: /^(UL|OL)$/,
  table: /^(TABLE|DIV)$/, blockquote: /^BLOCKQUOTE$/, hr: /^HR$/
};
function mapSourceLines() {
  const text = currentSource.replace(/\r\n|\r/g, '\n');
  const fm = /^\uFEFF?---\n[\s\S]*?\n---\n/.exec(text);
  let line = 1 + (fm ? fm[0].split('\n').length - 1 : 0);
  let tokens;
  try { tokens = md.lexer(fm ? text.slice(fm[0].length) : text.replace(/^\uFEFF/, '')); } catch { return; }
  const kids = [...output.children];
  let j = 0;
  for (const t of tokens) {
    const want = BLOCK_TAGS[t.type];
    if (want) {
      for (let k = j; k < Math.min(kids.length, j + 4); k++) {
        if (want.test(kids[k].tagName)) { kids[k].dataset.srcLine = line; j = k + 1; break; }
      }
    }
    line += ((t.raw || '').match(/\n/g) || []).length;
  }
}

const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
function buildSource() {
  srcDirty = false;
  const lines = currentSource.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const frag = document.createDocumentFragment();
  lines.slice(0, SRC_MAX_LINES).forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'sl';
    row.dataset.n = i + 1;
    const st = document.createElement('span');
    st.className = 'st';
    let last = 0;
    for (const m of l.matchAll(INVISIBLE)) {
      st.append(l.slice(last, m.index));
      const mark = document.createElement('span');
      mark.className = 'inv';
      mark.textContent = `⟨${SHORT_NAMES[m[0].codePointAt(0)] || uPlus(m[0].codePointAt(0))}⟩`;
      st.append(mark);
      last = m.index + m[0].length;
    }
    st.append(l.slice(last) || (last ? '' : ' '));
    row.append(st);
    frag.append(row);
  });
  srcView.replaceChildren(frag);
  if (lines.length > SRC_MAX_LINES) {
    const more = document.createElement('div');
    more.className = 'src-more';
    more.textContent = `… ${fmt(lines.length - SRC_MAX_LINES)} more lines not shown`;
    srcView.append(more);
  }
  document.getElementById('srcTitle').textContent = `Source · ${plural(lines.length, 'line')}`;
  syncSourceFromView();
}

// ---------------------------------------------------------------- compare two versions
// This document (as shown, with any unsaved replacements) and another Markdown file, line by line: lines
// only in the other file in red, lines only in this one in green, and inside a changed line the words that
// changed. Unchanged stretches fold away (click to show them).
const cmpDlg = document.getElementById('compare');
const cmpBody = document.getElementById('cmpBody');
const cmpSummary = document.getElementById('cmpSummary');
const cmpOther = document.getElementById('cmpOther');
const cmpFile = document.getElementById('cmpFile');
const cmpBtn = document.getElementById('cmpBtn');
const CMP_CONTEXT = 3;            // unchanged lines kept around each change
const CMP_MAX_CELLS = 9e6;        // lines-left × lines-right still compared exactly
let cmpOtherText = null, cmpOtherName = '', cmpChanges = [], cmpAt = -1;

const splitLines = s => { const l = s.replace(/\r\n|\r/g, '\n').split('\n'); if (l.length > 1 && l[l.length - 1] === '') l.pop(); return l; };

// Longest common subsequence of two arrays of keys → steps: ['=', i, j] / ['-', i] / ['+', j].
function diffKeys(a, b, maxCells) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (n * m > maxCells || n > 65000 || m > 65000) return null;
  const w = m + 1, L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out = [];
  for (let k = 0; k < s; k++) out.push(['=', k, k]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) { out.push(['=', s + i, s + j]); i++; j++; }
    else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { out.push(['+', s + j]); j++; }
    else { out.push(['-', s + i]); i++; }
  }
  for (let k = 0; k < a.length - ea; k++) out.push(['=', ea + k, eb + k]);
  return out;
}

// Inside a changed line: which words were removed / added.
function wordMarks(oldLine, newLine) {
  const tok = s => s.match(/\s+|[\p{L}\p{N}_]+|./gsu) || [];
  const a = tok(oldLine), b = tok(newLine);
  if (a.length > 1500 || b.length > 1500) return null;
  return { a, b, steps: diffKeys(a, b, 2.5e6) };
}

function cmpText(el, text, marks, side) {
  if (!marks || !marks.steps) { appendWithMarkers(el, text); return; }
  for (const st of marks.steps) {
    if (st[0] === '=') { if (side === 'a') appendWithMarkers(el, marks.a[st[1]]); else appendWithMarkers(el, marks.b[st[2]]); }
    else if ((st[0] === '-' && side === 'a') || (st[0] === '+' && side === 'b')) {
      const w = document.createElement('span');
      w.className = side === 'a' ? 'cmp-w-del' : 'cmp-w-add';
      appendWithMarkers(w, side === 'a' ? marks.a[st[1]] : marks.b[st[1]]);
      el.append(w);
    }
  }
}

function runCompare() {
  if (cmpOtherText === null) return;
  const ignore = document.getElementById('cmpSpaces').checked;
  const before = splitLines(cmpOtherText), after = splitLines(currentSource);
  const norm = l => ignore ? l.replace(/\s+/g, ' ').trim() : l;
  const ids = new Map();
  const id = l => { const k = norm(l); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const steps = diffKeys(before.map(id), after.map(id), CMP_MAX_CELLS);
  cmpChanges = [];
  cmpAt = -1;
  if (!steps) {
    cmpBody.replaceChildren();
    cmpSummary.className = 'cmp-summary bad';
    cmpSummary.textContent = 'These files differ in too many lines to compare line by line here.';
    return;
  }

  // Changed lines next to each other become pairs, so the words that changed can be marked.
  const rows = [];
  for (let k = 0; k < steps.length;) {
    if (steps[k][0] === '=') { rows.push({ op: '=', a: steps[k][1], b: steps[k][2] }); k++; continue; }
    const dels = [], adds = [];
    while (k < steps.length && steps[k][0] !== '=') { (steps[k][0] === '-' ? dels : adds).push(steps[k][1]); k++; }
    const block = [];
    dels.forEach((a, x) => block.push({ op: '-', a, pair: x < adds.length ? adds[x] : null }));
    adds.forEach((b, x) => block.push({ op: '+', b, pair: x < dels.length ? dels[x] : null }));
    block[0].start = true;
    rows.push(...block);
  }
  const added = rows.filter(r => r.op === '+').length, removed = rows.filter(r => r.op === '-').length;
  const blocks = rows.filter(r => r.start).length;

  // Which unchanged lines stay visible: those close to a change.
  const keep = rows.map(r => r.op !== '=');
  rows.forEach((r, i) => { if (r.op !== '=') for (let d = -CMP_CONTEXT; d <= CMP_CONTEXT; d++) if (rows[i + d]) keep[i + d] = true; });

  const frag = document.createDocumentFragment();
  const rowEl = r => {
    const el = document.createElement('div');
    el.className = 'cmp-row ' + (r.op === '-' ? 'del' : r.op === '+' ? 'add' : 'same');
    const na = document.createElement('span'); na.className = 'cmp-n'; na.textContent = r.op === '+' ? '' : r.a + 1;
    const nb = document.createElement('span'); nb.className = 'cmp-n'; nb.textContent = r.op === '-' ? '' : r.b + 1;
    const mk = document.createElement('span'); mk.className = 'cmp-mark'; mk.textContent = r.op === '=' ? '' : r.op === '-' ? '−' : '+';
    const tx = document.createElement('span'); tx.className = 'cmp-text';
    if (r.op === '=') appendWithMarkers(tx, after[r.b]);
    else if (r.op === '-') cmpText(tx, before[r.a], r.pair !== null ? wordMarks(before[r.a], after[r.pair]) : null, 'a');
    else cmpText(tx, after[r.b], r.pair !== null ? wordMarks(before[r.pair], after[r.b]) : null, 'b');
    el.append(na, nb, mk, tx);
    if (r.start) cmpChanges.push(el);
    return el;
  };
  for (let i = 0; i < rows.length;) {
    if (keep[i]) { frag.append(rowEl(rows[i])); i++; continue; }
    const from = i;
    while (i < rows.length && !keep[i]) i++;
    const hiddenRows = rows.slice(from, i);
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'cmp-fold';
    fold.textContent = `⋯ ${plural(hiddenRows.length, 'unchanged line')} — click to show`;
    fold.addEventListener('click', () => fold.replaceWith(...hiddenRows.map(rowEl)));
    frag.append(fold);
  }
  cmpBody.replaceChildren(frag);
  cmpBody.scrollTop = 0;
  cmpSummary.className = 'cmp-summary ' + (blocks ? 'warn' : 'ok');
  cmpSummary.textContent = blocks
    ? `${plural(blocks, 'change')}: ${plural(removed, 'line')} only in “${cmpOtherName}” (red), ${plural(added, 'line')} only in this document (green)` +
      (ignore ? ' · spaces ignored' : '')
    : `✓ No differences${ignore ? ' (ignoring spaces)' : ''}.`;
  if (blocks) stepCompare(1);
}

function stepCompare(dir) {
  if (!cmpChanges.length) return;
  cmpChanges[cmpAt]?.classList.remove('cmp-current');
  cmpAt = (cmpAt + dir + cmpChanges.length) % cmpChanges.length;
  const el = cmpChanges[cmpAt];
  el.classList.add('cmp-current');
  el.scrollIntoView({ block: 'center' });
  document.getElementById('cmpPos').textContent = `${cmpAt + 1} / ${cmpChanges.length}`;
}

function openCompare() {
  if (!currentPath) return;
  document.getElementById('cmpThis').textContent = fileName(currentPath) + (isEdited() ? ' (with unsaved replacements)' : '');
  cmpOther.replaceChildren(new Option('Choose the other version…', ''));
  for (const p of mdPaths) {
    if (key(p) === key(currentPath)) continue;
    cmpOther.append(new Option(listBase && key(p).startsWith(key(listBase)) ? p.slice(listBase.length) : p, p));
  }
  cmpOther.value = '';
  cmpOtherText = null;
  cmpChanges = [];
  document.getElementById('cmpPos').textContent = '';
  cmpBody.replaceChildren();
  cmpSummary.className = 'cmp-summary';
  cmpSummary.textContent = 'Pick the other version: a Markdown file from this folder, or “Other file…” for one anywhere on your PC.';
  cmpDlg.showModal();
}

cmpOther.addEventListener('change', async () => {
  if (!cmpOther.value) return;
  try {
    const entry = await readDoc(cmpOther.value);
    cmpOtherText = entry.text;
    cmpOtherName = fileName(entry.path);
    runCompare();
  } catch (e) { cmpSummary.className = 'cmp-summary bad'; cmpSummary.textContent = e.message; }
});
document.getElementById('cmpBrowse').addEventListener('click', () => cmpFile.click());
cmpFile.addEventListener('change', async () => {
  const f = cmpFile.files[0];
  cmpFile.value = '';
  if (!f) return;
  try {
    cmpOtherText = decodeBytes(await f.arrayBuffer()).text;
    cmpOtherName = f.name;
    cmpOther.value = '';
    runCompare();
  } catch (e) { cmpSummary.className = 'cmp-summary bad'; cmpSummary.textContent = `Could not read ${f.name}: ${e.message}`; }
});
document.getElementById('cmpSpaces').addEventListener('change', runCompare);
document.getElementById('cmpPrev').addEventListener('click', () => stepCompare(-1));
document.getElementById('cmpNext').addEventListener('click', () => stepCompare(1));
document.getElementById('cmpClose').addEventListener('click', () => cmpDlg.close());
cmpBtn.addEventListener('click', openCompare);

// Programmatic scrolling of one side must not scroll the other side back.
let quietView = 0, quietSrc = 0;
const now = () => performance.now();

function syncSourceFromView() {
  if (!srcIsOpen() || now() < quietView) return;
  const blocks = [...output.querySelectorAll(':scope > [data-src-line]')];
  if (!blocks.length || !srcView.children.length) return;
  const top = content.getBoundingClientRect().top + 8;
  let cur = blocks[0], next = null;
  for (const b of blocks) {
    if (b.getBoundingClientRect().top <= top) cur = b; else { next = b; break; }
  }
  const start = +cur.dataset.srcLine, end = next ? +next.dataset.srcLine : srcView.children.length + 1;
  const r = cur.getBoundingClientRect();
  const frac = r.height ? Math.min(1, Math.max(0, (top - r.top) / r.height)) : 0;
  srcView.querySelectorAll('.sl.cur').forEach(x => x.classList.remove('cur'));
  for (let n = start; n < end && n <= srcView.children.length; n++) srcView.children[n - 1]?.classList.add('cur');
  const lineF = start + frac * (end - start);
  const el = srcView.children[Math.max(0, Math.floor(lineF) - 1)];
  if (!el) return;
  quietSrc = now() + 150;
  srcPanel.scrollTop = srcView.offsetTop + el.offsetTop + (lineF % 1) * el.offsetHeight - 40;
}

function lineAtTopOfSource() {
  const rows = srcView.children, y = srcPanel.scrollTop - srcView.offsetTop + 40;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

function scrollViewToLine(line, smooth) {
  const blocks = [...output.querySelectorAll(':scope > [data-src-line]')];
  if (!blocks.length) return;
  let cur = blocks[0], next = null;
  for (const b of blocks) { if (+b.dataset.srcLine <= line) cur = b; else { next = b; break; } }
  const start = +cur.dataset.srcLine, end = next ? +next.dataset.srcLine : start + 1;
  const frac = Math.min(1, Math.max(0, (line - start) / Math.max(1, end - start)));
  const r = cur.getBoundingClientRect(), c = content.getBoundingClientRect();
  quietView = now() + (smooth ? 800 : 150);
  content.scrollTo({ top: content.scrollTop + r.top - c.top + frac * r.height - 8, behavior: smooth ? 'smooth' : 'auto' });
}

content.addEventListener('scroll', () => { if (srcIsOpen()) requestAnimationFrame(syncSourceFromView); });
srcPanel.addEventListener('scroll', () => {
  if (!srcIsOpen() || now() < quietSrc) return;
  requestAnimationFrame(() => scrollViewToLine(lineAtTopOfSource(), false));
});
srcView.addEventListener('click', ev => {
  const row = ev.target.closest('.sl');
  if (row && window.getSelection().isCollapsed) scrollViewToLine(+row.dataset.n, true);
});

// Open the source at a line (e.g. from the safety report) and point it out.
function showSourceLine(n) {
  if (!srcIsOpen()) toggleSource();
  const row = srcView.children[n - 1];
  if (!row) return;
  quietSrc = now() + 300;
  srcPanel.scrollTop = srcView.offsetTop + row.offsetTop - srcPanel.clientHeight / 3;
  srcView.querySelectorAll('.sl.hit').forEach(x => x.classList.remove('hit'));
  row.classList.add('hit');
  setTimeout(() => row.classList.remove('hit'), 2500);
  scrollViewToLine(n, true);
}

function updateSrcButton() {
  srcBtn.classList.toggle('on', srcIsOpen() && !srcBtn.disabled);
}
function closeSource() {
  delete document.documentElement.dataset.srcOpen;
  updateSrcButton();
  updateTocButton();
}
function toggleSource() {
  if (srcBtn.disabled) return;
  const root = document.documentElement;
  if (srcIsOpen()) { closeSource(); return; }
  closeImages();
  closeLinks();
  root.dataset.srcOpen = '';
  delete root.dataset.tocOpen;
  if (srcDirty) buildSource(); else syncSourceFromView();
  updateSrcButton();
  updateTocButton();
}
srcBtn.addEventListener('click', toggleSource);

// ---------------------------------------------------------------- figure viewer (zoom & pan)
const lightbox = document.getElementById('lightbox');
const lbStage = document.getElementById('lbStage');
const lbItem = document.getElementById('lbItem');
const lbLevel = document.getElementById('lbLevel');
const lb = { scale: 1, x: 0, y: 0, w: 0, h: 0, fit: 1, returnFocus: null };

function openLightbox(node, width, height, caption, isDiagram) {
  const wasHidden = lightbox.hidden;
  lbItem.replaceChildren(node);
  lbItem.classList.toggle('diagram', isDiagram);
  document.getElementById('lbCaption').textContent = caption;
  lb.w = Math.max(1, width);
  lb.h = Math.max(1, height);
  if (wasHidden) lb.returnFocus = document.activeElement;
  lightbox.hidden = false;
  fitLightbox();
  if (wasHidden) document.getElementById('lbClose').focus();
}

// ---- Saving files: Windows' Save As dialog. Only where there is no such dialog at all is the file
// downloaded instead; if the dialog fails (e.g. another one is still open) nothing is saved silently.
async function saveFileAs(blob, name, type) {
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [type] }); }
    catch (e) {
      if (e.name !== 'AbortError') showToast('The Save As window could not open — close any other Save As window and try again.');
      return null;
    }
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return handle.name;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return name;
}

// ---- Diagram export: SVG as drawn; PNG from a copy drawn without HTML labels (a picture that contains
// HTML cannot be turned into pixels by the browser).
let lbDiagram = null;
const diagramBase = () => (currentPath ? currentPath.split('/').pop().replace(MD_RE, '') : 'diagram') +
  `-diagram-${[...output.querySelectorAll('pre.mermaid')].indexOf(lbDiagram) + 1}`;

function standaloneSvg(svg) {
  const copy = svg.cloneNode(true);
  const vb = (copy.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const [x, y, w, h] = vb.length === 4 && vb.every(isFinite) ? vb : [0, 0, svg.getBoundingClientRect().width, svg.getBoundingClientRect().height];
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', w);
  copy.setAttribute('height', h);
  copy.removeAttribute('style');
  // A background in the theme's colour, so light text on a dark diagram stays readable anywhere.
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', x); bg.setAttribute('y', y); bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor || '#ffffff');
  copy.insertBefore(bg, copy.firstChild);
  return { text: new XMLSerializer().serializeToString(copy), w, h };
}

async function saveDiagramSvg() {
  const svg = lbDiagram && lbDiagram.querySelector('svg');
  if (!svg) return;
  const { text } = standaloneSvg(svg);
  const saved = await saveFileAs(new Blob([text], { type: 'image/svg+xml' }), diagramBase() + '.svg',
    { description: 'SVG picture', accept: { 'image/svg+xml': ['.svg'] } }).catch(e => { showToast(`Saving failed: ${e.message}`); return null; });
  if (saved) showToast(`Saved “${saved}”.`);
}

async function saveDiagramPng() {
  const src = lbDiagram && diagramSource.get(lbDiagram);
  if (!src) return;
  const theme = isDark() ? 'dark' : 'default';
  try {
    mermaid.initialize({ ...mermaidConfig(theme), htmlLabels: false, flowchart: { htmlLabels: false } });
    const { svg } = await mermaid.render(`mermaid-export-${++diagramCounter}`, src);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');     // inert: only drawn as a picture
    const { text, w, h } = standaloneSvg(doc.documentElement);
    const scale = 2;
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    let blob;
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(w * scale);
      canvas.height = Math.ceil(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('no picture')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
    const saved = await saveFileAs(blob, diagramBase() + '.png', { description: 'PNG picture', accept: { 'image/png': ['.png'] } });
    if (saved) showToast(`Saved “${saved}” (${fmt(Math.ceil(w * scale))} × ${fmt(Math.ceil(h * scale))} pixels).`);
  } catch (e) {
    showToast(e.name === 'SecurityError' ? 'This kind of diagram cannot be saved as PNG — save it as SVG instead.' : `Saving the PNG failed: ${e.message}`);
  } finally {
    mermaid.initialize(mermaidConfig(theme));
  }
}
document.getElementById('lbSvg').addEventListener('click', saveDiagramSvg);
document.getElementById('lbPng').addEventListener('click', saveDiagramPng);

// ---- A picture's own text, as if the file were opened in Notepad: "</> Text" in the picture viewer.
// SVG pictures are text; other pictures (PNG, JPG…) are binary, shown the way Notepad shows them - read as
// UTF-8, or as Windows (ANSI) text when that fails - with control bytes as small symbols (␀ …) so they stay
// visible. Line numbers, invisible characters as ⟨markers⟩, read-only, with a button to copy the text.
const TEXT_PICTURE = /\.svg$/i;
const PICTURE_TEXT_MAX = 2 << 20;      // a large photo: only its first 2 MB, so the window stays responsive
const isTextPicture = img => !!img && TEXT_PICTURE.test((img.dataset.origSrc || '').split(/[?#]/)[0]);
const hasPictureFile = img => !!img && !!img.dataset.origSrc && !['web', 'missing', 'blocked'].some(c => img.classList.contains(c));
let pictureText = '';

// Bytes → text the way Notepad reads a file it is given.
function bytesAsNotepad(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('windows-1252').decode(bytes); }
  return text.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
    c => String.fromCharCode(c === '\x7F' ? 0x2421 : 0x2400 + c.charCodeAt(0)));
}

function appendWithMarkers(el, text) {
  let last = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    el.append(text.slice(last, m.index));
    const mark = document.createElement('span');
    mark.className = 'inv';
    mark.textContent = `⟨${SHORT_NAMES[m[0].codePointAt(0)] || uPlus(m[0].codePointAt(0))}⟩`;
    el.append(mark);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last) || (last ? '' : ' '));
}

async function showPictureText(img) {
  if (!hasPictureFile(img)) return;
  const svg = isTextPicture(img);
  let text, total = 0, shown = 0;
  try {
    // Binary pictures: only the first part of a large file (the app hands out pieces on request).
    const res = await fetch(img.currentSrc || img.src, svg ? { cache: 'no-store' }
      : { cache: 'no-store', headers: { Range: `bytes=0-${PICTURE_TEXT_MAX - 1}` } });
    if (!res.ok) throw new Error(res.status === 404 ? 'file not found' : `error ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, svg ? undefined : PICTURE_TEXT_MAX);
    shown = bytes.length;
    total = +((res.headers.get('Content-Range') || '').split('/')[1]) || shown;
    text = svg ? new TextDecoder('utf-8').decode(bytes) : bytesAsNotepad(bytes);
  } catch (e) { showToast(`Could not read the picture's text: ${e.message}`); return; }
  pictureText = text;
  const lines = text.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const frag = document.createDocumentFragment();
  lines.slice(0, SRC_MAX_LINES).forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'sl';
    row.dataset.n = i + 1;
    const st = document.createElement('span');
    st.className = 'st';
    appendWithMarkers(st, l);
    row.append(st);
    frag.append(row);
  });
  const body = document.getElementById('tvBody');
  body.replaceChildren(frag);
  if (lines.length > SRC_MAX_LINES) {
    const more = document.createElement('div');
    more.className = 'src-more';
    more.textContent = `… ${fmt(lines.length - SRC_MAX_LINES)} more lines not shown`;
    body.append(more);
  }
  document.getElementById('tvTitle').textContent = imageFile(img) || 'Picture';
  document.getElementById('tvInfo').textContent =
    `${plural(lines.length, 'line')} · ${fmt(charCount(text))} characters · ` +
    (svg ? 'SVG picture (text)' : `binary picture shown as text, as Notepad would${shown < total ? ` — first ${fmt(shown)} of ${fmt(total)} bytes` : ''}`) +
    ' — read-only';
  const dlg = document.getElementById('textView');
  dlg.showModal();
  body.scrollTop = 0;
}

document.getElementById('lbText').addEventListener('click', () => showPictureText(lbImages[lbIndex]));
document.getElementById('tvClose').addEventListener('click', () => document.getElementById('textView').close());
document.getElementById('tvCopy').addEventListener('click', async () => {
  showToast(await copyToClipboard(pictureText) ? 'Copied the picture’s text.' : 'Could not copy the text.');
});

// Pictures open in the viewer one after another: ‹ › buttons and the ← → keys.
const lbPos = document.getElementById('lbPos');
let lbImages = [], lbIndex = -1;

function openImage(img) {
  lbImages = [...output.querySelectorAll('img.zoomable')];
  lbIndex = Math.max(0, lbImages.indexOf(img));
  showLightboxImage();
}

function showLightboxImage() {
  const img = lbImages[lbIndex];
  if (!img) return;
  const copy = new Image();
  copy.src = img.currentSrc || img.src;
  copy.alt = img.alt;
  // Vector pictures, and pictures that don't say how big they are (e.g. an SVG with only a viewBox), keep
  // the shape they have in the document, drawn large enough to stay sharp when zoomed.
  let w = img.naturalWidth, h = img.naturalHeight;
  const svg = /\.svgz?$/i.test((img.dataset.origSrc || '').split(/[?#]/)[0]) || /^data:image\/svg/i.test(copy.src);
  if (svg || !w || !h) {
    const r = img.getBoundingClientRect();
    const rw = r.width || w || 300, rh = r.height || h || 150;
    const k = Math.max(1, 1600 / Math.max(rw, rh));
    w = rw * k;
    h = rh * k;
  }
  copy.width = Math.round(w);
  copy.height = Math.round(h);
  const many = lbImages.length > 1;
  document.getElementById('lbPrev').hidden = document.getElementById('lbNext').hidden = !many;
  document.getElementById('lbSvg').hidden = document.getElementById('lbPng').hidden = true;
  document.getElementById('lbText').hidden = !hasPictureFile(img);
  lbDiagram = null;
  lbPos.textContent = many ? `${lbIndex + 1} / ${lbImages.length}` : '';
  openLightbox(copy, w, h, imageLabel(img), false);
}

function stepLightbox(dir) {
  if (lbIndex < 0 || lbImages.length < 2) return;
  lbIndex = (lbIndex + dir + lbImages.length) % lbImages.length;
  showLightboxImage();
}
document.getElementById('lbPrev').addEventListener('click', () => stepLightbox(-1));
document.getElementById('lbNext').addEventListener('click', () => stepLightbox(1));

function closeLightbox() {
  lightbox.hidden = true;
  lbItem.replaceChildren();
  const last = lbIndex >= 0 ? lbImages[lbIndex] : null;
  if (last && last.isConnected) last.scrollIntoView({ block: 'center' });
  lbIndex = -1;
  if (lb.returnFocus && lb.returnFocus.focus) lb.returnFocus.focus();
}

function applyLightbox() {
  lbItem.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
  lbLevel.textContent = Math.round(lb.scale * 100) + '%';
}

// Whole figure visible and centred. Small pictures are enlarged up to 3×.
function fitLightbox() {
  const pad = lbItem.classList.contains('diagram') ? 24 : 0;
  const sw = lbStage.clientWidth, sh = lbStage.clientHeight;
  lb.fit = Math.min(3, (sw * 0.94) / (lb.w + pad), (sh * 0.94) / (lb.h + pad));
  lb.scale = lb.fit;
  lb.x = (sw - (lb.w + pad) * lb.scale) / 2;
  lb.y = (sh - (lb.h + pad) * lb.scale) / 2;
  applyLightbox();
}

// Zoom keeping the point under the cursor (or the centre) in place.
function zoomLightbox(factor, cx = lbStage.clientWidth / 2, cy = lbStage.clientHeight / 2) {
  const next = Math.min(20, Math.max(0.05, lb.scale * factor));
  lb.x = cx - (cx - lb.x) * (next / lb.scale);
  lb.y = cy - (cy - lb.y) * (next / lb.scale);
  lb.scale = next;
  applyLightbox();
}

lbStage.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = lbStage.getBoundingClientRect();
  zoomLightbox(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });

let drag = null;
lbStage.addEventListener('pointerdown', ev => {
  drag = { id: ev.pointerId, x: ev.clientX - lb.x, y: ev.clientY - lb.y };
  lbStage.setPointerCapture(ev.pointerId);
  lbStage.classList.add('dragging');
});
lbStage.addEventListener('pointermove', ev => {
  if (!drag || ev.pointerId !== drag.id) return;
  lb.x = ev.clientX - drag.x;
  lb.y = ev.clientY - drag.y;
  applyLightbox();
});
const endDrag = () => { drag = null; lbStage.classList.remove('dragging'); };
lbStage.addEventListener('pointerup', endDrag);
lbStage.addEventListener('pointercancel', endDrag);
lbStage.addEventListener('dblclick', ev => {
  const r = lbStage.getBoundingClientRect();
  zoomLightbox(2, ev.clientX - r.left, ev.clientY - r.top);
});
document.getElementById('lbIn').addEventListener('click', () => zoomLightbox(1.25));
document.getElementById('lbOut').addEventListener('click', () => zoomLightbox(0.8));
lbLevel.addEventListener('click', fitLightbox);
document.getElementById('lbClose').addEventListener('click', closeLightbox);
window.addEventListener('resize', () => { if (!lightbox.hidden) fitLightbox(); });

// Images (not inside links, so badges still work as links) and diagrams open in the viewer.
function markZoomable(root) {
  root.querySelectorAll('img').forEach(img => {
    if (!img.closest('a') && !img.classList.contains('missing') && !img.classList.contains('web') && !img.classList.contains('blocked')) {
      img.classList.add('zoomable');
      img.title = img.title || 'Click to enlarge';
    }
  });
  root.querySelectorAll('pre.mermaid').forEach(pre => pre.classList.toggle('zoomable', !!pre.querySelector('svg')));
}

output.addEventListener('click', ev => {
  const math = ev.target.closest('.katex');
  if (math && !ev.target.closest('a') && window.getSelection().isCollapsed) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) {
      copyToClipboard(tex).then(ok => showToast(ok
        ? `Copied the LaTeX: ${tex.length > 70 ? tex.slice(0, 70) + '…' : tex}` : 'Could not copy the LaTeX.'));
      return;
    }
  }
  const img = ev.target.closest('img.zoomable');
  if (img) {
    openImage(img);
    return;
  }
  const pre = ev.target.closest('pre.mermaid.zoomable');
  const svg = pre && pre.querySelector('svg');
  if (svg) {
    const copy = svg.cloneNode(true);
    const vb = svg.viewBox.baseVal;
    const w = vb && vb.width ? vb.width : svg.getBoundingClientRect().width;
    const h = vb && vb.height ? vb.height : svg.getBoundingClientRect().height;
    copy.removeAttribute('style');
    copy.setAttribute('width', w);
    copy.setAttribute('height', h);
    lbImages = [];
    lbIndex = -1;
    lbDiagram = pre;
    document.getElementById('lbPrev').hidden = document.getElementById('lbNext').hidden = true;
    document.getElementById('lbSvg').hidden = document.getElementById('lbPng').hidden = false;
    document.getElementById('lbText').hidden = true;
    lbPos.textContent = '';
    openLightbox(copy, w, h, 'Diagram', true);
  }
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', ev => {
  if (!lightbox.hidden && !document.querySelector('dialog[open]')) {
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === '+' || ev.key === '=') zoomLightbox(1.25);
    else if (ev.key === '-' || ev.key === '_') zoomLightbox(0.8);
    else if (ev.key === '0') fitLightbox();
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') stepLightbox(-1);
    else if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') stepLightbox(1);
    else return;
    ev.preventDefault();
    return;
  }
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openFind(); }
  else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'h') {
    ev.preventDefault(); openFind(); if (!replaceMode) setReplaceMode(true); replaceInput.focus();
  }
  else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'z' && undoStack.length &&
           !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { ev.preventDefault(); undoEdit(); }
  else if (ev.key === 'F3') { ev.preventDefault(); if (findBar.hidden) openFind(); else stepFind(ev.shiftKey ? -1 : 1); }
  else if (ev.key === 'Escape' && !findBar.hidden && !document.querySelector('dialog[open]')) closeFind();
  else if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'b') { ev.preventDefault(); toggleSidebar(); }
  else if (ev.altKey && !mod && ev.key === 'ArrowLeft') { ev.preventDefault(); goBack(); }
  else if (ev.altKey && !mod && ev.key === 'ArrowRight') { ev.preventDefault(); goForward(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); toggleToc(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'g') { ev.preventDefault(); toggleImages(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'l') { ev.preventDefault(); toggleLinks(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'u') { ev.preventDefault(); toggleSource(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'h') { ev.preventDefault(); toggleHidden(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'b') { ev.preventDefault(); togglePictures(); }
  else if (ev.key === 'Escape' && 'tocOpen' in document.documentElement.dataset) {
    delete document.documentElement.dataset.tocOpen;
    updateTocButton();
  }
  else if (ev.key === 'Escape' && 'imgsOpen' in document.documentElement.dataset && !document.querySelector('dialog[open]')) closeImages();
  else if (ev.key === 'Escape' && 'linksOpen' in document.documentElement.dataset && !document.querySelector('dialog[open]')) closeLinks();
  else if (ev.key === 'Escape' && srcIsOpen() && !document.querySelector('dialog[open]')) closeSource();
});

// ---------------------------------------------------------------- export as a web page
// One self-contained .html file: the document as shown (light theme), with its pictures, math fonts and
// diagrams embedded. No scripts, and a security policy in the file that forbids them; web pictures are
// left out (this app never goes online).
const toDataURL = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function inlineKatexCss() {
  const css = await (await fetch('lib/katex/katex.min.css')).text();
  const fonts = new Map();
  for (const m of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) {
    if (!fonts.has(m[1])) fonts.set(m[1], await toDataURL(await (await fetch('lib/katex/' + m[1])).blob()));
  }
  return css.replace(/,\s*url\(fonts\/[^)]+\.(woff|ttf)\)\s*format\("[^"]+"\)/g, '')
            .replace(/url\((fonts\/[^)]+\.woff2)\)/g, (all, f) => `url(${fonts.get(f)})`);
}

async function exportHtml() {
  if (!currentPath) return;
  const base = currentPath.split('/').pop().replace(MD_RE, '');
  const dark = isDark();
  showToast('Preparing the web page…');
  try {
    if (dark) await renderDiagrams(output, 'default');
    const clone = output.cloneNode(true);
    if (dark) await renderDiagrams(output);
    clone.querySelectorAll('.code-copy, .hc-badge, .print-toc, .table-bar').forEach(e => e.remove());
    let pictures = 0, left = 0;
    for (const img of clone.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (!src || img.classList.contains('web') || img.classList.contains('missing')) {
        const note = document.createElement('span');
        note.textContent = `[picture not included: ${img.dataset.webSrc || img.dataset.origSrc || img.alt || ''}]`;
        img.replaceWith(note);
        left++;
        continue;
      }
      try { img.src = await toDataURL(await (await fetch(src)).blob()); img.removeAttribute('srcset'); pictures++; }
      catch { img.remove(); left++; }
    }
    clone.querySelectorAll('video, audio').forEach(m => {
      const note = document.createElement('span');
      note.textContent = `[${m.tagName.toLowerCase()} not included: ${m.dataset.origSrc || ''}]`;
      m.replaceWith(note);
    });
    clone.querySelectorAll('a').forEach(a => {
      if (a.dataset.origHref && !a.classList.contains('link-disabled')) a.setAttribute('href', a.dataset.origHref);
      a.removeAttribute('target');
    });
    clone.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
      el.classList.remove('zoomable', 'img-flash', 'link-broken');
      if (/^(Click to enlarge|Click to copy the LaTeX)$/.test(el.getAttribute('title') || '')) el.removeAttribute('title');
    });

    let katexCss = '', hlCss = '';
    try { katexCss = await inlineKatexCss(); } catch { }
    try { hlCss = await (await fetch('lib/highlight/styles/github.min.css')).text(); } catch { }
    const appCss = document.querySelector('head style').textContent;
    const html = `<!DOCTYPE html>
<html lang="${document.documentElement.lang || 'en'}" data-theme="light">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Markdown Viewer (WebView2)">
<title>${esc(base)}</title>
<style>${katexCss}</style>
<style>${hlCss}</style>
<style>${appCss}</style>
<style>
html, body { height: auto !important; overflow: visible !important; display: block !important; background: #fff; }
body > .markdown-body { contain: none; max-width: 980px; margin: 0 auto; padding: 2rem 2rem 4rem; }
.code-copy { display: none !important; }
</style>
</head>
<body>
<article class="markdown-body">
${clone.innerHTML}
</article>
</body>
</html>
`;
    const saved = await saveFileAs(new Blob([html], { type: 'text/html;charset=utf-8' }), base + '.html',
      { description: 'Web page', accept: { 'text/html': ['.html', '.htm'] } });
    if (saved) showToast(`Saved “${saved}” — one file with ${plural(pictures, 'picture')}, no scripts.` +
      (left ? ` ${plural(left, 'web or missing picture')} left out.` : ''));
  } catch (e) { showToast(`Saving the web page failed: ${e.message}`); }
}

// ---------------------------------------------------------------- PDF
const pdfBtn = document.getElementById('pdfBtn');
pdfBtn.addEventListener('click', async () => {
  if (!currentPath) return;
  pdfBtn.disabled = true;
  const oldTitle = document.title;
  const dark = isDark();
  try {
    // Wait for every figure to finish loading so none are blank in the PDF.
    await Promise.all([...output.querySelectorAll('img')].map(img =>
      img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    if (dark) await renderDiagrams(output, 'default');
    // The browser uses the page title as the suggested PDF file name.
    const name = currentPath.split('/').pop().replace(MD_RE, '');
    document.title = name;
    const contents = addPrintContents();
    // File name at the top of every page, "page / pages" at the bottom.
    const css = s => '"' + s.replace(/[\\"]/g, m => '\\' + m).replace(/[\r\n]/g, ' ') + '"';
    const pageStyle = document.createElement('style');
    pageStyle.textContent = `@page { margin: 16mm 14mm 18mm;
      @top-center { content: ${css(name)}; font: 9pt system-ui, sans-serif; color: #666; }
      @bottom-center { content: counter(page) " / " counter(pages); font: 9pt system-ui, sans-serif; color: #666; } }`;
    document.head.append(pageStyle);
    let done = false;
    const cleanup = async () => {
      if (done) return;
      done = true;
      contents?.remove();
      pageStyle.remove();
      document.title = oldTitle;
      if (dark) await renderDiagrams(output);
      pdfBtn.disabled = false;
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  } catch (e) {
    document.title = oldTitle;
    pdfBtn.disabled = false;
    showToast(`Printing failed: ${e.message}`);
  }
});

// A contents page at the start of the PDF (documents with 3 or more headings), with links to each part.
function addPrintContents() {
  const heads = [...output.querySelectorAll('h1[id], h2[id], h3[id]')];
  if (heads.length < 3) return null;
  const top = Math.min(...heads.map(h => +h.tagName[1]));
  const nav = document.createElement('nav');
  nav.className = 'print-toc';
  const title = document.createElement('div');
  title.className = 'print-toc-title';
  title.textContent = 'Contents';
  const ol = document.createElement('ol');
  for (const h of heads) {
    const li = document.createElement('li');
    li.style.setProperty('--lvl', +h.tagName[1] - top);
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.trim();
    li.append(a);
    ol.append(li);
  }
  nav.append(title, ol);
  output.prepend(nav);
  return nav;
}

// ---------------------------------------------------------------- inputs
picker.addEventListener('change', () => {
  loadEntries([...picker.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
  picker.value = '';
});
filePicker.addEventListener('change', () => {
  loadEntries([...filePicker.files].map(f => ({ path: f.name, file: f })));
  filePicker.value = '';
});
filter.addEventListener('input', buildList);

// Drag & drop a folder (or files) anywhere on the page.
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const items = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  const out = [];
  if (items.length) {
    for (const it of items) await walk(it, '', out);
  } else {
    for (const f of e.dataTransfer.files) out.push({ path: f.name, file: f });
  }
  if (out.length) loadEntries(out);
});

async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    if (/^(node_modules|\.git)$/i.test(entry.name)) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child, prefix + entry.name + '/', out);
    } while (batch.length);
  }
}

// ---------------------------------------------------------------- About
// Every library is bundled with the app (lib folder; marked next to the page). Versions are the bundled
// copies' versions; the "running" version is read from the library itself where it reports one.
const LIBRARIES = [
  { name: 'marked', version: '18.1.0', use: 'Markdown → HTML', match: /marked/i,
    loaded: () => typeof window.marked?.Marked === 'function' },
  { name: 'KaTeX', version: '0.19.0', use: 'Math equations', match: /katex/i,
    loaded: () => typeof window.katex?.renderToString === 'function', actual: () => window.katex?.version },
  { name: 'highlight.js', version: '11.12.0', use: 'Code colouring', match: /highlight/i,
    loaded: () => typeof window.hljs?.highlightElement === 'function', actual: () => window.hljs?.versionString },
  { name: 'Mermaid', version: '12.1.0', use: 'Diagrams (```mermaid)', match: /mermaid/i,
    loaded: () => typeof window.mermaid?.render === 'function' }
];

const APP_EXE = 'MarkdownViewerWebView2.exe';
let appInfo = null;   // set by initApp() inside the app

// The browser showing the page when it was opened directly (inside the app, the WebView2 Runtime version is used).
function browserName() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const b = brands.find(x => !/not.?a.?brand/i.test(x.brand) && x.brand !== 'Chromium') || brands.find(x => x.brand === 'Chromium');
  if (b) return `${b.brand} ${b.version}`;
  const m = /(Edg|Firefox|Chrome|Safari)\/([\d.]+)/.exec(navigator.userAgent);
  return m ? `${m[1] === 'Edg' ? 'Microsoft Edge' : m[1]} ${m[2]}` : 'Web browser';
}

// "Built with": what the app is made from, with live versions/availability where they can be detected.
function builtWith() {
  const feature = (name, use, ok) => `${ok ? '✓' : '✗'} ${name} — ${use}`;
  return [
    { name: 'Windows app', detail: appInfo ? `${APP_EXE} ${appInfo.version}` : `${APP_EXE} (not used — page opened directly)`,
      use: 'Opens .md files from Explorer and hands the document folder to the viewer window — no network port',
      items: ['C# 5, compiled with csc.exe from .NET Framework 4 (included with Windows)' + (appInfo && appInfo.runtime ? ` — runtime ${appInfo.runtime}` : ''),
              'WebView2 control (Microsoft.Web.WebView2 SDK) — every request is answered inside the program',
              'Windows Forms for the app window and native message boxes'] },
    { name: 'Window',
      detail: appInfo && appInfo.webview2Runtime ? `WebView2 Runtime ${appInfo.webview2Runtime}` : browserName(),
      use: appInfo ? 'The Edge engine embedded in the program’s own window (WebView2 Runtime)' : 'The browser this page is open in',
      items: appInfo && appInfo.webview2Sdk ? [`WebView2 SDK ${appInfo.webview2Sdk} (Microsoft.Web.WebView2) — built into ${APP_EXE}`] : [] },
    { name: 'Installer', detail: 'PowerShell 5.1 scripts',
      use: 'Build, install and uninstall for the current user — no admin rights',
      items: ['build.ps1 — compiles the app, packs the page and libraries into MarkdownViewerWebView2.Content.dll, signs both (Authenticode) and makes the icon (System.Drawing)',
              'install.ps1 / Uninstall.exe — per-user .md file association (HKCU registry), Start menu shortcuts, Settings › Apps entry'] },
    { name: 'Viewer', detail: 'HTML, CSS and JavaScript (viewer.html + viewer.js), no frameworks',
      use: 'Renders, counts, inspects, finds and exports',
      items: [
        feature('Intl.Segmenter', 'word and sentence counts in any language', typeof Intl !== 'undefined' && !!Intl.Segmenter),
        feature('CSS Custom Highlight API', 'Find highlights without changing the document', canHighlight),
        feature('File System Access API', 'Save As dialog for Export and Save', !!window.showSaveFilePicker),
        feature('TextDecoder', 'reading UTF-8, UTF-16 and Windows-1252 files', typeof TextDecoder === 'function'),
        feature('Clipboard API', 'Copy clean', !!(navigator.clipboard && navigator.clipboard.writeText)),
        feature('DOMParser + Content-Security-Policy', 'preview-only safety: documents never run code', typeof DOMParser === 'function'),
        feature('Fetch', 'loading documents from the app', typeof fetch === 'function')
      ] },
    { name: 'Made using', detail: 'AI coding assistants',
      use: 'Who made it',
      items: ['Created by Shaimaa Soltan',
              'Original viewer: made using GPT-5 (as noted in the footer)',
              'This version: extended and tested with Claude Code (Anthropic)'] }
  ];
}

function renderBuiltWith() {
  const list = document.getElementById('toolList');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  list.replaceChildren();
  for (const t of builtWith()) {
    const card = el('div', 'lib');
    const head = el('div', 'lib-head');
    head.append(el('span', 'lib-name', t.name), el('span', 'lib-use', t.detail));
    card.append(head, el('div', 'tool-use', t.use));
    if (t.items.length) {
      const ul = el('ul', 'lib-src tool-items');
      for (const i of t.items) {
        const li = el('li', i.startsWith('✗') ? 'bad' : i.startsWith('✓') ? 'ok-item' : '', i);
        ul.appendChild(li);
      }
      card.append(ul);
    }
    list.appendChild(card);
  }
}

function showAbout() {
  renderBuiltWith();
  const files = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href'));
  const list = document.getElementById('libList');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  list.replaceChildren();
  for (const lib of LIBRARIES) {
    const actual = lib.actual && lib.actual();
    const ok = lib.loaded();
    const card = el('div', 'lib');
    const head = el('div', 'lib-head');
    head.append(
      el('span', 'lib-name', `${lib.name} ${actual && actual !== lib.version ? `${lib.version} (running ${actual})` : lib.version}`),
      el('span', 'lib-use', lib.use),
      el('span', ok ? 'ok' : 'bad', ok ? '✓ loaded' : '✗ not loaded'));
    const src = el('ul', 'lib-src');
    const where = appInfo?.signature ? `inside the signed ${appInfo.signature.content}` : 'bundled';
    for (const f of files.filter(u => lib.match.test(u))) src.appendChild(el('li', '', `${f} (${where})`));
    card.append(head, src);
    list.appendChild(card);
  }
  // Details of the app, when the page runs inside it.
  const appSection = document.getElementById('appSection');
  appSection.hidden = !appInfo;
  document.getElementById('appSectionNote').hidden = !!appInfo;
  if (appInfo) {
    const dl = document.getElementById('appInfo');
    dl.replaceChildren();
    const wv = appInfo.webview2Runtime
      ? `Runtime ${appInfo.webview2Runtime}` + (appInfo.webview2Sdk ? ` · SDK ${appInfo.webview2Sdk}` : '')
      : 'Runtime version not reported';
    const rows = [
      ['Version', `${appInfo.name} ${appInfo.version}`],
      ['Installed in', appInfo.installDir],
      ['Can read files under', appInfo.readableFolder || '—'],
      ['File types it will read', appInfo.servedTypes],
      ['Everything else', 'Refused (HTML, scripts, PDFs, programs, …)'],
      ['Connection', 'Private in-app address — every request is answered by the program itself; no network port'],
      ['Developer tools', 'Off (no F12 / Inspect). Documents are refused if WebView2 debugging has been switched on'],
      ['WebView2', wv]
    ];
    const sig = appInfo.signature;
    if (sig) rows.splice(2, 0, ['Signed', `Program and ${sig.content} (the page and every library — no loose script files) ` +
      `signed by “${sig.signer}”, checked at every start; WebView2 files signed by Microsoft. Certificate ${sig.thumbprint}` +
      (sig.trusted ? ' — trusted by Windows' : ' — made on this PC, not in Windows’ trusted list')]);
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
    // Firewall: shown from the last check, then refreshed.
    const fwDd = el('dd');
    fwDd.id = 'fwRow';
    fillFirewallRow(fwDd);
    dl.append(el('dt', '', 'Firewall rules'), fwDd);
    fetchFirewall();
  }
  const about = document.getElementById('about');
  about.showModal();
  about.scrollTop = 0;          // start at the top (title and author), not at the focused Close button
}
document.getElementById('aboutBtn').addEventListener('click', showAbout);
document.getElementById('aboutClose').addEventListener('click', () => document.getElementById('about').close());

// ---------------------------------------------------------------- app start-up
async function initApp() {
  // Let the deferred diagram library finish loading first.
  if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r));
  let info;
  try { info = await (await fetch(apiBase + 'info')).json(); }
  catch { return; }
  appInfo = info.app || null;
  renderConnStatus();
  fetchFirewall();
  setInterval(fetchFirewall, 60000);

  const file = new URLSearchParams(location.search).get('file') || info.file;
  if (!file) return;
  source = 'app';
  repoRoot = info.repoRoot || dirOf(file);
  listBase = info.dir || dirOf(file);
  mdPaths = (info.files || [])
    .sort((a, b) => depth(a) - depth(b) || isReadme(b) - isReadme(a) || a.localeCompare(b));
  updateSidebarAvailability();
  buildList();
  await openDoc(file);
}

// Status line under the document path.
function renderConnStatus() {
  const box = document.getElementById('connStatus');
  document.getElementById('appStatus').hidden = false;
  box.replaceChildren('🔒 Private in-app connection — no network port');
  box.title = 'This window shows documents through WebView2; nothing listens on the network';
}

// ---------------------------------------------------------------- firewall status
// Nothing listens on the network, so no firewall rules are needed; the app reports that, whether the
// block rules Setup adds for its program are in place, and whether Windows Firewall itself is on.
let firewall = null;
const firewallOk = () => !!(firewall && firewall.readable && (firewall.state === 'nonetwork' || firewall.state === 'blocked'));

async function fetchFirewall() {
  try { firewall = await (await fetch(apiBase + 'firewall')).json(); } catch { /* app closed */ }
  renderFirewall();
}

function renderFirewall() {
  const badge = document.getElementById('fwBadge');
  if (!APP || !firewall) return;
  document.getElementById('appStatus').hidden = false;
  badge.hidden = false;
  badge.className = 'breakdown-btn ' + (firewallOk() ? 'ok' : 'bad');
  badge.textContent = `🛡 Firewall: ${firewallOk() ? firewall.label || 'no network port' : 'status unknown'}`;
  badge.title = `${firewall.summary}. ${firewall.detail} — click for details`;
  // Keep the About window's row current if it's open.
  const row = document.getElementById('fwRow');
  if (row) fillFirewallRow(row);
}

function fillFirewallRow(dd) {
  dd.className = firewallOk() ? 'fw-ok' : 'fw-bad';
  dd.replaceChildren();
  if (!firewall) { dd.textContent = '…'; return; }
  dd.append(`${firewallOk() ? '✓' : '✗'} ${firewall.summary}` + (firewall.readable ? (firewall.firewallOn ? ' · Windows Firewall on' : ' · Windows Firewall OFF') : ''));
  const detail = document.createElement('span');
  detail.className = 'fw-detail';
  detail.textContent = firewall.detail + (firewall.rules && firewall.rules.length ? ` Rules: ${firewall.rules.join(', ')}.` : '');
  dd.append(detail);
}
document.getElementById('fwBadge').addEventListener('click', () => showAbout());

if (APP) initApp();

// The app's name tag in the header.
{
  const tag = document.createElement('span');
  tag.className = 'app-tag';
  tag.textContent = 'WebView2';
  tag.title = 'Own window, bundled libraries, no network port';
  document.querySelector('header h1').append(' ', tag);
}

// Opened directly in a browser (not inside the app): say what's missing and how to get it.
if (!APP) {
  const note = document.getElementById('standaloneNote');
  let dismissed = false;
  try { dismissed = localStorage.getItem('mdv-standalone-note') === 'hidden'; } catch {}
  note.hidden = dismissed;
  document.getElementById('standaloneClose').addEventListener('click', () => {
    note.hidden = true;
    try { localStorage.setItem('mdv-standalone-note', 'hidden'); } catch {}
  });
}
