const DATABASE = 'kiemke-kho-xuong';
const STORE = 'workspace-state';
const STATE_ID = 'current';
const LEGACY_KEY = 'kiemke-kho-xuong-state-v1';

function withDefaults(value, fallback) {
  return { ...fallback(), ...value };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Không mở được IndexedDB.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Không đọc/ghi được dữ liệu cục bộ.'));
  });
}

export async function loadLocalState(fallback) {
  let legacy = {};
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
  } catch {
    legacy = {};
  }
  if (!globalThis.indexedDB) return withDefaults(legacy, fallback);
  try {
    const db = await openDatabase();
    const stored = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(STATE_ID));
    if (stored) return withDefaults(stored, fallback);
    const migrated = withDefaults(legacy, fallback);
    if (Object.keys(legacy).length) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(migrated, STATE_ID);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Không chuyển được dữ liệu cũ.'));
        tx.onabort = () => reject(tx.error || new Error('Không chuyển được dữ liệu cũ.'));
      });
    }
    return migrated;
  } catch {
    return withDefaults(legacy, fallback);
  }
}

export async function saveLocalState(state) {
  if (!globalThis.indexedDB) {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(state));
    return;
  }
  const db = await openDatabase();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(state, STATE_ID);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Không lưu được dữ liệu cục bộ.'));
    tx.onabort = () => reject(tx.error || new Error('Không lưu được dữ liệu cục bộ.'));
  });
}
