/* 运行时自检：在真实浏览器环境中验证核心算法与数据链路 */

import { findTermMatches, segmentBlock, describeRange, resolveRange, primaryAnnotation } from '../src/reader/anchors.js';
import { decodeTextBuffer, parseText, parseMarkdown, parseHTML } from '../src/import/parsers.js';
import { createBlockEl, paintBlock } from '../src/reader/marks.js';
import * as db from '../src/core/db.js';
import store from '../src/core/store.js';

const out = [];
let pass = 0, fail = 0;

function group(name) { out.push(`<div class="grp">── ${name} ──</div>`); }
function ok(name) { pass++; out.push(`<div class="ok">✓ ${name}</div>`); }
function bad(name, msg) { fail++; out.push(`<div class="fail">✗ ${name} — ${msg}</div>`); }
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(name); else bad(name, `期望 ${e}，实际 ${a}`);
}
function truthy(cond, name, msg = '断言为假') { cond ? ok(name) : bad(name, msg); }
async function t(name, fn) {
  try { await fn(); } catch (e) { bad(name, e.message || String(e)); }
}

/* ---------------- 1. 锚点与分段 ---------------- */
group('锚点与分段算法');

await t('术语匹配：长词优先、别名生效、互不重叠', () => {
  const terms = [{ id: 't1', name: '马尔可夫链', aliases: ['马氏链'] }, { id: 't2', name: '马尔可夫' }];
  const text = '马尔可夫链是一种模型，马尔可夫性质很重要，马氏链也常用。';
  const m = findTermMatches(text, terms, { minLen: 2 });
  eq(m.length, 3, '命中 3 处（长词优先，不与「马尔可夫」重叠）');
  eq(text.slice(m[0].start, m[0].end), '马尔可夫链', '第一处取最长匹配');
  eq(m[1].termId, 't2', '第二处是「马尔可夫」');
  eq(m[2].termId, 't1', '第三处命中别名');
});

await t('术语匹配：低于最小长度不参与，空串不匹配', () => {
  const terms = [{ id: 't1', name: '熵' }, { id: 't2', name: '' }];
  const text = '信息熵与热力学熵';
  eq(findTermMatches(text, terms, { minLen: 2 }).length, 0, '单字词在 minLen=2 时被跳过');
  eq(findTermMatches(text, terms, { minLen: 1 }).length, 2, 'minLen=1 时命中两次');
});

await t('分段：片段文本拼接后严格等于原文', () => {
  const text = 'abcdefghij';
  const anns = [{ id: 'a1', start: 2, end: 6, createdAt: 1 }, { id: 'a2', start: 4, end: 8, createdAt: 2 }];
  const terms = [{ start: 0, end: 3, termId: 'T' }];
  const segs = segmentBlock(text, anns, terms);
  eq(segs.map(s => s.text).join(''), text, '拼接还原原文');
  eq(segs.map(s => `${s.start}-${s.end}`).join(','), '0-2,2-3,3-4,4-6,6-8,8-10', '边界点覆盖所有关键位置');
  eq(segs.find(s => s.start === 4).annIds.slice().sort(), ['a1', 'a2'], '重叠区间同时命中两条批注');
  eq(segs.filter(s => s.termId === 'T').map(s => s.text).join(''), 'abc', '术语跨越多个片段仍完整覆盖');
});

await t('分段：无批注无术语时返回整块', () => {
  const segs = segmentBlock('一段普通文字', [], []);
  eq(segs.length, 1, '单片段');
  eq(segs[0].text, '一段普通文字', '内容完整');
  eq(segs[0].annIds.length, 0, '无批注');
});

await t('主批注：区间更具体者优先', () => {
  const annsById = new Map([
    ['wide', { id: 'wide', start: 0, end: 20, createdAt: 9 }],
    ['narrow', { id: 'narrow', start: 5, end: 9, createdAt: 1 }],
  ]);
  eq(primaryAnnotation({ annIds: ['wide', 'narrow'] }, annsById).id, 'narrow', '取最短区间作为视觉主标记');
});

