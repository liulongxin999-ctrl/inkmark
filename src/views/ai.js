/* 独立 AI 工作台（左侧栏「AI」）：像通用聊天助手那样问答，跟书里的内容没有半点关系

   墨读里有两个 AI 入口，分工是刻意分开的：
   - 阅读视图的右侧栏（src/ui/ai.js）：带着「选中的原文 + 所在段落 + 书名章节」问，
     回答能一键接回术语、笔记和复习队列
   - 这里：只把你在输入框里写下的字发出去，书、批注、笔记一个字节都不发，
     所以它才能当成一台通用助手来用

   隐私红线：本模块只调用 core/ai.js 的 buildChatRequest()。
   它不读 state.selectionRef / state.chapter / state.terms —— 拿不到，就发不出去。 */

import { $, el, svg, ICONS, relTime, setChildren, copyText } from '../core/utils.js';
import store from '../core/store.js';
import { toast, confirmDialog, promptDialog } from '../ui/shell.js';
import { buildChatRequest } from '../core/ai.js';
import { aiStatus, renderAnswer, paintMath, decorateCode, streamChat } from '../ui/chatkit.js';
import { resolveWikiLink } from './notes.js';

/** 空对话里的起手式：点一下填进输入框，**不会自动发送** */
const SUGGESTS = [
  { title: '解释一个概念', hint: '把不懂的词丢给我', text: '用简单的话解释：' },
  { title: '整理成要点', hint: '长文 → 清单', text: '把下面的内容整理成要点：\n' },
  { title: '润色一段文字', hint: '改掉生硬的句子', text: '帮我润色下面这段文字，让它更通顺自然：\n' },
  { title: '写一段代码', hint: '带注释与边界处理', text: '用 Python 写一段代码，实现：' },
  { title: '翻译成英文', hint: '中英互译', text: '把下面这段翻译成地道的英文：\n' },
  { title: '帮我权衡利弊', hint: '列出取舍与风险', text: '我在这两件事之间犹豫，帮我分析利弊再给建议：\n' },
];

let openChatId = null;   // 当前打开的会话；null = 新对话（欢迎页）
let draft = '';          // 输入框草稿：整块重绘也不会把它冲掉
let query = '';          // 会话列表搜索
let chatting = false;
let abortCtrl = null;
let streamEl = null;
let streamAt = 0;
let wantFocus = false;   // 发完消息/点完建议后，重绘完把光标放回输入框

export function initAiPage() {
  // 进入这个视图由 main.js 的路由统一触发；这里只管「内容变了要重画」
  store.bus.on('chats', () => renderAiPage());
  store.bus.on('aiStatus', () => renderAiPage());
}

export function renderAiPage(host = $('#view-ai')) {
  if (!host || store.state.route !== 'ai') return;
  const hadFocus = !!document.activeElement?.classList?.contains('ai-page-input');
  const chats = store.standaloneChats();
  let chat = openChatId ? store.chatById(openChatId) : null;
  if (chat && !chats.some(c => c.id === chat.id)) chat = null;
  openChatId = chat?.id || null;

  const input = composer();
  setChildren(host, el('div', { class: 'ai-page' },
    sideColumn(chats, chat),
    el('div', { class: 'ai-page-main' },
      mainHead(chat),
      el('div', { class: 'ai-page-scroll', id: 'ai-page-scroll' },
        el('div', { class: 'ai-page-thread', id: 'ai-page-thread' }, ...threadBody(chat))),
      input.wrap,
    ),
  ));

  const box = $('#ai-page-scroll');
  if (box) box.scrollTop = box.scrollHeight;
  if (hadFocus || wantFocus) {
    wantFocus = false;
    input.node.focus();
    input.node.setSelectionRange(input.node.value.length, input.node.value.length);
  }
  autosize(input.node);
}

