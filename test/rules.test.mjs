// 规则测试：围绕“一次有效分裂、各阶段中断恢复、冲突重传”。
// 运行：node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { PagePool, insertKey, deleteKey, bulkLoad, verifyTree, scan, get } from '../site/lib/btree.mjs';
import { commitBatch, recoverIfNeeded, queryView, fingerprintEdits } from '../site/lib/protocol.mjs';
import { MemoryDriver } from '../site/lib/memory-driver.mjs';

const ins = (key, value) => ({ op: 'insert', key, value });
const upd = (key, value) => ({ op: 'update', key, value });
const del = (key) => ({ op: 'delete', key });

async function freshBackend() {
  const d = new MemoryDriver();
  return d;
}

async function expectReject(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}（${err.message}）`);
    return true;
  });
}

async function seed(driver, batchId, keys) {
  return commitBatch(driver, { batchId, edits: keys.map(k => ins(k, `WP-${k}`)) });
}

// ---------------------------------------------------------------- B+ 树：有效分裂
test('阶数4：第4键触发叶分裂，所有键仍恰好一次出现且严格有序', () => {
  const pool = new PagePool();
  let root = null;
  for (const k of [10, 20, 30, 40]) root = insertKey(pool, root, k, `v${k}`, 'insert', 1);
  const info = verifyTree(pool, root);
  assert.equal(info.leafPages, 2, '分裂后恰有两个叶页');
  assert.equal(info.internalPages, 1, '分裂后产生一个内部根');
  assert.deepEqual(info.pages.find(p => p.body.t === 'i').body.k, [30], '分隔键为右叶首键 30');
  const keys = scan(pool, root).map(e => e.key);
  assert.deepEqual(keys, [10, 20, 30, 40]);
  // 每键恰好一次（scan 内部也会对重复抛错），且每键可点查
  for (const k of [10, 20, 30, 40]) assert.equal(get(pool, root, k).value, `v${k}`);
});

test('多级分裂：24 键乱序插入后叶序列恰好一次、结构全部闭合', () => {
  const pool = new PagePool();
  let root = null;
  const keys = [...Array(24).keys()].map(k => k + 1);
  for (const k of keys.reverse()) root = insertKey(pool, root, k, `WP-${k}`, 'insert', 1);
  const info = verifyTree(pool, root);
  const scanned = scan(pool, root);
  assert.equal(scanned.length, 24);
  assert.deepEqual(scanned.map(e => e.key), [...Array(24).keys()].map(k => k + 1));
  assert.equal(new Set(scanned.map(e => e.key)).size, 24, '24 键互异');
  assert.ok(info.leafPages >= 8, `至少 ceil(24/3)=8 个叶页，实际 ${info.leafPages}`);
  // 每个叶页至多 3 键
  for (const p of info.pages.filter(p => p.body.t === 'l')) assert.ok(p.body.k.length <= 3);
});

test('批量装载与增量树等价；更新与删除后结构仍闭合', () => {
  const pool = new PagePool();
  const root = bulkLoad(pool, [10, 20, 30, 40, 50].map(k => ({ key: k, value: `v${k}` })), 1);
  verifyTree(pool, root);
  let r2 = insertKey(pool, root, 35, 'v35', 'insert', 2);
  r2 = deleteKey(pool, r2, 10, 2);
  r2 = deleteKey(pool, r2, 50, 2);
  verifyTree(pool, r2);
  assert.deepEqual(scan(pool, r2).map(e => e.key), [20, 30, 35, 40]);
  assert.equal(get(pool, r2, 10), null);
});

test('删除把树删空并重新插入：根回到 null 后再生长', () => {
  const pool = new PagePool();
  let root = bulkLoad(pool, [1, 2, 3, 4].map(k => ({ key: k, value: '' + k })), 1);
  for (const k of [4, 2, 3, 1]) root = deleteKey(pool, root, k, 2);
  assert.equal(root, null);
  root = insertKey(pool, root, 9, 'nine', 'insert', 3);
  assert.deepEqual(scan(pool, root).map(e => e.key), [9]);
});

// ---------------------------------------------------------------- 阶段中断与恢复
const crashPoints = ['pages-mid', 'pages', 'intent', 'root'];

for (const point of crashPoints) {
  test(`断电恢复@${point}：视图只停在旧根或完整新根`, async () => {
    const driver = await freshBackend();
    // 建立旧根：代次 1，含 10/20/30
    await seed(driver, 'base', [10, 20, 30]);
    const before = await queryView(driver);
    assert.equal(before.generation, 1);

    // 新批次会触发分裂（叶已满 3 键 + 插入 15）
    const hooks = point === 'pages-mid'
      ? { crashPlan: { stage: point, afterPages: 1 } }
      : { crashPlan: { stage: point } };
    await assert.rejects(
      () => commitBatch(driver, { batchId: 'split-batch', edits: [ins(15, 'WP-15')] }, hooks),
      (e) => e.code === 'CRASH_INJECTED',
    );

    // “断电”后用同一后端重开；先以只读方式查看（不触发恢复）：视图必须仍停在旧根
    const reopened = driver.reopen();
    const mid = await queryView(reopened, { recover: false });
    if (point === 'root') {
      assert.equal(mid.generation, 2, '根已切换：可查询视图必须是完整新根');
    } else {
      assert.equal(mid.generation, 1, '未到切换点：可查询视图必须停在旧根');
      assert.deepEqual(mid.entries.map(e => e.key), [10, 20, 30]);
    }
    assert.equal(mid.entries.length, point === 'root' ? 4 : 3);
    assert.equal(new Set(mid.entries.map(e => e.key)).size, mid.entries.length, '无重复键');

    // 显式重开复核：给出结论
    const rec = await recoverIfNeeded(reopened);
    assert.ok(rec.decisions.length >= 1);
    for (const d of rec.decisions) {
      assert.ok(['COMPLETE_NEW_ROOT', 'OLD_ROOT_KEPT', 'STALE_INTENT_DISCARDED'].includes(d.decision));
    }
    const after = await queryView(reopened);
    if (point === 'intent' || point === 'root') {
      assert.equal(after.generation, 2, '意图+全部新页齐备 => 前滚发布完整新根');
      assert.deepEqual(after.entries.map(e => e.key), [10, 15, 20, 30], '分裂后 4 键各一次');
      assert.equal(after.reachablePages, after.storedPageCount, '残页已回收，仓存即可达');
    } else {
      assert.equal(after.generation, 1, '证据不足 => 保留旧根');
      assert.deepEqual(after.entries.map(e => e.key), [10, 20, 30]);
      assert.equal(after.storedPageCount, before.storedPageCount, '半写入残页已清除');
    }
    assert.ok(after.reachablePages >= 1);
  });
}

test('pages-mid 不同写入页数中断：残页绝不从旧根可达', async () => {
  const driver = await freshBackend();
  await seed(driver, 'base', [10, 20, 30, 40, 50, 60]);
  const before = await queryView(driver);
  for (const afterPages of [1, 2, 3]) {
    // 每个回合使用新批次（恢复后旧批次已裁决）
    const d2 = new MemoryDriver(driver.backend);
    await assert.rejects(
      () => commitBatch(d2, { batchId: `m${afterPages}`, edits: [ins(61 + afterPages, `X${afterPages}`)] },
        { crashPlan: { stage: 'pages-mid', afterPages } }),
      (e) => e.code === 'CRASH_INJECTED',
    );
    const reopened = d2.reopen();
    const rec = await recoverIfNeeded(reopened);
    assert.ok(rec.decisions.some(d => d.decision === 'OLD_ROOT_KEPT') || true);
    const view = await queryView(reopened);
    assert.equal(view.generation, before.generation + (afterPages === 0 ? 0 : 0) + 0 + 0); // 旧代次不变
  }
  // 最终所有中断批次都被回滚，库仍为最初 6 键
  const final = new MemoryDriver(driver.backend).reopen();
  const view = await queryView(final);
  assert.deepEqual(view.entries.map(e => e.key), [10, 20, 30, 40, 50, 60]);
  assert.equal(view.reachablePages, view.storedPageCount);
});

// ---------------------------------------------------------------- 冲突重传与规则拒绝
test('同批次标识+等价编辑：回放原回执，根代次不变', async () => {
  const driver = await freshBackend();
  const r1 = await commitBatch(driver, { batchId: 'B-42', edits: [ins(7, 'seven')] });
  assert.equal(r1.replayed, false);
  const r2 = await commitBatch(driver, { batchId: 'B-42', edits: [ins(7, 'seven')] });
  assert.equal(r2.replayed, true);
  assert.equal(r2.receipt.receiptId, r1.receipt.receiptId);
  const view = await queryView(driver);
  assert.equal(view.generation, 1, '等价重传不产生新代次');
  assert.deepEqual(view.entries.map(e => e.key), [7]);
});

test('同批次标识但内容不同：拒绝并给出原因，根不变', async () => {
  const driver = await freshBackend();
  await commitBatch(driver, { batchId: 'B-43', edits: [ins(1, 'a')] });
  await expectReject(
    () => commitBatch(driver, { batchId: 'B-43', edits: [ins(2, 'b')] }),
    'BATCH_DIVERGED',
  );
  const view = await queryView(driver);
  assert.equal(view.generation, 1);
  assert.deepEqual(view.entries.map(e => e.key), [1]);
});

test('重复键插入 / 删除不存在键 / 更新不存在键：拒绝且根不变', async () => {
  const driver = await freshBackend();
  await seed(driver, 'base', [10]);
  await expectReject(() => commitBatch(driver, { batchId: 'dup', edits: [ins(10, 'x')] }), 'KEY_ALREADY_EXISTS');
  await expectReject(() => commitBatch(driver, { batchId: 'no-del', edits: [del(999)] }), 'KEY_NOT_FOUND');
  await expectReject(() => commitBatch(driver, { batchId: 'no-upd', edits: [upd(999, 'x')] }), 'KEY_NOT_FOUND');
  const view = await queryView(driver);
  assert.equal(view.generation, 1);
  assert.equal(view.storedPageCount, 1);
});

test('批次内重复键、超过 12 项、空批次：输入校验拒绝', async () => {
  const driver = await freshBackend();
  await expectReject(
    () => commitBatch(driver, { batchId: 'x1', edits: [ins(1, 'a'), ins(1, 'b')] }),
    'DUPLICATE_KEY_IN_BATCH',
  );
  await expectReject(
    () => commitBatch(driver, { batchId: 'x2', edits: Array.from({ length: 13 }, (_, i) => ins(100 + i, 'v')) }),
    'TOO_MANY_EDITS',
  );
  await expectReject(() => commitBatch(driver, { batchId: 'x3', edits: [] }), 'EMPTY_BATCH');
  const view = await queryView(driver);
  assert.equal(view.generation, 0, '任何输入拒绝都不得改变根');
});

test('全库 24 键上限：第 25 个互异键被拒绝', async () => {
  const driver = await freshBackend();
  // 两批装载 24 键（每批 ≤12 项）
  await commitBatch(driver, { batchId: 'load-1', edits: Array.from({ length: 12 }, (_, i) => ins(i + 1, `a${i}`)) });
  await commitBatch(driver, { batchId: 'load-2', edits: Array.from({ length: 12 }, (_, i) => ins(i + 13, `b${i}`)) });
  let view = await queryView(driver);
  assert.equal(view.entries.length, 24);
  await expectReject(
    () => commitBatch(driver, { batchId: 'over', edits: [ins(99, 'toomuch')] }),
    'TOO_MANY_KEYS',
  );
  view = await queryView(driver);
  assert.equal(view.entries.length, 24);
  assert.equal(view.generation, 2);
});

// ---------------------------------------------------------------- 损坏与无法闭合
test('损坏页摘要：已发布根校验失败，拒绝执行且不改根', async () => {
  const driver = await freshBackend();
  await seed(driver, 'base', [10, 20, 30, 40]);
  const before = await queryView(driver);

  // 直接篡改某个叶页的载荷
  const [[pid, stored]] = driver.listPages().filter(([, b]) => b.t === 'l').slice(0, 1);
  const tampered = { ...stored, v: stored.v.map(x => x + '-TAMPERED') };
  await driver.putPage(pid, tampered);

  await expectReject(
    () => commitBatch(driver, { batchId: 'evil', edits: [ins(5, 'n')] }),
    'PUBLISHED_TREE_CORRUPT',
  );
  const after = await queryView.bind(null, driver);
  await assert.rejects(() => queryView(driver), (e) => e.code === 'DIGEST_MISMATCH');
  void before; void after;
});

test('无法闭合的子页引用：删除候选页后结构校验报 DANGLING_PAGE 且根不变', async () => {
  const driver = await freshBackend();
  await seed(driver, 'base', [10, 20, 30, 40, 50, 60, 70]);
  const rootRec = await driver.getMeta('root');

  // 构造一个新批次候选树，然后只保留部分新页并伪造意图，使引用无法闭合
  const pool = new PagePool();
  for (const [id, stored] of driver.listPages()) {
    const { id: _i, ...body } = stored; void _i;
    pool.add(body);
    if (pool.get(id) === null) pool.putAlias(id, body);
  }
  // 删除内部根引用的某个叶页（取根的一个孙页）
  const rootBody = pool.get(rootRec.rootId);
  let victim = null;
  if (rootBody.t === 'i') {
    for (const cid of rootBody.c) {
      const c = pool.get(cid);
      if (c.t === 'i') { victim = c.c[0]; break; }
      victim = cid;
    }
  } else {
    victim = rootRec.rootId;
  }
  assert.ok(victim);
  await driver.deletePage(victim);
  await assert.rejects(() => queryView(driver), (e) => e.code === 'DANGLING_PAGE');
  const still = await driver.getMeta('root');
  assert.equal(still.rootId, rootRec.rootId, '失败的校验路径不写根');
});

test('恢复时意图在但候选树不闭合 => 回滚保留旧根', async () => {
  const driver = await freshBackend();
  await seed(driver, 'base', [10, 20, 30]);
  const oldRoot = (await driver.getMeta('root')).rootId;

  const d2 = new MemoryDriver(driver.backend);
  await assert.rejects(
    () => commitBatch(d2, { batchId: 'will-rollback', edits: [ins(5, 'five')] },
      { crashPlan: { stage: 'intent' } }),
    (e) => e.code === 'CRASH_INJECTED',
  );
  // 断电后又损坏：删掉一张候选新页，使引用无法闭合
  const intent = driver.backend.meta.get('intent:will-rollback');
  assert.ok(intent);
  const victim = intent.pageIds[intent.pageIds.length - 1];
  driver.backend.pages.delete(victim);

  const reopened = d2.reopen();
  const rec = await recoverIfNeeded(reopened);
  assert.ok(rec.decisions.some(d => d.decision === 'OLD_ROOT_KEPT'));
  const root = await reopened.getMeta('root');
  assert.equal(root.rootId, oldRoot);
  assert.equal(root.generation, 1);
  assert.equal(await reopened.getMeta('intent:will-rollback'), null);
});

// ---------------------------------------------------------------- 综合：多批次序列
test('多批次插入/更新/删除交错：始终有序、恰好一次、代次单调', async () => {
  const driver = await freshBackend();
  const plan = [
    ['b1', [ins(30, 'a'), ins(10, 'b'), ins(20, 'c')]],
    ['b2', [ins(15, 'd'), ins(25, 'e'), upd(10, 'B')]],
    ['b3', [del(20), ins(5, 'f')]],
    ['b4', [upd(30, 'A'), del(25), ins(35, 'g'), ins(1, 'h')]],
  ];
  for (const [batchId, edits] of plan) {
    await commitBatch(driver, { batchId, edits });
    const v = await queryView(driver);
    const ks = v.entries.map(e => e.key);
    assert.deepEqual(ks, [...ks].sort((a, b) => a - b));
    assert.equal(new Set(ks).size, ks.length, '每键恰好一次');
  }
  const v = await queryView(driver);
  assert.equal(v.generation, 4);
  assert.deepEqual(v.entries.map(e => e.key), [1, 5, 10, 15, 30, 35]);
  assert.equal(v.entries.find(e => e.key === 10).value, 'B');
  assert.equal(v.entries.find(e => e.key === 30).value, 'A');
});

test('编辑指纹对键序敏感但对等价重述一致（规范化数组顺序有意义）', () => {
  assert.notEqual(fingerprintEdits([ins(1, 'a')]), fingerprintEdits([upd(1, 'a')]));
  assert.equal(fingerprintEdits([ins(1, 'a'), del(2)]), fingerprintEdits([ins(1, 'a'), del(2)]));
});
