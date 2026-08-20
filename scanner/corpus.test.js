/**
 * Reference corpus tests (Phase 2, Stage 1: ingest).
 * node scanner/corpus.test.js
 *
 * The screening tests carry the most weight. The failure this feature is
 * most exposed to is silent: a corpus built from assistant-drafted samples
 * produces a fingerprint of the assistant, and then confidently tells the
 * writer their own voice is wrong. Every guard against that is tested here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('./corpus.js');
const { voiceDoc, VOICE_PATH, SKILL_PATH, sync } = require('./sync-rules.js');

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
const repeat = (t, n) => Array.from({ length: n }, () => t).join('\n\n');

const HUMAN = [
  { label: 'Solar quote essay', text: repeat(read('human-essay.md'), 3) },
  { label: 'Postgres runbook', text: repeat(read('fixtures/human-technical.md'), 3) },
  { label: 'Deploy incident note', text: repeat(read('fixtures/human-short-note.md'), 3) },
  { label: 'Cover letter to Priya', text: repeat(read('fixtures/human-cover-letter.md'), 3) },
];
const ASSISTED = { label: 'Cover letter (assistant)', text: repeat(read('fixtures/ai-cover-letter.md'), 2) };

// ── Sample validation ───────────────────────────────────────────────

test('a sample needs text', () => {
  assert.throws(() => C.normalizeSample({ label: 'empty', text: '' }), /no text/i);
  assert.throws(() => C.normalizeSample({}), /no text/i);
});

test('a sample under the word floor is rejected with the numbers', () => {
  assert.throws(
    () => C.normalizeSample({ label: 'tiny', text: 'a few words only here.' }),
    new RegExp(`${C.MIN_SAMPLE_WORDS} is the minimum`)
  );
});

test('a sample keeps its label and counts its words', () => {
  const s = C.normalizeSample(HUMAN[0]);
  assert.strictEqual(s.label, 'Solar quote essay');
  assert.ok(s.words >= C.MIN_SAMPLE_WORDS, `${s.words} words`);
  assert.strictEqual(s.words, C.countWords(HUMAN[0].text));
});

test('a sample with no label gets a positional one', () => {
  const s = C.normalizeSample({ text: HUMAN[0].text }, 2);
  assert.strictEqual(s.label, 'Sample 3');
});

test('duplicate labels get distinct ids', () => {
  const list = C.normalize([
    { label: 'Notes', text: HUMAN[0].text },
    { label: 'Notes', text: HUMAN[1].text },
  ]);
  assert.notStrictEqual(list[0].id, list[1].id);
});

test('the sample ceiling is enforced', () => {
  const many = Array.from({ length: C.MAX_SAMPLES + 1 }, () => ({ text: HUMAN[0].text }));
  assert.throws(() => C.normalize(many), /Too many samples/i);
});

test('normalize rejects a non-list', () => {
  assert.throws(() => C.normalize({ text: 'x' }), /must be a list/i);
});

// ── Screening: the guard the feature rests on ───────────────────────

test('an assistant-drafted sample is flagged', () => {
  const screened = C.screenSample(C.normalizeSample(ASSISTED));
  assert.strictEqual(screened.flagged, true, `scored ${screened.score}, not flagged`);
  assert.ok(/assistant/i.test(screened.reason), `reason should name the risk: ${screened.reason}`);
});

test('genuine human samples are not flagged', () => {
  for (const s of HUMAN) {
    const screened = C.screenSample(C.normalizeSample(s));
    assert.strictEqual(
      screened.flagged,
      false,
      `"${s.label}" was wrongly flagged at ${screened.score}/100`
    );
  }
});

test('a flagged sample is excluded from readiness', () => {
  const st = C.status([...HUMAN, ASSISTED]);
  assert.strictEqual(st.sampleCount, 5);
  assert.strictEqual(st.usableCount, 4, 'the assisted sample should not count');
  assert.ok(st.usableWords < st.totalWords, 'its words should not count either');
  assert.ok(st.flagged.some((f) => f.label === ASSISTED.label));
});

test('a flagged sample is left out of the text a fingerprint would read', () => {
  const text = C.usableText([...HUMAN, ASSISTED]);
  assert.ok(!/enthusiastic interest/i.test(text), 'assisted text leaked into the corpus');
  assert.ok(/solar/i.test(text), 'genuine text is missing');
});

test('an explicit override lets a flagged sample back in', () => {
  const st = C.status([...HUMAN, { ...ASSISTED, overrideScreen: true }]);
  assert.strictEqual(st.usableCount, 5, 'override should re-include it');
  assert.strictEqual(st.flagged.length, 0, 'an overridden sample is no longer blocking');
});

test('every screened sample reports a score', () => {
  for (const s of C.screen(HUMAN)) {
    assert.ok(s.screen, `${s.label} was not screened`);
    assert.ok(Number.isFinite(s.screen.score), `${s.label} has no score`);
    assert.ok(s.screen.band && s.screen.band.id, `${s.label} has no band`);
  }
});

// ── Readiness and confidence ────────────────────────────────────────

test('an empty corpus is not ready and says why', () => {
  const st = C.status([]);
  assert.strictEqual(st.ok, false);
  assert.strictEqual(st.confidence, 'none');
  assert.ok(st.reasons.length >= 2, 'should name both the sample and word shortfalls');
  assert.ok(st.reasons.some((r) => r.includes(`of ${C.MIN_SAMPLES} samples`)));
});

test('too few samples is not ready even with plenty of words', () => {
  const st = C.status([{ label: 'One long piece', text: repeat(read('human-essay.md'), 20) }]);
  assert.strictEqual(st.ok, false);
  assert.ok(st.usableWords > C.MIN_TOTAL_WORDS, 'this fixture should clear the word floor');
  assert.ok(st.reasons.some((r) => /samples/.test(r)), 'should complain about sample count');
});

test('enough samples but too few words is not ready', () => {
  const short = read('fixtures/human-short-note.md');
  const st = C.status(Array.from({ length: 4 }, (_, i) => ({ label: `Note ${i}`, text: short })));
  assert.strictEqual(st.ok, false);
  assert.ok(st.usableCount >= C.MIN_SAMPLES);
  assert.ok(st.reasons.some((r) => r.includes(`of ${C.MIN_TOTAL_WORDS} words`)));
});

test('a corpus that clears both floors is ready', () => {
  const st = C.status(HUMAN);
  assert.strictEqual(st.ok, true, `not ready: ${st.reasons.join('; ')}`);
  assert.ok(st.usableWords >= C.MIN_TOTAL_WORDS);
  assert.notStrictEqual(st.confidence, 'none');
});

test('a thin corpus reports low confidence rather than a confident number', () => {
  const st = C.status(HUMAN);
  assert.strictEqual(st.confidence, 'low', `expected low, got ${st.confidence}`);
});

test('confidence rises with more samples and more words', () => {
  const bigger = [
    ...HUMAN.map((s) => ({ ...s, text: repeat(s.text, 2) })),
    { label: 'Fifth', text: repeat(read('fixtures/human-cover-letter.md'), 4) },
    { label: 'Sixth', text: repeat(read('fixtures/human-technical.md'), 4) },
  ];
  const st = C.status(bigger);
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.confidence, 'high', `expected high, got ${st.confidence} (${st.usableWords} words)`);
});

test('status never throws on malformed input; it reports', () => {
  for (const bad of [null, undefined, [{ text: 'too short' }], 'nonsense']) {
    const st = C.status(bad);
    assert.strictEqual(typeof st.ok, 'boolean');
    assert.ok(Array.isArray(st.reasons));
  }
});

// ── Import / export ─────────────────────────────────────────────────

test('export then import round-trips', () => {
  const json = C.toJSON(HUMAN);
  assert.strictEqual(C.toJSON(C.fromJSON(json)), json);
});

test('the exported document carries the unassisted warning', () => {
  const doc = JSON.parse(C.toJSON(HUMAN));
  assert.strictEqual(doc.format, C.FORMAT);
  assert.ok(/unassisted/i.test(doc.note), 'export should restate the constraint');
});

test('an override survives a round trip', () => {
  const back = C.fromJSON(C.toJSON([...HUMAN, { ...ASSISTED, overrideScreen: true }]));
  assert.strictEqual(back[4].overrideScreen, true);
});

test('import rejects junk with an actionable message', () => {
  assert.throws(() => C.fromJSON('nope'), /not valid JSON/i);
  assert.throws(() => C.fromJSON('{"format":"other","samples":[]}'), /Unrecognized format/i);
  assert.throws(() => C.fromJSON('{"version":1}'), /no "samples" list/i);
});

test('a bare array of samples imports', () => {
  const list = C.fromJSON(JSON.stringify(HUMAN));
  assert.strictEqual(list.length, 4);
});

// ── Nothing else changes until a corpus exists ──────────────────────

test('an empty corpus contributes no text and no readiness', () => {
  assert.strictEqual(C.usableText([]), '');
  assert.strictEqual(C.status([]).ok, false);
});

test('stage 1 exposes no fingerprint or score', () => {
  // Guards the staging: comparison lands in stage 3, not before.
  for (const name of ['fingerprint', 'compare', 'voiceScore', 'match']) {
    assert.strictEqual(C[name], undefined, `Corpus.${name} should not exist yet`);
  }
});

// ── Skill parity ────────────────────────────────────────────────────

test('the generated skill docs are in sync', () => {
  assert.deepStrictEqual(sync({ check: true }), [], 'run npm run rules:sync');
});

test('VOICE.md states the unassisted constraint in plain terms', () => {
  const doc = fs.readFileSync(VOICE_PATH, 'utf8');
  assert.ok(/own unassisted writing/i.test(doc), 'the constraint is not stated');
  assert.ok(/describes the assistant, not the writer/i.test(doc), 'the consequence is not stated');
  assert.ok(doc.includes(String(C.MIN_SAMPLES)), 'sample floor missing');
  assert.ok(doc.includes(String(C.MIN_TOTAL_WORDS)), 'word floor missing');
});

test('SKILL.md points at VOICE.md', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(skill.includes('VOICE.md'), 'the skill does not link the corpus doc');
  assert.ok(/unassisted/i.test(skill), 'the skill does not restate the constraint');
});

test('the voice doc is generated, not hand-written', () => {
  assert.strictEqual(fs.readFileSync(VOICE_PATH, 'utf8'), voiceDoc());
});

console.log(`\ncorpus: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
