/**
 * Resume-specific detection layer.
 *
 * The bundled avoid-ai-writing detector (../.claude/skills/avoid-ai-writing/
 * detector/patterns.js) scores general prose. Resumes are not prose: they are
 * fragment bullets with no articles, deliberate Title Case headers, and a
 * vocabulary that would read as promotional anywhere else. Running the prose
 * detector alone on a resume both misses the tells that matter (unquantified
 * bullets, LLM verb signature, suspiciously round metrics) and risks firing on
 * conventions that are correct in the genre.
 *
 * This module adds the genre layer. Issues come tagged with a `group`:
 *
 *   ai     — reads as machine-generated. Feeds a bounded uplift on the prose
 *            detector's score.
 *   craft  — a resume problem regardless of who or what wrote it (no metrics,
 *            missing contact block, weak verbs). Scored separately, because
 *            "sounds human" and "is a good resume" are different questions.
 *
 * Zero dependencies. Runs in Node (>=18) and in the browser, where it
 * self-registers as a global `ResumeRules`.
 */

const ResumeRules = (() => {
  // ═══ Weights ═══════════════════════════════════════════════════════
  //
  // Same shape as the prose detector's ISSUE_WEIGHTS: raw score is the sum
  // of weights over the deduplicated issue list, then normalized.
  const ISSUE_WEIGHTS = {
    'resume-cliche': 5,
    'resume-llm-verb': 4,
    'resume-vague-impact': 4,
    'resume-round-metrics': 5,
    'resume-uniform-bullets': 4,
    'resume-triad': 3,
    'resume-unquantified': 6,
    'resume-weak-verb': 2,
    'resume-pronoun': 3,
    'resume-long-bullet': 2,
    'resume-tense-mix': 2,
    'resume-missing-contact': 4,
    'resume-missing-dates': 3,
    'resume-missing-section': 3,
    'resume-skill-dump': 2,
  };

  const GROUPS = {
    'resume-cliche': 'ai',
    'resume-llm-verb': 'ai',
    'resume-vague-impact': 'ai',
    'resume-round-metrics': 'ai',
    'resume-uniform-bullets': 'ai',
    'resume-triad': 'ai',
    'resume-unquantified': 'craft',
    'resume-weak-verb': 'craft',
    'resume-pronoun': 'craft',
    'resume-long-bullet': 'craft',
    'resume-tense-mix': 'craft',
    'resume-missing-contact': 'craft',
    'resume-missing-dates': 'craft',
    'resume-missing-section': 'craft',
    'resume-skill-dump': 'craft',
  };

  const TYPE_LABELS = {
    'resume-cliche': 'Resume cliché',
    'resume-llm-verb': 'LLM-favored verb',
    'resume-vague-impact': 'Unmeasured impact claim',
    'resume-round-metrics': 'Suspiciously round metrics',
    'resume-uniform-bullets': 'Uniform bullet rhythm',
    'resume-triad': 'Rule-of-three stacking',
    'resume-unquantified': 'Bullets without numbers',
    'resume-weak-verb': 'Weak opener',
    'resume-pronoun': 'First-person pronoun',
    'resume-long-bullet': 'Overlong bullet',
    'resume-tense-mix': 'Mixed verb tense',
    'resume-missing-contact': 'No contact details',
    'resume-missing-dates': 'Undated roles',
    'resume-missing-section': 'Missing standard section',
    'resume-skill-dump': 'Skills keyword dump',
  };

  // ═══ Phrase tables ═════════════════════════════════════════════════

  // Dead phrases. Every recruiter has read these ten thousand times, and
  // an LLM asked for a resume reaches for them first.
  const CLICHES = [
    ['results[- ]driven', 'name the result'],
    ['results[- ]oriented', 'name the result'],
    ['detail[- ]oriented', 'show it — a bullet where detail mattered'],
    ['team player', 'name a team outcome you owned part of'],
    ['hard[- ]working', 'cut — the bullets should show this'],
    ['self[- ]starter', 'name something you started'],
    ['go[- ]getter', 'cut'],
    ['think(?:ing)? outside the box', 'describe the unconventional thing you did'],
    ['wear(?:s|ing)? many hats', 'list the actual roles'],
    ['proven track record', 'show the record'],
    ['track record of success', 'show the record'],
    ['dynamic (?:professional|leader|individual)', 'cut'],
    ['seasoned (?:professional|veteran|expert)', 'state years and domain'],
    ['passionate about', 'cut — show it in what you built'],
    ['highly motivated', 'cut'],
    ['excellent communication skills', 'cut — or cite a talk, doc, or audience'],
    ['strong work ethic', 'cut'],
    ['works? well (?:both )?independently and (?:as part of )?(?:in )?a team', 'cut'],
    ['best[- ]in[- ]class', 'name the comparison'],
    ['world[- ]class', 'name the comparison'],
    ['value[- ]add', 'name the value'],
    ['synerg(?:y|ies|istic)', 'say what actually combined'],
    ['bottom[- ]line', 'give the number'],
    ['fast[- ]paced environment', 'cut'],
    ['hit the ground running', 'cut'],
    ['go above and beyond', 'give the example instead'],
    ['well[- ]versed in', 'just list it'],
    ['a wide (?:range|array|variety) of', 'list the actual few'],
    ['proficient in a variety of', 'list them'],
  ];

  // Verbs and phrases an LLM reaches for when asked to write resume
  // bullets. `strong` entries flag on a single appearance; `soft` entries
  // are legitimate often enough that they only flag when they cluster.
  const LLM_VERBS_STRONG = [
    ['spearhead(?:ed|ing|s)?', 'led'],
    ['orchestrat(?:ed|ing|es)?', 'ran / coordinated'],
    ['championed', 'pushed for / led'],
    ['pioneer(?:ed|ing|s)?', 'built first / started'],
    ['revolutioniz(?:ed|ing|es)?', 'changed — then say how much'],
    ['leverag(?:ed|ing|es)?', 'used'],
    ['utiliz(?:ed|ing|es)?', 'used'],
    ['seamless(?:ly)?', 'cut'],
    ['holistic', 'cut'],
    ['actionable insights?', 'name the decision it drove'],
    ['robust solutions?', 'name the thing you built'],
    ['cutting[- ]edge', 'name the technology'],
    ['state[- ]of[- ]the[- ]art', 'name the technology'],
    ['synergiz(?:ed|ing|es)?', 'say what combined'],
    ['ideat(?:ed|ing|es)?', 'came up with'],
    ['evangeliz(?:ed|ing|es)?', 'promoted / taught'],
  ];

  const LLM_VERBS_SOFT = [
    ['streamlin(?:ed|ing|es)?', 'cut steps — say which'],
    ['optimiz(?:ed|ing|es)?', 'say what got faster / cheaper, by how much'],
    ['facilitat(?:ed|ing|es)?', 'ran / helped'],
    ['empower(?:ed|ing|s)?', 'say what it let people do'],
    ['curat(?:ed|ing|es)?', 'picked / assembled'],
    ['architect(?:ed|ing|s)', 'designed'],
    ['drove (?:significant|substantial|meaningful)', 'give the number'],
    ['cross[- ]functional', 'name the teams'],
    ['end[- ]to[- ]end', 'name the span'],
    ['stakeholders?', 'name who'],
  ];

  // Impact claims with no measurement attached.
  const VAGUE_IMPACT = [
    ['result(?:ing|ed) in (?:improved|increased|enhanced|greater|better)', 'give the number'],
    ['lead(?:ing)? to (?:improved|increased|enhanced|greater|better)', 'give the number'],
    ['significantly (?:improv|increas|reduc|enhanc|boost)\\w*', 'give the number'],
    ['greatly (?:improv|increas|reduc|enhanc|boost)\\w*', 'give the number'],
    ['substantially (?:improv|increas|reduc|enhanc|boost)\\w*', 'give the number'],
    ['dramatically (?:improv|increas|reduc|enhanc|boost)\\w*', 'give the number'],
    ['(?:improv|increas|enhanc|boost)\\w* (?:overall )?(?:efficiency|productivity|performance)(?!\\s+by)', 'give the number'],
    ['ensur(?:ed|ing) (?:optimal|maximum|seamless)', 'say what you actually did'],
    ['contribut(?:ed|ing) to the (?:success|growth|development)', 'say what you did'],
  ];

  const WEAK_OPENERS = [
    ['responsible for', 'start with the verb: "Ran", "Built", "Owned"'],
    ['worked on', 'name what you did to it'],
    ['helped (?:with|to)', 'say your part'],
    ['assisted (?:in|with)', 'say your part'],
    ['tasked with', 'say what you delivered'],
    ['duties included', 'drop the preamble'],
    ['involved in', 'say your part'],
    ['participated in', 'say your part'],
  ];

  // Irregular past-tense verbs that resume bullets actually start with —
  // needed because the -ed test alone misses "Led", "Built", "Ran".
  const IRREGULAR_PAST = new Set([
    'led', 'built', 'ran', 'wrote', 'built', 'made', 'won', 'grew', 'drove',
    'sold', 'taught', 'spoke', 'chose', 'set', 'cut', 'sent', 'kept', 'held',
    'brought', 'took', 'gave', 'found', 'met', 'rebuilt', 'oversaw', 'shipped',
  ]);

  const SECTION_WORDS = {
    experience: /^\s*(work\s+)?(experience|employment|professional\s+experience|work\s+history|career)\b/i,
    education: /^\s*(education|academic|academics|degrees?)\b/i,
    skills: /^\s*(skills|technical\s+skills|core\s+competencies|technologies|toolkit)\b/i,
    summary: /^\s*(summary|profile|objective|about|professional\s+summary)\b/i,
  };

  const BULLET_GLYPH = /^\s*(?:[•▪▫‣◦●○·*\-–—]|\d+[.)])\s+/;
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const URL_RE = /(?:https?:\/\/|www\.)\S+|(?:linkedin\.com|github\.com)\/\S+/i;
  const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  const DATE_RE = new RegExp(
    `(?:${MONTHS}\\.?\\s*\\d{4})|(?:\\b(?:19|20)\\d{2}\\s*(?:[-–—]|to)\\s*(?:(?:19|20)\\d{2}|present|current)\\b)`,
    'i'
  );
  // A number that carries real weight: percent, currency, multiplier, count,
  // or a duration. Bare years are excluded — a date is not an achievement.
  const METRIC_RE = /(?:\d+(?:\.\d+)?\s*%)|(?:[$£€]\s?\d)|(?:\d+(?:\.\d+)?\s*[xX]\b)|(?:\b\d{1,3}(?:,\d{3})+\b)|(?:\b\d+(?:\.\d+)?\s*(?:k|m|bn|b|million|billion|thousand)\b)|(?:\b\d+\s*(?:hours?|days?|weeks?|months?|minutes?|seconds?|ms|users?|customers?|clients?|people|engineers?|reports?|accounts?|stores?|units?|tickets?|articles?|posts?)\b)/i;

  // ═══ Parsing ═══════════════════════════════════════════════════════

  /**
   * Split a pasted resume into the structures the rules need. Handles both
   * glyph-bulleted resumes and the flat text you get out of a PDF copy-paste,
   * where the glyphs are gone and every bullet is just a line.
   */
  function parseResume(text) {
    const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const lines = rawLines.map((raw, i) => {
      const trimmed = raw.trim();
      return {
        index: i,
        raw,
        text: trimmed,
        words: trimmed ? trimmed.split(/\s+/).length : 0,
        isBlank: trimmed === '',
        hasGlyph: BULLET_GLYPH.test(raw),
        body: trimmed.replace(BULLET_GLYPH, '').trim(),
      };
    });

    const sections = {};
    for (const line of lines) {
      if (line.isBlank || line.words > 6) continue;
      for (const [name, re] of Object.entries(SECTION_WORDS)) {
        if (re.test(line.text) && sections[name] === undefined) sections[name] = line.index;
      }
    }

    // Bullets: explicit glyphs when the document uses them, otherwise every
    // substantive line that isn't a header, date, or contact line.
    const glyphed = lines.filter((l) => l.hasGlyph && l.body.length > 0);
    let bullets;
    if (glyphed.length >= 3) {
      // Join wrapped continuation lines back onto their bullet. A bullet that
      // wraps to a second line is one bullet, and the half the wrap carries
      // often holds the metric — dropping it would both understate length
      // variance and lose the number.
      bullets = [];
      let current = null;
      for (const line of lines) {
        if (line.hasGlyph && line.body.length > 0) {
          current = { ...line };
          bullets.push(current);
          continue;
        }
        if (!current) continue;
        const isContinuation =
          !line.isBlank &&
          /^\s+/.test(line.raw) &&
          !isHeadingLine(line.text) &&
          !DATE_RE.test(line.text);
        if (isContinuation) current.body = `${current.body} ${line.text}`.trim();
        else if (line.isBlank || isHeadingLine(line.text)) current = null;
      }
    } else {
      bullets = lines.filter(
        (l) =>
          !l.isBlank &&
          l.words >= 6 &&
          !DATE_RE.test(l.text) &&
          !EMAIL_RE.test(l.text) &&
          !isHeadingLine(l.text) &&
          !Object.values(SECTION_WORDS).some((re) => re.test(l.text))
      );
    }

    // Group bullets into role blocks — a run of bullets uninterrupted by a
    // blank line or heading is one job. The date rule compares against this,
    // not against bullet count: one role with five bullets needs one date
    // range, not five.
    let blocks = 0;
    let prevIndex = -99;
    for (const b of bullets) {
      const contiguous = lines
        .slice(prevIndex + 1, b.index)
        .every((l) => !l.isBlank && !isHeadingLine(l.text));
      if (prevIndex < 0 || !contiguous) blocks += 1;
      prevIndex = b.index;
    }

    return {
      lines,
      bullets,
      blocks,
      sections,
      contact: {
        email: lines.some((l) => EMAIL_RE.test(l.text)),
        phone: lines.some((l) => PHONE_RE.test(l.text)),
        url: lines.some((l) => URL_RE.test(l.text)),
      },
      dateLines: lines.filter((l) => DATE_RE.test(l.text)).length,
      usedGlyphs: glyphed.length >= 3,
    };
  }

  function isHeadingLine(s) {
    if (!s || s.length > 60) return false;
    const letters = s.replace(/[^A-Za-z]/g, '');
    if (!letters) return false;
    // ALL CAPS or Title Case with no terminal punctuation reads as a header.
    return letters === letters.toUpperCase() && letters.length >= 3;
  }

  function stripFormatting(s) {
    return s.replace(/[*_`]/g, '');
  }

  // ═══ Rules ═════════════════════════════════════════════════════════

  function matchTable(haystackLines, table, type, severity) {
    const issues = [];
    for (const [pattern, fix] of table) {
      const re = new RegExp(`\\b(${pattern})\\b`, 'gi');
      for (const line of haystackLines) {
        const body = stripFormatting(line.body || line.text);
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(body)) !== null) {
          issues.push({
            type,
            text: m[1],
            severity,
            suggestion: fix,
            line: line.index + 1,
            context: body,
          });
          if (m.index === re.lastIndex) re.lastIndex += 1;
        }
      }
    }
    return issues;
  }

  function checkUnquantified(bullets) {
    if (bullets.length < 3) return [];
    const withMetric = bullets.filter((b) => METRIC_RE.test(b.body));
    const ratio = withMetric.length / bullets.length;
    if (ratio >= 0.4) return [];
    const missing = bullets.length - withMetric.length;
    return [
      {
        type: 'resume-unquantified',
        text: `${missing} of ${bullets.length} bullets carry no number`,
        severity: ratio < 0.15 ? 'high' : 'medium',
        suggestion:
          'Attach a magnitude to the claims that have one — headcount, dollars, percent, latency, volume. Aim for numbers on 40%+ of bullets.',
        line: null,
        stat: { withMetric: withMetric.length, total: bullets.length },
      },
    ];
  }

  function checkRoundMetrics(bullets) {
    const percents = [];
    for (const b of bullets) {
      const re = /(\d+(?:\.\d+)?)\s*%/g;
      let m;
      while ((m = re.exec(b.body)) !== null) percents.push({ value: parseFloat(m[1]), line: b.index + 1 });
    }
    if (percents.length < 3) return [];
    const round = percents.filter((p) => Number.isInteger(p.value) && p.value % 5 === 0);
    if (round.length !== percents.length) return [];
    return [
      {
        type: 'resume-round-metrics',
        text: percents.map((p) => `${p.value}%`).join(', '),
        severity: 'high',
        suggestion:
          'Every percentage is a multiple of 5. Real measurements are lumpy — pull the actual figures, or say "roughly a third" and cite where it came from.',
        line: percents[0].line,
      },
    ];
  }

  // Coefficient-of-variation floor for bullet length. Deliberately tight:
  // measured human resumes land around cv 0.18-0.35, so a wider gate turns
  // a tidy writer into a false positive. Same FN-bias the prose detector uses.
  const UNIFORMITY_CV = 0.12;

  function checkUniformity(bullets) {
    if (bullets.length < 5) return [];
    const lengths = bullets.map((b) => b.body.split(/\s+/).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (mean < 8) return [];
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv >= UNIFORMITY_CV) return [];
    return [
      {
        type: 'resume-uniform-bullets',
        text: `${bullets.length} bullets, all ~${Math.round(mean)} words (variation ${(cv * 100).toFixed(0)}%)`,
        severity: 'medium',
        suggestion:
          'Human bullets are uneven — some are four words, some run two lines. Cut two of these to a fragment and let one run long.',
        line: null,
        stat: { mean: Math.round(mean), cv: Number(cv.toFixed(3)) },
      },
    ];
  }

  function checkTriads(bullets) {
    // "A, B, and C" — the shape an LLM falls into when it needs a list.
    const re = /\b[\w-]+(?:\s+[\w-]+){0,3},\s+[\w-]+(?:\s+[\w-]+){0,3},\s+and\s+[\w-]+/i;
    const hits = bullets.filter((b) => re.test(b.body));
    if (hits.length < 3) return [];
    return [
      {
        type: 'resume-triad',
        text: `${hits.length} bullets built as "X, Y, and Z"`,
        severity: 'medium',
        suggestion:
          'Rule-of-three lists stacked across bullets is a generation artifact. Keep the one that earns it and cut the filler item from the rest.',
        line: hits[0].index + 1,
      },
    ];
  }

  function checkPronouns(bullets) {
    const issues = [];
    const re = /\b(I|I'm|I've|my|me|myself)\b/g;
    for (const b of bullets) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(b.body)) !== null) {
        issues.push({
          type: 'resume-pronoun',
          text: m[1],
          severity: 'low',
          suggestion: 'Resume bullets drop the subject: "Led the migration", not "I led the migration".',
          line: b.index + 1,
          context: b.body,
        });
      }
    }
    return issues;
  }

  function checkLongBullets(bullets) {
    return bullets
      .filter((b) => b.body.split(/\s+/).length > 32)
      .map((b) => ({
        type: 'resume-long-bullet',
        text: b.body.slice(0, 60) + '…',
        severity: 'low',
        suggestion: 'Over 32 words. Split it, or cut to the claim and the number.',
        line: b.index + 1,
      }));
  }

  function checkTense(bullets) {
    if (bullets.length < 3) return [];
    let past = 0;
    let present = 0;
    for (const b of bullets) {
      const first = (b.body.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
      if (!first) continue;
      if (first.endsWith('ed') || IRREGULAR_PAST.has(first)) past += 1;
      else if (first.endsWith('ing')) continue; // gerund openers are their own style
      else if (/^(manage|lead|build|run|own|drive|write|design|develop|maintain|support|create)s?$/.test(first))
        present += 1;
    }
    if (past === 0 || present === 0) return [];
    if (past + present < 3) return [];
    return [
      {
        type: 'resume-tense-mix',
        text: `${past} past-tense openers, ${present} present-tense`,
        severity: 'low',
        suggestion: 'Pick one tense per role — present for the current job, past for everything else.',
        line: null,
      },
    ];
  }

  function checkStructure(parsed) {
    const issues = [];
    const { contact, sections, bullets, dateLines, lines, blocks } = parsed;

    if (!contact.email && !contact.phone && !contact.url) {
      issues.push({
        type: 'resume-missing-contact',
        text: 'no email, phone, or profile link found',
        severity: 'high',
        suggestion: 'Add a contact line. Applicant tracking systems key off it, and a human cannot reply without it.',
        line: null,
      });
    }

    for (const name of ['experience', 'education', 'skills']) {
      if (sections[name] === undefined) {
        issues.push({
          type: 'resume-missing-section',
          text: `no "${name}" heading`,
          severity: 'medium',
          suggestion: `Add a plain "${name[0].toUpperCase() + name.slice(1)}" heading — parsers look for the standard words.`,
          line: null,
        });
      }
    }

    if (bullets.length >= 3 && dateLines < blocks) {
      issues.push({
        type: 'resume-missing-dates',
        text: `${dateLines} date range${dateLines === 1 ? '' : 's'} for ${blocks} role block${blocks === 1 ? '' : 's'}`,
        severity: 'medium',
        suggestion: 'Put a "Mon YYYY – Mon YYYY" range on every role. Gaps read worse when the dates are missing entirely.',
        line: null,
      });
    }

    for (const line of lines) {
      const commas = (line.text.match(/,/g) || []).length;
      if (commas >= 25) {
        issues.push({
          type: 'resume-skill-dump',
          text: `${commas + 1} comma-separated items on one line`,
          severity: 'low',
          suggestion: 'Group skills by kind and cut anything you would not want to be interviewed on.',
          line: line.index + 1,
        });
      }
    }

    return issues;
  }

  // ═══ Entry point ═══════════════════════════════════════════════════

  /**
   * @param {string} text raw resume text
   * @param {{minBullets?: number}} [options]
   * @returns {{score:number,label:string,aiScore:number,craftScore:number,
   *            issues:Array,stats:Object,sections:Object}}
   */
  function analyzeResume(text, options = {}) {
    const src = String(text || '');
    const parsed = parseResume(src);
    const { bullets, lines } = parsed;
    const wordCount = src.trim() ? src.trim().split(/\s+/).length : 0;

    if (wordCount < 30) {
      return {
        score: 0,
        label: 'Too short',
        aiScore: 0,
        craftScore: 100,
        issues: [],
        stats: { wordCount, bulletCount: bullets.length, scorable: false },
        sections: parsed.sections,
      };
    }

    const contentLines = lines.filter((l) => !l.isBlank);
    let issues = [];

    issues = issues.concat(matchTable(contentLines, CLICHES, 'resume-cliche', 'high'));
    issues = issues.concat(matchTable(contentLines, LLM_VERBS_STRONG, 'resume-llm-verb', 'high'));
    issues = issues.concat(matchTable(contentLines, VAGUE_IMPACT, 'resume-vague-impact', 'medium'));
    issues = issues.concat(matchTable(contentLines, WEAK_OPENERS, 'resume-weak-verb', 'low'));

    // Soft LLM verbs only count once they cluster — "optimized" on its own is
    // a normal word, three of these together is a signature.
    const softHits = matchTable(contentLines, LLM_VERBS_SOFT, 'resume-llm-verb', 'medium');
    const distinctSoft = new Set(softHits.map((h) => h.text.toLowerCase()));
    if (distinctSoft.size >= 3) issues = issues.concat(softHits);

    issues = issues.concat(checkUnquantified(bullets));
    issues = issues.concat(checkRoundMetrics(bullets));
    issues = issues.concat(checkUniformity(bullets));
    issues = issues.concat(checkTriads(bullets));
    issues = issues.concat(checkPronouns(bullets));
    issues = issues.concat(checkLongBullets(bullets));
    issues = issues.concat(checkTense(bullets));
    issues = issues.concat(checkStructure(parsed));

    // Dedup by (type, lowercased text) — the prose detector's convention, so
    // one cliché repeated six times counts once.
    const seen = new Set();
    const deduped = [];
    for (const issue of issues) {
      const key = `${issue.type}::${String(issue.text).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...issue, group: GROUPS[issue.type], weight: ISSUE_WEIGHTS[issue.type] });
    }

    const aiIssues = deduped.filter((i) => i.group === 'ai');
    const craftIssues = deduped.filter((i) => i.group === 'craft');

    // Normalize against document length the way the prose detector does, so a
    // three-page resume isn't punished for having more surface area.
    const norm = Math.max(1, Math.log2(Math.max(wordCount, 50) / 50) + 1);
    const rawAi = aiIssues.reduce((a, i) => a + i.weight, 0);
    const rawCraft = craftIssues.reduce((a, i) => a + i.weight, 0);

    const aiScore = clamp(Math.round((rawAi / norm) * 4));
    const craftPenalty = clamp(Math.round((rawCraft / norm) * 5));
    const craftScore = 100 - craftPenalty;
    const score = clamp(Math.round(aiScore * 0.65 + craftPenalty * 0.35));

    return {
      score,
      label: getLabel(aiScore),
      aiScore,
      craftScore,
      issues: deduped.sort(
        (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.weight - a.weight
      ),
      stats: {
        wordCount,
        bulletCount: bullets.length,
        bulletsWithMetrics: bullets.filter((b) => METRIC_RE.test(b.body)).length,
        usedGlyphs: parsed.usedGlyphs,
        dateLines: parsed.dateLines,
        contact: parsed.contact,
        rawAi,
        rawCraft,
        scorable: true,
      },
      sections: parsed.sections,
    };
  }

  /**
   * Bounded uplift applied to the prose detector's score for resumes. Capped
   * at 25 so the genre layer can sharpen a verdict but never manufacture one
   * on its own — the calibrated engine stays in charge.
   */
  function aiUplift(resumeResult) {
    if (!resumeResult || !resumeResult.stats || !resumeResult.stats.scorable) return 0;
    return Math.min(25, Math.round(resumeResult.aiScore * 0.35));
  }

  function severityRank(s) {
    return { high: 3, medium: 2, low: 1 }[s] || 0;
  }

  function clamp(n) {
    return Math.max(0, Math.min(100, n));
  }

  function getLabel(score) {
    if (score === 0) return 'Clean';
    if (score <= 15) return 'Minimal AI signals';
    if (score <= 35) return 'Some AI patterns';
    if (score <= 60) return 'Moderate AI signals';
    if (score <= 80) return 'Strong AI signals';
    return 'Heavy AI patterns';
  }

  return {
    analyzeResume,
    parseResume,
    aiUplift,
    getLabel,
    ISSUE_WEIGHTS,
    TYPE_LABELS,
    GROUPS,
    METRIC_RE,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResumeRules;
}
