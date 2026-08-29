import type { SandboxState } from "@open-agents/sandbox";
import type { GlobalSkillRef } from "@/lib/skills/global-skill-refs";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// users
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at").defaultNow().notNull(),
  // --- Billing (Paystack-backed credit plans) ---
  // "free" | "plus" | "pro" | "max" -- see lib/billing/plans.ts for the
  // catalog (price, credit grant, model access) each id maps to.
  plan: text("plan", { enum: ["free", "plus", "pro", "max"] })
    .notNull()
    .default("free"),
  // Spendable balance, in USD cents, against the live model cost catalog.
  // Free-plan users get a small one-time trial grant here; paid plans get
  // their creditGrantCents re-topped-up on each successful renewal.
  creditBalanceCents: integer("credit_balance_cents").notNull().default(100),
  // When the current paid billing cycle renews/re-grants credit. Null for
  // free-plan users (no recurring cycle).
  billingCycleAnchor: timestamp("billing_cycle_anchor"),
  paystackCustomerCode: text("paystack_customer_code"),
  paystackSubscriptionCode: text("paystack_subscription_code"),
  // Per-user turn lock (billing correctness): holds the workflowRunId of
  // whichever chat turn is currently allowed to spend this user's
  // balance. Prevents two concurrent turns (e.g. two open tabs/chats)
  // from each reading the same starting balance and both being allowed
  // to spend against it before either notices -- see
  // claimUserBillingTurn/releaseUserBillingTurn in credit-ledger.ts.
  // Null means no turn currently holds the lock.
  activeBillingRunId: text("active_billing_run_id"),
  // When the current activeBillingRunId claim was taken. Used to let a
  // new turn steal a stale lock (e.g. left behind by a crashed/orphaned
  // workflow that never reached its cleanup) after
  // BILLING_TURN_LOCK_STALE_MS -- see claimUserBillingTurn in
  // credit-ledger.ts. Never left permanently stuck.
  activeBillingRunClaimedAt: timestamp("active_billing_run_claimed_at"),
});

// oauth provider accounts
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// better-auth sessions
export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

// better-auth verification tokens
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", {
      enum: ["User", "Organization"],
    }).notNull(),
    repositorySelection: text("repository_selection", {
      enum: ["all", "selected"],
    }).notNull(),
    installationUrl: text("installation_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_user_installation_idx").on(
      table.userId,
      table.installationId,
    ),
    uniqueIndex("github_installations_user_account_idx").on(
      table.userId,
      table.accountLogin,
    ),
  ],
);

