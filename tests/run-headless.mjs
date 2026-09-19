/* 无头浏览器运行自检（CDP 驱动，可捕获控制台错误）：node tests/run-headless.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8799, CDP = 9333;

if (typeof WebSocket === 'undefined') {
  console.error(`✗ 本测试需要 Node.js 22 或更高版本（自带 WebSocket），当前为 ${process.version}`);
  process.exit(2);
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium-browser', '/snap/bin/chromium',
];
const browser = CANDIDATES.find(p => fs.existsSync(p));
if (!browser) { console.error('✗ 未找到 Edge / Chrome，无法运行浏览器自检'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
let proc = null;

async function waitFor(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
const finish = async code => { try { server.kill(); } catch {} try { proc?.kill(); } catch {} process.exit(code); };

const ready = await waitFor(async () => (await fetch(`http://localhost:${PORT}/tests/selftest.html`)).ok);
if (!ready) { console.error('✗ 本地服务未启动'); await finish(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-test-'));
proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', `--user-data-dir=${profile}`,
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  `--remote-debugging-port=${CDP}`, 'about:blank',
], { stdio: 'ignore' });

const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json());
if (!version) { console.error('✗ 浏览器调试端口未就绪'); fs.rmSync(profile, { recursive: true, force: true }); await finish(2); }

const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('✗ 没有可用的页面目标'); await finish(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push({ type: msg.params.type, text: msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ') });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push({ type: 'error', text: `${d.exception?.description || d.text} @${d.url || ''}:${d.lineNumber ?? ''}` });
  }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:${PORT}/tests/selftest.html` });

const result = await waitFor(async () => {
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__selftestResult||null)', returnByValue: true });
  const v = r?.result?.value;
  return v && v !== 'null' ? JSON.parse(v) : null;
}, 200, 400);

ws.close();
try { proc.kill(); } catch {}
await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}

if (!result) {
  console.error('✗ 自检未在超时前完成，浏览器日志：');
  for (const l of logs) console.error(`  [${l.type}] ${l.text}`);
  await finish(2);
}

const C = { ok: '\u001b[32m', fail: '\u001b[31m', grp: '\u001b[90m', reset: '\u001b[0m' };
for (const line of result.lines) {
  if (line.startsWith('──')) console.log(`\n${C.grp}${line}${C.reset}`);
  else console.log(`${line.startsWith('✓') ? C.ok : C.fail}${line}${C.reset}`);
}
for (const l of logs) console.log(`\n${C.grp}[浏览器 ${l.type}] ${l.text}${C.reset}`);
console.log(`\n${result.fail ? C.fail : C.ok}PASS ${result.pass} / FAIL ${result.fail}${C.reset}`);
await finish(result.fail ? 1 : 0);
