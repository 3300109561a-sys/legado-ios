// UI verification.
// jsdom does not execute ES modules, so we fetch the page, strip the module script,
// then evaluate the SAME app.js inside the jsdom window as a classic script. The
// code under test is unmodified; only the loading mechanism differs.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:1234';
const FIX = process.env.FIXTURE_BASE || 'http://127.0.0.1:18099';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(HERE, '..', 'webapp', 'js', 'app.js');

// the fixture site must live in its own process (java.ajax blocks this event loop)
let fixtureChild = null;
async function ensureFixture() {
  try {
    const r = await fetch(FIX + '/search?key=x');
    if (r.ok) return;
  } catch { /* start it */ }
  fixtureChild = spawn(process.execPath, [path.join(HERE, 'fixture-server.mjs')], {
    env: { ...process.env, FIXTURE_PORT: String(new URL(FIX).port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(FIX + '/search?key=x'); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('fixture server did not start');
}
await ensureFixture();
process.on('exit', () => { try { fixtureChild && fixtureChild.kill(); } catch { /* ignore */ } });

const results = [];
function flushOutput() {
  try { fs.fsyncSync(1); } catch { /* stdout may not be a file */ }
}
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

const pageRes = await fetch(BASE + '/');
let html = await pageRes.text();
html = html.replace(/<script[^>]*type="module"[^>]*><\/script>/g, '');

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('JSDOM ERROR:', e.message));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    Object.defineProperty(window.navigator, 'serviceWorker', { value: undefined, configurable: true });
    // jsdom has no fetch; proxy to Node's real fetch so the app hits the live server
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : String(input && input.url);
      const abs = url.startsWith('http') ? url : new URL(url, BASE).toString();
      return fetch(abs, init);
    };
  },
});

const { window } = dom;
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

// run app.js inside the page
const appSource = fs.readFileSync(APP_JS, 'utf8');
const scriptEl = window.document.createElement('script');
scriptEl.textContent = appSource;
window.document.body.appendChild(scriptEl);

const waitFor = async (fn, ms = 9000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = fn(); if (v) return v; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
};
const tick = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el && el.dispatchEvent(new window.Event('click'));

// --- 1. shell ---
check('shelf is the active view', $('[data-view="shelf"]').classList.contains('is-active'));
// style assertions belong in a real browser; jsdom has no cascade for var() stacks
check('stylesheet loaded', $$('link[rel=stylesheet]').length > 0 && $('#read-page').className === 'read-page');

// --- 2. navigation ---
click($('#btn-search'));
await tick();
check('search view opens', $('[data-view="search"]').classList.contains('is-active'));
click($('[data-view="search"] [data-back]'));
await tick();
check('back returns to shelf', $('[data-view="shelf"]').classList.contains('is-active'));

// --- 3. menu sheet ---
click($('#btn-menu'));
await tick(150);
check('menu sheet opens', !$('#sheet').hidden);
click($('#sheet-cancel'));
await tick(150);
check('menu sheet closes', $('#sheet').hidden);

// --- 4. sources view renders a source ---
// Seed one through the API first so this check does not depend on whether the
// scratch data dir already had sources (order-independence).
await fetch(BASE + '/api/sources/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify([{
    bookSourceName: '种子源', bookSourceUrl: 'http://seed.invalid', enabled: true,
    ruleSearch: { bookList: '' },
  }]),
});
click($('#btn-menu'));
await tick(120);
click($('#sheet-sources'));
const srcRow = await waitFor(() => $$('.source-row')[0], 6000);
check('source list renders', !!srcRow, srcRow ? srcRow.textContent.replace(/\s+/g, ' ').slice(0, 40) : 'none');
click($('[data-view="sources"] [data-back]'));
await tick();

// --- 5. import through the UI textarea ---
const fixtureSource = [{
  bookSourceName: 'UI夹具源',
  bookSourceUrl: FIX,
  bookSourceType: 0,
  enabled: true,
  searchUrl: FIX + '/search?key={{key}}&page=<1,2>',
  ruleSearch: { bookList: '#results li.book', name: '.name@text', author: '.author@text', bookUrl: '.name@href', kind: '.kind@text' },
  ruleBookInfo: { name: '.title@text', author: '.author@text##作者：', intro: '.intro@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: '#toc dd', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: '#content@html', title: '#ctitle@text' },
}];
click($('#btn-menu'));
await tick(120);
click($('#sheet-import'));
await tick(200);
$('#import-text').value = JSON.stringify(fixtureSource);
click($('#btn-import-run'));
const logged = await waitFor(() => ($('#import-log').textContent || '').includes('解析'), 8000);
check('UI import of a book source', !!logged, ($('#import-log').textContent || '').slice(0, 70));
click($('[data-view="import"] [data-back]'));
await tick();

// --- 6. search through the UI ---
click($('#btn-search'));
await tick();
$('#search-input').value = '测试之书';
click($('#btn-do-search'));
const row = await waitFor(() => $$('.result-row')[0], 9000);
check('search results render', !!row, row ? row.textContent.replace(/\s+/g, ' ').slice(0, 60) : 'none');

if (row) {
  // --- 7. add to shelf ---
  click(row);
  const cell = await waitFor(() => $$('.book-cell')[0], 9000);
  check('book appears on the shelf', !!cell, cell ? cell.textContent.replace(/\s+/g, ' ').slice(0, 40) : 'none');

  if (cell) {
    // --- 8. detail + TOC ---
    click(cell);
    const tocBtn = await waitFor(() => $$('.info-actions .ghost-btn')[0], 6000);
    check('book detail opens', !!tocBtn);
    click(tocBtn);
    const tocRow = await waitFor(() => $$('.toc-row')[0], 9000);
    check('TOC renders 3 chapters', $$('.toc-row').length === 3, `${$$('.toc-row').length}`);

    if (tocRow) {
      // --- 9. read ---
      click(tocRow);
      const text = await waitFor(() => {
        const t = $('#read-page').textContent || '';
        return t.includes('第一章的正文内容') ? t : null;
      }, 9000);
      check('chapter text renders', !!text, text ? JSON.stringify(text.slice(0, 46)) : 'none');
      const ttl = $('#read-page').querySelector('.read-title');
      check('chapter title rendered', ttl && ttl.textContent === '第一章 开始', ttl ? ttl.textContent : 'none');
      check('ink rail exists', !!$('.ink-rail'));

      // --- 10. next chapter ---
      click($('#btn-next'));
      const second = await waitFor(() => {
        const t = $('#read-page').textContent || '';
        return t.includes('第二章的正文内容') ? t : null;
      }, 9000);
      check('next chapter loads', !!second);
    }
  }
}

const bad = results.filter((r) => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' UI checks passed');
window.close();
flushOutput();
// jsdom keeps timers and undici keeps sockets alive; exit explicitly so the
// runner sees a clean status instead of waiting for the process to idle out.
process.exit(bad.length ? 1 : 0);
