/* ============================================================
   storage-safe.js — localStorage 的安全包裝
   原本 readStore/writeStore 只有 try...catch，
   一旦瀏覽器儲存空間滿了、或在嚴格無痕模式下 localStorage 被整個
   禁用，寫入會靜靜失敗、使用者完全不知道資料沒存到。

   這裡做兩件事：
     1. 寫入失敗時，自動降級成記憶體內的 Map，讓「這次瀏覽期間」
        功能還能正常運作（重新整理後才會遺失，並非整站癱瘓）。
     2. 透過 toast 提示使用者一次（避免每次寫入都跳提示轟炸）。
   ============================================================ */

const memoryFallback = new Map();
let warnedOnce = false;
let toastFn = (msg) => console.warn(msg);

export function setToastHandler(fn) {
  if (typeof fn === "function") toastFn = fn;
}

function warnFallback() {
  if (warnedOnce) return;
  warnedOnce = true;
  toastFn("⚠ 瀏覽器儲存空間無法使用，本次瀏覽改用記憶體暫存（重新整理後會遺失）");
}

export function getItem(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return raw;
  } catch (e) {
    warnFallback();
  }
  return memoryFallback.has(key) ? memoryFallback.get(key) : fallback;
}

export function setItem(key, value) {
  try {
    localStorage.setItem(key, value);
    memoryFallback.delete(key);
    return true;
  } catch (e) {
    warnFallback();
    memoryFallback.set(key, value);
    return false;
  }
}

export function removeItem(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  memoryFallback.delete(key);
}

export function getJSON(key, fallback) {
  const raw = getItem(key, null);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

export function setJSON(key, value) {
  return setItem(key, JSON.stringify(value));
}

// 給資料彙整站用（原本是包 window.storage，同樣邏輯：失敗就退記憶體 + 提示一次）
export async function safeWindowStorageSet(key, value, shared = false) {
  try {
    if (window.storage) {
      await window.storage.set(key, value, shared);
      memoryFallback.delete(`ws:${key}`);
      return true;
    }
  } catch (e) { /* fall through to memory */ }
  warnFallback();
  memoryFallback.set(`ws:${key}`, value);
  return false;
}

export async function safeWindowStorageGet(key, shared = false) {
  try {
    if (window.storage) {
      const res = await window.storage.get(key, shared);
      if (res) return res;
    }
  } catch (e) { /* fall through to memory */ }
  if (memoryFallback.has(`ws:${key}`)) {
    return { key, value: memoryFallback.get(`ws:${key}`), shared };
  }
  return null;
}
