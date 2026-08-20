# Proof Desk

Checks essays, cover letters, and resumes for the patterns that make writing
read as machine-generated, and says what to write instead.

Runs as a single self-contained web page, as a CLI, and as a Claude Code skill.
**Zero dependencies. Nothing is uploaded anywhere** — every engine is plain
JavaScript that runs in your browser or on your machine.

```bash
git clone https://github.com/brucemacvaughn/proof-desk
cd proof-desk
open dist/index.html          # or: xdg-open / just double-click it
```

## Three views

- **Draft** — paste text, or drop a `.pdf` / `.docx` / `.txt` on the page.
  Scans as you type.
- **Marked up** — your text with a wavy proof-mark underline under every
  flagged phrase, colored by severity. Click a finding to jump to its mark.
- **Cleaned** — the draft with the definite fixes already applied, ready to
  copy.

## CLI

```bash
node scanner/scan.js essay.md                    # auto-detects essay vs resume
node scanner/scan.js resume.txt --mode resume
cat draft.txt | node scanner/scan.js --json
node scanner/scan.js essay.md --fix > clean.md   # cleaned draft to stdout
node scanner/scan.js essay.md --fail-over 40     # exit 1 when the score is over 40
```

The last one makes it usable as a CI gate or a pre-commit hook on a docs repo.

## As a Claude Code skill

The vendored skill lives in `.claude/skills/`, so inside this repo you can ask
Claude to "clean up the AI writing in draft.md" and it will audit and rewrite —
which covers the judgment calls the deterministic fixer refuses to guess at.
To install it globally:

```bash
git clone https://github.com/conorbronsdon/avoid-ai-writing ~/.claude/skills/avoid-ai-writing
```

## House rules

Your own standing bans, on top of the AI patterns. They get their own
**HOUSE RULES** category in every surface, and they **never move the AI
score** — a style preference is not evidence a machine wrote something, and
letting "platinum" push a document toward "machine-written" would make the
number mean two things at once.

The shipped set:

| Pattern | Replacement | Why |
|---|---|---|
| `em dash` | `,` | Not how I punctuate |
| `intersection` | (rewrite) | Overused, means nothing |
| `crossroads` | (rewrite) | Overused, means nothing |
| `platinum` | (remove) | Not a claim I make |
| `leverage (as verb)` | use | Corporate |
| `delve` | (rewrite) | AI tell |
| `robust` | strong, solid | AI tell |
| `landscape` | (rewrite) | AI tell |
| `6,000` | thousands | Never use the number |
| `two years coding` | three years | Recurring factual error |

Each entry takes a **pattern**, an optional **replacement**, and an optional
**note**. Three match modes cover the list above:

- `word` (default) — whole word, case-insensitive. `robust` does not fire
  inside `robustness`.
- `literal` — exact substring, no word boundary. An em dash is punctuation and
  has no `\b` to anchor to.
- `regex` — for morphology and context. `delve` catches *delves/delved/
  delving*; `leverage` fires as a verb but not as a noun, so "financial
  leverage" and "the leverage he had" are left alone.

A replacement of `(rewrite)` or `(remove)` is an **instruction, not a
substitution**. The fixer applies real replacements and reports directives for
you to handle, rather than pasting the word "(rewrite)" into your draft.

### One list, three surfaces

The rules live as code in `scanner/house-rules.js` (the page has no network
and cannot fetch JSON at runtime). Everything else is generated from there by
`npm run rules:sync`, and `npm run rules:check` fails if any copy has drifted:

| | |
|---|---|
| `house-rules.json` | Portable export; what the CLI reads. |
| `.claude/skills/avoid-ai-writing/HOUSE-RULES.md` | What the Claude Code skill reads. |
| `.claude/skills/avoid-ai-writing/SKILL.md` | A pointer, fenced in HTML comment markers. |

**In the page** — the HOUSE RULES panel adds, deletes, and toggles rules, kept
in `localStorage`. **Copy JSON** is the reliable export everywhere; **Download**
also works when the page is opened from disk. Import takes a file or a paste.

