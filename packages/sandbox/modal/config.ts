/**
 * Modal Sandbox resource + network configuration.
 *
 * Every number here is chosen against Modal's published Sandbox pricing
 * (https://modal.com/pricing, "Modal Sandbox + Notebooks Pricing"), which
 * is billed PER SECOND with no idle charge:
 *
 *   CPU    $0.00003942 / core / sec      ->  $0.1419 per core-hour
 *   Memory $0.00000667 / GiB / sec       ->   $0.0240 per GiB-hour
 *   Volume $0.09 / GiB / mo (1 TiB free) ->  ~$0.00012 per GiB-hour
 *
 * A 2 vCPU / 4 GiB sandbox therefore costs ~$0.387/hour, and a 1 GiB
 * workspace volume ~$0.11/month. The minimum reservation Modal accepts is
 * 0.125 cores per container, so there is no cheaper shape than the smallest
 * legal CPU/memory pair -- anything below is rejected by the API, not
 * merely wasted.
 */

/** Modal's hard ceiling on a single sandbox lifetime. */
export const MODAL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Cheapest legal sandbox shape.
 *
 * `cpu` and `memoryMiB` are RESERVATIONS, not limits, so this is what
 * Modal bills against. 1 vCPU / 2 GiB is the smallest sane pair: below
 * 0.25 cores the container spends most of its life scheduling against
 * itself (a `pnpm install` on 0.125 cores is slower than on a laptop),
 * and node/bun plus a git checkout comfortably fits in 2 GiB.
 */
export const MODAL_DEFAULT_CPU = 1;
export const MODAL_DEFAULT_MEMORY_MIB = 2048;

/**
 * Degraded shape used when Modal rejects the default for quota/capacity
 * reasons. Halves the memory reservation but stays a legal shape, so a
 * session gets a working shell instead of a 507.
 */
export const MODAL_CHEAP_MEMORY_MIB = 1024;

/**
 * Workspace volume size: 1 GiB.
 *
 * Modal bills volumes at $0.09/GiB/month with 1 TiB included free on the
 * Team plan, so 1 GiB costs ~$0.09/month per session. Modal's own guidance
 * is that Volumes v1 perform best under ~50,000 files and hard-cap at
 * 500,000 inodes, which a source checkout plus node_modules stays under.
 */
export const MODAL_DEFAULT_VOLUME_GIB = 1;

/** Mount point for the workspace volume inside every sandbox. */
export const MODAL_WORKSPACE_MOUNT_PATH = "/workspace";

/** Default sandbox lifetime: 24h (Modal's ceiling) with idle reap at 15m. */
export const MODAL_DEFAULT_TIMEOUT_MS = MODAL_MAX_TIMEOUT_MS;
export const MODAL_DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Base image: Alpine 3.21. Small, fast cold starts, has git/sh. */
export const MODAL_DEFAULT_IMAGE = "alpine:3.21";

/** Proactive re-provision lead time before Modal's hard timeout. */
export const MODAL_EXPIRES_BUFFER_MS = 60 * 1000;
