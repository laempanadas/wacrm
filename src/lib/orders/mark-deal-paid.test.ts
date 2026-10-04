import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { markDealPaid } from './mark-deal-paid';

const DEAL_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

// Minimal in-memory stand-in for the query-builder calls markDealPaid makes.
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    const rows = () =>
      (tables[table] ??= []).filter((r) =>
        filters.every(([k, v]) => r[k] === v)
      );
    const run = () => {
      if (op === 'insert') {
        const row = { id: `new-${table}`, ...payload };
        tables[table].push(row);
        return [row];
      }
      if (op === 'update') {
        rows().forEach((r) => Object.assign(r, payload));
        return rows();
      }
      return rows();
    };
    const q = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (r: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const baseTables = (stages: Row[]) => ({
  deals: [
    {
      id: DEAL_ID,
      account_id: 'acc',
      pipeline_id: 'pipe',
      stage_id: 'novo',
      status: 'open',
    },
  ],
  pipeline_stages: stages,
});

describe('markDealPaid', () => {
  it('moves the deal to the existing Pago stage and marks it won', async () => {
    const tables = baseTables([
      { id: 'novo', pipeline_id: 'pipe', name: 'Novo Pedido', position: 0 },
      { id: 'pago', pipeline_id: 'pipe', name: ' pago ', position: 1 },
    ]);
    const res = await markDealPaid(fakeDb(tables), {
      accountId: 'acc',
      dealId: DEAL_ID,
    });

    expect(res).toMatchObject({
      moved: true,
      stageId: 'pago',
      stageCreated: false,
    });
    expect(tables.deals[0]).toMatchObject({ stage_id: 'pago', status: 'won' });
  });

  it('creates the Pago stage at the end of the pipeline when missing', async () => {
    const tables = baseTables([
      { id: 'novo', pipeline_id: 'pipe', name: 'Novo Pedido', position: 0 },
      { id: 'prep', pipeline_id: 'pipe', name: 'Em preparo', position: 3 },
    ]);
    const res = await markDealPaid(fakeDb(tables), {
      accountId: 'acc',
      dealId: DEAL_ID,
    });

    expect(res).toMatchObject({ moved: true, stageCreated: true });
    const created = tables.pipeline_stages.find((s) => s.name === 'Pago');
    expect(created).toMatchObject({ pipeline_id: 'pipe', position: 4 });
    expect(tables.deals[0].stage_id).toBe(created!.id);
  });

  it("does nothing for a deal id that isn't a uuid or belongs to another account", async () => {
    const tables = baseTables([]);
    expect(
      await markDealPaid(fakeDb(tables), {
        accountId: 'acc',
        dealId: 'PED-123',
      })
    ).toEqual({
      moved: false,
      reason: 'invalid_deal_id',
    });
    expect(
      await markDealPaid(fakeDb(tables), {
        accountId: 'other',
        dealId: DEAL_ID,
      })
    ).toEqual({
      moved: false,
      reason: 'deal_not_found',
    });
    expect(tables.deals[0].status).toBe('open');
  });
});
