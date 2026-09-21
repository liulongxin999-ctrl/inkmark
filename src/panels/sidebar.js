/* 右侧批注面板：批注 / 术语 / 大纲 / 统计 */

import { $, el, svg, ICONS, HL_COLORS, debounce, relTime, setChildren } from '../core/utils.js';
import store from '../core/store.js';
import { annKind } from '../reader/marks.js';
import { locateAnnotation, locateTerm, jumpTo, addBookmarkHere, openOriginalPage, sortAnns } from '../reader/reader.js';
import { openTermEditor, toast, confirmDialog } from '../ui/shell.js';
import { renderAi } from '../ui/ai.js';

const KIND_LABEL = { hl: '高亮', ul: '下划线', wavy: '波浪线', strike: '删除线', note: '批注' };
let scope = 'chapter';   // chapter | book
let termQuery = '';

export function initSidebar() {
  store.bus.on('aside', () => renderAside());
  // 下面这些事件都可能在「用户正在写批注」的时候触发：
  // 防抖实时保存（anns）、阅读进度落盘（book）、换章（chapter）……
  // 直接整块重绘会把正在输入的那个编辑框换成新节点，光标当场丢失。
  store.bus.on('anns', () => { if (store.state.asideOpen && store.state.asideTab === 'ann') renderAsideLater(); });
  store.bus.on('terms', () => { if (store.state.asideOpen && store.state.asideTab === 'term') renderAsideLater(); });
  store.bus.on('bookmarks', () => { if (store.state.asideOpen && store.state.asideTab === 'outline') renderAsideLater(); });
  store.bus.on('chapter', () => { if (store.state.asideOpen) renderAsideLater(); });
  store.bus.on('book', () => renderAsideLater());
  store.bus.on('chats', () => { if (store.state.asideOpen && store.state.asideTab === 'ai') renderAsideLater(); });
  store.bus.on('aiStatus', () => { if (store.state.asideOpen && store.state.asideTab === 'ai') renderAsideLater(); });
  store.bus.on('route', () => renderAside());
  // 用户离开输入框后，再把挂起的重绘补上
  document.addEventListener('focusout', () => {
    // focusout 阶段 activeElement 还没更新，放到下一轮事件循环里再判断
    setTimeout(() => {
      if (pendingAsideRender && !typingInAside()) { pendingAsideRender = false; renderAside(); }
    }, 0);
  });
  renderAside();
}

/* ---------------- 重绘与光标保护 ----------------
   侧栏是整块重绘的，而批注卡里的编辑框是 contenteditable。
   只要在用户打字期间重绘，输入框节点就会被换掉，光标和已选中的位置一起丢失
   （表现为"话还没打完，光标就跳出去了，得重新点回批注框"）。
   所以焦点还在侧栏编辑器里时，先把重绘挂起，等用户离开输入框再补上。 */
let pendingAsideRender = false;

