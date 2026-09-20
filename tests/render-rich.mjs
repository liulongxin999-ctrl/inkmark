/* 富内容渲染验证：
   1) 公式渲染成真正的数学排版（而不是 LaTeX 源码）
   2) 公式仍是"逻辑文本"的一部分：跨公式划选、批注的锚点与原文完全一致
   3) 导入 zip（md + images）后，插图渲染成真正的图片
   4) 刷新后公式与图片依然正常（图片存在本地） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { sweepTestBackups } from './_cleanup.mjs';
import { PNG_W, PNG_H, richZipExpression } from './_fixtures.mjs';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8789, CDP = 9329;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (typeof WebSocket === 'undefined') {
  console.error(`✗ 本测试需要 Node.js 22+（自带 WebSocket），当前 ${process.version}`);
  process.exit(2);
}

const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-rich-'));
let proc = null;
sweepTestBackups();

const backupDir = path.join(root, 'backups');
const preexisting = (() => { try { return fs.readdirSync(backupDir); } catch { return []; } })();
const finish = async code => {
  try { server.kill(); } catch {}
  try { proc?.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  try { for (const f of fs.readdirSync(backupDir)) if (!preexisting.includes(f)) fs.unlinkSync(path.join(backupDir, f)); } catch {}
  sweepTestBackups();
  process.exit(code);
};

async function waitFor(fn, tries = 80, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}

for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await sleep(150); }

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) { console.error('✗ 未找到浏览器'); await finish(2); }

proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  `--remote-debugging-port=${CDP}`, 'about:blank',
], { stdio: 'ignore' });

if (!await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(), 60, 200)) {
  console.error('✗ 浏览器未就绪'); await finish(2);
}
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (ex, aw = false) => {
  const r = await send('Runtime.evaluate', { expression: ex, awaitPromise: aw, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await waitFor(async () => await ev('!!window.__inkReady'), 60, 250);

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

/* ---------- 1. 在页面里造 zip 并导入 ---------- */
await ev(richZipExpression(), true);

