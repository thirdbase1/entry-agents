import postgres from "postgres";

/**
 * Server-only Postgres handle for Project-B. Reads POSTGRES_URL at first
 * use; the value never leaves the server process. Same DB as web — this
 * is deliberately the raw `postgres` driver (like web's usage helper) so
 * both surfaces share one connection pattern.
 */
let _sql: postgres.Sql | null = null;

export function getSql(): postgres.Sql {
  if (!_sql) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL environment variable is required");
    _sql = postgres(url, { prepare: false, max: 5 });
  }
  return _sql;
}
