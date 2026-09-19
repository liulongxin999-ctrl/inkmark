/* 测试专用：清理测试产生的磁盘备份

   规则很简单也很安全 —— 只删除 origin 指向测试端口（8790-8799）的备份文件。
   你日常使用的地址是 8765，永远不会被碰到。
   即使某个测试中途崩溃，下一次跑测试时也会自动扫掉上次的残留。 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = path.join(root, 'backups');
const TEST_PORT = /localhost:(879\d)/;

export function sweepTestBackups(verbose = false) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f === 'index.json' || !f.endsWith('.json')) continue;
      const full = path.join(BACKUP_DIR, f);
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
