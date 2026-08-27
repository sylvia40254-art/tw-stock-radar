/* ============================================================
   quote-app.js — 股票查詢 / 首頁指數 / 技術分析 / 排行榜 / 收藏
   （原本內嵌在 index.html 裡的第一支 <script>，現在是獨立的
   ES module。改成 module 之後,這裡宣告的所有 const/let/function
   都只在這個檔案的模組作用域內,不會再汙染全域 window,
   也不需要再手動包一層 (function(){...})() IIFE。）
   ============================================================ */
import { getApiBase, PERIOD_MONTHS, TWSE_OPENAPI, TPEX_OPENAPI, STORAGE_KEYS, SEARCH_DEBOUNCE_MS }
  from "./config.js";
import { escapeHtml, safeNum, formatMaybe, formatSignedPct, signClass, debounce }
  from "./utils.js";
import * as SafeStorage from "./storage-safe.js";
import { applyBothThemeMechanisms } from "./theme-sync.js";

  // API_BASE / PERIOD_MONTHS 現在集中在 config.js（見檔案最上方 import）
  // 用 getApiBase() 取得目前的 Worker 網址（若使用者在設定面板改過，優先用改過的）

  /* ============================================
     主題切換:只保留深色/淺色
     ============================================ */
  const themeDarkBtn = document.getElementById("themeDarkBtn");
  const themeLightBtn = document.getElementById("themeLightBtn");
  themeDarkBtn.addEventListener("click", () => setTheme("dark"));
  themeLightBtn.addEventListener("click", () => setTheme("light"));

  function setTheme(mode) {
    document.body.classList.toggle("theme-light", mode === "light");
    applyBothThemeMechanisms(mode); // 讓資料彙整站的 #page-aggregate 主題也跟著換
    themeDarkBtn.classList.toggle("active", mode === "dark");
    themeLightBtn.classList.toggle("active", mode === "light");
    if (latestDailyRows.length) renderForPeriod(currentPeriod);
  }

  /* ============================================
     搜尋主流程
     ============================================ */
  const stockInput = document.getElementById("stockInput");
  const stockSuggest = document.getElementById("stockSuggest");
  const searchBtn = document.getElementById("searchBtn");
  const addFavBtn = document.getElementById("addFavBtn");
  const searchHistoryBar = document.getElementById("searchHistoryBar");
  const mainMsg = document.getElementById("mainMsg");
  const resultArea = document.getElementById("resultArea");
  const favoriteListEl = document.getElementById("favoriteList");
  const favoriteMsgEl = document.getElementById("favoriteMsg");
  const favoriteHistoryListEl = document.getElementById("favoriteHistoryList");
  // TWSE_OPENAPI / TPEX_OPENAPI / STORAGE_KEYS 現在從 config.js import
  const marketCache = { snapshot: null, ratios: null, profile: null, revenue: null, dividend: null, tpexQuotes: null, tpexRatios: null };
  /* 排行榜 股利/營收 內嵌備援資料(2026/08 證交所 OpenAPI 出表快照)
     TWSE OpenAPI 對瀏覽器直連未提供 CORS header 時,排行榜股利與營收分頁改吃這份內建資料,保證有內容可顯示 */
  let RANK_FALLBACK = null;
  async function loadRankFallback() {
    if (RANK_FALLBACK) return RANK_FALLBACK;
    try {
      const res = await fetch("rank_fallback.json");
      if (!res.ok) throw new Error("http " + res.status);
      RANK_FALLBACK = await res.json();
    } catch (err) {
      RANK_FALLBACK = { revenue: [], dividend: [] };
    }
    return RANK_FALLBACK;
  }
  /* ============================================
     頂層主分頁切換:首頁/股票查詢/比較/排行榜
     ============================================ */
  /* 頂層主分頁切換 + URL hash 深層連結(可直接用 #rank / #compare 開啟對應分頁) */
  function switchMainPage(page) {
    document.querySelectorAll(".main-tabs button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
    document.querySelectorAll(".main-page").forEach(p => p.classList.toggle("active", p.id === "page-" + page));
    try { history.replaceState(null, "", "#" + page); } catch (e) {}
    if (page === "rank" && rankState && !rankState.loaded) loadRanking();
    if (page === "favorite") {
      renderFavoriteList();
      renderSearchHistory();
    }
  }
  document.querySelectorAll(".main-tabs button").forEach(btn => {
    btn.addEventListener("click", () => switchMainPage(btn.dataset.page));
  });

  /* 將股票查詢頁的 #subTabs(第二層子分頁)與其對應的內容區塊,重新包裝進一個
     flex 容器,讓桌機版可以用側邊欄呈現、手機版仍維持原本的頁籤列,
     藉此簡化過深的子分頁視覺層級,且完全不影響既有的分頁切換邏輯(仍靠 id/class 選取)。 */
  (function setupStockDetailLayout() {
    const subTabs = document.getElementById("subTabs");
    if (!subTabs) return;
    const parent = subTabs.parentElement;
    const pages = Array.from(parent.querySelectorAll(":scope > .subtab-page"));
    const layout = document.createElement("div");
    layout.className = "stock-detail-layout";
    const pagesWrap = document.createElement("div");
    pagesWrap.className = "stock-detail-pages";
    parent.insertBefore(layout, subTabs);
    layout.appendChild(subTabs);
    pages.forEach(p => pagesWrap.appendChild(p));
    layout.appendChild(pagesWrap);
  })();

  /* ============================================
     首頁:主要指數＋台指期貨
     指數與台指期貨皆透過 Yahoo Finance 備援資料顯示
     ============================================ */
  const INDEXES = [
    { key: "taiex", symbol: "^TWII" },
    { key: "dji", symbol: "^DJI" },
    { key: "spx", symbol: "^GSPC" },
    { key: "sox", symbol: "^SOX" },
    { key: "txf", symbol: "IX0126.TW" },
  ];

  async function loadIndexes() {
    const msgEl = document.getElementById("indexMsg");
    setMsgOn(msgEl, "載入指數中...", "loading");

    const [results, twIndexResult] = await Promise.all([
      Promise.allSettled(
        INDEXES.map(idx => fetch(`${getApiBase()}/yahoo?symbol=${encodeURIComponent(idx.symbol)}`).then(r => r.json()))
      ),
      fetch(`${getApiBase()}/twindex`).then(r => r.json()).catch(() => null),
    ]);

    let okCount = 0;
    results.forEach((result, i) => {
      const key = INDEXES[i].key;
      if (result.status !== "fulfilled" || result.value.error) return;
      const d = result.value;
      okCount++;

      const price = d.price, open = d.open;
      // 振幅% = (最高價-最低價) ÷ 昨收,這是台股慣用的振幅算法,不是除以開盤價
      const range = (d.high != null && d.low != null && d.prevClose) ? ((d.high - d.low) / d.prevClose * 100) : null;
      const cls = d.prevClose != null && price != null
        ? (price > d.prevClose ? "up" : price < d.prevClose ? "down" : "flat") : "";

      // 台股加權指數的成交量,改用官方大盤成交資訊(Yahoo 對這個指數沒有維護成交量統計)
      let volumeText = d.volume != null ? d.volume.toLocaleString() : "--";
      if (key === "taiex" && twIndexResult && !twIndexResult.error) {
        const shares = parseFloat(String(twIndexResult.volume).replace(/,/g, ""));
        volumeText = !isNaN(shares) ? Math.round(shares / 1000).toLocaleString() + " 張" : volumeText;
      }

      const priceEl = document.getElementById(`idx${capitalize(key)}Price`);
      priceEl.textContent = price != null ? price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";
      priceEl.className = "index-price " + cls;
      document.getElementById(`idx${capitalize(key)}Open`).textContent = open != null ? open.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "--";
      document.getElementById(`idx${capitalize(key)}Range`).textContent = range != null ? range.toFixed(2) + "%" : "--";
      document.getElementById(`idx${capitalize(key)}Volume`).textContent = volumeText;
    });

    setMsgOn(msgEl, `已更新 ${okCount}/${INDEXES.length} 個指數,最後更新 ${new Date().toLocaleTimeString("zh-TW")}`, okCount > 0 ? "ok" : "err");
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  document.getElementById("indexRefreshBtn").addEventListener("click", loadIndexes);
  loadIndexes(); // 一打開網頁就先載入一次

  /* ============================================
     子分頁切換:技術分析/籌碼分析/基本分析/財務分析
     切換時不用重抓資料,資料在查詢股票的當下就已經一次全部載入了
     ============================================ */
  document.querySelectorAll(".subtabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      document.querySelectorAll(".subtabs button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".subtab-page").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("subtab-" + btn.dataset.subtab).classList.add("active");
    });
  });

  /* 財務分析內部子分頁(第三層)
     手機上「主分頁→子分頁→財務分析下的第三層分頁」疊了三層,容易迷失。
     維持原本的按鈕列(桌機/平板),另外加一個 <select> 下拉選單,
     用 CSS media query 只在窄螢幕顯示;兩者呼叫同一個 switchFinTab()、
     互相同步選取狀態,不管用哪一個切換都是同一份邏輯。 */
  const finTabsMobileSelect = document.getElementById("finTabsMobileSelect");

  function switchFinTab(key) {
    document.querySelectorAll(".fin-tabs button").forEach(b => b.classList.toggle("active", b.dataset.fintab === key));
    document.querySelectorAll(".fin-tab-page").forEach(p => p.classList.remove("active"));
    const page = document.getElementById("fintab-" + key);
    if (page) page.classList.add("active");
    if (finTabsMobileSelect && finTabsMobileSelect.value !== key) finTabsMobileSelect.value = key;
  }

  document.querySelectorAll(".fin-tabs button").forEach(btn => {
    btn.addEventListener("click", () => switchFinTab(btn.dataset.fintab));
  });
  if (finTabsMobileSelect) {
    finTabsMobileSelect.addEventListener("change", () => switchFinTab(finTabsMobileSelect.value));
  }

  const periodTabs = document.getElementById("periodTabs");

  let nameToCode = {};
  let latestDailyRows = [];   // 目前已抓到的「日線」資料(週/月都是從這裡彙整出來的)
  let latestQuote = null;
  let latestRatio = {};
  let currentCode = null;
  let currentPeriod = "day";
  let fetchedMonthsFor = {};  // 記錄目前已經抓了多少個月的資料,避免切換週期時重複抓取
  let minutePoints = [];      // 「分」線資料:從打開分頁那一刻開始即時累積,無官方歷史可回補
  let quoteTimer = null;      // 統一的報價輪詢計時器,不管在哪個分頁都持續更新成交價
  let chartState = null;      // 記錄目前圖表的座標換算方式,給滑鼠移動的十字線功能使用
  let latestIndicators = null; // 目前的 MA/RSI/KDJ/MACD 快照,給「產生趨勢解讀」按鈕使用
  let epsByYear = {}; // 年度→EPS 對照表,由獲利狀況面板算好後快取,給股利歷史表格重複使用

  let searchCandidates = [];
  let suggestActiveIndex = -1;

  searchBtn.addEventListener("click", runSearch);
  stockInput.addEventListener("keydown", async e => {
    const items = stockSuggest ? Array.from(stockSuggest.querySelectorAll(".suggest-item")) : [];
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      suggestActiveIndex = Math.min(suggestActiveIndex + 1, items.length - 1);
      highlightSuggestItem(items);
      return;
    }
    if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      suggestActiveIndex = Math.max(suggestActiveIndex - 1, 0);
      highlightSuggestItem(items);
      return;
    }
    if (e.key === "Escape") {
      hideSuggestions();
      return;
    }
    if (e.key === "Enter") {
      if (suggestActiveIndex >= 0 && items[suggestActiveIndex]) {
        e.preventDefault();
        chooseSuggestion(items[suggestActiveIndex].dataset.code, items[suggestActiveIndex].dataset.name);
        return;
      }
      runSearch();
    }
  });
  // 效能優化:輸入框加 250ms 防抖,使用者快速打字時不會每個字都觸發一次過濾/渲染
  const debouncedSearchInputChanged = debounce(onSearchInputChanged, SEARCH_DEBOUNCE_MS);
  stockInput.addEventListener("input", debouncedSearchInputChanged);
  stockInput.addEventListener("focus", () => {
    if (stockInput.value.trim()) onSearchInputChanged();
  });
  document.addEventListener("click", e => {
    if (!stockSuggest) return;
    if (e.target === stockInput || stockSuggest.contains(e.target)) return;
    hideSuggestions();
  });

  periodTabs.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => switchPeriod(btn.dataset.period));
  });

  async function buildSearchCandidates() {
    if (searchCandidates.length) return searchCandidates;
    const [listedRes, otcRes] = await Promise.allSettled([
      fetchCachedList('snapshot', `${getApiBase()}/snapshot`),
      fetchCachedList('tpexQuotes', `${TPEX_OPENAPI}/tpex_mainboard_quotes`),
    ]);
    const merged = [];
    const seen = new Set();
    const addRow = (row, codeKey, nameKey, market) => {
      const code = String(row?.[codeKey] ?? '').trim();
      const name = String(row?.[nameKey] ?? '').trim();
      if (!code || !name || seen.has(code)) return;
      seen.add(code);
      merged.push({ code, name, market });
      nameToCode[name] = code;
    };
    if (listedRes.status === 'fulfilled' && Array.isArray(listedRes.value)) {
      listedRes.value.forEach(row => addRow(row, 'Code', 'Name', '上市'));
    }
    if (otcRes.status === 'fulfilled' && Array.isArray(otcRes.value)) {
      otcRes.value.forEach(row => addRow(row, 'SecuritiesCompanyCode', 'CompanyName', '上櫃'));
    }
    searchCandidates = merged;
    return merged;
  }

  function hideSuggestions() {
    if (!stockSuggest) return;
    stockSuggest.style.display = 'none';
    stockSuggest.innerHTML = '';
    suggestActiveIndex = -1;
  }

  function highlightSuggestItem(items) {
    items.forEach((el, idx) => el.classList.toggle('active', idx === suggestActiveIndex));
    const active = items[suggestActiveIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function chooseSuggestion(code, name) {
    stockInput.value = code;
    hideSuggestions();
    runSearch();
  }

  async function onSearchInputChanged() {
    const keyword = stockInput.value.trim();
    if (!keyword) {
      hideSuggestions();
      return;
    }
    const list = await buildSearchCandidates().catch(() => []);
    const normalized = keyword.toLowerCase();
    const matched = list.filter(item => {
      const code = item.code.toLowerCase();
      const name = item.name.toLowerCase();
      return code.startsWith(normalized)
        || code.includes(normalized)
        || name.includes(normalized);
    }).sort((a, b) => {
      const aExact = a.code === keyword || a.name === keyword;
      const bExact = b.code === keyword || b.name === keyword;
      if (aExact !== bExact) return aExact ? -1 : 1;
      const aPrefix = a.code.startsWith(keyword) || a.name.startsWith(keyword);
      const bPrefix = b.code.startsWith(keyword) || b.name.startsWith(keyword);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
      return a.code.localeCompare(b.code, 'zh-Hant');
    }).slice(0, 12);

    if (!stockSuggest) return;
    if (!matched.length) {
      hideSuggestions();
      return;
    }
    suggestActiveIndex = -1;
    stockSuggest.innerHTML = matched.map(item => `
      <div class="suggest-item" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}">
        <span class="sc">${escapeHtml(item.code)}</span>
        <span>${escapeHtml(item.name)}</span>
        <span style="margin-left:auto; color:var(--text-dim); font-size:12px;">${escapeHtml(item.market)}</span>
      </div>
    `).join('');
    stockSuggest.style.display = 'block';
    stockSuggest.querySelectorAll('.suggest-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        chooseSuggestion(el.dataset.code, el.dataset.name);
      });
    });
  }

  async function resolveCode(input) {
    const trimmed = input.trim();
    if (/^\d{4,6}$/.test(trimmed)) return trimmed;
    if (nameToCode[trimmed]) return nameToCode[trimmed];
    const list = await buildSearchCandidates().catch(() => []);
    const exact = list.find(item => item.code === trimmed || item.name === trimmed);
    if (exact) return exact.code;
    const fuzzy = list.find(item => item.code.startsWith(trimmed) || item.name.includes(trimmed));
    return fuzzy ? fuzzy.code : null;
  }

  // 原本直接呼叫 localStorage,現在改走 storage-safe.js:
  // 空間滿了或無痕模式擋掉時,自動退記憶體暫存,並提示使用者一次
  function readStore(key, fallback) {
    return SafeStorage.getJSON(key, fallback);
  }

  function writeStore(key, value) {
    SafeStorage.setJSON(key, value);
  }

  function jumpToStock(code) {
    if (!code) return;
    stockInput.value = code;
    switchMainPage("stock");
    runSearch();
  }

  /**
   * 收藏資料結構(新版):{ folders: [{id, name, items:[{code,name}]}], activeFolderId }
   * 如果偵測到舊版格式(單純陣列),自動搬進一個預設資料夾裡,不會讓舊資料消失。
   */
  function getFavoritesData() {
    const raw = readStore(STORAGE_KEYS.favorites, null);
    if (!raw) {
      const defaultFolder = { id: "f_" + Date.now(), name: "我的收藏", items: [] };
      return { folders: [defaultFolder], activeFolderId: defaultFolder.id };
    }
    if (Array.isArray(raw)) {
      // 舊格式搬遷:整包塞進一個資料夾
      const migrated = { id: "f_" + Date.now(), name: "我的收藏", items: raw };
      const data = { folders: [migrated], activeFolderId: migrated.id };
      writeStore(STORAGE_KEYS.favorites, data);
      return data;
    }
    if (!raw.folders || raw.folders.length === 0) {
      const defaultFolder = { id: "f_" + Date.now(), name: "我的收藏", items: [] };
      raw.folders = [defaultFolder];
      raw.activeFolderId = defaultFolder.id;
    }
    if (!raw.activeFolderId || !raw.folders.some(f => f.id === raw.activeFolderId)) {
      raw.activeFolderId = raw.folders[0].id;
    }
    return raw;
  }

  function saveFavoritesData(data) { writeStore(STORAGE_KEYS.favorites, data); }

  function getActiveFolder(data) { return data.folders.find(f => f.id === data.activeFolderId) || data.folders[0]; }

  /** 攤平所有資料夾的收藏股票,判斷「這檔股票有沒有被收藏過」不用管在哪個資料夾 */
  function getAllFavoriteItems() {
    return getFavoritesData().folders.flatMap(f => f.items);
  }

  function getFavorites() { return getAllFavoriteItems(); } // 相容舊呼叫
  function getSearchHistory() { return readStore(STORAGE_KEYS.searchHistory, []); }

  function renderFolderTabs() {
    const data = getFavoritesData();
    const tabsEl = document.getElementById("folderTabs");
    if (!tabsEl) return;

    tabsEl.innerHTML = data.folders.map(f =>
      `<button data-folder="${escapeHtml(f.id)}" class="${f.id === data.activeFolderId ? "active" : ""}">${escapeHtml(f.name)}(${f.items.length})</button>`
    ).join("");

    tabsEl.querySelectorAll("button[data-folder]").forEach(btn => {
      btn.addEventListener("click", () => {
        const d = getFavoritesData();
        d.activeFolderId = btn.dataset.folder;
        saveFavoritesData(d);
        renderFolderTabs();
        renderFavoriteList();
      });
    });
  }

  document.getElementById("addFolderBtn")?.addEventListener("click", () => {
    const input = document.getElementById("newFolderInput");
    const name = input.value.trim();
    if (!name) { setMsgOn(favoriteMsgEl, "請先輸入資料夾名稱", "err"); return; }
    const data = getFavoritesData();
    const newFolder = { id: "f_" + Date.now(), name, items: [] };
    data.folders.push(newFolder);
    data.activeFolderId = newFolder.id;
    saveFavoritesData(data);
    input.value = "";
    renderFolderTabs();
    renderFavoriteList();
    setMsgOn(favoriteMsgEl, `已建立資料夾「${name}」`, "ok");
  });

  document.getElementById("deleteFolderBtn")?.addEventListener("click", () => {
    const data = getFavoritesData();
    if (data.folders.length <= 1) {
      setMsgOn(favoriteMsgEl, "至少要保留一個資料夾,沒辦法刪除最後一個", "err");
      return;
    }
    const folder = getActiveFolder(data);
    if (!confirm(`確定要刪除資料夾「${folder.name}」嗎?裡面 ${folder.items.length} 檔收藏會一併刪除,無法復原。`)) return;
    data.folders = data.folders.filter(f => f.id !== folder.id);
    data.activeFolderId = data.folders[0].id;
    saveFavoritesData(data);
    renderFolderTabs();
    renderFavoriteList();
    setMsgOn(favoriteMsgEl, `已刪除資料夾「${folder.name}」`, "ok");
  });

  function renderSearchHistory() {
    const list = getSearchHistory();
    const html = list.length
      ? list.map(item => `
          <span class="history-item" data-code="${escapeHtml(item.code)}">
            <strong>${escapeHtml(item.code)}</strong> ${escapeHtml(item.name || "")}
            <small>${new Date(item.ts).toLocaleString("zh-TW")}</small>
            <span class="history-close" data-remove-history="${escapeHtml(item.code)}" title="移除這筆紀錄">✕</span>
          </span>`).join("")
      : '<div class="empty-state" style="width:100%;">目前還沒有查詢紀錄</div>';
    if (searchHistoryBar) searchHistoryBar.innerHTML = html;
    if (favoriteHistoryListEl) favoriteHistoryListEl.innerHTML = html;

    document.querySelectorAll(".history-item[data-code]").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-remove-history]")) return; // 點到叉叉不要觸發查詢
        jumpToStock(el.dataset.code);
      });
    });
    document.querySelectorAll("[data-remove-history]").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = getSearchHistory().filter(x => x.code !== el.dataset.removeHistory);
        writeStore(STORAGE_KEYS.searchHistory, next);
        renderSearchHistory();
      });
    });
  }

  function saveSearchHistory(code, name) {
    if (!code) return;
    const cleanName = String(name || code).trim();
    const next = getSearchHistory().filter(x => x.code !== code);
    next.unshift({ code, name: cleanName, ts: Date.now() });
    writeStore(STORAGE_KEYS.searchHistory, next.slice(0, 12));
    renderSearchHistory();
  }

  function updateFavoriteButton() {
    if (!addFavBtn) return;
    const found = currentCode && getAllFavoriteItems().some(x => x.code === currentCode);
    addFavBtn.textContent = found ? "已收藏" : "加入收藏";
    addFavBtn.classList.toggle("active", !!found);
  }

  async function renderFavoriteList() {
    if (!favoriteListEl) return;
    const data = getFavoritesData();
    const folder = getActiveFolder(data);
    const list = folder.items;

    if (!list.length) {
      favoriteListEl.innerHTML = '<tr><td colspan="7" class="empty-state" style="padding:34px 0;">這個資料夾還沒有收藏股票，先到「股票查詢」頁查詢後再加入收藏。</td></tr>';
      return;
    }

    favoriteListEl.innerHTML = list.map((item, idx) => `
      <tr data-code="${escapeHtml(item.code)}">
        <td>${idx + 1}</td>
        <td class="fav-name" data-code="${escapeHtml(item.code)}" style="cursor:pointer;color:var(--accent);font-weight:700;">${escapeHtml(item.code)}</td>
        <td class="fav-name" data-code="${escapeHtml(item.code)}" style="cursor:pointer;text-align:left;">${escapeHtml(item.name || "")}</td>
        <td class="num" id="favPrice_${escapeHtml(item.code)}">--</td>
        <td class="num" id="favChange_${escapeHtml(item.code)}">--</td>
        <td class="num" id="favPct_${escapeHtml(item.code)}">--</td>
        <td>
          <button class="mini-btn" data-move="up" data-code="${escapeHtml(item.code)}"${idx === 0 ? " disabled" : ""}>上移</button>
          <button class="mini-btn" data-move="down" data-code="${escapeHtml(item.code)}"${idx === list.length - 1 ? " disabled" : ""}>下移</button>
          <button class="mini-btn" data-remove="${escapeHtml(item.code)}">刪除</button>
        </td>
      </tr>`).join("");

    favoriteListEl.querySelectorAll(".fav-name[data-code]").forEach(el => {
      el.addEventListener("click", () => jumpToStock(el.dataset.code));
    });
    favoriteListEl.querySelectorAll("button[data-remove]").forEach(el => {
      el.addEventListener("click", () => {
        const d = getFavoritesData();
        const f = getActiveFolder(d);
        f.items = f.items.filter(x => x.code !== el.dataset.remove);
        saveFavoritesData(d);
        renderFolderTabs();
        renderFavoriteList();
        updateFavoriteButton();
        if (favoriteMsgEl) setMsgOn(favoriteMsgEl, `已從「${f.name}」刪除 ${el.dataset.remove}`, "ok");
      });
    });
    favoriteListEl.querySelectorAll("button[data-move]").forEach(el => {
      el.addEventListener("click", () => {
        const d = getFavoritesData();
        const f = getActiveFolder(d);
        const i = f.items.findIndex(x => x.code === el.dataset.code);
        if (i < 0) return;
        const j = el.dataset.move === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= f.items.length) return;
        [f.items[i], f.items[j]] = [f.items[j], f.items[i]];
        saveFavoritesData(d);
        renderFavoriteList();
      });
    });

    // 批次抓即時報價(最多 20 檔一次,跟即時報價分頁用同一個路徑)
    try {
      const ids = list.map(x => x.code).join(",");
      let data2 = { msgArray: [] };
      try { data2 = await fetchJSON(`${getApiBase()}/realtime?ids=${encodeURIComponent(ids)}`); } catch (err) { console.warn("favorite realtime:", err.message); }
      const rows = data2.msgArray || [];
      const byCode = {};
      rows.forEach(r => { byCode[r.c] = r; });

      list.forEach(item => {
        const priceEl = document.getElementById(`favPrice_${item.code}`);
        const changeEl = document.getElementById(`favChange_${item.code}`);
        const pctEl = document.getElementById(`favPct_${item.code}`);
        if (!priceEl || !changeEl || !pctEl) return;
        const q = byCode[item.code];
        if (!q || !q.z || q.z === "-") {
          priceEl.textContent = "--"; changeEl.textContent = "--"; pctEl.textContent = "--";
          priceEl.className = "num"; changeEl.className = "num"; pctEl.className = "num";
          return;
        }
        const price = parseFloat(q.z), prevClose = parseFloat(q.y);
        const change = !isNaN(prevClose) ? price - prevClose : null;
        const pct = change != null && prevClose ? (change / prevClose * 100) : null;
        const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";
        priceEl.textContent = price.toFixed(2);
        priceEl.className = "num " + cls;
        changeEl.textContent = change != null ? (change > 0 ? "+" : "") + change.toFixed(2) : "--";
        changeEl.className = "num " + cls;
        pctEl.textContent = pct != null ? (pct > 0 ? "+" : "") + pct.toFixed(2) + "%" : "--";
        pctEl.className = "num " + cls;
      });
    } catch (err) {
      list.forEach(item => {
        const priceEl = document.getElementById(`favPrice_${item.code}`);
        if (priceEl) priceEl.textContent = "載入失敗";
      });
    }
  }

  function addCurrentFavorite() {
    if (!currentCode) {
      setMsg("請先查詢一檔股票，再加入收藏", "err");
      return;
    }
    const data = getFavoritesData();
    const folder = getActiveFolder(data);
    if (folder.items.some(x => x.code === currentCode)) {
      setMsg(`${currentCode} 已經在「${folder.name}」收藏清單中`, "ok");
      updateFavoriteButton();
      return;
    }
    folder.items.push({ code: currentCode, name: latestQuote?.n || currentCode });
    saveFavoritesData(data);
    updateFavoriteButton();
    renderFolderTabs();
    renderFavoriteList();
    if (favoriteMsgEl) setMsgOn(favoriteMsgEl, `已收藏 ${currentCode} 到「${folder.name}」`, "ok");
    setMsg(`已將 ${currentCode} 加入收藏(資料夾:${folder.name})`, "ok");
  }

  if (addFavBtn) addFavBtn.addEventListener("click", addCurrentFavorite);
  renderSearchHistory();
  renderFolderTabs();
  renderFavoriteList();

  async function runSearch() {
    const entry = stockInput.value.trim();
    if (!entry) return;

    searchBtn.disabled = true;
    setMsg("查詢中...", "loading");
    resultArea.style.display = "none";
    fetchedMonthsFor = {};
    stopQuotePolling();
    minutePoints = [];
    currentPeriod = "day";
    updatePeriodTabsUI();

    try {
      hideSuggestions();
      const code = await resolveCode(entry);
      if (!code) throw new Error(`找不到「${entry}」,請確認代號或名稱`);
      currentCode = code;

      let quote = null, ratiosData = [];
      try {
        const [rtData, rtRatios] = await Promise.all([
          fetchJSON(`${getApiBase()}/realtime?ids=${encodeURIComponent(code)}`).catch(e => { throw e; }),
          fetchJSON(`${getApiBase()}/ratios`).catch(() => []),
        ]);
        quote = (rtData?.msgArray || [])[0];
        ratiosData = rtRatios || [];
      } catch (rtErr) {
        // 即時報價端點暫時回 520 / HTML 錯誤頁 → 自動改用 Yahoo 備援,
        // 確保使用者一定能看到股價,不要因為 worker 抖動就看到錯誤訊息。
        console.warn("realtime failed, using Yahoo fallback:", rtErr.message);
        const yahoo = await fetchJSON(`${getApiBase()}/yahoo?code=${encodeURIComponent(code)}`).catch(() => null);
        if (yahoo && yahoo.price != null) {
          const d = yahoo.time ? new Date(yahoo.time * 1000) : new Date();
          const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
          quote = {
            c: code,
            n: yahoo.name || code,
            z: String(yahoo.price),
            y: yahoo.prevClose != null ? String(yahoo.prevClose) : "-",
            h: yahoo.high != null ? String(yahoo.high) : "-",
            l: yahoo.low != null ? String(yahoo.low) : "-",
            o: yahoo.open != null ? String(yahoo.open) : "-",
            v: yahoo.volume != null ? String(yahoo.volume / 1000) : "-",
            t: d.toLocaleTimeString("zh-TW"),
            d: dateStr,
            _source: "yahoo",
          };
        }
        ratiosData = await fetchJSON(`${getApiBase()}/ratios`).catch(() => []);
      }
      if (!quote) throw new Error("查無即時報價,可能非交易時間或代號錯誤");

      latestRatio = (ratiosData || []).find(r => r.Code === code) || {};
      renderQuote(quote, latestRatio);
      saveSearchHistory(code, quote.n || code);
      updateFavoriteButton();

      await loadHistoryForPeriod("day");
      resultArea.style.display = "block";
      setMsg(`最後更新: ${new Date().toLocaleTimeString("zh-TW")}`, "ok");

      startQuotePolling(); // 開始每 5 秒自動刷新成交價,不用手動重新查詢
      loadChipData(code);
      loadProfile(code);
      await loadFinancials(code); // 先跑完,股利歷史要用這裡算好的年度 EPS 對照表
      loadDividendHistory(code);

    } catch (err) {
      setMsg("查詢失敗:" + err.message, "err");
    } finally {
      searchBtn.disabled = false;
    }
  }

  async function switchPeriod(period) {
    if (period === currentPeriod) return;
    currentPeriod = period;
    updatePeriodTabsUI();

    if (period === "minute") {
      startMinuteMode();
      return;
    }

    setMsg(`載入「${periodLabel(period)}」資料中...`, "loading");
    await loadHistoryForPeriod(period);
    setMsg(`已切換為「${periodLabel(period)}」`, "ok");
  }

  function updatePeriodTabsUI() {
    periodTabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.period === currentPeriod));
    const note = document.getElementById("periodNote");
    if (currentPeriod === "minute") {
      note.textContent = "「分」線沒有官方歷史資料,只會從你打開這個查詢那一刻開始即時累積畫出走勢,不是回補今天完整的分線";
      note.className = "msg loading";
    } else {
      note.textContent = "";
    }
  }

  /* ============================================
     統一的報價輪詢:不管停在日/週/月/分哪一個分頁,
     每 5 秒都會刷新一次成交價等即時欄位,方便隨時看到最新價格。
     如果目前剛好在「分」線分頁,才順便把這個點加進分線走勢圖。
     ============================================ */
  async function startQuotePolling() {
    stopQuotePolling(); // 保險起見,先清掉舊的計時器,避免重複疊加
    await pollQuote(); // 立刻先更新一次,不用等第一個間隔
    quoteTimer = setInterval(pollQuote, 5000);
  }

  function stopQuotePolling() {
    if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
  }

  async function pollQuote() {
    if (!currentCode) return;
    try {
      const data = await fetchJSON(`${getApiBase()}/realtime?ids=${encodeURIComponent(currentCode)}`);
      let q = (data?.msgArray || [])[0];

      // TWSE 抓不到成交價(z 是 "-" 或整個查無資料)時,自動改用 Yahoo Finance 備援
      const twseHasPrice = q && q.z && q.z !== "-";
      if (!twseHasPrice) {
        const fallback = await fetchYahooFallback();
        if (fallback) q = fallback;
      }
      if (!q) return;

      renderQuote(q, latestRatio);

      if (currentPeriod === "minute") {
        const price = parseFloat(q.z);
        if (!isNaN(price)) {
          minutePoints.push({ time: q.t || new Date().toLocaleTimeString("zh-TW"), price });
          if (minutePoints.length > 300) minutePoints.shift(); // 避免長時間開著頁面資料無限增長
          drawMinuteChart(minutePoints);
        }
      }
    } catch (err) {
      // 單次輪詢失敗不用整頁報錯,靜靜跳過,等下一次輪詢再試就好
    }
  }

  /**
   * Yahoo Finance 備援:把回傳資料轉換成跟 TWSE 即時報價一樣的欄位格式(z/y/h/l/o/v/t),
   * 這樣 renderQuote() 完全不用另外寫一套處理邏輯,兩種來源共用同一份渲染程式碼。
   */
  async function fetchYahooFallback() {
    try {
      const res = await fetch(`${getApiBase()}/yahoo?code=${currentCode}`);
      const y = await res.json();
      if (y.error || y.price == null) return null;

      const d = y.time ? new Date(y.time * 1000) : new Date();
      const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;

      return {
        c: currentCode,
        n: latestQuote?.n || "",
        z: String(y.price),
        y: y.prevClose != null ? String(y.prevClose) : "-",
        h: y.high != null ? String(y.high) : "-",
        l: y.low != null ? String(y.low) : "-",
        o: y.open != null ? String(y.open) : "-",
        v: y.volume != null ? String(y.volume / 1000) : "-", // 統一成「張」為單位,跟 TWSE 的 v 欄位一致
        u: latestQuote?.u, // Yahoo 沒有漲跌停價,沿用之前 TWSE 抓到的值
        w: latestQuote?.w,
        t: d.toLocaleTimeString("zh-TW"),
        d: dateStr,
        _source: "yahoo", // 標記這筆是備援資料,renderQuote 會顯示提示
      };
    } catch {
      return null;
    }
  }

  function periodLabel(p) { return { minute: "分", day: "日", week: "週", month: "月" }[p]; }

  /* ============================================
     切換到「分」線分頁:圖表換成分線走勢圖,資料來源就是上面的統一輪詢
     ============================================ */
  function startMinuteMode() {
    document.getElementById("kdjStatusBox").innerHTML =
      `<div class="kdj-status neutral">「分」線不計算 KDJ(資料量太少,判讀沒有意義)</div>`;
    document.getElementById("maLegend").innerHTML = "";
    document.getElementById("kdjLegend").innerHTML = "";
    document.getElementById("macdLegend").innerHTML = "";
    const kdjCtx = document.getElementById("kdjCanvas").getContext("2d");
    kdjCtx.clearRect(0, 0, kdjCtx.canvas.width, kdjCtx.canvas.height);
    const macdCtx = document.getElementById("macdCanvas").getContext("2d");
    macdCtx.clearRect(0, 0, macdCtx.canvas.width, macdCtx.canvas.height);
    drawMinuteChart(minutePoints); // 先把目前已經累積到的點畫出來,不用等下一次輪詢
  }

  async function loadHistoryForPeriod(period) {
    const neededMonths = PERIOD_MONTHS[period];
    // 週期切換時,只要之前抓過的月數已經夠用,就不用重新打 API(省時間、也對證交所比較友善)
    if (!fetchedMonthsFor[period] || fetchedMonthsFor[period] < neededMonths) {
      try {
        const histData = await fetchJSON(`${getApiBase()}/history?code=${encodeURIComponent(currentCode)}&months=${neededMonths}`);
        latestDailyRows = parseHistoryRows(histData);
        fetchedMonthsFor[period] = neededMonths;
      } catch (err) {
        console.warn("history failed:", err.message);
        latestDailyRows = [];
        if (period === "day") setMsg(`日線歷史暫時抓不到: ${err.message}（最新報價仍可顯示）`, "err");
      }
    }
    renderForPeriod(period);
  }

  function setMsg(text, type) { mainMsg.textContent = text; mainMsg.className = "msg " + type; }

  /* ============================================
     解析證交所日線資料
     ============================================ */
  function parseHistoryRows(histData) {
    const fields = histData.fields || [];
    const idx = {
      date: fields.indexOf("日期"),
      volume: fields.indexOf("成交股數"),
      amount: fields.indexOf("成交金額"),
      open: fields.indexOf("開盤價"),
      high: fields.indexOf("最高價"),
      low: fields.indexOf("最低價"),
      close: fields.indexOf("收盤價"),
      count: fields.indexOf("成交筆數"),
    };
    return (histData.data || [])
      .map(r => ({
        date: r[idx.date],
        volume: parseFloat(String(r[idx.volume]).replace(/,/g, "")) || 0,
        amount: idx.amount >= 0 ? parseFloat(String(r[idx.amount]).replace(/,/g, "")) : null,
        open: parseFloat(String(r[idx.open]).replace(/,/g, "")),
        high: parseFloat(String(r[idx.high]).replace(/,/g, "")),
        low: parseFloat(String(r[idx.low]).replace(/,/g, "")),
        close: parseFloat(String(r[idx.close]).replace(/,/g, "")),
        transactionCount: idx.count >= 0 ? parseFloat(String(r[idx.count]).replace(/,/g, "")) : null,
      }))
      .filter(r => !isNaN(r.high) && !isNaN(r.low) && !isNaN(r.close));
  }

  /* ============================================
     把日線資料彙整成週/月/年線
     民國日期格式類似 "115/08/07",用 "/" 分隔
     ============================================ */
  function aggregate(rows, period) {
    if (period === "day") return rows;

    const groups = new Map();
    rows.forEach(r => {
      const parts = String(r.date).split("/"); // [民國年, 月, 日]
      let key;
      if (period === "year") {
        key = parts[0];
      } else if (period === "month") {
        key = `${parts[0]}/${parts[1]}`;
      } else { // week:用該筆資料換算出的西元日期取 ISO 週數
        const y = parseInt(parts[0]) + 1911;
        const d = new Date(y, parseInt(parts[1]) - 1, parseInt(parts[2]));
        const weekKey = `${y}-W${getISOWeek(d)}`;
        key = weekKey;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    const result = [];
    for (const [key, group] of groups) {
      result.push({
        date: key,
        open: group[0].open,
        close: group[group.length - 1].close,
        high: Math.max(...group.map(g => g.high)),
        low: Math.min(...group.map(g => g.low)),
        volume: group.reduce((s, g) => s + g.volume, 0),
      });
    }
    return result;
  }

  function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  /* ============================================
     渲染報價卡片(Excel 風格分區塊表格)
     ============================================ */
  function renderQuote(q, ratio) {
    latestQuote = q;
    latestRatio = ratio || {};

    // 台灣 ETF 代號慣例都是 00 開頭(0050、0056、00878...),用這個規則判斷,不用額外查表
    const isEtf = /^00\d{2,4}$/.test(q.c);
    document.getElementById("stockTitle").innerHTML =
      `${q.c} ${q.n}` + (isEtf ? ` <span class="etf-badge">ETF</span>` : "");
    document.getElementById("quoteDate").textContent = "日期: " + formatQuoteDate(q);
    const sourceNote = q._source === "yahoo" ? "(目前顯示 Yahoo Finance 備援資料,非 TWSE 官方即時報價)" : "";
    document.getElementById("quoteSubtitle").textContent = `${q.c} ${q.n} 當日交易資料 ${sourceNote}`;

    const price = parseFloat(q.z);
    const prevClose = parseFloat(q.y);
    const open = parseFloat(q.o);
    const hasPrice = !isNaN(price) && q.z !== "-";
    const change = hasPrice && !isNaN(prevClose) ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose * 100) : null;
    const cls = change > 0 ? "up" : change < 0 ? "down" : "flat";

    setCell("qPrice", hasPrice ? price.toFixed(2) : "尚無成交", cls);
    setCell("qPrevClose", !isNaN(prevClose) ? prevClose.toFixed(2) : "--");
    setCell("qChange", change != null ? (change > 0 ? "+" : "") + change.toFixed(2) : "--", cls);
    setCell("qChangePct", changePct != null ? (changePct > 0 ? "+" : "") + changePct.toFixed(2) + "%" : "--", cls);
    setCell("qOpen", !isNaN(open) ? open.toFixed(2) : "--");
    setCell("qHigh", q.h && q.h !== "-" ? parseFloat(q.h).toFixed(2) : "--");
    setCell("qLow", q.l && q.l !== "-" ? parseFloat(q.l).toFixed(2) : "--");

    // 成交張數:v 單位是「張」(千股),TWSE 即時報價的欄位本身就是這個單位
    const lots = q.v && q.v !== "-" ? Math.round(parseFloat(q.v)) : null;
    setCell("qLots", lots != null ? lots.toLocaleString() + " 張" : "--");

    document.getElementById("qTime").textContent = "最後更新: " + formatQuoteTime(q);
  }

  /**
   * 第三區塊:昨日交易資料,來自歷史日線最後一筆(STOCK_DAY 收盤後才更新,
   * 所以「最後一筆歷史資料」就是最近一個完整交易日,即「昨天」)
   * 以及「連續漲跌」:從最近的日線資料回推,算連續同方向的天數與累計漲跌
   */
  /**
   * 股利發放歷史,來自官方股利分派資料集(依公司代號+年度存,涵蓋歷年資料)。
   * 因為不確定證交所實際使用的欄位名稱,這裡用「動態欄位」的寫法:
   * 不管欄位實際叫什麼,都自動抓出來建表頭,不會因為欄位名稱猜錯而整片空白。
   */
  /**
   * 籌碼分析:外資持股完整比例(來自 /foreign)+ 三大法人當日買賣超(來自 /institutional)
   */
  async function loadChipData(code) {
    const foreignMsgEl = document.getElementById("chipForeignMsg");
    const instMsgEl = document.getElementById("chipInstMsg");
    setMsgOn(foreignMsgEl, "載入中...", "loading");
    setMsgOn(instMsgEl, "載入中...", "loading");

    try {
      const res = await fetch(`${getApiBase()}/foreign`);
      const data = await res.json();

      if (data.error || !data.fields || !data.data) {
        throw new Error(data.error || "回傳格式異常");
      }

      const idx = {
        code: data.fields.indexOf("證券代號"),
        issued: data.fields.indexOf("發行股數"),
        available: data.fields.indexOf("外資及陸資尚可投資股數"),
        held: data.fields.indexOf("全體外資及陸資持有股數"),
        availPct: data.fields.indexOf("外資及陸資尚可投資比率"),
        ratio: data.fields.indexOf("全體外資及陸資持股比率"),
      };
      const row = data.data.find(r => r[idx.code] === code);
      if (!row) throw new Error("查無這檔股票的外資持股資料");

      document.getElementById("cfIssued").textContent = row[idx.issued] || "--";
      document.getElementById("cfAvailable").textContent = row[idx.available] || "--";
      document.getElementById("cfHeld").textContent = row[idx.held] || "--";
      document.getElementById("cfAvailPct").textContent = row[idx.availPct] || "--";
      document.getElementById("cfRatio").textContent = row[idx.ratio] || "--";
      setMsgOn(foreignMsgEl, `資料日期: ${data.date || "--"}`, "ok");
    } catch (err) {
      setMsgOn(foreignMsgEl, "外資持股載入失敗:" + err.message, "err");
    }

    try {
      const res = await fetch(`${getApiBase()}/institutional`);
      const data = await res.json();

      // 先檢查是不是錯誤回應(這是造成「Cannot read properties of undefined」的原因——
      // 沒先檢查就直接假設一定有 data.fields,遇到抓取失敗的情況就整個崩潰)
      if (data.error || !data.fields || !data.data) {
        throw new Error(data.error || "回傳格式異常");
      }

      const idx = {
        code: data.fields.indexOf("證券代號"),
        foreign: data.fields.indexOf("外陸資買賣超股數(不含外資自營商)"),
        trust: data.fields.indexOf("投信買賣超股數"),
        dealerNormal: data.fields.indexOf("自營商買賣超股數(自行買賣)"),
        dealerHedge: data.fields.indexOf("自營商買賣超股數(避險)"),
        total: data.fields.indexOf("三大法人買賣超股數"),
      };
      const row = data.data.find(r => String(r[idx.code]).trim() === code);
      if (!row) throw new Error("查無這檔股票今日的法人買賣資料(可能非交易日或該股無成交)");

      const fmt = v => v != null ? v : "--";
      const dealerTotal = idx.dealerNormal >= 0 && idx.dealerHedge >= 0
        ? (parseFloat(String(row[idx.dealerNormal]).replace(/,/g, "")) || 0) +
          (parseFloat(String(row[idx.dealerHedge]).replace(/,/g, "")) || 0)
        : null;

      document.getElementById("ciForeign").textContent = fmt(row[idx.foreign]);
      document.getElementById("ciTrust").textContent = fmt(row[idx.trust]);
      document.getElementById("ciDealer").textContent = dealerTotal != null ? dealerTotal.toLocaleString() : "--";
      document.getElementById("ciTotal").textContent = fmt(row[idx.total]);
      setMsgOn(instMsgEl, `資料日期: ${data.date || "--"}`, "ok");
    } catch (err) {
      setMsgOn(instMsgEl, "法人買賣資料載入失敗:" + err.message, "err");
    }
  }

  /**
   * 基本資料:公司產業別、成立日期、實收資本額等,動態建表(欄位名稱用實際回傳資料為準)
   */
  /**
   * 證交所「產業別」欄位存的是代碼,不是文字,這裡轉成好讀的名稱。
   * 對照表來源:證交所公開的 TSE 產業對照表,如果遇到表裡沒有的代碼,
   * 就顯示「產業別代碼:XX」,不會讓畫面整個空白或報錯。
   */
  const INDUSTRY_CODE_MAP = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維",
    "05": "電機機械", "06": "電器電纜", "08": "玻璃陶瓷", "09": "造紙工業",
    "10": "鋼鐵工業", "11": "橡膠工業", "12": "汽車工業", "14": "建材營造",
    "15": "航運業", "16": "觀光事業", "17": "金融保險", "18": "貿易百貨",
    "19": "綜合", "20": "其他", "21": "化學工業", "22": "生技醫療",
    "23": "油電燃氣業", "24": "半導體業", "25": "電腦及週邊設備業",
    "26": "光電業", "27": "通信網路業", "28": "電子零組件業", "29": "電子通路業",
    "30": "資訊服務業", "31": "其他電子業", "32": "文化創意業", "33": "農業科技業",
    "34": "電子商務業", "35": "綠能環保", "36": "數位雲端", "80": "管理股票",
    "91": "存託憑證(TDR)",
  };

  function industryName(code) {
    if (!code) return "--";
    const trimmed = String(code).trim().padStart(2, "0");
    return INDUSTRY_CODE_MAP[trimmed] || `產業別代碼:${code}(對照表沒有,可能是新增分類)`;
  }

  async function loadProfile(code) {
    const msgEl = document.getElementById("profileMsg");
    const headEl = document.getElementById("profileHead");
    const bodyEl = document.getElementById("profileBody");
    headEl.innerHTML = ""; bodyEl.innerHTML = "";
    setMsgOn(msgEl, "載入基本資料中...", "loading");

    try {
      const res = await fetch(`${getApiBase()}/profile`);
      const all = await res.json();
      if (!Array.isArray(all) || all.length === 0) throw new Error("回傳格式異常");

      const row = all.find(r => String(r["公司代號"]).trim() === code);
      if (!row) throw new Error("查無這檔股票的基本資料");

      const capitalRaw = parseFloat(row["實收資本額"]) || 0;
      const parValue = parseFloat(row["普通股每股面額"]) || 10; // 沒有資料時,台股絕大多數面額是 10 元
      const shares = parValue ? capitalRaw / parValue : 0;
      const price = latestQuote ? parseFloat(latestQuote.z) : NaN;
      const marketCap = !isNaN(price) && shares ? (shares * price / 1e8) : null;
      const capitalYi = capitalRaw / 1e8;

      const listingDate = formatDateField(row["上市日期"]);
      const listingYears = calcYearsSince(row["上市日期"]);

      const companyName = row["公司名稱"] || code;
      const googleUrl = (keyword) =>
        `https://www.google.com/search?q=${encodeURIComponent(`${code} ${companyName} ${keyword}`)}`;

      headEl.innerHTML = "";
      bodyEl.innerHTML = `
        <tr><td class="k">公司名稱</td><td>${row["公司名稱"] || "--"}</td><td class="k">產業</td><td>${industryName(row["產業別"])}</td></tr>
        <tr><td class="k">英文簡稱</td><td>${row["英文簡稱"] || "--"}</td><td class="k">細產業別</td><td><a href="${googleUrl("細產業別")}" target="_blank" rel="noopener" class="google-link">🔍 Google 查詢</a></td></tr>
        <tr><td class="k">董事長</td><td>${row["董事長"] || "--"}</td><td class="k">內銷比重</td><td><a href="${googleUrl("內銷比重 外銷比重")}" target="_blank" rel="noopener" class="google-link">🔍 Google 查詢</a></td></tr>
        <tr><td class="k">成立日期</td><td>${formatDateField(row["成立日期"])}</td><td class="k">外銷比重</td><td>同上,已合併查詢</td></tr>
        <tr><td class="k">上市上櫃</td><td>上市</td><td class="k">總市值(億)</td><td>${marketCap != null ? marketCap.toFixed(2) : "--"}</td></tr>
        <tr><td class="k">上市日期</td><td>${listingDate}</td><td class="k">資本額(億)</td><td>${capitalYi.toFixed(2)}</td></tr>
        <tr><td class="k">掛牌年數</td><td>${listingYears != null ? listingYears : "--"}</td><td class="k">股本(億)</td><td>${capitalYi.toFixed(2)}</td></tr>
        <tr><td class="k">經營項目</td><td colspan="3"><a href="${googleUrl("主要經營項目 主要業務")}" target="_blank" rel="noopener" class="google-link">🔍 Google 查詢「${companyName} 主要經營項目」</a></td></tr>
        <tr><td class="k">公司地址</td><td colspan="3">${row["住址"] || "--"}</td></tr>
      `;

      setMsgOn(msgEl, "細產業別、內外銷比重、經營項目這幾項,官方資料集沒有提供,已改成 Google 查詢連結,點下去會開新分頁幫你查好關鍵字", "ok");
    } catch (err) {
      setMsgOn(msgEl, "基本資料載入失敗:" + err.message, "err");
    }
  }

  /** 日期欄位可能是 YYYYMMDD(西元)或已經是 YYYY/MM/DD,統一轉成好讀的格式 */
  function formatDateField(raw) {
    if (!raw) return "--";
    const s = String(raw).trim();
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}/${s.slice(4,6)}/${s.slice(6,8)}`;
    return s;
  }

  /** 從日期欄位算到今天經過幾年,用來算掛牌年數 */
  function calcYearsSince(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    let y, m, d;
    if (/^\d{8}$/.test(s)) {
      y = +s.slice(0,4); m = +s.slice(4,6); d = +s.slice(6,8);
    } else if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
      [y, m, d] = s.split("/").map(Number);
    } else {
      return null;
    }
    const past = new Date(y, m - 1, d);
    if (isNaN(past.getTime())) return null;
    return Math.floor((Date.now() - past.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  }

  /**
   * 財務分析分頁:估值指標(用已經抓過的 latestRatio,不用重打 API)
   * + 營收(/revenue,篩選這檔股票)+ 損益表 EPS(/income)
   */
  async function loadFinancials(code) {
    // 估值指標直接沿用查詢股票時已經抓過的 latestRatio,不用重複打 API
    document.getElementById("finPER").textContent = latestRatio.PEratio ? parseFloat(latestRatio.PEratio).toFixed(2) : "--";
    document.getElementById("finYield").textContent = latestRatio.DividendYield ? parseFloat(latestRatio.DividendYield).toFixed(2) : "--";
    document.getElementById("finPBR").textContent = latestRatio.PBratio ? parseFloat(latestRatio.PBratio).toFixed(2) : "--";

    // 各面板獨立載入,一個失敗不影響其他面板
    loadFinRevenue(code);
    loadFinProfit(code);
    loadFinBalance(code);
  }

  /** 抓最近 N 年的日期字串,給 FinMind 的 start_date 參數用 */
  function yearsAgoDateStr(years) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString().slice(0, 10);
  }

  async function fetchFinMind(dataset, code, years = 8) {
    const url = `${getApiBase()}/fm?dataset=${dataset}&code=${code}&start_date=${yearsAgoDateStr(years)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(json.error + (json.detail ? `(${json.detail})` : ""));
    if (!json.data) throw new Error("回傳格式異常,查無 data 欄位");
    return json.data;
  }

  /* ============================================
     月營收狀況(FinMind: TaiwanStockMonthRevenue)
     ============================================ */
  async function loadFinRevenue(code) {
    const msgEl = document.getElementById("finRevenueMsg");
    const bodyEl = document.getElementById("finRevenueBody");
    bodyEl.innerHTML = "";
    setMsgOn(msgEl, "載入月營收中(FinMind)...", "loading");

    try {
      const rows = await fetchFinMind("TaiwanStockMonthRevenue", code, 8);
      if (rows.length === 0) throw new Error("查無資料,這檔股票可能在 FinMind 沒有月營收紀錄");

      // 依年月排序(新到舊),並計算月增率/年增率/累計營收(因為 FinMind 原始資料不一定會附增減率,自己算比較保險)
      const sorted = [...rows].sort((a, b) =>
        (b.revenue_year * 100 + b.revenue_month) - (a.revenue_year * 100 + a.revenue_month)
      );
      const byKey = {};
      sorted.forEach(r => { byKey[`${r.revenue_year}-${r.revenue_month}`] = r; });

      const enriched = sorted.map(r => {
        const lastMonthKey = r.revenue_month === 1 ? `${r.revenue_year - 1}-12` : `${r.revenue_year}-${r.revenue_month - 1}`;
        const lastYearKey = `${r.revenue_year - 1}-${r.revenue_month}`;
        const lastMonthRev = byKey[lastMonthKey]?.revenue;
        const lastYearRev = byKey[lastYearKey]?.revenue;
        const mom = lastMonthRev ? ((r.revenue - lastMonthRev) / lastMonthRev * 100) : null;
        const yoy = lastYearRev ? ((r.revenue - lastYearRev) / lastYearRev * 100) : null;

        // 累計營收:同一年度、從1月到這個月的加總
        const cumThis = sorted
          .filter(x => x.revenue_year === r.revenue_year && x.revenue_month <= r.revenue_month)
          .reduce((s, x) => s + x.revenue, 0);
        const cumLast = sorted
          .filter(x => x.revenue_year === r.revenue_year - 1 && x.revenue_month <= r.revenue_month)
          .reduce((s, x) => s + x.revenue, 0);
        const cumYoy = cumLast ? ((cumThis - cumLast) / cumLast * 100) : null;

        return { ...r, mom, yoy, cumThis, cumLast: cumLast || null, cumYoy };
      });

      // 只顯示最近 24 個月,避免表格過長
      const display = enriched.slice(0, 24);

      bodyEl.innerHTML = display.map(r => {
        const momCls = r.mom > 0 ? "up" : r.mom < 0 ? "down" : "";
        const yoyCls = r.yoy > 0 ? "up" : r.yoy < 0 ? "down" : "";
        return `
          <tr>
            <td>${r.revenue_year}/${String(r.revenue_month).padStart(2,"0")}</td>
            <td>${(r.revenue / 1e8).toFixed(2)}</td>
            <td class="${momCls}">${r.mom != null ? r.mom.toFixed(1) : "--"}</td>
            <td class="${yoyCls}">${r.yoy != null ? r.yoy.toFixed(1) : "--"}</td>
            <td>${(r.cumThis / 1e8).toFixed(2)}</td>
            <td>${r.cumYoy != null ? r.cumYoy.toFixed(1) : "--"}</td>
          </tr>
        `;
      }).join("");

      // 折線圖:要由舊到新排列,所以把 display(新到舊)反過來
      const chartRows = [...display].reverse();
      drawTrendChart(
        "finRevenueChart",
        chartRows.map(r => `${r.revenue_year}/${String(r.revenue_month).padStart(2,"0")}`),
        [{ name: "單月營收(億)", values: chartRows.map(r => r.revenue / 1e8), color: "#ff8a3d" }]
      );

      setMsgOn(msgEl, `共取得 ${rows.length} 筆月營收紀錄(近8年),顯示最近 ${display.length} 個月`, "ok");
    } catch (err) {
      setMsgOn(msgEl, "月營收載入失敗:" + err.message, "err");
    }
  }

  /* ============================================
     獲利狀況(FinMind: TaiwanStockFinancialStatements)
     這份資料是「長表格式」:每季很多筆,每筆是一個科目(type)+數值(value),
     要自己依日期(季別)分組、把各科目拼回同一列
     ============================================ */
  async function loadFinProfit(code) {
    const msgEl = document.getElementById("finProfitMsg");
    const bodyEl = document.getElementById("finProfitBody");
    bodyEl.innerHTML = "";
    setMsgOn(msgEl, "載入獲利狀況中(FinMind)...", "loading");

    try {
      const rows = await fetchFinMind("TaiwanStockFinancialStatements", code, 8);
      if (rows.length === 0) throw new Error("查無資料");

      // 依日期(季別)分組,把每個科目攤平成同一列的欄位
      const byQuarter = {};
      rows.forEach(r => {
        if (!byQuarter[r.date]) byQuarter[r.date] = { date: r.date };
        byQuarter[r.date][r.type] = r.value;
      });

      // 找出常見科目名稱(FinMind 的科目命名可能因公司/產業略有差異,用候選比對增加相容性)
      const pick = (obj, candidates) => {
        for (const k of candidates) if (obj[k] != null) return obj[k];
        return null;
      };

      const quarters = Object.values(byQuarter).map(q => ({
        date: q.date,
        year: q.date.slice(0, 4),
        revenue: pick(q, ["Revenue", "TotalRevenue", "OperatingRevenue", "利息淨收益"]),
        grossProfit: pick(q, ["GrossProfit", "GrossProfitLoss"]),
        operatingIncome: pick(q, ["OperatingIncome", "OperatingIncomeLoss"]),
        netIncome: pick(q, ["IncomeAfterTaxes", "IncomeAfterTaxesFromContinuingOperations", "ProfitLoss"]),
        eps: pick(q, ["EPS", "EarningsPerShare", "EarningsPerShareBasic"]),
      })).filter(q => q.revenue != null || q.netIncome != null);

      if (quarters.length === 0) {
        throw new Error("找到資料但科目名稱沒對上,可能是這檔股票屬於特殊產業(金融/保險類科目命名不同)");
      }

      // 依年度加總四季,做出「年度」列;同時保留最新一季當「最新季」列
      const byYear = {};
      quarters.forEach(q => {
        if (!byYear[q.year]) byYear[q.year] = { year: q.year, revenue: 0, netIncome: 0, grossProfit: 0, operatingIncome: 0, eps: 0, quarterCount: 0 };
        const y = byYear[q.year];
        y.revenue += q.revenue || 0;
        y.netIncome += q.netIncome || 0;
        y.grossProfit += q.grossProfit || 0;
        y.operatingIncome += q.operatingIncome || 0;
        y.eps += q.eps || 0;
        y.quarterCount++;
      });

      const yearRows = Object.values(byYear).sort((a, b) => b.year.localeCompare(a.year));

      // 快取年度 EPS,給股利歷史表格重複使用,不用再打一次 API
      epsByYear = {};
      yearRows.forEach(y => { epsByYear[y.year] = y.eps; });

      bodyEl.innerHTML = yearRows.map(y => {
        const grossMargin = y.revenue ? (y.grossProfit / y.revenue * 100) : null;
        const opMargin = y.revenue ? (y.operatingIncome / y.revenue * 100) : null;
        const netMargin = y.revenue ? (y.netIncome / y.revenue * 100) : null;
        const label = y.quarterCount < 4 ? `${y.year}(累${y.quarterCount}季)` : y.year;
        return `
          <tr>
            <td>${label}</td>
            <td>${(y.revenue / 1e8).toFixed(0)}</td>
            <td>${(y.netIncome / 1e8).toFixed(0)}</td>
            <td>${grossMargin != null ? grossMargin.toFixed(1) : "--"}</td>
            <td>${opMargin != null ? opMargin.toFixed(1) : "--"}</td>
            <td>${netMargin != null ? netMargin.toFixed(1) : "--"}</td>
            <td>${y.eps.toFixed(2)}</td>
          </tr>
        `;
      }).join("");

      // 折線圖:由舊到新排列
      const chartRows = [...yearRows].reverse();
      const chartLabels = chartRows.map(y => y.year);

      drawTrendChart(
        "finProfitChart",
        chartLabels,
        [
          { name: "營收(億)", values: chartRows.map(y => y.revenue / 1e8), color: "#ff8a3d" },
          { name: "稅後淨利(億)", values: chartRows.map(y => y.netIncome / 1e8), color: "#4fd693" },
        ]
      );
      document.getElementById("finProfitChartLegend").innerHTML = `
        <span><span class="dot" style="background:#ff8a3d;"></span>營收(億)</span>
        <span><span class="dot" style="background:#4fd693;"></span>稅後淨利(億)</span>
      `;

      drawTrendChart(
        "finEpsChart",
        chartLabels,
        [{ name: "EPS(元)", values: chartRows.map(y => y.eps), color: "#d97fe8" }]
      );

      setMsgOn(msgEl, `共取得 ${quarters.length} 季資料(近8年),已依年度加總`, "ok");
    } catch (err) {
      setMsgOn(msgEl, "獲利狀況載入失敗:" + err.message, "err");
    }
  }

  /* ============================================
     資產負債(FinMind: TaiwanStockBalanceSheet)
     同樣是長表格式,取每年最後一季(通常是Q4,代表當年度年底的資產負債狀況)
     ============================================ */
  async function loadFinBalance(code) {
    const msgEl = document.getElementById("finBalanceMsg");
    const bodyEl = document.getElementById("finBalanceBody");
    bodyEl.innerHTML = "";
    setMsgOn(msgEl, "載入資產負債中(FinMind)...", "loading");

    try {
      const rows = await fetchFinMind("TaiwanStockBalanceSheet", code, 8);
      if (rows.length === 0) throw new Error("查無資料");

      const byQuarter = {};
      rows.forEach(r => {
        if (!byQuarter[r.date]) byQuarter[r.date] = { date: r.date };
        byQuarter[r.date][r.type] = r.value;
      });

      const pick = (obj, candidates) => {
        for (const k of candidates) if (obj[k] != null) return obj[k];
        return null;
      };

      const quarters = Object.values(byQuarter).map(q => ({
        date: q.date,
        year: q.date.slice(0, 4),
        totalAssets: pick(q, ["TotalAssets"]),
        cash: pick(q, ["CashAndCashEquivalents", "Cash"]),
        receivables: pick(q, ["AccountsReceivableNet", "NotesReceivableNetCurrent"]),
        inventory: pick(q, ["Inventories"]),
        totalLiabilities: pick(q, ["TotalLiabilities"]),
        equity: pick(q, ["Equity", "EquityAttributableToOwnersOfParent"]),
        sharesOutstanding: pick(q, ["OrdinarySharesNumber", "CommonStockSharesOutstanding"]),
      })).filter(q => q.totalAssets != null);

      if (quarters.length === 0) {
        throw new Error("找到資料但科目名稱沒對上");
      }

      // 每個年度只取最後一季(季度數字最大的那筆),代表當年度年底的狀況
      const latestByYear = {};
      quarters.forEach(q => {
        if (!latestByYear[q.year] || q.date > latestByYear[q.year].date) latestByYear[q.year] = q;
      });

      const yearRows = Object.values(latestByYear).sort((a, b) => b.year.localeCompare(a.year));

      bodyEl.innerHTML = yearRows.map(q => {
        const pct = v => v != null && q.totalAssets ? (v / q.totalAssets * 100).toFixed(1) : "--";
        const bps = q.equity != null && q.sharesOutstanding ? (q.equity / q.sharesOutstanding).toFixed(2) : "--";
        return `
          <tr>
            <td>${q.year}</td>
            <td>${pct(q.cash)}</td>
            <td>${pct(q.receivables)}</td>
            <td>${pct(q.inventory)}</td>
            <td>${pct(q.totalLiabilities)}</td>
            <td>${bps}</td>
          </tr>
        `;
      }).join("");

      setMsgOn(msgEl, `共取得 ${quarters.length} 季資料(近8年),每年顯示最後一季(年底)狀況`, "ok");
    } catch (err) {
      setMsgOn(msgEl, "資產負債載入失敗:" + err.message, "err");
    }
  }

  async function loadDividendHistory(code) {
    const msgEl = document.getElementById("dividendMsg");
    const bodyEl = document.getElementById("dividendBody");
    bodyEl.innerHTML = "";
    setMsgOn(msgEl, "載入股利歷史中(FinMind)...", "loading");

    try {
      const rows = await fetchFinMind("TaiwanStockDividend", code, 15); // 抓近15年,股利資料集本身涵蓋更久,但抓太多年沒必要

      if (rows.length === 0) {
        setMsgOn(msgEl, "查無這檔股票的股利發放紀錄", "err");
        return;
      }

      // 同一年度出現幾筆紀錄,概判配息頻率(1筆=年配、2筆=半年配、4筆=季配、更多=月配)
      const countByYear = {};
      rows.forEach(r => { countByYear[r.year] = (countByYear[r.year] || 0) + 1; });
      const freqLabel = n => n >= 10 ? "月配" : n === 4 ? "季配" : n === 2 ? "半年配" : "年配";

      // 同一年度可能有多筆(分次配息),先加總同年度的現金/股票股利,得到「這年度總共配多少」
      const byYear = {};
      rows.forEach(r => {
        const y = r.year;
        if (!byYear[y]) byYear[y] = {
          year: y, cash: 0, stock: 0,
          cashExDates: [], stockExDates: [], paymentDates: [],
        };
        byYear[y].cash += parseFloat(r.CashEarningsDistribution) || 0;
        byYear[y].stock += (parseFloat(r.StockEarningsDistribution) || 0) + (parseFloat(r.StockStatutorySurplus) || 0);
        if (r.CashExDividendTradingDate) byYear[y].cashExDates.push(r.CashExDividendTradingDate);
        if (r.StockExDividendTradingDate) byYear[y].stockExDates.push(r.StockExDividendTradingDate);
        if (r.CashDividendPaymentDate) byYear[y].paymentDates.push(r.CashDividendPaymentDate);
      });

      const yearRows = Object.values(byYear).sort((a, b) => b.year.localeCompare(a.year));
      const currentPrice = latestQuote ? parseFloat(latestQuote.z) : NaN;

      bodyEl.innerHTML = yearRows.map(y => {
        const yieldPct = !isNaN(currentPrice) && currentPrice > 0 && y.cash > 0
          ? (y.cash / currentPrice * 100).toFixed(2) : "--";
        const eps = epsByYear[y.year];

        // 一年可能有好幾次除權息,把日期用頓號接起來顯示
        const fmtDates = arr => arr.length ? arr.join("、") : "--";

        return `
          <tr>
            <td>${y.year}</td>
            <td>${freqLabel(countByYear[y.year])}</td>
            <td>${y.cash.toFixed(2)}</td>
            <td>${y.stock.toFixed(2)}</td>
            <td>${eps != null ? eps.toFixed(2) : "--"}</td>
            <td>${yieldPct}</td>
            <td>${fmtDates(y.cashExDates)}</td>
            <td>${fmtDates(y.stockExDates)}</td>
            <td>${fmtDates(y.paymentDates)}</td>
          </tr>
        `;
      }).join("");

      // 折線圖:由舊到新排列
      const chartRows = [...yearRows].reverse();
      drawTrendChart(
        "dividendChart",
        chartRows.map(y => y.year),
        [{ name: "現金股利(元/股)", values: chartRows.map(y => y.cash), color: "#ff8a3d" }]
      );

      const summaryMsg = `共 ${yearRows.length} 個年度、${rows.length} 筆股利發放紀錄。殖利率用「目前股價」概算,不是當時發放時的股價;EPS 來自獲利狀況面板算出的年度 EPS 快照(需要先看過獲利狀況分頁才會有資料)`;
      setMsgOn(msgEl, summaryMsg, "ok");

    } catch (err) {
      setMsgOn(msgEl, "股利歷史載入失敗:" + err.message, "err");
    }
  }

  function setMsgOn(el, text, type) { el.textContent = text; el.className = "msg " + type; }

  /**
   * 從「期別」欄位的文字概略判斷配息頻率(月配/季配/半年配/年配)。
   * 官方沒有直接的頻率分類欄位,這是用文字關鍵字概判,不是精確分類,
   * 如果期別欄位寫法特殊,可能會判斷成「--」。
   */
  function classifyDividendFrequency(periodText) {
    if (!periodText) return "--";
    const s = String(periodText);
    if (s.includes("月")) return "月配";
    if (s.includes("季")) return "季配";
    if (s.includes("半年")) return "半年配";
    if (s.includes("年度") || s.includes("全年")) return "年配";
    return "--";
  }

  /**
   * 通用折線圖繪製函式,純 Canvas 手繪,不依賴外部套件。
   * seriesList: [{ name, values, color }],labels 跟 values 是同長度陣列,由舊到新排序。
   * 這個版本額外處理:重繪 + 記錄座標換算方式,給滑鼠移動的十字游標功能使用。
   */
  const trendChartStates = {}; // canvasId → { labels, seriesList, cssHeight },重繪時要用
  const trendChartBound = {};  // canvasId → 是否已經綁定過滑鼠事件,避免重複綁定

  function drawTrendChart(canvasId, labels, seriesList, cssHeight = 160) {
    trendChartStates[canvasId] = { labels, seriesList, cssHeight };
    drawTrendChartBase(canvasId);
    attachTrendCrosshair(canvasId);
  }

  function drawTrendChartBase(canvasId) {
    const state = trendChartStates[canvasId];
    if (!state) return;
    const { labels, seriesList, cssHeight } = state;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (labels.length === 0) return;

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 54, padRight = 12, padTop = 10, padBottom = 24;
    const chartH = cssHeight - padTop - padBottom;
    const chartW = cssWidth - padLeft - padRight;

    const allVals = seriesList.flatMap(s => s.values.filter(v => v != null));
    if (allVals.length === 0) return;
    const maxV = Math.max(...allVals), minV = Math.min(...allVals);
    const pad = (maxV - minV) * 0.12 || Math.abs(maxV) * 0.1 || 1;
    const top = maxV + pad, bottom = minV - pad;

    const n = labels.length;
    const xAt = i => n === 1 ? padLeft + chartW / 2 : padLeft + (i / (n - 1)) * chartW;
    const yAt = v => padTop + (top - v) / (top - bottom) * chartH;

    // 網格與 Y 軸刻度
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1; ctx.font = "10px monospace"; ctx.fillStyle = textColor;
    for (let g = 0; g <= 4; g++) {
      const v = bottom + (top - bottom) * (g / 4);
      const y = yAt(v);
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssWidth - padRight, y); ctx.stroke();
      ctx.fillText(v >= 1000 || v <= -1000 ? v.toFixed(0) : v.toFixed(1), 2, y + 3);
    }

    // 每條線
    seriesList.forEach(s => {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.beginPath();
      let started = false;
      s.values.forEach((v, i) => {
        if (v == null) return;
        const x = xAt(i), y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      });
      ctx.stroke();

      // 資料點
      ctx.fillStyle = s.color;
      s.values.forEach((v, i) => {
        if (v == null) return;
        ctx.beginPath(); ctx.arc(xAt(i), yAt(v), 2, 0, Math.PI * 2); ctx.fill();
      });
    });

    // X 軸標籤(每隔幾筆顯示一次,避免擠成一團)
    ctx.fillStyle = textColor; ctx.font = "10px monospace";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    labels.forEach((label, i) => {
      if (i % labelStep === 0 || i === n - 1) {
        ctx.fillText(String(label), xAt(i) - 14, cssHeight - 6);
      }
    });

    // 記錄這次畫圖用的座標換算方式,給滑鼠移動的十字游標功能使用
    state.layout = { xAt, yAt, padLeft, padRight, cssWidth, cssHeight, n };
  }

  /**
   * 幫一個折線圖 canvas 綁定滑鼠移動的十字游標互動,只會綁定一次
   * (重複呼叫 drawTrendChart 時不會疊加出好幾個事件監聽器)
   */
  function attachTrendCrosshair(canvasId) {
    if (trendChartBound[canvasId]) return;
    trendChartBound[canvasId] = true;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.style.cursor = "crosshair";

    // 每個折線圖共用同一個浮動提示框,用 position:fixed 直接跟著滑鼠位置走,
    // 不用另外幫每張圖各自準備一個提示框元素
    let tip = document.getElementById("trendChartTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "trendChartTip";
      tip.className = "crosshair-tip";
      tip.style.position = "fixed";
      document.body.appendChild(tip);
    }

    canvas.addEventListener("mousemove", e => {
      const state = trendChartStates[canvasId];
      if (!state || !state.layout) return;
      const { xAt, padLeft, padRight, cssWidth, n } = state.layout;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      if (mouseX < padLeft || mouseX > cssWidth - padRight) { hideTrendCrosshair(canvasId, tip); return; }

      let closest = 0, minDist = Infinity;
      for (let i = 0; i < n; i++) {
        const dist = Math.abs(xAt(i) - mouseX);
        if (dist < minDist) { minDist = dist; closest = i; }
      }

      drawTrendChartBase(canvasId); // 先重畫乾淨的底圖,避免虛線疊加殘影
      const { yAt, padTop } = state.layout;
      const ctx = canvas.getContext("2d");
      const x = xAt(closest);

      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
      ctx.save();
      ctx.strokeStyle = accent; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, canvas.clientHeight - 4); ctx.stroke();
      ctx.restore();

      // 提示框內容:標籤 + 這個點上每一條線各自的數值
      const label = state.labels[closest];
      const lines = state.seriesList
        .map(s => `<span style="color:${s.color};">${s.name} ${s.values[closest] != null ? s.values[closest].toFixed(2) : "--"}</span>`)
        .join("<br>");
      tip.innerHTML = `${label}<br>${lines}`;
      tip.style.display = "block";
      tip.style.left = (e.clientX + 14) + "px";
      tip.style.top = (e.clientY - 10) + "px";
    });

    canvas.addEventListener("mouseleave", () => hideTrendCrosshair(canvasId, tip));
  }

  function hideTrendCrosshair(canvasId, tip) {
    tip.style.display = "none";
    drawTrendChartBase(canvasId); // 移開滑鼠時重畫一次乾淨的圖,把十字線清掉
  }

  function formatNum(v) {
    if (v === null || v === undefined || v === "") return "--";
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? v : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  /**
   * 即時報價 API 的 t 欄位只有時間(例如 13:30:00),沒有日期,
   * 這裡用 d 欄位(格式通常是 YYYYMMDD)組成完整的年月日時間,
   * 如果 API 沒有回傳 d,就用瀏覽器現在的日期當備援
   */
  function formatQuoteDate(q) {
    if (q.d && /^\d{8}$/.test(q.d)) {
      return `${q.d.slice(0,4)}/${q.d.slice(4,6)}/${q.d.slice(6,8)}`;
    }
    const now = new Date();
    return `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getDate()).padStart(2,"0")}`;
  }

  function formatQuoteTime(q) {
    return `${formatQuoteDate(q)} ${q.t || "--"}`;
  }

  function setCell(id, text, cls) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = cls || "";
  }

  /* ============================================
     KDJ 計算與判讀(只顯示狀態標籤,不畫線圖)
     ============================================ */
  function calcKDJ(rows) {
    let k = 50, d = 50;
    const result = [];
    rows.forEach((row, i) => {
      const windowStart = Math.max(0, i - 8);
      const windowRows = rows.slice(windowStart, i + 1);
      const highN = Math.max(...windowRows.map(r => r.high));
      const lowN = Math.min(...windowRows.map(r => r.low));
      const rsv = highN === lowN ? 50 : ((row.close - lowN) / (highN - lowN)) * 100;
      k = (2 / 3) * k + (1 / 3) * rsv;
      d = (2 / 3) * d + (1 / 3) * k;
      result.push({ k, d, j: 3 * k - 2 * d });
    });
    return result;
  }

  function judgeKdjStatus(kdjSeries) {
    if (kdjSeries.length < 2) return { type: "neutral", text: "資料不足,無法判讀" };
    const cur = kdjSeries[kdjSeries.length - 1];
    const prev = kdjSeries[kdjSeries.length - 2];
    const crossedUp = prev.k <= prev.d && cur.k > cur.d;
    const crossedDown = prev.k >= prev.d && cur.k < cur.d;

    if (crossedUp && cur.k < 50) return { type: "golden", text: "🟢 黃金交叉:K 值由下往上穿越 D 值,常視為買進訊號參考" };
    if (crossedDown && cur.k > 50) return { type: "death", text: "🔴 死亡交叉:K 值由上往下穿越 D 值,常視為賣出訊號參考" };
    if (cur.k > 80 && cur.d > 80) return { type: "overbought", text: "⚠️ 市場處於超買狀態,短線可能有回檔壓力" };
    if (cur.k < 20 && cur.d < 20) return { type: "oversold", text: "💡 市場處於超賣狀態,短線可能有反彈機會" };
    return { type: "neutral", text: "➖ 目前無明顯交叉或超買超賣訊號,盤整格局" };
  }

  /* ============================================
     依目前選擇的週期,重新計算並繪製
     ============================================ */
  function renderForPeriod(period) {
    const rows = aggregate(latestDailyRows, period);

    if (rows.length === 0) {
      document.getElementById("kdjStatusBox").innerHTML = `<div class="kdj-status neutral">查無足夠資料</div>`;
      return;
    }

    const kdjSeries = calcKDJ(rows);
    const status = judgeKdjStatus(kdjSeries);
    document.getElementById("kdjStatusBox").innerHTML = `<div class="kdj-status ${status.type}">${status.text}</div>`;

    drawPriceVolumeCanvas(rows);
    drawKdjCanvas(rows, kdjSeries);
    drawMacdCanvas(rows);
    drawRsiCanvas(rows);

    // 記錄目前的資料,給十字游標重繪使用(KDJ/MACD/RSI 滑鼠移動時需要重畫,得知道原始資料是什麼)
    technicalChartData = { rows, kdjSeries };

    // 記錄目前最新的技術指標數值,給「產生趨勢解讀」按鈕使用,避免按下去時要重新算一次
    latestIndicators = buildIndicatorSnapshot(rows, kdjSeries);
  }

  let technicalChartData = { rows: [], kdjSeries: [] };

  /**
   * 通用的十字游標附加機制,給 KDJ/MACD/RSI 這種「畫法各自客製化、但都有 X 軸資料點」的圖表用。
   * redrawFn:滑鼠移動時要呼叫哪個函式重畫乾淨的底圖
   * getTooltip(index):回傳這個資料點要顯示的提示文字(HTML)
   */
  function attachSimpleCrosshair(canvasId, redrawFn, getTooltip) {
    if (trendChartBound[canvasId]) return;
    trendChartBound[canvasId] = true;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.style.cursor = "crosshair";

    let tip = document.getElementById("trendChartTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "trendChartTip";
      tip.className = "crosshair-tip";
      tip.style.position = "fixed";
      document.body.appendChild(tip);
    }

    canvas.addEventListener("mousemove", e => {
      const state = trendChartStates[canvasId];
      if (!state || !state.layout) return;
      const { xAt, padLeft, padRight, padTop, cssWidth, cssHeight, n } = state.layout;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      if (mouseX < padLeft || mouseX > cssWidth - padRight) { tip.style.display = "none"; redrawFn(); return; }

      let closest = 0, minDist = Infinity;
      for (let i = 0; i < n; i++) {
        const dist = Math.abs(xAt(i) - mouseX);
        if (dist < minDist) { minDist = dist; closest = i; }
      }

      redrawFn(); // 先重畫乾淨的底圖,避免虛線疊加殘影
      const ctx = canvas.getContext("2d");
      const x = xAt(closest);
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
      ctx.save();
      ctx.strokeStyle = accent; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, cssHeight - 4); ctx.stroke();
      ctx.restore();

      tip.innerHTML = getTooltip(closest);
      tip.style.display = "block";
      tip.style.left = (e.clientX + 14) + "px";
      tip.style.top = (e.clientY - 10) + "px";
    });

    canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; redrawFn(); });
  }

  /* ============================================
     RSI(14)計算與繪圖:標準公式,用平均漲幅/平均跌幅的比值算出來
     70 以上通常視為超買,30 以下視為超賣(跟 KDJ 的 80/20 概念類似,但門檻不同)
     ============================================ */
  function calcRSI(rows, period = 14) {
    const closes = rows.map(r => r.close);
    const result = [];
    let avgGain = 0, avgLoss = 0;

    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { result.push(50); continue; }
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;

      if (i <= period) {
        avgGain = (avgGain * (i - 1) + gain) / i;
        avgLoss = (avgLoss * (i - 1) + loss) / i;
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }

      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
      result.push(rsi);
    }
    return result;
  }

  function drawRsiCanvas(rows) {
    const rsi = calcRSI(rows);
    const n = rows.length;

    const canvas = document.getElementById("rsiCanvas");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    const cssHeight = 130;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 48, padRight = 12, padTop = 8, padBottom = 6;
    const chartH = cssHeight - padTop - padBottom;
    const chartW = cssWidth - padLeft - padRight;

    const top = 100, bottom = 0;
    const slotW = chartW / n;
    const xAt = i => padLeft + i * slotW + slotW / 2;
    const yAt = v => padTop + (top - v) / (top - bottom) * chartH;

    [70, 30].forEach(level => {
      const y = yAt(level);
      ctx.strokeStyle = gridColor; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssWidth - padRight, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textColor; ctx.font = "10px monospace";
      ctx.fillText(String(level), 2, y + 3);
    });

    drawMaLine(ctx, rsi, xAt, yAt, "#4fa3d6");

    const last = rsi[rsi.length - 1];
    const rsiStatus = last >= 70 ? "超買" : last <= 30 ? "超賣" : "中性";
    document.getElementById("rsiLegend").innerHTML = `
      <span><span class="dot" style="background:#4fa3d6;"></span>RSI(14) ${last.toFixed(1)}</span>
      <span style="color:var(--text-dim);">目前狀態:${rsiStatus}(70以上超買、30以下超賣)</span>
    `;

    trendChartStates["rsiCanvas"] = { layout: { xAt, padLeft, padRight, padTop, cssWidth, cssHeight, n }, rsi, rows };
    attachSimpleCrosshair("rsiCanvas",
      () => drawRsiCanvas(technicalChartData.rows),
      (i) => `${rows[i].date}<br><span style="color:#4fa3d6;">RSI ${rsi[i].toFixed(1)}</span>`
    );
  }

  /** 把目前的 MA/RSI/KDJ/MACD 打包成一份快照,給 Gemini 分析用 */
  function buildIndicatorSnapshot(rows, kdjSeries) {
    const ma5 = calcMA(rows, 5), ma20 = calcMA(rows, 20), ma60 = calcMA(rows, 60);
    const rsi = calcRSI(rows);
    const macd = calcMACD(rows);
    const kdjStatus = judgeKdjStatus(kdjSeries);
    const lastK = kdjSeries[kdjSeries.length - 1];

    // 均線斜率:用最近兩個值比較,判斷上彎/下彎(這裡用 5MA 當短期、20MA 當長期,是 KDJ/MACD 之外另一組判讀依據)
    const lastN = arr => arr[arr.length - 1];
    const prevN = arr => arr[arr.length - 2];
    const slope = (arr) => {
      const last = lastN(arr), prev = prevN(arr);
      if (last == null || prev == null) return 0;
      return last - prev;
    };

    // 黃金交叉/死亡交叉:比較最近兩天,5MA 是否穿越 20MA
    let maCross = null;
    if (ma5.length >= 2 && ma20.length >= 2) {
      const curShort = lastN(ma5), curLong = lastN(ma20);
      const prevShort = prevN(ma5), prevLong = prevN(ma20);
      if (curShort != null && curLong != null && prevShort != null && prevLong != null) {
        if (prevShort <= prevLong && curShort > curLong) maCross = "golden_cross";
        else if (prevShort >= prevLong && curShort < curLong) maCross = "death_cross";
      }
    }

    return {
      code: currentCode,
      name: latestQuote?.n || "",
      last_close: rows[rows.length - 1]?.close,
      price: rows[rows.length - 1]?.close,
      change: latestQuote ? (parseFloat(latestQuote.z) - parseFloat(latestQuote.y)).toFixed(2) : null,
      ma5: ma5[ma5.length - 1]?.toFixed(2),
      ma20: ma20[ma20.length - 1]?.toFixed(2),
      ma60: ma60[ma60.length - 1]?.toFixed(2),
      SMA_short: lastN(ma5), SMA_long: lastN(ma20),
      slope_short: slope(ma5), slope_long: slope(ma20),
      ma_cross: maCross,
      rsi: rsi[rsi.length - 1]?.toFixed(1),
      RSI: lastN(rsi),
      kdj: { k: lastK.k.toFixed(1), d: lastK.d.toFixed(1), j: lastK.j.toFixed(1), status: kdjStatus.text },
      macd: {
        dif: macd.dif[macd.dif.length - 1]?.toFixed(2),
        dea: macd.dea[macd.dea.length - 1]?.toFixed(2),
        osc: macd.osc[macd.osc.length - 1]?.toFixed(2),
      },
    };
  }

  /**
   * 規則式的本地解讀(Gemini 呼叫失敗時的備援),不用打 API 就能立刻給出一段文字判讀。
   * 邏輯對照:價格與短長期均線的相對位置 → 均線斜率 → 有沒有交叉訊號 → RSI 區間,
   * 四個角度分開講,不會只靠單一指標就下結論。
   */
  function humanizeInterpretation(f) {
    const lines = [];

    // 價格與均線相對位置
    if (f.last_close > f.SMA_short && f.SMA_short > f.SMA_long) {
      lines.push("價格位於短、長期均線之上,屬於偏多排列");
    } else if (f.last_close < f.SMA_short && f.SMA_short < f.SMA_long) {
      lines.push("價格位於短、長期均線之下,屬於偏空排列");
    } else {
      lines.push("價格與均線多空交錯,短線方向不明確");
    }

    // 均線斜率
    if (f.slope_short > 0 && f.slope_long > 0) {
      lines.push("短長期均線皆上彎,整體趨勢偏多");
    } else if (f.slope_short < 0 && f.slope_long < 0) {
      lines.push("短長期均線皆下彎,整體趨勢偏弱");
    } else {
      lines.push("短長期均線方向不一致,留意盤整或轉折");
    }

    // 交叉
    if (f.ma_cross === "golden_cross") {
      lines.push("出現黃金交叉(短上穿長),常被視為偏多訊號");
    } else if (f.ma_cross === "death_cross") {
      lines.push("出現死亡交叉(短下穿長),常被視為偏空訊號");
    }

    // RSI
    const r = f.RSI;
    if (r >= 70) {
      lines.push(`RSI ≈ ${r.toFixed(1)}(偏熱),強勢中但留意回檔風險`);
    } else if (r <= 30) {
      lines.push(`RSI ≈ ${r.toFixed(1)}(偏冷),超賣中但不等同立刻反彈`);
    } else {
      lines.push(`RSI ≈ ${r.toFixed(1)}(中性區間),動能溫和`);
    }

    return lines.join(";") + "(本段為本地規則判讀,非 AI 生成)";
  }

  /* ============================================
     KDJ 線圖:K/D/J 三條線,80/20 虛線標示超買超賣門檻,
     並在線上直接標記黃金交叉/死亡交叉發生的位置(不用區塊底色,單純疊加三角形)
     ============================================ */
  function drawKdjCanvas(rows, kdjSeries) {
    const n = rows.length;
    const canvas = document.getElementById("kdjCanvas");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    const cssHeight = 150;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 48, padRight = 12, padTop = 8, padBottom = 6;
    const chartH = cssHeight - padTop - padBottom;
    const chartW = cssWidth - padLeft - padRight;

    // KDJ 的 J 值可能超過 100 或低於 0,所以座標範圍要包含實際資料,不能固定卡在 0~100
    const allVals = kdjSeries.flatMap(p => [p.k, p.d, p.j]);
    const top = Math.max(100, ...allVals) + 5;
    const bottom = Math.min(0, ...allVals) - 5;

    const slotW = chartW / n;
    const xAt = i => padLeft + i * slotW + slotW / 2;
    const yAt = v => padTop + (top - v) / (top - bottom) * chartH;

    // 80 / 20 門檻虛線
    [80, 20].forEach(level => {
      const y = yAt(level);
      ctx.strokeStyle = gridColor; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssWidth - padRight, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textColor; ctx.font = "10px monospace";
      ctx.fillText(String(level), 2, y + 3);
    });

    // K / D / J 三條線
    drawMaLine(ctx, kdjSeries.map(p => p.k), xAt, yAt, "#ffb84f");
    drawMaLine(ctx, kdjSeries.map(p => p.d), xAt, yAt, "#4fa3d6");
    drawMaLine(ctx, kdjSeries.map(p => p.j), xAt, yAt, "#d97fe8");

    // 標記黃金交叉(▲)與死亡交叉(▼)發生的位置,跟你截圖裡的箭頭標註概念一樣
    for (let i = 1; i < n; i++) {
      const prev = kdjSeries[i - 1], cur = kdjSeries[i];
      const crossedUp = prev.k <= prev.d && cur.k > cur.d;
      const crossedDown = prev.k >= prev.d && cur.k < cur.d;
      if (!crossedUp && !crossedDown) continue;

      const x = xAt(i);
      const y = yAt(cur.k);
      ctx.fillStyle = crossedUp ? "#ff5a5a" : "#4fd693";
      ctx.beginPath();
      if (crossedUp) {
        ctx.moveTo(x, y - 14); ctx.lineTo(x - 5, y - 6); ctx.lineTo(x + 5, y - 6);
      } else {
        ctx.moveTo(x, y + 14); ctx.lineTo(x - 5, y + 6); ctx.lineTo(x + 5, y + 6);
      }
      ctx.closePath(); ctx.fill();
    }

    const last = kdjSeries[kdjSeries.length - 1];
    document.getElementById("kdjLegend").innerHTML = `
      <span><span class="dot" style="background:#ffb84f;"></span>K ${last.k.toFixed(1)}</span>
      <span><span class="dot" style="background:#4fa3d6;"></span>D ${last.d.toFixed(1)}</span>
      <span><span class="dot" style="background:#d97fe8;"></span>J ${last.j.toFixed(1)}</span>
      <span style="color:var(--text-dim);">▲紅色三角=黃金交叉　▼綠色三角=死亡交叉</span>
    `;

    trendChartStates["kdjCanvas"] = { layout: { xAt, padLeft, padRight, padTop, cssWidth, cssHeight, n } };
    attachSimpleCrosshair("kdjCanvas",
      () => drawKdjCanvas(technicalChartData.rows, technicalChartData.kdjSeries),
      (i) => {
        const p = kdjSeries[i];
        return `${rows[i].date}<br><span style="color:#ffb84f;">K ${p.k.toFixed(1)}</span><br><span style="color:#4fa3d6;">D ${p.d.toFixed(1)}</span><br><span style="color:#d97fe8;">J ${p.j.toFixed(1)}</span>`;
      }
    );
  }

  /* ============================================
     MACD(12, 26, 9)計算,標準公式:
       EMA12、EMA26 → DIF = EMA12 - EMA26
       DEA = DIF 的 9 期 EMA(訊號線)
       OSC(柱狀圖)= (DIF - DEA) * 2,台股常見的畫法乘以2讓柱狀更明顯
     ============================================ */
  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const result = [];
    let prevEma = null;
    values.forEach((v, i) => {
      if (prevEma == null) {
        prevEma = v; // 第一個值直接當起始 EMA,是常見的簡化做法
      } else {
        prevEma = v * k + prevEma * (1 - k);
      }
      result.push(prevEma);
    });
    return result;
  }

  function calcMACD(rows) {
    const closes = rows.map(r => r.close);
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const dif = closes.map((_, i) => ema12[i] - ema26[i]);
    const dea = calcEMA(dif, 9);
    const osc = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif, dea, osc };
  }

  function drawMacdCanvas(rows) {
    const macd = calcMACD(rows);
    const n = rows.length;
    const dif = macd.dif, dea = macd.dea, osc = macd.osc;

    const canvas = document.getElementById("macdCanvas");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    const cssHeight = 140;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 48, padRight = 12, padTop = 8, padBottom = 6;
    const chartH = cssHeight - padTop - padBottom;
    const chartW = cssWidth - padLeft - padRight;

    const allVals = dif.concat(dea).concat(osc);
    const maxV = Math.max(...allVals), minV = Math.min(...allVals);
    const pad = (maxV - minV) * 0.1 || 0.5;
    const top = maxV + pad, bottom = minV - pad;

    const slotW = chartW / n;
    const barW = Math.max(1, slotW * 0.6);
    const xAt = i => padLeft + i * slotW + slotW / 2;
    const yAt = v => padTop + (top - v) / (top - bottom) * chartH;

    // 零軸與網格
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padLeft, yAt(0)); ctx.lineTo(cssWidth - padRight, yAt(0)); ctx.stroke();
    ctx.fillStyle = textColor; ctx.font = "10px monospace";
    ctx.fillText("0", 2, yAt(0) + 3);

    // OSC 柱狀圖:正值紅色(多方動能增強)、負值綠色(空方動能增強),對應台股慣例
    rows.forEach((r, i) => {
      const v = osc[i];
      const x = xAt(i);
      ctx.fillStyle = v >= 0 ? "#ff5a5a99" : "#4fd69399";
      const y0 = yAt(0), y1 = yAt(v);
      ctx.fillRect(x - barW / 2, Math.min(y0, y1), barW, Math.abs(y0 - y1));
    });

    // DIF、DEA 折線
    drawMaLine(ctx, dif, xAt, yAt, "#ffb84f");
    drawMaLine(ctx, dea, xAt, yAt, "#4fa3d6");

    const lastDif = dif[dif.length - 1], lastDea = dea[dea.length - 1], lastOsc = osc[osc.length - 1];
    document.getElementById("macdLegend").innerHTML = `
      <span><span class="dot" style="background:#ffb84f;"></span>DIF ${lastDif != null ? lastDif.toFixed(2) : "--"}</span>
      <span><span class="dot" style="background:#4fa3d6;"></span>DEA ${lastDea != null ? lastDea.toFixed(2) : "--"}</span>
      <span><span class="dot" style="background:${lastOsc >= 0 ? '#ff5a5a' : '#4fd693'};"></span>OSC ${lastOsc != null ? lastOsc.toFixed(2) : "--"}</span>
    `;

    trendChartStates["macdCanvas"] = { layout: { xAt, padLeft, padRight, padTop, cssWidth, cssHeight, n } };
    attachSimpleCrosshair("macdCanvas",
      () => drawMacdCanvas(technicalChartData.rows),
      (i) => `${rows[i].date}<br><span style="color:#ffb84f;">DIF ${dif[i].toFixed(2)}</span><br><span style="color:#4fa3d6;">DEA ${dea[i].toFixed(2)}</span><br><span style="color:${osc[i] >= 0 ? '#ff5a5a' : '#4fd693'};">OSC ${osc[i].toFixed(2)}</span>`
    );
  }

  /* ============================================
     K 線圖 + 均線 + 成交量,純 Canvas 手繪
     ============================================ */
  function calcMA(rows, period) {
    return rows.map((_, i) => {
      if (i < period - 1) return null;
      const slice = rows.slice(i - period + 1, i + 1);
      return slice.reduce((s, r) => s + r.close, 0) / period;
    });
  }

  function drawPriceVolumeCanvas(allRows) {
    const rows = allRows.slice(-60);
    const ma5 = calcMA(allRows, 5).slice(-60);
    const ma20 = calcMA(allRows, 20).slice(-60);
    const ma60 = calcMA(allRows, 60).slice(-60);

    const canvas = document.getElementById("priceCanvas");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    const cssHeight = 420;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 48, padRight = 12, padTop = 10;
    const priceH = 300, volumeH = 80, gap = 10;
    const chartW = cssWidth - padLeft - padRight;

    const allVals = rows.flatMap(r => [r.high, r.low]).concat(ma60.filter(v => v != null));
    const maxPrice = Math.max(...allVals);
    const minPrice = Math.min(...allVals);
    const pricePad = (maxPrice - minPrice) * 0.08 || 1;
    const priceTop = maxPrice + pricePad, priceBottom = minPrice - pricePad;
    const maxVolume = Math.max(...rows.map(r => r.volume), 1);

    const n = rows.length;
    const slotW = chartW / n;
    const candleW = Math.max(2, slotW * 0.6);

    const priceY = v => padTop + (priceTop - v) / (priceTop - priceBottom) * priceH;
    const volY = v => padTop + priceH + gap + volumeH - (v / maxVolume) * volumeH;
    const xAt = i => padLeft + i * slotW + slotW / 2;

    ctx.strokeStyle = gridColor; ctx.fillStyle = textColor;
    ctx.font = "10px monospace"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = priceBottom + (priceTop - priceBottom) * (g / 4);
      const y = priceY(v);
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssWidth - padRight, y); ctx.stroke();
      ctx.fillText(v.toFixed(1), 2, y + 3);
    }

    rows.forEach((r, i) => {
      const x = xAt(i);
      const isUp = r.close >= r.open;
      const color = isUp ? "#ff5a5a" : "#4fd693";
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, priceY(r.high)); ctx.lineTo(x, priceY(r.low)); ctx.stroke();
      const yOpen = priceY(r.open), yClose = priceY(r.close);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(1, Math.abs(yOpen - yClose));
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });

    drawMaLine(ctx, ma5, xAt, priceY, "#ffb84f");
    drawMaLine(ctx, ma20, xAt, priceY, "#4fa3d6");
    drawMaLine(ctx, ma60, xAt, priceY, "#d97fe8");

    rows.forEach((r, i) => {
      const x = xAt(i);
      const isUp = r.close >= r.open;
      ctx.fillStyle = (isUp ? "#ff5a5a" : "#4fd693") + "aa";
      const yTop = volY(r.volume);
      const yBase = padTop + priceH + gap + volumeH;
      ctx.fillRect(x - candleW / 2, yTop, candleW, yBase - yTop);
    });

    ctx.fillStyle = textColor; ctx.font = "10px monospace";
    const labelStep = Math.ceil(n / 8);
    rows.forEach((r, i) => {
      if (i % labelStep === 0) ctx.fillText(String(r.date).slice(-5), xAt(i) - 14, cssHeight - 4);
    });

    const lastMa5 = ma5[ma5.length - 1], lastMa20 = ma20[ma20.length - 1], lastMa60 = ma60[ma60.length - 1];
    document.getElementById("maLegend").innerHTML = `
      <span><span class="dot" style="background:#ffb84f;"></span>5MA ${lastMa5 ? lastMa5.toFixed(1) : "--"}</span>
      <span><span class="dot" style="background:#4fa3d6;"></span>20MA ${lastMa20 ? lastMa20.toFixed(1) : "--"}</span>
      <span><span class="dot" style="background:#d97fe8;"></span>60MA ${lastMa60 ? lastMa60.toFixed(1) : "--"}</span>
    `;

    // 記錄目前圖表的座標換算方式跟資料,給滑鼠移動的十字線功能使用
    chartState = {
      mode: "candle", rows, xAt, priceY,
      padLeft, padRight, padTop, priceH, volumeH, gap, cssWidth, cssHeight, n,
      getPoint: i => ({ label: rows[i].date, price: rows[i].close }),
    };
  }

  /* ============================================
     「分」線圖表:單純的價格折線,資料點是即時累積出來的
     ============================================ */
  function drawMaLine(ctx, series, xAt, priceY, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i), y = priceY(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
  }

  function drawMinuteChart(points) {
    if (points.length === 0) return;

    const canvas = document.getElementById("priceCanvas");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 800;
    const cssHeight = 420;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-dim").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--line").trim();

    const padLeft = 48, padRight = 12, padTop = 10, padBottom = 24;
    const chartH = cssHeight - padTop - padBottom;
    const chartW = cssWidth - padLeft - padRight;

    const prices = points.map(p => p.price);
    const maxPrice = Math.max(...prices), minPrice = Math.min(...prices);
    const pad = (maxPrice - minPrice) * 0.1 || 1;
    const top = maxPrice + pad, bottom = minPrice - pad;

    const n = points.length;
    const xAt = i => n === 1 ? padLeft + chartW / 2 : padLeft + (i / (n - 1)) * chartW;
    const priceY = v => padTop + (top - v) / (top - bottom) * chartH;

    ctx.strokeStyle = gridColor; ctx.fillStyle = textColor;
    ctx.font = "10px monospace"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = bottom + (top - bottom) * (g / 4);
      const y = priceY(v);
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(cssWidth - padRight, y); ctx.stroke();
      ctx.fillText(v.toFixed(2), 2, y + 3);
    }

    ctx.strokeStyle = "#ff8a3d"; ctx.lineWidth = 1.5; ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(i), y = priceY(p.price);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = textColor; ctx.font = "10px monospace";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    points.forEach((p, i) => {
      if (i % labelStep === 0) ctx.fillText(p.time.slice(0, 5), xAt(i) - 14, cssHeight - 6);
    });

    chartState = {
      mode: "minute", xAt, priceY,
      padLeft, padRight, padTop, cssWidth, cssHeight, n,
      getPoint: i => ({ label: points[i].time, price: points[i].price }),
    };
  }

  /* ============================================
     滑鼠移動十字線:顯示當時的價格與日期/時間
     ============================================ */
  const priceCanvas = document.getElementById("priceCanvas");
  const crosshairTip = document.getElementById("crosshairTip");

  priceCanvas.addEventListener("mousemove", e => {
    if (!chartState) return;
    const rect = priceCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    const { xAt, padLeft, cssWidth, padRight, n } = chartState;
    if (mouseX < padLeft || mouseX > cssWidth - padRight) { hideCrosshair(); return; }

    // 找出滑鼠 X 位置最接近哪一個資料點
    let closest = 0, minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const dist = Math.abs(xAt(i) - mouseX);
      if (dist < minDist) { minDist = dist; closest = i; }
    }

    redrawCrosshair(closest);
  });

  priceCanvas.addEventListener("mouseleave", hideCrosshair);

  function hideCrosshair() {
    crosshairTip.style.display = "none";
    // 移開滑鼠時,重畫一次乾淨的圖(把十字線清掉)
    if (chartState) redrawBase();
  }

  function redrawBase() {
    if (!chartState) return;
    if (chartState.mode === "candle") renderForPeriod(currentPeriod);
    else drawMinuteChart(minutePoints);
  }

  function redrawCrosshair(index) {
    redrawBase(); // 先重畫乾淨的底圖,避免疊加殘影
    if (!chartState) return;

    const ctx = priceCanvas.getContext("2d");
    const { xAt, padTop, padLeft, padRight, cssWidth, cssHeight, getPoint } = chartState;
    const x = xAt(index);
    const point = getPoint(index);

    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, cssHeight - 4); // 貫穿到底部,涵蓋價格區跟成交量區
    ctx.stroke();
    ctx.restore();

    crosshairTip.innerHTML = `${point.label}　<span class="cp">${point.price.toFixed(2)}</span>`;
    crosshairTip.style.display = "block";

    // 提示框跟著十字線的 X 座標移動,並限制在圖表範圍內,避免超出畫布邊界被裁掉
    const tipWidth = crosshairTip.offsetWidth || 120;
    let left = x - tipWidth / 2;
    left = Math.max(padLeft, Math.min(left, cssWidth - padRight - tipWidth));
    crosshairTip.style.left = left + "px";
    crosshairTip.style.top = (padTop + 6) + "px";
  }

  /* ============================================
     AI 趨勢解讀:把目前的技術指標快照送給 Worker 的 /analyze 路徑,
     Worker 再轉發給 Gemini,回傳一段文字分析
     ============================================ */
  const analyzeBtn = document.getElementById("analyzeBtn");
  const analyzeMsg = document.getElementById("analyzeMsg");
  const analyzeResult = document.getElementById("analyzeResult");

  analyzeBtn.addEventListener("click", async () => {
    if (!latestIndicators) {
      setMsgOn(analyzeMsg, "請先查詢一檔股票,並確認技術分析圖已經有資料", "err");
      return;
    }

    analyzeBtn.disabled = true;
    analyzeResult.style.display = "none";
    setMsgOn(analyzeMsg, "AI 分析中,請稍候幾秒...", "loading");

    try {
      const res = await fetch(`${getApiBase()}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(latestIndicators),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      analyzeResult.textContent = data.analysis;
      analyzeResult.style.display = "block";
      setMsgOn(analyzeMsg, "分析完成(由 Gemini 生成,僅供參考)", "ok");
    } catch (err) {
      // Gemini 呼叫失敗時(額度用完、金鑰沒設好、網路問題...),
      // 不要整個功能沒反應,改用本地規則判讀當備援,至少還能給出一段有依據的文字
      const fallback = humanizeInterpretation(latestIndicators);
      analyzeResult.textContent = fallback;
      analyzeResult.style.display = "block";
      setMsgOn(analyzeMsg, `Gemini 呼叫失敗(${err.message}),已改用本地規則判讀`, "err");
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  /* ============================================
     新聞情緒分析:抓新聞(RSS)→ 送 Gemini 批次情緒分析 → 顯示結果
     ============================================ */
  const newsKeyword = document.getElementById("newsKeyword");
  const newsFetchBtn = document.getElementById("newsFetchBtn");
  const newsMsg = document.getElementById("newsMsg");
  const newsList = document.getElementById("newsList");
  const newsSummaryBox = document.getElementById("newsSummaryBox");
  const newsSummaryText = document.getElementById("newsSummaryText");
  const newsSentimentCount = document.getElementById("newsSentimentCount");
  const POSITIVE_NEWS_WORDS = ["成長","創高","大增","增長","利多","受惠","突破","上修","擴產","簽約","合作","回升","看好","樂觀","加碼","買超","漲","飆","強勁","復甦","新高","獲利佳","題材"];
  const NEGATIVE_NEWS_WORDS = ["下滑","衰退","虧損","利空","裁員","減產","違約","調降","重挫","下跌","賣超","風險","疲弱","匯損","糾紛","查核","停工","罰款","崩跌","爆雷","示警","壓力","疲軟","衝擊"];

  newsFetchBtn.addEventListener("click", runNewsAnalysis);

  function stripHtml(raw) {
    return String(raw || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeNewsItems(items) {
    return (items || []).map(it => ({
      title: stripHtml(it.title || it.Title || ""),
      link: it.link || it.url || it.guid || "#",
      source: it.source || it.author || it.creator || "",
      pubDate: it.pubDate || it.isoDate || it.published || "",
      snippet: stripHtml(it.snippet || it.description || "")
    })).filter(it => it.title && it.link);
  }

  function parseGoogleNewsRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    return Array.from(doc.querySelectorAll("item")).slice(0, 12).map(node => ({
      title: stripHtml(node.querySelector("title")?.textContent || ""),
      link: node.querySelector("link")?.textContent || "#",
      source: node.querySelector("source")?.textContent || "Google News",
      pubDate: node.querySelector("pubDate")?.textContent || "",
      snippet: stripHtml(node.querySelector("description")?.textContent || "")
    })).filter(it => it.title && it.link);
  }

  async function fetchNewsViaWorker(keyword) {
    const res = await fetch(`${getApiBase()}/news?keyword=${encodeURIComponent(keyword)}`);
    const data = await res.json();
    if (data.error && (!data.items || !data.items.length)) throw new Error(data.error);
    return normalizeNewsItems(data.items || []);
  }

  async function fetchNewsViaGoogleRss(keyword) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword + " when:30d")}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const proxyUrls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(rssUrl)}`,
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`,
    ];
    let lastErr = null;
    for (const url of proxyUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (url.includes("rss2json")) {
          const data = await res.json();
          const items = normalizeNewsItems((data.items || []).map(it => ({
            title: it.title,
            link: it.link,
            source: it.author || "Google News",
            pubDate: it.pubDate,
            snippet: it.description
          })));
          if (items.length) return items;
        } else {
          const text = await res.text();
          const items = parseGoogleNewsRss(text);
          if (items.length) return items;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("找不到可用的新聞來源");
  }

  async function fetchNewsItems(keyword) {
    const loaders = [fetchNewsViaWorker, fetchNewsViaGoogleRss];
    const errors = [];
    for (const loader of loaders) {
      try {
        const items = await loader(keyword);
        if (items.length) return items.slice(0, 12);
      } catch (err) {
        errors.push(err.message);
      }
    }
    throw new Error(errors.filter(Boolean).join(" / ") || "找不到新聞資料");
  }

  function analyzeHeadlineLocal(text) {
    const input = `${text || ""}`;
    let score = 0;
    POSITIVE_NEWS_WORDS.forEach(w => { if (input.includes(w)) score += 0.18; });
    NEGATIVE_NEWS_WORDS.forEach(w => { if (input.includes(w)) score -= 0.18; });
    score = Math.max(-1, Math.min(1, score));
    const sentiment_label = score > 0.12 ? "positive" : score < -0.12 ? "negative" : "neutral";
    return { sentiment_label, sentiment_score: score };
  }

  function buildLocalSentimentResults(items) {
    return items.map((it, index) => ({ index, ...analyzeHeadlineLocal(`${it.title} ${it.snippet || ""}`) }));
  }

  function mergeSentimentResults(items, remoteResults) {
    const localMap = {};
    buildLocalSentimentResults(items).forEach(r => { localMap[r.index] = r; });
    const remoteMap = {};
    (remoteResults || []).forEach(r => { if (r && Number.isInteger(r.index)) remoteMap[r.index] = r; });
    return items.map((_, index) => {
      const rr = remoteMap[index];
      if (rr && rr.sentiment_label) {
        return {
          index,
          sentiment_label: rr.sentiment_label,
          sentiment_score: typeof rr.sentiment_score === "number" ? rr.sentiment_score : localMap[index].sentiment_score,
          mode: "remote"
        };
      }
      return { ...localMap[index], index, mode: "local" };
    });
  }

  async function runNewsAnalysis() {
    const keyword = newsKeyword.value.trim() || latestQuote?.n || currentCode;
    if (!keyword) {
      setMsgOn(newsMsg, "請先查詢一檔股票,或自己輸入關鍵字", "err");
      return;
    }
    newsKeyword.value = keyword;

    newsFetchBtn.disabled = true;
    newsList.innerHTML = "";
    newsSummaryBox.style.display = "none";
    setMsgOn(newsMsg, `搜尋「${keyword}」相關新聞中...`, "loading");

    try {
      const items = await fetchNewsItems(keyword);
      if (!items.length) {
        setMsgOn(newsMsg, "找不到可分析的新聞", "err");
        return;
      }

      setMsgOn(newsMsg, `找到 ${items.length} 則新聞,進行情緒分析中...`, "loading");

      let results = [];
      let modeText = "本地備援";
      try {
        const analyzeRes = await fetch(`${getApiBase()}/newsanalyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ headlines: items.map(it => it.title) }),
        });
        const analyzeData = await analyzeRes.json();
        if (analyzeData.error) throw new Error(analyzeData.error);
        results = mergeSentimentResults(items, analyzeData.results || []);
        modeText = results.some(r => r.mode === "local") ? "遠端＋本地補齊" : "遠端情緒分析";
      } catch (err) {
        results = buildLocalSentimentResults(items);
        modeText = `本地備援(${err.message || "遠端失敗"})`;
      }

      renderNewsList(items, results);
      renderNewsSummary(items, results, keyword, modeText);
      setMsgOn(newsMsg, `共 ${items.length} 則新聞,已完成情緒分析；目前使用 ${modeText}`, "ok");
    } catch (err) {
      setMsgOn(newsMsg, "新聞分析流程失敗:" + err.message, "err");
    } finally {
      newsFetchBtn.disabled = false;
    }
  }

  function renderNewsList(items, results) {
    const resultMap = {};
    results.forEach(r => { resultMap[r.index] = r; });
    const labelText = { positive: "偏正面", negative: "偏負面", neutral: "中性" };

    newsList.innerHTML = items.map((it, i) => {
      const r = resultMap[i];
      const label = r?.sentiment_label;
      const badge = label
        ? `<span class="sentiment-badge ${label}">${labelText[label] || label}${r.sentiment_score != null ? " " + Number(r.sentiment_score).toFixed(2) : ""}</span>`
        : `<span class="sentiment-badge neutral">未分析</span>`;

      return `
        <div class="news-item">
          <a href="${it.link}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
          <div class="news-meta">
            ${badge}
            <span>${escapeHtml(it.source || "")}</span>
            <span>${it.pubDate ? new Date(it.pubDate).toLocaleString("zh-TW") : ""}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderNewsSummary(items, results, keyword, modeText = "") {
    const valid = results.filter(r => r.sentiment_label != null);
    if (valid.length === 0) {
      newsSummaryBox.style.display = "none";
      return;
    }

    const counts = { positive: 0, negative: 0, neutral: 0 };
    let sumScore = 0;
    valid.forEach(r => {
      counts[r.sentiment_label] = (counts[r.sentiment_label] || 0) + 1;
      sumScore += r.sentiment_score || 0;
    });
    const avgScore = sumScore / valid.length;
    const overall = avgScore > 0.15 ? "偏正面" : avgScore < -0.15 ? "偏負面" : "中性/分歧";

    newsSummaryText.textContent =
      `「${keyword}」近期共 ${valid.length} 則新聞完成情緒分析,平均情緒分數 ${avgScore.toFixed(2)}` +
      `(範圍 -1 極負面 ~ +1 極正面),整體市場情緒判讀為「${overall}」。` +
      `其中正面 ${counts.positive} 則、負面 ${counts.negative} 則、中性 ${counts.neutral} 則。` +
      `${modeText ? `分析模式：${modeText}。` : ""}` +
      `此結果僅根據新聞標題與摘要文字判讀,不構成投資建議,仍建議點進原文確認完整脈絡。`;

    newsSentimentCount.innerHTML = `
      <span><span class="dot" style="background:#ff5a5a;"></span>正面 ${counts.positive}</span>
      <span><span class="dot" style="background:#4fd693;"></span>負面 ${counts.negative}</span>
      <span><span class="dot" style="background:var(--text-dim);"></span>中性 ${counts.neutral}</span>
    `;
    newsSummaryBox.style.display = "block";
  }

  /* ============================================
     綜合分析:技術指標(latestIndicators) + 新聞標題,一次送給 Gemini,
     產生策略結論卡片與 AI 投資報告卡片
     ============================================ */
  const comboRunBtn = document.getElementById("comboRunBtn");
  const comboMsg = document.getElementById("comboMsg");

  comboRunBtn.addEventListener("click", runComprehensiveAnalysis);

  async function runComprehensiveAnalysis() {
    if (!currentCode || !latestQuote) {
      setMsgOn(comboMsg, "請先在上方查詢一檔股票", "err");
      return;
    }
    if (!latestIndicators) {
      setMsgOn(comboMsg, "技術指標還沒算好,請先切到「技術分析」分頁看一下圖表,再回來產生綜合分析", "err");
      return;
    }

    comboRunBtn.disabled = true;
    document.getElementById("comboStrategyCard").style.display = "none";
    document.getElementById("comboReportCard").style.display = "none";
    setMsgOn(comboMsg, "抓取相關新聞中...", "loading");

    try {
      // 先抓新聞標題(跟「新聞」分頁共用同一個 /news 路徑,關鍵字用股票名稱)
      const keyword = latestQuote.n || currentCode;
      const newsRes = await fetch(`${getApiBase()}/news?keyword=${encodeURIComponent(keyword)}`);
      const newsData = await newsRes.json();
      const headlines = (newsData.items || []).map(it => it.title);

      setMsgOn(comboMsg, "AI 分析中,請稍候幾秒...", "loading");

      const res = await fetch(`${getApiBase()}/comprehensive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...latestIndicators, headlines }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      renderComboResult(data, headlines.length);
      setMsgOn(comboMsg, `分析完成(由 Gemini 生成,根據 ${headlines.length} 則新聞與目前技術指標,僅供參考)`, "ok");
    } catch (err) {
      setMsgOn(comboMsg, "綜合分析失敗:" + err.message, "err");
    } finally {
      comboRunBtn.disabled = false;
    }
  }

  function renderComboResult(data, newsCount) {
    const biasClass = data.trend_bias === "偏多" ? "bull" : data.trend_bias === "偏空" ? "bear" : "side";

    // 卡片一:策略結論
    document.getElementById("comboTrendBadge").innerHTML =
      `<span class="trend-badge ${biasClass}">趨勢判讀:${data.trend_bias || "--"}</span>`;
    document.getElementById("comboStrategyText").textContent = data.strategy_conclusion || "--";
    document.getElementById("comboStrategyCard").style.display = "block";

    // 卡片二:AI 投資報告
    const price = parseFloat(latestQuote.z);
    const prevClose = parseFloat(latestQuote.y);
    const change = !isNaN(price) && !isNaN(prevClose) ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose * 100) : null;
    const isEtf = /^00\d{2,4}$/.test(currentCode);

    document.getElementById("comboBasicInfo").innerHTML =
      `代號:${currentCode}${isEtf ? ' <span class="etf-badge">ETF</span>' : ""}　名稱:${latestQuote.n || "--"}　` +
      `目前股價:${!isNaN(price) ? price.toFixed(2) : "--"}　` +
      `漲跌:${change != null ? (change > 0 ? "+" : "") + change.toFixed(2) : "--"}` +
      `(${changePct != null ? (changePct > 0 ? "+" : "") + changePct.toFixed(2) + "%" : "--"})` +
      `　相關新聞:${newsCount} 則`;

    document.getElementById("comboTechNote").textContent = data.technical_note || "--";
    document.getElementById("comboNewsSummary").textContent = data.news_summary || "--";
    document.getElementById("comboAiAssess").innerHTML =
      `<span class="trend-badge ${biasClass}" style="font-size:13px; padding:4px 12px;">${data.trend_bias || "--"}</span>　${data.strategy_conclusion || "--"}`;

    document.getElementById("comboReportCard").style.display = "block";
  }

  /* ============================================
     排行榜 / 比較 / 收藏輔助
     ============================================ */
  /* 把 fetch + JSON 解析包在一起,若後端回的不是 JSON(例 520 HTML 錯誤頁),給出友善訊息而不是拋 SyntaxError */
  async function fetchJSON(url, opts) {
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { throw new Error(`網路錯誤:${e.message || e}`); }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    if (!ct.includes("json")) {
      throw new Error(`API 回應非 JSON (HTTP ${res.status}, type=${ct || "unknown"}) - 可能後端暫時不可用,稍候重試`);
    }
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`API 回應解析失敗:${e.message}`); }
  }

  async function fetchCachedList(key, url) {
    if (marketCache[key]) return marketCache[key];
    try {
      const data = await fetchJSON(url);
      marketCache[key] = Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn(`fetchCachedList(${key}) failed:`, err.message);
      marketCache[key] = [];
    }
    return marketCache[key];
  }

  function parseYearValue(raw) {
    if (raw == null) return null;
    const m = String(raw).match(/(\d{3,4})/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    return y < 1911 ? y + 1911 : y;
  }

  function compareDesc(a, b) { return String(b).localeCompare(String(a)); }

  function pickField(obj, candidates) {
    for (const key of candidates) if (obj[key] != null) return obj[key];
    return null;
  }

  function buildRevenueTimeline(rows) {
    const sorted = [...rows].sort((a, b) => (b.revenue_year * 100 + b.revenue_month) - (a.revenue_year * 100 + a.revenue_month));
    const byKey = {};
    sorted.forEach(r => { byKey[`${r.revenue_year}-${r.revenue_month}`] = r; });
    return sorted.map(r => {
      const lastMonthKey = r.revenue_month === 1 ? `${r.revenue_year - 1}-12` : `${r.revenue_year}-${r.revenue_month - 1}`;
      const lastYearKey = `${r.revenue_year - 1}-${r.revenue_month}`;
      const lastMonth = byKey[lastMonthKey]?.revenue;
      const lastYear = byKey[lastYearKey]?.revenue;
      const cumThis = sorted.filter(x => x.revenue_year === r.revenue_year && x.revenue_month <= r.revenue_month).reduce((s, x) => s + (x.revenue || 0), 0);
      const cumLast = sorted.filter(x => x.revenue_year === r.revenue_year - 1 && x.revenue_month <= r.revenue_month).reduce((s, x) => s + (x.revenue || 0), 0);
      return {
        label: `${r.revenue_year}/${String(r.revenue_month).padStart(2, "0")}`,
        year: String(r.revenue_year),
        revenue: safeNum(r.revenue),
        mom: lastMonth ? ((r.revenue - lastMonth) / lastMonth * 100) : null,
        yoy: lastYear ? ((r.revenue - lastYear) / lastYear * 100) : null,
        cumRevenue: cumThis,
        cumYoy: cumLast ? ((cumThis - cumLast) / cumLast * 100) : null,
      };
    });
  }

  function buildAnnualProfitMap(rows) {
    const byQuarter = {};
    rows.forEach(r => {
      if (!byQuarter[r.date]) byQuarter[r.date] = { date: r.date };
      byQuarter[r.date][r.type] = r.value;
    });
    const quarters = Object.values(byQuarter).map(q => ({
      year: q.date.slice(0, 4),
      revenue: pickField(q, ["Revenue", "TotalRevenue", "OperatingRevenue", "利息淨收益"]),
      grossProfit: pickField(q, ["GrossProfit", "GrossProfitLoss"]),
      operatingIncome: pickField(q, ["OperatingIncome", "OperatingIncomeLoss"]),
      netIncome: pickField(q, ["IncomeAfterTaxes", "IncomeAfterTaxesFromContinuingOperations", "ProfitLoss"]),
      eps: pickField(q, ["EPS", "EarningsPerShare", "EarningsPerShareBasic"]),
    })).filter(q => q.revenue != null || q.netIncome != null);
    const byYear = {};
    quarters.forEach(q => {
      if (!byYear[q.year]) byYear[q.year] = { revenue: 0, grossProfit: 0, operatingIncome: 0, netIncome: 0, eps: 0, quarterCount: 0 };
      byYear[q.year].revenue += q.revenue || 0;
      byYear[q.year].grossProfit += q.grossProfit || 0;
      byYear[q.year].operatingIncome += q.operatingIncome || 0;
      byYear[q.year].netIncome += q.netIncome || 0;
      byYear[q.year].eps += q.eps || 0;
      byYear[q.year].quarterCount += 1;
    });
    return byYear;
  }

  function buildAnnualBalanceMap(rows) {
    const byQuarter = {};
    rows.forEach(r => {
      if (!byQuarter[r.date]) byQuarter[r.date] = { date: r.date };
      byQuarter[r.date][r.type] = r.value;
    });
    const latestByYear = {};
    Object.values(byQuarter).forEach(q => {
      const year = q.date.slice(0, 4);
      if (!latestByYear[year] || q.date > latestByYear[year].date) {
        latestByYear[year] = {
          date: q.date,
          totalAssets: pickField(q, ["TotalAssets"]),
          equity: pickField(q, ["Equity", "EquityAttributableToOwnersOfParent"]),
          shares: pickField(q, ["OrdinarySharesNumber", "CommonStockSharesOutstanding"]),
        };
      }
    });
    return latestByYear;
  }

  function buildAnnualCashflowMap(rows) {
    const byQuarter = {};
    rows.forEach(r => {
      if (!byQuarter[r.date]) byQuarter[r.date] = { date: r.date };
      byQuarter[r.date][r.type] = r.value;
    });
    const latestByYear = {};
    Object.values(byQuarter).forEach(q => {
      const year = q.date.slice(0, 4);
      if (!latestByYear[year] || q.date > latestByYear[year].date) {
        latestByYear[year] = {
          date: q.date,
          operatingCf: pickField(q, ["CashFlowsFromOperatingActivities", "NetCashInflowFromOperatingActivities"]),
          capex: pickField(q, ["PropertyAndPlantAndEquipment"]),
        };
      }
    });
    return latestByYear;
  }

  function buildAnnualDividendMap(rows) {
    const map = {};
    rows.forEach(r => {
      const year = parseYearValue(r.year);
      if (!year) return;
      if (!map[year]) map[year] = { cash: 0, stock: 0 };
      map[year].cash += (safeNum(r.CashEarningsDistribution) || 0) + (safeNum(r.CashStatutorySurplus) || 0);
      map[year].stock += (safeNum(r.StockEarningsDistribution) || 0) + (safeNum(r.StockStatutorySurplus) || 0);
    });
    return map;
  }

  function buildCompareBundle({ item, quote, ratio, snapshot, profile, historyRows, revenueRows, fsRows, bsRows, cfRows, dividendRows }) {
    const revenueTimeline = buildRevenueTimeline(revenueRows || []);
    const annualProfit = buildAnnualProfitMap(fsRows || []);
    const annualBalance = buildAnnualBalanceMap(bsRows || []);
    const annualCash = buildAnnualCashflowMap(cfRows || []);
    const annualDividend = buildAnnualDividendMap(dividendRows || []);
    const years = Array.from(new Set([
      ...Object.keys(annualProfit),
      ...Object.keys(annualBalance),
      ...Object.keys(annualCash),
      ...Object.keys(annualDividend).map(String)
    ])).sort(compareDesc);
    const annualMap = {};
    const capital = safeNum(profile?.["實收資本額"]);
    years.forEach(y => {
      const profit = annualProfit[y] || {};
      const balance = annualBalance[y] || {};
      const cash = annualCash[y] || {};
      const dividend = annualDividend[y] || {};
      const bps = balance.equity != null && balance.shares ? balance.equity / balance.shares : null;
      const roe = profit.netIncome != null && balance.equity ? (profit.netIncome / balance.equity * 100) : null;
      const grossMargin = profit.revenue ? (profit.grossProfit / profit.revenue * 100) : null;
      const opMargin = profit.revenue ? (profit.operatingIncome / profit.revenue * 100) : null;
      const assetSharePct = balance.equity != null && balance.totalAssets ? (balance.equity / balance.totalAssets * 100) : null;
      const fcf = cash.operatingCf != null ? cash.operatingCf - Math.abs(cash.capex || 0) : null;
      annualMap[y] = {
        revenue: profit.revenue,
        eps: profit.eps,
        dividend: dividend.cash,
        bvps: bps,
        capital,
        roe,
        grossMargin,
        opMargin,
        assetSharePct,
        fcf,
      };
    });
    const monthMap = {};
    revenueTimeline.forEach(r => { monthMap[r.label] = r; });
    const monthList = revenueTimeline.map(r => r.label);
    const latestYear = years[0];
    const latestMonth = monthList[0];
    const price = safeNum(quote?.z) ?? safeNum(snapshot?.ClosingPrice);
    const prevClose = safeNum(quote?.y);
    const pct = price != null && prevClose ? ((price - prevClose) / prevClose * 100) : (snapshot ? (() => {
      const c = safeNum(snapshot.ClosingPrice); const ch = safeNum(snapshot.Change); const prev = c != null && ch != null ? c - ch : null; return prev ? ch / prev * 100 : null;
    })() : null);
    return {
      code: item.code,
      name: quote?.n || snapshot?.Name || item.name || item.code,
      ratio,
      quote,
      snapshot,
      profile,
      historyRows,
      years,
      monthList,
      annualMap,
      monthMap,
      latest: {
        price,
        pct,
        eps: latestYear ? annualMap[latestYear]?.eps : null,
        pe: safeNum(ratio?.PEratio),
        dividend: latestYear ? annualMap[latestYear]?.dividend : null,
        yieldPct: safeNum(ratio?.DividendYield),
        bvps: latestYear ? annualMap[latestYear]?.bvps : null,
        pb: safeNum(ratio?.PBratio),
        cumRevenue: latestMonth ? monthMap[latestMonth]?.cumRevenue : null,
        capital,
        roe: latestYear ? annualMap[latestYear]?.roe : null,
        grossMargin: latestYear ? annualMap[latestYear]?.grossMargin : null,
        opMargin: latestYear ? annualMap[latestYear]?.opMargin : null,
        assetSharePct: latestYear ? annualMap[latestYear]?.assetSharePct : null,
        fcf: latestYear ? annualMap[latestYear]?.fcf : null,
        lots: safeNum(quote?.v),
      }
    };
  }

  const rankTabs = document.getElementById("rankTabs");
  const rankLimitSelect = document.getElementById("rankLimitSelect");
  const rankScopeSelect = document.getElementById("rankScopeSelect");
  const rankDividendYearSelect = document.getElementById("rankDividendYearSelect");
  const rankSummary = document.getElementById("rankSummary");
  const rankState = { loaded: false, snapshot: [], ratios: [], revenue: [], dividend: [], otcQuotes: [], otcRatios: [], mode: "yield", advMetrics: {}, renderSeq: 0, usedFallback: {} };

  rankTabs.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      rankState.mode = btn.dataset.rank;
      rankTabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
      renderRanking();
    });
  });
  rankLimitSelect.addEventListener("change", renderRanking);
  rankScopeSelect.addEventListener("change", renderRanking);
  rankDividendYearSelect.addEventListener("change", renderRanking);

  /* TWSE OpenAPI 直連在瀏覽器端沒有 CORS header 會被擋掉 → 改成「直連失敗自動改用內嵌備援資料」,
     保證排行榜的股利 / 營收分頁永遠有資料可顯示 */
  async function fetchRankList(key, url, embedded) {
    if (marketCache[key]) return marketCache[key];
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      if (Array.isArray(data) && data.length) { marketCache[key] = data; return data; }
      throw new Error("empty");
    } catch (err) {
      marketCache[key] = embedded || [];
      rankState.usedFallback[key] = true;
      return marketCache[key];
    }
  }

  document.getElementById("rankExportBtn")?.addEventListener("click", () => {
    const rows = document.querySelectorAll("#rankBody tr[data-code]");
    if (!rows.length) { setMsgOn(document.getElementById("rankMsg"), "目前沒有可匯出的資料列", "err"); return; }
    const heads = Array.from(document.querySelectorAll("#rankHead th")).map(th => th.textContent.trim());
    const csv = [heads.join(",")].concat(Array.from(rows).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => {
        const txt = td.textContent.trim().replace(/,/g, "");
        return /[^\d\-+.]/.test(txt) ? `"${txt}"` : txt;
      }).join(",")
    )).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `台股排行榜_${rankState.mode}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMsgOn(document.getElementById("rankMsg"), "已匯出 CSV", "ok");
  });

  async function loadRanking() {
    const msgEl = document.getElementById("rankMsg");
    setMsgOn(msgEl, "載入排行榜資料中...", "loading");
    try {
      const fallback = await loadRankFallback();
      const [snapshot, ratios, revenue, dividend, otcQuotes, otcRatios] = await Promise.all([
        fetchCachedList("snapshot", `${getApiBase()}/snapshot`),
        fetchCachedList("ratios", `${getApiBase()}/ratios`),
        fetchRankList("revenue", `${TWSE_OPENAPI}/t187ap05_L`, fallback.revenue),
        fetchRankList("dividend", `${TWSE_OPENAPI}/t187ap45_L`, fallback.dividend),
        fetchCachedList("tpexQuotes", `${TPEX_OPENAPI}/tpex_mainboard_quotes`).catch(() => []),
        fetchCachedList("tpexRatios", `${TPEX_OPENAPI}/tpex_mainboard_peratio_analysis`).catch(() => []),
      ]);
      rankState.snapshot = snapshot || [];
      rankState.ratios = ratios || [];
      rankState.revenue = revenue || [];
      rankState.dividend = dividend || [];
      rankState.otcQuotes = otcQuotes || [];
      rankState.otcRatios = otcRatios || [];
      rankState.loaded = true;
      const years = Array.from(new Set(rankState.dividend.map(r => String(r["股利年度"] || "").trim()).filter(Boolean))).sort(compareDesc);
      rankDividendYearSelect.innerHTML = '<option value="all">全部年度</option>' + years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
      renderRanking();
    } catch (err) {
      setMsgOn(msgEl, "排行榜載入失敗:" + err.message, "err");
    }
  }

  function buildDividendMapForRank() {
    const selectedYear = rankDividendYearSelect.value;
    const map = {};
    rankState.dividend.forEach(r => {
      const year = String(r["股利年度"] || "").trim();
      if (selectedYear !== "all" && year !== selectedYear) return;
      const code = String(r["公司代號"] || "").trim();
      if (!code) return;
      if (!map[code]) map[code] = { cash: 0, year };
      map[code].cash += (safeNum(r["股東配發-盈餘分配之現金股利(元/股)"]) || 0)
        + (safeNum(r["股東配發-法定盈餘公積發放之現金(元/股)"]) || 0)
        + (safeNum(r["股東配發-資本公積發放之現金(元/股)"]) || 0);
      map[code].year = year;
    });
    return map;
  }

  function buildTwseRankRows() {
    const ratioMap = {};
    rankState.ratios.forEach(r => { ratioMap[String(r.Code)] = r; });
    const revenueMap = {};
    rankState.revenue.forEach(r => {
      const code = String(r["公司代號"] || "").trim();
      if (!code) return;
      revenueMap[code] = {
        month: String(r["資料年月"] || ""),
        revenue: safeNum(r["營業收入-當月營收"]),
        yoy: safeNum(r["營業收入-去年同月增減(%)"]),
        cumRevenue: safeNum(r["累計營業收入-當月累計營收"]),
      };
    });
    const dividendMap = buildDividendMapForRank();
    return rankState.snapshot.map(r => {
      const code = String(r.Code);
      const close = safeNum(r.ClosingPrice);
      const change = safeNum(r.Change) || 0;
      const prevClose = close != null ? close - change : null;
      const pct = prevClose ? change / prevClose * 100 : null;
      const value = safeNum(r.TradeValue) || 0;
      const volume = safeNum(r.TradeVolume) || 0;
      const ratio = ratioMap[code] || {};
      const pe = safeNum(ratio.PEratio);
      const yieldPct = safeNum(ratio.DividendYield);
      const pb = safeNum(ratio.PBratio);
      const eps = close != null && pe ? close / pe : null;
      const div = dividendMap[code] || null;
      const rev = revenueMap[code] || null;
      const score = (yieldPct ? Math.min(yieldPct, 10) * 4 : 0)
        + (pe && pe > 0 ? Math.max(0, 25 - pe) * 0.8 : 0)
        + (rev?.yoy ? Math.max(-20, Math.min(rev.yoy, 50)) * 0.5 : 0)
        + (div?.cash ? Math.min(div.cash, 12) * 2 : 0)
        + (pb && pb > 0 && pb < 2 ? 6 : 0);
      return { market: "listed", marketLabel: "上市", code, name: r.Name, close, change, pct, value, volume, pe, yieldPct, pb, eps, dividend: div?.cash || null, dividendYear: div?.year || "--", revenue: rev?.revenue || null, revenueYoy: rev?.yoy || null, cumRevenue: rev?.cumRevenue || null, revenueMonth: rev?.month || "--", score };
    }).filter(r => r.close > 0);
  }

  function buildTpexRankRows() {
    const ratioMap = {};
    rankState.otcRatios.forEach(r => { ratioMap[String(r.SecuritiesCompanyCode)] = r; });
    return rankState.otcQuotes.map(r => {
      const code = String(r.SecuritiesCompanyCode);
      const ratio = ratioMap[code] || {};
      const close = safeNum(r.Close);
      const change = safeNum(r.Change) || 0;
      const prevClose = close != null ? close - change : null;
      const pct = prevClose ? change / prevClose * 100 : null;
      const value = safeNum(r.TransactionAmount) || 0;
      const volume = safeNum(r.TradingShares) || 0;
      const pe = safeNum(ratio.PriceEarningRatio);
      const yieldPct = safeNum(ratio.YieldRatio);
      const pb = safeNum(ratio.PriceBookRatio);
      const eps = close != null && pe ? close / pe : null;
      const dividend = safeNum(ratio.DividendPerShare);
      const score = (yieldPct ? Math.min(yieldPct, 10) * 4 : 0)
        + (pe && pe > 0 ? Math.max(0, 25 - pe) * 0.8 : 0)
        + (dividend ? Math.min(dividend, 12) * 2 : 0)
        + (pb && pb > 0 && pb < 2 ? 6 : 0);
      return { market: "otc", marketLabel: "上櫃", code, name: r.CompanyName, close, change, pct, value, volume, pe, yieldPct, pb, eps, dividend: dividend || null, dividendYear: "--", revenue: null, revenueYoy: null, cumRevenue: null, revenueMonth: "--", score };
    }).filter(r => r.close > 0);
  }

  function buildAdvancedMetricFromFsBs(fsRows, bsRows) {
    const profitMap = buildAnnualProfitMap(fsRows || []);
    const balanceMap = buildAnnualBalanceMap(bsRows || []);
    const years = Array.from(new Set([...Object.keys(profitMap), ...Object.keys(balanceMap)])).sort(compareDesc);
    for (const y of years) {
      const profit = profitMap[y] || {};
      const balance = balanceMap[y] || {};
      const grossMargin = profit.revenue ? (profit.grossProfit / profit.revenue * 100) : null;
      const assetSharePct = balance.equity != null && balance.totalAssets ? (balance.equity / balance.totalAssets * 100) : null;
      if (grossMargin != null || assetSharePct != null) {
        return { year: y, grossMargin, assetSharePct };
      }
    }
    return { year: "--", grossMargin: null, assetSharePct: null };
  }

  async function getRankAdvancedMetric(code) {
    if (!code) return { year: "--", grossMargin: null, assetSharePct: null };
    const cached = rankState.advMetrics[code];
    if (cached) return cached instanceof Promise ? cached : cached;
    const promise = Promise.all([
      fetchFinMind("TaiwanStockFinancialStatements", code, 8).catch(() => []),
      fetchFinMind("TaiwanStockBalanceSheet", code, 8).catch(() => []),
    ]).then(([fsRows, bsRows]) => {
      const result = buildAdvancedMetricFromFsBs(fsRows, bsRows);
      rankState.advMetrics[code] = result;
      return result;
    }).catch(() => {
      const fallback = { year: "--", grossMargin: null, assetSharePct: null };
      rankState.advMetrics[code] = fallback;
      return fallback;
    });
    rankState.advMetrics[code] = promise;
    return promise;
  }

  async function ensureRankingAdvancedMetrics(rows) {
    const uniqueCodes = Array.from(new Set((rows || []).map(r => r.code).filter(Boolean)));
    const metrics = await Promise.all(uniqueCodes.map(async code => [code, await getRankAdvancedMetric(code)]));
    const metricMap = {};
    metrics.forEach(([code, value]) => { metricMap[code] = value; });
    return metricMap;
  }

  async function renderRanking() {
    if (!rankState.loaded) return;
    const msgEl = document.getElementById("rankMsg");
    const seq = ++rankState.renderSeq;
    const scope = rankScopeSelect.value;
    const allRows = [
      ...(scope !== "otc" ? buildTwseRankRows() : []),
      ...(scope !== "listed" ? buildTpexRankRows() : [])
    ];

    let sorted = [];
    if (rankState.mode === "yield") sorted = allRows.filter(r => r.yieldPct != null).sort((a, b) => b.yieldPct - a.yieldPct);
    else if (rankState.mode === "eps") sorted = allRows.filter(r => r.eps != null && r.eps > 0).sort((a, b) => b.eps - a.eps);
    else if (rankState.mode === "pe") sorted = allRows.filter(r => r.pe != null && r.pe > 0).sort((a, b) => a.pe - b.pe);
    else if (rankState.mode === "dividend") sorted = allRows.filter(r => r.dividend != null && r.dividend > 0).sort((a, b) => b.dividend - a.dividend);
    else if (rankState.mode === "revenue") sorted = allRows.filter(r => r.revenue != null && r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
    else sorted = allRows.filter(r => r.score > 0).sort((a, b) => b.score - a.score);

    const limit = parseInt(rankLimitSelect.value, 10) || 30;
    const top = sorted.slice(0, limit);
    setMsgOn(msgEl, `共 ${allRows.length} 檔，顯示前 ${top.length} 名；補抓財報指標中...`, top.length ? "loading" : "err");
    const advMetricMap = await ensureRankingAdvancedMetrics(top);
    if (seq !== rankState.renderSeq) return;
    let head = `<tr><th>#</th><th>市場</th><th>代號</th><th>名稱</th><th>收盤價</th>`;
    if (rankState.mode === "yield") head += `<th>殖利率%</th><th>本益比</th><th>股價淨值比</th>`;
    else if (rankState.mode === "eps") head += `<th>EPS 推估</th><th>本益比</th><th>殖利率%</th>`;
    else if (rankState.mode === "pe") head += `<th>本益比</th><th>EPS 推估</th><th>殖利率%</th>`;
    else if (rankState.mode === "dividend") head += `<th>現金股利(元/股)</th><th>股利年度</th><th>殖利率%</th>`;
    else if (rankState.mode === "revenue") head += `<th>資料年月</th><th>單月營收(億)</th><th>年增%</th>`;
    else head += `<th>綜合分數</th><th>殖利率%</th><th>營收年增%</th>`;
    head += `<th>毛利率%</th><th>權益占總資產%</th></tr>`;
    document.getElementById("rankHead").innerHTML = head;

    document.getElementById("rankBody").innerHTML = top.map((r, i) => {
      const badge = i < 3 ? `<span class="rank-badge top">${i + 1}</span>` : `<span class="rank-badge">${i + 1}</span>`;
      let extra = "";
      const adv = advMetricMap[r.code] || {};
      if (rankState.mode === "yield") extra = `<td>${formatMaybe(r.yieldPct, 2)}</td><td>${formatMaybe(r.pe, 2)}</td><td>${formatMaybe(r.pb, 2)}</td>`;
      else if (rankState.mode === "eps") extra = `<td>${formatMaybe(r.eps, 2)}</td><td>${formatMaybe(r.pe, 2)}</td><td>${formatMaybe(r.yieldPct, 2)}</td>`;
      else if (rankState.mode === "pe") extra = `<td>${formatMaybe(r.pe, 2)}</td><td>${formatMaybe(r.eps, 2)}</td><td>${formatMaybe(r.yieldPct, 2)}</td>`;
      else if (rankState.mode === "dividend") extra = `<td>${formatMaybe(r.dividend, 2)}</td><td>${escapeHtml(r.dividendYear)}</td><td>${formatMaybe(r.yieldPct, 2)}</td>`;
      else if (rankState.mode === "revenue") extra = `<td>${escapeHtml(r.revenueMonth)}</td><td>${formatMaybe(r.revenue != null ? r.revenue / 1e8 : null, 2)}</td><td class="${signClass(r.revenueYoy)}">${formatSignedPct(r.revenueYoy, 1)}</td>`;
      else extra = `<td>${formatMaybe(r.score, 1)}</td><td>${formatMaybe(r.yieldPct, 2)}</td><td class="${signClass(r.revenueYoy)}">${formatSignedPct(r.revenueYoy, 1)}</td>`;
      return `<tr data-code="${escapeHtml(r.code)}" data-market="${escapeHtml(r.market)}"><td>${badge}</td><td>${escapeHtml(r.marketLabel)}</td><td>${escapeHtml(r.code)}</td><td class="cmp-name">${escapeHtml(r.name)}</td><td>${formatMaybe(r.close, 2)}</td>${extra}<td>${formatMaybe(adv.grossMargin, 2)}</td><td>${formatMaybe(adv.assetSharePct, 2)}</td></tr>`;
    }).join("");

    document.querySelectorAll("#rankBody tr[data-code]").forEach(tr => {
      tr.addEventListener("click", () => jumpToStock(tr.dataset.code));
    });

    const scopeText = scope === "listed" ? "上市" : scope === "otc" ? "上櫃" : "上市＋上櫃";
    const notes = [];
    if (rankState.mode === "revenue" && scope !== "listed") notes.push("營收排行目前以上市公開月營收資料為主");
    if (rankState.mode === "dividend" && scope === "otc") notes.push("上櫃股利以櫃買中心每股股利欄位顯示，未分年度拆解");
    if (rankState.mode === "recommend") notes.push("推薦分數綜合殖利率、本益比、營收年增與現金股利，僅供篩選參考");
    if (rankState.usedFallback?.revenue) notes.push("營收排行資料來自內嵌備援快照(2026/08 出表)");
    if (rankState.usedFallback?.dividend) notes.push("股利排行資料來自內嵌備援快照(2026/08 出表)");
    rankSummary.textContent = `${scopeText}視圖。${notes.join("；") || "點列可直接跳到完整分析頁。"} 毛利率與權益占總資產%採最新可得財報年度。`;
    setMsgOn(msgEl, `共 ${allRows.length} 檔，顯示前 ${top.length} 名`, top.length ? "ok" : "err");
  }

  const cmpInput = document.getElementById("cmpInput");
  const cmpAddBtn = document.getElementById("cmpAddBtn");
  const cmpGoBtn = document.getElementById("cmpGoBtn");
  const cmpClearBtn = document.getElementById("cmpClearBtn");
  const cmpChips = document.getElementById("cmpChips");
  const cmpMsg = document.getElementById("cmpMsg");
  const cmpResult = document.getElementById("cmpResult");
  const cmpModeSelect = document.getElementById("cmpModeSelect");
  const cmpYearSelect = document.getElementById("cmpYearSelect");
  const cmpMonthSelect = document.getElementById("cmpMonthSelect");
  const cmpYearWrap = document.getElementById("cmpYearWrap");
  const cmpMonthWrap = document.getElementById("cmpMonthWrap");
  const cmpFieldPicker = document.getElementById("cmpFieldPicker");
  const cmpTableTitle = document.getElementById("cmpTableTitle");
  const compareList = [];
  const compareState = { bundles: [] };
  const CMP_COLORS = ["#ff8a3d", "#4fa3d6", "#d97fe8", "#4fd693"];
  const MAX_COMPARE = 4;
  const CMP_FIELDS = {
    latest: [
      { key: "price", label: "股價", fmt: v => formatMaybe(v, 2) },
      { key: "pct", label: "漲跌幅%", fmt: v => formatSignedPct(v, 2), cls: signClass },
      { key: "eps", label: "EPS", fmt: v => formatMaybe(v, 2) },
      { key: "pe", label: "本益比", fmt: v => formatMaybe(v, 2) },
      { key: "dividend", label: "股利", fmt: v => formatMaybe(v, 2) },
      { key: "yieldPct", label: "殖利率%", fmt: v => formatMaybe(v, 2) },
      { key: "bvps", label: "BVPS", fmt: v => formatMaybe(v, 2) },
      { key: "pb", label: "淨值比", fmt: v => formatMaybe(v, 2) },
      { key: "cumRevenue", label: "累計營收(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "capital", label: "股本(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "roe", label: "ROE%", fmt: v => formatMaybe(v, 2) },
      { key: "grossMargin", label: "毛利率%", fmt: v => formatMaybe(v, 2) },
      { key: "opMargin", label: "營業利率%", fmt: v => formatMaybe(v, 2) },
      { key: "assetSharePct", label: "權益占總資產%", fmt: v => formatMaybe(v, 2) },
      { key: "fcf", label: "自由現金流(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "lots", label: "成交張數", fmt: v => v == null ? "--" : Math.round(v).toLocaleString() },
    ],
    annual: [
      { key: "revenue", label: "營收(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "eps", label: "EPS", fmt: v => formatMaybe(v, 2) },
      { key: "dividend", label: "股利", fmt: v => formatMaybe(v, 2) },
      { key: "bvps", label: "BVPS", fmt: v => formatMaybe(v, 2) },
      { key: "capital", label: "股本(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "roe", label: "ROE%", fmt: v => formatMaybe(v, 2) },
      { key: "grossMargin", label: "毛利率%", fmt: v => formatMaybe(v, 2) },
      { key: "opMargin", label: "營業利率%", fmt: v => formatMaybe(v, 2) },
      { key: "assetSharePct", label: "權益占總資產%", fmt: v => formatMaybe(v, 2) },
      { key: "fcf", label: "自由現金流(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
    ],
    monthly: [
      { key: "revenue", label: "單月營收(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "mom", label: "月增%", fmt: v => formatSignedPct(v, 1), cls: signClass },
      { key: "yoy", label: "年增%", fmt: v => formatSignedPct(v, 1), cls: signClass },
      { key: "cumRevenue", label: "累計營收(億)", fmt: v => formatMaybe(v != null ? v / 1e8 : null, 2) },
      { key: "cumYoy", label: "累計年增%", fmt: v => formatSignedPct(v, 1), cls: signClass },
    ],
  };
  const cmpFieldState = {
    latest: CMP_FIELDS.latest.map(f => f.key),
    annual: CMP_FIELDS.annual.map(f => f.key),
    monthly: CMP_FIELDS.monthly.map(f => f.key),
  };

  cmpAddBtn.addEventListener("click", addCompareStock);
  cmpInput.addEventListener("keydown", e => { if (e.key === "Enter") addCompareStock(); });
  cmpGoBtn.addEventListener("click", runCompare);
  cmpClearBtn.addEventListener("click", () => {
    compareList.length = 0;
    compareState.bundles = [];
    renderCmpChips();
    cmpResult.style.display = "none";
    setMsgOn(cmpMsg, "", "ok");
  });
  cmpModeSelect.addEventListener("change", () => {
    renderCmpFieldPicker();
    syncCompareSelectors();
    renderCompareTable();
  });
  cmpYearSelect.addEventListener("change", renderCompareTable);
  cmpMonthSelect.addEventListener("change", renderCompareTable);

  async function addCompareStock() {
    const entry = cmpInput.value.trim();
    if (!entry) return;
    setMsgOn(cmpMsg, "解析股票代號中...", "loading");
    const code = await resolveCode(entry);
    if (!code) { setMsgOn(cmpMsg, `找不到「${entry}」,請確認代號或名稱`, "err"); return; }
    if (compareList.some(c => c.code === code)) { setMsgOn(cmpMsg, `「${code}」已經在比較清單中了`, "err"); return; }
    if (compareList.length >= MAX_COMPARE) { setMsgOn(cmpMsg, `最多同時比較 ${MAX_COMPARE} 檔`, "err"); return; }
    const snap = await fetchCachedList("snapshot", `${getApiBase()}/snapshot`).catch(() => []);
    const row = (snap || []).find(x => String(x.Code) === code);
    compareList.push({ code, name: row ? row.Name : code });
    cmpInput.value = "";
    renderCmpChips();
    if (compareList.length >= 2) { runCompare(); return; }
    setMsgOn(cmpMsg, "再至少加入 1 檔就可以開始比較", "ok");
  }

  function renderCmpChips() {
    cmpChips.innerHTML = compareList.length === 0
      ? '<span class="chip-placeholder">最多加入 4 檔,加入後按「開始比較」</span>'
      : compareList.map((c, i) => `
          <span class="chip" style="border-color:${CMP_COLORS[i]};">
            <span style="color:${CMP_COLORS[i]}; font-weight:700;">${escapeHtml(c.code)}</span>
            ${escapeHtml(c.name)}
            <span class="chip-remove" data-rm="${escapeHtml(c.code)}">✕</span>
          </span>`).join("");
    cmpChips.querySelectorAll(".chip-remove").forEach(el => {
      el.addEventListener("click", () => {
        const i = compareList.findIndex(x => x.code === el.dataset.rm);
        if (i >= 0) compareList.splice(i, 1);
        renderCmpChips();
        cmpResult.style.display = "none";
        setMsgOn(cmpMsg, compareList.length >= 2 ? "清單已更新，按「開始比較」重新比較" : "", "ok");
      });
    });
  }

  function renderCmpFieldPicker() {
    const mode = cmpModeSelect.value;
    cmpFieldPicker.innerHTML = CMP_FIELDS[mode].map(field => {
      const checked = cmpFieldState[mode].includes(field.key) ? "checked" : "";
      return `<label class="metric-pill"><input type="checkbox" data-key="${field.key}" ${checked}>${field.label}</label>`;
    }).join("");
    cmpFieldPicker.querySelectorAll("input[data-key]").forEach(el => {
      el.addEventListener("change", () => {
        const next = Array.from(cmpFieldPicker.querySelectorAll("input[data-key]:checked")).map(x => x.dataset.key);
        cmpFieldState[mode] = next.length ? next : [CMP_FIELDS[mode][0].key];
        renderCompareTable();
      });
    });
  }

  function syncCompareSelectors() {
    const mode = cmpModeSelect.value;
    cmpYearWrap.style.display = mode === "annual" ? "inline-flex" : "none";
    cmpMonthWrap.style.display = mode === "monthly" ? "inline-flex" : "none";
    const years = Array.from(new Set(compareState.bundles.flatMap(b => b.years || []))).sort(compareDesc);
    const months = Array.from(new Set(compareState.bundles.flatMap(b => b.monthList || []))).sort(compareDesc);
    if (mode === "annual") {
      cmpYearSelect.innerHTML = years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
    }
    if (mode === "monthly") {
      cmpMonthSelect.innerHTML = months.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    }
  }

  function renderCompareTable() {
    if (!compareState.bundles.length) return;
    const mode = cmpModeSelect.value;
    const selectedKeys = cmpFieldState[mode];
    const fields = CMP_FIELDS[mode].filter(f => selectedKeys.includes(f.key));
    const periodLabel = mode === "latest" ? "最新總覽" : mode === "annual" ? `${cmpYearSelect.value || "年度"} 比較` : `${cmpMonthSelect.value || "月份"} 比較`;
    cmpTableTitle.textContent = periodLabel;
    document.getElementById("cmpHead").innerHTML = `<tr><th>代號/名稱</th>${fields.map(f => `<th>${f.label}</th>`).join("")}</tr>`;
    document.getElementById("cmpBody").innerHTML = compareState.bundles.map((b, i) => {
      const rowData = mode === "latest" ? b.latest : mode === "annual" ? (b.annualMap[cmpYearSelect.value] || {}) : (b.monthMap[cmpMonthSelect.value] || {});
      const cells = fields.map(f => {
        const raw = rowData[f.key];
        const cls = f.cls ? f.cls(raw) : "";
        return `<td class="${cls}">${f.fmt(raw)}</td>`;
      }).join("");
      return `<tr><td class="cmp-name" style="color:${CMP_COLORS[i]};">${escapeHtml(b.code)}<small>${escapeHtml(b.name)}</small></td>${cells}</tr>`;
    }).join("");
  }

  function renderCompareTechAndChart() {
    document.getElementById("cmpTechBody").innerHTML = compareState.bundles.map((b, i) => {
      const hist = b.historyRows || [];
      if (hist.length < 2) return `<tr><td class="cmp-name" style="color:${CMP_COLORS[i]};">${escapeHtml(b.code)}<small>${escapeHtml(b.name)}</small></td><td colspan="6" style="color:var(--text-dim);">歷史資料不足</td></tr>`;
      const kdj = calcKDJ(hist);
      const status = judgeKdjStatus(kdj);
      const lastK = kdj[kdj.length - 1];
      const rsi = calcRSI(hist);
      const lastRsi = rsi[rsi.length - 1];
      const ma5 = calcMA(hist, 5);
      const slope5 = ma5[ma5.length - 1] - ma5[ma5.length - 2];
      const trend = slope5 > 0 ? '<span class="up">▲ 上彎</span>' : slope5 < 0 ? '<span class="down">▼ 下彎</span>' : '<span class="flat">─ 持平</span>';
      const stIcon = { golden: "🟢", death: "🔴", overbought: "⚠️", oversold: "💡", neutral: "➖" }[status.type] || "";
      return `<tr><td class="cmp-name" style="color:${CMP_COLORS[i]};">${escapeHtml(b.code)}<small>${escapeHtml(b.name)}</small></td><td>${stIcon} ${escapeHtml(status.text.split(":")[0])}</td><td>${lastK.k.toFixed(1)}</td><td>${lastK.d.toFixed(1)}</td><td>${lastK.j.toFixed(1)}</td><td>${lastRsi.toFixed(1)}</td><td>${trend}</td></tr>`;
    }).join("");

    const chartRows = compareState.bundles.map(b => (b.historyRows || []).slice(-60));
    const maxLen = Math.max(...chartRows.map(r => r.length), 1);
    const labelSource = chartRows.find(r => r.length === maxLen) || [];
    const labels = labelSource.map(r => r.date);
    const seriesList = compareState.bundles.map((b, i) => {
      const aligned = chartRows[i].slice(-maxLen);
      if (aligned.length < 2) return { name: `${b.code} ${b.name}`.trim(), values: [], color: CMP_COLORS[i] };
      const base = aligned[0].close;
      const offset = maxLen - aligned.length;
      const values = [];
      for (let j = 0; j < maxLen; j++) {
        const row = aligned[j - offset];
        values.push(row && base ? (row.close / base * 100) : null);
      }
      return { name: `${b.code} ${b.name}`.trim(), values, color: CMP_COLORS[i] };
    });
    document.getElementById("cmpLegend").innerHTML = seriesList.map(s => `<span><span class="dot" style="background:${s.color};"></span>${escapeHtml(s.name)}</span>`).join("");
    drawTrendChart("cmpChart", labels, seriesList, 240);
  }

  async function runCompare() {
    if (compareList.length < 2) { setMsgOn(cmpMsg, "至少加入 2 檔股票才能比較", "err"); return; }
    cmpGoBtn.disabled = true;
    setMsgOn(cmpMsg, "抓取比較資料中，可能需要幾秒...", "loading");
    try {
      const [ratiosData, snapshotData, profileData] = await Promise.all([
        fetchCachedList("ratios", `${getApiBase()}/ratios`).catch(() => []),
        fetchCachedList("snapshot", `${getApiBase()}/snapshot`).catch(() => []),
        fetchCachedList("profile", `${getApiBase()}/profile`).catch(() => []),
      ]);
      const ratioMap = {}; (ratiosData || []).forEach(r => { ratioMap[String(r.Code)] = r; });
      const snapMap = {}; (snapshotData || []).forEach(r => { snapMap[String(r.Code)] = r; });
      const profileMap = {}; (profileData || []).forEach(r => { profileMap[String(r["公司代號"]).trim()] = r; });

      compareState.bundles = await Promise.all(compareList.map(async item => {
        const [quote, historyRows, revenueRows, fsRows, bsRows, cfRows, dividendRows] = await Promise.all([
          fetchJSON(`${getApiBase()}/realtime?ids=${encodeURIComponent(item.code)}`).then(d => (d?.msgArray || [])[0] || null).catch(() => null),
          fetchJSON(`${getApiBase()}/history?code=${encodeURIComponent(item.code)}&months=${PERIOD_MONTHS.day}`).then(parseHistoryRows).catch(() => []),
          fetchFinMind("TaiwanStockMonthRevenue", item.code, 8).catch(() => []),
          fetchFinMind("TaiwanStockFinancialStatements", item.code, 8).catch(() => []),
          fetchFinMind("TaiwanStockBalanceSheet", item.code, 8).catch(() => []),
          fetchFinMind("TaiwanStockCashFlowsStatement", item.code, 8).catch(() => []),
          fetchFinMind("TaiwanStockDividend", item.code, 15).catch(() => []),
        ]);
        return buildCompareBundle({ item, quote, ratio: ratioMap[item.code] || {}, snapshot: snapMap[item.code], profile: profileMap[item.code], historyRows, revenueRows, fsRows, bsRows, cfRows, dividendRows });
      }));

      compareState.bundles.forEach((b, i) => { compareList[i].name = b.name; });
      renderCmpChips();
      renderCmpFieldPicker();
      syncCompareSelectors();
      cmpResult.style.display = "block";
      renderCompareTable();
      renderCompareTechAndChart();
      setMsgOn(cmpMsg, "比較完成，可切換最新 / 年度 / 月份模式翻閱資料", "ok");
    } catch (err) {
      setMsgOn(cmpMsg, "比較失敗:" + err.message, "err");
    } finally {
      cmpGoBtn.disabled = false;
    }
  }

  renderCmpFieldPicker();
  updateFavoriteButton();

  /* 打開頁面時,若有 hash,直接切到對應分頁 */
  (function initHash() {
    const parts = location.hash.replace("#", "").split("/");
    const h = parts[0];
    if (["home", "stock", "compare", "rank", "favorite", "aggregate"].includes(h)) switchMainPage(h);
    if (h === "rank" && parts[1]) {
      const mode = parts[1];
      const btn = rankTabs ? rankTabs.querySelector(`button[data-rank="${mode}"]`) : null;
      if (btn) {
        rankState.mode = mode;
        rankTabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
      }
    }
  })();
