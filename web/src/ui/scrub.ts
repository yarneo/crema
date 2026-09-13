/**
 * Reading exact values off the shot chart.
 *
 * Hold anywhere on the trace and a crosshair snaps to the nearest sample,
 * showing the time and what pressure, flow and weight-flow actually were
 * there. The chart is otherwise a shape you interpret by eye; this is for the
 * moments when the question is "what was the flow at nine seconds".
 *
 * Two constraints shaped this:
 *
 * Rendering replaces the whole tree, so nothing here may call render() — the
 * crosshair is moved by touching the DOM directly, at pointer speed.
 *
 * And the samples are not duplicated into a data attribute. They are already
 * in the polylines, as the coordinates actually plotted, so the values are
 * recovered by inverting the same mapping that drew them. One source of truth,
 * and no second copy of 350 numbers per chart.
 */

/** The plot geometry `renderShot` writes into `data-scrub`. */
interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
  maxY: number;
  duration: number;
}

export function parsePlot(raw: string | null | undefined): Plot | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
  const [left, right, top, bottom, maxY, duration] = parts as [number, number, number, number, number, number];
  if (right <= left || bottom <= top || maxY <= 0 || duration <= 0) return null;
  return { left, right, top, bottom, maxY, duration };
}

/** A polyline's `points` attribute, as pairs. */
export function parsePoints(raw: string | null | undefined): Array<[number, number]> {
  if (!raw) return [];
  const out: Array<[number, number]> = [];
  for (const pair of raw.trim().split(/\s+/)) {
    const [x, y] = pair.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x!, y!]);
  }
  return out;
}

/** Index of the sample nearest a plot-space x. Points are ordered by x. */
export function nearestIndex(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (points.length === 0) return -1;
  let best = 0;
  let bestGap = Math.abs(points[0]![0] - x);
  for (let i = 1; i < points.length; i += 1) {
    const gap = Math.abs(points[i]![0] - x);
    if (gap > bestGap) break; // ordered by x, so the gap only grows from here
    best = i;
    bestGap = gap;
  }
  return best;
}

/** Invert the y mapping `renderShot` used: y = bottom - (v / maxY) * (bottom - top). */
export function valueAt(plot: Plot, y: number): number {
  return ((plot.bottom - y) / (plot.bottom - plot.top)) * plot.maxY;
}

/** Invert the x mapping: x = left + (t / duration) * (right - left). */
export function timeAt(plot: Plot, x: number): number {
  return ((x - plot.left) / (plot.right - plot.left)) * plot.duration;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/** The value-carrying traces, in the order their dots are declared. */
const SERIES: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: 'pressure', label: 'pressure', unit: 'bar' },
  { key: 'flow', label: 'flow', unit: 'mL/s' },
  { key: 'weight', label: 'weight', unit: 'g/s' }
];

/**
 * Turn a pointer position into plot-space coordinates.
 *
 * The SVG scales to its container, so screen pixels are not plot units; the
 * element's own transform matrix is the only reliable way across engines.
 */
function toPlotSpace(svg: SVGSVGElement, clientX: number): number | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = 0;
  return point.matrixTransform(ctm.inverse()).x;
}

/**
 * Wire scrubbing for every chart under `root`, once.
 *
 * Delegated from a stable ancestor, so it keeps working across the re-renders
 * that replace the charts themselves.
 */
export function attachScrub(root: HTMLElement): void {
  let active: SVGSVGElement | null = null;

  const hide = (): void => {
    if (!active) return;
    const chart = active.closest('.shot-chart, .card');
    active.querySelector('.scrub')?.classList.remove('on');
    chart?.querySelector('.scrub-readout')?.classList.remove('on');
    active = null;
  };

  const move = (svg: SVGSVGElement, clientX: number): void => {
    const plot = parsePlot(svg.getAttribute('data-scrub'));
    if (!plot) return;

    const raw = toPlotSpace(svg, clientX);
    if (raw === null) return;
    const x = clamp(raw, plot.left, plot.right);

    // The traces are the polylines with a stroke-width of 2.2 — the live
    // series, as opposed to the thinner goal and comparison lines.
    const traces = [...svg.querySelectorAll<SVGPolylineElement>('polyline[stroke-width="2.2"]')];
    if (traces.length === 0) return;

    const points = traces.map((line) => parsePoints(line.getAttribute('points')));
    const index = nearestIndex(points[0]!, x);
    if (index < 0) return;

    const anchorX = points[0]![index]![0];
    const group = svg.querySelector<SVGGElement>('.scrub');
    const line = svg.querySelector<SVGLineElement>('.scrub-line');
    if (!group || !line) return;

    line.setAttribute('x1', String(anchorX));
    line.setAttribute('x2', String(anchorX));

    const dots = [...svg.querySelectorAll<SVGCircleElement>('.scrub-dot')];
    const readings: string[] = [];
    dots.forEach((dot, series) => {
      const trace = points[series];
      const sample = trace?.[index];
      if (!sample) {
        dot.setAttribute('opacity', '0');
        return;
      }
      dot.setAttribute('opacity', '1');
      dot.setAttribute('cx', String(sample[0]));
      dot.setAttribute('cy', String(sample[1]));
      const meta = SERIES[series];
      if (meta) readings.push(`${meta.label} ${valueAt(plot, sample[1]).toFixed(1)} ${meta.unit}`);
    });

    group.classList.add('on');

    const chart = svg.closest('.shot-chart, .card');
    const readout = chart?.querySelector<HTMLElement>('.scrub-readout');
    if (readout) {
      readout.textContent = `${timeAt(plot, anchorX).toFixed(1)}s · ${readings.join(' · ')}`;
      readout.classList.add('on');

      // Follow the crosshair, but stay inside the chart. Clamped in pixels
      // against the readout's own width — a percentage cannot know how wide
      // the text is, so near either end it hung off the edge.
      const fraction = (anchorX - plot.left) / (plot.right - plot.left);
      const bounds = (chart as HTMLElement).getBoundingClientRect();
      const half = readout.offsetWidth / 2;
      // The "Detailed graph" button lives in the same top-right corner, so the
      // readout stops short of it rather than sliding underneath.
      const corner = chart?.querySelector<HTMLElement>('.graph-open');
      const reserved = corner ? corner.offsetWidth + 16 : 8;
      const low = half + 8;
      const high = Math.max(low, bounds.width - half - reserved);
      readout.style.left = `${clamp(fraction * bounds.width, low, high)}px`;
    }
  };

  root.addEventListener('pointerdown', (event) => {
    const svg = (event.target as Element).closest<SVGSVGElement>('svg[data-scrub]');
    if (!svg) return;
    active = svg;
    move(svg, event.clientX);
    event.preventDefault();

    // Claim the gesture so a drag reads values instead of scrolling the page.
    // Last, and guarded: setPointerCapture throws outright when the id is not
    // an active pointer, and an exception here used to abort the handler
    // before anything was drawn. Capture is an improvement to the gesture,
    // never a precondition for reading a value.
    try {
      svg.setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture the drag still tracks; it just ends at the edge.
    }
  });

  root.addEventListener('pointermove', (event) => {
    if (!active) return;
    move(active, event.clientX);
    event.preventDefault();
  });

  for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    root.addEventListener(end, hide);
  }
}
