import { describe, expect, it } from "bun:test";
import {
  filterRepositories,
  type InstallationRepository,
} from "@/lib/github/repos";

function repo(
  name: string,
  owner: string,
  updatedAt: string,
): InstallationRepository {
  return {
    name,
    full_name: `${owner}/${name}`,
    description: null,
    private: false,
    clone_url: `https://github.com/${owner}/${name}.git`,
    updated_at: updatedAt,
    language: null,
  };
}

const REPOS: InstallationRepository[] = [
  repo("alpha", "thirdbase1", "2026-09-10T00:00:00Z"),
  repo("beta", "acme", "2026-09-12T00:00:00Z"),
  repo("gamma", "thirdbase1", "2026-09-11T00:00:00Z"),
  repo("delta", "acme", "2026-09-09T00:00:00Z"),
];

describe("filterRepositories (repo index local filtering, upstream #840)", () => {
  it("returns everything sorted by recency with no filters", () => {
    const result = filterRepositories(REPOS);
    expect(result.map((r) => r.name)).toEqual([
      "beta",
      "gamma",
      "alpha",
      "delta",
    ]);
  });

  it("filters by owner", () => {
    const result = filterRepositories(REPOS, { owner: "acme" });
    expect(result.map((r) => r.name)).toEqual(["beta", "delta"]);
  });

  it("filters by substring query on name and full_name", () => {
    const byName = filterRepositories(REPOS, { query: "gam" });
    expect(byName.map((r) => r.name)).toEqual(["gamma"]);

    const byOwner = filterRepositories(REPOS, { query: "thirdbase" });
    expect(byOwner.length).toBe(2);
  });

  it("applies the limit after sorting", () => {
    const result = filterRepositories(REPOS, { limit: 2 });
    expect(result.map((r) => r.name)).toEqual(["beta", "gamma"]);
  });

  it("combines owner + query + limit", () => {
    const result = filterRepositories(REPOS, {
      owner: "thirdbase1",
      query: "a",
      limit: 1,
    });
    expect(result.map((r) => r.name)).toEqual(["gamma"]);
  });

  it("handles empty and whitespace-only filters", () => {
    expect(filterRepositories(REPOS, { query: "   " }).length).toBe(4);
    expect(filterRepositories([]).length).toBe(0);
  });
});
