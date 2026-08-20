/**
 * Scan orchestration shared by the CLI (scan.js) and the web app (app.html).
 *
 * Combines the vendored avoid-ai-writing prose detector with the resume rule
 * layer, and decides which of the two is in charge for a given document.
 *
 * Runs in Node (resolves its dependencies via require) and in the browser
 * (picks them up as globals, which is how the built single-file app loads
 * them). Self-registers as a global `ScanEngine`.
 */

const ScanEngine = (() => {
  function deps() {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      const path = require('path');
      return {
        AIDetector: require(path.join(
          __dirname,
          '..',
          '.claude',
          'skills',
          'avoid-ai-writing',
          'detector',
          'patterns.js'
        )),
        ResumeRules: require(path.join(__dirname, 'resume-rules.js')),
        Scoring: require(path.join(__dirname, 'scoring.js')),
        HouseRules: require(path.join(__dirname, 'house-rules.js')),
        Voice: require(path.join(__dirname, 'voice.js')),
      };
    }
    return {
      AIDetector: typeof AIDetector !== 'undefined' ? AIDetector : globalThis.AIDetector,
      ResumeRules: typeof ResumeRules !== 'undefined' ? ResumeRules : globalThis.ResumeRules,
      Scoring: typeof Scoring !== 'undefined' ? Scoring : globalThis.Scoring,
      HouseRules: typeof HouseRules !== 'undefined' ? HouseRules : globalThis.HouseRules,
      Voice: typeof Voice !== 'undefined' ? Voice : globalThis.Voice,
    };
  }

  /**
   * Resumes are structurally distinctive: a contact line, standard section
   * headings, dated roles, and a high ratio of fragment bullets. Two of the
   * four signals is enough — plenty of good resumes drop one.
   */
  function detectMode(text) {
    const { ResumeRules } = deps();
    const parsed = ResumeRules.parseResume(text);
    const signals = [
      parsed.contact.email || parsed.contact.phone,
      Object.keys(parsed.sections).length >= 2,
      parsed.bullets.length >= 4 && parsed.usedGlyphs,
      parsed.dateLines >= 2,
    ].filter(Boolean).length;
    return signals >= 2 ? 'resume' : 'essay';
  }

  /**
   * @param {string} text
   * @param {{mode?: 'auto'|'essay'|'resume', context?: 'general'|'technical'}} [options]
   */
  function scan(text, options = {}) {
    const { AIDetector, ResumeRules, Scoring, HouseRules, Voice } = deps();
    const mode = options.mode && options.mode !== 'auto' ? options.mode : detectMode(text);

    // Resumes are fragment-heavy by design. Technical context suppresses the
    // Title Case header and copula flags that would otherwise fire on every
    // correctly formatted one.
    const proseContext = mode === 'resume' ? 'technical' : options.context || 'general';
    const prose = AIDetector.analyzeText(text, { contextMode: proseContext });

    const resume = mode === 'resume' ? ResumeRules.analyzeResume(text) : null;
    const resumeIssues = resume ? resume.issues : [];

    // Every finding that is evidence of machine authorship feeds the curve.
    // Craft findings (a bullet with no number) say nothing about who wrote it,
    // so they are excluded here and reported on their own axis.
    const aiIssues = [
      ...(prose.issues || []),
      ...resumeIssues.filter((i) => i.group === 'ai'),
    ];

    // House rules are the writer's own standing bans. They are checked here
    // but deliberately excluded from the calibration below: a personal style
    // preference is not evidence of machine authorship, and letting one move
    // the AI score would make the number mean two different things.
    let houseIssues = [];
    let houseError = null;
    if (options.houseRules !== false) {
      // An explicitly supplied list is used as given, including an empty one.
      // Treating [] as "no preference" meant a writer who deleted every rule
      // silently got the shipped defaults back.
      const supplied = Array.isArray(options.houseRules)
        ? options.houseRules
        : HouseRules.DEFAULT_RULES;
      try {
        houseIssues = HouseRules.check(text, supplied);
      } catch (err) {
        houseError = err.message;
      }
    }

    // Voice comparison. Like house rules, it is computed here and kept out
    // of the calibration below: a style deviation is not evidence of machine
    // authorship. The traffic is blocked in both directions — the AI score
    // is not an input to `compare` either, so neither number can move the
    // other.
    let voice = null;
    if (options.profile) {
      try {
        voice = Voice.compare(text, options.profile);
      } catch (err) {
        voice = { available: false, score: null, band: null, reason: err.message, findings: [], unavailable: [] };
      }
    }

    const calibrated = Scoring.calibrate({
      baseScore: prose.score,
      issues: aiIssues,
      wordCount: prose.stats.wordCount,
    });

    return {
      mode,
      aiScore: calibrated.score,
      band: calibrated.band,
      label: calibrated.band.label,
      classification: prose.document_classification,
      probabilities: prose.class_probabilities,
      confidence: prose.confidence_category,
      proseScore: prose.score,
      calibration: calibrated,
      craftScore: resume ? resume.craftScore : null,
      proseIssues: prose.issues || [],
      resumeIssues,
      houseIssues,
      houseError,
      voice,
      voiceIssues: voice && voice.available ? voice.findings : [],
      regions: prose.highlight_sentence_for_ai || [],
      sections: resume ? resume.sections : null,
      stats: resume ? { ...prose.stats, ...resume.stats } : prose.stats,
    };
  }

  /** Flat, display-ordered issue list with stable ids for the UI to key on. */
  function allIssues(result) {
    const { AIDetector, ResumeRules } = deps();
    const rank = { critical: 4, high: 3, medium: 2, low: 1 };
    const tagged = [
      ...(result.voiceIssues || []).map((i) => ({
        ...i,
        source: 'voice',
        label: i.label || 'Voice',
      })),
      ...(result.houseIssues || []).map((i) => ({
        ...i,
        source: 'house',
        label: i.label || 'House rule',
      })),
      ...result.resumeIssues.map((i) => ({
        ...i,
        source: 'resume',
        label: ResumeRules.TYPE_LABELS[i.type] || i.type,
      })),
      ...result.proseIssues.map((i) => ({
        ...i,
        source: 'prose',
        group: 'ai',
        label: (AIDetector.TYPE_LABELS || {})[i.type] || i.type,
      })),
    ];
    // House findings sort ahead of everything at equal severity — they are
    // the writer's explicit instruction, and they carry the better wording.
    const sourceRank = { house: 2, voice: 1, resume: 0, prose: 0 };
    return tagged
      .sort(
        (a, b) =>
          (sourceRank[b.source] || 0) - (sourceRank[a.source] || 0) ||
          (rank[b.severity] || 0) - (rank[a.severity] || 0)
      )
      .map((issue, index) => ({ ...issue, id: `f${index}` }));
  }

  return { scan, detectMode, allIssues };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScanEngine;
}
