/** Browser-local persistence and portable backups. No memo content leaves this device. */
// GitHub Pages repositories share an origin; isolate data by the installed app path.
export const STORAGE_KEY = `yohaku.notes.v1:${new URL('./', import.meta.url).pathname}`;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const APP = 'yohaku';
const VERSION = 1;
const COLORS = new Set(['plain', 'sage', 'sand', 'rose', 'blue']);
const DEFAULT_SETTINGS = Object.freeze({ theme: 'dark', sort: 'updated', view: 'grid' });
const ENCODER = new TextEncoder();

function failure(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function invalid(message) {
  throw failure(message, 'INVALID_DATA');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    invalid(`${label}の日付形式が正しくありません。`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(`${label}の日付が正しくありません。`);
  }
  return value;
}

function stringValue(value, label, maximum) {
  if (typeof value !== 'string' || value.length > maximum) {
    invalid(`${label}は${maximum.toLocaleString('ja-JP')}文字以内のテキストにしてください。`);
  }
  return value;
}

function noteValue(value) {
  if (!isObject(value)) invalid('メモの形式が正しくありません。');
  const id = stringValue(value.id, 'メモID', 128);
  if (!id.trim() || /[\u0000-\u001f\u007f]/u.test(id)) invalid('メモIDが正しくありません。');
  if (!COLORS.has(value.color)) invalid('メモの色が正しくありません。');
  if (typeof value.pinned !== 'boolean') invalid('ピン留めの設定が正しくありません。');
  return {
    id,
    title: stringValue(value.title, 'タイトル', 1000),
    body: stringValue(value.body, 'メモ本文', 1000000),
    color: value.color,
    pinned: value.pinned,
    createdAt: isoDate(value.createdAt, '作成日時'),
    updatedAt: isoDate(value.updatedAt, '更新日時'),
    deletedAt: value.deletedAt === null ? null : isoDate(value.deletedAt, '削除日時'),
  };
}

function notesValue(notes) {
  if (!Array.isArray(notes) || notes.length > 10000) invalid('メモは10,000件以内の配列にしてください。');
  const ids = new Set();
  return notes.map((note) => {
    const result = noteValue(note);
    if (ids.has(result.id)) invalid('同じIDのメモが重複しています。');
    ids.add(result.id);
    return result;
  });
}

function settingsValue(settings) {
  if (!isObject(settings)) invalid('表示設定の形式が正しくありません。');
  if (!['system', 'light', 'dark'].includes(settings.theme)) invalid('テーマの設定が正しくありません。');
  if (!['updated', 'created', 'title'].includes(settings.sort)) invalid('並び順の設定が正しくありません。');
  if (!['grid', 'list'].includes(settings.view)) invalid('表示方法の設定が正しくありません。');
  return { theme: settings.theme, sort: settings.sort, view: settings.view };
}

function stateValue(state) {
  if (!isObject(state)) invalid('保存データの形式が正しくありません。');
  return { notes: notesValue(state.notes), settings: settingsValue(state.settings) };
}

function envelopeValue(value) {
  if (!isObject(value) || value.app !== APP || value.version !== VERSION) {
    invalid('このファイルは対応する「余白」のバックアップではありません。');
  }
  return stateValue(value);
}

function checkSize(text) {
  if (typeof text !== 'string') invalid('バックアップはJSONテキストを指定してください。');
  // Check code-unit length first to avoid allocating a second very large buffer.
  if (text.length > MAX_BACKUP_BYTES || ENCODER.encode(text).byteLength > MAX_BACKUP_BYTES) {
    invalid('データが大きすぎます。10MB以内にしてください。');
  }
  return text;
}

function parseJson(text) {
  checkSize(text);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw failure('JSONを読み込めませんでした。ファイルが壊れていないか確認してください。', 'INVALID_DATA', cause);
  }
}

/** Normalize Japanese full-width characters and Latin case for search. */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP').trim();
}

export function createNote({ title = '', body = '', color = 'plain' } = {}) {
  const now = new Date().toISOString();
  const id = globalThis.crypto?.randomUUID?.() ?? `memo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return noteValue({ id, title, body, color, pinned: false, createdAt: now, updatedAt: now, deletedAt: null });
}

/** Storage is injectable so failures and round trips can be tested without a browser. */
export function createStore(storage, key = STORAGE_KEY) {
  // Safari can deny access to the localStorage property itself before getItem runs.
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch (cause) {
      throw failure('このブラウザーでは端末への保存を利用できません。Safariの保存設定を確認してください。', 'STORAGE_UNAVAILABLE', cause);
    }
  }
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw failure('このブラウザーでは端末への保存を利用できません。Safariで開いてください。', 'STORAGE_UNAVAILABLE');
  }
  return {
    load() {
      let text;
      try {
        text = storage.getItem(key);
      } catch (cause) {
        throw failure('端末の保存データを読み込めませんでした。ブラウザーの保存設定を確認してください。', 'STORAGE_UNAVAILABLE', cause);
      }
      if (text === null) return { notes: [], settings: { ...DEFAULT_SETTINGS } };
      try {
        return envelopeValue(parseJson(text));
      } catch (cause) {
        throw failure('保存データを読み込めませんでした。既存データは変更していません。バックアップを確認してください。', 'INVALID_STORED_DATA', cause);
      }
    },
    save(state) {
      const normalized = stateValue(state);
      const text = checkSize(JSON.stringify({ app: APP, version: VERSION, ...normalized }));
      try {
        storage.setItem(key, text);
      } catch (cause) {
        const quota = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(cause?.name);
        throw failure(
          quota ? '端末の保存容量が不足しています。バックアップを保存してから、不要なメモを整理してください。' : 'メモを端末に保存できませんでした。内容をコピーするか、バックアップを保存してください。',
          quota ? 'STORAGE_QUOTA' : 'STORAGE_UNAVAILABLE',
          cause,
        );
      }
      return normalized;
    },
  };
}

export function exportBackup(state) {
  const normalized = stateValue(state);
  return checkSize(JSON.stringify({ app: APP, version: VERSION, exportedAt: new Date().toISOString(), ...normalized }, null, 2));
}

export function parseBackup(text) {
  const envelope = parseJson(text);
  const state = envelopeValue(envelope);
  isoDate(envelope.exportedAt, 'バックアップ日時');
  return state;
}

/** Newer revisions win, including deleted notes, so old backups do not revive them. */
export function mergeNotes(existing, incoming) {
  const current = notesValue(existing);
  const restored = notesValue(incoming);
  const merged = new Map(current.map((note) => [note.id, note]));
  for (const note of restored) {
    const previous = merged.get(note.id);
    if (!previous || note.updatedAt > previous.updatedAt) merged.set(note.id, note);
  }
  if (merged.size > 10000) invalid('復元後のメモが10,000件を超えます。');
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
