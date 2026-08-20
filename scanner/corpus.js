/**
 * Reference corpus — samples of the writer's own unassisted writing.
 *
 * ── The constraint that shapes this whole module ────────────────────
 *
 * A voice fingerprint is only as honest as what it is built from. If a
 * sample was drafted by an assistant, the fingerprint captures the
 * assistant's cadence and vocabulary, and every later comparison is then
 * confidently wrong: the tool would tell the writer their own voice is off
 * when the draft is actually closer to them than the reference is.
 *
 * Asking nicely is not enough, so every sample is screened on the way in
 * with the AI detector that already ships here. A sample that reads as
 * AI-assisted or machine-written is flagged loudly and excluded from
 * readiness until the writer either replaces it or overrides deliberately.
 * That is a guard, not a verdict — the same false-positive caveats apply as
 * everywhere else — but it catches the obvious case, which is the one that
 * would silently poison the feature.
 *
 * ── Stage 1 scope ───────────────────────────────────────────────────
 *
 * This file stores and validates the corpus. It computes no fingerprint and
 * changes no score; nothing else in the app behaves differently until a
 * corpus exists. The thresholds a fingerprint will need (MIN_SAMPLES,
 * MIN_TOTAL_WORDS, the confidence tiers) live here now so that ingest can
 * report readiness honestly from the start.
 *
 * Zero dependencies. Node and browser; self-registers as global `Corpus`.
 */

