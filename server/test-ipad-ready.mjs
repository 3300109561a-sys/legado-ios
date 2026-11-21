// iPad-readiness checks: everything the "add to home screen" flow needs.
// Runs against a live server on the LAN address the iPad would actually use.
//
//   node test-ipad-ready.mjs [http://192.168.x.x:1234]
import os from 'node:os';

const argBase = process.argv[2];
const PORT = process.env.LEGADO_PORT || '1234';

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) {
        out.push({ name, address: a.address });
      }
    }
  }
  out.sort((a, b) => {
    const s = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : 2);
    return s(a.address) - s(b.address);
  });
  return out;
}

const bases = argBase ? [argBase] : [
  `http://127.0.0.1:${PORT}`,
  ...lanAddresses().map((a) => `http://${a.address}:${PORT}`),
];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}

for (const base of bases) {
  console.log(`\n--- ${base} ---`);
  let html = '';
  try {
    const r = await fetch(base + '/');
    check('page loads', r.ok, `HTTP ${r.status}`);
    html = await r.text();
  } catch (e) {
    check('page loads', false, e.message);
    continue;
  }

  // iOS home-screen requirements
  check('title is 阅读', /<title>阅读<\/title>/.test(html));
  check('apple-mobile-web-app-capable', /apple-mobile-web-app-capable"\s+content="yes"/.test(html));
  check('apple-mobile-web-app-title 阅读', /apple-mobile-web-app-title"\s+content="阅读"/.test(html));
  check('apple-touch-icon declared', /rel="apple-touch-icon"/.test(html));
  check('manifest declared', /rel="manifest"/.test(html));
  check('viewport fit=cover (safe-area)', /viewport-fit=cover/.test(html));

  // assets must all resolve, with sane content types
  const assets = [
    ['/css/app.css', 'text/css'],
    ['/js/app.js', 'javascript'],
    ['/manifest.webmanifest', 'json'],
    ['/sw.js', 'javascript'],
    ['/icons/icon-180.png', 'image/png'],
  ];
  for (const [p, type] of assets) {
    try {
      const r = await fetch(base + p);
      const ct = r.headers.get('content-type') || '';
      check(`asset ${p}`, r.ok && ct.includes(type), `${r.status} ${ct}`);
    } catch (e) {
      check(`asset ${p}`, false, e.message);
    }
  }

  // the PWA must be installable: manifest fields iOS/Android look at
  try {
    const m = await (await fetch(base + '/manifest.webmanifest')).json();
    check('manifest display standalone', m.display === 'standalone', m.display);
    check('manifest has 180px icon', (m.icons || []).some((i) => i.sizes === '180x180'));
    check('manifest start_url set', !!m.start_url, m.start_url);
  } catch (e) {
    check('manifest parses', false, e.message);
  }

  // API the UI depends on
  try {
    const h = await (await fetch(base + '/api/health')).json();
    check('api health', h.ok === true, JSON.stringify(h));
    check('book sources seeded', h.sources >= 1, `${h.sources} sources`);
  } catch (e) {
    check('api health', false, e.message);
  }

  try {
    const srcs = await (await fetch(base + '/getBookSources')).json();
    check('getBookSources responds', Array.isArray(srcs), `${srcs.length} sources`);
    check('sources have ruleSearch', srcs.length === 0 || !!srcs[0].ruleSearch);
  } catch (e) {
    check('getBookSources responds', false, e.message);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} iPad-readiness checks passed`);
if (bad.length) {
  console.log('Failed: ' + bad.map((b) => b.name).join(', '));
  process.exitCode = 1;
}
