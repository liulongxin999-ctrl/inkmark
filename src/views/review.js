/* 间隔复习：正面提问 → 翻面看答案 → 自评安排下次 */

import { $, el, svg, ICONS, relTime, setChildren } from '../core/utils.js';
import store from '../core/store.js';
import { renderMarkdown } from './notes.js';

let queue = [];
let flipped = false;
let done = 0;
let current = null;

export function initReview() {
  store.bus.on('route', ({ route }) => { if (route === 'review') startReview(); });
  store.bus.on('terms', () => { if (store.state.route === 'review') renderReview(); });
  store.bus.on('notes', () => { if (store.state.route === 'review') renderReview(); });
}

export function startReview() {
  queue = store.dueCards().sort(() => Math.random() - 0.5);
  done = 0;
  current = queue.shift() || null;
  flipped = false;
  renderReview();
}

function renderReview() {
  const host = $('#view-review');
  const totalLearned = store.state.terms.length + store.state.notes.length;

  if (!current) {
    setChildren(host, el('div', { class: 'review-wrap' },
      el('div', { class: 'review-stage' },
        el('div', { class: 'review-card' },
          el('div', { class: 'rc-kind', text: '复习完成' }),
          el('div', { class: 'rc-q', text: done ? `今天复习了 ${done} 张` : '暂时没有需要复习的卡片' }),
          el('div', { class: 'rc-quote', text: done ? '知识就是这样一点点变成自己的。' : '把术语补充上定义、给笔记写上内容，它们就会进入复习队列。' }),
        ),
        el('div', { class: 'review-actions' },
          el('button', { class: 'btn primary', on: { click: () => startReview() } }, svg(ICONS.refresh), '再来一轮'),
          el('button', { class: 'btn', on: { click: () => store.go('notes') } }, '去整理笔记'),
        ),
        el('div', { class: 'review-meta' }, el('span', { text: `知识库共 ${totalLearned} 张卡片` })),
      )));
    return;
  }

  const c = current;
  const cardEl = el('div', { class: 'review-card' },
    el('div', { class: 'rc-kind', text: c.kind === 'term' ? '术语' : '笔记卡' }),
    el('div', { class: 'rc-q', text: c.front || '(无内容)' }),
    c.kind === 'term' && c.ref?.category ? el('div', { class: 'small muted', text: c.ref.category }) : null,
    flipped ? el('div', { class: 'rc-a', html: renderMarkdown(c.back || '（这张卡还没有内容，去补上吧）') }) : null,
  );

  setChildren(host, el('div', { class: 'review-wrap' },
    el('div', { class: 'review-stage' },
      el('div', { class: 'small muted', style: { textAlign: 'center', marginBottom: '10px' }, text: `剩余 ${queue.length + 1} 张 · 已完成 ${done} 张` }),
      cardEl,
      flipped
        ? el('div', { class: 'review-actions' },
          gradeBtn('忘了', 'again', 'var(--danger)'),
          gradeBtn('模糊', 'hard', 'var(--warn)'),
          gradeBtn('记住了', 'good', 'var(--ok)'))
        : el('div', { class: 'review-actions' },
          el('button', { class: 'btn primary', on: { click: () => { flipped = true; renderReview(); } } }, '显示答案'),
          el('button', {
            class: 'btn', on: {
              click: async () => { if (c.kind === 'term') store.saveTerm({ id: c.id, review: { ...c.ref.review, due: Date.now() + 86400000 } }); next(); },
            },
          }, '稍后再看'),
        ),
      el('div', { class: 'review-meta' },
        el('span', { text: c.kind === 'term' ? '来源：术语库' : `来源：${c.ref?.bookTitle || '笔记'}` }),
        c.ref?.updatedAt ? el('span', { text: `更新于 ${relTime(c.ref.updatedAt)}` }) : null,
      ),
    )));
}

function gradeBtn(text, grade, color) {
  return el('button', {
    class: 'btn', style: { borderColor: `color-mix(in srgb,${color} 45%,transparent)`, color },
    on: {
      click: async () => {
        await store.grade(current.kind, current.id, grade);
        next();
      },
    },
  }, text);
}

function next() {
  done++;
  current = queue.shift() || null;
  flipped = false;
  renderReview();
}
