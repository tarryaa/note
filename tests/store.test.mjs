import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, MAX_BACKUP_BYTES, createStore, createNote, normalizeText,
  exportBackup, parseBackup, mergeNotes,
} from '../store.js';

const settings = { theme: 'system', sort: 'updated', view: 'grid' };
const state = (notes = []) => ({ notes, settings: { ...settings } });
function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[STORAGE_KEY, initial]]);
  return {
    writes: 0,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { this.writes += 1; values.set(key, value); },
  };
}

test('fresh state, exact Unicode round trip, and independent settings objects', () => {
  const store = createStore(memoryStorage());
  assert.deepEqual(store.load(), { notes: [], settings: { ...settings, theme: 'dark' } });
  const first = store.load();
  first.settings.theme = 'light';
  assert.equal(store.load().settings.theme, 'dark');
  const note = createNote({ title: '週末の買い物 🌿', body: '牛乳\nパン\n<script>alert(1)</script>', color: 'sage' });
  store.save(state([note]));
  assert.deepEqual(store.load(), state([note]));
});

test('malformed saved state is never silently replaced or written', () => {
  for (const bad of ['', '{broken', '{}', JSON.stringify({ app: 'yohaku', version: 99, notes: [], settings })]) {
    const storage = memoryStorage(bad);
    assert.throws(() => createStore(storage).load(), { code: 'INVALID_STORED_DATA' });
    assert.equal(storage.getItem(STORAGE_KEY), bad);
    assert.equal(storage.writes, 0);
  }
});

test('repository-scoped storage keys keep same-origin app installations independent', () => {
  const storage = memoryStorage();
  const first = createStore(storage, 'yohaku.notes.v1:/first/');
  const second = createStore(storage, 'yohaku.notes.v1:/second/');
  first.save(state([createNote({ title: 'first repository' })]));
  assert.equal(second.load().notes.length, 0);
  second.save(state([createNote({ title: 'second repository' })]));
  assert.equal(first.load().notes[0].title, 'first repository');
  assert.equal(second.load().notes[0].title, 'second repository');
});

test('a quota failure preserves the prior persisted data and remains visible to callers', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  const original = state([createNote({ title: '保存済み' })]);
  store.save(original);
  storage.setItem = () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; };
  assert.throws(() => store.save(state([createNote({ title: '未保存' })])), { code: 'STORAGE_QUOTA' });
  assert.deepEqual(store.load(), original);
});

test('storage access denial is surfaced separately from invalid content', () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() {} };
  assert.throws(() => createStore(storage).load(), { code: 'STORAGE_UNAVAILABLE' });
  assert.throws(() => createStore(null), { code: 'STORAGE_UNAVAILABLE' });
});

test('denied access to the localStorage property has an actionable storage error', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const denial = new DOMException('Storage is disabled', 'SecurityError');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw denial; },
  });
  try {
    assert.throws(() => createStore(), (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.cause, denial);
      assert.match(error.message, /保存設定/);
      return true;
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('portable backup preserves all fields and ignores unrelated injected properties', () => {
  const original = state([createNote({ title: 'テスト', body: '全角ＡＢＣと半角abc' })]);
  original.notes[0].pinned = true;
  original.settings = { theme: 'dark', sort: 'title', view: 'list' };
  assert.deepEqual(parseBackup(exportBackup(original)), original);
  const envelope = JSON.parse(exportBackup(original));
  envelope.notes[0].extra = 'ignored';
  assert.deepEqual(parseBackup(JSON.stringify(envelope)), original);
});

test('imports reject wrong app/version, bad fields, duplicate IDs, impossible dates, and oversized files', () => {
  const good = JSON.parse(exportBackup(state([createNote()])));
  const variants = [
    { ...good, app: 'other' },
    { ...good, version: 2 },
    { ...good, exportedAt: undefined },
    { ...good, notes: 'not-an-array' },
    { ...good, notes: [good.notes[0], good.notes[0]] },
    { ...good, notes: [{ ...good.notes[0], pinned: 'false' }] },
    { ...good, notes: [{ ...good.notes[0], color: 'purple' }] },
    { ...good, notes: [{ ...good.notes[0], createdAt: '2026-02-30T00:00:00.000Z' }] },
    { ...good, notes: [{ ...good.notes[0], body: 'a'.repeat(1000001) }] },
    { ...good, settings: { ...settings, theme: 'malformed' } },
  ];
  for (const variant of variants) assert.throws(() => parseBackup(JSON.stringify(variant)), { code: 'INVALID_DATA' });
  assert.throws(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1)), { code: 'INVALID_DATA' });
  assert.throws(() => parseBackup('あ'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3) + 1)), { code: 'INVALID_DATA' });
});

test('merge keeps newer content and tombstones, adds new IDs, and keeps local revision on ties', () => {
  const base = { ...createNote({ title: 'old' }), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const deleted = { ...base, title: 'current', updatedAt: '2026-01-03T00:00:00.000Z', deletedAt: '2026-01-03T00:00:00.000Z' };
  const added = { ...createNote({ title: 'added' }), updatedAt: '2026-01-02T00:00:00.000Z' };
  const result = mergeNotes([deleted], [base, added]);
  assert.deepEqual(result, [deleted, added]);
  assert.equal(mergeNotes([deleted], [{ ...deleted, title: 'tie' }])[0].title, 'current');
  const newer = { ...base, title: 'newer', updatedAt: '2026-01-04T00:00:00.000Z' };
  assert.equal(mergeNotes([deleted], [newer])[0].title, 'newer');
  assert.equal(base.title, 'old');
});

test('search normalizes full-width Latin and digits, Japanese width, case and surrounding space', () => {
  assert.equal(normalizeText(' ＡＢＣ１２３ '), 'abc123');
  assert.equal(normalizeText(' ｶﾀｶﾅ '), 'カタカナ');
  assert.equal(normalizeText(null), '');
});
