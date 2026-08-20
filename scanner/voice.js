/**
 * Voice comparison — how far a draft sits from the writer's own range.
 *
 * Stage 3 of the voice profile.
 *
 * ── Separation ──────────────────────────────────────────────────────
 *
 * VOICE MATCH never feeds the AI-writing score, and the AI-writing score
 * never feeds VOICE MATCH. They answer different questions. A style
 * deviation says nothing about machine authorship — a writer stretching into
 * an unfamiliar register is not evidence of a model — and mixing them would
 * corrupt the Phase 0 calibration, whose fixture bands assume the density
 * channel sees prose findings only. Same rule as house rules, same reason.
 *
 * ── Bands, not means ────────────────────────────────────────────────
 *
 * A finding fires only when the draft falls OUTSIDE the range the corpus
 * actually shows. Comparing against a mean the writer never writes at would
 * flag their own work constantly: this writer's contraction rate spans 0% in
 * a runbook to 60% in an incident note, and an average of 20% would flag both
 * of the real documents that produced it.
 *
 * ── Unavailable is said out loud ────────────────────────────────────
 *
 * A metric whose data requirement is unmet produces no finding, and is
 * reported as unavailable with what it still needs. Silence would read as
 * "checked and fine", which is a different and false claim.
 *
 * ── No similarity percentage ────────────────────────────────────────
 *
 * The score is not a black-box similarity. It starts at 100 and every point
 * deducted is attributable to a listed finding, so the number and the list
 * can never disagree.
 *
 * Zero dependencies. Node and browser; self-registers as global `Voice`.
 */

