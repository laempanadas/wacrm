# Payments finalization evidence

## Completed owned payment scope

- Authenticated GET status first resolves `(account_id, external_reference)` using explicit service-role scoping (037 may make orders server-only). It rejects missing/duplicate references, missing preferences and globally ambiguous preference bindings BEFORE gateway I/O. Foreign identifiers never appear in error bodies.
- Replaced global latest-one Payment.search reference resolution with the SDK-supported MerchantOrder.search preference filter. Truncated result sets, multiple payment attempts and inconsistent identities require reconciliation; no latest-payment selection.
- Gateway identity is verified Payment.get -> MerchantOrder.get -> Preference.get, including IDs, positive integer collector, reference, membership, exact BRL currency and cents. Installed SDK 3.2.1 exercised with mocked HTTP transport and actual URLs. No invented payment preference fields. Authorized-but-uncaptured is in_process, not approved.
- Webhook derives CRM ownership from the unique persisted preference binding, ignores supplied account IDs, validates contact/deal/pipeline ownership before mutations, and account/preference/reference-scopes both approved and non-approved order writes. Missing transition rows are distinguished from concurrent already-paid winners; DB failures return failure.
- Replaced payment-specific use of generic moveDealToStage. That helper would overwrite orders.paid with payment_approved, defeating duplicate notification exclusion. Payment follow-up now updates only the account-bound deal and leaves paid monotonic. Real stage resolution + linked legacy + repeated notifications tested.
- Standalone POST payment writer no longer drops malformed SKU lines or casts arbitrary quantities, reuses a global recent order, treats a reference as an unchecked deal FK, or reports success on failed persistence. It validates contact/deal/conversation links, preserves SKU IDs, claims a canonical order before gateway I/O, disables preference transport retries, then requires a durable bound order ID before returning the URL. Incomplete canonical claims stay blocking.
- createOrderWithMercadoPago now checks service-role contact/conversation ownership, validates completed replay against canonical storage, and shares the pre-gateway canonical insert-only order claim with standalone POST. This prevents independent writers from each issuing a preference before one loses the final order insert. Final canonical persistence is a scoped conditional update, not a late insert. Updated accompanying real-creator ownership fixture tests to include actual account-owned contacts/conversations and explicit uncertain reservation expectations.

## Permanent tests / verification

TDD RED outputs observed for: status tenant scoping/ambiguity, API false-success/foreign-reference/ownership/concurrency, webhook ownership/non-approved DB errors/scoped writes/unknown bindings, orchestrator foreign FKs/preexisting canonical/replay missing canonical, SDK malformed IDs/collectors/authorized status.

Final commands (actual execution):

- `npx vitest run src/app/api/payments src/lib/payments src/lib/orders` — **20 files, 287 tests passed**.
- `npx eslint src/app/api/payments src/lib/payments src/lib/orders/create-order-with-mercado-pago.ts src/lib/orders/create-order-with-mercado-pago.test.ts src/lib/orders/checkout-deal-ownership.test.ts` — exit 0, no lint errors. Removed explicit-any route test mocks using a typed database boundary helper; no blanket lint suppression.
- `npm run typecheck` — exit 0.
- `git diff --check` — exit 0.
- Scoped modified/new TS files formatted with installed Prettier.

## Legacy/configuration/migration constraints

- `MP_ACCESS_TOKEN` remains the server-only integration credential. Persisted verified preference ownership is the CRM binding; global token access or request/body account IDs are not proof of account ownership.
- `MERCADO_PAGO_WEBHOOK_SECRET` remains optional legacy configuration; when provided signatures are enforced. Gateway verification is mandatory regardless of that setting. Production should configure the secret.
- Linked legacy Checkout Pro orders retain support when their canonical preference/reference/account/amount can be verified. Unlinked legacy payments/orders, duplicate bindings, missing data and ambiguous attempts explicitly fail closed and require operator reconciliation; no automatic reference matching/backfill.
- Existing 037 orders `(account_id, external_reference)` unique index is REQUIRED for cross-writer exclusion. No 037/038 edits, no new migration, no RLS weakening, and no migration/deploy against shared systems were performed by this child. Parent separately reported isolated migration validation.
- Canonical `checkout_uncertain` rows without a verified preference are intentionally retained, not auto-restarted. A DB with a legacy restrictive orders.status enum/check must explicitly reconcile that schema before using new reservation writes; rejected claims fail BEFORE gateway effects. The existing text-status canonical schema supports the marker.
- Gateway reply arriving before canonical binding persistence yields explicit unknown-binding/reconciliation failure and can retry after the binding becomes durable. A crash after remote creation but before final storage cannot create another preference automatically.
- Notifications/CRM follow-up remain best-effort after the paid transition: a crash can lose a confirmation, not duplicate a gateway charge. There is no new delivery outbox.
- No commit/push/deploy, production credentials, real messages, real payment creation, shared migration or destructive cleanup by this child.

## Out-of-owned-scope audit findings requiring parent action

The ALL-consumer audit found existing payment consumers outside the assigned `src/app/api/payments/**`, `src/lib/payments/**` and permitted orchestrator scope. **Do not declare ALL-consumer isolation complete until these are addressed by their owner:**

1. **`src/app/api/cron/payment-reminders/route.ts` (blocking):** reads only five global WhatsApp configurations; selects matching account config OR silently falls back to `allConfigs[0]` (lines 67-111). Deduplicates phones globally rather than `(account_id, phone)` (82-88). After sending it marks every pending order with the same payer_phone across accounts, without account_id (208-215). It also trusts payer_phone without validating contact ownership. Requires exact account-owned integration lookup, no fallback, account-local dedupe/update and trusted recipient binding. Not modified because explicitly outside child write ownership.
2. **`src/app/api/deals/[id]/mark-paid/route.ts`:** account-scoped initial deal lookup is followed by pipeline lookup and a non-delivery deal update by ID alone; contact tagging receives the deal.contact_id without a scoped contact ownership check. The final orders write itself is account-scoped. Parent should validate service-role FKs and scope deal updates before notification/contact mutation.
3. **`src/lib/orders/custom-fields.ts` getSavedCustomerAddress:** reads recent orders and deals by contact_id alone (138-161), unlike saveContactOrderFields which filters definitions by account. Parent-owned order callers should ensure account scope/contact ownership before using this fallback; this is not invoked by webhook payment confirmation.

The owned webhook no longer invokes unscoped/degrading legacy updateDealWithPayment/moveDealToStage paths. Shared helpers themselves remain outside this child's modification scope.
