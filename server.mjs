/* 零依赖本地服务器
   1) 静态文件服务
   2) 单实例检测：端口被自己占用时直接复用，绝不悄悄换端口（换端口 = 换浏览器存储空间）
   3) 磁盘自动备份接口：把浏览器里的数据另存一份到项目文件夹
   用法：node server.mjs [端口] [--open] [--allow-port-change] */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { exec } from 'node:child_process';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portArg = args.find(a => /^\d+$/.test(a));
const PORT = Number(portArg || 8765);
const OPEN = args.includes('--open');
const ALLOW_PORT_CHANGE = args.includes('--allow-port-change');
// 只绑定本机回环地址：同一 Wi-Fi 下的其他设备无法访问你的墨读
const HOST = '127.0.0.1';

const BACKUP_DIR = path.join(root, 'backups');
const INDEX_FILE = 'index.json';        // 备份摘要（文件数、含几本书几条例句），避免每次都解析大文件
const MAX_BACKUPS = 12;
const MAX_BODY = 256 * 1024 * 1024;   // 单次备份上限 256MB

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/* 只接受带自定义头的请求：浏览器对跨域的「自定义头」请求会先发 OPTIONS 预检，
   而这里不返回任何放行头，所以别的网站无法悄悄往这个接口写文件。 */
function trusted(req) {
  if (req.headers['x-inkmark'] === '1') return true;
  // 同源请求（含 sendBeacon）会带 Origin；跨站请求带的是它自己的来源，一律拒绝
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  return !!origin && !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('备份体积超过上限')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 只读文件名与大小，不解析内容 */
function listFiles() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json') && f !== INDEX_FILE)
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

const readIndex = () => {
  try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, INDEX_FILE), 'utf8')); } catch { return {}; }
};
const writeIndex = idx => {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, INDEX_FILE), JSON.stringify(idx), 'utf8'); } catch {}
};

/** 从备份内容里提取规模信息（首次遇到没有摘要的旧备份时才会解析） */
function summarize(name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'));
    const d = j.data || {};
    return {
      books: d.books?.length || 0,
      chapters: d.chapters?.length || 0,
      annotations: d.annotations?.length || 0,
      terms: d.terms?.length || 0,
      notes: d.notes?.length || 0,
      origin: j.origin || '',
      savedAt: j.savedAt || 0,
      reason: j.reason || '',
    };
  } catch { return { books: 0, chapters: 0, annotations: 0, terms: 0, notes: 0, origin: '', savedAt: 0, broken: true }; }
}

/** 列表带摘要：界面上可以直接显示"3 本书 · 12 条笔记" */
function listBackups() {
  const files = listFiles();
  const idx = readIndex();
  let changed = false;
  const out = files.map(f => {
    let info = idx[f.name];
    if (!info) { info = summarize(f.name); idx[f.name] = info; changed = true; }
    return { ...f, ...info };
  });
  // 清掉已经不存在的文件对应的摘要
  const alive = new Set(files.map(f => f.name));
  for (const k of Object.keys(idx)) if (!alive.has(k)) { delete idx[k]; changed = true; }
  if (changed) writeIndex(idx);
  return out;
}

function trimBackups() {
  for (const f of listFiles().slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch {}
  }
}

async function saveBackup(req, res) {
  if (!trusted(req)) return json(res, 403, { ok: false, error: '不接受的请求来源' });
  try {
    const buf = await readBody(req);
    const text = buf.toString('utf8');
    const data = JSON.parse(text);
    if (data?.app !== 'inkmark' || !data.data) return json(res, 400, { ok: false, error: '备份内容格式不正确' });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // 文件名精确到秒，同一秒内连续备份会重名互相覆盖 —— 这里自动加序号避开
    let name = `墨读自动备份-${stamp()}.json`;
    for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) {
      name = `墨读自动备份-${stamp()}-${i}.json`;
      if (i > 99) break;
    }
    fs.writeFileSync(path.join(BACKUP_DIR, name), text, 'utf8');
    // 顺手记下摘要，列表就不用再解析大文件
    const idx = readIndex();
    idx[name] = summarize(name);
    writeIndex(idx);
    trimBackups();
    const count = listBackups().length;
    console.log(`[备份] 已写入 ${name}（${(buf.length / 1024).toFixed(1)} KB，保留最新 ${count} 份）`);
    return json(res, 200, { ok: true, name, count, dir: BACKUP_DIR });
  } catch (e) {
    console.error('[备份] 写入失败：', e.message);
    return json(res, 500, { ok: false, error: e.message });
  }
}

