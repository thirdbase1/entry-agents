-- 0061: rename the Paystack-shaped billing columns/tables to provider-neutral
-- names for the Paystack -> Bachs migration.
--
-- Hand-written (no drizzle snapshot), matching how 0058-0060 were added:
-- migration history is append-only, so 0043_pink_mantis.sql -- which
-- CREATEs these -- is left exactly as it was.
--
-- Data is preserved: this is a pure rename, so every existing
-- paystack_customer_code / paystack_subscription_code / paystack_reference
-- value and every idempotency row carries over. Users already subscribed
-- through Paystack keep their stored codes; the Bachs webhook simply never
-- matches them again (their subscription already ended with the cutover).

ALTER TABLE users
  RENAME COLUMN paystack_customer_code TO billing_customer_code;

ALTER TABLE users
  RENAME COLUMN paystack_subscription_code TO billing_subscription_code;

ALTER TABLE credit_transactions
  RENAME COLUMN paystack_reference TO billing_reference;

ALTER TABLE paystack_webhook_events RENAME TO billing_webhook_events;

ALTER TABLE billing_webhook_events
  RENAME COLUMN paystack_event_id TO event_key;

ALTER INDEX paystack_webhook_events_event_id_idx
  RENAME TO billing_webhook_events_event_key_idx;
