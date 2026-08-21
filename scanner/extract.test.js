/**
 * Extraction tests. node scanner/extract.test.js
 *
 * The PDF fixtures in samples/files are produced by Chromium's Skia/PDF —
 * a real, mainstream producer that emits Type0/Identity-H subset fonts with
 * ToUnicode CMaps, which is the case that actually has to work. They are not
 * hand-built to match the parser.
 *
 * The .docx fixture IS synthetic (LibreOffice could not run in this sandbox),
 * built to the OOXML layout Word writes: a zip of deflate-raw entries whose
 * word/document.xml holds w:p / w:r / w:t. It exercises the same zip and XML
 * path a real file takes, but it is not proof against Word's quirks.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('./extract.js');
const ScanEngine = require('./engine.js');

let passed = 0;
let failed = 0;
const failures = [];
const pending = [];

function test(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed += 1;
      })
      .catch((err) => {
        failed += 1;
        failures.push(`${name}\n    ${err.message}`);
      })
  );
}

const FILES = path.join(__dirname, 'samples', 'files');
const read = (name) => new Uint8Array(fs.readFileSync(path.join(FILES, name)));

// ── Sniffing ────────────────────────────────────────────────────────

test('identifies formats by magic bytes, not just extension', () => {
  assert.strictEqual(E.sniff(read('resume-chromium.pdf'), 'anything.bin'), 'pdf');
  assert.strictEqual(E.sniff(read('resume.docx'), 'resume.docx'), 'docx');
  assert.strictEqual(E.sniff(new TextEncoder().encode('hello there'), 'a.txt'), 'text');
});

test('a zip that is not a docx is reported as a zip', () => {
  assert.strictEqual(E.sniff(read('resume.docx'), 'bundle.zip'), 'zip');
});

// ── PDF ─────────────────────────────────────────────────────────────

for (const file of ['resume-chromium.pdf', 'resume-chromium-times.pdf']) {
  test(`extracts readable text from ${file}`, async () => {
    const r = await E.extractText(read(file), file);
    assert.strictEqual(r.kind, 'pdf');
    assert.ok(/Jane Doe/.test(r.text), `no name: ${r.text.slice(0, 120)}`);
    assert.ok(/jane\.doe@example\.com/.test(r.text), 'no email');
    assert.ok(/Spearheaded a cross-functional initiative/.test(r.text), 'bullet text missing');
    assert.ok(/BS Computer Science/.test(r.text), 'education missing');
  });

  test(`${file} decodes glyph ids through the ToUnicode CMap`, async () => {
    const r = await E.extractText(read(file), file);
    // Without CMap decoding this comes out as control characters.
    const printable = (r.text.match(/[\x20-\x7e\n]/g) || []).length / r.text.length;
    assert.ok(printable > 0.97, `only ${(printable * 100).toFixed(1)}% printable — CMap not applied`);
  });

  test(`${file} does not split words with phantom spaces`, async () => {
    const r = await E.extractText(read(file), file);
    // The positioning heuristic used to produce "SUMMAR Y" and "EDUCA TION".
    assert.ok(/SUMMARY/.test(r.text), `heading split: ${r.text.match(/SUMMAR.{0,3}/)}`);
    assert.ok(/EDUCATION/.test(r.text), 'heading split');
    assert.ok(/efficiency/.test(r.text), 'word split mid-token');
    assert.ok(!/\b[A-Za-z]{1,2} [a-z]{1,3}\b(?= (by|the|of))/.test(r.text), 'suspicious fragmentation');
  });

  test(`${file} rejoins words hyphenated across a line break`, async () => {
    const r = await E.extractText(read(file), file);
    assert.ok(/cutting-edge/.test(r.text), 'hyphenated compound not rejoined');
  });

  test(`${file} scores like the same resume pasted as text`, async () => {
    const r = await E.extractText(read(file), file);
    const fromFile = ScanEngine.scan(r.text, { mode: 'auto' });
    const pasted = ScanEngine.scan(
      fs.readFileSync(path.join(__dirname, 'samples', 'ai-resume.txt'), 'utf8'),
      { mode: 'auto' }
    );
    assert.strictEqual(fromFile.mode, 'resume', 'should still detect a resume');
    assert.ok(
      Math.abs(fromFile.aiScore - pasted.aiScore) <= 8,
      `score drifted: file ${fromFile.aiScore} vs pasted ${pasted.aiScore}`
    );
  });
}

// ── DOCX ────────────────────────────────────────────────────────────

test('extracts text from a .docx', async () => {
  const r = await E.extractText(read('resume.docx'), 'resume.docx');
  assert.strictEqual(r.kind, 'docx');
  assert.ok(/Jane Doe/.test(r.text));
  assert.ok(/Spearheaded/.test(r.text));
});

test('docx paragraphs become line breaks', () => {
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>First line</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second line</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  assert.strictEqual(E.docxXmlToText(xml), 'First line\nSecond line');
});

test('docx entities are decoded, and ampersand last', () => {
  const xml = '<w:p><w:r><w:t>R&amp;D &lt;tag&gt; &quot;quoted&quot; &#233;</w:t></w:r></w:p>';
  assert.strictEqual(E.docxXmlToText(xml), 'R&D <tag> "quoted" é');
});

test('docx runs split mid-word are joined without a gap', () => {
  // Word splits runs on formatting changes, often mid-word.
  const xml = '<w:p><w:r><w:t>Spear</w:t></w:r><w:r><w:t>headed</w:t></w:r></w:p>';
  assert.strictEqual(E.docxXmlToText(xml), 'Spearheaded');
});

// ── CMap parsing ────────────────────────────────────────────────────

test('parses bfchar and bfrange CMap forms', () => {
  const cmap = E.parseCMap(`
    2 beginbfchar
    <0003> <0020>
    <0024> <0041>
    endbfchar
    1 beginbfrange
    <0025> <0027> <0042>
    endbfrange
    1 beginbfrange
    <0030> <0031> [<0058> <0059>]
    endbfrange
  `);
  assert.strictEqual(cmap.get(0x03), ' ');
  assert.strictEqual(cmap.get(0x24), 'A');
  assert.strictEqual(cmap.get(0x25), 'B');
  assert.strictEqual(cmap.get(0x27), 'D');
  assert.strictEqual(cmap.get(0x30), 'X');
  assert.strictEqual(cmap.get(0x31), 'Y');
});

// ── Stream boundaries ───────────────────────────────────────────────
//
// Every case here comes from one real resume that extracted as empty and was
// reported as scanned. Its only content stream ended in 0x0A; the trailing-EOL
// trim ate that byte, inflate failed, and the document looked textless.

/** Assemble a one-object PDF with an accurate /Length. */
function onePdf(dict, streamBytes) {
  const body = Buffer.from(streamBytes, typeof streamBytes === 'string' ? 'latin1' : undefined);
  const head = `%PDF-1.4\n1 0 obj <<${dict} /Length ${body.length}>>\nstream\n`;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(head, 'latin1'),
      body,
      Buffer.from('\nendstream\nendobj\ntrailer <</Root 1 0 R>>\n%%EOF\n', 'latin1'),
    ])
  );
}

