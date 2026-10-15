-- Canonical checkout storage. Additive only: do not change existing orders
-- columns, RLS, policies, or legacy uniqueness constraints.
-- Existing duplicates of (account_id, external_reference) deliberately make
-- this migration fail: reconcile them explicitly instead of deleting orders.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    CREATE TABLE IF NOT EXISTS public.orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid()
    );
    -- Newly created canonical tables are server-only. Existing orders RLS is
    -- left untouched. Client access, if needed, requires a separate policy.
    ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS contact_id UUID,
  ADD COLUMN IF NOT EXISTS deal_id UUID,
  ADD COLUMN IF NOT EXISTS external_reference TEXT,
  ADD COLUMN IF NOT EXISTS preference_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_url TEXT,
  ADD COLUMN IF NOT EXISTS total NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS items JSONB,
  ADD COLUMN IF NOT EXISTS delivery_kind TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS payer_phone TEXT,
  ADD COLUMN IF NOT EXISTS payer_name TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS paid_online BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS orders_account_external_reference_checkout_uidx
  ON public.orders (account_id, external_reference);

CREATE TABLE IF NOT EXISTS public.order_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  external_reference TEXT NOT NULL CHECK (length(external_reference) > 0),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed', 'uncertain')),
  deal_id UUID,
  order_id UUID,
  preference_id TEXT,
  payment_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, external_reference),
  CHECK (status <> 'completed' OR (
    order_id IS NOT NULL AND deal_id IS NOT NULL
    AND preference_id IS NOT NULL AND length(preference_id) > 0
    AND payment_url IS NOT NULL AND length(payment_url) > 0
  ))
);

-- No client policies: only the service role may acquire/reconcile a checkout.
ALTER TABLE public.order_checkouts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.guard_order_checkout_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
    OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
    OR NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'Checkout identity and input snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_checkouts_frozen_snapshot ON public.order_checkouts;
CREATE TRIGGER order_checkouts_frozen_snapshot
  BEFORE UPDATE ON public.order_checkouts
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_checkout_snapshot();

COMMENT ON TABLE public.order_checkouts IS
  'Durable checkout claim: never auto-retry processing/failed/uncertain. Reconcile with the gateway and canonical orders before any new operation.';

COMMIT;
