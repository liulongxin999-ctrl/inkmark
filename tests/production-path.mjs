/* 生产路径与安全边界测试：用与「启动.bat」完全相同的端口启动，验证
   1) 应用与接口可达
   2) 备份接口拒绝无凭证/跨站请求
   3) 备份目录不可被当作静态文件下载
   4) 文件名不能穿越目录
   用法：node tests/production-path.mjs [端口] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const HEAD = { 'X-InkMark': '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const beforeFiles = (() => { try { return fs.readdirSync(path.join(root, 'backups')); } catch { return []; } })();

const proc = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const cleanup = () => {
  try { proc.kill(); } catch {}
  try {
    const dir = path.join(root, 'backups');
    for (const f of fs.readdirSync(dir)) if (!beforeFiles.includes(f)) fs.unlinkSync(path.join(dir, f));
  } catch {}
};
process.on('exit', cleanup);

async function ready() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/__inkmark`)).ok) return true; } catch {}
    await sleep(150);
  }
  return false;
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

if (!await ready()) {
  console.error(`\n✗ 无法在端口 ${PORT} 启动服务（可能已被占用）。请先关闭正在运行的墨读再重试。`);
  cleanup(); process.exit(2);
}

/* 关键校验：确认我们连上的就是本次启动的进程。
   否则端口上可能有另一个（旧版本的）墨读实例在跑，测试会测错对象。 */
const me = await (await fetch(`${BASE}/__inkmark`)).json();
if (me.pid !== proc.pid) {
  console.error(`\n✗ 端口 ${PORT} 已被另一个墨读进程占用（对方 PID ${me.pid}，本次 PID ${proc.pid}）。`);
  console.error('  请先关闭它（关掉那个「启动.bat」窗口），再重新运行本测试。');
  console.error('  否则测试会连到旧进程上，结果不可信。\n');
  cleanup(); process.exit(2);
}

/* 1. 基本可达 */
const home = await fetch(`${BASE}/`);
const html = await home.text();
step('应用首页可访问', home.ok && html.includes('墨读 InkMark'), `HTTP ${home.status}`);
step('静态资源 MIME 正确', (await fetch(`${BASE}/src/main.js`)).headers.get('content-type')?.includes('javascript'));

const mark = await (await fetch(`${BASE}/__inkmark`)).json();
step('身份接口返回正确标识', mark.app === 'inkmark' && mark.port === PORT);

/* 2. 备份接口的访问控制 */
step('无凭证读取备份列表被拒绝', (await fetch(`${BASE}/__backup/list`)).status === 403);
step('跨站来源写备份被拒绝', (await fetch(`${BASE}/__backup`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  body: JSON.stringify({ app: 'inkmark', data: {} }),
})).status === 403);

/* 3. 正常备份与读取 */
const payload = { app: 'inkmark', version: 1, data: { books: [{ id: 'bk1', title: '安全测试书' }], notes: [] } };
const save = await fetch(`${BASE}/__backup`, { method: 'POST', headers: { ...HEAD, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const saveJson = await save.json();
step('带凭证可以写入备份', save.ok && saveJson.ok === true, saveJson.name || '');

const list = await (await fetch(`${BASE}/__backup/list`, { headers: HEAD })).json();
step('可以列出备份文件', list.ok && list.count >= 1, `${list.count} 份`);
const mine = list.backups.find(b => b.name === saveJson.name);
step('列表带内容摘要（几本书 / 几条批注 / 几条笔记）',
  !!mine && mine.books === 1 && mine.annotations === 0 && mine.notes === 0,
  mine ? `书 ${mine.books} · 批注 ${mine.annotations} · 笔记 ${mine.notes}` : '找不到刚写入的备份');

const empty = await fetch(`${BASE}/__backup`, {
  method: 'POST', headers: { ...HEAD, 'Content-Type': 'application/json' },
  body: JSON.stringify({ app: 'inkmark', data: { books: [], chapters: [], notes: [], terms: [], annotations: [] } }),
}).then(r => r.json());
const list2 = await (await fetch(`${BASE}/__backup/list`, { headers: HEAD })).json();
const emptyEntry = list2.backups.find(b => b.name === empty.name);
step('空备份会被标记为 0 本书（界面据此不再推荐恢复）', !!emptyEntry && emptyEntry.books === 0, `books=${emptyEntry?.books}`);
step('摘要索引没有污染备份计数', list2.backups.every(b => b.name.endsWith('.json') && b.name !== 'index.json'));
step('同一秒内的两次备份不会互相覆盖', saveJson.name !== empty.name, `${saveJson.name} vs ${empty.name}`);
step('两份备份确实是两份文件', list2.backups.filter(b => b.name === saveJson.name).length === 1 && !!list2.backups.find(b => b.name === empty.name));

const got = await (await fetch(`${BASE}/__backup/file?name=${encodeURIComponent(saveJson.name)}`, { headers: HEAD })).json();
step('可以读回备份内容', got?.data?.books?.[0]?.title === '安全测试书', JSON.stringify(got).slice(0, 140));

/* 4. 目录穿越与静态泄露 */
const trav1 = await fetch(`${BASE}/__backup/file?name=..%2Fserver.mjs`, { headers: HEAD });
step('文件名穿越被拒绝', trav1.status === 400 || trav1.status === 404, `HTTP ${trav1.status}`);
const trav2 = await fetch(`${BASE}/__backup/file?name=..%2F..%2Fpackage.json`, { headers: HEAD });
step('多级穿越同样被拒绝', trav2.status === 400 || trav2.status === 404, `HTTP ${trav2.status}`);
step('backups 目录不能当静态文件下载', (await fetch(`${BASE}/backups/${encodeURIComponent(saveJson.name)}`)).status === 403);
step('无凭证也无法读单个备份', (await fetch(`${BASE}/__backup/file?name=${encodeURIComponent(saveJson.name)}`)).status === 403);

/* 5. 收尾 */
cleanup();
await sleep(400);
let stillUp = false;
try { stillUp = (await fetch(`${BASE}/__inkmark`, { signal: AbortSignal.timeout(1000) })).ok; } catch { stillUp = false; }
step('服务可以正常停止', stillUp === false);

const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log(`\n生产路径与安全边界测试（端口 ${PORT}）\n`);
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
process.exit(failed ? 1 : 0);
