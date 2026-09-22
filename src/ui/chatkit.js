/* 聊天界面的共用零件：连接状态、Markdown 渲染、公式排版、代码块、流式请求

   为什么要单独一个文件：墨读里有两处 AI 界面 ——
   - 阅读视图右侧栏（src/ui/ai.js）：带着「选中的原文 + 所在段落 + 书名章节」问
   - 左侧栏「AI」（src/views/ai.js）：独立问答，不与书相连
   两者的渲染方式、中断处理、代码块复制必须完全一致，所以只有这一份实现。

   注意：本文件只负责「把 messages 送出去、把回来的字渲染出来」。
   messages 里装什么，由 src/core/ai.js 的两个 build* 函数决定，
   这里不碰 store，也就不可能把书里的内容掺进去。 */

import { el, esc, copyText } from '../core/utils.js';
import { parseSseChunk } from '../core/ai.js';
import { findMathRuns, renderMath } from '../reader/math.js';
import { toast } from './shell.js';

export const AI_HEADERS = { 'Content-Type': 'application/json', 'X-InkMark': '1' };

/* ---------------- 连接状态 ----------------
   页面只知道「配没配 + 用的哪个模型」，永远读不回完整 Key。 */
export let aiStatus = { configured: false, model: '' };

export async function refreshAiStatus() {
  try {
    const r = await fetch('/__ai/status', { headers: AI_HEADERS });
    aiStatus = await r.json();
  } catch {
    aiStatus = { configured: false, model: '', offline: true };
  }
  return aiStatus;
}

/* ---------------- 渲染回答：Markdown + KaTeX + 双链 ---------------- */
export function renderAnswer(text) {
  const src = String(text || '');
  let html;
  if (window.marked?.parse) {
    try { html = window.marked.parse(src, { breaks: true, gfm: true }); }
    catch { html = `<p>${esc(src)}</p>`; }
  } else html = `<p>${esc(src).replace(/\n/g, '<br>')}</p>`;
  return html.replace(/\[\[(.+?)\]\]/g,
    (_, n) => `<span class="wl" data-link="${esc(n.trim())}">${esc(n.trim())}</span>`);
}

/** 把正文里的 $...$ / $$...$$ 换成真正的数学排版 */
export function paintMath(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const runs = findMathRuns(node.data);
    if (!runs.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const r of runs) {
      if (r.start > last) frag.append(document.createTextNode(node.data.slice(last, r.start)));
      const span = document.createElement('span');
      span.className = `math-atom${r.display ? ' math-display' : ''}`;
      span.dataset.src = r.src;
      renderMath(span, r.latex, r.display);
      frag.append(span);
      last = r.end;
    }
    if (last < node.data.length) frag.append(document.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}

/** 给回答里的代码块加上语言标签与「复制」按钮 */
export function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (!pre.parentElement || pre.closest('.ai-code')) continue;
    const code = pre.querySelector('code');
    const lang = (code?.className || '').match(/language-([\w+#.-]+)/)?.[1] || '代码';
    const box = el('div', { class: 'ai-code' },
      el('div', { class: 'ai-code-bar' },
        el('span', { text: lang }),
        el('span', { class: 'spacer', style: { flex: '1' } }),
        el('button', {
          class: 'btn sm ghost', text: '复制',
          on: { click: async () => { await copyText(code?.textContent || pre.textContent || ''); toast('已复制代码', 'ok'); } },
        })));
    pre.replaceWith(box);
    box.append(pre);
  }
}

/* ---------------- 流式对话 ----------------
   这一层刻意「不抛异常」（用户中断除外也是返回值）：网络抖一下不该让整个界面中断，
   调用方拿到返回值就知道该不该把这条回答标成「没写完」。 */

/**
 * 发一次对话请求，把流式回答取回来。
 * @returns {Promise<{text:string, interrupted:boolean, aborted:boolean, error:string|null}>}
 *   text 是累积到的文本（中断时是已经收到的部分），error 非空表示这次没能问出去。
 */
export async function streamChat({ messages, signal, onDelta, stream = true }) {
  let acc = '';
  let raw = '';
  try {
    const res = await fetch('/__ai/chat', {
      method: 'POST', headers: AI_HEADERS, signal,
      body: JSON.stringify({ messages, stream }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      return { text: '', interrupted: true, aborted: false, error: e.error || `请求失败（HTTP ${res.status}）` };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = dec.decode(value, { stream: true });
      raw += piece;
      const add = parseSseChunk(piece);
      if (!add) continue;
      acc += add;
      onDelta?.(acc, add);
    }
    // 服务端在「上游断流」时会补这个标记再收尾（见 server.mjs 的 proxyChat）
    return { text: acc, interrupted: raw.includes('"inkmark":"aborted"'), aborted: false, error: null };
  } catch (e) {
    if (e?.name === 'AbortError') return { text: acc, interrupted: true, aborted: true, error: null };
    return { text: acc, interrupted: true, aborted: false, error: `连接中断：${e.message}` };
  }
}
