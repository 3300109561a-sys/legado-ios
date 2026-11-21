// Faithful port of io.legado.app.model.analyzeRule.AnalyzeRule + AnalyzeByJSoup.
// Spec: app/src/main/java/io/legado/app/model/analyzeRule/{AnalyzeRule,AnalyzeByJSoup}.kt
// and constant/AppPattern.kt from HapeLee/legado-with-MD3 (GPL-3.0).
//
// Rule syntax (from the APK's own assets/help/ruleHelp.md):
//   @@  default (jsoup CSS) rule        @XPath: / leading "//"
//   @Json: / leading "$."               : regex  (list rules only)
//   {{js}} must carry a rule marker; otherwise it is executed as JS.
import vm from 'node:vm';
import { JSONPath } from 'jsonpath-plus';
import { parseDocument, JNode, resolveUrl } from './html.mjs';
import { makeJavaBridge } from './jsbridge.mjs';

const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const WEBJS_PATTERN = /@webjs:([\w\W]{5,})/gi;
const PUT_PATTERN = /@put:(\{[^}]+?\})/gi;
const EVAL_PATTERN = /@get:\{[^}]+?\}|\{\{[\w\W]*?\}\}/gi;
const INDEX_PATTERN = /\$\d{1,2}/g;

export const Mode = {
  Default: 'Default',
  XPath: 'XPath',
  Json: 'Json',
  Js: 'Js',
  Regex: 'Regex',
  WebJs: 'WebJs',
};

