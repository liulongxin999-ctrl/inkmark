/* AI 面板：会话列表 + 对话区

   隐私相关（不要为了「效果更好」放宽）：
   - 点「问 AI」只把内容填进输入框，绝不自动发送
   - 发送前有「本次将发送」逐字预览
   - 实际发出去的内容由 src/core/ai.js 的 buildRequest 决定 */

import { $, el, svg, ICONS, esc, relTime, setChildren, copyText, debounce } from '../core/utils.js';
import store from '../core/store.js';
import { toast, promptDialog, confirmDialog, openTermEditor } from './shell.js';
import { buildRequest, requestChars, extractTerm, parseSseChunk } from '../core/ai.js';
import { findMathRuns, renderMath } from '../reader/math.js';
import { jumpTo } from '../reader/reader.js';

export const AI_HEADERS = { 'Content-Type': 'application/json', 'X-InkMark': '1' };

let activeChatId = null;
let chatting = false;
let abortCtrl = null;
let aiStatus = { configured: false, model: '' };
let pending = '';          // 从正文/术语带过来的问题草稿，等用户确认再发
let streamBuf = '';        // 流式输出的累积文本
let streamEl = null;       // 流式输出时正在写的那个节点

const isAiOpen = () => store.state.asideOpen && store.state.asideTab === 'ai';

export async function refreshAiStatus() {
  try {
    const r = await fetch('/__ai/status', { headers: AI_HEADERS });
    aiStatus = await r.json();
  } catch {
    aiStatus = { configured: false, model: '', offline: true };
  }
  store.bus.emit('aiStatus');
  return aiStatus;
}

export function setPending(q) { pending = String(q || ''); }

export function initAi() {
  store.bus.on('chats', () => { if (isAiOpen()) renderAi(); });
  store.bus.on('aiStatus', () => { if (isAiOpen()) renderAi(); });
  store.bus.on('aiAsk', q => { if (q) { setPending(q); if (isAiOpen()) renderAi(); } });
  store.bus.on('route', () => { if (isAiOpen()) renderAi(); });
  refreshAiStatus();
}

export function renderAi(host = $('#aside-body')) {
  if (!host) return;
  if (aiStatus.offline) return renderOffline(host);
  if (!aiStatus.configured) return renderSetupGuide(host);
  renderChats(host);
}

/* ---------------- 两种提示态 ---------------- */
function renderOffline(host) {
  setChildren(host, el('div', { class: 'empty' },
    el('div', { class: 'big', text: 'AI' }),
    el('div', { text: 'AI 助手需要本地服务' }),
    el('div', { class: 'small', style: { marginTop: '8px' } },
      '请用「启动.bat」打开墨读，不要直接双击 index.html。'),
  ));
}

function renderSetupGuide(host) {
  setChildren(host, el('div', { class: 'empty' },
    el('div', { class: 'big', text: 'AI' }),
    el('div', { text: '还没有连接 AI 助手' }),
    el('div', { class: 'small', style: { marginTop: '8px' } },
      '需要先在设置里填入你自己的 DeepSeek API Key。'),
    el('div', { class: 'small', style: { marginTop: '6px' } },
      '开启后，每次提问会把「选中的原文 + 所在段落 + 书名章节」发给你配置的服务商。'),
    el('div', { style: { marginTop: '12px' } },
      el('button', { class: 'btn primary', text: '去设置', on: { click: () => store.go('settings') } })),
  ));
}