**In the CLI** — rules resolve from the first of: `--rules <file>`,
`$PROOF_DESK_RULES`, `./.proof-desk-rules.json`,
`~/.proof-desk/house-rules.json`, then the built-in defaults. `--no-house`
skips them.

```bash
node scanner/scan.js draft.md --rules my-rules.json
```

**In the skill** — `SKILL.md` carries one generated block, fenced between
`<!-- PROOF-DESK:HOUSE-RULES:BEGIN -->` and `:END`, pointing at
`HOUSE-RULES.md`. That block is the only edit to the vendored skill text; the
detector itself is untouched.

## Voice: the reference corpus

*Phase 2, complete: ingest, fingerprint, and the VOICE MATCH comparison.*

Proof Desk can hold a **reference corpus**: 4–6 samples of your own writing,
used later to compare a draft against how you actually write.

### Every sample must be your own unassisted writing

This is the constraint the whole feature depends on. If a sample was drafted
with an assistant, the fingerprint describes the assistant, not you — and
every comparison afterwards is confidently wrong in the worst direction: it
tells you your own voice is off while rating assistant-shaped prose as
authentic. Much recent professional writing is assistant-drafted, so this is
the normal case, not an edge case.

The page says so plainly, and **every sample is screened on the way in** with
the AI detector that already ships here. Anything scoring above the "some
signals" band is flagged, excluded from readiness, and left out of the text a
fingerprint would read. You can override that per sample, and the page tells
you what you are accepting. A screen catches the obvious case; it is not proof.

### What makes a corpus usable

| | |
|---|---|
| Samples | 4 minimum, 6 recommended (12 ceiling) |
| Words per sample | 100 minimum |
| Total words | 1,500 minimum; 3,000+ for full confidence |

Below those floors the corpus reports exactly what is missing — *"3 of 4
samples. Add 1 more."*, *"467 of 1500 words."* — rather than producing a
number that looks authoritative. Confidence is reported as `none` / `low` /
`medium` / `high` and never inferred silently.

### Using it

**In the page** — the YOUR WRITING panel takes a paste or a file (PDF, .docx,
text, through the same extractor as the scanner). Samples persist in
`localStorage`; Copy JSON exports, file or paste imports.

**In the CLI**

```bash
node scanner/scan.js --corpus-status --corpus my-corpus.json
node scanner/scan.js draft.md --corpus my-corpus.json
```

Resolved from the first of `--corpus <file>`, `$PROOF_DESK_CORPUS`,
`./.proof-desk-corpus.json`, `~/.proof-desk/corpus.json`. `--corpus-status`
exits non-zero when the corpus is not yet usable, so it works as a check.

**In the skill** — `.claude/skills/avoid-ai-writing/VOICE.md` is generated
from the same thresholds and states the unassisted constraint for the agent.

### Written and spoken samples

A sample is `written` or `spoken`. Transcripts of talks, courses and
interviews are `spoken`: their sentence lengths, paragraph breaks,
punctuation and contractions belong to whoever transcribed them — auto-captions
carry none at all — so **those metrics ignore transcripts entirely**.
Vocabulary and phrasing survive transcription, so spoken samples do count
toward those. The UI labels the type and says why it counts for less.

## The voice profile

Built from the corpus. Four properties matter more than the metric list.

**Range, not averages.** Someone who mentors students, files support reports
and negotiates with vendors has a sentence length that is a *band*, not a
number. Every numeric metric is measured **per sample** and stored as the
range across samples, with the mean alongside. Stage 3 will flag only drafts
outside the band — comparing against an average the writer never actually
writes at would flag their own work constantly.

**Per-metric confidence, no global number.** A mean settles after a few
hundred words; claiming someone *never* writes a word needs thousands. Each
metric declares its own requirement and reports `unavailable` with a reason
until met:

| Metric | Needs | Basis |
|---|---|---|
| Sentence length, Reading level | 400 words | written only |
| Commas, Contractions | 500 words | written only |
| Sentence openers | 600 words | written only |
| Paragraph length | 800 words | written only |
| Semicolons, Dashes, Parentheticals | 1,000 words | written only |
| Paragraph openers, Words you lean on | 1,500 words | mixed |
| Words you never use | 3,000 words | mixed |

