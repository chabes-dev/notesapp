import './styles.css';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';

/* =========================================================
   Storage (IndexedDB, this computer only)
   ========================================================= */
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const DB = {
  db: null,
  async open() {
    const r = indexedDB.open('notes-app', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('notes', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
    this.db = await reqP(r);
  },
  store(name, mode) { return this.db.transaction(name, mode).objectStore(name); },
  all(name) { return reqP(this.store(name, 'readonly').getAll()); },
  get(name, key) { return reqP(this.store(name, 'readonly').get(key)); },
  put(name, val, key) { return reqP(key === undefined ? this.store(name, 'readwrite').put(val) : this.store(name, 'readwrite').put(val, key)); },
  del(name, key) { return reqP(this.store(name, 'readwrite').delete(key)); },
};

/* =========================================================
   State
   ========================================================= */
const params = new URLSearchParams(location.search);
const SOLO = params.has('solo');           // a popped-out window: one note, no sidebar
const MAX_PANES = 4;
const S = { notes: new Map(), folders: [], view: 'all', query: '', panes: [], active: null };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('notes-sync') : null;
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const K = isMac ? '⌘' : 'Ctrl+';

const ICON = {
  side: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
  compose: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  split: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16"/><path d="M15.5 12h3M17 10.5v3"/></svg>',
  pop: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="6" cy="7" r="2.2"/><circle cx="6" cy="17" r="2.2"/><path d="M11 7h9M11 17h9"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};

/* =========================================================
   Editor extensions
   ========================================================= */
// Indentation is a property of the line, bold is a property of the text.
// They live in separate places, so changing one can never reset the other.
const INDENTABLE = ['paragraph', 'heading'];
const LIST_ITEMS = ['listItem', 'taskItem'];
function listItemsAround($pos) {
  const found = [];
  for (let d = $pos.depth; d > 0; d--) { const n = $pos.node(d).type.name; if (LIST_ITEMS.includes(n)) found.push(n); }
  return found; // innermost first
}
const shiftIndent = delta => ({ state, tr, dispatch }) => {
  const { from, to } = state.selection; let changed = false;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!INDENTABLE.includes(node.type.name)) return true;
    if (parent && LIST_ITEMS.includes(parent.type.name)) return false;
    const cur = node.attrs.indent || 0, next = Math.max(0, Math.min(8, cur + delta));
    if (next !== cur) { changed = true; if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }); }
    return false;
  });
  return changed;
};
const Indent = Extension.create({
  name: 'indent',
  priority: 1000,
  addGlobalAttributes() {
    return [{
      types: INDENTABLE,
      attributes: {
        indent: {
          default: 0, keepOnSplit: true,
          parseHTML: el => parseInt(el.getAttribute('data-indent') || '0', 10) || 0,
          renderHTML: a => (a.indent ? { 'data-indent': a.indent, style: `margin-left:${a.indent * 1.6}em` } : {}),
        },
      },
    }];
  },
  addCommands() { return { indent: () => shiftIndent(1), outdent: () => shiftIndent(-1) }; },
  addKeyboardShortcuts() {
    const ed = this.editor;
    const fwd = () => {
      const items = listItemsAround(ed.state.selection.$from);
      if (items.length) { ed.commands.sinkListItem(items[0]); return true; }
      ed.commands.indent(); return true;
    };
    const back = () => {
      const items = listItemsAround(ed.state.selection.$from);
      if (items.length > 1) { ed.commands.liftListItem(items[0]); return true; }
      if (items.length) return true;
      ed.commands.outdent(); return true;
    };
    return {
      Tab: fwd, 'Shift-Tab': back, 'Mod-]': fwd, 'Mod-[': back,
      Backspace: () => {
        const { $from, empty } = ed.state.selection;
        if (!empty || $from.parentOffset !== 0 || listItemsAround($from).length) return false;
        const n = $from.parent;
        return INDENTABLE.includes(n.type.name) && n.attrs.indent > 0 ? ed.commands.outdent() : false;
      },
    };
  },
});
// Apple Notes style shortcuts (the TipTap defaults ⌘⌥1/2/3/0 also work)
const AppleKeys = Extension.create({
  name: 'appleKeys',
  addKeyboardShortcuts() {
    const c = () => this.editor.chain().focus();
    return {
      'Mod-Shift-t': () => c().toggleHeading({ level: 1 }).run(),
      'Mod-Shift-h': () => c().toggleHeading({ level: 2 }).run(),
      'Mod-Shift-j': () => c().toggleHeading({ level: 3 }).run(),
      'Mod-Shift-b': () => c().setParagraph().run(),
      'Mod-Shift-l': () => c().toggleTaskList().run(),
    };
  },
});

