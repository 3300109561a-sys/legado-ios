// Book source pipeline: search / bookInfo / toc / content.
// Mirrors io.legado.app.model.webBook.WebBook + BookSourceExtensions rules.
import { AnalyzeRule } from './analyzeRule.mjs';
import { AnalyzeUrl, decodeBody } from './analyzeUrl.mjs';
import { SyncFetcher } from './syncfetch.mjs';
import { parseDocument, JNode, resolveUrl } from './html.mjs';

let fetcher = null;
function getFetcher() {
  if (!fetcher) fetcher = new SyncFetcher();
  return fetcher;
}

// ---- variable maps (book/chapter level @put/@get) ----
class VarMap {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.get(k) || ''; }
  put(k, v) { this.m.set(k, v); return v; }
  toObject() { return Object.fromEntries(this.m); }
  load(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) this.m.set(k, v); }
}

export class RuleContext {
  constructor(source, { book = null, chapter = null } = {}) {
    this.source = source;
    this.book = book || { variableMap: new VarMap() };
    this.chapter = chapter || { variableMap: new VarMap() };
    this.source_vars = new VarMap();
    if (!this.book.variableMap) this.book.variableMap = new VarMap();
    if (!this.chapter.variableMap) this.chapter.variableMap = new VarMap();
  }

  newAnalyzeRule(baseUrl = '') {
    const ar = new AnalyzeRule({
      source: this.source,
      book: this.book,
      chapter: this.chapter,
      baseUrl,
    });
    // route java.put/get through the chapter/book/source chain like AnalyzeRule.put/get
    ar.put = (k, v) => {
      if (this.chapter && this.chapter.variableMap) this.chapter.variableMap.put(k, v);
      else if (this.book && this.book.variableMap) this.book.variableMap.put(k, v);
      else this.source_vars.put(k, v);
      return v;
    };
    ar.get = (k) => {
      if (k === 'bookName') return this.book.name || '';
      if (k === 'title') return this.chapter.title || '';
      return (this.chapter.variableMap && this.chapter.variableMap.get(k))
        || (this.book.variableMap && this.book.variableMap.get(k))
        || this.source_vars.get(k)
        || '';
    };
    ar._syncFetch = (url, header, body) => this.fetchRaw(url, header, body);
    return ar;
  }

  // blocking fetch used by java.ajax / java.connect
  fetchRaw(url, header, body) {
    try {
      const headers = { ...this.headersForRequest() };
      if (header) {
        const parsed = typeof header === 'string' ? safeJson(header) : header;
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (k === 'method') continue;
          }
          if (parsed.method) { /* method handled by caller signature */ }
          else for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
        }
      }
      let method = 'GET';
      let payload = body;
      if (header && typeof header === 'string' && header.includes('{')) {
        const parsed = safeJson(header);
        if (parsed && parsed.method) method = String(parsed.method).toUpperCase();
        if (parsed && parsed.body != null) payload = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
      }
      const r = getFetcher().request(url, { method, headers, body: payload, timeout: 30000 });
      return decodeBody(r.bodyBuffer, r.headers);
    } catch {
      return '';
    }
  }

  headersForRequest(extra) {
    const h = {};
    const ua = this.source.userAgent ? String(this.source.userAgent).trim() : '';
    h['User-Agent'] = ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const raw = this.source.header ? String(this.source.header).trim() : '';
    if (raw) {
      const obj = safeJson(raw);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'proxy') continue;
          h[k] = String(v);
        }
      }
    }
    if (this.source.hasLogin && this.source.loginHeader) {
      const lh = safeJson(this.source.loginHeader);
      if (lh && typeof lh === 'object') for (const [k, v] of Object.entries(lh)) h[k] = String(v);
    }
    return { ...h, ...(extra || {}) };
  }

  // Resolve a URL rule then fetch it (AnalyzeUrl + StrResponse)
  fetchUrl(ruleUrl, { key = '', page = 1, baseUrl = '' } = {}) {
    const ar = this.newAnalyzeRule(baseUrl || this.source.bookSourceUrl || '');
    const au = new AnalyzeUrl(ruleUrl, {
      key,
      page,
      baseUrl: baseUrl || this.source.bookSourceUrl || '',
      source: this.source,
      book: this.book,
      chapter: this.chapter,
      headerMap: this.headersForRequest(),
      evalJS: (js, res) => ar.evalJS(js, res),
    });
    const { url, init } = au.getFetchArgs();
    const r = getFetcher().request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeout: 30000,
    });
    const body = decodeBody(r.bodyBuffer, r.headers, au.charset);
    // detect final url for relative resolution
    const finalUrl = r.url || url;
    return { body, url: finalUrl, status: r.status, headers: r.headers };
  }

  // getStringList with @put support
  getStringList(rule, content, baseUrl) {
    const ar = this.newAnalyzeRule(baseUrl);
    const list = ar.getStringList(rule, content);
    return list || [];
  }

  getString(rule, content, baseUrl, isUrl = false) {
    const ar = this.newAnalyzeRule(baseUrl);
    return ar.getString(rule, content, isUrl);
  }
}

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { /* lenient */ }
  try {
    const fixed = String(s)
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => JSON.stringify(p1))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  } catch { return null; }
}