There is deliberately **no single confidence score** — the profile reports
how many metrics are actually available (e.g. `8/12`).

**Evidence.** Every metric carries real excerpts from the corpus that produced
it, attributed to their sample. Sentence length shows the shortest, a median
and the longest sentence you actually wrote. A fingerprint you cannot audit is
one you should not trust.

**Absence is bounded.** "Words you never use" is only ever a claim about the
corpus that was read, and says so: *"furthermore appears 0 times in 3,100
words."*

```bash
node scanner/scan.js --fingerprint --corpus my-corpus.json
```

## VOICE MATCH

A second score beside the AI-writing one, with its own findings category.

**It never feeds the AI-writing score, and the AI-writing score never feeds
it.** Same separation as house rules, same reason: a style deviation says
nothing about machine authorship, and mixing them would corrupt the Phase 0
calibration. A test recomputes the AI score from prose findings alone and
requires an exact match.

**Only deviations outside the observed band are flagged.** All five documents
in the reference corpus — across every register in it — score **100/100 with
zero findings**. That is the property that matters: if a writer's own work
gets flagged, they stop reading the findings.

Findings are specific and checkable, never a similarity percentage:

```
you write at grade 5.3 to 6.8, this draft reads at grade 14.7
your sentences run 9.6 to 14.7 words, this draft averages 18.7
you never write "furthermore" across 3,534 words, this draft uses it once
```

**Unavailable is said out loud.** A metric short of corpus produces no finding
and is listed under *Voice — not checked* with what it still needs. Silence
would read as "checked and fine", which is a different claim.

Every point deducted is attributable to a listed finding: the score starts at
100 and a test asserts `score === 100 - sum(penalties)`, so the number and the
list can never disagree.

| Score | Means |
|---|---|
| 80–100 | Sounds like you |
| 60–79 | Mostly like you |
| 35–59 | Drifting from your voice |
| 0–34 | Doesn't sound like you |

## The score bands

`scanner/scoring.js` is the source of truth for what a number means. The CLI,
the web page, and the fixture tests all read the bands from there, so the
terminal and the browser can never disagree.

| Score | Band | Means |
|---|---|---|
| 0–15 | **Reads as human** | Nothing here looks machine-written. |
| 16–40 | **Some AI signals** | A few tells. Worth a look, not an alarm. |
| 41–70 | **Reads as AI-assisted** | Enough patterns that a reader would notice. Worth editing. |
| 71–100 | **Reads as machine-written** | Dense with generated-text patterns. Rewrite before sending. |

### Why there is a calibration layer

The vendored detector normalizes with `rawScore / max(1, log2(words/50))`.
That divisor stops long documents accumulating score forever, but it also
punishes density: the bundled AI essay packs 19 distinct flags into 125 words
and used to land on **49/100** — "moderate, low confidence" — while clean prose
landed on 0. The usable range was 0–50 and the top half was unreachable.

The detector is vendored unmodified, so the fix lives in `scoring.js`, which
treats the detector's output as evidence rather than the verdict. Two channels,
stronger wins:

- **Density** — severity-weighted flags per 100 words through a saturating
  curve. Density is what actually separates the corpus: human fixtures run
  ~2 weighted flags per 100 words, generated ones 37–100.
- **Base** — the detector's own score, so a document it feels strongly about
  for reasons density misses is never talked down.

Two guards preserve the FN-bias:

- **Corroboration.** Density is damped by `(findings / 3)²`, so one flag counts
  for 11%, two for 44%, three for full. Every clean fixture in the corpus —
  including the technical runbook and the second-language piece — carries at
  most one flag. One "delve" is a word choice; three distinct tells is a
  signature.
- **Minimum length.** Under 40 words there is not enough text to judge, and the
  score stays in the clean band rather than guessing.

That moves the AI essay 49 → **89** and leaves the human essay at **3**.

