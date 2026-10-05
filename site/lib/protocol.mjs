// 批次事务协议（与存储介质无关，驱动只需实现 getMeta/putMeta/deleteMeta、
// listMetaByPrefix、putPage/getPage/hasPage/deletePage/listPages）：
//
//   阶段 1 新页：先把受影响路径写时复制得到的新页逐页落盘（页 id 即摘要），
//               再写 staging 清单（含基/新代次、候选根、新页 id 列表、编辑指纹）
//   阶段 2 意图：写 intent 作为提交授权
//   阶段 3 切换：root 指针切到候选根并自增代次；随后写回执、清理意图/清单、回收不可达旧页
//
// 重开恢复只认已持久化的阶段证据：
//   - 仅有 staging/残页而无 intent  -> 回滚：保留旧根，残页按垃圾回收
//   - intent 在、根仍在旧基：候选根可从已落盘页完整遍历 -> 前滚；否则回滚保留旧根
//   - 根已等于候选根 -> 新树必须完整，补齐回执与清理，结论为完整新根
//
// 同一批次标识重传：编辑等价则原样回放回执；内容不同则拒绝且已发布根不变。

import {
  PagePool, insertKey, deleteKey, get, scan, verifyTree, reachableIds, makeError,
} from './btree.mjs';
import { stableStringify, sha256Hex } from './util.mjs';

export const OPS = ['insert', 'update', 'delete'];

export function normalizeEdits(rawEdits) {
  if (!Array.isArray(rawEdits)) throw makeError('BAD_INPUT', '编辑列表必须是数组');
  if (rawEdits.length === 0) throw makeError('EMPTY_BATCH', '批次至少包含一项编辑');
  if (rawEdits.length > 12) throw makeError('TOO_MANY_EDITS', '一个批次至多包含 12 项编辑');
  const edits = [];
  const seenKeys = new Set();
  for (const [i, raw] of rawEdits.entries()) {
    const op = raw && raw.op;
    if (!OPS.includes(op)) throw makeError('BAD_INPUT', `第 ${i + 1} 项编辑的操作非法（应为 insert/update/delete）`);
    const key = Number(raw.key);
    if (!Number.isInteger(key)) throw makeError('BAD_INPUT', `第 ${i + 1} 项编辑的键不是整数`);
    if (seenKeys.has(key)) {
      throw makeError('DUPLICATE_KEY_IN_BATCH', `键 ${key} 在同一批次中出现多次，批次内键必须互异`);
    }
    seenKeys.add(key);
    let value = null;
    if (op === 'insert' || op === 'update') {
      value = String(raw.value ?? '');
      if (value.length === 0) throw makeError('BAD_INPUT', `键 ${key} 的 ${op} 载荷不能为空`);
      if (value.length > 120) throw makeError('PAYLOAD_TOO_LONG', `键 ${key} 的短文本载荷过长（上限 120 字）`);
    }
    edits.push(value !== null ? { op, key, value } : { op, key });
  }
  return edits;
}

export const fingerprintEdits = (edits) => sha256Hex(stableStringify(edits));

export class CrashInjected extends Error {
  constructor(stage) {
    super(`模拟断电：持久化阶段「${stage}」完成后中断`);
    this.code = 'CRASH_INJECTED';
    this.stage = stage;
  }
}

const K_ROOT = 'root';
const kStaging = (b) => `staging:${b}`;
const kIntent = (b) => `intent:${b}`;
const kReceipt = (b) => `receipt:${b}`;

async function getRootRec(driver) {
  return (await driver.getMeta(K_ROOT)) || { rootId: null, generation: 0 };
}

async function loadPool(driver) {
  const pool = new PagePool();
  for (const [id, stored] of driver.listPages()) {
    const body = stripStored(stored);
    const trueId = pool.add(body);
    if (trueId !== id) pool.putAlias(id, body);
  }
  return pool;
}

function stripStored(stored) {
  const { id, ...body } = stored;
  void id;
  return body;
}

function buildReceipt(intent) {
  const { batchId, baseGeneration, newGeneration, candidateRootId, edits, applied } = intent;
  const payload = { batchId, baseGeneration, newGeneration, candidateRootId, edits, applied };
  return {
    batchId,
    baseGeneration,
    generation: newGeneration,
    rootId: candidateRootId,
    edits,
    applied,
    fingerprint: fingerprintEdits(edits),
    receiptId: sha256Hex(stableStringify(payload)),
  };
}

