/* 磁盘自动备份：把浏览器里的数据另存一份到项目文件夹的 backups/
   由本地服务提供接口；换网址、清浏览器数据、换浏览器都能从这里恢复。 */

import * as db from './db.js';
import { relTime, fmtBytes } from './utils.js';
import store from './store.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-InkMark': '1' };

export const backup = {
  supported: false,
  checking: true,
  lastAt: 0,
  lastName: '',
  count: 0,
  dir: '',
  error: '',
  busy: false,
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  notify() { for (const fn of this.listeners) { try { fn(this); } catch (e) { console.error(e); } } },

  summary() {
    if (this.checking) return '检测中…';
    if (!this.supported) return '不可用（未通过本地服务打开）';
    if (!this.count) return '尚未生成备份';
    return `最近备份 ${relTime(this.lastAt)} · 共 ${this.count} 份`;
  },
};

let dirty = false;
let urgentTimer = null;
let interval = null;

export function markDirty(urgent = false) {
  if (!backup.supported) return;
  dirty = true;
  // 上传书籍、批量导入这类"重做成本高"的操作，尽快落盘
  if (urgent && !urgentTimer) {
    urgentTimer = setTimeout(() => { urgentTimer = null; flush('重要改动'); }, 6000);
  }
}

export async function probe() {
  try {
    const r = await fetch('/__backup/list', { headers: HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    backup.supported = !!d.ok;
    backup.count = d.count || 0;
    backup.dir = d.dir || '';
    backup.lastAt = d.backups?.[0]?.mtime || 0;
    backup.lastName = d.backups?.[0]?.name || '';
  } catch {
    backup.supported = false;
  }
  backup.checking = false;
  backup.notify();
  return backup.supported;
}

export async function listBackups() {
  const r = await fetch('/__backup/list', { headers: HEADERS });
  if (!r.ok) throw new Error('无法读取备份列表');
  const d = await r.json();
  backup.count = d.count || 0;
  backup.lastAt = d.backups?.[0]?.mtime || 0;
  backup.lastName = d.backups?.[0]?.name || '';
  backup.dir = d.dir || backup.dir;
  backup.notify();
  return d.backups || [];
}

const MIN_GAP = 120000;   // 自动备份最短间隔，避免频繁写盘

export async function flush(reason = '定时备份', { force = false } = {}) {
  if (!backup.supported || backup.busy) return false;
  const hasData = store_hasData();
  if (!hasData) { dirty = false; return false; }
  if (!force && backup.lastAt && Date.now() - backup.lastAt < MIN_GAP) return false;
  backup.busy = true;
  try {
    const payload = await db.exportAll();
    payload.origin = location.origin;
    payload.savedAt = Date.now();
    payload.reason = reason;
    const r = await fetch('/__backup', { method: 'POST', headers: HEADERS, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || '写入失败');
    dirty = false;
    backup.lastAt = Date.now();
    backup.lastName = d.name;
    backup.count = d.count;
    backup.dir = d.dir || backup.dir;
    backup.error = '';
    backup.notify();
    return true;
  } catch (e) {
    backup.error = e.message || String(e);
    backup.notify();
    return false;
  } finally {
    backup.busy = false;
  }
}

/** 从某个备份文件恢复（会覆盖当前数据） */
export async function restoreFrom(name) {
  const r = await fetch(`/__backup/file?name=${encodeURIComponent(name)}`, { headers: HEADERS });
  if (!r.ok) throw new Error('备份文件读取失败');
  const payload = await r.json();
  await db.importAll(payload);
  return payload;
}

export function describeBackup(b) {
  return `${relTime(b.mtime)} · ${fmtBytes(b.size)}`;
}

/** 只有真的有东西才值得备份，避免每天生成一堆空文件 */
function store_hasData() {
  const s = store.state;
  return s.books.length > 0 || s.notes.length > 0 || s.terms.length > 0;
}

export function initBackup() {
  probe().then(ok => {
    if (ok) {
      // 启动后如果已有内容，先留一份
      markDirty(false);
    }
  });
  if (!interval) {
    interval = setInterval(() => { if (dirty) flush('定时备份'); }, 30000);
  }
  // 页面转入后台时也尝试落一份（切标签页、最小化）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty) flush('离开页面');
  });
}
