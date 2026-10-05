import { IDBDriver } from './lib/idb-store.mjs';
import { MemoryDriver } from './lib/memory-driver.mjs';
import { commitBatch, recoverIfNeeded, queryView } from './lib/protocol.mjs';

const $ = (sel) => document.querySelector(sel);
const MAX_ROWS = 12;

let driver = null;
let mode = 'idb'; // 'idb' | 'mem'
const memState = { backend: null, seq: 0 };
let pendingCrash = false; // 断电后、复核前：只读视图必须停在旧根

const els = {
  badge: $('#backendBadge'),
  batchId: $('#batchId'),
  tbody: $('#editsTable tbody'),
  btnAddRow: $('#btnAddRow'),
  rowsLeft: $('#rowsLeft'),
  btnFillSplit: $('#btnFillSplit'),
  btnClearRows: $('#btnClearRows'),
  crashEnabled: $('#crashEnabled'),
  crashStage: $('#crashStage'),
  afterPagesWrap: $('#afterPagesWrap'),
  crashAfterPages: $('#crashAfterPages'),
  memoryMode: $('#memoryMode'),
  btnCommit: $('#btnCommit'),
  btnReopen: $('#btnReopen'),
  btnRefresh: $('#btnRefresh'),
  btnWipe: $('#btnWipe'),
  messages: $('#messages'),
  metrics: $('#metrics'),
  leafBody: $('#leafTable tbody'),
  pagesBody: $('#pagesTable tbody'),
  receiptsBody: $('#receiptsTable tbody'),
  onceBadge: $('#onceBadge'),
};

// ---------------- 编辑行 ----------------
function addRow(op = 'insert', key = '', value = '') {
  if (els.tbody.children.length >= MAX_ROWS) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="op">
      <option value="insert">插入 insert</option>
      <option value="update">更新 update</option>
      <option value="delete">删除 delete</option>
    </select></td>
    <td><input class="key" type="number" step="1" placeholder="整数键"></td>
    <td><input class="val" type="text" maxlength="120" placeholder="短文本载荷"></td>
    <td><button type="button" class="delrow">✕</button></td>`;
  tr.querySelector('.op').value = op;
  tr.querySelector('.key').value = key;
  tr.querySelector('.val').value = value;
  tr.querySelector('.delrow').addEventListener('click', () => {
    tr.remove();
    updateRowsLeft();
  });
  tr.querySelector('.op').addEventListener('change', () => updateRowsLeft());
  els.tbody.appendChild(tr);
  updateRowsLeft();
}

function updateRowsLeft() {
  els.rowsLeft.textContent = MAX_ROWS - els.tbody.children.length;
  els.btnAddRow.disabled = els.tbody.children.length >= MAX_ROWS;
}

function readEdits() {
  return [...els.tbody.querySelectorAll('tr')].map((tr) => ({
    op: tr.querySelector('.op').value,
    key: tr.querySelector('.key').value,
    value: tr.querySelector('.val').value,
  }));
}

// ---------------- 存储后端 ----------------
async function currentDriver() {
  const wantMem = els.memoryMode.checked || els.crashEnabled.checked;
  if (wantMem && mode !== 'mem') {
    if (!memState.backend) memState.backend = { pages: new Map(), meta: new Map(), dead: false, log: [] };
    driver = new MemoryDriver(memState.backend);
    mode = 'mem';
    pendingCrash = false;
  } else if (!wantMem && mode !== 'idb') {
    driver = await IDBDriver.open();
    mode = 'idb';
    pendingCrash = false;
  }
  if (mode === 'mem' && driver.backend.dead) driver = driver.reopen();
  els.badge.textContent = mode === 'idb'
    ? '存储：IndexedDB（真实持久化）'
    : `存储：内存演习后端（断电 #${memState ? memState.seq : 0}）`;
  els.badge.className = 'badge ' + (mode === 'idb' ? 'idb' : 'mem');
  return driver;
}

// ---------------- 消息 ----------------
function clearMessages() { els.messages.innerHTML = ''; }
function message(kind, tag, html) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.innerHTML = `<span class="tag">${tag}</span>${html}`;
  els.messages.appendChild(div);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortId(id) { return id ? id.slice(0, 16) + '…' : '∅（空树）'; }

function renderRecovery(decisions) {
  if (!decisions || decisions.length === 0) return '';
  const items = decisions.map(d =>
    `<li><strong>${d.decision === 'COMPLETE_NEW_ROOT' ? '发布完整新根'
      : d.decision === 'OLD_ROOT_KEPT' ? '保留旧根' : '丢弃过期意图'}</strong>
     <span class="mono">[${esc(d.batchId)}]</span>：${esc(d.reason)}</li>`).join('');
  return `<ul>${items}</ul>`;
}

