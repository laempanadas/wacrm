import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
export type Call = {
  table: string;
  op: string;
  filters: Array<[string, unknown]>;
  payload: Row;
  options: { onConflict?: string; ignoreDuplicates?: boolean };
};
/** Simulates DB boundaries, including 037's composite uniqueness and DO NOTHING.
 * The creator and custom-field persistence remain real. No credentials/network. */
export function createOrderTestDatabase() {
  const tables: Record<string, Row[]> = {
    pipelines: [{ id: 'pipe', account_id: 'acc', name: 'Pedidos Delivery' }],
    pipeline_stages: [{ id: 'novo', pipeline_id: 'pipe', name: 'Novo Pedido' }],
    tags: [{ id: 'tag', account_id: 'acc', name: 'Aguardando Pagamento' }],
    orders: [],
    deals: [],
    contact_tags: [],
    custom_fields: [],
    contact_custom_values: [],
  };
  const calls: Call[] = [];
  const errors: Record<string, { code: string; message: string }> = {};
  const missing = new Set<string>();
  const hooks: { before?: (call: Call) => void } = {};
  let seq = 0;
  const from = (table: string) => {
    let op = 'select';
    let payload: Row = {};
    let options: Call['options'] = {};
    const filters: Call['filters'] = [];
    const run = () => {
      const call = {
        table,
        op,
        filters: [...filters],
        payload: structuredClone(payload),
        options,
      };
      calls.push(call);
      hooks.before?.(call);
      const key = `${table}:${op}`;
      if (errors[key]) return { data: null, error: errors[key] };
      if (missing.has(key)) return { data: null, error: null };
      const rows = (tables[table] ??= []);
      if (op === 'insert' || op === 'upsert') {
        if (
          table === 'orders' &&
          op === 'upsert' &&
          options.onConflict !== 'account_id,external_reference'
        )
          return {
            data: null,
            error: { code: '42P10', message: 'no matching unique constraint' },
          };
        const keys = (
          options.onConflict ??
          (table === 'orders' ? 'account_id,external_reference' : 'id')
        ).split(',');
        const existing =
          payload.external_reference !== null &&
          rows.find((r) =>
            keys.every((k) => payload[k] !== undefined && r[k] === payload[k])
          );
        if (existing) {
          if (op === 'insert')
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key' },
            };
          if (options.ignoreDuplicates) return { data: [], error: null };
          Object.assign(existing, structuredClone(payload));
          return { data: [structuredClone(existing)], error: null };
        }
        const row = { id: `${table}-${++seq}`, ...structuredClone(payload) };
        rows.push(row);
        return { data: [structuredClone(row)], error: null };
      }
      const matched = rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      if (op === 'update')
        matched.forEach((r) => Object.assign(r, structuredClone(payload)));
      return { data: structuredClone(matched), error: null };
    };
    const single = async () => {
      const result = run();
      return { ...result, data: result.data?.[0] ?? null };
    };
    const q = {
      select: () => q,
      limit: () => q,
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      is: (k: string, v: unknown) => (filters.push([k, v]), q),
      in: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      upsert: (p: Row, opts: Call['options'] = {}) => (
        (op = 'upsert'),
        (payload = p),
        (options = opts),
        q
      ),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      maybeSingle: single,
      single,
      then: (resolve: (r: ReturnType<typeof run>) => void) =>
        Promise.resolve(run()).then(resolve),
    };
    return q;
  };
  return {
    db: { from } as unknown as SupabaseClient,
    tables,
    calls,
    errors,
    missing,
    hooks,
  };
}

export const createOrderTestContext = { accountId: 'acc', userId: 'user' };
export const createOrderTestInput = {
  contactId: 'contact',
  customerName: 'Maria',
  deliveryKind: 'retirada' as const,
  paymentMethod: 'na_retirada' as const,
  total: 28,
  external_reference: 'SAME',
};
