#!/usr/bin/env node
/**
 * scan — check an essay, a piece of text, or a resume for AI-writing tells.
 *
 * Combines two engines:
 *   • the avoid-ai-writing prose detector (vendored, MIT, Conor Bronsdon)
 *   • the resume rule layer in ./resume-rules.js
 *
 *   node scanner/scan.js essay.md
 *   node scanner/scan.js resume.txt --mode resume
 *   cat draft.txt | node scanner/scan.js --json
 *   node scanner/scan.js essay.md --fail-over 40     # exit 1 if score > 40
 */

const fs = require('fs');
const path = require('path');

const AIDetector = require(path.join(
  __dirname,
  '..',
  '.claude',
  'skills',
  'avoid-ai-writing',
  'detector',
  'patterns.js'
));
const ResumeRules = require('./resume-rules.js');
const ScanEngine = require('./engine.js');
const Fixer = require('./fixer.js');
const Scoring = require('./scoring.js');

// ═══ Terminal helpers ════════════════════════════════════════════════

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));
const bold = c('1');
const dim = c('2');
const red = c('31');
const yellow = c('33');
const green = c('32');
const cyan = c('36');

function scoreColor(score) {
  // Same bands the UI and the fixture tests read, so a number never means
  // one thing in the terminal and another on the page.
  const tone = Scoring.bandFor(score).tone;
  if (tone === 'high') return red;
  if (tone === 'mid') return yellow;
  return Scoring.bandFor(score).id === 'clean' ? green : c('92');
}

function bar(score, width = 28) {
  const filled = Math.round((score / 100) * width);
  return scoreColor(score)('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

// ═══ Args ════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const opts = { mode: 'auto', json: false, failOver: null, context: 'general', file: null, quiet: false, fix: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--context') opts.context = argv[++i];
    else if (a === '--fail-over') opts.failOver = Number(argv[++i]);
    else if (a === '--fix') opts.fix = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) opts.file = a;
  }
  return opts;
}

const HELP = `
${bold('scan')} — check text for AI-writing patterns

  node scanner/scan.js <file> [options]
  cat file.txt | node scanner/scan.js [options]

Options
  --mode <auto|essay|resume>   what kind of document this is (default: auto)
  --context <general|technical> suppress flags legitimate in code-adjacent prose
  --fix                        print the draft with the definite fixes applied
  --fail-over <n>              exit 1 when the AI score is above n
  --json                       machine-readable output
  --quiet, -q                  scores only, no issue list
  --help, -h                   this text
`;

// ═══ Scanning ═══════════════════════════════════════════════════════
//
// Mode detection and the prose+resume combination live in ./engine.js so the
// CLI and the web app cannot drift apart.

const { scan, detectMode } = ScanEngine;

// ═══ Rendering ═══════════════════════════════════════════════════════

function severityMark(sev) {
  if (sev === 'critical' || sev === 'high') return red('●');
  if (sev === 'medium') return yellow('●');
  return dim('●');
}

