// Regression tests for the rule-engine bugs found by testing against real,
// third-party book sources (see test-real-sources.mjs). Each case reproduces a
// construct that appears in real sources and that previously produced wrong
// output or threw.
import { AnalyzeRule } from './lib/analyzeRule.mjs';

const results = [];
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  => ' + JSON.stringify(actual) +
    (ok ? '' : '\n        expected ' + JSON.stringify(expected)));
}
function noThrow(name, fn) {
  try {
    const v = fn();
    results.push({ name, ok: true });
    console.log('PASS  ' + name + '  => ' + JSON.stringify(v));
  } catch (e) {
    results.push({ name, ok: false });
    console.log('FAIL  ' + name + '  => threw: ' + e.message);
  }
}

const ar = (html, base = 'https://ex.com') => {
  const a = new AnalyzeRule({ baseUrl: base });
  if (html !== undefined) a.setContent(html, base);
  return a;
};

// ---- 1. leading @attr (RuleAnalyzer.trim) ----
// real source: ruleSearch.bookUrl = "@onclick@js:result.match(/\\('(.*?)', '', ''\\)/)[1]"
{
  const a = ar(`<div class="v-list-item" onclick="openBook('/book/123', '', '')">
      <span class="v-title">书名</span></div>`);
  eq('leading @attr reads element attribute', a.getString('@onclick'), "openBook('/book/123', '', '')");
  eq('@attr then @js chain',
    a.getString("@onclick@js:result.match(/\\('(.*?)', '', ''\\)/)[1]"), '/book/123');
  eq('bare @attr on document root',
    a.getString('@data-x'), '');
}

// ---- 2. scoped @attr inside a list item ----
{
  const a = ar('<div class="item" data-id="42"><span class="t">书A</span></div>');
  const el = a.getElements('.item')[0];
  const sub = new AnalyzeRule({ baseUrl: 'https://ex.com' });
  sub.setContent(el, 'https://ex.com');
  eq('scoped bare @attr', sub.getString('@data-id'), '42');
  eq('scoped usual attr still works', sub.getString('@data-id'), '42');
  eq('scoped @attr and @text coexist', sub.getString('@data-id') + '/' + sub.getString('span@text'), '42/书A');
}

// ---- 3. chained :nth selectors used by real sources ----
// real source: ruleBookInfo.kind = ".face-info span.1:3@text&&#idNewIds@#chapter-ps-id@text##.*："
{
  const a = ar(`<div class="face-info"><span>作者：甲</span><span>分类：玄幻</span></div>`);
  eq('span index via tag syntax', a.getString('tag.span.1@text'), '分类：玄幻');
}

// ---- 4. getElement (java.getElement) ----
{
  const a = ar('<div class="x"><a href="/b/1">T1</a></div><div class="x"><a href="/b/2">T2</a></div>');
  const el = a.getElement('.x a@text');
  eq('getElement returns the first element', el && el.text(), 'T1');
  eq('java.getElement from JS', a.getString('@js:java.getElement(".x a@text").text()'), 'T1');
}

// ---- 5. java APIs real sources call ----
{
  const a = ar('x');
  eq('java.toURL', a.getString('@js:java.toURL("a b")'), 'a%20b');
  eq('java.encodeURI', a.getString('@js:java.encodeURI("中 文")'), '%E4%B8%AD%20%E6%96%87');
  eq('java.androidId', a.getString('@js:java.androidId().length'), '16');
  eq('java.hexDecodeToString', a.getString('@js:java.hexDecodeToString("e4b8ad")'), '中');
  eq('java.getString nested rule', a.getString('@js:java.getString("a@text")'), '');
  eq('java.put/get roundtrip', a.getString('@js:(java.put("k","v"), java.get("k"))'), 'v');
}

// ---- 6. unsupported browser API must fail loudly, not silently ----
{
  const a = ar('x');
  let threw = false;
  let msg = '';
  try { a.getString('@js:java.startBrowserAwait("http://x")'); } catch (e) { threw = true; msg = e.message; }
  eq('java.startBrowserAwait throws (not silent)', threw, true);
  eq('  ...and names the missing feature', /WebView/.test(msg), true);
}

// ---- 7. setContent from JS ----
{
  const a = ar('<div id="a">hello</div>');
  eq('java.setContent + getString', a.getString('@js:(java.setContent("<b>hi</b>"), java.getString("b@text"))'), 'hi');
}

// ---- 8. searchUrl keyword/page substitution as real sources write it ----
{
  const a = new AnalyzeRule({ baseUrl: 'http://m.example.com', key: '诡秘之主', page: 1 });
  a.setContent('x');
  eq('keyword in JS rule', a.getString('@js:encodeURIComponent(key)'),
    encodeURIComponent('诡秘之主'));
}




// ---- 9. URL-rule forms that real sources actually use ----
{
  const AU = (await import('./lib/analyzeUrl.mjs')).AnalyzeUrl;
  const mk = (rule, key = '关键词') => new AU(rule, {
    key, page: 1, baseUrl: 'https://example.com',
    source: { bookSourceUrl: 'https://example.com' },
    evalJS: (js, res) => {
      const a = new AnalyzeRule({ baseUrl: 'https://example.com', key, page: 1 });
      a.setContent('x');
      return a.evalJS(js, res);
    },
  });
  // 69书吧.com: <js>url,{options};result='';result;</js>
  const a = mk("<js>/modules/article/search.php,{'charset':'gbk','body':'searchkey={{key}}&searchtype=all','method':'POST'};result='';result;</js>");
  eq('js-wrapped url + options', a.url, 'https://example.com/modules/article/search.php');
  eq('  ...method parsed', a.method, 'POST');
  eq('  ...charset parsed', a.charset, 'gbk');
  eq('  ...body interpolated', a.body, 'searchkey=' + encodeURIComponent('关键词') + '&searchtype=all');
  eq('plain url with {{key}}', mk('/p?q={{key}}').url,
    'https://example.com/p?q=' + encodeURIComponent('关键词'));
  eq('page template <1,2>', mk('/p?page=<1,2>').url, 'https://example.com/p?page=1');

  // ---- 10. @onclick attribute extraction (阅友小说) ----
  const b = new AnalyzeRule({ baseUrl: 'https://example.com' });
  b.setContent(`<div class="v-list-item" onclick="openBook('/book/123', '', '')"></div>`);
  eq('@onclick attr', b.getString('@onclick'), "openBook('/book/123', '', '')");
  eq('@onclick + @js chain',
    b.getString("@onclick@js:result.match(/\\('(.*?)', '', ''\\)/)[1]"), '/book/123');
}

const bad = results.filter((r) => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' real-source regression checks passed');
if (bad.length) {
  console.log('Failed: ' + bad.map((b) => b.name).join(', '));
  process.exitCode = 1;
}
