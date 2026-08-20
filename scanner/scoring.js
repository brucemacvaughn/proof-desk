/**
 * The score scale — bands, and the curve that maps evidence onto them.
 *
 * This file is the source of truth for what a number means. The CLI, the web
 * UI, and the fixture tests all read the bands from here, so a reader and a
 * test can never disagree about whether 62 is "fine" or "fix this".
 *
 * ── Why a calibration layer exists ──────────────────────────────────
 *
 * The vendored detector normalizes with `rawScore / max(1, log2(words/50))`.
 * That divisor is meant to stop long documents accumulating score forever,
 * but it also punishes density: the bundled AI essay packs 19 distinct flags
 * into 125 words — "a testament to", "watershed moment", "delves into",
 * "Moreover", "Furthermore", "experts believe" — and lands on 49/100, while
 * genuinely clean prose lands on 0. The usable range was 0-50, so obviously
 * machine-written text read as "moderate, low confidence".
 *
 * The detector is vendored unmodified (its own test suite pins its numbers),
 * so the fix belongs here: treat the detector's output as evidence, not as
 * the final answer, and re-express it on a scale where the top band is
 * reachable.
 *
 * ── The curve ───────────────────────────────────────────────────────
 *
 * Two channels, taking the stronger:
 *
 *   density  Severity-weighted flags per 100 words, through a saturating
 *            exponential. Density is what actually distinguishes machine
 *            prose: the fixtures run 0.7 flags/100 words for human writing
 *            against 15-23 for generated text. Saturating means "very dense"
 *            and "absurdly dense" both land near the ceiling, instead of the
 *            ceiling being unreachable.
 *
 *   base     The detector's own score, so a document it feels strongly about
 *            for reasons density misses is not talked down.
 *
 * Two guards keep the FN-bias the whole project is built on:
 *
 *   evidence  Density is damped until several DISTINCT findings corroborate
 *             each other. One "delve" in a paragraph is a word choice; six
 *             different tells in four sentences is a signature. Without this,
 *             a single flag in a short paragraph would score like an essay.
 *
 *   MIN_WORDS Below it there is not enough text to judge, and the score stays
 *             in the clean band rather than guessing.
 */

const Scoring = (() => {
  /**
   * The bands. Ordered low to high; `max` is inclusive.
   * `blurb` is what the UI shows under the number.
   */
  const BANDS = [
    {
      id: 'clean',
      min: 0,
      max: 15,
      label: 'Reads as human',
      blurb: 'Nothing here looks machine-written.',
      tone: 'low',
    },
    {
      id: 'some',
      min: 16,
      max: 40,
      label: 'Some AI signals',
      blurb: 'A few tells. Worth a look, not an alarm.',
      tone: 'low',
    },
    {
      id: 'assisted',
      min: 41,
      max: 70,
      label: 'Reads as AI-assisted',
      blurb: 'Enough patterns that a reader would notice. Worth editing.',
      tone: 'mid',
    },
    {
      id: 'machine',
      min: 71,
      max: 100,
      label: 'Reads as machine-written',
      blurb: 'Dense with generated-text patterns. Rewrite before sending.',
      tone: 'high',
    },
  ];

  // ── Curve constants ───────────────────────────────────────────────
  //
  // Fitted against scanner/samples/fixtures/, not chosen by feel. Changing
  // one of these without re-running `npm run test:bands` will move fixtures
  // out of their bands, which is the point of that suite.

  /** Weighted-density at which the curve reaches ~63% of the ceiling. */
  const DENSITY_SCALE = 26;

  /**
   * Distinct findings needed before density counts at full strength.
   *
   * Three, squared, gives the ramp 1 -> 0.11, 2 -> 0.44, 3 -> 1.0. That
   * matches what the fixtures show: every clean document in the corpus,
   * including the technical runbook and the second-language piece, carries
   * at most one flag, while three distinct tells of different kinds is real
   * corroboration rather than one unlucky word.
   */
  const EVIDENCE_FULL = 3;

  /** Too little text to judge. */
  const MIN_WORDS = 40;

  /** Severity → weight, for the density channel. */
  const SEVERITY_WEIGHT = { critical: 6, high: 5, medium: 3, low: 1.5 };

  /**
   * @param {number} score 0-100
   * @returns {{id,min,max,label,blurb,tone}} the band it falls in
   */
  function bandFor(score) {
    const n = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    return BANDS.find((b) => n >= b.min && n <= b.max) || BANDS[BANDS.length - 1];
  }

  /** Weight one finding for the density channel. */
  function weigh(issue) {
    if (issue && typeof issue.weight === 'number') return issue.weight;
    return SEVERITY_WEIGHT[issue && issue.severity] ?? 2;
  }

  /**
   * Map detector evidence onto the published scale.
   *
   * @param {{baseScore:number, issues:Array, wordCount:number}} input
   * @returns {{score:number, band:object, density:number, evidence:number,
   *            densityScore:number, baseScore:number}}
   */
  function calibrate({ baseScore = 0, issues = [], wordCount = 0 } = {}) {
    // Default parameters only cover `undefined`, and callers pass through
    // detector output that can carry an explicit null.
    const list = Array.isArray(issues) ? issues : [];
    const base = Math.max(0, Math.min(100, Number(baseScore) || 0));
    const words = Math.max(0, Number(wordCount) || 0);
    const count = list.length;

    if (words < MIN_WORDS || count === 0) {
      const score = words < MIN_WORDS ? Math.min(base, BANDS[0].max) : base;
      return {
        score: Math.round(score),
        band: bandFor(score),
        density: 0,
        evidence: 0,
        densityScore: 0,
        baseScore: base,
      };
    }

    const weighted = list.reduce((sum, i) => sum + weigh(i), 0);
    const density = (weighted / words) * 100;

    // Corroboration damping. Squared so a lone finding is nearly discounted
    // and full weight arrives only once several distinct tells agree —
    // false positives cost more than misses here, and a single flag is the
    // commonest false positive.
    const evidence = Math.min(1, (count / EVIDENCE_FULL) ** 2);

    const densityScore = 100 * (1 - Math.exp(-density / DENSITY_SCALE)) * evidence;

    // Take the stronger channel. The detector's own read is never talked
    // down by a low density, and density can lift a verdict that the
    // detector's length divisor flattened.
    const score = Math.max(base, densityScore);

    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      band: bandFor(score),
      density: Number(density.toFixed(2)),
      evidence: Number(evidence.toFixed(3)),
      densityScore: Math.round(densityScore),
      baseScore: base,
    };
  }

  return {
    BANDS,
    bandFor,
    calibrate,
    DENSITY_SCALE,
    EVIDENCE_FULL,
    MIN_WORDS,
    SEVERITY_WEIGHT,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Scoring;
}
