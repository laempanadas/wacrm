import type { SupabaseClient } from '@supabase/supabase-js';
export type PaymentTestRow = Record<string, unknown>;
type DatabaseError = { message?: string; code?: string };
type Result = {
  data: PaymentTestRow | PaymentTestRow[] | null;
  error: DatabaseError | null;
};
type Query = {
  select: (fields?: string) => Query;
  eq: (key: string, value: unknown) => Query;
  neq: (key: string, value: unknown) => Query;
  or: (filter: string) => Query;
  order: (key?: string, options?: unknown) => Query;
  limit: (n: number) => Query;
  insert: (payload: PaymentTestRow) => Query;
  update: (payload: PaymentTestRow) => Query;
  single: () => Query;
  maybeSingle: () => Query;
  then: (
    resolve: (value: Result) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise<unknown>;
};
/** Database boundary with real filters, composite uniqueness and conditional
 * writes. Route tests execute production handlers/SDK rather than mock them. */
export function paymentDatabase(
  tables: Record<string, PaymentTestRow[]> = { orders: [] }
) {
  const failures: Record<string, DatabaseError> = {};
  const missing: Record<string, boolean> = {};
  const writes: { table: string; payload: PaymentTestRow; ids: unknown[] }[] =
    [];
  const calls: {
    table: string;
    op: string;
    payload?: PaymentTestRow;
    equalities: [string, unknown][];
  }[] = [];
  let globalError: DatabaseError | null = null;
  let updateError: DatabaseError | null = null;
  const from = (table: string): Query => {
    const filters: ((row: PaymentTestRow) => boolean)[] = [];
    const equalities: [string, unknown][] = [];
    let op = 'select';
    let payload: PaymentTestRow | undefined;
    let single = false;
    let limit = Infinity;
    const q: Query = {
      select: () => q,
      eq: (key, value) => {
        equalities.push([key, value]);
        filters.push((r) => r[key] === value);
        return q;
      },
      neq: (key, value) => {
        filters.push((r) => r[key] !== value);
        return q;
      },
      or: () => {
        filters.push((r) => r.status !== 'paid');
        return q;
      },
      order: () => q,
      limit: (n) => {
        limit = n;
        return q;
      },
      insert: (p) => {
        op = 'insert';
        payload = p;
        return q;
      },
      update: (p) => {
        op = 'update';
        payload = p;
        return q;
      },
      single: () => {
        single = true;
        return q;
      },
      maybeSingle: () => {
        single = true;
        return q;
      },
      then(resolve, reject) {
        calls.push({ table, op, payload, equalities: [...equalities] });
        const error =
          globalError ??
          failures[`${table}:${op}`] ??
          (op === 'update' ? updateError : null);
        if (error)
          return Promise.resolve({ data: null, error }).then(resolve, reject);
        if (missing[`${table}:${op}`])
          return Promise.resolve({ data: null, error: null }).then(
            resolve,
            reject
          );
        const all = (tables[table] ??= []);
        if (op === 'insert' && payload) {
          if (
            table === 'orders' &&
            all.some(
              (r) =>
                r.account_id === payload!.account_id &&
                r.external_reference === payload!.external_reference
            )
          ) {
            return Promise.resolve({
              data: null,
              error: { code: '23505' },
            }).then(resolve, reject);
          }
          const row = {
            id: `${table}-${all.length + 1}`,
            ...structuredClone(payload),
          };
          all.push(row);
          return Promise.resolve({
            data: single ? row : [row],
            error: null,
          }).then(resolve, reject);
        }
        const rows = all
          .filter((r) => filters.every((f) => f(r)))
          .slice(0, limit);
        if (single && rows.length > 1)
          return Promise.resolve({
            data: null,
            error: { message: 'ambiguous rows' },
          }).then(resolve, reject);
        if (payload) {
          rows.forEach((r) => Object.assign(r, payload));
          writes.push({ table, payload, ids: rows.map((r) => r.id) });
        }
        return Promise.resolve({
          data: single ? (rows[0] ?? null) : rows,
          error: null,
        }).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    from,
    tables,
    failures,
    missing,
    writes,
    calls,
    get orders() {
      return tables.orders;
    },
    fail: () => {
      globalError = { message: 'DB unavailable' };
    },
    failUpdate: () => {
      updateError = { message: 'DB update unavailable' };
    },
    client: { from } as unknown as SupabaseClient,
  };
}
