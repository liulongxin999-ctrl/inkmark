/* 静态检查：所有相对导入的名字都能在目标文件中找到对应导出 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\s/.test(src)) names.add('default');
  return names;
}

const files = walk(path.join(root, 'src'));
const cache = new Map();
const read = p => { if (!cache.has(p)) cache.set(p, fs.readFileSync(p, 'utf8')); return cache.get(p); };

let errors = 0;
for (const file of files) {
  const src = read(file);
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) { console.error(`✗ ${path.relative(root, file)} → 找不到模块 ${spec}`); errors++; continue; }
    const clause = m[1].trim();
    const named = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) for (const part of braces[1].split(',')) {
      const seg = part.trim(); if (!seg) continue;
      named.push(seg.split(/\s+as\s+/)[0].trim());
    }
    const available = exportsOf(read(target));
    for (const n of named) {
      if (!available.has(n)) { console.error(`✗ ${path.relative(root, file)} → '${spec}' 未导出 ${n}`); errors++; }
    }
  }
}

console.log(errors ? `\n共 ${errors} 处导入错误` : `✓ ${files.length} 个模块，导入导出全部匹配`);
process.exit(errors ? 1 : 0);