function typingInAside() {
  const a = document.activeElement;
  if (!a || !$('#aside')?.contains(a)) return false;
  // 批注编辑器是 contenteditable；AI 面板的输入框是 textarea/input。
  // 两者都不能在打字期间被重绘，否则光标和未提交的内容一起丢。
  return !!(a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
}

function renderAsideLater() {
  if (typingInAside()) { pendingAsideRender = true; return; }
  pendingAsideRender = false;
  renderAside();
}

function renderAside() {
  const aside = $('#aside');
  const open = store.state.asideOpen && store.state.book && store.state.route === 'reader';
  document.getElementById('app').classList.toggle('aside-open', open);
  if (!open) return;
  pendingAsideRender = false;
  const tabs = [['ann', '批注'], ['term', '术语'], ['ai', 'AI'], ['outline', '大纲'], ['stat', '统计']];
  const body = el('div', { class: 'aside-body', id: 'aside-body' });
  setChildren(aside,
    el('div', { class: 'aside-head' },
      el('div', { class: 'aside-tabs' }, ...tabs.map(([id, name]) => el('button', {
        class: `aside-tab${store.state.asideTab === id ? ' active' : ''}`, text: name,
        on: { click: () => store.setAside({ asideTab: id }) },
      }))),
      el('button', { class: 'icon-btn', title: '收起面板', on: { click: () => store.setAside({ asideOpen: false }) } }, svg(ICONS.close)),
    ),
    body,
    el('div', { class: 'aside-foot small muted', text: hintFor(store.state.asideTab) }),
  );
  const render = { ann: renderAnnPanel, term: renderTermPanel, ai: renderAiPanel, outline: renderOutline, stat: renderStats }[store.state.asideTab];
  render?.(body);
  // 定位请求是一次性的：用完就清掉，
  // 否则以后每次重绘都会把焦点和滚动位置重新抢回这条卡片，用户点哪儿都会被拽回来。
  const wantAnn = store.state.focusAnnId;
  const wantTerm = store.state.focusTermId;
  store.state.focusAnnId = null;
  store.state.focusTermId = null;
  if (wantAnn && store.state.asideTab === 'ann') focusAnn(wantAnn);
  if (wantTerm && store.state.asideTab === 'term') focusTerm(wantTerm);
}

const hintFor = tab => ({
  ann: '正文里点选文字即可批注；点标记回到这里编辑，改动自动保存。',
  term: '术语会在全书自动高亮。悬停看释义，点击回到这里编辑。',
  ai: '每次提问只会发送选中的原文、所在段落和书名章节；批注与笔记永远不发。',
  outline: '目录与书签，点击直达。',
  stat: '阅读与批注的进度概览。',
}[tab] || '');

/** AI 标签页：直接交给 src/ui/ai.js 渲染 */
function renderAiPanel(host) { renderAi(host); }

/* ---------------- 批注面板 ---------------- */
function renderAnnPanel(host) {
  const list = scope === 'chapter' ? store.annsForChapter() : store.state.anns;
  const sorted = sortAnns(list);
  const withNote = sorted.filter(a => (a.note || '').trim()).length;

  setChildren(host,
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('div', { class: 'seg-group' },
        el('button', { class: scope === 'chapter' ? 'active' : '', text: '本章', on: { click: () => { scope = 'chapter'; renderAside(); } } }),
        el('button', { class: scope === 'book' ? 'active' : '', text: '全书', on: { click: () => { scope = 'book'; renderAside(); } } }),
      ),
      el('div', { class: 'spacer' }),
      el('span', { class: 'pill', text: `${sorted.length} 条 · ${withNote} 有笔记` }),
    ),
    sorted.length === 0
      ? el('div', { class: 'empty' },
        el('div', { class: 'big', text: '批' }),
        el('div', { text: scope === 'chapter' ? '本章还没有批注' : '这本书还没有批注' }),
        el('div', { class: 'small', style: { marginTop: '8px' }, text: '选中正文中的任意文字，工具条会浮出来。' }))
      : el('div', {}, ...sorted.map(a => annCard(a))),
  );
}

