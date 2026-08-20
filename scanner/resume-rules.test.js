/**
 * Tests for the resume rule layer. Zero deps, same style as the upstream
 * detector's tests: node scanner/resume-rules.test.js
 */

const assert = require('assert');
const R = require('./resume-rules.js');

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

const types = (result) => new Set(result.issues.map((i) => i.type));
const has = (result, type) => types(result).has(type);

// ── Fixtures ────────────────────────────────────────────────────────

const AI_RESUME = `
Jane Doe
jane.doe@example.com | (555) 123-4567 | linkedin.com/in/janedoe

SUMMARY
Results-driven, detail-oriented professional with a proven track record of
success. Passionate about leveraging cutting-edge technology to deliver
best-in-class solutions in fast-paced environments.

EXPERIENCE
Senior Manager, Acme Corp — Jan 2021 - Present
• Spearheaded a cross-functional initiative that increased revenue by 25%
• Orchestrated the migration of legacy systems, reducing costs by 30%
• Championed a holistic approach to quality, improving efficiency by 15%
• Leveraged actionable insights to optimize workflows, boosting output by 20%
• Pioneered robust solutions that streamlined operations, cutting time by 40%

SKILLS
Python, SQL, Excel

EDUCATION
BS Computer Science, State University, 2016
`;

const HUMAN_RESUME = `
Marco Reyes
marco@reyes.dev | github.com/mreyes | Austin, TX

EXPERIENCE
Backend engineer, Halyard Logistics — Mar 2021 - Present
• Rewrote the dispatch matcher. Cut p99 assignment latency from 4.2s to 380ms.
• Owned the on-call rotation for 3 services.
• Killed a nightly batch job nobody had read since 2019; saved $3,100/month in
  compute and removed the 6am pager that came with it.
• Wrote the internal Postgres upgrade runbook. 14 teams used it.

Junior engineer, Tessellate — Jun 2019 - Feb 2021
• Built the CSV import path. Handled 41,000 rows/day at peak.
• Shipped the retry queue after a bad week of dropped webhooks.

SKILLS
Go, Postgres, Python, Terraform

EDUCATION
BS Computer Science, UT Austin, 2019
`;

// ── Cliché + LLM verb detection ─────────────────────────────────────

test('flags resume clichés', () => {
  const r = R.analyzeResume(AI_RESUME);
  assert.ok(has(r, 'resume-cliche'), 'expected resume-cliche');
  const found = r.issues.filter((i) => i.type === 'resume-cliche').map((i) => i.text.toLowerCase());
  assert.ok(found.some((t) => t.includes('results-driven')), `expected results-driven in ${found}`);
  assert.ok(found.some((t) => t.includes('detail-oriented')), `expected detail-oriented in ${found}`);
});

test('flags strong LLM-favored verbs on a single appearance', () => {
  const r = R.analyzeResume(AI_RESUME);
  const found = r.issues.filter((i) => i.type === 'resume-llm-verb').map((i) => i.text.toLowerCase());
  assert.ok(found.some((t) => t.startsWith('spearhead')), `expected spearheaded in ${found}`);
  assert.ok(found.some((t) => t.startsWith('leverag')), `expected leveraged in ${found}`);
});

test('soft LLM verbs stay silent below the cluster threshold', () => {
  const one = `
Sam Patel
sam@example.com

EXPERIENCE
Analyst, Northwind — Jan 2020 - Present
• Optimized the weekly close and took two days out of it
• Rebuilt the variance report after the Q3 restatement
• Ran the vendor audit that found $84,000 of duplicate invoices

SKILLS
Excel, SQL

EDUCATION
BA Economics, 2019
`;
  const r = R.analyzeResume(one);
  const soft = r.issues.filter((i) => i.type === 'resume-llm-verb');
  assert.strictEqual(soft.length, 0, `single soft verb should not flag, got ${JSON.stringify(soft)}`);
});

test('three distinct soft verbs do cluster into a flag', () => {
  const many = `
Sam Patel
sam@example.com

EXPERIENCE
Analyst, Northwind — Jan 2020 - Present
• Optimized the reporting pipeline for 12 teams
• Streamlined the intake process across 4 regions
• Facilitated the quarterly planning cycle for 30 people
• Ran the vendor audit that found $84,000 of duplicate invoices

SKILLS
Excel, SQL

EDUCATION
BA Economics, 2019
`;
  const r = R.analyzeResume(many);
  assert.ok(has(r, 'resume-llm-verb'), 'three soft verbs should cluster into a flag');
});

