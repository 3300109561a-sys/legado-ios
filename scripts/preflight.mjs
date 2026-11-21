#!/usr/bin/env node
// Repo preflight: verifies the folder is ready to push and that nothing needed
// by the macOS build is missing, ignored, or stale.
//
//   node scripts/preflight.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
};
const warn = (msg) => console.log('WARN  ' + msg);

// ---- files the CI build cannot work without ----
const required = [
  '.github/workflows/build-ipa.yml',
  'ios/LegadoMobile.xcodeproj/project.pbxproj',
  'ios/LegadoMobile.xcodeproj/xcshareddata/xcschemes/LegadoMobile.xcscheme',
  'ios/LegadoMobile/LegadoMobileApp.swift',
  'ios/LegadoMobile/Info.plist',
  'ios/LegadoMobile/Assets.xcassets/Contents.json',
  'ios/LegadoMobile/Assets.xcassets/AppIcon.appiconset/Contents.json',
  'ios/LegadoMobile/Assets.xcassets/AppIcon.appiconset/icon-1024.png',
  'ios/LegadoMobile/Assets.xcassets/LaunchBackground.colorset/Contents.json',
  'ios/LegadoMobile/WebApp/index.html',
  'ios/LegadoMobile/WebApp/js/app.js',
  'ios/LegadoMobile/WebApp/css/app.css',
  'ios/LegadoMobile/WebApp/manifest.webmanifest',
];
for (const rel of required) {
  const full = path.join(ROOT, rel.split('/').join(path.sep));
  check(`exists: ${rel}`, fs.existsSync(full));
}

// ---- .gitignore must not exclude anything the build needs ----
const giPath = path.join(ROOT, '.gitignore');
if (!fs.existsSync(giPath)) {
  check('.gitignore present', false);
} else {
  const gi = fs.readFileSync(giPath, 'utf8');
  check('.gitignore present', true);
  // 'build/' and 'out/' are fine (CI creates them); ios/ must not be ignored
  const bad = ['ios/', 'LegadoMobile', '*.png', '*.plist', '*.pbxproj']
    .filter((p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').test(gi));
  check('.gitignore does not exclude build inputs', bad.length === 0, bad.join(', '));
}

// ---- webapp/ and the bundled copy must be identical ----
function digest(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) digest(full, base, out);
    else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  return out;
}
const a = digest(path.join(ROOT, 'webapp'));
const b = digest(path.join(ROOT, 'ios', 'LegadoMobile', 'WebApp'));
const missing = Object.keys(a).filter((k) => !(k in b));
const extra = Object.keys(b).filter((k) => !(k in a));
const diff = Object.keys(a).filter((k) => k in b && a[k] !== b[k]);
check('bundled WebApp matches webapp/', !missing.length && !extra.length && !diff.length,
  [missing.length && `missing=${missing.join(',')}`,
    extra.length && `extra=${extra.join(',')}`,
    diff.length && `stale=${diff.join(',')}`].filter(Boolean).join(' '));

// ---- the app must not reference a server address that cannot work ----
const swift = fs.readFileSync(path.join(ROOT, 'ios', 'LegadoMobile', 'LegadoMobileApp.swift'), 'utf8');
check('Swift registers a URL scheme handler', /setURLSchemeHandler/.test(swift));
// A baked-in default server address would be wrong on every network. Comments
// may mention an example IP; what matters is that no *code* assigns one.
const codeLines = swift
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .filter((l) => !/^\s*\*/.test(l));
const hardcoded = codeLines.filter((l) => /["']https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(l));
check('no hardcoded default server address in code', hardcoded.length === 0,
  hardcoded.join(' | '));
check('settings UI is reachable (no always-false gate)',
  /showSetup = true/.test(swift));

// ---- workflow sanity: no leftover placeholder text ----
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-ipa.yml'), 'utf8');
check('workflow has no TODO/placeholder', !/TODO|FIXME|placeholder|xxx/i.test(wf));

// ---- packaging script present ----
check('packaging dry-run script present',
  fs.existsSync(path.join(ROOT, 'scripts', 'test-package-dryrun.ps1')));

// ---- size sanity: GitHub has limits, and huge files slow the runner ----
let bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else bytes += fs.statSync(full).size;
  }
})(ROOT);
const mb = bytes / 1048576;
check('repo is small enough for a clean clone', mb < 50, `${mb.toFixed(1)} MB (excluding node_modules)`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} preflight checks passed`);
if (bad.length) {
  console.log('Fix these before pushing, or the macOS build will fail:');
  for (const b of bad) console.log('  - ' + b.name);
  process.exitCode = 1;
}