export const vercelProjectLinks = pgTable(
  "vercel_project_links",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    projectId: text("project_id").notNull(),
    projectName: text("project_name").notNull(),
    teamId: text("team_id"),
    teamSlug: text("team_slug"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.repoOwner, table.repoName],
    }),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "archived"],
    })
      .notNull()
      .default("running"),
    // Repository info
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    branch: text("branch"),
    cloneUrl: text("clone_url"),
    vercelProjectId: text("vercel_project_id"),
    vercelProjectName: text("vercel_project_name"),
    vercelTeamId: text("vercel_team_id"),
    vercelTeamSlug: text("vercel_team_slug"),
    // Whether this session uses a new auto-generated branch
    isNewBranch: boolean("is_new_branch").default(false).notNull(),
    // Optional per-session override for auto commit + push behavior.
    // null means "use the user's default preference".
    autoCommitPushOverride: boolean("auto_commit_push_override"),
    // Optional per-session override for auto PR creation after auto-commit.
    // null means "use the user's default preference".
    autoCreatePrOverride: boolean("auto_create_pr_override"),
    // Optional per-session override for the permission mode. null means
    // "use the user's default preference" (userPreferences.defaultPermissionMode).
    // "ask": gate dangerous bash, .env reads/writes, and every web_fetch
    //   (unchanged legacy default behavior).
    // "autoAccept": skip the web_fetch approval gate only -- it's the
    //   noisiest one, firing on every single outbound request -- while
    //   still gating dangerous bash and .env access.
    // "fullAccess": skip every approval gate entirely.
    // Deprecated 2026-08-12: autoApproveToolsOverride (boolean) is
    // superseded by this 3-way enum. Left in place, unread, for one
    // release cycle in case any in-flight session still has it set;
    // safe to drop in a later migration.
    autoApproveToolsOverride: boolean("auto_approve_tools_override"),
    permissionModeOverride: text("permission_mode_override", {
      enum: ["ask", "autoAccept", "fullAccess"],
    }),
    globalSkillRefs: jsonb("global_skill_refs")
      .$type<GlobalSkillRef[]>()
      .notNull()
      .default([]),
    // Unified sandbox state
    sandboxState: jsonb("sandbox_state").$type<SandboxState>(),
    // Lifecycle orchestration state for sandbox management
    lifecycleState: text("lifecycle_state", {
      enum: [
        "provisioning",
        "active",
        "hibernating",
        "hibernated",
        "restoring",
        // Added 2026-08-25: session's sandbox is being proactively moved
        // to a fresh sandbox ahead of the Hobby plan's hard 45-min
        // session cap. See lib/sandbox/migration.ts.
        "migrating",
        "archived",
        "failed",
      ],
    }),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at"),
    sandboxExpiresAt: timestamp("sandbox_expires_at"),
    hibernateAfter: timestamp("hibernate_after"),
    lifecycleRunId: text("lifecycle_run_id"),
    sandboxProvisioningRunId: text("sandbox_provisioning_run_id"),
    lifecycleError: text("lifecycle_error"),
    // Added 2026-08-29: consecutive migration-attempt failure count, so
    // sandboxLifecycleWorkflow (apps/web/app/workflows/sandbox-lifecycle.ts)
    // can back off exponentially and eventually give up instead of
    // hot-retrying performSandboxMigration every
    // SANDBOX_LIFECYCLE_MIN_SLEEP_MS (5s) forever on a migration that
    // keeps failing. Reset to 0 on any successful migration or fresh
    // active-lifecycle state. See lib/sandbox/migration.ts.
    migrationFailureCount: integer("migration_failure_count")
      .notNull()
      .default(0),
    // Added 2026-08-25: durable record of the in-flight bash command (if
    // any) running in this session's sandbox, so a process other than
    // the one that started it (the lifecycle workflow, ahead of the
    // hard session-duration cap) can find and kill it before migrating
    // the workspace to a fresh sandbox. Cleared once the command
    // finishes or a migration completes. See lib/sandbox/migration.ts
    // and packages/agent/tools/bash.ts.
    activeSandboxCommand: jsonb("active_sandbox_command").$type<{
      cmdId: string;
      command: string;
      cwd: string;
      startedAt: number;
    } | null>(),
    // Git stats (for display in session list)
    linesAdded: integer("lines_added").default(0),
    linesRemoved: integer("lines_removed").default(0),
    // PR info if created
    prNumber: integer("pr_number"),
    prStatus: text("pr_status", {
      enum: ["open", "merged", "closed"],
    }),
    // Snapshot info (for cached snapshots feature)
    snapshotUrl: text("snapshot_url"),
    snapshotCreatedAt: timestamp("snapshot_created_at"),
    snapshotSizeBytes: integer("snapshot_size_bytes"),
    // Cached diff for offline viewing
    cachedDiff: jsonb("cached_diff"),
    cachedDiffUpdatedAt: timestamp("cached_diff_updated_at"),
    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    modelId: text("model_id").default("gpt-5.6-sol"),
    // Per-chat reasoning-effort preference (e.g. "low"/"medium"/"high"/
    // "xhigh", or a boolean-style "on"/"off" for models that only support
    // toggling thinking rather than graduated effort). Null means "use the
    // model's default reasoning behavior" -- see lib/model-reasoning.ts for
    // the per-model capability catalog and validation.
    reasoningEffort: text("reasoning_effort"),
    activeStreamId: text("active_stream_id"),
    lastAssistantMessageAt: timestamp("last_assistant_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("chats_session_id_idx").on(table.sessionId)],
);