// ── Metric rules ────────────────────────────────────────────────────

test('flags bullets with no numbers', () => {
  const bare = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Managed the customer onboarding process end to end
• Coordinated with partner teams on the quarterly roadmap
• Presented findings to leadership on a regular basis
• Maintained documentation for the support organization

SKILLS
Notion, Jira

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(bare);
  assert.ok(has(r, 'resume-unquantified'), 'expected resume-unquantified');
});

test('does not flag unquantified when bullets carry numbers', () => {
  const r = R.analyzeResume(HUMAN_RESUME);
  assert.ok(!has(r, 'resume-unquantified'), 'human resume has metrics on most bullets');
});

test('flags percentages that are all multiples of five', () => {
  const r = R.analyzeResume(AI_RESUME);
  assert.ok(has(r, 'resume-round-metrics'), 'expected resume-round-metrics');
});

test('does not flag lumpy real percentages', () => {
  const lumpy = `
Dev Singh
dev@example.com

EXPERIENCE
Engineer, Initech — Jan 2020 - Present
• Cut error rate from 3.4% to 0.8% on the payments path
• Raised cache hit rate by 17% after re-keying the index
• Trimmed 23% off the build by dropping two dead targets
• Moved 41,000 records without downtime

SKILLS
Go, Redis

EDUCATION
BS CS, 2018
`;
  const r = R.analyzeResume(lumpy);
  assert.ok(!has(r, 'resume-round-metrics'), 'lumpy percentages should not flag');
});

// ── Structure rules ─────────────────────────────────────────────────

test('flags a missing contact block', () => {
  const nocontact = `
EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Ran the onboarding program for 40 new hires
• Cut ticket backlog from 900 to 120 in one quarter
• Owned the vendor relationship for 3 tools

SKILLS
Notion, Jira

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(nocontact);
  assert.ok(has(r, 'resume-missing-contact'), 'expected resume-missing-contact');
});

test('does not flag contact when an email is present', () => {
  const r = R.analyzeResume(HUMAN_RESUME);
  assert.ok(!has(r, 'resume-missing-contact'), 'email present, should not flag');
});

test('flags missing standard sections', () => {
  const nosections = `
Ann Lee
ann@example.com

Ran the onboarding program for 40 new hires at Globex from 2020 onward
Cut ticket backlog from 900 to 120 in a single quarter across two teams
Owned the vendor relationship for 3 different procurement tools
Built the reporting layer that 12 managers checked every Monday morning
`;
  const r = R.analyzeResume(nosections);
  assert.ok(has(r, 'resume-missing-section'), 'expected resume-missing-section');
});

test('finds sections in the human fixture', () => {
  const r = R.analyzeResume(HUMAN_RESUME);
  assert.ok(!has(r, 'resume-missing-section'), `sections found: ${JSON.stringify(r.sections)}`);
});

test('does not flag dates when each role block carries one', () => {
  const ai = R.analyzeResume(AI_RESUME);
  const human = R.analyzeResume(HUMAN_RESUME);
  assert.ok(!has(ai, 'resume-missing-dates'), 'one role, one date range — should not flag');
  assert.ok(!has(human, 'resume-missing-dates'), 'two roles, two date ranges — should not flag');
});

test('flags roles with no dates at all', () => {
  const undated = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex
• Cut backlog from 900 to 120 tickets
• Ran the vendor review for $200,000 of spend

Analyst, Initech
• Built the reporting layer for 12 managers
• Onboarded 40 new hires

SKILLS
Notion

EDUCATION
BA History
`;
  const r = R.analyzeResume(undated);
  assert.ok(has(r, 'resume-missing-dates'), 'expected resume-missing-dates');
});

test('counts role blocks separately', () => {
  assert.strictEqual(R.parseResume(AI_RESUME).blocks, 1, 'AI fixture has one role');
  assert.strictEqual(R.parseResume(HUMAN_RESUME).blocks, 2, 'human fixture has two roles');
});

