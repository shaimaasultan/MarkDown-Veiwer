// Markdown Folder Viewer — page logic (kept out of ReadMe.html so the page can forbid inline scripts).
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

// Desktop app mode: opened by MarkdownViewer.exe, which serves files from disk at <token>/fs/<path>.
const APP = (location.hostname === '127.0.0.1' || location.hostname === 'mdviewer.local') && /\/app\/[^/]*$/.test(location.pathname);
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

// github.com/.../blob/... image links don't render as images; use the raw file instead.
function fixRemote(href) {
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/i.exec(href || '');
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2].split('?')[0]}` : null;
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
  'http-equiv', 'xmlns:xlink', 'popover', 'popovertarget', 'popovertargetaction', 'nonce']);

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
      ok = !/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i.test(value);
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
  if (!html) html = `<code class="math-raw" title="Math renderer unavailable (offline?)">${esc(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
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

const md = new marked.Marked({ gfm: true });
md.use({
  extensions: [mathBlock, mathInline],
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
    .filter(p => MD_RE.test(p) && !SKIP_DIRS.test(p))
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
      : `File not found: ${path}`);
    return { path, ...decodeBytes(await res.arrayBuffer()) };
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

async function openDoc(path, anchor) {
  if (isEdited() && key(path) !== key(currentPath || '') &&
      !confirm('This document has unsaved replacements. Open another document and discard them?')) return;
  let entry;
  try { entry = await readDoc(path); }
  catch (e) { alert(e.message); return; }
  currentPath = entry.path;
  if (source === 'app') history.replaceState(null, '', '?file=' + encodeURIComponent(entry.path));
  currentSource = entry.text;
  currentInfo = entry.info;
  resetEdits();
  renderDoc({ anchor });
}

// Renders currentSource (the file as read, or as edited by Find & Replace).
function renderDoc({ anchor = null, keepScroll = false } = {}) {
  const scroll = content.scrollTop;
  const text = currentSource.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // strip YAML front matter

  slugCounts = new Map();
  dropHint.hidden = true;
  output.replaceChildren(sanitize(md.parse(text)));

  fixResources(output, dirOf(currentPath));
  renderLeftoverMath(output);
  highlightCode(output);
  markHiddenChars(output);
  markZoomable(output);
  buildToc();

  document.getElementById('docPath').textContent = currentPath + (isEdited() ? '  •  edited (unsaved)' : '');
  updateStats();
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
  for (const li of fileList.children) li.classList.toggle('active', key(li.dataset.path) === key(currentPath));

  if (keepScroll) content.scrollTop = scroll;
  else if (anchor) scrollToAnchor(anchor);
  else content.scrollTop = 0;
}

// Local files a link may open in a new window. Anything that could run code when opened directly
// (HTML, SVG, scripts, PDFs, programs, …) is never linked; the link text stays but is inactive.
const OPENABLE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mp3|wav|ogg|txt)$/i;

// Point images/figures/links at the files inside the chosen folder.
function fixResources(root, baseDir) {
  root.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach(el => {
    const src = el.getAttribute('src');
    const entry = localEntry(baseDir, src);
    const isImg = el.tagName === 'IMG';
    if (entry) {
      if (isImg && source === 'app') el.addEventListener('error', () => markMissing(el, src, baseDir), { once: true });
      el.src = blobURL(entry);
      return;
    }
    const raw = fixRemote(src);
    if (raw && isImg) { el.src = raw; return; }
    if (!isExternal(src) && isImg) markMissing(el, src, baseDir);
  });
  root.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
    el.srcset = el.getAttribute('srcset').split(',').map(part => {
      const [url, ...rest] = part.trim().split(/\s+/);
      const entry = localEntry(baseDir, url);
      return [entry ? blobURL(entry) : url, ...rest].join(' ');
    }).join(', ');
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      a.addEventListener('click', ev => { ev.preventDefault(); scrollToAnchor(href.slice(1)); });
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      a.target = '_blank';
      return;
    }
    const entry = isExternal(href) ? null : (localEntry(baseDir, href) || { path: resolve(baseDir, href), missing: true });
    if (entry && MD_RE.test(entry.path)) {
      const anchor = href.includes('#') ? href.split('#')[1] : '';
      a.addEventListener('click', ev => { ev.preventDefault(); openDoc(entry.path, anchor); });
    } else if (entry && !entry.missing && OPENABLE.test(entry.path)) {
      a.href = blobURL(entry);
      a.target = '_blank';
    } else {
      disableLink(a, entry && !entry.missing
        ? 'Opening this type of file is disabled in preview mode'
        : 'Link target not available');
    }
  });
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
  const linkEls = [...output.querySelectorAll('a')].filter(a => a.hasAttribute('href') || a.classList.contains('link-disabled'));
  const disabledLinks = linkEls.filter(a => a.classList.contains('link-disabled')).length;

  const images = output.querySelectorAll('img').length;
  const missing = output.querySelectorAll('img.missing').length;
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
      [plural(images, 'image') + (missing ? ` (${fmt(missing)} missing)` : ''),
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
    btn, insBtn);
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
    catch (e) { if (e.name === 'AbortError') return; }
    if (handle) {
      try { const w = await handle.createWritable(); await w.write(blob); await w.close(); }
      catch (e) { showToast(`Saving failed: ${e.message}`); return; }
      done(`Saved “${handle.name}” (UTF-8).` + (currentInfo && !/UTF-8|ASCII/.test(currentInfo.name) ? ` The original was ${currentInfo.name}.` : ''));
      return;
    }
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
    catch (e) { if (e.name === 'AbortError') return; handle = null; }      // cancelled → nothing to do
    if (handle) {
      try {
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        savedAs = handle.name;
      } catch (e) { showToast(`Saving failed: ${e.message}`); return; }
      showToast(`Saved “${savedAs}” (UTF-8, ${fmt(charCount(r.text))} characters). ${cleanSummary(r)}`);
      return;
    }
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
  if (open) copyMenu.querySelector('button').focus();
}
copyBtn.addEventListener('click', ev => { ev.stopPropagation(); setCopyMenu(copyMenu.hidden); });
copyMenu.addEventListener('click', ev => {
  const item = ev.target.closest('[data-action]');
  if (!item) return;
  setCopyMenu(false);
  if (item.dataset.action === 'save') saveClean(item.dataset.what);
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
          book(CAT.entity, 0, len(t.text) - len(v), W(t.text) - W(v));
          book(CAT.other, 0, len(raw) - len(t.text), W(raw) - W(t.text));
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
        bookContainer(CAT.quoteMarks, raw, (t.tokens || []).map(c => c.raw).join(''));
        return blocks(t.tokens);
      }
      case 'list': {
        bookContainer(CAT.listMarks, raw, t.items.map(i => i.raw).join(''));
        const out = [];
        for (const item of t.items) {
          const inner = (item.tokens || []).map(c => c.raw).join('');
          const task = item.task ? /^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s*)/.exec(item.raw) : null;
          if (task) book(CAT.taskBoxes, 0, len(task[1]) - 1, W(task[1]));   // the box is drawn followed by a space
          // (the task text "[x] " is part of the item's markers, not of its content)
          bookContainer(CAT.listMarks, item.raw, task ? task[1] + inner : inner);
          if (task) book(CAT.listMarks, 0, 0, W(task[1] + inner) - W(task[1]) - W(inner));   // keep word sums exact
          const v = blocks(item.tokens);
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

async function renderDiagrams(root, forceTheme) {
  const nodes = root.querySelectorAll('pre.mermaid');
  if (!nodes.length || typeof window.mermaid?.render !== 'function') return;
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',   // no click handlers / links that run code inside diagrams
      theme: forceTheme || (isDark() ? 'dark' : 'default')
    });
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
// Remembered view settings. The Windows app stores them itself (each window has a new local
// address, so browser storage would forget them) and puts them on <html data-…> before the page
// is shown; the standalone page uses localStorage. The first value is the default.
const PREFS = { theme: ['auto', 'light', 'dark'], sidebar: ['shown', 'hidden'], toc: ['shown', 'hidden'], hiddenchars: ['off', 'on'],
                rotate: ['15', 'off', '5', '30', '60'] };

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
  const open = narrowScreen.matches ? 'tocOpen' in document.documentElement.dataset : loadPrefLive('toc') === 'shown';
  tocBtn.classList.toggle('on', open && !tocBtn.disabled);
}

