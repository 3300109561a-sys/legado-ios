// Publish this project to GitHub using only api.github.com.
//
// Why not `git push`: on this machine github.com:443 is unreachable (the TLS
// credential store is blocked and the socket hangs), while api.github.com works.
// So every step goes through the REST API: create the repo, upload a blob per
// file, build a tree, commit, then point a branch at it.
//
//   GITHUB_TOKEN=ghp_... node scripts/publish-github.mjs --repo legado-ios [--owner me]
//
// Optional flags:
//   --private          create a private repo
//   --dry-run          print the plan, change nothing
//   --message "..."    commit message
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.github.com';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const has = (name) => argv.includes('--' + name);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO = String(flag('repo', 'legado-ios'));
const OWNER = flag('owner', null);
const PRIVATE = has('private');
const DRY = has('dry-run');
const MESSAGE = String(flag('message', 'Legado iOS: 阅读 iPad 移植版'));
const BRANCH = String(flag('branch', 'main'));

if (!TOKEN && !DRY) {
  console.error('缺少 GITHUB_TOKEN 环境变量。');
  console.error('请创建一个 Personal Access Token（需要 repo 权限）：https://github.com/settings/tokens');
  console.error('然后：$env:GITHUB_TOKEN="ghp_xxx"; node scripts/publish-github.mjs --repo legado-ios');
  process.exit(2);
}

// ---------------------------------------------------------------- collect files
const SKIP_DIRS = new Set(['node_modules', '.git', '.testdata', '.uidata', 'build', 'out', '.pnpm-store']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function collect(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), base, out);
    } else {
      if (SKIP_FILES.has(e.name)) continue;
      if (/\.log$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      out.push({
        full,
        rel: path.relative(base, full).split(path.sep).join('/'),
        size: fs.statSync(full).size,
      });
    }
  }
  return out;
}

// Text files must be uploaded as plain utf8; binaries need base64 or the
// content gets mangled. Detect by extension plus a NUL-byte sniff.
const TEXT_EXT = new Set([
  '.swift', '.mjs', '.cjs', '.js', '.json', '.md', '.yml', '.yaml', '.plist',
  '.html', '.css', '.txt', '.py', '.sh', '.ps1', '.pbxproj', '.xcscheme',
  '.webmanifest', '.gitignore', '.npmrc', '.pbxproj',
]);

function isBinary(f) {
  const name = path.basename(f.rel).toLowerCase();
  if (name === '.gitignore' || name === '.npmrc') return false;
  const ext = path.extname(name);
  if (TEXT_EXT.has(ext)) return false;
  const buf = fs.readFileSync(f.full);
  const probe = buf.subarray(0, Math.min(8000, buf.length));
  return probe.includes(0);
}

