/* 应用外壳：提示、弹窗、命令面板、设置、数据导入导出 */

import { $, el, svg, ICONS, HL_COLORS, esc, downloadText, downloadBlob, fuzzyScore, fmtBytes, relTime, clamp, fmtNum, setChildren } from '../core/utils.js';
import * as db from '../core/db.js';
import store from '../core/store.js';
import { backup, listBackups, flush, restoreFrom, describeBackup, describePending, clearPending } from '../core/backup.js';

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
    { kind: '命令', label: '问 AI…', run: () => store.bus.emit('aiAsk', { question: '' }) },
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
        el('h3', { text: '存档位置与磁盘备份' }),
        backupPanel(),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: 'AI 助手（可选）' }),
        aiPanel(row, sw),
      ),
      el('div', { class: 'set-panel' },
        el('h3', { text: '快捷键' }),
        ...[
          ['Ctrl / ⌘ + K', '打开命令面板'],
          ['Ctrl / ⌘ + S', '保存（写入磁盘备份）'],
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

/* ---------------- AI 助手配置 ----------------
   Key 存服务端本地文件（ai.local.json，已被 .gitignore 忽略），
   页面只知道「配没配 / 用的哪个模型」，永远读不回完整 Key。 */
const AI_HEADERS = { 'Content-Type': 'application/json', 'X-InkMark': '1' };

function aiPanel(row, sw) {
  const host = el('div', {});
  const statusEl = el('span', { class: 'pill', text: '检测中…' });
  const providerSel = el('select', { class: 'select', style: { width: '160px' } },
    el('option', { value: 'deepseek', text: 'DeepSeek' }));
  const baseUrlI = el('input', { class: 'input', style: { width: '250px' }, placeholder: 'https://api.deepseek.com' });
  const keyI = el('input', { class: 'input', type: 'password', style: { width: '250px' }, placeholder: '粘贴 API Key' });
  const modelSel = el('select', { class: 'select', style: { width: '210px' } },
    el('option', { value: 'deepseek-flash', text: 'deepseek-flash（便宜）' }),
    el('option', { value: 'deepseek-v4-pro', text: 'deepseek-v4-pro（更强）' }));

  async function load() {
    try {
      const d = await (await fetch('/__ai/status', { headers: AI_HEADERS })).json();
      if (d.configured) {
        statusEl.textContent = '已配置';
        statusEl.className = 'pill ok';
        providerSel.value = d.provider || 'deepseek';
        baseUrlI.value = d.baseUrl || '';
        modelSel.value = d.model || 'deepseek-flash';
        keyI.placeholder = '已保存，留空表示不修改';
      } else {
        statusEl.textContent = '未配置';
        statusEl.className = 'pill warn';
        baseUrlI.value = 'https://api.deepseek.com';
        keyI.placeholder = '粘贴你的 DeepSeek API Key';
      }
    } catch {
      statusEl.textContent = '本地服务不可用';
      statusEl.className = 'pill warn';
    }
  }

  const saveBtn = el('button', {
    class: 'btn sm primary', text: '保存',
    on: {
      click: async () => {
        saveBtn.disabled = true;
        try {
          const d = await (await fetch('/__ai/config', {
            method: 'POST', headers: AI_HEADERS,
            body: JSON.stringify({
              provider: providerSel.value,
              baseUrl: baseUrlI.value.trim(),
              apiKey: keyI.value.trim(),      // 留空 = 保留原值
              model: modelSel.value,
            }),
          })).json();
          if (!d.ok) throw new Error(d.error || '保存失败');
          keyI.value = '';
          await load();
          toast('AI 配置已保存', 'ok');
          // 通知 AI 面板刷新状态；用动态 import 避免 shell ↔ ai 循环依赖
          const m = await import('./ai.js').catch(() => null);
          await m?.refreshAiStatus();
        } catch (e) {
          toast(`保存失败：${e.message}`, 'err', 4200);
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
  });

  /* 这两项只改界面偏好，直接切类名、不整页重绘 ——
     否则用户打到一半的 Key 会被重绘冲掉 */
  const ctxGroup = el('div', { class: 'seg-group' },
    ...['brief', 'chapter'].map(lv => el('button', {
      class: (store.ui.aiCtxLevel || 'brief') === lv ? 'active' : '',
      text: lv === 'brief' ? '精简' : '本章',
      on: {
        click: e => {
          store.setUi({ aiCtxLevel: lv });
          [...e.target.parentElement.querySelectorAll('button')].forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
        },
      },
    })));

  host.append(
    row('连接状态', '未配置时，墨读全程不会产生任何外部请求', statusEl),
    row('服务商', '目前只支持 DeepSeek', providerSel),
    row('接口地址', '默认即可；也可指向自建或代理', baseUrlI),
    row('API Key', '只存在本机 ai.local.json，不进仓库、不被页面读回', keyI),
    row('模型', '', modelSel),
    row('', '', saveBtn),
    row('默认上下文', '精简＝选段＋所在段落；本章＝再加上整章',
      el('div', { class: 'row' }, ctxGroup)),
    row('带上术语定义', '让模型知道某个词在本书里的特定含义',
      sw(store.ui.aiIncludeTerms !== false, v => store.setUi({ aiIncludeTerms: v }))),
    row('对话历史', '只存本机，随备份一起走，不进仓库',
      el('button', {
        class: 'btn sm danger', text: '清空全部对话',
        on: {
          click: async () => {
            if (!await confirmDialog({ title: '清空全部对话', message: '所有 AI 对话记录都会被删除，无法恢复。确定吗？' })) return;
            await store.clearChats();
            toast('已清空全部对话', 'ok');
          },
        },
      })),
    el('p', { class: 'small muted', style: { marginTop: '10px' } },
      '每次提问只会把「选中的原文 ＋ 所在段落 ＋ 书名章节」发给你配置的服务商。'
      + '你的批注、笔记和术语的「我的理解」永远不会发送。'),
  );

  load();
  return host;
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

/* ---------------- 数据存放位置与磁盘备份 ---------------- */

/** 生成"数据存在哪 / 备份到哪"面板；状态变化时只重绘这一块 */
export function backupPanel() {
  const host = el('div', {});
  const origin = location.origin;
  const canonical = 'http://localhost:8765';
  const unusual = origin !== canonical;

  const persistEl = el('span', { class: 'pill', text: '检测中…' });
  async function checkPersist() {
    try {
      const v = await navigator.storage?.persisted?.();
      persistEl.textContent = v ? '已授权 · 不会被自动清理' : '未授权 · 建议点右侧申请';
      persistEl.className = `pill ${v ? 'ok' : 'warn'}`;
      return v;
    } catch { persistEl.textContent = '浏览器不支持检测'; return false; }
  }
  checkPersist();
  const persistBtn = el('button', {
    class: 'btn sm', text: '申请授权',
    on: {
      click: async e => {
        e.target.disabled = true;
        try {
          const ok = await navigator.storage.persist();   // 点击属于用户手势，成功率更高
          toast(ok ? '已获得持久化授权，数据不会被浏览器自动清理' : '浏览器暂未批准；有磁盘备份兜底，不影响使用', ok ? 'ok' : '');
          await checkPersist();
        } catch { toast('当前浏览器不支持该能力', 'err'); }
        e.target.disabled = false;
      },
    },
  });

  const listHost = el('div', { class: 'small', style: { marginTop: '10px' } });
  const statusEl = el('div', { class: 'small muted', text: backup.summary() });

  async function refresh() {
    statusEl.textContent = backup.summary();
    const pendingNotice = backup.pending
      ? el('div', {
        class: 'card',
        style: { borderColor: 'var(--warn)', background: 'color-mix(in srgb,var(--warn) 10%,transparent)', marginBottom: '10px' },
      },
        el('div', { class: 'small', text: `上次离开时有改动没能自动备份：${describePending()}${backup.pending.why ? `（${backup.pending.why}）` : ''}` }),
        el('div', { class: 'row', style: { marginTop: '8px' } },
          el('button', {
            class: 'btn sm primary', text: '现在补一次备份',
            on: {
              click: async () => {
                const ok = await flush('补做关闭时的备份', { force: true });
                toast(ok ? '已写入磁盘备份' : `备份失败：${backup.error || '未知原因'}`, ok ? 'ok' : 'err');
                refresh();
              },
            },
          }),
          el('button', { class: 'btn sm ghost', text: '忽略这次', on: { click: () => { clearPending(); refresh(); } } }),
        ))
      : null;
    if (!backup.supported) {
      listHost.replaceChildren(el('div', { class: 'muted small', text: '磁盘备份需要从「启动.bat」打开的地址访问，当前不可用。' }));
      return;
    }
    try {
      const items = await listBackups();
      if (!items.length) {
        listHost.replaceChildren(pendingNotice, el('div', { class: 'muted small', text: '还没有生成备份。默认会在你关闭页面时自动备份一次。' }));
        return;
      }
      listHost.replaceChildren(
        pendingNotice,
        el('div', { class: 'muted small', style: { marginBottom: '6px' }, text: `保存在 ${backup.dir}` }),
        ...items.slice(0, 6).map((b, i) => el('div', { class: 'row', style: { padding: '4px 0', gap: '8px' } },
          el('span', { class: 'grow mono', style: { fontSize: '11.5px' }, text: b.name }),
          (b.books || 0) === 0
            ? el('span', { class: 'pill', text: '空备份' })
            : el('span', { class: 'pill', text: `${b.books} 书 / ${b.annotations || 0} 标注 / ${b.notes || 0} 笔记` }),
          b.reason ? el('span', { class: 'muted', style: { fontSize: '11px' }, text: b.reason }) : null,
          el('span', { class: 'muted', style: { fontSize: '11.5px' }, text: describeBackup(b) }),
          el('button', {
            class: 'btn sm', text: i === 0 ? '恢复这一份' : '恢复',
            on: {
              click: async () => {
                if (!await confirmDialog({
                  title: '从磁盘备份恢复',
                  message: `将用「${b.name}」覆盖当前全部数据（${describeBackup(b)}）。当前数据会被替换，确定继续吗？`,
                  okText: '覆盖并恢复', danger: true,
                })) return;
                try {
                  const payload = await restoreFrom(b.name);
                  toast(`已恢复备份（${payload.data?.books?.length || 0} 本书），正在刷新…`, 'ok');
                  setTimeout(() => location.reload(), 700);
                } catch (e) { toast(`恢复失败：${e.message}`, 'err', 5000); }
              },
            },
          }),
        )),
      );
    } catch (e) {
      listHost.replaceChildren(el('div', { class: 'small', style: { color: 'var(--danger)' }, text: `读取备份列表失败：${e.message}` }));
    }
  }

  host.append(
    el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, '当前地址（决定数据存在哪）',
        el('small', { text: '浏览器按网址隔离存储，换一个地址就看不到这里的书和批注' })),
      el('span', { class: 'mono small', style: { color: unusual ? 'var(--warn)' : 'var(--ok)' }, text: origin }),
    ),
    unusual ? el('div', { class: 'card', style: { borderColor: 'var(--warn)', background: 'color-mix(in srgb,var(--warn) 10%,transparent)' } },
      el('div', { class: 'small', text: `⚠ 标准地址是 ${canonical}/ ，你现在用的是 ${origin} 。如果之前是在标准地址下写的内容，这里会看不到——请改用标准地址打开，或从下面的磁盘备份恢复。` })) : null,
    el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, '持久化存储', el('small', { text: '授权后浏览器不会在磁盘紧张时清理你的数据' })),
      el('div', { class: 'row' }, persistEl, persistBtn),
    ),
    el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, '自动备份时机',
        el('small', { text: '默认在你关闭页面时自动备份一次，不打扰你；数据过大发不完时会在下次打开时询问' })),
      el('select', {
        class: 'select', style: { width: '200px' },
        on: { change: e => { store.setUi({ backupMode: e.target.value }); refresh(); } },
      },
        el('option', { value: 'close', selected: backup.mode() === 'close', text: '关闭页面时（推荐）' }),
        el('option', { value: 'hourly', selected: backup.mode() === 'hourly', text: '每小时自动备份' }),
        el('option', { value: 'manual', selected: backup.mode() === 'manual', text: '仅手动备份' }),
      ),
    ),
    el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, '手动保存',
        el('small', { text: '也可以随时点左侧栏的「保存」，或按 Ctrl+S' })),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn sm primary', text: '保存一次',
          on: { click: async () => { await saveNow('手动保存'); refresh(); } },
        }),
        el('button', { class: 'btn sm', text: '刷新列表', on: { click: refresh } }),
      ),
    ),
    el('div', { class: 'set-row' },
      el('div', { class: 'lbl' }, '书库为空时提示恢复备份',
        el('small', { text: '如果觉得提示多余可以关掉；关掉后仍可在下面的列表里手动恢复' })),
      (() => {
        const input = el('input', {
          type: 'checkbox', checked: store.ui.showRestoreHint !== false,
          on: {
            change: e => {
              store.setUi({ showRestoreHint: e.target.checked });
              toast(e.target.checked ? '已开启提示' : '已关闭提示');
            },
          },
        });
        return el('label', { class: 'switch' }, input, el('span', { class: 'sl' }));
      })(),
    ),
    statusEl, listHost,
  );

  backup.onChange(() => { statusEl.textContent = backup.summary(); });
  refresh();
  return host;
}

