#!/usr/bin/env node
/**
 * Build the single-file web scanner.
 *
 * The published page has to be self-contained — the artifact CSP blocks every
 * external host except Google Fonts, so the two detection engines and the
 * sample documents get inlined into dist/index.html rather than fetched.
 * Source stays split across scanner/*.js; this is the only place they merge.
 *
 *   node scanner/build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'index.html');

const SOURCES = {
  patterns: path.join(ROOT, '.claude', 'skills', 'avoid-ai-writing', 'detector', 'patterns.js'),
  'resume-rules': path.join(__dirname, 'resume-rules.js'),
  scoring: path.join(__dirname, 'scoring.js'),
  'house-rules': path.join(__dirname, 'house-rules.js'),
  corpus: path.join(__dirname, 'corpus.js'),
  fingerprint: path.join(__dirname, 'fingerprint.js'),
  extract: path.join(__dirname, 'extract.js'),
  fixer: path.join(__dirname, 'fixer.js'),
  engine: path.join(__dirname, 'engine.js'),
};

const SAMPLE_FILES = {
  'ai-essay': 'ai-essay.md',
  'human-essay': 'human-essay.md',
  'ai-resume': 'ai-resume.txt',
  'human-resume': 'human-resume.txt',
};

/**
 * `</script>` anywhere inside inlined JS would close the host script tag early.
 * None of the current sources contain one, but a future pattern addition
 * easily could, so neutralize it at build time rather than hoping.
 */
function safeForInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function stripNodeTail(code) {
  // The CommonJS export block is guarded at runtime, but dropping it keeps the
  // bundle honest about being browser-only.
  return code.replace(
    /\nif \(typeof module !== 'undefined' && module\.exports\) \{\n\s*module\.exports = \w+;\n\}\n?$/,
    '\n'
  );
}

function build() {
  const template = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

  const samples = {};
  for (const [key, file] of Object.entries(SAMPLE_FILES)) {
    samples[key] = fs.readFileSync(path.join(__dirname, 'samples', file), 'utf8');
  }

  let out = template;

  for (const [key, file] of Object.entries(SOURCES)) {
    const marker = `/*INJECT:${key}*/`;
    if (!out.includes(marker)) throw new Error(`template is missing ${marker}`);
    const code = safeForInlineScript(stripNodeTail(fs.readFileSync(file, 'utf8')));
    out = out.replace(marker, () => code);
  }

  const marker = '/*INJECT:samples*/';
  if (!out.includes(marker)) throw new Error(`template is missing ${marker}`);
  out = out.replace(marker, () => safeForInlineScript(JSON.stringify(samples)));

  if (out.includes('/*INJECT:')) throw new Error('an injection marker was left unresolved');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, out);

  const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
  return { path: OUT, kb };
}

if (require.main === module) {
  const { path: out, kb } = build();
  process.stdout.write(`built ${path.relative(ROOT, out)} (${kb} KB)\n`);
}

module.exports = { build, OUT };
