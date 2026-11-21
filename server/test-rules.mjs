// Conformance tests. Each expectation traces to the Kotlin source:
//  - AnalyzeByJSoup.getResultList: rule without trailing "@..." reads the *attribute*
//    named by the rule; the element index must sit at the end of a segment.
//  - AnalyzeByRegex.getElements: last "&&" segment -> group arrays.
//  - AnalyzeRule.putRule: @put values are evaluated as rules before being stored.
//  - ruleHelp.md: ":" regex is only valid for list rules.
import { AnalyzeRule } from './lib/analyzeRule.mjs';

const results = [];
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  => ' + JSON.stringify(actual) +
    (ok ? '' : '\n        expected ' + JSON.stringify(expected)));
}

const HTML = `<html><body>
<div id="list">
  <div class="item"><a href="/book/1" title="B1"><h2>书名一</h2></a><span class="au">作者甲</span><em>简介一</em></div>
  <div class="item"><a href="/book/2" title="B2"><h2>书名二</h2></a><span class="au">作者乙</span><em>简介二</em></div>
  <div class="item"><a href="/book/3" title="B3"><h2>书名三</h2></a><span class="au">作者丙</span><em>简介三</em></div>
</div>
<div id="content"><p>第一段</p><p>第二段</p></div>
</body></html>`;

const JSON_BODY = JSON.stringify({
  code: 0,
  data: { books: [{ title: 'JSON书一', writer: 'JSON作者', id: 11 }, { title: 'JSON书二', writer: 'JSON作者2', id: 12 }] },
});

const ar = (content, baseUrl = 'https://ex.com') => {
  const a = new AnalyzeRule({ baseUrl });
  if (content !== undefined) a.setContent(content, baseUrl);
  return a;
};

// ---------------- jsoup / CSS ----------------
eq('css @text list', ar(HTML).getStringList('.item@text'), ['书名一 作者甲 简介一', '书名二 作者乙 简介二', '书名三 作者丙 简介三']);
eq('css bare rule = attribute', ar(HTML).getStringList('.item'), []);
eq('css @attr list', ar(HTML).getStringList('.item a@href'), ['/book/1', '/book/2', '/book/3']);
eq('css @title joined', ar(HTML).getString('.item a@title'), 'B1\nB2\nB3');
eq('css descendant @text', ar(HTML).getStringList('.item .au@text'), ['作者甲', '作者乙', '作者丙']);
eq('css nested @text', ar(HTML).getString('.item a h2@text'), '书名一\n书名二\n书名三');
eq('css @ownText', ar(HTML).getString('#content p@ownText'), '第一段\n第二段');
eq('css @@ prefix', ar(HTML).getStringList('@@.item a@href'), ['/book/1', '/book/2', '/book/3']);
eq('css @CSS: prefix', ar(HTML).getStringList('@CSS:.item a@href'), ['/book/1', '/book/2', '/book/3']);
eq('css tag.div@class', ar(HTML).getStringList('tag.div@class'), ['item', 'item', 'item']);
eq('css tag.div.1@class', ar(HTML).getStringList('tag.div.1@class'), ['item']);
eq('css tag.div.0@id', ar(HTML).getStringList('tag.div.0@id'), ['list']);


eq('css tag.div.-1@id', ar(HTML).getStringList('tag.div.-1@id'), ['content']);
eq('css tag.div!0@class', ar(HTML).getStringList('tag.div!0@class'), ['item', 'item', 'item']);

// ---------------- regex ----------------
eq('## strip', ar(HTML).getStringList('.item a@title##B'), ['1', '2', '3']);
eq('## template', ar(HTML).getStringList('.item a@title##B(\\d)##$1-'), ['1-', '2-', '3-']);

// ---------------- jsonpath ----------------
eq('json list', ar(JSON_BODY).getStringList('$.data.books[*].title'), ['JSON书一', 'JSON书二']);
eq('json scalar', ar(JSON_BODY).getString('$.data.books[0].writer'), 'JSON作者');
eq('json root array', ar('[{"x":1},{"x":2}]').getStringList('$[*].x'), ['1', '2']);
eq('@Json: prefix', ar(JSON_BODY).getString('@Json:$.data.books[1].title'), 'JSON书二');
eq('json filter', ar(JSON_BODY).getStringList('$.data.books[?(@.id>11)].title'), ['JSON书二']);

// ---------------- js ----------------
eq('@js literal', ar(HTML).getString('@js:"hello"'), 'hello');
eq('@js md5', ar('x').getString("@js:java.md5Encode('abc')"), '900150983cd24fb0d6963f7d28e17f72');
eq('@js base64Encode', ar('x').getString("@js:java.base64Encode('阅读')"), '6ZiF6K+7');
eq('@js base64Decode', ar('x').getString('@js:java.base64Decode("6ZiF6K+7")'), '阅读');
eq('@js timeFormat', ar('x').getString("@js:java.timeFormat(0,'yyyy')"), '1970');
eq('@js result', ar(HTML).getString('@js:result.match(/B2/)[0]'), 'B2');
eq('@js key/page', (() => {
  const a = new AnalyzeRule({ baseUrl: 'https://ex.com', key: '关键词', page: 3 });
  a.setContent('x');
  return a.getString('@js:key+"-"+page');
})(), '关键词-3');
eq('@js searchKey alias', (() => {
  const a = new AnalyzeRule({ baseUrl: 'https://ex.com', key: 'abc', page: 2 });
  a.setContent('x');
  return a.getString('@js:searchKey+"/"+searchPage');
})(), 'abc/2');
eq('<js> block', ar(HTML).getString('<js>"block-ok"</js>'), 'block-ok');
eq('@js chained after rule', ar(HTML).getString('.item a@href@js:result.length').trim(), '23');

// ---------------- @put / @get ----------------
eq('@put evaluates rule value', (() => {
  const a = new AnalyzeRule({ baseUrl: 'https://ex.com' });
  a.setContent(HTML);
  return a.getString('@put:{"n":".item a@title"}@js:java.get("n")');
})(), 'B1\nB2\nB3');

// ---------------- list rules (getElements) ----------------
eq('bookList css', ar(HTML).getElements('.item').length, 3);
eq('bookList css scoped', ar(HTML).getElements('#list .item').length, 3);
eq('bookList : regex groups', (() => {
  const a = new AnalyzeRule({ baseUrl: 'https://ex.com' });
  a.setContent('<div class="x" href="/b/1">a1</div><div class="x" href="/b/2">a2</div>');
  const els = a.getElements(':class="x" href="([^"]+)"');
  return els.map((e) => (Array.isArray(e) ? e[1] : `?${e}`));
})(), ['/b/1', '/b/2']);
eq('chapterList css', ar(HTML).getElements('.item a').length, 3);

// ---------------- XML ----------------
eq('xml content css', (() => {
  const a = new AnalyzeRule({ baseUrl: 'https://ex.com' });
  a.setContent('<?xml version="1.0"?><rss><channel><item><title>T1</title></item></channel></rss>');
  return a.getString('item title@text');
})(), 'T1');

// ---------------- summary ----------------
const bad = results.filter((r) => !r.ok);
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
if (bad.length) {
  console.log('\nFailed:');
  for (const b of bad) console.log(' - ' + b.name);
  process.exitCode = 1;
}





