/* 阅读视图：章节渲染、顶栏、进度、快捷键、原版页速览 */

import { $, el, svg, ICONS, esc, copyText, debounce, clamp, setChildren } from '../core/utils.js';
import * as db from '../core/db.js';
import store from '../core/store.js';
import { createBlockEl, paintBlock, repaintBlock, bindMarkEvents, flashAnnotation, flashTerm, annKind, fillImages } from './marks.js';
import { resolveAssetUrl, clearAssetCache } from '../core/assets.js';
import { initSelection, bindToolbar, buildAnnotations, collectSelectionRanges, kindName } from './selection.js';
import { toast, modal, openTermEditor, promptDialog } from '../ui/shell.js';

let selection = null;
let readerReady = false;
let lastScroll = 0;

export const sortAnns = list => [...list].sort(
  (a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0) || a.start - b.start || (a.createdAt || 0) - (b.createdAt || 0),
);

export function initReader() {
  const root = $('#reader-body');
  const scroll = $('#reader-scroll');

  selection = initSelection({ root, getChapter: () => store.state.chapter, onAfterCreate: () => {} });

  bindToolbar({
    root,
    onAction: async (act, sel, color) => handleToolbarAction(act, sel, color),
  });

  bindMarkEvents(root, {
    onClickMark: sg => {
      const termId = sg.dataset.term;
      const annId = (sg.dataset.primary || '').split(' ')[0];
      if (termId) store.openAside('term', { focusTermId: termId, focusAnnId: annId || null });
      else if (annId) store.openAside('ann', { focusAnnId: annId, focusTermId: null });
    },
    onHoverMark: sg => selection?.hover(sg),
    onLeaveMark: () => selection?.hideHover(),
  });

  // 点击正文插图 → 全屏放大查看
  root.addEventListener('click', e => {
    const img = e.target.closest?.('.block-image img');
    if (!img?.getAttribute('src')) return;
    const box = el('div', {
      class: 'img-zoom', title: '点击任意处关闭',
      on: { click: () => box.remove() },
    }, el('img', { src: img.src, alt: img.alt }));
    document.body.append(box);
  });

  scroll.addEventListener('scroll', debounce(() => {
    const max = scroll.scrollHeight - scroll.clientHeight;
    const ratio = max > 0 ? scroll.scrollTop / max : 0;
    $('#reader-progress').firstElementChild.style.width = `${clamp(ratio * 100, 0, 100)}%`;
    if (ratio > .985 && ratio > lastScroll) {
      const btn = $('#reader-body .next-chapter');
      btn?.classList.add('ready');
    }
    lastScroll = ratio;
  }, 80));

  store.bus.on('chapter', () => renderChapter());
  store.bus.on('book', () => renderTopbar());
  store.bus.on('route', ({ route }) => { if (route === 'reader') { renderTopbar(); renderChapter(); } });
  store.bus.on('anns', (ev = {}) => {
    const { added, updated, removed } = ev || {};
    if (added || removed) return repaintAll();
    if (updated) repaintBlockById(updated.blockId);
  });
  store.bus.on('terms', () => repaintAll());
  store.bus.on('ui', patch => {
    if ('autoTermHighlight' in patch || 'minTermLen' in patch || 'fontSize' in patch || 'lineHeight' in patch || 'measure' in patch || 'fontFamily' in patch) {
      repaintAll();
    }
  });
  store.bus.on('bookmarks', () => renderTopbar());

  readerReady = true;
  setInterval(() => {
    if (document.visibilityState === 'visible' && store.state.route === 'reader') store.tickReading(5);
  }, 5000);
}