/* =========================================================
   Notes
   ========================================================= */
function summarize(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  return { title: lines[0] || 'New Note', snippet: lines.slice(1).join(' ').slice(0, 160) || 'No additional text' };
}
function newNote(folder) {
  const now = Date.now();
  const n = { id: uid(), folder: folder || 'notes', doc: null, text: '', title: 'New Note', snippet: 'No additional text', created: now, updated: now, pinned: false, deleted: 0 };
  S.notes.set(n.id, n);
  return n;
}
async function persist(note, { broadcast = true } = {}) {
  S.notes.set(note.id, note);
  await DB.put('notes', note);
  if (broadcast && bc) bc.postMessage({ t: 'note', note });
  scheduleList();
}
async function hardDelete(id, { broadcast = true } = {}) {
  S.notes.delete(id);
  await DB.del('notes', id);
  if (broadcast && bc) bc.postMessage({ t: 'gone', id });
  S.panes.forEach(p => { if (p.noteId === id) p.show(null); });
  scheduleList();
}
const isBlank = n => !n || !n.text.trim();
const openElsewhere = (id, except) => S.panes.some(p => p !== except && p.noteId === id);
function discardIfBlank(id, except) {
  const n = S.notes.get(id);
  if (n && isBlank(n) && !openElsewhere(id, except)) hardDelete(id);
}
async function trashNote(id) {
  const n = S.notes.get(id); if (!n) return;
  if (n.deleted) { if (confirm(`Delete "${n.title}" forever?`)) hardDelete(id); return; }
  await persist({ ...n, deleted: Date.now(), pinned: false });
  S.panes.forEach(p => { if (p.noteId === id) p.show(null); });
  toast('Moved to Recently Deleted');
}
function fmtDate(ts, long) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (long) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) + ' at ' + time;
  if (sameDay) return time;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function groupOf(ts) {
  const day = 864e5, start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  if (ts >= t0) return 'Today';
  if (ts >= t0 - day) return 'Yesterday';
  if (ts >= t0 - 7 * day) return 'Previous 7 Days';
  if (ts >= t0 - 30 * day) return 'Previous 30 Days';
  const d = new Date(ts);
  return d.getFullYear() === start.getFullYear() ? d.toLocaleDateString(undefined, { month: 'long' }) : String(d.getFullYear());
}

/* =========================================================
   Panes (side-by-side windows inside the app)
   ========================================================= */
