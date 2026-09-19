/* 正文块的渲染与标记绘制 */

import { el } from '../core/utils.js';
import { findTermMatches, segmentBlock, primaryAnnotation } from './anchors.js';

const TAG = { h2: 'h2', h3: 'h3', p: 'p', li: 'div', q: 'blockquote', code: 'pre', img: 'div', page: 'div', hr: 'div' };

export const annKind = a => a?.kind || a?.style || 'hl';

export function blockClassName(block) {
  return `blk ${block.t}${block.t === 'img' ? ' img' : ''}`;
}

export function createBlockEl(block) {
  const node = el(TAG[block.t] || 'p', { class: blockClassName(block) });
  node.dataset.blockId = block.id;
  if (block.n) node.dataset.page = block.n;
  return node;
}

/** 把块内容画成「最小片段」序列，片段文本拼接后严格等于原文 */
export function paintBlock(node, block, anns, terms, ui) {
  const text = block.x || '';
  if (block.t === 'page') { node.textContent = text; return; }
  if (block.t === 'img') { node.textContent = text || '〔图片〕'; return; }

  const termMatches = ui.autoTermHighlight ? findTermMatches(text, terms, { minLen: ui.minTermLen }) : [];
  if (!anns.length && !termMatches.length) { node.textContent = text; return; }

  const segs = segmentBlock(text, anns, termMatches);
  const annsById = new Map(anns.map(a => [a.id, a]));
  const noteEndOffsets = new Set(anns.filter(a => (a.note || '').trim()).map(a => a.end));
  const termById = new Map((terms || []).map(t => [t.id, t]));
  const frag = document.createDocumentFragment();

  for (const seg of segs) {
    const span = document.createElement('span');
    span.className = 'sg';
    span.textContent = seg.text;

    if (seg.termId) {
      span.dataset.term = seg.termId;
      const t = termById.get(seg.termId);
      span.style.setProperty('--term-color', t?.color || 'var(--accent-2)');
    }

    const primary = primaryAnnotation(seg, annsById);
    let primaryId = null;
    if (primary) {
      primaryId = primary.id;
      span.dataset.ann = seg.annIds.join(' ');
      const k = annKind(primary);
      if (k === 'ul') { span.dataset.ul = '1'; span.style.setProperty('--ul', primary.color || 'var(--accent)'); }
      else if (k === 'wavy') { span.dataset.ul = 'wavy'; span.style.setProperty('--ul', primary.color || 'var(--accent-2)'); }
      else if (k === 'strike') { span.dataset.ul = 'strike'; }
      else { span.dataset.hl = 'on'; span.style.setProperty('--hl', primary.color || '#ffdf7e'); }
      // 只要这一段的结束位置正好是某条「写了内容」的批注结尾，就打上批注圆点
      if (noteEndOffsets.has(seg.end) && seg.annIds.some(id => (annsById.get(id)?.note || '').trim())) span.classList.add('note-end');
    }
    if (!span.dataset.hl) span.dataset.hl = 'none';
    span.dataset.primary = primaryId || '';
    frag.append(span);
  }
  node.replaceChildren(frag);
}

/** 重新绘制某个块（正文局部刷新，避免整章重排） */
export function repaintBlock(blockEl, block, anns, terms, ui) {
  paintBlock(blockEl, block, anns, terms, ui);
}

export function segElsForAnn(container, annId) {
  return Array.from(container.querySelectorAll('.sg')).filter(s => (s.dataset.ann || '').split(' ').includes(annId));
}

/** 定位到某条批注并闪烁 */
export function flashAnnotation(container, ann) {
  const blockEl = container.querySelector(`[data-block-id="${CSS.escape(ann.blockId)}"]`);
  if (!blockEl) return false;
  blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  blockEl.classList.add('flash');
  setTimeout(() => blockEl.classList.remove('flash'), 1200);
  setTimeout(() => {
    for (const s of segElsForAnn(container, ann.id)) {
      s.classList.add('pulse');
      setTimeout(() => s.classList.remove('pulse'), 950);
    }
  }, 260);
  return true;
}

/** 定位到术语的某次出现 */
export function flashTerm(container, termId, nth = 0) {
  const hits = Array.from(container.querySelectorAll(`.sg[data-term="${CSS.escape(termId)}"]`));
  const target = hits[nth] || hits[0];
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('term-hit');
  setTimeout(() => target.classList.remove('term-hit'), 2300);
  return true;
}

/** 列出术语在正文中的出现位置（用于术语卡「出处」） */
export function findTermOccurrences(container, termId) {
  return Array.from(container.querySelectorAll(`.sg[data-term="${CSS.escape(termId)}"]`))
    .map((s, i) => {
      const blockEl = s.closest('.blk');
      const ctx = blockEl.textContent;
      const i2 = ctx.indexOf(s.textContent);
      return {
        index: i, blockId: blockEl.dataset.blockId,
        before: ctx.slice(Math.max(0, i2 - 18), i2),
        match: s.textContent,
        after: ctx.slice(i2 + s.textContent.length, i2 + s.textContent.length + 18),
      };
    });
}

/** 事件委托：点击与悬停（悬停由 selection.js 提供回调） */
export function bindMarkEvents(root, { onClickMark, onHoverMark, onLeaveMark }) {
  root.addEventListener('click', e => {
    const sg = e.target.closest?.('.sg');
    if (!sg || !root.contains(sg)) return;
    if (window.getSelection()?.toString()) return; // 正在选择文字时不触发
    onClickMark?.(sg);
  });
  root.addEventListener('mouseover', e => {
    const sg = e.target.closest?.('.sg');
    if (!sg || !root.contains(sg)) return;
    if (sg === root.__lastHover) return;
    root.__lastHover = sg;
    onHoverMark?.(sg);
  });
  root.addEventListener('mouseout', e => {
    const sg = e.target.closest?.('.sg');
    if (!sg) return;
    const to = e.relatedTarget;
    if (to && sg.contains(to)) return;
    if (root.__lastHover === sg) root.__lastHover = null;
    onLeaveMark?.(sg);
  });
}
