/**
 * Finding the Mac advice server again after it moves.
 *
 * The Tcl skin does a bounded async TCP sweep of the local /24 for anything
 * listening on 8877, because a laptop on DHCP changes address and a saved URL
 * then points at nothing. The web port shipped without it, so a moved Mac
 * meant advice simply failed until the address was retyped.
 *
 * A browser cannot open raw sockets, and inside Decaid's webview the page is
 * on `localhost`, so there is no way to read our own LAN address and derive
 * the subnet from it. What we do have is the address that used to work: if the
 * server was at 10.0.0.11, the Mac is almost certainly still somewhere on
 * 10.0.0.x. That is the sweep, and it is bounded and only ever runs after a
 * real failure.
 */

/** Decaid's advisor answers this, and nothing else on the network will. */
const HEALTH_PATH = '/health';

const DEFAULT_PROBE_TIMEOUT_MS = 1200;
const DEFAULT_CONCURRENCY = 24;

export interface DiscoverOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  concurrency?: number;
}

/** The host part of an origin, or null when it is not parseable. */
export function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Every address to try, in the order worth trying them.
 *
 * The saved one first — a failure can be transient, and a needless sweep of
 * 254 addresses is rude. Then, when the saved address was numeric, the rest of
 * its /24: the Mac moved, it did not emigrate. A `.local` name needs no sweep
 * at all, since mDNS re-resolves it; if that is what failed, the name itself
 * is wrong and scanning will not help.
 */
export function candidateOrigins(savedOrigin: string): string[] {
  const trimmed = savedOrigin.trim().replace(/\/+$/, '');
  if (trimmed === '') return [];

  const host = hostOf(trimmed);
  if (host === null) return [trimmed];

  const candidates = [trimmed];
  const match = IPV4.exec(host);
  if (!match) return candidates;

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return candidates;

  const [a, b, c, own] = octets as [number, number, number, number];
  for (let last = 1; last <= 254; last += 1) {
    if (last === own) continue;
    candidates.push(trimmed.replace(host, `${a}.${b}.${c}.${last}`));
  }
  return candidates;
}

/** Whether this origin is our advisor, as opposed to something else on 8877. */
async function isAdvisor(
  origin: string,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${origin}${HEALTH_PATH}`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown };
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first candidate that answers as the advisor, or null.
 *
 * Probes run a fixed number at a time rather than all at once: 254 parallel
 * requests is a burst a phone's network stack handles badly, and the Tcl
 * version keeps ~30 in flight for the same reason. The first success wins and
 * the rest are abandoned.
 */
export async function discoverServer(
  savedOrigin: string,
  options: DiscoverOptions = {}
): Promise<string | null> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const width = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const queue = candidateOrigins(savedOrigin);
  let next = 0;
  let found: string | null = null;

  const worker = async (): Promise<void> => {
    while (found === null) {
      const index = next;
      next += 1;
      const origin = queue[index];
      if (origin === undefined) return;
      if (await isAdvisor(origin, doFetch, timeoutMs)) {
        // Keep the earliest candidate, so a retry of the saved address beats
        // a lucky hit further down the sweep.
        if (found === null) found = origin;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
  return found;
}
