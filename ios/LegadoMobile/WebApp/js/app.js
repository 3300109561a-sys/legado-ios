// 阅读 iOS — 前端逻辑
// API 契约与 APK 自带 Web 服务一致（见 assets/web/vue 与 api.md）。

const API = {
  async get(path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return t; }
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return t; }
  },
};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ------------------------------------------------------------------- state
const state = {
  shelf: [],
  view: 'shelf',
  history: [],
  book: null,
  chapters: [],
  chapterIndex: 0,
  tocReversed: false,
  searchKey: '',
};

// -------------------------------------------------------------------- view
function show(view, { push = true } = {}) {
  if (state.view !== view && push) state.history.push(state.view);
  state.view = view;
  for (const el of $$('.view')) {
    const on = el.dataset.view === view;
    el.hidden = !on;
    el.classList.toggle('is-active', on);
  }
  hideSheet();
}

function back() {
  const prev = state.history.pop() || 'shelf';
  show(prev, { push: false });
  if (prev === 'shelf') refreshShelf();
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('is-shown'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove('is-shown');
    setTimeout(() => { t.hidden = true; }, 220);
  }, ms);
}

function hideSheet() {
  $('#sheet').hidden = true;
  $('#scrim').hidden = true;
}

// ------------------------------------------------------------------- shelf
async function refreshShelf() {
  try {
    const list = await API.get('/getBookshelf');
    state.shelf = Array.isArray(list) ? list : [];
  } catch (e) {
    state.shelf = [];
    toast('无法连接本地服务');
  }
  renderShelf();
}

function coverEl(book, cls) {
  const wrap = document.createElement('div');
  wrap.className = cls;
  if (book.coverUrl) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = '/cover?path=' + encodeURIComponent(book.coverUrl);
    img.onerror = () => { img.remove(); wrap.appendChild(fallbackTitle(book.name)); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(fallbackTitle(book.name));
  }
  return wrap;
}

function fallbackTitle(name) {
  const d = document.createElement('div');
  d.className = 'fallback';
  d.textContent = name || '未命名';
  return d;
}

function renderShelf() {
  const grid = $('#shelf-grid');
  grid.textContent = '';
  $('#shelf-empty').hidden = state.shelf.length > 0;
  state.shelf.forEach((b, i) => {
    const cell = document.createElement('div');
    cell.className = 'book-cell';
    cell.style.animationDelay = Math.min(i * 24, 320) + 'ms';
    cell.appendChild(coverEl(b, 'book-cover'));
    if (b.durChapterIndex > 0) {
      const badge = document.createElement('span');
      badge.className = 'book-badge';
      badge.textContent = '读到 ' + (b.durChapterIndex + 1);
      cell.appendChild(badge);
    }
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const t = document.createElement('div');
    t.className = 'book-title';
    t.textContent = b.name;
    const a = document.createElement('div');
    a.className = 'book-author';
    a.textContent = b.author || b.originName || '';
    meta.append(t, a);
    cell.appendChild(meta);
    cell.addEventListener('click', () => openBook(b));
    grid.appendChild(cell);
  });
}

// --------------------------------------------------------------- add / open
async function addBook(item) {
  const book = {
    name: item.name,
    author: item.author || '',
    bookUrl: item.bookUrl,
    origin: item.origin || item.bookSourceUrl || '',
    originName: item.originName || '',
    coverUrl: item.coverUrl || '',
    intro: item.intro || '',
    kind: item.kind || '',
    lastChapterTitle: item.lastChapter || '',
    durChapterIndex: 0,
  };
  await API.post('/saveBook', book);
  toast('已加入书架');
}

