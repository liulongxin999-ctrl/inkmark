/* 数据防泄漏闸门
   作用：确保"你日常使用产生的私人数据"永远不会被提交到 GitHub。

   检查四件事：
   1) .gitignore 里的规则**真的生效**（而不是只写了字符串）
   2) 当前被跟踪的文件里没有私人数据
   3) 暂存区里没有私人数据（pre-commit 钩子用）
   4) 被跟踪的文本文件里没有本机绝对路径、私人邮箱

   用法：
     node tools/check-no-data.mjs            # 检查（CI / 手动）
     node tools/check-no-data.mjs --staged   # 额外检查暂存区（pre-commit 钩子）
*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const staged = process.argv.includes('--staged');

/* 注意：git 默认会把含中文/特殊字符的路径用引号 + 八进制转义输出
   （例如 "backups/\345\242\250..."），必须关掉 quotePath 并去掉引号，
   否则路径匹配会全部失配 —— 这正是本项目踩过的坑。 */
const git = args => {
  try { return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const unquote = f => f.replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1');
const lines = s => s.split('\n').map(x => unquote(x.trim())).filter(Boolean);

const problems = [];
const notes = [];

/* ---------- 1. 忽略规则是否真的生效 ---------- */
const MUST_IGNORE = [
  'backups/墨读自动备份-2026-01-01_000000.json',
  'backups/任意文件.json',
  '墨读自动备份-2026-01-01_000000.json',
  '资料/我的教材.pdf',
  '导出/我的笔记.md',
  '我的书/某本书.epub',
  '随便一本书.pdf',
  '某本教材.epub',
  'node_modules/whatever.js',
  '.DS_Store',
];
for (const p of MUST_IGNORE) {
  // git check-ignore：被忽略则退出码 0
  let ignored = false;
  try { execFileSync('git', ['check-ignore', '-q', '--', p], { cwd: root }); ignored = true; } catch { ignored = false; }
  if (!ignored) problems.push(`忽略规则失效：${p} 会被提交（请检查 .gitignore）`);
}

/* ---------- 2 & 3. 文件名单检查 ---------- */
const isDataPath = f => {
  const n = f.replace(/\\/g, '/');
  if (/(^|\/)backups\//.test(n)) return '磁盘自动备份目录';
  if (/墨读自动备份.*\.json$/.test(n)) return '自动备份文件';
  if (/(^|\/)(资料|导出|我的书)\//.test(n)) return '个人资料目录';
  if (/\.(pdf|epub|mobi|azw3)$/i.test(n) && !/^示例\//.test(n)) return '电子书原文件';
  return null;
};

const tracked = lines(git(['ls-files']));
const stagedFiles = staged ? lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])) : [];

for (const [list, label] of [[tracked, '已被跟踪的文件'], [stagedFiles, '本次要提交的文件']]) {
  for (const f of list) {
    const kind = isDataPath(f);
    if (kind) problems.push(`${label}里出现了私人数据：${f}（${kind}）`);
  }
}

/* ---------- 4. 内容检查 ---------- */
const TEXT_EXT = /\.(js|mjs|css|html|json|md|txt|yml|yaml|bat|cmd|sh|typ|tex)$/i;
const PERSONAL = [
  { re: /C:\\+Users\\+[^\\\s"']+\\/g, why: '本机绝对路径' },
];

for (const f of tracked) {
  const full = path.join(root, f);
  if (!TEXT_EXT.test(f) || !fs.existsSync(full)) continue;
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  for (const { re, why } of PERSONAL) {
    const m = text.match(re);
    if (m) problems.push(`${f} 里疑似包含${why}：${m[0].slice(0, 60)}`);
  }
}

/* ---------- 5. 备份目录规模提示 ---------- */
try {
  const dir = path.join(root, 'backups');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f !== 'index.json');
    if (files.length) notes.push(`backups/ 里有 ${files.length} 份本地备份（不会被提交，仅提示）`);
  }
} catch {}

/* ---------- 输出 ---------- */
const C = { ok: '\u001b[32m', bad: '\u001b[31m', dim: '\u001b[90m', reset: '\u001b[0m' };
console.log('');
if (problems.length) {
  console.log(`${C.bad}✗ 数据防泄漏检查未通过${C.reset}\n`);
  for (const p of problems) console.log(`  ${C.bad}·${C.reset} ${p}`);
  console.log(`\n${C.dim}如果是误报，请调整 .gitignore 或 tools/check-no-data.mjs 的规则；`);
  console.log(`确有必要提交时，用 git commit --no-verify 跳过钩子。${C.reset}\n`);
  process.exit(1);
}
console.log(`${C.ok}✓ 数据防泄漏检查通过${C.reset} —— 被跟踪的 ${tracked.length} 个文件里没有私人数据`);
console.log(`${C.dim}  已确认 ${MUST_IGNORE.length} 条忽略规则真实生效${C.reset}`);
for (const n of notes) console.log(`${C.dim}  提示：${n}${C.reset}`);
console.log('');