function toggleToc() {
  if (tocBtn.disabled) return;
  const root = document.documentElement;
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
});
setRootPref('toc', loadPref('toc'));
setRootPref('hiddenchars', loadPref('hiddenchars'));
updateHiddenButton();

// ---------------------------------------------------------------- figure viewer (zoom & pan)
const lightbox = document.getElementById('lightbox');
const lbStage = document.getElementById('lbStage');
const lbItem = document.getElementById('lbItem');
const lbLevel = document.getElementById('lbLevel');
const lb = { scale: 1, x: 0, y: 0, w: 0, h: 0, fit: 1, returnFocus: null };

function openLightbox(node, width, height, caption, isDiagram) {
  lbItem.replaceChildren(node);
  lbItem.classList.toggle('diagram', isDiagram);
  document.getElementById('lbCaption').textContent = caption;
  lb.w = Math.max(1, width);
  lb.h = Math.max(1, height);
  lb.returnFocus = document.activeElement;
  lightbox.hidden = false;
  fitLightbox();
  document.getElementById('lbClose').focus();
}

function closeLightbox() {
  lightbox.hidden = true;
  lbItem.replaceChildren();
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
    if (!img.closest('a') && !img.classList.contains('missing')) {
      img.classList.add('zoomable');
      img.title = img.title || 'Click to enlarge';
    }
  });
  root.querySelectorAll('pre.mermaid').forEach(pre => pre.classList.toggle('zoomable', !!pre.querySelector('svg')));
}

