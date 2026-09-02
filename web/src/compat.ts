/**
 * Old-browser compatibility.
 *
 * The Android 8.1 tablets Decent shipped around 2019-2020 cannot install
 * Decaid at all (it needs API 28), but they can open a skin in a browser
 * pointed at a Decaid running elsewhere. Those tablets are frozen on
 * **Chrome 78** — there is no Play Store on them to update it — so that is the
 * floor this skin builds for.
 *
 * Two things stood in the way. `Array.prototype.at` is handled by not using it
 * (see `domain/last.ts`), and the build target lowers optional chaining and
 * nullish coalescing. The remaining one is flexbox `gap`, which needs Chrome
 * 84 and cannot be feature-queried: `gap` is valid on grid far earlier, so
 * `@supports (gap: 1px)` answers true on Chrome 78 and tells you nothing.
 *
 * So it is measured instead.
 */

/**
 * Whether flexbox honours `gap`.
 *
 * Two stacked children in a column flex box with a 10px row gap: if gap works
 * the box is at least 10px tall, and if it does not the children have no
 * height and neither does the box. The probe is positioned off-screen and
 * removed immediately so it cannot affect layout or be seen.
 */
export function supportsFlexGap(doc: Document = document): boolean {
  const probe = doc.createElement('div');
  probe.style.display = 'flex';
  probe.style.flexDirection = 'column';
  probe.style.rowGap = '10px';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.appendChild(doc.createElement('div'));
  probe.appendChild(doc.createElement('div'));

  const host = doc.body ?? doc.documentElement;
  host.appendChild(probe);
  const height = probe.scrollHeight;
  host.removeChild(probe);

  return height >= 10;
}

/**
 * Mark the document when flex gap is missing, so the stylesheet can fall back
 * to margins. Called once at boot, before the first render.
 */
export function applyCompatFlags(doc: Document = document): void {
  if (!supportsFlexGap(doc)) {
    doc.documentElement.classList.add('no-flex-gap');
  }
}