// 纯内存规划：任何规则错误都在此抛出，不留持久化痕迹
function planEdits(pool, rootId, edits, newGeneration) {
  let cur = rootId;
  const applied = [];
  for (const e of edits) {
    const existing = cur === null ? null : get(pool, cur, e.key);
    if (e.op === 'insert') {
      if (existing) {
        throw makeError('KEY_ALREADY_EXISTS',
          `键 ${e.key} 已存在（载荷「${existing.value}」），禁止重复插入；如要替换请使用更新`);
      }
      cur = insertKey(pool, cur, e.key, e.value, 'insert', newGeneration);
      applied.push({ op: 'insert', key: e.key, value: e.value });
    } else if (e.op === 'update') {
      if (!existing) throw makeError('KEY_NOT_FOUND', `键 ${e.key} 不存在，无法更新；请改用插入`);
      cur = insertKey(pool, cur, e.key, e.value, 'update', newGeneration);
      applied.push({ op: 'update', key: e.key, previous: existing.value, value: e.value });
    } else {
      if (!existing) throw makeError('KEY_NOT_FOUND', `键 ${e.key} 不存在，无法删除`);
      cur = deleteKey(pool, cur, e.key, newGeneration);
      applied.push({ op: 'delete', key: e.key, previous: existing.value });
    }
  }
  return { rootId: cur, applied };
}

// ---------------- 垃圾回收（只删当前已发布根不可达的页） ----------------
// 返回被移除的页 id；已发布根异常时不动任何页（返回 []）。
async function collectGarbage(driver, rootRec, pool = null) {
  let reachable;
  try {
    const p = pool || await loadPool(driver);
    reachable = rootRec.rootId === null ? new Set() : reachableIds(p, rootRec.rootId);
  } catch {
    return [];
  }
  const removed = [];
  for (const [id] of driver.listPages()) {
    if (!reachable.has(id)) { await driver.deletePage(id); removed.push(id); }
  }
  return removed;
}

// ---------------- 重开恢复 ----------------
export async function recoverIfNeeded(driver, hooks = {}) {
  const rootRec = await getRootRec(driver);
  const decisions = [];

  for (const [metaKey, intent] of driver.listMetaByPrefix('intent:')) {
    const published =
      rootRec.rootId === intent.candidateRootId && rootRec.generation === intent.newGeneration;

    if (published) {
      const pool = await loadPool(driver);
      try {
        verifyTree(pool, intent.candidateRootId);
        assertPagesPresent(driver, intent.pageIds);
      } catch (err) {
        throw makeError('PUBLISHED_TREE_CORRUPT',
          `已发布根（代次 ${intent.newGeneration}）校验失败：${err.reason || err.message}；为安全起见不做任何改写`);
      }
      await finishCommit(driver, intent, pool, hooks, '根指针此前已切换且新树完整，补齐事务收尾');
      await driver.deleteMeta(metaKey);
      decisions.push(decision(intent.batchId, 'COMPLETE_NEW_ROOT', '根指针已切换，候选树自根完整遍历，确认发布新根'));
      continue;
    }

    if (rootRec.generation !== intent.baseGeneration || rootRec.rootId !== intent.baseRootId) {
      await driver.deleteMeta(metaKey);
      decisions.push(decision(intent.batchId, 'STALE_INTENT_DISCARDED',
        `根已推进到代次 ${rootRec.generation}，该意图（目标代次 ${intent.newGeneration}）过期丢弃，已发布根不受影响`));
      continue;
    }

    // 根仍停在旧基：证据齐全则前滚，否则回滚
    const pool = await loadPool(driver);
    let closeReason = '';
    try {
      verifyTree(pool, intent.candidateRootId);
      assertPagesPresent(driver, intent.pageIds);
    } catch (err) {
      closeReason = err.reason || err.message;
    }

    if (!closeReason) {
      await driver.putMeta(K_ROOT, { rootId: intent.candidateRootId, generation: intent.newGeneration });
      if (hooks.crashBarrier) await hooks.crashBarrier('recovery-root');
      const pool2 = await loadPool(driver);
      await finishCommit(driver, intent, pool2, hooks, '前滚');
      await driver.deleteMeta(metaKey);
      decisions.push(decision(intent.batchId, 'COMPLETE_NEW_ROOT',
        '意图与全部新页均已持久化且候选树可完整遍历，重开后依据证据前滚切换到新根'));
    } else {
      await driver.deleteMeta(metaKey);
      await driver.deleteMeta(kStaging(intent.batchId));
      await collectGarbage(driver, rootRec, pool);
      decisions.push(decision(intent.batchId, 'OLD_ROOT_KEPT',
        `候选树无法闭合（${closeReason}），丢弃意图与残页，根停在旧代次 ${rootRec.generation}`));
    }
  }

  // 无意图的 staging：若当前根正是候选根，说明切换与回执已完成、只是清单未删；
  // 否则证据不足以发布，严格保留旧根。
  const rootNow = await getRootRec(driver);
  for (const [metaKey, staging] of driver.listMetaByPrefix('staging:')) {
    await driver.deleteMeta(metaKey);
    if (rootNow.rootId === staging.candidateRootId && rootNow.generation === staging.newGeneration) {
      decisions.push(decision(staging.batchId, 'COMPLETE_NEW_ROOT',
        '根指针此前已切换到候选根且树完整（意图已清除、清单残留），确认发布新根并清理'));
    } else {
      decisions.push(decision(staging.batchId, 'OLD_ROOT_KEPT',
        '只发现新页与阶段清单而没有批次意图，半写入页不得进入可查询视图，保留旧根'));
    }
  }
  // 兜底：连清单都未写出的写入中途残页（如阶段 1 新页写入途中断电）。
  // 只从已发布根判定可达性，残页一律回收并给出复核结论。
  const finalRoot = await getRootRec(driver);
  const orphanIds = await collectGarbage(driver, finalRoot);
  if (decisions.length === 0 && orphanIds.length > 0) {
    decisions.push(decision('(未命名批次)', 'OLD_ROOT_KEPT',
      `发现 ${orphanIds.length} 张不被任何阶段清单覆盖、且从已发布根不可达的半写入页；证据不足以发布，已清除残页并保留旧根（代次 ${finalRoot.generation}）`));
  }
  return { root: finalRoot, decisions };
}

