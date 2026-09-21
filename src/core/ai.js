/* AI 请求组装：纯函数，决定了「什么会被发到外网」

   隐私红线（任何改动都不得突破）：
   - 默认只发：书名、章节标题、选中原文、所在段落、相关术语的「定义」
   - 默认绝不发：批注、笔记、术语的「我的理解」、其他书籍
   这些约束由 tests/selftest.js 的用例钉住，不要为了「效果更好」而放宽。 */

const trim = s => String(s || '').trim();

/** 选中内容所在块的完整文本 */
export function blockText(chapter, blockId) {
  const b = chapter?.blocks?.find(x => x.id === blockId);
  return b ? trim(b.x) : '';
}

/** 当前章节的完整文字 */
export function chapterText(chapter) {
  return (chapter?.blocks || []).map(b => trim(b.x)).filter(Boolean).join('\n\n');
}

/** 文本里出现了哪些术语；只取定义，绝不带「我的理解」 */
export function relatedTerms(text, terms) {
  const t = String(text || '');
  return (terms || [])
    .filter(x => x?.name && x.definition && t.includes(x.name))
    .map(x => `- ${x.name}：${trim(x.definition)}`);
}

export function systemPrompt(book, chapter) {
  const lines = [
    '你是墨读里的阅读助手，帮读者理解正在读的内容。',
    '回答要准确、简洁，优先解释清楚概念与推导过程。',
    '数学公式请用 LaTeX（行内用 $...$，独立成行用 $$...$$）。',
  ];
  const where = [book?.title, chapter?.title].map(trim).filter(Boolean).join(' · ');
  if (where) lines.push(`读者当前正在读：${where}`);
  return lines.join('\n');
}

/**
 * 组装一次请求。
 * @returns {{ messages: Array<{role:string,content:string}>, preview: string, chars: number }}
 *   preview 供界面上「本次将发送」预览使用。
 */
export function buildRequest({ book, chapter, selection, terms = [], ui = {}, history = [], question = '', level = 'brief' }) {
  const quoted = trim(selection?.quote);
  const para = selection?.blockId ? blockText(chapter, selection.blockId) : '';

  const ctx = [];
  if (quoted) ctx.push(`我选中的原文：\n${quoted}`);
  if (para && para !== quoted) ctx.push(`它所在的完整段落：\n${para}`);
  if (level === 'chapter') {
    const full = chapterText(chapter);
    if (full && full !== para) ctx.push(`本章完整内容：\n${full}`);
  }

  let termBlock = '';
  if (ui.aiIncludeTerms !== false) {
    const hit = relatedTerms(`${quoted}\n${para}`, terms);
    if (hit.length) termBlock = `本书中相关术语的定义（供你参考）：\n${hit.join('\n')}`;
  }

  const parts = [ctx.join('\n\n'), termBlock].filter(Boolean);
  const userContent = parts.length ? `${parts.join('\n\n')}\n\n我的问题：${question}` : question;

  const messages = [
    { role: 'system', content: systemPrompt(book, chapter) },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  return { messages, preview: userContent, chars: requestChars(messages) };
}

/** 一次请求发送的字数，用于界面显示体量 */
export const requestChars = messages =>
  (messages || []).reduce((n, m) => n + String(m.content || '').length, 0);

/** 解析 SSE 分片，返回本次新增的文本。坏分片直接丢弃，绝不抛错。 */
export function parseSseChunk(buf) {
  let out = '';
  for (const line of String(buf || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      out += j.choices?.[0]?.delta?.content || '';
    } catch { /* 不完整分片，丢弃 */ }
  }
  return out;
}

/** 从一段回答里猜出术语名与定义，用于预填术语编辑器 */
export function extractTerm(text) {
  const raw = trim(text);
  if (!raw) return { name: '', definition: '' };
  const heading = raw.match(/^#{1,4}\s*(.+)$/m);
  const bold = raw.match(/\*\*(.+?)\*\*/);
  const name = (heading?.[1] || bold?.[1] || raw.split(/[\n。！？]/)[0] || '').trim().slice(0, 30);
  const body = raw.replace(/^#{1,4}\s*.+$/m, '').trim();
  const definition = (body.split(/\n\s*\n/).find(p => p.trim()) || body).trim().slice(0, 300);
  return { name, definition };
}
