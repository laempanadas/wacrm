import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paymentDatabase,
  type PaymentTestRow,
} from '@/lib/payments/payment-db-test-helper';
const mocks = vi.hoisted(() => ({
  db: undefined as unknown as ReturnType<typeof paymentDatabase>,
  merchantSearch: vi.fn(),
  paymentGet: vi.fn(),
  merchantGet: vi.fn(),
  preferenceGet: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: 'A', supabase: mocks.db }),
  toErrorResponse: () =>
    Response.json({ error: 'Database error' }, { status: 500 }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => mocks.db.from(table) }),
}));
vi.mock('mercadopago', () => ({
  MercadoPagoConfig: class {},
  Payment: class {
    get = mocks.paymentGet;
  },
  MerchantOrder: class {
    get = mocks.merchantGet;
    search = mocks.merchantSearch;
  },
  Preference: class {
    get = mocks.preferenceGet;
  },
}));
import { GET } from './route';
const owned = {
  id: 'order-A',
  account_id: 'A',
  external_reference: 'SAME28',
  preference_id: 'pref-A',
  total: 28,
};
function database(
  rows: PaymentTestRow[],
  error: { message: string } | null = null
) {
  const db = paymentDatabase({ orders: rows });
  if (error) db.failures['orders:select'] = error;
  return db;
}
const get = () =>
  GET(
    new Request(
      'http://localhost/api/payments/mercado-pago/status?externalReference=SAME28'
    )
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MP_ACCESS_TOKEN', 'test-token-not-real');
  mocks.db = database([
    owned,
    { ...owned, id: 'foreign', account_id: 'B', preference_id: 'pref-B' },
  ]);
  mocks.merchantSearch.mockResolvedValue({
    total: 1,
    elements: [{ preference_id: 'pref-A', payments: [{ id: 123 }] }],
  });
  mocks.paymentGet.mockResolvedValue({
    id: 123,
    status: 'approved',
    transaction_amount: 28,
    currency_id: 'BRL',
    external_reference: 'SAME28',
    collector_id: 9,
    order: { id: 456, type: 'mercadopago' },
  });
  mocks.merchantGet.mockResolvedValue({
    id: 456,
    preference_id: 'pref-A',
    collector: { id: 9 },
    external_reference: 'SAME28',
    payments: [{ id: 123 }],
  });
  mocks.preferenceGet.mockResolvedValue({
    id: 'pref-A',
    collector_id: 9,
    external_reference: 'SAME28',
    items: [{ quantity: 1, unit_price: 28, currency_id: 'BRL' }],
  });
});
describe('authenticated payment status binds account before gateway I/O', () => {
  it('blocks a preference bound to another account before gateway I/O', async () => {
    mocks.db = database([
      owned,
      {
        ...owned,
        id: 'foreign',
        account_id: 'B',
        external_reference: 'FOREIGN',
      },
    ]);
    expect((await get()).status).toBe(500);
    expect(mocks.merchantSearch).not.toHaveBeenCalled();
  });
  it('does not query gateway or expose IDs for a foreign-only reference', async () => {
    mocks.db = database([{ ...owned, account_id: 'B' }]);
    const response = await get();
    expect(response.status).toBe(404);
    expect(mocks.merchantSearch).not.toHaveBeenCalled();
    expect(mocks.paymentGet).not.toHaveBeenCalled();
  });
  it('uses only persisted preference in the authenticated account', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('approved');
    expect(mocks.merchantSearch).toHaveBeenCalledWith({
      options: { preference_id: 'pref-A', limit: 100 },
    });
  });
  it('blocks duplicate account references before gateway I/O', async () => {
    mocks.db = database([owned, { ...owned, id: 'duplicate' }]);
    expect((await get()).status).toBe(500);
    expect(mocks.merchantSearch).not.toHaveBeenCalled();
  });
  it('blocks unlinked legacy rows explicitly', async () => {
    mocks.db = database([{ ...owned, preference_id: null }]);
    expect((await get()).status).toBe(409);
    expect(mocks.merchantSearch).not.toHaveBeenCalled();
  });
  it('fails closed on a database error', async () => {
    mocks.db = database([], { message: 'unavailable' });
    expect((await get()).status).toBe(500);
    expect(mocks.merchantSearch).not.toHaveBeenCalled();
  });
  it.each([
    [
      'foreign preference',
      {
        total: 1,
        elements: [{ preference_id: 'pref-B', payments: [{ id: 999 }] }],
      },
    ],
    [
      'multiple payments',
      {
        total: 1,
        elements: [
          { preference_id: 'pref-A', payments: [{ id: 123 }, { id: 124 }] },
        ],
      },
    ],
    [
      'truncated results',
      {
        total: 101,
        elements: [{ preference_id: 'pref-A', payments: [{ id: 123 }] }],
      },
    ],
  ])('blocks %s without exposing foreign IDs', async (_name, search) => {
    mocks.merchantSearch.mockResolvedValue(search);
    const response = await get();
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty('paymentId');
  });
  it('does not expose a payment that fails gateway identity validation', async () => {
    mocks.preferenceGet.mockResolvedValue({ id: 'pref-B' });
    const response = await get();
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty('paymentId');
  });
});
