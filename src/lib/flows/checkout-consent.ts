import type { FlowRunRow } from './types';
import { supabaseAdmin } from './admin-client';
type DB = ReturnType<typeof supabaseAdmin>;

// These RPCs all lock the same account-scoped flow_runs row. No local mutex,
// lease expiry, or resumed worker can reauthorize an insert-only checkout claim.
export async function writeFlowVars(
  db: DB,
  run: FlowRunRow,
  vars: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await db.rpc('flow_checkout_write', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_revision: run.consent_revision ?? 0,
    p_snapshot: run.vars,
    p_vars: vars,
  });
  if (error) throw new Error(`Consent write failed: ${error.message}`);
  const row = data?.[0] as FlowRunRow | undefined;
  if (!row) return false;
  Object.assign(run, row);
  return true;
}

export async function authorizeFlowCheckout(
  db: DB,
  run: FlowRunRow
): Promise<string | null> {
  const { data, error } = await db.rpc('flow_checkout_authorize', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_revision: run.consent_revision ?? 0,
    p_snapshot: run.vars,
  });
  if (error) throw new Error(`Checkout authorization failed: ${error.message}`);
  return data?.[0]?.claim_id ?? null;
}

export async function correctFlowCheckout(
  db: DB,
  run: Pick<FlowRunRow, 'id' | 'account_id'>,
  text: string
): Promise<void> {
  const { data, error } = await db.rpc('flow_checkout_correct', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_text: text,
  });
  if (error || !data?.[0])
    throw new Error('Order correction could not be persisted');
  Object.assign(run, data[0]);
}

export async function finishFlowCheckout(
  db: DB,
  run: FlowRunRow,
  claimId: string,
  evidence: Record<string, unknown>,
  success: boolean
): Promise<boolean> {
  const { data, error } = await db.rpc('flow_checkout_finish', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_claim_id: claimId,
    p_evidence: evidence,
    p_success: success,
  });
  if (error || !data?.[0])
    throw new Error(
      'Checkout evidence could not be persisted; claim remains blocking'
    );
  if (!data[0].owned || !success) return false;
  run.vars = data[0].vars;
  run.consent_revision = data[0].consent_revision;
  return true;
}

export async function confirmFlowCheckout(
  db: DB,
  run: FlowRunRow,
  message: {
    meta_message_id: string;
    kind: string;
    text?: string;
    reply_id?: string;
    context_message_id?: string;
  }
): Promise<boolean> {
  // A static reply_id identifies an action, never the summary being accepted.
  // Recheck under the SQL row lock too, since this snapshot can become stale.
  if (
    message.kind === 'interactive_reply' &&
    (!message.context_message_id ||
      message.context_message_id !== run.consent_prompt_message)
  )
    return false;
  const { data, error } = await db.rpc('flow_checkout_confirm', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_revision: run.consent_revision ?? 0,
    p_snapshot: run.vars,
    p_inbound_message: message.meta_message_id,
    p_kind: message.kind,
    p_reply: message.kind === 'text' ? message.text : message.reply_id,
    p_context_message:
      message.kind === 'interactive_reply' ? message.context_message_id : null,
  });
  if (error) throw new Error(`Consent confirmation failed: ${error.message}`);
  if (!data?.[0]) return false;
  Object.assign(run, data[0]);
  return true;
}

/** Exact snapshot/status/node CAS for suspension, progression and termination. */
export async function transitionFlowRun(
  db: DB,
  run: FlowRunRow,
  patch: Record<string, unknown>,
  promptMessage: string | null = null
): Promise<boolean> {
  const { data, error } = await db.rpc('flow_checkout_transition', {
    p_account_id: run.account_id,
    p_run_id: run.id,
    p_revision: run.consent_revision ?? 0,
    p_snapshot: run.vars,
    p_node: run.current_node_key,
    p_patch: patch,
    p_prompt_message: promptMessage,
  });
  if (error) throw new Error(`Flow transition failed: ${error.message}`);
  if (!data?.[0]) return false;
  Object.assign(run, data[0]);
  return true;
}
