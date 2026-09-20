/* 数学公式：把文本里的 $...$ / $$...$$ / \(...\) / \[...\] 变成真正的排版公式

   设计要点：公式在正文里是「原子单元」——
   渲染后它占一个整体，可以整条选中、高亮、批注，但不能在公式内部逐字划线。 */

const PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

/** 找出文本里所有公式区间（按出现顺序，互不重叠） */
export function findMathRuns(text) {
  const runs = [];
  if (!text || (!text.includes('$') && !text.includes('\\(') && !text.includes('\\['))) return runs;
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(text))) {
    const display = !!(m[1] || m[2]);             // $$...$$ 和 \[...\] 是独立成行的公式
    const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    if (!body.trim()) { if (m.index === PATTERN.lastIndex) PATTERN.lastIndex++; continue; }
    runs.push({ start: m.index, end: m.index + m[0].length, src: m[0], latex: body, display });
    if (m.index === PATTERN.lastIndex) PATTERN.lastIndex++;
  }
  return runs;
}

export const hasMath = text => findMathRuns(text).length > 0;

/** 把 LaTeX 渲染进指定元素；失败时退回显示原文，绝不让页面崩掉 */
export function renderMath(el, latex, display = false) {
  const katex = window.katex;
  if (!katex?.render) { el.textContent = display ? `$$${latex}$$` : `$${latex}$`; return false; }
  try {
    katex.render(latex, el, {
      displayMode: !!display,
      throwOnError: false,
      errorColor: 'var(--danger)',
      strict: false,
      trust: false,
      output: 'html',
    });
    return true;
  } catch {
    el.textContent = display ? `$$${latex}$$` : `$${latex}$`;
    return false;
  }
}
