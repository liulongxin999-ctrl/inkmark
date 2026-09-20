/* 文件解析：PDF / EPUB / TXT / Markdown / HTML → 统一的 {title, chapters:[{title,level,blocks}]} */

import { readAsArrayBuffer, readAsText, uid } from '../core/utils.js';

const B = (t, x, extra = {}) => ({ t, x: String(x || '').replace(/\u0000/g, '').trim(), ...extra });

/* ---------------- 编码识别 ---------------- */
export function decodeTextBuffer(buf) {
  const bytes = new Uint8Array(buf);
  // BOM
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    for (const enc of ['gb18030', 'gbk', 'big5', 'shift_jis']) {
      try { return new TextDecoder(enc).decode(bytes); } catch { /* 继续尝试 */ }
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/* ---------------- 入口 ---------------- */
export async function parseFile(file, onProgress = () => {}) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'zip') return parseBundle(file, onProgress);
  if (ext === 'pdf') return parsePDF(file, onProgress);
  if (ext === 'epub') return parseEPUB(file, onProgress);
  if (ext === 'md' || ext === 'markdown') return parseMarkdown(file);
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return parseHTML(file);
  if (['txt', 'text', 'log', 'json', 'csv', ''].includes(ext)) return parseText(file, ext);
  // 未知后缀：按文本尝试，失败则报错
  try { return await parseText(file, ext.toUpperCase()); }
  catch { throw new Error(`暂不支持 .${ext} 格式，请使用 PDF / EPUB / TXT / Markdown / HTML`); }
}

/* ---------------- 纯文本 ---------------- */
const CHAPTER_RE = /^[\s\u3000]*(?:(第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章节節回篇卷部课課讲])|(Chapter\s+[0-9IVXLC]+)|(CHAPTER\s+[0-9IVXLC]+)|(卷\s*[0-9一二三四五六七八九十]+)|(序章|楔子|前言|后记|附录|参考文献|结束语|引言|绪论))[\s：:.、]*(.{0,40})$/;

