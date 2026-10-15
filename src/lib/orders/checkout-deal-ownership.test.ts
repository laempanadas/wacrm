import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrderDeal } from './create-order';
import { createOrderWithMercadoPago } from './create-order-with-mercado-pago';

const gateway = vi.hoisted(() => ({
  createPaymentLink: vi.fn(),
  isMercadoPagoConfigured: () => true,
}));
vi.mock('@/lib/payments/mercado-pago', () => gateway);

type Row = Record<string, unknown>;
// Only DB and gateway boundaries are simulated; createOrderDeal is REAL.
function database() {
  const tables: Record<string, Row[]> = {
    pipelines: [
      { id: 'pipeline', account_id: 'account', name: 'Pedidos Delivery' },
    ],
    pipeline_stages: [
      { id: 'stage', pipeline_id: 'pipeline', name: 'Novo Pedido' },
    ],
    tags: [{ id: 'tag', account_id: 'account', name: 'Aguardando Pagamento' }],
    deals: [],
    orders: [],
    order_checkouts: [],
    contacts: [{ id: 'contact', account_id: 'account' }],
    conversations: [
      { id: 'conversation', account_id: 'account', contact_id: 'contact' },
    ],
    contact_tags: [],
  };
  const calls: Array<{
    table: string;
    op: string;
    filters: Array<[string, unknown]>;
    payload: Row;
  }> = [];
  const failures: Record<string, string> = {};
  const missing: Set<string> = new Set();
  const barriers = {
    afterDealInsert: undefined as (() => Promise<void>) | undefined,
  };
  let seq = 0;
  const from = (table: string) => {
    let op = 'select';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];
    const run = () => {
      calls.push({
        table,
        op,
        filters: [...filters],
        payload: structuredClone(payload),
      });
      const key = `${table}:${op}`;
      if (failures[key])
        return { data: null, error: { message: failures[key] } };
      if (missing.has(key)) return { data: null, error: null };
      const rows = (tables[table] ??= []);
      if (op === 'insert' || op === 'upsert') {
        if (
          (table === 'order_checkouts' || table === 'orders') &&
          rows.some(
            (r) =>
              r.account_id === payload.account_id &&
              r.external_reference === payload.external_reference
          )
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate claim' },
          };
        }
        const row = { id: `${table}-${++seq}`, ...structuredClone(payload) };
        rows.push(row);
        return { data: structuredClone(row), error: null };
      }
      const matched = rows.filter((r) =>
        filters.every(([key, value]) => r[key] === value)
      );
      if (op === 'update')
        matched.forEach((r) => Object.assign(r, structuredClone(payload)));
      return {
        data: matched[0] ? structuredClone(matched[0]) : null,
        error: null,
      };
    };
    const execute = async () => {
      const result = run();
      if (table === 'deals' && op === 'insert' && barriers.afterDealInsert) {
        const barrier = barriers.afterDealInsert;
        barriers.afterDealInsert = undefined;
        await barrier();
      }
      return result;
    };
    const query = {
      select: () => query,
      limit: () => query,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      insert: (value: Row) => {
        op = 'insert';
        payload = value;
        return query;
      },
      upsert: (value: Row) => {
        op = 'upsert';
        payload = value;
        return query;
      },
      update: (value: Row) => {
        op = 'update';
        payload = value;
        return query;
      },
      single: execute,
      maybeSingle: execute,
      then: (resolve: (result: ReturnType<typeof run>) => void) =>
        execute().then(resolve),
    };
    return query;
  };
  return {
    db: { from } as unknown as SupabaseClient,
    tables,
    calls,
    failures,
    missing,
    barriers,
  };
}
const ctx = { accountId: 'account', userId: 'user' };
const order = (reference: string, quantity: number) => ({
  contactId: 'contact',
  customerName: 'Maria',
  conversationId: 'conversation',
  deliveryKind: 'delivery' as const,
  deliveryAddress: 'Rua A',
  externalReference: reference,
  items: [
    {
      id: 'carne',
      title: 'Carne',
      quantity,
      unitPrice: 14,
      description: 'Sem cebola',
    },
  ],
});
let db: ReturnType<typeof database>;
beforeEach(() => {
  db = database();
  gateway.createPaymentLink.mockReset();
  gateway.createPaymentLink.mockImplementation(
    async ({ externalReference }) => ({
      ok: true,
      preferenceId: `pref-${externalReference}`,
      paymentUrl: `https://payment.test/${externalReference}`,
    })
  );
});

