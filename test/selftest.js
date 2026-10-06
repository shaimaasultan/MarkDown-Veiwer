// Runs inside a temporary copy of the viewer page made by app\test-viewer.ps1; never part of the app.
// Opens every test document the way the viewer does (as dropped files), then reports for each one whether
// the breakdown adds up and whether anything that could run code got into the page.
"use strict";
(() => {
  const token = location.pathname.split('/')[1];
  const pageErrors = [];
  window.addEventListener('error', e => pageErrors.push(String(e.message || e.type)));
  window.addEventListener('unhandledrejection', e => pageErrors.push('promise: ' + String(e.reason && e.reason.message || e.reason)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const BAD_TAGS = 'script, iframe, frame, object, embed, applet, form, base, meta, link, portal, frameset';
  const BAD_URL = /^\s*(javascript|vbscript|livescript)\s*:|^\s*data\s*:\s*text\/html/i;

  function inspect() {
    const all = [...output.querySelectorAll('*')];
    const onAttrs = all.filter(el => [...el.attributes].some(a => /^on/i.test(a.name)));
    const badUrls = all.filter(el => [...el.attributes].some(a =>
      /^(href|src|action|formaction|xlink:href|data|poster|background)$/i.test(a.name) && BAD_URL.test(a.value)));
    const inputs = [...output.querySelectorAll('input, textarea, select, button[form], button[formaction]')];
    return {
      badTags: [...output.querySelectorAll(BAD_TAGS)].map(el => el.tagName.toLowerCase()),
      onAttrs: onAttrs.map(el => el.tagName.toLowerCase()),
      badUrls: badUrls.map(el => el.tagName.toLowerCase()),
      otherInputs: inputs.filter(el => !(el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'checkbox' && el.disabled)).length,
      checkboxes: inputs.length
    };
  }

  async function run() {
    const results = [];
    for (const [name, b64] of window.TESTDOCS) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      lastBreakdown = null;
      loadEntries([{ path: name, file: new File([bytes], name) }]);
      for (let i = 0; i < 200 && !(lastBreakdown && lastBreakdown.path === name); i++) await sleep(50);
      // Wait for diagrams to be drawn, then measure once more with everything in place.
      for (let i = 0; i < 200 && [...output.querySelectorAll('pre.mermaid')].some(p => !p.querySelector(':scope > svg')); i++) await sleep(50);
      await sleep(300);
      clearTimeout(statsTimer); updateStats();
      const btn = [...document.querySelectorAll('#stats .breakdown-btn')].find(b => /Breakdown/.test(b.textContent));
      results.push({
        name,
        rendered: output.textContent.trim().length > 0,
        breakdown: btn ? (btn.classList.contains('ok') ? 'ok' : 'bad') : 'missing',
        viewed: lastBreakdown && lastBreakdown.viewed,
        diagrams: output.querySelectorAll('pre.mermaid').length,
        drawn: output.querySelectorAll('pre.mermaid > svg').length,
        equations: output.querySelectorAll('.katex').length,
        pwn: window.PWN === undefined ? null : String(window.PWN),
        ...inspect()
      });
    }
    const libs = LIBRARIES.map(l => ({ name: l.name, version: l.version, loaded: !!l.loaded() }));
    await fetch(`/${token}/result`, { method: 'POST', body: JSON.stringify({ results, pageErrors, libs }) });
  }
  window.addEventListener('load', () => setTimeout(() => run().catch(e =>
    fetch(`/${token}/result`, { method: 'POST', body: JSON.stringify({ failed: String(e && e.stack || e), pageErrors }) })), 500));
})();