export function isJsonText(s) {
  const t = String(s || '').trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

// ---------------------------------------------------------------- SourceRule
class SourceRule {
  constructor(ruleStr, mode = Mode.Default, ctx = null) {
    this.mode = mode;
    this.rule = '';
    this.replaceRegex = '';
    this.replacement = '';
    this.replaceFirst = false;
    this.putMap = {};
    this.ruleParam = [];
    this.ruleType = [];
    this._ctx = ctx;
    this._init(String(ruleStr ?? ''));
  }

  _init(ruleStr) {
    if (this.mode === Mode.Js || this.mode === Mode.Regex) {
      this.rule = ruleStr;
    } else if (/^@CSS:/i.test(ruleStr)) {
      // isCss: AnalyzeByJSoup strips the marker, AnalyseRule keeps Default
      this.mode = Mode.Default;
      this.rule = ruleStr.substring(5).trim();
    } else if (ruleStr.startsWith('@@')) {
      this.mode = Mode.Default;
      this.rule = ruleStr.substring(2);
    } else if (/^@XPath:/i.test(ruleStr)) {
      this.mode = Mode.XPath;
      this.rule = ruleStr.substring(7);
    } else if (/^@Json:/i.test(ruleStr)) {
      this.mode = Mode.Json;
      this.rule = ruleStr.substring(6);
    } else if ((this._ctx && this._ctx.isJSON) || ruleStr.startsWith('$.') || ruleStr.startsWith('$[')) {
      this.mode = Mode.Json;
      this.rule = ruleStr;
    } else if (ruleStr.startsWith('//') || ruleStr.startsWith('/html') || ruleStr.startsWith('/body')) {
      this.mode = Mode.XPath;
      this.rule = ruleStr;
    } else if (ruleStr.startsWith(':')) {
      // ":" = regex mode, only meaningful for list rules
      this.mode = Mode.Regex;
      this.rule = ruleStr.substring(1);
    } else {
      this.rule = ruleStr;
    }

    this.rule = this._splitPutRule(this.rule);

    let start = 0;
    let tmp;
    EVAL_PATTERN.lastIndex = 0;
    const first = EVAL_PATTERN.exec(this.rule);
    if (first) {
      tmp = this.rule.substring(start, first.index);
      if (this.mode !== Mode.Js && this.mode !== Mode.Regex &&
          (first.index === 0 || !tmp.includes('##'))) {
        // 2.x bodiless-## convention: a rule with {{}} / @get and no explicit
        // marker is treated as a regex rule whose match feeds the replacement.
        this.mode = Mode.Regex;
      }
    }
    EVAL_PATTERN.lastIndex = 0;
    let m;
    while ((m = EVAL_PATTERN.exec(this.rule)) !== null) {
      if (m.index > start) this._splitRegex(this.rule.substring(start, m.index));
      const tok = m[0];
      if (/^@get:/i.test(tok)) {
        this.ruleType.push(-2);
        this.ruleParam.push(tok.substring(6, tok.length - 1));
      } else if (tok.startsWith('{{')) {
        this.ruleType.push(-1);
        this.ruleParam.push(tok.substring(2, tok.length - 2));
      } else {
        this._splitRegex(tok);
      }
      start = m.index + tok.length;
    }
    if (this.rule.length > start) this._splitRegex(this.rule.substring(start));
  }

  _hasRegexMarker(s) {
    // A rule explicitly selecting elements never gets forced into Regex mode
    const head = String(s).split('##')[0].trim();
    if (!head) return false;
    if (/^(\.|#|\[)/.test(head)) return false;                    // css
    if (/^@/.test(head)) return true;
    if (head.startsWith('$.') || head.startsWith('$[')) return true;
    if (/^\//.test(head)) return true;
    return true;
  }

  _splitPutRule(ruleStr) {
    let v = ruleStr;
    PUT_PATTERN.lastIndex = 0;
    const found = [];
    let m;
    while ((m = PUT_PATTERN.exec(ruleStr)) !== null) found.push(m[0]);
    for (const tok of found) {
      v = v.split(tok).join('');
      try {
        const obj = JSON.parse(tok.slice(5));
        if (obj && typeof obj === 'object') Object.assign(this.putMap, obj);
      } catch { /* strict GSON failure path: ignore */ }
    }
    return v;
  }

  _splitRegex(ruleStr) {
    let start = 0;
    const arr = String(ruleStr).split('##');
    const head = arr[0];
    INDEX_PATTERN.lastIndex = 0;
    if (INDEX_PATTERN.exec(head) !== null && this.mode !== Mode.Js && this.mode !== Mode.Regex) {
      this.mode = Mode.Regex;
    }
    INDEX_PATTERN.lastIndex = 0;
    let m;
    while ((m = INDEX_PATTERN.exec(head)) !== null) {
      if (m.index > start) {
        this.ruleType.push(0);
        this.ruleParam.push(ruleStr.substring(start, m.index));
      }
      this.ruleType.push(parseInt(m[0].substring(1), 10));
      this.ruleParam.push(m[0]);
      start = m.index + m[0].length;
    }
    if (ruleStr.length > start) {
      this.ruleType.push(0);
      this.ruleParam.push(ruleStr.substring(start));
    }
  }

  makeUpRule(result) {
    for (const [k, v] of Object.entries(this.putMap || {})) {
      if (this._ctx) this._ctx.putVar(k, this._ctx.contentString(v));
    }
    if (this.ruleParam.length) {
      let out = '';
      let i = this.ruleParam.length;
      while (i-- > 0) {
        const t = this.ruleType[i];
        if (t > 0) {
          if (Array.isArray(result) && result.length > t && result[t] != null) out = String(result[t]) + out;
          else out = this.ruleParam[i] + out;
        } else if (t === -1) {
          const v = this._ctx ? this._ctx.jsEval(this.ruleParam[i], result) : null;
          if (v == null) { /* empty */ }
          else if (typeof v === 'number' && Number.isInteger(v)) out = v.toFixed(0) + out;
          else out = String(v) + out;
        } else if (t === -2) {
          out = (this._ctx ? this._ctx.getVar(this.ruleParam[i]) : '') + out;
        } else {
          out = this.ruleParam[i] + out;
        }
      }
      this.rule = out;
    }
    const parts = this.rule.split('##');
    this.rule = (parts[0] || '').trim();
    if (parts.length > 1) this.replaceRegex = parts[1];
    if (parts.length > 2) this.replacement = parts[2];
    if (parts.length > 3) this.replaceFirst = true;
  }

  getParamSize() { return this.ruleParam.length; }
}

// ------------------------------------------------------------ jsoup select
// Port of ElementsSingle.getElementsSingle + index filtering.
function selectElements(root, rule) {
  const { beforeRule, indexSpec, isExclude } = parseRuleIndex(rule);
  const sel = parseSelectorRule(beforeRule);
  let elements;
  if (!beforeRule || sel.kind === 'children') {
    elements = root.children();
  } else if (sel.kind === 'class') {
    elements = root.select('.' + sel.arg);
  } else if (sel.kind === 'tag') {
    elements = root.select(sel.arg || '*');
  } else if (sel.kind === 'id') {
    elements = root.select('#' + sel.arg);
  } else if (sel.kind === 'text') {
    elements = root.select('*').filter((e) => e.ownText().includes(sel.arg));
  } else {
    elements = root.select(sel.arg);
  }
  return applyIndex(elements, indexSpec, isExclude);
}

function parseRuleIndex(rule) {
  const s = String(rule || '').trim();
  let beforeRule = s;
  let indexSpec = null;
  let isExclude = false;
  // Legado's own `tag.`/`class.`/`id.`/`children.`/`text.` selector syntax with a
  // trailing `.<n>` or `!<n>` index (`tag.div.1`, `tag.div!0:3`). A plain CSS
  // selector keeps CSS meaning, so `[...]` is left to css-select.
  const legacy = /^(tag|class|id|children|text)((?:\.[^.!]+)*)([.!])(-?\d+)$/.exec(s);
  if (legacy) {
    beforeRule = legacy[1] + legacy[2];
    indexSpec = legacy[4];
    isExclude = legacy[3] === '!';
  }
  return { beforeRule, indexSpec, isExclude };
}

function parseSelectorRule(rule) {
  // `tag.div`, `class.item`, `id.main`, `children`. A segment that is not one of
  // these is a plain CSS selector and is handed to css-select unchanged.
  // Note: `.` is also a CSS class separator, so `tag.div.x` means tag=div,
  // class=x per ElementsSingle(beforeRule="tag.div.x") -> rules[0]=="tag".
  const parts = String(rule).split('.');
  const head = parts[0];
  if (head === 'tag' && parts[1]) return { kind: 'tag', arg: parts[1] };
  if (head === 'class' && parts[1]) return { kind: 'class', arg: parts[1] };
  if (head === 'id' && parts[1]) return { kind: 'id', arg: parts[1] };
  if (head === 'children') return { kind: 'children', arg: '' };
  if (head === 'text' && parts[1]) return { kind: 'text', arg: parts.slice(1).join('.') };
  return { kind: 'css', arg: String(rule) };
}

function applyIndex(elements, spec, isExclude) {
  if (spec == null) return elements;
  const len = elements.length;
  const picked = [];
  const seen = new Set();
  const groups = spec.split(',').map((x) => x.trim()).filter(Boolean);
  for (const g of groups) {
    if (g.includes(':')) {
      const seg = g.split(':').map((x) => x.trim());
      let start = seg[0] === '' ? 0 : Number(seg[0]);
      let end = seg[1] === '' || seg[1] === undefined ? len - 1 : Number(seg[1]);
      let step = seg[2] === undefined || seg[2] === '' ? 1 : Number(seg[2]);
      if (start < 0) start += len;
      if (end < 0) end += len;
      if (start === 0 && end === len - 1 && step === -1) {
        for (let i = len - 1; i >= 0; i--) if (!seen.has(i)) { seen.add(i); picked.push(i); }
        continue;
      }
      start = Math.max(0, Math.min(start, len - 1));
      end = Math.max(0, Math.min(end, len - 1));
      if (step <= 0) step = 1;
      if (end >= start) for (let i = start; i <= end; i += step) { if (!seen.has(i)) { seen.add(i); picked.push(i); } }
      else for (let i = start; i >= end; i -= step) { if (!seen.has(i)) { seen.add(i); picked.push(i); } }
    } else {
      let i = Number(g);
      if (i < 0) i += len;
      if (i >= 0 && i < len && !seen.has(i)) { seen.add(i); picked.push(i); }
    }
  }
  picked.sort((a, b) => a - b);
  if (isExclude) return elements.filter((_, i) => !seen.has(i));
  return picked.map((i) => elements[i]);
}

// -------------------------------------------------------------- AnalyzeRule
export class AnalyzeRule {
  constructor({ source = null, book = null, chapter = null, baseUrl = '', key = '', page = 1, ruleName = '' } = {}) {
    this.source = source;
    this.book = book;
    this.chapter = chapter;
    this.baseUrl = baseUrl || '';
    this.key = key;
    this.page = page;
    this.ruleName = ruleName;
    this.content = null;
    this.isJSON = false;
    this.isRegex = false;
    this._vars = new Map();
    this._doc = null;
    this._java = makeJavaBridge(this);
    this._syncFetch = null;
  }

  setContent(content, baseUrl) {
    if (content == null) throw new Error('内容不可空（Content cannot be null）');
    this.content = content;
    this.isJSON = !(content instanceof JNode) && isJsonText(String(content));
    if (baseUrl) this.baseUrl = baseUrl;
    this._doc = null;
    return this;
  }

  setBaseUrl(u) { if (u) this.baseUrl = u; return this; }

  put(k, v) { this._vars.set(k, v); return v; }
  get(k) {
    if (k === 'bookName') return (this.book && this.book.name) || '';
    if (k === 'title') return (this.chapter && this.chapter.title) || '';
    return this._vars.get(k) || '';
  }

  // hooks used by SourceRule
  jsEval(js, result) { return this.evalJS(js, result); }
  getVar(k) { return this.get(k); }
  putVar(k, v) { return this.put(k, v); }
  // AnalyzeRule.putRule evaluates each @put value as a rule first
  contentString(v) {
    try { return String(this.getString(String(v))); } catch { return String(v); }
  }

  // ---- rule splitting ----
  splitSourceRule(ruleStr, allInOne = false) {
    if (!ruleStr) return [];
    const list = [];
    let mMode = Mode.Default;
    let start = 0;
    if (allInOne && ruleStr.startsWith(':')) {
      mMode = Mode.Regex;
      this.isRegex = true;
      start = 1;
    } else if (this.isRegex) {
      mMode = Mode.Regex;
    }
    const mk = (txt, mode, raw) => {
      const sr = new SourceRule(raw ? '' : txt, raw ? mode : mode, this);
      if (raw) {
        sr.rule = txt;
        sr.mode = mode;
        sr.replaceRegex = '';
        sr.replacement = '';
        sr.replaceFirst = false;
        sr.putMap = {};
        sr.ruleParam = [];
        sr.ruleType = [];
      }
      return sr;
    };

    const jsMatches = [];
    JS_PATTERN.lastIndex = 0;
    let m;
    while ((m = JS_PATTERN.exec(ruleStr)) !== null) jsMatches.push(m);
    for (const js of jsMatches) {
      if (js.index > start) {
        const t = ruleStr.substring(start, js.index).trim();
        if (t) list.push(mk(t, mMode, false));
      }
      const body = js[2] && js[2].length ? js[2] : (js[1] || '');
      list.push(mk(body, Mode.Js, true));
      start = js.index + js[0].length;
    }
    if (ruleStr.length > start) {
      const t = ruleStr.substring(start).trim();
      if (t) list.push(mk(t, mMode, false));
    }
    return list;
  }

  // ---- regex replacement ----
  _replaceRegex(result, sr) {
    if (!sr.replaceRegex) return result;
    let re = null;
    try { re = new RegExp(sr.replaceRegex); } catch { re = null; }
    if (sr.replaceFirst) {
      if (re) {
        const mm = String(result).match(re);
        return mm ? String(mm[0]).replace(re, sr.replacement) : '';
      }
      return sr.replacement;
    }
    if (re) return String(result).replace(re, sr.replacement);
    return String(result).split(sr.replaceRegex).join(sr.replacement);
  }

  _mapReplace(result, sr) {
    if (Array.isArray(result)) return result.map((r) => this._replaceRegex(String(r), sr));
    return this._replaceRegex(String(result), sr);
  }

  // ---- JS ----
  evalJS(jsStr, result) {
    const sandbox = this._sandbox(result);
    const ctx = vm.createContext(sandbox, { name: 'legado-rule' });
    const out = vm.runInContext(String(jsStr), ctx, { timeout: 15000, displayErrors: true });
    if (out === undefined) return null;
    return out;
  }

  _sandbox(result) {
    const src = this.source || {};
    const bk = this.book || {};
    const ch = this.chapter || {};
    return {
      console: { log() {}, error() {}, warn() {}, info() {} },
      java: this._java,
      key: this.key,
      page: this.page,
      // legacy Legado 2.x aliases still used by older sources
      searchKey: this.key,
      searchPage: this.page,
      cookie: { getCookie: () => (src.cookieString || ''), setCookie() {}, removeCookie() {} },
      cache: { get: () => null, put() {}, delete() {} },
      source: {
        bookSourceName: src.bookSourceName || '',
        bookSourceUrl: src.bookSourceUrl || '',
        bookSourceGroup: src.bookSourceGroup || '',
        getKey: () => src.bookSourceUrl || '',
        getTag: () => src.bookSourceUrl || '',
        getVariable: () => (src.variable || ''),
        setVariable: (v) => { src.variable = v; },
        getLoginInfo: () => (src.loginInfo || null),
        getLoginInfoMap: () => (src.loginInfo || {}),
        getLoginHeader: () => (src.loginHeader || null),
        putLoginHeader: (h) => { src.loginHeader = h; },
        getHeaderMap: () => '{}',
        getExploreUrl: () => src.exploreUrl || '',
        getBookSourceUrl: () => src.bookSourceUrl || '',
        getBookSourceType: () => src.bookSourceType ?? 0,
        enabledCookieJar: !!src.enabledCookieJar,
      },
      book: {
        name: bk.name || '',
        author: bk.author || '',
        bookUrl: bk.bookUrl || '',
        getName: () => bk.name || '',
        getAuthor: () => bk.author || '',
        getBookUrl: () => bk.bookUrl || '',
        getUrl: () => bk.bookUrl || '',
        getCoverUrl: () => bk.coverUrl || '',
        getIntro: () => bk.intro || '',
        getKind: () => bk.kind || '',
        getTotalChapterNum: () => bk.totalChapterNum || 0,
        getLatestChapterTitle: () => bk.latestChapterTitle || '',
        getVariable: (k) => (this.book && this.book.variableMap ? this.book.variableMap.get(k) : ''),
        putVariable: (k, v) => (this.book && this.book.variableMap ? this.book.variableMap.put(k, v) : v),
        getVariableMap: () => ({
          get: (k) => (this.book && this.book.variableMap ? this.book.variableMap.get(k) : ''),
          put: (k, v) => (this.book && this.book.variableMap ? this.book.variableMap.put(k, v) : v),
        }),
      },
      chapter: {
        title: ch.title || '',
        index: ch.index ?? 0,
        url: ch.url || '',
        getTitle: () => ch.title || '',
        getIndex: () => ch.index ?? 0,
        getUrl: () => ch.url || '',
        getVariable: (k) => (this.chapter && this.chapter.variableMap ? this.chapter.variableMap.get(k) : ''),
        putVariable: (k, v) => (this.chapter && this.chapter.variableMap ? this.chapter.variableMap.put(k, v) : v),
      },
      result: toPlain(result),
      baseUrl: this.baseUrl,
      title: ch.title || '',
      src: typeof this.content === 'string' ? this.content : (this.content ? String(this.content) : ''),
      nextChapterUrl: '',
      fromBookInfo: false,
      rssArticle: null,
      Packages: {
        java: {
          lang: { System: { currentTimeMillis: () => Date.now() } },
          util: { Base64: { getDecoder: () => ({ decode: (s) => Buffer.from(String(s), 'base64').toString('utf8') }) } },
        },
      },
    };
  }

  // ---- content dispatch ----
  _docOf(content) {
    if (content instanceof JNode) return content;
    if (content === this.content && this._doc) return this._doc;
    const d = parseDocument(String(content), this.baseUrl);
    if (content === this.content) this._doc = d;
    return d;
  }

  _jsonPath(content, path) {
    let json = content;
    if (typeof json === 'string') { try { json = JSON.parse(json); } catch { return undefined; } }
    try {
      return JSONPath({ path, json, wrap: false, flatten: false, autostart: true });
    } catch { return undefined; }
  }

  // AnalyzeByRegex.getElements last segment: one group array per match
  _regexMatchGroups(text, pattern) {
    let re;
    try { re = new RegExp(pattern, 'g'); } catch { return []; }
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push([...m]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  _regexFindAll(text, rule) {
    const parts = String(rule).split('##');
    const pattern = parts[0];
    const template = parts.length > 1 ? parts[1] : '';
    let re;
    try { re = new RegExp(pattern, 'g'); } catch { return []; }
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (template) {
        let t = template;
        for (let i = m.length - 1; i >= 0; i--) t = t.split('$' + i).join(m[i] ?? '');
        out.push(t);
      } else {
        out.push(m[0]);
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  }

  // getElement (AnalyzeRule.getElement): single element, used by java.getElement
  getElement(ruleStr, mContent = null) {
    if (!ruleStr) return null;
    const list = this.splitSourceRule(ruleStr, true);
    let result = mContent != null ? mContent : this.content;
    for (const sr of list) {
      sr.makeUpRule(result);
      if (result == null) return null;
      const r = sr.rule;
      if (!r) continue;
      if (sr.mode === Mode.Js) {
        result = this.evalJS(r, result);
      } else if (sr.mode === Mode.Regex) {
        const text = typeof result === 'string' ? result : this._docOf(result).outerHtml();
        const found = this._regexFindAll(text, r);
        result = found.length ? this._docOf(found[0]) : null;
      } else if (sr.mode === Mode.Json) {
        const v = this._jsonPath(result, r);
        result = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      } else {
        // Only the selector part participates in element selection; a trailing
        // `@text`/`@href` describes extraction, and getElement returns elements.
        const selector = r.split('@')[0];
        const els = selectElements(this._docOf(result), selector);
        result = els.length ? els[0] : null;
      }
      if (result != null && sr.replaceRegex) result = this._replaceRegex(String(result), sr);
    }
    if (result instanceof JNode) return result;
    return result;
  }

  // getElements (list rules: chapterList / bookList)
  getElements(ruleStr) {
    if (!ruleStr) return [];
    const list = this.splitSourceRule(ruleStr, true);
    let result = this.content;
    for (const sr of list) {
      sr.makeUpRule(result);
      if (result == null) continue;
      const r = sr.rule;
      if (!r) continue;
      if (sr.mode === Mode.Js) {
        result = this.evalJS(r, result);
      } else if (sr.mode === Mode.Regex) {
        const text = typeof result === 'string' ? result : this._docOf(result).outerHtml();
        // AnalyzeByRegex.getElements: the final "&&" segment yields one group
        // array per match; earlier segments concatenate matches and feed on.
        const regs = r.split('&&').map((x) => x.trim()).filter(Boolean);
        let texts = [text];
        let groups = null;
        for (let i = 0; i < regs.length; i++) {
          const isLast = i === regs.length - 1;
          if (isLast) {
            groups = [];
            for (const t of texts) groups.push(...this._regexMatchGroups(t, regs[i]));
          } else {
            const next = [];
            for (const t of texts) next.push(this._regexMatchGroups(t, regs[i]).map((g) => g[0]).join(''));
            texts = next;
          }
        }
        result = groups || [];
      } else if (sr.mode === Mode.Json) {
        const v = this._jsonPath(result, r);
        result = Array.isArray(v) ? v : (v == null ? [] : [v]);
      } else {
        result = selectElements(this._docOf(result), r);
      }
      if (sr.replaceRegex) result = this._mapReplace(result, sr);
    }
    if (Array.isArray(result)) return result;
    if (result == null) return [];
    return [result];
  }

  // getStringList
  getStringList(ruleStr, mContent = null) {
    if (!ruleStr) return [];
    const list = this.splitSourceRule(ruleStr);
    let result = mContent != null ? mContent : this.content;
    if (result == null || !list.length) return [];
    for (const sr of list) {
      if (sr.mode === Mode.Js) {
        // A bare `@js:` rule (via a leading `@attr`) must see the value the
        // previous rule produced, as Legado's Rhino binding does.
        if (result != null) this.content = result;
        result = this.evalJS(sr.rule, result);
        continue;
      }
      sr.makeUpRule(result);
      if (result == null) break;
      const r = sr.rule;
      if (r) {
        if (sr.mode === Mode.Js) result = this.evalJS(r, result);
        else if (sr.mode === Mode.Regex) {
          const text = typeof result === 'string' ? result : this._docOf(result).outerHtml();
          result = this._regexFindAll(text, r);
        } else if (sr.mode === Mode.Json) {
          const v = this._jsonPath(result, r);
          result = Array.isArray(v) ? v : (v == null ? [] : [v]);
        } else {
          result = this._selectList(this._docOf(result), r);
        }
      }
      if (sr.replaceRegex) result = this._mapReplace(result, sr);
    }
    if (result == null) return [];
    if (typeof result === 'string') return result.split('\n').filter((x) => x !== '');
    return (Array.isArray(result) ? result : [result]).map((x) => (x == null ? '' : String(x)));
  }

  // jsoup getResultList/getResultLast -> list of strings
  _selectList(doc, rule) {
    const raw = String(rule);
    // RuleAnalyzer.trim() strips a leading "@" (and whitespace) before splitting,
    // so "@onclick" means "the onclick attribute of the current element", not
    // "#document@onclick". Real sources rely on this: `bookUrl: "@onclick@js:..."`.
    const hadLeadingAt = /^\s*@/.test(raw);
    const cleaned = hadLeadingAt ? raw.replace(/^\s*@+/, '') : raw;
    const segs = cleaned.split('@');
    const last = segs.pop() || 'text';
    let els = [doc];
    if (hadLeadingAt) {
      // no selector: the rule applies to the element(s) the caller scoped us to
      els = (doc && doc.name && doc.name !== '#document' && doc.name !== '#text') ? [doc] : doc.select('*');
    }
    if (segs.length) {
      const next = [];
      for (const seg of segs) {
        for (const e of els) next.push(...selectElements(e, seg));
      }
      els = next;
    }
    const out = [];
    for (const e of els) {
      const v = extractLast(e, last);
      if (v !== null && v !== '') out.push(v);
    }
    return out;
  }

  // getString
  getString(ruleStr, mContent = null, isUrl = false, unescape = true) {
    if (!ruleStr) return '';
    const list = this.splitSourceRule(ruleStr);
    let result = mContent != null ? mContent : this.content;
    if (result == null || !list.length) return isUrl ? (this.baseUrl || '') : '';
    for (const sr of list) {
      if (sr.mode === Mode.Js && !sr.ruleParam.length) {
        // A bare `@js:` segment (reached via a leading `@attr`) must see the
        // value the previous segment produced: Legado binds `result` (and `src`)
        // to the running value at each step, and sources like
        //   `@onclick@js:result.match(...)[1]`
        // rely on that. sr.ruleParam is empty because the whole `@js:` body is
        // the segment itself, not a `{{}}` interpolation.
        if (result != null) this.content = result;
      }
      sr.makeUpRule(result);
      if (result == null) continue;
      const r = sr.rule;
      if (r || !sr.replaceRegex) {
        if (sr.mode === Mode.Js) {
          result = this.evalJS(r, result);
        } else if (sr.mode === Mode.Regex) {
          const text = typeof result === 'string' ? result : this._docOf(result).outerHtml();
          const found = this._regexFindAll(text, r);
          result = found.length ? found.join('\n') : '';
        } else if (sr.mode === Mode.Json) {
          const v = this._jsonPath(result, r);
          result = v == null ? '' : (Array.isArray(v) ? v.filter((x) => x != null && x !== '').join('\n') : v);
        } else {
          const found = this._selectList(this._docOf(result), r);
          result = found.join('\n');
        }
      }
      if (result != null && sr.replaceRegex) result = this._replaceRegex(String(result), sr);
    }
    let str = result == null ? '' : (result instanceof JNode ? result.text() : String(result));
    if (unescape && str.includes('&')) str = unescapeHtml4(str);
    if (isUrl) {
      // AnalyzeRule.getString(isUrl=true) resolves exactly one value. The jsoup
      // path uses getString0 (first match only); joining would corrupt the URL.
      const first = str.split('\n').find((x) => x.trim()) || '';
      return first.trim() ? resolveUrl(first.trim(), this.baseUrl) : (this.baseUrl || '');
    }
    return str;
  }

  // getString with explicit Mode.Regex / Json applied to raw element
  getStringWithContent(ruleStr, content) {
    const ar = new AnalyzeRule({
      source: this.source, book: this.book, chapter: this.chapter,
      baseUrl: this.baseUrl, key: this.key, page: this.page,
    });
    ar._syncFetch = this._syncFetch;
    ar.setContent(content, this.baseUrl);
    return ar.getString(ruleStr);
  }
}

function extractLast(el, last) {
  if (last === 'text') return el.text();
  if (last === 'ownText') return el.ownText();
  if (last === 'textNodes') {
    const tn = el.textNodes();
    return tn || null;
  }
  if (last === 'html') {
    let h = el.outerHtml();
    h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    return h;
  }
  if (last === 'all') return el.outerHtml();
  if (!last) return el.text();
  // `attr(spec)` filtered attributes: Legado skips blank / duplicate values
  const m = last.match(/^([A-Za-z_:][\w:.-]*)\(([\w,]+)\)$/);
  const name = m ? m[1] : last;
  const v = el.attr(name);
  return v === '' ? null : v;
}

export function unescapeHtml4(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', mdash: '\u2014' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.substring(2), 16)
        : parseInt(body.substring(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code); } catch { return all; }
      }
      return all;
    }
    const v = named[body.toLowerCase()];
    return v === undefined ? all : v;
  });
}

function toPlain(v) {
  if (v instanceof JNode) return v.text();
  if (Array.isArray(v)) return v.map(toPlain);
  return v;
}

export { SourceRule, selectElements };