describe('checkout deal ownership with real createOrderDeal', () => {
  it.each([true, false])(
    'never lets legacy callers adopt a completed checkout deal (reference=%s)',
    async (withReference) => {
      const checkout = await createOrderWithMercadoPago(
        ctx,
        order('A', 2),
        db.db
      );
      expect(checkout.ok).toBe(true);
      const original = structuredClone(db.tables.deals[0]);
      const legacy = await createOrderDeal(db.db, ctx, {
        contactId: 'contact',
        customerName: 'Maria',
        conversationId: 'conversation',
        deliveryKind: 'retirada',
        total: 70,
        skipOrderRecord: true,
        external_reference: withReference ? 'B' : undefined,
      });
      expect(legacy.dealId).not.toBe(checkout.dealId);
      expect(db.tables.deals[0]).toEqual(original);
    }
  );

  it('never lets a no-reference legacy order adopt a checkout before ledger linkage', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.barriers.afterDealInsert = async () => {
      entered();
      await blocked;
    };
    const checkout = createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    await entering;
    const original = structuredClone(db.tables.deals[0]);
    expect(db.tables.order_checkouts[0].deal_id).toBeUndefined();
    try {
      const legacy = await createOrderDeal(db.db, ctx, {
        contactId: 'contact',
        customerName: 'Maria',
        conversationId: 'conversation',
        deliveryKind: 'retirada',
        total: 70,
        skipOrderRecord: true,
      });
      expect(legacy.dealId).not.toBe(original.id);
      expect(db.tables.deals[0]).toEqual(original);
    } finally {
      release();
      await checkout;
    }
  });

  it('never lets legacy callers adopt an uncertain in-flight gateway deal', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway.createPaymentLink.mockImplementationOnce(async () => {
      entered();
      await blocked;
      throw new Error('gateway timeout');
    });
    const checkout = createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    await entering;
    const original = structuredClone(db.tables.deals[0]);
    expect(db.tables.order_checkouts[0].status).toBe('uncertain');
    try {
      const legacy = await createOrderDeal(db.db, ctx, {
        contactId: 'contact',
        customerName: 'Maria',
        conversationId: 'conversation',
        deliveryKind: 'retirada',
        total: 70,
        skipOrderRecord: true,
        external_reference: 'B',
      });
      expect(legacy.dealId).not.toBe(original.id);
      expect(db.tables.deals[0]).toEqual(original);
    } finally {
      release();
      await checkout;
    }
    expect(db.tables.order_checkouts[0].status).toBe('uncertain');
    expect(db.tables.deals[0]).toEqual(original);
  });

  it('rejects checkout ownership without caller-owned canonical persistence before DB side effects', async () => {
    await expect(
      createOrderDeal(db.db, ctx, {
        contactId: 'contact',
        customerName: 'Maria',
        deliveryKind: 'delivery',
        total: 28,
        checkoutOwned: true,
      })
    ).rejects.toThrow(
      'Checkout-owned deals require caller-owned order persistence'
    );
    expect(db.calls).toHaveLength(0);
  });
  it('keeps two distinct checkouts for one contact/conversation immutable and replays each result', async () => {
    const first = await createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    const firstDeal = structuredClone(db.tables.deals[0]);
    const second = await createOrderWithMercadoPago(ctx, order('B', 5), db.db);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.dealId).not.toBe(first.dealId);
    expect(db.tables.deals).toHaveLength(2);
    expect(db.tables.deals[0]).toEqual(firstDeal);
    expect(db.tables.deals.map((d) => d.value)).toEqual([28, 70]);
    expect(db.tables.deals[0].notes).toContain('2x Carne [carne]');
    expect(db.tables.deals[1].notes).toContain('5x Carne [carne]');
    expect(gateway.createPaymentLink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        externalReference: 'A',
        items: order('A', 2).items,
      })
    );
    expect(gateway.createPaymentLink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        externalReference: 'B',
        items: order('B', 5).items,
      })
    );
    expect(
      db.tables.order_checkouts.map((c) => [
        c.external_reference,
        c.deal_id,
        c.preference_id,
      ])
    ).toEqual([
      ['A', first.dealId, 'pref-A'],
      ['B', second.dealId, 'pref-B'],
    ]);
    expect(
      db.tables.orders.map((o) => [o.deal_id, o.total, o.preference_id])
    ).toEqual([
      [first.dealId, 28, 'pref-A'],
      [second.dealId, 70, 'pref-B'],
    ]);
    expect(await createOrderWithMercadoPago(ctx, order('A', 2), db.db)).toEqual(
      first
    );
    expect(await createOrderWithMercadoPago(ctx, order('B', 5), db.db)).toEqual(
      second
    );
    expect(gateway.createPaymentLink).toHaveBeenCalledTimes(2);
    expect(db.tables.deals).toHaveLength(2);
  });

  it('isolates overlapping references before a processing checkout links its new deal', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.barriers.afterDealInsert = async () => {
      entered();
      await blocked;
    };
    const first = createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    await entering;
    expect(db.tables.order_checkouts[0].status).toBe('processing');
    expect(db.tables.order_checkouts[0].deal_id).toBeUndefined();
    const firstId = db.tables.deals[0].id;
    try {
      const second = await createOrderWithMercadoPago(
        ctx,
        order('B', 5),
        db.db
      );
      expect(second.ok).toBe(true);
      expect(second.dealId).not.toBe(firstId);
      expect(db.tables.deals[0].value).toBe(28);
    } finally {
      release();
    }
    expect((await first).ok).toBe(true);
    expect(db.tables.deals.map((d) => d.value)).toEqual([28, 70]);
    expect(db.tables.orders).toHaveLength(2);
    expect(gateway.createPaymentLink).toHaveBeenCalledTimes(2);
  });

  it('isolates overlapping references while one gateway request is uncertain', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway.createPaymentLink.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return {
        ok: true,
        preferenceId: 'pref-A',
        paymentUrl: 'https://payment.test/A',
      };
    });
    const first = createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    await entering;
    const firstDeal = structuredClone(db.tables.deals[0]);
    expect(db.tables.order_checkouts[0].status).toBe('uncertain');
    let second;
    try {
      second = await createOrderWithMercadoPago(ctx, order('B', 5), db.db);
      expect(second.ok).toBe(true);
      expect(second.dealId).not.toBe(firstDeal.id);
      expect(db.tables.deals[0]).toEqual(firstDeal);
      expect(
        (await createOrderWithMercadoPago(ctx, order('A', 2), db.db)).ok
      ).toBe(false);
    } finally {
      release();
    }
    const result = await first;
    expect(result.ok).toBe(true);
    expect(db.tables.orders).toHaveLength(2);
    expect(db.tables.order_checkouts.map((c) => c.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(gateway.createPaymentLink).toHaveBeenCalledTimes(2);
  });

  it.each(['processing', 'uncertain', 'failed', 'completed', 'provisional'])(
    'never adopts an open deal owned by a %s checkout',
    async (status) => {
      const existing = {
        id: 'existing-deal',
        account_id: 'account',
        contact_id: 'contact',
        conversation_id: 'conversation',
        pipeline_id: 'pipeline',
        stage_id: 'stage',
        status: 'open',
        value: 28,
        notes: 'Original order',
      };
      db.tables.deals.push(structuredClone(existing));
      if (status !== 'provisional')
        db.tables.order_checkouts.push({
          id: 'existing-checkout',
          account_id: 'account',
          external_reference: 'A',
          status,
          deal_id: existing.id,
        });
      const result = await createOrderWithMercadoPago(
        ctx,
        order('B', 5),
        db.db
      );
      expect(result.ok).toBe(true);
      expect(result.dealId).not.toBe(existing.id);
      expect(db.tables.deals[0]).toEqual(existing);
      expect(
        db.calls.filter((c) => c.table === 'deals' && c.op === 'select')
      ).toHaveLength(0);
    }
  );

  it('keeps non-ledger pickup separate from an unowned zero-value auto-deal', async () => {
    db.tables.deals.push({
      id: 'legacy-deal',
      account_id: 'account',
      contact_id: 'contact',
      pipeline_id: 'pipeline',
      status: 'open',
      value: 0,
    });
    const result = await createOrderDeal(db.db, ctx, {
      contactId: 'contact',
      customerName: 'Maria',
      deliveryKind: 'retirada',
      paymentMethod: 'na_retirada',
      total: 28,
      skipOrderRecord: true,
    });
    expect(result.dealId).not.toBe('legacy-deal');
    expect(db.tables.deals).toHaveLength(2);
    expect(db.tables.deals[0].value).toBe(0);
    expect(db.tables.deals[1].value).toBe(28);
  });

  it('scopes the real deal path by account even for identical external references', async () => {
    db.tables.pipelines.push({
      id: 'other-pipeline',
      account_id: 'other-account',
      name: 'Pedidos Delivery',
    });
    db.tables.pipeline_stages.push({
      id: 'other-stage',
      pipeline_id: 'other-pipeline',
      name: 'Novo Pedido',
    });
    db.tables.tags.push({
      id: 'other-tag',
      account_id: 'other-account',
      name: 'Aguardando Pagamento',
    });
    const first = await createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    db.tables.contacts.push({
      id: 'other-contact',
      account_id: 'other-account',
    });
    db.tables.conversations.push({
      id: 'other-conversation',
      account_id: 'other-account',
      contact_id: 'other-contact',
    });
    const otherCtx = { ...ctx, accountId: 'other-account' };
    const second = await createOrderWithMercadoPago(
      otherCtx,
      {
        ...order('A', 5),
        contactId: 'other-contact',
        conversationId: 'other-conversation',
      },
      db.db
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.dealId).not.toBe(second.dealId);
    expect(db.tables.deals[1]).toMatchObject({
      account_id: 'other-account',
      pipeline_id: 'other-pipeline',
      stage_id: 'other-stage',
      value: 70,
    });
    expect(
      await createOrderWithMercadoPago(
        otherCtx,
        {
          ...order('A', 5),
          contactId: 'other-contact',
          conversationId: 'other-conversation',
        },
        db.db
      )
    ).toEqual(second);
    for (const call of db.calls) {
      if (
        ['deals', 'orders', 'order_checkouts'].includes(call.table) &&
        call.op === 'insert'
      )
        expect(['account', 'other-account']).toContain(call.payload.account_id);
      if (
        call.op === 'update' ||
        (call.op === 'select' &&
          ['pipelines', 'tags', 'order_checkouts'].includes(call.table))
      )
        expect(call.filters.some(([key]) => key === 'account_id')).toBe(true);
      if (call.table === 'pipeline_stages')
        expect(
          call.filters.some(
            ([key, value]) =>
              key === 'pipeline_id' &&
              ['pipeline', 'other-pipeline'].includes(String(value))
          )
        ).toBe(true);
    }
    expect(gateway.createPaymentLink).toHaveBeenCalledTimes(2);
  });

  it.each([
    'pipelines:select',
    'pipeline_stages:select',
    'deals:insert',
    'deals:update',
    'tags:insert',
  ])(
    'blocks gateway and retries after returned DB failure: %s',
    async (key) => {
      if (key === 'tags:insert') db.tables.tags = [];
      db.failures[key] = 'simulated DB failure';
      const result = await createOrderWithMercadoPago(
        ctx,
        order('A', 2),
        db.db
      );
      expect(result).toMatchObject({
        ok: false,
        error: 'simulated DB failure',
      });
      expect(db.tables.order_checkouts[0].status).toBe('failed');
      expect(db.tables.orders).toHaveLength(1);
      expect(db.tables.orders[0].status).toBe('checkout_uncertain');
      expect(gateway.createPaymentLink).not.toHaveBeenCalled();
      const dealCount = db.tables.deals.length;
      delete db.failures[key];
      expect(
        (await createOrderWithMercadoPago(ctx, order('A', 2), db.db)).ok
      ).toBe(false);
      expect(db.tables.deals).toHaveLength(dealCount);
      expect(gateway.createPaymentLink).not.toHaveBeenCalled();
    }
  );

  it.each([
    'pipelines:select',
    'pipeline_stages:select',
    'deals:insert',
    'deals:update',
  ])('blocks gateway when DB returns no row: %s', async (key) => {
    db.missing.add(key);
    const result = await createOrderWithMercadoPago(ctx, order('A', 2), db.db);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found|no id returned|not persisted/);
    expect(db.tables.order_checkouts[0].status).toBe('failed');
    expect(db.tables.orders).toHaveLength(1);
    expect(db.tables.orders[0].status).toBe('checkout_uncertain');
    expect(gateway.createPaymentLink).not.toHaveBeenCalled();
  });
});
