import type { Source } from "../types.ts";

export interface BoxdState {
  source?: Source;
  machineId?: string;
  machineName?: string;
  expiresAt?: number;
}
