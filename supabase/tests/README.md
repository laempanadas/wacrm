# Isolated checkout consent tests

Run from the repository root:

    python3 supabase/tests/flow_checkout_concurrency.py

Requires Python 3 (standard library only), Docker, and the `postgres:17` image.
Use `--rounds 10` to repeat the lock-contention cases more often. `--image`
selects a compatible PostgreSQL container image; no database URL is accepted.

The runner creates its own randomly named disposable cluster with `--network
none`, no published ports, no host bind mounts, and tmpfs database storage.
Cleanup runs in `finally`, including on failures. If the runner is forcibly
killed, remove only its `wacrm-consent-test-*` container manually.

The dependency fixture supplies minimal accounts/auth/conversation tables.
The `flow_nodes` and `flow_runs` CREATE TABLE statements are taken verbatim from
migration 010, with the account column added for the protocol. Migration 038
is applied verbatim, including its triggers, RLS and RPC grants, with
Supabase-style permissive default privileges in place. The existing sequential
`flow_checkout_consent.sql` assertions are then executed.

The concurrent tests call the actual RPCs as `service_role`, using two
persistent database sessions and a separate administrative observer. They
assert `pg_blocking_pids` before releasing the first transaction: a sleep alone
is not accepted as proof of ordering. Cases cover duplicate authorization,
correction before/after authorization, both finish/correction orderings,
rollback and backend termination during uncommitted authorization, stale
revisions/summary buttons, cross-account
rejection and independent authorization in distinct accounts. Claims, frozen
snapshots, correction state and reconciliation evidence are read back from
the real database.

This is protocol verification, not full deployment homologation: it does not
apply the entire Supabase migration chain, inspect a shared environment,
validate real catalog/pipeline/WhatsApp/payment configuration, or make external
messaging/payment calls. The JavaScript suite remains `npm test`; this Docker
integration test is deliberately separate.
The backend-termination case verifies rollback, not an ambiguous disconnect
after commit or an external checkout effect.
