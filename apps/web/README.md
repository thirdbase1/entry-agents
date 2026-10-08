# Entry Agents web runtime

Entry Agents is the web editor and agent workspace for entry-agents.dev. The editor can start from a blank Workspace, uploaded files, or an optional GitHub repository. The public runtime uses Entry Gateway for model routing and boxd for private Workspaces.

## Environment

Required for the editor and agent runtime:

| Variable | Purpose |
|---|---|
| `POSTGRES_URL` | Session, chat, usage, and billing data. |
| `BETTER_AUTH_SECRET` | Session signing and encryption. |
| `BETTER_AUTH_URL` | Canonical auth origin. |
| `NEXT_PUBLIC_SITE_URL` | Canonical public URL and metadata. |
| `GATEWAY_BASE_URL` | Entry Gateway base URL. |
| `GATEWAY_API_KEY` | Entry Gateway authentication. |
| `BOXD_API_KEY` or `BOXD_TOKEN` | boxd Workspace authentication. |

`BOXD_BASE_URL` is optional and only needed for a non-default boxd cluster. `PARALLEL_API_KEY` enables the agent web-search tool but is not needed for file editing, shell commands, or normal web fetches. Sign-in provider variables are needed for the enabled OAuth buttons. GitHub App variables are optional until a user connects a repository or uses Git delivery features. See `.env.example` for the complete inventory.

There is no separate sandbox or Workspace charge in the product pricing model. Credits are used for model usage through Entry Gateway.
