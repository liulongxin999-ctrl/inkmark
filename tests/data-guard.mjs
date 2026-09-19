/* 数据防泄漏闸门回归测试
   目的：保证"日常使用产生的私人数据"永远不会被推到 GitHub。
   本测试会临时制造假数据并尝试提交，然后彻底清理；只使用带前缀的临时文件名，
   绝不碰 backups/ 里你自己的备份文件。 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PREFIX = 'INKMARK-GUARD-TEST';

/* 注意：本文件自身也被防泄漏检查扫描，所以不能出现字面量的本机路径，
   否则会被自己拦下（这正是真实发生过的误报）。这里在运行时拼接。 */
const FAKE_HOME = ['C:', 'Users', '某个人', 'Desktop', '秘密', '笔记.txt'].join(String.fromCharCode(92));

const FAKES = [
  { file: path.join('backups', `${PREFIX}.json`), content: '{"app":"inkmark","data":{"books":[{"title":"假的私密教材"}]}}' },
  { file: `${PREFIX}.pdf`, content: '%PDF-1.4 假电子书' },
  { file: `${PREFIX}-路径泄露.md`, content: `我电脑上的路径：${FAKE_HOME}\n` },
];

const steps = [];
const step = (name, ok, extra = '') => steps.push({ name, ok: !!ok, extra });

const git = (args, opts = {}) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const runGuard = (extra = []) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'check-no-data.mjs'), ...extra], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const preStaged = git(['diff', '--cached', '--name-only']).out;
const cleanup = () => {
  for (const f of FAKES) {
    try { git(['reset', '-q', '--', f.file]); } catch {}
    try { fs.rmSync(path.join(root, f.file), { force: true }); } catch {}
  }
  try { fs.rmdirSync(path.join(root, 'backups')); } catch {}   // 空目录才删得掉；有你的备份时自然保留
};
process.on('exit', cleanup);

/* ---------- 1. 干净状态应通过 ---------- */
let g = runGuard();
step('干净仓库下检查通过', g.code === 0, g.out.match(/被跟踪的 \d+ 个文件/)?.[0] || '');

/* ---------- 2. 制造假数据 ---------- */
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
for (const f of FAKES) fs.writeFileSync(path.join(root, f.file), f.content, 'utf8');

const visible = git(['status', '--porcelain', '--untracked-files=all']).out
  .split('\n').filter(l => l.includes(PREFIX));
const dataVisible = visible.filter(l => /\.(json|pdf)\b/.test(l));
step('忽略规则让备份文件与电子书对 git 完全不可见', dataVisible.length === 0, `git 显示 ${dataVisible.length} 个（应为 0）`);
// 普通 .md 文件本来就该被 git 看见 —— 它用来验证"内容层面"的检查是否生效
step('普通文本文件仍会被跟踪（由内容检查兜底）', visible.some(l => l.includes('.md')), `可见 ${visible.length} 个`);

/* ---------- 3. 强行加入暂存区后必须被拦下 ---------- */
const add = git(['add', '-f', '--', ...FAKES.map(f => f.file)]);
step('可以用 -f 强行加入暂存区（模拟极端误操作）', add.code === 0);

g = runGuard(['--staged']);
step('检查器能识别出暂存的私人数据', g.code !== 0, `退出码 ${g.code}`);
step('能指出备份文件', /backups\/INKMARK-GUARD-TEST\.json/.test(g.out));
step('能指出电子书原文件', /INKMARK-GUARD-TEST\.pdf/.test(g.out));
step('能识别文件内容里的本机路径', /本机绝对路径/.test(g.out));

/* ---------- 4. 真实 git commit 必须被钩子阻止 ---------- */
const hooksPath = git(['config', '--get', 'core.hooksPath']).out;
if (hooksPath !== '.githooks') {
  step('git 钩子已启用（core.hooksPath=.githooks）', false, `当前为 "${hooksPath}"，请执行 git config core.hooksPath .githooks`);
} else if (preStaged) {
  step('git 提交被钩子阻止（跳过：仓库里本来就有暂存内容，避免影响你的工作）', true);
} else {
  const commit = git(['commit', '-m', '这条提交必须被阻止']);
  step('真实 git commit 被钩子阻止', commit.code !== 0, `退出码 ${commit.code}`);
  const head = git(['log', '-1', '--pretty=%s']).out;
  step('确认仓库里没有产生这条提交', !head.includes('这条提交必须被阻止'), head);
}

/* ---------- 5. 清理后恢复通过 ---------- */
cleanup();
await new Promise(r => setTimeout(r, 200));
g = runGuard();
step('清理后检查恢复通过', g.code === 0);
const dirty = git(['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(l => l.includes(PREFIX));
step('测试没有残留任何临时文件', dirty.length === 0);

/* ---------------- 输出 ---------------- */
const C = { ok: '\u001b[32m', fail: '\u001b[31m', reset: '\u001b[0m', dim: '\u001b[90m' };
console.log('\n数据防泄漏闸门回归测试\n');
let failed = 0;
for (const st of steps) {
  if (!st.ok) failed++;
  console.log(`${st.ok ? C.ok + '✓' : C.fail + '✗'}${C.reset} ${st.name}${st.extra ? `${C.dim}  (${st.extra})${C.reset}` : ''}`);
}
console.log(`\n${failed ? C.fail : C.ok}PASS ${steps.length - failed} / FAIL ${failed}${C.reset}`);
process.exit(failed ? 1 : 0);
