/**
 * Tests for the deterministic fixer. node scanner/fixer.test.js
 *
 * The bar here is different from the detector's: a wrong flag is a nuisance,
 * a wrong edit corrupts the user's draft. Most of these tests assert that
 * something is NOT changed.
 */

const assert = require('assert');
const path = require('path');
const AIDetector = require(path.join(
  __dirname, '..', '.claude', 'skills', 'avoid-ai-writing', 'detector', 'patterns.js'
));
const F = require('./fixer.js');

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

const run = (text) => F.fix(text, AIDetector.analyzeText(text).issues);

// ── Suggestion parsing ──────────────────────────────────────────────

test('takes the first option from a replacement list', () => {
  assert.deepStrictEqual(F.parseReplacement('strong, reliable, solid'), { kind: 'swap', text: 'strong' });
  assert.deepStrictEqual(F.parseReplacement('ran / coordinated'), { kind: 'swap', text: 'ran' });
});

test('treats advice as advice, not as a replacement', () => {
  assert.strictEqual(F.parseReplacement('describe what changed'), null);
  assert.strictEqual(F.parseReplacement('name the result'), null);
  assert.strictEqual(F.parseReplacement('give the number'), null);
  assert.strictEqual(F.parseReplacement('show it — a bullet where detail mattered'), null);
});

test('reads "cut" as a deletion', () => {
  assert.deepStrictEqual(F.parseReplacement('cut'), { kind: 'delete' });
  assert.deepStrictEqual(F.parseReplacement('cut — show it in what you built'), { kind: 'delete' });
});

test('keeps a multi-word replacement whole', () => {
  assert.deepStrictEqual(F.parseReplacement('turning point, shift'), { kind: 'swap', text: 'turning point' });
});

// ── Morphology ──────────────────────────────────────────────────────

test('carries the -ing participle onto the replacement', () => {
  assert.strictEqual(F.inflect('leveraging', 'use'), 'using');
  assert.strictEqual(F.inflect('utilizing', 'use'), 'using');
});

test('does not invent an -ed form', () => {
  // "poised" -> "ready" is already correct; appending -ed gave "readyed".
  assert.strictEqual(F.inflect('poised', 'ready'), 'ready');
  assert.strictEqual(F.inflect('utilized', 'use'), 'use');
});

test('preserves capitalization', () => {
  assert.strictEqual(F.matchCase('Leveraging', 'using'), 'Using');
  assert.strictEqual(F.matchCase('leveraging', 'using'), 'using');
  assert.strictEqual(F.matchCase('ROBUST', 'strong'), 'STRONG');
});

// ── Deletions ───────────────────────────────────────────────────────

test('deletes a leading connective and repairs the seam', () => {
  const out = run('The system works well. Moreover, the tests all pass and the build is green.');
  assert.ok(!/Moreover/.test(out.text), out.text);
  assert.ok(/\.\s+The tests all pass/.test(out.text), `seam not repaired: ${out.text}`);
});

test('deletes a filler clause', () => {
  const out = run(
    'It is important to note that the migration finished ahead of schedule and under budget this quarter.'
  );
  assert.ok(!/important to note/.test(out.text), out.text);
  assert.ok(/^The migration finished/.test(out.text.trim()), out.text);
});

test('leaves a partial connective alone', () => {
  // "In today's" is flagged, but the sentence continues "rapidly evolving
  // world" — deleting only the flagged span would break it.
  const src = "In today's rapidly evolving world, teams ship software faster than they can review it.";
  const out = run(src);
  assert.ok(out.text.includes("In today's rapidly evolving world"), out.text);
});

// ── Swaps ───────────────────────────────────────────────────────────

test('swaps tier-1 vocabulary for the plainer word', () => {
  const out = run(
    'We built a robust pipeline using cutting-edge tooling to ship the deployment each week.'
  );
  assert.ok(/strong pipeline/.test(out.text), out.text);
  assert.ok(/latest tooling/.test(out.text), out.text);
});

test('swaps tier-2 vocabulary once it clusters', () => {
  // Tier-2 words only flag in a cluster, so a single "navigate" is left
  // alone by the detector and therefore by the fixer.
  const solo = 'We had to navigate the deployment process again this week without much trouble.';
  assert.strictEqual(run(solo).applied, 0, 'an isolated tier-2 word should not be touched');

  const clustered = `The platform serves as a cornerstone of this transformation and is poised to
revolutionize how teams navigate the industry landscape over the coming year.`;
  const out = run(clustered);
  assert.ok(out.applied > 0, 'clustered tier-2 words should be swapped');
  assert.ok(/foundation/.test(out.text), out.text);
});

