// Port of io.legado.app.model.analyzeRule.AnalyzeUrl (URL rule subset).
// Spec: AnalyzeUrl.kt - @js:, {{js}}, <page1,page2>, `, {json options}`,
// per-key query encoding, charset handling.
import { AnalyzeRule } from './analyzeRule.mjs';
import iconv from 'iconv-lite';

const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const paramPattern = /\s*,\s*(?=\{)/;
const pagePattern = /<(.*?)>/g;
const EXP_PATTERN = /\{\{([\w\W]*?)\}\}/g;

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function isEncoded(s) {
  // NetworkUtils.encodedForm / encodedQuery 近似：含 %XX 或 +
  return /%[0-9A-Fa-f]{2}/.test(s) || /\+/.test(s);
}

function encodeComponent(v, charset) {
  if (charset === 'escape') {
    return encodeURIComponent(v).replace(/%20/g, '%20');
  }
  return encodeURIComponent(v);
}

// Per-key encode of `a=1&b=2` (AnalyzeUrl.encodeParams)
function encodeParams(params, charset) {
  const out = [];
  let pos = 0;
  const len = params.length;
  while (pos <= len) {
    let amp = params.indexOf('&', pos);
    if (amp === -1) amp = len;
    const eq = params.indexOf('=', pos);
    let key, value;
    if (eq === -1 || eq > amp) {
      key = params.substring(pos, amp);
      value = null;
    } else {
      key = params.substring(pos, eq);
      value = params.substring(eq + 1, amp);
    }
    const enc = (v) => (isEncoded(v) ? v : encodeComponent(v, charset));
    let seg = enc(key);
    if (value !== null) seg += '=' + enc(value);
    out.push(seg);
    pos = amp + 1;
  }
  return out.join('&');
}

// Heuristic: does this JS-rule body look like a JS program rather than a URL
// fragment? Real sources use both forms in searchUrl:
//   <js>/path,{'method':'POST'};result='';result;</js>      -> URL fragment
//   @js:var u=baseUrl+'/s?q='+key; u                         -> JS program
function looksLikeJs(s) {
  const t = String(s).trim();
  if (!t) return false;
  const startsUrl = /^(\/|https?:\/\/|\.\/)/.test(t);
  // A rule that starts with a url/path is a URL fragment unless it opens with a
  // JS statement keyword; `;result='';result;` at the end is rule plumbing.
  if (startsUrl && !/^(var|let|const|function|return|if|for|while|try)\b/.test(t)) {
    return false;
  }
  if (/^\s*(var|let|const|function|return|try|if|for|while)\b/.test(t)) return true;
  if (/^[A-Za-z_$][\w$.]*\s*=/.test(t)) return true;
  if (/=>/.test(t)) return true;
  if (/\)\s*\(/.test(t)) return true;          // IIFE
  if (/;\s*$/.test(t) && !startsUrl) return true;
  return false;
}

function jsonParseLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // GSON lenient-ish: quote bare keys, single quotes -> double
  try {
    const fixed = text
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => JSON.stringify(p1))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  } catch { return null; }
}

// Find the first `,` that starts a JSON options object. Legacy sources embed the
// options inside an @js expression, so we scan for a balanced `{...}` that
// actually parses instead of trusting the first comma in the string.
function findOptionsStart(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ',') continue;
    const rest = s.substring(i + 1).replace(/^\s+/, '');
    if (!rest.startsWith('{')) continue;
    let depth = 0;
    let inStr = null;
    for (let j = 0; j < rest.length; j++) {
      const c = rest[j];
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = rest.substring(0, j + 1);
          // `{{key}}` inside the object is legal Legado: neutralise the double
          // braces before testing parseability.
          const probe = candidate.replace(/\{\{[\w\W]*?\}\}/g, '__EXP__');
          if (jsonParseLoose(probe)) return i;
          break;
        }
      }
    }
  }
  return -1;
}