// ---- search ----
export function searchBook(source, key, page = 1) {
  const ctx = new RuleContext(source);
  const rule = source.searchUrl || '';
  if (!rule) return [];

  let finalRule = rule;
  if (rule.includes('{{key}}') || rule.includes('{{searchKey}}')) {
    const enc = encodeURIComponent(key);
    finalRule = rule.split('{{key}}').join(enc).split('{{searchKey}}').join(enc);
  }
  const resp = ctx.fetchUrl(finalRule, { key, page, baseUrl: source.bookSourceUrl });
  const content = resp.body;

  ctx.book = { name: key, author: '', bookUrl: '', variableMap: new VarMap() };
  const rules = source.ruleSearch || {};
  const bookListRule = rules.bookList || '';
  let bookList;
  if (bookListRule) {
    const ar = ctx.newAnalyzeRule(resp.url);
    ar.setContent(content, resp.url);
    const els = ar.getElements(bookListRule);
    bookList = els.map((e) => unwrap(e, resp.url));
  } else {
    bookList = [new JNode(parseDocument(content, resp.url).node, resp.url)];
  }

  const results = [];
  for (const item of bookList) {
    const isNode = item instanceof JNode || (item && typeof item.select === 'function');
    if (isNode) {
      const ar = ctx.newAnalyzeRule(resp.url);
      ar.setContent(item, resp.url);
      const get = (r) => { try { return ar.getString(r); } catch { return ''; } };
      const getAbs = (r) => { try { return ar.getString(r, null, true); } catch { return ''; } };
      const b = {};
      b.name = get(rules.name || '');
      b.author = get(rules.author || '');
      b.bookUrl = getAbs(rules.bookUrl || '');
      b.coverUrl = getAbs(rules.coverUrl || '');
      b.intro = get(rules.intro || '');
      b.kind = get(rules.kind || '');
      b.lastChapter = get(rules.lastChapter || '');
      b.wordCount = get(rules.wordCount || '');
      if (b.name) results.push(b);
    } else {
      // JSON object item
      const ar = ctx.newAnalyzeRule(resp.url);
      ar.setContent(content, resp.url);
      const getFrom = (r) => {
        if (!r) return '';
        try { return ar.getString(r, item); } catch { return ''; }
      };
      const b = {};
      for (const f of ['name', 'author', 'bookUrl', 'coverUrl', 'intro', 'kind', 'lastChapter', 'wordCount']) {
        b[f] = getFrom(rules[f] || '');
      }
      if (b.bookUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(b.bookUrl)) {
        b.bookUrl = resolveUrl(b.bookUrl, resp.url);
      }
      if (b.coverUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(b.coverUrl)) {
        b.coverUrl = resolveUrl(b.coverUrl, resp.url);
      }
      if (b.name) results.push(b);
    }
  }
  return results;
}

function unwrap(e, baseUrl) {
  if (e && typeof e.select === 'function') {
    e.baseUrl = e.baseUrl || baseUrl;
    return e;
  }
  return e;
}

function getUrl(v) {
  const s = String(v || '').trim();
  return s;
}