function assertPagesPresent(driver, pageIds) {
  for (const pid of pageIds) {
    if (!driver.hasPage(pid)) throw makeError('DANGLING_PAGE', `候选页 ${pid.slice(0, 10)} 未落盘，引用无法闭合`);
  }
}

async function finishCommit(driver, intent, pool, hooks, _why) {
  if (!(await driver.getMeta(kReceipt(intent.batchId)))) {
    await driver.putMeta(kReceipt(intent.batchId), buildReceipt(intent));
    if (hooks.crashBarrier) await hooks.crashBarrier('recovery-receipt');
  }
  await driver.deleteMeta(kStaging(intent.batchId));
  await collectGarbage(driver, { rootId: intent.candidateRootId, generation: intent.newGeneration }, pool);
}

const decision = (batchId, decisionName, reason) => ({ batchId, decision: decisionName, reason });

// ---------------- 批次提交 ----------------
export async function commitBatch(driver, rawInput, hooks = {}) {
  const batchId = String(rawInput.batchId ?? '').trim();
  if (!batchId) throw makeError('BAD_INPUT', '缺少稳定批次标识');
  if (batchId.length > 64) throw makeError('BAD_INPUT', '批次标识过长（上限 64 字符）');
  const edits = normalizeEdits(rawInput.edits);

  // 任何提交前先依据持久化证据复核
  const recovery = await recoverIfNeeded(driver, hooks);
  const rootRec = recovery.root;

  // 幂等重传
  const prior = await driver.getMeta(kReceipt(batchId));
  if (prior) {
    if (prior.fingerprint === fingerprintEdits(edits)) {
      return { replayed: true, receipt: prior, recovery, unchangedGeneration: rootRec.generation };
    }
    throw makeError('BATCH_DIVERGED',
      `批次标识「${batchId}」已用于一组不同的编辑（原回执 ${prior.receiptId.slice(0, 10)}…）：内容不同禁止重放，已发布根保持代次 ${rootRec.generation} 不变`);
  }
  if (await driver.getMeta(kIntent(batchId))) {
    throw makeError('BATCH_PENDING', `批次「${batchId}」存在未决意图，请先重开复核`);
  }

  // 已发布根预检：损坏摘要/无法闭合的引用必须拒绝且不改根
  const pool = await loadPool(driver);
  if (rootRec.rootId !== null) {
    try {
      verifyTree(pool, rootRec.rootId);
    } catch (err) {
      throw makeError('PUBLISHED_TREE_CORRUPT',
        `当前已发布根无法通过校验：${err.reason || err.message}；拒绝执行批次，根保持代次 ${rootRec.generation} 不变`);
    }
  }

  const newGeneration = rootRec.generation + 1;
  let planned;
  try {
    planned = planEdits(pool, rootRec.rootId, edits, newGeneration);
  } catch (err) {
    throw err; // 纯内存规划失败：驱动中未写入任何内容
  }
  // 候选树必须完整可遍历（分裂后每键恰好一次也在此保证）
  verifyTree(pool, planned.rootId);

  const plannedCount = planned.rootId === null ? 0 : scan(pool, planned.rootId).length;
  if (plannedCount > 24) {
    throw makeError('TOO_MANY_KEYS',
      `本批次将使索引达到 ${plannedCount} 个互异键，超出全库 24 个航点键的上限；批次拒绝，已发布根不变`);
  }

  const oldReachable = rootRec.rootId === null ? new Set() : reachableIds(pool, rootRec.rootId);
  const newReachable = planned.rootId === null ? new Set() : reachableIds(pool, planned.rootId);
  const newPageIds = [...newReachable].filter(id => !oldReachable.has(id));

  const staging = {
    batchId,
    baseGeneration: rootRec.generation,
    baseRootId: rootRec.rootId,
    newGeneration,
    candidateRootId: planned.rootId,
    pageIds: newPageIds,
    fingerprint: fingerprintEdits(edits),
    edits,
  };

  // 阶段 1：逐页落盘新页（断电可能只留下其中一部分——它们从旧根不可达）
  let written = 0;
  for (const pid of newPageIds) {
    await driver.putPage(pid, { ...pool.get(pid), id: pid });
    written++;
    if (hooks.crashPlan?.stage === 'pages-mid' && written === hooks.crashPlan.afterPages) {
      await driver.losePower?.('pages-mid');
      throw new CrashInjected('pages-mid');
    }
  }
  await driver.putMeta(kStaging(batchId), staging);
  if (hooks.crashPlan?.stage === 'pages') {
    await driver.losePower?.('pages');
    throw new CrashInjected('pages');
  }

  // 阶段 2：批次意图
  const intent = { ...staging, applied: planned.applied };
  await driver.putMeta(kIntent(batchId), intent);
  if (hooks.crashPlan?.stage === 'intent') {
    await driver.losePower?.('intent');
    throw new CrashInjected('intent');
  }

  // 阶段 3：原子切换根指针
  await driver.putMeta(K_ROOT, { rootId: planned.rootId, generation: newGeneration });
  if (hooks.crashPlan?.stage === 'root') {
    await driver.losePower?.('root');
    throw new CrashInjected('root');
  }

  // 收尾：回执、清理意图/清单、回收旧页
  const receipt = buildReceipt(intent);
  await driver.putMeta(kReceipt(batchId), receipt);
  await driver.deleteMeta(kIntent(batchId));
  await driver.deleteMeta(kStaging(batchId));
  await collectGarbage(driver, { rootId: planned.rootId, generation: newGeneration }, pool);

  return { replayed: false, receipt, recovery, newPageIds };
}

