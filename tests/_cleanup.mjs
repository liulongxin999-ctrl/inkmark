/* 测试专用：清理测试产生的磁盘备份

   规则很简单也很安全 —— 只删除 origin 指向测试端口（8790-8799）的备份文件。
   你日常使用的地址是 8765，永远不会被碰到。
   即使某个测试中途崩溃，下一次跑测试时也会自动扫掉上次的残留。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = path.join(root, 'backups');
const TEST_PORT = /localhost:(879\d)/;
const TEST_MARK = /^INKMARK-(GUARD|TRIM)-TEST/;   // 测试自己造的假备份的固定前缀

export function sweepTestBackups(verbose = false) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f === 'index.json' || !f.endsWith('.json')) continue;
      const full = path.join(BACKUP_DIR, f);
      // 1) 按固定前缀：测试造的假备份，无论里面写了什么来源都清掉
      if (TEST_MARK.test(f)) { try { fs.unlinkSync(full); n++; continue; } catch {} }
      // 2) 按来源地址：测试端口写出来的备份
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (TEST_PORT.test(j.origin || '')) { fs.unlinkSync(full); n++; }
      } catch { /* 解析不了就留着，不冒险删 */ }
    }
  } catch { /* 目录不存在 */ }
  if (verbose && n) console.log(`（已清理 ${n} 份测试产生的备份）`);
  return n;
}

export const backupsDir = BACKUP_DIR;

/**
 * 清理测试在系统临时目录里留下的工作目录。
 *
 * 测试崩溃（断言失败、浏览器起不来）时会跳过收尾，临时目录就留在那儿了 ——
 * 长期跑下来会攒到几百 MB。这里只删「两小时以前、且以 inkmark- 开头」的目录，
 * 绝不会碰到正在跑的测试。
 *
 * 本模块被各个测试 import，所以这一步是自动的：只要跑任意一个测试，就会顺手清一次。
 */
export function sweepTempDirs(maxAgeMs = 2 * 60 * 60 * 1000, verbose = false) {
  let n = 0;
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('inkmark-')) continue;
      const full = path.join(os.tmpdir(), name);
      try {
        const st = fs.statSync(full);
        if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        n++;
      } catch { /* 正被占用就跳过 */ }
    }
  } catch { /* 读不到临时目录就算了 */ }
  if (verbose && n) console.log(`（已清理 ${n} 个测试遗留的临时目录）`);
  return n;
}

// import 即生效：跑任意一个用到本模块的测试，都会顺手清理陈年临时目录
sweepTempDirs();
