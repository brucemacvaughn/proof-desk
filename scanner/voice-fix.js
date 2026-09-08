/**
 * Deterministic voice edits — "More like me".
 *
 * Takes the VOICE findings from voice.js and applies the ones a machine can
 * carry out honestly, using nothing but the writer's own observed bands.
 *
 * ── The rule this module is built around ────────────────────────────
 *
 * **It never optimizes the score.** Every edit traces to one listed finding
 * and is reported by name; the VOICE MATCH number moves afterward as a
 * consequence, never as a target. The moment a button exists to raise a
 * measurement, the measurement stops measuring anything — nudging a
 * contraction rate to the middle of a band does not make prose more like
 * its author, it makes it more compliant with a statistic derived from the
 * author. Same reason the AI score, house rules and voice never feed each
 * other.
 *
 * So the edits stop at the writer's band edge rather than its centre, and
 * anything that would need judgment is refused out loud.
 *
 * ── What it will do ─────────────────────────────────────────────────
 *
 *   paragraphLength   split at sentence boundaries, or join adjacent
 *                     paragraphs. Structure only; not one word changes
 *   contractionRate   "it is" ⇄ "it's", from a fixed table
 *   semicolonRate     semicolon → period, next word capitalized
 *   dashRate          dash → comma, or → period where the dash joins two
 *                     independent clauses
 *   absentWords       delete a sentence-initial discourse adverb the writer
 *                     never uses ("Furthermore, we shipped" → "We shipped")
 *
 * ── What it refuses, and why ────────────────────────────────────────
 *
 *   sentenceLength    splitting a 31-word sentence means finding the clause
 *                     boundary and often supplying a subject
 *   readingLevel      a function of word and sentence length; moving it
 *                     means substituting vocabulary
 *   sentenceOpeners   varying how sentences start is rewriting
 *   commaRate         removing a comma can change what a sentence means
 *   parentheticalRate an aside is content; dropping it loses information
 *   signatureWords    never. Injecting the writer's own pet words to raise
 *                     the match is gaming the number, not writing
 *
 * Those come back as `manual` so the caller can show them as still the
 * writer's problem. Silently "fixing" them would produce confident nonsense.
 *
 * Zero dependencies. Node and browser; self-registers as global `VoiceFix`.
 */