// ---------------- 提交 / 重开 / 刷新 ----------------
async function doCommit() {
  clearMessages();
  const batchId = els.batchId.value.trim();
  const edits = readEdits();
  let d;
  try {
    d = await currentDriver();
  } catch (err) {
    message('err', '存储不可用', esc(err.message));
    return;
  }

  const hooks = {};
  if (els.crashEnabled.checked) {
    const stage = els.crashStage.value;
    hooks.crashPlan = { stage, afterPages: Math.max(1, Number(els.crashAfterPages.value) || 1) };
  }

  try {
    const res = await commitBatch(d, { batchId, edits }, hooks);
    pendingCrash = false;
    if (res.replayed) {
      message('ok', '幂等重传',
        `批次「${esc(batchId)}」编辑等价，回放原回执 <span class="mono">${esc(res.receipt.receiptId.slice(0, 16))}…</span>，已发布根保持代次 <strong>${res.unchangedGeneration}</strong> 不变。`);
    } else {
      const n = res.newPageIds.length;
      message('ok', '批次已发布',
        `批次「${esc(batchId)}」完成：新根代次 <strong>${res.receipt.generation}</strong>，写时复制新页 <strong>${n}</strong> 张，回执 <span class="mono">${esc(res.receipt.receiptId.slice(0, 16))}…</span>`
        + renderRecovery(res.recovery.decisions));
    }
  } catch (err) {
    if (err.code === 'CRASH_INJECTED') {
      memState.seq++;
      pendingCrash = true;
      message('warn', '模拟断电',
        `已在<strong>${esc(stageLabel(els.crashStage.value))}</strong>中断，进程内驱动随即离线。<br>此时存储上只存在该时刻之前的证据；下方可查询视图仍停在断电前的已发布根。请点击「重开复核」——恢复结论只能是<em>保留旧根</em>或<em>发布可从根完整遍历的新根</em>。`);
    } else {
      pendingCrash = false;
      message('err', '批次被拒绝 · ' + esc(err.code || 'ERROR'),
        `<span class="reason">${esc(err.reason || err.message)}</span><br>已发布根不发生任何改变。`);
    }
  }
  await refresh();
}

async function doReopen() {
  clearMessages();
  const d = await currentDriver();
  const res = await recoverIfNeeded(d);
  pendingCrash = false;
  if (res.decisions.length === 0) {
    message('ok', '重开复核', '未发现任何未决阶段证据，可查询视图维持当前已发布根。');
  } else {
    const verdict = res.decisions.some(x => x.decision === 'COMPLETE_NEW_ROOT')
      ? 'ok' : 'warn';
    message(verdict, '重开复核结论', renderRecovery(res.decisions));
  }
  await refresh();
}

function stageLabel(stage) {
  return {
    'pages-mid': '阶段1·新页写入中途',
    pages: '阶段1·新页与清单完成后',
    intent: '阶段2·批次意图留下后',
    root: '阶段3·根指针切换后',
  }[stage] || stage;
}

