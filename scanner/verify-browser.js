#!/usr/bin/env node
/**
 * Browser smoke test for dist/index.html.
 *
 * The unit tests in build.test.js check the bundle's shape; this one drives
 * the real page in Chromium, because the failure that matters most — an
 * inlining bug that breaks the app script — looks perfectly fine to a string
 * check and produces a dead page.
 *
 * Playwright is deliberately NOT a dependency of this project (everything else
 * here runs with zero installs). Install it only when you want to run this:
 *
 *   npm i -D playwright && node scanner/verify-browser.js [--shots <dir>]
 */

const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.stderr.write(
    'verify-browser: playwright is not installed.\n' +
      '  npm i -D playwright && node scanner/verify-browser.js\n'
  );
  process.exit(2);
}

const BUNDLE = path.join(__dirname, '..', 'dist', 'index.html');
const shotsFlag = process.argv.indexOf('--shots');
const SHOTS = shotsFlag > -1 ? process.argv[shotsFlag + 1] : null;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function readout(page) {
  return page.evaluate(() => ({
    ai: document.getElementById('ai-score').textContent.trim(),
    band: (document.getElementById('ai-band-label') || {}).textContent || '',
    bandTone: (document.getElementById('ai-band') || {}).dataset?.tone || '',
    activeSeg: (document.querySelector('.scale-seg[data-active="true"]') || {}).dataset?.band || '',
    mode: document.getElementById('mode-note').textContent.trim(),
    craftHidden: document.getElementById('craft-block').hidden,
    marks: document.querySelectorAll('mark.mk').length,
    findings: document.querySelectorAll('.finding').length,
    proofHidden: document.getElementById('proof').hidden,
    bg: getComputedStyle(document.body).backgroundColor,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
}

(async () => {
  if (!fs.existsSync(BUNDLE)) {
    process.stderr.write('verify-browser: dist/index.html missing — run `npm run build` first.\n');
    process.exit(2);
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const url = 'file://' + BUNDLE;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  });
  const fatal = [];

  // ── Light theme, default sample ─────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fatal.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.waitForTimeout(800);

  let r = await readout(page);
  check('opens with the essay sample scored', /^\d+\/100$/.test(r.ai), `got "${r.ai}"`);
  check('essay mode detected', r.mode === 'essay mode', r.mode);

  // The page must open on the editable draft. Landing on the read-only proof
  // view means a first-time visitor pastes into nothing and concludes the
  // tool is broken — which is exactly what happened before this check existed.
  check('opens in the editable draft view', r.proofHidden === true);
  check('the draft is editable on load', (await page.evaluate(() => {
    const d = document.getElementById('draft');
    return !d.hidden && !d.readOnly && !d.disabled;
  })) === true);

  // Typing must work with no further clicks, and there must be a visible
  // button for people who expect one.
  await page.fill('#draft', 'Certainly! Let us delve into this rich tapestry of innovation and synergy.');
  await page.waitForTimeout(500);
  check('typing rescans without pressing anything', /^\d+\/100$/.test((await readout(page)).ai));
  check('an explicit scan button exists', (await page.locator('#scan').count()) === 1);
  await page.click('#scan');
  await page.waitForTimeout(400);
  check('the scan button opens the marked-up view', (await readout(page)).proofHidden === false);

  // Clicking the marked-up sheet away from a mark returns you to editing.
  await page.click('.proof', { position: { x: 10, y: 220 } });
  await page.waitForTimeout(300);
  check('clicking blank proof space returns to the draft', (await readout(page)).proofHidden === true);

  await page.click('[data-sample="ai-essay"]');
  await page.waitForTimeout(600);
  r = await readout(page);
  check('craft readout hidden for an essay', r.craftHidden === true);
  check('proof marks rendered', r.marks > 5, `${r.marks} marks`);
  check('findings listed', r.findings > 5, `${r.findings} findings`);
  check('no horizontal scroll', r.hScroll === false);
  check('the band label is shown next to the score', r.band.length > 3, `band="${r.band}"`);
  check('the AI essay reads as machine-written', r.band === 'Reads as machine-written', r.band);
  check('the scale legend highlights the active band', r.activeSeg === 'machine', r.activeSeg);
  check('the band carries a severity tone', r.bandTone === 'high', r.bandTone);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '1-light-essay.png') });

  // ── Resume sample ───────────────────────────────────────────────
  await page.click('[data-sample="ai-resume"]');
  await page.waitForTimeout(600);
  r = await readout(page);
  check('resume mode detected', r.mode === 'resume mode', r.mode);
  check('craft readout shown for a resume', r.craftHidden === false);
  check('resume draft opens at the top', (await page.evaluate(() => document.getElementById('draft').scrollTop)) === 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '2-light-resume.png') });

  // ── Finding → mark navigation ───────────────────────────────────
  await page.click('.finding[data-locatable="1"]');
  await page.waitForTimeout(500);
  const jump = await page.evaluate(() => ({
    proofHidden: document.getElementById('proof').hidden,
    active: document.querySelectorAll('mark.is-active').length,
  }));
  check('clicking a finding opens the marked-up view', jump.proofHidden === false);
  check('clicking a finding highlights its mark', jump.active === 1, `${jump.active} active`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '3-proof-active.png') });

  // ── Upload ──────────────────────────────────────────────────────
  // Drive the real file input with the real fixtures, so PDF extraction is
  // exercised in a browser rather than only under Node's DecompressionStream.
  const FILES = path.join(__dirname, 'samples', 'files');
  for (const [name, expectMode] of [
    ['resume-chromium.pdf', 'resume mode'],
    ['resume.docx', 'resume mode'],
  ]) {
    await page.setInputFiles('#file', path.join(FILES, name));
    await page.waitForTimeout(1200);
    const up = await page.evaluate(() => ({
      draft: document.getElementById('draft').value,
      hint: document.getElementById('hint').textContent,
      mode: document.getElementById('mode-note').textContent.trim(),
      ai: document.getElementById('ai-score').textContent.trim(),
    band: (document.getElementById('ai-band-label') || {}).textContent || '',
    bandTone: (document.getElementById('ai-band') || {}).dataset?.tone || '',
    activeSeg: (document.querySelector('.scale-seg[data-active="true"]') || {}).dataset?.band || '',
    }));
    check(`${name}: text lands in the draft`, /Jane Doe/.test(up.draft), up.draft.slice(0, 80));
    check(`${name}: bullets survive extraction`, /Spearheaded a cross-functional/.test(up.draft));
    check(`${name}: no phantom mid-word spaces`, /SUMMARY/.test(up.draft) && /EDUCATION/.test(up.draft));
    check(`${name}: detected as a resume`, up.mode === expectMode, up.mode);
    check(`${name}: scored`, /^\d+\/100$/.test(up.ai), up.ai);
    check(`${name}: hint names the file`, up.hint.includes(name), up.hint);
  }

  // A file we cannot read must explain itself, not fail silently.
  const badPath = path.join(SHOTS || require('os').tmpdir(), 'not-a-real.pdf');
  fs.writeFileSync(badPath, '%PDF-1.4\nnothing here at all\n');
  await page.setInputFiles('#file', badPath);
  await page.waitForTimeout(900);
  const bad = await page.evaluate(() => document.getElementById('hint').textContent);
  check('an unreadable PDF explains what to do', /readable text|scanned|OCR/i.test(bad), bad);

  // ── Cleaned view ────────────────────────────────────────────────
  await page.click('[data-sample="ai-essay"]');
  await page.waitForTimeout(600);
  await page.click('#view-clean');
  await page.waitForTimeout(400);
  const cleaned = await page.evaluate(() => ({
    shown: !document.getElementById('clean').hidden,
    value: document.getElementById('clean').value,
    draftValue: document.getElementById('draft').value,
    hint: document.getElementById('hint').textContent,
    copyShown: !document.getElementById('copy-clean').hidden,
  }));
  check('the cleaned view shows', cleaned.shown === true);
  check('the cleaned text is populated', cleaned.value.length > 100, `${cleaned.value.length} chars`);
  check('the cleaned text differs from the draft', cleaned.value !== cleaned.draftValue);
  check('filler is gone from the cleaned text', !/It is important to note that/.test(cleaned.value));
  check('tier-1 vocabulary is swapped', !/cutting-edge/.test(cleaned.value), cleaned.value.slice(0, 80));
  check('the hint reports what was applied', /Applied \d+ fix/.test(cleaned.hint), cleaned.hint);
  check('a copy button appears in the cleaned view', cleaned.copyShown === true);
  check(
    'the cleaned view does not capitalize wrapped lines',
    !/\n[A-Z][a-z]+ (ingenuity|sources|research)/.test(cleaned.value),
    'mid-sentence capitalization'
  );

  // A clean human draft must come out of the fixer untouched.
  await page.click('[data-sample="human-essay"]');
  await page.waitForTimeout(600);
  await page.click('#view-clean');
  await page.waitForTimeout(400);
  const untouched = await page.evaluate(() => ({
    same: document.getElementById('clean').value === document.getElementById('draft').value,
    hint: document.getElementById('hint').textContent,
  }));
  check('human prose is returned unchanged by the fixer', untouched.same === true, untouched.hint);

  // ── Human sample scores clean ───────────────────────────────────
  await page.click('[data-sample="human-resume"]');
  await page.waitForTimeout(600);
  r = await readout(page);
  const humanScore = parseInt(r.ai, 10);
  check('human resume scores low', humanScore <= 15, `scored ${humanScore}`);
  check('human resume reads as human', r.band === 'Reads as human', r.band);
  check('human resume lights the clean segment', r.activeSeg === 'clean', r.activeSeg);

  // ── Empty state ─────────────────────────────────────────────────
  await page.click('[data-sample="clear"]');
  await page.waitForTimeout(400);
  r = await readout(page);
  check('clearing resets the readout', r.ai === '—/100', r.ai);
  check('clearing empties the findings', r.findings === 0, `${r.findings} left`);

  // ── Theme toggle ────────────────────────────────────────────────
  await page.click('[data-sample="ai-essay"]');
  await page.waitForTimeout(500);
  const beforeBg = (await readout(page)).bg;
  await page.click('#theme');
  await page.waitForTimeout(300);
  const afterBg = (await readout(page)).bg;
  check('theme toggle changes the ground', beforeBg !== afterBg, `${beforeBg} -> ${afterBg}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '4-dark-toggled.png') });
  await ctx.close();

  // ── System dark with no stamp — the default state most viewers see ──
  const darkCtx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1360, height: 940 } });
  const dp = await darkCtx.newPage();
  dp.on('pageerror', (e) => fatal.push('pageerror(dark): ' + e.message));
  await dp.goto(url);
  await dp.waitForTimeout(800);
  const dark = await dp.evaluate(() => ({
    stamp: document.documentElement.dataset.theme || '',
    bg: getComputedStyle(document.body).backgroundColor,
    ink: getComputedStyle(document.body).color,
  }));
  check('system dark applies without a stamp', dark.stamp === '' && dark.bg === 'rgb(19, 18, 25)', JSON.stringify(dark));
  check('system dark uses light ink', dark.ink === 'rgb(237, 235, 243)', dark.ink);
  if (SHOTS) await dp.screenshot({ path: path.join(SHOTS, '5-dark-system.png') });
  await darkCtx.close();

  // ── Mobile ──────────────────────────────────────────────────────
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mp = await m.newPage();
  mp.on('pageerror', (e) => fatal.push('pageerror(mobile): ' + e.message));
  await mp.goto(url);
  await mp.waitForTimeout(800);
  check(
    'no horizontal scroll on a phone',
    (await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) === false
  );
  if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, '6-mobile.png') });
  await m.close();

  await browser.close();

  check('no uncaught page errors', fatal.length === 0, fatal.join('; '));

  console.log(`\nverify-browser: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
})();
