/**
 * Crema's own settings.
 *
 * The API key lives in this device's browser storage and nowhere else. It is
 * never written to the Decaid gateway, which has no reason to hold it, and
 * never leaves the device except as a header on the request to the provider
 * the user chose.
 *
 * Every access is wrapped: storage throws outright in some contexts (private
 * windows, blocked site data, thumbnail capture), and a skin that cannot read
 * a preference must still start.
 */

import { PROVIDERS, type ProviderConfig, type ProviderId } from './advice/provider.ts';

const KEY = 'crema.settings.v1';

/**
 * The provider fields are optional on `ProviderConfig` (a caller may omit
 * them), but stored settings always have a concrete string — blank meaning
 * "use the default" — so they are narrowed to required here.
 */
export interface CremaSettings extends ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Free text, e.g. "Lagom 01". The advisor phrases moves in its units. */
  grinderName: string;
  /** Optional, e.g. "0.1-0.5". Used to size moves, never to clamp them. */
  grinderRange: string;
  /** Dark is the default, as in the Tcl skin; light is its `theme_variant`. */
  theme: Theme;
}

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_SETTINGS: CremaSettings = {
  provider: 'anthropic',
  apiKey: '',
  model: '',
  baseUrl: '',
  grinderName: '',
  grinderRange: '',
  theme: 'dark'
};

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function loadSettings(): CremaSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const record = parsed as Record<string, unknown>;

    const str = (k: string) => (typeof record[k] === 'string' ? (record[k] as string) : '');

    return {
      provider: isProvider(record['provider']) ? record['provider'] : DEFAULT_SETTINGS.provider,
      apiKey: str('apiKey'),
      model: str('model'),
      baseUrl: str('baseUrl'),
      grinderName: str('grinderName'),
      grinderRange: str('grinderRange'),
      theme: record['theme'] === 'light' ? 'light' : 'dark'
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Returns false when storage refused the write, so the UI can say so. */
export function saveSettings(settings: CremaSettings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Whether Crema has enough to ask for advice at all. */
export function isReady(settings: CremaSettings): boolean {
  // The local server needs no key, but it does need an address — and it no
  // longer has a default, because the old one (localhost) was right only on
  // the Mac itself. Without this, a blank field reads as "ready" and every
  // request fails.
  if (settings.provider === 'server') return settings.baseUrl.trim() !== '';
  if (settings.provider === 'compatible') return true;
  return settings.apiKey.trim() !== '';
}

/**
 * Whether the machine has a group-head controller.
 *
 * Remembered separately from the settings above because it is not a
 * preference — it is a fact about the hardware, discovered from the gateway.
 * It is cached for one reason: the brew screen's whole layout depends on it
 * (a GHC machine has no on-screen start buttons), and waiting for a round trip
 * to find out means rendering the wrong layout first and correcting it, which
 * reads as a flicker.
 */
const GHC_KEY = 'crema.machine.ghc.v1';

export function loadKnownGhc(): boolean | null {
  try {
    const raw = localStorage.getItem(GHC_KEY);
    return raw === 'true' ? true : raw === 'false' ? false : null;
  } catch {
    return null;
  }
}

export function saveKnownGhc(hasGhc: boolean): void {
  try {
    localStorage.setItem(GHC_KEY, hasGhc ? 'true' : 'false');
  } catch {
    // Not knowing next time is survivable; it only costs one relayout.
  }
}
