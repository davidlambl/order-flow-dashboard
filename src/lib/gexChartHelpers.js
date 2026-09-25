// src/lib/gexChartHelpers.js
// Geometry for the GEX-by-strike chart (roadmap F14). The strike axis is numeric, so the
// uneven spacing of listed strikes ($2.50 near the money, $5 further out) stays visible,
// tick labels are real strikes, and the reference levels (spot, cost basis, moving
// averages) sit at their exact price instead of snapping to the nearest strike.
// Pure and Node-loadable: scripts/verify/charts.mjs imports it directly.

/** Keys of the chart's reference lines, in drawing (and legend) order. */
const LEVEL_KEYS = ['spot', 'basis', 'sma50', 'sma200'];

/**
 * A price as a number. Numbers and numeric strings count; null, '', booleans and anything
 * else are NaN (Number(null) and Number('') would silently be 0, a bogus strike or level).
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/** The finite prices in `values`, ascending and without duplicates ([] for a non-array). */
function sortedPrices(values) {
  if (!Array.isArray(values)) return [];
  const nums = values.map(toNumber).filter(Number.isFinite).sort((a, b) => a - b);
  return nums.filter((v, i) => i === 0 || v !== nums[i - 1]);
}

/**
 * Tick values for the numeric strike axis. With at most `maxTicks` strikes, every strike;
 * otherwise the strikes nearest to `maxTicks` evenly spaced prices from the lowest to the
 * highest strike. Either way ticks are real strikes and always include both ends; spacing
 * them by price rather than by index keeps them even along the axis (index thinning
 * crowds them where strikes are dense, near the money).
 *
 * @param {Array<number|string>} strikes - strike prices in any order; non-numeric entries are ignored
 * @param {number} [maxTicks=8] - upper bound on the number of ticks; values below 2 count as 2
 * @returns {number[]} distinct strikes, ascending; [] when there are none
 */
export function gexAxisTicks(strikes, maxTicks = 8) {
  const sorted = sortedPrices(strikes);
  const limit = Number.isFinite(maxTicks) ? Math.max(2, Math.floor(maxTicks)) : 8;
  if (sorted.length <= limit) return sorted;

  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const ticks = [];
  let j = 0;
  for (let i = 0; i < limit; i++) {
    const target = i === limit - 1 ? hi : lo + ((hi - lo) * i) / (limit - 1);
    // Targets ascend, so the nearest strike only moves right (a tie keeps the lower strike).
    while (j < sorted.length - 1 && Math.abs(sorted[j + 1] - target) < Math.abs(sorted[j] - target)) j++;
    if (ticks[ticks.length - 1] !== sorted[j]) ticks.push(sorted[j]);
  }
  return ticks;
}

/**
 * The chart's reference levels at their exact prices, in the order spot, basis, sma50,
 * sma200. A level is included only when its price is a finite number above 0 (so a zero or
 * missing cost basis draws nothing), and the moving averages only while `showMAs` is on.
 * `visible` says whether the price lies within the strike range, i.e. whether the line
 * lands on the chart; Recharts discards a ReferenceLine outside the axis domain.
 *
 * @param {object} prices
 * @param {number|string} [prices.spotPrice]
 * @param {number|string} [prices.costBasis]
 * @param {number|string} [prices.sma50]
 * @param {number|string} [prices.sma200]
 * @param {boolean} [prices.showMAs=true]
 * @param {Array<number|string>} strikes - the chart's strikes, any order
 * @returns {Array<{ key: 'spot'|'basis'|'sma50'|'sma200', value: number, visible: boolean }>}
 */
export function referenceLevels(prices, strikes) {
  const { spotPrice, costBasis, sma50, sma200, showMAs = true } = prices ?? {};
  const raw = {
    spot: spotPrice,
    basis: costBasis,
    sma50: showMAs ? sma50 : null,
    sma200: showMAs ? sma200 : null,
  };
  const range = sortedPrices(strikes);
  const lo = range[0];
  const hi = range[range.length - 1];

  const levels = [];
  for (const key of LEVEL_KEYS) {
    const value = toNumber(raw[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    levels.push({ key, value, visible: range.length > 0 && value >= lo && value <= hi });
  }
  return levels;
}
