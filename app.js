import { createStore, createNote, normalizeText, exportBackup, parseBackup, mergeNotes, STORAGE_KEY, MAX_BACKUP_BYTES } from './store.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const editor = $('#editor');
const settingsDialog = $('#settings');
let state = { notes: [], settings: { theme: 'dark', sort: 'updated', view: 'grid' } };
let store;
let startupFailure = false;
let unsaved = false;
let filter = 'all';
let collection = 'all';
let draft = null;
let draftWasSaved = false;
let returnFocus = null;
let toastTimer;
let confirmResolve;
let waitingWorker;
let updating = false;
let persistedState = cloneState(state);

try {
  store = createStore();
  state = store.load();
  persistedState = cloneState(state);
} catch (error) {
  startupFailure = true;
  showStorageError(error);
}

function showStorageError(error) {
  $('#storage-warning').textContent = error.message;
  $('#storage-warning').hidden = false;
}

function cloneState(value) {
  return { notes: value.notes.map((note) => ({ ...note })), settings: { ...value.settings } };
}

function sameNote(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function editingCopy(note) {
  const suffix = '（編集中のコピー）';
  return {
    ...createNote({ title: `${(note.title || '無題のメモ').slice(0, 1000 - suffix.length)}${suffix}`, body: note.body, color: note.color }),
    pinned: note.pinned,
  };
}

// Apply only local changes since the last successful read/write. An absent remote
// ID is a permanent deletion, so stale tabs must never write that ID back.
function reconcileState(local, previous, remote, { importing = false } = {}) {
  const original = new Map(previous.notes.map((note) => [note.id, note]));
  const current = new Map(local.notes.map((note) => [note.id, note]));
  const latest = new Map(remote.notes.map((note) => [note.id, { ...note }]));
  const copied = new Map();
  for (const note of local.notes) {
    const before = original.get(note.id);
    const other = latest.get(note.id);
    if (sameNote(note, before)) continue;
    if (importing) {
      if ((!before && !other) || (other && note.updatedAt > other.updatedAt)) latest.set(note.id, { ...note });
      continue;
    }
    if (!before) {
      if (!other || note.updatedAt > other.updatedAt) latest.set(note.id, { ...note });
      continue;
    }
    const textChanged = ['title', 'body'].some((field) => note[field] !== before[field]);
    const conflictingText = other && ['title', 'body'].some((field) => note[field] !== before[field] && other[field] !== before[field] && note[field] !== other[field]);
    if (!other || conflictingText || (textChanged && other.deletedAt && !note.deletedAt)) {
      if (textChanged && !note.deletedAt) {
        const copy = editingCopy(note);
        latest.set(copy.id, copy);
        copied.set(note.id, copy);
      }
      continue;
    }
    const combined = { ...other };
    for (const field of ['title', 'body', 'color', 'pinned', 'deletedAt']) {
      if (note[field] !== before[field]) combined[field] = note[field];
    }
    combined.updatedAt = note.updatedAt > other.updatedAt ? note.updatedAt : other.updatedAt;
    latest.set(note.id, combined);
  }
  for (const note of previous.notes) {
    if (!current.has(note.id)) latest.delete(note.id);
  }
  const settings = { ...remote.settings };
  for (const key of ['theme', 'sort', 'view']) {
    if (local.settings[key] !== previous.settings[key]) settings[key] = local.settings[key];
  }
  return { state: { notes: [...latest.values()], settings }, copied };
}

function fillEditor() {
  if (!draft) return;
  $('#note-title').value = draft.title;
  $('#note-body').value = draft.body;
  $('#editor-date').textContent = formatDate(draft.updatedAt, true);
  const readOnly = Boolean(draft.deletedAt);
  $('#note-title').readOnly = readOnly;
  $('#note-body').readOnly = readOnly;
  $('#trash-note').hidden = readOnly;
  $('#restore-note').hidden = !readOnly;
  $('#delete-note').hidden = !readOnly;
  $('#editor-pin').hidden = readOnly;
  $('.color-picker').hidden = readOnly;
  updateEditorDecorations();
}

function adoptSavedDraft(copied) {
  if (!draft || !draftWasSaved) return;
  const copy = copied.get(draft.id);
  const saved = copy || state.notes.find((note) => note.id === draft.id);
  if (!saved) {
    editor.close();
    draft = null;
    toast('このメモは別の画面で完全に削除されました');
    return;
  }
  if (!sameNote(draft, saved)) {
    draft = { ...saved };
    fillEditor();
  }
  if (copy) toast('別の画面の変更を反映し、編集中の内容をコピーに残しました');
}

function persist({ replaceUnreadable = false, importing = false } = {}) {
  if (startupFailure || !store) return false;
  try {
    const latest = replaceUnreadable ? cloneState(persistedState) : store.load();
    const reconciled = reconcileState(state, persistedState, latest, { importing });
    state = reconciled.state;
    persistedState = cloneState(latest);
    adoptSavedDraft(reconciled.copied);
    store.save(state);
    persistedState = cloneState(state);
    unsaved = false;
    $('#storage-warning').hidden = true;
    setSaveStatus('この端末に保存済み');
    applyTheme();
    return true;
  } catch (error) {
    unsaved = true;
    showStorageError(error);
    setSaveStatus('保存できませんでした', true);
    return false;
  }
}

function setSaveStatus(text, failed = false) {
  $('#save-status').textContent = text;
  $('#save-status').classList.toggle('error', failed);
}

function applyTheme() {
  const dark = state.settings.theme === 'dark' || (state.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#080b14' : '#eef0f7';
  $('#theme').value = state.settings.theme;
}

function noteTitle(note) {
  return note.title.trim() || note.body.trim().split('\n')[0].slice(0, 70) || '無題のメモ';
}

function formatDate(iso, full = false) {
  const date = new Date(iso);
  if (full) return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60000) return 'たった今';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(date);
  return new Intl.DateTimeFormat('ja-JP', { year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined, month: 'numeric', day: 'numeric' }).format(date);
}

function render() {
  const active = state.notes.filter((note) => !note.deletedAt);
  const trashed = state.notes.filter((note) => note.deletedAt);
  const pinned = active.filter((note) => note.pinned);
  $('#stat-notes').textContent = String(active.length).padStart(2, '0');
  $('#stat-pinned').textContent = String(pinned.length).padStart(2, '0');
  const characters = active.reduce((total, note) => total + [...note.body].length, 0);
  $('#stat-characters').textContent = characters.toLocaleString('ja-JP');
  $$('[data-count-color]').forEach((counter) => {
    counter.textContent = active.filter((note) => note.color === counter.dataset.countColor).length;
  });
  $$('[data-collection]').forEach((button) => {
    const selected = button.dataset.collection === collection;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#count-all').textContent = active.length;
  $('#count-pinned').textContent = pinned.length;
  $('#count-trash').textContent = trashed.length;
  $$('[data-filter]').forEach((button) => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const headings = {
    all: ['すべてのメモ', 'あなたの思考に、自由な余白を。', 'YOUR NOTES'],
    pinned: ['ピン留め', 'いつでも、すぐに取り出せるように。', 'PINNED NOTES'],
    trash: ['ごみ箱', '必要になったら、いつでも戻せます。', 'RECENTLY DELETED'],
  };
  const [title, description, label] = headings[filter];
  $('#page-title').replaceChildren(document.createTextNode(title));
  const dot = document.createElement('span');
  dot.className = 'heading-dot';
  dot.textContent = '.';
  $('#page-title').append(dot);
  $('#page-description').textContent = description;
  $('#section-label').textContent = label;
  const query = normalizeText($('#search').value);
  const words = query.split(/\s+/u).filter(Boolean);
  let notes = filter === 'trash' ? trashed : filter === 'pinned' ? pinned : active;
  if (collection !== 'all') notes = notes.filter((note) => note.color === collection);
  $('#page-count').textContent = `${notes.length} ${notes.length === 1 ? 'NOTE' : 'NOTES'}`;
  notes = notes.filter((note) => words.every((word) => normalizeText(`${note.title}\n${note.body}`).includes(word)));
  notes.sort((a, b) => {
    if (filter !== 'trash' && a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
    if (state.settings.sort === 'title') return noteTitle(a).localeCompare(noteTitle(b), 'ja');
    const key = state.settings.sort === 'created' ? 'createdAt' : 'updatedAt';
    return b[key].localeCompare(a[key]) || a.id.localeCompare(b.id);
  });
  $('#result-count').textContent = query ? `${notes.length}件の検索結果` : notes.length ? `${notes.length}件のメモ` : '日々のかけらを、この場所に。';
  $('#sort').value = state.settings.sort;
  $('#notes').classList.toggle('list-view', state.settings.view === 'list');
  for (const view of ['grid', 'list']) {
    $(`#view-${view}`).classList.toggle('selected', state.settings.view === view);
    $(`#view-${view}`).setAttribute('aria-pressed', String(state.settings.view === view));
  }
  $('#notes').replaceChildren(...notes.map(makeCard));
  $('.collection-filters').classList.toggle('has-filter', collection !== 'all');
  $('#empty-state').hidden = notes.length > 0;
  if (!notes.length) renderEmpty(query);
  $$('[data-action="new"]').forEach((button) => { button.disabled = startupFailure; });
}

function makeCard(note) {
  const card = document.createElement('article');
  card.className = `note-card ${note.color}${note.pinned ? ' is-pinned' : ''}`;
  const main = document.createElement('button');
  main.className = 'note-card-main';
  main.setAttribute('aria-label', `メモを開く: ${noteTitle(note)}`);
  const category = document.createElement('span');
  category.className = 'card-category';
  const colorNames = { plain: 'グラファイト', blue: 'ブルー', sand: 'パープル', rose: 'ローズ', sage: 'ミント' };
  category.innerHTML = `<span class="collection-dot ${note.color}"></span>`;
  category.append(document.createTextNode(colorNames[note.color]));
  if (note.pinned) {
    const label = document.createElement('span');
    label.className = 'pinned-label';
    label.textContent = 'PINNED';
    category.append(label);
  }
  const title = document.createElement('h2');
  title.textContent = noteTitle(note);
  const body = document.createElement('p');
  body.textContent = note.body || '本文はまだありません';
  if (!note.body) body.className = 'blank-body';
  main.append(category, title, body);
  main.addEventListener('click', () => openEditor(note.id));
  card.append(main);
  if (!note.deletedAt) {
    const pin = document.createElement('button');
    pin.className = 'icon-button card-pin';
    pin.innerHTML = icon('pin');
    pin.setAttribute('aria-label', `${noteTitle(note)}を${note.pinned ? 'ピン留めから外す' : 'ピン留めする'}`);
    pin.setAttribute('aria-pressed', String(note.pinned));
    pin.addEventListener('click', () => {
      note.pinned = !note.pinned;
      note.updatedAt = new Date().toISOString();
      if (persist()) toast(note.pinned ? 'ピン留めしました' : 'ピン留めを外しました');
      render();
    });
    card.append(pin);
  }
  const footer = document.createElement('div');
  footer.className = 'note-card-footer';
  const date = document.createElement('time');
  date.dateTime = note.deletedAt || note.updatedAt;
  date.textContent = `${note.deletedAt ? '削除 ' : ''}${formatDate(date.dateTime)}`;
  const count = document.createElement('span');
  count.textContent = `${[...note.body].length.toLocaleString('ja-JP')}文字`;
  footer.append(date, count);
  card.append(footer);
  return card;
}

function renderEmpty(query) {
  let title = 'まだないアイデアの、居場所。';
  let description = '浮かんだ言葉を、そのままに。\nあなただけの余白を、ここから。';
  let eyebrow = 'YOUR NEXT IDEA STARTS HERE';
  if (query) {
    title = 'メモが見つかりませんでした。';
    description = '違う言葉で、もう一度探してみてください。';
    eyebrow = 'LOOKING FOR A LITTLE THOUGHT';
  } else if (filter === 'pinned') {
    title = '大切なメモを、すぐそばに。';
    description = 'メモのピンのアイコンを押すと、\nここにまとめて表示されます。';
    eyebrow = 'KEEP YOUR FAVORITES CLOSE';
  } else if (filter === 'trash') {
    title = 'ごみ箱は空です。';
    description = '削除したメモは、ここから戻せます。\n完全に削除するまで、自動では消えません。';
    eyebrow = 'A FRESH LITTLE SPACE';
  } else if (collection !== 'all') {
    title = 'この色に、最初のひとことを。';
    description = '新しいメモを書いてみましょう。\n選んだ色で、自動的に整理されます。';
    eyebrow = 'A NEW COLLECTION';
  }
  if (!query && collection !== 'all' && filter !== 'all') {
    title = 'この色のメモはありません。';
    description = '別の色、または「すべて」を選んでください。';
    eyebrow = 'NO MATCHING NOTES';
  }
  $('#empty-title').textContent = title;
  $('#empty-description').textContent = description;
  $('#empty-description').style.whiteSpace = 'pre-line';
  $('#empty-eyebrow').textContent = eyebrow;
  $('#empty-create').hidden = Boolean(query) || filter !== 'all' || startupFailure;
  const first = state.notes.filter((note) => !note.deletedAt).length === 0;
  $('#empty-create').innerHTML = `${first ? 'はじめてのメモを書く' : '新しいメモを書く'}${icon('arrow')}`;
}

function openEditor(id = null) {
  if (startupFailure && !id) return;
  const note = state.notes.find((item) => item.id === id);
  draft = note ? { ...note } : createNote();
  if (!note && collection !== 'all') draft.color = collection;
  draftWasSaved = Boolean(note);
  returnFocus = document.activeElement;
  fillEditor();
  const readOnly = Boolean(draft.deletedAt);
  setSaveStatus(readOnly ? 'ごみ箱のメモ' : note ? 'この端末に保存済み' : '入力すると自動で保存');
  updateEditorDecorations();
  editor.showModal();
  fitMobileEditor();
  if (!readOnly) (note ? $('#note-body') : $('#note-title')).focus();
}

function updateEditorDecorations() {
  if (!draft) return;
  editor.dataset.color = draft.color;
  $('#editor-pin').setAttribute('aria-pressed', String(draft.pinned));
  $('#editor-pin').setAttribute('aria-label', draft.pinned ? 'ピン留めから外す' : 'ピン留めする');
  $$('.color-picker [data-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.color === draft.color)));
  $('#character-count').textContent = `${[...draft.body].length.toLocaleString('ja-JP')}文字`;
}

function saveDraft() {
  if (!draft || draft.deletedAt) return !unsaved;
  draft.title = $('#note-title').value;
  draft.body = $('#note-body').value;
  if (!draftWasSaved && !draft.title.trim() && !draft.body.trim()) return true;
  const current = state.notes.find((note) => note.id === draft.id);
  const changed = !current || ['title', 'body', 'color', 'pinned'].some((field) => draft[field] !== current[field]);
  if (!changed) {
    updateEditorDecorations();
    return unsaved ? persist() : true;
  }
  draft.updatedAt = new Date().toISOString();
  const index = state.notes.findIndex((note) => note.id === draft.id);
  if (index < 0) state.notes.push({ ...draft });
  else state.notes[index] = { ...draft };
  draftWasSaved = true;
  updateEditorDecorations();
  const saved = persist();
  render();
  return saved;
}

function closeEditor() {
  if (!saveDraft()) {
    toast('保存できません。共有ボタンから内容を書き出せます。');
    return false;
  }
  editor.close();
  draft = null;
  render();
  if (returnFocus?.isConnected) returnFocus.focus();
  else $('#search').focus({ preventScroll: true });
  return true;
}

function fitMobileEditor() {
  const viewport = window.visualViewport;
  if (window.innerWidth <= 760 && viewport && editor.open) {
    editor.style.height = `${viewport.height}px`;
    editor.style.top = `${viewport.offsetTop}px`;
  } else {
    editor.style.removeProperty('height');
    editor.style.removeProperty('top');
  }
}

window.visualViewport?.addEventListener('resize', fitMobileEditor);
window.visualViewport?.addEventListener('scroll', fitMobileEditor);
window.addEventListener('resize', fitMobileEditor);

function toast(message, action = null) {
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#toast-action').hidden = !action;
  $('#toast-action').onclick = action;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, action ? 8000 : 4500);
}

function confirmAction(title, description, label = '実行する', dangerous = false) {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-ok').textContent = label;
  $('#confirm-ok').style.background = dangerous ? 'var(--danger)' : '';
  $('#confirm-dialog').showModal();
  $('#confirm-cancel').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(result) {
  $('#confirm-dialog').close();
  confirmResolve?.(result);
  confirmResolve = null;
}

function download(content, filename, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function backupFilename() {
  const date = new Date();
  return `余白-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.json`;
}

$$('[data-action="new"]').forEach((button) => button.addEventListener('click', () => openEditor()));
$$('[data-action="settings"]').forEach((button) => button.addEventListener('click', () => settingsDialog.showModal()));
$$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  collection = 'all';
  $('#search').value = '';
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}));
$$('[data-collection]').forEach((button) => button.addEventListener('click', () => {
  collection = button.dataset.collection;
  if (button.closest('.sidebar-collections')) filter = 'all';
  render();
}));
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', (event) => {
  state.settings.sort = event.target.value;
  persist();
  render();
});
for (const view of ['grid', 'list']) {
  $(`#view-${view}`).addEventListener('click', () => {
    state.settings.view = view;
    persist();
    render();
  });
}
$('#theme').addEventListener('change', (event) => {
  state.settings.theme = event.target.value;
  applyTheme();
  persist();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
$('#close-settings').addEventListener('click', () => settingsDialog.close());
$('#editor-back').addEventListener('click', closeEditor);
$('#editor-done').addEventListener('click', closeEditor);
editor.addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
for (const id of ['#note-title', '#note-body']) {
  $(id).addEventListener('input', () => { saveDraft(); updateEditorDecorations(); });
}
$('#note-body').maxLength = 1000000;
$('#editor-pin').addEventListener('click', () => {
  draft.pinned = !draft.pinned;
  saveDraft();
  updateEditorDecorations();
});
$$('.color-picker [data-color]').forEach((button) => button.addEventListener('click', () => {
  draft.color = button.dataset.color;
  saveDraft();
  updateEditorDecorations();
}));
$('#trash-note').addEventListener('click', () => {
  if (!draftWasSaved) { closeEditor(); return; }
  if (!saveDraft()) return;
  const id = draft.id;
  const note = state.notes.find((item) => item.id === id);
  note.deletedAt = note.updatedAt = new Date().toISOString();
  if (!persist()) return;
  editor.close();
  draft = null;
  render();
  toast('メモをごみ箱へ移動しました', () => {
    const item = state.notes.find((memo) => memo.id === id);
    if (item) {
      item.deletedAt = null;
      item.updatedAt = new Date().toISOString();
      if (persist()) toast('メモを元に戻しました');
      render();
    }
  });
});
$('#restore-note').addEventListener('click', () => {
  const id = draft.id;
  const note = state.notes.find((item) => item.id === id);
  note.deletedAt = null;
  note.updatedAt = new Date().toISOString();
  if (!persist()) return;
  editor.close();
  draft = null;
  render();
  toast('メモを元に戻しました');
});
$('#delete-note').addEventListener('click', async () => {
  const id = draft.id;
  if (!await confirmAction('メモを完全に削除しますか？', 'この操作は元に戻せません。\n必要なメモは、先にバックアップしてください。', '完全に削除', true)) return;
  const oldNotes = state.notes;
  const previousPersisted = cloneState(persistedState);
  const previousUnsaved = unsaved;
  state.notes = state.notes.filter((note) => note.id !== id);
  if (!persist()) { state.notes = oldNotes; persistedState = previousPersisted; unsaved = previousUnsaved; return; }
  editor.close();
  draft = null;
  render();
  toast('メモを完全に削除しました');
});
$('#share-note').addEventListener('click', async () => {
  const text = [$('#note-title').value, $('#note-body').value].filter(Boolean).join('\n\n');
  if (!text.trim()) { toast('共有する内容を書いてください'); return; }
  try {
    if (navigator.share) await navigator.share({ title: noteTitle(draft), text });
    else {
      const filename = noteTitle(draft).replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 70);
      download(text, `${filename}.txt`, 'text/plain');
      setSaveStatus('テキストを書き出しました');
    }
  } catch (error) {
    if (error.name !== 'AbortError') setSaveStatus('共有できませんでした', true);
  }
});
$('#export-backup').addEventListener('click', () => {
  try {
    if (startupFailure) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) throw new Error('書き出せる保存データがありません。');
      download(raw, '余白-保存データの原本.json');
    } else download(exportBackup(state), backupFilename());
    toast('バックアップを書き出しました');
  } catch (error) { toast(error.message); }
});
$('#import-backup').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('ファイルが大きすぎます。10MB以内にしてください。');
    const incoming = parseBackup(await file.text());
    const replacingUnreadable = startupFailure;
    const description = startupFailure
      ? '読み込めない保存データを原本ファイルとして書き出し、バックアップで復元します。ダウンロードした原本を保管してください。'
      : '今あるメモは残ります。同じメモは、更新日時が新しい方を使います。ごみ箱のメモも含みます。';
    if (!await confirmAction(`${incoming.notes.length}件のメモを読み込みますか？`, description, '読み込む')) return;
    if (startupFailure) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) download(raw, '余白-復元前の原本.json');
      store = createStore();
      startupFailure = false;
    }
    const notes = mergeNotes(state.notes, incoming.notes);
    const previous = state;
    const previousPersisted = cloneState(persistedState);
    const previousUnsaved = unsaved;
    state = { notes, settings: state.settings };
    if (!persist({ replaceUnreadable: replacingUnreadable, importing: true })) {
      state = previous;
      persistedState = previousPersisted;
      unsaved = previousUnsaved;
      startupFailure = replacingUnreadable;
      throw new Error('読み込んだメモを保存できませんでした。保存領域を確認してください。');
    }
    render();
    toast('バックアップを読み込みました');
  } catch (error) { toast(error.message); }
});
$('#confirm-ok').addEventListener('click', () => settleConfirm(true));
$('#confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('#confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || editor.open || settingsDialog.open || $('#confirm-dialog').open) return;
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); openEditor(); }
});
window.addEventListener('beforeunload', (event) => {
  if (unsaved) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('storage', (event) => {
  if ((event.key !== STORAGE_KEY && event.key !== null) || startupFailure) return;
  if (unsaved) {
    // Preserve the unsaved revision; persist() rereads and reconciles before retrying.
    toast('別の画面にも変更があります。保存時に内容を照合します');
    return;
  }
  try {
    const latest = store.load();
    let copy = null;
    if (draft && draftWasSaved && !draft.deletedAt) {
      const remote = latest.notes.find((note) => note.id === draft.id);
      if (!sameNote(remote, draft)) {
        copy = editingCopy(draft);
        draft = copy;
        draftWasSaved = false;
        fillEditor();
        toast('別の画面の変更を反映し、編集中の内容をコピーに残しました');
      }
    }
    state = latest;
    persistedState = cloneState(latest);
    if (copy) saveDraft();
    else adoptSavedDraft(new Map());
    applyTheme();
    render();
  } catch (error) { showStorageError(error); }
});

function updateConnection() {
  $('#connection-label').textContent = navigator.onLine ? 'この端末に保存' : 'オフライン · この端末に保存';
}
window.addEventListener('online', updateConnection);
window.addEventListener('offline', updateConnection);

async function registerOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const showUpdate = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        $('#update-banner').hidden = false;
      }
    };
    showUpdate();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => { if (installing.state === 'installed') showUpdate(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updating) window.location.reload();
    });
  } catch {
    $('#connection-label').textContent = 'オフライン準備未完了 · オンラインで再度開いてください';
  }
}
$('#update-button').addEventListener('click', () => {
  if (!waitingWorker || (editor.open && !closeEditor()) || unsaved) return;
  updating = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
});

$('#today').textContent = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
applyTheme();
updateConnection();
render();
registerOffline();
