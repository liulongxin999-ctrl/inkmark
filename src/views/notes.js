/* 笔记工作台：看板 / 列表 / 标签 / 双链 / 编辑器 */

import { $, el, svg, ICONS, esc, debounce, relTime, isDue, setChildren } from '../core/utils.js';
import store from '../core/store.js';
import { modal, openTermEditor, statusName, exportMarkdown, toast, confirmDialog } from '../ui/shell.js';
import { jumpTo } from '../reader/reader.js';

const COLUMNS = [
  { id: 'inbox', name: '收集箱', hint: '刚收进来，还没消化' },
  { id: 'working', name: '整理中', hint: '正在理解、补充' },
  { id: 'learned', name: '已掌握', hint: '能复述出来了' },
  { id: 'archive', name: '归档', hint: '暂时不再看' },
];

let view = 'board';
let query = '';
let tagFilter = null;
let bookFilter = null;

export function initNotes() {
  store.bus.on('notes', () => { if (store.state.route === 'notes') renderNotes(); });
  store.bus.on('route', ({ route }) => { if (route === 'notes') renderNotes(); });
  store.bus.on('openNote', id => { const n = store.state.notes.find(x => x.id === id); if (n) openNoteEditor(n); });
}

export function renderNotes() {
  const host = $('#view-notes');
  const all = store.state.notes;
  const tags = collectTags(all);
  const filtered = all.filter(n => {
    if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
    if (bookFilter && n.bookId !== bookFilter) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return `${n.title} ${n.body} ${n.quote || ''} ${n.bookTitle || ''} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q);
  });
  const searchInput = el('input', {
    class: 'input', placeholder: '搜索笔记内容、引文、书名…', value: query, style: { maxWidth: '300px' },
    on: { input: debounce(e => { query = e.target.value; renderNotes(); const s = $('#view-notes .notes-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 220) },
  });
  searchInput.classList.add('notes-search');

  setChildren(host, el('div', { class: 'page-scroll' },
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { text: '笔记工作台' }),
        el('p', { text: `${all.length} 张卡片 · ${all.filter(n => isDue(n.review)).length} 张待复习 · ${tags.length} 个标签` }),
      ),
      el('div', { class: 'spacer', style: { flex: '1' } }),
      el('button', { class: 'btn primary', on: { click: () => newNote() } }, svg(ICONS.plus), '新建笔记'),
    ),
    el('div', { class: 'toolbar' },
      searchInput,
      el('div', { class: 'seg-group' },
        el('button', { class: view === 'board' ? 'active' : '', text: '看板', on: { click: () => { view = 'board'; renderNotes(); } } }),
        el('button', { class: view === 'list' ? 'active' : '', text: '列表', on: { click: () => { view = 'list'; renderNotes(); } } }),
      ),
      store.state.books.length ? el('select', {
        class: 'select', style: { width: 'auto' },
        on: { change: e => { bookFilter = e.target.value || null; renderNotes(); } },
      }, el('option', { value: '', text: '全部书籍' }),
        ...store.state.books.map(b => el('option', { value: b.id, selected: bookFilter === b.id, text: b.title }))) : null,
      el('div', { class: 'spacer', style: { flex: '1' } }),
      el('button', { class: 'btn', on: { click: () => exportMarkdown() } }, svg(ICONS.doc), '导出 Markdown'),
    ),
    tags.length ? el('div', { class: 'row wrap', style: { marginBottom: '14px' } },
      el('span', { class: `chip clickable${!tagFilter ? ' active' : ''}`, text: '全部标签', on: { click: () => { tagFilter = null; renderNotes(); } } }),
      ...tags.slice(0, 24).map(([t, n]) => el('span', {
        class: `chip clickable${tagFilter === t ? ' active' : ''}`,
        on: { click: () => { tagFilter = tagFilter === t ? null : t; renderNotes(); } },
      }, `#${t}`, el('span', { class: 'muted', text: String(n) }))),
    ) : null,
    filtered.length === 0
      ? el('div', { class: 'empty' },
        el('div', { class: 'big', text: '記' }),
        el('div', { text: all.length ? '没有符合条件的笔记' : '还没有笔记' }),
        el('div', { class: 'small', style: { marginTop: '8px' }, text: '阅读时选中文字 → 「存入笔记」，或直接新建一张卡片。' }),
        el('div', { style: { marginTop: '14px' } },
          el('button', { class: 'btn primary', on: { click: () => newNote() } }, '新建一张空笔记')))
      : (view === 'board' ? boardView(filtered) : listView(filtered)),
  ));
}

