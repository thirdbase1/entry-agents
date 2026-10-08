/** boxd's smallest machine class: exactly 1 vCPU and 4 GiB RAM. */
export const BOXD_VCPU = 1;
export const BOXD_MEMORY = "4G" as const;
export const BOXD_DISK = "100G" as const;
export const BOXD_WORKING_DIRECTORY = "/workspace";

export function isBoxdConfigured(): boolean {
  return Boolean(process.env.BOXD_API_KEY || process.env.BOXD_TOKEN);
}