output.addEventListener('click', ev => {
  const img = ev.target.closest('img.zoomable');
  if (img) {
    const copy = new Image();
    copy.src = img.currentSrc || img.src;
    copy.alt = img.alt;
    const name = decodeURIComponent((img.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop() || '');
    openLightbox(copy, img.naturalWidth || img.width, img.naturalHeight || img.height, img.alt || name || 'Figure', false);
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
    openLightbox(copy, w, h, 'Diagram', true);
  }
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', ev => {
  if (!lightbox.hidden) {
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === '+' || ev.key === '=') zoomLightbox(1.25);
    else if (ev.key === '-' || ev.key === '_') zoomLightbox(0.8);
    else if (ev.key === '0') fitLightbox();
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
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'o') { ev.preventDefault(); toggleToc(); }
  else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'h') { ev.preventDefault(); toggleHidden(); }
  else if (ev.key === 'Escape' && 'tocOpen' in document.documentElement.dataset) {
    delete document.documentElement.dataset.tocOpen;
    updateTocButton();
  }
});

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
    document.title = currentPath.split('/').pop().replace(MD_RE, '');
    window.print();
  } finally {
    document.title = oldTitle;
    if (dark) await renderDiagrams(output);
    pdfBtn.disabled = false;
  }
});

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
// Versions and online addresses come from the <script>/<link> tags in ReadMe.html, so this list can't
// drift from what is actually loaded. marked is bundled locally; its online copy is listed for reference.
const LIBRARIES = [
  { name: 'marked', use: 'Markdown → HTML', match: /marked/i, version: '15.0.12',
    bundled: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js',
    loaded: () => typeof window.marked?.Marked === 'function' },
  { name: 'KaTeX', use: 'Math equations', match: /katex/i,
    loaded: () => typeof window.katex?.renderToString === 'function', actual: () => window.katex?.version },
  { name: 'highlight.js', use: 'Code colouring', match: /highlight/i,
    loaded: () => typeof window.hljs?.highlightElement === 'function', actual: () => window.hljs?.versionString },
  { name: 'Mermaid', use: 'Diagrams (```mermaid)', match: /mermaid/i,
    loaded: () => typeof window.mermaid?.render === 'function' }
];

