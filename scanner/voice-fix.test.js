/**
 * "More like me" tests. node scanner/voice-fix.test.js
 *
 * The tests that matter most are the refusals. A voice fixer's failure mode
 * is not a bad edit, it is a confident one: quietly rewriting a sentence it
 * did not understand, or nudging a statistic to raise the match score. Both
 * would make the VOICE MATCH number stop meaning anything, so both are
 * pinned here.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./fingerprint.js');
const C = require('./corpus.js');
const V = require('./voice.js');
const VF = require('./voice-fix.js');

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

const PROFILE = F.build(
  C.usableSamples(OWN.map((p, i) => ({ label: `Sample ${i + 1}`, text: rep(read(p), 6) })))
);

const measure = (t) => F.measureSample({ id: 'd', label: 'd', type: 'written', text: t });
const wordsOf = (t) => F.words(t).join(' ');

// A dense, formal block: twelve sentences, one paragraph, no contractions.
const DENSE = [
  'We shipped the change on Tuesday.',
  'It is not the fix we planned.',
  'The queue was backing up behind a lock.',
  'We could not reproduce it on staging.',
  'I am fairly sure the retry loop is the cause.',
  'They are going to test it again tomorrow.',
  'There is one more case we have not covered.',
  'We will not know until the load returns.',
  'That is the whole picture as of tonight.',
  'You are welcome to look at the trace.',
  'It is worth another pair of eyes.',
  'We have not closed the ticket yet.',
].join(' ');

// ── It never optimizes the score ────────────────────────────────────

test('a draft with no voice findings is returned untouched', () => {
  const text = read('human-essay.md');
  const cmp = V.compare(text, PROFILE);
  const r = VF.fix(text, cmp);
  if (cmp.available && cmp.findings.length === 0) {
    assert.strictEqual(r.changed, false, 'edited a draft that had nothing flagged');
    assert.strictEqual(r.text, text);
  }
  // Whatever it did, it may only have acted on listed findings.
  for (const a of r.applied) {
    assert.ok(
      cmp.findings.some((f) => f.metric === a.metric),
      `${a.metric} was edited but never flagged`
    );
  }
});

test('every edit traces to a listed finding and reports itself', () => {
  const cmp = V.compare(DENSE, PROFILE);
  const r = VF.fix(DENSE, cmp);
  for (const a of r.applied) {
    assert.ok(a.metric, 'an edit has no metric');
    assert.ok(a.label, `${a.metric} has no label`);
    assert.ok(a.count > 0, `${a.metric} reported ${a.count} edits`);
    assert.ok(a.what && /\d/.test(a.what), `${a.metric} does not say what it did: ${a.what}`);
  }
});

test('it declines when there is no comparison to work from', () => {
  for (const bad of [null, undefined, {}, { available: false }]) {
    const r = VF.fix('some text', bad);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.text, 'some text');
    assert.deepStrictEqual(r.applied, []);
  }
});

test('a second pass makes no further changes', () => {
  // Drifting on every run would mean it is chasing a number, not applying
  // a fixed set of edits.
  const once = VF.fix(DENSE, V.compare(DENSE, PROFILE)).text;
  const twice = VF.fix(once, V.compare(once, PROFILE)).text;
  assert.strictEqual(twice, once, 'the fixer keeps editing its own output');
});

// ── Refusals ────────────────────────────────────────────────────────

test('every judgment metric is refused with a reason', () => {
  for (const [metric, reason] of Object.entries(VF.MANUAL_REASON)) {
    assert.ok(reason.length > 20, `${metric} has no real explanation`);
    assert.ok(!VF.FIXABLE[metric], `${metric} is both fixable and manual`);
  }
});

test('a refused finding never edits the text', () => {
  const cmp = {
    available: true,
    findings: [
      { metric: 'sentenceLength', label: 'Sentence length', text: 'x', direction: 'above', band: { low: 1, high: 2 }, draftValue: 9 },
      { metric: 'readingLevel', label: 'Reading level', text: 'x', direction: 'above', band: { low: 1, high: 2 }, draftValue: 9 },
      { metric: 'commaRate', label: 'Commas', text: 'x', direction: 'above', band: { low: 1, high: 2 }, draftValue: 9 },
      { metric: 'sentenceOpeners', label: 'Openers', text: 'x' },
      { metric: 'parentheticalRate', label: 'Parentheticals', text: 'x', direction: 'above', band: { low: 1, high: 2 }, draftValue: 9 },
    ],
  };
  const r = VF.fix(DENSE, cmp);
  assert.strictEqual(r.changed, false, 'a judgment finding produced an edit');
  assert.strictEqual(r.manual.length, 5);
  for (const m of r.manual) assert.ok(m.reason, `${m.metric} was refused without saying why`);
});

test('signature words are never injected to raise the match', () => {
  assert.ok(VF.MANUAL_REASON.signatureWords, 'signature words must be refused outright');
  assert.ok(/game/i.test(VF.MANUAL_REASON.signatureWords), 'the reason should name the problem');
  assert.ok(!VF.FIXABLE.signatureWords);
  const r = VF.fix(DENSE, {
    available: true,
    findings: [{ metric: 'signatureWords', label: 'Signature words', text: 'x' }],
  });
  assert.strictEqual(r.changed, false);
});

test('canFix names only what fix would act on', () => {
  const cmp = V.compare(DENSE, PROFILE);
  const can = new Set(VF.canFix(cmp));
  for (const metric of can) assert.ok(VF.FIXABLE[metric], `${metric} is not a fixable metric`);
  const r = VF.fix(DENSE, cmp);
  for (const a of r.applied) assert.ok(can.has(a.metric), `${a.metric} was applied but not offered`);
});

// ── Paragraphs: structure only ──────────────────────────────────────

test('a dense draft is split to land inside the observed band', () => {
  const band = PROFILE.metrics.paragraphLength.band;
  const cmp = V.compare(DENSE, PROFILE);
  const finding = cmp.findings.find((f) => f.metric === 'paragraphLength');
  assert.ok(finding, 'the dense fixture should be flagged for paragraph length');
  assert.strictEqual(finding.direction, 'above');

  const r = VF.fix(DENSE, cmp);
  const after = measure(r.text).values.paragraphLength;
  assert.ok(after <= band.high + 0.01, `still ${after}, band tops out at ${band.high}`);
});

test('splitting a paragraph changes not one word', () => {
  const r = VF.splitParagraphs(DENSE, 3, F);
  assert.ok(r.count > 0, 'nothing was split');
  assert.strictEqual(wordsOf(r.text), wordsOf(DENSE), 'the split altered the words');
});

test('splitting divides evenly rather than shearing off a tail', () => {
  // Twelve sentences at a ceiling of 5 is three paragraphs of four, not
  // two of five and one of two.
  const r = VF.splitParagraphs(DENSE, 5, F);
  const sizes = r.text.split(/\n\s*\n+/).map((p) => F.sentences(p).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `uneven split: ${sizes.join(', ')}`);
});

test('a paragraph already inside the band is left alone', () => {
  const short = 'We shipped it. It broke. We rolled back.';
  const r = VF.splitParagraphs(short, 5, F);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.text, short);
});

test('fragmented paragraphs are joined back up', () => {
  const choppy = 'We shipped it.\n\nIt broke.\n\nWe rolled back.\n\nThe queue drained.';
  const r = VF.joinParagraphs(choppy, 3, F);
  assert.ok(r.count > 0, 'nothing was joined');
  assert.ok(r.text.split(/\n\s*\n+/).length < 4, 'still fragmented');
  assert.strictEqual(wordsOf(r.text), wordsOf(choppy), 'joining altered the words');
});

// ── Contractions ────────────────────────────────────────────────────

test('contractions are added when the draft is more formal than the writer', () => {
  const r = VF.editContractions('It is late and we do not know why.', 'tighten', 9);
  assert.strictEqual(r.text, "It's late and we don't know why.");
  assert.strictEqual(r.count, 2);
});

test('contractions are expanded in the other direction', () => {
  const r = VF.editContractions("It's late and we don't know why.", 'loosen', 9);
  assert.strictEqual(r.text, 'It is late and we do not know why.');
});

test('a contraction edit keeps the original capitalization', () => {
  assert.strictEqual(VF.editContractions('Do not stop.', 'tighten', 5).text, "Don't stop.");
  assert.strictEqual(VF.editContractions('It is here.', 'tighten', 5).text, "It's here.");
});

test('the budget stops it changing more than the band needs', () => {
  const text = 'It is one. It is two. It is three. It is four.';
  const r = VF.editContractions(text, 'tighten', 2);
  assert.strictEqual(r.count, 2, `changed ${r.count}`);
  assert.ok(/It is/.test(r.text), 'it converted the whole draft');
});

test('a contraction pattern does not fire inside a longer word', () => {
  const text = 'I ambled home. She cannotate nothing.';
  const r = VF.editContractions(text, 'tighten', 9);
  assert.ok(/I ambled/.test(r.text), `"I am" matched inside "ambled": ${r.text}`);
});

// ── Punctuation ─────────────────────────────────────────────────────

test('a semicolon becomes a full stop and the next word is capitalized', () => {
  const r = VF.fixSemicolons('The queue backed up; the lock never cleared.', 5);
  assert.strictEqual(r.text, 'The queue backed up. The lock never cleared.');
  assert.strictEqual(r.count, 1);
});

test('a dash joining a phrase becomes a comma', () => {
  const r = VF.fixDashes('We shipped it — a late change.', 5);
  assert.strictEqual(r.text, 'We shipped it, a late change.');
});

test('a dash joining two clauses becomes a full stop, not a comma splice', () => {
  const r = VF.fixDashes('We shipped it — it broke by morning.', 5);
  assert.strictEqual(r.text, 'We shipped it. It broke by morning.');
});

// ── Words the writer never uses ─────────────────────────────────────

test('a discourse adverb the writer never uses is cut from the sentence head', () => {
  const r = VF.dropOpeners('We shipped it. Furthermore, the queue drained.', ['furthermore']);
  assert.strictEqual(r.text, 'We shipped it. The queue drained.');
  assert.strictEqual(r.count, 1);
});

test('the same word mid-sentence is left alone', () => {
  const text = 'We argued furthermore, and then we shipped.';
  assert.strictEqual(VF.dropOpeners(text, ['furthermore']).text, text);
});

test('a content word is handed back rather than deleted', () => {
  const cmp = {
    available: true,
    findings: [
      { metric: 'absentWords', label: 'Word you never use', text: 'x', word: 'nuance' },
    ],
  };
  const r = VF.fix('The nuance of the framing matters here.', cmp);
  assert.strictEqual(r.changed, false, 'it deleted a word carrying meaning');
  assert.strictEqual(r.manual.length, 1);
  assert.ok(/needs you/i.test(r.manual[0].reason));
});

test('a multi-word candidate is never deleted mechanically', () => {
  const cmp = {
    available: true,
    findings: [{ metric: 'absentWords', label: 'Phrase you never use', text: 'x', word: 'at scale' }],
  };
  const r = VF.fix('We ran it at scale last year.', cmp);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.manual.length, 1);
});

// ── End to end against a real corpus ────────────────────────────────

test('the pass moves a real draft toward the writer without inventing text', () => {
  const draft = read('fixtures/ai-cover-letter.md');
  const before = V.compare(draft, PROFILE);
  const r = VF.fix(draft, before);
  assert.ok(r.applied.length > 0, 'nothing was applied to an obviously off-voice draft');
  const after = V.compare(r.text, PROFILE);
  assert.ok(after.score >= before.score, `score fell: ${before.score} → ${after.score}`);
});

test('it says what it left undone', () => {
  const draft = read('fixtures/ai-cover-letter.md');
  const r = VF.fix(draft, V.compare(draft, PROFILE));
  assert.ok(r.manual.length > 0, 'a draft this far off should leave work for the writer');
  for (const m of r.manual) {
    assert.ok(m.label, 'a refusal with no label');
    assert.ok(m.reason && m.reason.length > 15, `${m.metric}: thin reason`);
  }
});

// ── Staging guard ───────────────────────────────────────────────────

test('the fixer owns edits, not scoring', () => {
  // The comparison lives in voice.js and the profile in fingerprint.js.
  // Neither may migrate in here, or the thing being measured and the thing
  // doing the measuring become the same module.
  for (const name of ['compare', 'build', 'score', 'bandFor', 'measureSample']) {
    assert.strictEqual(VF[name], undefined, `VoiceFix.${name} does not belong here`);
  }
});

console.log(`\nvoice-fix: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
