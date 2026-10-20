import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as deals from './create-order';
import {
  createOrderWithMercadoPago,
  type CreateOrderWithMpInput,
} from './create-order-with-mercado-pago';

const payment = vi.hoisted(() => ({
  createPaymentLink: vi.fn(),
  isMercadoPagoConfigured: vi.fn(),
}));
vi.mock('@/lib/payments/mercado-pago', () => payment);
const client = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client.value }));
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('mercadopago', () => ({
  MercadoPagoConfig: class {},
  Preference: class {
    create = sdk.create;
  },
  Payment: class {},
}));

type Row = Record<string, unknown>;
function database() {
  const tables: Record<string, Row[]> = {
    order_checkouts: [],
    orders: [],
    contacts: [{ id: 'contact', account_id: 'account' }],
    conversations: [
      { id: 'conversation', account_id: 'account', contact_id: 'contact' },
      {
        id: 'another-conversation',
        account_id: 'account',
        contact_id: 'contact',
      },
    ],
    deals: [],
  };
  const failures: Record<string, string> = {};
  const failOnce: Record<string, string> = {};
  const calls: Array<{
    table: string;
    op: string;
    filters: Array<[string, unknown]>;
  }> = [];
  let seq = 0;
  const from = (table: string) => {
    let op = 'select';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];
    let excludePaid = false;
    const run = (single = true) => {
      calls.push({ table, op, filters: [...filters] });
      if (failures[`${table}:${op}`])
        return { data: null, error: { message: failures[`${table}:${op}`] } };
      const onceKey = `${table}:${op}:${payload.status ?? (payload.preference_id ? 'preference' : 'other')}`;
      if (failOnce[onceKey]) {
        const error = { message: failOnce[onceKey] };
        delete failOnce[onceKey];
        return { data: null, error };
      }
      const rows = (tables[table] ??= []);
      if (op === 'insert') {
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
            error: { code: '23505', message: 'duplicate checkout' },
          };
        }
        const row = { id: `${table}-${++seq}`, ...structuredClone(payload) };
        rows.push(row);
        return { data: row, error: null };
      }
      const matched = rows.filter(
        (r) =>
          (!excludePaid || r.status !== 'paid') &&
          filters.every(([k, v]) => r[k] === v)
      );
      if (op === 'update')
        matched.forEach((r) => Object.assign(r, structuredClone(payload)));
      return {
        data: single
          ? matched[0]
            ? structuredClone(matched[0])
            : null
          : structuredClone(matched),
        error: null,
      };
    };
    const query = {
      or: () => {
        excludePaid = true;
        return query;
      },
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return query;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return query;
      },
      select: () => query,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return query;
      },
      maybeSingle: async () => run(true),
      single: async () => run(true),
      then: (resolve: (v: ReturnType<typeof run>) => void) =>
        resolve(run(false)),
    };
    return query;
  };
  const db = { from } as unknown as SupabaseClient;
  client.value = db;
  return { db, tables, failures, failOnce, calls };
}
const ctx = { accountId: 'account', userId: 'user' };
const input = {
  contactId: 'contact',
  customerName: 'Maria',
  conversationId: 'conversation',
  deliveryKind: 'delivery' as const,
  deliveryAddress: 'Rua A',
  externalReference: 'TEXT-draft-1',
  items: [
    {
      id: 'sku-a',
      title: 'Empanada',
      quantity: 2,
      unitPrice: 10.01,
      description: 'Sem cebola',
    },
    {
      id: 'sku-b',
      title: 'Empanada',
      quantity: 1,
      unitPrice: 12.34,
      description: 'Com molho',
    },
  ],
} satisfies CreateOrderWithMpInput;
let db: ReturnType<typeof database>;
beforeEach(() => {
  vi.restoreAllMocks();
  db = database();
  vi.spyOn(deals, 'createOrderDeal').mockImplementation(async () => {
    const row = { id: 'deal', account_id: ctx.accountId };
    db.tables.deals.push(row);
    return {
      dealId: 'deal',
      pipelineId: 'pipeline',
      stageId: 'stage',
      tagName: 'Aguardando Pagamento',
    };
  });
  payment.isMercadoPagoConfigured.mockReturnValue(true);
  payment.createPaymentLink.mockResolvedValue({
    ok: true,
    preferenceId: 'preference',
    paymentUrl: 'https://payment.test/link',
  });
});

