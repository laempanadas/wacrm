import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { markDealPaid } from './mark-deal-paid';

const DEAL_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

const { tagContact } = vi.hoisted(() => ({ tagContact: vi.fn() }));
vi.mock('./create-order', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./create-order')>()),
  markContactPaymentConfirmed: tagContact,
}));
beforeEach(() => {
  tagContact.mockReset();
});

// Minimal in-memory stand-in for the query-builder calls markDealPaid makes.
function fakeDb(
  tables: Record<string, Row[]>,
  options: {
    fail?: string;
    beforeUpdate?: () => void;
  } = {}
) {
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
        options.beforeUpdate?.();
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
      is: (k: string, v: unknown) => (filters.push([k, v]), q),
      maybeSingle: async () => {
        if (options.fail === `${table}:${op}`)
          return {
            data: rows()[0] ?? null,
            error: { message: 'lookup failed' },
          };
        return { data: structuredClone(run()[0] ?? null), error: null };
      },
      then: (resolve: (r: unknown) => void) =>
        resolve(
          options.fail === `${table}:${op}`
            ? { data: rows(), error: { message: 'lookup failed' } }
            : { data: run(), error: null }
        ),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const baseTables = (stages: Row[]): Record<string, Row[]> => ({
  deals: [
    {
      id: DEAL_ID,
      account_id: 'acc',
      pipeline_id: 'pipe',
      stage_id: 'novo',
      status: 'open',
      contact_id: 'contact',
      user_id: 'user',
    },
  ],
  pipeline_stages: stages,
  pipelines: [{ id: 'pipe', account_id: 'acc' }],
  contacts: [{ id: 'contact', account_id: 'acc' }],
});

describe('markDealPaid', () => {
  it('rejects a missing pipeline without creating a stage', async () => {
    const tables = baseTables([]);
    tables.pipelines = [];
    expect(
      await markDealPaid(fakeDb(tables), { accountId: 'acc', dealId: DEAL_ID })
    ).toEqual({ moved: false, reason: 'pipeline_not_found' });
    expect(tables.pipeline_stages).toEqual([]);
    expect(tables.deals[0].status).toBe('open');
  });

  it.each([
    ['pipeline_stages:insert', 'stage_unavailable'],
    ['deals:update', 'update_failed'],
  ])('does not tag if %s fails', async (fail, reason) => {
    const tables = baseTables([]);
    expect(
      await markDealPaid(fakeDb(tables, { fail }), {
        accountId: 'acc',
        dealId: DEAL_ID,
      })
    ).toEqual({ moved: false, reason });
    expect(tables.deals[0].status).toBe('open');
    expect(tagContact).not.toHaveBeenCalled();
  });

  it('tags a validated contact exactly once and keeps tag failures best effort', async () => {
    const tables = baseTables([]);
    tagContact.mockRejectedValue(new Error('tag failed'));
    expect(
      await markDealPaid(fakeDb(tables), { accountId: 'acc', dealId: DEAL_ID })
    ).toMatchObject({ moved: true });
    expect(tagContact).toHaveBeenCalledTimes(1);
    expect(tagContact).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'acc', userId: 'user' },
      'contact'
    );
    expect(tables.deals[0].status).toBe('won');
  });

  it('supports deals with no contact without tagging', async () => {
    const tables = baseTables([]);
    tables.deals[0].contact_id = null;
    expect(
      await markDealPaid(fakeDb(tables), { accountId: 'acc', dealId: DEAL_ID })
    ).toMatchObject({ moved: true });
    expect(tagContact).not.toHaveBeenCalled();
  });
  it.each([
    ['account_id', 'other'],
    ['pipeline_id', 'foreign-pipeline'],
    ['contact_id', 'foreign-contact'],
  ])(
    'does not mutate or tag when the deal %s changes after preflight',
    async (key, value) => {
      const tables = baseTables([
        { id: 'pago', pipeline_id: 'pipe', name: 'Pago', position: 1 },
      ]);
      const db = fakeDb(tables, {
        beforeUpdate: () => {
          tables.deals[0][key] = value;
        },
      });
      expect(
        await markDealPaid(db, { accountId: 'acc', dealId: DEAL_ID })
      ).toEqual({ moved: false, reason: 'update_failed' });
      expect(tables.deals[0].status).toBe('open');
      expect(tagContact).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['deals', 'lookup_failed'],
    ['pipelines', 'lookup_failed'],
    ['contacts', 'lookup_failed'],
    ['pipeline_stages', 'stage_unavailable'],
  ])(
    'fails closed on a %s lookup error even if data is returned',
    async (table, reason) => {
      const tables = baseTables([]);
      const before = structuredClone(tables);
      expect(
        await markDealPaid(fakeDb(tables, { fail: `${table}:select` }), {
          accountId: 'acc',
          dealId: DEAL_ID,
        })
      ).toEqual({ moved: false, reason });
      expect(tables).toEqual(before);
      expect(tagContact).not.toHaveBeenCalled();
    }
  );
  it.each(['other', null])(
    'rejects a foreign or missing contact (%s) before any mutation',
    async (account) => {
      const tables = baseTables([]);
      if (account) tables.contacts[0].account_id = account;
      else tables.contacts = [];
      const before = structuredClone(tables);
      expect(
        await markDealPaid(fakeDb(tables), {
          accountId: 'acc',
          dealId: DEAL_ID,
        })
      ).toEqual({ moved: false, reason: 'contact_not_found' });
      expect(tables).toEqual(before);
      expect(tagContact).not.toHaveBeenCalled();
    }
  );
  it('rejects a foreign pipeline before creating a stage or mutating a deal', async () => {
    const tables = baseTables([]);
    tables.pipelines[0].account_id = 'other';
    const before = structuredClone(tables);
    expect(
      await markDealPaid(fakeDb(tables), { accountId: 'acc', dealId: DEAL_ID })
    ).toEqual({ moved: false, reason: 'pipeline_not_found' });
    expect(tables).toEqual(before);
    expect(tagContact).not.toHaveBeenCalled();
  });
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