// A real deflate stream whose final byte is 0x0A — the exact shape that broke.
const FLATE_ENDING_IN_NEWLINE = Buffer.from(
  'eJw1yz0OQEAQBtCrfCWVn0ZNrCDKucCElV1ZRjZDHF9D+5LXELKuQFGCVlQlqjwHLUg6eTSKYvI7o7VBGcOxeEYvasMnZnaC8QreKprIt+BvdTgdp6ANhl6tCR8K',
  'base64'
);

test('a compressed stream whose last byte is a newline still inflates', async () => {
  assert.strictEqual(
    FLATE_ENDING_IN_NEWLINE[FLATE_ENDING_IN_NEWLINE.length - 1],
    0x0a,
    'the fixture no longer reproduces the bug'
  );
  const r = await E.extractText(onePdf('/Filter /FlateDecode', FLATE_ENDING_IN_NEWLINE), 'x.pdf');
  assert.match(r.text, /Foxtrot Lima Delta India Hotel/);
});

test('the declared /Length wins over a scan for the endstream keyword', async () => {
  // Compressed bytes can spell "endstream"; scanning for it truncates them.
  const r = await E.extractText(
    onePdf('', 'BT /F1 12 Tf 72 700 Td (Alpha endstream Bravo Charlie Delta) Tj ET'),
    'x.pdf'
  );
  assert.match(r.text, /Alpha endstream Bravo Charlie Delta/);
});

// ── A partial read is an error, never a score ───────────────────────

