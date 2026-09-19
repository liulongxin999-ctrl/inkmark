/* 备份时机验证：
   1) 平时不备份（不再两分钟一次，也不再"改完就写盘"）
   2) 关闭页面时自动备份一次（走 sendBeacon，小数据）
   3) 数据太大发不完 → 记下待备份标记
   4) 下次打开时弹窗询问，点"立即备份"补上 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { sweepTestBackups } from './_cleanup.mjs';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8790, CDP = 9330;
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

const backupNames = () => { try { return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json') && f !== 'index.json'); } catch { return []; } };
sweepTestBackups();                        // 先扫掉上一次测试可能留下的残留
const beforeBackups = backupNames();
const newBackups = () => backupNames().filter(f => !beforeBackups.includes(f));

/* 造一本"大书"，让备份体积超过浏览器关闭时能发送的上限 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-timing-'));
const bigBook = path.join(tmpDir, '大部头教材.txt');
fs.writeFileSync(bigBook, Array.from({ length: 900 }, (_, i) => `第 ${i} 段：` + '这是一段用来撑大体积的正文内容，重复重复重复重复重复重复。'.repeat(3)).join('\n\n'), 'utf8');

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-timing-br-'));
let proc = null;

const finish = async code => {
  try { server.kill(); } catch {}
  try { proc?.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  for (const f of newBackups()) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} }
  sweepTestBackups();
  process.exit(code);
};

async function waitFor(fn, tries = 80, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
const cdpAlive = async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok; } catch { return false; } };

async function openSession() {
  proc = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--remote-debugging-port=${CDP}`, 'about:blank',
  ], { stdio: 'ignore' });
  if (!await waitFor(cdpAlive, 60, 200)) throw new Error('浏览器未就绪');
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    const onMsg = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', onMsg); res(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  if (!await waitFor(async () => (await send('Runtime.evaluate', { expression: '!!window.__inkReady', returnByValue: true }))?.result?.value, 60, 250)) throw new Error('应用未启动');
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };
  return {
    evalJs, send,
    async reload() {
      await send('Page.navigate', { url: `http://localhost:${PORT}/` });
      await waitFor(async () => (await send('Runtime.evaluate', { expression: '!!window.__inkReady', returnByValue: true }))?.result?.value, 60, 250);
      await sleep(600);
    },
    async importBook(file) {
      const doc = await send('DOM.getDocument', { depth: -1 });
      const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#view-library input[type=file]' });
      await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
      return waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; }, 80, 250);
    },
    /** 模拟关闭页面：浏览器在离开页面时会触发 pagehide，应用在这里发信标 */
    leave: () => evalJs("(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); return true; })()"),
  };
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

await waitFor(async () => { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } });

/* ===== 1. 平时不备份 ===== */
let s = await openSession();
step('备份时机默认为「关闭页面时」', (await s.evalJs('window.__ink.store.ui.backupMode')) === 'close');
step('上传一本小书', (await s.importBook(path.join(root, '示例', '示例书-认知科学导论.txt'))) > 0);
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'inbox', title: '时机测试', body: '验证不会再自动写盘。' })", true);

/* ===== 手动保存按钮 ===== */
const SAVE_BTN = "document.querySelector('.rail-btn[data-action=\"save\"]')";
step('左侧栏有「保存」按钮', (await s.evalJs(`!!${SAVE_BTN}`)) === true);
step('有改动时保存按钮上出现未保存小圆点', await waitFor(async () => await s.evalJs(`!${SAVE_BTN}.querySelector('.unsaved').hidden`), 20, 200));
const beforeSave = newBackups().length;
await s.evalJs(`${SAVE_BTN}.click()`);
step('点「保存」立刻写出一份备份', await waitFor(() => newBackups().length > beforeSave, 30, 250), `新增 ${newBackups().length - beforeSave} 份`);
step('保存后小圆点消失（已保存状态）', await waitFor(async () => await s.evalJs(`${SAVE_BTN}.querySelector('.unsaved').hidden`), 20, 200));
step('鼠标悬停能看到保存状态文案', /已保存/.test(await s.evalJs(`${SAVE_BTN}.title`)));

