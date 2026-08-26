import Redis, { type RedisOptions } from "ioredis";
import { sendTelegramMessage } from "./telegram-alerts";
import { getRedisConnectionOptions, getRedisUrl } from "./redis";

type RateLimitOptions = {
  key: string;
  limit: number;
  windowMs: number;
};

const DEFAULT_RATE_LIMIT_TIMEOUT_MS = 1000;

// How long to skip real Redis attempts after a failure before trying
// again. Keeps us from hammering an already-struggling (or
// provider-rate-limited) Redis instance with more doomed commands on
// every single request, and keeps per-request latency low during an
// outage instead of paying the timeout on every call.
const CIRCUIT_BREAKER_COOLDOWN_MS = 15_000;

// Dedup window for the "rate limiter is degraded" Telegram alert so a
// sustained outage sends one notification per window instead of one per
// request. Deliberately kept in module memory (not Redis-backed, unlike
// the model-health alert cooldown in telegram-alerts.ts) since Redis
// being down is exactly the condition this alert fires for.
const ALERT_DEDUP_MS = 15 * 60 * 1000;

let sharedRedisClient: Redis | null | undefined;
let circuitOpenedAt: number | null = null;
let lastAlertSentAt: number | null = null;

function getRateLimitTimeoutMs(): number {
  const configuredTimeoutMs = process.env.RATE_LIMIT_TIMEOUT_MS;
  if (!configuredTimeoutMs) {
    return DEFAULT_RATE_LIMIT_TIMEOUT_MS;
  }

  const timeoutMs = Number.parseInt(configuredTimeoutMs, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_RATE_LIMIT_TIMEOUT_MS;
  }

  return timeoutMs;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(`Redis rate limit check timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function getSharedRedisClient(): Redis | null {
  if (sharedRedisClient !== undefined) {
    return sharedRedisClient;
  }

  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    sharedRedisClient = null;
    return sharedRedisClient;
  }

  sharedRedisClient = new Redis({
    ...(getRedisConnectionOptions(redisUrl) as RedisOptions),
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
  });
  sharedRedisClient.on("error", (error) => {
    console.error("[redis] rate-limit error:", error);
  });
  return sharedRedisClient;
}

function resetRedisClient(): void {
  sharedRedisClient?.disconnect();
  sharedRedisClient = undefined;
}

function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

async function checkRedisRateLimit(
  client: Redis,
  options: RateLimitOptions,
): Promise<Response | null> {
  const key = `rate-limit:${options.key}`;
  const count = await client
    .multi()
    .incr(key)
    .pexpire(key, options.windowMs, "NX")
    .exec()
    .then((results) => {
      const [incrementResult, expireResult] = results ?? [];
      const [error, value] = incrementResult ?? [];
      if (error) {
        throw error;
      }

      const [expireError] = expireResult ?? [];
      if (expireError) {
        throw expireError;
      }

      const count = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(count)) {
        throw new Error("Redis rate limit increment returned an invalid count");
      }

      return count;
    });

  if (count <= options.limit) {
    return null;
  }

  const ttl = await client.pttl(key);
  return rateLimitResponse(ttl > 0 ? ttl : options.windowMs);
}

function isCircuitOpen(): boolean {
  if (circuitOpenedAt === null) {
    return false;
  }

  if (Date.now() - circuitOpenedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    // Cooldown elapsed -- let the next call make a fresh real attempt
    // instead of staying open forever off a single stale failure.
    circuitOpenedAt = null;
    return false;
  }

  return true;
}

function sendDegradedModeAlert(): void {
  const now = Date.now();
  if (lastAlertSentAt !== null && now - lastAlertSentAt < ALERT_DEDUP_MS) {
    return;
  }
  lastAlertSentAt = now;

  sendTelegramMessage(
    "⚠️ <b>Entry rate limiter degraded</b>\n" +
      "Redis is unavailable or erroring, so rate limiting is temporarily " +
      "fail-open (requests are allowed through unlimited) to keep session " +
      "and chat creation working. Check the Upstash dashboard -- this " +
      "usually means the database hit a provider-side quota/rate limit.",
  ).catch((err) => {
    console.error(
      "[rate-limit] Failed to send degraded-mode Telegram alert:",
      err,
    );
  });
}

function recordFailure(): Response | null {
  const wasAlreadyOpen = circuitOpenedAt !== null;
  circuitOpenedAt = Date.now();
  if (!wasAlreadyOpen) {
    sendDegradedModeAlert();
  }
  // Fail OPEN, not closed: when Redis itself is the thing that's broken,
  // hard-blocking every rate-limited endpoint (session/chat/sandbox
  // creation) is a worse outage than temporarily allowing unlimited
  // requests through. Matches the fail-open pattern already used by
  // lib/skills-cache.ts for the same Redis instance.
  return null;
}

function recordSuccess(): void {
  circuitOpenedAt = null;
}

export async function checkRateLimit(
  options: RateLimitOptions,
): Promise<Response | null> {
  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  if (isCircuitOpen()) {
    return null;
  }

  const redisClient = getSharedRedisClient();
  if (!redisClient) {
    return recordFailure();
  }

  try {
    const result = await withTimeout(
      checkRedisRateLimit(redisClient, options),
      getRateLimitTimeoutMs(),
    );
    recordSuccess();
    return result;
  } catch (error) {
    resetRedisClient();
    console.error("[rate-limit] Redis check failed:", error);
    return recordFailure();
  }
}

export function rateLimitKey(parts: (number | string | null | undefined)[]) {
  return parts.map((part) => String(part ?? "unknown")).join(":");
}
