/* 备份保留策略：每个来源地址各留 12 份，互不挤占

   回归背景：早期实现是「全局按时间保留最新 12 份」，
   于是自动化测试（跑在 879x）写出来的备份会把你自己 8765 的真实备份挤掉，
   而测试清理只能删掉自己的文件，被挤掉的那份再也找不回来。

   ⚠ 本测试一开始是直接拿真实的 backups/ 当试验场的，结果在验证旧逻辑时
   真的把你 6 份真实备份删掉了。现在的做法是：
   **服务器用 INKMARK_BACKUP_DIR 指向一个临时目录，测试全程只碰那个目录**，
   并且最后会校验真实的 backups/ 一份都没少。

   验证四件事：
   1) 测试端口写入     → 8765 的备份一份都不少
   2) 8766（找回旧存档用的地址）写入 → 8765 的备份一份都不少
   3) 同一个地址自己的备份仍然按上限清理
   4) 8765 自己写入时，只清理自己那一组的旧备份
   另加一条：整个测试不碰真实 backups/ 目录。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = 8792;                              // 8789~8799 里没有被别的测试占用的一个
const REAL_BACKUP_DIR = path.join(root, 'backups');   // 你的真实备份，本测试只读不动
const TEMP_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmark-trim-'));
const FAKE_ORIGIN = 'http://localhost:8765';    // 你日常使用、真实备份所在的那个地址
const MAX_BACKUPS = 12;
const FAKE_COUNT = MAX_BACKUPS + 2;
const OLD = new Date('2020-01-01T00:00:00Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const isBackup = f => f.endsWith('.json') && f !== 'index.json';
const backupsIn = dir => { try { return fs.readdirSync(dir).filter(isBackup); } catch { return []; } };
const originOf = (dir, f) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).origin || ''; }
  catch { return null; }
};
const filesWithOrigin = (dir, o) => backupsIn(dir).filter(f => originOf(dir, f) === o);
const realBackupNames = backupsIn(REAL_BACKUP_DIR);   // 开始前记下你有哪些真实备份

let server = null;
const finish = async code => {
  try { server?.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(TEMP_BACKUP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
};

async function waitFor(fn, tries = 60, gap = 200) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

/* ---------- 安全闸：绝不允许对着真实备份目录跑 ---------- */
step('测试用的备份目录是独立的临时目录，不是真实的 backups/',
  path.resolve(TEMP_BACKUP_DIR) !== path.resolve(REAL_BACKUP_DIR), TEMP_BACKUP_DIR);
if (path.resolve(TEMP_BACKUP_DIR) === path.resolve(REAL_BACKUP_DIR)) await finish(2);

/* ---------- 准备：在临时目录里造一批很旧的「8765 备份」 ---------- */
const fakePaths = [];
for (let i = 0; i < FAKE_COUNT; i++) {
  const full = path.join(TEMP_BACKUP_DIR, `墨读自动备份-2020-01-01_0000${String(i).padStart(2, '0')}.json`);
  fs.writeFileSync(full, JSON.stringify({
    app: 'inkmark', version: 2, savedAt: OLD.getTime(),
    origin: FAKE_ORIGIN, reason: '测试用假备份（内容是空的，不会被恢复）',
    data: { books: [], chapters: [], annotations: [], terms: [], notes: [], bookmarks: [], stats: [], settings: [] },
  }), 'utf8');
  fs.utimesSync(full, OLD, OLD);   // 设成最旧：按时间清理时最先删到的一定是它们
  fakePaths.push(full);
}
const fakedTotal = filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length;
step('已在临时目录里放入假备份，模拟"攒了很久的 8765 存档"',
  fakedTotal === FAKE_COUNT, `${FAKE_COUNT} 份`);
step('8765 的备份总数已超过上限（否则复现不出被挤掉的问题）',
  fakedTotal > MAX_BACKUPS, `${fakedTotal} > ${MAX_BACKUPS}`);

/* ---------- 启动测试服务器（备份目录指向临时目录） ---------- */
server = spawn(process.execPath, [path.join(root, 'server.mjs'), String(PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, INKMARK_BACKUP_DIR: TEMP_BACKUP_DIR },
});
const up = await waitFor(async () => { try { return (await fetch(`http://localhost:${PORT}/__inkmark`)).ok; } catch { return false; } });
step('测试服务器已启动（备份写入临时目录）', !!up, `端口 ${PORT}`);
if (!up) await finish(2);

const post = async origin => {
  const body = JSON.stringify({
    app: 'inkmark', version: 2, savedAt: Date.now(), origin, reason: '保留策略测试',
    data: { books: [], chapters: [] },
  });
  const r = await fetch(`http://localhost:${PORT}/__backup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-InkMark': '1' }, body,
  });
  return r.json();
};

/* ---------- 1. 测试端口写入，不许动 8765 ---------- */
const r1 = await post(`http://localhost:${PORT}`);
step('测试端口能正常写入备份', r1.ok === true, r1.name || r1.error);
step('测试端口写入后，8765 的备份一份都没少',
  filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length === fakedTotal,
  `${fakedTotal} 份 → ${filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length} 份`);

/* ---------- 2. 「找回旧存档」用的地址写入，也不许动 8765 ---------- */
const r2 = await post('http://localhost:8766');
step('8766（找回旧存档用的地址）能正常写入', r2.ok === true, r2.name || r2.error);
step('8766 写入后，8765 的备份仍然一份都没少',
  filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length === fakedTotal,
  `${filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length} 份`);

/* ---------- 3. 同一地址自己的备份仍然按上限清理 ---------- */
for (let i = 0; i <= MAX_BACKUPS; i++) await post(`http://localhost:${PORT}`);
const sameOrigin = filesWithOrigin(TEMP_BACKUP_DIR, `http://localhost:${PORT}`).length;
step('同一个地址自己的备份仍然按上限（12 份）清理', sameOrigin === MAX_BACKUPS, `${sameOrigin} 份`);
step('挤占自家配额时，也影响不到 8765 的备份',
  filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length === fakedTotal,
  `${filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length} 份`);

/* ---------- 4. 8765 自己写入：只清自己那组的旧备份 ---------- */
const r4 = await post(FAKE_ORIGIN);
step('8765 自己写入备份成功', r4.ok === true, r4.name || r4.error);
step('8765 这一组被清理到上限之内',
  filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length <= MAX_BACKUPS,
  `${filesWithOrigin(TEMP_BACKUP_DIR, FAKE_ORIGIN).length} 份（上限 ${MAX_BACKUPS}）`);
step('被清掉的是最旧的假备份',
  fakePaths.some(p => !fs.existsSync(p)), `假备份剩余 ${fakePaths.filter(p => fs.existsSync(p)).length} 份`);

/* ---------- 5. 全程没碰过你真实的 backups/ ---------- */
const missingReal = realBackupNames.filter(f => !fs.existsSync(path.join(REAL_BACKUP_DIR, f)));
step('整个测试没有删掉你真实的任何一份备份',
  missingReal.length === 0,
  `测试前 ${realBackupNames.length} 份，丢失 ${missingReal.length} 份`);

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n备份保留策略（每个来源地址各留 12 份）\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
await finish(failed ? 1 : 0);
