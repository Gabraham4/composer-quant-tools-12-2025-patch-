// Table-specific logic for the portfolio page
import { performanceData, getSymphonyDailyChange, getAccountDeploys, getSymphonyStatsMeta, getSymphonyActivityHistory } from "../apiService.js";
import { addGeneratedSymphonyStatsToSymphony, addQuantstatsToSymphony, addGeneratedSymphonyStatsToSymphonyWithModifiedDietz } from "./liveSymphonyPerformance.js";
import { calculateActiveCagr, injectActiveCagrWithTooltip, injectActiveCagrLoadingPlaceholder } from "./portfolioCAGR.js";
import { computeTotalPortfolioStats } from "./portfolioSummary.js";
import { log } from "./logger.js";
import {
  setupNativeColumnListener,
  setupTableObserver,
  handleColumnSort,
  addSortIndicatorToHeader,
  isSortingEnabled,
} from "./tableSortUtil.js";

let extraColumns = [
  "Running Days",
  "Avg. Daily Return",
  "MTD",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "Win Days",
  "Best Day",
  "Worst Day",
];

export function setExtraColumns(columns) {
  extraColumns = columns;
}

export const startPortfolioTableInterval = async () => {
  const checkInterval = setInterval(async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const view = urlParams.get('view');
    if (window.location.pathname !== "/portfolio" || (view && view !== 'symphonies')) return;
    const mainTable = document.querySelector("main :not(.tv-lightweight-charts) > table");
    const mainTableContent = document.querySelectorAll("main :not(.tv-lightweight-charts) > table td");
    if (!mainTable) return;
    if (mainTable.classList.contains('composer-quant-tools-initialized')) {
      const hasAnyExtraColumns = mainTable.querySelector('.extra-column');
      if (!hasAnyExtraColumns) {
        mainTable.classList.remove('composer-quant-tools-initialized');
      }
    }
    if (!mainTable.classList.contains('composer-quant-tools-initialized')) {
      if (mainTableContent?.length > 0) {
        mainTable.classList.add('composer-quant-tools-initialized');
        await startSymphonyPerformanceSync(mainTable);
      }
      return;
    }
    if (performanceData?.symphonyStats?.symphonies?.length > 0) {
      const mainTableBody = mainTable.querySelector("tbody");
      const rows = mainTableBody?.querySelectorAll("tr");
      if (rows?.length > 0) {
        const needsUpdate = Array.from(rows).some(row => {
          const columnCells = row.querySelectorAll('.extra-column');
          return columnCells.length !== extraColumns.length;
        });
        if (needsUpdate) {
          updateColumns(mainTable, extraColumns);
          updateTableRows();
        }
      }
    }
  }, 1000);
  window.addEventListener('unload', () => {
    clearInterval(checkInterval);
  });
};

export const startSymphonyPerformanceSync = async (mainTable) => {
  updateColumns(mainTable, extraColumns);
  setupNativeColumnListener(updateTableRows);
  setupTableObserver(); // Watch for Composer updates to re-apply our sort

  // Show loading placeholder for Active CAGR while data loads (if enabled)
  const cagrStorageResult = await chrome.storage.local.get(['enableCagrReturns']);
  const enableCagrReturns = cagrStorageResult?.enableCagrReturns ?? false;
  if (enableCagrReturns) {
    injectActiveCagrLoadingPlaceholder();
  }

  const data = await getSymphonyPerformanceInfo({
    onSymphonyCallback: extendSymphonyStatsRow,
    skipCache: true,
  });
  if (!data) {
    log("no symphony performance data found");
    return;
  }
  chrome.runtime.sendMessage({
    action: "processSymphonies",
    performanceData: data
  }, (response) => {
    if (response.success) {
      log("symphony performance data processed", response.data);
    } else {
      log("error processing symphony performance data", response.error);
    }
  });
  updateTableRows();
  log("all symphony stats added", performanceData);

  // Calculate and inject Active CAGR after all symphony stats are loaded (if enabled)
  if (enableCagrReturns) {
    const activeCagrStats = calculateActiveCagr();
    if (activeCagrStats) {
      injectActiveCagrWithTooltip(activeCagrStats);
    }
  }

  // Render the portfolio-wide "Total Portfolio" summary row.
  await renderTotalPortfolioRow(mainTable);
};