async function openBook(book) {
  state.book = book;
  $('#info-title').textContent = book.name || '详情';
  const body = $('#info-body');
  body.innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';
  show('info');

  const info = document.createElement('div');
  info.className = 'info-scroll';

  const head = document.createElement('div');
  head.className = 'info-head';
  head.appendChild(coverEl(book, 'info-cover'));

  const main = document.createElement('div');
  main.className = 'info-main';
  const h = document.createElement('h2');
  h.className = 'info-title';
  h.textContent = book.name || '';
  main.appendChild(h);
  if (book.author) {
    const au = document.createElement('div');
    au.className = 'info-author';
    au.textContent = book.author;
    main.appendChild(au);
  }
  if (book.kind) {
    const kinds = document.createElement('div');
    kinds.className = 'info-kinds';
    for (const k of String(book.kind).split(/[,，、]/).filter(Boolean).slice(0, 4)) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = k.trim();
      kinds.appendChild(c);
    }
    main.appendChild(kinds);
  }
  head.appendChild(main);
  info.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'info-actions';
  const readBtn = document.createElement('button');
  readBtn.className = 'primary-btn';
  readBtn.textContent = '开始阅读';
  const tocBtn = document.createElement('button');
  tocBtn.className = 'ghost-btn';
  tocBtn.textContent = '目录';
  actions.append(readBtn, tocBtn);
  info.appendChild(actions);
  body.textContent = '';
  body.appendChild(info);

  if (book.intro) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = '简介';
    const intro = document.createElement('div');
    intro.className = 'info-intro';
    intro.textContent = book.intro;
    info.append(lbl, intro);
  }

  const loadToc = async () => {
    const list = await API.get('/getChapterList?url=' + encodeURIComponent(book.bookUrl));
    if (!Array.isArray(list)) throw new Error(list && list.errorMsg || '目录获取失败');
    state.chapters = list;
    return list;
  };

  readBtn.addEventListener('click', async () => {
    readBtn.disabled = true;
    try {
      if (!state.chapters.length) await loadToc();
      const idx = Number.isFinite(book.durChapterIndex) ? Math.min(book.durChapterIndex, state.chapters.length - 1) : 0;
      openChapter(idx);
    } catch (e) {
      toast(e.message);
    } finally {
      readBtn.disabled = false;
    }
  });

  tocBtn.addEventListener('click', async () => {
    tocBtn.disabled = true;
    try {
      if (!state.chapters.length) await loadToc();
      renderToc();
      show('toc');
    } catch (e) {
      toast(e.message);
    } finally {
      tocBtn.disabled = false;
    }
  });
}

// -------------------------------------------------------------------- toc
function renderToc() {
  const list = $('#toc-list');
  $('#toc-title').textContent = state.book ? state.book.name : '目录';
  list.textContent = '';
  const chapters = state.tocReversed ? [...state.chapters].reverse() : state.chapters;
  const frag = document.createDocumentFragment();
  for (const ch of chapters) {
    const row = document.createElement('div');
    row.className = 'toc-row' + (ch.index === state.chapterIndex ? ' is-current' : '');
    const num = document.createElement('span');
    num.className = 'toc-num';
    num.textContent = String(ch.index + 1);
    const name = document.createElement('span');
    name.className = 'toc-name';
    name.textContent = ch.title;
    row.append(num, name);
    row.addEventListener('click', () => openChapter(ch.index));
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

// ------------------------------------------------------------------- read
function ensureRail() {
  let rail = $('.ink-rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.className = 'ink-rail';
    const view = $('#view-read');
    if (view) view.appendChild(rail);
  }
  return rail;
}

async function openChapter(index) {
  if (!state.book) return;
  state.chapterIndex = index;
  const title = state.chapters[index] ? state.chapters[index].title : '';

  $('#read-head-title').textContent = title;
  $('#read-page').innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';
  show('read');
  const scroller = $('#read-scroll');
  scroller.scrollTop = 0;

  let text;
  try {
    text = await API.get('/getBookContent?url=' + encodeURIComponent(state.book.bookUrl) + '&index=' + index);
    if (typeof text !== 'string') throw new Error(text && text.errorMsg || '正文获取失败');
  } catch (e) {
    $('#read-page').textContent = '正文加载失败：' + e.message;
    return;
  }

  const page = $('#read-page');
  page.textContent = '';
  const h = document.createElement('h1');
  h.className = 'read-title';
  h.textContent = title;
  const body = document.createElement('div');
  body.textContent = text;
  page.append(h, body);

  const rail = ensureRail();
  updateProgress();
  saveProgress(index, 0);

  $('#btn-prev').disabled = index <= 0;
  $('#btn-next').disabled = index >= state.chapters.length - 1;
}

function updateProgress() {
  const scroller = $('#read-scroll');
  const max = scroller.scrollHeight - scroller.clientHeight;
  const pct = max > 8 ? Math.min(100, Math.round((scroller.scrollTop / max) * 100)) : 100;
  const rail = $('.ink-rail');
  if (rail) rail.style.setProperty('--p', pct + '%');
  $('#read-pct').textContent = pct + '%';
  const slider = $('#read-slider');
  if (slider && document.activeElement !== slider) slider.value = String(pct);
}

let progressTimer = null;
function saveProgress(index, pct) {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    if (!state.book) return;
    API.post('/saveBookProgress', {
      bookUrl: state.book.bookUrl,
      durChapterIndex: index,
      durChapterTitle: state.chapters[index] ? state.chapters[index].title : '',
      durChapterPos: Math.round(pct || 0),
      durChapterTime: Date.now(),
    }).catch(() => {});
  }, 700);
}

