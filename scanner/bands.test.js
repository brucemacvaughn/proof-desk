/**
 * Band calibration tests. node scanner/bands.test.js
 *
 * The fixture corpus in samples/fixtures/manifest.json is the contract for
 * what the score means. If a change to the rules, the weights, or the curve
 * moves any document out of its band, this fails — which is the whole point.
 *
 * Two fixtures are false-positive guards and matter more than the rest:
 * human-technical.md (dense imperative technical prose) and
 * human-nonnative.md (second-language English). Published audits put detector
 * false-positive rates above 60% on non-native writers, so a calibration that
 * lifts either out of the clean band is a regression no matter what it does
 * for the machine-written fixtures.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Scoring = require('./scoring.js');
const ScanEngine = require('./engine.js');

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

const SAMPLES = path.join(__dirname, 'samples');
const manifest = JSON.parse(
  fs.readFileSync(path.join(SAMPLES, 'fixtures', 'manifest.json'), 'utf8')
);

const scoreOf = (f) =>
  ScanEngine.scan(fs.readFileSync(path.join(SAMPLES, f.file), 'utf8'), { mode: f.mode });

// ── The bands themselves ────────────────────────────────────────────

test('bands cover 0-100 with no gap and no overlap', () => {
  const bands = Scoring.BANDS;
  assert.strictEqual(bands[0].min, 0, 'must start at 0');
  assert.strictEqual(bands[bands.length - 1].max, 100, 'must end at 100');
  for (let i = 1; i < bands.length; i += 1) {
    assert.strictEqual(
      bands[i].min,
      bands[i - 1].max + 1,
      `gap or overlap between ${bands[i - 1].id} and ${bands[i].id}`
    );
  }
});

test('bands match the documented ranges', () => {
  const got = Scoring.BANDS.map((b) => `${b.id}:${b.min}-${b.max}`);
  assert.deepStrictEqual(got, [
    'clean:0-15',
    'some:16-40',
    'assisted:41-70',
    'machine:71-100',
  ]);
});

test('bandFor lands on the right side of every boundary', () => {
  const cases = [
    [0, 'clean'], [15, 'clean'], [16, 'some'], [40, 'some'],
    [41, 'assisted'], [70, 'assisted'], [71, 'machine'], [100, 'machine'],
  ];
  for (const [score, id] of cases) {
    assert.strictEqual(Scoring.bandFor(score).id, id, `${score} should be ${id}`);
  }
});

test('bandFor clamps out-of-range input instead of returning undefined', () => {
  assert.strictEqual(Scoring.bandFor(-20).id, 'clean');
  assert.strictEqual(Scoring.bandFor(500).id, 'machine');
  assert.strictEqual(Scoring.bandFor(NaN).id, 'clean');
  assert.strictEqual(Scoring.bandFor(undefined).id, 'clean');
});

test('every band carries a label and a blurb for the UI', () => {
  for (const b of Scoring.BANDS) {
    assert.ok(b.label && b.label.length > 3, `${b.id} has no label`);
    assert.ok(b.blurb && b.blurb.length > 10, `${b.id} has no blurb`);
    assert.ok(['low', 'mid', 'high'].includes(b.tone), `${b.id} has no tone`);
  }
});

// ── The corpus ──────────────────────────────────────────────────────

test('the corpus covers every band', () => {
  const covered = new Set(manifest.fixtures.map((f) => f.band));
  for (const b of Scoring.BANDS) {
    assert.ok(covered.has(b.id), `no fixture exercises the "${b.id}" band`);
  }
});

test('the corpus is big enough to be worth trusting', () => {
  assert.ok(
    manifest.fixtures.length >= 10,
    `only ${manifest.fixtures.length} fixtures; want at least 10`
  );
});

test('every fixture named in the manifest exists', () => {
  for (const f of manifest.fixtures) {
    assert.ok(fs.existsSync(path.join(SAMPLES, f.file)), `missing fixture: ${f.file}`);
    assert.ok(f.why && f.why.length > 10, `${f.file} has no rationale`);
  }
});

// One test per fixture, so a failure names the document.
for (const f of manifest.fixtures) {
  test(`${f.file} lands in the "${f.band}" band`, () => {
    const r = scoreOf(f);
    const band = Scoring.bandFor(r.aiScore);
    assert.strictEqual(
      band.id,
      f.band,
      `scored ${r.aiScore} (${band.id}), expected ${f.band}. ` +
        `density ${r.calibration.density}, evidence ${r.calibration.evidence}, ` +
        `base ${r.calibration.baseScore}. Rationale: ${f.why}`
    );
  });
}

// ── The properties the bands exist to guarantee ─────────────────────

test('machine-written fixtures all clear the top-band floor', () => {
  const floor = Scoring.BANDS.find((b) => b.id === 'machine').min;
  for (const f of manifest.fixtures.filter((x) => x.band === 'machine')) {
    const r = scoreOf(f);
    assert.ok(r.aiScore >= floor, `${f.file} scored ${r.aiScore}, below ${floor}`);
  }
});

test('human fixtures all stay inside the clean band', () => {
  const ceiling = Scoring.BANDS.find((b) => b.id === 'clean').max;
  for (const f of manifest.fixtures.filter((x) => x.band === 'clean')) {
    const r = scoreOf(f);
    assert.ok(r.aiScore <= ceiling, `${f.file} scored ${r.aiScore}, above ${ceiling}`);
  }
});

test('false-positive guards stay clean', () => {
  // These two carry the project's whole claim about being FN-biased.
  for (const file of ['fixtures/human-technical.md', 'fixtures/human-nonnative.md']) {
    const f = manifest.fixtures.find((x) => x.file === file);
    assert.ok(f, `${file} is missing from the manifest`);
    const r = scoreOf(f);
    assert.ok(r.aiScore <= 15, `${file} scored ${r.aiScore}; must stay clean`);
  }
});

test('there is real separation between the machine floor and the human ceiling', () => {
  const machine = manifest.fixtures.filter((f) => f.band === 'machine').map((f) => scoreOf(f).aiScore);
  const human = manifest.fixtures.filter((f) => f.band === 'clean').map((f) => scoreOf(f).aiScore);
  const gap = Math.min(...machine) - Math.max(...human);
  assert.ok(gap >= 50, `only ${gap} points between the worst machine and best human fixture`);
});

test('the scale actually reaches the top band', () => {
  // The bug this recalibration existed to fix: obviously generated prose
  // topped out near 50, so the upper half of the scale was unreachable.
  const top = Math.max(
    ...manifest.fixtures.filter((f) => f.band === 'machine').map((f) => scoreOf(f).aiScore)
  );
  assert.ok(top >= 85, `highest fixture only reached ${top}; the ceiling is still unreachable`);
});

// ── Curve behaviour ─────────────────────────────────────────────────

test('score rises monotonically with density', () => {
  const issue = { severity: 'high' };
  let last = -1;
  for (const n of [3, 5, 10, 20, 40]) {
    const r = Scoring.calibrate({ baseScore: 0, issues: Array(n).fill(issue), wordCount: 200 });
    assert.ok(r.score >= last, `score fell from ${last} to ${r.score} at ${n} flags`);
    last = r.score;
  }
});

test('a lone finding is damped, never enough on its own', () => {
  const r = Scoring.calibrate({
    baseScore: 0,
    issues: [{ severity: 'critical' }],
    wordCount: 120,
  });
  assert.ok(r.score <= 15, `one finding scored ${r.score}; must stay clean`);
});

test('the same density scores the same at any length', () => {
  const issue = { severity: 'high' };
  const short = Scoring.calibrate({ baseScore: 0, issues: Array(10).fill(issue), wordCount: 200 });
  const long = Scoring.calibrate({ baseScore: 0, issues: Array(50).fill(issue), wordCount: 1000 });
  assert.ok(
    Math.abs(short.score - long.score) <= 2,
    `length still shifts the score: ${short.score} vs ${long.score}`
  );
});

test('the detector score is never talked down by the curve', () => {
  const r = Scoring.calibrate({ baseScore: 62, issues: [{ severity: 'low' }], wordCount: 900 });
  assert.ok(r.score >= 62, `curve lowered a confident detector score to ${r.score}`);
});

test('too little text stays in the clean band rather than guessing', () => {
  const r = Scoring.calibrate({
    baseScore: 90,
    issues: Array(6).fill({ severity: 'critical' }),
    wordCount: 12,
  });
  assert.strictEqual(r.band.id, 'clean', `scored ${r.score} on 12 words`);
});

test('no findings means no density contribution', () => {
  const r = Scoring.calibrate({ baseScore: 0, issues: [], wordCount: 500 });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.band.id, 'clean');
});

test('scores stay inside 0-100 under absurd input', () => {
  const r = Scoring.calibrate({
    baseScore: 100,
    issues: Array(500).fill({ severity: 'critical' }),
    wordCount: 60,
  });
  assert.ok(r.score >= 0 && r.score <= 100, `out of range: ${r.score}`);
  assert.strictEqual(r.band.id, 'machine');
});

test('calibrate survives missing and malformed input', () => {
  for (const input of [undefined, {}, { baseScore: null, issues: null, wordCount: null }]) {
    const r = Scoring.calibrate(input);
    assert.ok(Number.isFinite(r.score), `non-finite score for ${JSON.stringify(input)}`);
    assert.ok(r.band && r.band.id, 'no band returned');
  }
});

// ── Integration ─────────────────────────────────────────────────────

test('scan() exposes the band alongside the score', () => {
  const r = ScanEngine.scan(
    fs.readFileSync(path.join(SAMPLES, 'ai-essay.md'), 'utf8'),
    { mode: 'essay' }
  );
  assert.ok(r.band && r.band.id, 'scan returned no band');
  assert.strictEqual(r.band.id, Scoring.bandFor(r.aiScore).id, 'band disagrees with score');
  assert.strictEqual(r.label, r.band.label, 'label should come from the band');
});

test('resume craft is scored independently of the AI band', () => {
  const r = ScanEngine.scan(
    fs.readFileSync(path.join(SAMPLES, 'ai-resume.txt'), 'utf8'),
    { mode: 'resume' }
  );
  assert.strictEqual(r.band.id, 'machine', `AI resume scored ${r.aiScore}`);
  assert.ok(r.craftScore >= 80, `craft collapsed to ${r.craftScore} — the axes should be separate`);
});

console.log(`\nbands: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