test('does not drop a verb form into a noun slot', () => {
  // "a testament to" suggests "shows" — "a shows" is broken English.
  const out = run(
    'The launch stands as a testament to the quality of the engineering team and their long effort.'
  );
  assert.ok(!/a shows/.test(out.text), `produced broken grammar: ${out.text}`);
  assert.ok(out.manual.some((m) => m.text === 'testament to'), 'should be reported as manual');
});

// ── Safety ──────────────────────────────────────────────────────────

test('leaves clean human writing untouched', () => {
  const human = `I got three quotes for panels last spring. Two came in around $22,000. The third
was $14,500, which made me suspicious enough to actually read it. The cheap one
used 380W panels and assumed my roof got five peak sun hours a day. It gets 3.9.`;
  const out = run(human);
  assert.strictEqual(out.applied, 0, `edited clean prose: ${JSON.stringify(out.edits)}`);
  assert.strictEqual(out.text, F.apply(human, []), 'text should be unchanged');
});

test('does not capitalize hard-wrapped lines mid-sentence', () => {
  const wrapped = `Moreover, the renewable energy transition depends on storage
capacity and grid interconnection more than on panel
efficiency, which plateaued years ago.`;
  const out = run(wrapped);
  assert.ok(!/\nCapacity/.test(out.text), `capitalized a wrapped line: ${out.text}`);
  assert.ok(!/\nEfficiency/.test(out.text), `capitalized a wrapped line: ${out.text}`);
});

test('capitalizes after a sentence that ends on a line break', () => {
  const src = 'The tests all pass.\nMoreover, the build is green and the deploy went out on time.';
  const out = run(src);
  assert.ok(/\nThe build is green/.test(out.text), out.text);
});

test('never leaves a doubled space or a space before punctuation', () => {
  const out = run(
    'The rollout went fine. Furthermore, the dashboards stayed green throughout the whole window.'
  );
  assert.ok(!/ {2}/.test(out.text), `double space: ${JSON.stringify(out.text)}`);
  assert.ok(!/ [,.]/.test(out.text), `space before punctuation: ${JSON.stringify(out.text)}`);
});

test('judgment findings are reported, never auto-applied', () => {
  const out = run(
    'Experts believe the platform is poised to disrupt the market, and the future looks bright for everyone.'
  );
  assert.ok(
    out.manual.some((m) => m.type === 'vague-attribution'),
    'vague attribution must stay manual'
  );
  assert.ok(/[Ee]xperts believe/.test(out.text), 'must not silently invent a source');
});

test('edits never overlap', () => {
  const src = `In today's rapidly evolving world, it is important to note that our robust,
cutting-edge platform serves as a cornerstone of the industry landscape.
Moreover, experts believe it is poised to revolutionize how teams leverage data.`;
  const { edits } = F.plan(src, AIDetector.analyzeText(src).issues);
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].start >= sorted[i - 1].end, `overlap at edit ${i}`);
  }
});

// ── End to end ──────────────────────────────────────────────────────

test('lowers the score on AI prose without touching human prose', () => {
  const ai = `In today's rapidly evolving world, our platform stands as a cornerstone of
innovation. Moreover, it is important to note that we leverage cutting-edge
technology to deliver robust solutions. Furthermore, the platform is poised to
revolutionize the industry landscape. In conclusion, the future looks bright.`;
  const before = AIDetector.analyzeText(ai).score;
  const out = run(ai);
  const after = AIDetector.analyzeText(out.text).score;
  assert.ok(after < before - 15, `expected a real drop, got ${before} -> ${after}`);
  assert.ok(out.applied >= 6, `expected several edits, got ${out.applied}`);
});

test('the result is still valid text, not a mangled string', () => {
  const ai = `Moreover, it is important to note that we leverage cutting-edge technology.
Furthermore, the robust platform is poised to revolutionize the landscape.`;
  const out = run(ai);
  assert.ok(out.text.length > 40, 'text collapsed');
  assert.ok(!/undefined|null|NaN/.test(out.text), out.text);
  assert.ok(!/\n{4,}/.test(out.text), 'blank line explosion');
});

test('empty and tiny input do not throw', () => {
  for (const input of ['', '   ', 'Hi.']) {
    const out = F.fix(input, []);
    assert.strictEqual(typeof out.text, 'string');
    assert.strictEqual(out.applied, 0);
  }
});

console.log(`\nfixer: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
