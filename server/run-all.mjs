// One-command verification for the whole deliverable.
// Runs: rule conformance, book-source pipeline, WebService integration,
// PWA end-to-end, iOS project/workflow/Swift static checks.
//
//   node run-all.mjs
//
// NOTE: children use stdio:'inherit' on purpose. Under the Windows sandbox a
// child spawned with stdio 'pipe' fails with EPERM (no named pipes), so we let
// each suite write straight to this process's stdout and judge it by exit code.
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PY = process.env.LEGADO_PYTHON || 'python';
const results = [];

function banner(title) {
  console.log(`\n${'='.repeat(66)}\n${title}\n${'='.repeat(66)}`);
}

function runNode(script, env = {}) {
  banner(script);
  const r = spawnSync(process.execPath, [path.join(HERE, script)], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    timeout: 240000,
  });
  return r.status === 0;
}

function runCmd(cmd, args, cwd) {
  banner(path.basename(args[0] || cmd));
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, timeout: 180000 });
  return r.status === 0;
}

function record(name, ok) {
  results.push({ name, ok });
  console.log(`\n>>> ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// 1-3: pure suites
record('rule engine conformance', runNode('test-rules.mjs'));
record('real-source regressions', runNode('test-real-regressions.mjs'));
record('book source pipeline', runNode('test-pipeline.mjs'));
record('WebService integration', runNode('test-server.mjs'));

// 4: PWA end-to-end needs a scratch server
const UI_PORT = 12341;
const UI_DATA = path.join(HERE, '.uidata');
fs.rmSync(UI_DATA, { recursive: true, force: true });
banner('PWA end-to-end (scratch server on ' + UI_PORT + ')');
const srv = spawn(process.execPath, [path.join(HERE, 'webservice.mjs')], {
  env: { ...process.env, LEGADO_PORT: String(UI_PORT), LEGADO_DATA: UI_DATA },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let uiOk = false;
try {
  if (await waitFor(`http://127.0.0.1:${UI_PORT}/api/health`)) {
    uiOk = runNode('test-ui.mjs', { UI_BASE: `http://127.0.0.1:${UI_PORT}` });
    // iPad home-screen readiness, measured on the scratch server and the LAN IP
    record('iPad readiness', runNode('test-ipad-ready.mjs',
      { LEGADO_PORT: String(UI_PORT) }));
  } else {
    console.log('scratch server did not start');
  }
} finally {
  try { srv.kill(); } catch { /* ignore */ }
}
record('PWA end-to-end', uiOk);

// 5-8: iOS artifacts
record('Swift syntax', runCmd(process.execPath,
  [path.join(ROOT, 'scripts', 'check-swift.cjs'), path.join(ROOT, 'ios', 'LegadoMobile', 'LegadoMobileApp.swift')],
  path.join(ROOT, 'scripts')));

record('Xcode project graph', runCmd(PY,
  [path.join(ROOT, 'scripts', 'validate_pbxproj.py')]));

record('iOS deliverables', runCmd(PY,
  [path.join(ROOT, 'scripts', 'check-ios.py')]));

record('CI workflow', runCmd(process.execPath,
  [path.join(ROOT, 'scripts', 'check-workflow.cjs'), path.join(ROOT, '.github', 'workflows', 'build-ipa.yml')],
  path.join(ROOT, 'scripts')));

// 9: the packaging logic the workflow runs, exercised on a fake .app bundle
record('IPA packaging dry-run', runCmd('powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'scripts', 'test-package-dryrun.ps1')]));

// 10: is the folder actually ready to push?
record('repo preflight', runCmd(process.execPath,
  [path.join(ROOT, 'scripts', 'preflight.mjs')]));

// -------- summary --------
banner('SUMMARY');
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} suites passed`);
process.exitCode = failed ? 1 : 0;
