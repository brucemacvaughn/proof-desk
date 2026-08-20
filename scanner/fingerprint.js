/**
 * Voice fingerprint — what the corpus says about how this person writes.
 *
 * Stage 2 of the voice profile. It computes and stores the profile; the
 * comparison that uses it lands in stage 3.
 *
 * ── Four things shape this module more than the metric list ─────────
 *
 * 1. RANGE, NOT AVERAGES. A writer's samples span registers — mentoring a
 *    student, filing a support report, negotiating with a vendor. Their real
 *    sentence length is a band, not a number. So every numeric metric is
 *    measured PER SAMPLE and stored as the observed band across samples,
 *    alongside the pooled mean. Stage 3 compares a draft against the band.
 *    Comparing a writer to an average they never actually write at would
 *    flag their own writing constantly.
 *
 * 2. PER-METRIC CONFIDENCE. One global number is a lie: mean sentence length
 *    settles after a few hundred words, while "words you never use" needs
 *    thousands before absence means anything rather than not having come up.
 *    Every metric declares its own data requirement and reports
 *    `available: false` with a reason until met. A thin metric produces no
 *    finding at all rather than a confident one.
 *
 * 3. SPOKEN SAMPLES COUNT FOR LESS. A transcript's sentence lengths,
 *    paragraph breaks, punctuation and contractions belong to the
 *    transcriber, not the speaker — auto-captions carry no punctuation at
 *    all, a human transcript carries whoever typed it. Vocabulary and
 *    phrasing survive transcription. So metrics are tagged `writtenOnly` and
 *    the rest pool everything.
 *
 * 4. EVIDENCE. Every metric carries real excerpts from the corpus that
 *    produced its number, with their sample and their value. A fingerprint
 *    nobody can audit is a fingerprint nobody should trust.
 *
 * Zero dependencies. Node and browser; self-registers as global `Fingerprint`.
 */