let appInfo = null;   // set by initApp() inside the Windows app

// Edition: "online" (libraries from the internet) or "offline" (every library bundled in ./lib/).
const metaContent = name => (document.querySelector(`meta[name="${name}"]`) || {}).content || '';
const EDITION = ['offline', 'webview2'].includes(metaContent('mdv-edition')) ? metaContent('mdv-edition') : 'online';
// Offline edition: versions of the bundled copies, recorded by build.ps1 ("KaTeX=0.16.22;…").
const BUNDLED_VERSIONS = Object.fromEntries(metaContent('mdv-lib-versions').split(';').filter(Boolean).map(p => p.split('=')));
const APP_EXE = { online: 'MarkdownViewer.exe', offline: 'MarkdownViewerOffline.exe', webview2: 'MarkdownViewerWebView2.exe' }[EDITION];
const APP_TITLE = { online: 'Markdown Viewer', offline: 'Markdown Viewer (Offline)', webview2: 'Markdown Viewer (WebView2)' }[EDITION];

// "Built with": what the app is made from, with live versions/availability where they can be detected.
// Browsers report a shortened version by default ("154.0.0.0"); the full one has to be asked for.
let fullEdgeVersion = null;
if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
  navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then(v => {
    const edge = (v.fullVersionList || []).find(b => b.brand === 'Microsoft Edge');
    if (edge) fullEdgeVersion = edge.version;
  }).catch(() => {});
}

function edgeVersion() {
  if (fullEdgeVersion) return fullEdgeVersion;
  const m = /Edg\/([\d.]+)/.exec(navigator.userAgent);
  return m ? m[1] : null;
}

// The browser showing the page: "Microsoft Edge 1xx" in the Windows app, otherwise the real engine name.
function browserName() {
  if (edgeVersion()) return `Microsoft Edge ${edgeVersion()}`;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const b = brands.find(x => !/not.?a.?brand/i.test(x.brand) && x.brand !== 'Chromium') || brands.find(x => x.brand === 'Chromium');
  if (b) return `${b.brand} ${b.version}`;
  const m = /(Firefox|Chrome|Safari)\/([\d.]+)/.exec(navigator.userAgent);
  return m ? `${m[1]} ${m[2]}` : 'Web browser';
}

