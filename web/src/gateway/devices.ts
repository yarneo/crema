/**
 * Reading Decaid's device list.
 *
 * Kept apart from `main.ts` so it can be unit-tested: `main.ts` boots the app
 * on import, which makes anything defined there untestable by construction.
 */

import type { DeviceInfoWire } from './types.ts';

/**
 * Why a connect attempt found nothing, in the words that name the fix.
 *
 * Decaid distinguishes a device it has never seen from one it remembers but
 * cannot currently reach — the latter comes back with `available: false`,
 * which in practice means the hardware is off, asleep or out of range. That is
 * a different problem from "no machine paired", and telling them apart saves
 * hunting in the wrong place.
 */
export function describeFailedConnect(
  kind: 'machine' | 'scale',
  devices: readonly DeviceInfoWire[]
): string {
  const noun = kind === 'machine' ? 'machine' : 'scale';
  const known = devices.find((device) => device.type === kind);

  if (!known) return `No ${noun} found. Check it is switched on and in Bluetooth range.`;
  if (known.available === false) {
    return `${known.name} is paired but not responding — switch it on, or wake it if it has been idle.`;
  }
  return `${known.name} was found but would not connect. Try again, or reconnect it from Decaid.`;
}