const Fingerprint = (() => {
  const FORMAT = 'proof-desk/fingerprint';
  const VERSION = 1;

  // ═══ Text units ════════════════════════════════════════════════════

  const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

  function words(text) {
    return String(text || '').match(WORD_RE) || [];
  }

  /**
   * Strip the things that are formatting rather than prose, so sentence and
   * paragraph statistics describe how the person writes rather than how they
   * mark up. Headings, code fences, list markers and quote markers are not
   * sentences, and counting them drags the measured band around.
   */
  function cleanForProse(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      // [ \t] not \s: \s matches newlines, so \s{4,} spanned blank
      // lines and swallowed the paragraph after any code block.
      .replace(/^[ \t]{4,}\S.*$/gm, ' ')
      .replace(/^\s*#{1,6}\s.*$/gm, ' ')
      .replace(/^\s*>+\s?/gm, '')
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
      .replace(/`([^`]*)`/g, '$1');
  }

  /**
   * Split into sentences. Deliberately simple, and it discards fragments
   * that are not sentences: a short line with no terminal punctuation is a
   * signature, a heading or a label ("— Dana"), and counting it as a
   * one-word sentence distorts the length band.
   */
  function sentences(text) {
    return String(text || '')
      // Protect common abbreviations from being read as sentence ends.
      .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|Inc|Ltd|Co)\./gi, '$1<DOT>')
      .replace(/\b([A-Z])\./g, '$1<DOT>')
      .split(/(?<=[.!?])["'”’)\]]*\s+/)
      .map((s) => s.replace(/<DOT>/g, '.').trim())
      .filter((s) => {
        const n = words(s).length;
        if (n === 0) return false;
        return /[.!?]["'”’)\]]*$/.test(s) || n >= 4;
      });
  }

  function paragraphs(text) {
    return String(text || '')
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => words(p).length > 0);
  }

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  function sd(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  }

  function percentile(xs, p) {
    if (!xs.length) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  /** Rough syllable count, for reading level only. */
  function syllables(word) {
    const w = String(word).toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const groups = trimmed.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  const CONTRACTION_RE =
    /\b\w+['’](?:t|s|re|ve|ll|d|m)\b|\b(?:can't|won't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|doesn't|didn't|shouldn't|wouldn't|couldn't|ain't)\b/i;

  // ═══ Baselines ═════════════════════════════════════════════════════

  /**
   * Approximate general-English rates, per million words, for the commonest
   * words. Coarse and hand-set — good enough to stop "the" being reported as
   * a signature word, not good enough to be quoted as corpus linguistics.
   * Anything absent uses BASELINE_FLOOR, so a repeated uncommon word can
   * still register as distinctive.
   */
  const BASELINE = {
    the: 56000, of: 33000, and: 29000, to: 26000, a: 21000, in: 18000, is: 10000,
    it: 10000, you: 9500, that: 9000, he: 8000, was: 7000, for: 7000, on: 6500,
    are: 6000, with: 5800, as: 5500, i: 5500, his: 5000, they: 4800, be: 4600,
    at: 4500, one: 4000, have: 3900, this: 3800, from: 3700, or: 3600, had: 3400,
    by: 3300, not: 3200, but: 3100, what: 3000, all: 2900, were: 2800, we: 2700,
    when: 2600, your: 2500, can: 2400, said: 2300, there: 2200, use: 2100,
    an: 2000, each: 1900, which: 1900, she: 1800, do: 1800, how: 1700,
    their: 1700, if: 1700, will: 1600, up: 1600, other: 1500, about: 1500,
    out: 1400, many: 1300, then: 1300, them: 1300, these: 1200, so: 1200,
    some: 1200, her: 1100, would: 1100, make: 1000, like: 1000, him: 1000,
    into: 950, time: 950, has: 900, look: 850, two: 850, more: 850, write: 800,
    go: 800, see: 800, number: 750, no: 750, way: 750, could: 700, people: 700,
    my: 700, than: 650, first: 650, been: 650, call: 600, who: 600, its: 600,
    now: 600, find: 550, long: 550, down: 550, day: 550, did: 500, get: 500,
    come: 500, made: 500, may: 500, part: 450, over: 450, new: 450, sound: 400,
    take: 400, only: 400, little: 400, work: 400, know: 400, place: 350,
    years: 350, live: 350, me: 350, back: 350, give: 300, most: 300, very: 300,
    after: 300, thing: 300, our: 300, just: 300, name: 250, good: 250,
    sentence: 250, man: 250, think: 250, say: 250, great: 200, where: 200,
    help: 200, through: 200, much: 200, before: 200, line: 200, right: 200,
    too: 200, mean: 150, old: 150, any: 150, same: 150, tell: 150, boy: 150,
    follow: 150, came: 150, want: 150, show: 150, also: 150, around: 100,
    form: 100, three: 100, small: 100, set: 100, put: 100, end: 100, does: 100,
    another: 100, well: 100, large: 100, must: 100, big: 100, even: 100,
    such: 100, because: 100, turn: 100, here: 100, why: 100, ask: 100,
    went: 100, men: 100, read: 100, need: 100, land: 100, different: 100,
    home: 100, us: 100, move: 100, try: 100, kind: 100, hand: 100, picture: 100,
    again: 100, change: 100, off: 100, play: 100, spell: 100, air: 100,
    away: 100, animal: 100, house: 100, point: 100, page: 100, letter: 100,
    mother: 100, answer: 100, found: 100, study: 100, still: 100, learn: 100,
    should: 100, america: 100, world: 100,
  };

  /** Rate assumed for any word not in the table above. */
  const BASELINE_FLOOR = 20;

  /**
   * Words whose ABSENCE is worth reporting. Absence of an obscure word means
   * nothing; absence of "furthermore" across three thousand words is a real
   * fact about a writer. Everything here is common enough that a writer who
   * uses it at all would have used it by then.
   */
  const ABSENCE_CANDIDATES = [
    'furthermore', 'moreover', 'additionally', 'consequently', 'subsequently',
    'nevertheless', 'nonetheless', 'notwithstanding', 'albeit', 'whilst',
    'amongst', 'hence', 'thereby', 'therein', 'whereby', 'heretofore',
    'utilize', 'leverage', 'delve', 'robust', 'myriad', 'plethora', 'paradigm',
    'holistic', 'synergy', 'seamless', 'pivotal', 'crucial', 'vital',
    'essentially', 'fundamentally', 'ultimately', 'arguably', 'undoubtedly',
    'indeed', 'certainly', 'obviously', 'clearly', 'notably', 'importantly',
    'significantly', 'substantially', 'considerably', 'remarkably',
    'furthermore', 'thus', 'therefore', 'accordingly', 'likewise',
    'comprehensive', 'innovative', 'cutting-edge', 'state-of-the-art',
    'landscape', 'ecosystem', 'framework', 'methodology', 'stakeholder',
    'actionable', 'impactful', 'transformative', 'unprecedented',
  ];

  const STOPWORDS = new Set(Object.keys(BASELINE).concat([
    'am', 'been', 'being', 'both', 'during', 'few', 'further', 'having',
    'itself', 'myself', 'nor', 'once', 'own', 'same', 'themselves', 'those',
    'under', 'until', 'while', 'yourself', 'ours', 'yours', 'theirs',
  ]));

  // ═══ Per-sample measurement ════════════════════════════════════════

  /** Everything measurable from one sample, before pooling. */
  function measureSample(sample) {
    const text = cleanForProse(sample.text);
    const sents = sentences(text);
    const paras = paragraphs(text);
    const ws = words(text);
    const sentLengths = sents.map((s) => words(s).length);
    const paraLengths = paras.map((p) => sentences(p).length);
    const per100 = (n) => (ws.length ? (n / ws.length) * 100 : 0);

    const commas = (text.match(/,/g) || []).length;
    const semicolons = (text.match(/;/g) || []).length;
    const dashes = (text.match(/—|–|\s-\s/g) || []).length;
    const parens = (text.match(/\([^)]*\)/g) || []).length;

    const withContraction = sents.filter((s) => CONTRACTION_RE.test(s)).length;

    const totalSyllables = ws.reduce((n, w) => n + syllables(w), 0);
    const grade =
      sents.length && ws.length
        ? 0.39 * (ws.length / sents.length) + 11.8 * (totalSyllables / ws.length) - 15.59
        : 0;

    return {
      id: sample.id,
      label: sample.label,
      type: sample.type,
      words: ws.length,
      sentences: sents,
      sentLengths,
      paraLengths,
      values: {
        sentenceLength: sentLengths.length ? mean(sentLengths) : null,
        paragraphLength: paraLengths.length ? mean(paraLengths) : null,
        commaRate: per100(commas),
        semicolonRate: per100(semicolons),
        dashRate: per100(dashes),
        parentheticalRate: per100(parens),
        contractionRate: sents.length ? (withContraction / sents.length) * 100 : null,
        readingLevel: Math.max(0, grade),
      },
      openers: sents.map((s) => (words(s)[0] || '').toLowerCase()).filter(Boolean),
      paraOpeners: paras.map((p) => (words(p)[0] || '').toLowerCase()).filter(Boolean),
      wordList: ws.map((w) => w.toLowerCase()),
    };
  }

  // ═══ Metric definitions ════════════════════════════════════════════

  /**
   * Each metric declares what it needs before it may speak. The word floors
   * differ by an order of magnitude on purpose: a mean settles quickly, an
   * absence claim does not.
   */
  const METRICS = [
    { id: 'sentenceLength', label: 'Sentence length', unit: 'words', writtenOnly: true, needWords: 400, kind: 'band' },
    { id: 'paragraphLength', label: 'Paragraph length', unit: 'sentences', writtenOnly: true, needWords: 800, kind: 'band' },
    { id: 'commaRate', label: 'Commas', unit: 'per 100 words', writtenOnly: true, needWords: 500, kind: 'band' },
    { id: 'semicolonRate', label: 'Semicolons', unit: 'per 100 words', writtenOnly: true, needWords: 1000, kind: 'band' },
    { id: 'dashRate', label: 'Dashes', unit: 'per 100 words', writtenOnly: true, needWords: 1000, kind: 'band' },
    { id: 'parentheticalRate', label: 'Parentheticals', unit: 'per 100 words', writtenOnly: true, needWords: 1000, kind: 'band' },
    { id: 'contractionRate', label: 'Contractions', unit: '% of sentences', writtenOnly: true, needWords: 500, kind: 'band' },
    { id: 'readingLevel', label: 'Reading level', unit: 'grade', writtenOnly: true, needWords: 400, kind: 'band' },
    { id: 'sentenceOpeners', label: 'Sentence openers', unit: '% of sentences', writtenOnly: true, needWords: 600, kind: 'openers' },
    { id: 'paragraphOpeners', label: 'Paragraph openers', unit: '% of paragraphs', writtenOnly: true, needWords: 1500, kind: 'openers' },
    { id: 'signatureWords', label: 'Words you lean on', unit: 'per 100k words', writtenOnly: false, needWords: 1500, kind: 'vocab' },
    { id: 'absentWords', label: 'Words you never use', unit: 'absent', writtenOnly: false, needWords: 3000, kind: 'vocab' },
  ];

  const METRIC_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m]));

  // ═══ Building ══════════════════════════════════════════════════════

  function unavailable(def, have) {
    return {
      id: def.id,
      label: def.label,
      unit: def.unit,
      writtenOnly: !!def.writtenOnly,
      available: false,
      requirement: { words: def.needWords, basis: def.writtenOnly ? 'written' : 'all' },
      have,
      reason:
        `Needs ${def.needWords} ${def.writtenOnly ? 'written ' : ''}words; the corpus has ${have}.` +
        (def.writtenOnly && def.id !== 'signatureWords'
          ? ' Transcripts do not count toward this one.'
          : ''),
      evidence: [],
    };
  }

  /** A numeric metric: pooled mean, spread, and the band across samples. */
  function bandMetric(def, measured, have) {
    const eligible = measured.filter((m) => !def.writtenOnly || m.type === 'written');
    const perSample = eligible
      .map((m) => ({ sample: m, value: m.values[def.id] }))
      .filter((x) => x.value !== null && Number.isFinite(x.value));

    if (perSample.length < 2) {
      return {
        ...unavailable(def, have),
        reason: `Needs at least 2 ${def.writtenOnly ? 'written ' : ''}samples to show a range; the corpus has ${perSample.length}.`,
      };
    }

    const values = perSample.map((x) => x.value);
    const low = Math.min(...values);
    const high = Math.max(...values);

    return {
      id: def.id,
      label: def.label,
      unit: def.unit,
      writtenOnly: !!def.writtenOnly,
      available: true,
      requirement: { words: def.needWords, basis: def.writtenOnly ? 'written' : 'all' },
      have,
      mean: round1(mean(values)),
      sd: round1(sd(values)),
      // The band is the range the corpus actually shows across samples, not
      // a confidence interval around the mean. Stage 3 flags outside it.
      band: { low: round1(low), high: round1(high) },
      samples: perSample.length,
      perSample: perSample.map((x) => ({
        id: x.sample.id,
        label: x.sample.label,
        value: round1(x.value),
      })),
      evidence: evidenceFor(def, perSample),
    };
  }

  /**
   * Real excerpts behind the number. For sentence length that means actual
   * sentences at the short end, the middle and the long end, so the writer
   * can see the band is theirs.
   */
  function evidenceFor(def, perSample) {
    if (def.id === 'sentenceLength') {
      const all = perSample.flatMap((x) =>
        x.sample.sentences.map((s) => ({
          text: s,
          value: words(s).length,
          sample: x.sample.label,
        }))
      );
      if (!all.length) return [];
      all.sort((a, b) => a.value - b.value);
      const pick = [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]];
      return pick.filter(Boolean).map((p) => ({
        sample: p.sample,
        value: p.value,
        text: p.text.length > 220 ? p.text.slice(0, 219) + '…' : p.text,
      }));
    }

    if (def.id === 'contractionRate') {
      const withOne = perSample
        .flatMap((x) => x.sample.sentences.map((s) => ({ text: s, sample: x.sample.label })))
        .filter((s) => CONTRACTION_RE.test(s.text))
        .slice(0, 3);
      return withOne.map((s) => ({
        sample: s.sample,
        value: null,
        text: s.text.length > 200 ? s.text.slice(0, 199) + '…' : s.text,
      }));
    }

    // Everything else: the per-sample values are the evidence, lowest and
    // highest, so the band's endpoints are attributable.
    const sorted = [...perSample].sort((a, b) => a.value - b.value);
    return [sorted[0], sorted[sorted.length - 1]].filter(Boolean).map((x) => ({
      sample: x.sample.label,
      value: round1(x.value),
      text: `${x.sample.label}: ${round1(x.value)} ${def.unit}`,
    }));
  }

  function openerMetric(def, measured, have) {
    const eligible = measured.filter((m) => !def.writtenOnly || m.type === 'written');
    const list = eligible.flatMap((m) =>
      def.id === 'sentenceOpeners' ? m.openers : m.paraOpeners
    );
    if (!list.length) return unavailable(def, have);

    const counts = new Map();
    for (const w of list) counts.set(w, (counts.get(w) || 0) + 1);
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word, n]) => ({ word, count: n, rate: round1((n / list.length) * 100) }));

    return {
      id: def.id,
      label: def.label,
      unit: def.unit,
      writtenOnly: !!def.writtenOnly,
      available: true,
      requirement: { words: def.needWords, basis: def.writtenOnly ? 'written' : 'all' },
      have,
      total: list.length,
      distinct: counts.size,
      top,
      evidence: top.slice(0, 5).map((t) => ({
        sample: null,
        value: t.rate,
        text: `"${t.word}" opens ${t.count} of ${list.length} (${t.rate}%)`,
      })),
    };
  }

  function vocabMetric(def, measured, have, corpusWords) {
    const all = measured.flatMap((m) => m.wordList);
    if (!all.length) return unavailable(def, have);
    const counts = new Map();
    for (const w of all) counts.set(w, (counts.get(w) || 0) + 1);

    if (def.id === 'absentWords') {
      const absent = [...new Set(ABSENCE_CANDIDATES)]
        .filter((w) => !counts.has(w.toLowerCase()))
        .sort();
      return {
        id: def.id,
        label: def.label,
        unit: def.unit,
        writtenOnly: false,
        available: true,
        requirement: { words: def.needWords, basis: 'all' },
        have,
        // Absence is only a claim about the corpus that was actually read.
        observedOver: corpusWords,
        candidates: ABSENCE_CANDIDATES.length,
        absent,
        evidence: absent.slice(0, 6).map((w) => ({
          sample: null,
          value: 0,
          text: `"${w}" appears 0 times in ${corpusWords} words`,
        })),
      };
    }

    // Signature words: rate far above the baseline, and spread across
    // samples so one topic-heavy piece cannot dominate.
    const perSampleSets = measured.map((m) => new Set(m.wordList));
    const scored = [];
    for (const [word, n] of counts) {
      if (STOPWORDS.has(word) || word.length < 4) continue;
      const spread = perSampleSets.filter((set) => set.has(word)).length;
      if (spread < 2 || n < 3) continue;
      const ratePerMillion = (n / all.length) * 1e6;
      const base = BASELINE[word] ?? BASELINE_FLOOR;
      const ratio = ratePerMillion / base;
      if (ratio < 3) continue;
      scored.push({
        word,
        count: n,
        spread,
        per100k: round1((n / all.length) * 1e5),
        ratio: round1(ratio),
      });
    }
    scored.sort((a, b) => b.ratio - a.ratio || b.count - a.count);
    const top = scored.slice(0, 15);

    return {
      id: def.id,
      label: def.label,
      unit: def.unit,
      writtenOnly: false,
      available: true,
      requirement: { words: def.needWords, basis: 'all' },
      have,
      words: top,
      evidence: top.slice(0, 6).map((t) => ({
        sample: null,
        value: t.per100k,
        text: `"${t.word}" ${t.count}x across ${t.spread} samples (${t.ratio}x baseline)`,
      })),
    };
  }

  /**
   * Build a fingerprint from corpus samples.
   *
   * @param {Array} samples normalized, screened corpus samples
   * @returns {object} the profile, with every metric marked available or not
   */
  function build(samples) {
    const list = Array.isArray(samples) ? samples : [];
    const measured = list.map(measureSample);
    const writtenWords = measured
      .filter((m) => m.type === 'written')
      .reduce((n, m) => n + m.words, 0);
    const totalWords = measured.reduce((n, m) => n + m.words, 0);

    const metrics = {};
    for (const def of METRICS) {
      const have = def.writtenOnly ? writtenWords : totalWords;
      if (have < def.needWords) {
        metrics[def.id] = unavailable(def, have);
        continue;
      }
      if (def.kind === 'band') metrics[def.id] = bandMetric(def, measured, have);
      else if (def.kind === 'openers') metrics[def.id] = openerMetric(def, measured, have);
      else metrics[def.id] = vocabMetric(def, measured, have, totalWords);
    }

    const availableCount = Object.values(metrics).filter((m) => m.available).length;

    return {
      format: FORMAT,
      version: VERSION,
      builtFrom: {
        samples: list.length,
        writtenSamples: measured.filter((m) => m.type === 'written').length,
        spokenSamples: measured.filter((m) => m.type === 'spoken').length,
        totalWords,
        writtenWords,
        spokenWords: totalWords - writtenWords,
        sampleLabels: list.map((s) => s.label),
      },
      metrics,
      // No single confidence number by design: each metric carries its own.
      // This is a count, so a reader can see how much of the profile is real.
      availableMetrics: availableCount,
      totalMetrics: METRICS.length,
    };
  }

  // ═══ Import / export ═══════════════════════════════════════════════

  function toJSON(profile, { pretty = true } = {}) {
    return JSON.stringify(profile, null, pretty ? 2 : 0);
  }

  function fromJSON(json) {
    let doc;
    try {
      doc = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (err) {
      throw new Error(`That is not valid JSON: ${err.message}`);
    }
    if (!doc || typeof doc !== 'object') throw new Error('Expected a fingerprint object.');
    if (doc.format !== FORMAT) throw new Error(`Unrecognized format "${doc.format}".`);
    if (!doc.metrics || typeof doc.metrics !== 'object') throw new Error('Fingerprint has no metrics.');
    return doc;
  }

  return {
    FORMAT,
    VERSION,
    METRICS,
    METRIC_BY_ID,
    BASELINE,
    BASELINE_FLOOR,
    ABSENCE_CANDIDATES,
    CONTRACTION_RE,
    build,
    measureSample,
    sentences,
    paragraphs,
    cleanForProse,
    words,
    syllables,
    mean,
    sd,
    percentile,
    toJSON,
    fromJSON,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Fingerprint;
}
