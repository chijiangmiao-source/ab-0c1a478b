// 页面构建检查（无 npm 依赖）：
//  1) 站点内每个 .mjs/.js 通过 node --check 语法检查
//  2) index.html 引用的本地脚本/样式文件均存在
//  3) 核心库模块在 Node 下可直接导入并满足基本导出契约
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2];
if (!root || !existsSync(root)) {
  console.error(`构建检查失败：站点目录不存在：${root}`);
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (['.mjs', '.js'].includes(extname(p))) out.push(p);
  }
  return out;
}

let failed = 0;

// 1) 语法检查
const scripts = walk(root);
console.log(`- 语法检查 ${scripts.length} 个脚本文件`);
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`  ✘ 语法错误：${f}\n${String(err.stderr || err.message).split('\n').slice(0, 4).join('\n')}`);
  }
}

// 2) index.html 资源引用
const htmlPath = join(root, 'index.html');
if (!existsSync(htmlPath)) {
  console.error('  ✘ 缺少 index.html');
  failed++;
} else {
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)].map(m => m[1]);
  console.log(`- 校验 ${refs.length} 个本地引用`);
  for (const ref of refs) {
    if (/^https?:/.test(ref)) continue;
    if (!existsSync(join(root, ref))) {
      console.error(`  ✘ 缺失引用：${ref}`);
      failed++;
    }
  }
  for (const marker of ['<title>', 'app.mjs', 'styles.css']) {
    if (!html.includes(marker)) {
      console.error(`  ✘ index.html 缺少标记：${marker}`);
      failed++;
    }
  }
}

// 3) 核心模块导出契约（app.mjs/idb-store.mjs 依赖浏览器环境，不做导入）
const { ORDER, MAX_KEYS, verifyTree, PagePool, bulkLoad } = await import(join(root, 'lib/btree.mjs'));
const { commitBatch, recoverIfNeeded, queryView, normalizeEdits } = await import(join(root, 'lib/protocol.mjs'));
const { MemoryDriver } = await import(join(root, 'lib/memory-driver.mjs'));
for (const [name, v] of Object.entries({
  ORDER, MAX_KEYS, verifyTree, PagePool, bulkLoad,
  commitBatch, recoverIfNeeded, queryView, normalizeEdits, MemoryDriver,
})) {
  if (v === undefined) { console.error(`  ✘ 核心导出缺失：${name}`); failed++; }
}
if (ORDER !== 4 || MAX_KEYS !== 3) {
  console.error(`  ✘ 阶数契约错误：ORDER=${ORDER} MAX_KEYS=${MAX_KEYS}`);
  failed++;
}

// 4) 冒烟式库自检：一批 4 键必定触发叶分裂且每键恰好一次
{
  const driver = new MemoryDriver();
  await commitBatch(driver, {
    batchId: 'build-smoke',
    edits: [10, 20, 30, 40].map(k => ({ op: 'insert', key: k, value: `v${k}` })),
  });
  const view = await queryView(driver, { recover: false });
  if (view.entries.length !== 4 || view.leafPages !== 2) {
    console.error(`  ✘ 构建自检失败：entries=${view.entries.length} leafPages=${view.leafPages}`);
    failed++;
  }
  if (new Set(view.entries.map(e => e.key)).size !== 4) {
    console.error('  ✘ 构建自检失败：分裂后键不互异');
    failed++;
  }
}

if (failed > 0) {
  console.error(`构建检查失败：${failed} 项`);
  process.exit(1);
}
console.log('构建检查通过');
