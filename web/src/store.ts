/**
 * Crema's own records: what each shot tasted like, and what the advisor said.
 *
 * These live in Decaid's key-value store rather than browser storage, so they
 * follow the user between the tablet and a laptop and survive a reinstall of
 * the skin. The API key deliberately does not — see `settings.ts`.
 *
 * The store is keyed per shot. Reading the whole namespace back on every load
 * would not scale, so an index document holds the ordered list of shot ids we
 * know about and the records are fetched for the bean being looked at.
 */

import type { Gateway } from './gateway/client.ts';
import { EMPTY_RATING, type Rating } from './domain/rating.ts';
import type { Recipe } from './domain/recipe.ts';

const NAMESPACE = 'crema';
const INDEX_KEY = 'shot-index';

export interface ShotRecord {
  /** Decaid's shot id, or a local id when the shot was never persisted. */
  id: string;
  at: number;
  bean: { name: string | null; roaster: string | null };
  recipe: Recipe;
  rating: Rating;
  finalYieldG: number | null;
  /**
   * The shot's curves, downsampled. Stored because a tablet that sleeps or a
   * reloaded page must still be able to rate the shot and ask for advice on
   * it — without these, a reload silently loses the cup in front of you.
   */
  curves: { elapsedS: number[]; pressureBar: number[]; flowMlS: number[]; weightFlow: number[] | null } | null;
  /** What the advisor said, kept so the attempt log can be rebuilt. */
  advice: { summary: string; diagnosis: string } | null;
  /** Which fields we actually applied afterwards, for honest attribution. */
  applied: string[];
}

export interface ShotIndex {
  ids: string[];
}

export class Store {
  private readonly gateway: Gateway;

  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  private key(key: string): string {
    return `/api/v1/store/${NAMESPACE}/${encodeURIComponent(key)}`;
  }

  /**
   * A missing key is a 404, which is a normal empty state rather than a
   * failure, so it comes back as null instead of throwing.
   */
  private async get<T>(key: string): Promise<T | null> {
    try {
      return await this.gateway.request<T>(this.key(key));
    } catch {
      return null;
    }
  }

  private async set(key: string, value: unknown): Promise<boolean> {
    try {
      await this.gateway.request(this.key(key), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value)
      });
      return true;
    } catch {
      return false;
    }
  }

  async readIndex(): Promise<string[]> {
    const index = await this.get<ShotIndex>(INDEX_KEY);
    return Array.isArray(index?.ids) ? index!.ids : [];
  }

  async readShot(id: string): Promise<ShotRecord | null> {
    return this.get<ShotRecord>(`shot-${id}`);
  }

  /** Newest first, capped so a long history does not stall the screen. */
  async readRecent(limit = 20): Promise<ShotRecord[]> {
    const ids = (await this.readIndex()).slice(-limit).reverse();
    const records = await Promise.all(ids.map((id) => this.readShot(id)));
    return records.filter((r): r is ShotRecord => r !== null);
  }

  /**
   * Write a shot and make sure it is in the index.
   *
   * The index is rewritten rather than appended blindly, so re-saving a shot
   * that is already known does not duplicate it.
   */
  async saveShot(record: ShotRecord): Promise<boolean> {
    const ok = await this.set(`shot-${record.id}`, record);
    if (!ok) return false;

    const ids = await this.readIndex();
    if (!ids.includes(record.id)) {
      await this.set(INDEX_KEY, { ids: [...ids, record.id] });
    }
    return true;
  }
}

/** A blank record for a shot that has just finished. */
export function newShotRecord(
  id: string,
  recipe: Recipe,
  bean: { name: string | null; roaster: string | null },
  finalYieldG: number | null,
  curves: ShotRecord['curves'],
  at = Date.now()
): ShotRecord {
  return {
    id,
    at,
    bean,
    recipe,
    rating: { ...EMPTY_RATING },
    finalYieldG,
    curves,
    advice: null,
    applied: []
  };
}

/**
 * Whether a record carries usable curves.
 *
 * Records written by an earlier version have no `curves` key at all, so this
 * cannot be a `!== null` check: `undefined !== null` is true, which let a
 * curveless record through and crashed the brew screen. Anything read back out
 * of the store is data from a past version of ourselves and gets validated
 * like any other untrusted input.
 */
export function hasCurves(record: ShotRecord): boolean {
  const curves = record.curves;
  return (
    curves !== null &&
    curves !== undefined &&
    Array.isArray(curves.elapsedS) &&
    Array.isArray(curves.pressureBar) &&
    Array.isArray(curves.flowMlS) &&
    curves.elapsedS.length >= 2
  );
}

/** True when a stored shot still needs rating — the one to reopen on boot. */
export function needsRating(record: ShotRecord): boolean {
  return (record.rating?.score ?? null) === null && hasCurves(record);
}
