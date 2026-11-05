'use strict';
// Regression tests for the citation guard (lib/grounding.js). Precision is the point: a
// document the answer cites that was actually retrieved must NEVER be flagged (Lokyni has
// twice removed over-eager checks that false-flagged prose), while a cited document absent
// from the retrieved sources — an invented citation — must be caught. No network. Run:
// `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const g = require(path.join(PROJECT, 'lib', 'grounding'));

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  const sources = [
    { id: 'a', source: '50 activity ideas.pdf', path: '/docs/Handbook/50 activity ideas.pdf' },
    { id: 'b', source: 'Support Groups.docx' },
  ];

  // ── a real citation is never flagged ──
  ok(g.citedButAbsentSources('According to 50 activity ideas.pdf, try music.', sources).length === 0,
     'a cited file that IS a retrieved source is not flagged');
  ok(g.caveatFor('See Support Groups.docx for details.', sources) === '',
     'no caveat when every cited file is a real source');
  // path-prefixed / differently-cased reference to a real source still matches
  ok(g.citedButAbsentSources('see /docs/Handbook/50 Activity Ideas.pdf', sources).length === 0,
     'a path-prefixed, differently-cased real citation still matches (lenient)');
  console.log('✓ grounding: real citations are never flagged');

  // ── an invented citation is caught ──
  const absent = g.citedButAbsentSources('This is confirmed in annual-report-2023.pdf and summary.docx.', sources);
  ok(absent.includes('annual-report-2023.pdf') && absent.includes('summary.docx'), 'invented file citations are flagged');
  ok(/not among your retrieved sources/.test(g.caveatFor('per made-up-file.pdf', sources)), 'a caveat is produced for an absent citation');
  console.log('✓ grounding: invented citations are caught with a caveat');

  // ── The guard must cover every retrievable format, including images and media, and must be built from the
  //    one canonical extension list so a new format cannot drift out of it. An unsupported format (.rtf) can
  //    never be a retrieved source and is deliberately not treated as a citation. ──
  {
    const { SUPPORTED_EXTENSIONS, OCR_EXTENSIONS, MEDIA_EXTENSIONS } = require(path.join(PROJECT, 'lib', 'constants'));
    const exts = [...new Set([...SUPPORTED_EXTENSIONS, ...OCR_EXTENSIONS, ...MEDIA_EXTENSIONS])];
    for (const ext of exts) {
      const name = `sample${ext}`;
      ok(g.citedButAbsentSources(`See ${name} for details.`, sources).includes(name),
        `a cited ${ext} file is recognized by the guard`);
      ok(g.citedButAbsentSources(`See ${name} for details.`, [{ source: name }]).length === 0,
        `a retrieved ${ext} source is never flagged`);
    }
    ok(!g.citedButAbsentSources('See notes.rtf for details.', sources).includes('notes.rtf'),
      'an unsupported extension is not treated as a retrievable citation');
    console.log('✓ grounding: the citation guard covers every supported format, including images and media');
  }

  // ── substring bypass is closed: a fabricated name that is only a MID-TOKEN substring of a real source
  //    (or makes a real short source a substring of itself) must be flagged, while a whole trailing TOKEN of a
  //    space-separated real source must still pass. ──
  {
    const src2 = [
      { id: 'r', source: 'annual-report-2023-final-summary.pdf' },   // one hyphenated token (no spaces)
      { id: 's', source: 'a.pdf' },                                   // a short real source
      { id: 'm', source: 'quarterly board meeting notes.pdf' },       // space-separated multi-word
    ];
    const f1 = g.citedButAbsentSources('As shown in summary.pdf, revenue rose.', src2);
    ok(f1.includes('summary.pdf'), 'a fabricated "summary.pdf" is flagged, not excused as a substring of a real "...-final-summary.pdf"');
    const f2 = g.citedButAbsentSources('See data.pdf for the breakdown.', src2);
    ok(f2.includes('data.pdf'), 'a fabricated "data.pdf" is flagged, not excused because a real "a.pdf" is its substring');
    const f3 = g.citedButAbsentSources('Per notes.pdf, the board approved it.', src2);
    ok(f3.length === 0, 'a whole trailing token ("notes.pdf") of a space-separated real source is NOT flagged (legit abbreviation)');
  }
  console.log('✓ grounding: the two-way substring bypass is closed (word-boundary token match only)');

  // ── prose without filenames is quiet ──
  ok(g.citedButAbsentSources('Encourage gentle music and short walks. There are many options.', sources).length === 0,
     'ordinary prose with no filename tokens is never flagged');
  ok(g.caveatFor('', sources) === '' && g.citedButAbsentSources('x', []).length === 0, 'empty answer / no sources handled');
  console.log('✓ grounding: ordinary prose and empty inputs are quiet');

  console.log(`\nALL GROUNDING UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ GROUNDING UNIT TEST FAILED:', e && e.message);
  process.exit(1);
}
