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
import type { Advice } from './advice/schema.ts';
import type { ShotCurves } from './advice/curves.ts';

const NAMESPACE = 'crema';
const INDEX_KEY = 'shot-index';
const SETTINGS_KEY = 'settings-mirror';
const RETAINED_HISTORY = 100;

export interface ShotRecord {
  /** Decaid's shot id, or a local id when the shot was never persisted. */
  id: string;
  at: number;
  bean: {
    beanId?: string | null;
    name: string | null;
    roaster: string | null;
    /** The specific bag matters: two roasts of one coffee are not one dial-in. */
    batchId?: string | null;
    roastDate?: string | null;
    roastLevel?: string | null;
  };
  recipe: Recipe;
  rating: Rating;
  /** The barista deliberately postponed this rating; do not reopen it at boot. */
  deferred?: boolean;
  finalYieldG: number | null;
  /**
   * The shot's curves, downsampled. Stored because a tablet that sleeps or a
   * reloaded page must still be able to rate the shot and ask for advice on
   * it — without these, a reload silently loses the cup in front of you.
   */
  curves: ShotCurves | null;
  /** What the advisor said, kept so the attempt log can be rebuilt. */
  advice: { summary: string; diagnosis: string; full?: Advice } | null;
  /** Which fields we actually applied afterwards, for honest attribution. */
  applied: string[];
  /** The next-shot setup after Apply; kept separate from what this shot used. */
  appliedRecipe?: Recipe;
}

export interface ShotIndex {
  ids: string[];
}

export interface BeanDialIn {
  recipe: Recipe;
}

/**
 * The settings worth surviving a reinstall.
 *
 * Settings live in `localStorage`, which is scoped to the origin Decaid serves
 * the skin from — and reinstalling the skin wipes it, taking the grinder and
 * the provider address with it. A shot survives that because it lives here, in
 * Decaid's own store, so the parts of the setup that are not secret are
 * mirrored here too.
 *
 * The API key is deliberately not among them. It stays on the device, in
 * browser storage, and is never written to the gateway — the same rule as
 * before. Losing a key on reinstall is a re-paste; losing it to the wrong
 * place is not recoverable.
 */
export interface SettingsMirror {
  provider: string;
  model: string;
  baseUrl: string;
  grinderName: string;
  grinderRange: string;
  theme: string;
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
  async readRecent(limit = RETAINED_HISTORY): Promise<ShotRecord[]> {
    const ids = (await this.readIndex()).slice(-limit).reverse();
    const records = await Promise.all(ids.map((id) => this.readShot(id)));
    return records.filter((r): r is ShotRecord => r !== null);
  }

  readBeanDialIn(beanId: string): Promise<BeanDialIn | null> {
    return this.get<BeanDialIn>(`bean-dial-in-${beanId}`);
  }

  saveBeanDialIn(beanId: string, recipe: Recipe): Promise<boolean> {
    return this.set(`bean-dial-in-${beanId}`, { recipe });
  }

  async deleteBeanDialIn(beanId: string): Promise<void> {
    try {
      await this.gateway.request(this.key(`bean-dial-in-${beanId}`), { method: 'DELETE' });
    } catch {
      // A missing preset is already the desired result.
    }
  }

  readSettingsMirror(): Promise<SettingsMirror | null> {
    return this.get<SettingsMirror>(SETTINGS_KEY);
  }

  saveSettingsMirror(mirror: SettingsMirror): Promise<boolean> {
    return this.set(SETTINGS_KEY, mirror);
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

  async deleteShot(id: string): Promise<boolean> {
    try {
      await this.gateway.request(this.key(`shot-${id}`), { method: 'DELETE' });
      const ids = await this.readIndex();
      await this.set(INDEX_KEY, { ids: ids.filter((candidate) => candidate !== id) });
      return true;
    } catch {
      return false;
    }
  }
}

/** A blank record for a shot that has just finished. */
export function newShotRecord(
  id: string,
  recipe: Recipe,
  bean: ShotRecord['bean'],
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
const PENDING_RATING_MAX_AGE_MS = 30 * 60 * 1000;

export function needsRating(record: ShotRecord, now = Date.now()): boolean {
  const age = now - record.at;
  return (
    record.deferred !== true &&
    (record.rating?.score ?? null) === null &&
    age >= 0 &&
    age <= PENDING_RATING_MAX_AGE_MS &&
    hasCurves(record)
  );
}
