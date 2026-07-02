// Inline SVG sparkline for shelf stock history — pure string generation,
// no DOM, so it's unit-testable and safe to call inside row templates.
//
// Stock is a step function (a shelf holds its quantity until a sale or a
// refill), so the line renders step-after: horizontal at the previous
// value up to each sample's time, then vertical to the new value. A
// smooth polyline would invent gradual depletion between samples and,
// worse, draw restocks as ramps instead of the cliffs they are — the
// cliffs are exactly what makes the cycle shape readable at a glance.

// Downsampling bound. 48 h of a busy shelf can carry hundreds of
// transitions; past ~90 steps the extra points are sub-pixel at
// sparkline width and just bloat the HTML string.
const MAX_POINTS = 90;

/**
 * Render a step-after sparkline of quantity history.
 *
 * @param {Array<{quantity:number, snappedAt:number}>} samples - asc by time
 * @param {object} [opts]
 * @param {number} [opts.width=72]   viewBox width (CSS scales the element)
 * @param {number} [opts.height=16]  viewBox height
 * @param {number} [opts.windowMs]   history window (default 48 h); samples
 *                                   older than nowMs − windowMs are dropped
 * @param {number} [opts.nowMs]      right edge of the time axis (default:
 *                                   last sample — callers pass Date.now()
 *                                   so the flat tail to "now" is visible)
 * @returns {string} `<svg …>…</svg>`, or '' when there's nothing worth
 *          drawing (fewer than 4 samples in-window, or a shelf that never
 *          left zero)
 */
export function stockSparklineSvg(samples, opts = {}) {
  const width = opts.width ?? 72;
  const height = opts.height ?? 16;
  const windowMs = opts.windowMs ?? 48 * 3600_000;

  if (!Array.isArray(samples) || samples.length === 0) return '';
  const nowMs = opts.nowMs ?? samples[samples.length - 1].snappedAt;
  const startMs = nowMs - windowMs;

  let pts = samples.filter(s =>
    s && Number.isFinite(s.quantity) && Number.isFinite(s.snappedAt)
    && s.snappedAt >= startMs && s.snappedAt <= nowMs
  );
  if (pts.length < 4) return '';

  const maxQty = Math.max(...pts.map(s => s.quantity));
  if (maxQty <= 0) return ''; // never observed in stock — a flat zero line is noise

  if (pts.length > MAX_POINTS) {
    // Keep first + last; stride the middle. Uniform stride keeps cliffs
    // roughly in place — good enough at this size.
    const stride = Math.ceil(pts.length / MAX_POINTS);
    pts = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  }

  // Time spans the window's in-view portion, not just first→last sample,
  // so a shelf with one early flurry then silence reads as "old activity,
  // flat since" rather than stretching the flurry across the full width.
  const t0 = Math.max(startMs, pts[0].snappedAt);
  const span = Math.max(1, nowMs - t0);
  const x = (ms) => ((ms - t0) / span) * width;
  // 1px padding top/bottom so a full-shelf line isn't clipped.
  const y = (q) => height - 1 - (q / maxQty) * (height - 2);

  const d = [];
  d.push(`M${x(pts[0].snappedAt).toFixed(1)},${y(pts[0].quantity).toFixed(1)}`);
  for (let i = 1; i < pts.length; i++) {
    d.push(`H${x(pts[i].snappedAt).toFixed(1)}`); // hold previous value…
    d.push(`V${y(pts[i].quantity).toFixed(1)}`);  // …then step to the new one
  }
  d.push(`H${width}`); // hold the latest value out to "now"

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" `
    + `preserveAspectRatio="none" aria-hidden="true">`
    + `<path d="${d.join('')}" fill="none" stroke="currentColor" `
    + `stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
}