export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("shares_chat_id_idx").on(table.chatId)],
);

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", {
    enum: ["user", "assistant"],
  }).notNull(),
  // Store the full message parts as JSON for flexibility
  parts: jsonb("parts").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatReads = pgTable(
  "chat_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index("chat_reads_chat_id_idx").on(table.chatId),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: text("model_id"),
    status: text("status", {
      enum: ["completed", "aborted", "failed"],
    }).notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    totalDurationMs: integer("total_duration_ms").notNull(),
    // Raw error text (message + first stack line, capped) captured when
    // status is "failed" -- admin-only diagnostic field. Added 2026-08-20
    // after a real incident where the underlying provider/tool error was
    // unrecoverable once Vercel's Hobby-plan runtime log retention (~1hr)
    // expired, making a repeatedly-failing turn (retry hits the same
    // deterministic error every time) impossible to root-cause after the
    // fact. This is a server-side-only field -- never surfaced to the
    // chat UI (see friendly-error.ts for why raw errors must never reach
    // end users); only read by admin tooling.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_runs_chat_id_idx").on(table.chatId),
    index("workflow_runs_session_id_idx").on(table.sessionId),
    index("workflow_runs_user_id_idx").on(table.userId),
  ],
);

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    finishReason: text("finish_reason"),
    rawFinishReason: text("raw_finish_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_run_steps_run_id_idx").on(table.workflowRunId),
    uniqueIndex("workflow_run_steps_run_step_idx").on(
      table.workflowRunId,
      table.stepNumber,
    ),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type VercelProjectLink = typeof vercelProjectLinks.$inferSelect;
export type NewVercelProjectLink = typeof vercelProjectLinks.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatRead = typeof chatReads.$inferSelect;
export type NewChatRead = typeof chatReads.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;