const cards = await waitFor(async () => { const n = await ev("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; }, 80, 250);
step('导入 zip（Markdown + 插图）成功', cards > 0, `书卡 ${cards}`);

await ev("document.querySelector('.book-card').click()");
await waitFor(async () => { const n = await ev("document.querySelectorAll('#reader-body .blk').length"); return n >= 4 ? n : 0; });
await sleep(600);

/* ---------- 2. 公式渲染 ---------- */
const mathAtoms = await ev("document.querySelectorAll('#reader-body .math-atom').length");
step('公式被识别为原子单元', mathAtoms >= 2, `${mathAtoms} 个（本章共 2 处公式）`);
const katexNodes = await ev("document.querySelectorAll('#reader-body .math-atom .katex').length");
step('公式渲染成真正的数学排版（KaTeX 节点已生成）', katexNodes >= 2, `katex 节点 ${katexNodes}`);
const rawLatexVisible = await ev("document.querySelector('#reader-body').textContent.includes('\\\\frac') || document.querySelector('#reader-body').textContent.includes('\\\\\\\\frac')");
step('正文里不再出现 LaTeX 源码', rawLatexVisible === false);
step('行内公式与独立公式都被识别',
  (await ev("document.querySelectorAll('#reader-body .math-atom.math-display').length")) >= 1,
  `独立公式 ${await ev("document.querySelectorAll('#reader-body .math-atom.math-display').length")} 个`);
step('公式保留了原始 LaTeX 源码（供锚点与复制使用）',
  /\\frac\{L\}\{R\}/.test(await ev("document.querySelector('#reader-body .math-atom').dataset.src")));

/* ---------- 3. 图片渲染 ---------- */
const diag = await ev(`(async () => {
  const st = window.__ink.store.state;
  const rows = await window.__ink.db.getAllBy('assets', 'bookId', st.bookId).catch(e => 'ERR:' + e.message);
  return {
    assetCount: st.books[0] ? st.books[0].assetCount : null,
    stored: Array.isArray(rows) ? rows.map(r => r.path + ':' + (r.blob ? r.blob.size : 'noblob') + ':' + (r.blob ? r.blob.type : '')) : String(rows),
    missing: [...document.querySelectorAll('.img-missing')].map(e => e.textContent.slice(0, 40)),
    imgSrc: (document.querySelector('.block-image img') || {}).getAttribute ? document.querySelector('.block-image img').getAttribute('src') : null,
    blockSrc: [...document.querySelectorAll('.blk.img')].map(b => b.querySelector('img')?.dataset.asset),
  };
})()`, true);
step('诊断：图片资源已存入本地', diag.assetCount > 0 && Array.isArray(diag.stored), JSON.stringify(diag).slice(0, 260));

const imgInfo = await waitFor(async () => {
  const v = await ev(`(() => { const i = document.querySelector('#reader-body .block-image img');
    return i && i.getAttribute('src') ? { src: i.getAttribute('src').slice(0, 5), w: i.naturalWidth, h: i.naturalHeight } : null; })()`);
  return v && v.w > 0 ? v : null;
}, 40, 250);
step('插图渲染成真正的图片并加载成功', !!imgInfo && imgInfo.src === 'blob:',
  imgInfo ? `${imgInfo.src}… ${imgInfo.w}×${imgInfo.h}` : '未加载');
step('图片尺寸与源文件一致', imgInfo?.w === PNG_W && imgInfo?.h === PNG_H, `期望 ${PNG_W}×${PNG_H}`);
step('图片有图注', (await ev("document.querySelector('#reader-body .block-image figcaption')?.textContent || ''")).includes('分组交换示意图'));
step('正文里不再出现〔图片〕占位符', (await ev("document.querySelector('#reader-body').textContent.includes('〔图片〕')")) === false);

/* ---------- 4. 跨公式划选与批注（逻辑偏移是否准确） ---------- */
const quoted = await ev(`(() => {
  const blk = [...document.querySelectorAll('#reader-body .blk')].find(b => (b.dataset.src || '').includes('\\\\frac{L}{R}'));
  if (!blk) return 'NO_BLOCK';
  const r = document.createRange();
  r.setStart(blk, 0);
  r.setEnd(blk, blk.childNodes.length);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.querySelector('#reader-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return blk.dataset.src;
})()`);
step('找到含公式的段落', quoted !== 'NO_BLOCK' && quoted.includes('\\frac{L}{R}'));

await waitFor(async () => await ev("!document.querySelector('#sel-toolbar').hidden"), 30, 200);
await ev(`[...document.querySelectorAll('#sel-toolbar [data-act="hl"]')][0].click()`);
const ann = await waitFor(async () => {
  const a = await ev('JSON.stringify(window.__ink.store.state.anns[0] || null)');
  return a && a !== 'null' ? JSON.parse(a) : null;
}, 40, 250);
step('可以跨公式创建批注', !!ann);
step('批注锚点里保存的是 LaTeX 原文（说明偏移映射正确）',
  !!ann && ann.quote.includes('\\frac{L}{R}') && ann.quote.includes('发送时延'),
  ann ? ann.quote.slice(0, 46) + '…' : '');
step('批注长度与逻辑文本一致',
  !!ann && ann.quote.length === quoted.length,
  ann ? `${ann.quote.length} / ${quoted.length}` : '');

/* ---------- 5. 刷新后仍然正常（图片来自本地存储） ---------- */
await send('Page.navigate', { url: `http://localhost:${PORT}/` });
await waitFor(async () => await ev('!!window.__inkReady'), 60, 250);
await ev("document.querySelector('.book-card').click()");
await waitFor(async () => { const n = await ev("document.querySelectorAll('#reader-body .blk').length"); return n >= 4 ? n : 0; });
const afterReload = await waitFor(async () => {
  const v = await ev(`(() => ({ math: document.querySelectorAll('#reader-body .math-atom .katex').length,
    img: (document.querySelector('#reader-body .block-image img') || {}).naturalWidth || 0 }))()`);
  return v && v.math >= 2 && v.img > 0 ? v : null;
}, 40, 250);
step('刷新后公式与插图依然正常', !!afterReload, afterReload ? `公式 ${afterReload.math} · 图片 ${afterReload.img}px` : '未就绪');
step('批注在刷新后仍存在', (await ev('window.__ink.store.state.anns.length')) >= 1);
step('批注在正文里正确画在公式段落上',
  (await ev("document.querySelectorAll('#reader-body .math-atom[data-ann]').length")) >= 1);

ws.close();

const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n公式与插图渲染验证\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
if (errors.length) { console.log(`\n${C.fail}页面控制台错误：${C.reset}`); for (const e of errors.slice(0, 5)) console.log('  ' + e.slice(0, 160)); }
console.log(`\n${failed || errors.length ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed || errors.length ? 1 : 0);
await ev(richZipExpression(), true);
