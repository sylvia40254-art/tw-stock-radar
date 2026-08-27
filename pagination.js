/* ============================================================
   pagination.js — 大量資料表格的分頁工具
   原本「資料彙整」與「排行榜」分頁，會把上千檔股票一次全部渲染
   進 DOM，瀏覽器在組 innerHTML／reflow 時會明顯卡頓。
   這裡提供一個很單純的分頁狀態機 + 頁碼列 HTML 產生器，
   render() 只要改成「先 slice 出當前頁的資料再組 HTML」即可，
   不需要引入額外的虛擬捲動套件。
   ============================================================ */

export function createPager(pageSize) {
  return { page: 1, pageSize };
}

/** 依目前頁碼，從完整清單裡切出這一頁要渲染的資料 */
export function paginate(list, pager) {
  const totalPages = Math.max(1, Math.ceil(list.length / pager.pageSize));
  if (pager.page > totalPages) pager.page = totalPages;
  if (pager.page < 1) pager.page = 1;
  const start = (pager.page - 1) * pager.pageSize;
  return {
    pageItems: list.slice(start, start + pager.pageSize),
    totalPages,
    totalCount: list.length,
    start,
  };
}

/** 產生「上一頁 1/N 下一頁」控制列的 HTML，data-page-action 供外部綁事件 */
export function pagerControlsHtml(pager, totalPages, idPrefix) {
  if (totalPages <= 1) return "";
  return `
    <div class="pager-bar" id="${idPrefix}-pager">
      <button type="button" data-page-action="first" ${pager.page <= 1 ? "disabled" : ""}>«</button>
      <button type="button" data-page-action="prev" ${pager.page <= 1 ? "disabled" : ""}>‹ 上一頁</button>
      <span class="pager-status">第 ${pager.page} / ${totalPages} 頁</span>
      <button type="button" data-page-action="next" ${pager.page >= totalPages ? "disabled" : ""}>下一頁 ›</button>
      <button type="button" data-page-action="last" ${pager.page >= totalPages ? "disabled" : ""}>»</button>
    </div>`;
}

/** 綁定分頁列的點擊事件（用事件代理，容器重繪後不需要重新綁定） */
export function bindPagerEvents(container, pager, rerenderFn) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-page-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.pageAction;
    if (action === "first") pager.page = 1;
    else if (action === "prev") pager.page -= 1;
    else if (action === "next") pager.page += 1;
    else if (action === "last") pager.page = Infinity; // paginate() 會夾回最大頁
    rerenderFn();
  });
}
