/* 应用入口：装配路由、视图与全局交互 */

import { $, $$, el } from './core/utils.js';
import store from './core/store.js';
import { initReader, bindReaderKeys, renderTopbar, renderChapter } from './reader/reader.js';
import { initSidebar } from './panels/sidebar.js';
import { initLibrary, renderLibrary } from './views/library.js';
import { initNotes, renderNotes, bindWikiLinks } from './views/notes.js';
import { initReview } from './views/review.js';
import { renderSettings, bindGlobalKeys, openPalette } from './ui/shell.js';

function showBootError(msg) {
  const box = $('#boot-error');
  if (!box) return;
  box.hidden = false;
  if (msg) box.querySelector('.boot-card')?.prepend(el('p', { style: { color: 'var(--danger)' }, text: msg }));
}

function applyRoute() {
  const route = store.state.route;
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === route));
  $$('.rail-btn[data-route]').forEach(b => b.classList.toggle('active', b.dataset.route === route));
  // 顶栏只属于阅读视图；切换视图时顺手收起浮层，避免残留
  $('.topbar').hidden = route !== 'reader';
  $('#sel-toolbar').hidden = true;
  $('#hover-card').hidden = true;
  document.title = route === 'reader' && store.state.book
    ? `${store.state.book.title} · 墨读`
    : '墨读 InkMark · 电子书实时批注与知识整理';
}

function bindRail() {
  $$('.rail-btn[data-route]').forEach(btn => btn.addEventListener('click', () => store.go(btn.dataset.route)));
  $('.rail-btn[data-action="settings"]')?.addEventListener('click', () => store.go('settings'));
  $('.rail-btn[data-action="command"]')?.addEventListener('click', () => openPalette());
}

async function boot() {
  if (location.protocol === 'file:') return showBootError();
  try {
    await store.init();
  } catch (e) {
    console.error(e);
    return showBootError(`初始化失败：${e.message}。如果使用了浏览器的无痕模式，请换普通窗口重试。`);
  }

  bindRail();
  bindGlobalKeys();
  bindReaderKeys();
  initLibrary();
  initNotes();
  initReview();
  initReader();
  initSidebar();
  bindWikiLinks(document.body);

  store.bus.on('route', () => {
    applyRoute();
    const route = store.state.route;
    if (route === 'library') renderLibrary();
    else if (route === 'notes') renderNotes();
    else if (route === 'settings') renderSettings();
    else if (route === 'reader') { renderTopbar(); renderChapter(); }
  });
  store.bus.on('ui', () => { if (store.state.route === 'settings') return; applyRoute(); });
  store.bus.on('books', () => { if (store.state.route === 'library') renderLibrary(); });
  store.bus.on('stats', () => { if (store.state.route === 'library') renderLibrary(); });

  applyRoute();
  if (store.state.books.length) renderLibrary();
  else {
    store.state.route = 'library';
    applyRoute();
    renderLibrary();
  }

  // 阅读进度落盘
  setInterval(() => { if (store.state.route === 'reader') store.saveBookProgress(); }, 45000);
  window.addEventListener('beforeunload', () => { if (store.state.route === 'reader') store.saveBookProgress(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#sel-toolbar').hidden = true;
      $('#hover-card').hidden = true;
      $('#modal-root').lastElementChild?.remove();
      if (store.ui.theme === 'dark' && e.shiftKey) store.setUi({ theme: 'paper' });
    }
  });

  console.info('%c墨读 InkMark%c 已就绪 · Ctrl+K 打开命令面板', 'font-size:15px;font-weight:700;color:#b0432a', 'color:#888');
  // 调试入口：控制台可用 __ink.store / __ink.db 直接查看数据
  window.__ink = { store, db: (await import('./core/db.js')) };
  window.__inkReady = true;
}

window.addEventListener('error', e => {
  if (String(e.message || '').includes('ResizeObserver')) return;
  console.error('[未捕获错误]', e.error || e.message);
});
window.addEventListener('unhandledrejection', e => console.error('[未处理的 Promise]', e.reason));

boot();
