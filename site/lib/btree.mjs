// 阶数 4 的 B+ 树（order = branching factor 4）：
//   - 每个节点最多 3 个键；叶节点溢出时按键升序一分为二，分隔键上浮（副本保留在右叶）
//   - 内部节点 children.length === keys.length + 1，keys[i] 是 children[i+1] 最左键的副本
//   - 叶节点以 next 串联，叶链顺序必须与内部树中序遍历一致
//   - 页为不可变对象，id 即页体摘要（内容寻址），任何页体篡改都会导致摘要不符
//   - 写操作沿受影响路径写时复制，新页盖批次代次 g；删除时空叶摘除、
//     退化为单儿子的内部层坍缩，父层分隔键按子树最左键重算（不做借并，键数下限放宽到 1）
//
// 页体：叶 {t:'l', k:[...], v:[...], n:nextId|null, g:gen}
//       内部 {t:'i', k:[...], c:[childId...], g:gen}

import { stableStringify, sha256Hex } from './util.mjs';

export const ORDER = 4;
export const MAX_KEYS = ORDER - 1; // 3
export const MIN_KEYS = 1;        // 放宽下限：删除后允许 1 键；空叶/单儿子层直接坍缩

export function pageDigest(body) {
  return sha256Hex(stableStringify(body));
}

export class PagePool {
  constructor() { this.pages = new Map(); }

  add(body) {
    const id = pageDigest(body);
    const cur = this.pages.get(id);
    if (cur) {
      if (stableStringify(cur) !== stableStringify(body)) {
        throw makeError('DIGEST_COLLISION', '页摘要碰撞，拒绝写入');
      }
    } else {
      this.pages.set(id, body);
    }
    return id;
  }

  get(id) { return this.pages.has(id) ? this.pages.get(id) : null; }
  has(id) { return this.pages.has(id); }
  ids() { return this.pages.keys(); }

  // 存储里的页标识与内容算出的摘要不一致时，把损坏页体也挂在原标识下，
  // 让结构校验能够明确判定 DIGEST_MISMATCH（而不是误报为缺失）。
  putAlias(id, body) {
    if (!this.pages.has(id)) this.pages.set(id, body);
  }
}

const leafBody = (keys, values, next, g) => ({ t: 'l', k: keys, v: values, n: next, g });
const internalBody = (keys, children, g) => ({ t: 'i', k: keys, c: children, g });

// ---------- 批量装载（用于初始化空树的批量导入测试/核对） ----------
export function bulkLoad(pool, entries, generation = 1) {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.key - b.key);
  const leafCount = Math.ceil(sorted.length / MAX_KEYS);
  const leafIds = new Array(leafCount);
  const firstKeys = new Array(leafCount);
  for (let idx = leafCount - 1; idx >= 0; idx--) {
    const i = idx * MAX_KEYS;
    const slice = sorted.slice(i, i + MAX_KEYS);
    firstKeys[idx] = slice[0].key;
    const next = idx + 1 < leafCount ? leafIds[idx + 1] : null;
    leafIds[idx] = pool.add(leafBody(slice.map(e => e.key), slice.map(e => e.value), next, generation));
  }
  let levelIds = leafIds;
  let levelFirstKeys = firstKeys;
  while (levelIds.length > 1) {
    const n = levelIds.length;
    const groups = Math.ceil(n / ORDER);
    const base = Math.floor(n / groups);
    let extra = n % groups;
    const sizes = Array.from({ length: groups }, () => base + (extra-- > 0 ? 1 : 0));
    const upIds = [];
    const upFirst = [];
    let i = 0;
    for (const size of sizes) {
      const children = levelIds.slice(i, i + size);
      const keys = children.slice(1).map((_, j) => levelFirstKeys[i + j + 1]);
      upIds.push(pool.add(internalBody(keys, children, generation)));
      upFirst.push(levelFirstKeys[i]);
      i += size;
    }
    levelIds = upIds;
    levelFirstKeys = upFirst;
  }
  return levelIds[0];
}

// ---------- 插入 / 更新（COW） ----------
function descendIndex(node, key) {
  let i = 0;
  while (i < node.k.length && key >= node.k[i]) i++;
  return i;
}

