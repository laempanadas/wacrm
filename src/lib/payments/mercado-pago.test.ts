import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPaymentLink,
  getExistingPaymentLink,
  getPaymentById,
  getPaymentStatusForOrder,
} from './mercado-pago';

// Exercise installed SDK 3.2.1, mocking ONLY HTTP transport (never the SDK).
const records = () => ({
  '/v1/payments/123': {
    id: 123,
    status: 'approved',
    transaction_amount: 28,
    currency_id: 'BRL',
    external_reference: 'SAME28',
    collector_id: 9,
    order: { id: 456, type: 'mercadopago' },
  },
  '/merchant_orders/456': {
    id: 456,
    preference_id: 'pref-A',
    collector: { id: 9 },
    external_reference: 'SAME28',
    payments: [{ id: 123 }],
  },
  '/checkout/preferences/pref-A': {
    id: 'pref-A',
    collector_id: 9,
    external_reference: 'SAME28',
    items: [{ quantity: 2, unit_price: 14, currency_id: 'BRL' }],
  },
});
let data: Record<string, Record<string, unknown>>;
let transport: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('MP_ACCESS_TOKEN', 'test-token-never-real');
  data = records();
  transport = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/merchant_orders/search')
      return Response.json({
        total: 1,
        elements: [data['/merchant_orders/456']],
      });
    if (!(path in data))
      return Response.json(
        { status: 400, message: 'Unexpected URL' },
        { status: 400 }
      );
    return Response.json(data[path]);
  });
  vi.stubGlobal('fetch', transport);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('installed SDK payment identity transport', () => {
  const existingOrder = {
    account_id: 'A',
    preference_id: 'pref-A',
    external_reference: 'SAME28',
    total: 28,
    payment_url: 'https://payments.example/existing',
  };
  it.each(['delivery', 'retirada'] as const)(
    'sets an explicit zero shipping cost for %s, even below any former minimum',
    async (deliveryKind) => {
      transport.mockResolvedValueOnce(
        Response.json({
          id: 'pref-free-delivery',
          init_point: 'https://www.mercadopago.com.br/checkout/test',
        })
      );
      await createPaymentLink({
        items: [
          { title: 'Empanada de Carne com Ovos', quantity: 1, unitPrice: 14 },
        ],
        deliveryKind,
        externalReference: 'FREE-DELIVERY',
      });
      const options = transport.mock.calls[0][1];
      const body = JSON.parse(String(options.body));
      expect(body.shipments).toMatchObject({ cost: 0 });
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ quantity: 1, unit_price: 14 });
    }
  );
  it('validates an existing pending preference and returns its exact persisted URL using GET only', async () => {
    data['/checkout/preferences/pref-A'].init_point = existingOrder.payment_url;
    data['/merchant_orders/456'].payments = [];
    expect(await getExistingPaymentLink(existingOrder)).toBe(
      existingOrder.payment_url
    );
    expect(
      transport.mock.calls.every(([, options]) => options.method === 'GET')
    ).toBe(true);
  });
  it.each([
    { id: 'foreign' },
    { external_reference: 'foreign' },
    { collector_id: 0 },
    { init_point: 'https://payments.example/other' },
    { items: [{ quantity: 1, unit_price: 28, currency_id: 'USD' }] },
    { items: [{ quantity: 2, unit_price: 15, currency_id: 'BRL' }] },
    { expires: true, expiration_date_to: '2000-01-01T00:00:00Z' },
  ])(
    'blocks an existing preference with mismatched or expired gateway data: %j',
    async (patch) => {
      Object.assign(
        data['/checkout/preferences/pref-A'],
        { init_point: existingOrder.payment_url },
        patch
      );
      data['/merchant_orders/456'].payments = [];
      await expect(getExistingPaymentLink(existingOrder)).rejects.toThrow();
      expect(
        transport.mock.calls.every(([, options]) => options.method === 'GET')
      ).toBe(true);
    }
  );
  it.each(['approved', 'authorized', 'rejected'])(
    'never resends a checkout with payment status %s',
    async (status) => {
      data['/checkout/preferences/pref-A'].init_point =
        existingOrder.payment_url;
      data['/v1/payments/123'].status = status;
      await expect(getExistingPaymentLink(existingOrder)).rejects.toThrow();
    }
  );
  it('uses supported Payment.get -> MerchantOrder.get -> Preference.get URLs for linked legacy payments', async () => {
    expect(await getPaymentById('123')).toMatchObject({
      ok: true,
      status: 'approved',
      paymentId: '123',
      preferenceId: 'pref-A',
      collectorId: '9',
      currency: 'BRL',
      paidAmount: 28,
    });
    expect(transport.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/v1/payments/123',
      '/merchant_orders/456',
      '/checkout/preferences/pref-A',
    ]);
  });
  it('uses documented merchant-order preference filter, not unsupported payment preference fields', async () => {
    expect(
      await getPaymentStatusForOrder({
        account_id: 'A',
        preference_id: 'pref-A',
        external_reference: 'SAME28',
        total: 28,
      })
    ).toMatchObject({ status: 'approved' });
    const query = new URL(transport.mock.calls[0][0]);
    expect(query.pathname).toBe('/merchant_orders/search');
    expect(query.searchParams.get('preference_id')).toBe('pref-A');
    expect(query.searchParams.get('limit')).toBe('100');
  });
  it.each(['0', '-1', '1.5', 'undefined', 'abc'])(
    'rejects malformed payment ID %s before HTTP',
    async (id) => {
      expect(await getPaymentById(id)).toMatchObject({ status: 'unknown' });
      expect(transport).not.toHaveBeenCalled();
    }
  );
  it.each([0, -1, 9.5, '9', undefined])(
    'blocks invalid collector ID %j',
    async (collector) => {
      data['/v1/payments/123'].collector_id = collector;
      data['/merchant_orders/456'].collector = { id: collector };
      data['/checkout/preferences/pref-A'].collector_id = collector;
      expect(await getPaymentById('123')).toMatchObject({
        status: 'unknown',
        identityError: expect.any(String),
      });
    }
  );
  it('does not treat authorized-but-uncaptured funds as an approved payment', async () => {
    data['/v1/payments/123'].status = 'authorized';
    expect((await getPaymentById('123')).status).not.toBe('approved');
  });
  it('reports SDK read failures without a trusted identity', async () => {
    delete data['/merchant_orders/456'];
    expect(await getPaymentById('123')).toMatchObject({
      ok: false,
      status: 'unknown',
    });
  });
});
