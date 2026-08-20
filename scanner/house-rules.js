/**
 * House rules — the writer's own standing bans, checked alongside the AI
 * detectors and reported in their own category.
 *
 * ── Why these are separate from the AI score ────────────────────────
 *
 * A house rule says nothing about machine authorship. "platinum" is a claim
 * this author does not make; "6,000" is a number they never use; "two years
 * coding" is a recurring factual error. None of that is evidence a model
 * wrote the text, so house findings are counted and displayed on their own
 * and are deliberately kept OUT of the density channel in scoring.js. Folding
 * them in would let a personal style preference move a document from "reads
 * as human" to "reads as machine-written", which is a different claim than
 * the score is allowed to make.
 *
 * Some rules overlap the detector's own vocabulary (delve, robust,
 * landscape). That is intentional: the house rule states the writer's reason
 * and their preferred replacement, which the generic table cannot. The UI
 * marks the span once, house rule first.
 *
 * ── Match modes ─────────────────────────────────────────────────────
 *
 *   word     (default) whole-word, case-insensitive. "robust" does not fire
 *            inside "robustness".
 *   literal  exact substring, no word boundaries. For punctuation and
 *            anything that is not made of word characters — an em dash has
 *            no \b to anchor to.
 *   regex    full expression, for rules that need morphology or context.
 *
 * ── Replacement directives ──────────────────────────────────────────
 *
 * A replacement of "(rewrite)" or "(remove)" is an instruction to the writer,
 * not literal text to substitute. The fixer refuses to auto-apply them; a
 * real replacement string it will apply.
 *
 * Zero dependencies. Node and browser; self-registers as global `HouseRules`.
 */