function lowerBound(keys, key) {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < key) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function insertKey(pool, rootId, key, value, mode = 'insert', generation = 1) {
  if (rootId === null) {
    if (mode === 'update') throw makeError('KEY_NOT_FOUND', `键 ${key} 不存在，无法更新`);
    return pool.add(leafBody([key], [value], null, generation));
  }
  return editTree(pool, rootId, key, generation, (leaf) => {
    const pos = leaf.k.findIndex(k => k === key);
    const exists = pos !== -1;
    if (mode === 'insert' && exists) {
      throw makeError('KEY_ALREADY_EXISTS', `键 ${key} 已存在，插入冲突；如要替换请使用更新`);
    }
    if (mode === 'update' && !exists) {
      throw makeError('KEY_NOT_FOUND', `键 ${key} 不存在，无法更新`);
    }
    let keys, values;
    if (exists) {
      keys = leaf.k.slice();
      values = leaf.v.slice();
      values[pos] = value;
    } else {
      const at = lowerBound(leaf.k, key);
      keys = leaf.k.slice(0, at).concat(key, leaf.k.slice(at));
      values = leaf.v.slice(0, at).concat(value, leaf.v.slice(at));
    }
    // 叶容量至多 3：第 4 项触发分裂（2/2），可能继续向上传播
    return splitChunks(keys, values).map(([ks, vs]) => ({ keys: ks, values: vs }));
  });
}

// ---------- 删除（COW + 坍缩） ----------
export function deleteKey(pool, rootId, key, generation = 1) {
  if (rootId === null) throw makeError('KEY_NOT_FOUND', `键 ${key} 不存在，无法删除`);
  return editTree(pool, rootId, key, generation, (leaf) => {
    const pos = leaf.k.findIndex(k => k === key);
    if (pos === -1) throw makeError('KEY_NOT_FOUND', `键 ${key} 不存在，无法删除`);
    const keys = leaf.k.slice(); keys.splice(pos, 1);
    const values = leaf.v.slice(); values.splice(pos, 1);
    if (keys.length === 0) return []; // 整叶摘除
    return [{ keys, values }];
  });
}

function splitChunks(keys, values) {
  if (keys.length <= MAX_KEYS) return [[keys, values]];
  // 叶溢出最多 1 项（4 键）：均衡一分为二（2/2），分隔键即右组首键
  const mid = Math.ceil(keys.length / 2);
  return [
    [keys.slice(0, mid), values.slice(0, mid)],
    [keys.slice(mid), values.slice(mid)],
  ];
}

// 统一的编辑+定稿（纯函数，只向 pool 追加不可变页）：
//  1) applySkeleton：沿目标键下降生成编辑骨架（不写页、不定 next）；
//  2) 全局叶定稿：中序展平全部叶（新叶组 + 未改动旧叶），从右向左定 next：
//     新叶盖新代次；旧叶仅当 next 改变时才复制（物理叶链下，新叶换 id 会
//     级联改写其前驱链——这是叶链维护的必要闭包，右侧页永不被波及）；
//  3) 自底向上重渲染内部页：子页集合未变的内部页以旧代次重建，内容寻址
//     恰好返回旧 id（真正只复制受影响路径）；变化的页盖新代次，容量超限即分裂。
function editTree(pool, rootId, key, generation, mutateLeaf) {
  const rootSk = applySkeleton(pool, rootId, key, mutateLeaf);
  const descs = [];
  flattenLeaves(pool, rootSk, descs);

  // 从右向左：末叶 next=null，其余指向右侧“最终”叶 id
  const remap = new Map(); // 旧叶 id -> 最终叶 id
  let next = null;
  for (let i = descs.length - 1; i >= 0; i--) {
    const d = descs[i];
    if (d.kind === 'new') {
      d.finalId = pool.add(leafBody(d.keys, d.values, next, generation));
    } else {
      const b = pool.get(d.oldId);
      d.finalId = (b.n === next) ? d.oldId : pool.add(leafBody(b.k, b.v, next, generation));
      remap.set(d.oldId, d.finalId);
    }
    next = d.finalId;
  }

  let level = renderSkeleton(pool, rootSk, generation, remap);
  if (level.length === 0) return null;
  while (level.length > 1) level = groupInternal(pool, level.map(id => ({ id })), generation);
  return level[0];
}

function applySkeleton(pool, id, key, mutateLeaf) {
  const node = pool.get(id);
  if (!node) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，引用无法闭合`);
  if (node.t === 'l') return { kind: 'edited', descs: mutateLeaf(node).map(g => ({ kind: 'new', ...g })) };
  const at = descendIndex(node, key);
  return {
    kind: 'internal',
    groups: node.c.map((cid, i) => i === at ? applySkeleton(pool, cid, key, mutateLeaf) : { kind: 'ref', id: cid }),
  };
}

function flattenLeaves(pool, sk, out) {
  if (sk.kind === 'edited') {
    for (const d of sk.descs) out.push(d);
    return;
  }
  if (sk.kind === 'ref') {
    for (const leafId of inorderLeafIds(pool, sk.id)) out.push({ kind: 'keep', oldId: leafId });
    return;
  }
  for (const g of sk.groups) flattenLeaves(pool, g, out);
}

function inorderLeafIds(pool, rootId) {
  const out = [];
  const walk = (id) => {
    const b = pool.get(id);
    if (!b) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，引用无法闭合`);
    if (b.t === 'l') out.push(id);
    else b.c.forEach(walk);
  };
  walk(rootId);
  return out;
}

