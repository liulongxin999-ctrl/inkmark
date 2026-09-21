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
      // 中途断流分支：用来验证「模型服务抖一下」时墨读不会挂，且前端会标记未完成
      if (JSON.stringify(parsed.messages || []).includes('中断测试')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '只有半句' } }] })}\n\n`);
        setTimeout(() => { try { res.destroy(); } catch { /* 已经断了 */ } }, 30);
        return;
      }
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

/* ---------- 上游中途断流：最严重的一类故障 ----------
   没兜住的话，异常会变成 unhandled rejection，Node 15+ 直接终止进程，
   等于「模型服务抖一下，整个墨读就没了」。 ---------- */
await fetch(`http://localhost:${APP_PORT}/__ai/config`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: TEST_KEY, model: 'deepseek-flash',
  }),
});
let partial = '';
try {
  const r = await fetch(`http://localhost:${APP_PORT}/__ai/chat`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ messages: [{ role: 'user', content: '中断测试' }], stream: true }),
  });
  // 按前端的方式逐块读：连接被上游带断时 read() 会抛，
  // 但此前已经到达的分片必须已经累积下来（前端就是靠这个保住半截回答的）
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    partial += dec.decode(value, { stream: true });
  }
} catch { /* 连接断了，属于预期 */ }
step('上游断流时，已收到的部分仍转发给了前端', partial.includes('只有半句'), partial.slice(0, 40));

