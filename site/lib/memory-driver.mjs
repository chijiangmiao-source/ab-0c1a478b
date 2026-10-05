// 内存持久化驱动（规则测试与页面“演习”使用）。
// 多个驱动实例可共享同一后端，模拟“断电后重开”：此前已完成的写入全部保留，
// 未执行的写入自然不存在。

export class MemoryDriver {
  constructor(backend = null) {
    this.backend = backend || { pages: new Map(), meta: new Map(), dead: false, log: [] };
  }

  reopen() {
    this.backend.dead = false;
    return new MemoryDriver(this.backend);
  }

  #checkAlive() {
    if (this.backend.dead) throw new Error('存储已因断电离线，请重开');
  }

  async getMeta(key) { this.#checkAlive(); return this.backend.meta.get(key) ?? null; }
  async putMeta(key, value) { this.#checkAlive(); this.backend.meta.set(key, clone(value)); this.backend.log.push(['meta', key]); }
  async deleteMeta(key) { this.#checkAlive(); this.backend.meta.delete(key); }
  listMetaByPrefix(prefix) {
    this.#checkAlive();
    return [...this.backend.meta.entries()].filter(([k]) => k.startsWith(prefix));
  }

  async getPage(id) { this.#checkAlive(); return this.backend.pages.get(id) ?? null; }
  async putPage(id, body) { this.#checkAlive(); this.backend.pages.set(id, clone(body)); this.backend.log.push(['page', id]); }
  hasPage(id) { this.#checkAlive(); return this.backend.pages.has(id); }
  async deletePage(id) { this.#checkAlive(); this.backend.pages.delete(id); }
  listPages() { this.#checkAlive(); return [...this.backend.pages.entries()]; }

  // 模拟断电：驱动离线，已写入数据留在后端
  async losePower(stage) {
    this.backend.log.push(['crash', stage]);
    this.backend.dead = true;
  }

  snapshot() {
    return {
      pages: new Map([...this.backend.pages].map(([k, v]) => [k, clone(v)])),
      meta: new Map([...this.backend.meta].map(([k, v]) => [k, clone(v)])),
    };
  }
}

function clone(v) {
  return typeof structuredClone === 'function'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}
