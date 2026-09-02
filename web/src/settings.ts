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
}

export const DEFAULT_SETTINGS: CremaSettings = {
  provider: 'anthropic',
  apiKey: '',
  model: '',
  baseUrl: '',
  grinderName: '',
  grinderRange: ''
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
      grinderRange: str('grinderRange')
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
  if (settings.provider === 'compatible' || settings.provider === 'server') return true;
  return settings.apiKey.trim() !== '';
}
