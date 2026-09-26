-- 0063: server-backed composer queue.
--
-- Hand-written (no drizzle snapshot), matching 0058-0062.
--
-- The queue of prompts a user writes while a turn is running lived in
-- React state on a single client. It was wiped on chat switch and on
-- reload (session-chat-content.tsx reset it in an effect keyed on
-- chatInfo.id), so anything typed during a long turn was lost, and no
-- other device could ever see it.
--
-- jsonb rather than a table: the queue is per-chat, small (bounded by
-- the composer), ordered, and never queried by the database -- only read
-- and written whole by one chat's own UI. A table would add joins and
-- migrations for a list that never needs SQL.

ALTER TABLE chats
  ADD COLUMN queued_prompts jsonb;
