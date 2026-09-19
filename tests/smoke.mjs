/* 端到端冒烟测试：真实上传 → 阅读 → 划选批注 → 术语 → 笔记工作台 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8797, CDP = 9335;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) { console.error('✗ 未找到浏览器'); process.exit(2); }

/* 准备一本真实存在的测试书 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-book-'));
const bookPath = path.join(dir, '认知科学导论.txt');
fs.writeFileSync(bookPath, [
  '第一章 记忆的机制', '',
  '工作记忆是认知活动的临时工作台，容量有限。', '',
  '长时记忆则负责长期储存，通过复述与编码得以巩固。', '',
  '第二章 注意与加工', '',
  '选择性注意决定哪些信息能进入工作记忆。', '',
  '自动化加工几乎不占用注意资源。', '',
].join('\n'), 'utf8');

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
let proc = null;
const finish = async code => { try { server.kill(); } catch {} try { proc?.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); };

async function waitFor(fn, tries = 100, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
await waitFor(async () => (await fetch(`http://localhost:${PORT}/`)).ok);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-smoke-'));
proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  `--remote-debugging-port=${CDP}`, 'about:blank',
], { stdio: 'ignore' });
if (!await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json())) { console.error('✗ 浏览器未就绪'); await finish(2); }

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });

let id = 0; const pending = new Map(); const errors = [];
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
};
await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');

const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};

const steps = [];
const step = (name, ok, extra = '') => { steps.push({ name, ok, extra }); };

await send('Page.navigate', { url: `http://localhost:${PORT}/` });
step('应用加载完成', await waitFor(async () => await evalJs('!!window.__inkReady')));

/* 1. 通过真实文件输入上传 */
const doc = await send('DOM.getDocument', { depth: -1 });
const inputNode = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#view-library input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [bookPath] });
const cardCount = await waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; }, 80, 250);
step('上传 TXT 后书库出现书籍卡片', cardCount > 0, `卡片数 ${cardCount}`);

/* 2. 打开书籍进入阅读 */
await evalJs("document.querySelector('.book-card').click()");
const blockCount = await waitFor(async () => { const n = await evalJs("document.querySelectorAll('#reader-body .blk').length"); return n >= 2 ? n : 0; });
step('进入阅读器并渲染正文块', blockCount >= 2, `正文块 ${blockCount}`);
step('章节标题正确渲染', (await evalJs("document.querySelector('.chapter-head h1').textContent")) === '第一章 记忆的机制');

/* 3. 模拟真实划选 → 工具条 → 高亮 */
await evalJs(`(() => {
  const blk = [...document.querySelectorAll('#reader-body .blk')].find(b => b.textContent.includes('工作记忆'));
  const node = [...blk.childNodes].find(n => n.nodeType === 3);
  const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 8);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.querySelector('#reader-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
})()`);
step('划选文字后浮出工具条', await waitFor(async () => await evalJs("!document.querySelector('#sel-toolbar').hidden")));
const annBefore = await evalJs('window.__ink.store.state.anns.length');
await evalJs("[...document.querySelectorAll('#sel-toolbar [data-act=\"hl\"]')][0].click()");
const annAfter = await waitFor(async () => { const n = await evalJs('window.__ink.store.state.anns.length'); return n > annBefore ? n : 0; });
step('点击高亮按钮生成批注', annAfter > annBefore, `批注数 ${annAfter}`);
step('批注锚点与所选文字一致', (await evalJs("window.__ink.store.state.anns[0].quote")) === '工作记忆是认知活', await evalJs("window.__ink.store.state.anns[0].quote"));
step('正文出现高亮片段', (await evalJs("document.querySelectorAll('#reader-body .sg[data-hl=\"on\"]').length")) > 0);

