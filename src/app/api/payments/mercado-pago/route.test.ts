import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentDatabase } from '@/lib/payments/payment-db-test-helper';
const mocks = vi.hoisted(() => ({
  db: undefined as unknown as ReturnType<typeof paymentDatabase>,
  create: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: 'A', userId: 'user-A' }),
  toErrorResponse: () =>
    Response.json({ error: 'Internal server error' }, { status: 500 }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => mocks.db.from(table) }),
}));
vi.mock('mercadopago', () => ({
  MercadoPagoConfig: class {},
  Payment: class {},
  MerchantOrder: class {},
  Preference: class {
    create = mocks.create;
  },
}));
import { POST } from './route';
function database() {
  return paymentDatabase({
    orders: [],
    contacts: [
      { id: 'contact-A', account_id: 'A' },
      { id: 'contact-B', account_id: 'B' },
    ],
    deals: [{ id: 'deal-B', account_id: 'B' }],
    conversations: [],
  });
}
const input = {
  externalReference: 'SAME28',
  contactId: 'contact-A',
  items: [{ id: 'SKU', title: 'Empanada', quantity: 2, unitPrice: 14 }],
  payerName: 'Cliente',
};
const post = (body: unknown = input) =>
  POST(
    new Request('http://localhost/api/payments/mercado-pago', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MP_ACCESS_TOKEN', 'test-token-no-network');
  mocks.db = database();
  mocks.create.mockResolvedValue({
    id: 'pref-A',
    init_point: 'https://example.invalid/payment',
  });
});
describe('real payment POST durable account-bound writer', () => {
  it.each(['pending', 'checkout_uncertain', 'processing'])(
    'rejects binding a standalone payment to a checkout deal (%s)',
    async (status) => {
      mocks.db.tables.deals.push({
        id: 'checkout-deal',
        account_id: 'A',
        contact_id: 'contact-A',
        value: 28,
      });
      mocks.db.tables.orders.push({
        id: 'checkout-order',
        account_id: 'A',
        external_reference: 'CHECKOUT28',
        deal_id: 'checkout-deal',
        total: 28,
        status,
      });
      const before = structuredClone(mocks.db.tables);
      const responses = await Promise.all(
        ['STANDALONE70', 'STANDALONE84'].map((externalReference) =>
          post({
            ...input,
            externalReference,
            dealId: 'checkout-deal',
            items: [{ ...input.items[0], unitPrice: 35 }],
          })
        )
      );
      expect(responses.map((response) => response.status)).toEqual([409, 409]);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.db.tables).toEqual(before);
    }
  );
  it('rejects even an unclaimed deal rather than racing another checkout', async () => {
    mocks.db.tables.deals.push({
      id: 'unclaimed-deal',
      account_id: 'A',
      contact_id: 'contact-A',
    });
    expect((await post({ ...input, dealId: 'unclaimed-deal' })).status).toBe(
      409
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.db.tables.orders).toEqual([]);
  });
  it('never reuses a foreign reference and returns only the persisted account order ID', async () => {
    mocks.db.tables.orders.push({
      ...input,
      id: 'foreign',
      account_id: 'B',
      external_reference: 'SAME28',
      status: 'pending',
      preference_id: 'pref-B',
      payment_url: 'foreign-url',
      created_at: new Date().toISOString(),
    });
    const response = await post();
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.orderId).toBeTruthy();
    expect(result.orderId).not.toBe('foreign');
    expect(result.preferenceId).toBe('pref-A');
    expect(
      mocks.db.tables.orders.find((r) => r.account_id === 'A')
    ).toMatchObject({
      preference_id: 'pref-A',
      total: 28,
      deal_id: null,
      items: input.items,
    });
  });
  it.each([
    { contactId: 'contact-B' },
    { dealId: 'deal-B' },
    { conversationId: 'foreign-conversation' },
  ])('validates ownership before external effects: %j', async (foreign) => {
    expect((await post({ ...input, ...foreign })).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.db.tables.orders).toEqual([]);
  });
  it.each(['select', 'insert'])(
    'does not call gateway when orders %s fails',
    async (op) => {
      mocks.db.failures[`orders:${op}`] = { message: 'DB down' };
      expect((await post()).status).toBe(500);
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );
  it('does not call gateway when insert returns no durable ID', async () => {
    mocks.db.missing['orders:insert'] = true;
    expect((await post()).status).toBe(500);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['error', 'missing'])(
    'never returns a payment URL when final persistence is %s',
    async (mode) => {
      if (mode === 'error')
        mocks.db.failures['orders:update'] = { message: 'DB down' };
      else mocks.db.missing['orders:update'] = true;
      const response = await post();
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty('paymentUrl');
    }
  );
  it('concurrent identical requests create at most one preference', async () => {
    const responses = await Promise.all([post(), post()]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it('replays a durable JSONB snapshot despite reordered item object keys', async () => {
    const created = await post();
    expect(created.status).toBe(200);
    const first = await created.json();
    expect((await post()).status).toBe(200);
    const row = mocks.db.tables.orders[0];
    const originalItems = JSON.stringify(row.items);
    // Simulate JSONB returning object keys in a different insertion order.
    row.items = input.items.map(({ id, title, quantity, unitPrice }) => ({
      id,
      title,
      quantity,
      unitPrice,
    }));
    expect(JSON.stringify(row.items)).not.toBe(originalItems);
    const before = structuredClone(mocks.db.tables);
    mocks.db.calls.length = 0;

    const replay = await post();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      orderId: first.orderId,
      paymentUrl: first.paymentUrl,
      preferenceId: first.preferenceId,
      reused: true,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.tables).toEqual(before);
    expect(mocks.db.calls.every(({ op }) => op === 'select')).toBe(true);
  });
  it.each(['item value', 'line order', 'line multiplicity'])(
    'rejects replay with changed %s even when totals match',
    async (change) => {
      const a = input.items[0];
      const b = { ...a, id: 'SKU-B', title: 'Another empanada' };
      const original = { ...input, items: [a, b, a] };
      const created = await post(original);
      expect(created.status).toBe(200);
      const before = structuredClone(mocks.db.tables);
      mocks.db.calls.length = 0;
      const changedItems =
        change === 'item value'
          ? [{ ...a, title: 'Changed empanada' }, b, a]
          : change === 'line order'
            ? [b, a, a]
            : [a, b, b];

      const replay = await post({ ...original, items: changedItems });

      expect(replay.status).toBe(409);
      expect(await replay.json()).not.toHaveProperty('paymentUrl');
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.db.tables).toEqual(before);
      expect(mocks.db.calls.every(({ op }) => op === 'select')).toBe(true);
    }
  );
  it('replays only a matching durable canonical order and blocks changed input', async () => {
    const first = await (await post()).json();
    expect((await post()).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(await (await post()).json()).toMatchObject({
      orderId: first.orderId,
      reused: true,
    });
    expect(
      (await post({ ...input, items: [{ ...input.items[0], unitPrice: 15 }] }))
        .status
    ).toBe(409);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1.5, '2'])(
    'rejects invalid quantity without silently removing SKU lines (%j)',
    async (quantity) => {
      expect(
        (
          await post({
            ...input,
            items: [...input.items, { title: 'Bad', unitPrice: 14, quantity }],
          })
        ).status
      ).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );
  it('rejects fractional cents before gateway I/O', async () => {
    expect(
      (
        await post({
          ...input,
          items: [{ ...input.items[0], unitPrice: 14.001 }],
        })
      ).status
    ).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
