// 随机化压力测试：对内存树反复执行混合编辑（走与浏览器相同的 commit 协议），
// 每一步后：已发布视图必须有序、每键恰好一次、与模型集合一致；
// 并随机在四个持久化阶段断电后重开，验证“旧根或完整新根”不变量。

import test from 'node:test';
import assert from 'node:assert/strict';

import { commitBatch, queryView, recoverIfNeeded } from '../site/lib/protocol.mjs';
import { MemoryDriver } from '../site/lib/memory-driver.mjs';

const stages = ['pages-mid', 'pages', 'intent', 'root'];

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function assertViewMatches(driver, model) {
  const v = await queryView(driver, { recover: false });
  const ks = v.entries.map(e => e.key);
  assert.deepEqual(ks, [...model].sort((a, b) => a - b), '视图键集合/顺序与模型一致');
  assert.equal(new Set(ks).size, ks.length, '每键恰好一次');
  assert.equal(v.reachablePages, v.storedPageCount, '无不可达残页混入存储');
  return v;
}

test('随机混合编辑 200 步：结构始终闭合、恰好一次、与模型一致', async () => {
  const rand = mulberry32(20261005);
  const driver = new MemoryDriver();
  const model = new Set();
  let batchSeq = 0;

  for (let step = 0; step < 200; step++) {
    const key = 1 + Math.floor(rand() * 24);
    const r = rand();
    let op;
    if (model.has(key)) op = r < 0.5 ? 'update' : 'delete';
    else op = 'insert';
    if (model.size >= 24 && op === 'insert') op = rand() < 0.5 ? 'update' : 'delete';
    const edit = op === 'delete'
      ? { op, key }
      : { op, key, value: `w-${key}-${step}` };

    const batchId = `rand-${batchSeq++}`;
    if (op === 'insert' && model.size >= 24) {
      await assert.rejects(
        () => commitBatch(driver, { batchId, edits: [edit] }),
        (e) => ['TOO_MANY_KEYS', 'KEY_ALREADY_EXISTS'].includes(e.code),
      );
      continue;
    }
    await commitBatch(driver, { batchId, edits: [edit] });
    if (op === 'delete') model.delete(key); else model.add(key);
    await assertViewMatches(driver, model);
  }
});

test('随机断电恢复 60 回合：每回合后视图必等于旧模型或新模型', async () => {
  const rand = mulberry32(424242);
  const driver = new MemoryDriver();
  const model = new Set();
  let seq = 0;

  for (let round = 0; round < 60; round++) {
    // 先确保有一定数据
    while (model.size < 6) {
      const k = 1 + Math.floor(rand() * 24);
      if (!model.has(k)) {
        await commitBatch(driver, { batchId: `fill-${seq++}`, edits: [{ op: 'insert', key: k, value: `v${k}` }] });
        model.add(k);
      }
    }
    const beforeModel = new Set(model);
    const beforeGen = (await queryView(driver, { recover: false })).generation;

    // 构造一个必然合法的编辑
    let edit;
    const existing = [...model];
    if (rand() < 0.4 && model.size > 0) {
      const k = existing[Math.floor(rand() * existing.length)];
      edit = { op: 'delete', key: k };
    } else {
      let k;
      do { k = 1 + Math.floor(rand() * 24); } while (model.has(k));
      edit = { op: 'insert', key: k, value: `new-${round}` };
      if (model.size >= 24) { edit = { op: 'update', key: existing[0], value: `u${round}` }; }
    }
    const afterModel = new Set(model);
    if (edit.op === 'delete') afterModel.delete(edit.key);
    else if (edit.op === 'insert') afterModel.add(edit.key);

    const stage = stages[Math.floor(rand() * stages.length)];
    const hooks = stage === 'pages-mid'
      ? { crashPlan: { stage, afterPages: 1 + Math.floor(rand() * 3) } }
      : { crashPlan: { stage } };
    const crashing = new MemoryDriver(driver.backend);
    let crashed = true;
    try {
      await commitBatch(crashing, { batchId: `crash-${seq++}`, edits: [edit] }, hooks);
      crashed = false; // pages-mid 的写入页数未达断点：批次正常完成（等同于新根已发布）
    } catch (err) {
      assert.equal(err.code, 'CRASH_INJECTED');
    }

    if (!crashed) {
      model.clear(); for (const k of afterModel) model.add(k);
      const v = await queryView(crashing, { recover: false });
      assert.deepEqual(v.entries.map(e => e.key), [...afterModel].sort((a, b) => a - b));
      continue;
    }

    // 重开后只读视图：必须停在旧根（root 断点前）或已是完整新根（root 断点）
    const reopened = crashing.reopen();
    const mid = await queryView(reopened, { recover: false });
    if (stage === 'root') {
      assert.equal(mid.generation, beforeGen + 1);
      assert.deepEqual(mid.entries.map(e => e.key), [...afterModel].sort((a, b) => a - b));
    } else {
      assert.equal(mid.generation, beforeGen);
      assert.deepEqual(mid.entries.map(e => e.key), [...beforeModel].sort((a, b) => a - b));
    }

    // 显式复核后：要么旧模型要么新模型，二者必居其一
    const rec = await recoverIfNeeded(reopened);
    const finalView = await queryView(reopened, { recover: false });
    const finalKeys = finalView.entries.map(e => e.key);
    const oldKeys = [...beforeModel].sort((a, b) => a - b);
    const newKeys = [...afterModel].sort((a, b) => a - b);
    const decided = rec.decisions.some(d =>
      d.decision === 'COMPLETE_NEW_ROOT' || d.decision === 'OLD_ROOT_KEPT');
    assert.ok(decided, '每个断电回合都必须给出明确复核结论');
    if (finalKeys.length === newKeys.length && finalKeys.every((k, i) => k === newKeys[i])) {
      assert.equal(finalView.generation, beforeGen + 1, '前滚 => 新根代次');
      model.clear(); for (const k of afterModel) model.add(k);
    } else {
      assert.deepEqual(finalKeys, oldKeys, '回滚 => 严格旧根内容');
      assert.equal(finalView.generation, beforeGen);
    }
    assert.equal(finalView.reachablePages, finalView.storedPageCount, '复核后无残页');
  }
});