function render(result, { quiet }) {
  const out = [];
  const sc = scoreColor(result.aiScore);

  out.push('');
  out.push(`  ${bold('AI-writing score')}  ${sc(bold(String(result.aiScore).padStart(3)))}${dim('/100')}  ${bar(result.aiScore)}`);
  const band = result.band || Scoring.bandFor(result.aiScore);
  out.push(`  ${sc(bold(band.label))} ${dim(`(${band.min}-${band.max})`)}`);
  out.push(`  ${dim(band.blurb)}`);
  out.push(`  ${dim(result.classification)} ${dim(`· ${result.confidence} confidence`)}`);
  if (result.calibration) {
    const cal = result.calibration;
    out.push(
      dim(
        `  detector ${cal.baseScore} · ${cal.density.toFixed(1)} weighted flags/100 words` +
          (cal.evidence < 1 ? ` · damped to ${(cal.evidence * 100).toFixed(0)}% (few findings)` : '')
      )
    );
  }

  if (result.mode === 'resume') {
    const cc = scoreColor(100 - result.craftScore);
    out.push('');
    out.push(`  ${bold('Resume craft   ')}  ${cc(bold(String(result.craftScore).padStart(3)))}${dim('/100')}  ${bar(100 - result.craftScore)} ${dim('(lower bar = better)')}`);
    out.push(
      dim(
        `  ${result.stats.bulletsWithMetrics}/${result.stats.bulletCount} bullets carry a number`
      )
    );
  }

  if (quiet) return out.join('\n') + '\n';

  const groups = [
    ['AI-writing tells', result.resumeIssues.filter((i) => i.group === 'ai'), ResumeRules.TYPE_LABELS],
    ['Resume craft', result.resumeIssues.filter((i) => i.group === 'craft'), ResumeRules.TYPE_LABELS],
    ['Prose patterns', result.proseIssues, AIDetector.TYPE_LABELS || {}],
  ];

  for (const [title, issues, labels] of groups) {
    if (!issues.length) continue;
    out.push('');
    out.push(`  ${bold(title)} ${dim(`(${issues.length})`)}`);
    for (const issue of issues.slice(0, 40)) {
      const label = labels[issue.type] || issue.type;
      const where = issue.line ? dim(` L${issue.line}`) : '';
      out.push(`    ${severityMark(issue.severity)} ${cyan(label)}${where}  ${bold(truncate(issue.text, 64))}`);
      if (issue.suggestion) out.push(`      ${dim('→ ' + truncate(issue.suggestion, 92))}`);
    }
    if (issues.length > 40) out.push(dim(`    … and ${issues.length - 40} more`));
  }

  if (!result.proseIssues.length && !result.resumeIssues.length) {
    out.push('');
    out.push(`  ${green('Nothing flagged.')} ${dim('Reads as human.')}`);
  }

  out.push('');
  out.push(
    dim(
      '  Signals, not proof. AI detectors misclassify non-native English writing at high rates —\n' +
        '  use this to improve the draft, not to judge an author.'
    )
  );
  out.push('');
  return out.join('\n');
}

function truncate(s, n) {
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// ═══ Main ════════════════════════════════════════════════════════════

function readInput(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  if (process.stdin.isTTY) return null;
  return fs.readFileSync(0, 'utf8');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let text;
  try {
    text = readInput(opts.file);
  } catch (err) {
    process.stderr.write(`scan: cannot read ${opts.file}: ${err.message}\n`);
    return 2;
  }
  if (text === null) {
    process.stdout.write(HELP);
    return 2;
  }

  if (!['auto', 'essay', 'resume'].includes(opts.mode)) {
    process.stderr.write(`scan: unknown mode "${opts.mode}" — use auto, essay, or resume\n`);
    return 2;
  }

  const result = scan(text, opts);

  // --fix writes the cleaned draft to stdout and nothing else, so it can be
  // redirected into a file or piped onward. The summary goes to stderr.
  if (opts.fix) {
    const issues = ScanEngine.allIssues(result);
    const out = Fixer.fix(text, issues);
    process.stdout.write(out.text);
    const after = scan(out.text, opts);
    process.stderr.write(
      `\n  ${dim(`applied ${out.applied} fix${out.applied === 1 ? '' : 'es'}`)} ` +
        `${dim('·')} ${dim(`score ${result.aiScore} -> ${after.aiScore}`)} ` +
        `${dim('·')} ${dim(`${out.manual.length} left for you`)}\n`
    );
    return opts.failOver !== null && after.aiScore > opts.failOver ? 1 : 0;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (opts.file) process.stdout.write(`\n  ${dim(path.basename(opts.file))} ${dim('·')} ${dim(result.mode + ' mode')}\n`);
    process.stdout.write(render(result, opts));
  }

  if (opts.failOver !== null && result.aiScore > opts.failOver) return 1;
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { scan, detectMode };
