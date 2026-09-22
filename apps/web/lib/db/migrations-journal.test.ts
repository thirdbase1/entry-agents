import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Drizzle only applies migrations that are registered in
 * `meta/_journal.json`. A `.sql` file committed without a matching
 * journal entry is silently invisible: it never runs, no build step
 * complains, and the failure only surfaces at runtime as a 42P01
 * "relation does not exist" against a table the schema clearly
 * declares.
 *
 * That exact thing happened on 2026-09-22: `0057_github_repo_index.sql`
 * was committed (7e857f6) with the schema table and the code that uses
 * it, but the journal entry was never added -- so `github_repo_index`
 * never existed in production and the repo selector 500'd on the cache
 * write. These tests make that class of mistake fail fast in CI.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));
}

function journalTags(): Set<string> {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return new Set(journal.entries.map((e) => e.tag));
}

describe("migration journal integrity", () => {
  test("every .sql file is registered in the journal", () => {
    // The regression guard. An orphaned SQL file never runs, so this is
    // the single most valuable assertion in the file.
    const tags = journalTags();
    const orphans = sqlFiles().filter((f) => !tags.has(f));
    expect(orphans).toEqual([]);
  });

  test("every journal entry points at a file that exists", () => {
    // The inverse: a stale journal entry (e.g. a renamed migration)
    // would crash the migrator on the next deploy.
    const files = new Set(sqlFiles());
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const missing = journal.entries
      .map((e) => e.tag)
      .filter((t) => !files.has(t));
    expect(missing).toEqual([]);
  });

  test("journal indexes are contiguous and start at zero", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ idx: number }>;
    };
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  test("journal tags are unique", () => {
    // drizzle keys migrations by tag; a duplicate makes ordering
    // ambiguous and can silently skip one of them.
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("hand-written migrations are allowed to omit a snapshot", () => {
    // Documents the repo's existing convention so a future contributor
    // doesn't "fix" the missing snapshots and wonder why nothing helps:
    // snapshots are for drizzle-kit generate, not for migrate.
    const sqlFile = "0057_github_repo_index.sql";
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = new Set(journal.entries.map((e) => e.tag));

    expect(existsSync(join(MIGRATIONS_DIR, sqlFile))).toBe(true);
    expect(tags.has(sqlFile.replace(/\.sql$/, ""))).toBe(true);
  });
});
