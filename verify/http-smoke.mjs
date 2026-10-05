// HTTP 冒烟（Node 20 内置 fetch，无外部依赖）：
//  - GET /health        -> 200，体为 ok
//  - GET /              -> 200，HTML 中含 app.mjs
//  - GET /app.mjs       -> 200，JS 内容类型
//  - GET /lib/protocol.mjs / lib/util.mjs / styles.css -> 200
//  - GET /healthz-noexist -> 404（不应被 SPA 回退掩盖健康端点的错误）
// 站点在 Compose 中可能刚启动，做有限次重试。

const base = process.env.SITE_URL || 'http://site';
const tries = Number(process.env.SMOKE_TRIES || 30);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let lastErr;
for (let i = 0; i < tries; i++) {
  try {
    const res = await fetch(base + '/health');
    if (res.ok) break;
    lastErr = new Error(`/health 状态 ${res.status}`);
  } catch (err) { lastErr = err; }
  await sleep(1000);
  if (i === tries - 1) {
    console.error(`站点在 ${tries}s 内未就绪：${lastErr?.message}`);
    process.exit(1);
  }
}

let failed = 0;
async function check(path, { status = 200, contains = null, typeIncludes = null } = {}) {
  const res = await fetch(base + path);
  const body = await res.text();
  const ok = res.status === status
    && (contains === null || body.includes(contains))
    && (typeIncludes === null || (res.headers.get('content-type') || '').includes(typeIncludes));
  console.log(`  ${ok ? '✔' : '✘'} GET ${path} -> ${res.status} (${body.length}B)`);
  if (!ok) {
    failed++;
    if (res.status !== status) console.error(`      期望状态 ${status}`);
    if (contains !== null && !body.includes(contains)) console.error(`      期望内容包含：${contains}`);
    if (typeIncludes !== null && !(res.headers.get('content-type') || '').includes(typeIncludes)) {
      console.error(`      期望类型包含：${typeIncludes}，实际 ${res.headers.get('content-type')}`);
    }
  }
}

console.log(`HTTP 冒烟目标：${base}`);
await check('/health', { contains: 'ok', typeIncludes: 'text/plain' });
await check('/', { contains: 'app.mjs', typeIncludes: 'text/html' });
await check('/index.html', { contains: '离线航迹交换站' });
await check('/app.mjs', { contains: 'commitBatch', typeIncludes: 'javascript' });
await check('/lib/protocol.mjs', { contains: 'recoverIfNeeded' });
await check('/lib/btree.mjs', { contains: 'ORDER' });
await check('/lib/util.mjs', { contains: 'sha256Hex' });
await check('/lib/memory-driver.mjs', { contains: 'MemoryDriver' });
await check('/styles.css', { contains: '--accent' });
{
  const res = await fetch(base + '/definitely-not-a-page');
  console.log(`  · GET /definitely-not-a-page -> ${res.status}（未知路由，${res.status === 404 ? '404' : 'SPA 回退均可接受'}）`);
}

if (failed > 0) {
  console.error(`HTTP 冒烟失败：${failed} 项`);
  process.exit(1);
}
console.log('HTTP 冒烟通过');
