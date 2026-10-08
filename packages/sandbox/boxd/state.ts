import type { Source } from "../types.ts";

export interface BoxdState {
  /** Stable human-readable identity used when a machine id is unavailable. */
  machineName?: string;
  source?: Source;
  machineId?: string;
  expiresAt?: number;
}