export const reopen = recoverIfNeeded;

// ---------------- 可查询视图 ----------------
export async function queryView(driver, options = {}) {
  let decisions = [];
  if (options.recover !== false) ({ decisions } = await recoverIfNeeded(driver));
  const rootRec = await getRootRec(driver);
  const pool = await loadPool(driver);
  let info = null;
  if (rootRec.rootId !== null) info = verifyTree(pool, rootRec.rootId);
  const entries = rootRec.rootId === null ? [] : scan(pool, rootRec.rootId);
  const pagesByGeneration = new Map();
  if (info) for (const p of info.pages) {
    const g = p.body.g ?? 0;
    pagesByGeneration.set(g, (pagesByGeneration.get(g) || 0) + 1);
  }
  return {
    rootId: rootRec.rootId,
    generation: rootRec.generation,
    entries,
    reachablePages: info ? info.pages.length : 0,
    leafPages: info ? info.leafPages : 0,
    internalPages: info ? info.internalPages : 0,
    treeDepth: info ? info.maxDepth + 1 : 0,
    depthMap: info ? new Map(info.pages.map(p => [p.id, p.depth])) : new Map(),
    pages: info ? info.pages.map(p => ({ id: p.id, body: p.body, depth: p.depth })) : [],
    pagesByGeneration: [...pagesByGeneration.entries()].sort((a, b) => a[0] - b[0]),
    storedPageCount: driver.listPages().length,
    receipts: driver.listMetaByPrefix('receipt:').map(([, r]) => r),
    recovery: decisions,
  };
}
