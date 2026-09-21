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
