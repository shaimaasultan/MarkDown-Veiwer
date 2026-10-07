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

  // Code, text, config, XML, Excel and notebooks.
  async function checkOther(name, bytes) {
    const problems = [];
    const ext = name.split('.').pop().toLowerCase();
    const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const wait = async sel => { for (let i = 0; i < 100 && !output.querySelector(sel); i++) await sleep(50); return output.querySelector(sel); };
    if (['xml'].includes(ext)) {
      if (!(await wait('.json-view'))) return ['no XML view'];
      const dlg = document.getElementById('codeAlert');
      if (!dlg.open || !document.getElementById('caTitle').textContent.includes('shown as text') || document.getElementById('caFile').textContent !== name)
        problems.push('no "contains code" warning: ' + dlg.open + ' / ' + document.getElementById('caTitle').textContent);
      if (!/Contains code \(.*active content/i.test(document.getElementById('stats').textContent)) problems.push('status line: ' + document.getElementById('stats').textContent.slice(0, 160));
      dlg.close();
      const modeBtn = label => [...output.querySelectorAll('.json-modes button')].find(b => b.textContent.includes(label));
      click(modeBtn('Text'));
      const text = output.querySelector('pre.xml-text').textContent;
      if (!text.includes("<script>window.PWN='xml-element'</script>")) problems.push('xml text');
      click(modeBtn('Tree'));
      await sleep(150);
      const root = output.querySelector('.json-tree > details > summary');
      if (!root || !root.textContent.startsWith('<catalog updated="2026-10-07">') || !root.textContent.includes('4 children')) problems.push('xml tree root: ' + (root && root.textContent));
      click(modeBtn('Table'));
      await sleep(150);
      const sel = output.querySelector('select.json-array');
      if (!sel || sel.value !== '/catalog/book') problems.push('xml rows from: ' + (sel && sel.value));
      const heads = [...output.querySelectorAll('.csv-table thead tr:first-child th')].map(t => t.textContent).join('|');
      if (heads !== '@id|title|price|author/name|author/country') problems.push('xml columns: ' + heads);
      const rows = [...output.querySelector('.csv-table').tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent));
      if (rows.length !== 3 || rows[2][1] !== "<script>window.PWN='xml'</script>") problems.push('xml rows: ' + rows.length + ' / ' + (rows[2] && rows[2][1]));
      click(modeBtn('Text'));
      return problems;
    }
    if (ext === 'xlsx') {
      if (!(await wait('.csv-table'))) return ['no workbook table: ' + output.textContent.slice(0, 120)];
      const sel = output.querySelector('select.json-array');
      const sheets = sel ? [...sel.options].map(o => o.value).join('|') : '';
      if (sheets !== 'Sales|Notes') problems.push('sheets: ' + sheets);
      const heads = [...output.querySelectorAll('.csv-table thead tr:first-child th')].map(t => t.textContent).join('|');
      if (heads !== 'Item|Amount|Date|Paid|Note') problems.push('xlsx columns: ' + heads);
      const rows = [...output.querySelector('.csv-table').tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent));
      const want = [['Pens', '12.5', '2026-10-07', 'TRUE', "<script>window.PWN='xlsx'</script>"], ['Paper', '3', '2026-10-08', 'FALSE', 'inline text'], ['Total', '15.5', '', '', 'Rich text']];
      if (JSON.stringify(rows) !== JSON.stringify(want)) problems.push('xlsx rows: ' + JSON.stringify(rows));
      sel.value = 'Notes'; sel.dispatchEvent(new Event('change'));
      await sleep(200);
      const r2 = [...output.querySelector('.csv-table').tBodies[0].rows].map(r => r.cells[0].textContent);
      if (r2.join('|') !== 'second sheet') problems.push('sheet 2: ' + r2.join('|'));
      return problems;
    }
    if (ext === 'ipynb') {
      if (!(await wait('.nb-view'))) return ['no notebook view'];
      const v = output.querySelector('.nb-view');
      if (!v.querySelector('.nb-md h1') || v.querySelector('.nb-md h1').textContent !== 'Notebook test') problems.push('markdown cell');
      if (!v.querySelector('.nb-md .katex')) problems.push('math in markdown cell');
      if (!v.querySelector('.nb-code code') || !v.querySelector('.nb-code code').textContent.includes('import pandas')) problems.push('code cell');
      if (!v.querySelector('pre.nb-stream') || !v.querySelector('pre.nb-stream').textContent.includes('hello')) problems.push('stream output');
      const img = v.querySelector('.nb-outputs img');
      if (!img || !img.getAttribute('src').startsWith('data:image/png;base64,')) problems.push('picture output');
      if (!v.querySelector('.nb-html table')) problems.push('html table output');
      const err = v.querySelector('pre.nb-error');
      if (!err || err.textContent !== 'ValueError: bad value\nValueError: bad value') problems.push('error output: ' + (err && JSON.stringify(err.textContent)));
      const box = output.querySelector('.nb-view .csv-option input');
      box.checked = false; box.dispatchEvent(new Event('change'));
      if (getComputedStyle(v.querySelector('.nb-outputs')).display !== 'none') problems.push('outputs not hidden');
      box.checked = true; box.dispatchEvent(new Event('change'));
      return problems;
    }
    // Code, text and config: line numbers match the file, the text is all there.
    if (!(await wait('.code-file'))) return ['no code view'];
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
    const lines = text.split(/\r\n|\n|\r/).length - (/(\r\n|\n|\r)$/.test(text) ? 1 : 0);
    const gutter = output.querySelector('pre.code-gutter').textContent.trim().split('\n');
    if (gutter.length !== lines) problems.push(`line numbers ${gutter.length}, lines ${lines}`);
    const shown = output.querySelector('pre.code-text code').textContent.replace(/[\r]/g, '');
    if (!shown.includes(text.split(/\r?\n/)[0])) problems.push('first line missing');
    if (name === 'script.ps1') {
      if (!output.querySelector('pre.code-text .hc')) problems.push('hidden text-direction character not marked');
      if (!shown.includes('Remove-Item')) problems.push('ps1 text');
    }
    if (ext === 'log' && !shown.includes("<script>window.PWN='log'</script>")) problems.push('log text');
    if (ext === 'yaml' && !output.querySelector('pre.code-text code span')) problems.push('yaml not coloured');
    return problems;
  }

  // The file list: one entry per document with its type icon; the type filter hides and shows kinds.
  async function checkFileList() {
    const problems = [];
    const entries = window.TESTDOCS.map(([n, b64]) => ({ path: n, file: new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], n) }));
    loadEntries(entries);
    await sleep(500);
    const items = () => [...document.querySelectorAll('#fileList li')];
    if (items().length !== entries.length) problems.push(`list ${items().length} of ${entries.length}`);
    const btn = document.querySelector('#typeFilter .csv-cols-btn');
    if (!btn || !/Types: (\d+) of \1/.test(btn.textContent)) problems.push('types button: ' + (btn && btn.textContent));
    const md = [...document.querySelectorAll('#typeFilter .csv-cols-list label')].find(l => l.textContent.includes('Markdown'));
    const mdCount = window.TESTDOCS.filter(([n]) => /\.md$/i.test(n)).length;
    if (!md || !md.textContent.includes(`(${mdCount})`)) problems.push('markdown count: ' + (md && md.textContent));
    md.querySelector('input').checked = false; md.querySelector('input').dispatchEvent(new Event('change'));
    if (items().length !== entries.length - mdCount || items().some(li => /\.md$/i.test(li.dataset.path))) problems.push('hiding Markdown: ' + items().length);
    // Opening a Markdown file while Markdown is hidden shows Markdown again.
    const mdName = window.TESTDOCS.find(([n]) => /\.md$/i.test(n))[0];
    await openDoc(mdName);
    await sleep(200);
    if (items().length !== entries.length || hiddenTypes().has('md')) problems.push('opening a hidden kind did not show it: ' + items().length);
    md.querySelector('input').checked = false; md.querySelector('input').dispatchEvent(new Event('change'));
    const all = [...document.querySelectorAll('#typeFilter .csv-cols-tools button')].find(b => b.textContent === 'Show all');
    all.click();
    if (items().length !== entries.length) problems.push('show all: ' + items().length);
    if (!items().every(li => li.querySelector('.type-icon') && li.querySelector('.type-icon').textContent)) problems.push('type icons');
    return problems;
  }

  async function run() {
    const results = [];
    for (const [name, b64] of window.TESTDOCS) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      lastBreakdown = null;
      loadEntries([{ path: name, file: new File([bytes], name) }]);
      // Wait until the viewer has switched to this document (views of different files share class names).
      for (let i = 0; i < 200 && currentPath !== name; i++) await sleep(25);
      await sleep(60);
      if (!/\.md$/i.test(name)) {
        const tableProblems = /\.(csv|tsv)$/i.test(name) ? await checkTable(name) : /\.(json|jsonl|ndjson)$/i.test(name) ? await checkJson(name) : await checkOther(name, bytes);
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
    const listProblems = await checkFileList();
    results.push({ name: '(file list and types)', rendered: true, breakdown: listProblems.length ? 'bad' : 'ok', tableProblems: listProblems,
                   viewed: null, diagrams: 0, drawn: 0, equations: 0, pwn: window.PWN === undefined ? null : String(window.PWN), ...inspect() });
    const libs = LIBRARIES.map(l => ({ name: l.name, version: l.version, loaded: !!l.loaded() }));
    await fetch(`/${token}/result`, { method: 'POST', body: JSON.stringify({ results, pageErrors, libs }) });
  }
  window.addEventListener('load', () => setTimeout(() => run().catch(e =>
    fetch(`/${token}/result`, { method: 'POST', body: JSON.stringify({ failed: String(e && e.stack || e), pageErrors }) })), 500));
})();