// 渲染骨架为同层页 id 列表（0=整段消失，1=正常/坍缩，多个=分裂待上层提升）
function renderSkeleton(pool, sk, generation, remap) {
  if (sk.kind === 'edited') return sk.descs.map(d => d.finalId);
  if (sk.kind === 'ref') return [renderRefSubtree(pool, sk.id, generation, remap)];
  let ids = [];
  for (const g of sk.groups) ids.push(...renderSkeleton(pool, g, generation, remap));
  return groupInternal(pool, ids.map(id => ({ id })), generation);
}

// 未走编辑路径的旧子树：把被叶链级联改写过的叶 id 替换上去；
// 子页集合完全没变时用旧代次重建，内容寻址返回原页 id。
function renderRefSubtree(pool, id, generation, remap) {
  const b = pool.get(id);
  if (!b) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，引用无法闭合`);
  if (b.t === 'l') return remap.get(id) || id;
  const children = b.c.map(cid => renderRefSubtree(pool, cid, generation, remap));
  const unchanged = children.every((cid, i) => cid === b.c[i]);
  if (unchanged) return pool.add(internalBody(b.k, children, b.g));
  const keys = children.slice(1).map(cid => firstKeyOf(pool, cid));
  return pool.add(internalBody(keys, children, generation));
}

// 把子页 id 均衡组织成内部页：扇出 2..4；恰 1 个儿子时该层坍缩
function groupInternal(pool, refs, generation) {
  if (refs.length === 0) return [];
  if (refs.length === 1) return [refs[0].id];
  const groupsN = Math.ceil(refs.length / ORDER);
  const base = Math.floor(refs.length / groupsN);
  let extra = refs.length % groupsN;
  const sizes = Array.from({ length: groupsN }, () => base + (extra-- > 0 ? 1 : 0));
  const out = [];
  let i = 0;
  for (const size of sizes) {
    const children = refs.slice(i, i + size).map(r => r.id);
    const keys = children.slice(1).map(cid => firstKeyOf(pool, cid));
    out.push(pool.add(internalBody(keys, children, generation)));
    i += size;
  }
  return out;
}

// ---------- 读取 ----------
export function get(pool, rootId, key) {
  let id = rootId;
  while (id !== null) {
    const node = pool.get(id);
    if (!node) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，引用无法闭合`);
    if (node.t === 'l') {
      const pos = node.k.indexOf(key);
      return pos === -1 ? null : { key, value: node.v[pos] };
    }
    id = node.c[descendIndex(node, key)];
  }
  return null;
}