function splitParagraphs(text) {
  let parts = text.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 1200) { out.push(p); continue; }
    // 超长段落按句子切分
    let buf = '';
    for (const sent of p.split(/(?<=[。！？；.!?;])\s*/)) {
      if ((buf + sent).length > 900) { if (buf) out.push(buf.trim()); buf = ''; }
      buf += sent;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

export async function parseText(file, label) {
  const text = decodeTextBuffer(await readAsArrayBuffer(file)).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const chapters = [];
  let cur = { title: '', level: 1, lines: [] };

  for (const line of lines) {
    const m = line.match(CHAPTER_RE);
    // 标题行：匹配章节格式、足够短，且不以句末标点结尾（避免把正文句子误判为标题）
    const isHeading = !!m && line.trim().length <= 48 && !/[。！？；]/.test(line);
    if (isHeading) {
      if (cur.title || cur.lines.join('').trim()) chapters.push(cur);
      cur = { title: line.trim(), level: 1, lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.title || cur.lines.join('').trim() || !chapters.length) chapters.push(cur);

  // 无正文的标题（如「第一部分」这类分组标题）并入下一章的标题，避免空章节与信息丢失
  const built = [];
  let pendingTitles = [];
  for (const c of chapters) {
    const blocks = splitParagraphs(c.lines.join('\n')).map(p => B('p', p));
    if (!blocks.length) { if (c.title) pendingTitles.push(c.title.trim()); continue; }
    built.push({ title: [...pendingTitles, (c.title || '').trim()].filter(Boolean).join(' · '), level: 1, blocks });
    pendingTitles = [];
  }

  if (!built.some(c => c.title)) {
    // 无章节标记：按段落切成若干等长部分
    const paras = splitParagraphs(text);
    const chunkSize = 7000;
    const chunks = [];
    let buf = [];
    let len = 0;
    for (const p of paras) {
      buf.push(p); len += p.length;
      if (len >= chunkSize) { chunks.push(buf); buf = []; len = 0; }
    }
    if (buf.length) chunks.push(buf);
    return {
      title: stripExt(file.name), author: '', format: (label || 'TXT').toUpperCase(),
      chapters: chunks.map((ps, i) => ({
        title: `第 ${i + 1} 部分`, level: 1,
        blocks: ps.map(p => B('p', p)),
      })),
    };
  }

  return {
    title: stripExt(file.name), author: '', format: (label || 'TXT').toUpperCase(),
    chapters: built.map((c, i) => ({ ...c, title: c.title || `第 ${i + 1} 章` })),
  };
}

/* ---------------- Markdown ---------------- */
export async function parseMarkdown(file) {
  const raw = decodeTextBuffer(await readAsArrayBuffer(file)).replace(/\r\n?/g, '\n');
  return markdownToParsed(raw, stripExt(file.name));
}

/** Markdown 文本 → 统一结构（.md 文件、压缩包、文件夹三种入口共用） */
export function markdownToParsed(raw, fallbackTitle) {
  raw = String(raw || '').replace(/\r\n?/g, '\n');
  const sections = [];
  let cur = { title: '', lines: [] };
  for (const line of raw.split('\n')) {
    const m = line.match(/^(#{1,2})\s+(.*)$/);
    if (m && m[2].trim()) {
      if (cur.lines.join('').trim()) sections.push(cur);
      cur = { title: m[2].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim() || !sections.length) sections.push(cur);

  const renderer = window.marked;
  const chapters = sections.map((s, i) => ({
    title: s.title || `第 ${i + 1} 节`, level: 1,
    blocks: mdToBlocks(s.lines.join('\n'), renderer),
  })).filter(c => c.blocks.length);

  return { title: fallbackTitle || '未命名', author: '', format: 'Markdown', chapters: chapters.length ? chapters : [{ title: '正文', level: 1, blocks: [B('p', raw)] }] };
}

function mdToBlocks(md, marked) {
  if (marked?.parse) {
    try { return htmlToBlocks(new DOMParser().parseFromString(marked.parse(md), 'text/html').body); }
    catch { /* 退化为纯文本 */ }
  }
  return splitParagraphs(md).map(p => B('p', p));
}

/* ---------------- HTML ---------------- */
export async function parseHTML(file) {
  const raw = decodeTextBuffer(await readAsArrayBuffer(file));
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const docTitle = doc.querySelector('title')?.textContent?.trim();
  const blocks = htmlToBlocks(doc.body);
  return {
    title: docTitle || stripExt(file.name), author: doc.querySelector('meta[name="author"]')?.content || '',
    format: 'HTML',
    chapters: [{ title: docTitle || '正文', level: 1, blocks }],
  };
}

/** 把一串 HTML 转成块列表（跳过脚本样式，保留标题/列表/引用/代码） */
function htmlToBlocks(root) {
  const out = [];
  const push = (t, x, extra) => { const v = String(x || '').replace(/\s+/g, ' ').trim(); if (v) out.push(B(t, v, extra)); };
  const walk = node => {
    for (const child of node.children) {
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'nav', 'footer', 'header', 'svg'].includes(tag)) continue;
      if (['div', 'section', 'article', 'main', 'body', 'figure', 'tbody', 'tr', 'td', 'th', 'dl', 'dd', 'dt', 'center', 'span', 'font'].includes(tag)) {
        if (tag === 'td' || tag === 'th') { push('p', child.textContent); continue; }
        walk(child); continue;
      }
      if (tag === 'h1') push('h2', child.textContent);
      else if (tag === 'h2') push('h3', child.textContent);
      else if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') push('h3', child.textContent);
      else if (tag === 'p') pushParagraph(child);
      else if (tag === 'li') push('li', child.textContent);
      else if (tag === 'blockquote') push('q', child.textContent);
      else if (tag === 'pre') push('code', child.textContent);
      else if (tag === 'img') {
        const src = child.getAttribute('src') || '';
        if (src) out.push(B('img', child.getAttribute('alt') || '', { src }));
      }
      else if (tag === 'hr') push('page', '');
      else if (tag === 'br') continue;
      else if (tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'thead') walk(child);
      else push('p', child.textContent);
    }
  };
  walk(root);
  return out;

  /** 段落里可能夹着图片：按顺序拆成文本块与图片块，不能整段取纯文本把图丢掉 */
  function pushParagraph(p) {
    if (!p.querySelector('img')) { push('p', p.textContent); return; }
    let buf = '';
    const flush = () => { if (buf.trim()) { push('p', buf); buf = ''; } };
    for (const node of p.childNodes) {
      const isImg = node.nodeType === 1 && node.tagName.toLowerCase() === 'img';
      if (isImg) {
        flush();
        const src = node.getAttribute('src') || '';
        if (src) out.push(B('img', node.getAttribute('alt') || '', { src }));
      } else {
        buf += node.textContent || '';
      }
    }
    flush();
  }
}

/* ---------------- EPUB ---------------- */
export async function parseEPUB(file, onProgress = () => {}) {
  const zip = await window.JSZip.loadAsync(await readAsArrayBuffer(file));
  const readText = async path => {
    const f = zip.file(path);
    if (!f) return '';
    return decodeTextBuffer(await f.async('arraybuffer'));
  };

  const containerXml = await readText('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 结构异常：缺少 META-INF/container.xml');
  const container = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 结构异常：找不到 OPF 清单');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await readText(opfPath), 'application/xml');

  const pick = sel => opf.getElementsByTagName(sel)[0]?.textContent?.trim() || '';
  const title = pick('dc:title') || pick('title') || stripExt(file.name);
  const author = pick('dc:creator') || pick('creator') || '';

  const manifest = new Map();
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }
  const spineIds = Array.from(opf.getElementsByTagName('itemref')).map(r => r.getAttribute('idref'));
  const docs = spineIds.map(id => manifest.get(id)).filter(m => m && /x?html/i.test(m.type) && !/nav/.test(m.props));

  const chapters = [];
  for (let i = 0; i < docs.length; i++) {
    onProgress({ phase: 'epub', done: i + 1, total: docs.length });
    const href = docs[i].href;
    const path = resolvePath(base, href);
    const html = await readText(path);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks = htmlToBlocks(doc.body);
    if (!blocks.length) continue;
    const heading = doc.querySelector('h1,h2,h3')?.textContent?.trim();
    const t = heading || docTitleOf(doc) || `第 ${chapters.length + 1} 节`;
    chapters.push({
      title: t.slice(0, 60), level: blocks[0].t === 'h2' ? 1 : 2,
      blocks: blocks[0].t === 'h2' && blocks[0].x === t.slice(0, 60) ? blocks.slice(1) : blocks,
    });
  }
  if (!chapters.length) throw new Error('EPUB 中未解析到正文内容');
  return { title, author, format: 'EPUB', chapters };
}

const docTitleOf = doc => doc.querySelector('title')?.textContent?.trim() || '';

function resolvePath(base, href) {
  const parts = (base + href).split('/');
  const stack = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') stack.pop(); else stack.push(p);
  }
  return stack.join('/');
}

/* ---------------- PDF ---------------- */
export async function parsePDF(file, onProgress = () => {}) {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('PDF 引擎未加载，请确认 assets/vendor/pdf.min.js 存在');
  pdfjs.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
  const data = await readAsArrayBuffer(file);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const meta = await doc.getMetadata().catch(() => ({ info: {} }));
  const title = (meta.info?.Title || '').trim() || stripExt(file.name);
  const author = (meta.info?.Author || '').trim() || '';

  const pageBlocks = [];   // [{page, blocks}]
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress({ phase: 'pdf', done: p, total: doc.numPages });
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const { lines, medianHeight } = layoutLines(content.items);
    const blocks = linesToBlocks(lines, medianHeight);
    totalChars += blocks.reduce((n, b) => n + b.x.length, 0);
    pageBlocks.push({ page: p, blocks });
    if (p % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const scanned = totalChars < doc.numPages * 30;

  // 标题行聚合成章节；没有明显标题则按页数分章
  const headings = [];
  pageBlocks.forEach((pb, pi) => pb.blocks.forEach((b, bi) => {
    if (b.t === 'h2' || b.t === 'h3') headings.push({ pi, bi, b, page: pb.page });
  }));
  const chapters = [];
  if (headings.length >= 3) {
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const next = headings[i + 1];
      const blocks = [];
      let lastPage = 0;
      const startPi = h.pi, startBi = h.bi;
      const endPi = next ? next.pi : pageBlocks.length - 1;
      const endBi = next ? next.bi : -1;
      for (let pi = startPi; pi <= endPi; pi++) {
        const pb = pageBlocks[pi];
        const from = pi === startPi ? startBi : 0;
        const to = pi === endPi && endBi >= 0 ? endBi : pb.blocks.length;
        const slice = pb.blocks.slice(from, to);
        if (!slice.length) continue;
        if (pb.page !== lastPage) { blocks.push(B('page', `第 ${pb.page} 页`, { n: pb.page })); lastPage = pb.page; }
        blocks.push(...slice);
      }
      const title0 = h.b.x.slice(0, 70);
      if (blocks[0]?.t === 'h2' && blocks[0].x === title0) blocks.shift();
      if (blocks.length) chapters.push({ title: title0, level: 1, blocks });
    }
  } else {
    const per = doc.numPages > 60 ? 12 : 24;
    for (let i = 0; i < pageBlocks.length; i += per) {
      const group = pageBlocks.slice(i, i + per);
      const blocks = [];
      for (const pb of group) {
        blocks.push(B('page', `第 ${pb.page} 页`, { n: pb.page }));
        blocks.push(...pb.blocks);
      }
      if (blocks.length) chapters.push({ title: `第 ${group[0].page}–${group.at(-1).page} 页`, level: 1, blocks });
    }
  }

  return {
    title, author, format: 'PDF', chapters,
    meta: { pages: doc.numPages, scanned, hasFile: true },
  };
}

/** 把 PDF 文本项按坐标还原为行 */
function layoutLines(items) {
  const rows = [];
  const heights = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const h = Math.abs(it.transform?.[3] || it.height || 10);
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    heights.push(h);
    let row = rows.find(r => Math.abs(r.y - y) < Math.max(2.5, h * 0.42));
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ str: it.str, x, w: it.width || 0, h });
    row.h = Math.max(row.h || 0, h);
  }
  heights.sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  rows.sort((a, b) => b.y - a.y); // PDF 坐标自下而上
  const lines = rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    for (const it of r.items) {
      if (prev && it.x - (prev.x + prev.w) > Math.max(2, r.h * 0.28) && !/[\s\u3000]$/.test(text)) text += ' ';
      text += it.str;
      prev = it;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), y: r.y, h: r.h };
  }).filter(l => l.text);
  return { lines, medianHeight };
}

