// Legado WebService-compatible HTTP server.
// Contract taken from the APK itself:
//   assets/web/vue/assets/index-*.js  (the app's own web UI)
//   api.md + app/src/main/java/io/legado/app/web/  (upstream)
// Routes: getReadConfig, saveReadConfig, getBookshelf, getBookSource(s),
//         getRssSource(s), saveBookSource(s), deleteBookSources, saveBook,
//         deleteBook, saveBookProgress, getChapterList, getBookContent,
//         cover, image, getReplaceRules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { searchBook, getBookInfo, getChapterList, getBookContent } from './lib/webBook.mjs';
import { SyncFetcher } from './lib/syncfetch.mjs';
import { decodeBody } from './lib/analyzeUrl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.LEGADO_DATA || path.join(HERE, 'data');
const PORT = Number(process.env.LEGADO_PORT || 1234);

// ---------------------------------------------------------------- persistence
const DB_FILE = path.join(DATA, 'db.json');

const DEFAULTS = {
  bookSources: [],
  rssSources: [],
  books: [],
  chapterCache: {},
  contentCache: {},
  readConfig: [],
  replaceRules: [],
  progress: {},
};

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...structuredClone(DEFAULTS) };
  }
}

let db = loadDb();
let saveTimer = null;

function writeDbNow() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (e) {
    console.error('writeDb failed', e.message);
    return false;
  }
}

function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeDbNow();
  }, 150);
}

// Flush pending writes so a kill/restart never loses the last action.
function flushDb() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeDbNow();
    return true;
  }
  return false;
}

// ------------------------------------------------------------ source helpers
const sourceKey = (s) => s.bookSourceUrl || s.sourceUrl || '';
const sourceName = (s) => s.bookSourceName || s.sourceName || '';

function normalizeSource(raw) {
  const s = { ...raw };
  if (!s.bookSourceUrl && s.sourceUrl) s.bookSourceUrl = s.sourceUrl;
  if (!s.bookSourceName && s.sourceName) s.bookSourceName = s.sourceName;
  if (s.enabled === undefined) s.enabled = true;
  if (s.bookSourceType === undefined) s.bookSourceType = 0;
  for (const k of ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']) {
    if (s[k] == null) s[k] = {};
  }
  return s;
}

function importSources(list) {
  let added = 0;
  let updated = 0;
  for (const raw of list) {
    const s = normalizeSource(raw);
    const key = sourceKey(s);
    if (!key) continue;
    const i = db.bookSources.findIndex((x) => sourceKey(x) === key);
    if (i >= 0) { db.bookSources[i] = { ...db.bookSources[i], ...s }; updated++; }
    else { db.bookSources.push(s); added++; }
  }
  saveDb();
  return { added, updated, total: db.bookSources.length };
}

function findSource(url) {
  return db.bookSources.find((s) => sourceKey(s) === url);
}

// --------------------------------------------------------------- book helpers
const bookKey = (b) => b.bookUrl || '';

function findBook(url) {
  return db.books.find((b) => bookKey(b) === url);
}

function bookSummary(b) {
  return {
    name: b.name || '',
    author: b.author || '',
    bookUrl: b.bookUrl || '',
    origin: b.origin || 'loc_book',
    originName: b.originName || '',
    coverUrl: b.coverUrl || '',
    intro: b.intro || '',
    kind: b.kind || '',
    lastChapterTitle: b.lastChapterTitle || '',
    latestChapterTitle: b.latestChapterTitle || '',
    durChapterIndex: b.durChapterIndex ?? 0,
    durChapterTitle: b.durChapterTitle || '',
    durChapterPos: b.durChapterPos ?? 0,
    durChapterTime: b.durChapterTime ?? 0,
    totalChapterNum: b.totalChapterNum ?? 0,
    canUpdate: true,
    variableMap: b.variableMap || '',
    group: b.group ?? 0,
    order: b.order ?? 0,
    customCoverUrl: '',
  };
}