const TwelveHours = 12 * 60 * 60 * 1000; // this should only update once per day ish base on a normal user's usage. It could happen multiple times if multiple windows are open. or if the user is refreshing every 12 hours.
let performanceDataFetchedAt = Date.now() - TwelveHours;
export async function getSymphonyPerformanceInfo(options = {}) {
  const onSymphonyCallback = options.onSymphonyCallback;
  // if the last call options are the same as the current call options and was less than 2 hours ago, return the cached data
  if (performanceDataFetchedAt >= Date.now() - TwelveHours && !options.skipCache) {
    for (const symphony of performanceData.symphonyStats.symphonies) {
      onSymphonyCallback?.(symphony);
    }
    return performanceData;
  }
  try {
    // const accountDeploys = await getAccountDeploys();
    const symphonyStats = await getSymphonyStatsMeta();

    // performanceData.accountDeploys = accountDeploys;
    performanceData.symphonyStats = symphonyStats;

    // Process symphonies in batches
    const batchSize = 5; // Process 5 symphonies at a time
    const symphonies = [...symphonyStats.symphonies];

    // Process symphonies in batches
    for (let i = 0; i < symphonies.length; i += batchSize) {
      const batch = symphonies.slice(i, i + batchSize);

      // Process each batch in parallel
      await Promise.all(batch.map(async (symphony) => {
        try {
          symphony.dailyChanges = await getSymphonyDailyChange(
            symphony.id,
            TwelveHours
          );

          const symphonyActivityHistory = await getSymphonyActivityHistory(symphony.id);

          // addGeneratedSymphonyStatsToSymphony(symphony, []);
          addGeneratedSymphonyStatsToSymphonyWithModifiedDietz(symphony, symphonyActivityHistory);
          await addQuantstatsToSymphony(symphony, []);

          // Update the symphony in the performanceData
          const symphonyIndex = performanceData.symphonyStats.symphonies.findIndex(s => s.id === symphony.id);
          if (symphonyIndex !== -1) {
            performanceData.symphonyStats.symphonies[symphonyIndex] = symphony;
          }

          // Call the callback if provided
          onSymphonyCallback?.(symphony);
        } catch (error) {
          log(
            "Error adding stats to symphony",
            symphony?.id,
            symphony?.name,
            error,
          );
        }
      }));
    }
    
    // Update the timestamp to indicate successful data fetch
    performanceDataFetchedAt = Date.now();

    return performanceData;
  } catch (error) {
    log("Error getting symphony performance info", error);
  }
}

// Helper to extract symphony ID from a row (handles various row states)
function getSymphonyIdFromRow(row) {
  // Primary: Try to get ID from the symphony link in first cell
  const primaryLink = row.querySelector("td:first-child a[href*='/symphony/']");
  if (primaryLink) {
    const match = primaryLink.href.match(/\/symphony\/([^\/]+)/);
    if (match) return match[1];
  }

  // Fallback: Look for any symphony link in the row (handles pending trades, liquidations, etc.)
  const anyLink = row.querySelector("a[href*='/symphony/']");
  if (anyLink) {
    const match = anyLink.href.match(/\/symphony\/([^\/]+)/);
    if (match) return match[1];
  }

  // Final fallback: Check for data attributes that might store the ID
  const dataId = row.dataset?.symphonyId || row.querySelector("[data-symphony-id]")?.dataset?.symphonyId;
  if (dataId) return dataId;

  return null;
}