class Pane {
  constructor(noteId) {
    this.noteId = null;
    this.el = h(`<section class="pane">
      <header class="phead">
        <button class="ibtn sidetoggle" title="Show/hide sidebar (${K}⌥S)">${ICON.side}</button>
        <div class="date"></div>
        <div class="fmt fadeui">
          <button class="pill aa" title="Text styles">Aa</button>
          <button class="ibtn chk" title="Checklist (${K}⇧L)">${ICON.check}</button>
          <button class="ibtn sp" title="Open a note side by side (${K}\\)">${ICON.split}</button>
          <button class="ibtn po" title="Open in its own window">${ICON.pop}</button>
          <button class="ibtn cl" title="Close this pane">${ICON.close}</button>
        </div>
      </header>
      <div class="pbody"><div class="host"></div></div>
      <div class="pblank">No note open.<br><span style="font-size:15px">Pick one from the list, or press ${K}N.</span></div>
    </section>`);
    this.editor = new Editor({
      element: $('.host', this.el),
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
        TaskList, TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: 'Start writing…' }),
        Indent, AppleKeys,
      ],
      content: '',
      onUpdate: () => this.changed(),
      onFocus: () => setActive(this),
      onBlur: () => { this.flush(); if (this.pending) { this.pending = false; const n = S.notes.get(this.noteId); n && this.receive(n); } },
    });
    this.wire();
    this.show(noteId || null);
  }
  wire() {
    const el = this.el;
    el.addEventListener('mousedown', () => setActive(this));
    $('.sidetoggle', el).onclick = () => toggleSide();
    $('.aa', el).onclick = e => { e.stopPropagation(); this.styleMenu(e.currentTarget); };
    $('.chk', el).onclick = () => this.editor.chain().focus().toggleTaskList().run();
    $('.sp', el).onclick = () => addPane(newNote(currentFolder()).id, this);
    $('.po', el).onclick = () => this.noteId && popOut(this.noteId);
    $('.cl', el).onclick = () => closePane(this);
    // links: ⌘-click opens them
    $('.host', el).addEventListener('click', e => {
      const a = e.target.closest('a'); if (a && (e.metaKey || e.ctrlKey)) window.open(a.href, '_blank');
    });
    // typing hides everything but the words (like Spark)
    $('.host', el).addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab') hideChrome();
    });
    // drop a note from the list onto this pane to open it here
    el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/note-id')) { e.preventDefault(); el.classList.add('dropping'); } });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
    el.addEventListener('drop', e => {
      const id = e.dataTransfer.getData('text/note-id'); el.classList.remove('dropping');
      if (id) { e.preventDefault(); setActive(this); this.show(id); this.editor.commands.focus('end'); }
    });
  }
  show(id) {
    if (this.noteId && this.noteId !== id) { this.flush(); discardIfBlank(this.noteId, this); }
    this.noteId = id;
    const n = id && S.notes.get(id);
    if (!n) this.noteId = null;
    $('.pbody', this.el).style.display = n ? '' : 'none';
    $('.pblank', this.el).style.display = n ? 'none' : '';
    $('.fmt', this.el).style.visibility = n ? '' : 'hidden';
    if (n) {
      this.editor.commands.setContent(n.doc || '', { emitUpdate: false });
      this.shown = n.updated; this.pending = false; this.dirty = false;
      this.editor.setEditable(!n.deleted);
      $('.pbody', this.el).scrollTop = 0;
    }
    this.header();
    scheduleList(); saveLayout();
  }
  header() {
    const n = this.noteId && S.notes.get(this.noteId);
    $('.date', this.el).textContent = n ? (n.deleted ? 'In Recently Deleted · restore it to edit' : fmtDate(n.updated, true)) : '';
    $('.cl', this.el).style.display = S.panes.length > 1 ? '' : 'none';
    $('.sidetoggle', this.el).style.display = S.panes[0] === this ? '' : 'none';
  }
  changed() {
    this.dirty = true;
    clearTimeout(this.t);
    this.t = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.t);
    if (!this.dirty) return;   // only save real local edits, never a stale copy
    this.dirty = false;
    const n = this.noteId && S.notes.get(this.noteId); if (!n || n.deleted) return;
    const doc = this.editor.getJSON();
    const text = this.editor.getText({ blockSeparator: '\n' });
    if (JSON.stringify(doc) === JSON.stringify(n.doc)) return;
    const next = { ...n, doc, text, ...summarize(text), updated: Date.now() };
    this.shown = next.updated;
    persist(next);
    S.panes.forEach(p => { if (p !== this) p.receive(next); });
    this.header();
  }
  receive(note) {   // the same note changed in another pane or window
    if (!note || this.noteId !== note.id) return;
    if (note.updated > (this.shown || 0)) {
      if (this.editor.isFocused) this.pending = true;   // don't yank text from under the cursor
      else { this.editor.commands.setContent(note.doc || '', { emitUpdate: false }); this.shown = note.updated; this.pending = false; this.dirty = false; }
    }
    this.header();
  }
  styleMenu(anchor) {
    const ed = this.editor, A = (n, o) => ed.isActive(n, o) ? 'on' : '';
    const items = [
      ['Title', `${K}⇧T`, () => ed.chain().focus().toggleHeading({ level: 1 }).run(), A('heading', { level: 1 })],
      ['Heading', `${K}⇧H`, () => ed.chain().focus().toggleHeading({ level: 2 }).run(), A('heading', { level: 2 })],
      ['Subheading', `${K}⇧J`, () => ed.chain().focus().toggleHeading({ level: 3 }).run(), A('heading', { level: 3 })],
      ['Body', `${K}⇧B`, () => ed.chain().focus().setParagraph().run(), A('paragraph') && !ed.isActive('listItem') ? 'on' : ''],
      '-',
      ['Bulleted list', `${K}⇧8`, () => ed.chain().focus().toggleBulletList().run(), A('bulletList')],
      ['Numbered list', `${K}⇧7`, () => ed.chain().focus().toggleOrderedList().run(), A('orderedList')],
      ['Checklist', `${K}⇧L`, () => ed.chain().focus().toggleTaskList().run(), A('taskList')],
      '-',
      ['Bold', `${K}B`, () => ed.chain().focus().toggleBold().run(), A('bold')],
      ['Italic', `${K}I`, () => ed.chain().focus().toggleItalic().run(), A('italic')],
      ['Underline', `${K}U`, () => ed.chain().focus().toggleUnderline().run(), A('underline')],
      ['Strikethrough', `${K}⇧S`, () => ed.chain().focus().toggleStrike().run(), A('strike')],
      '-',
      ['Indent', `${K}] · Tab`, () => { ed.commands.focus(); ed.commands.keyboardShortcut('Tab'); }, ''],
      ['Outdent', `${K}[ · ⇧Tab`, () => { ed.commands.focus(); ed.commands.keyboardShortcut('Shift-Tab'); }, ''],
      ['Quote', '', () => ed.chain().focus().toggleBlockquote().run(), A('blockquote')],
      ['Monospaced', '', () => ed.chain().focus().toggleCodeBlock().run(), A('codeBlock')],
    ];
    menu(anchor, items, { alignRight: true });
  }
  destroy() { this.flush(); this.editor.destroy(); this.el.remove(); }
}