/* ---------------- 左栏：会话列表 ---------------- */
function sideColumn(chats, chat) {
  const q = query.trim().toLowerCase();
  const list = q
    ? chats.filter(c => `${c.title} ${c.messages.map(m => m.text).join(' ')}`.toLowerCase().includes(q))
    : chats;

  const search = el('input', {
    class: 'input ai-page-search', placeholder: '搜索对话…', value: query,
    on: {
      input: e => {
        query = e.target.value;
        renderAiPage();
        const box = $('.ai-page-search');
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      },
    },
  });

  return el('div', { class: 'ai-page-side' },
    el('div', { class: 'ai-page-side-head' },
      el('div', { class: 'ai-page-brand' },
        svg(ICONS.spark),
        el('span', { text: 'AI 助手' }),
        el('span', { class: 'pill', text: '独立' })),
      el('button', { class: 'btn primary ai-new-chat', on: { click: newChat } },
        svg(ICONS.plus), '新建对话'),
    ),
    search,
    el('div', { class: 'ai-page-list' },
      ...(list.length ? groupedChats(list, chat) : [
        el('div', { class: 'small muted', style: { padding: '10px 8px' }, text: q ? '没有匹配的对话' : '还没有对话。右边直接开问吧。' }),
      ])),
    el('div', { class: 'ai-page-side-foot small muted' },
      '对话只存在这台电脑上。这里的 AI 读不到你的书、批注与笔记。'),
  );
}

/** 按「今天 / 昨天 / 过去 7 天 / 更早」分组，列表长了也找得到 */
function groupedChats(list, chat) {
  const out = [];
  let last = '';
  for (const c of list) {
    const label = dayLabel(c.updatedAt || c.createdAt);
    if (label !== last) { last = label; out.push(el('div', { class: 'ai-group', text: label })); }
    out.push(el('div', {
      class: `ai-page-item${c.id === chat?.id ? ' active' : ''}`,
      dataset: { chatId: c.id },
      on: { click: () => { openChatId = c.id; renderAiPage(); } },
    },
      el('span', { class: 't', text: c.title || '新对话' }),
      el('button', {
        class: 'icon-btn danger', title: '删除这条对话',
        on: {
          click: async e => {
            e.stopPropagation();
            if (!await confirmDialog({ title: '删除对话', message: `删除「${c.title || '新对话'}」？这段聊天记录会消失。` })) return;
            if (openChatId === c.id) openChatId = null;
            await store.removeChat(c.id);
          },
        },
      }, svg(ICONS.trash)),
    ));
  }
  return out;
}

function dayLabel(ts) {
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const now = new Date();
  const d = new Date(ts || Date.now());
  if (same(d, now)) return '今天';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (same(d, y)) return '昨天';
  if (now - d < 7 * 86400000) return '过去 7 天';
  return '更早';
}

/* ---------------- 右栏：标题栏 + 对话区 + 输入框 ---------------- */
function mainHead(chat) {
  return el('div', { class: 'ai-page-head' },
    el('div', { class: 'ai-page-title', text: chat ? (chat.title || '新对话') : '新对话' }),
    chat ? el('span', { class: 'small muted', text: relTime(chat.updatedAt) }) : null,
    el('div', { class: 'spacer', style: { flex: '1' } }),
    el('span', { class: 'pill', title: '模型', text: aiStatus.model || '' }),
    chat ? el('button', {
      class: 'icon-btn', title: '重命名',
      on: {
        click: async () => {
          const name = await promptDialog({ title: '重命名对话', value: chat.title || '' });
          if (name === null) return;
          await store.saveChat({ id: chat.id, title: name.trim().slice(0, 40) || '新对话' });
        },
      },
    }, svg(ICONS.edit)) : null,
    chat ? el('button', {
      class: 'icon-btn danger', title: '删除这条对话',
      on: {
        click: async () => {
          if (!await confirmDialog({ title: '删除对话', message: `删除「${chat.title || '新对话'}」？这段聊天记录会消失。` })) return;
          openChatId = null;
          await store.removeChat(chat.id);
        },
      },
    }, svg(ICONS.trash)) : null,
  );
}

