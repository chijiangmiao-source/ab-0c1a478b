// IndexedDB 持久化驱动：两个对象仓 pages（keyPath: 'id'）与 meta（keyPath: 'key'）。
// 每次 put 各自是独立事务；commit 协议保证任意断电点下“旧根或完整新根”的不变量。
// 结构与内存驱动一致，因此规则测试在内存后端上覆盖全部恢复路径。

const DB_NAME = 'waypoint-exchange-v1';
const DB_VERSION = 1;

export class IDBDriver {
  constructor(db) { this.db = db; }

  static async open() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IDBDriver(db);
  }

  #tx(storeName, mode) {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }

  #req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getMeta(key) {
    const row = await this.#req(this.#tx('meta', 'readonly').get(key));
    return row ? row.value : null;
  }
  async putMeta(key, value) {
    await this.#req(this.#tx('meta', 'readwrite').put({ key, value }));
  }
  async deleteMeta(key) {
    await this.#req(this.#tx('meta', 'readwrite').delete(key));
  }
  async listMetaByPrefix(prefix) {
    const rows = await this.#req(this.#tx('meta', 'readonly').getAll());
    return rows.filter(r => r.key.startsWith(prefix)).map(r => [r.key, r.value]);
  }

  async putPage(id, body) {
    const tx = this.db.transaction('pages', 'readwrite');
    const reqP = new Promise((resolve, reject) => {
      const req = tx.objectStore('pages').put(body);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await Promise.all([reqP, new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(t.error);
    })]);
  }
  async getPage(id) {
    return this.#req(this.#tx('pages', 'readonly').get(id));
  }
  async hasPage(id) {
    const row = await this.#req(this.#tx('pages', 'readonly').get(id));
    return !!row;
  }
  async deletePage(id) {
    await this.#req(this.#tx('pages', 'readwrite').delete(id));
  }
  async listPages() {
    const rows = await this.#req(this.#tx('pages', 'readonly').getAll());
    return rows.map(r => [r.id, r]);
  }

  async losePower() { /* 真实浏览器靠物理断电；页面演习使用内存后端 */ }

  async destroy() {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    this.db.close();
  }
}