export function updateTableRows() {
  const mainTableBody = document.querySelector("main :not(.tv-lightweight-charts) > table tbody");
  const rows = mainTableBody?.querySelectorAll("tr");
  performanceData?.symphonyStats?.symphonies?.forEach?.((symphony) => {
    if (symphony.addedStats) {
      for (let row of rows) {
        if (row.classList.contains("cqt-total-portfolio-row")) continue;
        // Use robust ID extraction that handles various row states
        const symphonyId = getSymphonyIdFromRow(row);
        if (symphonyId == symphony.id) {
          updateRowStats(row, symphony.addedStats);
          break;
        }
      }
    }
  });

  // Re-assert the Total Portfolio summary row if Composer re-rendered the tbody
  // and wiped it (stats are cached from the initial compute).
  if (totalPortfolioStats && !document.querySelector("tr.cqt-total-portfolio-row")) {
    injectTotalPortfolioRow();
  }
}

export function extendSymphonyStatsRow(symphony) {
  const mainTableBody = document.querySelector("main :not(.tv-lightweight-charts) > table tbody");
  const rows = mainTableBody?.querySelectorAll("tr");
  for (let row of rows) {
    // Use robust ID extraction that handles various row states
    const symphonyId = getSymphonyIdFromRow(row);
    if (symphonyId == symphony.id && symphony.addedStats) {
      updateRowStats(row, symphony.addedStats);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Total Portfolio summary row
// ---------------------------------------------------------------------------

let totalPortfolioStats = null;

// Compute portfolio-wide stats from all loaded symphonies, then render/refresh
// the pinned "TOTAL PORTFOLIO" row at the top of the table.
export async function renderTotalPortfolioRow(mainTable) {
  try {
    const symphonies = performanceData?.symphonyStats?.symphonies || [];
    if (!symphonies.length) return;
    const stats = await computeTotalPortfolioStats(symphonies);
    if (!stats) return;
    totalPortfolioStats = stats;
    injectTotalPortfolioRow(mainTable);
  } catch (e) {
    log("Error rendering Total Portfolio row", e);
  }
}

// "TOTAL PORTFOLIO" label + a (?) badge that reveals an explanation on hover.
// Self-contained inline styles + a fixed-position tooltip so it doesn't depend
// on app CSS and never gets clipped by the table's overflow.
const TOTAL_PORTFOLIO_TOOLTIP =
  "Whole-book summary built from the daily returns of ALL your symphonies.\n\n" +
  "• Each day uses only the symphonies that existed that day, so strategies " +
  "of different ages mix fine (the row's Running Days = your longest-running symphony).\n" +
  "• Each symphony's daily return is weighted by its CURRENT dollar value, then " +
  "averaged into one portfolio return per day.\n" +
  "• That combined daily series is run through the same stats engine as each " +
  "row, so every metric means the same thing — just for the whole book.\n\n" +
  "Note: it applies today's allocation across all history. It's a portfolio-" +
  "behavior estimate, not an exact realized account record.";

function buildTotalPortfolioLabel() {
  const wrap = document.createElement("span");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;";

  const label = document.createElement("span");
  label.textContent = "TOTAL PORTFOLIO";
  wrap.appendChild(label);

  const badge = document.createElement("span");
  badge.textContent = "?";
  badge.style.cssText = [
    "display:inline-flex", "align-items:center", "justify-content:center",
    "width:15px", "height:15px", "border-radius:50%",
    "border:1px solid rgba(0,0,0,0.35)", "color:rgba(0,0,0,0.55)",
    "font-size:10px", "font-weight:700", "line-height:1", "cursor:help",
    "user-select:none", "flex:none",
  ].join(";");
  wrap.appendChild(badge);

  let tip = null;
  const show = () => {
    if (tip) return;
    tip = document.createElement("div");
    tip.textContent = TOTAL_PORTFOLIO_TOOLTIP;
    tip.style.cssText = [
      "position:fixed", "z-index:99999", "max-width:360px",
      "white-space:pre-wrap", "background:rgba(20,22,28,0.98)", "color:#fff",
      "padding:12px 14px", "border-radius:8px", "font-size:12px",
      "font-weight:400", "line-height:1.5", "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(tip);
    const r = badge.getBoundingClientRect();
    let left = r.right + 10;
    let top = r.top;
    const tr = tip.getBoundingClientRect();
    if (left + tr.width > window.innerWidth - 10) left = r.left - tr.width - 10;
    if (left < 10) left = 10;
    if (top + tr.height > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - tr.height - 10);
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => { tip?.remove(); tip = null; };
  badge.addEventListener("mouseenter", show);
  badge.addEventListener("mouseleave", hide);

  return wrap;
}

// Build (or rebuild) the summary row. Idempotent: removes any prior one first.
// Populates ONLY the user's currently-selected extraColumns, with the same cell
// markup as a normal row so widths/alignment match.
export function injectTotalPortfolioRow(mainTable) {
  if (!totalPortfolioStats) return;
  const table = mainTable || document.querySelector("main :not(.tv-lightweight-charts) > table");
  const tbody = table?.querySelector("tbody");
  if (!tbody) return;

  // Use a real row as a structural template so the leading (native) cells line up.
  const templateRow = tbody.querySelector("tr:not(.cqt-total-portfolio-row)");
  if (!templateRow) return;

  tbody.querySelector("tr.cqt-total-portfolio-row")?.remove();

  const row = document.createElement("tr");
  row.className = templateRow.className + " cqt-total-portfolio-row";
  row.style.borderBottom = "2px solid rgba(0,0,0,0.15)";
  row.style.background = "rgba(59,130,246,0.06)";
  row.style.fontWeight = "600";

  // Recreate the native (non-extra) leading cells as blanks, except the first
  // one which gets the "TOTAL PORTFOLIO" label + (?) tooltip.
  const nativeCells = templateRow.querySelectorAll("td:not(.extra-column)");
  nativeCells.forEach((tmpl, i) => {
    const td = document.createElement("td");
    td.className = tmpl.className;
    if (i === 0) {
      td.appendChild(buildTotalPortfolioLabel());
      td.style.fontWeight = "700";
    }
    row.appendChild(td);
  });

  // Then the extra-column cells, same order/keys as everything else, so only
  // currently-selected metrics get values.
  extraColumns.forEach((key) => {
    const cell = document.createElement("td");
    cell.className = "table-cell flex py-4 truncate w-[160px] extra-column font-medium text-[14px] items-center justify-start";
    cell.dataset.key = key;
    const value = totalPortfolioStats[key];
    if (value === null || value === undefined || value === "-" || value === "—") {
      cell.innerHTML = '<span class="text-black/40">—</span>';
    } else {
      cell.textContent = value;
    }
    row.appendChild(cell);
  });

  tbody.insertBefore(row, tbody.firstChild);
}

export function updateRowStats(row, addedStats) {
  extraColumns.forEach((key, index) => {
    let value = addedStats[key];
    let cell = row.querySelector(`.extra-column[data-key="${key}"]`);
    if (!cell) {
      cell = document.createElement("td");
      cell.className = "table-cell flex py-4 truncate w-[160px] extra-column font-medium text-[14px] items-center justify-start";
      cell.dataset.key = key;
      const rowWrapper = row.querySelector("td:last-child").parentElement;
      rowWrapper.append(cell);
    }
    
    if (value === null || value === undefined || value === "-" || value === "—") {
      cell.innerHTML = '<span class="text-black/40">—</span>';
    } else {
      cell.textContent = value;
    }
  });
}

export function updateColumns(mainTable, extraColumns) {
  const theadFirstRow = mainTable?.querySelector("thead tr");
  mainTable.querySelectorAll('.extra-column').forEach(element => {
    element.remove();
  });
  extraColumns.forEach((columnName, index) => {
    let th = theadFirstRow.querySelector(`.extra-column[data-key="${columnName}"]`);
    if (!th) {
      th = document.createElement("th");
      th.className = "group relative font-normal select-none text-left text-xs whitespace-nowrap flex items-center gap-x-1 w-[160px] extra-column group cursor-pointer";
      th.dataset.key = columnName;

      th.innerHTML = `
        <span class="inline-flex items-center">
          <span class="text-dark/70">${columnName}</span>
          <div class="ml-1 shrink-0 sort-arrows">
            <span class="text-dark/30 arrow-up">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="currentColor" viewBox="0 0 256 256">
                <path d="M215.39,163.06A8,8,0,0,1,208,168H48a8,8,0,0,1-5.66-13.66l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,215.39,163.06Z"></path>
              </svg>
            </span>
            <span class="text-dark/30 arrow-down">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="currentColor" viewBox="0 0 256 256" class="-mt-[5px]">
                <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,48,88H208a8,8,0,0,1,5.66,13.66Z"></path>
              </svg>
            </span>
          </div>
        </span>
      `;

      // Only add cursor/click handler if sorting is enabled
      if (isSortingEnabled()) {
        // Add click handler for sorting
        th.addEventListener('click', () => {
          handleColumnSort(th.dataset.key);
        });
      }

      const theadRowWrapper = theadFirstRow.querySelector("th:last-child").parentElement;
      theadRowWrapper.append(th);
    }

    // Add sort indicator arrow (only if sorting is enabled)
    if (isSortingEnabled()) {
      addSortIndicatorToHeader(th, columnName);
    }
  });
}

export function onScrollUpdateTableHeaderAndNav() {
  const urlParams = new URLSearchParams(window.location.search);
  const view = urlParams.get('view');
  if (window.location.pathname !== "/portfolio" || (view && view !== 'symphonies')) {
    return;
  }
  const mainTable = document.querySelector("main :not(.tv-lightweight-charts) > table");
  if (!mainTable) {
    return;
  }
  const nav = document.querySelector("nav");
  const mainTableHeader = mainTable.querySelector("thead");
  const headerRect = mainTableHeader.getBoundingClientRect();
  const scrollContainer = mainTable.closest('.overflow-x-scroll');
  const stickyTopValue = 62;
  const overflowXValue = parseInt(mainTableHeader.style.getPropertyValue('overflow-x'));
  const navPosition = nav.style.getPropertyValue('position');
  const mainTableHeaderPosition = mainTableHeader.style.getPropertyValue('position');
  if (scrollContainer) {
    if (headerRect.top <= stickyTopValue) {
      overflowXValue !== 'unset' && scrollContainer.style.setProperty('overflow-x', 'unset', 'important');
      navPosition !== 'fixed' && nav.style.setProperty('position', 'fixed');
      if(mainTableHeaderPosition !== 'sticky') {
        mainTableHeader.style.setProperty('position', 'sticky');
        mainTableHeader.style.setProperty('top', `${stickyTopValue}px`);
        mainTableHeader.style.setProperty('z-index', '400');
      }
    } else{
      overflowXValue !== 'scroll' && scrollContainer.style.removeProperty('overflow-x');
      navPosition === 'fixed' && nav.style.removeProperty('position');
      if(mainTableHeaderPosition === 'sticky') {
        mainTableHeader.style.removeProperty('position');
        mainTableHeader.style.removeProperty('top');
        mainTableHeader.style.removeProperty('z-index');
      }
    }
  }
}

export function setupScrollListener() {
  window.removeEventListener('scroll', onScrollUpdateTableHeaderAndNav);
  window.addEventListener('scroll', onScrollUpdateTableHeaderAndNav);
}

export function getElementsByText(str, tag = "a") {
  return Array.prototype.slice
    .call(document.getElementsByTagName(tag))
    .filter((el) => el.textContent.trim().includes(str.trim()));
} 