test('flags weak openers', () => {
  const weak = `
Ann Lee
ann@example.com

EXPERIENCE
Coordinator, Globex — Jan 2020 - Present
• Responsible for the onboarding of 40 new hires each quarter
• Assisted in the migration of 12 dashboards to the new stack
• Helped with the vendor review covering $200,000 of spend

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(weak);
  assert.ok(has(r, 'resume-weak-verb'), 'expected resume-weak-verb');
});

test('flags first-person pronouns in bullets', () => {
  const pronouns = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• I ran the onboarding program for 40 new hires
• My team cut the ticket backlog from 900 to 120
• Owned the vendor relationship for 3 tools

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(pronouns);
  assert.ok(has(r, 'resume-pronoun'), 'expected resume-pronoun');
});

// ── Stylometric rules ───────────────────────────────────────────────

test('flags uniform bullet rhythm', () => {
  const r = R.analyzeResume(AI_RESUME);
  assert.ok(has(r, 'resume-uniform-bullets'), 'expected resume-uniform-bullets');
});

test('does not flag uneven human bullets', () => {
  const r = R.analyzeResume(HUMAN_RESUME);
  assert.ok(!has(r, 'resume-uniform-bullets'), 'human bullets vary in length');
});

test('flags stacked rule-of-three lists', () => {
  const triads = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Owned planning, staffing, and reporting for a team of 12
• Delivered dashboards, runbooks, and training for 40 users
• Coordinated design, engineering, and support across 3 offices
• Cut backlog from 900 to 120 tickets

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(triads);
  assert.ok(has(r, 'resume-triad'), 'expected resume-triad');
});

test('flags overlong bullets', () => {
  const long = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Managed the end to end onboarding program for 40 new hires each quarter while also owning the vendor relationship for three separate procurement tools and running the weekly reporting cadence for leadership across two offices
• Cut backlog from 900 to 120 tickets
• Ran the vendor review for $200,000 of spend

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(long);
  assert.ok(has(r, 'resume-long-bullet'), 'expected resume-long-bullet');
});

test('flags mixed verb tense', () => {
  const mixed = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Manages the onboarding program for 40 new hires
• Led the migration of 12 dashboards to the new stack
• Owned the vendor relationship for 3 tools
• Builds the weekly report for 20 managers

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(mixed);
  assert.ok(has(r, 'resume-tense-mix'), 'expected resume-tense-mix');
});

test('flags a skills keyword dump', () => {
  const skills = Array.from({ length: 30 }, (_, i) => `Skill${i}`).join(', ');
  const dump = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Cut backlog from 900 to 120 tickets
• Ran the vendor review for $200,000 of spend
• Onboarded 40 new hires

SKILLS
${skills}

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(dump);
  assert.ok(has(r, 'resume-skill-dump'), 'expected resume-skill-dump');
});

// ── Parsing ─────────────────────────────────────────────────────────

test('falls back to line heuristics when bullet glyphs are absent', () => {
  const flat = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex
Ran the onboarding program for 40 new hires each quarter
Cut the ticket backlog from 900 to 120 in one quarter
Owned the vendor relationship for three procurement tools

SKILLS
Notion, Jira

EDUCATION
BA History, 2018
`;
  const parsed = R.parseResume(flat);
  assert.strictEqual(parsed.usedGlyphs, false, 'no glyphs expected');
  assert.ok(parsed.bullets.length >= 3, `expected >=3 inferred bullets, got ${parsed.bullets.length}`);
});

test('detects contact fields', () => {
  const parsed = R.parseResume(AI_RESUME);
  assert.strictEqual(parsed.contact.email, true);
  assert.strictEqual(parsed.contact.phone, true);
  assert.strictEqual(parsed.contact.url, true);
});

test('a bare year is not counted as an achievement metric', () => {
  assert.strictEqual(R.METRIC_RE.test('Graduated in 2019'), false);
  assert.strictEqual(R.METRIC_RE.test('Cut costs by 30%'), true);
  assert.strictEqual(R.METRIC_RE.test('Saved $3,100 per month'), true);
  assert.strictEqual(R.METRIC_RE.test('Supported 41,000 users'), true);
});

// ── Scoring ─────────────────────────────────────────────────────────

