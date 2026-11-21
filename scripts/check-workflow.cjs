// Validate the GitHub Actions workflow with a real YAML parser.
// Python's PyYAML cannot be installed here (pip temp dir is sandboxed), so use
// the JS parser instead - same guarantee: the file must be well-formed YAML.
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
};

let doc;
try {
  doc = YAML.parse(text);
  check('workflow parses as YAML', true);
} catch (e) {
  check('workflow parses as YAML', false, e.message);
  process.exit(1);
}

check('has jobs', doc && typeof doc.jobs === 'object', Object.keys(doc.jobs || {}).join(','));
const jobNames = Object.keys(doc.jobs || {});
const job = doc.jobs?.build || doc.jobs?.[jobNames[0]];
// a diagnostic probe workflow is allowed to be read-only (no signing, no ipa)
const isProbe = jobNames.includes('probe') || /probe/i.test(file);
check(isProbe ? 'has a probe job' : 'has a build job', !!job);
if (job) {
  check('runs-on a macos runner', /macos/i.test(String(job['runs-on'])), String(job['runs-on']));
  const steps = job.steps || [];
  check('has >= 5 steps', steps.length >= 5, `${steps.length}`);
  const all = JSON.stringify(steps);
  check('disables code signing', all.includes('CODE_SIGNING_ALLOWED=NO'));
  check('clears identity', all.includes('CODE_SIGN_IDENTITY=\\"\\"') || all.includes('CODE_SIGN_IDENTITY=""'));
  check('builds device sdk', all.includes('-sdk iphoneos'));
  check('builds arm64', all.includes('ARCHS=arm64'));
  check('packages Payload/', all.includes('Payload'));
  check('produces .ipa', all.includes('.ipa'));
  check('uploads artifact', all.includes('upload-artifact'));
  const hasCheckout = all.includes('actions/checkout');
  check('checks out the repo', hasCheckout);
}

const bad = results.filter((r) => !r.ok);
// Probe workflows only need to be well-formed YAML with a runnable job; the
// build-specific assertions (signing, arm64, Payload, artifacts) do not apply.
const BUILD_ONLY = [
  'runs-on a macos runner', 'has >= 5 steps', 'disables code signing',
  'clears identity', 'builds device sdk', 'builds arm64', 'packages Payload/',
  'produces .ipa', 'uploads artifact', 'checks out the repo',
];
const effective = isProbe ? results.filter((r) => !BUILD_ONLY.includes(r.name)) : results;
const effectiveBad = effective.filter((r) => !r.ok);
console.log(`\n${effective.length - effectiveBad.length}/${effective.length} workflow checks passed` +
  (isProbe ? ' (probe workflow: build-specific checks skipped)' : ''));
if (effectiveBad.length) process.exitCode = 1;
