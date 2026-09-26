-- 0062: durable chat lifecycle.
--
-- Hand-written (no drizzle snapshot), matching 0058-0061.
--
-- The chat had no lifecycle state at all -- only active_stream_id -- so
-- "is this chat working?" was inferred by the client from its own
-- optimistic overlay plus polling. The workflow now records it, making
-- the workflow the source of truth and any client (browser, phone,
-- desktop, second device) a pure viewer.
--
-- `status` is text, not an enum type, for the same reason `sessions.status`
-- and `workflow_runs.status` are: the application validates, the database
-- stores. Existing rows are 'idle' because a chat with no run is idle by
-- definition; active rows get corrected by the workflow's next write.
--
-- Backfilling anything richer would be a lie: we cannot reconstruct
-- historical run state from active_stream_id alone (a null value means
-- either "never ran" or "finished long ago").

ALTER TABLE chats
  ADD COLUMN status text NOT NULL DEFAULT 'idle';

ALTER TABLE chats
  ADD COLUMN run_status_updated_at timestamp;