### The fixture corpus

`scanner/samples/fixtures/manifest.json` pins 14 documents to expected bands,
and `npm run test:bands` fails if any leaves its band. Two of them are
false-positive guards that matter more than the rest:

- `human-technical.md` — dense imperative technical prose
- `human-nonnative.md` — second-language English

Audits put detector false-positive rates above 60% on non-native writers, so a
calibration that lifts either out of the clean band is a regression regardless
of what it does for the generated fixtures. Current separation is 50+ points
between the lowest machine fixture and the highest human one.

## The two scores

Resumes are scored on two separate axes, because "sounds human" and "is a good
resume" are different questions and a resume can fail one while passing the
other. The bundled AI sample is exactly that case: a well-formed resume —
contact block, dated role, a number on every bullet — that still reads as
machine-written.

- **AI-writing score** (0–100, lower is better) — how machine-generated it
  reads, on the bands above. Resume-specific AI tells feed the same curve as
  prose findings, so a resume and an essay are judged on one scale.
- **Resume craft** (0–100, higher is better) — structure, metrics, and verb
  quality. Independent of who or what wrote it.

Essays get the AI-writing score only.

## What the resume layer looks for

The upstream engine scores general prose and has no resume coverage. Resumes
aren't prose — they're fragment bullets with no articles, deliberate Title Case
headers, and a vocabulary that would read as promotional anywhere else. So
`scanner/resume-rules.js` adds a genre layer, tagged `ai` or `craft`:

**Reads as AI** — dead clichés (`results-driven`, `proven track record`),
LLM-favored verbs (`spearheaded`, `orchestrated`, `leveraged`), impact claims
with no measurement, percentages that are *all* multiples of five, bullets of
suspiciously uniform length, stacked "X, Y, and Z" triads.

**Craft** — bullets carrying no number, weak openers (`Responsible for`),
first-person pronouns, overlong bullets, mixed verb tense, a missing contact
block, undated roles, missing standard sections, skills keyword dumps.

Soft signals only fire when they cluster: one "optimized" is a normal word;
three of them alongside "streamlined" and "facilitated" is a signature.

## What the fixer will and won't do

There is no model behind the page, so the fixer is deterministic. It applies
only the findings that carry a definite answer:

- **Swaps** — the detector ships a plainer replacement for its vocabulary
  tables (`leveraging` → `using`, `robust` → `strong`, `cutting-edge` →
  `latest`). The first option is applied, preserving the original's
  capitalization and `-ing` form.
- **Deletions** — a complete leading connective or filler clause comes out
  whole (`Moreover,`, `In conclusion,`, `It is important to note that`), and
  the seam is repaired.

It refuses everything that needs a fact or a rewrite: vague attribution
(`experts believe` — only the author knows the source), suggestions phrased as
advice (`describe what changed`), uniform rhythm, a bullet missing its metric,
generic conclusions. Those are returned as `manual` and counted in the UI.
Guessing at them produces confident nonsense, which is worse than a flag.

Two guards, both from real bugs: an `-ed` word is never re-conjugated
(`poised` → `ready`, not `readyed`), and a swap is skipped when an article
precedes it and the replacement reads as a verb (`a testament to` → `a shows`).

On the bundled AI essay this takes **89 → 43**, applying 13 edits and leaving
6. Note where that lands: machine-written down to AI-assisted, not down to
clean. The deterministic pass strips the vocabulary and the filler, but what
remains — vague attribution, generic conclusions, uniform rhythm — needs a
rewrite, not a swap. On the human essay it applies **zero**.

Read the result once before sending; a swap can be locally correct and
contextually flat.

## File upload

| | |
|---|---|
| `.pdf` | Text-based PDFs, including the Type0/Identity-H subset fonts Chrome, Google Docs, and Word emit — decoded through their ToUnicode CMaps. |
| `.docx` | OOXML, read straight out of the zip. |
| `.txt` `.md` | Decoded as UTF-8. |

