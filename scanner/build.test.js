/**
 * Build tests — the page has to be self-contained, because the artifact CSP
 * silently drops anything it isn't. A broken bundle looks fine locally and
 * renders as a dead page once published, so these run in CI-style with the
 * rest of the suite.
 */

const assert = require('assert');
const fs = require('fs');
const { build } = require('./build.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}\n    ${err.message}`);
  }
}

const html = fs.readFileSync(build().path, 'utf8');

test('every injection marker is resolved', () => {
  assert.ok(!html.includes('/*INJECT:'), 'unresolved marker left in output');
});

test('both engines and the orchestrator are inlined', () => {
  assert.ok(html.includes('const AIDetector'), 'prose detector missing');
  assert.ok(html.includes('const ResumeRules'), 'resume rules missing');
  assert.ok(html.includes('const ScanEngine'), 'engine missing');
  assert.ok(html.includes('const Fixer'), 'fixer missing');
  assert.ok(html.includes('const Extract'), 'extractor missing');
  assert.ok(html.includes('const Scoring'), 'scoring/bands missing');
  assert.ok(html.includes('const HouseRules'), 'house rules missing');
  assert.ok(html.includes('const Corpus'), 'corpus missing');
  assert.ok(html.includes('const Fingerprint'), 'fingerprint missing');
  assert.ok(html.includes('const Voice'), 'voice missing');
});

test('samples are inlined', () => {
  for (const key of ['ai-essay', 'human-essay', 'ai-resume', 'human-resume']) {
    assert.ok(html.includes(`"${key}"`), `sample ${key} missing`);
  }
});

test('no external script or style host other than Google Fonts', () => {
  const srcs = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  assert.deepStrictEqual(srcs, [], `external scripts would be blocked: ${srcs}`);

  const hrefs = [...html.matchAll(/<link[^>]*\shref=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const href of hrefs) {
    assert.ok(
      /^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(href),
      `only Google Fonts survives the CSP, got ${href}`
    );
  }
});

test('no network calls at runtime', () => {
  for (const call of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'import(']) {
    assert.ok(!html.includes(call), `${call} would be blocked by the CSP`);
  }
});

test('no stray closing script tag inside inlined code', () => {
  // One closing tag per opening tag, and no more.
  const opens = (html.match(/<script\b/gi) || []).length;
  const closes = (html.match(/<\/script>/gi) || []).length;
  assert.strictEqual(opens, closes, `${opens} <script> vs ${closes} </script>`);
});

test('declares a title and both theme stamps', () => {
  assert.ok(/<title>[^<]+<\/title>/.test(html), 'no title');
  assert.ok(html.includes('prefers-color-scheme: dark'), 'no system dark theme');
  assert.ok(html.includes(':root[data-theme="dark"]'), 'no explicit dark stamp');
  assert.ok(html.includes(':root:not([data-theme="light"])'), 'dark media query is not guarded');
  assert.ok(/body\s*\{[^}]*background:\s*var\(--ground\)/.test(html), 'body has no explicit background');
});

test('the bundle is comfortably inside the artifact size cap', () => {
  const mb = Buffer.byteLength(html) / (1024 * 1024);
  assert.ok(mb < 16, `bundle is ${mb.toFixed(2)}MB, over the 16MB cap`);
});

test('every script block in the bundle compiles', () => {
  // The app block references document/window so it cannot be run here, but
  // `new Function` compiles without executing — which is exactly what catches
  // a syntax error introduced by a bad injection.
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 11, `expected 11 script blocks, got ${blocks.length}`);
  blocks.forEach((code, i) => {
    assert.doesNotThrow(() => new Function(code), `script block ${i} has a syntax error`);
  });
});

test('the built page evaluates its engines without a DOM', () => {
  // Pull the three engine scripts out of the bundle and run them in a bare
  // context. Catches a syntax error introduced by inlining before it ships.
  const vm = require('vm');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const engineBlocks = blocks.filter(
    (b) =>
      b.includes('const AIDetector') ||
      b.includes('const ResumeRules') ||
      b.includes('const Fixer') ||
      b.includes('const Extract') ||
      b.includes('const Scoring') ||
      b.includes('const HouseRules') ||
      b.includes('const Corpus') ||
      b.includes('const Fingerprint') ||
      b.includes('const Voice') ||
      b.includes('const ScanEngine')
  );
  assert.strictEqual(engineBlocks.length, 10, `expected 10 engine blocks, got ${engineBlocks.length}`);

  const sandbox = { module: undefined, console };
  vm.createContext(sandbox);
  for (const block of engineBlocks) vm.runInContext(block, sandbox);

  const result = vm.runInContext(
    'ScanEngine.scan("Certainly! Let us delve into this rich tapestry of innovation. ' +
      'It is important to note that this is a testament to our commitment to excellence, ' +
      'and moreover, the future looks bright.", {mode: "essay"})',
    sandbox
  );
  assert.ok(result.aiScore > 0, `expected the bundled engine to flag AI prose, got ${result.aiScore}`);
  assert.ok(Array.isArray(result.proseIssues) && result.proseIssues.length > 0, 'no issues returned');

  const fixed = vm.runInContext(
    'Fixer.fix("Moreover, it is important to note that we leverage cutting-edge technology " +' +
      '"to deliver robust solutions for the whole industry.", ' +
      'AIDetector.analyzeText("Moreover, it is important to note that we leverage cutting-edge " +' +
      '"technology to deliver robust solutions for the whole industry.").issues)',
    sandbox
  );
  const bands = vm.runInContext('Scoring.BANDS.map(b => b.id + ":" + b.min + "-" + b.max).join(",")', sandbox);
  assert.strictEqual(
    bands,
    'clean:0-15,some:16-40,assisted:41-70,machine:71-100',
    `bundled bands drifted from the source of truth: ${bands}`
  );
  const banded = vm.runInContext(
    'ScanEngine.scan(' + JSON.stringify(require('fs').readFileSync(require('path').join(__dirname, 'samples', 'ai-essay.md'), 'utf8')) + ', {mode:"essay"})',
    sandbox
  );
  assert.strictEqual(banded.band.id, 'machine', `bundled AI essay scored ${banded.aiScore}`);

  // The page must ship byte-identical rules to the CLI and the skill.
  const bundledRules = vm.runInContext('HouseRules.toJSON(HouseRules.DEFAULT_RULES)', sandbox);
  assert.strictEqual(
    bundledRules.trim(),
    require('fs').readFileSync(require('path').join(__dirname, '..', 'house-rules.json'), 'utf8').trim(),
    'bundled house rules differ from house-rules.json'
  );

  assert.ok(fixed.applied > 0, 'bundled fixer applied nothing');
  assert.ok(!/Moreover/.test(fixed.text), `bundled fixer left filler in: ${fixed.text}`);
});

console.log(`\nbuild: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
