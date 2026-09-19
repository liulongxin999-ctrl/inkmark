/* IndexedDB 薄封装：所有持久化的唯一出口 */

const DB_NAME = 'inkmark';
const DB_VERSION = 1;

const SCHEMA = {
  books: { keyPath: 'id', indexes: [['lastReadAt', 'lastReadAt']] },
  chapters: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
  annotations: { keyPath: 'id', indexes: [['bookId', 'bookId'], ['chapterId', 'chapterId'], ['groupId', 'groupId']] },
  terms: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
  notes: { keyPath: 'id', indexes: [['status', 'status'], ['bookId', 'bookId']] },
  bookmarks: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
  files: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
  stats: { keyPath: 'day', indexes: [] },
  settings: { keyPath: 'key', indexes: [] },
};

let _db = null;

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idxName, path] of def.indexes) os.createIndex(idxName, path);
      }
    };
    open.onsuccess = () => { _db = open.result; resolve(_db); };
    open.onerror = () => reject(open.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let out, settled = false;
    const fail = err => { if (settled) return; settled = true; reject(err); };
    // 关键：写操作必须等事务真正提交成功才算成功，
    // 否则「请求成功但事务最终回滚」（例如超出配额）会被误判为保存成功。
    t.oncomplete = () => { if (settled) return; settled = true; resolve(out); };
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error || new Error('transaction aborted'));
    try {
      const stores = Object.fromEntries(names.map(n => [n, t.objectStore(n)]));
      out = fn(stores, t);
      if (out && typeof out.then === 'function') {
        out.then(v => { out = v; }, err => { try { t.abort(); } catch {} fail(err); });
      }
    } catch (e) { try { t.abort(); } catch {} fail(e); }
  });
}

export const get = (store, key) => tx(store, 'readonly', s => req(s[store].get(key)));
export const getAll = store => tx(store, 'readonly', s => req(s[store].getAll()));
export const count = store => tx(store, 'readonly', s => req(s[store].count()));
export const put = (store, value) => tx(store, 'readwrite', s => req(s[store].put(value)));
export const del = (store, key) => tx(store, 'readwrite', s => req(s[store].delete(key)));
export const clear = store => tx(store, 'readwrite', s => req(s[store].clear()));

export function getAllBy(store, indexName, value) {
  return tx(store, 'readonly', s => req(s[store].index(indexName).getAll(value)));
}

export function putMany(store, values) {
  return tx(store, 'readwrite', s => { for (const v of values) s[store].put(v); });
}

export function delMany(store, keys) {
  return tx(store, 'readwrite', s => { for (const k of keys) s[store].delete(k); });
}

/** 删除一本书及其全部关联数据 */
export async function deleteBookCascade(bookId) {
  const [chs, anns, terms, notes, bms, files] = await Promise.all([
    getAllBy('chapters', 'bookId', bookId),
    getAllBy('annotations', 'bookId', bookId),
    getAllBy('terms', 'bookId', bookId),
    getAllBy('notes', 'bookId', bookId),
    getAllBy('bookmarks', 'bookId', bookId),
    getAllBy('files', 'bookId', bookId),
  ]);
  await tx(Object.keys(SCHEMA), 'readwrite', s => {
    chs.forEach(c => s.chapters.delete(c.id));
    anns.forEach(a => s.annotations.delete(a.id));
    terms.forEach(t => s.terms.delete(t.id));
    notes.forEach(n => s.notes.delete(n.id));
    bms.forEach(b => s.bookmarks.delete(b.id));
    files.forEach(f => s.files.delete(f.id));
    s.books.delete(bookId);
  });
}

export async function wipeAll() {
  await tx(Object.keys(SCHEMA), 'readwrite', s => {
    for (const n of Object.keys(SCHEMA)) s[n].clear();
  });
}

export async function exportAll() {
  const out = { app: 'inkmark', version: DB_VERSION, exportedAt: Date.now(), data: {} };
  for (const name of Object.keys(SCHEMA)) {
    if (name === 'files') continue; // 原文件不入备份，避免体积爆炸
    out.data[name] = await getAll(name);
  }
  return out;
}

export async function importAll(payload) {
  if (!payload?.data) throw new Error('备份文件格式不正确');
  await wipeAll();
  for (const [name, rows] of Object.entries(payload.data)) {
    if (!SCHEMA[name] || !Array.isArray(rows) || !rows.length) continue;
    await putMany(name, rows);
  }
}

export { SCHEMA };
