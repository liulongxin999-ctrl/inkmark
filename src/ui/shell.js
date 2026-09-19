/* 应用外壳：提示、弹窗、命令面板、设置、数据导入导出 */

import { $, el, svg, ICONS, HL_COLORS, esc, downloadText, downloadBlob, fuzzyScore, fmtBytes, relTime, clamp, fmtNum, setChildren } from '../core/utils.js';
import * as db from '../core/db.js';
import store from '../core/store.js';

/* ---------------- 提示 ---------------- */
let toastTimer = new Map();
export function toast(msg, kind = '', ms = 2600) {
  const host = $('#toasts');
  const node = el('div', { class: `toast ${kind}`, text: msg });
  host.append(node);
  const t = setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateY(6px)'; node.style.transition = '.25s'; setTimeout(() => node.remove(), 260); }, ms);
  toastTimer.set(node, t);
  return node;
}

/* ---------------- 弹窗 ---------------- */
export function modal({ title, body, actions = [], width, onMount }) {
  const root = $('#modal-root');
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const box = el('div', { class: 'modal', style: width ? { width } : {} },
    el('div', { class: 'modal-head' },
      el('h3', { text: title || '' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'icon-btn', on: { click: close } }, svg(ICONS.close))),
    el('div', { class: 'modal-body' }, body),
    actions.length ? el('div', { class: 'modal-foot' },
      ...actions.map(a => el('button', {
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
        on: { click: () => a.onClick?.(close) },
      }, a.text))) : null,
  );
  const mask = el('div', {
    class: 'modal-mask',
    on: { mousedown: e => { if (e.target === mask) close(); } },
  }, box);
  root.append(mask);
  document.addEventListener('keydown', onKey);
  onMount?.(box, close);
  box.querySelector('input,textarea,select')?.focus();
  return close;
}

export function confirmDialog({ title = '确认操作', message, danger = true, okText = '确定', cancelText = '取消' }) {
  return new Promise(resolve => {
    let settled = false;
    const close = modal({
      title,
      body: el('div', { class: 'small', style: { lineHeight: '1.8' }, text: message }),
      actions: [
        { text: cancelText, onClick: c => { settled = true; c(); resolve(false); } },
        { text: okText, danger, primary: !danger, onClick: c => { settled = true; c(); resolve(true); } },
      ],
    });
    // 关闭按钮/ESC 视为取消
    const t = setInterval(() => { if (!$('#modal-root .modal')) { clearInterval(t); if (!settled) resolve(false); } }, 200);
  });
}

export function promptDialog({ title = '输入', label = '', value = '', placeholder = '', multiline = false }) {
  return new Promise(resolve => {
    let done = false;
    const input = multiline
      ? el('textarea', { class: 'textarea', placeholder, rows: 4 })
      : el('input', { class: 'input', value, placeholder });
    if (multiline) input.value = value;
    const close = modal({
      title,
      body: el('div', {},
        label ? el('label', { class: 'small muted', style: { display: 'block', marginBottom: '6px' }, text: label }) : null,
        input),
      actions: [
        { text: '取消', onClick: c => { done = true; c(); resolve(null); } },
        { text: '确定', primary: true, onClick: c => { done = true; c(); resolve(input.value.trim()); } },
      ],
    });
    const t = setInterval(() => { if (!$('#modal-root .modal')) { clearInterval(t); if (!done) resolve(null); } }, 200);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); done = true; close(); resolve(input.value.trim()); }
    });
  });
}

