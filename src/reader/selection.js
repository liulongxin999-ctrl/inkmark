/* 选区捕获 · 浮动工具条 · 悬停气泡 · 从选区创建批注 */

import { $, el, svg, ICONS, HL_COLORS, uid, clamp, esc, debounce, setChildren } from '../core/utils.js';
import store from '../core/store.js';
import { offsetInElement, describeRange } from './anchors.js';
import { annKind } from './marks.js';

let toolbar = null;
let hoverCard = null;
let hoverTimer = null;
let currentSel = null;

const blockOf = node => node?.nodeType === 1 ? node.closest('.blk') : node?.parentElement?.closest('.blk');

/** 把浏览器选区转成 [{blockId, start, end, text}] */
export function collectSelectionRanges(range, root) {
  const startEl = blockOf(range.startContainer), endEl = blockOf(range.endContainer);
  if (!startEl || !endEl || !root.contains(startEl) || !root.contains(endEl)) return [];
  const blocks = Array.from(root.querySelectorAll('.blk')).filter(b => b.dataset.blockId);
  const i = blocks.indexOf(startEl), j = blocks.indexOf(endEl);
  if (i < 0 || j < 0) return [];
  const lo = Math.min(i, j), hi = Math.max(i, j);
  const out = [];
  for (let k = lo; k <= hi; k++) {
    const be = blocks[k];
    const text = be.textContent || '';
    const type = Array.from(be.classList).find(c => ['page', 'img'].includes(c));
    let s = 0, e = text.length;
    if (k === i) { const o = offsetInElement(be, range.startContainer, range.startOffset); if (o != null) s = o; }
    if (k === j) { const o = offsetInElement(be, range.endContainer, range.endOffset); if (o != null) e = o; }
    if (k === i && k === j) { /* 单块 */ }
    s = clamp(s, 0, text.length); e = clamp(e, 0, text.length);
    if (e <= s) continue;
    let sub = text.slice(s, e);
    if (!sub.trim()) continue;
    // 掐掉首尾空白，保证锚点干净
    const lead = sub.length - sub.trimStart().length;
    const tail = sub.length - sub.trimEnd().length;
    s += lead; e -= tail;
    if (e <= s) continue;
    out.push({ blockId: be.dataset.blockId, start: s, end: e, text: text.slice(s, e), blockType: type || 'p' });
  }
  return out;
}

export function initSelection({ root, getChapter, onAfterCreate }) {
  toolbar = $('#sel-toolbar');
  hoverCard = $('#hover-card');

  const hideToolbar = () => { if (toolbar) toolbar.hidden = true; };
  const hideHover = () => { if (hoverCard) hoverCard.hidden = true; clearTimeout(hoverTimer); };

  const capture = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideToolbar();
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return hideToolbar();
    const ranges = collectSelectionRanges(range, root);
    if (!ranges.length) return hideToolbar();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return hideToolbar();
    currentSel = { ranges, rect, text: sel.toString().trim() };
    showToolbar(currentSel);
  };

  const onUp = debounce(() => { if (!toolbar?.matches(':hover')) capture(); }, 60);
  root.addEventListener('mouseup', onUp);
  root.addEventListener('keyup', e => { if (e.shiftKey || e.key.startsWith('Arrow')) onUp(); });
  document.addEventListener('mousedown', e => {
    if (toolbar?.contains(e.target)) return;         // 点工具条不算取消
    if (hoverCard?.contains(e.target)) return;
    hideToolbar();
  });
  document.addEventListener('scroll', () => { hideToolbar(); hideHover(); }, true);
  window.addEventListener('resize', () => { hideToolbar(); hideHover(); });
  root.addEventListener('mousemove', () => { if (!toolbar.hidden && !toolbar.matches(':hover')) return; });

  /* ---- 悬停气泡 ---- */
  let hoverToken = 0;
  const showHoverFor = sg => {
    if (!store.ui.showHoverCard) return;
    const token = ++hoverToken;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (token !== hoverToken) return;
      const html = hoverContent(sg);
      if (!html) return hideHover();
      hoverCard.innerHTML = html;
      hoverCard.hidden = false;
      const r = sg.getBoundingClientRect();
      const hc = hoverCard.getBoundingClientRect();
      let left = r.left + r.width / 2 - hc.width / 2;
      left = clamp(left, 10, window.innerWidth - hc.width - 10);
      let top = r.top - hc.height - 10;
      if (top < 10) top = Math.min(window.innerHeight - hc.height - 10, r.bottom + 10);
      hoverCard.style.left = `${left}px`;
      hoverCard.style.top = `${top}px`;
    }, 250);
  };
  hoverCard.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  hoverCard.addEventListener('mouseleave', hideHover);

  /** 供 reader 调用 */
  return {
    hideToolbar, hideHover, capture,
    hover: showHoverFor,
    isHoverTarget: n => hoverCard?.contains(n),
    current: () => currentSel,
  };
}