export function leftmostLeaf(pool, rootId) {
  let id = rootId;
  for (;;) {
    const node = pool.get(id);
    if (!node) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，引用无法闭合`);
    if (node.t === 'l') return id;
    id = node.c[0];
  }
}

export function scan(pool, rootId) {
  const out = [];
  if (rootId === null) return out;
  let id = leftmostLeaf(pool, rootId);
  const seen = new Set();
  while (id) {
    const leaf = pool.get(id);
    if (!leaf) throw makeError('DANGLING_PAGE', `叶页 ${short(id)} 缺失，叶链无法闭合`);
    for (let i = 0; i < leaf.k.length; i++) {
      if (seen.has(leaf.k[i])) {
        throw makeError('DUPLICATE_KEY_IN_TREE', `键 ${leaf.k[i]} 在树中出现超过一次`);
      }
      seen.add(leaf.k[i]);
      out.push({ key: leaf.k[i], value: leaf.v[i], pageId: id, generation: leaf.g });
    }
    id = leaf.n;
  }
  return out;
}

// ---------- 结构完整性 ----------
// 校验：自摘要、引用闭合、容量/扇出、分隔键、叶链一致、每键恰好一次。
export function verifyTree(pool, rootId) {
  if (rootId === null) {
    return { pages: [], leaves: [], entries: [], leafPages: 0, internalPages: 0, maxDepth: 0 };
  }
  const seen = new Map();
  const entries = [];
  let maxDepth = 0;

  const checkNode = (id, depth) => {
    if (typeof id !== 'string') throw makeError('BAD_REFERENCE', '存在非页标识的子页引用');
    const body = pool.get(id);
    if (!body) throw makeError('DANGLING_PAGE', `页 ${short(id)} 缺失，子页引用无法闭合`);
    if (pageDigest(body) !== id) {
      throw makeError('DIGEST_MISMATCH', `页 ${short(id)} 的摘要与内容不符（页已损坏或被篡改）`);
    }
    if (seen.has(id)) {
      if (seen.get(id) !== depth) throw makeError('BAD_REFERENCE', `页 ${short(id)} 出现在不同深度`);
      return;
    }
    seen.set(id, depth);
    maxDepth = Math.max(maxDepth, depth);

    if (body.t === 'l') {
      if (!Array.isArray(body.k) || !Array.isArray(body.v) || body.k.length !== body.v.length) {
        throw makeError('MALFORMED_PAGE', `叶页 ${short(id)} 结构不完整`);
      }
      if (body.k.length < MIN_KEYS) throw makeError('UNDERFLOW_PAGE', `叶页 ${short(id)} 为空`);
      if (body.k.length > MAX_KEYS) throw makeError('OVERFLOW_PAGE', `叶页 ${short(id)} 超出阶数 4 容量`);
      for (let i = 1; i < body.k.length; i++) {
        if (body.k[i - 1] >= body.k[i]) throw makeError('KEY_ORDER', `叶页 ${short(id)} 键未严格升序`);
      }
      for (const k of body.k) entries.push({ key: k, pageId: id });
    } else if (body.t === 'i') {
      if (!Array.isArray(body.k) || !Array.isArray(body.c)) {
        throw makeError('MALFORMED_PAGE', `内部页 ${short(id)} 结构不完整`);
      }
      if (body.c.length !== body.k.length + 1) {
        throw makeError('BAD_REFERENCE', `内部页 ${short(id)} 的键数与子页数不匹配`);
      }
      if (body.c.length > ORDER || body.c.length < 2) {
        throw makeError('BAD_FANOUT', `内部页 ${short(id)} 的扇出超出阶数 4 或小于 2`);
      }
      for (const [i, childId] of body.c.entries()) {
        checkNode(childId, depth + 1);
        if (i > 0) {
          const sep = body.k[i - 1];
          const first = firstKeyOf(pool, childId);
          if (sep !== first) {
            throw makeError('BAD_SEPARATOR', `内部页 ${short(id)} 的分隔键 ${sep} 不等于右子树最左键 ${first}`);
          }
        }
      }
    } else {
      throw makeError('MALFORMED_PAGE', `页 ${short(id)} 类型未知`);
    }
  };
  checkNode(rootId, 0);

  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1].key >= entries[i].key) {
      throw makeError('KEY_ORDER', `树遍历序在键 ${entries[i].key} 处失序或重复`);
    }
  }

  // 叶链必须与中序遍历覆盖同一组叶页且顺序一致
  const traversalLeaves = [];
  let prevPage = null;
  for (const e of entries) {
    if (e.pageId !== prevPage) { traversalLeaves.push(e.pageId); prevPage = e.pageId; }
  }
  const chainLeaves = [];
  let id = leftmostLeaf(pool, rootId);
  while (id) {
    const body = pool.get(id);
    if (body.t !== 'l') throw makeError('BAD_REFERENCE', '叶链指向了非叶页');
    chainLeaves.push(id);
    if (body.n !== null) {
      if (!pool.has(body.n)) throw makeError('DANGLING_PAGE', `叶页 ${short(id)} 的后继页缺失，叶链无法闭合`);
      const nxt = pool.get(body.n);
      if (nxt.t !== 'l') throw makeError('BAD_REFERENCE', '叶链后继不是叶页');
      if (nxt.k[0] <= body.k[body.k.length - 1]) throw makeError('KEY_ORDER', '叶链跨页键序不升序');
    }
    id = body.n;
  }
  if (chainLeaves.length !== traversalLeaves.length ||
      chainLeaves.some((v, i) => v !== traversalLeaves[i])) {
    throw makeError('LEAF_CHAIN', '叶链与内部树可达叶页集合不一致');
  }

  const pages = [...seen.entries()].map(([pid, depth]) => ({ id: pid, body: pool.get(pid), depth }));
  return {
    pages,
    leaves: chainLeaves,
    entries,
    leafPages: pages.filter(p => p.body.t === 'l').length,
    internalPages: pages.filter(p => p.body.t === 'i').length,
    maxDepth,
  };
}

export function reachableIds(pool, rootId) {
  if (rootId === null) return new Set();
  return new Set(verifyTree(pool, rootId).pages.map(p => p.id));
}

function firstKeyOf(pool, id) {
  const leaf = pool.get(leftmostLeaf(pool, id));
  return leaf.k[0];
}

export function short(id) {
  return typeof id === 'string' ? id.slice(0, 10) : String(id);
}

export function makeError(code, reason) {
  const err = new Error(reason);
  err.code = code;
  err.reason = reason;
  return err;
}
