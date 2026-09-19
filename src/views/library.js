/* 书库：上传、书籍区块卡片、进度环 */

import { $, el, svg, ICONS, fmtNum, relTime, downloadText, clamp, setChildren } from '../core/utils.js';
import * as db from '../core/db.js';
import { parseFile, guessKind } from '../import/parsers.js';
import store from '../core/store.js';
import { modal, toast, confirmDialog, promptDialog } from '../ui/shell.js';

let importing = false;

export function initLibrary() {
  store.bus.on('books', () => { if (store.state.route === 'library') renderLibrary(); });
  store.bus.on('route', ({ route }) => { if (route === 'library') renderLibrary(); });
  store.bus.on('stats', () => { if (store.state.route === 'library') renderLibrary(); });
}

export function renderLibrary() {
  const view = $('#view-library');
  const books = store.state.books;
  const totalAnn = books.reduce((n, b) => n + (b.annCount || 0), 0);
  const totalSec = Object.values(store.state.stats).reduce((n, s) => n + (s.sec || 0), 0);
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayMin = Math.round((store.state.stats[todayKey]?.sec || 0) / 60);
  const goal = store.ui.dailyGoalMin || 45;

  const fileInput = el('input', {
    type: 'file', multiple: true, accept: '.pdf,.epub,.txt,.md,.markdown,.html,.htm,.xhtml',
    style: { display: 'none' },
    on: { change: e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; } },
  });

  const dz = el('div', {
    class: 'dropzone',
    on: {
      click: () => fileInput.click(),
      dragover: e => { e.preventDefault(); dz.classList.add('over'); },
      dragleave: () => dz.classList.remove('over'),
      drop: e => {
        e.preventDefault(); dz.classList.remove('over');
        handleFiles(Array.from(e.dataTransfer.files));
      },
    },
  },
    el('div', { class: 'dz-icon', text: '⇪' }),
    el('div', { class: 'dz-main', text: '把电子书拖到这里，或点击选择文件' }),
    el('div', { class: 'small', style: { marginTop: '4px' }, text: '支持 PDF · EPUB · TXT · Markdown · HTML，可一次选多本' }),
  );

  setChildren(view, el('div', { class: 'page-scroll' },
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { text: '我的书库' }),
        el('p', { text: books.length ? `${books.length} 本书 · ${totalAnn} 条批注 · ${store.state.terms.length} 个术语 · 累计阅读 ${Math.round(totalSec / 60)} 分钟` : '把学习资料放进来，边读边批注' }),
      ),
      el('div', { class: 'spacer', style: { flex: '1' } }),
      el('div', { style: { minWidth: '190px' } },
        el('div', { class: 'row small muted', style: { justifyContent: 'space-between' } },
          el('span', { text: `今日阅读 ${todayMin} / ${goal} 分钟` }),
          el('span', { text: todayMin >= goal ? '✓ 达标' : `${Math.round((todayMin / goal) * 100)}%` })),
        el('div', { style: { height: '6px', borderRadius: '6px', background: 'var(--surface-3)', marginTop: '5px', overflow: 'hidden' } },
          el('div', { style: { height: '100%', width: `${clamp((todayMin / goal) * 100, 0, 100)}%`, background: todayMin >= goal ? 'var(--ok)' : 'var(--accent)', transition: 'width .4s' } })),
      ),
    ),
    fileInput,
    dz,
    books.length
      ? el('div', { class: 'book-grid' }, ...books.map(bookCard))
      : el('div', { class: 'empty' },
        el('div', { class: 'big', text: '書' }),
        el('div', { text: '书架还空着。上传第一本电子书，开始你的批注之旅。' }),
        el('div', { class: 'small', style: { marginTop: '8px' }, text: '建议先传一本 TXT 或 EPUB 试试：选中文字就能批注、设术语。' })),
  ));
}