const Voice = (() => {
  function deps() {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      const path = require('path');
      return { Fingerprint: require(path.join(__dirname, 'fingerprint.js')) };
    }
    return {
      Fingerprint: typeof Fingerprint !== 'undefined' ? Fingerprint : globalThis.Fingerprint,
    };
  }

  /** Too little draft to compare; below this the whole comparison declines. */
  const MIN_DRAFT_WORDS = 80;

  /**
   * How far outside the band counts as worth mentioning, as a fraction of
   * the band's own width. A draft a hair outside a narrow band is not news;
   * this is what stops a page of nitpicks.
   */
  const TOLERANCE = 0.25;

  /** Points deducted at the point a deviation becomes worth reporting. */
  const BASE_PENALTY = 8;

  /** Ceiling per finding, so one outlier cannot take the score to zero. */
  const MAX_PENALTY = 22;

  const round1 = (n) => Math.round(n * 10) / 10;

  /**
   * Quote a candidate for a finding. A label may carry a qualifier —
   * "surface (as a verb)" — which belongs outside the quotation marks,
   * because the writer never writes the parentheses.
   */
  function quoteCandidate(label) {
    const m = /^(.+?)\s+(\(.+\))$/.exec(String(label));
    return m ? `"${m[1]}" ${m[2]}` : `"${label}"`;
  }

  const BANDS = [
    { id: 'close', min: 80, max: 100, label: 'Sounds like you', tone: 'low' },
    { id: 'near', min: 60, max: 79, label: 'Mostly like you', tone: 'low' },
    { id: 'off', min: 35, max: 59, label: 'Drifting from your voice', tone: 'mid' },
    { id: 'far', min: 0, max: 34, label: "Doesn't sound like you", tone: 'high' },
  ];

  function bandFor(score) {
    const n = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    return BANDS.find((b) => n >= b.min && n <= b.max) || BANDS[BANDS.length - 1];
  }

  /**
   * Wording per metric. Each template states the writer's observed range,
   * then the draft's value, in that order — so the reader can check it.
   */
  const PHRASING = {
    sentenceLength: (b, v) =>
      `your sentences run ${b.low} to ${b.high} words, this draft averages ${v}`,
    paragraphLength: (b, v) =>
      `your paragraphs run ${b.low} to ${b.high} sentences, this draft averages ${v}`,
    commaRate: (b, v) =>
      `you use ${b.low} to ${b.high} commas per 100 words, this draft ${v}`,
    semicolonRate: (b, v) =>
      `you use ${b.low} to ${b.high} semicolons per 100 words, this draft ${v}`,
    dashRate: (b, v) => `you use ${b.low} to ${b.high} dashes per 100 words, this draft ${v}`,
    parentheticalRate: (b, v) =>
      `you use ${b.low} to ${b.high} parentheticals per 100 words, this draft ${v}`,
    contractionRate: (b, v) =>
      `you use contractions in ${b.low}% to ${b.high}% of sentences, this draft ${v}%`,
    readingLevel: (b, v) =>
      `you write at grade ${b.low} to ${b.high}, this draft reads at grade ${v}`,
  };

  /** Which direction reads as "more formal / less like a person". */
  const DIRECTION_HINT = {
    sentenceLength: { above: 'Longer sentences than you write.', below: 'Shorter and clippier than you write.' },
    paragraphLength: { above: 'Denser paragraphs than yours.', below: 'More fragmented than you write.' },
    commaRate: { above: 'More subclauses than you use.', below: 'Fewer pauses than you use.' },
    semicolonRate: { above: 'You rarely reach for semicolons.', below: '' },
    dashRate: { above: 'More dashes than you use.', below: '' },
    parentheticalRate: { above: 'More asides than you use.', below: '' },
    contractionRate: { above: 'Looser than you usually write.', below: 'More formal than you write.' },
    readingLevel: { above: 'Heavier going than your writing.', below: 'Plainer than you write.' },
  };

  // ═══ Comparison ════════════════════════════════════════════════════

  /**
   * @param {string} text the draft
   * @param {object} profile a fingerprint from fingerprint.js
   * @returns {{available:boolean, score:number|null, band:object|null,
   *            findings:Array, unavailable:Array, measured:object}}
   */
  function compare(text, profile) {
    const { Fingerprint } = deps();
    const draft = String(text || '');

    if (!profile || !profile.metrics) {
      return {
        available: false,
        score: null,
        band: null,
        reason: 'No voice profile. Add samples of your own writing first.',
        findings: [],
        unavailable: [],
        measured: null,
      };
    }

    const measured = Fingerprint.measureSample({
      id: 'draft',
      label: 'this draft',
      type: 'written',
      text: draft,
    });

    if (measured.words < MIN_DRAFT_WORDS) {
      return {
        available: false,
        score: null,
        band: null,
        reason: `${measured.words} words is too short to compare; ${MIN_DRAFT_WORDS} is the minimum.`,
        findings: [],
        unavailable: [],
        measured,
      };
    }

    // If not one metric cleared its data requirement there is nothing to
    // compare against, and a score of 100 would read as "sounds like you"
    // when it actually means "nothing was checked". Decline instead.
    const anyAvailable = Object.values(profile.metrics).some((m) => m && m.available);
    if (!anyAvailable) {
      return {
        available: false,
        score: null,
        band: null,
        reason:
          'No metric has enough corpus behind it yet. Add more of your own writing — ' +
          'a score here would mean "nothing was checked", not "sounds like you".',
        findings: [],
        unavailable: Object.values(profile.metrics).map((m) => ({
          id: m.id,
          label: m.label,
          reason: m.reason,
        })),
        measured,
      };
    }

    const findings = [];
    const unavailable = [];

    // ── Numeric metrics: flag only outside the observed band ────────
    for (const [id, phrase] of Object.entries(PHRASING)) {
      const m = profile.metrics[id];
      if (!m) continue;
      if (!m.available) {
        unavailable.push({ id, label: m.label, reason: m.reason });
        continue;
      }

      const value = measured.values[id];
      if (value === null || !Number.isFinite(value)) continue;
      const v = round1(value);
      const { low, high } = m.band;

      // Tolerance scales with the band's own width, so a wide band (a writer
      // who genuinely varies) is harder to fall outside than a narrow one.
      const width = Math.max(high - low, Math.abs(high) * 0.15, 0.5);
      const slack = width * TOLERANCE;

      let distance = 0;
      let direction = null;
      if (v > high + slack) {
        distance = v - high;
        direction = 'above';
      } else if (v < low - slack) {
        distance = low - v;
        direction = 'below';
      } else {
        continue;
      }

      const severityRatio = distance / width;
      const penalty = Math.min(MAX_PENALTY, Math.round(BASE_PENALTY * (1 + severityRatio)));
      const hint = (DIRECTION_HINT[id] || {})[direction] || '';

      findings.push({
        type: 'voice',
        group: 'voice',
        metric: id,
        label: m.label,
        severity: severityRatio >= 1.5 ? 'high' : severityRatio >= 0.6 ? 'medium' : 'low',
        text: phrase(m.band, v),
        suggestion: hint,
        band: m.band,
        draftValue: v,
        direction,
        penalty,
        evidence: (m.evidence || []).slice(0, 2),
      });
    }

    // ── Words the writer never uses ─────────────────────────────────
    const absent = profile.metrics.absentWords;
    if (absent && !absent.available) {
      unavailable.push({ id: 'absentWords', label: absent.label, reason: absent.reason });
    } else if (absent && absent.available) {
      const draftWords = measured.wordList;
      const counts = new Map();
      for (const w of draftWords) counts.set(w, (counts.get(w) || 0) + 1);

      for (const word of absent.absent) {
        // Candidates are not all single words. "at scale" and "worth noting"
        // are phrases, and "surface" only counts as a verb — none of which a
        // word-frequency map can answer. Resolve the candidate back to the
        // pattern that produced it and count that; the word map is the
        // fallback for a stored profile naming something we no longer carry.
        const entry = Fingerprint.absenceFor ? Fingerprint.absenceFor(word) : null;
        const n = entry
          ? Fingerprint.absenceCount(entry, measured.text || draft)
          : counts.get(word.toLowerCase());
        if (!n) continue;
        findings.push({
          type: 'voice',
          group: 'voice',
          metric: 'absentWords',
          label: 'Word you never use',
          severity: 'high',
          text:
            `you never write ${quoteCandidate(word)} across ${absent.observedOver} words, ` +
            `this draft uses it ${n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`}`,
          suggestion: '',
          word,
          draftValue: n,
          penalty: Math.min(MAX_PENALTY, BASE_PENALTY + (n - 1) * 3),
          evidence: [],
        });
      }
    }

    // ── Sentence openers ────────────────────────────────────────────
    const openers = profile.metrics.sentenceOpeners;
    if (openers && !openers.available) {
      unavailable.push({ id: 'sentenceOpeners', label: openers.label, reason: openers.reason });
    } else if (openers && openers.available && measured.openers.length >= 5) {
      const draftCounts = new Map();
      for (const w of measured.openers) draftCounts.set(w, (draftCounts.get(w) || 0) + 1);
      const known = new Map(openers.top.map((t) => [t.word, t.rate]));

      for (const [word, n] of draftCounts) {
        const draftRate = round1((n / measured.openers.length) * 100);
        const yourRate = known.get(word) || 0;
        // Only a heavy lean the writer does not share, and only with enough
        // openers behind it to be more than one sentence's accident.
        if (n < 3 || draftRate < 20 || draftRate < yourRate * 2.5) continue;
        findings.push({
          type: 'voice',
          group: 'voice',
          metric: 'sentenceOpeners',
          label: 'Sentence openers',
          severity: 'medium',
          text:
            `you open ${yourRate}% of sentences with "${word}", ` +
            `this draft opens ${draftRate}% of them that way`,
          suggestion: 'Vary how the sentences start.',
          word,
          draftValue: draftRate,
          penalty: BASE_PENALTY,
          evidence: (openers.evidence || []).slice(0, 1),
        });
      }
    }

    for (const id of ['paragraphOpeners', 'signatureWords']) {
      const m = profile.metrics[id];
      if (m && !m.available) unavailable.push({ id, label: m.label, reason: m.reason });
    }

    findings.sort((a, b) => b.penalty - a.penalty);

    const deducted = findings.reduce((n, f) => n + f.penalty, 0);
    const score = Math.max(0, Math.min(100, 100 - deducted));

    return {
      available: true,
      score,
      band: bandFor(score),
      reason: '',
      findings,
      unavailable,
      measured: {
        words: measured.words,
        sentences: measured.sentences.length,
        values: Object.fromEntries(
          Object.entries(measured.values).map(([k, v]) => [k, v === null ? null : round1(v)])
        ),
      },
      // Every point of the score is attributable to a listed finding.
      deducted,
      checked: Object.keys(PHRASING).length + 2,
    };
  }

  return {
    BANDS,
    PHRASING,
    MIN_DRAFT_WORDS,
    TOLERANCE,
    BASE_PENALTY,
    MAX_PENALTY,
    bandFor,
    compare,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Voice;
}