function threadBody(chat) {
  if (aiStatus.offline) {
    return [el('div', { class: 'ai-welcome' },
      el('div', { class: 'ai-welcome-mark', text: 'AI' }),
      el('h2', { text: 'AI 助手需要本地服务' }),
      el('p', { class: 'small muted', text: '请用「启动.bat」打开墨读，不要直接双击 index.html。' }))];
  }
  if (!aiStatus.configured) {
    return [el('div', { class: 'ai-welcome' },
      el('div', { class: 'ai-welcome-mark', text: 'AI' }),
      el('h2', { text: '还没有连接 AI 助手' }),
      el('p', { class: 'small muted', text: '墨读自己不提供模型：在设置里填入你自己的 DeepSeek API Key 就能用。不配置时，墨读不会产生任何外部请求。' }),
      el('div', { style: { marginTop: '16px' } },
        el('button', { class: 'btn primary', text: '去设置', on: { click: () => store.go('settings') } })))];
  }
  if (!chat || !chat.messages.length) return [welcome()];

  const out = [];
  chat.messages.forEach((m, i) => out.push(messageEl(m, i === chat.messages.length - 1)));
  if (chatting) {
    streamEl = el('div', { class: 'ai-msg role-assistant streaming' });
    out.push(streamEl);
  } else streamEl = null;
  return out;
}

function welcome() {
  return el('div', { class: 'ai-welcome' },
    el('div', { class: 'ai-welcome-mark', text: 'AI' }),
    el('h2', { text: '想聊点什么？' }),
    el('p', { class: 'small muted', text: '这里的 AI 是独立的：它读不到你的书、批注和笔记，你写什么它就只看到什么。' }),
    el('div', { class: 'ai-suggests' },
      ...SUGGESTS.map(s => el('button', {
        class: 'ai-suggest',
        on: { click: () => useSuggest(s.text) },
      },
        el('b', { text: s.title }),
        el('span', { class: 'small muted', text: s.hint })))),
  );
}

function messageEl(m, isLast) {
  if (m.role === 'user') {
    const node = el('div', { class: 'ai-msg role-user' },
      el('div', { class: 'ai-text', text: m.text }));
    // 上一条问题还没等到回答（比如网络断了）：给一个「重新发送」，不必重打一遍
    if (isLast && !chatting && aiStatus.configured) {
      node.append(el('div', { class: 'ai-actions' },
        el('button', { class: 'btn sm ghost', text: '重新发送', on: { click: () => regenerate() } })));
    }
    return node;
  }
  const body = el('div', { class: 'ai-text' });
  body.innerHTML = renderAnswer(m.text);
  paintMath(body);
  decorateCode(body);
  bindLinks(body);
  const node = el('div', { class: 'ai-msg role-assistant' }, body);
  if (m.interrupted) {
    node.append(el('div', { class: 'ai-warn small', text: '⚠ 这条回答没写完（连接中断，或你点了停止）。' }));
  }
  if (m.done) node.append(actionsEl(m, isLast));
  return node;
}

function bindLinks(root) {
  root.addEventListener('click', e => {
    const wl = e.target.closest?.('.wl');
    if (!wl) return;
    // 双链指向术语/笔记时，先回到阅读视图，那边的右侧栏才接得住
    if (store.state.bookId && store.state.route !== 'reader') store.go('reader');
    resolveWikiLink(wl.dataset.link);
  });
}

function actionsEl(m, isLast) {
  return el('div', { class: 'ai-actions' },
    el('button', { class: 'btn sm ghost', text: '复制', on: { click: async () => { await copyText(m.text); toast('已复制', 'ok'); } } }),
    el('button', {
      class: 'btn sm ghost', text: '存入笔记',
      on: {
        click: async () => {
          await store.saveNote({
            kind: 'ai', status: 'inbox',
            title: (String(m.text).split('\n')[0] || 'AI 回答').slice(0, 24),
            body: m.text, quote: '',
            bookId: null, chapterId: null, blockId: null, bookTitle: '',
          });
          toast('已存入笔记工作台', 'ok');
        },
      },
    }),
    isLast && !chatting && aiStatus.configured
      ? el('button', { class: 'btn sm ghost', text: '重新生成', on: { click: () => regenerate() } })
      : null,
  );
}