function setActive(p) {
  if (S.active === p) return;
  S.active = p;
  S.panes.forEach(x => x.el.classList.toggle('active', x === p));
  scheduleList(); saveLayout();
}
function addPane(noteId, after) {
  if (S.panes.length >= MAX_PANES) { toast(`Up to ${MAX_PANES} side by side`); if (noteId) { S.active.show(noteId); } return; }
  const p = new Pane(noteId);
  const i = after ? S.panes.indexOf(after) + 1 : S.panes.length;
  S.panes.splice(i, 0, p);
  const ref = S.panes[i + 1];
  $('#panes').insertBefore(p.el, ref ? ref.el : null);
  layoutPanes(); setActive(p);
  if (noteId) setTimeout(() => p.editor.commands.focus('end'), 0);
  return p;
}
function closePane(p) {
  if (S.panes.length < 2) return;
  const id = p.noteId; p.flush();
  const i = S.panes.indexOf(p); S.panes.splice(i, 1); p.destroy();
  if (id) discardIfBlank(id);
  if (S.active === p) { S.active = null; setActive(S.panes[Math.max(0, i - 1)]); }
  layoutPanes();
}
function layoutPanes() {
  $('#panes').classList.toggle('multi', S.panes.length > 1);
  S.panes.forEach(p => p.header());
  saveLayout();
}
function openNote(id, { newPane = false } = {}) {
  const already = S.panes.find(p => p.noteId === id);
  if (already && !newPane) { setActive(already); already.editor.commands.focus(); return; }
  if (newPane) return addPane(id, S.active);
  S.active.show(id);
}
function popOut(id) {
  S.panes.forEach(p => p.flush());
  window.open(`${location.pathname}?note=${encodeURIComponent(id)}&solo=1`, '_blank', 'popup,width=760,height=860');
}

/* =========================================================
   Sidebar: folders + list
   ========================================================= */
const currentFolder = () => (['all', 'trash'].includes(S.view) ? 'notes' : S.view);
function visibleNotes() {
  const all = [...S.notes.values()];
  if (S.query) { const q = norm(S.query); return all.filter(n => !n.deleted && norm(n.text + ' ' + n.title).includes(q)); }
  if (S.view === 'trash') return all.filter(n => n.deleted);
  if (S.view === 'all') return all.filter(n => !n.deleted);
  return all.filter(n => !n.deleted && n.folder === S.view);
}
function viewName() {
  if (S.query) return 'Search';
  if (S.view === 'all') return 'All Notes';
  if (S.view === 'trash') return 'Recently Deleted';
  return (S.folders.find(f => f.id === S.view) || { name: 'Notes' }).name;
}
let listQueued = false;
function scheduleList() { if (listQueued) return; listQueued = true; requestAnimationFrame(() => { listQueued = false; renderFolders(); renderList(); }); }