test('a content stream that will not decode fails loudly', async () => {
  await assert.rejects(
    () => E.extractText(onePdf('/Filter /FlateDecode', 'not deflate data at all'), 'x.pdf'),
    /Could not read this PDF.*failed to decode/s
  );
});

test('the decode error says scoring the remnant would be worse', async () => {
  // The whole point: a confident score on a failed read is worse than an
  // error, because nothing distinguishes it from a clean one.
  await E.extractText(onePdf('/Filter /FlateDecode', 'not deflate data'), 'x.pdf').then(
    () => assert.fail('should have thrown'),
    (err) => assert.match(err.message, /worse than|Export a fresh PDF|paste the text/)
  );
});

test('an image that will not decode does not fail a readable page', async () => {
  // Only text we could not read is a failure. A broken image costs nothing.
  const head = '%PDF-1.4\n';
  const text = 'BT /F1 12 Tf 72 700 Td (Alpha Bravo Charlie Delta Echo) Tj ET';
  const junk = 'not deflate data at all';
  const doc =
    head +
    `1 0 obj <</Length ${text.length}>>\nstream\n${text}\nendstream\nendobj\n` +
    `2 0 obj <</Subtype /Image /Filter /FlateDecode /Length ${junk.length}>>\n` +
    `stream\n${junk}\nendstream\nendobj\ntrailer <</Root 1 0 R>>\n%%EOF\n`;
  const r = await E.extractText(new Uint8Array(Buffer.from(doc, 'latin1')), 'x.pdf');
  assert.match(r.text, /Alpha Bravo Charlie Delta Echo/);
});

test('a page that draws text but yields almost none is refused', async () => {
  // Glyphs that map to nothing: the operators are there, the characters are
  // not. That is a fragment, and a fragment must not reach the scorer.
  const runs = Array.from({ length: 40 }, () => '<0000> Tj').join(' ');
  const r = onePdf('', `BT /F1 12 Tf 72 700 Td ${runs} ET`);
  await assert.rejects(() => E.extractText(r, 'x.pdf'), /Could not read this PDF|No readable text/);
});

test('the real fixtures clear the yield floor comfortably', async () => {
  // Guard on the guard: the floor must never grow into a real document.
  for (const name of ['resume-chromium.pdf', 'resume-chromium-times.pdf']) {
    const r = await E.extractText(read(name), name);
    assert.ok(r.text.length > 400, `${name} extracted only ${r.text.length} chars`);
  }
});

// ── Failure paths ───────────────────────────────────────────────────

test('rejects an empty file', async () => {
  await assert.rejects(() => E.extractText(new Uint8Array(0), 'x.pdf'), /empty/i);
});

test('rejects a file over the size cap', async () => {
  const big = new Uint8Array(E.MAX_BYTES + 1);
  big[0] = 0x25;
  await assert.rejects(() => E.extractText(big, 'x.pdf'), /limit is 12MB/);
});

test('reports an encrypted PDF in plain language', async () => {
  const fake = new TextEncoder().encode('%PDF-1.7\n1 0 obj <</Encrypt 2 0 R>> endobj\n');
  await assert.rejects(() => E.extractText(fake, 'x.pdf'), /password-protected/i);
});

test('reports a PDF with no extractable text rather than returning nothing', async () => {
  const fake = new TextEncoder().encode('%PDF-1.4\n1 0 obj <</Type/Page>> endobj\ntrailer\n');
  await assert.rejects(() => E.extractText(fake, 'x.pdf'), /No readable text|scanned/i);
});

test('names OCR as the reason for a scanned PDF', async () => {
  const fake = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj <</Type/XObject /Subtype /Image /Width 100>> endobj\ntrailer\n'
  );
  await assert.rejects(() => E.extractText(fake, 'x.pdf'), /scanned|OCR/i);
});

test('rejects a non-docx zip with a useful message', async () => {
  await assert.rejects(() => E.extractText(read('resume.docx'), 'archive.zip'), /zip/i);
});

test('plain text passes through with newlines normalized', async () => {
  const r = await E.extractText(new TextEncoder().encode('one\r\ntwo\rthree'), 'a.txt');
  assert.strictEqual(r.kind, 'text');
  assert.strictEqual(r.text, 'one\ntwo\nthree');
});

// ── Report ──────────────────────────────────────────────────────────

Promise.all(pending).then(() => {
  console.log(`\nextract: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
});