await t('锚点：描述与还原可往返，文字位移后模糊回退', () => {
  const text = '前文内容，关键概念在这里，后文继续。';
  const a = describeRange(text, 4, 10);
  eq(a.quote, '，关键概念在', 'quote 精确对应所选区间');
  eq([a.prefix, a.suffix], ['前文内容', '这里，后文继续。'], '前后文冗余校验信息完整');
  eq([resolveRange(text, a).start, resolveRange(text, a).end], [4, 10], '精确还原');
  const moved = '新增了一段前缀文字，' + text;
  const r2 = resolveRange(moved, a);
  eq(moved.slice(r2.start, r2.end), a.quote, '文字位移后仍能定位');
});

/* ---------------- 2. 解析器 ---------------- */
group('文件解析');

await t('编码识别：GBK 与 UTF-8 字节流都能正确解码', () => {
  eq(decodeTextBuffer(new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4])), '中文测试', 'GBK 自动识别');
  eq(decodeTextBuffer(new TextEncoder().encode('中文测试')), '中文测试', 'UTF-8 正常解码');
});

await t('TXT：自动识别章节与段落', async () => {
  const content = [
    '第一章 绪论', '', '这是第一段内容。', '', '这是第二段内容。', '',
    '第二章 方法', '', '这一章讲的是具体做法。', '',
  ].join('\n');
  const parsed = await parseText(new File([content], '测试书.txt', { type: 'text/plain' }), 'TXT');
  eq(parsed.chapters.length, 2, '识别出 2 章');
  eq(parsed.chapters[0].title, '第一章 绪论', '章标题正确');
  eq(parsed.chapters[0].blocks.length, 2, '第一章有 2 段正文');
  eq(parsed.chapters[0].blocks[0].x, '这是第一段内容。', '段落内容正确');
  eq(parsed.chapters[1].blocks[0].x, '这一章讲的是具体做法。', '第二章内容正确');
});

await t('TXT：正文里以「第X章」开头的句子不被误判为标题', async () => {
  const content = [
    '第一章 起点', '', '正常正文段落。', '',
    '第二章的正文内容其实是一句话，不应该被当成标题。', '',
    '第三章 转折', '', '另一段正文。', '',
  ].join('\n');
  const parsed = await parseText(new File([content], 't.txt'), 'TXT');
  eq(parsed.chapters.length, 2, '只识别出 2 个真正的章节标题');
  eq(parsed.chapters[0].blocks.length, 2, '句末带标点的句子归入上一章正文');
});

await t('TXT：无正文的分组标题并入下一章，不丢内容也不产生空章', async () => {
  const content = ['第一部分', '', '第一章 甲', '', '甲的内容。', '', '第二章 乙', '', '乙的内容。'].join('\n');
  const parsed = await parseText(new File([content], 't.txt'), 'TXT');
  eq(parsed.chapters.length, 2, '不产生空章节');
  eq(parsed.chapters[0].title, '第一部分 · 第一章 甲', '分组标题并入下一章');
  eq(parsed.chapters[0].blocks[0].x, '甲的内容。', '内容完整保留');
  eq(parsed.chapters[1].title, '第二章 乙', '后续章节不受影响');
});

