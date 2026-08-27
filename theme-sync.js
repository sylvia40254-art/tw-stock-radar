/* ============================================================
   theme-sync.js — 讓「股票查詢頁」與「資料彙整站」共用同一套視覺主題

   原本兩邊各自用不同機制切換深色/淺色:
     - 股票查詢頁: setTheme() 只切換 <body class="theme-light">
     - 資料彙整站: applyTheme() 只切換 <html data-theme="light">
   兩邊的 CSS 剛好各自只認自己那一種標記,所以只按其中一邊的主題
   按鈕,另一個分頁的顏色不會跟著換,使用者切換一次要按兩次鈕。

   這裡提供一個共用函式,兩邊的 setTheme/applyTheme 都改成呼叫它,
   一次把 <body> 的 class 與 <html> 的 data-theme 屬性都設好,
   兩邊的 CSS 變數(全域 :root 與 #page-aggregate 內的 --agg-* 系列)
   就會同時切換。
   ============================================================ */

export function applyBothThemeMechanisms(mode) {
  const isLight = mode === "light";
  document.body.classList.toggle("theme-light", isLight);
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
}