/* ---------------- 主面板 ---------------- */
function renderChats(host) {
  const chats = store.chatsSorted();
  const chat = store.chatById(activeChatId) || chats[0] || null;
  activeChatId = chat?.id || null;

  const list = el('div', { class: 'ai-chats' },
    ...(chats.length
      ? chats.map(c => el('div', {
        class: `ai-chat-item${c.id === activeChatId ? ' active' : ''}`,
        dataset: { chatId: c.id },
        on: { click: () => { activeChatId = c.id; renderAi(); } },
      },
        el('span', { class: 't', text: c.title || '新对话' }),
        el('span', { class: 'k', text: c.kind === 'reading' ? (c.bookTitle || '本书') : '通用' }),
        el('button', {
          class: 'icon-btn danger', title: '删除这条对话',
          on: {
            click: async e => {
              e.stopPropagation();
              if (!await confirmDialog({ title: '删除对话', message: `删除「${c.title || '新对话'}」？这段聊天记录会消失。` })) return;
              if (activeChatId === c.id) activeChatId = null;
              await store.removeChat(c.id);
            },
          },
        }, svg(ICONS.trash)),
      ))
      : [el('div', { class: 'small muted', style: { padding: '10px 4px' }, text: '还没有对话。在下面输入框里问第一个问题吧。' })]),
  );

  const thread = el('div', { class: 'ai-thread', id: 'ai-thread' });
  if (chat) {
    for (const m of chat.messages) thread.append(messageEl(m));
    if (chatting) {
      streamEl = el('div', { class: 'ai-msg role-assistant streaming' });
      thread.append(streamEl);
    } else streamEl = null;
  } else streamEl = null;

  const input = el('textarea', {
    class: 'input ai-input', rows: 2,
    placeholder: aiStatus.model ? `问点什么…（${aiStatus.model}）` : '问点什么…',
    value: pending,
    on: { input: () => { pending = input.value; } },
  });
  const btn = chatting
    ? el('button', { class: 'btn sm', text: '停止', on: { click: () => abortCtrl?.abort() } })
    : el('button', { class: 'btn sm primary', text: '发送', on: { click: () => send(input.value) } });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });

  setChildren(host,
    el('div', { class: 'ai-wrap' },
      el('div', { class: 'ai-bar' },
        el('button', {
          class: 'btn sm', text: '＋ 新对话',
          on: { click: () => { activeChatId = null; pending = ''; renderAi(); } },
        }),
        el('span', { class: 'spacer', style: { flex: '1' } }),
        el('span', { class: 'small muted', text: aiStatus.model || '' }),
      ),
      list,
      thread,
      previewEl(),
      el('div', { class: 'ai-input-row' }, input, btn),
    ),
  );

  const box = $('#ai-thread');
  if (box) box.scrollTop = box.scrollHeight;
  if (pending && !chatting) setTimeout(() => input.focus(), 40);
}

/* ---------------- 单条消息 ---------------- */
function messageEl(m) {
  const own = el('div', { class: `ai-msg role-${m.role}` });
  if (m.role === 'user') {
    if (m.quoted?.quote) own.append(quoteEl(m));
    own.append(el('div', { class: 'ai-text', text: m.text }));
    return own;
  }
  const body = el('div', { class: 'ai-text' });
  body.innerHTML = renderAnswer(m.text);
  paintMath(body);
  bindAnswerLinks(body);
  own.append(body);
  if (m.done && String(m.text || '').trim()) own.append(actionsEl(m));
  return own;
}

function quoteEl(m) {
  return el('div', {
    class: 'ai-quote', title: '回到原文',
    on: {
      click: () => {
        if (!m.quoted?.blockId) return;
        const chapterId = store.state.chapters.find(c => c.title === m.quoted.chapterTitle)?.id
          || store.state.chapter?.id;
        jumpTo({ chapterId, blockId: m.quoted.blockId });
      },
    },
  },
    el('div', { class: 'small muted', text: m.quoted?.chapterTitle || '' }),
    m.quoted?.quote || '',
  );
}

function actionsEl(m) {
  return el('div', { class: 'ai-actions' },
    el('button', {
      class: 'btn sm', text: '设为术语',
      on: {
        click: async () => {
          const { name, definition } = extractTerm(m.text);
          if (!name) return toast('这条回答里没提取到术语名', 'err');
          await openTermEditor({ name, definition, bookId: store.state.bookId, isNew: true });
          toast('已建立术语，全书自动高亮', 'ok');
        },
      },
    }),
    el('button', {
      class: 'btn sm', text: '存入笔记',
      on: {
        click: async () => {
          const q = m.quoted || {};
          await store.saveNote({
            kind: 'ai', status: 'inbox',
            title: (String(m.text).split('\n')[0] || 'AI 回答').slice(0, 24),
            body: m.text, quote: q.quote || '',
            bookId: store.state.bookId || null,
            chapterId: store.state.chapter?.id || null,
            blockId: q.blockId || null,
            bookTitle: store.state.book?.title || '',
          });
          toast('已存入笔记工作台', 'ok');
        },
      },
    }),
    el('button', { class: 'btn sm ghost', text: '复制', on: { click: async () => { await copyText(m.text); toast('已复制', 'ok'); } } }),
  );
}