/* ---------------- 顶栏 ---------------- */
export function renderTopbar() {
  const left = $('#topbar-left'), right = $('#topbar-right');
  if (store.state.route !== 'reader' || !store.state.book) { setChildren(left); setChildren(right); return; }
  const book = store.state.book;
  const ch = store.state.chapter;

  const chapterSelect = el('select', {
    class: 'select', style: { width: 'auto', maxWidth: '280px' },
    on: { change: e => store.loadChapter(Number(e.target.value)) },
  }, ...store.state.chapters.map((c, i) => el('option', {
    value: i, selected: i === store.state.chapterIndex, text: `${i + 1}. ${c.title}`.slice(0, 46),
  })));

  setChildren(left,
    el('div', { class: 'grow', style: { minWidth: '0' } },
      el('div', { class: 'tb-title', text: book.title }),
      el('div', { class: 'tb-sub', text: `${book.author || book.format} · 第 ${store.state.chapterIndex + 1}/${store.state.chapters.length} 章` }),
    ),
    chapterSelect,
  );

  setChildren(right,
    el('button', { class: 'btn icon ghost', title: '上一章 (K)', on: { click: () => goChapter(-1) } },
      svg('M15 5l-7 7 7 7')),
    el('button', { class: 'btn icon ghost', title: '下一章 (J)', on: { click: () => goChapter(1) } },
      svg('M9 5l7 7-7 7')),
    el('button', { class: 'btn icon ghost', title: '缩小字号', on: { click: () => store.setUi({ fontSize: clamp(store.ui.fontSize - 1, 13, 30) }) } },
      el('span', { text: 'A－', style: { fontSize: '11px' } })),
    el('button', { class: 'btn icon ghost', title: '放大字号', on: { click: () => store.setUi({ fontSize: clamp(store.ui.fontSize + 1, 13, 30) }) } },
      el('span', { text: 'A＋', style: { fontSize: '13px' } })),
    book.format === 'PDF' && el('button', { class: 'btn sm', title: '查看原版页面排版', on: { click: () => openOriginalPage(nearestPage()) } }, svg(ICONS.doc), '原版页'),
    el('button', { class: 'btn sm', title: '在此处加书签 (B)', on: { click: () => addBookmarkHere() } }, svg(ICONS.star), `书签 ${store.state.bookmarks.length}`),
    el('button', { class: 'btn icon ghost', title: '批注面板', on: { click: () => store.setAside({ asideOpen: !store.state.asideOpen }) } },
      svg('M4 5h16v14H4zM15 5v14')),
  );
}

function goChapter(d) { store.saveBookProgress().then(() => store.nextChapter(d)); }

function nearestPage() {
  const nodes = Array.from($('#reader-body').querySelectorAll('.blk.page, [data-page]'));
  const top = $('#reader-scroll').getBoundingClientRect().top + 40;
  let page = 1;
  for (const n of nodes) { if (n.getBoundingClientRect().top <= top) page = Number(n.dataset.page || 1); else break; }
  return page;
}

/* ---------------- 章节渲染 ---------------- */
export function renderChapter() {
  const body = $('#reader-body');
  const ch = store.state.chapter;
  const book = store.state.book;
  if (!ch || !book) { body.replaceChildren(); return; }
  const terms = store.termsFor(store.state.bookId);
  const annsByBlock = new Map();
  for (const a of store.annsForChapter(ch.id)) {
    if (!annsByBlock.has(a.blockId)) annsByBlock.set(a.blockId, []);
    annsByBlock.get(a.blockId).push(a);
  }
  body.classList.toggle('sans', store.ui.fontFamily === 'sans');

  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'chapter-head' },
    el('div', { class: 'kicker', text: `${book.title} · 第 ${store.state.chapterIndex + 1} 章` }),
    el('h1', { text: ch.title || '未命名章节' }),
  ));

  if (book.meta?.scanned && store.state.chapterIndex === 0) {
    frag.append(el('div', {
      class: 'card', style: { borderColor: 'var(--warn)', background: 'color-mix(in srgb,var(--warn) 10%,transparent)' },
    }, el('div', { class: 'small', text: '⚠ 这份 PDF 似乎没有文字层（可能是扫描件），正文无法提取。可以用顶栏的「原版页」按原始排版阅读，批注会按页归档。' })));
  }

  for (const b of ch.blocks) {
    const node = createBlockEl(b);
    paintBlock(node, b, annsByBlock.get(b.id) || [], terms, store.ui);
    frag.append(node);
  }

  const nextIdx = store.state.chapterIndex + 1;
  if (nextIdx < store.state.chapters.length) {
    frag.append(el('div', { class: 'next-chapter', style: { marginTop: '40px', textAlign: 'center' } },
      el('button', { class: 'btn primary', on: { click: () => goChapter(1) } },
        `读完本章，进入《${store.state.chapters[nextIdx].title.slice(0, 24)}》 →`),
    ));
  } else {
    frag.append(el('div', { class: 'empty', style: { marginTop: '40px' } },
      el('div', { class: 'big', text: '完' }),
      el('div', { text: '本书已读到最后。去笔记工作台整理一下收获吧。' }),
      el('div', { style: { marginTop: '12px' } },
        el('button', { class: 'btn primary', on: { click: () => store.go('notes') } }, '打开笔记工作台')),
    ));
  }

  body.replaceChildren(frag);
  // 图片块：正文先渲染出来，图片地址随后异步补上（本地对象地址）
  fillImages(body, store.state.bookId, resolveAssetUrl).catch(() => {});
  $('#reader-scroll').scrollTop = 0;
  $('#reader-progress').firstElementChild.style.width = `${(store.state.chapterIndex / Math.max(1, store.state.chapters.length)) * 100}%`;
  renderTopbar();
}