const stillAlive = await getJson(`http://localhost:${APP_PORT}/__inkmark`);
step('上游断流后墨读服务仍然活着（没被异常带走）',
  stillAlive.status === 200 && stillAlive.body?.app === 'inkmark', `HTTP ${stillAlive.status}`);

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

    /* 导入示例书并进入阅读：侧栏只在阅读视图里出现 */
    const doc = await send('DOM.getDocument', { depth: -1 });
    const fileInput = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#view-library input[type=file]' });
    await send('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [path.join(root, '示例', '示例书-认知科学导论.txt')] });
    await waitFor(async () => { const n = await evalJs("document.querySelectorAll('.book-card').length"); return n > 0 ? n : 0; });
    await evalJs("document.querySelector('.book-card').click()");
    await waitFor(async () => { const n = await evalJs("document.querySelectorAll('#reader-body .blk').length"); return n >= 2 ? n : 0; });

    /* 走真实的「选中正文 → 工具条 → 问 AI」路径 */
    await evalJs(`(() => {
      const blk = [...document.querySelectorAll('#reader-body .blk')].find(b => b.textContent.includes('组块'));
      const node = [...blk.childNodes].find(n => n.nodeType === 3) || blk.firstChild;
      const r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, Math.min(8, node.data.length));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('#reader-body').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    step('选中正文后工具条出现「问 AI」',
      (await evalJs('!!document.querySelector(\'#sel-toolbar [data-act="ask"]\')')) === true);

    await evalJs('document.querySelector(\'#sel-toolbar [data-act="ask"]\').click()');
    await sleep(700);
    step('点「问 AI」后侧栏切到 AI 标签',
      (await evalJs('window.__ink.store.state.asideTab')) === 'ai');
    step('选段被挂上（会随这次提问一起发出去）',
      (await evalJs('!!window.__ink.store.state.selectionRef')) === true);
    step('输入框预填了问题',
      String(await evalJs("document.querySelector('#aside .ai-input')?.value || ''")).includes('这段是什么意思'));
    step('AI 面板渲染出来', (await evalJs("!!document.querySelector('#aside .ai-input')")) === true);

    /* 命令面板里也要有入口 */
    await evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))");
    await sleep(400);
    step('命令面板里有「问 AI…」',
      String(await evalJs("[...document.querySelectorAll('.palette-item')].map(i => i.textContent).join('|')")).includes('问 AI'));
    await evalJs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await sleep(300);

    step('预览里标出了会带上选段',
      String(await evalJs("document.querySelector('#aside .ai-preview-head')?.textContent || ''")).includes('含选中原文'));

    /* 真的发一条消息（打到假 provider） */
    await evalJs(`(() => {
      const t = document.querySelector('#aside .ai-input');
      t.value = '这段是什么意思？';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#aside .ai-input-row .btn')].find(b => b.textContent === '发送').click();
      return true;
    })()`);
    const gotReply = await waitFor(async () => {
      const n = await evalJs("(window.__ink.store.state.chats[0]?.messages || []).filter(m => m.role === 'assistant').length");
      return n > 0 ? n : 0;
    }, 80, 250);
    step('提问后拿到回答并落盘', gotReply > 0, `${gotReply} 条回答`);
    step('回答内容确实来自假 provider 的流式分片',
      String(await evalJs("window.__ink.store.state.chats[0].messages.at(-1).text")).includes('流式回答'));
    step('用户消息带上了引用',
      (await evalJs("!!window.__ink.store.state.chats[0].messages[0].quoted?.quote")) === true);
    step('选段用完后被清空（不会重复发出去）',
      (await evalJs('window.__ink.store.state.selectionRef')) === null);

    /* 一键沉淀 */
    await sleep(500);
    await evalJs("[...document.querySelectorAll('#aside .ai-actions .btn')].find(b => b.textContent === '存入笔记').click()");
    await sleep(500);
    const aiNotes = await evalJs("window.__ink.store.state.notes.filter(n => n.kind === 'ai').length");
    step('一键「存入笔记」生成 AI 卡片', aiNotes > 0, `${aiNotes} 条`);
    step('AI 卡片记住了原始出处',
      (await evalJs("!!window.__ink.store.state.notes.find(n => n.kind === 'ai')?.blockId")) === true);

    await evalJs("[...document.querySelectorAll('#aside .ai-actions .btn')].find(b => b.textContent === '设为术语').click()");
    await sleep(400);
    step('一键「设为术语」打开术语编辑器',
      (await evalJs("!!document.querySelector('#modal-root .modal')")) === true);
    await evalJs("document.querySelector('#modal-root .modal .icon-btn')?.click()");
    await sleep(200);

    /* 笔记工作台要认得出 AI 卡片 */
    await evalJs("window.__ink.store.go('notes')");
    await sleep(500);
    const noteLabel = await evalJs(`(() => {
      const card = [...document.querySelectorAll('#view-notes .note-card')]
        .find(c => c.textContent.includes('AI 问答'));
      return card ? 'AI 问答' : [...document.querySelectorAll('#view-notes .note-card .pill')].map(p => p.textContent).join(',');
    })()`);
    step('笔记工作台把 AI 卡片标成「AI 问答」', noteLabel === 'AI 问答', String(noteLabel));
    await evalJs("window.__ink.store.go('reader')");
    await sleep(300);

    /* 上游断流时，前端的表现 */
    await evalJs(`(() => {
      window.__ink.store.openAside('ai');
      const t = document.querySelector('#aside .ai-input');
      t.value = '中断测试';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('#aside .ai-input-row .btn')].find(b => b.textContent === '发送').click();
      return true;
    })()`);
    const marked = await waitFor(async () => {
      const last = await evalJs("window.__ink.store.state.chats[0]?.messages.at(-1)");
      return last?.role === 'assistant' && last?.interrupted === true;
    }, 60, 250);
    const lastMsg = String(await evalJs("JSON.stringify(window.__ink.store.state.chats[0]?.messages.at(-1) || null)"));
    step('上游断流时，前端把这条回答标成「未完成」', marked === true, lastMsg.slice(0, 170));
    step('界面上明确提示了没写完',
      String(await evalJs("document.querySelector('#aside .ai-warn')?.textContent || ''")).includes('没写完'));

    /* 第四个入口：术语悬停气泡 */
    await evalJs("window.__ink.store.saveTerm({ name: '组块', definition: '记忆的单位', color: '#2f5d7c' })", true);
    await sleep(700);
    await evalJs(`(() => {
      const sg = document.querySelector('#reader-body .sg[data-term]');
      if (!sg) return false;
      sg.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);   // 悬停 250ms 之后才浮出气泡
    step('术语气泡里有「让 AI 讲讲这个」',
      (await evalJs("!!document.querySelector('#hover-card .hc-ask')")) === true);
    await evalJs("document.querySelector('#hover-card .hc-ask').click()");
    await sleep(700);
    step('点它会带着术语打开 AI 面板',
      String(await evalJs("document.querySelector('#aside .ai-input')?.value || ''")).includes('请解释「组块」'));
    step('术语所在段落也被挂成上下文',
      (await evalJs('!!window.__ink.store.state.selectionRef?.blockId')) === true);

    /* 刷新后会话仍在 */
    await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
    await waitFor(async () => await evalJs('!!window.__inkReady'));
    const chatsAfterReload = await evalJs('window.__ink.store.state.chats.length');
    step('刷新页面后会话仍在', chatsAfterReload > 0, `${chatsAfterReload} 条会话`);

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