// User preferences for settings
export const userPreferences = pgTable("user_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultModelId: text("default_model_id").default("gpt-5.6-sol"),
  defaultSubagentModelId: text("default_subagent_model_id"),
  defaultSandboxType: text("default_sandbox_type", {
    enum: ["vercel"],
  }).default("vercel"),
  defaultDiffMode: text("default_diff_mode", {
    enum: ["unified", "split"],
  }).default("unified"),
  autoCommitPush: boolean("auto_commit_push").notNull().default(false),
  autoCreatePr: boolean("auto_create_pr").notNull().default(false),
  // Deprecated 2026-08-12: superseded by defaultPermissionMode (3-way
  // enum). Left in place, unread, for one release cycle; safe to drop
  // later. See defaultPermissionMode for the current behavior.
  autoApproveTools: boolean("auto_approve_tools").notNull().default(false),
  // "ask" (default): gate dangerous bash, .env reads/writes, and every
  //   web_fetch behind a manual approval click.
  // "autoAccept": skip the web_fetch approval gate only -- still gates
  //   dangerous bash and .env access. A middle ground for people who
  //   trust the agent's browsing but not its shell/secret access.
  // "fullAccess": skip every approval gate entirely. Explicit, informed
  //   opt-in -- removes the safety net against prompt-injection-driven
  //   secret exfiltration or destructive commands.
  defaultPermissionMode: text("default_permission_mode", {
    enum: ["ask", "autoAccept", "fullAccess"],
  })
    .notNull()
    .default("ask"),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  alertSoundEnabled: boolean("alert_sound_enabled").notNull().default(true),
  publicUsageEnabled: boolean("public_usage_enabled").notNull().default(false),
  // Opt-in mode for `apps/web/app/workflows/chat.ts` / packages/agent's
  // system-prompt.ts: when on, the agent follows the guided frontend
  // workflow (design.md first, section-by-section build+audit via the
  // agent-browser skill, then a systematic states checklist) instead of
  // one-shotting frontend requests. Off by default -- it costs more
  // turns than a plain build. Users can also trigger it for a single
  // turn via an explicit phrase even when this is off; see
  // GUIDED_FRONTEND_WORKFLOW_TRIGGER_PHRASE in chat.ts.
  guidedFrontendWorkflowEnabled: boolean("guided_frontend_workflow_enabled")
    .notNull()
    .default(false),
  globalSkillRefs: jsonb("global_skill_refs")
    .$type<GlobalSkillRef[]>()
    .notNull()
    .default([]),
  // Deprecated 2026-08-11: the model-variant system was replaced by a
  // per-chat reasoningEffort column (see `chats.reasoningEffort` below).
  // Column kept as-is (unread, always []) to avoid a destructive migration;
  // safe to drop in a future cleanup pass.
  modelVariants: jsonb("model_variants")
    .$type<unknown[]>()
    .notNull()
    .default([]),
  enabledModelIds: jsonb("enabled_model_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// Usage tracking — one row per assistant turn (append-only)
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["web"] })
    .notNull()
    .default("web"),
  agentType: text("agent_type", { enum: ["main", "subagent"] })
    .notNull()
    .default("main"),
  provider: text("provider"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

// Admin-controlled per-model kill switch. A row's presence doesn't matter,
// only `disabled` -- upserted on every toggle so `updatedAt`/`updatedBy`
// always reflect the most recent change for the admin models page's audit
// trail. Model IDs are the flat gateway catalog IDs (e.g. "grok-4.5"),
// same namespace as everywhere else in this app.
export const modelOverrides = pgTable("model_overrides", {
  modelId: text("model_id").primaryKey(),
  disabled: boolean("disabled").notNull().default(false),
  updatedBy: text("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ModelOverride = typeof modelOverrides.$inferSelect;
export type NewModelOverride = typeof modelOverrides.$inferInsert;

// Singleton admin kill switch for free-tier access (id is always the
// literal string "singleton" -- there is exactly one row, upserted in
// place). When `freeTierEnabled` is false, every non-admin user is
// blocked from starting new chat turns AND any turn already streaming is
// aborted mid-flight (see startStopMonitor's gate check in
// app/workflows/chat.ts) -- `disabledReason` is shown to the blocked user
// verbatim in both cases, so admins should write it as a user-facing
// sentence, not an internal note.
export const platformSettings = pgTable("platform_settings", {
  id: text("id").primaryKey(),
  freeTierEnabled: boolean("free_tier_enabled").notNull().default(true),
  disabledReason: text("disabled_reason"),
  updatedBy: text("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlatformSettings = typeof platformSettings.$inferSelect;
export type NewPlatformSettings = typeof platformSettings.$inferInsert;

// --- Billing: credit ledger (every grant/topup/debit against a user's
// creditBalanceCents, for auditability and admin support) ---
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: [
        "signup_trial",
        "subscription_grant",
        "topup",
        "usage_debit",
        "refund",
        "admin_adjustment",
      ],
    }).notNull(),
    // Positive for credits (grants/topups/refunds), negative for debits.
    amountCents: integer("amount_cents").notNull(),
    balanceAfterCents: integer("balance_after_cents").notNull(),
    description: text("description"),
    modelId: text("model_id"),
    paystackReference: text("paystack_reference"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("credit_transactions_user_id_idx").on(table.userId)],
);

// --- Billing: idempotency + audit log for inbound Paystack webhooks ---
export const paystackWebhookEvents = pgTable(
  "paystack_webhook_events",
  {
    id: text("id").primaryKey(),
    paystackEventId: text("paystack_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload"),
    processedAt: timestamp("processed_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("paystack_webhook_events_event_id_idx").on(
      table.paystackEventId,
    ),
  ],
);

// --- Public benchmark page: precomputed harness-based eval results ---
// One row per benchmark execution batch (e.g. "run the suite against
// every current model"). The public /benchmarks page only ever reads
// the most recent row with status "completed" -- never triggers a live
// run itself (real harness runs are slow/costly: repo clone + real
// sandbox + real tool calls per task). Runs are kicked off by an
// admin-only action (see lib/benchmarks/run-suite.ts) or a scheduled
// job, never by public traffic.
export const benchmarkRuns = pgTable(
  "benchmark_runs",
  {
    id: text("id").primaryKey(),
    status: text("status", {
      enum: ["running", "completed", "failed"],
    })
      .notNull()
      .default("running"),
    // Which suite definition this run used -- lets us change the task
    // set over time without invalidating history (each run records the
    // shape it was actually run against).
    suiteVersion: text("suite_version").notNull(),
    // Free-text list of model IDs this run covers, for quick display
    // without joining benchmark_results.
    modelIds: jsonb("model_ids").notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    // Only ever set by the admin trigger -- never client-supplied.
    triggeredBy: text("triggered_by"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("benchmark_runs_status_idx").on(table.status)],
);

// One row per (run, model, benchmark, task). Graded pass/fail is stored
// per-task so the page can aggregate however it wants (per-benchmark %,
// overall %, cost, latency) without re-grading. transcriptUrl points at
// a stored transcript (private file upload) for the "show real
// transcripts, not just a number" credibility requirement -- never
// inlines full transcripts in this table to keep rows small.
export const benchmarkResults = pgTable(
  "benchmark_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    benchmark: text("benchmark", {
      enum: ["humaneval", "swebench_verified", "entry_tasks"],
    }).notNull(),
    taskId: text("task_id").notNull(),
    passed: boolean("passed").notNull(),
    latencyMs: integer("latency_ms"),
    costCents: integer("cost_cents"),
    errorMessage: text("error_message"),
    transcriptUrl: text("transcript_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("benchmark_results_run_id_idx").on(table.runId),
    index("benchmark_results_model_id_idx").on(table.modelId),
    index("benchmark_results_benchmark_idx").on(table.benchmark),
  ],
);

// Self-serve, user-configured MCP (Model Context Protocol) servers --
// the "paste any MCP server URL" path for extending the agent with
// external tools, as opposed to a curated vendor catalog. See
// packages/agent/tools/mcp.ts for the connector that actually uses
// these once resolved per-request, and lib/mcp/header-encryption.ts
// for why `encryptedHeaders` is encrypted rather than plain jsonb.
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // User-facing label AND the tool-namespace segment
    // (mcp__<name>__<tool>) -- kept short and slug-like on write.
    name: text("name").notNull(),
    transport: text("transport", { enum: ["http", "sse"] }).notNull(),
    url: text("url").notNull(),
    // AES-256-GCM ciphertext of a Record<string, string> (e.g. an
    // Authorization header carrying that server's API key), or null
    // if the server needs no auth. Never decrypted for display --
    // only decrypted server-side, per-request, right before opening
    // the MCP connection. See lib/mcp/header-encryption.ts.
    encryptedHeaders: text("encrypted_headers"),
    // Independent of the underlying MCP server being reachable --
    // lets a user turn a server off without losing/re-entering its
    // config, and is checked before every request re-attempts a
    // connection to a server that's been failing.
    enabled: boolean("enabled").notNull().default(true),
    lastConnectionError: text("last_connection_error"),
    lastConnectionCheckedAt: timestamp("last_connection_checked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("mcp_servers_user_id_idx").on(table.userId),
    uniqueIndex("mcp_servers_user_id_name_idx").on(table.userId, table.name),
  ],
);

export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;

// Persists the Composio session ID we mint for each Entry user so the
// chat request path resumes the same session across turns instead of
// creating a fresh one on every message (Composio's own guidance --
// see docs/agents/lessons-learned.md and .agents/skills/composio).
// One row per user; not encrypted -- a session ID is only usable
// together with our own COMPOSIO_API_KEY (never exposed to this
// table or to the client), so it carries no standalone value if it
// leaked, unlike the mcp_servers.encryptedHeaders column above.
export const composioSessions = pgTable("composio_sessions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ComposioSessionRow = typeof composioSessions.$inferSelect;
export type NewComposioSessionRow = typeof composioSessions.$inferInsert;
