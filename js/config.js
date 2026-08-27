/* ============================================================
   config.js — 集中管理所有寫死的網址與常數
   原本 API_BASE / TWSE_OPENAPI / TPEX_OPENAPI 直接寫死在程式碼裡，
   Worker 網址一旦換掉，整站就要到處找字串改。
   現在改成：
     1. 預設值仍在這裡（方便直接部署）
     2. 提供 getApiBase()/setApiBase()，允許使用者在「設定」面板
        輸入自己的 Worker 網址並存起來（見 storage-safe.js + main.js 的設定面板）
   ============================================================ */

const DEFAULTS = {
  // 換成你自己的 Worker 網址
  API_BASE: "https://red-shadow-40ab.sylvia40254.workers.dev",
  TWSE_OPENAPI: "https://openapi.twse.com.tw/v1/opendata",
  TPEX_OPENAPI: "https://www.tpex.org.tw/openapi/v1",
};

const RUNTIME_KEY = "stock-site-api-base-override";

// 執行期覆寫值：模組一載入就同步讀一次 localStorage(見檔案最下方),
// 不用等 main.js 呼叫才初始化 —— 這樣不管哪一支 script 先 import config.js,
// 都能立刻拿到使用者存過的網址,不會有「已經開始打第一批 API 卻還在用預設值」的空窗期。
let _apiBaseOverride = null;

export function initConfig(safeStorage) {
  const saved = safeStorage.getItem(RUNTIME_KEY, null);
  if (saved) _apiBaseOverride = saved;
}

export function getApiBase() {
  return _apiBaseOverride || DEFAULTS.API_BASE;
}

export function setApiBase(url, safeStorage) {
  _apiBaseOverride = url && url.trim() ? url.trim() : null;
  if (_apiBaseOverride) safeStorage.setItem(RUNTIME_KEY, _apiBaseOverride);
  else safeStorage.removeItem(RUNTIME_KEY);
}

export const TWSE_OPENAPI = DEFAULTS.TWSE_OPENAPI;
export const TPEX_OPENAPI = DEFAULTS.TPEX_OPENAPI;

// 不同週期需要抓多長的歷史資料，才夠算出穩定的 KDJ
// (週期越大，需要越多個月的日資料去彙整)
export const PERIOD_MONTHS = { day: 4, week: 14, month: 40 };

export const STORAGE_KEYS = {
  favorites: "twstock_favorites_v202608",
  searchHistory: "twstock_search_history_v202608",
};

// 表格分頁預設每頁筆數（效能優化：避免一次把上千檔股票塞進 DOM）
export const PAGE_SIZE = 50;

// 搜尋輸入防抖延遲（毫秒）
export const SEARCH_DEBOUNCE_MS = 250;

// 模組載入當下就同步初始化一次(見上面 initConfig 的說明)
import * as _SafeStorage from "./storage-safe.js";
initConfig(_SafeStorage);
