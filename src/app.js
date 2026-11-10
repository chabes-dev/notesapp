import './styles.css';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { TextSelection, Plugin } from '@tiptap/pm/state';
import { keydownHandler } from '@tiptap/pm/keymap';

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
const h = (html, d = document) => { const t = d.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
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
  // lists indent themselves: a line that joins a list drops its own indent (no gap after the bullet)
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some(t => t.docChanged)) return null;
        let tr = null;
        state.doc.descendants((node, pos, parent) => {
          if (INDENTABLE.includes(node.type.name) && node.attrs.indent && parent && LIST_ITEMS.includes(parent.type.name)) {
            tr = tr || state.tr;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: 0 });
          }
          return !node.isTextblock;
        });
        return tr;
      },
    })];
  },
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
// Dashed lists are bullet lists with a flag, like Apple Notes' "Dashed List".
const DashedFlag = Extension.create({
  name: 'dashedFlag',
  addGlobalAttributes() {
    return [{ types: ['bulletList'], attributes: { dashed: {
      default: false,
      parseHTML: el => el.getAttribute('data-dashed') === 'true',
      renderHTML: a => (a.dashed ? { 'data-dashed': 'true' } : {}),
    } } }];
  },
});
function setList(ed, kind) {
  if (kind === 'numbered') return ed.chain().focus().toggleOrderedList().run();
  const wantDashed = kind === 'dashed';
  if (ed.isActive('bulletList')) {
    const isDashed = ed.isActive('bulletList', { dashed: true });
    if (isDashed === wantDashed) return ed.chain().focus().toggleBulletList().run();      // same style again = off
    return ed.chain().focus().updateAttributes('bulletList', { dashed: wantDashed }).run();
  }
  return ed.chain().focus().toggleBulletList().updateAttributes('bulletList', { dashed: wantDashed }).run();
}
function toggleChecked(ed) {
  const { $from } = ed.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'taskItem') {
      ed.view.dispatch(ed.state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked: !n.attrs.checked }));
      return true;
    }
  }
  return false;
}
function moveItem(ed, dir) {   // ⌃⌘↑ / ⌃⌘↓ : move a list or checklist item
  const { state } = ed, { $from } = state.selection;
  let d = $from.depth;
  while (d > 0 && !LIST_ITEMS.includes($from.node(d).type.name)) d--;
  if (!d) return false;
  const item = $from.node(d), parent = $from.node(d - 1), idx = $from.index(d - 1), sib = idx + dir;
  if (sib < 0 || sib >= parent.childCount) return true;
  const start = $from.before(d), offset = $from.pos - start, tr = state.tr;
  let newStart;
  if (dir < 0) {
    const prev = parent.child(sib); newStart = start - prev.nodeSize;
    tr.delete(start, start + item.nodeSize).insert(newStart, item);
  } else {
    const next = parent.child(sib);
    tr.insert(start + item.nodeSize + next.nodeSize, item).delete(start, start + item.nodeSize);
    newStart = start + next.nodeSize;
  }
  tr.setSelection(TextSelection.create(tr.doc, newStart + offset)).scrollIntoView();
  ed.view.dispatch(tr);
  return true;
}
function editLink(ed) {
  const prev = ed.getAttributes('link').href || '';
  const url = window.prompt('Link address', prev || 'https://');
  if (url === null) return true;
  const u = url.trim();
  if (!u || u === 'https://') { ed.chain().focus().extendMarkRange('link').unsetLink().run(); return true; }
  const href = /^[a-z]+:/i.test(u) ? u : 'https://' + u;
  if (ed.state.selection.empty && !ed.isActive('link')) ed.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  else ed.chain().focus().extendMarkRange('link').setLink({ href }).run();
  return true;
}
// Apple Notes keyboard shortcuts (support.apple.com/guide/notes/apd46c25187e/mac).
// Wired in as the editor's own key handler so they win over the editor's built-in defaults.
function appleBindings() {
  const c = ed => ed.chain().focus();
  return {
    'Mod-Shift-t': ed => c(ed).toggleHeading({ level: 1 }).run() || true,
    'Mod-Shift-h': ed => c(ed).toggleHeading({ level: 2 }).run() || true,
    'Mod-Shift-j': ed => c(ed).toggleHeading({ level: 3 }).run() || true,
    'Mod-Shift-b': ed => c(ed).setParagraph().run() || true,
    'Mod-Shift-m': ed => c(ed).toggleCodeBlock().run() || true,
    'Mod-Shift-7': ed => setList(ed, 'bullet') || true,
    'Mod-Shift-8': ed => setList(ed, 'dashed') || true,
    'Mod-Shift-9': ed => setList(ed, 'numbered') || true,
    'Mod-Shift-l': ed => c(ed).toggleTaskList().run() || true,
    'Mod-Shift-u': ed => toggleChecked(ed),
    "Mod-'": ed => c(ed).toggleBlockquote().run() || true,
    'Mod-l': ed => c(ed).setHorizontalRule().run() || true,
    'Mod-k': ed => editLink(ed),
    'Ctrl-Mod-ArrowUp': ed => moveItem(ed, -1),
    'Ctrl-Mod-ArrowDown': ed => moveItem(ed, 1),
    'Alt-Tab': ed => c(ed).insertContent('\t').run(),
  };
}
function appleKeyHandler(getEd) {
  const map = appleBindings(), bound = {};
  for (const k in map) bound[k] = () => map[k](getEd()) !== false;
  return keydownHandler(bound);
}
const editorExtensions = () => [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
  TaskList, TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: 'Start writing…' }),
  Indent, DashedFlag,
];

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
  livePanes().forEach(p => { if (p.noteId === id) p.show(null); });
  scheduleList();
}
const isBlank = n => !n || !n.text.trim();
const openElsewhere = (id, except) => livePanes().some(p => p !== except && p.noteId === id);
const livePanes = () => FLOATS.length ? [...S.panes, ...FLOATS.map(f => f.pane)] : S.panes;
function discardIfBlank(id, except) {
  const n = S.notes.get(id);
  if (n && isBlank(n) && !openElsewhere(id, except)) hardDelete(id);
}
async function trashNote(id) {
  const n = S.notes.get(id); if (!n) return;
  if (n.deleted) { if (confirm(`Delete "${n.title}" forever?`)) hardDelete(id); return; }
  await persist({ ...n, deleted: Date.now(), pinned: false });
  livePanes().forEach(p => { if (p.noteId === id) p.show(null); });
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
  constructor(noteId, opts = {}) {
    this.noteId = null;
    this.floating = opts.win || null;          // set when this pane lives in a floating window
    this.el = h(`<section class="pane">
      <header class="phead">
        <button class="ibtn sidetoggle" title="Show/hide sidebar (${isMac ? '⌃⌘S' : 'Ctrl+Alt+S'})">${ICON.side}</button>
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
    </section>`, opts.win ? opts.win.document : document);
    if (opts.mount) opts.mount(this.el);       // floating: put it in its window before the editor starts
    this.editor = new Editor({
      element: $('.host', this.el),
      extensions: editorExtensions(),
      editorProps: { handleKeyDown: appleKeyHandler(() => this.editor) },
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
    $('.po', el).onclick = () => { if (!this.noteId) return; if (this.floating) dockFloat(this); else popOut(this.noteId); };
    $('.cl', el).onclick = () => closePane(this);
    // links: ⌘-click opens them
    $('.host', el).addEventListener('click', e => {
      const a = e.target.closest('a'); if (a && (e.metaKey || e.ctrlKey)) window.open(a.href, '_blank');
    });
    // typing hides everything but the words (like Spark)
    $('.host', el).addEventListener('keydown', e => {
      this.lastType = Date.now();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.floating) return;
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
    if (this.floating) {
      $('.sidetoggle', this.el).style.display = 'none';
      $('.sp', this.el).style.display = 'none';
      $('.cl', this.el).style.display = 'none';
      $('.po', this.el).title = 'Dock into the main window';
      if (n) this.floating.document.title = n.title;
      return;
    }
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
    livePanes().forEach(p => { if (p !== this) p.receive(next); });
    this.header();
  }
  receive(note) {   // the same note changed in another pane or window
    if (!note || this.noteId !== note.id) return;
    if (note.updated > (this.shown || 0)) {
      const typingHere = this.editor.isFocused && this.el.ownerDocument.hasFocus() && Date.now() - (this.lastType || 0) < 5000;
      if (typingHere) this.pending = true;   // don't yank text from under the cursor
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
      ['Monostyled', `${K}⇧M`, () => ed.chain().focus().toggleCodeBlock().run(), A('codeBlock')],
      '-',
      ['Bulleted list', `${K}⇧7`, () => setList(ed, 'bullet'), ed.isActive('bulletList') && !ed.isActive('bulletList', { dashed: true }) ? 'on' : ''],
      ['Dashed list', `${K}⇧8`, () => setList(ed, 'dashed'), A('bulletList', { dashed: true })],
      ['Numbered list', `${K}⇧9`, () => setList(ed, 'numbered'), A('orderedList')],
      ['Checklist', `${K}⇧L`, () => ed.chain().focus().toggleTaskList().run(), A('taskList')],
      '-',
      ['Bold', `${K}B`, () => ed.chain().focus().toggleBold().run(), A('bold')],
      ['Italic', `${K}I`, () => ed.chain().focus().toggleItalic().run(), A('italic')],
      ['Underline', `${K}U`, () => ed.chain().focus().toggleUnderline().run(), A('underline')],
      ['Strikethrough', `${K}⇧S`, () => ed.chain().focus().toggleStrike().run(), A('strike')],
      '-',
      ['Indent', `${K}] · Tab`, () => { ed.commands.focus(); ed.commands.keyboardShortcut('Tab'); }, ''],
      ['Outdent', `${K}[ · ⇧Tab`, () => { ed.commands.focus(); ed.commands.keyboardShortcut('Shift-Tab'); }, ''],
      ['Block quote', `${K}'`, () => ed.chain().focus().toggleBlockquote().run(), A('blockquote')],
      ['Divider line', `${K}L`, () => ed.chain().focus().setHorizontalRule().run(), ''],
      ['Link…', `${K}K`, () => editLink(ed), A('link')],
      '-',
      ['Rewrite in floating window', `${isMac ? '⌥⌘' : 'Ctrl+Alt+'}N`, () => openSandbox(), ''],
      ['All shortcuts', `${K}/`, () => showShortcuts(), ''],
    ];
    menu(anchor, items, { alignRight: true });
  }
  destroy() { this.flush(); this.editor.destroy(); this.el.remove(); }
}

function setActive(p) {
  if (!p || S.active === p || p.floating) return;   // floating notes never become the main window's target
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
  if (already && !newPane) { setActive(already); return; }
  if (newPane) return addPane(id, S.active);
  S.active.show(id);
}
function popOut(id) {
  livePanes().forEach(p => p.flush());
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
  const row = (id, name, editable) => `<button tabindex="-1" class="folder ${S.view === id && !S.query ? 'on' : ''}" data-f="${id}" ${editable ? 'data-edit="1"' : ''}>${esc(name)}<span class="n">${count(id) || ''}</span></button>`;
  $('#flist').innerHTML =
    `<div class="fsec">${row('all', 'All Notes')}${row('notes', 'Notes')}</div>` +
    (S.folders.length ? `<div class="label">Folders</div><div class="fsec">${S.folders.map(f => row(f.id, f.name, true)).join('')}</div>` : '') +
    `<div class="fsec">${row('trash', 'Recently Deleted')}</div>`;
}
const visibleSorted = () => visibleNotes().sort((a, b) => (b.pinned - a.pinned) || ((S.view === 'trash' ? b.deleted - a.deleted : b.updated - a.updated)));
function renderList() {
  const notes = visibleSorted();
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
  $('#newfolder').onclick = () => newFolderNow();
  $('#compose').onclick = () => composeNew();
  $('#q').addEventListener('input', e => { S.query = e.target.value.trim(); scheduleList(); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; S.query = ''; scheduleList(); S.active.editor.commands.focus(); } });

  const notesEl = $('#notes');
  notesEl.addEventListener('click', e => {
    const r = e.target.closest('.note'); if (!r) return;
    openNote(r.dataset.id, { newPane: e.metaKey || e.ctrlKey });
    if (!(e.metaKey || e.ctrlKey)) notesEl.focus({ preventScroll: true });
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

function closeMenus() { [document, ...FLOATS.map(f => f.win.document)].forEach(d => { try { d.querySelectorAll('.pop').forEach(p => p.remove()); } catch {} }); }
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
  if (anchor && anchor.nodeType === 1) {   // (not instanceof: floating windows have their own Element)
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
  livePanes().forEach(p => p.flush());
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
// Sidebar keyboard: Tab cycles folders → list → search (like Notes), arrows move, Return starts typing.
const SIDE_STOPS = () => [$('#flist'), $('#notes'), $('#q')];
function sidebarKeys(e) {
  const ae = document.activeElement, stops = SIDE_STOPS(), i = stops.findIndex(x => x === ae || (x !== $('#q') && x.contains(ae)));
  if (i < 0) return false;
  if (e.key === 'Tab') { e.preventDefault(); stops[(i + (e.shiftKey ? 2 : 1)) % 3].focus(); return true; }
  if (i === 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const ids = [...$('#flist').querySelectorAll('.folder')].map(b => b.dataset.f), j = ids.indexOf(S.view);
    const next = ids[Math.max(0, Math.min(ids.length - 1, j + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { S.view = next; S.query = ''; $('#q').value = ''; scheduleList(); saveLayout(); }
    return true;
  }
  if (i === 1 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const ids = visibleSorted().map(n => n.id), j = ids.indexOf(S.active.noteId);
    const next = ids[j < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, j + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { S.active.show(next); requestAnimationFrame(() => { const r = $(`.note[data-id="${next}"]`); r && r.scrollIntoView({ block: 'nearest' }); }); }
    return true;
  }
  if (i === 1 && e.key === 'Enter') { e.preventDefault(); S.active.noteId && S.active.editor.commands.focus('end'); return true; }
  return false;
}
let zoom = parseFloat(localStorage.getItem('zoom') || '1') || 1;
function setZoom(z) {
  zoom = Math.round(Math.max(0.7, Math.min(1.8, z)) * 100) / 100;
  document.documentElement.style.setProperty('--z', zoom);
  try { localStorage.setItem('zoom', zoom); } catch {}
}
setZoom(zoom);
function duplicateNote() {
  const src = S.active.noteId && S.notes.get(S.active.noteId); if (!src || src.deleted) return;
  S.active.flush();
  const n = newNote(src.folder);
  Object.assign(n, { doc: src.doc, text: src.text, title: src.title, snippet: src.snippet });
  persist(n).then(() => { S.active.show(n.id); toast('Duplicated'); });
}
async function newFolderNow() {
  document.body.classList.remove('hide-side', 'hide-folders', 'typing');
  const f = { id: uid(), name: 'New Folder' }; S.folders.push(f); await saveFolders(); renderFolders();
  renameFolder(f.id, $(`.folder[data-f="${f.id}"]`));
}
function printNote() {
  const p = S.active; if (!p.noteId) return;
  p.flush(); p.el.classList.add('printme'); document.body.classList.add('printing');
  const done = () => { p.el.classList.remove('printme'); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);
}
window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey, c = e.code;
  if (!mod) {
    if (sidebarKeys(e)) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && document.activeElement === $('#notes') && S.active.noteId) { e.preventDefault(); trashNote(S.active.noteId); }
    if (e.key === 'Escape') { closeMenus(); closeShortcuts(); document.body.classList.remove('typing'); }
    return;
  }
  const go = fn => { e.preventDefault(); e.stopPropagation(); fn(); };
  const sidebarCombo = isMac ? (e.metaKey && e.ctrlKey) : (e.ctrlKey && e.altKey);
  if (c === 'KeyN' && e.altKey && !e.shiftKey) go(openSandbox);                       // ⌥⌘N floating rewrite window
  else if (c === 'KeyN' && e.shiftKey) go(newFolderNow);                              // ⇧⌘N new folder
  else if (c === 'KeyN') go(floatingNote);                                            // ⌘N new note in a floating window
  else if (c === 'KeyS' && (sidebarCombo || e.altKey)) go(toggleSide);                // ⌃⌘S sidebar
  else if (c === 'KeyF' && e.altKey) go(() => { document.body.classList.remove('hide-side', 'typing'); $('#q').focus(); $('#q').select(); });
  else if (c === 'KeyD' && !e.shiftKey && !e.altKey) go(duplicateNote);              // ⌘D duplicate
  else if (c === 'KeyP' && !e.shiftKey && !e.altKey) go(printNote);                  // ⌘P print
  else if (c === 'Slash') go(showShortcuts);                                          // ⌘/ cheat sheet
  else if ((c === 'Equal' && !e.shiftKey) || (c === 'Equal' && e.shiftKey) || (c === 'Period' && e.shiftKey)) go(() => setZoom(zoom + 0.1));
  else if ((c === 'Minus') || (c === 'Comma' && e.shiftKey)) go(() => setZoom(zoom - 0.1));
  else if (c === 'Digit0' && e.shiftKey) go(() => setZoom(1));
  else if (c === 'Backslash') go(() => addPane(newNote(currentFolder()).id, S.active));
  else if (c === 'KeyW' && !e.shiftKey) go(() => closePane(S.active));                // ⌘W / ⌥⌘W close this pane — never the whole app
  else if (e.altKey && (c === 'ArrowRight' || c === 'ArrowLeft')) {   // move between panes
    const i = S.panes.indexOf(S.active) + (c === 'ArrowRight' ? 1 : -1);
    if (S.panes[i]) go(() => { setActive(S.panes[i]); S.panes[i].editor.commands.focus(); });
  }
}, true);

/* =========================================================
   ⌘N: a new note in its own floating window (500×600), like a note window in Apple Notes.
   Chrome lets one window float on top at a time: a new one takes the spot and the
   previous note docks into the main window, so nothing disappears. Where floating
   isn't available (e.g. Arc), each ⌘N opens an ordinary small window instead.
   ========================================================= */
const FLOATS = [];   // { win, pane, pip, dock }
let floatCount = 0;
function floatsUsePip() { return 'documentPictureInPicture' in window && localStorage.getItem('sandboxPopup') !== '1'; }
async function floatingNote() {
  const folder = currentFolder();
  let win = null, pip = false;
  if (floatsUsePip()) {
    FLOATS.forEach(f => { if (f.pip) f.dock = true; });    // the current floating note will dock
    if (SB) SB.replaced = true;
    try { win = await documentPictureInPicture.requestWindow({ width: 500, height: 600 }); pip = true; }
    catch (err) { FLOATS.forEach(f => { f.dock = false; }); win = null; }
  }
  if (!win) {
    const k = floatCount++ % 8;
    const left = (window.screenX || 0) + 80 + k * 32, top = (window.screenY || 0) + 60 + k * 32;
    win = window.open('', 'notes-float-' + Date.now(), `popup,width=500,height=600,left=${left},top=${top}`);
    if (!win) { toast('Chrome blocked the new window'); return; }
  }
  const n = newNote(folder);
  const doc = win.document;
  doc.head.innerHTML = '';
  document.querySelectorAll('style').forEach(st => doc.head.append(st.cloneNode(true)));
  doc.title = 'New Note';
  doc.body.className = 'floatnote';
  doc.body.innerHTML = '';
  const pane = new Pane(n.id, { win, mount: el => doc.body.append(el) });
  const f = { win, pane, pip, dock: false };
  FLOATS.push(f);
  doc.addEventListener('keydown', e => {
    lastKey = Date.now();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyN' && !e.altKey && !e.shiftKey) { e.preventDefault(); floatingNote(); }
    if (mod && e.code === 'KeyN' && e.altKey) { e.preventDefault(); }
    if (mod && e.code === 'KeyW' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); win.close(); }   // ⌘W closes only this floating note
  }, true);
  doc.addEventListener('mousedown', e => { if (!e.target.closest('.pop')) closeMenus(); });
  win.addEventListener('pagehide', () => endFloat(f));
  setTimeout(() => pane.editor.commands.focus('start'), 30);
  scheduleList();
}
function endFloat(f) {
  const i = FLOATS.indexOf(f); if (i < 0) return;
  FLOATS.splice(i, 1);
  const p = f.pane, id = p.noteId;
  try { p.flush(); p.editor.destroy(); } catch {}
  const n = id && S.notes.get(id);
  if (f.dock && n && !isBlank(n) && !n.deleted) {
    if (S.panes.length < MAX_PANES) addPane(id, S.active);
    else toast(`“${n.title}” is saved in your list`);
  } else if (id) discardIfBlank(id);
  scheduleList();
}
function dockFloat(pane) {
  const f = FLOATS.find(x => x.pane === pane); if (!f) return;
  pane.flush(); f.dock = true;
  try { f.win.close(); } catch {}
  endFloat(f);
}
window.addEventListener('pagehide', () => FLOATS.slice().forEach(f => { try { f.pane.flush(); f.win.close(); } catch {} }));

/* =========================================================
   Floating rewrite window (⌥⌘N)
   A sandbox: the passage is copied in, the original stays untouched
   until you press Replace or Insert below. Floats above every app
   (Chrome's Document Picture-in-Picture); falls back to a small window.
   ========================================================= */
let SB = null;   // { pane, noteId, from, to, inline, original, win, editor, off }
const words = t => (t.trim().match(/\S+/g) || []).length;
async function openSandbox() {
  const pane = S.active, ed = pane && pane.editor;
  if (!pane || !pane.noteId) return toast('Open a note first');
  const st = ed.state;
  let { from, to, empty } = st.selection;
  if (empty) {                                // no selection: take the paragraph / list item you're in
    const $f = st.selection.$from;
    let d = $f.depth;
    for (let x = $f.depth; x > 0; x--) if (LIST_ITEMS.includes($f.node(x).type.name)) { d = x; break; }
    from = $f.before(d); to = $f.after(d);
  }
  const slice = st.doc.slice(from, to);
  // a selection inside one paragraph comes back as bare text: remember that, so Replace keeps the sentence whole
  const inline = slice.content.childCount > 0 && slice.content.firstChild.isInline;
  let blocks = slice.content.toJSON() || [];
  if (inline) blocks = [{ type: 'paragraph', content: blocks }];
  // only list items selected → wrap them back in their list so the sandbox shows them as a list
  if (blocks.length && LIST_ITEMS.includes(blocks[0].type)) blocks = [{ type: blocks[0].type === 'taskItem' ? 'taskList' : 'bulletList', content: blocks }];
  const original = { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
  const originalText = st.doc.textBetween(from, to, '\n');

  // open the window synchronously inside the key press, so Chrome allows it
  let win;
  const forcePopup = localStorage.getItem('sandboxPopup') === '1';
  try {
    if (!forcePopup && 'documentPictureInPicture' in window) { FLOATS.forEach(f => { if (f.pip) f.dock = true; }); win = await documentPictureInPicture.requestWindow({ width: 560, height: 460 }); }
  } catch (err) { win = null; FLOATS.forEach(f => { f.dock = false; }); }
  if (!win) win = window.open('', 'notes-rewrite', 'popup,width=580,height=520');
  if (!win) return toast('Chrome blocked the floating window');
  closeSandbox(true);

  const doc = win.document;
  doc.title = 'Rewrite';
  doc.head.innerHTML = '';
  document.querySelectorAll('style').forEach(st => doc.head.append(st.cloneNode(true)));
  doc.body.className = 'sandbox';
  doc.body.innerHTML = `
    <header class="sbhead">
      <div class="sbtitle"><span class="label">Rewrite</span><span class="sbsrc"></span></div>
      <div class="sbcount"></div>
    </header>
    <div class="sbbody"><div class="host"></div></div>
    <footer class="sbfoot">
      <button class="pill" data-a="reset" title="Bring back the original text">Start over</button>
      <span style="flex:1"></span>
      <button class="pill" data-a="below" title="Keep the original and add this underneath">Insert below</button>
      <button class="pill primary" data-a="replace" title="${isMac ? '⌘' : 'Ctrl+'}Return">Replace</button>
    </footer>`;
  let editor;
  editor = new Editor({ element: doc.querySelector('.host'), extensions: editorExtensions(), editorProps: { handleKeyDown: appleKeyHandler(() => editor) }, content: original });
  SB = { pane, noteId: pane.noteId, from, to, inline, original, originalWords: words(originalText), win, editor };

  // keep the target range pointing at the same text while you keep editing the note
  const track = ({ transaction }) => {
    if (!SB || SB.pane !== pane || pane.noteId !== SB.noteId || SB.applying || !transaction.docChanged) return;
    SB.from = transaction.mapping.map(SB.from, 1);
    SB.to = Math.max(SB.from, transaction.mapping.map(SB.to, -1));
  };
  ed.on('transaction', track);
  SB.off = () => ed.off('transaction', track);

  const n = S.notes.get(pane.noteId);
  doc.querySelector('.sbsrc').textContent = n ? n.title : '';
  const count = () => { doc.querySelector('.sbcount').textContent = `${SB.originalWords} → ${words(editor.getText())} words`; };
  editor.on('update', count); count();
  doc.querySelector('.sbfoot').addEventListener('click', e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'reset') { editor.commands.setContent(SB.original); count(); editor.commands.focus('end'); }
    if (a.dataset.a === 'replace') applySandbox('replace');
    if (a.dataset.a === 'below') applySandbox('below');
  });
  doc.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applySandbox('replace'); }
    if (e.key === 'Escape') { e.preventDefault(); win.close(); }
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyW' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); win.close(); }
  }, true);
  win.addEventListener('pagehide', () => { if (SB && SB.win === win) closeSandbox(false); });
  editor.commands.focus('end');
}
function sandboxTarget() {
  // the note may have moved to another pane, or been closed: find it, or reopen it
  let pane = S.panes.includes(SB.pane) && SB.pane.noteId === SB.noteId ? SB.pane : S.panes.find(p => p.noteId === SB.noteId);
  if (!pane) {
    const n = S.notes.get(SB.noteId);
    if (!n || n.deleted) return null;
    pane = S.active; pane.show(SB.noteId);
  }
  return pane;
}
function applySandbox(how) {
  if (!SB) return;
  const pane = sandboxTarget();
  if (!pane) return toast('The original note is gone');
  const ed = pane.editor, out = (SB.editor.getJSON().content || []).slice();
  const isEmptyPara = n => n && n.type === 'paragraph' && !(n.content && n.content.length);
  while (out.length > 1 && isEmptyPara(out[out.length - 1])) out.pop();   // drop the editor's trailing empty line
  const size = Math.max(0, ed.state.doc.content.size);
  const from = Math.min(SB.from, size), to = Math.min(SB.to, size);
  SB.applying = true;
  try {
    if (how === 'replace') {
      const before = ed.state.doc.content.size;
      const content = SB.inline && out.length === 1 && out[0].type === 'paragraph' ? (out[0].content || []) : out;
          if (Array.isArray(content) && !content.length) ed.chain().deleteRange({ from, to }).run();
      else ed.chain().insertContentAt({ from, to }, content).run();
      SB.to = to + (ed.state.doc.content.size - before);
      SB.from = from;
      SB.original = SB.editor.getJSON();                 // the new text is now "the original"
      SB.originalWords = words(SB.editor.getText());
      SB.win.document.querySelector('.sbcount').textContent = `${SB.originalWords} → ${SB.originalWords} words`;
      toast('Replaced');
    } else {
      const $to = ed.state.doc.resolve(to);
      const at = $to.depth >= 1 ? $to.after(1) : to;
      ed.chain().insertContentAt(at, out).run();
      toast('Added below');
    }
  } finally { SB.applying = false; }
  pane.flush();
  SB.editor.commands.focus();
}
function closeSandbox(silent) {
  if (!SB) return;
  const s = SB; SB = null;
  try { s.off && s.off(); s.editor.destroy(); } catch {}
  if (!silent) { try { s.win.close(); } catch {} }
}
window.addEventListener('pagehide', () => { if (SB) try { SB.win.close(); } catch {} });

/* =========================================================
   Shortcut cheat sheet (⌘/)
   ========================================================= */
const KEYS = isMac ? { cmd: '⌘', opt: '⌥', ctl: '⌃', sh: '⇧' } : { cmd: 'Ctrl+', opt: 'Alt+', ctl: 'Ctrl+', sh: 'Shift+' };
function showShortcuts() {
  closeShortcuts();
  const { cmd, opt, ctl, sh } = KEYS;
  const groups = [
    ['Notes', [['New note (floating window)', cmd + 'N'], ['New note in this window', 'pencil button'], ['Rewrite in floating window', opt + cmd + 'N'], ['New folder', sh + cmd + 'N'], ['Duplicate note', cmd + 'D'], ['Search all notes', opt + cmd + 'F'], ['Show/hide sidebar', isMac ? '⌃⌘S' : 'Ctrl+Alt+S'], ['Print note', cmd + 'P'], ['Sidebar ↔ list ↔ search', 'Tab'], ['Start typing in selected note', 'Return']]],
    ['Side by side', [['Open a note next to this one', cmd + '\\'], [(isMac ? '⌘' : 'Ctrl') + '-click a note', 'opens it in a new pane'], ['Move between panes', opt + cmd + '← →'], ['Close pane / floating note', cmd + 'W']]],
    ['Text styles', [['Title', sh + cmd + 'T'], ['Heading', sh + cmd + 'H'], ['Subheading', sh + cmd + 'J'], ['Body', sh + cmd + 'B'], ['Monostyled', sh + cmd + 'M'], ['Block quote', cmd + "'"]]],
    ['Lists', [['Bulleted', sh + cmd + '7'], ['Dashed', sh + cmd + '8'], ['Numbered', sh + cmd + '9'], ['Checklist', sh + cmd + 'L'], ['Tick checklist item', sh + cmd + 'U'], ['Indent / outdent', cmd + '] · ' + cmd + '[ · Tab'], ['Move item up / down', ctl + cmd + '↑ ↓'], ['Tab inside a list item', opt + 'Tab']]],
    ['Edit', [['Bold · Italic · Underline', cmd + 'B · ' + cmd + 'I · ' + cmd + 'U'], ['Strikethrough', sh + cmd + 'S'], ['Link', cmd + 'K'], ['Divider line', cmd + 'L'], ['Bigger / smaller text', cmd + '+ · ' + cmd + '−'], ['Default text size', sh + cmd + '0']]],
  ];
  const el = h(`<div id="cheats"><div class="cheatbox"><div class="lhead"><h1>Keyboard shortcuts</h1><button class="ibtn" title="Close (Esc)">${ICON.close}</button></div>
    <div class="cheatcols">${groups.map(([g, rows]) => `<section><div class="label">${esc(g)}</div>${rows.map(([a, k]) => `<div class="crow"><span>${esc(a)}</span><kbd>${esc(k)}</kbd></div>`).join('')}</section>`).join('')}</div></div></div>`);
  el.addEventListener('mousedown', ev => { if (ev.target === el || ev.target.closest('.ibtn')) closeShortcuts(); });
  document.body.append(el);
}
function closeShortcuts() { const c = $('#cheats'); if (c) c.remove(); }

/* =========================================================
   Sync between windows
   ========================================================= */
bc && (bc.onmessage = ({ data }) => {
  if (data.t === 'note') { S.notes.set(data.note.id, data.note); livePanes().forEach(p => p.receive(data.note)); if (data.note.deleted) livePanes().forEach(p => { if (p.noteId === data.note.id) p.show(null); }); scheduleList(); }
  if (data.t === 'gone') { S.notes.delete(data.id); livePanes().forEach(p => { if (p.noteId === data.id) p.show(null); }); scheduleList(); }
  if (data.t === 'folders') { S.folders = data.folders; scheduleList(); }
});
window.addEventListener('pagehide', () => livePanes().forEach(p => p.flush()));
// Fallback for when the page is opened straight from a file (no live channel there):
// a window you're not typing in quietly re-reads the notes every second.
window.addEventListener('blur', () => livePanes().forEach(p => p.flush()));
async function refreshFromDB() {
  const all = await DB.all('notes'), seen = new Set();
  for (const n of all) {
    seen.add(n.id);
    const cur = S.notes.get(n.id);
    if (!cur || n.updated > cur.updated || n.deleted !== cur.deleted || n.pinned !== cur.pinned || n.folder !== cur.folder) {
      S.notes.set(n.id, n); livePanes().forEach(p => p.receive(n));
      if (n.deleted) livePanes().forEach(p => { if (p.noteId === n.id) p.show(null); });
      scheduleList();
    }
  }
  for (const [id, n] of S.notes) if (!seen.has(id) && !isBlank(n)) { S.notes.delete(id); livePanes().forEach(p => { if (p.noteId === id) p.show(null); }); scheduleList(); }
  livePanes().forEach(p => p.noteId && p.receive(S.notes.get(p.noteId)));
  const folders = (await DB.get('meta', 'folders')) || [];
  if (JSON.stringify(folders) !== JSON.stringify(S.folders)) { S.folders = folders; scheduleList(); }
}
setInterval(() => { if (!document.hidden && (!document.hasFocus() || !livePanes().some(p => p.editor.isFocused))) refreshFromDB(); }, 1000);
window.addEventListener('focus', () => refreshFromDB());
document.addEventListener('visibilitychange', () => { if (document.hidden) livePanes().forEach(p => p.flush()); });

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
      const quiet = !FLOATS.length && (Date.now() - lastKey > 4000 || document.hidden || !document.hasFocus());   // never close your floating notes
      if (!quiet) return setTimeout(tryReload, 1500);
      livePanes().forEach(p => p.flush());
      saveLayout();
      sessionStorage.setItem('justUpdated', '1');
      setTimeout(() => location.reload(), 150);   // let the last save land
    };
    tryReload();
  });
}

boot();
