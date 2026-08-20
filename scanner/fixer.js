/**
 * Deterministic fixer.
 *
 * The detector already knows the answer for a large share of what it flags:
 * a tier-1 word carries its plainer replacement, and filler like "It is
 * important to note that" simply comes out. This module turns those findings
 * into edits so a draft can be cleaned without a model in the loop.
 *
 * It is deliberately conservative. Three kinds of finding get applied:
 *
 *   swap    the suggestion is a replacement list ("strong, reliable, solid")
 *           — take the first, match the original's inflection and case
 *   delete  a complete leading connective or filler clause ("Moreover,",
 *           "It is important to note that") — remove it and repair the seam
 *   none    everything else
 *
 * Anything needing judgment — a vague attribution that needs a real source,
 * a suggestion phrased as instruction ("describe what changed"), uniform
 * rhythm, a missing metric — is never auto-applied. It is returned as
 * `manual` so the caller can show it as still-your-problem. Silently
 * "fixing" those would produce confident nonsense, which is worse than a
 * flag.
 *
 * Zero dependencies. Node and browser; self-registers as global `Fixer`.
 */

const Fixer = (() => {
  // A suggestion opening with one of these is advice, not a replacement.
  const INSTRUCTION_VERBS = new Set([
    'describe', 'name', 'say', 'give', 'show', 'explain', 'state', 'list',
    'pick', 'drop', 'replace', 'attach', 'put', 'add', 'aim', 'keep', 'split',
    'start', 'group', 'aim', 'aimfor', 'human', 'every', 'rule', 'over',
  ]);

  // Types whose flagged span is safe to delete outright when it forms a
  // complete leading connective or filler clause.
  const DELETABLE_TYPES = new Set(['transition', 'filler', 'chatbot', 'acknowledgment-loop']);

  // Types that are never auto-applied — they need a fact or a rewrite.
  const NEVER_AUTO = new Set([
    'vague-attribution', 'uniformity', 'low-ttr', 'punct-distribution',
    'fnword-trigram-entropy', 'cross-para-burstiness', 'resume-unquantified',
    'resume-uniform-bullets', 'resume-round-metrics', 'resume-triad',
    'resume-missing-contact', 'resume-missing-dates', 'resume-missing-section',
    'resume-tense-mix', 'resume-long-bullet', 'resume-skill-dump',
    'generic-conclusion', 'future-narrative', 'hedge-stack', 'emotional-flatline',
  ]);

  /**
   * Pull a usable replacement out of a suggestion string, or null when the
   * suggestion is advice rather than a substitute.
   */
  function parseReplacement(suggestion) {
    if (!suggestion) return null;
    const raw = String(suggestion).trim();
    if (!raw) return null;

    // "cut", "cut — show it in what you built" → delete the span.
    if (/^cut\b/i.test(raw)) return { kind: 'delete' };

    // Strip any trailing rationale after an em dash.
    const head = raw.split(/\s+—\s+/)[0].trim();
    if (!head) return null;

    // Options are separated by commas or slashes: "ran / coordinated".
    const first = head.split(/\s*[,/]\s*/)[0].trim();
    if (!first) return null;

    const opener = first.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    if (INSTRUCTION_VERBS.has(opener)) return null;
    // A suggestion that reads as a sentence is advice.
    if (/\b(what|which|the actual|instead|rather)\b/i.test(head)) return null;
    if (first.length > 40) return null;

    return { kind: 'swap', text: first };
  }

  /**
   * Match the original's inflection so a swap doesn't break the sentence.
   *
   * Only the -ing participle is handled. A word ending in -ed is not
   * necessarily a verb the replacement can be conjugated like: "poised" is
   * flagged, its replacement is the adjective "ready", and appending -ed
   * yields "readyed". The suggestion tables are already written in the form
   * that fits the flagged context, so leaving them alone is the safer default.
   */
  function inflect(original, replacement) {
    const bare = replacement;
    if (bare.includes(' ')) return bare; // multi-word replacements go in as-is
    if (/ing$/.test(original.toLowerCase()) && !/ing$/.test(bare)) {
      return bare.replace(/e$/, '') + 'ing';
    }
    return bare;
  }

  /**
   * Carry the original's capitalization onto the replacement.
   *
   * Case is only meaningful where there are letters. "6,000" equals its own
   * uppercase, which used to be read as SHOUTING and produced "THOUSANDS".
   */
  function matchCase(original, replacement) {
    if (!original || !replacement) return replacement;
    const letters = original.replace(/[^A-Za-z]/g, '');
    if (!letters) return replacement;
    if (letters === letters.toUpperCase() && letters.length > 1) return replacement.toUpperCase();
    const first = original.search(/[A-Za-z]/);
    if (first >= 0 && original[first] === original[first].toUpperCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  /** A house-rule replacement that is an instruction rather than a substitution. */
  function isHouseDirective(replacement) {
    const t = String(replacement || '').trim().toLowerCase();
    return t === '' || ['(rewrite)', '(remove)', '(cut)'].includes(t);
  }

  /** True when an article immediately precedes the span, so the slot wants a noun. */
  function fillsNounSlot(text, start) {
    return /\b(a|an|the)\s+$/i.test(text.slice(Math.max(0, start - 6), start));
  }

  function isWordChar(ch) {
    return ch !== undefined && /[A-Za-z0-9]/.test(ch);
  }

  /** Every whole-word occurrence of `needle` in `text`. */
  function occurrences(text, needle) {
    const hay = text.toLowerCase();
    const hit = needle.toLowerCase();
    const out = [];
    let from = 0;
    for (;;) {
      const at = hay.indexOf(hit, from);
      if (at < 0) break;
      from = at + 1;
      if (isWordChar(text[at - 1]) || isWordChar(text[at + hit.length])) continue;
      out.push({ start: at, end: at + hit.length });
    }
    return out;
  }

  /**
   * A deletion is only safe when the flagged span is a self-contained
   * connective — it starts a sentence and ends at a comma, or it already
   * ends on a subordinator like "that". "In today's" fails both (the
   * sentence continues "rapidly evolving world"), so it stays manual.
   */
  function deletionSpan(text, start, end) {
    const before = text.slice(0, start);
    const atSentenceStart = /(^|[.!?:;]\s*|\n\s*)$/.test(before);
    if (!atSentenceStart) return null;

    let stop = end;
    // Swallow a trailing comma and the space after it.
    const rest = text.slice(end);
    const comma = /^\s*,\s*/.exec(rest);
    if (comma) stop = end + comma[0].length;
    else if (/\b(that|to note that)$/i.test(text.slice(start, end))) {
      const space = /^\s+/.exec(rest);
      stop = end + (space ? space[0].length : 0);
    } else {
      const space = /^\s+/.exec(rest);
      if (!space) return null;
      // A bare connective with no comma ("However the...") is ambiguous —
      // only delete when the flagged text is a known standalone opener.
      if (!/^(certainly|sure|absolutely|of course|great question)!?$/i.test(text.slice(start, end).trim()))
        return null;
      stop = end + space[0].length;
    }
    return { start, end: stop };
  }

  /**
   * @param {string} text
   * @param {Array} issues flat issue list (prose + resume)
   * @returns {{edits: Array, manual: Array}}
   */
  function plan(text, issues) {
    const edits = [];
    const manual = [];

    for (const issue of issues) {
      // House rules carry their own offsets and their own replacement, set
      // by the writer. A "(rewrite)" / "(remove)" replacement is an
      // instruction to a person, so it is reported and never applied.
      if (issue.type === 'house-rule') {
        const directive = issue.directive || isHouseDirective(issue.suggestion);
        const target = String(issue.suggestion || '').trim();
        if (directive || !target) {
          manual.push(issue);
          continue;
        }
        // "strong, solid" offers options; take the first. But a replacement
        // made only of punctuation IS the replacement — splitting "," on
        // commas yields nothing and silently dropped the em-dash rule.
        const pick = /[A-Za-z0-9]/.test(target)
          ? target.split(/\s*[,/]\s*/)[0].trim()
          : target;
        // A house finding is deduplicated for display but carries every
        // occurrence on `spans`; all of them get fixed.
        const spots = Array.isArray(issue.spans) && issue.spans.length
          ? issue.spans
          : Number.isInteger(issue.start) && Number.isInteger(issue.end)
            ? [{ start: issue.start, end: issue.end }]
            : occurrences(text, String(issue.text || ''));
        if (!spots.length || !pick) {
          manual.push(issue);
          continue;
        }
        for (const spot of spots) {
          const was = text.slice(spot.start, spot.end);
          edits.push({ ...spot, replacement: matchCase(was, pick), kind: 'house', issue, was });
        }
        continue;
      }

      if (NEVER_AUTO.has(issue.type)) {
        manual.push(issue);
        continue;
      }

      const quoted = String(issue.text || '').trim();
      if (!quoted || quoted.length < 2 || quoted.length > 120) {
        manual.push(issue);
        continue;
      }

      const spots = occurrences(text, quoted);
      if (!spots.length) {
        manual.push(issue);
        continue;
      }

      const parsed = parseReplacement(issue.suggestion);
      const deletable = DELETABLE_TYPES.has(issue.type);

      // Filler and transitions carry no suggestion — the fix is removal.
      if ((!parsed && deletable) || (parsed && parsed.kind === 'delete')) {
        let any = false;
        for (const spot of spots) {
          const span = deletionSpan(text, spot.start, spot.end);
          if (!span) continue;
          edits.push({ ...span, replacement: '', kind: 'delete', issue, was: text.slice(spot.start, spot.end) });
          any = true;
        }
        if (!any) manual.push(issue);
        continue;
      }

      if (parsed && parsed.kind === 'swap') {
        let swapped = false;
        for (const spot of spots) {
          const was = text.slice(spot.start, spot.end);
          const replacement = matchCase(was, inflect(was, parsed.text));
          if (replacement.toLowerCase() === was.toLowerCase()) continue;
          if (fillsNounSlot(text, spot.start) && /^\w+s$/.test(parsed.text)) continue;
          edits.push({ ...spot, replacement, kind: 'swap', issue, was });
          swapped = true;
        }
        if (!swapped) manual.push(issue);
        continue;
      }

      manual.push(issue);
    }

    // Resolve overlaps: earliest start wins, longest span breaks a tie.
    edits.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    let cursor = -1;
    for (const edit of edits) {
      if (edit.start < cursor) continue;
      kept.push(edit);
      cursor = edit.end;
    }

    // An issue whose every edit lost an overlap is still the user's problem.
    const applied = new Set(kept.map((e) => e.issue));
    for (const edit of edits) {
      if (!applied.has(edit.issue) && !manual.includes(edit.issue)) manual.push(edit.issue);
    }

    return { edits: kept, manual };
  }

  /** Apply a plan and repair the seams deletion leaves behind. */
  function apply(text, edits) {
    let out = text;
    for (let i = edits.length - 1; i >= 0; i -= 1) {
      const e = edits[i];
      out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    }

    return (
      out
        // Deleting a clause can strand a space before punctuation.
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        // …or double up spaces mid-line. Newlines are left alone.
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '')
        // Recapitalize a sentence that lost its opener. Only after terminal
        // punctuation, at the very start, or after a blank line — a single
        // newline is a hard wrap mid-sentence, not a new sentence.
        .replace(/(^|[.!?]["')\]]?\s+|\n[ \t]*\n[ \t]*)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase())
    );
  }

  /**
   * Convenience: plan + apply in one call.
   * @returns {{text: string, applied: number, manual: Array, edits: Array}}
   */
  function fix(text, issues) {
    const { edits, manual } = plan(text, issues);
    return { text: apply(text, edits), applied: edits.length, manual, edits };
  }

  return { fix, plan, apply, parseReplacement, inflect, matchCase, occurrences, isHouseDirective };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Fixer;
}