function bookCard(b) {
  const pct = Math.round((b.progress || 0) * 100);
  const r = 15, c = 2 * Math.PI * r;
  const ring = el('div', { class: 'ring' });
  ring.innerHTML = `<svg viewBox="0 0 36 36" width="38" height="38">
    <circle cx="18" cy="18" r="${r}" fill="rgba(0,0,0,.18)" stroke="none"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="3.4"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - (b.progress || 0))}" transform="rotate(-90 18 18)"/>
  </svg>`;

  return el('div', { class: 'book-card', on: { click: () => store.openBook(b.id) } },
    el('div', { class: 'book-cover', style: { '--bc': b.color || '#8c3a2b' } },
      el('span', { class: 'fmt', text: b.format || 'BOOK' }),
      ring,
      el('span', { class: 'ini', text: (b.title || '书').slice(0, 1) }),
      el('div', { class: 'book-actions' },
        el('button', { class: 'icon-btn', title: '重命名', on: { click: e => { e.stopPropagation(); renameBook(b); } } }, svg(ICONS.edit)),
        el('button', { class: 'icon-btn', title: '导出本书批注', on: { click: e => { e.stopPropagation(); exportBook(b); } } }, svg(ICONS.doc)),
        el('button', {
          class: 'icon-btn', title: '删除', on: {
            click: async e => {
              e.stopPropagation();
              if (await confirmDialog({ title: `删除《${b.title}》`, message: '这本书的批注、术语与笔记都会一并删除，且无法恢复。' })) {
                await store.deleteBook(b.id); toast('已删除', 'ok');
              }
            },
          },
        }, svg(ICONS.trash)),
      ),
    ),
    el('div', { class: 'book-info' },
      el('div', { class: 'book-title', text: b.title }),
      el('div', { class: 'book-auth', text: b.author || b.source || '未知作者' }),
      el('div', { class: 'book-stats' },
        el('span', { text: `${b.chapterCount} 章` }),
        el('span', { text: `${fmtNum(b.wordCount || 0)} 字` }),
        el('span', { text: `${b.annCount || 0} 批注` }),
        el('span', { style: { marginLeft: 'auto' }, text: b.lastReadAt ? relTime(b.lastReadAt) : '未读' }),
      ),
      el('div', { style: { height: '3px', borderRadius: '3px', background: 'var(--surface-3)', overflow: 'hidden' } },
        el('div', { style: { height: '100%', width: `${pct}%`, background: 'var(--accent)' } })),
    ),
  );
}

async function renameBook(b) {
  const name = await promptDialog({ title: '重命名', label: '书名', value: b.title });
  if (name === null || name === undefined) return;
  await store.updateBook(b.id, { title: name || b.title });
}

async function exportBook(b) {
  const [rows, chapters] = await Promise.all([
    db.getAllBy('annotations', 'bookId', b.id),
    db.getAllBy('chapters', 'bookId', b.id),
  ]);
  chapters.sort((x, y) => x.order - y.order);
  const lines = [`# ${b.title}`, '', `> ${b.author || '未知作者'} · ${b.format} · 导出 ${new Date().toLocaleString('zh-CN')}`, '', `共 ${rows.length} 条批注`, ''];
  for (const c of chapters) {
    const list = rows.filter(r => r.chapterId === c.id).sort((x, y) => (x.blockIndex ?? 0) - (y.blockIndex ?? 0) || x.start - y.start);
    if (!list.length) continue;
    lines.push(`## ${c.title}`, '');
    for (const a of list) {
      lines.push(`> ${(a.quote || '').replace(/\n/g, ' ')}`, '');
      if (a.note) lines.push(a.note, '');
      lines.push(`*（${new Date(a.createdAt).toLocaleString('zh-CN')}）*`, '');
    }
  }
  downloadText(`${b.title}-批注.md`, lines.join('\n'));
  toast('已导出本书批注', 'ok');
}

/* ---------------- 导入 ---------------- */
async function handleFiles(files) {
  if (importing) return toast('正在导入上一批文件，请稍候', 'err');
  const valid = files.filter(f => guessKind(f));
  const skipped = files.length - valid.length;
  if (!valid.length) return toast('没有可导入的文件（支持 PDF / EPUB / TXT / MD / HTML）', 'err', 4000);
  importing = true;
  const progress = showImportModal();
  let ok = 0;
  for (let i = 0; i < valid.length; i++) {
    const f = valid[i];
    progress.set(`正在解析 ${f.name}`, i / valid.length);
    try {
      const parsed = await parseFile(f, p => {
        if (p.phase === 'pdf') progress.set(`正在读取 ${f.name}（第 ${p.done}/${p.total} 页）`, (i + p.done / p.total) / valid.length);
        if (p.phase === 'epub') progress.set(`正在读取 ${f.name}（${p.done}/${p.total} 节）`, (i + p.done / p.total) / valid.length);
      });
      if (!parsed.chapters?.length) throw new Error('没有解析到正文');
      await store.addBook(parsed, f);
      ok++;
    } catch (e) {
      console.error(e);
      toast(`${f.name} 导入失败：${e.message}`, 'err', 5200);
    }
  }
  progress.close();
  importing = false;
  if (ok) toast(`成功导入 ${ok} 本书${skipped ? `，跳过 ${skipped} 个不支持的文件` : ''}`, 'ok', 3400);
}

function showImportModal() {
  const label = el('div', { class: 'small', text: '准备中…' });
  const bar = el('div', { style: { height: '6px', borderRadius: '6px', background: 'var(--surface-3)', marginTop: '10px', overflow: 'hidden' } },
    el('div', { style: { height: '100%', width: '0%', background: 'var(--accent)', transition: 'width .2s' } }));
  const host = el('div', {}, label, bar, el('div', { class: 'small muted', style: { marginTop: '10px' }, text: '大文件（尤其是 PDF）解析需要一点时间，请不要关闭页面。' }));
  const close = modal({ title: '导入电子书', body: host });
  return {
    set(text, ratio) {
      label.textContent = text;
      bar.firstElementChild.style.width = `${Math.round((ratio || 0) * 100)}%`;
    },
    close,
  };
}
