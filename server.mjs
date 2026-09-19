/* 零依赖本地静态服务器：node server.mjs [端口] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { exec } from 'node:child_process';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8765);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(root, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }
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

let tries = 0;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && tries < 12) {
    tries++;
    setTimeout(() => server.listen(port + tries), 60);
    return;
  }
  console.error('启动失败：', err.message);
  process.exit(1);
});

server.listen(port, () => {
  const real = server.address().port;
  const addr = `http://localhost:${real}/`;
  console.log(`墨读已启动： ${addr}`);
  console.log('按 Ctrl+C 停止服务');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${addr}"` : process.platform === 'darwin' ? `open "${addr}"` : `xdg-open "${addr}"`;
    exec(cmd, () => {});
  }
});
