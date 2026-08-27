/* ============================================================
   utils.js — 兩個子應用（股票查詢 / 資料彙整站）共用的小工具
   原本 escapeHtml / safeNum(parseNum) / formatMaybe 等函式在兩支
   script 裡各寫了一份幾乎一樣的版本，這裡合併成單一份，兩邊都改
   成 import 這裡的版本，減少重複與日後修改時漏改一邊的風險。
   ============================================================ */

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s) {
  return escapeHtml(s);
}

// 相容兩邊舊名稱：script1 叫 safeNum，script2 叫 parseNum，邏輯相同
export function safeNum(value) {
  if (value === undefined || value === null || value === "" || value === "--") return null;
  const n = parseFloat(String(value).replace(/[+,]/g, ""));
  return isNaN(n) ? null : n;
}
export const parseNum = safeNum;

export function formatMaybe(value, digits = 2, suffix = "") {
  return value == null || isNaN(value) ? "--" : Number(value).toFixed(digits) + suffix;
}

export function formatSignedPct(value, digits = 2) {
  if (value == null || isNaN(value)) return "--";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;
}

export function signClass(value) {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 防抖（debounce）：等使用者停止輸入 wait 毫秒後才真正執行 fn。
 * 用在搜尋輸入框，避免每敲一個字就重新過濾候選清單。
 */
export function debounce(fn, wait = 250) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * 簡易 Toast 提示（沿用原本兩邊各自的 toast 邏輯，統一成一份）。
 * 呼叫端只要在畫面上準備一個 id="globalToast" 的容器即可，
 * 找不到容器時就退回 console，不會噴錯。
 */
let toastTimer = null;
export function showToast(msg, ms = 3200) {
  const el = document.getElementById("globalToast");
  if (!el) { console.log("[toast]", msg); return; }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
