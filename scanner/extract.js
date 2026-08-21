/**
 * Text extraction for uploaded documents.
 *
 * The scanner page is self-contained — the CSP admits no CDN, so pdf.js is
 * not an option and this has to do the job in a few hundred lines. It covers
 * the formats people actually keep resumes and cover letters in:
 *
 *   .pdf   text-based PDFs, including Type0/Identity-H fonts (what Chrome,
 *          Google Docs and Word all emit) via their ToUnicode CMaps
 *   .docx  OOXML — a zip whose word/document.xml holds the paragraphs
 *   .txt / .md  decoded as UTF-8
 *
 * Scanned PDFs hold pictures of words and would need OCR; they are detected
 * and reported rather than returned as empty. Encrypted PDFs are refused.
 *
 * Decompression uses the platform DecompressionStream, so the same code runs
 * in the browser and in Node >= 18. Everything here is async for that reason.
 *
 * Self-registers as a global `Extract`.
 */

const Extract = (() => {
  // ═══ Bytes ═════════════════════════════════════════════════════════

  const latin1 = (bytes, from = 0, to = bytes.length) => {
    let s = '';
    // Chunked so a long stream doesn't blow the argument limit.
    for (let i = from; i < to; i += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, to)));
    }
    return s;
  };

  async function inflate(bytes, format) {
    const ds = new DecompressionStream(format);
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** PDF FlateDecode is zlib-wrapped, but some producers emit raw deflate. */
  async function inflateFlate(bytes) {
    try {
      return await inflate(bytes, 'deflate');
    } catch {
      try {
        return await inflate(bytes, 'deflate-raw');
      } catch {
        return null;
      }
    }
  }

  /**
   * Undo the PNG predictor some producers apply to Flate streams. Used on
   * cross-reference and object streams; harmless when absent.
   */
  function unpredict(data, colors, columns) {
    const rowLen = colors * columns;
    const out = new Uint8Array(Math.floor(data.length / (rowLen + 1)) * rowLen);
    let src = 0;
    let dst = 0;
    const prev = new Uint8Array(rowLen);
    while (src + rowLen < data.length + 1 && dst + rowLen <= out.length) {
      const tag = data[src++];
      const row = data.subarray(src, src + rowLen);
      src += rowLen;
      for (let i = 0; i < rowLen; i += 1) {
        const left = i >= colors ? out[dst + i - colors] : 0;
        const up = prev[i];
        let v = row[i];
        if (tag === 1) v += left;
        else if (tag === 2) v += up;
        else if (tag === 3) v += (left + up) >> 1;
        else if (tag === 4) {
          const ul = i >= colors ? prev[i - colors] : 0;
          const p = left + up - ul;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - ul);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        }
        out[dst + i] = v & 0xff;
      }
      prev.set(out.subarray(dst, dst + rowLen));
      dst += rowLen;
    }
    return out.subarray(0, dst);
  }

  // ═══ PDF ═══════════════════════════════════════════════════════════

  /**
   * Collect every `N 0 obj … endobj` in the file. PDFs are meant to be read
   * through their cross-reference table, but a linear scan survives the
   * damaged and incrementally-updated files that a table walk trips over,
   * and we only need content, not fidelity.
   */
  function scanObjects(raw) {
    const objects = new Map();
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const num = Number(m[1]);
      const start = m.index + m[0].length;
      const end = raw.indexOf('endobj', start);
      if (end < 0) continue;
      // A later generation of the same object wins (incremental updates).
      objects.set(num, { start, end, body: raw.slice(start, end) });
    }
    return objects;
  }

  /** Byte range of an object's stream payload, if it has one. */
  function streamRange(raw, obj) {
    const at = obj.body.indexOf('stream');
    if (at < 0) return null;
    let from = obj.start + at + 6;
    if (raw[from] === '\r') from += 1;
    if (raw[from] === '\n') from += 1;

    // Prefer the declared /Length. Hunting for the "endstream" keyword is
    // wrong twice over: compressed bytes can spell it, and the keyword is
    // preceded by an end-of-line that is indistinguishable from a final data
    // byte. A real resume lost its only content stream to exactly that — the
    // deflate stream ended in 0x0A, the trim ate it, inflate failed, and a
    // text PDF was reported as scanned.
    const dict = obj.body.slice(0, at);
    const len = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
    if (len) {
      const end = from + Number(len[1]);
      if (end <= raw.length && /^[\s]*endstream/.test(raw.slice(end, end + 24))) {
        return { from, to: end };
      }
    }

    let to = raw.indexOf('endstream', from);
    if (to < 0) return null;
    // Exactly one EOL separates the data from the keyword. Trimming greedily
    // eats a data byte whenever the stream's last byte is itself a newline.
    if (raw[to - 1] === '\n') to -= 1;
    if (raw[to - 1] === '\r') to -= 1;
    return { from, to };
  }

  /**
   * Decode one object's stream.
   *
   * Returns {dict, data} on success and {dict, error} on failure. It used to
   * return a bare null either way, and every caller treated that as "nothing
   * here" and moved on — so a document whose only content stream failed to
   * inflate extracted as empty and was reported as scanned. A decode failure
   * is not an absence of text; it is text we could not read, and the two must
   * not look the same to the caller.
   *
   * `unsupported` marks a filter we never claimed to handle (a JPEG image,
   * say). That is a real absence and not a failure.
   */
  async function objectStreamData(bytes, raw, obj) {
    const at = obj.body.indexOf('stream');
    const dict = at < 0 ? '' : obj.body.slice(0, at);
    const range = streamRange(raw, obj);
    if (!range) return at < 0 ? null : { dict, error: 'no stream delimiter' };
    let data = bytes.subarray(range.from, range.to);
    if (/\/FlateDecode/.test(dict)) {
      data = await inflateFlate(data);
      if (!data) return { dict, error: 'compressed data would not inflate' };
      const pred = /\/Predictor\s+(\d+)/.exec(dict);
      if (pred && Number(pred[1]) >= 10) {
        const colors = Number((/\/Colors\s+(\d+)/.exec(dict) || [])[1] || 1);
        const columns = Number((/\/Columns\s+(\d+)/.exec(dict) || [])[1] || 1);
        data = unpredict(data, colors, columns);
      }
    } else if (/\/(LZW|RunLength|CCITTFax|DCT|JPX)Decode/.test(dict)) {
      return { dict, unsupported: true };
    }
    return { dict, data };
  }

  /**
   * PDF 1.5+ packs objects into compressed object streams. Expand them so
   * font and ToUnicode references resolve.
   */
  async function expandObjectStreams(bytes, raw, objects, failures = []) {
    for (const [id, obj] of [...objects]) {
      if (!/\/Type\s*\/ObjStm/.test(obj.body)) continue;
      const got = await objectStreamData(bytes, raw, obj);
      if (got && got.error) failures.push(`object stream ${id}: ${got.error}`);
      if (!got || !got.data) continue;
      const n = Number((/\/N\s+(\d+)/.exec(got.dict) || [])[1] || 0);
      const first = Number((/\/First\s+(\d+)/.exec(got.dict) || [])[1] || 0);
      if (!n || !first) continue;
      const text = latin1(got.data);
      const header = text.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i += 1) {
        const num = header[i * 2];
        const off = header[i * 2 + 1];
        if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
        const nextOff = i + 1 < n ? header[i * 2 + 3] : got.data.length - first;
        if (objects.has(num)) continue;
        objects.set(num, { start: -1, end: -1, body: text.slice(first + off, first + nextOff) });
      }
    }
  }

  /**
   * Parse a ToUnicode CMap into code -> string. This is what turns the glyph
   * ids of an Identity-H font back into readable text; without it a modern
   * PDF extracts as mojibake.
   */
  function parseCMap(text) {
    const map = new Map();
    const hexToStr = (hex) => {
      let out = '';
      for (let i = 0; i + 3 < hex.length + 1; i += 4) {
        const unit = parseInt(hex.slice(i, i + 4), 16);
        if (Number.isFinite(unit)) out += String.fromCharCode(unit);
      }
      return out;
    };

    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
        map.set(parseInt(pair[1], 16), hexToStr(pair[2]));
      }
    }

    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const body = block[1];
      // <lo> <hi> <dst>
      for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        const base = parseInt(r[3], 16);
        if (hi - lo > 65535) continue;
        for (let c = lo; c <= hi; c += 1) map.set(c, String.fromCharCode(base + (c - lo)));
      }
      // <lo> <hi> [ <d1> <d2> … ]
      for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
        const lo = parseInt(r[1], 16);
        const items = [...r[3].matchAll(/<([0-9A-Fa-f]*)>/g)];
        items.forEach((item, i) => map.set(lo + i, hexToStr(item[1])));
      }
    }
    return map;
  }

  const refIn = (dict, key) => {
    const m = new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
    return m ? Number(m[1]) : null;
  };

  /** Build resourceName -> {cmap, twoByte} for every font in the document. */
  async function buildFonts(bytes, raw, objects, failures = []) {
    const fonts = new Map();

    const cmapFor = async (fontNum) => {
      const font = objects.get(fontNum);
      if (!font) return null;
      const twoByte = /\/Identity-H|\/Type0/.test(font.body);
      const tuNum = refIn(font.body, '/ToUnicode');
      let cmap = null;
      if (tuNum !== null && objects.has(tuNum)) {
        const got = await objectStreamData(bytes, raw, objects.get(tuNum));
        if (got && got.error) failures.push(`character map ${tuNum}: ${got.error}`);
        if (got && got.data) cmap = parseCMap(latin1(got.data));
      }
      return { cmap, twoByte };
    };

    // /Font << /F1 4 0 R /F2 5 0 R >> appears in each page's resources.
    for (const [, obj] of objects) {
      for (const block of obj.body.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
        for (const entry of block[1].matchAll(/\/([^\s/<>]+)\s+(\d+)\s+\d+\s+R/g)) {
          const name = entry[1];
          if (fonts.has(name)) continue;
          const info = await cmapFor(Number(entry[2]));
          if (info) fonts.set(name, info);
        }
      }
    }
    return fonts;
  }

  /** Split a content stream into tokens we care about. */
  function tokenizeContent(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];

      if (ch === '(') {
        let depth = 1;
        let out = '';
        i += 1;
        while (i < n && depth > 0) {
          const c = text[i];
          if (c === '\\') {
            const next = text[i + 1];
            const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
            if (octal) {
              out += String.fromCharCode(parseInt(octal[0], 8));
              i += 1 + octal[0].length;
              continue;
            }
            const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
            if (next === '\n') i += 2;
            else {
              out += map[next] !== undefined ? map[next] : next;
              i += 2;
            }
            continue;
          }
          if (c === '(') depth += 1;
          else if (c === ')') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
          out += c;
          i += 1;
        }
        tokens.push({ t: 'str', v: out, hex: false });
        continue;
      }

      if (ch === '<' && text[i + 1] !== '<') {
        const end = text.indexOf('>', i);
        if (end < 0) break;
        tokens.push({ t: 'str', v: text.slice(i + 1, end).replace(/\s+/g, ''), hex: true });
        i = end + 1;
        continue;
      }

      if (ch === '<' && text[i + 1] === '<') {
        // Skip inline dictionaries wholesale — they carry no shown text.
        let depth = 0;
        while (i < n) {
          if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 2; continue; }
          if (text[i] === '>' && text[i + 1] === '>') { depth -= 1; i += 2; if (!depth) break; continue; }
          i += 1;
        }
        continue;
      }

      if (ch === '[' || ch === ']') {
        tokens.push({ t: ch });
        i += 1;
        continue;
      }

      if (ch === '/') {
        const m = /^\/([^\s/[\]<>()]*)/.exec(text.slice(i));
        tokens.push({ t: 'name', v: m ? m[1] : '' });
        i += m ? m[0].length : 1;
        continue;
      }

      const num = /^[-+]?[\d.]+/.exec(text.slice(i));
      if (num && /[\d.]/.test(ch)) {
        tokens.push({ t: 'num', v: parseFloat(num[0]) });
        i += num[0].length;
        continue;
      }
      if (num && (ch === '-' || ch === '+')) {
        tokens.push({ t: 'num', v: parseFloat(num[0]) });
        i += num[0].length;
        continue;
      }

      const op = /^[A-Za-z'"*]+/.exec(text.slice(i));
      if (op) {
        tokens.push({ t: 'op', v: op[0] });
        i += op[0].length;
        continue;
      }
      i += 1;
    }
    return tokens;
  }

  function decodeString(token, font) {
    const cmap = font && font.cmap;
    const twoByte = font ? font.twoByte : false;

    // Hex strings carry character codes directly.
    const codes = [];
    if (token.hex) {
      const hex = token.v.length % 2 ? token.v + '0' : token.v;
      const step = twoByte ? 4 : 2;
      for (let i = 0; i < hex.length; i += step) {
        codes.push(parseInt(hex.slice(i, i + step), 16));
      }
    } else if (twoByte) {
      for (let i = 0; i + 1 < token.v.length; i += 2) {
        codes.push((token.v.charCodeAt(i) << 8) | token.v.charCodeAt(i + 1));
      }
    } else {
      for (let i = 0; i < token.v.length; i += 1) codes.push(token.v.charCodeAt(i));
    }

    let out = '';
    for (const code of codes) {
      if (cmap && cmap.has(code)) out += cmap.get(code);
      else if (!cmap && code >= 32 && code < 127) out += String.fromCharCode(code);
      else if (!cmap && code >= 160) out += String.fromCharCode(code);
      else if (cmap) out += ''; // unmapped glyph in a subset font
      else out += '';
    }
    return out;
  }

  /**
   * Walk a content stream, emitting text with line breaks reconstructed from
   * the positioning operators. PDFs have no notion of a line — only where
   * each run is painted — so a y-shift becomes a newline and a wide negative
   * kern inside TJ becomes a space.
   */
  function runContent(tokens, fonts) {
    let out = '';
    let font = null;
    let y = null;
    const stack = [];

    // Only vertical movement becomes structure. A horizontal gap cannot be
    // read as a word space without per-glyph advance widths: producers
    // reposition mid-word to apply kerning, and the distance between two run
    // *origins* grows with the length of the run in between. Guessing from
    // it inserts spaces inside words ("SUMMAR Y", "ef ficiency"). Real
    // spaces are encoded in the strings by every mainstream producer.
    const newlineIfMoved = (ny) => {
      if (y !== null && ny !== null && Math.abs(ny - y) > 0.5) out += '\n';
      y = ny;
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const tk = tokens[i];
      if (tk.t !== 'op') {
        stack.push(tk);
        if (stack.length > 64) stack.shift();
        continue;
      }

      switch (tk.v) {
        case 'Tf': {
          const name = [...stack].reverse().find((t) => t.t === 'name');
          font = name ? fonts.get(name.v) || null : null;
          break;
        }
        case 'Tm': {
          const nums = stack.filter((t) => t.t === 'num').slice(-6);
          if (nums.length === 6) newlineIfMoved(nums[5].v);
          break;
        }
        case 'Td':
        case 'TD': {
          const nums = stack.filter((t) => t.t === 'num').slice(-2);
          if (nums.length === 2 && Math.abs(nums[1].v) > 0.5) out += '\n';
          break;
        }
        case 'T*':
        case 'ET':
          out += '\n';
          break;
        case 'Tj':
        case "'":
        case '"': {
          const str = [...stack].reverse().find((t) => t.t === 'str');
          if (tk.v !== 'Tj') out += '\n';
          if (str) out += decodeString(str, font);
          break;
        }
        case 'TJ': {
          const open = stack.map((t) => t.t).lastIndexOf('[');
          const items = open >= 0 ? stack.slice(open + 1) : stack;
          for (const item of items) {
            if (item.t === 'str') out += decodeString(item, font);
            // Some producers (notably TeX) omit the space glyph and open a
            // gap with a wide negative kern instead. Only treat a very large
            // one as a space, and never double one that is already there.
            else if (item.t === 'num' && item.v < -250 && !/[\s]$/.test(out)) out += ' ';
          }
          break;
        }
        default:
          break;
      }
      stack.length = 0;
    }
    return out;
  }

  /** Collapse the ragged whitespace that position-based reconstruction leaves. */
  function tidy(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      // Rejoin a word split across a line break. The hyphen is kept: in this
      // genre a break almost always falls on a real compound ("cutting-edge",
      // "results-driven", "cross-functional"), and those are exactly the
      // phrases the detector looks for. The cost is an occasional
      // "environ-ments", which is visible and fixable in the draft view.
      .replace(/([A-Za-z])-\n{1,2}([a-z])/g, '$1-$2')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ /g, '')
      .trim();
  }

  /**
   * Letters per text-showing operator below which a read is a fragment, not a
   * document. Measured against real producer output: Chromium/Skia lands at
   * 0.8 for a dense resume, higher for prose. A broken decode lands near zero.
   */
  const YIELD_FLOOR = 0.25;

  async function extractPdf(bytes) {
    const raw = latin1(bytes);
    const warnings = [];

    if (/\/Encrypt\b/.test(raw)) {
      throw new Error(
        'This PDF is password-protected. Open it, print or export an unprotected copy, and try that.'
      );
    }

    const objects = scanObjects(raw);
    const failures = [];
    await expandObjectStreams(bytes, raw, objects, failures);
    const fonts = await buildFonts(bytes, raw, objects, failures);

    let text = '';
    let textOps = 0;
    for (const [id, obj] of objects) {
      const dict = obj.body.slice(0, Math.max(0, obj.body.indexOf('stream')));
      if (/\/Type\s*\/(ObjStm|XRef|Metadata|Font|FontDescriptor)/.test(dict)) continue;
      const got = await objectStreamData(bytes, raw, obj);
      if (!got) continue;
      // An image that fails to decode costs us nothing; a content stream that
      // fails costs us the page.
      if (got.error && !/\/Subtype\s*\/Image/.test(dict)) {
        failures.push(`object ${id}: ${got.error}`);
        continue;
      }
      if (!got.data) continue;
      const content = latin1(got.data);
      if (!/\bBT\b/.test(content) || !/\b(Tj|TJ)\b/.test(content)) continue;
      textOps += (content.match(/\b(?:Tj|TJ)\b/g) || []).length;
      text += runContent(tokenizeContent(content), fonts) + '\n';
    }

    const cleaned = tidy(text);
    const letters = (cleaned.match(/[A-Za-z]/g) || []).length;

    // ── Refuse to hand back a partial read ──────────────────────────
    //
    // A confident score on a failed extraction is worse than an error: the
    // reader has no way to tell "your writing is clean" from "we scored the
    // wrong bytes". So anything short of a clean read stops here.

    if (failures.length) {
      throw new Error(
        `Could not read this PDF — ${failures.length} ` +
          `${failures.length === 1 ? 'section' : 'sections'} of it failed to decode ` +
          `(${failures[0]}). Scoring what did come through would be worse than ` +
          'this error. Export a fresh PDF from the original document, or paste the text.'
      );
    }

    // The page said "show this text" far more often than we produced text.
    // Whatever the cause — an encoding we misread, a font we could not map —
    // what we hold is a fragment, and a fragment must not be scored.
    // A healthy read lands near or above one letter per run: producers emit a
    // TJ per word or per kerned cluster, so the real fixtures sit at 0.8-3.
    // A quarter of a letter per run means the glyphs are not reaching us.
    if (textOps >= 20 && letters < textOps * YIELD_FLOOR) {
      throw new Error(
        `Could not read this PDF — it draws ${textOps} runs of text but only ` +
          `${letters} characters came through, so what we have is a fragment. ` +
          'Export a fresh PDF from the original document, or paste the text.'
      );
    }

    if (letters < 20) {
      const images = /\/Subtype\s*\/Image/.test(raw);
      throw new Error(
        images && !textOps
          ? 'This PDF looks scanned — the pages are images of text, which needs OCR. Paste the text instead, or export a text PDF from the original document.'
          : 'No readable text found in this PDF. If it was scanned or uses an unusual font encoding, paste the text instead.'
      );
    }
    if (fonts.size && [...fonts.values()].every((f) => !f.cmap)) {
      warnings.push('No character maps found — some characters may be wrong.');
    }

    return { text: cleaned, kind: 'pdf', warnings };
  }

  // ═══ DOCX ══════════════════════════════════════════════════════════

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  /** Minimal zip reader: walk the central directory, inflate one entry. */
  async function unzipEntry(bytes, wanted) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i -= 1) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That file is not a readable .docx.');

    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);

    for (let i = 0; i < count && p + 46 <= bytes.length; i += 1) {
      if (u32(bytes, p) !== 0x02014b50) break;
      const method = u16(bytes, p + 10);
      const compSize = u32(bytes, p + 20);
      const nameLen = u16(bytes, p + 28);
      const extraLen = u16(bytes, p + 30);
      const commentLen = u16(bytes, p + 32);
      const localOff = u32(bytes, p + 42);
      const name = latin1(bytes, p + 46, p + 46 + nameLen);

      if (name === wanted) {
        const lnLen = u16(bytes, localOff + 26);
        const leLen = u16(bytes, localOff + 28);
        const start = localOff + 30 + lnLen + leLen;
        const data = bytes.subarray(start, start + compSize);
        if (method === 0) return data;
        if (method === 8) {
          const out = await inflate(data, 'deflate-raw');
          if (!out) throw new Error('Could not decompress that .docx.');
          return out;
        }
        throw new Error('That .docx uses an unsupported compression method.');
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  function docxXmlToText(xml) {
    return tidy(
      xml
        // Paragraph and row ends are real line breaks.
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:br\b[^>]*\/?>/g, '\n')
        .replace(/<w:tab\b[^>]*\/?>/g, '\t')
        .replace(/<\/w:tr>/g, '\n')
        // Keep only the runs' text nodes.
        .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (m, inner) => inner)
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, '&')
    );
  }

  async function extractDocx(bytes) {
    const doc = await unzipEntry(bytes, 'word/document.xml');
    if (!doc) throw new Error('That .docx has no document body — try re-saving it from Word.');
    const text = docxXmlToText(new TextDecoder().decode(doc));
    if (!text.trim()) throw new Error('That .docx appears to be empty.');
    return { text, kind: 'docx', warnings: [] };
  }

  // ═══ Dispatch ══════════════════════════════════════════════════════

  const MAX_BYTES = 12 * 1024 * 1024;

  function sniff(bytes, filename = '') {
    const head = latin1(bytes, 0, Math.min(8, bytes.length));
    if (head.startsWith('%PDF')) return 'pdf';
    // A .docx is a zip; so is .odt, which we do not read.
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      return /\.docx$/i.test(filename) ? 'docx' : 'zip';
    }
    if (/\.(txt|md|markdown|text)$/i.test(filename)) return 'text';
    return head.includes(' ') ? 'binary' : 'text';
  }

  /**
   * @param {Uint8Array|ArrayBuffer} input
   * @param {string} filename
   * @returns {Promise<{text:string, kind:string, warnings:string[]}>}
   */
  async function extractText(input, filename = '') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

    if (!bytes.length) throw new Error('That file is empty.');
    if (bytes.length > MAX_BYTES) {
      throw new Error(`That file is ${(bytes.length / 1048576).toFixed(1)}MB — the limit is 12MB.`);
    }

    switch (sniff(bytes, filename)) {
      case 'pdf':
        return extractPdf(bytes);
      case 'docx':
        return extractDocx(bytes);
      case 'zip':
        throw new Error('That looks like a zip. Upload the .pdf, .docx, or .txt itself.');
      case 'binary':
        throw new Error('That file type is not supported. Use a PDF, a .docx, or plain text.');
      default: {
        const text = new TextDecoder().decode(bytes);
        if (!text.trim()) throw new Error('That file is empty.');
        return { text: text.replace(/\r\n?/g, '\n'), kind: 'text', warnings: [] };
      }
    }
  }

  return { extractText, sniff, parseCMap, docxXmlToText, tidy, MAX_BYTES };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Extract;
}