function hoverContent(sg) {
  const termId = sg.dataset.term;
  const annId = (sg.dataset.primary || '').split(' ')[0];
  const term = termId ? store.termById(termId) : null;
  const ann = annId ? store.state.anns.find(a => a.id === annId) : null;
  const parts = [];
  if (term) {
    parts.push(`<div class="hc-kind">术语 · ${esc(term.category || '未分类')}</div>`);
    parts.push(`<div class="hc-title">${esc(term.name)}</div>`);
    parts.push(`<div class="hc-body">${esc(term.definition || '（还没有定义，点击打开侧栏补充）')}</div>`);
    if (term.myNote) parts.push(`<div class="hc-body" style="margin-top:6px;color:var(--muted)">我的理解：${esc(term.myNote)}</div>`);
    const tags = (term.tags || []).map(t => `#${esc(t)}`).join(' ');
    parts.push(`<div class="hc-foot">${tags || '点击固定到侧栏'} <span style="margin-left:auto">${term.bookId ? '本书术语' : '全局术语'}</span></div>`);
  }
  if (ann && (ann.note || '').trim()) {
    if (!term) {
      parts.push(`<div class="hc-kind">批注 · ${esc(kindName(annKind(ann)))}</div>`);
      parts.push(`<div class="hc-title">${esc((ann.quote || '').slice(0, 40))}${(ann.quote || '').length > 40 ? '…' : ''}</div>`);
    } else parts.push('<div class="hc-kind" style="margin-top:8px">同时有一条批注</div>');
    parts.push(`<div class="hc-body">${esc(ann.note)}</div>`);
    parts.push(`<div class="hc-foot">点击在侧栏编辑</div>`);
  }
  return parts.join('');
}

export const kindName = k => ({ hl: '高亮', ul: '下划线', wavy: '波浪线', strike: '删除线', note: '批注' }[k] || '标记');

/* ---------------- 浮动工具条 ---------------- */
function showToolbar(sel) {
  if (!toolbar) return;
  const single = sel.ranges.length === 1;
  const shortEnough = sel.text.length <= 24;
  setChildren(toolbar,
    ...HL_COLORS.map(c => el('span', {
      class: `hl-swatch${c.key === store.ui.highlightColor ? ' active' : ''}`,
      title: `${c.name}高亮`, style: { background: c.key },
      dataset: { act: 'hl', color: c.key },
    })),
    el('div', { class: 'tb-sep' }),
    btn('ul', ICONS.check, '下划线', 'ul'),
    btn('wavy', ICONS.refresh, '波浪线', 'wavy'),
    btn('strike', ICONS.close, '删除线', 'strike'),
    el('div', { class: 'tb-sep' }),
    btn('note', ICONS.note, '写批注', 'note'),
    btn('term', ICONS.star, '设为术语', 'term', !(single && shortEnough)),
    el('div', { class: 'tb-sep' }),
    btn('copy', ICONS.copy, '复制', 'copy'),
    btn('collect', ICONS.jump, '存入笔记', 'collect'),
  );
  toolbar.hidden = false;
  const tw = toolbar.getBoundingClientRect();
  const r = sel.rect;
  let left = r.left + r.width / 2 - tw.width / 2;
  left = clamp(left, 10, Math.max(10, window.innerWidth - tw.width - 10));
  let top = r.top - tw.height - 10;
  if (top < 10) top = Math.min(window.innerHeight - tw.height - 10, r.bottom + 10);
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

function btn(act, icon, label, cls = '', disabled = false) {
  return el('button', {
    class: `st-btn ${cls}`, dataset: { act }, title: label, disabled,
  }, svg(icon), el('span', { text: label }));
}

/** 由 reader 调用，绑定工具条动作 */
export function bindToolbar({ root, onAction }) {
  const tb = $('#sel-toolbar');
  tb.addEventListener('mousedown', e => e.preventDefault()); // 保持选区
  tb.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const sel = currentSel;
    if (!sel) return;
    await onAction(act, sel, t.dataset.color);
    tb.hidden = true;
    window.getSelection()?.removeAllRanges();
  });
}

/** 用选区数据构造批注对象列表 */
export function buildAnnotations(sel, { kind, color, note = '', groupId = null }) {
  const gid = groupId || (sel.ranges.length > 1 ? uid('g') : null);
  const blocks = store.state.chapter?.blocks || [];
  return sel.ranges.map(r => {
    const text = lookupBlockText(r.blockId) || r.text;
    return {
      bookId: store.state.bookId,
      chapterId: store.state.chapter?.id,
      blockId: r.blockId,
      blockIndex: Math.max(0, blocks.findIndex(b => b.id === r.blockId)),
      kind, color, note, groupId: gid, tags: [],
      ...describeRange(text, r.start, r.end),
    };
  });
}

function lookupBlockText(blockId) {
  const b = store.state.chapter?.blocks?.find(x => x.id === blockId);
  return b?.x || '';
}
