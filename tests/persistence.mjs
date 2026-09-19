/* 存档验证：模拟"上传批注 → 关闭浏览器 → 下次重新打开"的真实场景
   用法：node tests/persistence.mjs
   三个阶段：正常关闭浏览器 → 强制杀进程 → 每次都复用同一个浏览器配置目录 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8795, CDP = 9331;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error(`✗ 本测试需要 Node.js 22 或更高版本（自带 WebSocket），当前为 ${process.version}`);
  process.exit(2);
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = CANDIDATES.find(p => fs.existsSync(p));
if (!browserPath) { console.error('✗ 未找到浏览器'); process.exit(2); }

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-persist-'));
let proc = null;

const finish = async code => {
  try { server.kill(); } catch {}
  try { proc?.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(code);
};

async function waitFor(fn, tries = 100, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
const cdpAlive = async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { return false; } };

/* ---------------- 打开一次浏览器会话 ---------------- */
async function openSession() {
  proc = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--remote-debugging-port=${CDP}`, 'about:blank',
  ], { stdio: 'ignore' });

  if (!await waitFor(cdpAlive, 60, 200)) throw new Error('浏览器未就绪');
  const ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find(t => t.type === 'page');

  const pageWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { pageWs.onopen = res; pageWs.onerror = rej; });
  const browserWs = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = rej; });

  let seq = 0;
  const rpc = ws => (method, params = {}) => new Promise(res => {
    const id = ++seq;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); res(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const send = rpc(pageWs);
  const sendBrowser = rpc(browserWs);

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  if (!await waitFor(async () => (await send('Runtime.evaluate', { expression: '!!window.__inkReady', returnByValue: true }))?.result?.value, 60, 250)) {
    throw new Error('应用未在预期时间内启动');
  }

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };

  return {
    send, evalJs,
    async importBook(filePath) {
      const doc = await send('DOM.getDocument', { depth: -1 });
      const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#view-library input[type=file]' });
      await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
      return waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; }, 80, 250);
    },
    async closeGracefully() {
      try { await sendBrowser('Browser.close'); } catch {}
      await waitFor(async () => !(await cdpAlive()), 50, 150);
      await sleep(800);
      try { pageWs.close(); browserWs.close(); } catch {}
    },
    async killHard() {
      try { proc.kill('SIGKILL'); } catch {}
      await waitFor(async () => !(await cdpAlive()), 50, 150);
      await sleep(800);
      try { pageWs.close(); browserWs.close(); } catch {}
    },
  };
}

const snapshot = s => s.evalJs(`(() => {
  const st = window.__ink.store.state;
  const b = st.books[0];
  return {
    origin: location.origin,
    books: st.books.length,
    title: b ? b.title : null,
    annCount: b ? (b.annCount || 0) : 0,
    anns: st.anns.length,
    annNote: st.anns[0] ? (st.anns[0].note || '') : '',
    term: (st.terms.find(t => t.name === '工作记忆') || {}).definition || '',
    notes: st.notes.length,
    chapters: st.chapters.length,
    renderedBlocks: document.querySelectorAll('#reader-body .blk').length,
  };
})()`);

/** 打开第一本书并等正文渲染完成（批注与章节数据只有在打开书本后才会载入内存） */
async function openBook(s) {
  await s.evalJs("document.querySelector('.book-card').click()");
  await waitFor(async () => {
    const n = await s.evalJs("document.querySelectorAll('#reader-body .blk').length");
    return n >= 2 ? n : 0;
  }, 60, 250);
  await sleep(200);
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

/* ---------------- 准备 ---------------- */
await waitFor(async () => { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } });

/* ===== 阶段 1：第一次使用，上传并批注 ===== */
let s = await openSession();
step('首次打开：书库为空', (await snapshot(s)).books === 0);
step('上传电子书成功', (await s.importBook(path.join(root, '示例', '示例书-认知科学导论.txt'))) > 0);

await s.evalJs("document.querySelector('.book-card').click()");
await waitFor(async () => { const n = await s.evalJs("document.querySelectorAll('#reader-body .blk').length"); return n >= 2 ? n : 0; });

/* 真实划选 → 写批注 */
await s.evalJs(`(() => {
  const blk = [...document.querySelectorAll('#reader-body .blk')].find(b => b.textContent.includes('组块是提升'));
  const node = [...blk.childNodes].find(n => n.nodeType === 3);
  const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 2);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.querySelector('#reader-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return true;
})()`);
await waitFor(async () => await s.evalJs("!document.querySelector('#sel-toolbar').hidden"));
await s.evalJs("[...document.querySelectorAll('#sel-toolbar [data-act=\"note\"]')][0].click()");
await waitFor(async () => await s.evalJs("!!document.querySelector('#aside .card-body')"));
await s.evalJs(`(() => {
  const el = document.querySelector('#aside .card-body');
  el.textContent = '组块是突破工作记忆容量的核心手段。';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/* 术语 + 笔记卡片 */
await s.evalJs("window.__ink.store.saveTerm({ name: '工作记忆', definition: '容量有限的临时加工系统', color: '#2f5d7c' })", true);
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'working', title: '复习计划', body: '每天 20 分钟，先回忆再看书。' })", true);
await sleep(900);

const before = await snapshot(s);
step('写入后数据齐全（书 / 批注 / 术语 / 笔记）',
  before.books === 1 && before.anns === 1 && before.annNote.length > 0 && before.term.length > 0 && before.notes === 1,
  `书 ${before.books} · 批注 ${before.anns} · 笔记 ${before.notes}`);

/* ===== 阶段 2：正常关闭浏览器，再打开 ===== */
await s.closeGracefully();
s = await openSession();
await openBook(s);
let after = await snapshot(s);
step('关闭浏览器后重新打开：书籍仍在', after.books === 1 && after.title === before.title, `书 ${after.books} · ${after.title}`);
step('批注与批注内容仍在', after.anns === 1 && after.annNote === before.annNote, `批注 ${after.anns} 条，内容「${after.annNote.slice(0, 12)}…」`);
step('术语定义仍在', after.term === before.term, after.term || '（丢失）');
step('笔记卡片仍在', after.notes === 1, `笔记 ${after.notes} 张`);
step('章节正文可从本地重新加载', after.chapters >= 3 && after.renderedBlocks >= 2, `章节 ${after.chapters} 个 / 正文 ${after.renderedBlocks} 块`);
step('书中批注计数一致', after.annCount === before.annCount, `${after.annCount} 条`);

/* ===== 阶段 3：强制杀进程（模拟强关/断电），再打开 ===== */
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'inbox', title: '第二次修改', body: '强关之前写入的内容。' })", true);
await sleep(900);
await s.killHard();
s = await openSession();
await openBook(s);
after = await snapshot(s);
step('强制关闭后：原有数据未损坏', after.books === 1 && after.anns === 1 && after.term === before.term, `书 ${after.books} · 批注 ${after.anns}`);
step('强制关闭前的最后一次写入也保住了', after.notes === 2, `笔记 ${after.notes} 张`);

const origin = (await snapshot(s)).origin;
step('三次会话使用同一个网址（同一个存储空间）', origin === `http://localhost:${PORT}`, origin);

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n存档（持久化）验证\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed ? 1 : 0);
