// Total Portfolio summary.
//
// Builds a single value-weighted daily-return series across every deployed
// symphony, then runs it through the SAME quantstats path used for each
// individual symphony row (addQuantstatsToSymphony). The result is a real
// portfolio-level stats dict (same keys as a symphony's addedStats), so the
// "Total Portfolio" row can populate whichever extra columns the user has
// selected — identical metric semantics to the rows below it.
//
// Weighting: each symphony's daily return is weighted by its CURRENT dollar
// value (symphony.value), normalized per-day across whichever symphonies have
// a return on that date. This is a current-allocation view (same spirit as
// Active CAGR): it applies today's weights across all of history, so it's a
// portfolio-behavior estimate, not an exact realized account record.

import { addQuantstatsToSymphony } from "./liveSymphonyPerformance.js";
import { log } from "./logger.js";

// Pull this symphony's current dollar value for weighting. Fall back through
// the fields Composer populates so a missing one doesn't zero out the weight.
function symphonyWeight(symphony) {
  const v =
    symphony?.value ??
    symphony?.deposit_adjusted_value ??
    symphony?.dailyChanges?.series?.[symphony.dailyChanges.series.length - 1];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Combine per-symphony daily returns into one value-weighted series.
// Returns { epoch_ms: number[], percentageReturns: [{dateString, percentChange}] }
// sorted ascending by date, or null if there isn't enough data.
//
// Different running lengths are handled naturally: each calendar day only
// averages in the symphonies that actually have a return on that day, so a
// strategy added last week contributes only to its recent days, while the
// oldest symphony anchors the start of the combined timeline.
function buildWeightedReturnSeries(symphonies) {
  // date -> { weightedSum, weightTotal }
  const byDate = new Map();

  for (const s of symphonies) {
    const w = symphonyWeight(s);
    if (w <= 0) continue;
    const rets = s?.dailyChanges?.percentageReturns;
    if (!Array.isArray(rets) || rets.length === 0) continue;

    for (const r of rets) {
      const d = r?.dateString;
      const pc = r?.percentChange;
      if (!d || typeof pc !== "number" || !isFinite(pc)) continue;
      let bucket = byDate.get(d);
      if (!bucket) {
        bucket = { weightedSum: 0, weightTotal: 0 };
        byDate.set(d, bucket);
      }
      bucket.weightedSum += w * pc;
      bucket.weightTotal += w;
    }
  }

  if (byDate.size < 2) return null;

  const dates = [...byDate.keys()].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );

  const percentageReturns = [];
  const epoch_ms = [];
  for (const d of dates) {
    const { weightedSum, weightTotal } = byDate.get(d);
    if (weightTotal <= 0) continue;
    percentageReturns.push({ dateString: d, percentChange: weightedSum / weightTotal });
    epoch_ms.push(new Date(d).getTime());
  }

  if (percentageReturns.length < 2) return null;
  return { epoch_ms, percentageReturns };
}

// Compute portfolio-wide stats. Returns a stats dict (same keys as a
// symphony's addedStats), or null if it couldn't be computed.
export async function computeTotalPortfolioStats(symphonies) {
  if (!Array.isArray(symphonies) || symphonies.length === 0) return null;

  const series = buildWeightedReturnSeries(symphonies);
  if (!series) {
    log("[totalPortfolio] not enough data to compute portfolio stats");
    return null;
  }

  const lastDate = series.percentageReturns[series.percentageReturns.length - 1].dateString;
  // Vary the id by data signature so the worker's cache doesn't serve stale
  // numbers when the portfolio (or account) changes.
  const sig = `${series.percentageReturns.length}-${new Date(lastDate).getTime()}`;

  const pseudoSymphony = {
    id: `cqt-total-portfolio-${sig}`,
    name: "Total Portfolio",
    dailyChanges: {
      epoch_ms: series.epoch_ms,
      percentageReturns: series.percentageReturns,
    },
    addedStats: {},
  };

  try {
    // Same worker path as individual symphonies.
    await addQuantstatsToSymphony(pseudoSymphony, []);
  } catch (e) {
    log("[totalPortfolio] quantstats failed:", e);
    return null;
  }

  return pseudoSymphony.addedStats || null;
}
