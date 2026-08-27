/* ============================================================
   main.js — 網站進入點
   1. import 兩個子應用,讓它們的程式碼真正執行(各自的 DOM 事件綁定、
      初始資料載入都在 import 的當下就會跑)。
   2. 這裡另外處理兩個子應用都需要的「共用設定面板」:
      讓使用者可以直接在畫面上輸入自己的 Worker 網址,不用再改原始碼。
      （對應優化建議三之一：API 網址不再寫死）
   ============================================================ */

import "./quote-app.js";
import "./aggregator-app.js";

import { getApiBase, setApiBase } from "./config.js";
import * as SafeStorage from "./storage-safe.js";
import { showToast } from "./utils.js";

const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const apiBaseInput = document.getElementById("apiBaseInput");
const apiBaseSaveBtn = document.getElementById("apiBaseSaveBtn");
const apiBaseResetBtn = document.getElementById("apiBaseResetBtn");

if (settingsBtn && settingsPanel) {
  settingsBtn.addEventListener("click", () => {
    const willShow = settingsPanel.hidden;
    settingsPanel.hidden = !willShow;
    if (willShow) apiBaseInput.value = getApiBase();
  });

  apiBaseSaveBtn.addEventListener("click", () => {
    const val = apiBaseInput.value.trim();
    if (!val) { showToast("⚠ 請輸入網址，或按「還原預設值」"); return; }
    if (!/^https?:\/\//.test(val)) { showToast("⚠ 網址要以 http:// 或 https:// 開頭"); return; }
    setApiBase(val, SafeStorage);
    showToast("✓ 已儲存，下次抓資料會改用這個 Worker 網址");
  });

  apiBaseResetBtn.addEventListener("click", () => {
    setApiBase(null, SafeStorage);
    apiBaseInput.value = getApiBase();
    showToast("✓ 已還原為預設 Worker 網址");
  });
}
