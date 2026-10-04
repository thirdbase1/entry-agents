import { beforeEach, describe, expect, mock, test } from "bun:test";

type UpsertMode = "inserted" | "updated" | "conflict";

let upsertMode: UpsertMode = "inserted";

// Rows returned by the fakeDb select() chain (used by getUsedSessionTitles)
let fakeSelectRows: { title: string }[] = [];

const fakeInsertedMessage = {
  id: "message-1",
  chatId: "chat-1",
  role: "assistant" as const,
  parts: { id: "message-1", role: "assistant", parts: [] },
  createdAt: new Date(),
};

const fakeDb = {
  // Fluent select chain: db.select({…}).from(table).where(condition)
  select: (_columns: unknown) => ({
    from: (_table: unknown) => ({
      where: async (_condition: unknown) => fakeSelectRows,
    }),
  }),

  transaction: async <T>(
    callback: (tx: {
      insert: (table: unknown) => {
        values: (input: unknown) => {
          onConflictDoNothing: (config: unknown) => {
            returning: () => Promise<(typeof fakeInsertedMessage)[]>;
          };
        };
      };
      update: (table: unknown) => {
        set: (input: unknown) => {
          where: (condition: unknown) => {
            returning: () => Promise<(typeof fakeInsertedMessage)[]>;
          };
        };
      };
    }) => Promise<T>,
  ) => {
    const tx = {
      insert: (_table: unknown) => ({
        values: (_input: unknown) => ({
          onConflictDoNothing: (_config: unknown) => ({
            returning: async () =>
              upsertMode === "inserted" ? [fakeInsertedMessage] : [],
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_input: unknown) => ({
          where: (_condition: unknown) => ({
            returning: async () =>
              upsertMode === "updated" ? [fakeInsertedMessage] : [],
          }),
        }),
      }),
    };

    return callback(tx);
  },
};

mock.module("./client", () => ({
  db: fakeDb,
}));

const sessionsModulePromise = import("./sessions");

describe("normalizeLegacySandboxState", () => {
  test("drops state from a removed provider so the session re-provisions", async () => {
    const { normalizeLegacySandboxState } = await sessionsModulePromise;

    // Returning the dead handle would make connect() throw
    // UnsupportedSandboxProviderError on EVERY future reconnect -- a
    // permanently broken session. null means "no live sandbox", so the
    // next connect provisions a fresh one on a new volume.
    expect(
      normalizeLegacySandboxState({
        type: "vercel",
        sandboxName: "session_123",
        expiresAt: 123,
      }),
    ).toBeNull();

    expect(
      normalizeLegacySandboxState({
        type: "boat",
        sandboxId: "bx_legacy-1",
        expiresAt: 123,
      }),
    ).toBeNull();

    // "hybrid" is the oldest label and also reads as unregistered.
    expect(
      normalizeLegacySandboxState({
        type: "hybrid",
        sandboxId: "sbx-legacy-1",
        expiresAt: 123,
      }),
    ).toBeNull();
  });

  test("leaves state from a registered provider untouched", async () => {
    const { normalizeLegacySandboxState } = await sessionsModulePromise;

    // Modal's durable handle is the volume -- it must survive normalization
    // exactly as stored, including the sandbox id of the live container.
    const modalState = {
      type: "modal",
      volumeName: "entry-workspace-session_current-1",
      sandboxId: "sb-live",
      expiresAt: Date.now() + 60_000,
    } as const;

    expect(normalizeLegacySandboxState(modalState)).toEqual(modalState);

    const localState = { type: "local", rootDir: "/tmp/x" } as const;
    expect(normalizeLegacySandboxState(localState)).toEqual(localState);
  });

  test("passes non-object values through untouched", async () => {
    const { normalizeLegacySandboxState } = await sessionsModulePromise;

    expect(normalizeLegacySandboxState(null)).toBeNull();
    expect(normalizeLegacySandboxState(undefined)).toBeUndefined();
    // A malformed row with no discriminator: nothing to normalize, so it
    // is returned as-is and callers treat a typeless object as absent.
    const malformed: unknown = { volumeName: "x" };
    expect(normalizeLegacySandboxState(malformed)).toBe(malformed as null);
  });
});

describe("getUsedSessionTitles", () => {
  beforeEach(() => {
    fakeSelectRows = [];
  });

  test("returns an empty Set when the user has no sessions", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [];

    const result = await getUsedSessionTitles("user-1");
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("returns a Set containing all existing session titles", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [
      { title: "Tokyo" },
      { title: "Paris" },
      { title: "Lagos" },
    ];

    const result = await getUsedSessionTitles("user-1");
    expect(result.size).toBe(3);
    expect(result.has("Tokyo")).toBe(true);
    expect(result.has("Paris")).toBe(true);
    expect(result.has("Lagos")).toBe(true);
  });

  test("deduplicates titles if the DB returns duplicates", async () => {
    const { getUsedSessionTitles } = await sessionsModulePromise;
    fakeSelectRows = [{ title: "Rome" }, { title: "Rome" }];

    const result = await getUsedSessionTitles("user-1");
    expect(result.size).toBe(1);
    expect(result.has("Rome")).toBe(true);
  });
});

describe("upsertChatMessageScoped", () => {
  beforeEach(() => {
    upsertMode = "inserted";
  });

  test("returns inserted when no existing row conflicts", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "inserted";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [] },
    });

    expect(result.status).toBe("inserted");
  });

  test("returns updated when id exists in same chat and role", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "updated";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [{ type: "text" }] },
    });

    expect(result.status).toBe("updated");
  });

  test("returns conflict when id exists for different chat/role scope", async () => {
    const { upsertChatMessageScoped } = await sessionsModulePromise;
    upsertMode = "conflict";

    const result = await upsertChatMessageScoped({
      id: "message-1",
      chatId: "chat-1",
      role: "assistant",
      parts: { id: "message-1", role: "assistant", parts: [{ type: "text" }] },
    });

    expect(result.status).toBe("conflict");
  });
});
