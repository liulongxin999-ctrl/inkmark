/* 文本锚定与分段：纯函数，可独立测试 */

import { escRe, clamp } from '../core/utils.js';

/** 在文本中找出术语（含别名）的所有出现位置，长词优先、去掉重叠 */
export function findTermMatches(text, terms, { minLen = 2 } = {}) {
  const hits = [];
  for (const t of terms || []) {
    const names = new Set(
      [t.name, ...(t.aliases || [])]
        .map(s => String(s || '').trim())
        .filter(s => s.length >= Math.max(1, minLen)),
    );
    for (const name of names) {
      const re = new RegExp(escRe(name), 'g');
      let m;
      while ((m = re.exec(text))) {
        hits.push({ start: m.index, end: m.index + name.length, termId: t.id, len: name.length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || b.len - a.len);
  const chosen = [];
  for (const h of hits) {
    if (chosen.some(c => h.start < c.end && h.end > c.start)) continue;
    chosen.push(h);
  }
  return chosen;
}

/**
 * 一次边界扫描，把「批注区间」和「术语区间」切成互不重叠的最小片段。
 * 片段文本首尾相接严格等于原文，因此字符偏移永远有效。
 */
export function segmentBlock(text, anns = [], termMatches = []) {
  const n = text.length;
  const points = new Set([0, n]);
  for (const a of anns) {
    const s = clamp(a.start, 0, n), e = clamp(a.end, 0, n);
    if (e > s) { points.add(s); points.add(e); }
  }
  for (const t of termMatches) { points.add(t.start); points.add(t.end); }

  const pts = Array.from(points).sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (e <= s) continue;
    const annIds = [];
    for (const a of anns) if (a.start <= s && a.end >= e) annIds.push(a.id);
    const tm = termMatches.find(t => t.start <= s && t.end >= e) || null;
    segs.push({
      start: s, end: e, text: text.slice(s, e),
      annIds, termId: tm ? tm.termId : null, termEnd: tm ? tm.end : -1,
    });
  }
  return segs;
}

/** 同一位置可能有多个批注，取「最具体（区间最短）」的那个作为视觉主标记 */
export function primaryAnnotation(seg, annsById) {
  const list = seg.annIds.map(id => annsById.get(id)).filter(Boolean);
  list.sort((a, b) => (a.end - a.start) - (b.end - b.start) || (b.createdAt || 0) - (a.createdAt || 0));
  return list[0] || null;
}

/** 生成可持久化的锚点描述（含冗余校验信息） */
export function describeRange(text, start, end) {
  const s = clamp(start, 0, text.length), e = clamp(end, 0, text.length);
  return {
    start: s, end: e,
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - 24), s),
    suffix: text.slice(e, Math.min(text.length, e + 24)),
  };
}

/** 用锚点还原区间；先精确校验，再模糊回退 */
export function resolveRange(text, anchor) {
  if (!anchor) return null;
  const { start, end, quote } = anchor;
  if (Number.isInteger(start) && Number.isInteger(end) && text.slice(start, end) === quote) return { start, end };
  if (!quote) return null;
  let idx = text.indexOf(quote);
  if (idx >= 0) return { start: idx, end: idx + quote.length };
  // 用前后文夹逼
  const p = anchor.prefix || '', s = anchor.suffix || '';
  if (p || s) {
    const i = p ? text.indexOf(p) : 0;
    if (i >= 0) {
      const from = i + p.length;
      const j = text.indexOf(quote, Math.max(0, from - 8));
      if (j >= 0) return { start: j, end: j + quote.length };
    }
  }
  return null;
}

/** 把锚点区间与正文比对，标出是否已失效 */
export const anchorValid = (text, ann) => text.slice(ann.start, ann.end) === ann.quote;

/** 选区在一个块内的字符偏移（依赖 Range.toString 的长度） */
export function offsetInElement(rootEl, node, offset) {
  const r = document.createRange();
  r.setStart(rootEl, 0);
  try { r.setEnd(node, offset); } catch { return null; }
  return r.toString().length;
}
