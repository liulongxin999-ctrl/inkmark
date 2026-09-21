/* AI 助手端到端回归：全程使用假 provider，不碰真实 DeepSeek API，
   也不碰项目里真实的 ai.local.json 和 backups/。

   两个隔离手段：
   1) INKMARK_AI_CONFIG 把配置指到临时目录
   2) 假 provider 跑在本机另一个端口上

   注意：假 Key 必须在运行时拼出来。这个文件本身会被防泄漏闸门扫描，
   写死字面量会把测试文件自己判为泄露（邮箱那次就是这么踩的）。 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const APP_PORT = 8791;        // 8789~8799 里没被别的测试占用的一个
const FAKE_PORT = 8798;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-ai-'));
const AI_CONFIG = path.join(WORK, 'ai.local.json');
const REAL_AI_CONFIG = path.join(root, 'ai.local.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 假 Key：运行时拼出来，源码里不出现完整形态 */
const TEST_KEY = ['sk', 'test', 'key', '0'.repeat(12)].join('-');

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });
const hits = [];

/* ---------- 假的 OpenAI 兼容服务商 ---------- */
function startFakeProvider() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
      hits.push({ url: req.url, auth: req.headers.authorization || '', body: parsed });
      if (parsed.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of ['这是', '流式', '回答', '。']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '这是普通回答。' } }] }));
      }
      res.end();
    });
  });
  return new Promise(r => srv.listen(FAKE_PORT, '127.0.0.1', () => r(srv)));
}

let fake = null;
let app = null;
const finish = async code => {
  try { fake?.close(); } catch {}
  try { app?.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  process.exit(code);
};

async function waitFor(fn, tries = 60, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}

/* ---------- 安全闸：绝不使用真实配置 ---------- */
if (path.resolve(AI_CONFIG) === path.resolve(REAL_AI_CONFIG)) {
  console.error('测试配置路径指向了真实 ai.local.json，已中止');
  process.exit(2);
}

fake = await startFakeProvider();
app = spawn(process.execPath, [path.join(root, 'server.mjs'), String(APP_PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, INKMARK_AI_CONFIG: AI_CONFIG },
});

const up = await waitFor(async () => {
  try { return (await fetch(`http://localhost:${APP_PORT}/__inkmark`)).ok; } catch { return false; }
});
step('测试服务器已启动', !!up, `端口 ${APP_PORT}`);
if (!up) await finish(2);

/* ---------- 后续任务的用例追加在这里 ---------- */

/* ---------- 配置读写 ---------- */
const H = { 'Content-Type': 'application/json', 'X-InkMark': '1' };

/** 安全地取 JSON：接口不存在时返回 body:null，不抛异常（失败要干净，不能崩） */
async function getJson(u, opts) {
  const r = await fetch(u, opts);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON，例如 404 的纯文本 */ }
  return { status: r.status, body };
}

// 必须带自定义头：/__ai/* 全部走 trusted() 校验，前端也是这么调的
const status0 = await getJson(`http://localhost:${APP_PORT}/__ai/status`, { headers: H });
step('未配置时 status 返回 configured:false',
  status0.body?.ok === true && status0.body?.configured === false, JSON.stringify(status0));

const saveRes = await getJson(`http://localhost:${APP_PORT}/__ai/config`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    provider: 'deepseek', baseUrl: `http://127.0.0.1:${FAKE_PORT}`,
    apiKey: TEST_KEY, model: 'deepseek-flash',
  }),
});
step('可以保存配置', saveRes.body?.ok === true, JSON.stringify(saveRes));

const status1 = await getJson(`http://localhost:${APP_PORT}/__ai/status`, { headers: H });
step('配置后 status 返回 configured:true 与模型名',
  status1.body?.configured === true && status1.body?.model === 'deepseek-flash', JSON.stringify(status1));
step('status 绝不返回 Key', !JSON.stringify(status1.body).includes(TEST_KEY), JSON.stringify(status1.body));

const raw = fs.existsSync(AI_CONFIG) ? fs.readFileSync(AI_CONFIG, 'utf8') : '';
step('Key 落在隔离的临时配置文件里', raw.includes(TEST_KEY));
step('真实 ai.local.json 没有被创建', !fs.existsSync(REAL_AI_CONFIG));

/* ---------- 流式转发 ---------- */
hits.length = 0;
const chatRes = await fetch(`http://localhost:${APP_PORT}/__ai/chat`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: true }),
});
const streamed = await chatRes.text();
step('chat 接口返回 200', chatRes.status === 200, `HTTP ${chatRes.status}`);
step('流式内容被完整转发',
  streamed.includes('这是') && streamed.includes('流式') && streamed.includes('回答'), streamed.slice(0, 60));
step('确实打到了配置里的 baseUrl',
  hits.length === 1 && String(hits[0]?.url).includes('/chat/completions'), String(hits[0]?.url));
step('转发时带上了 Authorization',
  String(hits[0]?.auth) === `Bearer ${TEST_KEY}`, String(hits[0]?.auth).slice(0, 12) + '…');
step('转发时带上了配置的模型', hits[0]?.body?.model === 'deepseek-flash', String(hits[0]?.body?.model));
step('转发时原样带上了消息', hits[0]?.body?.messages?.[0]?.content === '你好', JSON.stringify(hits[0]?.body?.messages));

/* ---------- 未配置时报错清晰 ---------- */
fs.rmSync(AI_CONFIG, { force: true });
const noCfg = await getJson(`http://localhost:${APP_PORT}/__ai/chat`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
});
step('未配置 Key 时返回 400', noCfg.status === 400, `HTTP ${noCfg.status}`);
step('未配置时提示是中文且明确', /Key/.test(noCfg.body?.error || ''), String(noCfg.body?.error));

/* ---------- 会话持久化（浏览器驱动） ----------
   上一步为了测「未配置」把配置删了，这里先写回去。 */
await fetch(`http://localhost:${APP_PORT}/__ai/config`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: TEST_KEY, model: 'deepseek-flash',
  }),
});

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const browserPath = CANDIDATES.find(p => fs.existsSync(p));
if (!browserPath) {
  step('（跳过浏览器用例：未找到 Chrome/Edge）', true);
} else {
  const CDP = 9351;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-ai-p-'));
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { return false; } });
    const tabs = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let seq = 0; const waiting = new Map();
    const send = (method, params = {}) => new Promise(res => {
      const i = ++seq; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
    };
    await send('Runtime.enable'); await send('Page.enable');
    const evalJs = async (expression, awaitPromise = false) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r?.result?.value;
    };

    await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
    await waitFor(async () => await evalJs('!!window.__inkReady'));

    await evalJs("window.__ink.store.saveChat({ kind: 'general', title: '持久化用例' })", true);
    await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
    await waitFor(async () => await evalJs('!!window.__inkReady'));
    step('刷新页面后会话仍在',
      (await evalJs("window.__ink.store.state.chats.some(c => c.title === '持久化用例')")) === true);

    await evalJs('window.__ink.store.clearChats()', true);
    const left = await evalJs('window.__ink.store.state.chats.length');
    step('清空全部对话后没有残留', left === 0, `${left} 条`);

    ws.close();
  } catch (e) {
    step('浏览器用例执行失败', false, e.message);
  } finally {
    try { browser.kill(); } catch {}
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

/* ---------- 输出 ---------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\nAI 助手端到端回归\n');
let failed = 0;
for (const s of steps) {
  if (!s.ok) failed++;
  console.log(`${s.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${s.name}${s.extra ? `${C.dim}  (${s.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed ? 1 : 0);
