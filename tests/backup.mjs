/* 磁盘备份与灾难恢复验证：
   1) 有数据时自动写出备份文件到 backups/
   2) 换成"全新浏览器"（等价于换网址 / 清数据）后，书库为空 → 一键恢复 → 数据回来 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8794, CDP = 9332;
const BACKUP_DIR = path.join(root, 'backups');
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error(`✗ 本测试需要 Node.js 22+（自带 WebSocket），当前 ${process.version}`);
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

/* 记录测试前已有的备份文件，结束时清理本次新增的 */
const before = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
let proc = null;
const profiles = [];

const finish = async code => {
  try { server.kill(); } catch {}
  try { proc?.kill(); } catch {}
  await sleep(400);
  for (const p of profiles) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  try {
    for (const f of fs.readdirSync(BACKUP_DIR)) if (!before.includes(f)) fs.unlinkSync(path.join(BACKUP_DIR, f));
    if (!fs.existsSync(BACKUP_DIR)) { /* 无目录则无需处理 */ }
  } catch {}
  process.exit(code);
};

async function waitFor(fn, tries = 100, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
const cdpAlive = async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { return false; } };

/** 每次调用都用一个新的浏览器配置目录 = 一台"干净的浏览器" */
async function openSession() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-bk-'));
  profiles.push(profile);
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

  const connect = async wsUrl => {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const rpc = (method, params = {}) => new Promise(res => {
      const id = ++seq;
      const onMsg = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); res(m.result); } };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
    return { rpc, close: () => { try { ws.close(); } catch {} } };
  };

  const pageC = await connect(page.webSocketDebuggerUrl);
  const browserC = await connect(ver.webSocketDebuggerUrl);
  const send = pageC.rpc;

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  if (!await waitFor(async () => (await send('Runtime.evaluate', { expression: '!!window.__inkReady', returnByValue: true }))?.result?.value, 60, 250)) {
    throw new Error('应用未启动');
  }

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };

  return {
    evalJs, send,
    async importBook(filePath) {
      const doc = await send('DOM.getDocument', { depth: -1 });
      const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#view-library input[type=file]' });
      await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
      return waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; }, 80, 250);
    },
    async close() {
      try { await browserC.rpc('Browser.close'); } catch {}
      await waitFor(async () => !(await cdpAlive()), 50, 150);
      await sleep(700);
      pageC.close(); browserC.close();
    },
  };
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

await waitFor(async () => { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } });

/* ===== 1. 写入数据并落盘备份 ===== */
let s = await openSession();
step('首次打开书库为空', (await s.evalJs('window.__ink.store.state.books.length')) === 0);
step('上传书籍成功', (await s.importBook(path.join(root, '示例', '示例书-认知科学导论.txt'))) > 0);
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'working', title: '备份验证', body: '这条笔记应该能从磁盘备份里恢复。' })", true);
await sleep(500);

const flushed = await s.evalJs("window.__ink.flush('测试备份', { force: true })", true);
step('可以主动写出磁盘备份', flushed === true, String(flushed));
const files = (() => { try { return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')); } catch { return []; } })();
step('备份文件已生成在 backups/ 目录', files.length > 0, `${files.length} 个文件`);

const saved = (() => {
  try {
    const latest = files.map(f => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, latest.f), 'utf8'));
  } catch { return null; }
})();
step('备份内容包含书 / 笔记 / 来源地址',
  !!saved && saved.app === 'inkmark' && saved.data.books.length === 1 && saved.data.notes.length === 1 && !!saved.origin,
  saved ? `书 ${saved.data.books.length} · 笔记 ${saved.data.notes.length} · 来自 ${saved.origin}` : '解析失败');

await s.close();

/* ===== 2. 换一台"干净浏览器"（等价于换网址/清数据）→ 一键恢复 ===== */
s = await openSession();
const emptyBooks = await s.evalJs('window.__ink.store.state.books.length');
step('全新浏览器下书库确实为空（复现你遇到的问题）', emptyBooks === 0, `书 ${emptyBooks} 本`);

const bannerShown = await waitFor(async () => await s.evalJs("!!document.querySelector('#view-library .card .btn.primary')"), 40, 250);
step('自动提示"发现磁盘备份，是否恢复"', !!bannerShown);

const backupInfo = await s.evalJs("window.__ink.backup.supported && window.__ink.backup.count");
step('页面能读到磁盘备份列表', backupInfo > 0, `${backupInfo} 份`);

await s.evalJs("document.querySelector('#view-library .card .btn.primary').click()");
await waitFor(async () => await s.evalJs("!!document.querySelector('#modal-root .modal')"), 30, 200);
await s.evalJs("document.querySelector('#modal-root .modal-foot .btn.primary').click()");

const restored = await waitFor(async () => {
  const n = await s.evalJs('window.__ink.store.state.books.length');
  return n > 0 ? n : 0;
}, 60, 300);
step('一键恢复后书籍回来了', restored === 1, `书 ${restored} 本`);
step('恢复后笔记也回来了', (await s.evalJs("window.__ink.store.state.notes.length")) === 1);
step('恢复后书名正确', (await s.evalJs('window.__ink.store.state.books[0].title')) === '示例书-认知科学导论');

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n磁盘备份与灾难恢复验证\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed ? 1 : 0);
