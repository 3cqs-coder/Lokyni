'use strict';
// Unit tests for the office-document helpers (lib/indexing/officedocs.js): PPTX text
// extraction and the guards on DOCX/PPTX image description. Hermetic — builds minimal ZIP
// archives with the bundled jszip; no vision model and no network (the image-description
// path itself needs a model and is exercised by `npm run eval:visual`). Run: `npm run test:unit`.

const path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const office = require(path.join(PROJECT, 'lib', 'indexing', 'officedocs'));
const JSZip = require(path.join(PROJECT, 'node_modules', 'jszip'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  try {
    // ── runsFromSlideXml: pull <a:t> runs and decode entities ──
    eq(office.runsFromSlideXml('<p><a:t>Hello</a:t> <a:t>World &amp; more</a:t></p>'), 'Hello World & more', 'text runs joined, entities decoded');
    eq(office.runsFromSlideXml('<p:sld></p:sld>'), '', 'a slide with no text runs -> empty');
    console.log('✓ officedocs: runsFromSlideXml pulls text runs and decodes entities');

    // ── extractPptxText: ordered slides + speaker notes ──
    const z = new JSZip();
    z.file('ppt/slides/slide2.xml', '<a:t>Second slide</a:t>');   // deliberately out of order
    z.file('ppt/slides/slide1.xml', '<a:t>First slide</a:t>');
    z.file('ppt/slides/slide10.xml', '<a:t>Tenth slide</a:t>');   // numeric (not lexical) order
    z.file('ppt/notesSlides/notesSlide1.xml', '<a:t>Note for one</a:t>');
    z.file('docProps/core.xml', '<x/>');                          // ignored
    const pptx = await z.generateAsync({ type: 'nodebuffer' });
    const text = await office.extractPptxText(pptx);
    ok(text.includes('Slide 1: First slide'), 'slide 1 labeled and present');
    ok(text.includes('Slide 2: Second slide'), 'slide 2 present');
    ok(text.includes('Slide 10: Tenth slide'), 'slide 10 present');
    ok(text.indexOf('Slide 1:') < text.indexOf('Slide 2:') && text.indexOf('Slide 2:') < text.indexOf('Slide 10:'), 'slides are in numeric order');
    ok(text.includes('Speaker notes:') && text.includes('Notes for slide 1: Note for one'), 'speaker notes included and labeled');
    console.log('✓ officedocs: extractPptxText orders slides numerically and includes notes');

    // ── describeOfficeImages guards: safe no-op without breaking on bad/plain input ──
    // Feature defaults OFF, so this returns { text:'', figures:[] } without touching vision.
    const nz = await office.describeOfficeImages(Buffer.from('not a zip'), 'x.docx');
    eq(nz.text, '', 'non-zip input -> empty text');
    ok(Array.isArray(nz.figures) && nz.figures.length === 0, 'non-zip input -> no figures');
    eq((await office.describeOfficeImages(null, 'x.docx')).text, '', 'non-buffer input -> empty text');
    const empty = await new JSZip().generateAsync({ type: 'nodebuffer' });
    eq((await office.describeOfficeImages(empty, 'x.docx')).text, '', 'a doc with no media -> empty text');
    console.log('✓ officedocs: describeOfficeImages is a safe no-op when disabled or media-free');

    console.log(`\nALL OFFICEDOCS UNIT TESTS PASSED (${checks} checks)`);
    process.exitCode = 0;
  } catch (e) {
    console.error('\n✗ OFFICEDOCS UNIT TEST FAILED:', e && e.message);
    process.exitCode = 1;
  }
})();