const HouseRules = (() => {
  /** Replacements that are instructions rather than substitutions. */
  const DIRECTIVES = ['(rewrite)', '(remove)', '(cut)'];

  /** Import limits. A pasted rule set is untrusted input. */
  const MAX_RULES = 500;
  const MAX_PATTERN = 200;
  const MAX_MATCHES_PER_RULE = 200;

  /**
   * The seeded set. These are one writer's real standing rules, kept here as
   * the shipped default; the page, the CLI and the skill all start from this
   * list and any of them can replace it wholesale.
   */
  const DEFAULT_RULES = [
    {
      id: 'em-dash',
      label: 'em dash',
      pattern: '—',
      match: 'literal',
      replacement: ',',
      note: 'Not how I punctuate',
    },
    {
      id: 'intersection',
      pattern: 'intersection',
      replacement: '(rewrite)',
      note: 'Overused, means nothing',
    },
    {
      id: 'crossroads',
      pattern: 'crossroads',
      replacement: '(rewrite)',
      note: 'Overused, means nothing',
    },
    {
      id: 'platinum',
      pattern: 'platinum',
      replacement: '(remove)',
      note: 'Not a claim I make',
    },
    {
      id: 'leverage-verb',
      label: 'leverage (as verb)',
      // Verb use only. An article, possessive or qualifier in front almost
      // always marks the noun ("the leverage", "financial leverage"), which
      // is a legitimate word this rule should leave alone.
      pattern:
        '(?<!\\b(?:the|a|an|his|her|their|its|our|my|your|financial|operating|market|more|less|no|any|some|enough|negative|positive)\\s)\\bleverag(?:e|es|ed|ing)\\b',
      match: 'regex',
      replacement: 'use',
      note: 'Corporate',
    },
    {
      id: 'delve',
      label: 'delve',
      pattern: '\\bdelv(?:e|es|ed|ing)\\b',
      match: 'regex',
      replacement: '(rewrite)',
      note: 'AI tell',
    },
    {
      id: 'robust',
      pattern: 'robust',
      replacement: 'strong, solid',
      note: 'AI tell',
    },
    {
      id: 'landscape',
      pattern: 'landscape',
      replacement: '(rewrite)',
      note: 'AI tell',
    },
    {
      id: 'six-thousand',
      label: '6,000',
      // Written either way, and as "6k".
      pattern: '\\b6[,.]?000\\b|\\b6k\\b',
      match: 'regex',
      replacement: 'thousands',
      note: 'Never use the number',
    },
    {
      id: 'two-years-coding',
      label: 'two years coding',
      pattern:
        '\\btwo years\\b(?:\\s+(?:of|doing))?\\s+(?:coding|programming|software|engineering|development|dev)\\b',
      match: 'regex',
      replacement: 'three years',
      note: 'Recurring factual error',
    },
  ];

  // ═══ Validation ════════════════════════════════════════════════════

  const isDirective = (replacement) =>
    !!replacement && DIRECTIVES.includes(String(replacement).trim().toLowerCase());

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Slug for a rule with no explicit id, so findings stay addressable. */
  function slug(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'rule';
  }

  /**
   * Normalize one entry, or throw with a message worth showing a user.
   * Everything except `pattern` is optional.
   */
  function normalizeRule(raw, index = 0) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Rule ${index + 1} is not an object.`);
    }
    const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim() : '';
    if (!pattern) throw new Error(`Rule ${index + 1} has no pattern.`);
    if (pattern.length > MAX_PATTERN) {
      throw new Error(`Rule ${index + 1} pattern is longer than ${MAX_PATTERN} characters.`);
    }

    const match = ['word', 'literal', 'regex'].includes(raw.match) ? raw.match : 'word';
    const rule = {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : slug(raw.label || pattern),
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : pattern,
      pattern,
      match,
      replacement: typeof raw.replacement === 'string' ? raw.replacement.trim() : '',
      note: typeof raw.note === 'string' ? raw.note.trim() : '',
      severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'high',
      caseSensitive: raw.caseSensitive === true,
      enabled: raw.enabled !== false,
    };

    // Compile now so a bad expression is reported at edit time, not mid-scan.
    try {
      compile(rule);
    } catch (err) {
      throw new Error(`Rule ${index + 1} ("${rule.label}") is not a valid pattern: ${err.message}`);
    }
    return rule;
  }

  /** @returns {Array} normalized rules; throws on the first invalid entry. */
  function normalize(rules) {
    if (!Array.isArray(rules)) throw new Error('Rules must be a list.');
    if (rules.length > MAX_RULES) throw new Error(`Too many rules (limit ${MAX_RULES}).`);
    const out = rules.map(normalizeRule);

    const seen = new Set();
    for (const rule of out) {
      let id = rule.id;
      let n = 2;
      while (seen.has(id)) id = `${rule.id}-${n++}`;
      rule.id = id;
      seen.add(id);
    }
    return out;
  }

  function compile(rule) {
    const flags = rule.caseSensitive ? 'g' : 'gi';
    if (rule.match === 'regex') return new RegExp(rule.pattern, flags);
    if (rule.match === 'literal') return new RegExp(escapeRe(rule.pattern), flags);

    // Word mode. \b only anchors against word characters, so a pattern that
    // starts or ends with punctuation gets no boundary on that side —
    // otherwise "—" in word mode could never match anything.
    const body = escapeRe(rule.pattern).replace(/\\?\s+/g, '\\s+');
    const lead = /^[A-Za-z0-9_]/.test(rule.pattern) ? '\\b' : '';
    const tail = /[A-Za-z0-9_]$/.test(rule.pattern) ? '\\b' : '';
    return new RegExp(lead + body + tail, flags);
  }

  // ═══ Checking ══════════════════════════════════════════════════════

  /**
   * @param {string} text
   * @param {Array} [rules] normalized or raw; defaults to DEFAULT_RULES
   * @returns {Array} findings, shaped like the other engines' issues
   */
  function check(text, rules = DEFAULT_RULES) {
    const src = String(text || '');
    if (!src) return [];
    const list = normalize(rules).filter((r) => r.enabled);
    const findings = [];

    for (const rule of list) {
      const re = compile(rule);
      let m;
      let guard = 0;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        if (guard++ >= MAX_MATCHES_PER_RULE) break;
        // A zero-length match would spin forever.
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        findings.push({
          type: 'house-rule',
          group: 'house',
          ruleId: rule.id,
          text: m[0],
          label: rule.label,
          severity: rule.severity,
          suggestion: rule.replacement || '',
          note: rule.note,
          directive: isDirective(rule.replacement),
          start: m.index,
          end: m.index + m[0].length,
          line: src.slice(0, m.index).split('\n').length,
        });
      }
    }

    // Deduplicate by (rule, matched text) the way the other engines do, so a
    // word banned once is one row in the findings list however often it
    // appears. Every occurrence is kept on `spans`: the list wants one
    // entry, but the fixer has to repair all of them, and collapsing them
    // meant only the first em dash in a paragraph was ever replaced.
    const byKey = new Map();
    for (const f of findings.sort((a, b) => a.start - b.start)) {
      const key = `${f.ruleId}::${f.text.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.spans.push({ start: f.start, end: f.end });
        existing.count += 1;
        continue;
      }
      byKey.set(key, { ...f, spans: [{ start: f.start, end: f.end }], count: 1 });
    }
    return [...byKey.values()];
  }

  // ═══ Import / export ═══════════════════════════════════════════════

  const FORMAT = 'proof-desk/house-rules';
  const VERSION = 1;

  /** Portable JSON. Stable key order so exports diff cleanly. */
  function toJSON(rules = DEFAULT_RULES, { pretty = true } = {}) {
    const doc = {
      format: FORMAT,
      version: VERSION,
      rules: normalize(rules).map((r) => {
        const out = { pattern: r.pattern };
        if (r.label !== r.pattern) out.label = r.label;
        if (r.match !== 'word') out.match = r.match;
        if (r.replacement) out.replacement = r.replacement;
        if (r.note) out.note = r.note;
        if (r.severity !== 'high') out.severity = r.severity;
        if (r.caseSensitive) out.caseSensitive = true;
        if (!r.enabled) out.enabled = false;
        return out;
      }),
    };
    return JSON.stringify(doc, null, pretty ? 2 : 0);
  }

  /**
   * Parse an exported document, or a bare array of rules. Throws with a
   * message intended for a person, since this is fed by paste and by file.
   */
  function fromJSON(json) {
    let doc;
    try {
      doc = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (err) {
      throw new Error(`That is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(doc)) return normalize(doc);
    if (!doc || typeof doc !== 'object') throw new Error('Expected a rule set object or a list.');
    if (doc.format && doc.format !== FORMAT) {
      throw new Error(`Unrecognized format "${doc.format}".`);
    }
    if (!Array.isArray(doc.rules)) throw new Error('Rule set has no "rules" list.');
    return normalize(doc.rules);
  }

  return {
    DEFAULT_RULES,
    DIRECTIVES,
    FORMAT,
    VERSION,
    MAX_RULES,
    MAX_PATTERN,
    check,
    normalize,
    normalizeRule,
    compile,
    toJSON,
    fromJSON,
    isDirective,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HouseRules;
}