function builtWith() {
  const feature = (name, use, ok) => `${ok ? '✓' : '✗'} ${name} — ${use}`;
  return [
    { name: 'Edition', detail: {
        online: 'Online — math, code colouring and diagrams load from the internet',
        offline: 'Offline — every library is bundled; no internet needed',
        webview2: 'WebView2 — own window, every library bundled, no network port' }[EDITION],
      use: {
        online: 'Offline and WebView2 editions can be installed alongside this one',
        offline: 'The window’s security policy allows no internet addresses at all',
        webview2: 'Documents are handed to the page inside the program; nothing listens on the network' }[EDITION],
      items: [] },
    { name: 'Windows app', detail: appInfo ? `${APP_EXE} ${appInfo.version}` : `${APP_EXE} (not used — page opened directly)`,
      use: 'Opens .md files from Explorer and serves the document folder to the viewer window',
      items: ['C# 5, compiled with csc.exe from .NET Framework 4 (included with Windows)' + (appInfo && appInfo.runtime ? ` — runtime ${appInfo.runtime}` : ''),
              EDITION === 'webview2'
                ? 'WebView2 control (Microsoft.Web.WebView2 SDK) — requests are answered inside the program, no network port'
                : 'Built-in local web server (System.Net.Sockets), bound to 127.0.0.1 only, with a random access token',
              'Windows Forms for the app window and native message boxes'] },
    { name: 'Window',
      detail: appInfo && appInfo.webview2Runtime ? `WebView2 Runtime ${appInfo.webview2Runtime}` : browserName(),
      use: !appInfo ? 'The browser this page is open in'
         : EDITION === 'webview2' ? 'The Edge engine embedded in the program’s own window (WebView2 Runtime)'
         : 'Shows the viewer as an app window (Edge --app mode, Chromium engine)',
      items: appInfo && appInfo.webview2Sdk ? [`WebView2 SDK ${appInfo.webview2Sdk} (Microsoft.Web.WebView2) — built into ${APP_EXE}`] : [] },
    { name: 'Installer', detail: 'PowerShell 5.1 scripts',
      use: 'Build, install and uninstall for the current user — no admin rights',
      items: ['build.ps1 — compiles the app and makes the icon (System.Drawing)',
              'install.ps1 / uninstall.ps1 — per-user .md file association (HKCU registry), Start menu shortcuts, Settings › Apps entry'] },
    { name: 'Viewer', detail: 'HTML, CSS and JavaScript (ReadMe.html + viewer.js), no frameworks',
      use: 'Renders, counts, inspects, finds and exports',
      items: [
        feature('Intl.Segmenter', 'word and sentence counts in any language', typeof Intl !== 'undefined' && !!Intl.Segmenter),
        feature('CSS Custom Highlight API', 'Find highlights without changing the document', canHighlight),
        feature('File System Access API', 'Save As dialog for Export and Save', !!window.showSaveFilePicker),
        feature('TextDecoder', 'reading UTF-8, UTF-16 and Windows-1252 files', typeof TextDecoder === 'function'),
        feature('Clipboard API', 'Copy clean', !!(navigator.clipboard && navigator.clipboard.writeText)),
        feature('DOMParser + Content-Security-Policy', 'preview-only safety: documents never run code', typeof DOMParser === 'function'),
        feature('Fetch', 'loading documents from the Windows app', typeof fetch === 'function')
      ] },
    { name: 'Made using', detail: 'AI coding assistants',
      use: 'Who wrote the code',
      items: ['Original viewer: made using GPT-5 (as noted in the footer)',
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

function rotationText() {
  if (!rotation) return '…';
  if (rotation.rotate) return 'Now — the window moves at the next quiet moment';
  const s = secsLeft('nextRotationSeconds');
  if (s < 0) return 'Never (changes are off)';
  return `in ${clock(s)}`;
}

function showAbout() {
  renderBuiltWith();
  if (EDITION !== 'online')
    document.getElementById('libNote').textContent = 'All bundled with the app (in its lib folder) — nothing is loaded from the internet, so math, code colouring and diagrams work fully offline.';
  const tags = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href'));
  const list = document.getElementById('libList');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  list.replaceChildren();
  for (const lib of LIBRARIES) {
    const urls = tags.filter(u => lib.match.test(u) && /^https?:/i.test(u));
    const local = tags.filter(u => lib.match.test(u) && !/^https?:/i.test(u));
    const wanted = lib.version || (urls.join(' ').match(/[@/](\d+\.\d+\.\d+)\//) || [])[1] || BUNDLED_VERSIONS[lib.name] || '?';
    const actual = lib.actual && lib.actual();
    const ok = lib.loaded();

    const card = el('div', 'lib');
    const head = el('div', 'lib-head');
    head.append(
      el('span', 'lib-name', `${lib.name} ${actual && actual !== wanted ? `${wanted} (running ${actual})` : wanted}`),
      el('span', 'lib-use', lib.use),
      el('span', ok ? 'ok' : 'bad', ok ? '✓ loaded' : '✗ not loaded (offline?)'));
    const src = el('ul', 'lib-src');
    const original = EDITION === 'offline' && lib.name !== 'marked' && BUNDLED_VERSIONS[`${lib.name}-source`]
      ? [`original download: ${BUNDLED_VERSIONS[`${lib.name}-source`]}`] : [];
    for (const line of [...local.map(u => `${u} (bundled)`), ...urls, ...original, ...(lib.bundled ? [`online copy: ${lib.bundled}`] : [])])
      src.appendChild(el('li', '', line));
    card.append(head, src);
    list.appendChild(card);
  }
  // Details of MarkdownViewer.exe, when the page runs inside the Windows app.
  const appSection = document.getElementById('appSection');
  appSection.hidden = !appInfo;
  document.getElementById('appSectionNote').hidden = !!appInfo;
  if (appInfo) {
    const dl = document.getElementById('appInfo');
    dl.replaceChildren();
    const rows = [
      ['Version', `${appInfo.name} ${appInfo.version}`],
      ['Installed in', appInfo.installDir],
      ['Can read files under', appInfo.readableFolder || '—'],
      ['File types it will read', appInfo.servedTypes],
      ['Everything else', 'Refused (HTML, scripts, PDFs, programs, …)']
    ];
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));

    if (EDITION === 'webview2') {
      // No network port in this edition, so there is no connection to rotate.
      const wv = appInfo.webview2Runtime
        ? `Runtime ${appInfo.webview2Runtime}` + (appInfo.webview2Sdk ? ` · SDK ${appInfo.webview2Sdk}` : '')
        : 'Runtime version not reported';
      for (const [k, v] of [
        ['Connection', 'Private in-app address — every request is answered by the program itself; no network port, nothing to rotate'],
        ['Developer tools', 'Off (no F12 / Inspect). Documents are refused if WebView2 debugging has been switched on'],
        ['WebView2', wv]
      ]) dl.append(el('dt', '', k), el('dd', '', v));
    } else {
    // Connection rotation: interval setting and a live countdown (port numbers are not shown).
    const sel = el('select', 'rot-select');
    const choice = loadPrefLive('rotate');
    for (const [v, label] of [['off', 'Off'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]) {
      const o = el('option', '', label); o.value = v; o.selected = v === choice; sel.append(o);
    }
    const nextDd = el('dd', '', rotationText());
    nextDd.id = 'rotNext';
    sel.addEventListener('change', async () => {
      setRootPref('rotate', sel.value);
      savePref('rotate', sel.value);
      await new Promise(r => setTimeout(r, 300));
      await pingServer();
      nextDd.textContent = rotationText();
    });
    const rotDd = el('dd');
    rotDd.append(sel);
    dl.append(el('dt', '', 'Change connection & access key every'), rotDd, el('dt', '', 'Next change'), nextDd);
    }

    // Firewall rules: shown from the last check, then refreshed.
    const fwDd = el('dd');
    fwDd.id = 'fwRow';
    fillFirewallRow(fwDd);
    dl.append(el('dt', '', 'Firewall rules'), fwDd);
    fetchFirewall();
  }
  document.getElementById('about').showModal();
}
document.getElementById('aboutBtn').addEventListener('click', showAbout);
document.getElementById('aboutClose').addEventListener('click', () => document.getElementById('about').close());

// ---------------------------------------------------------------- desktop app start-up
async function initApp() {
  // Let the deferred diagram library finish loading first.
  if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r));
  let info;
  try { info = await (await fetch(apiBase + 'info')).json(); }
  catch { return; }
  appInfo = info.app || null;
  // Tell MarkdownViewer.exe the window is still open (it exits a while after the pings stop),
  // and hear about port rotations.
  setInterval(pingServer, 10000);
  fetchFirewall();
  setInterval(fetchFirewall, 60000);
  setInterval(tryRotate, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) tryRotate(); else pingServer(); });
  pingServer();

  const carried = readCarriedState();     // state brought over from the previous port, if any
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
  if (carried) restoreCarriedState(carried);
}

// ---------------------------------------------------------------- port rotation (Windows app)
// The server periodically opens a new port with a new access token. Because a page's address
// includes its port, the window moves to the new address — at a quiet moment, keeping the open
// document, scroll position and Find search. It never moves with unsaved replacements or while
// a dialog or the figure viewer is open; the old port stays open until it has moved.
let rotation = null;                 // latest { port, rotate, rotateMinutes, nextRotationSeconds }
let lastInput = Date.now();
['keydown', 'pointerdown', 'wheel'].forEach(t => document.addEventListener(t, () => { lastInput = Date.now(); }, true));
content.addEventListener('scroll', () => { lastInput = Date.now(); }, { passive: true });

let rotationAt = 0;                  // when `rotation` was received (its countdowns start from here)

async function pingServer() {
  try {
    const r = await fetch(apiBase + 'ping');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) { rotation = await r.json(); rotationAt = Date.now(); }
  } catch { /* the helper has closed */ }
  renderPortStatus();
  if (rotation && rotation.rotate) tryRotate();
}