const VoiceFix = (() => {
  function deps() {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      const path = require('path');
      return { Fingerprint: require(path.join(__dirname, 'fingerprint.js')) };
    }
    return {
      Fingerprint: typeof Fingerprint !== 'undefined' ? Fingerprint : globalThis.Fingerprint,
    };
  }

  /** Metrics this module can move, and the label it reports them under. */
  const FIXABLE = {
    paragraphLength: 'Paragraph length',
    contractionRate: 'Contractions',
    semicolonRate: 'Semicolons',
    dashRate: 'Dashes',
    absentWords: 'Words you never use',
  };

  /** Metrics that need a person, with the reason shown to them. */
  const MANUAL_REASON = {
    sentenceLength: 'Splitting a sentence needs the clause boundary, and often a new subject.',
    readingLevel: 'Moving the grade level means substituting vocabulary, not moving punctuation.',
    sentenceOpeners: 'Varying how sentences begin is rewriting them.',
    commaRate: 'Removing a comma can change what the sentence means.',
    parentheticalRate: 'An aside carries content; cutting it loses information.',
    signatureWords: 'Injecting your own words to raise the match would game the number.',
  };

  // ── Contractions ───────────────────────────────────────────────────
  //
  // One direction is safe in both. Expanding "it's" is the exception: it
  // stands for "it is" or "it has" depending on what follows, so it is
  // handled by its own rule and left alone when ambiguous.

  const CONTRACTIONS = [
    ['it is', "it's"], ['that is', "that's"], ['there is', "there's"],
    ['here is', "here's"], ['what is', "what's"], ['who is', "who's"],
    ['he is', "he's"], ['she is', "she's"], ['let us', "let's"],
    ['I am', "I'm"], ['you are', "you're"], ['we are', "we're"],
    ['they are', "they're"], ['I have', "I've"], ['you have', "you've"],
    ['we have', "we've"], ['they have', "they've"], ['I will', "I'll"],
    ['you will', "you'll"], ['we will', "we'll"], ['they will', "they'll"],
    ['I would', "I'd"], ['you would', "you'd"], ['we would', "we'd"],
    ['cannot', "can't"], ['can not', "can't"], ['will not', "won't"],
    ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"],
    ['is not', "isn't"], ['are not', "aren't"], ['was not', "wasn't"],
    ['were not', "weren't"], ['has not', "hasn't"], ['have not', "haven't"],
    ['had not', "hadn't"], ['would not', "wouldn't"], ['could not', "couldn't"],
    ['should not', "shouldn't"], ['not have', "not've"],
  ].filter(([, short]) => short !== "not've");

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Keep the original's capitalization when swapping a phrase. */
  function likeCase(original, replacement) {
    if (original === original.toUpperCase() && /[A-Z]{2}/.test(original)) {
      return replacement.toUpperCase();
    }
    if (/^[A-Z]/.test(original)) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
  }

  /**
   * @param {string} text
   * @param {'tighten'|'loosen'} dir tighten = add contractions
   * @param {number} budget how many sentences still need changing
   */
  function editContractions(text, dir, budget) {
    let out = text;
    let n = 0;

    for (const [long, short] of CONTRACTIONS) {
      if (n >= budget) break;
      const from = dir === 'tighten' ? long : short;
      const to = dir === 'tighten' ? short : long;
      // "I am" must not fire inside "I ambled"; the boundary handles it.
      const re = new RegExp(`\\b${esc(from)}\\b`, 'gi');
      out = out.replace(re, (m) => {
        if (n >= budget) return m;
        n += 1;
        return likeCase(m, to);
      });
    }

    return { text: out, count: n };
  }

  // ── Paragraphs ─────────────────────────────────────────────────────

  /**
   * Split paragraphs that run longer than the writer's band, at real
   * sentence boundaries, until the document mean lands inside it.
   *
   * Splitting near the middle rather than at a fixed count keeps the halves
   * comparable; a 14-sentence paragraph becomes two of seven, not one of
   * nine and one of five.
   */
  function splitParagraphs(text, high, Fingerprint) {
    const blocks = String(text).split(/(\n\s*\n+)/);
    let count = 0;

    const out = blocks.map((block) => {
      if (/^\n\s*\n+$/.test(block) || !block.trim()) return block;
      const sents = Fingerprint.sentences(block);
      if (sents.length <= high) return block;

      // Rebuild from the source so nothing the segmenter normalized is lost.
      const pieces = [];
      let rest = block;
      for (const s of sents) {
        const at = rest.indexOf(s);
        if (at < 0) continue;
        pieces.push(rest.slice(0, at + s.length));
        rest = rest.slice(at + s.length);
      }
      if (!pieces.length) return block;
      if (rest.trim()) pieces[pieces.length - 1] += rest;

      const chunks = Math.ceil(pieces.length / high);
      const per = Math.ceil(pieces.length / chunks);
      const paras = [];
      for (let i = 0; i < pieces.length; i += per) {
        paras.push(pieces.slice(i, i + per).join('').trim());
      }
      count += paras.length - 1;
      return paras.join('\n\n');
    });

    return { text: out.join(''), count };
  }

  /** Join adjacent paragraphs shorter than the writer's band. */
  function joinParagraphs(text, low, Fingerprint) {
    const parts = String(text).split(/\n\s*\n+/);
    if (parts.length < 2) return { text, count: 0 };

    const out = [];
    let count = 0;
    for (const part of parts) {
      const prev = out[out.length - 1];
      const prevShort = prev !== undefined && Fingerprint.sentences(prev).length < low;
      const thisShort = Fingerprint.sentences(part).length < low;
      if (prev !== undefined && prevShort && thisShort) {
        out[out.length - 1] = `${prev.trim()} ${part.trim()}`;
        count += 1;
      } else {
        out.push(part);
      }
    }

    return { text: out.join('\n\n'), count };
  }

  // ── Punctuation ────────────────────────────────────────────────────

  /** Semicolon → period. The clause after one is independent by definition. */
  function fixSemicolons(text, budget) {
    let n = 0;
    const out = String(text).replace(/;(\s+)([a-z])/g, (m, gap, ch) => {
      if (n >= budget) return m;
      n += 1;
      return `.${gap}${ch.toUpperCase()}`;
    });
    return { text: out, count: n };
  }

  /**
   * Dash → comma, except where the dash joins two independent clauses, where
   * a comma would splice them and a period is right.
   */
  function fixDashes(text, budget) {
    let n = 0;
    const out = String(text).replace(
      /\s*[—–]\s*|\s+-\s+/g,
      (m, offset, whole) => {
        if (n >= budget) return m;
        const after = whole.slice(offset + m.length);
        const next = /^([A-Za-z']+)\s+([A-Za-z']+)/.exec(after);
        // "— it was late" reads as its own clause; "— a late change" does not.
        const independent =
          next && /^(?:it|he|she|they|we|i|you|that|this|there|and then)$/i.test(next[1]);
        n += 1;
        return independent ? '. ' : ', ';
      }
    );

    // A period introduced mid-sentence needs the next word capitalized.
    return {
      text: out.replace(/\.\s+([a-z])/g, (m, ch) => m.slice(0, -1) + ch.toUpperCase()),
      count: n,
    };
  }

  // ── Words the writer never uses ────────────────────────────────────

  /**
   * Delete a sentence-initial discourse adverb and repair the seam.
   *
   * Only this shape is safe. "Furthermore, we shipped" loses nothing when
   * the adverb goes; "the nuance of the framing" cannot be mended by
   * deletion, so a content word is left for the writer.
   */
  function dropOpeners(text, wordList) {
    let count = 0;
    let out = String(text);

    for (const word of wordList) {
      if (!/^[a-z]+$/i.test(word)) continue;
      const re = new RegExp(
        `(^|[.!?]["'”’)\\]]?\\s+|\\n[ \\t]*\\n[ \\t]*)${esc(word)},\\s+([a-z])`,
        'gi'
      );
      out = out.replace(re, (m, lead, ch) => {
        count += 1;
        return lead + ch.toUpperCase();
      });
    }

    return { text: out, count };
  }

  // ═══ Plan and apply ════════════════════════════════════════════════

  /**
   * @param {string} text the draft
   * @param {object} comparison the result of Voice.compare()
   * @returns {{text:string, applied:Array, manual:Array, changed:boolean}}
   *   `applied` names each edit made and how many; `manual` names each
   *   finding left alone and why.
   */
  function fix(text, comparison) {
    const { Fingerprint } = deps();
    let out = String(text || '');
    const applied = [];
    const manual = [];

    if (!comparison || !comparison.available || !comparison.findings) {
      return { text: out, applied, manual, changed: false };
    }

    const note = (metric, count, what) => {
      if (count > 0) applied.push({ metric, label: FIXABLE[metric], count, what });
    };

    for (const f of comparison.findings) {
      const metric = f.metric;

      if (MANUAL_REASON[metric]) {
        manual.push({ metric, label: f.label, text: f.text, reason: MANUAL_REASON[metric] });
        continue;
      }

      if (metric === 'paragraphLength') {
        // Stop at the writer's own band edge, not its middle.
        if (f.direction === 'above') {
          const r = splitParagraphs(out, Math.max(1, Math.floor(f.band.high)), Fingerprint);
          out = r.text;
          note(metric, r.count, `split ${r.count} paragraph${r.count === 1 ? '' : 's'}`);
        } else {
          const r = joinParagraphs(out, Math.max(1, Math.ceil(f.band.low)), Fingerprint);
          out = r.text;
          note(metric, r.count, `joined ${r.count} paragraph${r.count === 1 ? '' : 's'}`);
        }
        continue;
      }

      if (metric === 'contractionRate') {
        const sents = Fingerprint.sentences(out).length;
        const target = f.direction === 'below' ? f.band.low : f.band.high;
        // How many sentences have to change to reach the band edge.
        const budget = Math.max(1, Math.round((Math.abs(target - f.draftValue) / 100) * sents));
        const r = editContractions(out, f.direction === 'below' ? 'tighten' : 'loosen', budget);
        out = r.text;
        note(metric, r.count, `${f.direction === 'below' ? 'contracted' : 'expanded'} ${r.count}`);
        continue;
      }

      if (metric === 'semicolonRate' && f.direction === 'above') {
        const words = Fingerprint.words(out).length;
        const budget = Math.max(1, Math.round(((f.draftValue - f.band.high) / 100) * words));
        const r = fixSemicolons(out, budget);
        out = r.text;
        note(metric, r.count, `${r.count} → full stop`);
        continue;
      }

      if (metric === 'dashRate' && f.direction === 'above') {
        const words = Fingerprint.words(out).length;
        const budget = Math.max(1, Math.round(((f.draftValue - f.band.high) / 100) * words));
        const r = fixDashes(out, budget);
        out = r.text;
        note(metric, r.count, `${r.count} → comma or full stop`);
        continue;
      }

      if (metric === 'absentWords') {
        const r = dropOpeners(out, [f.word]);
        out = r.text;
        if (r.count) note(metric, r.count, `cut "${f.word}" ${r.count}×`);
        else {
          manual.push({
            metric,
            label: f.label,
            text: f.text,
            reason: `"${f.word}" is doing work in the sentence — a swap needs you.`,
          });
        }
        continue;
      }

      // A fixable metric in a direction with no safe move.
      manual.push({
        metric,
        label: f.label,
        text: f.text,
        reason: 'No mechanical edit moves this one in that direction.',
      });
    }

    return { text: out, applied, manual, changed: out !== text };
  }

  /** Which findings this module could act on, without acting on them. */
  function canFix(comparison) {
    if (!comparison || !comparison.available || !comparison.findings) return [];
    return comparison.findings
      .filter((f) => {
        if (MANUAL_REASON[f.metric]) return false;
        if (f.metric === 'paragraphLength' || f.metric === 'contractionRate') return true;
        if (f.metric === 'absentWords') return /^[a-z]+$/i.test(f.word || '');
        return (
          (f.metric === 'semicolonRate' || f.metric === 'dashRate') && f.direction === 'above'
        );
      })
      .map((f) => f.metric);
  }

  return {
    FIXABLE,
    MANUAL_REASON,
    CONTRACTIONS,
    fix,
    canFix,
    splitParagraphs,
    joinParagraphs,
    editContractions,
    fixSemicolons,
    fixDashes,
    dropOpeners,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceFix;
}
