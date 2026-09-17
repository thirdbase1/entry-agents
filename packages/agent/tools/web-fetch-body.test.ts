import {
  WEB_FETCH_BODY_DIR,
  buildWebFetchBodyFileName,
} from "./web-fetch-body";

describe("buildWebFetchBodyFileName", () => {
  it("produces a .txt file name with no path separators", () => {
    const name = buildWebFetchBodyFileName(
      "https://api.example.com/v1/users?limit=100",
    );
    expect(name).toMatch(/^fetch-[a-z0-9-]*-[0-9a-f]{8}\.txt$/);
    expect(name).not.toContain("/");
  });

  it("is deterministic for the same URL", () => {
    const url = "https://example.com/a/b?x=1";
    expect(buildWebFetchBodyFileName(url)).toBe(
      buildWebFetchBodyFileName(url),
    );
  });

  it("includes the host slug for recognizability", () => {
    const name = buildWebFetchBodyFileName("https://Docs.Example.com/readme");
    expect(name).toContain("docs-example-com");
  });

  it("hashes different query strings to different names", () => {
    const a = buildWebFetchBodyFileName("https://example.com/p?x=1");
    const b = buildWebFetchBodyFileName("https://example.com/p?x=2");
    expect(a).not.toBe(b);
  });

  it("survives unparseable input", () => {
    const name = buildWebFetchBodyFileName("not a url");
    expect(name).toMatch(/^fetch-unknown-/);
  });

  it("exports the persistence directory inside the harness dot-folder", () => {
    expect(WEB_FETCH_BODY_DIR.startsWith(".open-harness/")).toBe(true);
  });
});