// Seconds left on one of the server's countdowns, counted down locally between pings.
function secsLeft(field) {
  if (!rotation || rotation[field] < 0) return -1;
  return Math.max(0, Math.round(rotation[field] - (Date.now() - rotationAt) / 1000));
}
const clock = s => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
                             : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Status line under the document path (Windows app only). Port numbers are deliberately not shown.
function renderPortStatus() {
  const box = document.getElementById('portStatus');
  if (!APP || !rotation) return;
  document.getElementById('appStatus').hidden = false;
  const parts = [];
  if (rotation.transport === 'webview2') {
    // WebView2 edition: the page talks to the program directly - no port, nothing to rotate or close.
    box.replaceChildren('🔒 Private in-app connection — no network port');
    box.title = 'This window shows documents through WebView2; nothing listens on the network';
    return;
  }
  if (rotation.rotate) parts.push(['', '🔄 Connection change ready — moves at the next quiet moment']);
  else if (secsLeft('nextRotationSeconds') >= 0) {
    parts.push(['', `🔄 Connection changes in ${clock(secsLeft('nextRotationSeconds'))}`]);
    if (secsLeft('nextRotationSeconds') === 0 && Date.now() - rotationAt > 2000) pingServer();   // learn the new connection now
  }
  else parts.push(['', '🔄 Connection changes: off']);
  if (rotation.closingPort) {
    if (rotation.closeFailed) parts.push(['failed', '⚠ previous connection did not close']);
    else {
      const left = secsLeft('closeSecondsLeft');
      parts.push(['closing', left > 0 ? `· previous connection closes in ${left} s` : '· closing previous connection…']);
      if (left <= 0 && Date.now() - rotationAt > 2000) pingServer();      // fetch the outcome of the close
    }
  } else if (rotation.closedPort) parts.push(['closed', '· previous connection closed ✓']);
  box.replaceChildren(...parts.map(([cls, text]) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text + ' '; return s; }));
  box.title = 'For safety, the viewer regularly moves to a new private connection with a new access key';
  const next = document.getElementById('rotNext');
  if (next) next.textContent = rotationText();
  if (rotation.closeFailed) showPortDialog();
}
setInterval(() => { if (APP && rotation) renderPortStatus(); }, 1000);

