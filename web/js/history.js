// 本地历史（IndexedDB）。P5 会在此基础上加私有仓库同步（entry.synced 字段预留）。
//
// entry = {
//   id, ts, device, mode, register, kind, lang,
//   input, output, notes: string[], model, promptVersion,
//   starred, reviewed, synced,
//   alts?: { yandex, google }   // 只查了免费机翻的单词（model 是 'google' / 'yandex'）
// }

const DB_NAME = 'lang-helper';
const STORE = 'history';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    const req = fn(tx.objectStore(STORE));
    if (req && 'onsuccess' in req) req.onsuccess = () => (result = req.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export const put = (entry) => run('readwrite', (s) => s.put(entry));
export const get = (id) => run('readonly', (s) => s.get(id));
export const remove = (id) => run('readwrite', (s) => s.delete(id));
export const all = () => run('readonly', (s) => s.getAll());

export async function update(id, patch) {
  const e = await get(id);
  if (!e) return null;
  Object.assign(e, patch);
  await put(e);
  return e;
}

/**
 * 查单词时只看了免费机翻（Yandex / Google），没问 DeepSeek：也记一条，方便以后复习。
 * output 优先用 Google 的；两家的结果都存在 alts 里。
 */
export function putLookup({ device, from, src, tgt, text, results }) {
  const output = results.google || results.yandex || '';
  if (!output) return Promise.resolve();
  return put({
    id: newId(),
    ts: Date.now(),
    device,
    mode: tgt, // 和 DeepSeek 的记录一样按目标语言归类（ja 写日语 / zh 转中文 / en 写英文）
    register: null,
    kind: 'word',
    lang: src,
    input: text,
    output,
    notes: [],
    alts: { yandex: results.yandex || '', google: results.google || '' },
    model: results.google ? 'google' : 'yandex',
    promptVersion: null,
    from,
    starred: false,
    reviewed: false,
    synced: false,
  });
}

export function bulkPut(entries) {
  return run('readwrite', (s) => {
    for (const e of entries) s.put(e);
  });
}

export async function query({ mode = '', q = '', starred = false } = {}) {
  const items = await all();
  const ql = q.trim().toLowerCase();
  return items
    .filter(
      (e) =>
        (!mode || e.mode === mode) &&
        (!starred || e.starred) &&
        (!ql || [e.input, e.output, ...(e.notes || [])].join('\n').toLowerCase().includes(ql)),
    )
    .sort((a, b) => b.ts - a.ts);
}

/** 导入时做最基本的校验，跳过不像记录的东西 */
export function isEntry(x) {
  return (
    x &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    typeof x.ts === 'number' &&
    typeof x.mode === 'string' &&
    typeof x.input === 'string' &&
    typeof x.output === 'string'
  );
}

export async function wipe() {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
