/* ============================================================
   aggregator-app.js — 資料彙整站(匯入 Excel/HTML 表格、評分、篩選)
   原本是內嵌 <script> 裡自己包一層 (function(){ "use strict"; ... })()
   的 IIFE。現在整個檔案就是一個 ES module,模組本身已經有獨立作用域,
   所以拿掉了外層的手動 IIFE 包裝(邏輯完全不變,只是不需要再手動隔離)。
   ============================================================ */
import { STORAGE_KEYS, PAGE_SIZE } from "./config.js";
import { escapeHtml as sharedEscapeHtml, parseNum as sharedParseNum, fmtDate, debounce }
  from "./utils.js";
import * as SafeStorage from "./storage-safe.js";
import { applyBothThemeMechanisms } from "./theme-sync.js";
import { createPager, paginate, pagerControlsHtml } from "./pagination.js";

  const STORAGE_KEY = "stock-master-v1";
  const WORKER_URL_KEY = "stock-master-worker-url";
  const COMMON_COLS = ["名稱","成交","漲跌價","漲跌幅","市場","股價日期"];

  /** state shape:
   * {
   *   categories: { [catName]: { importedAt, sourceFile, columns:[...], rows: { [code]: {field:val} } } },
   *   quotes: { [code]: { 名稱, 成交, 漲跌價, 漲跌幅, 市場, updatedAt } },
   *   ui: { activeCats: [...], fields: { [catName]: [selected field names] }, expanded: { [catName]: true }, showPE: true }
   * }
   */
  let state = { categories: {}, quotes: {}, ui: { activeCats: [], fields: {}, expanded: {}, showPE: true } };
  let sortState = { key: null, dir: 1 }; // key: "code"|"name"|"price"|"change"|"cat::field"|"__pe__"|"__score__"
  let displaySortState = { key: null, dir: 1 }; // what's actually applied this render (may fall back to score-desc)
  const tablePager = createPager(PAGE_SIZE); // 效能優化:大量股票分頁渲染,不再一次把全部列塞進 DOM

  // Screening thresholds the user cares about (used for highlighting numbers in the table)
  const THRESHOLDS = {
    peGood: 15,      // 本益比 < 15 算便宜
    yieldGood: 6,     // 殖利率 >= 6% 算不錯
    roeGood: 10,      // ROE >= 10% 表現不錯
    roeGreat: 20,     // ROE >= 20% 具競爭優勢
    volumeGood: 1000, // 成交張數 >= 1000 張，流動性良好
    pbGood: 1,        // 淨值比 < 1 算便宜
    kdOversold: 20,   // KD 的 K < 20 視為超賣，可能是進場訊號
    kdOverbought: 80, // KD 的 K > 80 視為超買，提醒留意
  };

  // Field-name matchers -> which "well-known metric" a column represents, used for highlighting only.
  // (Only matches fields that actually exist in the imported Goodinfo exports.)
  function metricTypeOf(label){
    if(/排名/.test(label)) return null; // ranking columns (e.g. "EPS歷年排名") are not real values — never treat as a metric
    if(/^EPS/.test(label)) return "eps";
    if(/ROE/.test(label) && /%/.test(label)) return "roe";
    if(/成交張數/.test(label)) return "volume";
    if(/殖利率/.test(label) && !/股票/.test(label)) return "yield"; // 現金殖利率 / 合計殖利率 類
    if(/每股淨值|BVPS/i.test(label)) return "bvps"; // 用來計算淨值比
    if(/股東權益/.test(label)) return "equity";
    if(/三大法人/.test(label) && /(持股|占比)/.test(label)) return "instAll"; // 三大法人合計持股占比（區分於單純外資持股）
    if(/K值/.test(label)) return "kdK";
    if(/D值/.test(label)) return "kdD";
    if(/^本益比$/.test(label)) return "pe"; // 官方（如 TWSE OpenAPI）已經算好的本益比，跟我們自算的本益比用同一套門檻
    if(/淨值比/.test(label)) return "pb"; // 官方股價淨值比
    return null;
  }

  const $ = (sel) => document.querySelector(sel);
  const dropZone = $("#dropZone");
  const fileInput = $("#fileInput");
  const workerUrlInput = $("#workerUrlInput");
  const chipRow = $("#chipRow");
  const tableScroll = $("#tableScroll");
  const searchInput = $("#searchInput");
  const toast = $("#toast");

  function showToast(msg, ms=2600){
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>toast.classList.remove("show"), ms);
  }
  // localStorage / window.storage 降級時的提示,統一走這個頁面自己的 toast 元件
  SafeStorage.setToastHandler(showToast);

  // ---------- theme ----------
  const THEME_KEY = "stock-master-theme";
  function applyTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    applyBothThemeMechanisms(theme); // 讓股票查詢頁的 body.theme-light 也跟著換
    const btn = $("#themeToggle");
    if(btn) btn.textContent = theme === "light" ? "☀️" : "🌙";
  }
  async function loadTheme(){
    try{
      const res = await SafeStorage.safeWindowStorageGet(THEME_KEY, false);
      const theme = (res && res.value) ? res.value : "dark";
      applyTheme(theme);
    }catch(e){
      applyTheme("dark");
    }
  }
  async function toggleTheme(){
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "light" ? "dark" : "light";
    applyTheme(next);
    try{ await SafeStorage.safeWindowStorageSet(THEME_KEY, next, false); }catch(e){ /* non-critical */ }
  }
  $("#themeToggle").addEventListener("click", toggleTheme);

  // ---------- full backup export/import (for moving data between computers) ----------
  function exportBackup(){
    const payload = {
      __type: "stock-master-backup",
      __version: 1,
      exportedAt: new Date().toISOString(),
      state: state,
      theme: document.documentElement.getAttribute("data-theme") || "dark",
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `台股彙整_備份_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("✓ 已匯出備份檔，請把這個 .json 檔帶到另一台電腦匯入");
  }

  function readBackupFile(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, "utf-8");
    });
  }

  async function importBackup(file){
    let payload;
    try{
      const text = await readBackupFile(file);
      payload = JSON.parse(text);
    }catch(e){
      showToast("⚠ 備份檔案格式錯誤，無法讀取");
      return;
    }
    if(!payload || payload.__type !== "stock-master-backup" || !payload.state){
      showToast("⚠ 這不是本工具匯出的備份檔");
      return;
    }
    const catCount = Object.keys(state.categories).length;
    if(catCount > 0){
      const ok = confirm(`目前已有 ${catCount} 個類別的資料。匯入備份會整批覆蓋目前的資料，確定要繼續嗎？`);
      if(!ok) return;
    }
    state = payload.state;
    if(!state.ui) state.ui = { activeCats: [], fields: {}, expanded: {}, showPE: true };
    if(!state.ui.fields) state.ui.fields = {};
    if(!state.ui.expanded) state.ui.expanded = {};
    await saveState();
    if(payload.theme){
      applyTheme(payload.theme);
      try{ await SafeStorage.safeWindowStorageSet(THEME_KEY, payload.theme, false); }catch(e){}
    }
    render();
    showToast(`✓ 已匯入備份（${Object.keys(state.categories).length} 個類別）`);
  }

  // ---------- persistence ----------
  async function loadState(){
    try{
      const res = await SafeStorage.safeWindowStorageGet(STORAGE_KEY, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        state.categories = parsed.categories || {};
        state.quotes = parsed.quotes || {};
        state.ui = parsed.ui || { activeCats: [], fields: {}, expanded: {}, showPE: true };
        if(!state.ui.fields) state.ui.fields = {};
        if(!state.ui.expanded) state.ui.expanded = {};
        if(state.ui.showPE === undefined) state.ui.showPE = true;
      }
    }catch(e){
      // no existing data yet — fine
    }
  }

  async function saveState(){
    try{
      await SafeStorage.safeWindowStorageSet(STORAGE_KEY, JSON.stringify(state), false);
    }catch(e){
      showToast("⚠ 儲存失敗，資料可能無法保留");
      console.error(e);
    }
  }

  // ---------- parsing ----------
  function parseHtmlTable(text){
    const doc = new DOMParser().parseFromString(text, "text/html");
    const table = doc.querySelector("table");
    if(!table) throw new Error("找不到表格內容");
    const trs = Array.from(table.querySelectorAll("tr"));
    if(trs.length < 2) throw new Error("表格資料列不足");

    // header row: first tr with th elements, else first tr
    let headerRowEl = trs.find(tr => tr.querySelectorAll("th").length > 0) || trs[0];
    const headers = Array.from(headerRowEl.querySelectorAll("th,td")).map(c => c.textContent.trim());

    const dataRows = [];
    for(const tr of trs){
      if(tr === headerRowEl) continue;
      const cells = Array.from(tr.querySelectorAll("td"));
      if(cells.length === 0) continue;
      const row = {};
      cells.forEach((c, i) => {
        const h = headers[i];
        if(h) row[h] = c.textContent.trim();
      });
      if(Object.keys(row).length) dataRows.push(row);
    }
    if(!headers.includes("代號")) throw new Error("此表格沒有「代號」欄位，無法辨識為股票資料");
    return { headers, dataRows };
  }

  function readFileAsText(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, "utf-8");
    });
  }

  function baseName(fileName){
    return fileName.replace(/\.[^/.]+$/, "");
  }

  // ---------- merge into state ----------
  function importParsedIntoCategory(catName, headers, dataRows, fileName){
    const dynamicCols = headers.filter(h => h !== "代號" && !COMMON_COLS.includes(h));
    if(!state.categories[catName]){
      state.categories[catName] = { importedAt: null, sourceFile: fileName, columns: dynamicCols, rows: {} };
    }
    const cat = state.categories[catName];
    cat.columns = dynamicCols;
    cat.sourceFile = fileName;
    cat.importedAt = new Date().toISOString();

    const now = cat.importedAt;
    let count = 0;
    for(const row of dataRows){
      const code = (row["代號"] || "").trim();
      if(!code) continue;
      count++;

      // update common quote fields (latest import wins)
      const q = state.quotes[code] || {};
      for(const c of COMMON_COLS){
        if(row[c] !== undefined && row[c] !== "") q[c] = row[c];
      }
      q.updatedAt = now;
      state.quotes[code] = q;

      // category-specific fields — overwrite this stock's row entirely with newest data
      const fields = {};
      for(const h of dynamicCols){
        if(row[h] !== undefined) fields[h] = row[h];
      }
      cat.rows[code] = fields;
    }
    cat.count = Object.keys(cat.rows).length;
    return count;
  }

  async function handleFiles(fileList){
    const files = Array.from(fileList);
    if(!files.length) return;
    dropZone.classList.remove("drag");
    showToast(`匯入中… (${files.length} 個檔案)`, 60000);

    let okCount = 0, failMsgs = [];
    for(const file of files){
      try{
        const text = await readFileAsText(file);
        const { headers, dataRows } = parseHtmlTable(text);
        const catName = baseName(file.name);
        const n = importParsedIntoCategory(catName, headers, dataRows, file.name);
        okCount++;
        if(!state.ui.fields[catName]){
          state.ui.fields[catName] = state.categories[catName].columns.slice();
        }
        if(!state.ui.activeCats.includes(catName) && Object.keys(state.categories).length <= 2){
          state.ui.activeCats.push(catName);
        }
      }catch(err){
        failMsgs.push(`${file.name}：${err.message}`);
      }
    }
    await saveState();
    render();
    toast.classList.remove("show");
    if(failMsgs.length){
      showToast(`完成 ${okCount} 個，失敗 ${failMsgs.length} 個：${failMsgs[0]}`, 5000);
    }else{
      showToast(`✓ 已匯入 ${okCount} 個檔案`);
    }
  }

  // ---------- fetch official TWSE data via user's Cloudflare Worker proxy ----------

  // Finds the first key in obj whose name matches ALL of the given regex patterns
  // (robust to TWSE's field naming varying slightly between datasets/versions).
  function findKeyAll(obj, patterns){
    for(const k of Object.keys(obj)){
      if(patterns.every(p => p.test(k))) return k;
    }
    return null;
  }
  function findKeyAny(obj, patterns){
    for(const k of Object.keys(obj)){
      if(patterns.some(p => p.test(k))) return k;
    }
    return null;
  }
  function pickCodeName(obj){
    const codeKey = findKeyAny(obj, [/^Code$/i, /公司代號/, /證券代號/, /^代號$/]);
    const nameKey = findKeyAny(obj, [/^Name$/i, /公司名稱/, /證券名稱/, /^名稱$/]);
    return { codeKey, nameKey };
  }

  async function fetchOfficialRatios(){
    const baseUrl = (workerUrlInput.value || "").trim().replace(/\/+$/, "");
    if(!baseUrl){
      showToast("請先貼上你的 Worker 網址");
      return;
    }
    try{ await SafeStorage.safeWindowStorageSet(WORKER_URL_KEY, baseUrl, false); }catch(e){ /* non-critical */ }

    showToast("正在抓取證交所本益比／殖利率／股價淨值比…", 30000);
    try{
      const res = await fetch(`${baseUrl}/ratios`);
      if(!res.ok) throw new Error(`Worker 回應錯誤 (${res.status})`);
      const data = await res.json();
      if(!Array.isArray(data) || !data.length){
        throw new Error("回傳的資料是空的，請確認 Worker 的 /ratios 路徑正常");
      }

      // TWSE OpenAPI BWIBBU_ALL fields: Code / Name / PEratio / DividendYield / PBratio / ClosingPrice(可能無)
      const headers = ["代號","名稱","成交","本益比","殖利率(%)","股價淨值比"];
      const dataRows = data.map(item => ({
        "代號": String(item.Code ?? item.代號 ?? item["證券代號"] ?? "").trim(),
        "名稱": item.Name ?? item.名稱 ?? item["證券名稱"] ?? "",
        "成交": item.ClosingPrice ?? item.收盤價 ?? "",
        "本益比": item.PEratio ?? item.本益比 ?? "",
        "殖利率(%)": item.DividendYield ?? item["殖利率(%)"] ?? item.殖利率 ?? "",
        "股價淨值比": item.PBratio ?? item.股價淨值比 ?? "",
      })).filter(r => r["代號"]);

      const catName = "TWSE官方本益比殖利率";
      importParsedIntoCategory(catName, headers, dataRows, `${baseUrl}/ratios`);
      if(!state.ui.fields[catName]) state.ui.fields[catName] = state.categories[catName].columns.slice();
      if(!state.ui.activeCats.includes(catName)) state.ui.activeCats.push(catName);

      await saveState();
      render();
      toast.classList.remove("show");
      showToast(`✓ 已抓取 ${dataRows.length} 檔股票的官方本益比／殖利率／淨值比`);
    }catch(err){
      toast.classList.remove("show");
      console.error("fetchOfficialRatios error:", err);
      let hint = err.message || String(err);
      if(/Failed to fetch|NetworkError/i.test(hint)){
        hint += "（請確認網址正確、Worker 有在運作，且這台電腦連得到網路）";
      }
      showToast(`⚠ 抓取失敗：${hint}`, 6000);
    }
  }

  async function fetchOfficialEPS(){
    const baseUrl = (workerUrlInput.value || "").trim().replace(/\/+$/, "");
    if(!baseUrl){ showToast("請先貼上你的 Worker 網址"); return; }
    try{ await SafeStorage.safeWindowStorageSet(WORKER_URL_KEY, baseUrl, false); }catch(e){}

    showToast("正在抓取證交所損益表（EPS）…", 30000);
    try{
      const res = await fetch(`${baseUrl}/incomeall`);
      if(!res.ok) throw new Error(`Worker 回應錯誤 (${res.status})`);
      const data = await res.json();
      if(!Array.isArray(data) || !data.length){
        throw new Error("回傳的資料是空的，請確認 Worker 的 /incomeall 路徑正常");
      }
      const sample = data[0];
      const { codeKey, nameKey } = pickCodeName(sample);
      const epsKey = findKeyAny(sample, [/每股盈餘/, /^EPS$/i]);
      if(!codeKey || !epsKey){
        throw new Error("回傳資料裡找不到公司代號或每股盈餘欄位，欄位名稱可能跟預期不同");
      }
      const headers = ["代號","名稱","EPS(元)"];
      const dataRows = data.map(item => ({
        "代號": String(item[codeKey] ?? "").trim(),
        "名稱": nameKey ? (item[nameKey] ?? "") : "",
        "EPS(元)": item[epsKey] ?? "",
      })).filter(r => r["代號"]);

      const catName = "TWSE官方損益表(EPS)";
      importParsedIntoCategory(catName, headers, dataRows, `${baseUrl}/incomeall`);
      if(!state.ui.fields[catName]) state.ui.fields[catName] = state.categories[catName].columns.slice();
      if(!state.ui.activeCats.includes(catName)) state.ui.activeCats.push(catName);

      await saveState();
      render();
      toast.classList.remove("show");
      showToast(`✓ 已抓取 ${dataRows.length} 檔股票的官方 EPS`);
    }catch(err){
      toast.classList.remove("show");
      console.error("fetchOfficialEPS error:", err);
      let hint = err.message || String(err);
      if(/Failed to fetch|NetworkError/i.test(hint)){
        hint += "（請確認網址正確、Worker 有在運作，且這台電腦連得到網路）";
      }
      showToast(`⚠ 抓取失敗：${hint}`, 6000);
    }
  }

  async function fetchOfficialEquity(){
    const baseUrl = (workerUrlInput.value || "").trim().replace(/\/+$/, "");
    if(!baseUrl){ showToast("請先貼上你的 Worker 網址"); return; }
    try{ await SafeStorage.safeWindowStorageSet(WORKER_URL_KEY, baseUrl, false); }catch(e){}

    showToast("正在抓取證交所資產負債表（股東權益）…", 30000);
    try{
      const res = await fetch(`${baseUrl}/balanceall`);
      if(!res.ok) throw new Error(`Worker 回應錯誤 (${res.status})`);
      const data = await res.json();
      if(!Array.isArray(data) || !data.length){
        throw new Error("回傳的資料是空的，請確認 Worker 的 /balanceall 路徑正常");
      }
      const sample = data[0];
      const { codeKey, nameKey } = pickCodeName(sample);
      // 欄位名稱在不同版本可能是「權益總額」「股東權益總額」「業主權益總額」，用「含權益+含總額」比對比較保險
      const equityKey = findKeyAll(sample, [/權益/, /總額/]);
      if(!codeKey || !equityKey){
        throw new Error("回傳資料裡找不到公司代號或權益總額欄位，欄位名稱可能跟預期不同");
      }
      const headers = ["代號","名稱","股東權益(千元)"];
      const dataRows = data.map(item => ({
        "代號": String(item[codeKey] ?? "").trim(),
        "名稱": nameKey ? (item[nameKey] ?? "") : "",
        "股東權益(千元)": item[equityKey] ?? "",
      })).filter(r => r["代號"]);

      const catName = "TWSE官方資產負債表(股東權益)";
      importParsedIntoCategory(catName, headers, dataRows, `${baseUrl}/balanceall`);
      if(!state.ui.fields[catName]) state.ui.fields[catName] = state.categories[catName].columns.slice();
      if(!state.ui.activeCats.includes(catName)) state.ui.activeCats.push(catName);

      await saveState();
      render();
      toast.classList.remove("show");
      showToast(`✓ 已抓取 ${dataRows.length} 檔股票的官方股東權益（使用欄位：${equityKey}）`);
    }catch(err){
      toast.classList.remove("show");
      console.error("fetchOfficialEquity error:", err);
      let hint = err.message || String(err);
      if(/Failed to fetch|NetworkError/i.test(hint)){
        hint += "（請確認網址正確、Worker 有在運作，且這台電腦連得到網路）";
      }
      showToast(`⚠ 抓取失敗：${hint}`, 6000);
    }
  }

  async function loadWorkerUrl(){
    try{
      const res = await SafeStorage.safeWindowStorageGet(WORKER_URL_KEY, false);
      if(res && res.value) workerUrlInput.value = res.value;
    }catch(e){ /* no saved url yet */ }
  }

  // ---------- category management ----------
  async function removeCategory(catName){
    delete state.categories[catName];
    delete state.ui.fields[catName];
    delete state.ui.expanded[catName];
    state.ui.activeCats = state.ui.activeCats.filter(c => c !== catName);
    await saveState();
    render();
    showToast(`已移除「${catName}」`);
  }

  async function renameCategory(oldName){
    const newName = prompt("重新命名此類別：", oldName);
    if(!newName || newName === oldName) return;
    if(state.categories[newName]){
      showToast("已有相同名稱的類別");
      return;
    }
    state.categories[newName] = state.categories[oldName];
    delete state.categories[oldName];
    if(state.ui.fields[oldName]){ state.ui.fields[newName] = state.ui.fields[oldName]; delete state.ui.fields[oldName]; }
    if(state.ui.expanded[oldName]){ state.ui.expanded[newName] = true; delete state.ui.expanded[oldName]; }
    state.ui.activeCats = state.ui.activeCats.map(c => c === oldName ? newName : c);
    await saveState();
    render();
  }

  async function clearAll(){
    if(!confirm("確定要清空所有已匯入的資料嗎？此動作無法復原。")) return;
    state = { categories: {}, quotes: {}, ui: { activeCats: [], fields: {}, expanded: {}, showPE: true } };
    await saveState();
    render();
    showToast("已清空全部資料");
  }

  // ---------- rendering ----------
  // fmtDate/escapeHtml/escapeAttr/parseNum 現在共用 utils.js 的版本（見檔案頂端 import），
  // 這裡用別名接回原本的名字，其餘程式碼完全不用改動呼叫處。
  const escapeHtml = sharedEscapeHtml;
  const escapeAttr = sharedEscapeHtml;
  const parseNum = sharedParseNum;

  // Fields worth flagging with a ★ inside the expanded list, per the metrics the user cares about
  function isStarredField(label){
    return metricTypeOf(label) !== null;
  }

  function renderChips(){
    const names = Object.keys(state.categories);
    if(!names.length){
      chipRow.innerHTML = `<div class="empty-cats">尚未匯入任何資料</div>`;
      return;
    }
    chipRow.innerHTML = names.map(name => {
      const cat = state.categories[name];
      const active = state.ui.activeCats.includes(name);
      const expanded = !!state.ui.expanded[name];
      const selectedFields = state.ui.fields[name] || cat.columns.slice();
      const allSelected = cat.columns.length > 0 && cat.columns.every(f => selectedFields.includes(f));
      const noneSelected = selectedFields.length === 0;

      const fieldListHtml = expanded ? `
        <div class="field-list">
          ${cat.columns.map(f => `
            <label>
              <input type="checkbox" data-field-cat="${escapeAttr(name)}" data-field-name="${escapeAttr(f)}"
                ${selectedFields.includes(f) ? 'checked' : ''}>
              <span class="${isStarredField(f) ? 'starred' : ''}">${isStarredField(f) ? '★ ' : ''}${escapeHtml(f)}</span>
            </label>
          `).join("")}
        </div>` : "";

      return `
        <div class="chip-group ${active?'active':''}">
          <div class="chip">
            <span class="exp ${expanded?'open':''}" data-toggle-expand="${escapeAttr(name)}" title="展開/收合細項">▸</span>
            <label>
              <input type="checkbox" data-cat="${escapeAttr(name)}" ${active?'checked':''}
                ${(!allSelected && !noneSelected) ? 'data-indeterminate="1"' : ''}>
              <span>
                <span class="cname">${escapeHtml(name)}</span><br>
                <span class="cmeta">${cat.count||0} 檔 · ${selectedFields.length}/${cat.columns.length} 欄 · ${fmtDate(cat.importedAt)}</span>
              </span>
            </label>
            <span class="rn" data-rename="${escapeAttr(name)}" title="重新命名">✎</span>
            <span class="x" data-remove="${escapeAttr(name)}" title="移除">✕</span>
          </div>
          ${fieldListHtml}
        </div>`;
    }).join("");

    // set indeterminate state (can't be done via HTML attribute)
    chipRow.querySelectorAll('input[data-indeterminate="1"]').forEach(el => { el.indeterminate = true; });
  }

  function getAllCodes(){
    const set = new Set(Object.keys(state.quotes));
    for(const cat of Object.values(state.categories)){
      Object.keys(cat.rows).forEach(c => set.add(c));
    }
    return Array.from(set);
  }

  function buildColumnDefs(){
    const fixed = [
      { key: "code", label: "代號" },
      { key: "name", label: "名稱" },
      { key: "price", label: "成交" },
      { key: "change", label: "漲跌幅" },
    ];
    const dyn = [];
    let epsSource = null; // {cat, field} of the first selected EPS column found, used for computed 本益比
    let bvpsSource = null; // {cat, field} of the first selected 每股淨值 column found, used for computed 淨值比
    let yieldRelocateIdx = null; // index in dyn[] of the first active 殖利率-type field, to be moved into 計算指標
    for(const catName of state.ui.activeCats){
      const cat = state.categories[catName];
      if(!cat) continue;
      const selected = state.ui.fields[catName] || cat.columns;
      for(const field of cat.columns){
        if(!selected.includes(field)) continue;
        const type = metricTypeOf(field);
        dyn.push({ key: `${catName}::${field}`, cat: catName, field, label: field, metric: type });
        if(type === "eps" && !epsSource) epsSource = { cat: catName, field };
        if(type === "bvps" && !bvpsSource) bvpsSource = { cat: catName, field };
        if(type === "yield" && yieldRelocateIdx === null) yieldRelocateIdx = dyn.length - 1;
      }
    }
    // Pull the first active 殖利率 column out of its original category and regroup it under
    // "計算指標" (alongside 本益比／淨值比), so the summary columns stay together like the detail modal.
    let yieldEntry = null;
    if(yieldRelocateIdx !== null){
      yieldEntry = dyn.splice(yieldRelocateIdx, 1)[0];
    }
    // synthetic computed column: 本益比 = 成交 / EPS, only shown when an EPS column is active and toggle is on
    if(epsSource && state.ui.showPE){
      dyn.push({ key: "__pe__", cat: "計算指標", field: "本益比", label: "本益比", metric: "pe", computed: "pe", epsSource });
    }
    // synthetic computed column: 淨值比 = 成交 / 每股淨值, only shown when a 每股淨值 column is active
    if(bvpsSource && state.ui.showPB !== false){
      dyn.push({ key: "__pb__", cat: "計算指標", field: "淨值比", label: "淨值比", metric: "pb", computed: "pb", bvpsSource });
    }
    if(yieldEntry){
      dyn.push({ ...yieldEntry, displayCat: "計算指標", label: "殖利率", title: yieldEntry.field });
    }
    // synthetic "達標評分" column — counts how many of the currently-shown threshold metrics this stock passes
    // 達標評分只計入有明確門檻的指標；eps/bvps/equity/instAll/kdD 只是原始數值或輔助欄位，不納入評分
    const NON_SCORABLE = new Set(["eps", "bvps", "equity", "instAll", "kdD"]);
    const scorable = dyn.filter(d => d.metric && !NON_SCORABLE.has(d.metric));
    if(scorable.length >= 2){
      dyn.push({ key: "__score__", cat: "計算指標", field: "達標評分", label: "達標評分", computed: "score", scorable });
    }
    return { fixed, dyn };
  }

  function computeScore(code, scorable){
    let passed = 0, total = 0;
    for(const d of scorable){
      const val = getCellValue(code, d);
      const num = parseNum(val);
      if(num === null || isNaN(num)) continue; // missing data for this stock: don't count against it
      total++;
      const cls = highlightClass(d.metric, num);
      if(cls === "hl-good" || cls === "hl-great") passed++;
    }
    return { passed, total };
  }

  function getCellValue(code, d){
    if(d.computed === "pe"){
      const price = parseNum((state.quotes[code]||{})["成交"]);
      const cat = state.categories[d.epsSource.cat];
      const eps = cat && cat.rows[code] ? parseNum(cat.rows[code][d.epsSource.field]) : null;
      if(price === null || eps === null || eps === 0) return null;
      return Math.round((price / eps) * 100) / 100;
    }
    if(d.computed === "pb"){
      const price = parseNum((state.quotes[code]||{})["成交"]);
      const cat = state.categories[d.bvpsSource.cat];
      const bvps = cat && cat.rows[code] ? parseNum(cat.rows[code][d.bvpsSource.field]) : null;
      if(price === null || bvps === null || bvps === 0) return null;
      return Math.round((price / bvps) * 100) / 100;
    }
    if(d.computed === "score"){
      const { passed } = computeScore(code, d.scorable);
      return passed;
    }
    const cat = state.categories[d.cat];
    return cat && cat.rows[code] ? cat.rows[code][d.field] : undefined;
  }

  function highlightClass(metric, numVal){
    if(numVal === null || numVal === undefined || isNaN(numVal)) return "";
    switch(metric){
      case "pe": return numVal < THRESHOLDS.peGood ? "hl-good" : "";
      case "pb": return numVal < THRESHOLDS.pbGood ? "hl-good" : "";
      case "yield": return numVal >= THRESHOLDS.yieldGood ? "hl-good" : "";
      case "roe": return numVal >= THRESHOLDS.roeGreat ? "hl-great" : (numVal >= THRESHOLDS.roeGood ? "hl-good" : "");
      case "volume": return numVal >= THRESHOLDS.volumeGood ? "hl-good" : "";
      case "kdK": return numVal < THRESHOLDS.kdOversold ? "hl-good" : (numVal > THRESHOLDS.kdOverbought ? "hl-warn" : "");
      default: return "";
    }
  }

  function render(){
    renderChips();
    $("#statStocks").textContent = getAllCodes().length;
    $("#statCats").textContent = Object.keys(state.categories).length;

    const catCount = Object.keys(state.categories).length;
    if(catCount === 0){
      tableScroll.innerHTML = `<div class="empty-state"><div class="big">目前沒有資料</div><div class="small">拖曳或選擇 .xls 檔案開始匯入</div></div>`;
      $("#countBadge").textContent = "";
      $("#lastUpdated").textContent = "";
      $("#legendBar").style.display = "none";
      return;
    }

    const { fixed, dyn } = buildColumnDefs();
    const scoreDef = dyn.find(d => d.computed === "score");
    const query = searchInput.value.trim().toLowerCase();
    const scoreFilterVal = $("#scoreFilter") ? $("#scoreFilter").value : "0";
    let codes = getAllCodes().filter(code => {
      if(query){
        const q = state.quotes[code] || {};
        const matchesQuery = code.toLowerCase().includes(query) || (q["名稱"]||"").toLowerCase().includes(query);
        if(!matchesQuery) return false;
      }
      if(scoreDef && scoreFilterVal !== "0"){
        const { passed, total } = computeScore(code, scoreDef.scorable);
        if(total === 0) return false; // no data at all for this stock, exclude from filtered views
        if(scoreFilterVal === "all") return passed === total;
        if(passed < parseInt(scoreFilterVal, 10)) return false;
      }
      return true;
    });

    // default sort by score (best first) when the score column exists and no explicit sort chosen
    const effectiveSortKey = sortState.key || (scoreDef ? "__score__" : null);
    const effectiveSortDir = sortState.key ? sortState.dir : -1;
    displaySortState = { key: effectiveSortKey, dir: effectiveSortDir };

    // sorting
    if(effectiveSortKey){
      codes.sort((a,b) => {
        const va = getSortValue(a, effectiveSortKey);
        const vb = getSortValue(b, effectiveSortKey);
        const na = parseNum(va), nb = parseNum(vb);
        let cmp;
        if(na !== null && nb !== null) cmp = na - nb;
        else if(va == null || va === "") cmp = (vb == null || vb === "") ? 0 : 1;
        else if(vb == null || vb === "") cmp = -1;
        else cmp = String(va).localeCompare(String(vb), "zh-Hant");
        return cmp * effectiveSortDir;
      });
    }

    $("#countBadge").textContent = `顯示 ${codes.length} / ${getAllCodes().length} 檔`;
    const mostRecent = Object.values(state.categories).map(c=>c.importedAt).sort().pop();
    $("#lastUpdated").textContent = mostRecent ? `最後匯入：${fmtDate(mostRecent)}` : "";

    // apply Top-N limit (after sorting, so "前100名" reflects the current sort order)
    const limitVal = $("#limitFilter") ? parseInt($("#limitFilter").value, 10) : 0;
    const totalMatched = codes.length;
    if(limitVal > 0) codes = codes.slice(0, limitVal);
    $("#countBadge").textContent = limitVal > 0
      ? `顯示前 ${codes.length} 名（符合條件共 ${totalMatched} 檔 / 總計 ${getAllCodes().length} 檔）`
      : `顯示 ${codes.length} / ${getAllCodes().length} 檔`;

    const legendBar = $("#legendBar");
    if(scoreDef){
      const parts = [...new Set(scoreDef.scorable.map(d => {
        switch(d.metric){
          case "pe": return `本益比 &lt; ${THRESHOLDS.peGood}`;
          case "pb": return `淨值比 &lt; ${THRESHOLDS.pbGood}`;
          case "yield": return `殖利率 ≥ ${THRESHOLDS.yieldGood}%`;
          case "roe": return `ROE ≥ ${THRESHOLDS.roeGood}%（≥${THRESHOLDS.roeGreat}% 金色為佳）`;
          case "volume": return `成交張數 ≥ ${THRESHOLDS.volumeGood}`;
          case "kdK": return `KD值 K &lt; ${THRESHOLDS.kdOversold}（超賣，K &gt; ${THRESHOLDS.kdOverbought} 為超買提醒）`;
          default: return d.label;
        }
      }))];
      legendBar.style.display = "flex";
      legendBar.innerHTML = `
        <div class="lg-item"><span class="dot pick"></span>金框列＝全部指標都符合，值得優先研究</div>
        <div class="lg-item"><span class="dot good"></span>綠字＝單項達標</div>
        <div class="lg-item"><span class="dot great"></span>金字＝表現優異（如 ROE ≥ ${THRESHOLDS.roeGreat}%）</div>
        <div class="lg-item" style="color:var(--text-faint);">判讀依據：${parts.join("　·　")}</div>`;
    }else{
      legendBar.style.display = "none";
    }

    // group header row (category spans)
    const rankColHtml = limitVal > 0 ? `<th class="fixed-col" rowspan="2" style="min-width:36px;">名次</th>` : "";
    const groupCells = `${rankColHtml}
      <th class="fixed-col" rowspan="2" data-sort="code">代號${arrowFor("code")}</th>
      <th class="fixed-col" rowspan="2" data-sort="name">名稱${arrowFor("name")}</th>
      <th class="fixed-col" rowspan="2" data-sort="price">成交${arrowFor("price")}</th>
      <th class="fixed-col" rowspan="2" data-sort="change">漲跌幅${arrowFor("change")}</th>`;

    const catSpans = {};
    dyn.forEach(d => { const gc = d.displayCat || d.cat; catSpans[gc] = (catSpans[gc]||0)+1; });
    let catHeaderRow = "";
    for(const [catName, span] of Object.entries(catSpans)){
      catHeaderRow += `<th colspan="${span}">${escapeHtml(catName)}</th>`;
    }

    let fieldHeaderRow = "";
    for(const d of dyn){
      const starred = d.metric ? '★ ' : '';
      fieldHeaderRow += `<th class="${d.computed?'computed':''}" data-sort="${escapeAttr(d.key)}" title="${escapeAttr(d.title || d.label)}">${starred}${escapeHtml(d.label)}${arrowFor(d.key)}</th>`;
    }

    let bodyRows = "";
    // 分頁:只渲染目前頁的資料列,避免上千檔股票一次塞進 DOM 造成卡頓
    const { pageItems, totalPages } = paginate(codes, tablePager);
    const pageStart = (tablePager.page - 1) * tablePager.pageSize;
    pageItems.forEach((code, pageIdx) => {
      const idx = pageStart + pageIdx; // 名次要反映在「全部排序結果」中的位置,不是頁內位置
      const q = state.quotes[code] || {};
      const name = q["名稱"] || "";
      const price = q["成交"] || "";
      const change = q["漲跌幅"] || "";
      const changeNum = parseNum(change);
      const changeClass = changeNum > 0 ? "up" : (changeNum < 0 ? "down" : "");

      let rowScore = null; // {passed, total} if a score column is active for this row
      let rowHtml = limitVal > 0 ? `<td class="code-col" style="text-align:center;">${idx+1}</td>` : "";
      rowHtml += `<td class="code-col">${escapeHtml(code)}</td>`;
      rowHtml += `<td class="name-col clickable" data-open-detail="${escapeAttr(code)}">${escapeHtml(name)}</td>`;
      rowHtml += `<td class="num">${price ? escapeHtml(price) : '<span class="dash">—</span>'}</td>`;
      rowHtml += `<td class="num ${changeClass}">${change ? escapeHtml(change) : '<span class="dash">—</span>'}</td>`;

      for(const d of dyn){
        if(d.computed === "score"){
          const { passed, total } = computeScore(code, d.scorable);
          rowScore = { passed, total };
          const dots = total > 0
            ? Array.from({length: total}, (_,i) => i < passed ? "●" : "○").join("")
            : "";
          const label = total > 0 ? `${passed}/${total}` : "—";
          rowHtml += `<td class="score-cell">${label}${dots ? `<div class="dots">${dots}</div>` : ""}</td>`;
          continue;
        }
        const val = getCellValue(code, d);
        const numVal = parseNum(val);
        const hlClass = d.metric ? highlightClass(d.metric, numVal) : "";
        const display = (val !== undefined && val !== null && val !== "") ? escapeHtml(val) : '<span class="dash">—</span>';
        rowHtml += `<td class="num ${hlClass}">${display}</td>`;
      }
      const pickClass = (rowScore && rowScore.total >= 2 && rowScore.passed === rowScore.total) ? "row-pick" : "";
      bodyRows += `<tr class="${pickClass}">${rowHtml}</tr>`;
    });

    tableScroll.innerHTML = `
      <table>
        <thead>
          <tr class="group-row">
            <th class="fixed-col" colspan="${limitVal>0?5:4}" style="background:var(--group-bg);"></th>
            ${catHeaderRow}
          </tr>
          <tr class="field-row">
            ${groupCells}
            ${fieldHeaderRow}
          </tr>
        </thead>
        <tbody>
          ${bodyRows || `<tr><td colspan="${4+dyn.length}" style="text-align:center;color:var(--text-faint);padding:26px;">沒有符合的結果</td></tr>`}
        </tbody>
      </table>
      ${pagerControlsHtml(tablePager, totalPages, "agg-table")}`;
  }

  function arrowFor(key){
    if(displaySortState.key !== key) return "";
    return `<span class="arrow">${displaySortState.dir === 1 ? "▲" : "▼"}</span>`;
  }

  function getSortValue(code, key){
    if(key === "code") return code;
    if(key === "name") return (state.quotes[code]||{})["名稱"] || "";
    if(key === "price") return (state.quotes[code]||{})["成交"] || "";
    if(key === "change") return (state.quotes[code]||{})["漲跌幅"] || "";
    if(key === "__pe__"){
      const { dyn } = buildColumnDefs();
      const d = dyn.find(x => x.key === "__pe__");
      return d ? getCellValue(code, d) : "";
    }
    if(key === "__pb__"){
      const { dyn } = buildColumnDefs();
      const d = dyn.find(x => x.key === "__pb__");
      return d ? getCellValue(code, d) : "";
    }
    if(key === "__score__"){
      const { dyn } = buildColumnDefs();
      const d = dyn.find(x => x.key === "__score__");
      return d ? getCellValue(code, d) : "";
    }
    const [cat, field] = key.split("::");
    const c = state.categories[cat];
    return c && c.rows[code] ? c.rows[code][field] : "";
  }

  // ---------- CSV export ----------
  function exportCsv(){
    const { dyn } = buildColumnDefs();
    const query = searchInput.value.trim().toLowerCase();
    let codes = getAllCodes().filter(code => {
      if(!query) return true;
      const q = state.quotes[code] || {};
      return code.toLowerCase().includes(query) || (q["名稱"]||"").toLowerCase().includes(query);
    });
    if(sortState.key){
      codes.sort((a,b) => {
        const va = getSortValue(a, sortState.key);
        const vb = getSortValue(b, sortState.key);
        const na = parseNum(va), nb = parseNum(vb);
        let cmp;
        if(na !== null && nb !== null) cmp = na - nb;
        else cmp = String(va||"").localeCompare(String(vb||""), "zh-Hant");
        return cmp * sortState.dir;
      });
    }
    const headers = ["代號","名稱","成交","漲跌幅", ...dyn.map(d => `${d.cat}-${d.field}`)];
    const lines = [headers.join(",")];
    for(const code of codes){
      const q = state.quotes[code] || {};
      const row = [code, q["名稱"]||"", q["成交"]||"", q["漲跌幅"]||""];
      for(const d of dyn){
        const v = getCellValue(code, d);
        row.push(v || "");
      }
      lines.push(row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(","));
    }
    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `台股彙整_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- stock detail modal ----------
  const modalOverlay = $("#modalOverlay");
  const modalBox = $("#modalBox");

  // Find the first available raw value across ALL imported categories for a given metric type,
  // regardless of which categories/fields are currently active in the table view.
  function findBestMetricValue(code, metricType){
    for(const cat of Object.values(state.categories)){
      for(const field of cat.columns){
        if(metricTypeOf(field) !== metricType) continue;
        const row = cat.rows[code];
        if(row && row[field] !== undefined && row[field] !== ""){
          return row[field];
        }
      }
    }
    return null;
  }

  function openStockDetail(code){
    const q = state.quotes[code] || {};
    const name = q["名稱"] || "";
    const price = q["成交"] || "";
    const change = q["漲跌幅"] || "";
    const changeNum = parseNum(change);
    const changeClass = changeNum > 0 ? "up" : (changeNum < 0 ? "down" : "");

    let sections = "";
    for(const [catName, cat] of Object.entries(state.categories)){
      const row = cat.rows[code];
      if(!row) continue;
      const fieldRows = cat.columns
        .filter(f => row[f] !== undefined && row[f] !== "")
        .map(f => {
          const type = metricTypeOf(f);
          const numVal = parseNum(row[f]);
          const cls = type ? highlightClass(type, numVal) : "";
          return `<div class="field-row"><span class="fk">${escapeHtml(f)}</span><span class="fv ${cls}">${escapeHtml(row[f])}</span></div>`;
        }).join("");
      if(!fieldRows) continue;
      sections += `
        <div class="modal-section">
          <div class="sec-title">${escapeHtml(catName)}</div>
          <div class="modal-grid">${fieldRows}</div>
        </div>`;
    }

    // computed 本益比 / 淨值比, if derivable
    const dyn = buildColumnDefs().dyn;
    const computedRows = [];
    const peDef = dyn.find(d => d.computed === "pe");
    if(peDef){
      const pe = getCellValue(code, peDef);
      if(pe !== null && pe !== undefined){
        computedRows.push(`<div class="field-row"><span class="fk">本益比</span><span class="fv ${highlightClass("pe", pe)}">${pe}</span></div>`);
      }
    }
    const pbDef = dyn.find(d => d.computed === "pb");
    if(pbDef){
      const pb = getCellValue(code, pbDef);
      if(pb !== null && pb !== undefined){
        computedRows.push(`<div class="field-row"><span class="fk">淨值比</span><span class="fv ${highlightClass("pb", pb)}">${pb}</span></div>`);
      }
    }
    const yieldVal = findBestMetricValue(code, "yield");
    if(yieldVal !== null){
      const yNum = parseNum(yieldVal);
      computedRows.push(`<div class="field-row"><span class="fk">殖利率</span><span class="fv ${highlightClass("yield", yNum)}">${escapeHtml(yieldVal)}%</span></div>`);
    }
    if(computedRows.length){
      sections = `
          <div class="modal-section">
            <div class="sec-title">計算指標</div>
            <div class="modal-grid">${computedRows.join("")}</div>
          </div>` + sections;
    }

    if(!sections){
      sections = `<div class="modal-empty">目前沒有這支股票的細項資料</div>`;
    }

    modalBox.innerHTML = `
      <div class="modal-head">
        <div class="title-block">
          <h2>${escapeHtml(name || code)}</h2>
          <span class="code">${escapeHtml(code)}</span>
        </div>
        <div class="price-block">
          <div class="price">${price ? escapeHtml(price) : "—"}</div>
          <div class="change ${changeClass}">${change ? escapeHtml(change) + "%" : ""}</div>
        </div>
        <button class="modal-close" id="modalCloseBtn">✕</button>
      </div>
      <div class="modal-body">${sections}</div>`;

    modalOverlay.classList.add("show");
    $("#modalCloseBtn").addEventListener("click", closeStockDetail);
  }

  function closeStockDetail(){
    modalOverlay.classList.remove("show");
  }

  // ---------- AI 財報分析與推薦 ----------
  // Calls the person's own Cloudflare Worker (/recommend), which proxies to Gemini.
  // This works even when the file is opened locally, since the Worker has CORS enabled.
  function collectAnalysisData(){
    const { dyn } = buildColumnDefs();
    // exclude the 達標評分 column itself from the payload; the AI should form its own judgement
    const usableDyn = dyn.filter(d => d.computed !== "score");
    if(usableDyn.length < 2) return null;

    const scoreDef = dyn.find(d => d.computed === "score");
    let codes = getAllCodes();
    if(scoreDef){
      codes = codes
        .map(code => ({ code, ...computeScore(code, scoreDef.scorable) }))
        .filter(x => x.total > 0)
        .sort((a,b) => b.passed - a.passed)
        .slice(0, 200)
        .map(x => x.code);
    }else{
      codes = codes.slice(0, 200);
    }
    if(!codes.length) return null;

    const rows = codes.map(code => {
      const q = state.quotes[code] || {};
      const rec = { 代號: code, 名稱: q["名稱"] || "", 成交: q["成交"] || "" };
      for(const d of usableDyn){
        const val = getCellValue(code, d);
        if(val !== undefined && val !== null && val !== "") rec[d.label] = val;
      }
      return rec;
    });
    return rows;
  }

  async function runAIAnalysis(){
    const baseUrl = (workerUrlInput.value || "").trim().replace(/\/+$/, "");
    if(!baseUrl){
      showToast("請先在上面貼上你的 Worker 網址");
      return;
    }
    const rows = collectAnalysisData();
    if(!rows){
      showToast("目前選取的欄位太少，請先勾選幾個財務指標（如 EPS、ROE、殖利率）再試一次");
      return;
    }
    try{ await SafeStorage.safeWindowStorageSet(WORKER_URL_KEY, baseUrl, false); }catch(e){}

        window.__lastAIRows = rows; // 第六版:讓 renderAIResults 讀取送進 AI 的實際欄位值
modalBox.innerHTML = `
      <div class="modal-head">
        <div class="title-block"><h2>🤖 AI 財報分析</h2></div>
        <button class="modal-close" id="modalCloseBtn">✕</button>
      </div>
      <div class="modal-body">
        <div class="ai-loading">
          <div class="spinner-big"></div>
          <div>正在請 Gemini 分析 ${rows.length} 檔候選股票，並請 AI 推薦 20 檔，請稍候…</div>
        </div>
      </div>`;
    modalOverlay.classList.add("show");
    $("#modalCloseBtn").addEventListener("click", closeStockDetail);

    try{
      const response = await fetch(`${baseUrl}/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: rows }),
      });
      if(!response.ok){
        throw new Error(`Worker 回應錯誤 (${response.status})`);
      }
      const data = await response.json();
      if(data.error){
        throw new Error(data.error + (data.detail ? `（${JSON.stringify(data.detail).slice(0,200)}）` : ""));
      }
      const picks = Array.isArray(data.picks) ? data.picks.slice(0, 20) : [];
      if(!picks.length) throw new Error("AI 沒有回傳有效的推薦清單");
      renderAIResults(picks, rows.length);
    }catch(err){
      console.error("AI analysis error:", err);
      let hint = err.message || String(err);
      if(/Failed to fetch|NetworkError/i.test(hint)){
        hint += "（請確認 Worker 網址正確、Worker 有在運作，且這台電腦連得到網路）";
      }
      modalBox.querySelector(".modal-body").innerHTML = `
        <div class="ai-error">⚠ AI 分析失敗：${escapeHtml(hint)}<br><br>可以稍後再試一次。</div>`;
    }
  }

    // ---- 第六版:依既有財務欄位自動推導存股型 / 成長型 / 均衡型 分類 ----
  // 規則：殖利率 >= 6% 視為存股訊號；
  //       營收年增 >= 20% 或單月營收月增 >= 30% 或 EPS(元) >= 5 視為成長訊號；
  //       同時具備 → 均衡型；都不具備 → 均衡型
  const TAG_RULES = {
    yieldGood: 6,        // %，殖利率門檻
    revYoyGood: 20,      // %，營收年增門檻
    revMomGood: 30,      // %，單月月增門檻
    epsGood: 5           // 元，年度 EPS 門檻
  };
  function deriveTagWithRules(raw, pickedRow, rules){
    const fromAI = String(raw || "").trim();
    const norm = fromAI.replace(/\s|型/g, "");
    if(norm === "存股" || norm === "value" || norm === "dividend" || fromAI === "存股型") return "存股型";
    if(norm === "成長" || norm === "growth" || fromAI === "成長型") return "成長型";
    if(norm === "均衡" || norm === "balanced" || norm === "balance" || fromAI === "均衡型" || fromAI === "均衡型") return "均衡型";
    if(norm === "增長" || norm === "increase") return "成長型";
    let yieldVal=null, yoyVal=null, momVal=null, epsVal=null;
    if(pickedRow){
      for(const [k,v] of Object.entries(pickedRow)){
        const key = String(k);
        const num = parseFloat(String(v).replace(/[^\d.\-]/g,""));
        if(!isFinite(num)) continue;
        if(/殖利率/.test(key) && yieldVal == null) yieldVal = num;
        else if(/年增/.test(key) && yoyVal == null) yoyVal = num;
        else if(/月增/.test(key) && momVal == null) momVal = num;
        else if(/^EPS/.test(key) && epsVal == null) epsVal = num;
      }
    }
    const R = rules || TAG_RULES;
    let isValue = (yieldVal != null && yieldVal >= R.yieldGood)
                || (epsVal  != null && epsVal  >= R.epsGood * 0.4);
    let isGrowth = (yoyVal != null && yoyVal >= R.revYoyGood)
                || (epsVal != null && epsVal >= R.epsGood)
                || (momVal != null && momVal >= R.revMomGood);
    if(isValue && isGrowth) return "均衡型";
    if(isValue)              return "存股型";
    if(isGrowth)             return "成長型";
    return "均衡型";
  }
  // 第六版留下的入口;第七版會從 renderAIResults 用規則化版本覆蓋
  function deriveTag(raw, pickedRow){
    return deriveTagWithRules(raw, pickedRow, window.__tagRules || TAG_RULES);
  }

    function renderAIResults(picks, poolSize){
    const disclaimer = `此為 AI 依你目前匯入的財報／籌碼資料自動分析產生，資料範圍取自目前已勾選欄位中評分最高的前 ${poolSize} 檔（單日快照，非完整歷史財報），最終由 AI 推薦出 20 檔作為研究參考，不構成投資建議，請自行查證後再做投資決策。`;

    // 第七版:可動門檻;若使用者未編輯,沿用 TAG_RULES 預設
    if(!window.__tagRules){
      window.__tagRules = { yieldGood: TAG_RULES.yieldGood, revYoyGood: TAG_RULES.revYoyGood,
                            revMomGood: TAG_RULES.revMomGood, epsGood: TAG_RULES.epsGood };
    }
    const lastRows = window.__lastAIRows || [];
    const byCode = {};
    lastRows.forEach(r => { if(r && r["代號"]) byCode[String(r["代號"]).trim()] = r; });
    const tagMeta = {
      "存股型": { cls:"cat-value",  label:"存股型", sort:"yield" },
      "成長型": { cls:"cat-growth", label:"成長型", sort:"growth" },
      "均衡型": { cls:"cat-balance",label:"均衡型", sort:"balance" }
    };

    // 從每張卡的 row 抽數值,供第七版排序使用
    function metricFor(p, row, key){
      if(!row) return null;
      let yieldVal=null, yoyVal=null, momVal=null, epsVal=null;
      for(const [k,v] of Object.entries(row)){
        const num = parseFloat(String(v).replace(/[^\d.\-]/g,""));
        if(!isFinite(num)) continue;
        if(/殖利率/.test(k) && yieldVal == null) yieldVal = num;
        else if(/年增/.test(k) && yoyVal == null) yoyVal = num;
        else if(/月增/.test(k) && momVal == null) momVal = num;
        else if(/^EPS/.test(k) && epsVal == null) epsVal = num;
      }
      if(key === "yield")  return yieldVal;
      if(key === "growth") return Math.max(yoyVal || 0, momVal || 0, epsVal || 0);
      if(key === "balance")return Math.max(yieldVal || 0, epsVal || 0, yoyVal || 0);
      return null;
    }

    function deriveAndSort(rules){
      const tagged = picks.map((p, i) => {
        const code = String(p.code || "").trim();
        const row = byCode[code];
        const tag = deriveTagWithRules(p.category, row, rules);
        const meta = tagMeta[tag] || tagMeta["均衡型"];
        return { p, idx:i, tag, meta, metric: metricFor(p, row, meta.sort) };
      });
      // 同分類內依代表指標由高到低;若指標為 null,排到最後
      const order = { "存股型":0, "均衡型":1, "成長型":2 };
      tagged.sort((a,b) => {
        const oa = order[a.tag] ?? 99, ob = order[b.tag] ?? 99;
        if(oa !== ob) return oa - ob;
        const ma = a.metric == null ? -Infinity : a.metric;
        const mb = b.metric == null ? -Infinity : b.metric;
        return mb - ma;
      });
      // 重新編號(分類內排名)
      let curIdx = 0;
      tagged.forEach(t => { t.idx = curIdx++; });
      return tagged;
    }
    let tagged = deriveAndSort(window.__tagRules);
    const counts = { "存股型":0, "成長型":0, "均衡型":0 };
    tagged.forEach(t => { counts[t.tag] = (counts[t.tag]||0)+1; });
    const totalPct = (n) => tagged.length ? Math.round(n / tagged.length * 100) : 0;

    const toolbar = `
      <div class="ai-thresholds" role="group" aria-label="分類門檻">
        <label class="th-label">殖利率 ≥ <input type="number" step="0.5" id="thrYield" value="${window.__tagRules.yieldGood}">%<span class="th-hint">才算存股訊號</span></label>
        <label class="th-label">營收年增 ≥ <input type="number" step="1" id="thrYoy" value="${window.__tagRules.revYoyGood}">%<span class="th-hint">才算成長訊號</span></label>
        <label class="th-label">單月月增 ≥ <input type="number" step="1" id="thrMom" value="${window.__tagRules.revMomGood}">%<span class="th-hint">才算成長訊號</span></label>
        <label class="th-label">EPS ≥ <input type="number" step="0.5" id="thrEps" value="${window.__tagRules.epsGood}">元<span class="th-hint">才算成長訊號</span></label>
        <div class="th-row">
          <button class="th-btn" id="thrResetBtn">↺ 恢復預設門檻</button>
          <span class="th-hint">改完輸入欄位,分類會即時重新計算並重新排序。</span>
        </div>
      </div>`;

    const summary = `
      <div class="ai-summary" id="aiSummary">
        <span class="sum-item"><span class="legend-dot value"></span><strong>${counts["存股型"]}</strong> 檔存股型(${totalPct(counts["存股型"])}%)</span>
        <span class="sum-item"><span class="legend-dot balance"></span><strong>${counts["均衡型"]}</strong> 檔均衡型(${totalPct(counts["均衡型"])}%)</span>
        <span class="sum-item"><span class="legend-dot growth"></span><strong>${counts["成長型"]}</strong> 檔成長型(${totalPct(counts["成長型"])}%)</span>
        <span class="sum-item">依送進 AI 的欄位數值 · 共 ${tagged.length} 檔 · 候選池 ${poolSize}</span>
      </div>`;

    const filterBar = `
      <div class="ai-toolbar">
        <span class="tb-label">分類標籤：</span>
        <button class="ai-cat-btn active" data-cat="全部" data-filter="all">全部<span class="ai-cat-count">${tagged.length}</span></button>
        <button class="ai-cat-btn" data-cat="存股型" data-filter="value">🟢 存股型<span class="ai-cat-count">${counts["存股型"]}</span></button>
        <button class="ai-cat-btn" data-cat="均衡型" data-filter="balance">⚪ 均衡型<span class="ai-cat-count">${counts["均衡型"]}</span></button>
        <button class="ai-cat-btn" data-cat="成長型" data-filter="growth">🟠 成長型<span class="ai-cat-count">${counts["成長型"]}</span></button>
      </div>
      <div class="ai-legend">
        <span class="legend-item"><span class="legend-dot value"></span>存股型：高殖利率、穩定配息、注重現金流</span>
        <span class="legend-item"><span class="legend-dot growth"></span>成長型：營收或獲利高速成長、著眼未來</span>
        <span class="legend-item"><span class="legend-dot balance"></span>均衡型：兩者訊號並存或無法明確歸類</span>
      </div>`;

    modalBox.innerHTML = `
      <div class="modal-head">
        <div class="title-block"><h2>🤖 AI 財報分析－推薦 20 檔（含分類標籤 + 可調門檻）</h2></div>
        <button class="modal-close" id="modalCloseBtn">✕</button>
      </div>
      <div class="modal-body">
        <div class="ai-disclaimer">⚠ ${disclaimer}</div>
        ${toolbar}
        ${summary}
        ${filterBar}
        <div id="aiPickList"></div>
      </div>`;
    $("#modalCloseBtn").addEventListener("click", closeStockDetail);

    function renderList(filter){
      const visible = (filter && filter !== "all") ? tagged.filter(t => {
        if(filter === "value") return t.tag === "存股型";
        if(filter === "growth") return t.tag === "成長型";
        if(filter === "balance") return t.tag === "均衡型";
        return true;
      }) : tagged;
      const list = visible.length ? visible.map(t => `
        <div class="ai-pick" data-cat="${t.tag}">
          <div class="pick-head">
            <div>
              <span class="pick-rank">#${t.idx+1}</span>
              <span class="pick-name">${escapeHtml(t.p.name||"")}</span>
              <span class="pick-code">${escapeHtml(t.p.code||"")}</span>
              <span class="pick-tag ${t.meta.cls}">${t.meta.label}</span>
            </div>
          </div>
          <div class="pick-reason">${escapeHtml(t.p.reason||"")}</div>
        </div>
      `).join("") : '<div class="ai-tag-empty">此分類目前沒有推薦檔案,可切換其他標籤查看,或調低上方門檻再試試。</div>';
      const target = document.getElementById("aiPickList");
      if(target) target.innerHTML = list;
    }
    renderList("all");

    // 第七版:門檻即時生效 + 重置按鈕
    function readInputs(){
      const n = (id, fallback) => {
        const el = document.getElementById(id);
        if(!el) return fallback;
        const v = parseFloat(el.value);
        return isFinite(v) ? v : fallback;
      };
      return {
        yieldGood:  n("thrYield", window.__tagRules.yieldGood),
        revYoyGood: n("thrYoy",   window.__tagRules.revYoyGood),
        revMomGood: n("thrMom",   window.__tagRules.revMomGood),
        epsGood:    n("thrEps",   window.__tagRules.epsGood)
      };
    }
    function applyThresholds(){
      window.__tagRules = readInputs();
      tagged = deriveAndSort(window.__tagRules);
      ["存股型","均衡型","成長型"].forEach(k => counts[k] = 0);
      tagged.forEach(t => counts[t.tag]++);
      // refresh counts on filter buttons
      const btns = modalBox.querySelectorAll(".ai-cat-btn");
      btns.forEach(b => {
        const f = b.dataset.filter;
        const span = b.querySelector(".ai-cat-count");
        if(!span) return;
        if(f === "all") span.textContent = tagged.length;
        else if(f === "value")  span.textContent = counts["存股型"];
        else if(f === "balance")span.textContent = counts["均衡型"];
        else if(f === "growth") span.textContent = counts["成長型"];
      });
      // refresh summary
      const sum = document.getElementById("aiSummary");
      if(sum){
        sum.innerHTML = `
          <span class="sum-item"><span class="legend-dot value"></span><strong>${counts["存股型"]}</strong> 檔存股型(${totalPct(counts["存股型"])}%)</span>
          <span class="sum-item"><span class="legend-dot balance"></span><strong>${counts["均衡型"]}</strong> 檔均衡型(${totalPct(counts["均衡型"])}%)</span>
          <span class="sum-item"><span class="legend-dot growth"></span><strong>${counts["成長型"]}</strong> 檔成長型(${totalPct(counts["成長型"])}%)</span>
          <span class="sum-item">即時重算 · 共 ${tagged.length} 檔 · 候選池 ${poolSize}</span>
        `;
      }
      // Always re-render the visible list with the previously active filter
      const active = modalBox.querySelector(".ai-cat-btn.active");
      const f = active ? active.dataset.filter : "all";
      renderList(f);
    }
    ["thrYield","thrYoy","thrMom","thrEps"].forEach(id => {
      const el = document.getElementById(id);
      if(!el) return;
      el.addEventListener("input", applyThresholds);
      el.addEventListener("change", applyThresholds);
    });
    document.getElementById("thrResetBtn")?.addEventListener("click", () => {
      window.__tagRules = { yieldGood: TAG_RULES.yieldGood, revYoyGood: TAG_RULES.revYoyGood,
                            revMomGood: TAG_RULES.revMomGood, epsGood: TAG_RULES.epsGood };
      const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
      setVal("thrYield", TAG_RULES.yieldGood);
      setVal("thrYoy",   TAG_RULES.revYoyGood);
      setVal("thrMom",   TAG_RULES.revMomGood);
      setVal("thrEps",   TAG_RULES.epsGood);
      applyThresholds();
    });

    modalBox.querySelectorAll(".ai-cat-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        modalBox.querySelectorAll(".ai-cat-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderList(btn.dataset.filter);
      });
    });
  }

  $("#aiAnalyzeBtn").addEventListener("click", runAIAnalysis);

  modalOverlay.addEventListener("click", (e) => {
    if(e.target === modalOverlay) closeStockDetail();
  });
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape") closeStockDetail();
  });

  tableScroll.addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-page-action]");
    if(pageBtn){
      if(pageBtn.disabled) return;
      const action = pageBtn.dataset.pageAction;
      if(action === "first") tablePager.page = 1;
      else if(action === "prev") tablePager.page -= 1;
      else if(action === "next") tablePager.page += 1;
      else if(action === "last") tablePager.page = Infinity;
      render();
      return;
    }
    const nameCell = e.target.closest("[data-open-detail]");
    if(nameCell){
      openStockDetail(nameCell.getAttribute("data-open-detail"));
      return;
    }
    const th = e.target.closest("[data-sort]");
    if(!th) return;
    const key = th.getAttribute("data-sort");
    if(sortState.key === key){
      sortState.dir *= -1;
    }else{
      sortState.key = key;
      sortState.dir = 1;
    }
    tablePager.page = 1; // 換排序時回到第一頁
    render();
  });

  // ---------- events ----------
  $("#pickBtn").addEventListener("click", () => fileInput.click());
  $("#fetchRatiosBtn").addEventListener("click", fetchOfficialRatios);
  $("#fetchEpsBtn").addEventListener("click", fetchOfficialEPS);
  $("#fetchEquityBtn").addEventListener("click", fetchOfficialEquity);
  fileInput.addEventListener("change", (e) => { handleFiles(e.target.files); fileInput.value=""; });

  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
    handleFiles(e.dataTransfer.files);
  });

  $("#clearBtn").addEventListener("click", clearAll);
  $("#exportBtn").addEventListener("click", exportCsv);
  $("#backupExportBtn").addEventListener("click", exportBackup);
  $("#backupImportBtn").addEventListener("click", () => $("#backupFileInput").click());
  $("#backupFileInput").addEventListener("change", (e) => {
    if(e.target.files && e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = "";
  });
  searchInput.addEventListener("input", debounce(() => { tablePager.page = 1; render(); }, 250));
  $("#scoreFilter").addEventListener("change", () => { tablePager.page = 1; render(); });
  $("#limitFilter").addEventListener("change", () => { tablePager.page = 1; render(); });

  $("#top100Btn").addEventListener("click", async () => {
    if(Object.keys(state.categories).length === 0){
      showToast("請先匯入資料再產生排行榜");
      return;
    }
    // Auto-detect which imported categories contain the fields needed for the leaderboard,
    // and select just those fields (rather than every column) so the table stays readable.
    const wanted = [
      /^EPS\(/,            // EPS(元)
      /^ROE\(%\)$/,        // ROE(%)
      /^現金股利$/,         // 最新配息(現金)
      /^合計股利$/,         // 最新配息(合計)
      /殖利率/,             // 各類殖利率欄位
      /每股淨值|BVPS/i,     // 用來算淨值比
      /股東權益/,           // 股東權益
      /三大法人.*(持股|占比)/, // 三大法人合計持股占比
      /^外資持股\(%\)$/,    // 沒有三大法人合計資料時的備選
      /^成交張數$/,
      /K值|D值/,            // KD 技術指標
    ];
    let matchedAny = false;
    for(const [catName, cat] of Object.entries(state.categories)){
      const matchedFields = cat.columns.filter(col => !/排名/.test(col) && wanted.some(re => re.test(col)));
      if(matchedFields.length){
        matchedAny = true;
        state.ui.fields[catName] = matchedFields;
        if(!state.ui.activeCats.includes(catName)) state.ui.activeCats.push(catName);
      }
    }
    if(!matchedAny){
      showToast("目前匯入的檔案裡找不到可用的排行榜欄位");
      return;
    }
    state.ui.showPE = true;
    state.ui.showPB = true;
    sortState = { key: null, dir: 1 }; // fall back to default score-desc sort
    $("#limitFilter").value = "100";
    $("#scoreFilter").value = "0";
    searchInput.value = "";
    await saveState();
    render();
    showToast("已產生 Top 100 排行榜（依達標評分排序）", 4000);
  });

  chipRow.addEventListener("change", async (e) => {
    if(e.target.matches("input[data-cat]")){
      const cat = e.target.getAttribute("data-cat");
      if(e.target.checked){
        if(!state.ui.activeCats.includes(cat)) state.ui.activeCats.push(cat);
        // checking the whole category re-selects all its fields
        state.ui.fields[cat] = (state.categories[cat] && state.categories[cat].columns.slice()) || [];
      }else{
        state.ui.activeCats = state.ui.activeCats.filter(c => c !== cat);
      }
      await saveState();
      render();
    }
    if(e.target.matches("input[data-field-cat]")){
      const cat = e.target.getAttribute("data-field-cat");
      const field = e.target.getAttribute("data-field-name");
      if(!state.ui.fields[cat]) state.ui.fields[cat] = (state.categories[cat] && state.categories[cat].columns.slice()) || [];
      if(e.target.checked){
        if(!state.ui.fields[cat].includes(field)) state.ui.fields[cat].push(field);
      }else{
        state.ui.fields[cat] = state.ui.fields[cat].filter(f => f !== field);
      }
      // auto-activate the category once at least one field is selected
      if(state.ui.fields[cat].length > 0 && !state.ui.activeCats.includes(cat)){
        state.ui.activeCats.push(cat);
      }
      await saveState();
      render();
    }
  });
  chipRow.addEventListener("click", async (e) => {
    if(e.target.matches("[data-remove]")){
      removeCategory(e.target.getAttribute("data-remove"));
    }
    if(e.target.matches("[data-rename]")){
      renameCategory(e.target.getAttribute("data-rename"));
    }
    if(e.target.matches("[data-toggle-expand]")){
      const cat = e.target.getAttribute("data-toggle-expand");
      state.ui.expanded[cat] = !state.ui.expanded[cat];
      render(); // expand/collapse is view-only, no need to persist to storage
    }
  });

  // ---------- init ----------
  (async function init(){
    await loadTheme();
    await loadState();
    await loadWorkerUrl();
    render();
  })();
