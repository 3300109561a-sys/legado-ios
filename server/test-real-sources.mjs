// Real-world book source compatibility report.
//
// Loads a public Legado source collection, runs search on each source, and
// reports per-source outcome plus a failure taxonomy. Sources on the public
// internet drift and die; the point of this test is to measure how much of the
// *rule engine* works, and to name exactly which features are missing when a
// source fails.
//
//   node test-real-sources.mjs [sources.json] [query]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchBook, getBookInfo, getChapterList, getBookContent, shutdownFetcher } from './lib/webBook.mjs';
import { AnalyzeRule } from './lib/analyzeRule.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(HERE, '..', '..', 'work', 'real-sources.json');
const QUERY = process.argv[3] || '诡秘之主';
const LIMIT = Number(process.env.LIMIT || 0);

const all = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const sources = LIMIT ? all.slice(0, LIMIT) : all;
console.log(`real sources: ${sources.length} from ${path.basename(SRC)}  query="${QUERY}"\n`);

// ---- feature detection: which rule-engine features does this source need? ----
function featuresOf(src) {
  const blob = JSON.stringify(src);
  const f = [];
  if (/'@webjs|@webjs:/.test(blob)) f.push('@webjs');
  if (/queryTTF/.test(blob)) f.push('queryTTF');
  if (/Packages\./.test(blob)) f.push('Packages.*');
  if (/loginUrl/.test(src) && src.loginUrl) f.push('loginUrl');
  if (/loginCheckJs/.test(src) && src.loginCheckJs) f.push('loginCheckJs');
  if (/java\.downloadFile/.test(blob)) f.push('downloadFile');
  if (/java\.ajax|java\.connect|java\.post/.test(blob)) f.push('java.net');
  if (/@js:/.test(blob)) f.push('@js');
  if (/\{\{/.test(blob)) f.push('{{}}');
  if (/@Json:|\$\./.test(blob)) f.push('jsonpath');
  return f;
}

// ---- failure taxonomy ----
function classify(err) {
  const m = String(err && err.message || err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(m)) return 'DNS/域名失效';
  if (/timeout|aborted|ETIMEDOUT/i.test(m)) return '网络超时';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|TLS|ssl/i.test(m)) return '连接失败/站点已关';
  if (/HTTP 4\d\d|HTTP 5\d\d/i.test(m)) return '站点返回错误码';
  if (/is not defined/.test(m)) return '缺少 JS 全局: ' + (m.match(/(\w+) is not defined/) || [])[1];
  if (/queryTTF/.test(m)) return '缺 queryTTF(字体反爬)';
  if (/webjs/i.test(m)) return '缺 @webjs';
  if (/JSON/i.test(m)) return 'JSON 解析失败(可能站点改版)';
  return '其他: ' + m.slice(0, 60);
}

const rows = [];
for (const src of sources) {
  const name = src.bookSourceName || '(未命名)';
  const feats = featuresOf(src);
  const t0 = Date.now();
  let row = { name, feats, search: 0, status: '', detail: '', ms: 0 };

  try {
    const r = searchBook(src, QUERY, 1);
    row.ms = Date.now() - t0;
    if (r.length) {
      row.search = r.length;
      row.status = 'OK';
      row.detail = r[0].name + ' / ' + (r[0].author || '?');
      // try the rest of the pipeline on the first hit
      try {
        const book = { ...r[0], variableMap: new Map() };
        const info = getBookInfo(src, book);
        const chapters = getChapterList(src, { ...info, variableMap: new Map() });
        if (chapters.length) {
          const text = getBookContent(src, { ...info, variableMap: new Map() },
            { ...chapters[0], variableMap: new Map() });
          row.status = 'OK+正文';
          row.detail += ` | ${chapters.length}章 | ${text.length}字`;
        } else {
          row.status = '搜索OK 目录空';
        }
      } catch (e2) {
        row.status = '搜索OK 后续失败';
        row.detail += ' | ' + classify(e2);
      }
    } else {
      row.status = '搜索0结果';
      row.detail = '站点可能改版或需要特定 UA/Cookie';
    }
  } catch (e) {
    row.ms = Date.now() - t0;
    row.status = '失败';
    row.detail = classify(e);
  }
  rows.push(row);
  const flag = row.status.startsWith('OK') ? '✓' : '✗';
  console.log(`${flag} ${name.padEnd(14)} ${String(row.search).padStart(3)}条 ${row.ms}ms  ${row.status}`);
  if (row.detail) console.log(`    ${row.detail}`);
  if (row.feats.length) console.log(`    需要: ${row.feats.join(', ')}`);
}

// ---- summary ----
const ok = rows.filter((r) => r.status === 'OK');
const okFull = rows.filter((r) => r.status === 'OK+正文');
const zero = rows.filter((r) => r.status === '搜索0结果');
const bad = rows.filter((r) => r.status === '失败' || r.status === '搜索OK 后续失败');

console.log(`\n${'='.repeat(64)}`);
console.log(`真实书源兼容性: ${rows.length} 个源, 查询 "${QUERY}"`);
console.log(`${'='.repeat(64)}`);
console.log(`  搜索有结果      : ${ok.length + okFull.length} / ${rows.length}`);
console.log(`  连目录正文都通  : ${okFull.length} / ${rows.length}`);
console.log(`  搜索 0 结果     : ${zero.length}`);
console.log(`  直接失败        : ${bad.length}`);

const reasons = {};
for (const r of bad) {
  const k = classify(r.detail);
  reasons[k] = (reasons[k] || 0) + 1;
}
if (Object.keys(reasons).length) {
  console.log('\n失败原因分布:');
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}× ${k}`);
  }
}

const featCount = {};
for (const r of rows) for (const f of r.feats) featCount[f] = (featCount[f] || 0) + 1;
console.log('\n这些源用到的规则特性:');
for (const [k, v] of Object.entries(featCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(2)}× ${k}`);
}

shutdownFetcher();
const okAny = ok.length + okFull.length;
process.exitCode = okAny > 0 ? 0 : 1;