export function buildHeaders(source, extra = {}) {
  const h = {};
  const ua = source && source.userAgent ? String(source.userAgent).trim() : '';
  if (ua) h['User-Agent'] = ua;
  else h['User-Agent'] = DEFAULT_UA;
  const raw = source && source.header ? String(source.header).trim() : '';
  if (raw) {
    const obj = jsonParseLoose(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'proxy') continue;
        h[k] = String(v);
      }
    }
  }
  for (const [k, v] of Object.entries(extra || {})) h[k] = String(v);
  return h;
}

export class AnalyzeUrl {
  constructor(ruleUrl, {
    key = '',
    page = 1,
    baseUrl = '',
    source = null,
    book = null,
    chapter = null,
    evalJS = null,
    headerMap = null,
  } = {}) {
    this.rawUrl = String(ruleUrl || '');
    this.key = key == null ? '' : String(key);
    this.page = page || 1;
    this.baseUrl = baseUrl || '';
    this.source = source;
    this.book = book;
    this.chapter = chapter;
    this.url = '';
    this.type = null;
    this.method = 'GET';
    this.body = null;
    this.charset = null;
    this.headers = headerMap ? { ...headerMap } : buildHeaders(source);
    this.evalJS = evalJS || ((js, res) => {
      const ar = new AnalyzeRule({ source, book, chapter, baseUrl: this.baseUrl });
      return ar.evalJS(js, res);
    });
    this._parse();
  }

  _parse() {
    let ruleUrl = this.rawUrl;

    // 1. keyword / page substitution tokens handled by caller for searchUrl templates
    // 2. @js: segments
    ruleUrl = this._analyzeJs(ruleUrl);

    // 3. split off `, {options}` BEFORE {{}} interpolation: the options object
    //    itself often contains {{key}}, and interpolating first would destroy the
    //    braces we need to find.
    let urlPart = ruleUrl;
    const optMatch = findOptionsStart(ruleUrl);
    let optStr = null;
    if (optMatch >= 0) {
      urlPart = ruleUrl.substring(0, optMatch);
      optStr = ruleUrl.substring(optMatch).replace(/^\s*,\s*/, '');
    }

    // 4. {{ js }} on the url part only
    if (urlPart.includes('{{') && urlPart.includes('}}')) {
      urlPart = urlPart.replace(EXP_PATTERN, (_m, js) => {
        const v = this.evalJS(js);
        if (v == null) return '';
        if (typeof v === 'number' && Number.isInteger(v)) return v.toFixed(0);
        return String(v);
      });
    }
    // 5. <page1,page2,...>
    pagePattern.lastIndex = 0;
    urlPart = urlPart.replace(pagePattern, (m, list) => {
      const pages = String(list).split(',');
      if (this.page < pages.length) return pages[this.page - 1].trim();
      return pages[pages.length - 1].trim();
    });

    if (optStr != null) {
      // interpolate {{}} inside the options too (body/header values use it)
      const optResolved = optStr.replace(EXP_PATTERN, (_m, js) => {
        const v = this.evalJS(js);
        if (v == null) return '';
        if (typeof v === 'number' && Number.isInteger(v)) return v.toFixed(0);
        return String(v);
      });
      const opt = jsonParseLoose(optResolved);
      if (opt && typeof opt === 'object') this._applyOptions(opt);
    }

    this.url = this._absolute(this.baseUrl, urlPart.trim());
    if (this.method === 'GET' && this.url.includes('?')) {
      const pos = this.url.indexOf('?');
      const q = this.url.substring(pos + 1);
      this.url = this.url.substring(0, pos + 1) + encodeParams(q, this.charset);
    } else if (this.method === 'POST' && this.body) {
      const bodyTrim = this.body.trim();
      const isJsonBody = bodyTrim.startsWith('{') || bodyTrim.startsWith('[');
      if (!isJsonBody && !this.headers['Content-Type']) {
        this.body = encodeParams(this.body, this.charset);
      }
    }
    return this;
  }

