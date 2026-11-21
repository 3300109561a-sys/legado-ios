// Standalone fixture site used by test-pipeline.mjs.
// Runs in its own process because the rule engine's java.ajax blocks the caller's
// event loop (Legado's Rhino does the same).
import http from 'node:http';

const BOOKS = [
  { id: 101, name: '测试之书', author: '测试作者', intro: '这是一本用于验证的书。', cover: '/img/101.jpg', kind: '玄幻' },
  { id: 102, name: '第二本书', author: '另一位作者', intro: '第二本的简介。', cover: '/img/102.jpg', kind: '都市' },
];

const CHAPTERS = [
  { idx: 0, title: '第一章 开始', body: '第一章的正文内容，包含中文字符与标点。' },
  { idx: 1, title: '第二章 继续', body: '第二章的正文内容。' },
  { idx: 2, title: '第三章 结束', body: '第三章的正文内容。' },
];

const htmlPage = (title, body) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (p === '/search') {
    const key = u.searchParams.get('key') || '';
    const page = Number(u.searchParams.get('page') || 1);
    const items = BOOKS.filter((b) => b.name.includes(key) || key === '')
      .map((b) => `<li class="book"><a class="name" href="/book/${b.id}">${b.name}</a><span class="author">${b.author}</span><span class="kind">${b.kind}</span></li>`)
      .join('');
    // page 1 lists both books, page 2 repeats them: lets the test prove the
    // rendered page number actually reached the server.
    return send(200, 'text/html; charset=utf-8', htmlPage('搜索',
      `<ul id="results" data-page="${page}">${items}</ul><div class="page">${page}</div>`));
  }

  if (p === '/api/search') {
    const key = u.searchParams.get('key') || '';
    const list = BOOKS.filter((b) => b.name.includes(key));
    return send(200, 'application/json; charset=utf-8', JSON.stringify({ code: 0, data: { list } }));
  }

  const mBook = p.match(/^\/book\/(\d+)$/);
  if (mBook) {
    const b = BOOKS.find((x) => String(x.id) === mBook[1]);
    if (!b) return send(404, 'text/plain', 'not found');
    return send(200, 'text/html; charset=utf-8', htmlPage(b.name,
      `<div id="info"><h1 class="title">${b.name}</h1><p class="author">作者：${b.author}</p><p class="intro">${b.intro}</p><a class="toc" href="/toc/${b.id}">目录</a></div>`));
  }

  const mToc = p.match(/^\/toc\/(\d+)$/);
  if (mToc) {
    const links = CHAPTERS.map((c) => `<dd><a href="/read/${mToc[1]}/${c.idx}">${c.title}</a></dd>`).join('');
    return send(200, 'text/html; charset=utf-8', htmlPage('目录', `<dl id="toc">${links}</dl>`));
  }

  const mRead = p.match(/^\/read\/(\d+)\/(\d+)$/);
  if (mRead) {
    const c = CHAPTERS[Number(mRead[2])];
    if (!c) return send(404, 'text/plain', 'no chapter');
    return send(200, 'text/html; charset=utf-8', htmlPage(c.title,
      `<h1 id="ctitle">${c.title}</h1><div id="content"><p>${c.body}</p><p>第二段。</p></div><script>var ad="广告";</script>`));
  }

  if (p.startsWith('/img/')) return send(200, 'image/gif', 'GIF89a');
  return send(404, 'text/plain', 'not found');
});

const port = Number(process.env.FIXTURE_PORT || 18099);
server.listen(port, '127.0.0.1', () => console.log('fixture listening on ' + port));

