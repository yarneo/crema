/**
 * The slice of the Decaid API that Crema uses.
 *
 * Only the fields we actually read or write are typed. Decaid returns more
 * than this (and legacy duplicates of some of it), but narrowing here keeps
 * the mapping in `workflow.ts` honest: if we start depending on a field, it
 * has to be declared.
 */

export interface ProfileStepWire {
  name?: string;
  temperature?: number;
  seconds?: number;
  pump?: string;
  pressure?: number;
  flow?: number;
  transition?: string;
  exit_type?: string | null;
  exit_pressure_over?: number | null;
  exit_pressure_under?: number | null;
  exit_flow_over?: number | null;
  exit_flow_under?: number | null;
}

export interface ProfileWire {
  version?: string;
  title?: string;
  author?: string;
  notes?: string;
  beverage_type?: string;
  steps?: ProfileStepWire[];
  target_volume?: number;
  target_weight?: number;
  tank_temperature?: number;
}

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