const Corpus = (() => {
  function deps() {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      const path = require('path');
      return {
        AIDetector: require(path.join(
          __dirname, '..', '.claude', 'skills', 'avoid-ai-writing', 'detector', 'patterns.js'
        )),
        Scoring: require(path.join(__dirname, 'scoring.js')),
      };
    }
    return {
      AIDetector: typeof AIDetector !== 'undefined' ? AIDetector : globalThis.AIDetector,
      Scoring: typeof Scoring !== 'undefined' ? Scoring : globalThis.Scoring,
    };
  }

  // ── Thresholds ────────────────────────────────────────────────────

  /** Fewer than this and one atypical piece dominates the fingerprint. */
  const MIN_SAMPLES = 4;

  /** What the UI asks for. More is allowed; this is the shape to aim at. */
  const TARGET_SAMPLES = 6;

  /** A ceiling, so a paste loop cannot fill storage. */
  const MAX_SAMPLES = 12;

  /** Under this a sample is too short for sentence statistics to mean much. */
  const MIN_SAMPLE_WORDS = 100;

  /** Guard against pasting a novel. */
  const MAX_SAMPLE_WORDS = 20000;

  /**
   * Total words before a fingerprint is worth trusting. Sentence-length
   * spread and per-word rates are noisy under a few thousand words; this is
   * the floor below which the fingerprint must decline to be confident.
   */
  const MIN_TOTAL_WORDS = 1500;

  /** Total words at which the fingerprint can claim full confidence. */
  const STRONG_TOTAL_WORDS = 3000;

  /** A sample scoring above this band reads as assisted and is quarantined. */
  const MAX_CLEAN_BAND = 'some';

  const FORMAT = 'proof-desk/corpus';
  const VERSION = 1;

  // ── Sample handling ───────────────────────────────────────────────

  const countWords = (text) => {
    const t = String(text || '').trim();
    return t ? t.split(/\s+/).length : 0;
  };

  function slug(s) {
    return (
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'sample'
    );
  }

  /**
   * Validate and normalize one sample. Throws with a message meant for a
   * person, since this is fed by paste and by file upload.
   */
  function normalizeSample(raw, index = 0) {
    if (!raw || typeof raw !== 'object') throw new Error(`Sample ${index + 1} is not an object.`);
    const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) throw new Error(`Sample ${index + 1} has no text.`);

    const words = countWords(text);
    if (words < MIN_SAMPLE_WORDS) {
      throw new Error(
        `Sample ${index + 1} is ${words} words; ${MIN_SAMPLE_WORDS} is the minimum for it to say anything about your style.`
      );
    }
    if (words > MAX_SAMPLE_WORDS) {
      throw new Error(`Sample ${index + 1} is ${words} words; the limit is ${MAX_SAMPLE_WORDS}.`);
    }

    const label =
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 120)
        : `Sample ${index + 1}`;

    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : slug(label),
      label,
      text,
      words,
      // The writer's own assertion that this is unassisted. Recorded, not
      // trusted on its own — screening runs regardless.
      unassisted: raw.unassisted !== false,
      // Set by the writer to keep a sample the screen flagged.
      overrideScreen: raw.overrideScreen === true,
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 300) : '',
    };
  }

  function normalize(samples) {
    if (!Array.isArray(samples)) throw new Error('A corpus must be a list of samples.');
    if (samples.length > MAX_SAMPLES) {
      throw new Error(`Too many samples (limit ${MAX_SAMPLES}).`);
    }
    const out = samples.map(normalizeSample);

    const seen = new Set();
    for (const s of out) {
      let id = s.id;
      let n = 2;
      while (seen.has(id)) id = `${s.id}-${n++}`;
      s.id = id;
      seen.add(id);
    }
    return out;
  }

  // ── Screening ─────────────────────────────────────────────────────

  /**
   * Run the AI detector over one sample. Returns the calibrated score, its
   * band, and whether the sample should be treated as contaminated.
   *
   * This is the guard the whole feature rests on: a corpus built from
   * assistant-drafted text produces a fingerprint of the assistant.
   */
  function screenSample(sample) {
    const { AIDetector, Scoring } = deps();
    if (!AIDetector || !Scoring) {
      return { score: null, band: null, flagged: false, reason: 'screening unavailable' };
    }
    const prose = AIDetector.analyzeText(sample.text, { contextMode: 'general' });
    const calibrated = Scoring.calibrate({
      baseScore: prose.score,
      issues: prose.issues || [],
      wordCount: prose.stats.wordCount,
    });

    const order = Scoring.BANDS.map((b) => b.id);
    const limit = order.indexOf(MAX_CLEAN_BAND);
    const here = order.indexOf(calibrated.band.id);
    const flagged = here > limit;

    return {
      score: calibrated.score,
      band: calibrated.band,
      flagged,
      reason: flagged
        ? `Scores ${calibrated.score}/100 — ${calibrated.band.label.toLowerCase()}. ` +
          'If an assistant drafted this, the fingerprint will describe the assistant, not you.'
        : '',
    };
  }

  /** Screen every sample. Returns a new list with `screen` attached. */
  function screen(samples) {
    return normalize(samples).map((s) => ({ ...s, screen: screenSample(s) }));
  }

  // ── Readiness ─────────────────────────────────────────────────────

  /**
   * Whether the corpus can support a fingerprint, and if not, exactly what
   * is missing. Reported rather than inferred, so a thin corpus says so.
   */
  function status(samples) {
    let list;
    try {
      list = screen(samples || []);
    } catch (err) {
      return {
        ok: false,
        sampleCount: 0,
        usableCount: 0,
        totalWords: 0,
        usableWords: 0,
        confidence: 'none',
        flagged: [],
        reasons: [err.message],
      };
    }

    const flagged = list.filter((s) => s.screen.flagged && !s.overrideScreen);
    const usable = list.filter((s) => !s.screen.flagged || s.overrideScreen);
    const totalWords = list.reduce((n, s) => n + s.words, 0);
    const usableWords = usable.reduce((n, s) => n + s.words, 0);

    const reasons = [];
    if (usable.length < MIN_SAMPLES) {
      reasons.push(
        `${usable.length} of ${MIN_SAMPLES} samples. Add ${MIN_SAMPLES - usable.length} more.`
      );
    }
    if (usableWords < MIN_TOTAL_WORDS) {
      reasons.push(
        `${usableWords} of ${MIN_TOTAL_WORDS} words. Sentence statistics are noise below that.`
      );
    }
    for (const s of flagged) {
      reasons.push(`"${s.label}" reads as AI-assisted and is excluded. ${s.screen.reason}`);
    }

    const ok = usable.length >= MIN_SAMPLES && usableWords >= MIN_TOTAL_WORDS;
    const confidence = !ok
      ? 'none'
      : usableWords >= STRONG_TOTAL_WORDS && usable.length >= TARGET_SAMPLES
        ? 'high'
        : usableWords >= STRONG_TOTAL_WORDS || usable.length >= TARGET_SAMPLES
          ? 'medium'
          : 'low';

    return {
      ok,
      sampleCount: list.length,
      usableCount: usable.length,
      totalWords,
      usableWords,
      confidence,
      flagged: flagged.map((s) => ({ id: s.id, label: s.label, screen: s.screen })),
      reasons,
      samples: list,
    };
  }

  /** The usable samples' text, joined — what a fingerprint will read. */
  function usableText(samples) {
    return screen(samples)
      .filter((s) => !s.screen.flagged || s.overrideScreen)
      .map((s) => s.text)
      .join('\n\n');
  }

  // ── Import / export ───────────────────────────────────────────────

  function toJSON(samples, { pretty = true } = {}) {
    const doc = {
      format: FORMAT,
      version: VERSION,
      note:
        'Samples must be the writer\'s own unassisted writing. Anything drafted ' +
        'with an assistant fingerprints the assistant, not the writer.',
      samples: normalize(samples).map((s) => {
        const out = { label: s.label, text: s.text };
        if (s.note) out.note = s.note;
        if (s.overrideScreen) out.overrideScreen = true;
        if (s.unassisted === false) out.unassisted = false;
        return out;
      }),
    };
    return JSON.stringify(doc, null, pretty ? 2 : 0);
  }

  function fromJSON(json) {
    let doc;
    try {
      doc = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (err) {
      throw new Error(`That is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(doc)) return normalize(doc);
    if (!doc || typeof doc !== 'object') throw new Error('Expected a corpus object or a list.');
    if (doc.format && doc.format !== FORMAT) {
      throw new Error(`Unrecognized format "${doc.format}".`);
    }
    if (!Array.isArray(doc.samples)) throw new Error('Corpus has no "samples" list.');
    return normalize(doc.samples);
  }

  return {
    MIN_SAMPLES,
    TARGET_SAMPLES,
    MAX_SAMPLES,
    MIN_SAMPLE_WORDS,
    MAX_SAMPLE_WORDS,
    MIN_TOTAL_WORDS,
    STRONG_TOTAL_WORDS,
    MAX_CLEAN_BAND,
    FORMAT,
    VERSION,
    countWords,
    normalize,
    normalizeSample,
    screen,
    screenSample,
    status,
    usableText,
    toJSON,
    fromJSON,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Corpus;
}