/* ---------------- 渲染回答：Markdown + KaTeX + 双链 ---------------- */
function renderAnswer(text) {
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
function paintMath(root) {
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

function bindAnswerLinks(root) {
  root.addEventListener('click', async e => {
    const wl = e.target.closest?.('.wl');
    if (!wl) return;
    const name = wl.dataset.link;
    const term = store.state.terms.find(t => t.name === name || (t.aliases || []).includes(name));
    if (term) return store.openAside('term', { focusTermId: term.id });
    const note = store.state.notes.find(n => n.title === name);
    if (note) { store.go('notes'); store.bus.emit('openNote', note.id); return; }
    toast(`找不到「${name}」`, 'err');
  });
}

/* ---------------- 「本次将发送」预览 ---------------- */
function previewEl() {
  const { messages, preview } = buildRequest({
    book: store.state.book, chapter: store.state.chapter,
    selection: store.state.selectionRef || null,
    terms: store.termsFor(store.state.bookId), ui: store.ui,
    history: [], question: pending || '（还没输入问题）',
    level: store.ui.aiCtxLevel || 'brief',
  });
  const detail = el('pre', { class: 'ai-preview-body', style: { display: 'none' }, text: preview });
  return el('div', { class: 'ai-preview' },
    el('div', {
      class: 'ai-preview-head',
      on: { click: () => { detail.style.display = detail.style.display === 'none' ? '' : 'none'; } },
    },
      el('span', {
        text: `本次将发送：${store.ui.aiCtxLevel === 'chapter' ? '本章' : '精简'}档 · 约 ${requestChars(messages)} 字`
          + (store.state.selectionRef ? ' · 含选中原文' : ''),
      }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('span', { text: '展开' }),
    ),
    detail,
  );
}

/* ---------------- 发送与流式 ---------------- */
async function send(question) {
  const q = String(question || '').trim();
  if (chatting || !q) return;

  const sel = store.state.selectionRef || null;
  let chat = store.chatById(activeChatId);
  if (!chat) {
    chat = await store.saveChat({
      kind: store.state.bookId ? 'reading' : 'general',
      title: q.slice(0, 18),
      bookId: store.state.bookId || null,
      bookTitle: store.state.book?.title || '',
    });
    activeChatId = chat.id;
  }

  const quoted = sel ? {
    blockId: sel.blockId, quote: sel.quote,
    chapterTitle: store.state.chapter?.title || '',
  } : null;
  await store.appendMessage(chat.id, { role: 'user', text: q, quoted });

  const { messages } = buildRequest({
    book: store.state.book, chapter: store.state.chapter, selection: sel,
    terms: store.termsFor(store.state.bookId), ui: store.ui,
    history: chat.messages.map(m => ({ role: m.role, content: m.text })),
    question: q, level: store.ui.aiCtxLevel || 'brief',
  });

  // 选段是「一次性」的：已经随这条消息发出去了，立刻清掉。
  // 不清的话，同一会话里问第二遍会把上一段原文再发一次，而界面上看不出来。
  store.state.selectionRef = null;

  chatting = true; pending = ''; streamBuf = '';
  renderAi();
  abortCtrl = new AbortController();
  let acc = '';
  try {
    const res = await fetch('/__ai/chat', {
      method: 'POST', headers: AI_HEADERS, signal: abortCtrl.signal,
      body: JSON.stringify({ messages, stream: true }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      toast(e.error || `请求失败（HTTP ${res.status}）`, 'err', 5000);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += parseSseChunk(dec.decode(value, { stream: true }));
      paintStreaming(acc);
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast(`连接中断：${e.message}`, 'err', 5000);
  } finally {
    chatting = false; abortCtrl = null;
    if (acc.trim()) {
      await store.appendMessage(chat.id, {
        role: 'assistant', text: acc, quoted, model: aiStatus.model, done: true,
      });
    }
    renderAi();
  }
}

let streamAt = 0;

/** 流式输出时只改这一个节点，绝不整块重绘（否则会闪烁、还会弄丢输入框光标）。
    但节点内部照常走 Markdown + 公式渲染，否则等流结束才排版，结尾会「跳」一下。
    每片都重解析太费，节流到 90ms 一次；最后一片由 finally 里的 renderAi() 兜底。 */
function paintStreaming(text) {
  streamBuf = text;
  if (!streamEl) return;
  const now = Date.now();
  if (now - streamAt < 90) return;
  streamAt = now;
  const body = el('div', { class: 'ai-text' });
  body.innerHTML = renderAnswer(text);
  paintMath(body);
  streamEl.replaceChildren(body);
  const box = $('#ai-thread');
  if (box) box.scrollTop = box.scrollHeight;
}