function renderFolders() {
  const live = [...S.notes.values()].filter(n => !n.deleted);
  const count = id => id === 'all' ? live.length : id === 'trash' ? S.notes.size - live.length : live.filter(n => n.folder === id).length;
  const row = (id, name, editable) => `<button class="folder ${S.view === id && !S.query ? 'on' : ''}" data-f="${id}" ${editable ? 'data-edit="1"' : ''}>${esc(name)}<span class="n">${count(id) || ''}</span></button>`;
  $('#flist').innerHTML =
    `<div class="fsec">${row('all', 'All Notes')}${row('notes', 'Notes')}</div>` +
    (S.folders.length ? `<div class="label">Folders</div><div class="fsec">${S.folders.map(f => row(f.id, f.name, true)).join('')}</div>` : '') +
    `<div class="fsec">${row('trash', 'Recently Deleted')}</div>`;
}
function renderList() {
  const notes = visibleNotes().sort((a, b) => (b.pinned - a.pinned) || ((S.view === 'trash' ? b.deleted - a.deleted : b.updated - a.updated)));
  $('#vname').textContent = viewName();
  const open = new Set(S.panes.map(p => p.noteId));
  const activeId = S.active && S.active.noteId;
  if (!notes.length) {
    $('#notes').innerHTML = `<div class="empty">${S.query ? 'No matches.' : S.view === 'trash' ? 'Nothing deleted.' : 'No notes yet.'}</div>`;
    return;
  }
  let html = '', last = '';
  for (const n of notes) {
    const g = n.pinned ? 'Pinned' : groupOf(S.view === 'trash' ? n.deleted : n.updated);
    if (g !== last) { html += `<div class="label grp">${esc(g)}</div>`; last = g; }
    html += `<div class="note ${n.id === activeId ? 'on' : ''} ${open.has(n.id) ? 'inpane' : ''}" draggable="true" data-id="${n.id}">
      <div class="t">${esc(n.title)}</div><div class="s"><b>${fmtDate(n.updated)}</b>${esc(n.snippet)}</div></div>`;
  }
  $('#notes').innerHTML = html;
}

function wireSidebar() {
  $('#flist').addEventListener('click', e => {
    const b = e.target.closest('.folder'); if (!b || b.querySelector('input')) return;
    S.view = b.dataset.f; S.query = ''; $('#q').value = ''; scheduleList(); saveLayout();
  });
  $('#flist').addEventListener('dblclick', e => { const b = e.target.closest('.folder[data-edit]'); if (b) renameFolder(b.dataset.f, b); });
  $('#flist').addEventListener('contextmenu', e => {
    const b = e.target.closest('.folder[data-edit]'); if (!b) return; e.preventDefault();
    menu({ x: e.clientX, y: e.clientY }, [
      ['Rename folder', '', () => renameFolder(b.dataset.f, b)],
      ['Delete folder', '', () => deleteFolder(b.dataset.f)],
    ]);
  });
  // drop notes on folders to move them
  $('#flist').addEventListener('dragover', e => { const b = e.target.closest('.folder'); if (b && !['all'].includes(b.dataset.f)) { e.preventDefault(); b.classList.add('drop'); } });
  $('#flist').addEventListener('dragleave', e => { const b = e.target.closest('.folder'); if (b) b.classList.remove('drop'); });
  $('#flist').addEventListener('drop', e => {
    const b = e.target.closest('.folder'); if (!b) return; b.classList.remove('drop'); e.preventDefault();
    const n = S.notes.get(e.dataTransfer.getData('text/note-id')); if (!n) return;
    if (b.dataset.f === 'trash') return trashNote(n.id);
    persist({ ...n, folder: b.dataset.f, deleted: 0 }); toast(`Moved to ${b.textContent.replace(/\d+$/, '')}`);
  });
  $('#newfolder').onclick = async () => {
    const f = { id: uid(), name: 'New Folder' }; S.folders.push(f); await saveFolders(); renderFolders();
    renameFolder(f.id, $(`.folder[data-f="${f.id}"]`));
  };
  $('#compose').onclick = () => composeNew();
  $('#q').addEventListener('input', e => { S.query = e.target.value.trim(); scheduleList(); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; S.query = ''; scheduleList(); S.active.editor.commands.focus(); } });

  const notesEl = $('#notes');
  notesEl.addEventListener('click', e => {
    const r = e.target.closest('.note'); if (!r) return;
    openNote(r.dataset.id, { newPane: e.metaKey || e.ctrlKey });
  });
  notesEl.addEventListener('dragstart', e => {
    const r = e.target.closest('.note'); if (!r) return;
    e.dataTransfer.setData('text/note-id', r.dataset.id); e.dataTransfer.effectAllowed = 'move';
  });
  notesEl.addEventListener('contextmenu', e => {
    const r = e.target.closest('.note'); if (!r) return; e.preventDefault();
    const n = S.notes.get(r.dataset.id);
    const items = n.deleted ? [
      ['Restore', '', () => persist({ ...n, deleted: 0 })],
      ['Delete forever', '', () => trashNote(n.id)],
    ] : [
      [n.pinned ? 'Unpin note' : 'Pin note', '', () => persist({ ...n, pinned: !n.pinned })],
      ['Open side by side', isMac ? '⌘-click' : 'Ctrl-click', () => openNote(n.id, { newPane: true })],
      ['Open in its own window', '', () => popOut(n.id)],
      '-',
      ...[{ id: 'notes', name: 'Notes' }, ...S.folders].filter(f => f.id !== n.folder).map(f => [`Move to ${f.name}`, '', () => persist({ ...n, folder: f.id })]),
      '-',
      ['Delete', '⌫', () => trashNote(n.id)],
    ];
    menu({ x: e.clientX, y: e.clientY }, items);
  });
  $('#backup').onclick = exportAll;
  $('#restore').onclick = () => $('#importfile').click();
  $('#importfile').onchange = e => e.target.files[0] && importAll(e.target.files[0]);
}
function renameFolder(id, btn) {
  const f = S.folders.find(x => x.id === id); if (!f || !btn) return;
  btn.innerHTML = `<input value="${esc(f.name)}">`;
  const inp = $('input', btn); inp.focus(); inp.select();
  const done = async ok => { if (ok && inp.value.trim()) f.name = inp.value.trim(); await saveFolders(); renderFolders(); renderList(); };
  inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.onblur = null; done(false); } };
  inp.onblur = () => done(true);
}
async function deleteFolder(id) {
  const f = S.folders.find(x => x.id === id); if (!f) return;
  const inside = [...S.notes.values()].filter(n => n.folder === id && !n.deleted);
  if (!confirm(`Delete "${f.name}"?${inside.length ? ` Its ${inside.length} note(s) go to Recently Deleted.` : ''}`)) return;
  for (const n of inside) await persist({ ...n, folder: 'notes', deleted: Date.now(), pinned: false });
  S.folders = S.folders.filter(x => x.id !== id); await saveFolders();
  if (S.view === id) S.view = 'all';
  scheduleList();
}
async function saveFolders() { await DB.put('meta', S.folders, 'folders'); bc && bc.postMessage({ t: 'folders', folders: S.folders }); }