/* ---------------- 术语编辑器 ---------------- */
export async function openTermEditor(term = {}) {
  const isNew = !term.id;
  const fields = {};
  const mk = (key, label, opts = {}) => {
    const input = opts.multiline
      ? el('textarea', { class: 'textarea', rows: opts.rows || 3, placeholder: opts.placeholder || '' })
      : el('input', { class: 'input', placeholder: opts.placeholder || '' });
    input.value = opts.value ?? '';
    fields[key] = input;
    return el('div', { class: 'field' }, el('label', { text: label }), input);
  };

  const colorRow = el('div', { class: 'row wrap', style: { gap: '6px' } },
    ...['#2f5d7c', '#b0432a', '#3f6b4a', '#6b4a8c', '#8a6a22', '#2d6b6b'].map(c =>
      el('span', {
        class: `hl-swatch${(term.color || '#2f5d7c') === c ? ' active' : ''}`,
        style: { background: c, width: '22px', height: '22px' },
        on: { click: e => { fields.color.value = c; e.target.parentElement.querySelectorAll('.hl-swatch').forEach(s => s.classList.remove('active')); e.target.classList.add('active'); } },
      })));
  const colorHidden = el('input', { type: 'hidden', value: term.color || '#2f5d7c' });
  fields.color = colorHidden;

  const scopeSel = el('select', { class: 'select' },
    el('option', { value: 'book', text: '仅本书', selected: term.bookId !== null }),
    el('option', { value: 'global', text: '全局（所有书籍通用）', selected: term.bookId === null && !isNew }),
  );
  fields.scope = scopeSel;

  const body = el('div', {},
    el('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-start' } },
      el('div', { class: 'grow' }, mk('name', '术语名称 *', { value: term.name || '', placeholder: '例如：马尔可夫链' })),
      el('div', { style: { width: '180px' } }, el('div', { class: 'field' }, el('label', { text: '作用域' }), scopeSel)),
    ),
    mk('aliases', '别名（用逗号分隔，也会一起高亮）', { value: (term.aliases || []).join('，'), placeholder: '例如：马氏链，Markov Chain' }),
    mk('definition', '定义 / 释义', { multiline: true, rows: 3, value: term.definition || '', placeholder: '它在原文中是什么意思？' }),
    mk('myNote', '我的理解 / 补充', { multiline: true, rows: 3, value: term.myNote || '', placeholder: '你的联想、例子、易错点…' }),
    el('div', { class: 'row' },
      el('div', { class: 'grow' }, mk('category', '分类', { value: term.category || '', placeholder: '例如：概率论 / 人名 / 公式' })),
      el('div', { class: 'grow' }, mk('tags', '标签（逗号分隔）', { value: (term.tags || []).join('，'), placeholder: '重点，考试' })),
    ),
    el('div', { class: 'field' }, el('label', { text: '颜色标记' }), colorRow, colorHidden),
    mk('links', '关联术语（逗号分隔，支持 [[]] 双链）', { value: (term.links || []).join('，'), placeholder: '相关概念' }),
  );

  return new Promise(resolve => {
    let saved = null;
    const parseList = s => String(s || '').split(/[,，、;；\n]/).map(x => x.trim().replace(/^\[\[|\]\]$/g, '')).filter(Boolean);
    const close = modal({
      title: isNew ? '建立术语' : `编辑术语 · ${term.name}`,
      body,
      width: 'min(720px,94vw)',
      actions: [
        { text: '取消', onClick: c => { c(); resolve(null); } },
        {
          text: isNew ? '建立术语' : '保存', primary: true, onClick: async c => {
            const name = fields.name.value.trim();
            if (!name) { toast('术语名称不能为空', 'err'); return; }
            saved = await store.saveTerm({
              id: term.id, name,
              aliases: parseList(fields.aliases.value),
              definition: fields.definition.value.trim(),
              myNote: fields.myNote.value.trim(),
              category: fields.category.value.trim(),
              tags: parseList(fields.tags.value),
              links: parseList(fields.links.value),
              color: fields.color.value,
              bookId: fields.scope.value === 'global' ? null : (term.bookId ?? store.state.bookId),
            });
            c(); resolve(saved);
          },
        },
      ],
    });
  });
}