function annCard(a) {
  const chapter = store.state.chapters.find(c => c.id === a.chapterId);
  const t = store.termById(a.termId);
  const bodyEl = el('div', {
    class: 'card-body', contenteditable: 'true', 'data-ph': '写下你的想法…', dataset: { annBody: a.id },
  });
  bodyEl.textContent = a.note || '';
  const save = debounce(() => {
    const note = bodyEl.textContent.trim();
    if (note !== a.note) store.saveAnnotation({ id: a.id, note });
  }, 320);
  bodyEl.addEventListener('input', save);
  bodyEl.addEventListener('blur', () => save.flush());

  const card = el('div', { class: 'card', dataset: { annId: a.id } },
    el('div', { class: 'card-top' },
      el('span', { class: 'dot', style: { background: a.color || '#ffdf7e' } }),
      el('span', { class: 'kind', text: KIND_LABEL[annKind(a)] || '标记' }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      a.groupId ? el('span', { class: 'pill', text: '跨段' }) : null,
      el('span', { class: 'pill', text: relTime(a.createdAt) }),
    ),
    el('div', { class: 'card-quote', text: a.quote || '', title: '点击回到原文', on: { click: () => locateAnnotation(a) } }),
    bodyEl,
    el('div', { class: 'card-foot' },
      ...HL_COLORS.slice(0, 6).map(c => el('span', {
        class: 'hl-swatch', title: `改为${c.name}`, style: { background: c.key, width: '15px', height: '15px' },
        on: { click: () => store.saveAnnotation({ id: a.id, color: c.key, kind: 'hl' }) },
      })),
      el('span', { class: 'spacer' }),
      iconBtn(ICONS.jump, '回到原文', () => locateAnnotation(a)),
      iconBtn(ICONS.note, '存入笔记工作台', async () => {
        if ((bodyEl.textContent || '').trim() !== (a.note || '')) await store.saveAnnotation({ id: a.id, note: bodyEl.textContent.trim() });
        await store.collectAnnotations([a.id]);
        toast('已存入笔记工作台', 'ok');
      }),
      iconBtn(ICONS.trash, '删除批注', async () => {
        if (!await confirmDialog({ title: '删除批注', message: `删除这条标记？${a.groupId ? '（只删除这一段）' : ''}` })) return;
        store.removeAnnotation(a.id);
      }, 'danger'),
    ),
    scope === 'book' && chapter ? el('div', { class: 'small muted', style: { marginTop: '6px' }, text: `出自：${chapter.title}` }) : null,
  );
  return card;
}

const iconBtn = (icon, title, onClick, cls = '') =>
  el('button', { class: `icon-btn ${cls}`, title, on: { click: onClick } }, svg(icon));

function focusAnn(id) {
  setTimeout(() => {
    const card = $(`#aside [data-ann-id="${CSS.escape(id)}"]`);
    if (!card) return;
    $('#aside-body').querySelectorAll('.card.active').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('.card-body')?.focus();
  }, 90);
}

/* ---------------- 术语面板 ---------------- */
function renderTermPanel(host) {
  const all = store.termsFor(store.state.bookId);
  const q = termQuery.trim().toLowerCase();
  const list = q ? all.filter(t => `${t.name} ${t.aliases?.join(' ')} ${t.definition} ${t.category} ${t.tags?.join(' ')}`.toLowerCase().includes(q)) : all;
  const bookTerms = list.filter(t => t.bookId);
  const globalTerms = list.filter(t => !t.bookId);

  const search = el('input', {
    class: 'input', placeholder: '搜索术语…', value: termQuery,
    on: { input: debounce(e => { termQuery = e.target.value; renderAside(); const s = $('#aside .term-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 200) },
  });
  search.classList.add('term-search');

  setChildren(host,
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('div', { class: 'grow' }, search),
      el('button', { class: 'btn primary sm', on: { click: () => createTerm() } }, svg(ICONS.plus), '新建'),
    ),
    el('div', { class: 'panel-title' }, el('span', { text: '本书术语' }), el('span', { class: 'line' }), el('span', { class: 'count', text: String(bookTerms.length) })),
    ...(bookTerms.length ? bookTerms.map(termCard) : [el('div', { class: 'muted small', style: { padding: '6px 2px 12px' }, text: '还没有本书术语。选中一个专业名词 → 「设为术语」。' })]),
    el('div', { class: 'panel-title', style: { marginTop: '14px' } }, el('span', { text: '全局术语' }), el('span', { class: 'line' }), el('span', { class: 'count', text: String(globalTerms.length) })),
    ...(globalTerms.length ? globalTerms.map(termCard) : [el('div', { class: 'muted small', style: { padding: '6px 2px' }, text: '全局术语在所有书籍中都会高亮。' })]),
  );
}

function termCard(t) {
  const occ = countOccurrences(t);
  return el('div', {
    class: `term-card${store.state.focusTermId === t.id ? ' active' : ''}`,
    style: { '--tc': t.color || 'var(--accent-2)' },
    dataset: { termId: t.id },
    on: { click: e => { if (e.target.closest('.icon-btn')) return; locateTerm(t.id); } },
  },
    el('div', { class: 'term-name' },
      el('span', { class: 'text', text: t.name }),
      t.aliases?.length ? el('span', { class: 'pill', text: `别名 ${t.aliases.length}` }) : null,
      el('span', { class: 'spacer', style: { flex: '1' } }),
      t.bookId ? null : el('span', { class: 'pill', text: '全局' }),
    ),
    el('div', { class: 'term-def', text: t.definition || '（还没有定义，点击编辑）' }),
    el('div', { class: 'term-meta' },
      t.category ? el('span', { text: t.category }) : null,
      el('span', { text: `${occ} 次出现` }),
      (t.tags || []).length ? el('span', { text: (t.tags || []).map(x => `#${x}`).join(' ') }) : null,
      el('span', { style: { flex: '1' } }),
      iconBtn(ICONS.edit, '编辑术语', async () => { await editTerm(t); }),
      iconBtn(ICONS.trash, '删除术语', async () => {
        if (await confirmDialog({ title: '删除术语', message: `删除「${t.name}」？正文中的高亮会一并消失，已写好的定义无法恢复。` })) store.removeTerm(t.id);
      }, 'danger'),
    ),
  );
}

function countOccurrences(t) {
  const ch = store.state.chapter;
  if (!ch) return 0;
  const names = [t.name, ...(t.aliases || [])].filter(Boolean);
  let n = 0;
  for (const b of ch.blocks) for (const name of names) {
    let i = -1;
    while ((i = b.x.indexOf(name, i + 1)) >= 0) n++;
  }
  return n;
}

async function editTerm(t) { await openTermEditor(t); }

async function createTerm() {
  const sel = window.getSelection()?.toString().trim() || '';
  const t = await openTermEditor({ name: sel.slice(0, 40), bookId: store.state.bookId, isNew: true });
  if (t) {
    store.state.focusTermId = t.id;
    store.setAside({ asideTab: 'term' });
    toast(`已建立术语「${t.name}」`, 'ok');
  }
}

function focusTerm(id) {
  setTimeout(() => {
    const card = $(`#aside [data-term-id="${CSS.escape(id)}"]`);
    if (!card) return;
    $('#aside-body').querySelectorAll('.term-card.active').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (store.state.asideTab === 'term') locateTerm(id);
  }, 110);
}

/* ---------------- 大纲 ---------------- */
function renderOutline(host) {
  const bms = store.state.bookmarks;
  setChildren(host,
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('span', { class: 'pill', text: `${store.state.chapters.length} 章` }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm', on: { click: () => addBookmarkHere() } }, svg(ICONS.star), '加书签'),
    ),
    ...(bms.length ? [
      el('div', { class: 'panel-title' }, el('span', { text: '书签' }), el('span', { class: 'line' }), el('span', { class: 'count', text: String(bms.length) })),
      ...bms.map(b => el('div', { class: 'outline-item', on: { click: () => jumpTo({ chapterId: b.chapterId, blockId: b.blockId }) } },
        svg(ICONS.star, { cls: 'bm-ico' }),
        el('span', { class: 't', text: b.label || '书签' }),
        iconBtn(ICONS.trash, '删除书签', e => { store.removeBookmark(b.id); }, 'danger'))),
    ] : []),
    el('div', { class: 'panel-title' }, el('span', { text: '目录' }), el('span', { class: 'line' })),
    ...store.state.chapters.map((c, i) => el('div', {
      class: `outline-item lv${c.level || 1}${i === store.state.chapterIndex ? ' active' : ''}`,
      on: { click: () => store.loadChapter(i) },
    },
      el('span', { class: 'n', text: String(i + 1).padStart(2, '0') }),
      el('span', { class: 't', text: c.title }),
      el('span', { class: 'n', text: `${Math.round((c.charCount || 0) / 1000)}k` }),
    )),
  );
}

/* ---------------- 统计 ---------------- */
function renderStats(host) {
  const book = store.state.book;
  const anns = store.state.anns;
  const chapterAnns = store.annsForChapter();
  const kinds = {};
  for (const a of anns) kinds[annKind(a)] = (kinds[annKind(a)] || 0) + 1;
  const days = Object.keys(store.state.stats).sort().slice(-28);
  const max = Math.max(1, ...days.map(d => store.state.stats[d].sec || 0));
  const tags = {};
  for (const a of anns) for (const t of a.tags || []) tags[t] = (tags[t] || 0) + 1;
  const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const totalSec = Object.values(store.state.stats).reduce((n, s) => n + (s.sec || 0), 0);
  const goal = (store.ui.dailyGoalMin || 45) * 60;
  const todaySec = store.state.stats[new Date().toISOString().slice(0, 10)]?.sec || 0;

  setChildren(host,
    el('div', { class: 'stat-grid' },
      stat(book.annCount || anns.length, '全书批注'),
      stat(chapterAnns.length, '本章批注'),
      stat(store.termsFor(store.state.bookId).length, '可用术语'),
      stat(`${Math.round((book.progress || 0) * 100)}%`, '阅读进度'),
    ),
    el('div', { class: 'panel-title', style: { marginTop: '16px' } }, el('span', { text: '标记构成' }), el('span', { class: 'line' })),
    el('div', { class: 'row wrap' }, ...Object.entries(kinds).map(([k, v]) => el('span', { class: 'chip', text: `${KIND_LABEL[k]} ${v}` }))),
    el('div', { class: 'panel-title', style: { marginTop: '16px' } }, el('span', { text: '近 28 天阅读' }), el('span', { class: 'line' })),
    el('div', { class: 'heat' }, ...days.map(d => el('i', {
      title: `${d}：${Math.round((store.state.stats[d].sec || 0) / 60)} 分钟`,
      style: { background: `color-mix(in srgb,var(--accent) ${Math.round(((store.state.stats[d].sec || 0) / max) * 100)}%,var(--surface-3))` },
    }))),
    el('div', { class: 'small muted', style: { marginTop: '8px' }, text: `今日 ${Math.round(todaySec / 60)} 分钟 / 目标 ${store.ui.dailyGoalMin} 分钟 · 累计 ${Math.round(totalSec / 60)} 分钟` }),
    el('div', { style: { height: '6px', borderRadius: '6px', background: 'var(--surface-3)', marginTop: '6px', overflow: 'hidden' } },
      el('div', { style: { height: '100%', width: `${Math.min(100, (todaySec / goal) * 100)}%`, background: 'var(--accent)' } })),
    topTags.length ? el('div', { class: 'panel-title', style: { marginTop: '16px' } }, el('span', { text: '热门标签' }), el('span', { class: 'line' })) : null,
    topTags.length ? el('div', { class: 'row wrap' }, ...topTags.map(([t, n]) => el('span', { class: 'chip', text: `#${t} ${n}` }))) : null,
  );
}

const stat = (v, l) => el('div', { class: 'stat' }, el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l }));