// ---------------- 结果页渲染 ----------------
async function refresh() {
  let view;
  try {
    const d = await currentDriver();
    // 断电后未显式复核前，只读展示已发布根（recover:false），绝不暴露半写入候选
    view = await queryView(d, { recover: !pendingCrash });
  } catch (err) {
    message('err', '视图校验失败', `<span class="reason">${esc(err.reason || err.message)}</span>`);
    return;
  }

  els.metrics.innerHTML = [
    ['根代次', view.generation],
    ['可达页', `${view.reachablePages}<small>（叶 ${view.leafPages} / 内部 ${view.internalPages}）</small>`],
    ['树深', view.treeDepth || '—'],
    ['叶序列键数', view.entries.length],
    ['仓储存页', view.storedPageCount],
    ['根页摘要', `<small>${esc(shortId(view.rootId))}</small>`],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  // “分裂后所有键仍恰好一次出现”的显式核对
  const keys = view.entries.map(e => e.key);
  const uniq = new Set(keys);
  const sorted = [...keys].sort((a, b) => a - b);
  const exactlyOnce = uniq.size === keys.length && keys.every((k, i) => k === sorted[i]);
  els.onceBadge.className = 'once-badge ' + (exactlyOnce ? 'ok' : 'bad');
  els.onceBadge.textContent = exactlyOnce
    ? `✔ 恰好一次核对通过：${keys.length} 个键在叶序列中各出现一次，且严格升序`
    : '✘ 核对失败：存在重复或失序键（该视图不应被发布）';

  els.leafBody.innerHTML = view.entries.map((e, i) => `
    <tr><td class="num">${i + 1}</td><td class="num">${e.key}</td>
    <td>${esc(e.value)}</td><td class="mono">${e.pageId.slice(0, 16)}…</td>
    <td class="num">${e.generation ?? '—'}</td></tr>`).join('')
    || '<tr><td colspan="5" style="color:var(--muted)">当前为空树（旧根尚未发布任何航点）</td></tr>';

  els.pagesBody.innerHTML = view.pages.length === 0
    ? '<tr><td colspan="5" style="color:var(--muted)">无可达页</td></tr>'
    : view.pages.map(p => {
      const body = p.body;
      if (body.t === 'i') {
        return `<tr><td class="mono">${p.id.slice(0, 16)}…</td><td>内部</td>
        <td class="num">${p.depth}</td><td class="num">${body.g ?? '—'}</td>
        <td class="mono">keys=[${body.k.join(', ')}] children=${body.c.length}</td></tr>`;
      }
      return `<tr><td class="mono">${p.id.slice(0, 16)}…</td><td>叶</td>
      <td class="num">${p.depth}</td><td class="num">${body.g ?? '—'}</td>
      <td class="mono">keys=[${body.k.join(', ')}] next=${body.n ? body.n.slice(0, 10) + '…' : 'null'}</td></tr>`;
    }).join('');

  els.receiptsBody.innerHTML = view.receipts.map(r => `
    <tr><td>${esc(r.batchId)}</td>
    <td class="num">${r.baseGeneration} → ${r.generation}</td>
    <td class="num">${r.edits.length}</td>
    <td class="mono">${esc(r.receiptId.slice(0, 16))}…</td></tr>`).join('')
    || '<tr><td colspan="4" style="color:var(--muted)">尚无批次回执</td></tr>';
}

// ---------------- 事件 ----------------
els.btnAddRow.addEventListener('click', () => addRow());
els.btnClearRows.addEventListener('click', () => { els.tbody.innerHTML = ''; addRow('insert'); });
els.btnFillSplit.addEventListener('click', () => {
  els.tbody.innerHTML = '';
  [['insert', 10, 'WAYPOINT-10'], ['insert', 20, 'WAYPOINT-20'],
   ['insert', 5, 'WAYPOINT-5'], ['insert', 15, 'WAYPOINT-15']]
    .forEach(([op, k, v]) => addRow(op, k, v));
  if (!els.batchId.value.trim()) els.batchId.value = 'batch-split-' + Math.random().toString(36).slice(2, 8);
});
els.crashEnabled.addEventListener('change', async () => {
  els.afterPagesWrap.style.visibility = els.crashStage.value === 'pages-mid' ? 'visible' : 'hidden';
  await currentDriver().then(refresh);
});
els.crashStage.addEventListener('change', () => {
  els.afterPagesWrap.style.visibility = els.crashStage.value === 'pages-mid' ? 'visible' : 'hidden';
});
els.memoryMode.addEventListener('change', refresh);
els.btnCommit.addEventListener('click', doCommit);
els.btnReopen.addEventListener('click', doReopen);
els.btnRefresh.addEventListener('click', refresh);
els.btnWipe.addEventListener('click', async () => {
  if (!confirm('确认清空全部航点索引数据（IndexedDB 与内存演习后端）？')) return;
  try {
    const d = await IDBDriver.open();
    await d.destroy();
  } catch (err) {
    // 即使 IndexedDB 不可用也要继续清空内存后端
    if (mode !== 'mem') { message('err', '清空失败', esc(err.message)); return; }
  }
  memState.backend = { pages: new Map(), meta: new Map(), dead: false, log: [] };
  memState.seq = 0;
  pendingCrash = false;
  driver = null;
  mode = els.memoryMode.checked || els.crashEnabled.checked ? 'mem' : 'idb';
  await refresh();
  message('ok', '已清空', '持久化存储与演习后端均已重置，索引回到空树（代次 0）。');
});

// ---------------- 启动 ----------------
(async function init() {
  addRow('insert');
  addRow('insert');
  els.afterPagesWrap.style.visibility = 'hidden';
  try {
    driver = await IDBDriver.open();
    mode = 'idb';
  } catch (err) {
    els.memoryMode.checked = true;
    driver = await currentDriver();
    message('warn', 'IndexedDB 不可用', `已切换到内存演习后端：${esc(err.message)}`);
  }
  await refresh();
})();