/* ---------------- 命令面板 ---------------- */
export function openPalette() {
  if ($('#modal-root .palette-mask')) return;
  const input = el('input', { class: 'palette-input', placeholder: '搜索书籍、章节、术语、笔记，或执行命令…' });
  const list = el('div', { class: 'palette-list' });
  let items = [], cursor = 0;

  const mask = el('div', { class: 'modal-mask palette-mask', on: { mousedown: e => { if (e.target === mask) close(); } } },
    el('div', { class: 'modal palette' }, input, list));
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };

  const commands = [
    { kind: '命令', label: '回到书库', run: () => store.go('library') },
    { kind: '命令', label: '打开笔记工作台', run: () => store.go('notes') },
    { kind: '命令', label: '开始复习', run: () => store.go('review') },
    { kind: '命令', label: '切换主题：纸白 / 护眼 / 夜间', run: () => cycleTheme() },
    { kind: '命令', label: '导出完整备份（JSON）', run: () => exportBackup() },
    { kind: '命令', label: '导出笔记为 Markdown', run: () => exportMarkdown() },
    { kind: '命令', label: '导入备份', run: () => importBackup() },
    { kind: '命令', label: '打开设置', run: () => store.go('settings') },
  ];

  function build(q) {
    const out = [];
    for (const b of store.state.books) {
      out.push({ kind: '书籍', label: b.title, hint: `${b.chapterCount} 章 · ${b.format}`, score: fuzzyScore(q, b.title), run: () => store.openBook(b.id) });
    }
    if (store.state.book) {
      store.state.chapters.forEach((c, i) => out.push({
        kind: '章节', label: c.title, hint: store.state.book.title, score: fuzzyScore(q, c.title) * 0.9,
        run: () => { store.go('reader'); store.loadChapter(i); },
      }));
    }
    for (const t of store.state.terms) {
      out.push({
        kind: '术语', label: t.name, hint: (t.definition || '').slice(0, 40), score: fuzzyScore(q, t.name) * 1.1,
        run: () => { store.openAside('term', { focusTermId: t.id }); if (t.bookId && t.bookId !== store.state.bookId) store.openBook(t.bookId); },
      });
    }
    for (const n of store.state.notes) {
      out.push({
        kind: '笔记', label: n.title || n.quote || '(无标题)', hint: n.body?.slice(0, 40) || '', score: fuzzyScore(q, `${n.title} ${n.body} ${n.quote || ''}`) * 0.8,
        run: () => { store.go('notes'); store.bus.emit('openNote', n.id); },
      });
    }
    for (const c of commands) out.push({ ...c, score: fuzzyScore(q, c.label) * 0.95 });
    return out.filter(x => x.score > 0 || !q).sort((a, b) => b.score - a.score).slice(0, 40);
  }

  function render() {
    const q = input.value;
    items = build(q);
    cursor = clamp(cursor, 0, Math.max(0, items.length - 1));
    setChildren(list, ...items.map((it, i) => el('div', {
      class: `palette-item${i === cursor ? ' sel' : ''}`,
      on: { click: () => { it.run(); close(); }, mouseenter: () => { cursor = i; render(); } },
    },
      el('span', { class: 'pill', text: it.kind }),
      el('span', { class: 'grow', text: it.label }),
      it.hint ? el('span', { class: 'k', text: String(it.hint).slice(0, 34) }) : null,
    )));
  }

  const onKey = e => {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor++; render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor--; render(); }
    if (e.key === 'Enter') { e.preventDefault(); const it = items[cursor]; if (it) { it.run(); close(); } }
  };

  document.addEventListener('keydown', onKey);
  input.addEventListener('input', () => { cursor = 0; render(); });
  document.body.append(mask);
  input.focus();
  render();
}

export function cycleTheme() {
  const order = ['paper', 'sepia', 'dark'];
  const next = order[(order.indexOf(store.ui.theme) + 1) % order.length];
  store.setUi({ theme: next });
  toast(`主题：${{ paper: '纸白', sepia: '护眼', dark: '夜间' }[next]}`);
}