  _applyOptions(opt) {
    if (opt.method) {
      const mm = String(opt.method).toUpperCase();
      this.method = mm === 'POST' || mm === 'HEAD' ? mm : 'GET';
    }
    if (opt.headers && typeof opt.headers === 'object') {
      for (const [k, v] of Object.entries(opt.headers)) this.headers[k] = String(v);
    }
    if (opt.body != null) this.body = String(opt.body);
    if (opt.type != null) this.type = String(opt.type);
    if (opt.charset != null) this.charset = String(opt.charset);
    if (opt.js) {
      const v = this.evalJS(String(opt.js), this.url);
      if (v != null) this.url = String(v);
    }
  }

  _analyzeJs(ruleUrl) {
    let start = 0;
    let result = ruleUrl;
    const matches = [];
    JS_PATTERN.lastIndex = 0;
    let m;
    while ((m = JS_PATTERN.exec(ruleUrl)) !== null) matches.push(m);
    for (const match of matches) {
      if (match.index > start) {
        const seg = ruleUrl.substring(start, match.index).trim();
        if (seg) result = seg.split('@result').join(result);
      }
      const js = match[2] && match[2].length ? match[2] : (match[1] || '');
      // `<js>`/`@js:` bodies in a URL rule are usually the whole rule
      // ("<js>/path,{opts};result='';result;</js>"), not a standalone JS program.
      // Only evaluate the body when it actually looks like JS; otherwise splice
      // it back in as rule text and keep parsing.
      let v;
      if (looksLikeJs(js)) {
        v = this.evalJS(js, result);
        if (v == null) v = '';
        result = String(v);
      } else {
        // Rule text, not JS: strip the `;result='';result;` plumbing that real
        // sources append around a url fragment, then splice it in.
        let body = js.trim();
        body = body.replace(/;?\s*result\s*=\s*(['"])\1\s*;?/g, ';').trim();
        body = body.replace(/;\s*result\s*;?\s*$/, '').trim();
        body = body.replace(/;\s*$/, '');
        result = body ? body.split('@result').join(result) : result;
      }
      start = match.index + match[0].length;
    }
    if (ruleUrl.length > start) {
      const seg = ruleUrl.substring(start).trim();
      if (seg) result = seg.split('@result').join(result);
    }
    return result;
  }

  _absolute(base, url) {
    const s = String(url || '').trim();
    if (!s) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
    if (/^(data|mailto|javascript):/i.test(s)) return s;
    try {
      return new URL(s, base || 'http://localhost/').toString();
    } catch {
      return s;
    }
  }

  // Node's WHATWG URL keeps the query; fetch handles the rest.
  getFetchArgs() {
    const init = { method: this.method, headers: this.headers };
    if (this.method === 'POST' && this.body != null) {
      init.body = this.body;
      if (!Object.keys(this.headers).some((k) => k.toLowerCase() === 'content-type')) {
        const t = this.body.trim();
        this.headers['Content-Type'] = (t.startsWith('{') || t.startsWith('['))
          ? 'application/json'
          : 'application/x-www-form-urlencoded';
      }
    }
    return { url: this.url, init };
  }
}

// Decode a response body honouring charset (meta charset, header, or explicit).
export function decodeBody(buf, headers = {}, explicitCharset = null) {
  let charset = explicitCharset || '';
  if (!charset) {
    const ct = headers['content-type'] || headers['Content-Type'] || '';
    const mm = ct.match(/charset\s*=\s*["']?([\w-]+)/i);
    if (mm) charset = mm[1];
  }
  if (!charset && buf.length > 4) {
    // sniff <meta charset>, limited to the head
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    const m2 = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
    if (m2) charset = m2[1];
  }
  const lower = (charset || '').toLowerCase();
  if (!lower || lower === 'utf-8' || lower === 'utf8') {
    const s = buf.toString('utf8');
    // If it decoded to replacement chars, try gbk
    if (!s.includes('\uFFFD')) return s;
    try { return iconv.decode(buf, 'gbk'); } catch { return s; }
  }
  try {
    if (iconv.encodingExists(lower)) return iconv.decode(buf, lower);
  } catch { /* ignore */ }
  return buf.toString('utf8');
}
