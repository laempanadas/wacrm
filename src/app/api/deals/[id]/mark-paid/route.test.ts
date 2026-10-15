import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Scenario knobs ---------------------------------------------------------
let role: 'agent' | 'viewer' = 'agent';
let tables: Record<string, Array<Record<string, unknown>>> = {};
const DEAL_ID = '11111111-1111-4111-8111-111111111111';
let fail: string | undefined;
let beforeUpdate: (() => void) | undefined;

vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    requireRole: async () => {
      if (role === 'viewer')
        throw new actual.ForbiddenError('Insufficient role');
      return { accountId: 'acc', userId: 'user' };
    },
  };
});

const markDealPaid = vi.fn();
vi.mock('@/lib/orders/mark-deal-paid', () => ({
  markDealPaid: (...args: unknown[]) => markDealPaid(...args),
}));

const markContactPaymentConfirmed = vi.fn();
vi.mock('@/lib/orders/create-order', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/orders/create-order')
  >('@/lib/orders/create-order');
  return {
    ...actual,
    markContactPaymentConfirmed: (...args: unknown[]) =>
      markContactPaymentConfirmed(...args),
  };
});

// In-memory admin client covering select/update with eq filters.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      let inserted = false;
      const rows = () =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([k, v]) => r[k] === v)
        );
      const run = () => {
        if (patch) {
          beforeUpdate?.();
          if (inserted) {
            const row = { id: `new-${table}`, ...patch };
            (tables[table] ??= []).push(row);
            return [row];
          }
          rows().forEach((r) => Object.assign(r, patch));
        }
        return rows();
      };
      const result = () =>
        fail === `${table}:${patch ? 'update' : 'select'}`
          ? { data: rows(), error: { message: 'database error' } }
          : { data: run(), error: null };
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        insert: (p: Record<string, unknown>) => (
          (patch = p),
          (inserted = true),
          q
        ),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        is: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => {
          const res = result();
          return { ...res, data: structuredClone(res.data[0] ?? null) };
        },
        then: (resolve: (r: unknown) => void) => resolve(result()),
      };
      return q;
    },
  }),
}));

const { POST } = await import('./route');
const call = (id: string) =>
  POST(
    new Request(`https://app.test/api/deals/${id}/mark-paid`, {
      method: 'POST',
    }),
    {
      params: Promise.resolve({ id }),
    }
  );

beforeEach(async () => {
  role = 'agent';
  fail = undefined;
  beforeUpdate = undefined;
  const actual = await vi.importActual<
    typeof import('@/lib/orders/mark-deal-paid')
  >('@/lib/orders/mark-deal-paid');
  markDealPaid.mockImplementation(actual.markDealPaid);
  markContactPaymentConfirmed.mockResolvedValue(undefined);
  tables = {
    deals: [
      {
        id: DEAL_ID,
        account_id: 'acc',
        contact_id: 'c1',
        pipeline_id: 'orders',
        status: 'open',
        user_id: 'user',
      },
    ],
    pipelines: [
      { id: 'orders', account_id: 'acc', name: 'Pedidos Delivery' },
      { id: 'sales', account_id: 'acc', name: 'Vendas' },
    ],
    contacts: [{ id: 'c1', account_id: 'acc' }],
    pipeline_stages: [
      { id: 'pago', pipeline_id: 'orders', name: 'Pago', position: 1 },
    ],
    orders: [
      { id: 'o1', account_id: 'acc', deal_id: DEAL_ID, status: 'pending' },
    ],
  };
});