/* ---------------- 设置页 ---------------- */
export function renderSettings() {
  const view = $('#view-settings');
  const ui = store.ui;
  const themeNames = { paper: '纸白', sepia: '护眼', dark: '夜间' };
  const themes = ['paper', 'sepia', 'dark'];
  const bgOf = t => ({ paper: '#fffdf8', sepia: '#f7efdc', dark: '#201d19' }[t]);
  const fgOf = t => ({ paper: '#221e18', sepia: '#2b2317', dark: '#ece5d9' }[t]);

  const row = (label, sub, control) => el('div', { class: 'set-row' },
    el('div', { class: 'lbl' }, label, sub ? el('small', { text: sub }) : null), control);
  /** 带实时数值显示的滑杆行 */
  const sliderRow = (label, sub, { min, max, step = 1, value, fmt = String, onChange }) => {
    const valEl = el('span', { class: 'small muted mono', style: { minWidth: '52px', textAlign: 'right' }, text: fmt(value) });
    const input = el('input', {
      type: 'range', min, max, step, value, style: { width: '150px', flex: '0 0 auto' },
      on: { input: e => { const v = Number(e.target.value); valEl.textContent = fmt(v); onChange(v); } },
    });
    return el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, label, sub ? el('small', { text: sub }) : null), valEl, input);
  };
  const sw = (checked, onChange) => el('label', { class: 'switch' },
    el('input', { type: 'checkbox', checked, on: { change: e => onChange(e.target.checked) } }), el('span', { class: 'sl' }));

  const storageEl = el('div', { class: 'small muted', text: '计算中…' });
  navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
    storageEl.textContent = `已用 ${fmtBytes(usage)} / 可用 ${fmtBytes(quota)}`;
  }).catch(() => { storageEl.textContent = '浏览器未提供存储信息'; });

  const counts = [
    ['书籍', store.state.books.length],
    ['批注', store.state.books.reduce((n, b) => n + (b.annCount || 0), 0)],
    ['术语', store.state.terms.length],
    ['笔记', store.state.notes.length],
    ['累计阅读', `${Math.round(Object.values(store.state.stats).reduce((n, s) => n + (s.sec || 0), 0) / 60)} 分钟`],
    ['已读字数', fmtNum(store.state.books.reduce((n, b) => n + (b.wordCount || 0) * (b.progress || 0), 0))],
  ];

  setChildren(view, el('div', { class: 'page-scroll' },
    el('div', { class: 'page-head' }, el('div', {}, el('h1', { text: '设置' }), el('p', { text: '外观、阅读体验与数据管理' }))),
    el('div', { class: 'settings-grid' },
      el('div', { class: 'set-panel' },
        el('h3', { text: '外观主题' }),
        el('div', { class: 'theme-swatches' }, ...themes.map(t => el('div', {
          class: `theme-sw${ui.theme === t ? ' active' : ''}`, title: themeNames[t],
          style: { background: bgOf(t), display: 'grid', placeItems: 'center' },
          on: { click: () => { store.setUi({ theme: t }); renderSettings(); } },
        }, el('span', { style: { width: '20px', height: '3px', borderRadius: '3px', background: fgOf(t), display: 'block' } })))),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: '阅读体验' }),
        sliderRow('字号', '正文文字大小', { min: 14, max: 28, value: ui.fontSize, fmt: v => `${v}px`, onChange: v => store.setUi({ fontSize: v }) }),
        sliderRow('行距', '行与行之间的距离', { min: 1.4, max: 2.6, step: 0.05, value: ui.lineHeight, fmt: v => v.toFixed(2), onChange: v => store.setUi({ lineHeight: v }) }),
        sliderRow('栏宽', '每行的最大宽度，越窄越易扫读', { min: 560, max: 1100, step: 20, value: ui.measure, fmt: v => `${v}px`, onChange: v => store.setUi({ measure: v }) }),
        row('正文字体', ui.fontFamily === 'serif' ? '衬线（宋体）' : '无衬线（黑体）',
          el('div', { class: 'seg-group' },
            el('button', { class: ui.fontFamily === 'serif' ? 'active' : '', text: '宋体', on: { click: () => { store.setUi({ fontFamily: 'serif' }); renderSettings(); } } }),
            el('button', { class: ui.fontFamily === 'sans' ? 'active' : '', text: '黑体', on: { click: () => { store.setUi({ fontFamily: 'sans' }); renderSettings(); } } }))),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: '批注与术语' }),
        row('默认高亮颜色', '', el('div', { class: 'row', style: { gap: '6px' } }, ...HL_COLORS.map(c => el('span', {
          class: `hl-swatch${ui.highlightColor === c.key ? ' active' : ''}`, title: c.name,
          style: { background: c.key, width: '22px', height: '22px' },
          on: { click: () => { store.setUi({ highlightColor: c.key }); renderSettings(); } },
        })))),
        row('自动高亮术语', '建立术语后，全书中该词自动标记虚线', sw(ui.autoTermHighlight, v => { store.setUi({ autoTermHighlight: v }); renderSettings(); })),
        row('悬停显示批注气泡', '鼠标停留在标记上 0.25 秒后弹出预览', sw(ui.showHoverCard, v => { store.setUi({ showHoverCard: v }); renderSettings(); })),
        sliderRow('术语最短长度', '低于该长度的词不会自动高亮', { min: 1, max: 6, value: ui.minTermLen, fmt: v => `${v} 字`, onChange: v => store.setUi({ minTermLen: v }) }),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: '数据' }),
        el('div', { class: 'stat-grid', style: { marginBottom: '12px' } },
          ...counts.map(([l, v]) => el('div', { class: 'stat' }, el('div', { class: 'v', text: String(v) }), el('div', { class: 'l', text: l })))),
        storageEl,
        el('div', { class: 'divider' }),
        el('div', { class: 'row wrap' },
          el('button', { class: 'btn', on: { click: () => exportBackup() } }, svg(ICONS.upload), '导出备份'),
          el('button', { class: 'btn', on: { click: () => importBackup() } }, '导入备份'),
          el('button', { class: 'btn', on: { click: () => exportMarkdown() } }, svg(ICONS.doc), '导出 Markdown'),
          el('button', {
            class: 'btn danger', on: {
              click: async () => {
                if (!await confirmDialog({ title: '清空全部数据', message: '将删除所有书籍、批注、术语与笔记，且不可恢复。建议先导出备份。' })) return;
                await db.wipeAll();
                location.reload();
              },
            },
          }, svg(ICONS.trash), '清空全部'),
        ),
        el('p', { class: 'small muted', style: { marginTop: '10px' }, text: '所有数据都保存在这台电脑的浏览器里（IndexedDB），不会上传到任何服务器。清理浏览器数据会一并清除，请定期导出备份。' }),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: '快捷键' }),
        ...[
          ['Ctrl / ⌘ + K', '打开命令面板'],
          ['H', '高亮选中文字'],
          ['U', '加下划线'],
          ['N', '写批注并打开侧栏'],
          ['T', '把选中的词设为术语'],
          ['B', '在当前位置加书签'],
          ['J / K', '下一章 / 上一章'],
          ['Esc', '关闭弹窗与工具条'],
        ].map(([k, d]) => row(d, '', el('span', { class: 'kbd', text: k }))),
      ),
    ),
  ));
}