// ---- book info ----
export function getBookInfo(source, book) {
  const ctx = new RuleContext(source, { book });
  const rule = source.ruleBookInfo || {};
  const urlRule = rule.init || '';
  const resp = ctx.fetchUrl(urlRule || book.bookUrl, { baseUrl: source.bookSourceUrl });
  const ar = ctx.newAnalyzeRule(resp.url);
  ar.setContent(resp.body, resp.url);
  const get = (r) => { if (!r) return ''; try { return ar.getString(r); } catch { return ''; } };

  const out = { ...book };
  if (rule.name) out.name = get(rule.name) || out.name;
  if (rule.author) out.author = get(rule.author) || out.author;
  if (rule.intro) out.intro = get(rule.intro);
  if (rule.kind) out.kind = get(rule.kind);
  if (rule.lastChapter) out.lastChapterTitle = get(rule.lastChapter);
  if (rule.coverUrl) out.coverUrl = get(rule.coverUrl);
  if (rule.wordCount) out.wordCount = get(rule.wordCount);
  if (rule.tocUrl) {
    const t = get(rule.tocUrl);
    if (t) out.tocUrl = t;
  } else {
    out.tocUrl = resp.url;
  }
  out.variableMap = ctx.book.variableMap;
  return out;
}

// ---- TOC ----
export function getChapterList(source, book) {
  const ctx = new RuleContext(source, { book });
  const rule = source.ruleToc || {};
  // ruleToc.chapterUrl is the chapter *link* rule; the TOC page comes from tocUrl.
  const tocPage = book.tocUrl || book.bookUrl;
  const resp = ctx.fetchUrl(tocPage, { baseUrl: source.bookSourceUrl });
  const ar = ctx.newAnalyzeRule(resp.url);
  ar.setContent(resp.body, resp.url);

  const listRule = rule.chapterList || '';
  const elements = listRule ? ar.getElements(listRule) : [];
  const chapters = [];
  let i = 0;
  for (const el of elements) {
    const isNode = el && typeof el.select === 'function';
    const sub = ctx.newAnalyzeRule(resp.url);
    let title = '';
    let url2 = '';
    if (isNode) {
      sub.setContent(el, resp.url);
      title = safe(() => sub.getString(rule.chapterName || ''));
      url2 = safe(() => sub.getString(rule.chapterUrl || '', null, true));
    } else {
      sub.setContent(resp.body, resp.url);
      title = safe(() => sub.getString(rule.chapterName || '', el));
      url2 = safe(() => sub.getString(rule.chapterUrl || '', el, true));
    }
    if (!url2) continue;
    chapters.push({
      title: title || `第${i + 1}章`,
      url: url2,
      index: i,
      bookUrl: book.bookUrl,
    });
    i++;
  }
  return chapters;
}

function safe(fn) { try { return fn(); } catch { return ''; } }

// ---- content ----
export function getBookContent(source, book, chapter) {
  const ctx = new RuleContext(source, { book, chapter });
  const rule = source.ruleContent || {};
  const resp = ctx.fetchUrl(chapter.url, { baseUrl: source.bookSourceUrl });
  const ar = ctx.newAnalyzeRule(resp.url);
  ar.setContent(resp.body, resp.url);
  let text = safe(() => ar.getString(rule.content || ''));
  if (!text) {
    // fall back to whole body text
    text = parseDocument(resp.body, resp.url).text();
  }
  if (rule.title) {
    const t = safe(() => ar.getString(rule.title));
    if (t) chapter.title = t;
  }
  return formatContent(text);
}

// Legado HtmlFormatter.formatContent: <br>/<p> to newlines, keep indentation
export function formatContent(html) {
  if (!html) return '';
  let s = String(html);
  if (/<\/?[a-zA-Z][^>]*>/.test(s)) {
    const doc = parseDocument(s);
    const body = doc.select('body')[0] || doc;
    s = body.html ? body.html() : s;
    s = s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }
  s = s
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // indent paragraphs like Legado's default
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => '　　' + l.replace(/^　+/, ''))
    .join('\n');
}

export function shutdownFetcher() { if (fetcher) { fetcher.close(); fetcher = null; } }

