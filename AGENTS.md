# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

**This is a living document.** When you make a mistake or learn something new about this codebase, add it to [Lessons Learned](docs/agents/lessons-learned.md).

## Quick Links

- [Architecture & Workspace Structure](docs/agents/architecture.md)
- [Code Style & Patterns](docs/agents/code-style.md)
- [Lessons Learned](docs/agents/lessons-learned.md)

## Authentication

Authentication uses [Better Auth](https://www.better-auth.com/) with Vercel OAuth (sign-in) and GitHub OAuth (repo access). Config lives in `apps/web/lib/auth/config.ts`. Sessions are managed by better-auth's built-in session system — there is no manual JWE/encryption layer.

Key env vars: `BETTER_AUTH_SECRET` (session signing), `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` + `VERCEL_APP_CLIENT_SECRET` (Vercel OAuth), plus GitHub App credentials for repo access.

## Sandbox provider

Agents run in sandboxes provisioned by a provider **registry plugin** (`packages/sandbox`): each provider owns its adapter (`<provider>/connect.ts`, `state.ts`), registers itself in `registry.ts` + `registry-types.ts`, and declares what it can do via `SandboxCapabilities`. Nothing in the agent, workflows, or UI branches on a provider name — behaviour is read off capabilities.

Registered providers: **modal** (default) and **local** (dev/test only). Vercel and Boat were removed; `isKnownSandboxType()` returns false for them, so a stale session row fails closed and re-provisions instead of erroring forever.

Modal specifics that are easy to get wrong:

- **Credentials** resolve in exactly one place, `packages/sandbox/modal/client.ts`, from `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`. Never write a token to sandbox state, tool output, or logs; `setGitHubAuthToken` is per-exec env injection, never persisted.
- **The workspace Volume** is mounted at `/workspace` (a symlink to `/__modal/volumes/<id>`) and **requires `OPEN_AGENTS_SANDBOX_DRIVE=true`**. Without it no volume is attached, and the "no migration needed" property silently does not hold.
- **No workspace migration**: `MODAL_CAPABILITIES.workspaceMigration` is false because the Volume outlives any sandbox. Re-provisioning remounts the same bytes.
- **No kill RPC**: `ContainerProcess` has only `wait()`, so commands are wrapped to echo a `__ENTRY_PID__` marker and `killCommand()` signals that PID in-sandbox. Reading that PID MUST be incremental (`getReader()`), never `readText()` — the latter only resolves at EOF, which a detached command never reaches.

See `apps/web/.env.example` for the full environment variable list.

## Database & Migrations

Schema lives in `apps/web/lib/db/schema.ts`. Migrations are managed by Drizzle Kit.

**After modifying `schema.ts`, always generate a migration:**

```bash
pnpm --dir apps/web db:generate   # Creates a new .sql migration file
```

Commit the generated `.sql` file alongside the schema change. **Do not use `db:push`** except for local throwaway databases.

Migrations run automatically during `pnpm build` (via `lib/db/migrate.ts`), so every Vercel deploy — both preview and production — applies pending migrations to its own database.

### Environment isolation

Neon database branching is enabled in the Vercel project settings. Every preview deployment automatically gets its own isolated database branch forked from production. This means preview deployments never read or write production data. Production deployments use the main Neon database.

## Commands

```bash
# Development
pnpm web            # Run web app

# Quality checks (REQUIRED after making any changes)
pnpm run ci                             # Required: run format check, lint, typecheck, and tests
turbo typecheck                            # Type check all packages

# Linting and formatting (Ultracite - oxlint + oxfmt, run from root)
pnpm check                              # Lint and format check all files
pnpm fix                                # Lint fix and format all files

# Filter by package (use --filter)
turbo typecheck --filter=web # Type check web app only

# Testing
bun test                                              # Run all tests
bun test path/to/file.test.ts                         # Run single test file
bun test --watch                                      # Watch mode
pnpm test:verbose                                  # Run tests with JUnit reporter streamed to stdout (useful in non-interactive shells)
pnpm test:verbose path/to/file.test.ts             # Same verbose output for a single test file
```

**CI/script execution rules:**

- Run project checks through package scripts (for example `pnpm run ci`, `pnpm --dir apps/web db:check`).
- Prefer `pnpm <script>` over invoking tool binaries directly (`pnpm exec`, `tsc`, `eslint`, etc.) so local runs match CI behavior.

## Git Commands

- **Branch sync preference:** When bringing in `origin/main`, prefer a normal merge (`git fetch origin main` then `git merge origin/main`) instead of rebasing, unless explicitly requested otherwise.

**Quote paths with special characters**: File paths containing brackets (like Next.js dynamic routes `[id]`, `[slug]`) are interpreted as glob patterns by zsh. Always quote these paths in git commands:

```bash
# Wrong - zsh interprets [id] as a glob pattern
git add apps/web/app/tasks/[id]/page.tsx
# Error: no matches found: apps/web/app/tasks/[id]/page.tsx

# Correct - quote the path
git add "apps/web/app/tasks/[id]/page.tsx"
```

## Architecture (Summary)

```
Web -> Agent (packages/agent) -> Sandbox (packages/sandbox)
```

See [Architecture & Workspace Structure](docs/agents/architecture.md) for details.

## File Organization & Separation of Concerns

- Do **not** append new functionality to the bottom of an existing file by default.
- Before adding code, decide whether the behavior is a separate concern that should live in its own file.
- Prefer creating a new colocated file for distinct concerns (components, hooks, utilities, schemas, data-access helpers, etc.).
- If a file is already large or handling multiple responsibilities, extract the new logic (and related helpers/types) into focused modules and import them.
- For large page/view/client components, default to adding new feature behavior in colocated hooks and colocated child components instead of growing the main file.
- If a change introduces a distinct cluster of state, effects, handlers, API calls, or derived UI labels for one feature, treat that as a strong signal to extract it.
- Keep each file focused on one primary responsibility; avoid mixing unrelated UI, business logic, and data-access code in the same file.

## Code Style (Summary)

- **pnpm exclusively for dependency management**; use Node 24 for utility scripts and Bun for tests
- **Files**: kebab-case, **Types**: PascalCase, **Functions**: camelCase
- **Never use `any`** -- use `unknown` and narrow with type guards
- **No `.js` extensions** in imports
- **Ultracite** (oxlint + oxfmt) for linting and formatting (double quotes, 2-space indent)
- **Zod** schemas for validation, derive types with `z.infer`

See [Code Style & Patterns](docs/agents/code-style.md) for full conventions, tool implementation patterns, and dependency patterns.