// ---------------------------------------------------------------- firewall rules status (Windows app)
// The helper reads its own "Markdown Viewer" firewall rules (read-only) and reports them here.
// Green marker: all 4 rules present and enabled, and Windows Firewall is on. Red: anything less.
let firewall = null;
const firewallOk = () => !!(firewall && firewall.readable && (firewall.state === 'active' && firewall.firewallOn || firewall.state === 'nonetwork'));

async function fetchFirewall() {
  try { firewall = await (await fetch(apiBase + 'firewall')).json(); } catch { /* helper closed */ }
  renderFirewall();
}

function firewallLabel() {
  if (!firewall) return '…';
  if (firewall.state === 'nonetwork') return 'no network port';
  if (firewallOk()) return 'on';
  if (!firewall.readable) return 'status unknown';
  if (firewall.state === 'none') return 'rules not added';
  if (firewall.state === 'othercopy') return 'not this copy';
  if (!firewall.firewallOn) return 'Windows Firewall is off';
  return 'rules incomplete';
}

function renderFirewall() {
  const badge = document.getElementById('fwBadge');
  if (!APP || !firewall) return;
  document.getElementById('appStatus').hidden = false;
  badge.hidden = false;
  badge.className = 'breakdown-btn ' + (firewallOk() ? 'ok' : 'bad');
  badge.textContent = `🛡 Firewall: ${firewallLabel()}`;
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
  detail.textContent = firewall.detail + (firewall.rules.length ? ` Rules: ${firewall.rules.join(', ')}.` : '');
  dd.append(detail);
}
document.getElementById('fwBadge').addEventListener('click', () => showAbout());

