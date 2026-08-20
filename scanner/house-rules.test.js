/**
 * House rules tests. node scanner/house-rules.test.js
 *
 * Two things matter most here and get the most tests:
 *
 *   1. Parity. The page, the CLI and the skill must apply the same rules.
 *      They share one source (scanner/house-rules.js) and everything else is
 *      generated, so the sync check is the parity guarantee.
 *   2. Separation. House findings must never move the AI score. A style
 *      preference is not evidence of machine authorship, and folding it in
 *      would let "platinum" push a document toward "machine-written".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./house-rules.js');
const ScanEngine = require('./engine.js');
const Fixer = require('./fixer.js');
const Scoring = require('./scoring.js');
const { sync, JSON_PATH, DOC_PATH, SKILL_PATH, BEGIN, END } = require('./sync-rules.js');

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

const ids = (findings) => findings.map((f) => f.ruleId);
const hit = (text, id) => ids(H.check(text)).includes(id);

// ── The seeded rules ────────────────────────────────────────────────

test('ships the ten seeded rules', () => {
  const rules = H.normalize(H.DEFAULT_RULES);
  assert.strictEqual(rules.length, 10, `expected 10 seeded rules, got ${rules.length}`);
  for (const id of [
    'em-dash', 'intersection', 'crossroads', 'platinum', 'leverage-verb',
    'delve', 'robust', 'landscape', 'six-thousand', 'two-years-coding',
  ]) {
    assert.ok(rules.some((r) => r.id === id), `missing seeded rule: ${id}`);
  }
});

test('every seeded rule carries a note', () => {
  for (const r of H.normalize(H.DEFAULT_RULES)) {
    assert.ok(r.note && r.note.length > 2, `${r.id} has no note`);
  }
});

test('each seeded rule fires on its own trigger', () => {
  const cases = [
    ['em-dash', 'The plan — the good one — is ready.'],
    ['intersection', 'At the intersection of design and code.'],
    ['crossroads', 'We are at a crossroads.'],
    ['platinum', 'A platinum opportunity.'],
    ['leverage-verb', 'We should leverage this.'],
    ['delve', 'Let us delve into it.'],
    ['robust', 'A robust plan.'],
    ['landscape', 'The competitive landscape.'],
    ['six-thousand', 'We onboarded 6,000 users.'],
    ['two-years-coding', 'I have two years coding behind me.'],
  ];
  for (const [id, text] of cases) {
    assert.ok(hit(text, id), `${id} did not fire on: ${text}`);
  }
});

// ── The hard cases in the seed list ─────────────────────────────────

test('leverage is banned as a verb but not as a noun', () => {
  for (const verb of ['We leverage it.', 'They leveraged it.', 'By leveraging data.']) {
    assert.ok(hit(verb, 'leverage-verb'), `should fire: ${verb}`);
  }
  for (const noun of [
    'Financial leverage is a risk.',
    'The leverage he had was real.',
    'Their leverage in the deal.',
    'More leverage than expected.',
  ]) {
    assert.ok(!hit(noun, 'leverage-verb'), `should NOT fire: ${noun}`);
  }
});

test('delve catches its inflections', () => {
  for (const t of ['delve into', 'she delves into', 'we delved into', 'delving into']) {
    assert.ok(hit(t, 'delve'), `delve missed: ${t}`);
  }
});

test('word rules do not fire inside longer words', () => {
  assert.ok(!hit('Robustness is a property.', 'robust'), 'robust fired inside robustness');
  assert.ok(!hit('Landscaping the garden.', 'landscape'), 'landscape fired inside landscaping');
  assert.ok(hit('A robust plan.', 'robust'), 'robust should still fire on its own');
});

test('the em dash rule matches the character, not the words "em dash"', () => {
  assert.ok(hit('one — two', 'em-dash'), 'did not match the character');
  assert.ok(!hit('I avoid the em dash in prose.', 'em-dash'), 'matched the phrase instead');
  assert.ok(!hit('a hyphen - and an en dash – here', 'em-dash'), 'matched the wrong dash');
});

test('the number rule catches both spellings', () => {
  for (const t of ['6,000 users', '6000 users', 'about 6k users']) {
    assert.ok(hit(t, 'six-thousand'), `missed: ${t}`);
  }
  assert.ok(!hit('16,000 users', 'six-thousand'), 'fired inside 16,000');
});

// ── Match modes ─────────────────────────────────────────────────────

test('word mode is case-insensitive by default', () => {
  assert.ok(hit('ROBUST and Robust and robust', 'robust'));
});

test('case-sensitive rules honour case', () => {
  const rules = [{ pattern: 'Acme', caseSensitive: true }];
  assert.strictEqual(H.check('Acme shipped', rules).length, 1);
  assert.strictEqual(H.check('acme shipped', rules).length, 0);
});

test('literal mode matches punctuation with no word boundary', () => {
  const rules = [{ pattern: '...', match: 'literal' }];
  assert.strictEqual(H.check('wait... really', rules).length, 1);
});

test('regex mode compiles user expressions', () => {
  const rules = [{ pattern: 'colou?r', match: 'regex' }];
  assert.strictEqual(H.check('color and colour', rules).length, 2);
});

test('a broken regex is rejected at edit time with a readable message', () => {
  assert.throws(
    () => H.normalizeRule({ pattern: '(unclosed', match: 'regex' }),
    /not a valid pattern/i
  );
});

test('findings are deduplicated per rule', () => {
  const f = H.check('robust robust robust plan');
  assert.strictEqual(f.filter((x) => x.ruleId === 'robust').length, 1);
});

test('findings carry offsets and a line number', () => {
  const f = H.check('line one\nthis is robust\n');
  const r = f.find((x) => x.ruleId === 'robust');
  assert.strictEqual(r.line, 2, `line was ${r.line}`);
  assert.strictEqual('line one\nthis is robust\n'.slice(r.start, r.end), 'robust');
});

// ── Directives ──────────────────────────────────────────────────────

test('(rewrite) and (remove) are directives, not replacements', () => {
  assert.ok(H.isDirective('(rewrite)'));
  assert.ok(H.isDirective('(remove)'));
  assert.ok(!H.isDirective('use'));
  assert.ok(!H.isDirective(','));
});

test('the fixer applies real replacements and refuses directives', () => {
  const text =
    'We should leverage the robust plan — the one with 6,000 users, and I have ' +
    'two years coding plus a platinum record at this crossroads of the landscape.';
  const r = ScanEngine.scan(text, { mode: 'essay' });
  const out = Fixer.fix(text, ScanEngine.allIssues(r));

  assert.ok(/\buse\b/.test(out.text), `leverage not replaced: ${out.text}`);
  assert.ok(/\bstrong\b/.test(out.text), 'robust not replaced');
  assert.ok(/thousands/.test(out.text), '6,000 not replaced');
  assert.ok(/three years/.test(out.text), 'two years coding not corrected');
  assert.ok(!out.text.includes('—'), 'em dash not replaced');

  // Directives must survive untouched and be reported instead.
  assert.ok(/platinum/.test(out.text), 'platinum was auto-removed; it is a directive');
  assert.ok(/crossroads/.test(out.text), 'crossroads was auto-rewritten; it is a directive');
  assert.ok(!/\(rewrite\)|\(remove\)/.test(out.text), 'a directive leaked into the text');
  assert.ok(
    out.manual.some((m) => m.ruleId === 'platinum'),
    'platinum should be reported as needing the writer'
  );
});

test('a replacement that is itself punctuation is not split into nothing', () => {
  // "," used to be split on commas, yielding an empty replacement, and the
  // em-dash rule silently did nothing.
  const text = 'The plan — the good one — shipped on time and under budget this week.';
  const out = Fixer.fix(text, ScanEngine.allIssues(ScanEngine.scan(text, { mode: 'essay' })));
  assert.ok(!out.text.includes('—'), `em dash survived: ${out.text}`);
  assert.ok(/plan, the good one, shipped/.test(out.text), `seam not repaired: ${out.text}`);
});

test('a numeric replacement is not uppercased', () => {
  // "6,000" equals its own uppercase, which used to yield "THOUSANDS".
  const text = 'We onboarded 6,000 users last year and the number keeps coming up in every deck.';
  const out = Fixer.fix(text, ScanEngine.allIssues(ScanEngine.scan(text, { mode: 'essay' })));
  assert.ok(/thousands/.test(out.text), `not replaced: ${out.text}`);
  assert.ok(!/THOUSANDS/.test(out.text), `shouted: ${out.text}`);
});

// ── Separation from the AI score ────────────────────────────────────

test('house findings do not move the AI score', () => {
  const clean = fs.readFileSync(path.join(__dirname, 'samples', 'human-essay.md'), 'utf8');
  const withRules = ScanEngine.scan(clean, { mode: 'essay' });
  const without = ScanEngine.scan(clean, { mode: 'essay', houseRules: false });
  assert.strictEqual(
    withRules.aiScore,
    without.aiScore,
    `house rules shifted the score ${without.aiScore} -> ${withRules.aiScore}`
  );
});

test('a document full of banned words scores the same with rules off', () => {
  // Several seeded rules (robust, landscape, leverage, delve) overlap the
  // detector's own AI vocabulary, so a document stuffed with them scores
  // high on its own merits — that part is correct and expected. What must
  // hold is that turning house rules on adds nothing to the number.
  const text =
    'I met Dana at the crossroads near the old platinum mine, at the intersection ' +
    'of Route 9 and the county line. She had two years coding behind her and about ' +
    '6,000 photos on a dying laptop — the robust one, she called it. We drove out ' +
    'past the landscape she grew up in and she told me she wanted to leverage none ' +
    'of it, which is exactly the word she used, and I have not stopped thinking about it.';
  const on = ScanEngine.scan(text, { mode: 'essay' });
  const off = ScanEngine.scan(text, { mode: 'essay', houseRules: false });
  assert.ok(on.houseIssues.length >= 7, `expected many house findings, got ${on.houseIssues.length}`);
  assert.strictEqual(
    on.aiScore,
    off.aiScore,
    `house rules moved the score ${off.aiScore} -> ${on.aiScore}`
  );
  assert.strictEqual(on.band.id, off.band.id, 'house rules moved the band');
});

test('every occurrence is fixed, though only one is listed', () => {
  const text = 'The plan — the good one — and the other one — all shipped this week on time.';
  const f = H.check(text).find((x) => x.ruleId === 'em-dash');
  assert.strictEqual(f.count, 3, `expected 3 occurrences recorded, got ${f.count}`);
  assert.strictEqual(f.spans.length, 3, 'spans should carry every occurrence');
  const out = Fixer.fix(text, ScanEngine.allIssues(ScanEngine.scan(text, { mode: 'essay' })));
  assert.ok(!out.text.includes('—'), `an em dash survived: ${out.text}`);
});

test('house findings are their own group, separate from prose and resume', () => {
  const r = ScanEngine.scan('A robust plan at the crossroads. '.repeat(4) + 'x '.repeat(40), {
    mode: 'essay',
  });
  const all = ScanEngine.allIssues(r);
  const house = all.filter((i) => i.source === 'house');
  assert.ok(house.length > 0, 'no house findings');
  for (const f of house) {
    assert.strictEqual(f.type, 'house-rule');
    assert.strictEqual(f.group, 'house');
  }
  assert.ok(all.some((i) => i.source === 'prose'), 'prose findings should still be present');
  // House findings sort first so they win the proof mark on a shared span.
  assert.strictEqual(all[0].source, 'house', 'house findings should sort first');
});

test('disabling house rules removes them without touching anything else', () => {
  const text = 'A robust plan at the crossroads, and we should leverage it fully this quarter.';
  const on = ScanEngine.scan(text, { mode: 'essay' });
  const off = ScanEngine.scan(text, { mode: 'essay', houseRules: false });
  assert.ok(on.houseIssues.length > 0);
  assert.strictEqual(off.houseIssues.length, 0);
  assert.strictEqual(on.proseIssues.length, off.proseIssues.length);
});

// ── Import / export ─────────────────────────────────────────────────

test('export then import round-trips exactly', () => {
  const json = H.toJSON(H.DEFAULT_RULES);
  const back = H.fromJSON(json);
  assert.strictEqual(H.toJSON(back), json, 'round trip changed the rule set');
});

test('a bare array of rules imports', () => {
  const rules = H.fromJSON('[{"pattern":"synergy","note":"no"}]');
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].pattern, 'synergy');
});

test('import rejects junk with a message a person can act on', () => {
  assert.throws(() => H.fromJSON('not json at all'), /not valid JSON/i);
  assert.throws(() => H.fromJSON('{"format":"something-else","rules":[]}'), /Unrecognized format/i);
  assert.throws(() => H.fromJSON('{"version":1}'), /no "rules" list/i);
  assert.throws(() => H.fromJSON('[{"note":"no pattern here"}]'), /has no pattern/i);
});

test('import enforces limits on untrusted input', () => {
  const many = JSON.stringify(Array.from({ length: H.MAX_RULES + 1 }, () => ({ pattern: 'x' })));
  assert.throws(() => H.fromJSON(many), /Too many rules/i);
  const long = JSON.stringify([{ pattern: 'x'.repeat(H.MAX_PATTERN + 1) }]);
  assert.throws(() => H.fromJSON(long), /longer than/i);
});

test('exported JSON is the format the CLI reads', () => {
  const doc = JSON.parse(H.toJSON(H.DEFAULT_RULES));
  assert.strictEqual(doc.format, 'proof-desk/house-rules');
  assert.strictEqual(doc.version, 1);
  assert.ok(Array.isArray(doc.rules));
  assert.ok(doc.rules.every((r) => typeof r.pattern === 'string'));
});

test('duplicate ids are made unique rather than colliding', () => {
  const rules = H.normalize([{ pattern: 'same' }, { pattern: 'same' }]);
  assert.notStrictEqual(rules[0].id, rules[1].id);
});

test('a disabled rule is kept but does not fire', () => {
  const rules = [{ pattern: 'synergy', enabled: false }];
  assert.strictEqual(H.check('pure synergy here', rules).length, 0);
  assert.strictEqual(H.normalize(rules).length, 1, 'disabled rules must survive a round trip');
  assert.ok(H.toJSON(rules).includes('"enabled": false'));
});

test('an empty rule set is valid and finds nothing', () => {
  assert.deepStrictEqual(H.check('robust crossroads platinum', []), []);
});

test('deleting every rule does not silently restore the defaults', () => {
  const text = 'A robust plan at the crossroads that we should leverage this quarter, at length.';
  const emptied = ScanEngine.scan(text, { mode: 'essay', houseRules: [] });
  assert.strictEqual(
    emptied.houseIssues.length,
    0,
    `an emptied rule set produced ${emptied.houseIssues.length} findings`
  );
  const defaults = ScanEngine.scan(text, { mode: 'essay' });
  assert.ok(defaults.houseIssues.length > 0, 'defaults should still apply when nothing is supplied');
});

test('check survives empty and missing text', () => {
  for (const t of ['', null, undefined]) assert.deepStrictEqual(H.check(t), []);
});

// ── Parity across the page, the CLI and the skill ───────────────────

test('the generated files are in sync with the source', () => {
  const stale = sync({ check: true });
  assert.deepStrictEqual(stale, [], `run npm run rules:sync — stale: ${stale.join(', ')}`);
});

test('house-rules.json matches the shipped defaults exactly', () => {
  const onDisk = fs.readFileSync(JSON_PATH, 'utf8');
  assert.strictEqual(onDisk.trim(), H.toJSON(H.DEFAULT_RULES).trim());
  // And it must import cleanly, since that is what the CLI does with it.
  assert.strictEqual(H.fromJSON(onDisk).length, H.DEFAULT_RULES.length);
});

test('the skill documents every rule the engine enforces', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  for (const r of H.normalize(H.DEFAULT_RULES)) {
    assert.ok(doc.includes(r.label), `HOUSE-RULES.md does not mention "${r.label}"`);
    if (r.note) assert.ok(doc.includes(r.note), `HOUSE-RULES.md omits the reason for "${r.label}"`);
  }
});

test('SKILL.md points at the house rules inside fenced markers', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(skill.includes(BEGIN), 'no begin marker');
  assert.ok(skill.includes(END), 'no end marker');
  assert.ok(skill.indexOf(BEGIN) < skill.indexOf(END), 'markers are out of order');
  assert.ok(skill.includes('HOUSE-RULES.md'), 'the addendum does not link the rules');
  // Exactly one block, so repeated syncs cannot stack copies.
  assert.strictEqual(skill.split(BEGIN).length - 1, 1, 'more than one addendum block');
});

test('the local addendum is the only change to the vendored skill text', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const upstream = skill.slice(0, skill.indexOf(BEGIN));
  // Upstream's own frontmatter and opening must be intact ahead of the block.
  assert.ok(upstream.startsWith('---\nname: avoid-ai-writing'), 'frontmatter was disturbed');
  assert.ok(upstream.includes('# Avoid AI Writing'), 'upstream heading missing');
});

console.log(`\nhouse-rules: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
