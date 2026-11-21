// End-to-end pipeline test against the local fixture site.
// The fixture server must run in another process (see fixture-server.mjs) because
// the rule engine's java.ajax blocks the calling event loop, exactly like Rhino.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchBook, getBookInfo, getChapterList, getBookContent, shutdownFetcher } from './lib/webBook.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs')], {
  env: { ...process.env, FIXTURE_PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/search?key=x');
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function cleanup() {
  try { child.kill(); } catch { /* ignore */ }
}

try {
  if (!(await waitUp())) throw new Error('fixture server did not start');

  const htmlSource = {
    bookSourceName: '本地夹具-HTML',
    bookSourceUrl: BASE,
    bookSourceType: 0,
    enabled: true,
    searchUrl: BASE + '/search?key={{key}}&page=<1,2>',
    ruleSearch: {
      bookList: '#results li.book',
      name: '.name@text',
      author: '.author@text',
      bookUrl: '.name@href',
      kind: '.kind@text',
    },
    ruleBookInfo: {
      name: '.title@text',
      author: '.author@text##作者：',
      intro: '.intro@text',
      tocUrl: '.toc@href',
    },
    ruleToc: { chapterList: '#toc dd', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@html', title: '#ctitle@text' },
  };

  const jsonSource = {
    bookSourceName: '本地夹具-JSON',
    bookSourceUrl: BASE,
    bookSourceType: 0,
    enabled: true,
    searchUrl: BASE + '/api/search?key={{key}}',
    ruleSearch: {
      bookList: '$.data.list[*]',
      name: '$.name',
      author: '$.author',
      bookUrl: `$.id@js:"${BASE}/book/"+result`,
      intro: '$.intro',
    },
    ruleBookInfo: { name: '.title@text', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '#toc dd', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@text' },
  };

  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
  };

  const runPipeline = (src) => {
    console.log('\n--- ' + src.bookSourceName + ' ---');
    const found = searchBook(src, '测试之书', 1);
    check(src.bookSourceName + ' search', found.length === 1, `${found.length} results`);
    if (!found.length) return;
    check(src.bookSourceName + ' search fields',
      found[0].name === '测试之书' && found[0].author === '测试作者', JSON.stringify(found[0]));

    const book = { ...found[0], variableMap: new Map() };
    const info = getBookInfo(src, book);
    check(src.bookSourceName + ' bookInfo', info.name === '测试之书', info.name);

    const chapters = getChapterList(src, info);
    check(src.bookSourceName + ' toc', chapters.length === 3,
      chapters.map((c) => c.title).join(' | '));
    check(src.bookSourceName + ' absolute chapter url',
      chapters.length > 0 && chapters[0].url.startsWith('http'), chapters[0] && chapters[0].url);

    const content = getBookContent(src, info, chapters[0]);
    check(src.bookSourceName + ' content', content.includes('第一章的正文内容'),
      JSON.stringify(content.slice(0, 60)));
  };

  runPipeline(htmlSource);
  runPipeline(jsonSource);

  const p1 = searchBook(htmlSource, '测试之书', 1);
  const p2 = searchBook(htmlSource, '测试之书', 2);
  // <1,2> is Legado's page template: page 1 -> "1", page 2 -> "2"
  check('page template reaches server', p1.length === 1 && p2.length === 1, `p1=${p1.length} p2=${p2.length}`);

  const bad = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' pipeline checks passed');
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
} finally {
  shutdownFetcher();
  cleanup();
}