/* ---------------- 请求处理 ---------------- */
let actualPort = PORT;

const server = http.createServer(async (req, res) => {
  let p = '/';
  try { p = decodeURIComponent(new URL(req.url, `http://localhost:${actualPort}`).pathname); } catch { /* 异常 URL 忽略 */ }

  if (p === '/__inkmark') {
    return json(res, 200, { app: 'inkmark', name: '墨读 InkMark', port: actualPort, pid: process.pid, startedAt: server.__startedAt });
  }
  if (p === '/__backup' && req.method === 'POST') return saveBackup(req, res);
  if (p === '/__backup/list') {
    if (!trusted(req)) return json(res, 403, { ok: false });
    const backups = listBackups();
    return json(res, 200, { ok: true, dir: BACKUP_DIR, count: backups.length, backups });
  }
  if (p === '/__backup/file') {
    if (!trusted(req)) return json(res, 403, { ok: false });
    const name = new URL(req.url, 'http://localhost').searchParams.get('name') || '';
    // 只允许读取 backups 目录下的 .json，杜绝路径穿越
    if (!/^[\w\u4e00-\u9fa5\-.]+\.json$/.test(name)) return json(res, 400, { ok: false, error: '文件名不合法' });
    const full = path.join(BACKUP_DIR, name);
    if (!full.startsWith(BACKUP_DIR) || !fs.existsSync(full)) return json(res, 404, { ok: false, error: '备份不存在' });
    const body = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }

  /* 静态文件 */
  let file = path.join(root, p === '/' ? 'index.html' : p);
  if (!file.startsWith(root) || p.startsWith('/backups')) { res.writeHead(403).end('Forbidden'); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ---------------- 端口策略：绝不悄悄换地址 ---------------- */
function openBrowser(addr) {
  const cmd = process.platform === 'win32' ? `start "" "${addr}"`
    : process.platform === 'darwin' ? `open "${addr}"` : `xdg-open "${addr}"`;
  exec(cmd, () => {});
}

async function isOurServer(port) {
  try {
    const r = await fetch(`http://localhost:${port}/__inkmark`, { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    return d?.app === 'inkmark' ? d : null;
  } catch { return null; }
}

let tries = 0;
server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') {
    console.error('启动失败：', err.message);
    process.exit(1);
  }

  const mine = await isOurServer(PORT);
  if (mine) {
    console.log('');
    console.log(`  墨读已经在运行中（端口 ${PORT}，进程 ${mine.pid}）。`);
    console.log('  直接打开下面这个地址即可，你之前的书和批注都在里面：');
    console.log('');
    console.log(`      http://localhost:${PORT}/`);
    console.log('');
    if (OPEN) openBrowser(`http://localhost:${PORT}/`);
    process.exit(0);
  }

  if (!ALLOW_PORT_CHANGE) {
    console.error('');
    console.error(`  [×] 端口 ${PORT} 被其他程序占用了。`);
    console.error('');
    console.error('  请先关掉占用它的程序，再重新双击「启动.bat」。');
    console.error(`  不要改用其他端口：浏览器会把不同端口当成不同的网站，`);
    console.error(`  那样就看不到保存在 http://localhost:${PORT}/ 下面的书和批注了。`);
    console.error('');
    process.exit(1);
  }

  tries++;
  const next = PORT + tries;
  console.warn(`  [!] 端口 ${PORT} 被占用，临时改用 ${next}（该地址下的存档与 ${PORT} 互不相通）`);
  server.listen(next, HOST);
});

server.listen(PORT, HOST, () => {
  actualPort = server.address().port;
  server.__startedAt = Date.now();
  const addr = `http://localhost:${actualPort}/`;
  console.log('');
  console.log(`  墨读已启动： ${addr}`);
  console.log(`  浏览器存档：按上面这个网址区分   磁盘备份：${BACKUP_DIR}`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
  if (OPEN) openBrowser(addr);
});
