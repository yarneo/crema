import type { Profile } from '../domain/profile.ts';

/** Decaid's profile, verified against a live gateway. See domain/profile.ts. */
export type ProfileWire = Profile;

/**
 * The slice of the Decaid API that Crema uses.
 *
 * Only the fields we actually read or write are typed. Decaid returns more
 * than this (and legacy duplicates of some of it), but narrowing here keeps
 * the mapping in `workflow.ts` honest: if we start depending on a field, it
 * has to be declared.
 */

/**
 * The recommended home for dose, grinder and coffee. Every field is nullable,
 * and `grinderSetting` is a *string* on the wire even though it is a number to
 * everyone else.
 */
export interface WorkflowContextWire {
  targetDoseWeight?: number | null;
  targetYield?: number | null;
  grinderId?: string | null;
  grinderModel?: string | null;
  grinderSetting?: string | null;
  beanBatchId?: string | null;
  coffeeName?: string | null;
  coffeeRoaster?: string | null;
  finalBeverageType?: string | null;
}

export interface WorkflowWire {
  id?: string;
  name?: string;
  description?: string;
  profile?: ProfileWire;
  context?: WorkflowContextWire;
}

/** A partial update. Decaid applies whatever is present and uploads it. */
export interface WorkflowPatch {
  profile?: ProfileWire;
  context?: WorkflowContextWire;
}

/**
 * Live machine state. `state` is nested, and the mock reports the same shape
 * as a real DE1 ("idle"/"espresso"/"steam"...), so a skin cannot tell them
 * apart — which is the point of developing against it.
 */
export interface MachineStateWire {
  timestamp?: string;
  state?: { state?: string; substate?: string };
  flow?: number;
  pressure?: number;
  groupTemperature?: number;
  mixTemperature?: number;
  steamTemperature?: number;
}

/** A profile as listed by the gateway: the definition plus its content hash. */
export interface ProfileEntryWire {
  id: string;
  profile: ProfileWire;
}

/** Only the bean fields Crema reads or writes. Roaster and name are required. */
export interface BeanWire {
  id?: string;
  roaster: string;
  name: string;
  country?: string | null;
  region?: string | null;
  process?: string | null;
  roastLevel?: string | null;
  notes?: string | null;
  decaf?: boolean;
  archived?: boolean;
}

/** Shot list rows. Measurements are excluded from the list for speed. */
export interface ShotSummaryWire {
  id: string;
  timestamp?: string;
  profileTitle?: string | null;
  coffeeName?: string | null;
  doseWeight?: number | null;
  finalWeight?: number | null;
  duration?: number | null;
}

export interface ShotPageWire {
  items: ShotSummaryWire[];
  total: number;
  limit?: number;
  offset?: number;
}