/* ---------------- 看板 ---------------- */
function boardView(notes) {
  return el('div', { class: 'board' }, ...COLUMNS.map(col => {
    const items = notes.filter(n => (n.status || 'inbox') === col.id);
    const body = el('div', { class: 'board-col-body' });
    const column = el('div', {
      class: 'board-col', dataset: { col: col.id },
      on: {
        dragover: e => { e.preventDefault(); column.classList.add('over'); },
        dragleave: () => column.classList.remove('over'),
        drop: async e => {
          e.preventDefault(); column.classList.remove('over');
          const id = e.dataTransfer.getData('text/plain');
          if (id) await store.saveNote({ id, status: col.id });
        },
      },
    },
      el('div', { class: 'board-col-head' },
        el('span', { text: col.name }),
        el('span', { class: 'n', text: String(items.length) }),
        el('span', { class: 'spacer', style: { flex: '1' } }),
        el('span', { class: 'hint', title: col.hint, text: col.hint }),
      ),
      body,
    );
    if (!items.length) body.append(el('div', { class: 'small muted center', style: { padding: '18px 6px' }, text: '拖卡片到这里' }));
    for (const n of items) body.append(noteCard(n));
    return column;
  }));
}

function noteCard(n) {
  const card = el('div', {
    class: 'note-card', draggable: 'true', dataset: { noteId: n.id },
    on: {
      dragstart: e => { e.dataTransfer.setData('text/plain', n.id); card.classList.add('dragging'); },
      dragend: () => card.classList.remove('dragging'),
      dblclick: () => openNoteEditor(n),
    },
  },
    el('div', { class: 'nc-head' },
      el('span', {
        class: `pill${n.kind === 'quote' ? '' : ' ok'}`,
        text: n.kind === 'quote' ? '引文' : n.kind === 'term' ? '术语' : n.kind === 'ai' ? 'AI 问答' : '笔记',
      }),
      el('span', { class: 'nc-title', text: n.title || n.quote?.slice(0, 20) || '(无标题)' }),
      isDue(n.review) && n.review?.reps ? el('span', { class: 'pill warn', text: '待复习' }) : null,
    ),
    (n.kind === 'quote' || n.kind === 'ai') && n.quote ? el('div', { class: 'nc-body', style: { fontFamily: 'var(--serif)', borderLeft: '2px solid var(--line-2)', paddingLeft: '8px', marginBottom: '6px' }, text: n.quote }) : null,
    n.body ? el('div', { class: 'nc-body', html: renderMarkdown(n.body) }) : null,
    el('div', { class: 'nc-foot' },
      ...(n.tags || []).slice(0, 3).map(t => el('span', { class: 'chip', text: `#${t}` })),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      n.bookId ? el('span', { class: 'src', title: '回到原文', text: `《${n.bookTitle || '未知'}》↗`, on: { click: () => jumpToBook(n) } }) : null,
      el('button', { class: 'icon-btn', title: '编辑', on: { click: () => openNoteEditor(n) } }, svg(ICONS.edit)),
      el('button', {
        class: 'icon-btn danger', title: '删除', on: {
          click: async () => { if (await confirmDialog({ title: '删除笔记', message: '删除这张卡片？' })) store.removeNote(n.id); },
        },
      }, svg(ICONS.trash)),
    ),
  );
  return card;
}