function composeNew() {
  const n = newNote(currentFolder());
  if (S.view === 'trash') S.view = 'all';
  S.query = ''; $('#q').value = '';
  S.active.show(n.id);
  S.active.editor.commands.focus('start');
}

/* =========================================================
   Chrome hiding, menus, toasts, layout
   ========================================================= */
function hideChrome() { if (!document.body.classList.contains('typing')) { closeMenus(); document.body.classList.add('typing'); } }
let lastXY = null;
window.addEventListener('mousemove', e => {
  if (lastXY && Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]) > 6) document.body.classList.remove('typing');
  lastXY = [e.clientX, e.clientY];
});
function toggleSide() { document.body.classList.toggle('hide-side'); saveLayout(); }

function closeMenus() { document.querySelectorAll('.pop').forEach(p => p.remove()); }
function menu(anchor, items, { alignRight = false } = {}) {
  closeMenus();
  const pop = h('<div class="pop"></div>');
  items.forEach(it => {
    if (it === '-') return pop.append(h('<hr>'));
    const [label, kbd, fn, on] = it;
    const b = h(`<button class="${on || ''}"><span>${esc(label)}</span>${kbd ? `<kbd>${esc(kbd)}</kbd>` : ''}</button>`);
    b.onmousedown = e => e.preventDefault(); // keep the text selection
    b.onclick = () => { closeMenus(); fn(); };
    pop.append(b);
  });
  if (anchor instanceof Element) {
    anchor.parentElement.style.position = 'relative';
    pop.style[alignRight ? 'right' : 'left'] = '0';
    anchor.parentElement.append(pop);
  } else {
    pop.classList.add('ctx'); document.body.append(pop);
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.min(anchor.x, innerWidth - r.width - 8) + 'px';
    pop.style.top = Math.min(anchor.y, innerHeight - r.height - 8) + 'px';
  }
}
document.addEventListener('mousedown', e => { if (!e.target.closest('.pop')) closeMenus(); });

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