/* ---------------- 输入框 ---------------- */
function composer() {
  const node = el('textarea', {
    class: 'ai-page-input', rows: 1, placeholder: '给 AI 发消息…', value: draft,
    on: {
      input: () => { draft = node.value; autosize(node); },
      keydown: e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(draft); }
      },
    },
  });
  const btn = chatting
    ? el('button', { class: 'btn primary ai-send', text: '停止', on: { click: () => abortCtrl?.abort() } })
    : el('button', { class: 'btn primary ai-send', text: '发送', on: { click: () => send(draft) } });

  const hideComposer = aiStatus.offline || !aiStatus.configured;
  const wrap = hideComposer ? el('div', { hidden: true }) : el('div', { class: 'ai-page-compose' },
    el('div', { class: 'ai-compose-box' }, node, btn),
    el('div', { class: 'ai-page-hint small muted' },
      el('span', { text: 'Enter 发送 · Shift+Enter 换行' }),
      el('span', { class: 'spacer', style: { flex: '1' } }),
      el('span', { title: '这里只发送你写下的内容', text: '只发送你写下的内容' })),
  );
  return { wrap, node };
}

function autosize(node) {
  if (!node?.style) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight || 24, 220)}px`;
}

function useSuggest(text) {
  draft = text;
  renderAiPage();
  const node = $('.ai-page-input');
  if (node) { node.focus(); node.setSelectionRange(node.value.length, node.value.length); autosize(node); }
}

function newChat() {
  openChatId = null;
  draft = '';
  renderAiPage();
  $('.ai-page-input')?.focus();
}

/* ---------------- 发送 / 重新生成 ---------------- */
async function send(text) {
  const q = String(text ?? '').trim();
  if (chatting || !q) return;
  wantFocus = true;
  let chat = openChatId ? store.chatById(openChatId) : null;
  if (!chat) {
    chat = await store.saveChat({ kind: 'general', title: q.slice(0, 18), bookId: null, bookTitle: '' });
    openChatId = chat.id;
  }
  const history = chat.messages.map(m => ({ role: m.role, content: m.text }));
  await store.appendMessage(chat.id, { role: 'user', text: q });
  draft = '';
  await runCompletion(chat.id, { history, question: q });
}

/** 「重新生成」：去掉最后一条回答，拿同一个问题再问一次 */
async function regenerate() {
  const chat = openChatId ? store.chatById(openChatId) : null;
  if (!chat || chatting) return;
  wantFocus = true;
  const msgs = [...chat.messages];
  if (msgs.at(-1)?.role === 'assistant') msgs.pop();
  const lastUser = msgs.at(-1);
  if (!lastUser || lastUser.role !== 'user') return;
  await store.replaceMessages(chat.id, msgs);
  await runCompletion(chat.id, {
    history: msgs.slice(0, -1).map(m => ({ role: m.role, content: m.text })),
    question: lastUser.text,
  });
}

async function runCompletion(chatId, { history, question }) {
  const { messages } = buildChatRequest({ history, question });
  chatting = true;
  renderAiPage();
  abortCtrl = new AbortController();
  const r = await streamChat({
    messages, signal: abortCtrl.signal,
    onDelta: text => paintStreaming(text),
  });
  chatting = false; abortCtrl = null; streamEl = null;
  if (r.error) toast(r.error, 'err', 5000);
  if (r.text.trim()) {
    await store.appendMessage(chatId, {
      role: 'assistant', text: r.text, model: aiStatus.model,
      done: true, interrupted: r.interrupted,
    });
  }
  renderAiPage();
}

/**
 * 流式输出时只改这一个节点，绝不整块重绘（否则会闪烁、还会弄丢输入框里的字）。
 * 节点内部照常走 Markdown + 公式 + 代码块，否则要等流结束才排版，结尾会「跳」一下。
 * 每片都重解析太费，节流到 90ms 一次；最后一片由 runCompletion 里的 renderAiPage() 兜底。
 */
function paintStreaming(text) {
  if (!streamEl) return;
  const now = Date.now();
  if (now - streamAt < 90) return;
  streamAt = now;
  const box = $('#ai-page-scroll');
  const stick = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const body = el('div', { class: 'ai-text' });
  body.innerHTML = renderAnswer(text);
  paintMath(body);
  decorateCode(body);
  streamEl.replaceChildren(body);
  if (box && stick) box.scrollTop = box.scrollHeight;
}