// ----------------------------------------------------------------- search
async function doSearch(kw) {
  const key = (kw || '').trim();
  if (!key) return;
  state.searchKey = key;
  const box = $('#search-results');
  box.innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';
  try {
    const list = await API.get('/searchBook?key=' + encodeURIComponent(key));
    box.textContent = '';
    if (!Array.isArray(list) || !list.length) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '没有找到结果';
      box.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of list) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const thumb = document.createElement('div');
      thumb.className = 'result-thumb';
      thumb.textContent = (r.name || '?').slice(0, 2);
      const main = document.createElement('div');
      main.className = 'result-main';
      const n = document.createElement('div');
      n.className = 'result-name';
      n.textContent = r.name;
      const s = document.createElement('div');
      s.className = 'result-sub';
      s.textContent = [r.author, r.kind, r.lastChapter].filter(Boolean).join(' · ') || '—';
      const src = document.createElement('div');
      src.className = 'result-src';
      src.textContent = r.originName || '';
      main.append(n, s, src);
      row.append(thumb, main);
      row.addEventListener('click', async () => {
        try {
          await addBook(r);
          state.book = { ...r, durChapterIndex: 0 };
          show('shelf', { push: false });
          state.history = [];
          await refreshShelf();
        } catch (e) {
          toast(e.message);
        }
      });
      frag.appendChild(row);
    }
    box.appendChild(frag);
  } catch (e) {
    box.textContent = '搜索失败：' + e.message;
  }
}

// ---------------------------------------------------------------- sources
async function renderSources() {
  const box = $('#source-list');
  box.innerHTML = '<div class="loading-box"><div class="spinner"></div></div>';
  try {
    const list = await API.get('/getBookSources');
    box.textContent = '';
    if (!Array.isArray(list) || !list.length) {
      const p = document.createElement('p');
      p.className = 'empty-hint';
      p.textContent = '还没有书源';
      box.appendChild(p);
      return;
    }
    for (const s of list) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const main = document.createElement('div');
      main.className = 'source-main';
      const n = document.createElement('div');
      n.className = 'source-name';
      n.textContent = s.bookSourceName || s.sourceName || '(未命名)';
      const u = document.createElement('div');
      u.className = 'source-url';
      u.textContent = s.bookSourceUrl || s.sourceUrl || '';
      main.append(n, u);
      const del = document.createElement('button');
      del.className = 'source-del';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        try {
          await API.post('/deleteBookSources', [s]);
          renderSources();
        } catch (e) { toast(e.message); }
      });
      row.append(main, del);
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = '加载失败：' + e.message;
  }
}