const files = collect(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
const totalBytes = files.reduce((n, f) => n + f.size, 0);

console.log(`仓库根目录: ${ROOT}`);
console.log(`文件数: ${files.length}   总大小: ${(totalBytes / 1024).toFixed(0)} KB`);
console.log(`目标: ${OWNER ? OWNER + '/' : ''}${REPO}${PRIVATE ? ' (private)' : ' (public)'}   分支: ${BRANCH}`);
if (DRY) {
  console.log('\n--dry-run, 只列出计划，不做任何改动：');
  for (const f of files) {
    console.log(`  ${isBinary(f) ? 'BIN ' : 'TEXT'} ${String(f.size).padStart(7)}  ${f.rel}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- api helper
async function api(method, urlPath, body, tries = 6) {
  const url = urlPath.startsWith('http') ? urlPath : API + urlPath;
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'legado-ios-publisher',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
      if (!res.ok) {
        // 5xx and 429 are worth retrying; 4xx client errors are not
        if ((res.status >= 500 || res.status === 429) && attempt < tries) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        const msg = json && json.message ? json.message : text.slice(0, 300);
        const err = new Error(`${method} ${urlPath} -> ${res.status} ${msg}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } catch (e) {
      // network-level failure: retry with backoff
      lastErr = e;
      if (e.status) throw e;
      if (attempt === tries) break;
      const wait = 1500 * attempt;
      process.stdout.write(`\r网络重试 ${attempt}/${tries} (${e.message.slice(0, 40)})   `);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error('request failed');
}

// ---------------------------------------------------------------- run
try {
  // 1. who am I
  const me = await api('GET', '/user');
  const owner = OWNER || me.login;
  console.log(`\n已认证为: ${me.login}`);

  // 2. create or reuse the repo
  let repo;
  try {
    repo = await api('GET', `/repos/${owner}/${REPO}`);
    console.log(`仓库已存在: ${repo.full_name}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`创建仓库 ${owner}/${REPO} ...`);
    repo = await api('POST', '/user/repos', {
      name: REPO,
      private: PRIVATE,
      description: '阅读 / Legado 的 iPad 移植版（书源规则引擎 + iOS 外壳）',
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    });
    console.log(`仓库已创建: ${repo.html_url}`);
  }

  // repo may be empty: HEAD on a branch 404s when there are no commits
  let parentSha = null;
  let parentTree = null;
  try {
    const ref = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    const parentCommit = await api('GET', `/repos/${owner}/${REPO}/git/commits/${parentSha}`);
    parentTree = parentCommit.tree.sha;
    console.log(`已有分支 ${BRANCH}，将基于 ${parentSha.slice(0, 7)} 更新`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    console.log(`分支 ${BRANCH} 为空，将创建首个提交`);
  }

  // 3. blobs
  let done = 0;
  const treeEntries = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const binary = isBinary(f);
    const blob = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, binary
      ? { content: buf.toString('base64'), encoding: 'base64' }
      : { content: buf.toString('utf8'), encoding: 'utf-8' });
    treeEntries.push({
      path: f.rel,
      mode: binary ? '100755' : '100644',
      type: 'blob',
      sha: blob.sha,
    });
    done++;
    if (done % 10 === 0 || done === files.length) {
      process.stdout.write(`\r上传中 ${done}/${files.length}`);
    }
  }
  console.log('');

  // scripts need the executable bit for a cloned repo to run them
  const EXEC = new Set(['scripts/test-package-dryrun.sh']);
  for (const e of treeEntries) if (EXEC.has(e.path)) e.mode = '100755';

  // 4. tree + commit
  const tree = await api('POST', `/repos/${owner}/${REPO}/git/trees`, {
    ...(parentTree ? { base_tree: parentTree } : {}),
    tree: treeEntries,
  });
  console.log(`tree: ${tree.sha.slice(0, 7)} (${treeEntries.length} 个文件)`);

  const commit = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: tree.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  });
  console.log(`commit: ${commit.sha.slice(0, 7)}`);

  // 5. point the branch at it
  if (parentSha) {
    await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: false,
    });
  } else {
    await api('POST', `/repos/${owner}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  }
  console.log(`分支 ${BRANCH} -> ${commit.sha.slice(0, 7)}`);

  // 6. make sure the Actions workflow can publish artifacts
  try {
    const perms = await api('GET', `/repos/${owner}/${REPO}/actions/permissions/workflow`);
    if (perms.default_workflow_permissions !== 'write') {
      await api('PUT', `/repos/${owner}/${REPO}/actions/permissions/workflow`, {
        default_workflow_permissions: 'write',
        can_approve_pull_request_reviews: perms.can_approve_pull_request_reviews ?? false,
      });
      console.log('已把 Actions 默认权限设为 write');
    }
  } catch (e) {
    console.log(`(跳过 Actions 权限设置: ${e.message})`);
  }

  console.log('\n完成。');
  console.log(`仓库: https://github.com/${owner}/${REPO}`);
  console.log(`触发构建: https://github.com/${owner}/${REPO}/actions/workflows/build-ipa.yml`);
  console.log(`一键跑: https://github.com/${owner}/${REPO}/actions/workflows/build-ipa.yml / Run workflow`);
} catch (e) {
  console.error('\n失败:', e.message);
  if (e.status === 401) console.error('  token 无效或过期。');
  if (e.status === 403) console.error('  token 缺少 repo 权限，或触发了速率限制。');
  if (e.status === 422) console.error('  请求内容被拒绝，检查仓库名是否合法/已存在。');
  process.exit(1);
}