/** 行 → 段落 / 标题 */
function linesToBlocks(lines, medianHeight) {
  const blocks = [];
  const endsSentence = s => /[。．！？；：.!?;:"”』】)]\s*$/.test(s);
  const joinSpace = (a, b) => (/[A-Za-z0-9,;)]$/.test(a) && /^[A-Za-z0-9(“"']/.test(b)) ? ' ' : '';
  let para = '';
  let prevY = null;
  let prevH = 0;

  const flush = () => { if (para.trim()) blocks.push(B('p', para.trim())); para = ''; };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const next = lines[i + 1];
    const bigFont = ln.h > medianHeight * 1.22;
    const short = ln.text.length <= 34;
    const gap = prevY === null ? 0 : Math.abs(prevY - ln.y);
    const lineGap = Math.max(prevH, ln.h) * 1.75;

    if (bigFont && short && !/[。；，,]$/.test(ln.text)) {
      flush();
      blocks.push(B(ln.h > medianHeight * 1.5 ? 'h2' : 'h3', ln.text));
      prevY = ln.y; prevH = ln.h;
      continue;
    }
    if (para && gap > lineGap) flush();
    if (para.endsWith('-') && /^[a-z]/.test(ln.text)) para = para.slice(0, -1);
    para += (para ? joinSpace(para, ln.text) : '') + ln.text;
    if (endsSentence(para) && (!next || Math.abs(next.y - ln.y) > Math.max(next.h, ln.h) * 1.55 || next.h !== ln.h)) flush();
    prevY = ln.y; prevH = ln.h;
  }
  flush();
  return blocks;
}

const stripExt = name => String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || '未命名';

/** 简易 MIME 判断（用于拖拽） */
export function guessKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['pdf', 'epub', 'txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'text', 'zip'].includes(ext)) return ext;
  return '';
}

/* ---------------- 压缩包 / 文件夹：Markdown + 图片 一起导入 ---------------- */

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const DOC_RE = /\.(md|markdown)$/i;
const MIME_OF = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const mimeOf = name => MIME_OF[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const normPath = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/** 选主文档：优先根目录、名字像正文的，排除图片目录 */
function pickMainDoc(docs) {
  return docs.map(d => {
    const p = normPath(d.name);
    const base = p.toLowerCase();
    let score = 100 - p.split('/').length * 10;
    if (/content|result|output|full|book/.test(base)) score += 15;
    if (/images?\//.test(base)) score -= 50;
    return { d, score };
  }).sort((a, b) => b.score - a.score)[0].d;
}

/** 导入 zip（例如 MinerU 输出的「content.md + images/」打包） */
export async function parseBundle(file, onProgress = () => {}) {
  const zip = await window.JSZip.loadAsync(await readAsArrayBuffer(file));
  const entries = Object.values(zip.files)
    .filter(e => !e.dir)
    .filter(e => !/(^|\/)__MACOSX\//.test(e.name))
    .filter(e => !/(^|\/)\._/.test(normPath(e.name)));
  const docs = entries.filter(e => DOC_RE.test(e.name));
  const images = entries.filter(e => IMAGE_RE.test(e.name));
  if (!docs.length) throw new Error('这个压缩包里没有找到 Markdown 文件（.md）');

  const main = pickMainDoc(docs);
  const raw = decodeTextBuffer(await main.async('arraybuffer'));
  const parsed = markdownToParsed(raw, stripExt(file.name));

  const assets = [];
  for (let i = 0; i < images.length; i++) {
    onProgress({ phase: 'bundle', done: i + 1, total: images.length });
    const e = images[i];
    const blob = await e.async('blob');
    assets.push({ path: normPath(e.name), blob: blob.slice(0, blob.size, mimeOf(e.name)), type: mimeOf(e.name) });
  }
  return { ...parsed, title: parsed.title || stripExt(file.name), assets, meta: { assets: assets.length, bundled: true } };
}

/** 直接把文件夹拖进来（结构与压缩包一致） */
export async function parseFolder(fileList, onProgress = () => {}) {
  const files = Array.from(fileList);
  const pathOf = f => {
    const p = normPath(f.webkitRelativePath || f.name);
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : p;   // 去掉最外层文件夹名
  };
  const docs = files.filter(f => DOC_RE.test(f.name)).map(f => ({ name: pathOf(f), file: f }));
  const images = files.filter(f => IMAGE_RE.test(f.name));
  if (!docs.length) throw new Error('这个文件夹里没有找到 Markdown 文件（.md）');

  const main = pickMainDoc(docs);
  const raw = decodeTextBuffer(await readAsArrayBuffer(main.file));
  const parsed = markdownToParsed(raw, main.file.name.replace(DOC_RE, ''));

  const assets = [];
  for (let i = 0; i < images.length; i++) {
    onProgress({ phase: 'bundle', done: i + 1, total: images.length });
    assets.push({ path: pathOf(images[i]), blob: images[i], type: images[i].type || mimeOf(images[i].name) });
  }
  return { ...parsed, assets, meta: { assets: assets.length, bundled: true } };
}

export { uid };
