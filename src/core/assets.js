/* 导入的 Markdown 里引用的图片：存在本地，渲染时换成可显示的对象地址 */

import * as db from './db.js';

const urls = new Map();            // `${bookId}::${path}` → objectURL
const indexes = new Map();         // bookId → Map(路径或文件名 → 资源 id)

/** 建立"路径 / 文件名 → 资源 id"的索引，兼容 md 里写成 images/x.jpg 或 ./x.jpg 的情况 */
export async function assetIndex(bookId) {
  if (indexes.has(bookId)) return indexes.get(bookId);
  const rows = await db.getAllBy('assets', 'bookId', bookId).catch(() => []);
  const map = new Map();
  for (const r of rows) {
    map.set(r.path, r.id);
    map.set(r.path.replace(/^\.\//, ''), r.id);
    const base = r.path.split('/').pop();
    if (!map.has(base)) map.set(base, r.id);
  }
  indexes.set(bookId, map);
  return map;
}

const normalize = p => String(p || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');

export async function resolveAssetUrl(bookId, path) {
  const p = normalize(path);
  if (!p) return null;
  if (/^(data:|https?:|blob:)/i.test(p)) return p;      // 已经是自带地址
  const cacheKey = `${bookId}::${p}`;
  if (urls.has(cacheKey)) return urls.get(cacheKey);

  const idx = await assetIndex(bookId);
  const id = idx.get(p) || idx.get(p.split('/').pop());
  if (!id) return null;

  const rec = await db.get('assets', id);
  if (!rec?.blob) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(cacheKey, url);
  return url;
}

/** 换书或删书时释放内存里的图片地址 */
export function clearAssetCache(bookId) {
  for (const [k, u] of Array.from(urls)) {
    if (!bookId || k.startsWith(`${bookId}::`)) { try { URL.revokeObjectURL(u); } catch {} urls.delete(k); }
  }
  if (bookId) indexes.delete(bookId); else indexes.clear();
}

export const assetStats = () => ({ cached: urls.size, books: indexes.size });