/* 4. 侧栏批注编辑（实时保存） */
await evalJs("window.__ink.store.openAside('ann', { focusAnnId: window.__ink.store.state.anns[0].id })");
step('侧栏打开并显示批注卡', await waitFor(async () => await evalJs("!!document.querySelector('#aside [data-ann-id] .card-body')")));
await evalJs(`(() => {
  const el = document.querySelector('#aside [data-ann-id] .card-body');
  el.textContent = '工作记忆容量有限，约 4 个组块。';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(700);
const savedNote = await evalJs('(async () => (await window.__ink.db.get("annotations", window.__ink.store.state.anns[0].id)).note)()', true);
step('侧栏修改批注后实时落盘', savedNote === '工作记忆容量有限，约 4 个组块。', String(savedNote));
step('正文同步出现批注圆点', (await evalJs("document.querySelectorAll('#reader-body .note-end').length")) > 0);

/* 5. 建立术语 → 全书自动高亮 → 悬停气泡 */
await evalJs("window.__ink.store.saveTerm({ name: '工作记忆', definition: '容量有限的临时加工系统', color: '#2f5d7c' }).then(()=>window.__ink.store.openAside('term'))", true);
const termSegs = await waitFor(async () => { const n = await evalJs("document.querySelectorAll('#reader-body .sg[data-term]').length"); return n > 0 ? n : 0; });
step('建立术语后本章自动高亮该词', termSegs >= 1, `本章命中 ${termSegs} 处`);
await evalJs(`(() => { const s = document.querySelector('#reader-body .sg[data-term]'); s.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
step('悬停术语弹出解释气泡', await waitFor(async () => await evalJs("!document.querySelector('#hover-card').hidden"), 40, 100));
step('气泡内容包含术语定义', (await evalJs("document.querySelector('#hover-card').textContent")).includes('容量有限的临时加工系统'));
await evalJs("window.__ink.store.loadChapter(1)", true);
const otherChapterHits = await waitFor(async () => { const n = await evalJs("document.querySelectorAll('#reader-body .sg[data-term]').length"); return n > 0 ? n : 0; });
step('术语在其他章节同样自动高亮（全书生效）', otherChapterHits >= 1, `第二章命中 ${otherChapterHits} 处`);

/* 6. 其他视图 */
await evalJs("window.__ink.store.go('notes')");
await evalJs("window.__ink.store.collectAnnotations([window.__ink.store.state.anns[0].id])", true);
step('批注可收进笔记工作台', (await waitFor(async () => await evalJs("document.querySelectorAll('#view-notes .note-card').length"))) >= 1);
step('笔记工作台渲染看板四列', (await evalJs("document.querySelectorAll('#view-notes .board-col').length")) === 4);
await evalJs("window.__ink.store.go('review')");
step('复习页正常渲染', (await evalJs("!!document.querySelector('#view-review .review-card')")));
await evalJs("window.__ink.store.go('settings')");
step('设置页正常渲染', (await evalJs("!!document.querySelector('#view-settings .set-panel')")));
await evalJs("window.__ink.store.go('library')");
step('返回书库显示统计', (await evalJs("document.querySelector('#view-library .page-head h1').textContent")) === '我的书库');

/* 7. 刷新后数据仍在 */
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await waitFor(async () => await evalJs('!!window.__inkReady'));
const persisted = await waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; });
step('刷新页面后数据持久化', persisted > 0, `书籍 ${persisted} 本`);
const annPersisted = await evalJs('window.__ink.store.state.books[0].annCount');
step('批注数量随书籍持久化', annPersisted >= 1, `annCount=${annPersisted}`);

ws.close(); try { proc.kill(); } catch {} await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}

const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n端到端冒烟测试\n');
let failed = 0;
for (const s of steps) {
  if (!s.ok) failed++;
  console.log(`${s.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${s.name}${s.extra ? `${C.dim}  (${s.extra})${C.reset}` : ''}`);
}
if (errors.length) { console.log(`\n${C.fail}页面控制台错误：${C.reset}`); for (const e of errors) console.log('  ' + e); }
console.log(`\n${failed || errors.length ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed || errors.length ? 1 : 0);
