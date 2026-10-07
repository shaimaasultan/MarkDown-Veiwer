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
    // The table view's own filter boxes and header switch are the viewer's controls, not document content.
    const inputs = [...output.querySelectorAll('input, textarea, select, button[form], button[formaction]')]
      .filter(el => !el.closest('.csv-bar, .csv-filters'));
    return {
      badTags: [...output.querySelectorAll(BAD_TAGS)].map(el => el.tagName.toLowerCase()),
      onAttrs: onAttrs.map(el => el.tagName.toLowerCase()),
      badUrls: badUrls.map(el => el.tagName.toLowerCase()),
      otherInputs: inputs.filter(el => !(el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'checkbox' && el.disabled)).length,
      checkboxes: inputs.length
    };
  }

  // A table file (.csv / .tsv): drawn exactly, every cell as text; sorting and filtering work.
  // test\data.csv: Name, City, Amount, Note - six rows, one note on two lines, payloads as text.
  async function checkTable(name) {
    for (let i = 0; i < 100 && !output.querySelector('.csv-table'); i++) await sleep(50);
    const problems = [];
    const table = output.querySelector('.csv-table');
    if (!table) return ['no table drawn'];
    const rows = () => [...table.tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent));
    const heads = [...table.tHead.rows[0].cells].map(c => c.textContent);
    if (heads.join('|') !== 'Name|City|Amount|Note') problems.push('header: ' + heads.join('|'));
    const all = rows();
    if (all.length !== 6) problems.push(`${all.length} rows, expected 6`);
    const eve = all.find(r => r[0] === 'Eve');
    if (!eve || eve[3] !== 'line one\nline two') problems.push('quoted line break not kept');
    const bob = all.find(r => r[0] === 'Bob');
    if (!bob || bob[3] !== "<script>window.PWN='csv-script'</script>") problems.push('script cell not shown as text');
    if (!all.find(r => r[0] === 'Alice' && r[3] === 'plain, with comma')) problems.push('quoted comma');
    // Sort by Amount (numbers, empty and text last), then reverse.
    const amount = table.tHead.rows[0].cells[2];
    amount.click();
    let order = rows().map(r => r[0]).join(',');
    if (order !== 'Eve,Bob,Alice,Carol,Dave,Frank') problems.push('sort asc: ' + order);
    amount.click();
    order = rows().map(r => r[0]).join(',');
    if (order !== 'Carol,Alice,Bob,Eve,Dave,Frank') problems.push('sort desc: ' + order);
    amount.click();
    // Filter all columns, then one column with a number comparison.
    const search = output.querySelector('.csv-search');
    search.value = 'toronto'; search.dispatchEvent(new Event('input'));
    await sleep(300);
    if (rows().map(r => r[0]).join(',') !== 'Alice,Dave') problems.push('filter all: ' + rows().map(r => r[0]).join(','));
    search.value = ''; search.dispatchEvent(new Event('input'));
    const amountFilter = output.querySelectorAll('.csv-col-filter')[2];
    amountFilter.value = '>100'; amountFilter.dispatchEvent(new Event('input'));
    await sleep(300);
    if (rows().map(r => r[0]).join(',') !== 'Alice,Carol') problems.push('filter >100: ' + rows().map(r => r[0]).join(','));
    amountFilter.value = ''; amountFilter.dispatchEvent(new Event('input'));
    await sleep(300);
    return problems;
  }

  async function run() {
    const results = [];
    for (const [name, b64] of window.TESTDOCS) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      lastBreakdown = null;
      loadEntries([{ path: name, file: new File([bytes], name) }]);
      if (/\.(csv|tsv)$/i.test(name)) {
        const tableProblems = await checkTable(name);
        results.push({
          name,
          rendered: output.textContent.trim().length > 0,
          breakdown: tableProblems.length ? 'bad' : 'ok',
          tableProblems,
          viewed: null, diagrams: 0, drawn: 0, equations: 0,
          pwn: window.PWN === undefined ? null : String(window.PWN),
          ...inspect()
        });
        continue;
      }
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