test('AI resume scores far above the human one', () => {
  const ai = R.analyzeResume(AI_RESUME);
  const human = R.analyzeResume(HUMAN_RESUME);
  assert.ok(
    ai.aiScore > human.aiScore + 25,
    `expected a wide gap, got ai=${ai.aiScore} human=${human.aiScore}`
  );
  assert.ok(human.aiScore <= 15, `human resume should read clean, got ${human.aiScore}`);
});

test('craft score is independent of the AI score', () => {
  // The AI fixture is a structurally correct resume — contact block, dated
  // role, metrics on every bullet — that still reads as machine-written.
  // Craft should stay high while the AI score goes to the ceiling; collapsing
  // the two would make the tool useless for the "well-formatted but robotic"
  // case, which is the common one.
  const ai = R.analyzeResume(AI_RESUME);
  const human = R.analyzeResume(HUMAN_RESUME);
  assert.ok(ai.craftScore >= 80, `well-formed AI resume should score high on craft, got ${ai.craftScore}`);
  assert.ok(human.craftScore >= 80, `human craft score should be high, got ${human.craftScore}`);
  assert.ok(ai.aiScore > 60, `AI fixture should score high on AI, got ${ai.aiScore}`);
});

test('craft score drops on a structurally broken resume', () => {
  const broken = `
Some Person

Responsible for various tasks and duties across the organization over time
Worked on several projects with different teams throughout the department
Helped with reporting and analysis for the leadership group as required
Assisted in the coordination of activities across multiple business units
`;
  const r = R.analyzeResume(broken);
  assert.ok(r.craftScore < 70, `expected a low craft score, got ${r.craftScore}`);
});

test('scores stay inside 0-100', () => {
  for (const text of [AI_RESUME, HUMAN_RESUME, AI_RESUME.repeat(4)]) {
    const r = R.analyzeResume(text);
    for (const key of ['score', 'aiScore', 'craftScore']) {
      assert.ok(r[key] >= 0 && r[key] <= 100, `${key} out of range: ${r[key]}`);
    }
  }
});

test('short input is marked unscorable rather than guessed at', () => {
  const r = R.analyzeResume('Jane Doe, engineer.');
  assert.strictEqual(r.label, 'Too short');
  assert.strictEqual(r.stats.scorable, false);
  assert.strictEqual(r.issues.length, 0);
});

test('empty and null input do not throw', () => {
  for (const input of ['', null, undefined, '   \n\n  ']) {
    const r = R.analyzeResume(input);
    assert.strictEqual(r.stats.scorable, false);
  }
});

test('uplift is bounded at 25', () => {
  const heavy = R.analyzeResume(AI_RESUME);
  assert.ok(R.aiUplift(heavy) <= 25, 'uplift must be capped');
  assert.strictEqual(R.aiUplift(R.analyzeResume('too short')), 0);
});

test('every issue carries a group and a weight', () => {
  const r = R.analyzeResume(AI_RESUME);
  assert.ok(r.issues.length > 0);
  for (const issue of r.issues) {
    assert.ok(['ai', 'craft'].includes(issue.group), `bad group on ${issue.type}`);
    assert.ok(typeof issue.weight === 'number' && issue.weight > 0, `bad weight on ${issue.type}`);
    assert.ok(issue.suggestion && issue.suggestion.length > 0, `no suggestion on ${issue.type}`);
    assert.ok(R.TYPE_LABELS[issue.type], `no label for ${issue.type}`);
  }
});

test('issues are deduplicated by type and text', () => {
  const repeated = `
Ann Lee
ann@example.com

EXPERIENCE
Manager, Globex — Jan 2020 - Present
• Results-driven leader who is results-driven and results-driven
• Cut backlog from 900 to 120 tickets
• Ran the vendor review for $200,000 of spend

SKILLS
Notion

EDUCATION
BA History, 2018
`;
  const r = R.analyzeResume(repeated);
  const cliches = r.issues.filter((i) => i.type === 'resume-cliche' && /results/i.test(i.text));
  assert.strictEqual(cliches.length, 1, `expected 1 deduped hit, got ${cliches.length}`);
});

// ── Report ──────────────────────────────────────────────────────────

console.log(`\nresume-rules: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