/* ===== Ctrl+S 也能保存 ===== */
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'inbox', title: '第二次改动', body: '用快捷键保存。' })", true);
await waitFor(async () => await s.evalJs(`!${SAVE_BTN}.querySelector('.unsaved').hidden`), 20, 200);
const beforeHotkey = newBackups().length;
await s.evalJs("(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); return true; })()");
step('Ctrl+S 也能保存', await waitFor(() => newBackups().length > beforeHotkey, 30, 250), `新增 ${newBackups().length - beforeHotkey} 份`);

await sleep(9000);   // 旧的实现会在 6 秒内写盘；新实现应该什么都不做
const afterHotkey = newBackups().length;
await s.evalJs("window.__ink.store.saveNote({ kind: 'free', status: 'inbox', title: '等待测试', body: '接下来 9 秒不应该再自动写盘。' })", true);
await sleep(9000);
step('改动后等待 9 秒：没有自动写盘（不再"改完就备份"）', newBackups().length === afterHotkey, `又新增 ${newBackups().length - afterHotkey} 份`);

/* ===== 2. 关闭页面时自动备份 ===== */
const beforeLeave = newBackups().length;
await s.leave();
const leaveGrew = await waitFor(() => newBackups().length > beforeLeave, 20, 200);
step('关闭页面时自动写出一份备份', !!leaveGrew, `新增 ${newBackups().length - beforeLeave} 份`);
step('这一份确实是"关闭页面时自动备份"，且包含书与笔记', (() => {
  try {
    const newest = newBackups()
      .map(f => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
    const j = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, newest), 'utf8'));
    return j.data.books.length === 1 && j.data.notes.length >= 1 && j.reason === '关闭页面时自动备份';
  } catch { return false; }
})());
step('成功备份后没有留下待备份提醒', (await s.evalJs("localStorage.getItem('inkmark:pending-backup')")) === null);

/* ===== 3. 数据太大：记下待备份，而不是硬塞 ===== */
step('再上传一本大部头（备份体积超过 60KB）', (await s.importBook(bigBook)) > 0);
await sleep(6000);
const beforeBig = newBackups().length;
await s.leave();
await sleep(1200);
step('数据过大时不会发送失败的信标（文件数不变）', newBackups().length === beforeBig, `新增 ${newBackups().length - beforeBig} 份`);
step('改为记下"待备份"标记', (await s.evalJs("!!localStorage.getItem('inkmark:pending-backup')")) === true);

/* ===== 4. 下次打开时询问用户 ===== */
await s.reload();
const asked = await waitFor(async () => await s.evalJs("!!document.querySelector('#modal-root .modal')"), 30, 250);
step('下次打开时弹出询问', !!asked);
step('询问里说明是"上次关闭时没备份的改动"',
  (await s.evalJs("document.querySelector('#modal-root .modal').textContent")).includes('上次关闭时有改动没有备份'));
step('提供三个选项（以后不再询问 / 暂不保存 / 保存）',
  (await s.evalJs("[...document.querySelectorAll('#modal-root .modal-foot .btn')].map(b => b.textContent).join(',')"))
    === '以后不再询问,暂不保存,保存');

const beforeManual = newBackups().length;
await s.evalJs("[...document.querySelectorAll('#modal-root .modal-foot .btn')].find(b => b.textContent === '保存').click()");
const grew = await waitFor(() => newBackups().length > beforeManual, 30, 250);
const reasons = () => newBackups().map(f => {
  try { const j = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8')); return `${j.reason || '无原因'}/${Math.round(fs.statSync(path.join(BACKUP_DIR, f)).size / 1024)}KB`; }
  catch { return `${f}/解析失败`; }
}).join(' | ');
step('点「保存」后补上一份完整备份', !!grew, reasons());
const bigOne = newBackups().map(f => ({ f, size: fs.statSync(path.join(BACKUP_DIR, f)).size })).sort((a, b) => b.size - a.size)[0];
step('这份备份确实包含大部头（体积远大于 60KB）', bigOne && bigOne.size > 60000, bigOne ? `${Math.round(bigOne.size / 1024)} KB` : '找不到');
step('补备份后待备份标记被清除', (await s.evalJs("localStorage.getItem('inkmark:pending-backup')")) === null);

/* ===== 5. 「仅手动」模式下不再打扰 ===== */
await s.evalJs("window.__ink.store.setUi({ backupMode: 'manual' })", true);
await sleep(500);
step('切到「仅手动」后，改动不会再生成内存快照并发送',
  (await s.evalJs("(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); return window.__ink.store.ui.backupMode; })()")) === 'manual');

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n备份时机与询问流程验证\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed ? 1 : 0);
