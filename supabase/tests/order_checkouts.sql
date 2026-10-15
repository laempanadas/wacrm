-- Run only in an isolated PostgreSQL fixture after migration 037.
-- All fixture rows and grants are rolled back. Never run against production.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.order_checkouts'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'Ledger must have RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'order_checkouts') THEN
    RAISE EXCEPTION 'Ledger must not have client policies';
  END IF;
END $$;
INSERT INTO public.order_checkouts(account_id, external_reference, input_fingerprint, snapshot)
VALUES ('00000000-0000-0000-0000-000000000001', 'SQL-checkout-test', repeat('a', 64), '{"items":[{"id":"sku-a"}],"total":10}'::jsonb);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.order_checkouts(account_id, external_reference, input_fingerprint, snapshot)
    VALUES ('00000000-0000-0000-0000-000000000001', 'SQL-checkout-test', repeat('a', 64), '{}'::jsonb);
    RAISE EXCEPTION 'Duplicate claim was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.order_checkouts SET snapshot = '{}'::jsonb WHERE external_reference = 'SQL-checkout-test';
    RAISE EXCEPTION 'Frozen input was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.order_checkouts SET status = 'completed' WHERE external_reference = 'SQL-checkout-test';
    RAISE EXCEPTION 'Incomplete success was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO public.order_checkouts(account_id, external_reference, input_fingerprint, snapshot)
VALUES ('00000000-0000-0000-0000-000000000002', 'SQL-checkout-test', repeat('a', 64), '{}');
UPDATE public.order_checkouts SET status = 'uncertain', error = 'timeout'
WHERE account_id = '00000000-0000-0000-0000-000000000001' AND external_reference = 'SQL-checkout-test';
INSERT INTO public.orders(account_id, external_reference, total, total_amount, items)
VALUES ('00000000-0000-0000-0000-000000000001', 'SQL-checkout-test', 10, 10, '[{"id":"sku-a"}]');
UPDATE public.order_checkouts SET status = 'completed',
  order_id = (SELECT id FROM public.orders WHERE external_reference = 'SQL-checkout-test'),
  deal_id = '00000000-0000-0000-0000-000000000003', preference_id = 'pref', payment_url = 'https://payment.test/link'
WHERE account_id = '00000000-0000-0000-0000-000000000001' AND external_reference = 'SQL-checkout-test';
GRANT SELECT, INSERT ON public.order_checkouts TO authenticated;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.order_checkouts) <> 0 THEN
    RAISE EXCEPTION 'Client can see checkout ledger';
  END IF;
  BEGIN
    INSERT INTO public.order_checkouts(account_id, external_reference, input_fingerprint, snapshot)
    VALUES ('00000000-0000-0000-0000-000000000001', 'SQL-client-attempt', repeat('a', 64), '{}');
    RAISE EXCEPTION 'Client acquired a checkout';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.orders(account_id, external_reference)
    VALUES ('00000000-0000-0000-0000-000000000001', 'SQL-checkout-test');
    RAISE EXCEPTION 'Duplicate canonical order allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
ROLLBACK;
