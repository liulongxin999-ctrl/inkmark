/* 基础工具：DOM、事件、格式化、配色 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 安全地整体替换子节点：过滤掉 null / undefined / false。
 * 直接用 replaceChildren 会把它们变成字面文本「null」「false」。
 */
export function setChildren(parent, ...children) {
  if (!parent) return parent;
  const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false);
  parent.replaceChildren(...flat);
  return parent;
}

/** 创建元素：el('div',{class:'x',dataset:{k:1},on:{click:fn}},'文本',childEl) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function svg(path, extra = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  s.append(p);
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'cls') s.setAttribute('class', v);
    else if (k === 'fill') { s.setAttribute('fill', v); p.setAttribute('fill', v); }
    else s.setAttribute(k, v);
  }
  return s;
}

export const ICONS = {
  edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  note: 'M5 3h11l4 4v14H5zM16 3v4h4',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7 7h.01',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  jump: 'M7 17L17 7M9 7h8v8',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M7 9l5-5 5 5M4 17v3h16v-3',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 18.5',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  doc: 'M5 3h11l4 4v14H5zM16 3v4h4M8.5 12h7M8.5 16h4.5',
  msg: 'M4 5h16v11H8l-4 4z',
};

let _seq = 0;
export function uid(prefix = 'id') {
  _seq = (_seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce(fn, ms = 250) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...a) => { clearTimeout(t); fn(...a); };
  return wrapped;
}

export function throttle(fn, ms = 120) {
  let last = 0, timer = null, pend = null;
  return (...a) => {
    pend = a;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...pend); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...pend); }, ms - (now - last));
  };
}

export const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const escRe = (s = '') => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function fmtBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtNum(n = 0) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(n);
}

const pad = n => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fmtTime(ts, withDate = true) {
  if (!ts) return '—';
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}月${d.getDate()}日 ${t}` : t;
}

export function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtTime(ts);
}

export function fmtDuration(sec = 0) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分钟`;
  return `${sec} 秒`;
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const downloadText = (filename, text, mime = 'text/plain;charset=utf-8') =>
  downloadBlob(filename, new Blob([text], { type: mime }));

export function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsText(file, 'UTF-8');
  });
}

export function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

/** 极简事件总线 */
export class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) { (this.map.get(ev) || this.map.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this.map.get(ev)?.delete(fn); }
  emit(ev, payload) {
    for (const fn of this.map.get(ev) || []) { try { fn(payload); } catch (e) { console.error(`[bus:${ev}]`, e); } }
    for (const fn of this.map.get('*') || []) { try { fn(ev, payload); } catch (e) { console.error(e); } }
  }
}

/** 高亮配色 */
export const HL_COLORS = [
  { key: '#ffdf7e', name: '琥珀' },
  { key: '#a9ecc4', name: '薄荷' },
  { key: '#a8d8ff', name: '天青' },
  { key: '#d6c4ff', name: '紫藤' },
  { key: '#ffc2c4', name: '绯桃' },
  { key: '#e6d7b4', name: '沙褐' },
];

export const BOOK_COLORS = ['#8c3a2b', '#2f5d7c', '#3f6b4a', '#6b4a8c', '#8a6a22', '#2d6b6b', '#7a3d5c', '#455163'];

export const ANN_KINDS = [
  { id: 'hl', name: '高亮' },
  { id: 'ul', name: '下划线' },
  { id: 'wavy', name: '波浪线' },
  { id: 'strike', name: '删除线' },
  { id: 'note', name: '批注' },
];

/** 简化 SM-2 间隔重复 */
export function nextReview(review = {}, grade = 'good') {
  const r = { interval: review.interval || 0, ease: review.ease || 2.5, reps: review.reps || 0 };
  if (grade === 'again') { r.interval = 0; r.reps = 0; r.ease = Math.max(1.4, r.ease - 0.25); }
  else {
    r.reps += 1;
    if (grade === 'hard') { r.ease = Math.max(1.4, r.ease - 0.12); r.interval = r.reps === 1 ? 1 : Math.max(1, Math.round((r.interval || 1) * 1.35)); }
    else { r.ease = Math.min(3.2, r.ease + 0.08); r.interval = r.reps === 1 ? 2 : r.reps === 2 ? 5 : Math.round((r.interval || 5) * r.ease); }
  }
  r.interval = Math.min(r.interval, 365);
  const due = new Date(); due.setHours(4, 0, 0, 0);
  due.setDate(due.getDate() + Math.max(grade === 'again' ? 0 : r.interval, grade === 'again' ? 0 : 0));
  r.due = due.getTime();
  r.last = Date.now();
  return r;
}

export const isDue = r => !r?.due || r.due <= Date.now();

/** 分数排序式模糊匹配 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().trim(), t = String(text || '').toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500;
  if (t.includes(q)) return 300 - Math.min(200, t.indexOf(q));
  let i = 0, score = 0;
  for (const ch of t) { if (ch === q[i]) { i++; score += 6; } if (i >= q.length) break; }
  return i >= q.length ? score : 0;
}

/** 高亮搜索命中片段 */
export function snippet(text, query, radius = 60) {
  const t = String(text || '');
  const i = t.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (i < 0) return t.slice(0, radius * 2) + (t.length > radius * 2 ? '…' : '');
  const s = Math.max(0, i - radius), e = Math.min(t.length, i + query.length + radius);
  return (s > 0 ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : '');
}