// ----------------------------------------------------------------- import
function logLine(msg) {
  const el = $('#import-log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
}

function extractSources(parsed) {
  // Accepts: bare array, {bookSources:[...]}, Legado backup {data:{...}} shapes
  if (Array.isArray(parsed)) {
    if (parsed.length && Array.isArray(parsed[0])) return parsed.flat();
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    for (const k of ['bookSources', 'bookSourceList', 'sources']) {
      if (Array.isArray(parsed[k])) return parsed[k];
    }
    if (parsed.data) return extractSources(parsed.data);
    if (parsed.bookSourceName || parsed.bookSourceUrl) return [parsed];
  }
  return [];
}

async function importText(text, label = '内容') {
  const trimmed = text.trim();
  if (!trimmed) { toast('内容为空'); return; }
  if (/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    logLine(`拉取订阅链接…`);
    const r = await fetch('/api/proxy?url=' + encodeURIComponent(trimmed));
    if (!r.ok) throw new Error('订阅下载失败 HTTP ' + r.status);
    text = await r.text();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  const sources = extractSources(parsed);
  if (!sources.length) throw new Error('没有识别到书源');
  const res = await API.post('/saveBookSources', sources);
  logLine(`${label}: 解析 ${sources.length} 条 → ` + JSON.stringify(res));
  toast(`已导入 ${sources.length} 个书源`);
}

// ------------------------------------------------------------- interaction
function bind() {
  $('#btn-search').addEventListener('click', () => {
    show('search');
    setTimeout(() => $('#search-input').focus(), 260);
  });
  $('#btn-do-search').addEventListener('click', () => doSearch($('#search-input').value));
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#search-input').blur(); doSearch(e.target.value); }
  });

  $$('[data-back]').forEach((b) => b.addEventListener('click', back));

  $('#btn-menu').addEventListener('click', () => {
    $('#sheet').hidden = false;
    $('#scrim').hidden = false;
  });
  $('#scrim').addEventListener('click', hideSheet);
  $('#sheet-cancel').addEventListener('click', hideSheet);
  $('#sheet-sources').addEventListener('click', () => { hideSheet(); show('sources'); renderSources(); });
  $('#sheet-import').addEventListener('click', () => { hideSheet(); show('import'); });
  $('#sheet-about').addEventListener('click', () => {
    hideSheet();
    toast('阅读 · Legado 书源兼容版  1.0.0', 3200);
  });

  $('#btn-reverse').addEventListener('click', () => {
    state.tocReversed = !state.tocReversed;
    $('#btn-reverse').textContent = state.tocReversed ? '正序' : '倒序';
    renderToc();
  });

  $('#btn-prev').addEventListener('click', () => {
    if (state.chapterIndex > 0) openChapter(state.chapterIndex - 1);
  });
  $('#btn-next').addEventListener('click', () => {
    if (state.chapterIndex < state.chapters.length - 1) openChapter(state.chapterIndex + 1);
  });
  $('#btn-catalog').addEventListener('click', () => {
    renderToc();
    show('toc');
  });

  const scroller = $('#read-scroll');
  scroller.addEventListener('scroll', () => {
    updateProgress();
    if (state.book) saveProgress(state.chapterIndex, currentPct());
  }, { passive: true });

  $('#read-slider').addEventListener('input', (e) => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = (Number(e.target.value) / 100) * Math.max(0, max);
  });

  // tap the middle of the page to toggle chrome; tap edges to turn pages
  $('#view-read').addEventListener('click', (e) => {
    if (e.target.closest('.read-head, .read-foot')) return;
    const x = e.clientX / window.innerWidth;
    const ui = $('#read-ui');
    if (x < 0.22) { if (state.chapterIndex > 0) openChapter(state.chapterIndex - 1); return; }
    if (x > 0.78) { if (state.chapterIndex < state.chapters.length - 1) openChapter(state.chapterIndex + 1); return; }
    ui.classList.toggle('is-hidden');
  });

  // import panel
  $('#btn-import').addEventListener('click', () => show('import'));
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('#import-log').textContent = '';
    try {
      logLine(`文件: ${f.name} (${Math.round(f.size / 1024)} KB)`);
      const text = await f.text();
      await importText(text, '文件');
    } catch (err) {
      logLine('失败: ' + err.message);
      toast(err.message);
    } finally {
      e.target.value = '';
    }
  });
  $('#btn-import-run').addEventListener('click', async () => {
    $('#import-log').textContent = '';
    try {
      await importText($('#import-text').value, '粘贴内容');
      $('#import-text').value = '';
    } catch (err) {
      logLine('失败: ' + err.message);
      toast(err.message);
    }
  });

  window.addEventListener('popstate', () => { if (state.view !== 'shelf') back(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#sheet').hidden) hideSheet();
  });
}

function currentPct() {
  const s = $('#read-scroll');
  const max = s.scrollHeight - s.clientHeight;
  return max > 8 ? Math.round((s.scrollTop / max) * 100) : 100;
}

// ------------------------------------------------------------------ start
async function start() {
  bind();
  document.querySelector('[data-view="shelf"]').hidden = false;
  document.querySelector('[data-view="shelf"]').classList.add('is-active');
  await refreshShelf();
  try {
    const h = await API.get('/api/health');
    if (!h.sources) {
      // first run: offer the APK's bundled sources
      $('#shelf-empty').hidden = false;
    }
  } catch { /* offline shell */ }

  if ('serviceWorker' in navigator && navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    } catch { /* private mode / unsupported */ }
  }
}

start();
