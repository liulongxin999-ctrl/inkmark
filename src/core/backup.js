/* 磁盘备份：把浏览器里的数据另存一份到项目文件夹的 backups/

   备份时机（设置 → 自动备份时机）：
     close  —— 关闭 / 离开页面时自动备份一次（默认，最不打扰）
     hourly —— 每小时备份一次（适合长时间挂着页面的场景）
     manual —— 只在点「立即备份」时备份

   为什么不是"随时备份"：浏览器在页面关闭时只允许发送 64KB 以内的信标请求
   （sendBeacon）。所以关闭时如果数据太大发不出去，就记一个「待备份」标记，
   下次打开时询问用户要不要补一次。 */

import * as db from './db.js';
import { relTime, fmtBytes, debounce } from './utils.js';
import store from './store.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-InkMark': '1' };
const PENDING_KEY = 'inkmark:pending-backup';
const BEACON_MAX = 60000;     // sendBeacon 的实际上限约 64KB，留些余量
const MIN_GAP = 5 * 60 * 1000;

export const backup = {
  supported: false,
  checking: true,
  lastAt: 0,
  lastName: '',
  count: 0,
  dir: '',
  error: '',
  busy: false,
  dirty: false,         // 有没有"还没保存"的改动（界面上的小圆点看它）
  pending: null,        // { at, bytes, why } —— 上次离开时没能自动备份
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  notify() { for (const fn of this.listeners) { try { fn(this); } catch (e) { console.error(e); } } },

  mode: () => store.ui.backupMode || 'close',

  summary() {
    if (this.checking) return '检测中…';
    if (!this.supported) return '不可用（未通过本地服务打开）';
    const when = { close: '关闭页面时备份', hourly: '每小时备份一次', manual: '仅手动备份' }[this.mode()] || '';
    if (!this.count) return `${when} · 还没有生成备份`;
    return `${when} · 最近备份 ${relTime(this.lastAt)}（共 ${this.count} 份）`;
  },
};

let dirty = false;
let snapshot = null;          // 内存快照：关闭页面时直接发它，不用再读数据库
let hourlyTimer = null;
backup.pending = readPending();   // 模块加载就能知道"上次有没有没备成的改动"

/** 未保存状态：既更新内部标记，也通知界面（保存按钮上的小圆点） */
function setDirty(v) {
  if (dirty === v && backup.dirty === v) return;
  dirty = v;
  backup.dirty = v;
  backup.notify();
}

/* ---------------- 待备份标记（存 localStorage，跨会话保留） ---------------- */
function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setPending(bytes, why) {
  backup.pending = { at: Date.now(), bytes, why };
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(backup.pending)); } catch {}
  backup.notify();
}

export function clearPending() {
  backup.pending = null;
  try { localStorage.removeItem(PENDING_KEY); } catch {}
  backup.notify();
}

/* ---------------- 有没有值得备份的内容 ---------------- */
function hasData() {
  const s = store.state;
  return s.books.length > 0 || s.notes.length > 0 || s.terms.length > 0;
}

/** 任何写入后调用：3 秒后在内存里生成快照（纯内存，不写磁盘） */
export function markDirty() {
  if (!backup.supported) return;
  setDirty(true);
  // 「仅手动」模式不需要提前生成快照，但"未保存"标记一样要有
  if (backup.mode() !== 'manual') scheduleSnapshot();
}

const scheduleSnapshot = debounce(async () => {
  if (!hasData()) { snapshot = null; setDirty(false); return; }
  try {
    const p = await db.exportAll();
    p.origin = location.origin;
    p.savedAt = Date.now();
    p.reason = '关闭页面时自动备份';
    snapshot = p;
  } catch (e) { console.error('[备份] 生成快照失败', e); }
}, 3000);

/* ---------------- 关闭页面时备份 ---------------- */
export function flushOnLeave() {
  if (!backup.supported || !dirty) return 'skip';
  if (!hasData()) return 'empty';
  if (!snapshot) { setPending(0, '数据还没准备好'); return 'pending'; }

  const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
  if (blob.size > BEACON_MAX) {
    setPending(blob.size, '数据超过浏览器关闭时能发送的大小');
    return 'too-big';
  }
  let ok = false;
  try { ok = navigator.sendBeacon?.('/__backup', blob) === true; } catch { ok = false; }
  if (ok) { setDirty(false); clearPending(); return 'sent'; }
  setPending(blob.size, '浏览器没有接受这次发送');
  return 'failed';
}

/* ---------------- 探测与列表 ---------------- */
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
  backup.pending = readPending();
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

/* ---------------- 真正写盘（手动按钮 / 补备份） ---------------- */
export async function flush(reason = '手动备份', { force = false } = {}) {
  if (!backup.supported || backup.busy) return false;
  if (!hasData()) { setDirty(false); return false; }
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
    setDirty(false);
    snapshot = payload;
    backup.lastAt = Date.now();
    backup.lastName = d.name;
    backup.count = d.count;
    backup.dir = d.dir || backup.dir;
    backup.error = '';
    clearPending();
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

export function describePending() {
  const p = backup.pending;
  if (!p) return '';
  return p.bytes ? `${relTime(p.at)}（约 ${fmtBytes(p.bytes)}）` : relTime(p.at);
}

/* ---------------- 初始化 ---------------- */
export function initBackup() {
  probe();

  // 关闭 / 离开页面时自动备份一次
  const leave = () => { flushOnLeave(); };
  window.addEventListener('pagehide', leave);
  window.addEventListener('beforeunload', leave);

  // hourly 模式才跑定时器；默认模式下没有任何周期性备份
  const syncHourly = () => {
    if (hourlyTimer) { clearInterval(hourlyTimer); hourlyTimer = null; }
    if (backup.mode() === 'hourly' && backup.supported) {
      hourlyTimer = setInterval(() => { if (dirty) flush('每小时自动备份'); }, 60 * 1000);
    }
  };
  syncHourly();
  store.bus.on('ui', patch => { if ('backupMode' in patch) syncHourly(); });
}
