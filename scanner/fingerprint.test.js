/**
 * Voice fingerprint tests (Phase 2, Stage 2).
 * node scanner/fingerprint.test.js
 *
 * Weighted toward the four properties the fingerprint is supposed to have,
 * because those are what make it safe for stage 3 to build on:
 *
 *   1. It records the RANGE the corpus shows, not just an average.
 *   2. Every metric has its OWN data requirement and declines until met.
 *   3. Spoken samples feed vocabulary and nothing else.
 *   4. Every number is backed by excerpts you can go and read.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./fingerprint.js');
const C = require('./corpus.js');

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

const WRITTEN = [
  { label: 'Solar essay', text: rep(read('human-essay.md'), 4) },
  { label: 'Postgres runbook', text: rep(read('fixtures/human-technical.md'), 4) },
  { label: 'Incident note', text: rep(read('fixtures/human-short-note.md'), 4) },
  { label: 'Cover letter', text: rep(read('fixtures/human-cover-letter.md'), 4) },
];
const SPOKEN = {
  label: 'Conference talk (transcript)',
  type: 'spoken',
  text: rep(read('fixtures/human-nonnative.md'), 5),
};

const build = (samples) => F.build(C.usableSamples(samples));
const full = build(WRITTEN);

// ── Text units ──────────────────────────────────────────────────────

test('sentences split on terminal punctuation', () => {
  const s = F.sentences('One thing here. Another thing there! And a third? Yes.');
  assert.strictEqual(s.length, 4, JSON.stringify(s));
});

test('abbreviations do not end a sentence', () => {
  const s = F.sentences('We met Dr. Reyes at 3pm. She was late.');
  assert.strictEqual(s.length, 2, JSON.stringify(s));
});

test('headings, bullets and code fences are not prose', () => {
  const cleaned = F.cleanForProse(
    '# A Heading\n\n- a bullet point here\n\n```\ncode();\n```\n\nReal prose lives here.'
  );
  assert.ok(!/# A Heading/.test(cleaned), 'heading survived');
  assert.ok(!/code\(\)/.test(cleaned), 'code fence survived');
  assert.ok(/Real prose/.test(cleaned), 'prose was eaten');
});

test('a short unpunctuated fragment is not counted as a sentence', () => {
  // A signature line used to register as a one-word sentence and drag the
  // measured band down.
  const s = F.sentences('That is the whole story.\n\n— Dana');
  assert.strictEqual(s.length, 1, JSON.stringify(s));
});

test('syllable counting is roughly right', () => {
  assert.strictEqual(F.syllables('cat'), 1);
  assert.strictEqual(F.syllables('running'), 2);
  assert.ok(F.syllables('particularly') >= 4, F.syllables('particularly'));
});

// ── 1. Range, not averages ──────────────────────────────────────────

test('every numeric metric records a band, not just a mean', () => {
  for (const def of F.METRICS.filter((d) => d.kind === 'band')) {
    const m = full.metrics[def.id];
    if (!m.available) continue;
    assert.ok(m.band && Number.isFinite(m.band.low), `${def.id} has no band`);
    assert.ok(m.band.high >= m.band.low, `${def.id} band is inverted`);
    assert.ok(Number.isFinite(m.mean), `${def.id} has no mean`);
  }
});

test('the band comes from per-sample values, each attributable', () => {
  const m = full.metrics.sentenceLength;
  assert.strictEqual(m.perSample.length, 4);
  const values = m.perSample.map((p) => p.value);
  assert.strictEqual(m.band.low, Math.min(...values));
  assert.strictEqual(m.band.high, Math.max(...values));
  for (const p of m.perSample) assert.ok(p.label, 'a band endpoint has no sample label');
});

test('a divergent register widens the band rather than shifting a mean', () => {
  const longWinded = {
    label: 'Vendor negotiation',
    text: rep(
      'I want to set out the position we have reached so far, because I think the ' +
        'gap between what your team proposed in March and what we are able to commit ' +
        'to for the coming financial year has widened enough that it is worth writing ' +
        'down rather than continuing to work through it on calls where nobody takes ' +
        'notes and we both leave with a different recollection of what was agreed.',
      6
    ),
  };
  const widened = build([...WRITTEN, longWinded]);
  const before = full.metrics.sentenceLength.band;
  const after = widened.metrics.sentenceLength.band;
  assert.ok(after.high > before.high, `band did not widen: ${before.high} -> ${after.high}`);
  assert.ok(after.low <= before.low + 0.5, 'the low end should be roughly preserved');
});

test('a one-sample corpus cannot claim a range', () => {
  const one = build([{ label: 'Only one', text: rep(read('human-essay.md'), 8) }]);
  const m = one.metrics.sentenceLength;
  assert.strictEqual(m.available, false, 'a single sample should not produce a band');
  assert.ok(/at least 2/.test(m.reason), m.reason);
});

// ── 2. Per-metric confidence ────────────────────────────────────────

test('each metric declares its own data requirement', () => {
  const needs = F.METRICS.map((d) => d.needWords);
  assert.ok(new Set(needs).size > 1, 'requirements should differ per metric');
  const sentence = F.METRIC_BY_ID.sentenceLength.needWords;
  const absent = F.METRIC_BY_ID.absentWords.needWords;
  assert.ok(
    absent >= sentence * 4,
    `absence should need far more corpus than a mean: ${sentence} vs ${absent}`
  );
});

test('a thin corpus makes every metric unavailable, with numbers', () => {
  const thin = build([
    { label: 'One', text: read('human-essay.md') },
    { label: 'Two', text: read('fixtures/human-short-note.md') },
  ]);
  assert.strictEqual(thin.availableMetrics, 0, 'nothing should be available');
  for (const m of Object.values(thin.metrics)) {
    assert.strictEqual(m.available, false);
    assert.ok(/\d+/.test(m.reason), `${m.id} reason has no numbers: ${m.reason}`);
    assert.deepStrictEqual(m.evidence, [], `${m.id} produced evidence while unavailable`);
  }
});

test('an unavailable metric exposes no band, top list or word list', () => {
  const thin = build([{ label: 'One', text: read('human-essay.md') }]);
  for (const m of Object.values(thin.metrics)) {
    assert.strictEqual(m.band, undefined, `${m.id} leaked a band`);
    assert.strictEqual(m.top, undefined, `${m.id} leaked a top list`);
    assert.strictEqual(m.words, undefined, `${m.id} leaked words`);
    assert.strictEqual(m.absent, undefined, `${m.id} leaked an absence claim`);
  }
});

test('there is no single global confidence number', () => {
  assert.strictEqual(full.confidence, undefined, 'a global confidence would be a lie');
  assert.ok(Number.isFinite(full.availableMetrics), 'a count of real metrics is what is offered');
  assert.strictEqual(full.totalMetrics, F.METRICS.length);
});

test('metrics cross their thresholds independently', () => {
  const mid = build(WRITTEN.map((s) => ({ ...s, text: rep(s.text, 1) })));
  const ids = Object.values(mid.metrics);
  const available = ids.filter((m) => m.available).length;
  assert.ok(available > 0 && available < ids.length, `expected a mix, got ${available}/${ids.length}`);
});

// ── 3. Spoken samples ───────────────────────────────────────────────

test('a spoken sample is excluded from written-only metrics', () => {
  const withSpoken = build([...WRITTEN, SPOKEN]);
  assert.ok(withSpoken.builtFrom.spokenWords > 0, 'the spoken sample should be counted somewhere');
  assert.strictEqual(
    withSpoken.builtFrom.writtenWords,
    full.builtFrom.writtenWords,
    'written word count should not move when a transcript is added'
  );
  assert.strictEqual(
    withSpoken.metrics.sentenceLength.band.low,
    full.metrics.sentenceLength.band.low,
    'a transcript must not move the sentence-length band'
  );
  assert.strictEqual(withSpoken.metrics.sentenceLength.samples, 4, 'only written samples count');
});

test('a spoken sample does feed vocabulary metrics', () => {
  const withSpoken = build([...WRITTEN, SPOKEN]);
  assert.ok(
    withSpoken.metrics.signatureWords.have > full.metrics.signatureWords.have,
    'transcripts should add to the vocabulary word budget'
  );
});

test('a corpus of only transcripts gets vocabulary and nothing else', () => {
  const spokenOnly = build([
    { label: 'Talk 1', type: 'spoken', text: rep(read('human-essay.md'), 5) },
    { label: 'Talk 2', type: 'spoken', text: rep(read('fixtures/human-technical.md'), 5) },
  ]);
  assert.strictEqual(spokenOnly.builtFrom.writtenWords, 0);
  for (const def of F.METRICS.filter((d) => d.writtenOnly)) {
    assert.strictEqual(
      spokenOnly.metrics[def.id].available,
      false,
      `${def.id} should be unavailable with no written samples`
    );
  }
  assert.strictEqual(spokenOnly.metrics.signatureWords.available, true, 'vocabulary should survive');
});

test('the unavailability reason says transcripts do not count', () => {
  const spokenOnly = build([
    { label: 'Talk', type: 'spoken', text: rep(read('human-essay.md'), 5) },
    { label: 'Talk 2', type: 'spoken', text: rep(read('fixtures/human-technical.md'), 5) },
  ]);
  assert.ok(
    /Transcripts do not count/.test(spokenOnly.metrics.contractionRate.reason),
    spokenOnly.metrics.contractionRate.reason
  );
});

test('every written-only metric is one that transcription would distort', () => {
  const writtenOnly = F.METRICS.filter((d) => d.writtenOnly).map((d) => d.id);
  for (const id of [
    'sentenceLength', 'paragraphLength', 'commaRate', 'semicolonRate',
    'dashRate', 'parentheticalRate', 'contractionRate',
  ]) {
    assert.ok(writtenOnly.includes(id), `${id} should be written-only`);
  }
  assert.ok(!writtenOnly.includes('signatureWords'), 'vocabulary survives transcription');
  assert.ok(!writtenOnly.includes('absentWords'), 'absence survives transcription');
});

// ── 4. Evidence ─────────────────────────────────────────────────────

test('every available metric carries evidence', () => {
  for (const m of Object.values(full.metrics)) {
    if (!m.available) continue;
    assert.ok(m.evidence.length > 0, `${m.id} has no evidence`);
    for (const e of m.evidence) assert.ok(e.text && e.text.length > 0, `${m.id} evidence is empty`);
  }
});

test('sentence-length evidence is real sentences from the corpus, spanning the range', () => {
  const ev = full.metrics.sentenceLength.evidence;
  assert.ok(ev.length >= 3, `expected short/middle/long, got ${ev.length}`);
  const corpus = C.usableSamples(WRITTEN).map((s) => F.cleanForProse(s.text)).join('\n');
  for (const e of ev) {
    const snippet = e.text.replace(/…$/, '').slice(0, 40).replace(/\s+/g, ' ');
    assert.ok(
      corpus.replace(/\s+/g, ' ').includes(snippet),
      `evidence not found in the corpus: ${snippet}`
    );
    assert.ok(e.sample, 'evidence is not attributed to a sample');
  }
  assert.ok(ev[ev.length - 1].value > ev[0].value, 'evidence should span short to long');
});

test('contraction evidence is sentences that actually contain contractions', () => {
  const m = full.metrics.contractionRate;
  if (!m.available || !m.evidence.length) return;
  for (const e of m.evidence) {
    assert.ok(F.CONTRACTION_RE.test(e.text), `no contraction in evidence: ${e.text}`);
  }
});

test('band-metric evidence names the samples at each end', () => {
  const m = full.metrics.readingLevel;
  assert.ok(m.evidence.every((e) => e.sample), 'reading-level evidence is unattributed');
});

// ── Vocabulary ──────────────────────────────────────────────────────

test('signature words exclude stopwords and one-off topic words', () => {
  const m = full.metrics.signatureWords;
  assert.strictEqual(m.available, true);
  for (const w of m.words) {
    assert.ok(!['the', 'and', 'that', 'with'].includes(w.word), `stopword surfaced: ${w.word}`);
    assert.ok(w.spread >= 2, `${w.word} appears in only one sample`);
    assert.ok(w.count >= 3, `${w.word} appears only ${w.count} times`);
  }
});

test('absence is only claimed over the corpus actually read', () => {
  const m = full.metrics.absentWords;
  if (!m.available) return;
  assert.ok(m.observedOver > 0, 'absence must state how much text it looked at');
  const corpus = C.usableSamples(WRITTEN).join(' ');
  for (const label of m.absent) {
    const entry = F.absenceFor(label);
    assert.ok(entry, `"${label}" is reported absent but is not a candidate`);
    assert.strictEqual(
      F.absenceCount(entry, corpus),
      0,
      `"${label}" is claimed absent but appears in the corpus`
    );
  }
});

// ── Candidates: words, phrases and the one ambiguous verb ───────────

test('every candidate has a distinct id and a compiled pattern', () => {
  const ids = new Set();
  for (const e of F.ABSENCE_ENTRIES) {
    assert.ok(e.label, 'a candidate has no label');
    assert.ok(!ids.has(e.id), `duplicate candidate id: ${e.id}`);
    ids.add(e.id);
    assert.ok(e.re instanceof RegExp, `${e.id} has no pattern`);
  }
  assert.strictEqual(ids.size, F.ABSENCE_ENTRIES.length);
});

test('a candidate can be looked back up by label or id', () => {
  for (const e of F.ABSENCE_ENTRIES) {
    assert.strictEqual(F.absenceFor(e.label), e, `${e.label} does not resolve`);
    assert.strictEqual(F.absenceFor(e.id), e, `${e.id} does not resolve`);
  }
  assert.strictEqual(F.absenceFor('a word nobody listed'), null);
});

test('the words requested for the list are all candidates', () => {
  const asked = [
    'genuinely', 'precisely', 'plainly', 'materially', 'fundamentally', 'notably',
    'crucially', 'arguably', 'ultimately', 'concretely', 'structurally', 'orthogonal',
    'adjacent', 'nuance', 'framing', 'unpack', 'surface (as a verb)', 'load-bearing',
    'at scale', 'lean into', 'worth noting', 'nonetheless', 'albeit', 'whereby',
    'thereby', 'insofar',
  ];
  const missing = asked.filter((w) => !F.absenceFor(w));
  assert.deepStrictEqual(missing, [], `not on the candidate list: ${missing.join(', ')}`);
});

test('a single-word candidate matches whole words only', () => {
  const nuance = F.absenceFor('nuance');
  assert.strictEqual(F.absenceCount(nuance, 'the nuance here'), 1);
  assert.strictEqual(F.absenceCount(nuance, 'a nuanced take'), 0, 'matched inside a longer word');
});

test('a phrase candidate matches across a line break, not its parts alone', () => {
  const worthNoting = F.absenceFor('worth noting');
  assert.strictEqual(F.absenceCount(worthNoting, 'it is worth\nnoting that'), 1);
  assert.strictEqual(F.absenceCount(worthNoting, 'noting the price is worth it'), 0);

  const atScale = F.absenceFor('at scale');
  assert.strictEqual(F.absenceCount(atScale, 'we ran it at scale'), 1);
  assert.strictEqual(F.absenceCount(atScale, 'the scale of the problem'), 0);
});

test('"surface" counts as a verb and not as a noun', () => {
  const e = F.absenceFor('surface (as a verb)');
  for (const verb of [
    'we need to surface the issue',
    'it surfaced during review',
    'surfacing risks early',
    'surface all assumptions',
  ]) {
    assert.strictEqual(F.absenceCount(e, verb), 1, `missed the verb in: ${verb}`);
  }
  for (const noun of [
    'the surface area of the tank',
    'the road surface was wet',
    'a surface anomaly',
  ]) {
    assert.strictEqual(F.absenceCount(e, noun), 0, `flagged the noun in: ${noun}`);
  }
});

test('a phrase the writer uses is not reported absent', () => {
  const withPhrases = build([
    ...WRITTEN.slice(0, 3),
    {
      label: 'Strategy note',
      text: rep('We ran it at scale and it is worth noting the team will lean into that. ', 60),
    },
  ]);
  const m = withPhrases.metrics.absentWords;
  if (!m.available) return;
  for (const used of ['at scale', 'worth noting', 'lean into']) {
    assert.ok(!m.absent.includes(used), `"${used}" is used but reported absent`);
  }
});

test('a word the writer does use is not reported absent', () => {
  const withFurthermore = build([
    ...WRITTEN.slice(0, 3),
    { label: 'Formal memo', text: rep('Furthermore, the position is unchanged and remains so. ', 60) },
  ]);
  const m = withFurthermore.metrics.absentWords;
  if (!m.available) return;
  assert.ok(!m.absent.includes('furthermore'), 'furthermore is used but reported absent');
});

// ── Structure and IO ────────────────────────────────────────────────

test('the profile records what it was built from', () => {
  assert.strictEqual(full.builtFrom.samples, 4);
  assert.strictEqual(full.builtFrom.sampleLabels.length, 4);
  assert.ok(full.builtFrom.writtenWords > 0);
});

test('export then import round-trips', () => {
  const json = F.toJSON(full);
  const back = F.fromJSON(json);
  assert.strictEqual(F.toJSON(back), json);
  assert.strictEqual(back.metrics.sentenceLength.band.low, full.metrics.sentenceLength.band.low);
});

test('import rejects junk and foreign formats', () => {
  assert.throws(() => F.fromJSON('nope'), /not valid JSON/i);
  assert.throws(() => F.fromJSON('{"format":"other"}'), /Unrecognized format/i);
  assert.throws(() => F.fromJSON('{"format":"proof-desk/fingerprint"}'), /no metrics/i);
});

test('building from nothing does not throw', () => {
  for (const input of [[], null, undefined]) {
    const p = F.build(input);
    assert.strictEqual(p.availableMetrics, 0);
    assert.strictEqual(p.builtFrom.totalWords, 0);
  }
});

// ── Staging ─────────────────────────────────────────────────────────

test('stage 2 exposes no comparison', () => {
  // Stage 3 owns the comparison; it must not leak forward into stage 2.
  for (const name of ['compare', 'voiceMatch', 'score', 'deviations']) {
    assert.strictEqual(F[name], undefined, `Fingerprint.${name} belongs to stage 3`);
  }
});

console.log(`\nfingerprint: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