await t('TXT：无章节标记时按长度自动切分', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 段内容，` + '字'.repeat(300)).join('\n\n');
  const parsed = await parseText(new File([long], '无章节.txt'), 'TXT');
  truthy(parsed.chapters.length > 1, '切成多个部分', `实际 ${parsed.chapters.length} 章`);
  truthy(parsed.chapters.every(c => c.blocks.length), '每部分都有内容', '出现空章节');
});

await t('Markdown：标题分层与内联标记清理', async () => {
  const md = '# 我的笔记\n\n**重点**内容\n\n- 列表一\n- 列表二\n\n## 小节\n\n正文段落\n';
  const parsed = await parseMarkdown(new File([md], 'n.md'));
  truthy(parsed.chapters.length >= 2, '按标题分出章节', `实际 ${parsed.chapters.length}`);
  const all = parsed.chapters.flatMap(c => c.blocks);
  truthy(all.some(b => b.x.includes('重点内容') && !b.x.includes('**')), '加粗标记被清理', '仍包含 ** 符号');
  truthy(all.filter(b => b.t === 'li').length >= 2, '列表项被识别', '没有 li 块');
});

await t('HTML：标题、引用、图片占位', async () => {
  const html = '<html><head><title>网页名</title></head><body><h1>标题</h1><p>段落</p><blockquote>引用句</blockquote><img alt="示意图"></body></html>';
  const parsed = await parseHTML(new File([html], 'p.html'));
  eq(parsed.title, '网页名', '取 title 作为书名');
  const blocks = parsed.chapters[0].blocks;
  truthy(blocks.some(b => b.t === 'q' && b.x === '引用句'), '引用块被识别', '缺少引用块');
  truthy(blocks.some(b => b.t === 'img' && b.x === '示意图'), '图片用 alt 占位', '缺少图片块');
});

/* ---------------- 3. 渲染 ---------------- */
group('标记渲染');

await t('paintBlock：文本不丢失，标记属性正确', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const text = '量子纠缠是一种非经典的关联现象。';
  const block = { id: 'b1', t: 'p', x: text };
  const anns = [
    { id: 'a1', start: 0, end: 4, kind: 'hl', color: '#ffdf7e', createdAt: 1 },
    { id: 'a2', start: 6, end: 12, kind: 'note', color: '#a9ecc4', note: '这里要记住', createdAt: 2 },
  ];
  const terms = [{ id: 'T1', name: '量子纠缠', color: '#2f5d7c' }];
  const node = createBlockEl(block);
  host.append(node);
  paintBlock(node, block, anns, terms, { autoTermHighlight: true, minTermLen: 2 });

  eq(node.textContent, text, '渲染后文本与原文完全一致');
  const segs = Array.from(node.querySelectorAll('.sg'));
  truthy(segs.length >= 3, '切出多个片段', `实际 ${segs.length}`);
  eq(segs.map(s => s.textContent).join(''), text, '片段拼接还原原文');
  truthy(!!node.querySelector('.sg[data-term="T1"]'), '术语被标记', '缺少 data-term');
  truthy(!!node.querySelector('.sg[data-ann~="a1"]'), '高亮批注被标记', '缺少 data-ann');
  truthy(!!node.querySelector('.note-end'), '有内容的批注出现圆点标记', '缺少 note-end');
  const hl = node.querySelector('.sg[data-hl="on"]');
  truthy(!!hl && !!hl.style.getPropertyValue('--hl'), '高亮颜色写入 CSS 变量', '缺少 --hl');
  host.remove();
});

await t('paintBlock：关闭术语高亮时不生成片段', () => {
  const host = document.createElement('div'); document.body.append(host);
  const block = { id: 'b2', t: 'p', x: '测试文本内容' };
  const node = createBlockEl(block); host.append(node);
  paintBlock(node, block, [], [{ id: 'T', name: '测试' }], { autoTermHighlight: false, minTermLen: 2 });
  eq(node.querySelectorAll('.sg').length, 0, '没有生成任何片段');
  eq(node.textContent, '测试文本内容', '文本原样输出');
  host.remove();
});

/* ---------------- 4. 数据库 ---------------- */
group('IndexedDB 持久化');

await t('写入 → 读取 → 索引查询 → 级联删除', async () => {
  await db.openDB();
  await db.put('books', { id: 'testbk', title: '测试书', annCount: 0 });
  await db.putMany('chapters', [{ id: 'testbk#0', bookId: 'testbk', order: 0, title: '第一章', blocks: [] }]);
  await db.putMany('annotations', [
    { id: 'an1', bookId: 'testbk', chapterId: 'testbk#0', blockId: 'x', start: 0, end: 2, quote: '测试' },
    { id: 'an2', bookId: 'testbk', chapterId: 'testbk#0', blockId: 'x', start: 3, end: 5, quote: '批注' },
  ]);
  eq((await db.get('books', 'testbk')).title, '测试书', '按主键读取');
  eq((await db.getAllBy('annotations', 'bookId', 'testbk')).length, 2, '按索引查出 2 条批注');
  eq(await db.count('annotations'), 2, '总数正确');
  await db.deleteBookCascade('testbk');
  eq(await db.get('books', 'testbk'), undefined, '书已删除');
  eq((await db.getAllBy('annotations', 'bookId', 'testbk')).length, 0, '关联批注一并删除');
  eq((await db.getAllBy('chapters', 'bookId', 'testbk')).length, 0, '关联章节一并删除');
});

/* ---------------- 5. 状态中枢 ---------------- */
group('状态中枢');

await t('建立书籍 → 打开 → 写批注 → 建术语 → 收笔记 → 导出', async () => {
  if (!store.ready) await store.init();
  const parsed = {
    title: '中枢测试书', author: '测试', format: 'TXT',
    chapters: [
      { title: '第一章', level: 1, blocks: [{ t: 'p', x: '第一段文字内容。' }, { t: 'p', x: '第二段文字内容。' }] },
      { title: '第二章', level: 1, blocks: [{ t: 'p', x: '第二章的文字。' }] },
    ],
  };
  const book = await store.addBook(parsed, null);
  eq(store.state.books.some(b => b.id === book.id), true, '书籍进入书库');

  await store.openBook(book.id);
  eq(store.state.chapters.length, 2, '加载到 2 章');
  eq(store.state.chapter.blocks.length, 2, '当前章有 2 个块');
  truthy(store.state.chapter.blocks[0].id.includes(book.id), '块 ID 稳定可寻址', '块 ID 异常');

  const [ann] = await store.addAnnotations([{
    bookId: book.id, chapterId: store.state.chapter.id, blockId: store.state.chapter.blocks[0].id,
    blockIndex: 0, start: 0, end: 4, quote: '第一段文字', kind: 'hl', color: '#ffdf7e',
  }]);
  eq(store.state.anns.length, 1, '批注进入内存');
  eq((await db.getAllBy('annotations', 'bookId', book.id)).length, 1, '批注已落盘');
  eq((await db.get('books', book.id)).annCount, 1, '书籍批注数已更新');

  await store.saveAnnotation({ id: ann.id, note: '这是我的理解' });
  eq((await db.get('annotations', ann.id)).note, '这是我的理解', '批注内容实时保存');

  const term = await store.saveTerm({ name: '测试术语', definition: '用于自检', bookId: book.id });
  eq(store.termsFor(book.id).length, 1, '本书术语生效');
  eq(store.termsFor('不存在的书').length, 0, '本书术语不外泄到其他书');
  const gt = await store.saveTerm({ name: '全局术语', bookId: null });
  eq(store.termsFor('任意书').some(x => x.id === gt.id), true, '全局术语对所有书可见');

  const notes = await store.collectAnnotations([ann.id]);
  eq(notes.length, 1, '批注可收进笔记工作台');
  eq(store.state.notes[0].quote, '第一段文字', '引文被带入笔记');
  eq((await db.getAll('notes')).length, 1, '笔记已落盘');

  const backup = await db.exportAll();
  truthy(Array.isArray(backup.data.books) && backup.data.books.length >= 1, '备份包含书籍数据', '备份为空');

  await store.removeAnnotation(ann.id);
  eq(store.state.anns.length, 0, '删除批注生效');
  for (const n of store.state.notes.filter(x => x.bookId === book.id)) await store.removeNote(n.id);
  await store.deleteBook(book.id);
  await store.removeTerm(term.id);
  await store.removeTerm(gt.id);
  eq(store.state.books.some(b => b.id === book.id), false, '测试数据清理完成');
});

/* ---------------- 输出 ---------------- */
document.getElementById('results').innerHTML = out.join('');
const summary = document.getElementById('summary');
summary.textContent = `PASS ${pass} / FAIL ${fail}`;
summary.style.color = fail ? '#ff8f7a' : '#7fd6a0';
document.title = `SELFTEST PASS=${pass} FAIL=${fail}`;
window.__selftestResult = { pass, fail, lines: out.map(l => l.replace(/<[^>]+>/g, '')) };