The artifact CSP admits no CDN, so pdf.js was not an option and
`scanner/extract.js` does the job directly, using the platform
`DecompressionStream`. The file is read with `FileReader` and parsed in the
page — there is no upload and no server.

**Scanned PDFs will not work.** They hold pictures of words, which needs OCR;
you get told that rather than an empty box. Password-protected PDFs are
refused. Extracted text always lands in the Draft view first so you can check
it before trusting the score.

Two details, both found by testing against real files:

- Word spaces come from the encoded space glyphs, not from measuring gaps
  between runs. Producers reposition mid-word to kern, and the distance
  between two run origins grows with the run between them, so gap-guessing
  produces `SUMMAR Y` and `ef ficiency`.
- A word hyphenated across a line break is rejoined with the hyphen kept, so
  `cutting-edge` still matches. The cost is an occasional `environ-ments`,
  visible and fixable in the Draft view.

## A caveat that matters

These are **signals, not proof**. The patterns are more common in LLM output,
but people writing under deadline, in an unfamiliar genre, or in a second
language produce the same shapes. Independent audits have found false-positive
rates above 60% on non-native English writers. Every engine here is
deliberately biased toward false negatives for that reason.

Use it to sharpen a draft. Don't use it to decide whether someone cheated.

## Layout

| | |
|---|---|
| `dist/index.html` | The whole scanner as one self-contained page. |
| `scanner/app.html` | UI template the build inlines the engines into. |
| `scanner/scoring.js` | **Score bands and the calibration curve — the source of truth.** |
| `scanner/house-rules.js` | **House rules — the source of truth for the rule set.** |
| `scanner/corpus.js` | Reference corpus: storage, screening, readiness. |
| `scanner/fingerprint.js` | Voice profile: bands, per-metric confidence, evidence. |
| `scanner/voice.js` | VOICE MATCH: band comparison and specific deviations. |
| `scanner/sync-rules.js` | Regenerates the JSON and skill copies from it. |
| `scanner/engine.js` | Combines the engines and picks essay vs resume mode. |
| `scanner/resume-rules.js` | The resume genre layer. |
| `scanner/fixer.js` | Applies findings that have a definite answer. |
| `scanner/extract.js` | PDF / .docx / text extraction. |
| `scanner/scan.js` | CLI. |
| `scanner/build.js` | Inlines everything into `dist/index.html`. |
| `scanner/verify-browser.js` | Optional Chromium smoke test. |
| `.claude/skills/avoid-ai-writing/` | Vendored upstream skill + prose detector. |

## Development

Node >= 18. No install step.

```bash
npm test          # bands, house rules, corpus, fingerprint, voice, resume rules, fixer, extraction, detector, bundle
npm run test:bands # just the score calibration + fixture corpus
npm run rules:sync # regenerate house-rules.json and the skill copies
npm run build     # regenerate dist/index.html from scanner/app.html
```

`dist/index.html` is generated — edit `scanner/app.html` and the modules it
inlines, then rebuild. The build inlines every engine and the samples because
the page has to work with no network at all.

An optional browser smoke test drives the built page in Chromium. Playwright
is deliberately not a dependency:

```bash
npm i -D playwright && npm run verify:browser
```

Test fixtures in `scanner/samples/` use invented people (`Jane Doe`,
`Marco Reyes`) and `example.com` addresses. The two PDFs are real files
produced by Chromium's Skia/PDF engine rather than hand-built to match the
parser; the `.docx` is synthetic, built to the OOXML layout Word writes, and
noted as such in `scanner/extract.test.js`.

## Credit

The prose detection engine and the `avoid-ai-writing` skill are by
[Conor Bronsdon](https://github.com/conorbronsdon/avoid-ai-writing), MIT
licensed, vendored at commit `b504e20` under `.claude/skills/avoid-ai-writing/`
with its license retained. The detector and all its tests are unmodified;
`SKILL.md` carries one generated block, fenced in HTML comment markers, that
points at the house rules.

The resume layer, the fixer, the extractor, the CLI, and the web app are new
work in this repository, MIT licensed — see [LICENSE](LICENSE).