/* ---------------- 数据导入导出 ---------------- */
export async function exportBackup() {
  const payload = await db.exportAll();
  downloadBlob(`墨读备份-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  toast('备份已导出', 'ok');
}

export function importBackup() {
  const input = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (!await confirmDialog({ title: '导入备份', message: '导入会覆盖当前全部数据，确定继续吗？' })) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      toast('导入完成，正在刷新…', 'ok');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(`导入失败：${e.message}`, 'err', 5000); }
  });
  input.click();
}

export function exportMarkdown() {
  const books = store.state.books;
  const zip = new window.JSZip();
  const folder = zip.folder('墨读笔记');
  const index = ['# 墨读笔记导出', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '', '## 目录', ''];
  const termsFolder = folder.folder('术语库');
  const allTerms = store.state.terms;
  termsFolder.file('全部术语.md', [
    '# 术语总表', '',
    ...allTerms.map(t => `## ${t.name}\n\n- 分类：${t.category || '未分类'}\n- 别名：${(t.aliases || []).join('、') || '无'}\n- 标签：${(t.tags || []).join('、') || '无'}\n\n**定义**\n\n${t.definition || '_未填写_'}\n\n**我的理解**\n\n${t.myNote || '_未填写_'}\n`),
  ].join('\n'));

  for (const b of books) {
    const bFolder = folder.folder(`${safe(b.title)}`);
    const anns = store.state.notes.filter(n => n.bookId === b.id);
    const bTerms = allTerms.filter(t => t.bookId === b.id);
    index.push(`- [${b.title}](${safe(b.title)}/笔记.md) — 笔记 ${anns.length} 条，术语 ${bTerms.length} 个`);
    bFolder.file('笔记.md', [
      `# ${b.title}`, '', b.author ? `> 作者：${b.author}` : '', `> ${b.format} · ${b.chapterCount} 章 · 阅读进度 ${Math.round((b.progress || 0) * 100)}%`, '',
      '## 笔记', '',
      ...store.state.notes.filter(n => n.bookId === b.id).map(n => [
        `### ${n.title || '(无标题)'}`,
        '', `> ${(n.quote || '').replace(/\n/g, ' ')}`, '',
        n.body || '_空_', '',
        `- 状态：${statusName(n.status)}`, `- 标签：${(n.tags || []).join('、') || '无'}`, `- 更新：${relTime(n.updatedAt)}`, '',
      ].join('\n')),
    ].filter(Boolean).join('\n'));
    if (bTerms.length) {
      bFolder.file('术语.md', [`# ${b.title} · 术语`, '', ...bTerms.map(t => `## ${t.name}\n\n${t.definition || '_未填写_'}\n` + (t.myNote ? `\n**我的理解**：${t.myNote}\n` : ''))].join('\n'));
    }
  }
  const free = store.state.notes.filter(n => !n.bookId);
  if (free.length) folder.file('独立笔记.md', ['# 独立笔记', '', ...free.map(n => `## ${n.title || '(无标题)'}\n\n${n.body || ''}\n`)].join('\n'));
  folder.file('README.md', index.join('\n'));
  zip.generateAsync({ type: 'blob' }).then(blob => {
    downloadBlob(`墨读笔记-${new Date().toISOString().slice(0, 10)}.zip`, blob);
    toast('Markdown 已打包导出', 'ok');
  });
}

export const statusName = s => ({ inbox: '收集箱', working: '整理中', learned: '已掌握', archive: '归档' }[s] || s || '收集箱');
const safe = s => String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

/* ---------------- 全局快捷键 ---------------- */
export function bindGlobalKeys() {
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
}