function saveLayout() {
  if (SOLO || !S.panes.length) return;
  try {
    localStorage.setItem('layout', JSON.stringify({
      panes: S.panes.map(p => p.noteId), active: S.panes.indexOf(S.active), view: S.view,
      hideSide: document.body.classList.contains('hide-side'), hideFolders: document.body.classList.contains('hide-folders'),
    }));
  } catch { /* storage unavailable */ }
}
function loadLayout() { try { return JSON.parse(localStorage.getItem('layout')) || null; } catch { return null; } }

/* =========================================================
   Backup
   ========================================================= */
function exportAll() {
  S.panes.forEach(p => p.flush());
  const data = { app: 'notes', version: 1, exported: new Date().toISOString(), folders: S.folders, notes: [...S.notes.values()] };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  localStorage.setItem('lastBackup', Date.now());
  toast('Backup downloaded');
}
async function importAll(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.notes)) throw new Error('not a notes backup');
    let added = 0;
    for (const n of data.notes) {
      const cur = S.notes.get(n.id);
      if (!cur || (n.updated || 0) > (cur.updated || 0)) { await persist(n); added++; }
    }
    for (const f of data.folders || []) if (!S.folders.some(x => x.id === f.id)) S.folders.push(f);
    await saveFolders(); scheduleList();
    toast(`Restored ${added} note${added === 1 ? '' : 's'}`);
  } catch (err) { toast('That file is not a notes backup'); }
}

/* =========================================================
   Keyboard (app level)
   ========================================================= */
window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (!mod) {
    if ((e.key === 'Backspace' || e.key === 'Delete') && document.activeElement === $('#notes') && S.active.noteId) { e.preventDefault(); trashNote(S.active.noteId); }
    if (e.key === 'Escape') { closeMenus(); document.body.classList.remove('typing'); }
    return;
  }
  if (k === 'n' && !e.shiftKey) { e.preventDefault(); composeNew(); }
  else if ((k === 'f' && e.altKey) || (k === 'k' && !e.altKey)) { e.preventDefault(); document.body.classList.remove('hide-side', 'typing'); $('#q').focus(); $('#q').select(); }
  else if (e.code === 'Backslash') { e.preventDefault(); addPane(newNote(currentFolder()).id, S.active); }
  else if (e.code === 'KeyS' && e.altKey) { e.preventDefault(); toggleSide(); }
  else if (e.code === 'KeyW' && e.altKey) { e.preventDefault(); closePane(S.active); }
  else if (e.altKey && (e.code === 'ArrowRight' || e.code === 'ArrowLeft')) {   // move between panes
    const i = S.panes.indexOf(S.active) + (e.code === 'ArrowRight' ? 1 : -1);
    if (S.panes[i]) { e.preventDefault(); setActive(S.panes[i]); S.panes[i].editor.commands.focus(); }
  }
}, true);

/* =========================================================
   Sync between windows
   ========================================================= */
bc && (bc.onmessage = ({ data }) => {
  if (data.t === 'note') { S.notes.set(data.note.id, data.note); S.panes.forEach(p => p.receive(data.note)); if (data.note.deleted) S.panes.forEach(p => { if (p.noteId === data.note.id) p.show(null); }); scheduleList(); }
  if (data.t === 'gone') { S.notes.delete(data.id); S.panes.forEach(p => { if (p.noteId === data.id) p.show(null); }); scheduleList(); }
  if (data.t === 'folders') { S.folders = data.folders; scheduleList(); }
});
window.addEventListener('pagehide', () => S.panes.forEach(p => p.flush()));
// Fallback for when the page is opened straight from a file (no live channel there):
// a window you're not typing in quietly re-reads the notes every second.
window.addEventListener('blur', () => S.panes.forEach(p => p.flush()));
async function refreshFromDB() {
  const all = await DB.all('notes'), seen = new Set();
  for (const n of all) {
    seen.add(n.id);
    const cur = S.notes.get(n.id);
    if (!cur || n.updated > cur.updated || n.deleted !== cur.deleted || n.pinned !== cur.pinned || n.folder !== cur.folder) {
      S.notes.set(n.id, n); S.panes.forEach(p => p.receive(n));
      if (n.deleted) S.panes.forEach(p => { if (p.noteId === n.id) p.show(null); });
      scheduleList();
    }
  }
  for (const [id, n] of S.notes) if (!seen.has(id) && !isBlank(n)) { S.notes.delete(id); S.panes.forEach(p => { if (p.noteId === id) p.show(null); }); scheduleList(); }
  S.panes.forEach(p => p.noteId && p.receive(S.notes.get(p.noteId)));
  const folders = (await DB.get('meta', 'folders')) || [];
  if (JSON.stringify(folders) !== JSON.stringify(S.folders)) { S.folders = folders; scheduleList(); }
}
setInterval(() => { if (!document.hidden && (!document.hasFocus() || !S.panes.some(p => p.editor.isFocused))) refreshFromDB(); }, 1000);
window.addEventListener('focus', () => refreshFromDB());
document.addEventListener('visibilitychange', () => { if (document.hidden) S.panes.forEach(p => p.flush()); });

