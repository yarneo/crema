/**
 * The last element of an array.
 *
 * `Array.prototype.at(-1)` would be the obvious way, but it landed in Chrome
 * 92 and the Android 8.1 tablets Decent shipped are frozen on Chrome 78 with
 * no Play Store to update them. Those tablets cannot run Decaid natively, but
 * they can open a skin in the browser, and this is one of two things that
 * stood between them and a working page.
 */
export function last<T>(values: readonly T[]): T | undefined {
  return values.length === 0 ? undefined : values[values.length - 1];
}
