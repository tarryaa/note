import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createNote, mergeNotes } from '../store.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function cloneState('), source.indexOf('function fillEditor('));
const context = { createNote };
runInNewContext(helpers, context);
const reconcile = context.reconcileState;
const settings = { theme: 'system', sort: 'updated', view: 'grid' };
const state = (notes, custom = settings) => ({ notes, settings: { ...custom } });
const note = (title = 'original') => ({ ...createNote({ title, body: 'original body' }), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('a failed local save can retry without dropping notes added by a second tab', () => {
  const original = note();
  const local = { ...original, body: 'local changes', updatedAt: '2026-01-02T00:00:00.000Z' };
  const added = note('added remotely');
  const result = reconcile(state([local]), state([original]), state([original, added]));
  assert.equal(result.state.notes.length, 2);
  assert.equal(result.state.notes.find((item) => item.id === original.id).body, 'local changes');
  assert.equal(result.state.notes.find((item) => item.id === added.id).title, 'added remotely');
});

test('disjoint title/body edits and changed settings merge without overwriting remote fields', () => {
  const original = note();
  const local = { ...original, title: 'local title', updatedAt: '2026-01-02T00:00:00.000Z' };
  const remote = { ...original, body: 'remote body', updatedAt: '2026-01-03T00:00:00.000Z' };
  const result = reconcile(state([local], { ...settings, sort: 'title' }), state([original]), state([remote], { ...settings, theme: 'dark' }));
  assert.equal(result.state.notes[0].title, 'local title');
  assert.equal(result.state.notes[0].body, 'remote body');
  assert.equal(result.state.settings.theme, 'dark');
  assert.equal(result.state.settings.sort, 'title');
  assert.equal(result.copied.size, 0);
});

test('conflicting text edits preserve remote revision and create one bounded-title local copy', () => {
  const original = note('あ'.repeat(1000));
  const local = { ...original, body: 'local body', updatedAt: '2026-01-02T00:00:00.000Z' };
  const remote = { ...original, body: 'remote body', updatedAt: '2026-01-03T00:00:00.000Z' };
  const result = reconcile(state([local]), state([original]), state([remote]));
  const copy = result.copied.get(original.id);
  assert.equal(result.state.notes.length, 2);
  assert.equal(result.state.notes.find((item) => item.id === original.id).body, 'remote body');
  assert.equal(copy.body, 'local body');
  assert.equal(copy.title.length, 1000);
  assert.notEqual(copy.id, original.id);
  // Retrying a quota-failed write uses the just-read remote snapshot as baseline.
  const retry = reconcile(result.state, state([remote]), state([remote]));
  assert.equal(retry.state.notes.length, 2);
  assert.equal(retry.copied.size, 0);
});

test('permanent remote deletion is retained; a genuinely edited local body is preserved under a new ID', () => {
  const original = note();
  const unchanged = reconcile(state([original]), state([original]), state([]));
  assert.equal(unchanged.state.notes.length, 0);
  const edited = { ...original, body: 'unsaved text', updatedAt: '2026-01-02T00:00:00.000Z' };
  const result = reconcile(state([edited]), state([original]), state([]));
  assert.equal(result.state.notes.length, 1);
  assert.notEqual(result.state.notes[0].id, original.id);
  assert.equal(result.state.notes[0].body, 'unsaved text');
  const pinned = reconcile(state([{ ...original, pinned: true }]), state([original]), state([]));
  assert.equal(pinned.state.notes.length, 0);
});

test('an explicit local permanent deletion also removes an updated remote revision', () => {
  const original = note();
  const remote = { ...original, body: 'remote update', updatedAt: '2026-01-02T00:00:00.000Z' };
  assert.equal(reconcile(state([]), state([original]), state([remote])).state.notes.length, 0);
});

test('imports keep the newest full revision and do not create copies from older backups', () => {
  const original = note();
  const backup = { ...original, title: 'backup', body: 'older backup', updatedAt: '2026-01-02T00:00:00.000Z' };
  const remote = { ...original, title: 'remote', body: 'newest remote', updatedAt: '2026-01-03T00:00:00.000Z' };
  const result = reconcile(state(mergeNotes([original], [backup])), state([original]), state([remote]), { importing: true });
  assert.deepEqual(plain(result.state.notes), [remote]);
  assert.equal(result.copied.size, 0);
  const newest = { ...backup, updatedAt: '2026-01-04T00:00:00.000Z' };
  assert.deepEqual(plain(reconcile(state([newest]), state([original]), state([remote]), { importing: true }).state.notes), [newest]);
  assert.deepEqual(mergeNotes([remote], [backup]), [remote]);
  assert.equal(reconcile(state([backup]), state([original]), state([]), { importing: true }).state.notes.length, 0);
});

test('closing an unchanged draft neither writes storage nor changes its timestamp', () => {
  const current = note();
  let saves = 0;
  const saveContext = {
    draft: { ...current }, draftWasSaved: true, state: state([current]), unsaved: false,
    $: (selector) => ({ value: selector === '#note-title' ? current.title : current.body }),
    persist: () => { saves += 1; return true; }, updateEditorDecorations() {}, render() {},
  };
  const saveCode = source.slice(source.indexOf('function saveDraft('), source.indexOf('function closeEditor('));
  runInNewContext(saveCode, saveContext);
  assert.equal(saveContext.saveDraft(), true);
  assert.equal(saves, 0);
  assert.equal(saveContext.draft.updatedAt, current.updatedAt);
  saveContext.unsaved = true;
  assert.equal(saveContext.saveDraft(), true);
  assert.equal(saves, 1);
});

test('ordinary storage events do not trigger another write; read-only trash changes create no copy', () => {
  const current = note();
  const listeners = {};
  let saves = 0;
  let adopted = 0;
  let latest = state([current, note('remote addition')]);
  const storageContext = {
    STORAGE_KEY: 'test', startupFailure: false, unsaved: false,
    draft: { ...current }, draftWasSaved: true, state: state([current]), persistedState: state([current]),
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    store: { load: () => latest }, sameNote: context.sameNote, editingCopy: context.editingCopy,
    cloneState: context.cloneState, fillEditor() {}, toast() {},
    saveDraft() { saves += 1; }, adoptSavedDraft() { adopted += 1; }, applyTheme() {}, render() {}, showStorageError(error) { throw error; },
  };
  const eventCode = source.slice(source.indexOf("window.addEventListener('storage'"), source.indexOf('function updateConnection('));
  runInNewContext(eventCode, storageContext);
  listeners.storage({ key: 'test' });
  assert.equal(saves, 0);
  assert.equal(adopted, 1);
  storageContext.draft = { ...current, deletedAt: '2026-01-02T00:00:00.000Z' };
  latest = state([{ ...current, body: 'restored remotely' }]);
  listeners.storage({ key: 'test' });
  assert.equal(saves, 0);
  assert.equal(storageContext.draft.id, current.id);
  storageContext.draft = { ...current };
  listeners.storage({ key: 'test' });
  assert.equal(saves, 1);
  assert.notEqual(storageContext.draft.id, current.id);
});