/* ---------------- 列表 ---------------- */
function listView(notes) {
  return el('div', { style: { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', overflow: 'hidden' } },
    el('table', { class: 'list-table' },
      el('thead', {}, el('tr', {},
        el('th', { text: '标题' }), el('th', { text: '内容' }), el('th', { text: '来源' }),
        el('th', { text: '标签' }), el('th', { text: '状态' }), el('th', { text: '更新' }), el('th', { text: '' }))),
      el('tbody', {}, ...notes.map(n => el('tr', { on: { dblclick: () => openNoteEditor(n) } },
        el('td', {}, el('b', { text: n.title || '(无标题)' })),
        el('td', { class: 'c-body' }, el('div', { html: renderMarkdown((n.body || n.quote || '').slice(0, 160)) })),
        el('td', {}, n.bookId ? el('span', { class: 'src', text: n.bookTitle || '—', on: { click: () => jumpToBook(n) } }) : el('span', { class: 'muted', text: '独立' })),
        el('td', {}, (n.tags || []).map(t => el('span', { class: 'chip', text: `#${t}` }))),
        el('td', {}, el('span', { class: 'pill', text: statusName(n.status) })),
        el('td', { class: 'small muted', text: relTime(n.updatedAt || n.createdAt) }),
        el('td', {},
          el('button', { class: 'icon-btn', title: '编辑', on: { click: () => openNoteEditor(n) } }, svg(ICONS.edit)),
          el('button', { class: 'icon-btn danger', title: '删除', on: { click: async () => { if (await confirmDialog({ title: '删除笔记', message: '删除这张卡片？' })) store.removeNote(n.id); } } }, svg(ICONS.trash))),
      )))),
  );
}

/* ---------------- 编辑器 ---------------- */
export function openNoteEditor(note) {
  const n = { ...note };
  const titleI = el('input', { class: 'input', value: n.title || '', placeholder: '标题（留空会自动取正文首行）' });
  const bodyI = el('textarea', { class: 'textarea', rows: 12, style: { fontFamily: 'var(--mono)', fontSize: '13px' } });
  bodyI.value = n.body || '';
  const preview = el('div', { class: 'note-preview', style: { display: 'none', minHeight: '180px', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '12px 14px', background: 'var(--surface-2)', lineHeight: '1.8' } });
  const tagsI = el('input', { class: 'input', value: (n.tags || []).join('，'), placeholder: '标签，用逗号分隔' });
  const statusS = el('select', { class: 'select' }, ...COLUMNS.map(c => el('option', { value: c.id, selected: (n.status || 'inbox') === c.id, text: c.name })));
  const savedTag = el('span', { class: 'small muted', text: '自动保存' });

  const parseList = s => String(s || '').split(/[,，、;；\n]/).map(x => x.trim()).filter(Boolean);
  const save = debounce(async () => {
    const body = bodyI.value;
    const title = titleI.value.trim() || (n.quote ? n.quote.slice(0, 22) : body.split('\n')[0].slice(0, 22)) || '未命名笔记';
    const links = [...body.matchAll(/\[\[(.+?)\]\]/g)].map(m => m[1].trim());
    const row = await store.saveNote({
      id: n.id, title, body, tags: parseList(tagsI.value), status: statusS.value, links,
      kind: n.kind || 'free',
    });
    savedTag.textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    Object.assign(n, row);
    if (preview.style.display !== 'none') preview.innerHTML = renderMarkdown(body);
  }, 420);

  [titleI, bodyI, tagsI].forEach(i => i.addEventListener('input', save));
  statusS.addEventListener('change', save);

  const bodyWrap = el('div', {},
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('div', { class: 'grow' }, el('input', { class: 'input', value: n.title || '', placeholder: '标题', on: { input: e => { titleI.value = e.target.value; save(); } }, id: 'note-title-inline' })),
      el('div', { class: 'seg-group' },
        el('button', { class: 'active', text: '编辑', on: { click: e => { e.target.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); bodyI.style.display = ''; preview.style.display = 'none'; } } }),
        el('button', { text: '预览', on: { click: e => { e.target.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active')); e.target.classList.add('active'); preview.innerHTML = renderMarkdown(bodyI.value); bodyI.style.display = 'none'; preview.style.display = ''; } } }),
      ),
    ),
    (n.kind === 'quote' || n.kind === 'ai') && n.quote ? el('div', { class: 'card', style: { marginBottom: '10px' } },
      el('div', { class: 'card-top' }, el('span', { class: 'kind', text: '原文引用' }), el('span', { class: 'spacer', style: { flex: '1' } }),
        el('button', { class: 'btn sm ghost', on: { click: () => { jumpToBook(n); } } }, svg(ICONS.jump), '回到原文')),
      el('div', { class: 'card-quote', style: { WebkitLineClamp: '6' }, text: n.quote })) : null,
    bodyI, preview,
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('div', { class: 'grow' }, tagsI),
      el('div', { style: { width: '150px' } }, statusS),
    ),
    el('div', { class: 'small muted', style: { marginTop: '8px' } },
      '支持 Markdown；用 ',
      el('code', { text: '[[' }),
      ' 术语名或笔记标题 ',
      el('code', { text: ']]' }),
      ' 建立双向链接。'),
    savedTag,
  );

  titleI.style.display = 'none';

  const close = modal({
    title: n.title || '编辑笔记',
    body: bodyWrap,
    width: 'min(820px,94vw)',
    actions: [
      {
        text: '转为术语', onClick: async c => {
          await save.flush();
          const text = (n.title || bodyI.value).trim();
          await openTermEditor({ name: text.slice(0, 30), definition: bodyI.value.slice(0, 200), bookId: n.bookId, isNew: true });
          toast('已建立术语', 'ok');
        },
      },
      { text: '删除', danger: true, onClick: async c => { if (await confirmDialog({ title: '删除笔记', message: '确定删除？' })) { await store.removeNote(n.id); c(); } } },
      { text: '完成', primary: true, onClick: async c => { await save.flush(); c(); toast('已保存', 'ok'); } },
    ],
  });
  const titleField = bodyWrap.querySelector('#note-title-inline');
  titleField?.addEventListener('input', () => { titleI.value = titleField.value; });
  return close;
}

export async function newNote(patch = {}) {
  const row = await store.saveNote({ kind: 'free', status: 'inbox', title: '新建笔记', body: '', ...patch });
  if (store.state.route !== 'notes') store.go('notes');
  setTimeout(() => openNoteEditor(row), 60);
  return row;
}

/* ---------------- 双链与 Markdown ---------------- */
export function renderMarkdown(text) {
  let html;
  const src = String(text || '');
  if (window.marked?.parse) {
    try { html = window.marked.parse(src, { breaks: true, gfm: true }); }
    catch { html = `<p>${esc(src)}</p>`; }
  } else html = `<p>${esc(src).replace(/\n/g, '<br>')}</p>`;
  return html.replace(/\[\[(.+?)\]\]/g, (_, name) => `<span class="wl" data-link="${esc(name.trim())}">${esc(name.trim())}</span>`);
}

export function bindWikiLinks(root) {
  root.addEventListener('click', e => {
    const wl = e.target.closest?.('.wl');
    if (!wl) return;
    resolveWikiLink(wl.dataset.link);
  });
}

export function resolveWikiLink(name) {
  const term = store.state.terms.find(t => t.name === name || (t.aliases || []).includes(name));
  if (term) {
    if (term.bookId && term.bookId !== store.state.bookId) {
      store.openBook(term.bookId).then(() => store.openAside('term', { focusTermId: term.id }));
    } else store.openAside('term', { focusTermId: term.id });
    return;
  }
  const note = store.state.notes.find(n => n.title === name);
  if (note) { openNoteEditor(note); return; }
  const book = store.state.books.find(b => b.title === name);
  if (book) { store.openBook(book.id); return; }
  toast(`找不到「${name}」，可以先建立一个术语`, 'err');
}

function jumpToBook(n) {
  if (!n.bookId) return;
  if (store.state.bookId !== n.bookId) {
    store.openBook(n.bookId).then(() => jumpTo({ chapterId: n.chapterId, blockId: n.blockId }));
  } else jumpTo({ chapterId: n.chapterId, blockId: n.blockId });
}

function collectTags(notes) {
  const map = new Map();
  for (const n of notes) for (const t of n.tags || []) map.set(t, (map.get(t) || 0) + 1);
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
}
