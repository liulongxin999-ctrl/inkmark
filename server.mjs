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

// 备份目录：默认就是项目里的 backups/。
// 自动化测试用 INKMARK_BACKUP_DIR 把它指到临时目录，
// 这样测试怎么写都碰不到你真实的备份。
const BACKUP_DIR = process.env.INKMARK_BACKUP_DIR
  ? path.resolve(process.env.INKMARK_BACKUP_DIR)
  : path.join(root, 'backups');

// AI 配置（含 API Key）：默认放项目根目录，已被 .gitignore 忽略。
// 自动化测试用 INKMARK_AI_CONFIG 指到临时文件，碰不到你真正的配置。
const AI_CONFIG_FILE = process.env.INKMARK_AI_CONFIG
  ? path.resolve(process.env.INKMARK_AI_CONFIG)
  : path.join(root, 'ai.local.json');
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

/* ---------------- AI 配置（含 API Key） ----------------
   只存本机文件，页面永远读不到完整 Key：/__ai/status 只回「配没配 + 模型名」。 */
const AI_DEFAULTS = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };

function readAiConfig() {
  try { return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')); } catch { return null; }
}

function writeAiConfig(cfg) {
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 对外暴露的配置视图：永远不含 apiKey */
function maskConfig(cfg) {
  if (!cfg || !cfg.apiKey) return { ok: true, configured: false };
  return {
    ok: true, configured: true,
    provider: cfg.provider || '', baseUrl: cfg.baseUrl || '', model: cfg.model || '',
  };
}

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

/** 只清理「同一个来源地址」的旧备份。
    不同网址写出来的备份互不挤占：你日常用 http://localhost:8765/，
    自动化测试跑在 879x，如果按时间一刀切保留最新 12 份，
    测试写出的备份就会把你的真实备份挤掉，而且再也找不回来。 */
function trimBackups(origin = '') {
  const same = listBackups().filter(b => (b.origin || '') === origin);
  for (const f of same.slice(MAX_BACKUPS)) {
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
    // 每个来源地址各留 MAX_BACKUPS 份
    const origin = data.origin || req.headers.origin || '';
    trimBackups(origin);
    const all = listBackups();
    const mine = all.filter(b => (b.origin || '') === origin).length;
    console.log(`[备份] 已写入 ${name}（${(buf.length / 1024).toFixed(1)} KB，来自 ${origin || '未知来源'}，该地址共 ${mine} 份）`);
    return json(res, 200, { ok: true, name, count: all.length, dir: BACKUP_DIR });
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

  /* ---------------- AI ----------------
     Key 只存在服务端本地文件里，页面拿不到；换服务商只改这一处。 */
  if (p === '/__ai/status') {
    if (!trusted(req)) return json(res, 403, { ok: false });
    return json(res, 200, maskConfig(readAiConfig()));
  }

  if (p === '/__ai/config' && req.method === 'POST') {
    if (!trusted(req)) return json(res, 403, { ok: false });
    try {
      const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const cur = readAiConfig() || { ...AI_DEFAULTS };
      // apiKey 传空表示「保留原值」：前端改模型时不必把 Key 回传一遍
      const next = {
        provider: patch.provider ?? cur.provider ?? AI_DEFAULTS.provider,
        baseUrl: String(patch.baseUrl ?? cur.baseUrl ?? AI_DEFAULTS.baseUrl).replace(/\/+$/, ''),
        model: patch.model ?? cur.model ?? AI_DEFAULTS.model,
        apiKey: patch.apiKey ? String(patch.apiKey).trim() : (cur.apiKey || ''),
      };
      writeAiConfig(next);
      return json(res, 200, maskConfig(next));
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
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
