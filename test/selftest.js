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
  // test\wide.csv: Id, Name, City, Q1..Q37 (40 columns), 30 rows - choosing which columns to show.
  async function checkColumns() {
    const problems = [];
    const table = output.querySelector('.csv-table');
    const heads = () => [...table.tHead.rows[0].cells].map(c => c.textContent);
    const cellsPerRow = () => table.tBodies[0].rows[0].cells.length;
    const info = () => output.querySelector('.csv-info').textContent;
    const btn = output.querySelector('.csv-cols-btn');
    const boxes = () => [...output.querySelectorAll('.csv-cols-list input')];
    const box = n => boxes().find(b => b.parentElement.textContent === n);
    const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (heads().length !== 40 || !info().includes('40 of 40 columns') || !btn.textContent.includes('40 of 40')) problems.push('start: ' + heads().length + ' / ' + info());
    click(btn);
    if (output.querySelector('.csv-cols-panel').hidden) problems.push('column list did not open');
    for (const n of ['Q1', 'Q2']) { const b = box(n); b.checked = false; b.dispatchEvent(new Event('change')); }
    if (heads().length !== 38 || cellsPerRow() !== 38 || heads().includes('Q1') || !info().includes('38 of 40 columns')) problems.push('untick 2: ' + heads().length + ' / ' + cellsPerRow() + ' / ' + info());
    // Find "Q1" lists Q1 and Q10-Q19; Hide all hides just those.
    const find = output.querySelector('.csv-cols-find');
    find.value = 'Q1'; find.dispatchEvent(new Event('input'));
    const listed = boxes().filter(b => !b.parentElement.hidden).length;
    if (listed !== 11) problems.push('find Q1 lists ' + listed);
    click([...output.querySelectorAll('.csv-cols-tools button')].find(b => b.textContent === 'Hide all'));
    if (heads().length !== 28 || !btn.textContent.includes('28 of 40')) problems.push('hide found: ' + heads().length);
    // A filter on a column that gets hidden is cleared.
    const cityFilter = output.querySelectorAll('.csv-col-filter')[2];
    cityFilter.value = '=Ottawa'; cityFilter.dispatchEvent(new Event('input'));
    await sleep(300);
    if (table.tBodies[0].rows.length !== 8) problems.push('city filter rows: ' + table.tBodies[0].rows.length);
    find.value = 'City'; find.dispatchEvent(new Event('input'));
    const city = box('City'); city.checked = false; city.dispatchEvent(new Event('change'));
    if (table.tBodies[0].rows.length !== 30 || heads().includes('City')) problems.push('hidden column kept its filter: ' + table.tBodies[0].rows.length);
    // Copy / Save take the shown columns only.
    if (csvRowsShown()[0].length !== 27) problems.push('copy columns: ' + csvRowsShown()[0].length);
    // The filter box searches hidden columns too and shows the ones where it finds the text (1110 is only in Q37).
    find.value = 'Q37'; find.dispatchEvent(new Event('input'));
    const q37 = box('Q37'); q37.checked = false; q37.dispatchEvent(new Event('change'));
    if (heads().includes('Q37')) problems.push('Q37 not hidden');
    const search = output.querySelector('.csv-search');
    search.value = '1110'; search.dispatchEvent(new Event('input'));
    await sleep(300);
    if (table.tBodies[0].rows.length !== 1 || !heads().includes('Q37') || !box('Q37').checked) problems.push('hidden match: ' + table.tBodies[0].rows.length + ' rows, Q37 shown: ' + heads().includes('Q37'));
    search.value = ''; search.dispatchEvent(new Event('input'));
    await sleep(300);
    // Show all (with the find box empty) brings every column back.
    find.value = ''; find.dispatchEvent(new Event('input'));
    click([...output.querySelectorAll('.csv-cols-tools button')].find(b => b.textContent === 'Show all'));
    if (heads().length !== 40 || cellsPerRow() !== 40 || !info().includes('40 of 40 columns')) problems.push('show all: ' + heads().length);
    // A click elsewhere closes the list.
    click(document.body);
    if (!output.querySelector('.csv-cols-panel').hidden) problems.push('column list did not close');
    return problems;
  }

  async function checkTable(name) {
    for (let i = 0; i < 100 && !output.querySelector('.csv-table'); i++) await sleep(50);
    const problems = [];
    const table = output.querySelector('.csv-table');
    if (!table) return ['no table drawn'];
    if (/wide\.csv$/i.test(name)) return checkColumns();
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

  // JSON files: test\sample.json (text, tree, table), test\events.jsonl (one value per line), test\broken.json.
  async function checkJson(name) {
    for (let i = 0; i < 100 && !output.querySelector('.json-view'); i++) await sleep(50);
    const problems = [];
    if (!output.querySelector('.json-view')) return ['no JSON view'];
    const modeBtn = label => [...output.querySelectorAll('.json-modes button')].find(b => b.textContent.includes(label));
    const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (/broken\.json$/i.test(name)) {
      const err = output.querySelector('.json-error');
      if (!err || !/line 4/.test(err.textContent)) problems.push('error box: ' + (err ? err.textContent : 'none'));
      if (!modeBtn('Tree').disabled || !modeBtn('Table').disabled) problems.push('tree/table not disabled for invalid JSON');
      if (!output.querySelector('pre.json-text') || !output.querySelector('pre.json-text').textContent.includes('"b":')) problems.push('raw text not shown');
      return problems;
    }
    click(modeBtn('Text'));
    const text = () => output.querySelector('pre.json-text').textContent;
    if (/sample\.json$/i.test(name)) {
      if (!text().includes('"id": 12345678901234567890')) problems.push('long number not kept exactly');
      if (!text().includes('"note": "<script>')) problems.push('script string not shown as text');
      for (const want of ['{', '  "items": [', '    {', '      "sku": "A1",', '      "tags": [', '        "office",', '      "stock": {', '        "store": 10,', '  "empty": {},', '  "list": []', '}']) {
        if (!text().split('\n').includes(want)) problems.push('formatted line missing: ' + want);
      }
      // Tree: the root shows 8 keys; opening "items" shows 3 items.
      click(modeBtn('Tree'));
      await sleep(150);
      const rootSummary = output.querySelector('.json-tree > details > summary');
      if (!rootSummary || !rootSummary.textContent.includes('8 keys')) problems.push('tree root: ' + (rootSummary ? rootSummary.textContent : 'none'));
      const idLeaf = [...output.querySelectorAll('.json-tree .json-leaf')].find(l => l.textContent.startsWith('"id"'));
      if (!idLeaf || idLeaf.textContent !== '"id": 12345678901234567890') problems.push('tree long number: ' + (idLeaf && idLeaf.textContent));
      const items = [...output.querySelectorAll('.json-tree summary')].find(s => s.textContent.startsWith('"items"'));
      if (!items) problems.push('no items node');
      else {
        items.parentElement.open = true;
        await sleep(150);
        const kids = items.parentElement.querySelector('.json-kids').children.length;
        if (kids !== 3) problems.push('items children: ' + kids);
      }
      // Table: $.items with flattened columns; sort by price; another array; choose columns.
      click(modeBtn('Table'));
      await sleep(100);
      const heads = () => [...output.querySelectorAll('.csv-table thead tr:first-child th')].map(t => t.textContent);
      const rows = () => [...output.querySelector('.csv-table').tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent));
      const select = output.querySelector('select.json-array');
      if (!select || select.value !== '$.items') problems.push('first array: ' + (select && select.value));
      const want = ['sku', 'name', 'price', 'tags', 'stock.store', 'stock.online', 'discontinued'];
      if (heads().join('|') !== want.join('|')) problems.push('columns: ' + heads().join('|'));
      if (rows().length !== 3) problems.push('rows: ' + rows().length);
      if (!rows().some(r => r[1] === `<img src=x onerror="window.PWN='json-img'">`)) problems.push('img string not shown as text');
      const price = output.querySelectorAll('.csv-table thead tr:first-child th')[2];
      price.click(); price.click();
      if (rows().map(r => r[0]).join(',') !== 'B2,C3,A1') problems.push('sort price desc: ' + rows().map(r => r[0]).join(','));
      const tags = [...output.querySelectorAll('.csv-cols-list input')].find(b => b.parentElement.textContent === 'tags');
      tags.checked = false; tags.dispatchEvent(new Event('change'));
      if (heads().includes('tags') || !output.querySelector('.csv-cols-btn').textContent.includes('6 of 7')) problems.push('hide column in JSON table');
      select.value = '$ (keys and values)'; select.dispatchEvent(new Event('change'));
      await sleep(100);
      const idRow = rows().find(r => r[0] === 'id');
      if (!idRow || idRow[1] !== '12345678901234567890') problems.push('table long number: ' + (idRow && idRow[1]));
      const sel2 = output.querySelector('select.json-array');
      sel2.value = '$.owners'; sel2.dispatchEvent(new Event('change'));
      await sleep(100);
      if (rows().length !== 1 || heads().join('|') !== 'name|role') problems.push('owners: ' + heads().join('|'));
      click(modeBtn('Text'));
    }
    if (/events\.jsonl$/i.test(name)) {
      if (!text().includes('"message": "slow disk"')) problems.push('jsonl text');
      click(modeBtn('Table'));
      await sleep(100);
      const n = output.querySelector('.csv-table').tBodies[0].rows.length;
      const heads = [...output.querySelectorAll('.csv-table thead tr:first-child th')].map(t => t.textContent).join('|');
      if (n !== 3 || heads !== 'time|level|message|ms|code') problems.push('jsonl table: ' + n + ' / ' + heads);
      click(modeBtn('Text'));
    }
    return problems;
  }

  async function run() {
    const results = [];
    for (const [name, b64] of window.TESTDOCS) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      lastBreakdown = null;
      loadEntries([{ path: name, file: new File([bytes], name) }]);
      if (/\.(csv|tsv|json|jsonl|ndjson)$/i.test(name)) {
        const tableProblems = /\.(csv|tsv)$/i.test(name) ? await checkTable(name) : await checkJson(name);
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