// --------------------------------------------------------------- HTTP helpers
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return null;
  const text = buf.toString('utf8');
  try { return JSON.parse(text); } catch { /* lenient */ }
  try {
    const fixed = text
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, p1) => JSON.stringify(p1))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  } catch { return null; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

let fetcher = null;
const getFetcher = () => (fetcher ||= new SyncFetcher());

function proxyImage(url, referer) {
  try {
    const r = getFetcher().request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(referer ? { Referer: referer } : {}),
      },
      timeout: 20000,
    });
    return { buf: r.bodyBuffer, type: (r.headers['content-type'] || 'image/jpeg').split(';')[0] };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = decodeURIComponent(u.pathname);
  const q = u.searchParams;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
    });
    return res.end();
  }

  try {
    // ---- WebService API ----
    if (p === '/getReadConfig') return json(res, 200, db.readConfig);
    if (p === '/saveReadConfig') {
      const b = await jsonBody(req);
      if (b) { db.readConfig = b; saveDb(); }
      return json(res, 200, { isSuccess: true });
    }
    if (p === '/getBookshelf') return json(res, 200, db.books.map(bookSummary));
    if (p === '/getBookSources') return json(res, 200, db.bookSources);
    if (p === '/getRssSources') return json(res, 200, db.rssSources);
    if (p === '/getReplaceRules') return json(res, 200, db.replaceRules);
    if (p === '/getBookSource') {
      const s = findSource(q.get('url') || '');
      return json(res, 200, s || {});
    }

    if (p === '/saveBookSource' || p === '/saveBookSources') {
      const b = await jsonBody(req);
      if (!b) return json(res, 400, { isSuccess: false, errorMsg: 'body required' });
      const list = Array.isArray(b) ? b : [b];
      const r = importSources(list);
      return json(res, 200, { isSuccess: true, ...r, data: r });
    }

    if (p === '/saveRssSource' || p === '/saveRssSources') {
      const b = await jsonBody(req);
      if (!b) return json(res, 400, { isSuccess: false, errorMsg: 'body required' });
      const list = Array.isArray(b) ? b : [b];
      for (const raw of list) {
        const s = { ...raw };
        if (!s.sourceUrl && s.bookSourceUrl) s.sourceUrl = s.bookSourceUrl;
        const i = db.rssSources.findIndex((x) => (x.sourceUrl || '') === (s.sourceUrl || ''));
        if (i >= 0) db.rssSources[i] = s; else db.rssSources.push(s);
      }
      saveDb();
      return json(res, 200, { isSuccess: true, total: db.rssSources.length });
    }

    if (p === '/deleteBookSources' || p === '/deleteRssSources') {
      const b = await jsonBody(req);
      const list = Array.isArray(b) ? b : (b ? [b] : []);
      const isRss = p.includes('Rss');
      const arr = isRss ? db.rssSources : db.bookSources;
      const keys = new Set(list.map((x) => (isRss ? x.sourceUrl : sourceKey(x))));
      const before = arr.length;
      const kept = arr.filter((x) => !keys.has((isRss ? x.sourceUrl : sourceKey(x)) || ''));
      if (isRss) db.rssSources = kept; else db.bookSources = kept;
      saveDb();
      return json(res, 200, { isSuccess: true, deleted: before - kept.length });
    }

    // ---- books ----
    if (p === '/saveBook') {
      const b = await jsonBody(req);
      if (!b) return json(res, 400, { isSuccess: false });
      const book = { ...b, bookUrl: b.bookUrl || b.url || '' };
      const i = db.books.findIndex((x) => bookKey(x) === bookKey(book));
      if (i >= 0) db.books[i] = { ...db.books[i], ...book };
      else db.books.push(book);
      saveDb();
      return json(res, 200, { isSuccess: true, data: bookSummary(book) });
    }

    if (p === '/deleteBook') {
      const b = await jsonBody(req);
      const list = Array.isArray(b) ? b : (b ? [b] : []);
      const keys = new Set(list.map((x) => bookKey(x)));
      db.books = db.books.filter((x) => !keys.has(bookKey(x)));
      for (const k of keys) { delete db.chapterCache[k]; delete db.contentCache[k]; }
      saveDb();
      return json(res, 200, { isSuccess: true });
    }

    if (p === '/saveBookProgress') {
      const b = await jsonBody(req);
      if (b) {
        const key = b.bookUrl || b.url || '';
        db.progress[key] = b;
        const book = findBook(key);
        if (book) {
          book.durChapterIndex = b.durChapterIndex ?? book.durChapterIndex;
          book.durChapterTitle = b.durChapterTitle || book.durChapterTitle;
          book.durChapterPos = b.durChapterPos ?? book.durChapterPos;
          book.durChapterTime = b.durChapterTime ?? Date.now();
        }
        saveDb();
      }
      return json(res, 200, { isSuccess: true });
    }

    if (p === '/getChapterList') {
      const url = q.get('url') || '';
      const book = findBook(url);
      if (!book) return json(res, 400, { isSuccess: false, errorMsg: '书籍不存在，请先加入书架' });
      const cached = db.chapterCache[url];
      if (cached && cached.length && !q.get('refresh')) return json(res, 200, cached);
      const src = findSource(book.origin);
      if (!src) return json(res, 400, { isSuccess: false, errorMsg: '书源不存在' });
      const info = getBookInfo(src, { ...book, variableMap: new Map() });
      const chapters = getChapterList(src, { ...info, variableMap: new Map() });
      db.chapterCache[url] = chapters;
      book.totalChapterNum = chapters.length;
      if (chapters.length) book.lastChapterTitle = chapters[chapters.length - 1].title;
      saveDb();
      return json(res, 200, chapters);
    }

    if (p === '/getBookContent') {
      const url = q.get('url') || '';
      const index = Number(q.get('index') || 0);
      const book = findBook(url);
      if (!book) return json(res, 400, { isSuccess: false, errorMsg: '书籍不存在，请先加入书架' });
      const cacheKey = url + '#' + index;
      if (db.contentCache[cacheKey]) return json(res, 200, db.contentCache[cacheKey]);
      const src = findSource(book.origin);
      if (!src) return json(res, 400, { isSuccess: false, errorMsg: '书源不存在' });
      const chapters = db.chapterCache[url] || [];
      const ch = chapters[index];
      if (!ch) return json(res, 400, { isSuccess: false, errorMsg: '章节不存在' });
      const text = getBookContent(src, { ...book, variableMap: new Map() }, { ...ch, variableMap: new Map() });
      db.contentCache[cacheKey] = text;
      saveDb();
      return json(res, 200, text);
    }

    if (p === '/cover' || p === '/image') {
      const src = q.get('path') || q.get('url') || '';
      if (!src) return json(res, 404, {});
      const r = proxyImage(src, q.get('referer') || '');
      if (!r) return json(res, 404, {});
      res.writeHead(200, { 'content-type': r.type, 'content-length': r.buf.length, 'cache-control': 'max-age=86400' });
      return res.end(r.buf);
    }

    // ---- non-cached search used by the web UI's "search" panel ----
    if (p === '/searchBook') {
      const key = q.get('key') || '';
      const out = [];
      for (const s of db.bookSources.filter((x) => x.enabled !== false)) {
        try {
          for (const r of searchBook(s, key, Number(q.get('page') || 1))) {
            out.push({ ...r, origin: sourceKey(s), originName: sourceName(s) });
          }
        } catch { /* skip failing source */ }
      }
      return json(res, 200, out);
    }

    // ---- health ----
    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        app: 'legado-ios',
        sources: db.bookSources.length,
        books: db.books.length,
        version: '1.0.0',
      });
    }
    if (p === '/api/sources/import') {
      const b = await jsonBody(req);
      if (!b) return json(res, 400, { isSuccess: false });
      const list = Array.isArray(b) ? b : (b.sources || [b]);
      return json(res, 200, { isSuccess: true, ...importSources(list) });
    }

    // ---- first-run helper: import the sources bundled inside the original APK ----
    if (p === '/api/sources/builtin') {
      const builtinPath = path.join(HERE, '..', 'assets', 'builtin-bookSources.json');
      try {
        const list = JSON.parse(fs.readFileSync(builtinPath, 'utf8'));
        const r = importSources(list);
        return json(res, 200, {
          isSuccess: true,
          ...r,
          names: list.map((s) => s.bookSourceName || s.sourceName),
        });
      } catch (e) {
        return json(res, 500, { isSuccess: false, errorMsg: String(e.message || e) });
      }
    }

    // fetch a remote source/backup subscription (CORS-free for the PWA)
    if (p === '/api/proxy') {
      const target = q.get('url') || '';
      if (!/^https?:\/\//i.test(target)) return json(res, 400, { isSuccess: false, errorMsg: 'url required' });
      try {
        const r = getFetcher().request(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'application/json,text/plain,*/*',
          },
          timeout: 30000,
        });
        const text = decodeBody(r.bodyBuffer, r.headers);
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'access-control-allow-origin': '*',
        });
        return res.end(text);
      } catch (e) {
        return json(res, 502, { isSuccess: false, errorMsg: String(e.message || e) });
      }
    }

    // ---- static (PWA shell) ----
    return serveStatic(p, res);
  } catch (e) {
    console.error('500', p, e && e.stack || e);
    return json(res, 500, { isSuccess: false, errorMsg: String(e && e.message || e) });
  }
});

function serveStatic(p, res) {
  const root = path.join(HERE, '..', 'webapp');
  let rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403); return res.end('forbidden');
  }
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(root, 'index.html');
  }
  try {
    const buf = fs.readFileSync(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': ext === '.html' ? 'no-cache' : 'max-age=3600',
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Legado iOS server listening on http://0.0.0.0:${PORT}`);
  console.log(`  data dir: ${DATA}`);
  console.log(`  sources: ${db.bookSources.length}, books: ${db.books.length}`);
});

function shutdown() {
  flushDb();
  try { fetcher && fetcher.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
// 'exit' cannot await, but writeDbNow is synchronous, so it is safe here.
process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); writeDbNow(); } });