function repaintAll() {
  if (store.state.route !== 'reader') return;
  const body = $('#reader-body');
  const ch = store.state.chapter;
  if (!ch || !body.querySelector('.blk')) return;
  const terms = store.termsFor(store.state.bookId);
  const annsByBlock = new Map();
  for (const a of store.annsForChapter(ch.id)) {
    if (!annsByBlock.has(a.blockId)) annsByBlock.set(a.blockId, []);
    annsByBlock.get(a.blockId).push(a);
  }
  for (const b of ch.blocks) {
    const node = body.querySelector(`[data-block-id="${CSS.escape(b.id)}"]`);
    if (!node) continue;
    repaintBlock(node, b, annsByBlock.get(b.id) || [], terms, store.ui);
  }
}

function repaintBlockById(blockId) {
  const ch = store.state.chapter;
  if (!ch || store.state.route !== 'reader') return;
  const b = ch.blocks.find(x => x.id === blockId);
  const node = $('#reader-body').querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
  if (!b || !node) return;
  repaintBlock(node, b, store.annsForBlock(blockId), store.termsFor(store.state.bookId), store.ui);
}

/* ---------------- 工具条动作 ---------------- */
async function handleToolbarAction(act, sel, color) {
  const selText = sel.text;
  switch (act) {
    case 'hl': {
      await store.setUi({ highlightColor: color });
      const rows = await store.addAnnotations(buildAnnotations(sel, { kind: 'hl', color }));
      toast(`已高亮 ${rows.length} 处`, 'ok');
      break;
    }
    case 'ul': case 'wavy': case 'strike': {
      const kind = act;
      const map = { ul: store.ui.highlightColor, wavy: 'var(--accent-2)', strike: 'var(--muted)' };
      await store.addAnnotations(buildAnnotations(sel, { kind, color: map[kind] }));
      toast(`已添加${kindName(kind)}`, 'ok');
      break;
    }
    case 'note': {
      const rows = await store.addAnnotations(buildAnnotations(sel, { kind: 'note', color: store.ui.highlightColor }));
      store.openAside('ann', { focusAnnId: rows[0].id, focusTermId: null });
      setTimeout(() => $('#aside')?.querySelector(`[data-ann-id="${rows[0].id}"] .card-body`)?.focus(), 120);
      break;
    }
    case 'term': {
      const name = selText.slice(0, 40);
      await store.addAnnotations(buildAnnotations(sel, { kind: 'hl', color: 'var(--accent-2)' }));
      const term = await openTermEditor({ name, bookId: store.state.bookId, isNew: true });
      if (term) toast(`术语「${term.name}」已建立，全书自动高亮`, 'ok');
      repaintAll();
      break;
    }
    case 'copy': {
      const quote = sel.ranges.map((r, i) => (i ? '' : '') + r.text).join('\n');
      await copyText(`${quote}\n—— 《${store.state.book.title}》· ${store.state.chapter.title}`);
      toast('已复制引文与出处', 'ok');
      break;
    }
    case 'ask': {
      // 走事件总线交给 ui/ai.js 处理：避免 reader ←→ ui/ai 互相 import 成环。
      // 只把内容填进输入框，不自动发送——发送必须由用户按下去。
      const first = sel.ranges[0];
      store.bus.emit('aiAsk', {
        selection: { blockId: first.blockId, quote: first.text },
        question: '这段是什么意思？',
      });
      break;
    }
    case 'collect': {
      const rows = await store.addAnnotations(buildAnnotations(sel, { kind: 'hl', color: store.ui.highlightColor }));
      await store.collectAnnotations(rows.map(r => r.id));
      toast('已存入笔记工作台（收集箱）', 'ok');
      break;
    }
  }
}

/* ---------------- 书签与跳转 ---------------- */
export async function addBookmarkHere() {
  const label = await promptDialog({ title: '添加书签', label: '书签名称', value: store.state.chapter?.title || '' });
  if (label === null) return;
  await store.addBookmark({
    chapterId: store.state.chapter?.id,
    blockId: topBlockId(),
    label: label || store.state.chapter?.title,
    ratio: 0,
  });
  toast('已添加书签', 'ok');
}

function topBlockId() {
  const scroll = $('#reader-scroll');
  const top = scroll.getBoundingClientRect().top + 60;
  const blocks = Array.from($('#reader-body').querySelectorAll('.blk'));
  for (const b of blocks) if (b.getBoundingClientRect().bottom > top) return b.dataset.blockId;
  return blocks[0]?.dataset.blockId || null;
}

