/* 测试与截图共用的富内容样例：带公式、插图、图注的 Markdown（打包成 zip） */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

const crc32 = buf => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** 生成一张真 PNG（用于验证"图片真的显示出来了"） */
export function makePng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (r + x * 3) % 256; raw[o + 1] = (g + y * 3) % 256; raw[o + 2] = b;   // 渐变，便于肉眼确认
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PNG_W = 60, PNG_H = 40;
export const pngBase64 = makePng(PNG_W, PNG_H, [180, 70, 50]).toString('base64');

export const RICH_MD = [
  '# 第二章 性能指标',
  '',
  '发送时延的计算公式是 $\\frac{L}{R}$，其中 L 为数据块长度，R 为信道带宽。',
  '',
  '总时延由四部分组成：',
  '',
  '$$\\text{总时延} = \\frac{L}{R} + \\frac{d}{v} + \\frac{p}{R} + t_{proc}$$',
  '',
  '下图展示了分组交换的过程：',
  '',
  '![分组交换示意图](images/topology.png)',
  '',
  '从图中可以看到，报文被切分成若干分组，各自独立选择路径。',
  '',
  '## 2.1 速率与带宽',
  '',
  '速率指每秒传送的比特数，单位是 $bit/s$，也可以写成 $10^8\\ bit/s$。',
].join('\n');

/** 在页面里构造并投递 zip 的表达式（依赖页面已加载 JSZip） */
export function richZipExpression(fileName = '第2章-带插图.zip') {
  return `(async () => {
    const zip = new JSZip();
    zip.file('content.md', ${JSON.stringify(RICH_MD)});
    zip.file('images/topology.png', ${JSON.stringify(pngBase64)}, { base64: true });
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], ${JSON.stringify(fileName)}, { type: 'application/zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#view-library input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}