/* ---------------- 全局快捷键 ---------------- */
export function bindGlobalKeys() {
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    // Ctrl/Cmd + S：像文档一样保存
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      document.querySelector('.rail-btn[data-action="save"]')?.classList.add('saving');
      setTimeout(() => document.querySelector('.rail-btn[data-action="save"]')?.classList.remove('saving'), 800);
    }
  });
}

/**
 * 上次关闭页面时有改动没能自动备份（数据超过浏览器关闭时能发送的大小），
 * 这次打开就地问用户要不要补一份。
 */
/** 手动保存：把这次用下来的全部内容写进磁盘备份（等同于文档的"保存"） */
export async function saveNow(reason = '手动保存', silent = false) {
  if (!backup.supported) {
    if (!silent) toast('当前地址不支持磁盘保存，请用「启动.bat」打开', 'err', 4000);
    return false;
  }
  const counts = {
    books: store.state.books.length,
    anns: store.state.books.reduce((n, b) => n + (b.annCount || 0), 0),
    terms: store.state.terms.length,
    notes: store.state.notes.length,
  };
  if (!counts.books && !counts.terms && !counts.notes) {
    if (!silent) toast('还没有内容可以保存');
    return false;
  }
  const ok = await flush(reason, { force: true });
  if (ok) {
    if (!silent) toast(`已保存：${counts.books} 本书 · ${counts.anns} 条批注 · ${counts.terms} 个术语 · ${counts.notes} 条笔记`, 'ok', 3400);
  } else if (!silent) {
    toast(`保存失败：${backup.error || '未知原因'}`, 'err', 4500);
  }
  return ok;
}

export function askPendingBackup() {
  const p = backup.pending;
  if (!p || !backup.supported) return false;
  if (backup.mode() === 'manual') return false;   // 用户已经明确选了"仅手动"，不打扰

  modal({
    title: '上次关闭时有改动没有备份',
    body: el('div', {},
      el('div', { class: 'small', style: { lineHeight: '1.9' } },
        `你在 ${describePending()} 关闭了页面，当时有改动没能自动写进磁盘备份${p.why ? `（${p.why}）` : ''}。`),
      el('div', { class: 'small muted', style: { marginTop: '8px' } },
        '现在保存一次吗？保存只会写到项目文件夹的 backups/，不会上传到任何地方。'),
    ),
    actions: [
      {
        text: '以后不再询问', onClick: async c => {
          await store.setUi({ backupMode: 'manual' });
          clearPending(); c();
          toast('已改为「仅手动备份」，可在设置里改回');
        },
      },
      { text: '暂不保存', onClick: c => { clearPending(); c(); } },
      {
        text: '保存', primary: true,
        onClick: async c => { c(); await saveNow('补做关闭时的保存'); },
      },
    ],
  });
  return true;
}
