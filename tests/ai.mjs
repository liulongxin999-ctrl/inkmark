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