export async function jumpTo({ chapterId, blockId }) {
  if (!chapterId) return;
  const idx = store.state.chapters.findIndex(c => c.id === chapterId);
  if (idx < 0) return;
  store.go('reader');
  if (idx !== store.state.chapterIndex) await store.loadChapter(idx);
  setTimeout(() => {
    const node = blockId ? $('#reader-body').querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) : null;
    const target = node || $('#reader-body');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node?.classList.add('flash');
    setTimeout(() => node?.classList.remove('flash'), 1200);
  }, 90);
}

/* ---------------- 定位批注 / 术语 ---------------- */
export function locateAnnotation(ann) {
  if (ann.chapterId !== store.state.chapter?.id) {
    const idx = store.state.chapters.findIndex(c => c.id === ann.chapterId);
    if (idx >= 0) store.loadChapter(idx).then(() => setTimeout(() => flashAnnotation($('#reader-body'), ann), 120));
  } else flashAnnotation($('#reader-body'), ann);
}

export function locateTerm(termId) {
  const ok = flashTerm($('#reader-body'), termId);
  if (!ok) toast('当前章节没有出现该术语，可在「术语」标签页查看全部出处', 'err');
  return ok;
}

/* ---------------- 原版 PDF 页面 ---------------- */
export async function openOriginalPage(pageNo) {
  const bookId = store.state.bookId;
  const rec = await db.get('files', bookId);
  if (!rec?.blob) return toast('原文件未留档，无法渲染原版页面', 'err');
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
  const data = await rec.blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const n = clamp(pageNo || 1, 1, doc.numPages);
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = el('canvas', { width: viewport.width, height: viewport.height });
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const pageAnns = store.state.anns.filter(a => a.page === n || blockOnPage(a.blockId) === n);
  const host = el('div', { class: 'pdf-split' },
    el('div', { class: 'pdf-canvas-wrap' }, canvas),
    el('div', {},
      el('div', { class: 'panel-title' }, el('span', { text: `第 ${n} 页批注` }), el('span', { class: 'line' }), el('span', { class: 'count', text: String(pageAnns.length) })),
      ...(pageAnns.length ? pageAnns.map(a => el('div', { class: 'card' },
        el('div', { class: 'card-top' }, el('span', { class: 'dot', style: { background: a.color || '#ffdf7e' } }), el('span', { class: 'kind', text: kindName(annKind(a)) })),
        el('div', { class: 'card-quote', text: a.quote || '' }),
        a.note ? el('div', { class: 'card-body', text: a.note }) : null,
      )) : el('div', { class: 'muted small', text: '这一页还没有批注。' })),
    ),
  );
  modal({
    title: `${store.state.book.title} · 原版第 ${n} 页`,
    body: host,
    actions: [
      { text: '上一页', onClick: (close) => { close(); openOriginalPage(n - 1); } },
      { text: '下一页', onClick: (close) => { close(); openOriginalPage(n + 1); } },
      { text: '关闭', primary: true, onClick: (close) => close() },
    ],
  });
}

function blockOnPage(blockId) {
  const ch = store.state.chapter;
  if (!ch) return null;
  const i = ch.blocks.findIndex(b => b.id === blockId);
  if (i < 0) return null;
  for (let k = i; k >= 0; k--) if (ch.blocks[k].t === 'page') return ch.blocks[k].n;
  return null;
}

/* ---------------- 快捷键 ---------------- */
export function bindReaderKeys() {
  window.addEventListener('keydown', async e => {
    if (store.state.route !== 'reader') return;
    if (e.target.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && $('#reader-body').contains(sel.anchorNode);
    const ranges = hasSel ? collectSelectionRanges(sel.getRangeAt(0), $('#reader-body')) : [];
    const rect = hasSel ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const fakeSel = hasSel && ranges.length ? { ranges, rect, text: sel.toString().trim() } : null;
    switch (e.key.toLowerCase()) {
      case 'h': if (fakeSel) { e.preventDefault(); await handleToolbarAction('hl', fakeSel, store.ui.highlightColor); } break;
      case 'u': if (fakeSel) { e.preventDefault(); await handleToolbarAction('ul', fakeSel, store.ui.highlightColor); } break;
      case 'n': if (fakeSel) { e.preventDefault(); await handleToolbarAction('note', fakeSel, store.ui.highlightColor); } break;
      case 't': if (fakeSel) { e.preventDefault(); await handleToolbarAction('term', fakeSel, store.ui.highlightColor); } break;
      case 'b': e.preventDefault(); await addBookmarkHere(); break;
      case 'j': e.preventDefault(); goChapter(1); break;
      case 'k': e.preventDefault(); goChapter(-1); break;
      default: break;
    }
  });
}
