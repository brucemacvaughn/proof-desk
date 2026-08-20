/**
 * Voice comparison tests (Phase 2, Stage 3).
 * node scanner/voice.test.js
 *
 * Three properties carry the weight:
 *
 *   1. SEPARATION. VOICE MATCH never moves the AI score and the AI score
 *      never moves VOICE MATCH. Same rule as house rules: a style deviation
 *      is not evidence of machine authorship, and mixing them would corrupt
 *      the Phase 0 calibration.
 *   2. BANDS, NOT MEANS. The writer's own documents — across every register
 *      in the corpus — must produce zero findings. If a writer's own work
 *      gets flagged, they stop reading the findings.
 *   3. UNAVAILABLE IS SAID. A metric short of data produces no finding and
 *      is reported as unchecked. Silence would read as "checked and fine".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('./voice.js');
const F = require('./fingerprint.js');
const C = require('./corpus.js');
const ScanEngine = require('./engine.js');
const Scoring = require('./scoring.js');

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
const read = (p) => fs.readFileSync(path.join(SAMPLES, p), 'utf8');
const rep = (t, n) => Array.from({ length: n }, () => t).join('\n\n');

const OWN = [
  'human-essay.md',
  'fixtures/human-technical.md',
  'fixtures/human-short-note.md',
  'fixtures/human-cover-letter.md',
];

// Big enough that every metric, including absence, clears its requirement.
const PROFILE = F.build(
  C.usableSamples(OWN.map((p, i) => ({ label: `Sample ${i + 1}`, text: rep(read(p), 6) })))
);

// Deliberately thin: several metrics must decline.
const THIN = F.build(
  C.usableSamples([
    { label: 'One', text: rep(read('human-essay.md'), 2) },
    { label: 'Two', text: rep(read('fixtures/human-short-note.md'), 2) },
  ])
);

const compare = (file, profile = PROFILE) => V.compare(read(file), profile);

// ── 2. Bands, not means: the writer's own work must pass ────────────

test("every register in the writer's own corpus scores clean", () => {
  for (const file of OWN) {
    const r = compare(file);
    assert.strictEqual(
      r.findings.length,
      0,
      `${file} produced ${r.findings.length} findings: ${r.findings.map((f) => f.text).join(' | ')}`
    );
    assert.strictEqual(r.score, 100, `${file} scored ${r.score}`);
  }
});

test('a register the corpus contains does not get flagged for being different', () => {
  // The runbook and the incident note sit at opposite ends of the corpus's
  // contraction band (0% and 60%). Both are the writer. Neither may fire.
  const runbook = compare('fixtures/human-technical.md');
  const note = compare('fixtures/human-short-note.md');
  for (const r of [runbook, note]) {
    assert.ok(
      !r.findings.some((f) => f.metric === 'contractionRate'),
      `contraction rate fired on the writer's own work: ${JSON.stringify(r.findings)}`
    );
  }
});

test('a draft outside the band does fire', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  assert.ok(r.findings.length >= 3, `expected several findings, got ${r.findings.length}`);
  assert.ok(r.score < 60, `expected a low score, got ${r.score}`);
});

test('a value just outside the band is tolerated, far outside is not', () => {
  const band = PROFILE.metrics.sentenceLength.band;
  const width = band.high - band.low;
  const nudge = (target) => {
    // Build prose at roughly `target` words per sentence.
    const sentence = Array.from({ length: target }, (_, i) => `word${i}`).join(' ');
    return rep(`${sentence}.`, 12);
  };
  const slightly = V.compare(nudge(Math.round(band.high + width * 0.1)), PROFILE);
  const wildly = V.compare(nudge(Math.round(band.high + width * 4)), PROFILE);
  assert.ok(
    !slightly.findings.some((f) => f.metric === 'sentenceLength'),
    'a hair outside the band should not fire'
  );
  assert.ok(
    wildly.findings.some((f) => f.metric === 'sentenceLength'),
    'far outside the band should fire'
  );
});

// ── Findings are specific and checkable ─────────────────────────────

test('findings state the range and the draft value, never a similarity %', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  for (const f of r.findings) {
    assert.ok(!/similarity|% match|match score/i.test(f.text), `similarity phrasing: ${f.text}`);
    assert.ok(/\d/.test(f.text), `finding has no numbers: ${f.text}`);
    assert.ok(/this draft/i.test(f.text), `finding does not state the draft value: ${f.text}`);
  }
});

test('the sentence-length finding reads like the specification', () => {
  const long = rep(
    'I want to set out the position we have reached so far because the gap between ' +
      'what your team proposed in March and what we can commit to for the coming year ' +
      'has widened enough that it is worth writing down rather than working through it ' +
      'on calls where nobody takes notes and we both leave with different recollections.',
    8
  );
  const r = V.compare(long, PROFILE);
  const f = r.findings.find((x) => x.metric === 'sentenceLength');
  assert.ok(f, 'no sentence-length finding');
  assert.ok(
    /your sentences run [\d.]+ to [\d.]+ words, this draft averages [\d.]+/.test(f.text),
    f.text
  );
});

test('the contraction finding reads like the specification', () => {
  const formal = rep(
    'The committee will convene on Thursday. It is not possible to reschedule. ' +
      'The report has not been circulated. We do not expect an objection. ' +
      'The vendor has not responded. It is unfortunate but it is not fatal.',
    10
  );
  const r = V.compare(formal, PROFILE);
  const f = r.findings.find((x) => x.metric === 'contractionRate');
  if (!f) return; // the band is wide here; only assert the wording when it fires
  assert.ok(
    /you use contractions in [\d.]+% to [\d.]+% of sentences, this draft [\d.]+%/.test(f.text),
    f.text
  );
});

test('the absence finding reads like the specification', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  const f = r.findings.find((x) => x.metric === 'absentWords' && x.word === 'furthermore');
  assert.ok(f, 'furthermore should be reported absent from the corpus but present in the draft');
  assert.ok(
    /you never write "furthermore" across \d+ words, this draft uses it (once|twice|\d+ times)/.test(f.text),
    f.text
  );
});

test('a word the writer does use is not reported', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  const corpus = OWN.map(read).join(' ');
  for (const f of r.findings.filter((x) => x.metric === 'absentWords')) {
    const entry = F.absenceFor(f.word);
    assert.ok(entry, `"${f.word}" is reported but is not a candidate`);
    assert.strictEqual(
      F.absenceCount(entry, corpus),
      0,
      `"${f.word}" is used by the writer but reported absent`
    );
  }
});

test('a phrase in the draft is reported, not just single words', () => {
  const draft = rep(
    'We ran the rollout at scale and it is worth noting how far it went. ' +
      'The team will lean into the load-bearing parts of the plan next. ',
    12
  );
  const r = V.compare(draft, PROFILE);
  const reported = new Set(
    r.findings.filter((f) => f.metric === 'absentWords').map((f) => f.word)
  );
  for (const phrase of ['at scale', 'worth noting', 'lean into']) {
    // Only assert on candidates the corpus genuinely never uses.
    if (!PROFILE.metrics.absentWords.absent.includes(phrase)) continue;
    assert.ok(reported.has(phrase), `"${phrase}" is in the draft but was not reported`);
  }
});

test('"surface" in the draft is judged as a verb, not as a noun', () => {
  const absent = PROFILE.metrics.absentWords;
  if (!absent.available || !absent.absent.includes('surface (as a verb)')) return;
  const hit = (text) =>
    V.compare(rep(text, 12), PROFILE).findings.some(
      (f) => f.metric === 'absentWords' && f.word === 'surface (as a verb)'
    );
  assert.ok(
    hit('We should surface the risks before the review closes and say so plainly. '),
    'the verb in the draft was missed'
  );
  assert.ok(
    !hit('The surface area of the tank was measured again on the second pass. '),
    'the noun in the draft was flagged'
  );
});

test('a qualified candidate is quoted without its qualifier', () => {
  const absent = PROFILE.metrics.absentWords;
  if (!absent.available || !absent.absent.includes('surface (as a verb)')) return;
  const r = V.compare(
    rep('We should surface the risks before the review closes and say so plainly. ', 12),
    PROFILE
  );
  const f = r.findings.find((x) => x.word === 'surface (as a verb)');
  assert.ok(f);
  assert.ok(
    f.text.startsWith('you never write "surface" (as a verb) across '),
    `the qualifier belongs outside the quotes: ${f.text}`
  );
});

test('every finding carries the band it was judged against', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  for (const f of r.findings.filter((x) => x.band)) {
    assert.ok(Number.isFinite(f.band.low) && Number.isFinite(f.band.high), 'band is not numeric');
    assert.ok(Number.isFinite(f.draftValue), 'the draft value is missing');
  }
});

// ── 3. Unavailable is said out loud ─────────────────────────────────

test('a metric short of data produces no finding', () => {
  const r = V.compare(read('fixtures/ai-cover-letter.md'), THIN);
  const unavailableIds = new Set(THIN.metrics && Object.values(THIN.metrics)
    .filter((m) => !m.available)
    .map((m) => m.id));
  for (const f of r.findings) {
    assert.ok(!unavailableIds.has(f.metric), `${f.metric} fired while unavailable`);
  }
});

test('an unavailable metric is reported as unchecked, not skipped silently', () => {
  const r = V.compare(read('fixtures/ai-cover-letter.md'), THIN);
  assert.ok(r.unavailable.length > 0, 'nothing was reported as unavailable');
  for (const u of r.unavailable) {
    assert.ok(u.label, 'an unavailable entry has no label');
    assert.ok(/\d/.test(u.reason), `reason should say how much more is needed: ${u.reason}`);
  }
});

test('a thin profile cannot produce a confident verdict', () => {
  const r = V.compare(read('fixtures/ai-cover-letter.md'), THIN);
  assert.ok(
    r.unavailable.length >= r.findings.length,
    `more was claimed than checked: ${r.findings.length} findings, ${r.unavailable.length} unchecked`
  );
});

test('no profile at all declines rather than guessing', () => {
  const r = V.compare(read('human-essay.md'), null);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.score, null);
  assert.ok(/no voice profile/i.test(r.reason), r.reason);
  assert.deepStrictEqual(r.findings, []);
});

test('a profile with no available metric declines rather than scoring 100', () => {
  // An empty corpus produces a profile where nothing cleared its
  // requirement. Scoring 100 there would read as "sounds like you" when it
  // means "nothing was checked".
  const empty = F.build([]);
  const r = V.compare(read('fixtures/ai-cover-letter.md'), empty);
  assert.strictEqual(r.available, false, `scored ${r.score} against an empty profile`);
  assert.strictEqual(r.score, null);
  assert.ok(/nothing was checked/i.test(r.reason), r.reason);
  assert.ok(r.unavailable.length > 0, 'should still list what is missing');
});

test('too short a draft declines rather than guessing', () => {
  const r = V.compare('Only a few words here, nowhere near enough to judge a voice.', PROFILE);
  assert.strictEqual(r.available, false);
  assert.ok(/too short/i.test(r.reason), r.reason);
});

// ── 1. Separation, both directions ──────────────────────────────────

test('the AI score is identical with and without a voice profile', () => {
  for (const file of [...OWN, 'fixtures/ai-cover-letter.md', 'fixtures/ai-blog-post.md']) {
    const text = read(file);
    const withProfile = ScanEngine.scan(text, { mode: 'essay', profile: PROFILE });
    const without = ScanEngine.scan(text, { mode: 'essay' });
    assert.strictEqual(
      withProfile.aiScore,
      without.aiScore,
      `${file}: voice moved the AI score ${without.aiScore} -> ${withProfile.aiScore}`
    );
    assert.strictEqual(withProfile.band.id, without.band.id, `${file}: voice moved the AI band`);
  }
});

test('the voice score does not depend on the AI score', () => {
  // Same draft, scanned in the two modes that change the AI reading.
  const text = read('fixtures/ai-cover-letter.md');
  const a = ScanEngine.scan(text, { mode: 'essay', profile: PROFILE });
  const b = ScanEngine.scan(text, { mode: 'resume', profile: PROFILE });
  assert.notStrictEqual(a.aiScore, undefined);
  assert.strictEqual(
    a.voice.score,
    b.voice.score,
    `the AI reading changed the voice score: ${a.voice.score} vs ${b.voice.score}`
  );
});

test('voice findings are their own group, distinct from prose, resume and house', () => {
  const r = ScanEngine.scan(read('fixtures/ai-cover-letter.md'), {
    mode: 'essay',
    profile: PROFILE,
  });
  const all = ScanEngine.allIssues(r);
  const voice = all.filter((i) => i.source === 'voice');
  assert.ok(voice.length > 0, 'no voice findings');
  for (const f of voice) {
    assert.strictEqual(f.type, 'voice');
    assert.strictEqual(f.group, 'voice');
  }
  assert.ok(all.some((i) => i.source === 'prose'), 'prose findings should still be present');
  assert.ok(all.some((i) => i.source === 'house'), 'house findings should still be present');
});

test('voice findings never reach the calibration input', () => {
  const r = ScanEngine.scan(read('fixtures/ai-cover-letter.md'), {
    mode: 'essay',
    profile: PROFILE,
  });
  // Recompute the AI score from prose findings alone and require a match.
  const recomputed = Scoring.calibrate({
    baseScore: r.proseScore,
    issues: r.proseIssues,
    wordCount: r.stats.wordCount,
  });
  assert.strictEqual(
    r.aiScore,
    recomputed.score,
    'the AI score includes something other than prose findings'
  );
});

// ── The score ───────────────────────────────────────────────────────

test('every deducted point is attributable to a listed finding', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  const sum = r.findings.reduce((n, f) => n + f.penalty, 0);
  assert.strictEqual(r.deducted, sum, 'deductions do not match the findings');
  assert.strictEqual(r.score, Math.max(0, 100 - sum), 'the score is not the sum of its findings');
});

test('the score stays inside 0-100 however bad the draft', () => {
  const awful = rep(
    'Furthermore, notwithstanding the aforementioned considerations which have been ' +
      'delineated hereinbefore, it is incumbent upon the undersigned to articulate that ' +
      'the robust and comprehensive methodology employed throughout leverages a holistic ' +
      'paradigm of stakeholder engagement across the entirety of the operational landscape.',
    12
  );
  const r = V.compare(awful, PROFILE);
  assert.ok(r.score >= 0 && r.score <= 100, `out of range: ${r.score}`);
  assert.strictEqual(r.band.id, 'far', `expected the bottom band, got ${r.band.id}`);
});

test('bands cover 0-100 with no gap', () => {
  assert.strictEqual(V.BANDS[V.BANDS.length - 1].min, 0);
  assert.strictEqual(V.BANDS[0].max, 100);
  const sorted = [...V.BANDS].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.strictEqual(sorted[i].min, sorted[i - 1].max + 1, 'gap between voice bands');
  }
});

test('no single finding can take the score to zero on its own', () => {
  const r = compare('fixtures/ai-cover-letter.md');
  for (const f of r.findings) assert.ok(f.penalty <= V.MAX_PENALTY, `${f.metric} penalty ${f.penalty}`);
});

test('compare survives malformed input', () => {
  for (const bad of [null, undefined, '', 42]) {
    const r = V.compare(bad, PROFILE);
    assert.strictEqual(typeof r.available, 'boolean');
    assert.ok(Array.isArray(r.findings));
  }
  assert.strictEqual(V.compare('some text', { nonsense: true }).available, false);
});

// ── Staging ─────────────────────────────────────────────────────────

test('later phases have not leaked forward', () => {
  for (const name of ['rewrite', 'suggest', 'apply', 'autofix']) {
    assert.strictEqual(V[name], undefined, `Voice.${name} is not part of phase 2`);
  }
});

console.log(`\nvoice: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
