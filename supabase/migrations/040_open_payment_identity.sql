-- Quick payment identity is claimed on the canonical order BEFORE gateway I/O.
-- Null legacy identities are deliberately not guessed from amount/reference:
-- reconcile legacy preferences separately instead of attaching an unsafe hash.
BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_fingerprint TEXT
    CHECK (payment_fingerprint IS NULL OR payment_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS payment_conversation_id UUID;

-- Uncertain/rejected/in-process orders continue holding the claim: their
-- gateway preference may still accept money. Only a paid order releases it.
-- A new identical purchase then obtains its own order/reference/preference.
CREATE UNIQUE INDEX IF NOT EXISTS orders_open_payment_identity_uidx
  ON public.orders (account_id, contact_id, payment_fingerprint)
  WHERE payment_fingerprint IS NOT NULL
    AND contact_id IS NOT NULL
    AND status IS DISTINCT FROM 'paid';

COMMENT ON COLUMN public.orders.payment_fingerprint IS
  'SHA256 of canonical quick-payment-v1 items (including SKU, description, quantity and cents), delivery kind and address; scoped by account/contact. Incomplete claims must be reconciled, never auto-restarted.';
COMMENT ON COLUMN public.orders.payment_conversation_id IS
  'Validated originating conversation. A webhook must not close every conversation for a contact.';

COMMIT;