// Pop-up when the previous connection didn't close in time: force it closed, or refresh.
let portDialogDismissed = false;
function showPortDialog() {
  const d = document.getElementById('portDialog');
  if (d.open || portDialogDismissed || document.querySelector('dialog[open]')) return;
  document.getElementById('portMsg').textContent =
    'The viewer moved to a new connection, but the previous one did not close in time. Force it closed, or refresh the window.';
  d.showModal();
}
document.getElementById('portDismiss').addEventListener('click', () => { portDialogDismissed = true; document.getElementById('portDialog').close(); });
document.getElementById('portRefresh').addEventListener('click', () => {
  if (isEdited() && !confirm('Refreshing discards your unsaved replacements. Continue?')) return;
  location.reload();
});
document.getElementById('portForce').addEventListener('click', async () => {
  const msg = document.getElementById('portMsg');
  msg.textContent = 'Closing the previous connection…';
  try {
    const r = await fetch(apiBase + 'forceclose');
    rotation = await r.json(); rotationAt = Date.now();
  } catch { msg.textContent = 'The viewer helper did not respond. Close this window and open the file again.'; return; }
  if (!rotation.closingPort) {
    document.getElementById('portDialog').close();
    showToast('The previous connection is now closed.');
  } else {
    msg.textContent = 'The previous connection is still open. Refresh the window; if that does not help, close it and open the file again.';
  }
  renderPortStatus();
});

function tryRotate() {
  if (!rotation || !rotation.rotate || !currentPath) return;
  const busy = isEdited() || document.querySelector('dialog[open]') || !lightbox.hidden || !copyMenu.hidden;
  const quiet = document.hidden || Date.now() - lastInput > 60000;
  if (busy || !quiet) return;
  const url = new URL(rotation.rotate);
  url.search = '?file=' + encodeURIComponent(currentPath);
  url.hash = 'mv=' + encodeURIComponent(JSON.stringify({
    s: Math.round(content.scrollTop),
    f: findBar.hidden ? null : { q: findInput.value, c: findOpts.case.checked, w: findOpts.word.checked, r: findOpts.regex.checked, rep: replaceMode }
  }));
  rotation = null;
  location.replace(url.href);
}

function readCarriedState() {
  const m = /^#mv=(.+)$/.exec(location.hash);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

function restoreCarriedState(st) {
  if (st.f) {
    findBar.hidden = false;
    findBtn.classList.add('on');
    findInput.value = st.f.q || '';
    findOpts.case.checked = !!st.f.c; findOpts.word.checked = !!st.f.w; findOpts.regex.checked = !!st.f.r;
    if (st.f.rep) setReplaceMode(true); else runFind(true);
  }
  // Scroll after layout settles (diagrams and images can change heights).
  const scroll = () => { content.scrollTop = st.s || 0; };
  scroll();
  setTimeout(scroll, 300);
  setTimeout(scroll, 1200);
}
if (APP) initApp();

// Offline / WebView2 edition: say so in the header, next to the app name.
if (EDITION !== 'online') {
  const tag = document.createElement('span');
  tag.className = 'edition-tag';
  tag.textContent = EDITION === 'webview2' ? 'WebView2' : 'Offline';
  tag.title = EDITION === 'webview2' ? 'WebView2 edition: own window, bundled libraries, no network port'
                                     : 'Offline edition: every library is bundled, nothing is loaded from the internet';
  document.querySelector('header h1').append(' ', tag);
}

// Opened directly in a browser (no Markdown Viewer app behind it): say what's missing and how to get it.
if (!APP) {
  const note = document.getElementById('standaloneNote');
  note.querySelectorAll('strong')[1].textContent = APP_TITLE;
  let dismissed = false;
  try { dismissed = localStorage.getItem('mdv-standalone-note') === 'hidden'; } catch {}
  note.hidden = dismissed;
  document.getElementById('standaloneClose').addEventListener('click', () => {
    note.hidden = true;
    try { localStorage.setItem('mdv-standalone-note', 'hidden'); } catch {}
  });
}
