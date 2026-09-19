/* 状态中枢：所有数据的唯一入口，写库成功后再广播事件 */

import * as db from './db.js';
import { Emitter, uid, dayKey, BOOK_COLORS, nextReview } from './utils.js';

const DEFAULT_UI = {
  theme: 'paper',
  fontSize: 19,
  lineHeight: 1.95,
  measure: 760,
  fontFamily: 'serif',
  autoTermHighlight: true,
  minTermLen: 2,
  showHoverCard: true,
  sideTab: 'ann',
  notesView: 'board',
  highlightColor: '#ffdf7e',
  dailyGoalMin: 45,
  showRestoreHint: true,   // 书库为空时是否提示"可从磁盘备份恢复"
  backupMode: 'close',     // close=关闭页面时备份 / hourly=每小时 / manual=仅手动
};

const TAB_ID = uid('tab');
let bc = null;

export const store = {
  ready: false,
  bus: new Emitter(),
  ui: { ...DEFAULT_UI },

  state: {
    route: 'library',
    books: [],
    bookId: null,
    book: null,
    chapters: [],
    chapterIndex: 0,
    chapter: null,
    anns: [],
    terms: [],
    notes: [],
    bookmarks: [],
    stats: {},
    asideOpen: false,
    asideTab: 'ann',
    focusTermId: null,
    focusAnnId: null,
    selection: null,
    loading: false,
  },

  /* ---------- 初始化 ---------- */
  async init() {
    await db.openDB();
    // 请求持久化存储：避免浏览器在磁盘紧张时清理掉你的批注
    try { await navigator.storage?.persist?.(); } catch { /* 浏览器不支持则忽略 */ }
    const rows = await db.getAll('settings');
    for (const r of rows) if (r.key === 'ui') Object.assign(this.ui, r.value || {});
    this.applyUi();
    this.state.stats = Object.fromEntries((await db.getAll('stats')).map(s => [s.day, s]));
    this.state.notes = await db.getAll('notes');
    this.state.terms = await db.getAll('terms');
    await this.loadBooks();
    this.ready = true;
    this.bus.emit('ready');

    try {
      bc = new BroadcastChannel('inkmark');
      bc.onmessage = e => this.onRemote(e.data);
    } catch { /* 浏览器不支持时静默降级 */ }

    setInterval(() => this.flushReading(), 30000);
    window.addEventListener('beforeunload', () => this.flushReading());
  },

  onRemote(msg) {
    if (!msg || msg.tab === TAB_ID) return;
    if (msg.kind === 'db') this.reloadFromDB(msg.scopes || ['books', 'terms', 'notes']);
  },

  broadcast(scopes) {
    try { bc?.postMessage({ tab: TAB_ID, kind: 'db', scopes }); } catch {}
  },

  async reloadFromDB(scopes = ['books', 'terms', 'notes']) {
    if (scopes.includes('books')) await this.loadBooks();
    if (scopes.includes('terms')) { this.state.terms = await db.getAll('terms'); this.bus.emit('terms', {}); }
    if (scopes.includes('notes')) { this.state.notes = await db.getAll('notes'); this.bus.emit('notes', {}); }
    if (scopes.includes('anns') && this.state.bookId) {
      this.state.anns = await db.getAllBy('annotations', 'bookId', this.state.bookId);
      this.bus.emit('anns', {});
    }
    if (scopes.includes('bookmarks') && this.state.bookId) {
      this.state.bookmarks = await db.getAllBy('bookmarks', 'bookId', this.state.bookId);
      this.bus.emit('bookmarks', {});
    }
  },

  /* ---------- 界面设置 ---------- */
  applyUi() {
    const r = document.documentElement;
    r.dataset.theme = this.ui.theme;
    r.style.setProperty('--fs', this.ui.fontSize + 'px');
    r.style.setProperty('--lh', String(this.ui.lineHeight));
    r.style.setProperty('--measure', this.ui.measure + 'px');
  },

  async setUi(patch) {
    Object.assign(this.ui, patch);
    this.applyUi();
    await db.put('settings', { key: 'ui', value: { ...this.ui } });
    this.bus.emit('ui', patch);
  },

  /* ---------- 路由 ---------- */
  go(route, payload = {}) {
    if (route === 'reader' && !this.state.bookId) route = 'library';
    this.state.route = route;
    this.bus.emit('route', { route, ...payload });
  },

  /* ---------- 书库 ---------- */
  async loadBooks() {
    const books = await db.getAll('books');
    books.sort((a, b) => (b.lastReadAt || b.createdAt || 0) - (a.lastReadAt || a.createdAt || 0));
    this.state.books = books;
    this.bus.emit('books');
  },

  /** parsed 来自 parsers.parseFile */
  async addBook(parsed, file) {
    const bookId = uid('bk');
    const createdAt = Date.now();
    const book = {
      id: bookId, title: parsed.title || '未命名书籍', author: parsed.author || '',
      format: parsed.format, color: BOOK_COLORS[Math.floor(Math.random() * BOOK_COLORS.length)],
      createdAt, lastReadAt: 0, progress: 0, chapterIndex: 0,
      chapterCount: parsed.chapters.length,
      wordCount: parsed.chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + (b.x || '').length, 0), 0),
      annCount: 0, termCount: 0, source: file?.name || parsed.title || '',
      meta: parsed.meta || {},
    };
    const chapters = parsed.chapters.map((c, i) => {
      const chapterId = `${bookId}#${i}`;
      return {
        id: chapterId, bookId, order: i, title: c.title || `第 ${i + 1} 章`, level: c.level || 1,
        blocks: c.blocks.map((b, j) => ({ ...b, id: `${chapterId}:${j}` })),
        charCount: c.blocks.reduce((m, b) => m + (b.x || '').length, 0),
      };
    });
    await db.put('books', book);
    // 分片写入，避免单事务过大
    for (let i = 0; i < chapters.length; i += 8) await db.putMany('chapters', chapters.slice(i, i + 8));
    if (file) {
      try {
        await db.put('files', { id: bookId, bookId, name: file.name, type: file.type, size: file.size, blob: file, savedAt: Date.now() });
      } catch (e) { console.warn('原文件过大，未能留档：', e); }
    }
    await this.loadBooks();
    this.broadcast(['books']);
    return book;
  },

  async updateBook(id, patch) {
    const b = this.state.books.find(x => x.id === id) || await db.get('books', id);
    if (!b) return;
    const next = { ...b, ...patch };
    await db.put('books', next);
    const i = this.state.books.findIndex(x => x.id === id);
    if (i >= 0) this.state.books[i] = next;
    if (this.state.bookId === id) this.state.book = next;
    this.bus.emit('books');
    if (this.state.bookId === id) this.bus.emit('book');
    this.broadcast(['books']);
    return next;
  },

  async deleteBook(id) {
    await db.deleteBookCascade(id);
    if (this.state.bookId === id) {
      this.state.bookId = null; this.state.book = null; this.state.chapter = null;
      this.state.chapters = []; this.state.anns = [];
    }
    await this.loadBooks();
    this.broadcast(['books']);
  },

  /* ---------- 阅读 ---------- */
  async openBook(id, chapterIndex = null) {
    const book = await db.get('books', id);
    if (!book) return;
    this.state.bookId = id;
    this.state.book = book;
    const chs = await db.getAllBy('chapters', 'bookId', id);
    chs.sort((a, b) => a.order - b.order);
    this.state.chapters = chs;
    this.state.anns = await db.getAllBy('annotations', 'bookId', id);
    this.state.bookmarks = await db.getAllBy('bookmarks', 'bookId', id);
    this.state.terms = await db.getAll('terms');
    const idx = chapterIndex ?? Math.min(book.chapterIndex || 0, Math.max(0, chs.length - 1));
    await this.loadChapter(idx);
    this.go('reader');
    this.bus.emit('anns', {});
  },

  async loadChapter(index) {
    const chs = this.state.chapters;
    if (!chs.length) return;
    const i = Math.max(0, Math.min(index, chs.length - 1));
    const meta = chs[i];
    const full = await db.get('chapters', meta.id);
    this.state.chapterIndex = i;
    this.state.chapter = full || { ...meta, blocks: [] };
    this.bus.emit('chapter');
  },

  async nextChapter(d = 1) {
    const i = this.state.chapterIndex + d;
    if (i < 0 || i >= this.state.chapters.length) return false;
    await this.loadChapter(i);
    return true;
  },

  async saveBookProgress() {
    if (!this.state.book) return;
    const total = Math.max(1, this.state.chapters.length);
    const progress = Math.min(1, (this.state.chapterIndex + 0.5) / total);
    await this.updateBook(this.state.bookId, { chapterIndex: this.state.chapterIndex, progress, lastReadAt: Date.now() });
  },

  /* ---------- 批注 ---------- */
  annsForBlock(blockId) {
    return this.state.anns.filter(a => a.blockId === blockId);
  },

  annsForChapter(chapterId = this.state.chapter?.id) {
    return this.state.anns.filter(a => a.chapterId === chapterId);
  },

  async addAnnotations(list) {
    const rows = list.map(a => ({ id: uid('an'), createdAt: Date.now(), note: '', tags: [], ...a }));
    await db.putMany('annotations', rows);
    this.state.anns.push(...rows);
    await this.bumpAnnCount(rows.length);
    this.bus.emit('anns', { added: rows });
    this.broadcast(['anns']);
    return rows;
  },

  async saveAnnotation(patch) {
    const i = this.state.anns.findIndex(a => a.id === patch.id);
    if (i < 0) return;
    const next = { ...this.state.anns[i], ...patch, updatedAt: Date.now() };
    await db.put('annotations', next);
    this.state.anns[i] = next;
    this.bus.emit('anns', { updated: next });
    this.broadcast(['anns']);
    return next;
  },

  async removeAnnotation(id, entireGroup = false) {
    const ann = this.state.anns.find(a => a.id === id);
    if (!ann) return;
    const ids = entireGroup && ann.groupId ? this.state.anns.filter(a => a.groupId === ann.groupId).map(a => a.id) : [id];
    await db.delMany('annotations', ids);
    this.state.anns = this.state.anns.filter(a => !ids.includes(a.id));
    await this.bumpAnnCount(-ids.length);
    this.bus.emit('anns', { removed: ids });
    this.broadcast(['anns']);
  },

  async bumpAnnCount(delta) {
    if (!this.state.book || !delta) return;
    const n = Math.max(0, (this.state.book.annCount || 0) + delta);
    await this.updateBook(this.state.bookId, { annCount: n });
  },

  /* ---------- 术语 ---------- */
  termsFor(bookId = this.state.bookId) {
    return this.state.terms.filter(t => !t.bookId || t.bookId === bookId);
  },

  termById(id) { return this.state.terms.find(t => t.id === id); },

  async saveTerm(patch) {
    let row;
    if (patch.id && this.state.terms.some(t => t.id === patch.id)) {
      const i = this.state.terms.findIndex(t => t.id === patch.id);
      row = { ...this.state.terms[i], ...patch, updatedAt: Date.now() };
      this.state.terms[i] = row;
    } else {
      row = {
        id: uid('tm'), bookId: this.state.bookId, aliases: [], tags: [], links: [],
        category: '', definition: '', myNote: '', color: '#2f5d7c', review: { due: Date.now(), reps: 0, interval: 0, ease: 2.5 },
        createdAt: Date.now(), ...patch,
      };
      this.state.terms.push(row);
    }
    await db.put('terms', row);
    if (this.state.bookId) {
      const n = this.state.terms.filter(t => t.bookId === this.state.bookId).length;
      if (n !== this.state.book?.termCount) await this.updateBook(this.state.bookId, { termCount: n });
    }
    this.bus.emit('terms', { term: row });
    this.broadcast(['terms']);
    return row;
  },

  async removeTerm(id) {
    await db.del('terms', id);
    this.state.terms = this.state.terms.filter(t => t.id !== id);
    if (this.state.bookId) {
      const n = this.state.terms.filter(t => t.bookId === this.state.bookId).length;
      await this.updateBook(this.state.bookId, { termCount: n });
    }
    this.bus.emit('terms', {});
    this.broadcast(['terms']);
  },

  /* ---------- 笔记 ---------- */
  notesIn(status) { return this.state.notes.filter(n => n.status === status); },

  async saveNote(patch) {
    let row;
    const i = this.state.notes.findIndex(n => n.id === patch.id);
    if (i >= 0) {
      row = { ...this.state.notes[i], ...patch, updatedAt: Date.now() };
      this.state.notes[i] = row;
    } else {
      row = {
        id: uid('nt'), kind: 'free', status: 'inbox', tags: [], links: [], body: '', title: '',
        createdAt: Date.now(), review: { due: Date.now(), reps: 0, interval: 0, ease: 2.5 }, ...patch,
      };
      this.state.notes.unshift(row);
    }
    await db.put('notes', row);
    this.bus.emit('notes', { note: row });
    this.broadcast(['notes']);
    return row;
  },

  async removeNote(id) {
    await db.del('notes', id);
    this.state.notes = this.state.notes.filter(n => n.id !== id);
    this.bus.emit('notes', {});
    this.broadcast(['notes']);
  },

  /** 把一批批注收进笔记工作台 */
  async collectAnnotations(annIds, status = 'inbox') {
    const rows = [];
    for (const id of annIds) {
      const a = this.state.anns.find(x => x.id === id);
      if (!a) continue;
      const book = this.state.books.find(b => b.id === a.bookId) || this.state.book;
      rows.push(await this.saveNote({
        kind: 'quote', status, title: (a.quote || '').slice(0, 24) || '引文',
        body: a.note || '', quote: a.quote, bookId: a.bookId, chapterId: a.chapterId,
        blockId: a.blockId, bookTitle: book?.title || '', annId: a.id,
        tags: [...(a.tags || [])],
      }));
    }
    return rows;
  },

  /* ---------- 书签 ---------- */
  async addBookmark({ chapterId, blockId, label, ratio }) {
    const row = {
      id: uid('bm'), bookId: this.state.bookId, chapterId, blockId,
      label: label || this.state.chapter?.title || '书签', ratio: ratio || 0, createdAt: Date.now(),
    };
    await db.put('bookmarks', row);
    this.state.bookmarks.push(row);
    this.bus.emit('bookmarks');
    this.broadcast(['bookmarks']);
    return row;
  },

  async removeBookmark(id) {
    await db.del('bookmarks', id);
    this.state.bookmarks = this.state.bookmarks.filter(b => b.id !== id);
    this.bus.emit('bookmarks');
    this.broadcast(['bookmarks']);
  },

  /* ---------- 复习 ---------- */
  async grade(kind, id, grade) {
    if (kind === 'term') {
      const t = this.termById(id); if (!t) return;
      await this.saveTerm({ id, review: nextReview(t.review, grade) });
    } else {
      const n = this.state.notes.find(x => x.id === id); if (!n) return;
      await this.saveNote({ id, review: nextReview(n.review, grade) });
    }
  },

  dueCards() {
    const now = Date.now();
    const terms = this.state.terms
      .filter(t => t.definition || t.myNote)
      .filter(t => !t.review?.due || t.review.due <= now)
      .map(t => ({ kind: 'term', id: t.id, front: t.name, back: [t.definition, t.myNote].filter(Boolean).join('\n\n'), ref: t }));
    const notes = this.state.notes
      .filter(n => (!n.review?.reps && n.kind === 'quote') || (n.review?.due && n.review.due <= now))
      .map(n => ({ kind: 'note', id: n.id, front: n.quote || n.title, back: n.body, ref: n }));
    return [...terms, ...notes];
  },

  /* ---------- 阅读时长统计 ---------- */
  _readSec: 0,
  tickReading(sec = 5) { this._readSec += sec; },

  async flushReading() {
    if (this._readSec < 5) return;
    const sec = Math.round(this._readSec); this._readSec = 0;
    const day = dayKey();
    const cur = this.state.stats[day] || { day, sec: 0, anns: 0, reads: 0 };
    cur.sec += sec; cur.reads += 1;
    this.state.stats[day] = cur;
    await db.put('stats', cur);
    this.bus.emit('stats');
  },

  /* ---------- 侧栏 ---------- */
  setAside(patch) {
    Object.assign(this.state, patch);
    this.bus.emit('aside');
  },

  openAside(tab, ids = {}) {
    this.state.asideOpen = true;
    if (tab) this.state.asideTab = tab;
    Object.assign(this.state, ids);
    this.bus.emit('aside');
  },
};

export default store;