describe('durable checkout', () => {
  it.each(['dinheiro', 'na_retirada'])(
    'ignores only known unbound offline history (%s)',
    async (payment_method) => {
      db.tables.orders.push({
        id: 'offline',
        account_id: 'account',
        contact_id: 'contact',
        external_reference: 'OFFLINE',
        payment_method,
        status: 'pending',
        items: 'old text',
      });
      expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(true);
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    { payment_method: 'mercado_pago' },
    { payment_method: null },
    { payment_method: 'unknown' },
    { payment_method: 'dinheiro', preference_id: 'binding' },
    { payment_method: 'na_retirada', payment_url: 'binding' },
  ])('blocks incomplete potential MP history: %j', async (claim) => {
    db.tables.orders.push({
      id: 'legacy',
      account_id: 'account',
      contact_id: 'contact',
      external_reference: 'LEGACY',
      status: 'pending',
      items: null,
      ...claim,
    });
    const before = structuredClone(db.tables);
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(db.tables).toEqual(before);
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
    expect(deals.createOrderDeal).not.toHaveBeenCalled();
  });
  it.each(['ambiguous', 'uncertain', 'missing binding', 'frozen reference'])(
    'never borrows a legacy snapshot with %s',
    async (failure) => {
      await createOrderWithMercadoPago(ctx, input);
      const row = db.tables.orders[0];
      row.payment_fingerprint = null;
      if (failure === 'ambiguous')
        db.tables.orders.push({
          ...row,
          id: 'other',
          external_reference: 'OTHER',
        });
      if (failure === 'uncertain') row.status = 'checkout_uncertain';
      if (failure === 'missing binding') row.preference_id = null;
      if (failure === 'frozen reference')
        db.tables.order_checkouts.push({
          account_id: 'account',
          external_reference: 'NEW',
          status: 'uncertain',
          input_fingerprint: 'frozen',
        });
      const before = structuredClone(db.tables);
      expect(
        (
          await createOrderWithMercadoPago(ctx, {
            ...input,
            externalReference: 'NEW',
          })
        ).ok
      ).toBe(false);
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
      expect(db.tables).toEqual(before);
    }
  );
  it.each([
    { id: 'other-sku' },
    { id: ' sku-a ' },
    { title: 'Other' },
    { description: 'Other description' },
    { description: 'Sem cebola ' },
    { unitPrice: 10.02 },
  ])(
    'does not infer legacy cart identity from its total: %j',
    async (change) => {
      await createOrderWithMercadoPago(ctx, input);
      db.tables.orders[0].payment_fingerprint = null;
      const result = await createOrderWithMercadoPago(ctx, {
        ...input,
        externalReference: 'NEW',
        items: [{ ...input.items[0], ...change }, input.items[1]],
      });
      expect(result.ok).toBe(true);
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(2);
    }
  );
  it('reuses a complete legacy MP snapshot without a fingerprint and keeps its original reference', async () => {
    const first = await createOrderWithMercadoPago(ctx, input);
    db.tables.orders[0].payment_fingerprint = null;
    const before = structuredClone(db.tables);
    const result = await createOrderWithMercadoPago(ctx, {
      ...input,
      externalReference: 'TEXT-new-draft-1',
    });
    expect(result).toMatchObject({
      ok: true,
      orderId: first.orderId,
      externalReference: input.externalReference,
    });
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(db.tables).toEqual(before);
  });
  it.each(['title', 'deliveryAddress'])(
    'reuses legacy noted input with padded %s without changing frozen bindings',
    async (field) => {
      const noted = {
        ...input,
        observations: 'Portaria',
        items: input.items.map((item) => ({
          ...item,
          title: field === 'title' ? `  ${item.title}  ` : item.title,
        })),
        deliveryAddress:
          field === 'deliveryAddress'
            ? `  ${input.deliveryAddress}  `
            : input.deliveryAddress,
      };
      const first = await createOrderWithMercadoPago(ctx, noted);
      expect(first.ok).toBe(true);
      expect(db.tables.order_checkouts[0]).toMatchObject({
        status: 'completed',
        snapshot: { observations: 'Portaria', items: noted.items },
      });
      db.tables.orders[0].payment_fingerprint = null;
      const before = structuredClone(db.tables);
      const second = await createOrderWithMercadoPago(ctx, {
        ...noted,
        externalReference: 'NEW-PADDED-NOTED',
      });
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({
        ok: true,
        orderId: first.orderId,
        dealId: first.dealId,
        preferenceId: first.preferenceId,
        link_mercado_pago: first.link_mercado_pago,
        externalReference: input.externalReference,
      });
      expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
      expect(db.tables).toEqual(before);
    }
  );
  it.each([
    { field: 'title', legacy: false },
    { field: 'deliveryAddress', legacy: false },
    { field: 'title', legacy: true },
    { field: 'deliveryAddress', legacy: true },
  ])('reuses boundary-space aliases across references (%j)', async ({
    field,
    legacy,
  }) => {
    const noted = {
      ...input,
      observations: 'Portaria',
      items: input.items.map((item) => ({
        ...item,
        title: field === 'title' ? `  ${item.title}  ` : item.title,
      })),
      deliveryAddress:
        field === 'deliveryAddress'
          ? `  ${input.deliveryAddress}  `
          : input.deliveryAddress,
    };
    const first = await createOrderWithMercadoPago(ctx, noted);
    expect(first.ok).toBe(true);
    if (legacy) db.tables.orders[0].payment_fingerprint = null;
    const before = structuredClone(db.tables);
    const second = await createOrderWithMercadoPago(ctx, {
      ...input,
      observations: noted.observations,
      externalReference: 'NEW-SPACE-ALIAS',
    });
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      ok: true,
      orderId: first.orderId,
      externalReference: input.externalReference,
    });
    expect(db.tables).toEqual(before);
  });
  it('reuses legacy observations from the bound frozen ledger without a second preference', async () => {
    const noted = { ...input, observations: 'Entregar na portaria' };
    const first = await createOrderWithMercadoPago(ctx, noted);
    expect(first.ok).toBe(true);
    db.tables.orders[0].payment_fingerprint = null;
    const second = await createOrderWithMercadoPago(ctx, {
      ...noted,
      externalReference: 'NEW-NOTED',
    });
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      ok: true,
      orderId: first.orderId,
      externalReference: input.externalReference,
    });
  });
  it.each(['', 'Outras instruções', ' Portaria '])(
    'does not borrow legacy notes for different observations (%j)',
    async (observations) => {
      await createOrderWithMercadoPago(ctx, {
        ...input,
        observations: 'Portaria',
      });
      db.tables.orders[0].payment_fingerprint = null;
      const result = await createOrderWithMercadoPago(ctx, {
        ...input,
        observations,
        externalReference: 'DIFFERENT-NOTES',
      });
      expect(result.ok).toBe(true);
      expect(result.orderId).not.toBe(db.tables.orders[0].id);
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(2);
    }
  );
  it.each([
    'missing',
    'duplicate',
    'tenant',
    'order',
    'reference',
    'contact',
    'preference',
    'url',
    'uncertain',
    'notes',
    'items',
  ])(
    'blocks unrecoverable legacy observations (%s) before effects',
    async (failure) => {
      const noted = { ...input, observations: 'Portaria' };
      await createOrderWithMercadoPago(ctx, noted);
      db.tables.orders[0].payment_fingerprint = null;
      const ledger = db.tables.order_checkouts[0];
      if (failure === 'missing') db.tables.order_checkouts.length = 0;
      if (failure === 'duplicate')
        db.tables.order_checkouts.push(structuredClone(ledger));
      if (failure === 'tenant') ledger.account_id = 'foreign';
      if (failure === 'order') ledger.order_id = 'foreign';
      if (failure === 'reference') ledger.external_reference = 'foreign';
      if (failure === 'preference') ledger.preference_id = 'foreign';
      if (failure === 'url') ledger.payment_url = 'foreign';
      if (failure === 'uncertain') ledger.status = 'uncertain';
      const frozen = ledger.snapshot as Row;
      if (failure === 'contact') frozen.contactId = 'foreign';
      if (failure === 'notes') delete frozen.observations;
      if (failure === 'items')
        frozen.items = [{ ...input.items[0], id: 'foreign' }];
      const before = structuredClone(db.tables);
      expect(
        (
          await createOrderWithMercadoPago(ctx, {
            ...noted,
            externalReference: 'NEW-NOTED',
          })
        ).ok
      ).toBe(false);
      expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
      expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
      expect(db.tables).toEqual(before);
    }
  );
  it('reuses the same open cart across draft references without another gateway effect', async () => {
    const first = await createOrderWithMercadoPago(ctx, input);
    const second = await createOrderWithMercadoPago(ctx, {
      ...input,
      externalReference: 'TEXT-another-draft-1',
    });
    expect(second.ok).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(second.link_mercado_pago).toBe(first.link_mercado_pago);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
  });
  it('does not bypass an uncertain frozen reference by borrowing another open cart', async () => {
    await createOrderWithMercadoPago(ctx, input);
    db.tables.order_checkouts.push({
      account_id: 'account',
      external_reference: 'TEXT-frozen-1',
      input_fingerprint: 'frozen',
      status: 'uncertain',
    });
    const result = await createOrderWithMercadoPago(ctx, {
      ...input,
      externalReference: 'TEXT-frozen-1',
    });
    expect(result.ok).toBe(false);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });
  it('allows another identical purchase once the first canonical order is paid', async () => {
    await createOrderWithMercadoPago(ctx, input);
    db.tables.orders[0].status = 'paid';
    expect(
      (
        await createOrderWithMercadoPago(ctx, {
          ...input,
          externalReference: 'TEXT-new-paid-cart-1',
        })
      ).ok
    ).toBe(true);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(2);
  });
  it.each(['contacts', 'conversations'])(
    'validates service-role %s ownership before claiming or CRM/gateway effects',
    async (table) => {
      db.tables[table][0].account_id = 'foreign';
      const result = await createOrderWithMercadoPago(ctx, input);
      expect(result.ok).toBe(false);
      expect(db.tables.order_checkouts).toEqual([]);
      expect(deals.createOrderDeal).not.toHaveBeenCalled();
      expect(payment.createPaymentLink).not.toHaveBeenCalled();
    }
  );
  it('does not create a preference if another writer already owns the canonical order', async () => {
    db.tables.orders.push({
      id: 'already-claimed',
      account_id: ctx.accountId,
      external_reference: input.externalReference,
    });
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(deals.createOrderDeal).not.toHaveBeenCalled();
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
  });
  it('does not replay a completed claim whose canonical order is missing', async () => {
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(true);
    db.tables.orders.length = 0;
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  it('verified SDK request options make one transport attempt on a simulated timeout', async () => {
    const actual =
      await vi.importActual<typeof import('mercadopago')>('mercadopago');
    const fetch = vi.fn().mockRejectedValue(new Error('simulated timeout'));
    vi.stubGlobal('fetch', fetch);
    try {
      const requestOptions = { idempotencyKey: 'checkout-test', retries: 0 };
      const preference = new actual.Preference(
        new actual.MercadoPagoConfig({ accessToken: 'dummy-test-token' })
      );
      await expect(
        preference.create({ body: { items: [] }, requestOptions })
      ).rejects.toThrow('simulated timeout');
      expect(fetch).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetch.mock.calls[0][1].headers);
      expect(headers.get('x-idempotency-key')).toBe('checkout-test');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('payment adapter rejects a mixed valid/invalid basket instead of silently filtering', async () => {
    vi.stubEnv('MP_ACCESS_TOKEN', 'dummy-test-access-token');
    sdk.create.mockResolvedValue({
      id: 'pref',
      init_point: 'https://payment.test/link',
    });
    const realPayment = await vi.importActual<
      typeof import('@/lib/payments/mercado-pago')
    >('@/lib/payments/mercado-pago');
    try {
      await expect(
        realPayment.createPaymentLink({
          items: [input.items[0], { title: 'Bad', quantity: 0, unitPrice: 10 }],
          externalReference: 'TEXT-test-1',
        })
      ).rejects.toThrow(/item/i);
      expect(sdk.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('payment adapter preserves distinct SKU identities, titles and descriptions', async () => {
    vi.stubEnv('MP_ACCESS_TOKEN', 'dummy-test-access-token');
    sdk.create.mockResolvedValue({
      id: 'pref',
      init_point: 'https://payment.test/link',
    });
    const realPayment = await vi.importActual<
      typeof import('@/lib/payments/mercado-pago')
    >('@/lib/payments/mercado-pago');
    try {
      await realPayment.createPaymentLink({
        items: input.items,
        externalReference: input.externalReference,
      });
      expect(sdk.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            items: input.items.map((item) =>
              expect.objectContaining({
                id: item.id,
                title: item.title,
                quantity: item.quantity,
                unit_price: item.unitPrice,
                description: item.description,
              })
            ),
          }),
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('payment adapter opts out of automatic SDK retries for durable checkout requests', async () => {
    vi.stubEnv('MP_ACCESS_TOKEN', 'dummy-test-access-token');
    sdk.create.mockResolvedValue({
      id: 'pref',
      init_point: 'https://payment.test/link',
    });
    const realPayment = await vi.importActual<
      typeof import('@/lib/payments/mercado-pago')
    >('@/lib/payments/mercado-pago');
    try {
      await realPayment.createPaymentLink({
        items: input.items,
        externalReference: input.externalReference,
        idempotencyKey: 'checkout-key',
      });
      expect(sdk.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestOptions: { idempotencyKey: 'checkout-key', retries: 0 },
        })
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes exactly one canonical order with SKU lines and replays completed results', async () => {
    const first = await createOrderWithMercadoPago(ctx, input);
    const second = await createOrderWithMercadoPago(ctx, input);
    expect(first).toMatchObject({
      ok: true,
      orderId: expect.any(String),
      dealId: 'deal',
      preferenceId: 'preference',
    });
    expect(second).toEqual(first);
    expect(db.tables.orders).toHaveLength(1);
    expect(db.tables.orders[0]).toMatchObject({
      account_id: 'account',
      external_reference: input.externalReference,
      total: 32.36,
      items: input.items,
      deal_id: 'deal',
      preference_id: 'preference',
      payment_url: 'https://payment.test/link',
    });
    expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
    expect(deals.createOrderDeal).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ skipOrderRecord: true })
    );
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(payment.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({
        items: input.items,
        externalReference: input.externalReference,
        idempotencyKey: expect.stringMatching(/^CHECKOUT-[a-f0-9]{64}$/),
      })
    );
    expect(db.tables.order_checkouts[0]).toMatchObject({
      status: 'completed',
      order_id: first.orderId,
    });
    expect(db.tables.deals[0].notes).toContain('Sem cebola');
    expect(db.tables.deals[0].notes).toContain('sku-b');
  });

  it.each([
    { items: [] },
    { items: [{ title: 'Bad', quantity: 0, unitPrice: 10 }] },
    { items: [{ title: 'Bad', quantity: 1.5, unitPrice: 10 }] },
    { items: [{ title: 'Bad', quantity: 1, unitPrice: Number.NaN }] },
    { items: [{ title: '', quantity: 1, unitPrice: 10 }] },
    { externalReference: '' },
    { externalReference: ' TEXT-1' },
    { externalReference: undefined, conversationId: undefined },
  ])(
    'rejects invalid input without creating a durable claim: %j',
    async (patch) => {
      const result = await createOrderWithMercadoPago(ctx, {
        ...input,
        ...patch,
      });
      expect(result.ok).toBe(false);
      expect(db.tables.order_checkouts).toHaveLength(0);
      expect(deals.createOrderDeal).not.toHaveBeenCalled();
      expect(payment.createPaymentLink).not.toHaveBeenCalled();
    }
  );

  it('uses rounded unit cents for both snapshot and gateway totals', async () => {
    const result = await createOrderWithMercadoPago(ctx, {
      ...input,
      items: [{ ...input.items[0], quantity: 3, unitPrice: 1.005 }],
    });
    expect(result.ok).toBe(true);
    expect(db.tables.orders[0]).toMatchObject({
      total: 3.03,
      total_amount: 3.03,
      items: [expect.objectContaining({ unitPrice: 1.01 })],
    });
    expect(payment.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ unitPrice: 1.01 })],
      })
    );
  });

  it('rejects totals outside safe integer cents before acquisition', async () => {
    const result = await createOrderWithMercadoPago(ctx, {
      ...input,
      items: [
        { ...input.items[0], quantity: 100, unitPrice: 90_000_000_000_000 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(db.tables.order_checkouts).toHaveLength(0);
  });

  it('blocks a concurrent invocation while the gateway is in flight', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((r) => {
      entered = r;
    });
    payment.createPaymentLink.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        ok: true,
        preferenceId: 'preference',
        paymentUrl: 'https://payment.test/link',
      };
    });
    const first = createOrderWithMercadoPago(ctx, input);
    await entering;
    expect(db.tables.order_checkouts[0].status).toBe('uncertain');
    const second = await createOrderWithMercadoPago(ctx, input);
    expect(second.ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(db.tables.orders).toHaveLength(1);
  });

  it('blocks a second claim before the first deal completes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((r) => {
      entered = r;
    });
    vi.mocked(deals.createOrderDeal).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error('interrupted deal creation');
    });
    const first = createOrderWithMercadoPago(ctx, input);
    await entering;
    expect(db.tables.order_checkouts[0].status).toBe('processing');
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    release();
    expect((await first).ok).toBe(false);
    expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
  });

  it('retains uncertainty after a timeout and never calls the gateway again on retry', async () => {
    payment.createPaymentLink.mockRejectedValueOnce(
      new Error('gateway timeout')
    );
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(db.tables.order_checkouts[0]).toMatchObject({
      status: 'uncertain',
      deal_id: 'deal',
      error: 'gateway timeout',
    });
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(db.tables.orders).toHaveLength(1);
    expect(db.tables.orders[0].status).toBe('checkout_uncertain');
  });

  it('checks a canonical reservation insert error before creating any preference', async () => {
    db.failures['orders:insert'] = 'order write failed';
    const result = await createOrderWithMercadoPago(ctx, input);
    expect(result).toMatchObject({ ok: false, error: 'order write failed' });
    expect(db.tables.order_checkouts[0]).toMatchObject({ status: 'failed' });
    delete db.failures['orders:insert'];
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
    expect(db.tables.orders).toHaveLength(0);
  });

  it('durably hands off a known gateway response when the first metadata write fails transiently', async () => {
    db.failOnce['order_checkouts:update:preference'] =
      'preference handoff failed';
    expect(await createOrderWithMercadoPago(ctx, input)).toMatchObject({
      ok: false,
      error: 'preference handoff failed',
    });
    expect(db.tables.order_checkouts[0]).toMatchObject({
      status: 'uncertain',
      preference_id: 'preference',
      payment_url: 'https://payment.test/link',
    });
    expect(db.tables.orders).toHaveLength(1);
    expect(db.tables.orders[0].status).toBe('checkout_uncertain');
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  it('checks note write errors before sending any gateway request', async () => {
    db.failures['deals:update'] = 'notes failed';
    expect(await createOrderWithMercadoPago(ctx, input)).toMatchObject({
      ok: false,
      error: 'notes failed',
    });
    expect(db.tables.order_checkouts[0].status).toBe('failed');
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
    delete db.failures['deals:update'];
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(deals.createOrderDeal).toHaveBeenCalledTimes(1);
  });

  it('does not start side effects when durable acquisition fails', async () => {
    db.failures['order_checkouts:insert'] = 'ledger unavailable';
    expect(await createOrderWithMercadoPago(ctx, input)).toMatchObject({
      ok: false,
      error: 'ledger unavailable',
    });
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
    expect(deals.createOrderDeal).not.toHaveBeenCalled();
  });

  it('checks failure handoff errors without allowing new operations', async () => {
    db.failures['order_checkouts:update'] = 'ledger update failed';
    expect(await createOrderWithMercadoPago(ctx, input)).toMatchObject({
      ok: false,
      error: expect.stringContaining('durable handoff failed'),
    });
    expect(db.tables.order_checkouts[0].status).toBe('processing');
    delete db.failures['order_checkouts:update'];
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).not.toHaveBeenCalled();
  });

  it('does not report success if marking a persisted order completed fails', async () => {
    payment.createPaymentLink.mockImplementationOnce(async () => {
      // Fails the final ledger completion, not the preference handoff.
      const original = db.db.from.bind(db.db);
      db.db.from = ((table: string) => {
        const query = original(table);
        const update = query.update.bind(query);
        query.update = ((payload: Row) => {
          if (payload.status === 'completed')
            db.failures['order_checkouts:update'] = 'completion failed';
          return update(payload);
        }) as typeof query.update;
        return query;
      }) as typeof db.db.from;
      return {
        ok: true,
        preferenceId: 'preference',
        paymentUrl: 'https://payment.test/link',
      };
    });
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(db.tables.orders).toHaveLength(1);
    expect(db.tables.order_checkouts[0].status).toBe('uncertain');
    delete db.failures['order_checkouts:update'];
    expect((await createOrderWithMercadoPago(ctx, input)).ok).toBe(false);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
    expect(db.tables.orders).toHaveLength(1);
  });

  it('rejects changed input for a reference instead of mutating the frozen order', async () => {
    await createOrderWithMercadoPago(ctx, input);
    const original = structuredClone(db.tables.order_checkouts[0]);
    const result = await createOrderWithMercadoPago(ctx, {
      ...input,
      items: [{ ...input.items[0], quantity: 9 }],
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('conflicts'),
    });
    expect(db.tables.order_checkouts[0]).toEqual(original);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  it('uses a stable legacy content+conversation reference without time-based entropy', async () => {
    const legacy = { ...input, externalReference: undefined };
    const first = await createOrderWithMercadoPago(ctx, legacy);
    expect(await createOrderWithMercadoPago(ctx, legacy)).toEqual(first);
    expect(db.tables.order_checkouts).toHaveLength(1);
    expect(db.tables.order_checkouts[0].external_reference).toMatch(
      /^LEGACY-[a-f0-9]{64}$/
    );
    const fromAnotherConversation = await createOrderWithMercadoPago(ctx, {
      ...legacy,
      conversationId: 'another-conversation',
    });
    expect(fromAnotherConversation.orderId).toBe(first.orderId);
    expect(db.tables.order_checkouts).toHaveLength(1);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });

  it('scopes lookups and all updates by account', async () => {
    await createOrderWithMercadoPago(ctx, input);
    await createOrderWithMercadoPago(ctx, input);
    for (const call of db.calls.filter(
      (c) => c.op === 'update' || c.op === 'select'
    )) {
      expect(call.filters).toContainEqual(['account_id', ctx.accountId]);
    }
    expect(
      (
        await createOrderWithMercadoPago(
          { ...ctx, accountId: 'other-account' },
          input
        )
      ).ok
    ).toBe(false); // Foreign contact rejected before even acquiring a claim.
    expect(db.tables.order_checkouts).toHaveLength(1);
    expect(payment.createPaymentLink).toHaveBeenCalledTimes(1);
  });
});
