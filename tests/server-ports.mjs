/* 端口策略回归测试（针对"换端口导致存档看不见"这个真实事故）
   1) 端口被别的程序占用 → 必须报错退出，绝不悄悄换端口
   2) 端口被墨读自己占用 → 直接复用原地址，不新起服务
   3) 只有显式加 --allow-port-change 时才允许换端口 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8793, NEXT = 8794;
const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const children = [];
let squatter = null;
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch {} }
  try { squatter?.close(); } catch {}
};
process.on('exit', cleanup);

async function probe(port) {
  try {
    const r = await fetch(`http://${HOST}:${port}/__inkmark`, { signal: AbortSignal.timeout(1200) });
    const d = await r.json().catch(() => null);
    return d?.app === 'inkmark' ? 'inkmark' : 'other';
  } catch { return 'free'; }
}

function startServer(port, extraArgs = []) {
  const proc = spawn(process.execPath, [path.join(root, 'server.mjs'), String(port), ...extraArgs], { cwd: root });
  children.push(proc);
  let out = '', err = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });
  return {
    proc,
    async settle(ms = 2000) {
      const r = await Promise.race([
        new Promise(res => proc.once('exit', c => res({ exited: true, code: c }))),
        sleep(ms).then(() => ({ exited: false })),
      ]);
      return { ...r, out, err };
    },
  };
}

async function startSquatter(port, body = '我是别的程序') {
  const s = http.createServer((_, res) => res.end(body));
  await new Promise((res, rej) => { s.once('error', rej); s.listen(port, HOST, res); });
  return s;
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

/* ---------- 1. 端口被别的程序占用 ---------- */
squatter = await startSquatter(PORT);
step('确认测试前提：端口已被别的程序占用', (await probe(PORT)) === 'other');

let a = startServer(PORT);
let ra = await a.settle(2500);
step('别的程序占用端口时，墨读拒绝启动（不静默换端口）',
  ra.exited && ra.code !== 0, `退出码 ${ra.exited ? ra.code : '仍在运行'}`);
step('并给出明确的中文提示', /被其他程序占用/.test(ra.err + ra.out));
step('没有偷偷占用备用端口', (await probe(NEXT)) === 'free');
await new Promise(r => squatter.close(r)); squatter = null;

/* ---------- 2. 端口空闲 ---------- */
let b = startServer(PORT);
let rb = await b.settle(1800);
step('端口空闲时正常启动', !rb.exited && /墨读已启动/.test(rb.out));
step('启动后可从本机访问', (await probe(PORT)) === 'inkmark');

/* ---------- 3. 墨读已在运行，再启动一次 ---------- */
let c = startServer(PORT);
let rc = await c.settle(3000);
step('已有墨读在运行时：第二次启动直接复用并退出', rc.exited && rc.code === 0, `退出码 ${rc.exited ? rc.code : '仍在运行'}`);
step('复用提示里给出了原地址', /已经在运行/.test(rc.out + rc.err) && rc.out.includes(`localhost:${PORT}`));
step('第二次启动没有产生新的监听端口', (await probe(NEXT)) === 'free');
step('原服务依然可用且响应正常', (await probe(PORT)) === 'inkmark' && !rb.exited);
c.proc.kill();

/* ---------- 4. 显式允许换端口时才换 ---------- */
b.proc.kill();
await sleep(600);
squatter = await startSquatter(PORT);
let d = startServer(PORT, ['--allow-port-change']);
let rd = await d.settle(2500);
step('显式加 --allow-port-change 时才允许换端口',
  !rd.exited && (await probe(NEXT)) === 'inkmark', rd.exited ? `意外退出(${rd.code})` : '已改用备用端口');

/* ---------- 5. 安全性：只绑定本机回环，不暴露给局域网 ---------- */
const net = await import('node:net');
const os = await import('node:os');
const lanIps = Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
if (!lanIps.length) {
  step('只监听本机回环地址（跳过：本机没有局域网地址）', true);
} else {
  const lanExposed = await new Promise(resolve => {
    const sock = net.connect({ host: lanIps[0], port: PORT });
    sock.setTimeout(1000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
  step('只监听本机回环地址（同一 Wi-Fi 下的设备访问不到）', lanExposed === false, `局域网地址 ${lanIps[0]}`);
}

d.proc.kill();
await sleep(200);
if (squatter) { await new Promise(r => squatter.close(r)); squatter = null; }

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n端口策略与本地安全回归测试\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
cleanup();
process.exit(failed ? 1 : 0);
