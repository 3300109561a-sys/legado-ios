// End-to-end server test: start the real WebService against the fixture site,
// then drive it exactly the way the PWA does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PORT = 18099;
const SRV_PORT = 12340;
const BASE = `http://127.0.0.1:${SRV_PORT}`;
const FIX = `http://127.0.0.1:${FIXTURE_PORT}`;
const DATA = path.join(HERE, '.testdata');

fs.rmSync(DATA, { recursive: true, force: true });

const fixture = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs')], {
  env: { ...process.env, FIXTURE_PORT: String(FIXTURE_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const serverProc = spawn(process.execPath, [path.join(HERE, 'webservice.mjs')], {
  env: { ...process.env, LEGADO_PORT: String(SRV_PORT), LEGADO_DATA: DATA },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const killAll = () => {
  for (const p of [fixture, serverProc]) { try { p.kill(); } catch { /* ignore */ } }
};

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

async function api(p, init) {
  const r = await fetch(BASE + p, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}
const post = (p, body) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

try {
  if (!(await waitFor(FIX + '/search?key=x'))) throw new Error('fixture failed');
  if (!(await waitFor(BASE + '/api/health'))) throw new Error('webservice failed');

  // 1. health
  const health = await api('/api/health');
  check('health endpoint', health && health.ok === true, JSON.stringify(health));

  // 2. PWA shell served
  const shell = await fetch(BASE + '/');
  const html = await shell.text();
  check('PWA shell served', shell.ok && html.includes('<title>阅读</title>'));

  // 3. import book source through the same route the PWA uses
  const src = {
    bookSourceName: '夹具源',
    bookSourceUrl: FIX,
    bookSourceType: 0,
    enabled: true,
    searchUrl: FIX + '/search?key={{key}}&page=<1,2>',
    ruleSearch: { bookList: '#results li.book', name: '.name@text', author: '.author@text', bookUrl: '.name@href', kind: '.kind@text' },
    ruleBookInfo: { name: '.title@text', author: '.author@text##作者：', intro: '.intro@text', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '#toc dd', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@html', title: '#ctitle@text' },
  };
  const imp = await post('/saveBookSources', [src]);
  check('import book source', imp.isSuccess && imp.total === 1, JSON.stringify(imp));

  const sources = await api('/getBookSources');
  check('getBookSources', Array.isArray(sources) && sources.length === 1, `${sources.length}`);

  // 4. search
  const found = await api('/searchBook?key=' + encodeURIComponent('测试之书'));
  check('searchBook', Array.isArray(found) && found.length >= 1, JSON.stringify(found[0] || {}));

  // 5. add book
  const book = {
    name: found[0].name, author: found[0].author, bookUrl: found[0].bookUrl,
    origin: src.bookSourceUrl, originName: src.bookSourceName, coverUrl: found[0].coverUrl || '',
  };
  const saved = await post('/saveBook', book);
  check('saveBook', saved.isSuccess === true, JSON.stringify(saved.data || {}));

  // 6. bookshelf
  const shelf = await api('/getBookshelf');
  check('getBookshelf', Array.isArray(shelf) && shelf.length === 1, `${shelf.length}`);

  // 7. chapters
  const chapters = await api('/getChapterList?url=' + encodeURIComponent(book.bookUrl));
  check('getChapterList', Array.isArray(chapters) && chapters.length === 3,
    Array.isArray(chapters) ? chapters.map((c) => c.title).join(' | ') : JSON.stringify(chapters));

  // 8. content
  const content = await api('/getBookContent?url=' + encodeURIComponent(book.bookUrl) + '&index=0');
  check('getBookContent', typeof content === 'string' && content.includes('第一章的正文内容'),
    JSON.stringify(String(content).slice(0, 60)));

  // 9. progress round-trip
  await post('/saveBookProgress', {
    bookUrl: book.bookUrl, durChapterIndex: 1, durChapterTitle: '第二章 继续', durChapterPos: 42,
  });
  const shelf2 = await api('/getBookshelf');
  check('progress persisted', shelf2[0] && shelf2[0].durChapterIndex === 1, JSON.stringify({
    idx: shelf2[0] && shelf2[0].durChapterIndex, title: shelf2[0] && shelf2[0].durChapterTitle,
  }));

  // 10. reject unknown book (contract check: HTTP 400 + errorMsg)
  const bad = await fetch(BASE + '/getChapterList?url=' + encodeURIComponent('http://nope'));
  const badBody = await bad.json();
  check('unknown book -> 400 errorMsg', bad.status === 400 && !!badBody.errorMsg,
    `${bad.status} ${JSON.stringify(badBody)}`);

  // 11. delete source
  const del = await post('/deleteBookSources', [src]);
  const after = await api('/getBookSources');
  check('deleteBookSources', del.isSuccess && after.length === 0, `${after.length}`);

  // 12. persistence across restart (wait for the debounced write to land first)
  await new Promise((r) => setTimeout(r, 500));
  killAll();
  await new Promise((r) => setTimeout(r, 600));
  const server2 = spawn(process.execPath, [path.join(HERE, 'webservice.mjs')], {
    env: { ...process.env, LEGADO_PORT: String(SRV_PORT), LEGADO_DATA: DATA },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    if (!(await waitFor(BASE + '/api/health'))) throw new Error('restart failed');
    const shelf3 = await api('/getBookshelf');
    check('data persists across restart', Array.isArray(shelf3) && shelf3.length === 1, `${shelf3.length}`);
  } finally {
    try { server2.kill(); } catch { /* ignore */ }
  }

  const bad2 = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - bad2.length) + '/' + results.length + ' server checks passed');
  if (bad2.length) process.exitCode = 1;
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
} finally {
  killAll();
}
