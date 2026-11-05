'use strict';
// Extraction Tables: the per-document extraction core (lib/extracttable.js) and its structured-output
// plumbing. Covers column normalization/keying (bounded, safe, unique), the response schema shape, and
// extractRow's parsing + egress sanitation + bounding with a stubbed model. Also source-guards the
// constrained-generation wiring in llm.js and the api-core/socket orchestration. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(PROJECT, ...p), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };

(async () => {
  try {
    const et = require(path.join(PROJECT, 'lib', 'extracttable'));

    // ── normalizeColumns: trims, drops blanks, caps count + label length, de-dupes keys ──
    const cols = et.normalizeColumns(['  Key finding ', '', '   ', 'Sample size (n)', 'Key finding', 123]);
    ok(cols.length === 4, `blank/whitespace columns dropped, the rest kept (got ${cols.length})`);
    ok(cols.every(c => c.key && c.label), 'every column has a key and a label');
    ok(new Set(cols.map(c => c.key)).size === cols.length, 'column keys are unique');
    ok(cols[0].label === 'Key finding', 'labels are trimmed');
    ok(/^c1_sample_size/.test(cols[1].key), `an odd label becomes a safe slugged key (got ${cols[1].key})`);
    const many = et.normalizeColumns(Array.from({ length: 50 }, (_, i) => `col ${i}`));
    ok(many.length === et.MAX_COLUMNS, `the column count is capped to MAX_COLUMNS (${et.MAX_COLUMNS}, got ${many.length})`);
    const longLabel = et.normalizeColumns(['x'.repeat(500)])[0].label;
    ok(longLabel.length <= et.MAX_LABEL_CHARS, 'a very long label is truncated to the cap');
    ok(et.normalizeColumns(null).length === 0 && et.normalizeColumns('nope').length === 0, 'non-array input yields no columns');

    // ── buildSchema: one { value, evidence } object per column ──
    const schema = et.buildSchema(cols);
    ok(schema.type === 'object' && schema.properties, 'schema is an object with properties');
    ok(Object.keys(schema.properties).length === cols.length, 'schema has one property per column');
    const first = schema.properties[cols[0].key];
    ok(first && first.properties && first.properties.value && first.properties.evidence,
      'each column property is a { value, evidence } object');

    // ── extractRow: parses the model object, sanitizes + bounds every cell, never throws for content ──
    const llm = require(path.join(PROJECT, 'lib', 'llm'));
    const realCompleteJson = llm.completeJson;
    const entry = { content: 'The study enrolled 240 patients. The main finding was a 30% reduction.', metadata: { source: '/docs/trial.pdf' } };
    try {
      // 1) well-formed object with an embedded bidi/zero-width control char that must be stripped
      llm.completeJson = async () => ({
        [cols[0].key]: { value: 'A 30%‮ reduction', evidence: 'a 30% reduction' },
        [cols[1].key]: { value: '240​ patients', evidence: '240 patients' },
      });
      const row = await et.extractRow(entry, cols, {});
      ok(row.name === 'trial.pdf', 'the row is named from the document basename');
      ok(!/[‮​]/.test(row.cells[cols[0].key].value + row.cells[cols[1].key].value),
        'invisible/bidi control chars are stripped from cell values');
      ok(row.cells[cols[0].key].evidence === 'a 30% reduction', 'the evidence quote is carried through');
      ok(row.cells[cols[2].key] && row.cells[cols[2].key].value === '',
        'a column the model omitted becomes an empty cell (not undefined)');

      // 2) a model that returns a BARE string for a field (not the {value,evidence} shape) still parses
      llm.completeJson = async () => ({ [cols[0].key]: 'bare value' });
      const row2 = await et.extractRow(entry, cols, {});
      ok(row2.cells[cols[0].key].value === 'bare value' && row2.cells[cols[0].key].evidence === '',
        'a bare-string field is coerced to { value, evidence:"" }');

      // 3) a null/garbage model result yields all-empty cells, never a throw
      llm.completeJson = async () => null;
      const row3 = await et.extractRow(entry, cols, {});
      ok(Object.keys(row3.cells).length === cols.length && Object.values(row3.cells).every(c => c.value === ''),
        'a null model result yields a full row of empty cells (no throw)');

      // 4) an over-long value is bounded
      llm.completeJson = async () => ({ [cols[0].key]: { value: 'y'.repeat(10000), evidence: '' } });
      const row4 = await et.extractRow(entry, cols, {});
      ok(row4.cells[cols[0].key].value.length <= 2000, 'a cell value is length-bounded');

      // 5) an empty document is reported empty (no model call needed)
      const blank = await et.extractRow({ content: '   ', metadata: { source: 'x.txt' } }, cols, {});
      ok(blank.empty === true, 'an empty document yields an empty row');
    } finally {
      llm.completeJson = realCompleteJson;   // restore the real implementation
    }

    // ── constrained-generation wiring (llm.js) ──
    const llmSrc = read('lib', 'llm.js');
    ok(/function _formatOpts\(opts, isOpenAI\)/.test(llmSrc), 'llm.js defines the provider-neutral _formatOpts translator');
    ok(/response_format: \{ type: 'json_schema'/.test(llmSrc) && /format: opts\.jsonSchema/.test(llmSrc),
      '_formatOpts maps a schema to OpenAI response_format and Ollama format');
    ok(/const fmt = _formatOpts\(opts, isOpenAI\);/.test(llmSrc) && /max_tokens: maxTokens, \.\.\.fmt/.test(llmSrc) && /num_predict: maxTokens \},\s*\n\s*\.\.\.fmt/.test(llmSrc),
      'the format opts are threaded into BOTH the OpenAI and Ollama calls');
    ok(/const completeJson = async/.test(llmSrc) && /module\.exports = \{[^}]*completeJson/.test(llmSrc),
      'llm.js exports completeJson');

    // ── FUNCTIONAL orchestration (runExtractionTable) with the bundle + extractRow stubbed ──
    // Proves the real behaviors (cap + omittedDocs, selectedDocIds scoping, noise exclusion, abort, and the
    // onColumns-before-onRow ordering / no-accumulate-when-streaming contract) rather than only source text.
    {
      const apiCore = require(path.join(PROJECT, 'lib', 'api-core'));
      const bundle = require(path.join(PROJECT, 'lib', 'indexing', 'bundle'));
      const cfg = require(path.join(PROJECT, 'lib', 'config'));
      const et = require(path.join(PROJECT, 'lib', 'extracttable'));
      const mk = (source, content = 'some content', fileType = 'TXT') => ({ content, metadata: { source, fileType } });
      const parentMap = new Map([
        ['d_alpha', mk('/w/alpha.txt')],
        ['d_pkg',   mk('/w/package.json')],         // synthesis noise → excluded
        ['d_empty', mk('/w/empty.txt', '   ')],      // no content → excluded
        ['d_img',   mk('/w/icon.png', '', 'PNG')],   // trivial image → excluded
        ['d_beta',  mk('/w/beta.txt')],
        ['d_gamma', mk('/w/gamma.txt')],
      ]);
      const origGet = bundle.getBundleNonBlocking, origRow = et.extractRow, origMax = cfg.extractionMaxDocs;
      bundle.getBundleNonBlocking = async () => ({ status: 'ok', bundle: { parentMap } });
      et.extractRow = async (entry, cols) => ({ name: require('path').basename(entry.metadata.source), cells: Object.fromEntries(cols.map(c => [c.key, { value: 'v', evidence: '' }])), truncated: false });
      try {
        try { cfg.extractionMaxDocs = 2; } catch { /* read-only in some builds; cap assertions then relax */ }
        const events = [];
        const rowsSeen = [];
        const r = await apiCore.runExtractionTable('ws', ['Col A'], {
          onColumns: () => events.push('columns'),
          onRow: (row) => { events.push('row'); rowsSeen.push(row.name); },
          onProgress: () => {},
        });
        ok(r.status === 'ok', 'a run over a fake corpus succeeds');
        ok(r.totalDocs === 3, `noise/empty/trivial-image docs are excluded (3 content docs, got ${r.totalDocs})`);
        if (origMax !== cfg.extractionMaxDocs) {   // cap override took effect
          ok(r.processed === 2 && r.omittedDocs === 1, `the cap truncates to extractionMaxDocs with correct omittedDocs (got ${r.processed}/${r.omittedDocs})`);
          ok(rowsSeen.length === 2 && rowsSeen[0] === 'alpha.txt', 'rows stream in filename order, capped');
        }
        ok(events[0] === 'columns' && events.indexOf('row') > 0, 'onColumns fires before the first onRow');
        ok(Array.isArray(r.rows) && r.rows.length === 0, 'rows are NOT accumulated when a streaming onRow consumer is present');
        ok(!rowsSeen.includes('package.json') && !rowsSeen.includes('icon.png') && !rowsSeen.includes('empty.txt'), 'excluded docs never produce a row');

        // selectedDocIds scoping
        const r2 = await apiCore.runExtractionTable('ws', ['Col A'], { selectedDocIds: ['d_beta'], onRow: () => {} });
        ok(r2.status === 'ok' && r2.totalDocs === 1, 'selectedDocIds restricts the run to the pinned document(s)');

        // a pre-aborted signal yields 'aborted' with no rows emitted
        let aborted = 0;
        const r3 = await apiCore.runExtractionTable('ws', ['Col A'], { signal: { aborted: true }, onRow: () => { aborted++; } });
        ok(r3.status === 'aborted' && aborted === 0, 'a pre-aborted signal returns aborted with no rows emitted');

        // no columns → no_columns (no bundle work)
        const r4 = await apiCore.runExtractionTable('ws', [], {});
        ok(r4.status === 'no_columns', 'an empty column set returns no_columns');
      } finally {
        bundle.getBundleNonBlocking = origGet; et.extractRow = origRow; try { cfg.extractionMaxDocs = origMax; } catch {}
      }
    }

    // ── orchestration wiring (api-core + socket) ──
    const core = read('lib', 'api-core.js');
    ok(/const runExtractionTable = async \(workspaceId, columns, opts = \{\}\) =>/.test(core), 'api-core defines runExtractionTable');
    ok(/if \(signal\?\.aborted\) return \{ status: 'aborted' \};/.test(core), 'the extraction loop checks the abort signal at each boundary');
    ok(/collectContentEntries\(idx, \{ selectedDocIds: opts\.selectedDocIds, sort: true \}\)/.test(core), 'extraction reuses the shared collectContentEntries (single-sourced noise/content filter)');
    ok(/else rows\.push\(row\);/.test(core), 'rows are retained only when there is no streaming consumer (no latent OOM)');
    ok(/module\.exports = \{[^}]*runExtractionTable/.test(core), 'api-core exports runExtractionTable');

    // ── drift guards: client/server shared constants must stay in parity ──
    const chatJs = read('lib', 'public', 'js', 'chat.js');
    const clientMaxCols = (chatJs.match(/const MAX_COLUMNS = (\d+);/) || [])[1];
    const clientMaxLen = (chatJs.match(/input\.maxLength = (\d+);/) || [])[1];
    ok(clientMaxCols && Number(clientMaxCols) === et.MAX_COLUMNS, `client MAX_COLUMNS (${clientMaxCols}) equals extracttable.MAX_COLUMNS (${et.MAX_COLUMNS})`);
    ok(clientMaxLen && Number(clientMaxLen) === et.MAX_LABEL_CHARS, `client column maxLength (${clientMaxLen}) equals extracttable.MAX_LABEL_CHARS (${et.MAX_LABEL_CHARS})`);
    const sock = read('lib', 'socket.js');
    ok(/client\.on\('extract_table'/.test(sock) && /client\.on\('extract_cancel'/.test(sock), 'socket wires extract_table + extract_cancel');
    ok(/mayUseWorkspace\(turnWs, 'doc\.read'\)/.test(sock.slice(sock.indexOf("client.on('extract_table'"))),
      'extract_table enforces doc.read on the target workspace');

    console.log(`\nALL EXTRACTION-TABLES UNIT TESTS PASSED (${checks} checks)`);
    process.exit(0);
  } catch (e) {
    console.error('\n✗ EXTRACTION-TABLES UNIT TEST FAILED:', e && e.message);
    process.exit(1);
  }
})();