/* =========================================================
   Boot
   ========================================================= */
async function boot() {
  await DB.open();
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
  S.folders = (await DB.get('meta', 'folders')) || [];
  const notes = await DB.all('notes');
  const month = 30 * 864e5;
  for (const n of notes) {
    if (n.deleted && Date.now() - n.deleted > month) { DB.del('notes', n.id); continue; }
    if (isBlank(n) && !n.deleted) { DB.del('notes', n.id); continue; }
    S.notes.set(n.id, n);
  }
  if (!S.notes.size && !SOLO) {
    const w = newNote('notes');
    w.doc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Welcome to Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'The first line is always the title. Just start typing — the menus fade away and come back when you move the mouse.' }] },
      { type: 'paragraph', attrs: { indent: 1 }, content: [{ type: 'text', text: 'Tab or ' + K + '] indents a line. ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'Bold keeps it right where it is.' }] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: K + '\\ opens a second note side by side' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: (isMac ? '⌘' : 'Ctrl') + '-click a note in the list to open it next to this one' }] }] },
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The arrow icon pops a note out into its own window' }] }] },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Notes live only on this computer. Use “Back up” at the bottom left now and then.' }] },
    ] };
    w.text = 'Welcome to Notes\nThe first line is always the title.'; Object.assign(w, summarize(w.text));
    await persist(w, { broadcast: false });
  }
  wireSidebar();

  const want = params.get('note');
  const layout = SOLO ? null : loadLayout();
  if (SOLO) document.body.classList.add('hide-side');
  if (layout) {
    if (layout.hideSide) document.body.classList.add('hide-side');
    if (layout.hideFolders) document.body.classList.add('hide-folders');
    if (layout.view && (['all', 'notes', 'trash'].includes(layout.view) || S.folders.some(f => f.id === layout.view))) S.view = layout.view;
  }
  let ids = SOLO ? [want] : (layout && layout.panes || []).filter(id => S.notes.has(id));
  if (!ids.length) {
    const recent = [...S.notes.values()].filter(n => !n.deleted).sort((a, b) => b.updated - a.updated)[0];
    ids = [recent ? recent.id : newNote('notes').id];
  }
  ids.forEach(id => addPane(id));
  const act = S.panes[layout && layout.active >= 0 && !SOLO ? Math.min(layout.active, S.panes.length - 1) : 0];
  S.active = null; setActive(act);
  act.editor.commands.focus('end');
  scheduleList();

  setupUpdates();
  if (sessionStorage.getItem('justUpdated')) { sessionStorage.removeItem('justUpdated'); setTimeout(() => toast('Updated to the latest version'), 600); }
}
/* =========================================================
   Automatic updates: a new version installs in the background,
   then the window refreshes itself at a quiet moment (never mid-sentence).
   ========================================================= */
let lastKey = 0;
window.addEventListener('keydown', () => { lastKey = Date.now(); }, true);
function setupUpdates() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost')) return;
  const hadController = !!navigator.serviceWorker.controller;   // first install isn't an "update"
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    const check = () => reg.update().catch(() => {});
    setInterval(check, 15 * 60 * 1000);
    window.addEventListener('focus', check);
  });
  let pending = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || pending) return;
    pending = true;
    const tryReload = () => {
      const quiet = Date.now() - lastKey > 4000 || document.hidden || !document.hasFocus();
      if (!quiet) return setTimeout(tryReload, 1500);
      S.panes.forEach(p => p.flush());
      saveLayout();
      sessionStorage.setItem('justUpdated', '1');
      setTimeout(() => location.reload(), 150);   // let the last save land
    };
    tryReload();
  });
}

boot();
