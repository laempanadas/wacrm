import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentDatabase } from '@/lib/payments/payment-db-test-helper';
import { openPaymentFingerprint } from '@/lib/payments/open-payment-identity';
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
// A pre-040 core checkout has raw order lines plus a bound frozen ledger.
function legacyLedger(observations = '') {
  const order = mocks.db.orders[0];
  mocks.db.tables.order_checkouts = [
    {
      id: 'canonical-ledger',
      account_id: order.account_id,
      external_reference: order.external_reference,
      order_id: order.id,
      deal_id: order.deal_id,
      preference_id: order.preference_id,
      payment_url: order.payment_url,
      status: 'completed',
      snapshot: {
        contactId: order.contact_id,
        items: structuredClone(order.items),
        observations,
        deliveryKind: order.delivery_kind,
        deliveryAddress: order.delivery_address,
        total: order.total,
      },
    },
  ];
}
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
  it('does not bypass a frozen checkout ledger reference when borrowing an open cart', async () => {
    await post({ ...input, externalReference: 'ORIGINAL' });
    mocks.db.tables.order_checkouts = [
      {
        id: 'frozen',
        account_id: 'A',
        external_reference: input.externalReference,
        status: 'uncertain',
        input_fingerprint: 'frozen',
      },
    ];
    const before = structuredClone(mocks.db.tables);
    expect((await post()).status).toBe(409);
    expect(mocks.db.tables).toEqual(before);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('returns the original canonical reference for legacy cross-reference reuse', async () => {
    await post({ ...input, externalReference: 'ORIGINAL' });
    mocks.db.orders[0].payment_fingerprint = null;
    legacyLedger();
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reused: true,
      externalReference: 'ORIGINAL',
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it.each(['matching', 'different', 'missing ledger', 'foreign ledger'])(
    'preserves core legacy observations in standalone matching (%s)',
    async (kind) => {
      await post({ ...input, externalReference: 'CORE-ORIGINAL' });
      const order = mocks.db.orders[0];
      order.payment_fingerprint = null;
      order.deal_id = 'core-deal';
      legacyLedger('Portaria');
      if (kind === 'missing ledger') mocks.db.tables.order_checkouts = [];
      if (kind === 'foreign ledger')
        mocks.db.tables.order_checkouts[0].account_id = 'B';
      const before = structuredClone(mocks.db.tables);
      const response = await post({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          description: `\nObservações: ${kind === 'different' ? 'Outro local' : 'Portaria'}`,
        })),
      });
      if (kind === 'matching') {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          reused: true,
          orderId: order.id,
          externalReference: 'CORE-ORIGINAL',
        });
      } else if (kind === 'different') {
        expect(response.status).toBe(200);
        expect((await response.json()).reused).toBe(false);
      } else {
        expect(response.status).toBe(409);
        expect(mocks.db.tables).toEqual(before);
      }
      expect(mocks.create).toHaveBeenCalledTimes(kind === 'different' ? 2 : 1);
    }
  );
  it.each([
    { field: 'title', legacy: false },
    { field: 'deliveryAddress', legacy: false },
    { field: 'title', legacy: true },
    { field: 'deliveryAddress', legacy: true },
  ])('shares core boundary-space identity and preserves noted bindings (%j)', async ({
    field,
    legacy,
  }) => {
    const original = {
      ...input,
      externalReference: 'CORE-PADDED',
      deliveryAddress: 'Rua A',
    };
    expect((await post(original)).status).toBe(200);
    // Core persists raw title/address and owns observations in its frozen ledger.
    const order = mocks.db.orders[0];
    const rawItems = input.items.map((item) => ({
      ...item,
      title: field === 'title' ? `  ${item.title}  ` : item.title,
    }));
    order.items = rawItems;
    order.delivery_address = field === 'deliveryAddress' ? '  Rua A  ' : 'Rua A';
    order.deal_id = 'core-deal';
    order.payment_fingerprint = openPaymentFingerprint({
      items: rawItems,
      delivery_kind: 'delivery',
      delivery_address: String(order.delivery_address),
      observations: 'Portaria',
    });
    legacyLedger('Portaria');
    if (legacy) order.payment_fingerprint = null;
    const before = structuredClone(mocks.db.tables);
    const replay = await post({
      ...input,
      deliveryAddress: 'Rua A',
      items: input.items.map((item) => ({
        ...item,
        description: '\nObservações: Portaria',
      })),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      reused: true,
      orderId: order.id,
      preferenceId: order.preference_id,
      paymentUrl: order.payment_url,
      externalReference: original.externalReference,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.tables).toEqual(before);
  });
  it('fails closed for a legacy row without a ledger even when its raw cart matches', async () => {
    await post({ ...input, externalReference: 'ORIGINAL' });
    mocks.db.orders[0].payment_fingerprint = null;
    expect((await post()).status).toBe(409);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it.each([
    { payment_method: 'mercado_pago' },
    { payment_method: null },
    { payment_method: 'unknown' },
    { payment_method: 'dinheiro', preference_id: 'real-binding' },
    { payment_method: 'na_retirada', payment_url: 'real-url' },
    {
      payment_method: 'dinheiro',
      payment_fingerprint: 'claimed',
      status: 'checkout_uncertain',
    },
  ])('keeps incomplete potential MP claims blocking: %j', async (claim) => {
    mocks.db.orders.push({
      id: 'legacy',
      account_id: 'A',
      contact_id: 'contact-A',
      external_reference: 'LEGACY',
      status: 'pending',
      items: null,
      ...claim,
    });
    expect((await post()).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['dinheiro', 'na_retirada'])(
    'does not let a known unbound offline order block another cart (%s)',
    async (payment_method) => {
      mocks.db.orders.push({
        id: 'offline',
        account_id: 'A',
        contact_id: 'contact-A',
        external_reference: 'OFFLINE',
        payment_method,
        status: 'pending',
        items: payment_method === 'dinheiro' ? null : '2x pedido antigo',
      });
      expect((await post()).status).toBe(200);
      expect(mocks.create).toHaveBeenCalledTimes(1);
    }
  );
  it('reuses the open contact cart when quick Pix sends no reference', async () => {
    const quickPix = { ...input, externalReference: undefined };
    const first = await (await post(quickPix)).json();
    const replay = await post(quickPix);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      orderId: first.orderId,
      reused: true,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('persists the validated originating conversation with the payment claim', async () => {
    mocks.db.tables.conversations.push({
      id: 'conversation-A',
      account_id: 'A',
      contact_id: 'contact-A',
    });
    expect(
      (await post({ ...input, conversationId: 'conversation-A' })).status
    ).toBe(200);
    expect(mocks.db.orders[0].payment_conversation_id).toBe('conversation-A');
    const claim = mocks.db.calls.find(
      (call) => call.table === 'orders' && call.op === 'insert'
    );
    expect(claim?.payload).toMatchObject({
      payment_conversation_id: 'conversation-A',
      status: 'checkout_uncertain',
    });
  });
  it('claims the contact cart before remote I/O even without a reference', async () => {
    const quickPix = { ...input, externalReference: undefined };
    const responses = await Promise.all([post(quickPix), post(quickPix)]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mocks.db.orders).toHaveLength(1);
    expect(mocks.db.orders[0].payment_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['gateway timeout', 'binding failure'])(
    'keeps an ambiguous claim blocking new references after %s',
    async (failure) => {
      const quickPix = { ...input, externalReference: undefined };
      if (failure === 'gateway timeout')
        mocks.create.mockRejectedValueOnce(new Error('timeout after creation'));
      else mocks.db.failures['orders:update'] = { message: 'DB unavailable' };
      expect((await post(quickPix)).status).toBe(500);
      delete mocks.db.failures['orders:update'];
      expect(
        (await post({ ...quickPix, externalReference: 'NEW-REFERENCE' })).status
      ).toBe(409);
      expect(mocks.create).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['pending', 'checkout_uncertain'])(
    'does not create a second preference for a matching legacy snapshot without a fingerprint (%s)',
    async (status) => {
      const quickPix = { ...input, externalReference: undefined };
      const first = await (await post(quickPix)).json();
      delete mocks.db.orders[0].payment_fingerprint;
      legacyLedger();
      mocks.db.orders[0].status = status;
      const replay = await post(quickPix);
      expect(replay.status).toBe(status === 'pending' ? 200 : 409);
      if (status === 'pending')
        expect(await replay.json()).toMatchObject({
          reused: true,
          orderId: first.orderId,
        });
      expect(mocks.create).toHaveBeenCalledTimes(1);
    }
  );
  it('rejects multiple matching legacy bindings rather than guessing one', async () => {
    const quickPix = { ...input, externalReference: undefined };
    await post(quickPix);
    delete mocks.db.orders[0].payment_fingerprint;
    mocks.db.orders.push({
      ...mocks.db.orders[0],
      id: 'legacy-other',
      external_reference: 'LEGACY-OTHER',
      preference_id: 'pref-other',
    });
    expect((await post(quickPix)).status).toBe(409);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('creates a fresh payment after the previous identical cart is paid', async () => {
    const quickPix = { ...input, externalReference: undefined };
    const first = await (await post(quickPix)).json();
    mocks.db.orders[0].status = 'paid';
    const fresh = await (await post(quickPix)).json();
    expect(fresh.orderId).not.toBe(first.orderId);
    expect(fresh.reused).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it.each([
    { items: [{ ...input.items[0], title: 'Different SKU same total' }] },
    { items: [{ ...input.items[0], id: 'OTHER' }] },
    { items: [{ ...input.items[0], description: 'No onions' }] },
    { items: [{ ...input.items[0], unitPrice: 14.01 }] },
    { deliveryAddress: 'Rua B, 2' },
    { deliveryKind: 'retirada' },
    { contactId: 'contact-A2' },
  ])(
    'does not collapse a different cart, delivery or contact: %j',
    async (change) => {
      mocks.db.tables.contacts.push({ id: 'contact-A2', account_id: 'A' });
      const quickPix = { ...input, externalReference: undefined };
      await post(quickPix);
      mocks.db.orders[0].payment_fingerprint = null;
      legacyLedger();
      const second = await post({ ...quickPix, ...change });
      expect(second.status).toBe(200);
      expect((await second.json()).reused).toBe(false);
      expect(mocks.create).toHaveBeenCalledTimes(2);
    }
  );
  it('canonicalizes item keys and line order for reference-free retries', async () => {
    const quickPix = { ...input, externalReference: undefined };
    const a = input.items[0];
    const b = { ...a, id: 'SKU-B', title: 'Other' };
    const first = await (await post({ ...quickPix, items: [a, b, a] })).json();
    const replay = await post({
      ...quickPix,
      items: [
        b,
        { unitPrice: 14, quantity: 2, title: 'Empanada', id: 'SKU' },
        a,
      ],
    });
    expect(await replay.json()).toMatchObject({
      reused: true,
      orderId: first.orderId,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
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