describe('POST /api/deals/[id]/mark-paid', () => {
  it('fails closed on a deal lookup error even if data is returned', async () => {
    fail = 'deals:select';
    const before = structuredClone(tables);
    expect((await call(DEAL_ID)).status).toBe(500);
    expect(tables).toEqual(before);
    expect(markDealPaid).not.toHaveBeenCalled();
  });

  it.each(['orders', 'sales'])(
    'does not tag or close orders when the %s deal update fails',
    async (pipeline) => {
      tables.deals[0].pipeline_id = pipeline;
      fail = 'deals:update';
      expect((await call(DEAL_ID)).status).toBe(500);
      expect(tables.deals[0].status).toBe('open');
      expect(tables.orders[0].status).toBe('pending');
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );

  it('keeps order update errors best effort after moving and tagging once', async () => {
    fail = 'orders:update';
    expect((await call(DEAL_ID)).status).toBe(200);
    expect(tables.deals[0].status).toBe('won');
    expect(markContactPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(tables.orders[0].status).toBe('pending');
  });

  it('closes only orders in the current account for this deal', async () => {
    tables.orders.push({
      id: 'foreign-order',
      account_id: 'other',
      deal_id: DEAL_ID,
      status: 'pending',
    });
    expect((await call(DEAL_ID)).status).toBe(200);
    expect(tables.orders.map((order) => order.status)).toEqual([
      'paid',
      'pending',
    ]);
  });

  it.each(['orders', 'sales'])(
    'supports %s deals without a contact and never tags',
    async (pipeline) => {
      tables.deals[0].pipeline_id = pipeline;
      tables.deals[0].contact_id = null;
      expect((await call(DEAL_ID)).status).toBe(200);
      expect(tables.deals[0].status).toBe('won');
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['account_id', 'other'],
    ['pipeline_id', 'foreign'],
    ['contact_id', 'foreign'],
  ])(
    'does not update a generic deal whose %s changed after preflight',
    async (key, value) => {
      tables.deals[0].pipeline_id = 'sales';
      beforeUpdate = () => {
        tables.deals[0][key] = value;
      };
      expect((await call(DEAL_ID)).status).toBe(500);
      expect(tables.deals[0].status).toBe('open');
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );

  it('does not report success if the generic deal disappeared before updating', async () => {
    tables.deals[0].pipeline_id = 'sales';
    beforeUpdate = () => {
      tables.deals = [];
    };
    expect((await call(DEAL_ID)).status).toBe(500);
  });
  it.each([
    ['orders', 'other'],
    ['orders', null],
    ['sales', 'other'],
    ['sales', null],
  ])(
    'rejects a foreign or missing contact in %s (%s) before any mutation',
    async (pipeline, account) => {
      tables.deals[0].pipeline_id = pipeline;
      tables.contacts = account ? [{ id: 'c1', account_id: account }] : [];
      tables.pipeline_stages = [];
      const before = structuredClone(tables);
      expect((await call(DEAL_ID)).status).toBe(404);
      expect(tables).toEqual(before);
      expect(markDealPaid).not.toHaveBeenCalled();
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );

  it.each(['orders', 'sales'])(
    'fails closed on a contact lookup error in %s',
    async (pipeline) => {
      tables.deals[0].pipeline_id = pipeline;
      fail = 'contacts:select';
      const before = structuredClone(tables);
      expect((await call(DEAL_ID)).status).toBe(500);
      expect(tables).toEqual(before);
      expect(markDealPaid).not.toHaveBeenCalled();
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );
  it.each(['Pedidos Delivery', 'Vendas', null])(
    'rejects a foreign or missing pipeline (%s) before any mutation',
    async (name) => {
      tables.pipelines = name
        ? [{ id: 'orders', account_id: 'other', name }]
        : [];
      tables.pipeline_stages = [];
      const before = structuredClone(tables);
      expect((await call(DEAL_ID)).status).toBe(404);
      expect(tables).toEqual(before);
      expect(markDealPaid).not.toHaveBeenCalled();
      expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    }
  );

  it('fails closed on a pipeline lookup error instead of treating it as generic', async () => {
    fail = 'pipelines:select';
    const before = structuredClone(tables);
    expect((await call(DEAL_ID)).status).toBe(500);
    expect(tables).toEqual(before);
    expect(markDealPaid).not.toHaveBeenCalled();
    expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
  });
  it('moves an order card to Pago, tags Confirmado and closes the order', async () => {
    const res = await call(DEAL_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, moved: true });
    expect(markDealPaid).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acc',
      dealId: DEAL_ID,
    });
    expect(markContactPaymentConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'acc', userId: 'user' },
      'c1'
    );
    expect(markContactPaymentConfirmed).toHaveBeenCalledTimes(1);
    expect(tables.orders[0].status).toBe('paid');
  });

  it('only marks won for deals outside the orders pipeline', async () => {
    tables.deals[0].pipeline_id = 'sales';
    const res = await call(DEAL_ID);

    expect(await res.json()).toMatchObject({ ok: true, moved: false });
    expect(tables.deals[0].status).toBe('won');
    expect(markDealPaid).not.toHaveBeenCalled();
    expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('returns 404 for a deal of another account', async () => {
    tables.deals[0].account_id = 'other';
    expect((await call(DEAL_ID)).status).toBe(404);
    expect(markDealPaid).not.toHaveBeenCalled();
  });

  it('rejects viewers', async () => {
    role = 'viewer';
    expect((await call(DEAL_ID)).status).toBe(403);
  });

  it('still succeeds when tagging fails (card already moved)', async () => {
    markContactPaymentConfirmed.mockRejectedValue(new Error('boom'));
    expect((await call(DEAL_ID)).status).toBe(200);
  });
});
