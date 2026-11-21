// Seed server/data/db.json from the sources bundled inside the original APK.
// Idempotent: refuses to overwrite an existing database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'server', 'data', 'db.json');

const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'));

if (fs.existsSync(OUT)) {
  console.log('  数据库已存在，跳过初始化：' + OUT);
  process.exit(0);
}

const db = {
  bookSources: read('builtin-bookSources.json'),
  rssSources: read('builtin-rssSources.json'),
  readConfig: read('builtin-readConfig.json'),
  themeConfig: read('builtin-themeConfig.json'),
  books: [],
  chapterCache: {},
  contentCache: {},
  replaceRules: [],
  progress: {},
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(db, null, 1), 'utf8');
console.log(`  已初始化：${db.bookSources.length} 个书源、${db.rssSources.length} 个订阅源`);
