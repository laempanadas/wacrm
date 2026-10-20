import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paymentDatabase,
  type PaymentTestRow,
} from '@/lib/payments/payment-db-test-helper';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  paymentGet: vi.fn(),
  merchantGet: vi.fn(),
  preferenceGet: vi.fn(),
  db: undefined as unknown as ReturnType<typeof paymentDatabase>,
  send: vi.fn(),
}));
vi.mock('mercadopago', () => ({
  MercadoPagoConfig: class {},
  Payment: class {
    get = mocks.paymentGet;
  },
  MerchantOrder: class {
    get = mocks.merchantGet;
  },
  Preference: class {
    get = mocks.preferenceGet;
  },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => mocks.db.from(table) }),
}));
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendPaymentConfirmationWhatsApp: mocks.send,
}));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: mocks.send }));
vi.mock('@/lib/orders/create-order', () => ({
  markContactPaymentConfirmed: vi.fn(),
}));
vi.mock('@/lib/orders/custom-fields', () => ({
  saveContactOrderFields: vi.fn(),
}));
import { POST } from './route';
import { saveContactOrderFields } from '@/lib/orders/custom-fields';
import { markContactPaymentConfirmed } from '@/lib/orders/create-order';

// Mock only the database boundary: filtering and conditional updates are real
// in-memory operations, so global latest-reference queries reproduce the bug.
function database(
  orders: PaymentTestRow[],
  linked: Record<string, PaymentTestRow[]> = {}
) {
  return paymentDatabase({ ...linked, orders });
}
function order(account: string, preference: string) {
  return {
    id: `order-${account}`,
    account_id: account,
    preference_id: preference,
    external_reference: 'SAME28',
    total: 28,
    status: 'pending',
    contact_id: null,
  };
}
async function post() {
  return POST(
    new NextRequest('http://localhost/api/payments/mercado-pago/webhook', {
      method: 'POST',
      body: JSON.stringify({
        type: 'payment',
        data: { id: '123' },
        account_id: 'B',
      }),
    })
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MP_ACCESS_TOKEN', 'dummy-test-token');
  vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
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
  mocks.db = database([order('B', 'pref-B'), order('A', 'pref-A')]);
});
describe('real Mercado Pago webhook POST: trusted payment ownership', () => {
  it.each(['conversation', null])(
    'closes only a bound originating conversation, never all contact inboxes (%s)',
    async (bound) => {
      mocks.db = database(
        [
          {
            ...order('A', 'pref-A'),
            contact_id: 'contact',
            payment_conversation_id: bound,
          },
        ],
        {
          contacts: [{ id: 'contact', account_id: 'A', user_id: 'user' }],
          conversations: [
            {
              id: 'conversation',
              account_id: 'A',
              contact_id: 'contact',
              status: 'open',
            },
            {
              id: 'other-conversation',
              account_id: 'A',
              contact_id: 'contact',
              status: 'open',
            },
          ],
        }
      );
      expect((await post()).status).toBe(200);
      expect(mocks.db.tables.conversations.map((row) => row.status)).toEqual([
        bound ? 'closed' : 'open',
        'open',
      ]);
    }
  );
  it('settles the old order without overwriting or closing a newer open purchase', async () => {
    mocks.db = database(
      [
        {
          ...order('A', 'pref-A'),
          contact_id: 'contact',
          deal_id: 'old-deal',
          created_at: '2026-10-17T12:00:00Z',
          payment_conversation_id: 'old-conversation',
        },
        {
          ...order('A', 'pref-new'),
          id: 'new-order',
          external_reference: 'NEW',
          contact_id: 'contact',
          created_at: '2026-10-18T12:00:00Z',
        },
      ],
      {
        contacts: [{ id: 'contact', account_id: 'A', user_id: 'user' }],
        deals: [
          {
            id: 'old-deal',
            account_id: 'A',
            contact_id: 'contact',
            pipeline_id: 'pipeline',
          },
        ],
        pipelines: [{ id: 'pipeline', account_id: 'A' }],
        pipeline_stages: [
          { id: 'cooking', pipeline_id: 'pipeline', name: 'Na Cozinha' },
        ],
        conversations: [
          {
            id: 'old-conversation',
            account_id: 'A',
            contact_id: 'contact',
            status: 'open',
          },
          {
            id: 'current-conversation',
            account_id: 'A',
            contact_id: 'contact',
            status: 'open',
          },
        ],
      }
    );
    expect((await post()).status).toBe(200);
    expect(mocks.db.orders[0].status).toBe('paid');
    expect(mocks.db.orders[1].status).toBe('pending');
    expect(mocks.db.tables.deals[0].stage_id).toBe('cooking');
    expect(mocks.db.tables.conversations.map((row) => row.status)).toEqual([
      'open',
      'open',
    ]);
    expect(saveContactOrderFields).not.toHaveBeenCalled();
    expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['contact', 'deal', 'pipeline'])(
    'blocks foreign linked %s ownership before ANY mutation',
    async (kind) => {
      const row = {
        ...order('A', 'pref-A'),
        contact_id: 'contact',
        deal_id: 'deal',
      };
      mocks.db = database([row], {
        contacts: [
          {
            id: 'contact',
            account_id: kind === 'contact' ? 'B' : 'A',
            user_id: 'user',
          },
        ],
        deals: [
          {
            id: 'deal',
            account_id: kind === 'deal' ? 'B' : 'A',
            contact_id: 'contact',
            pipeline_id: 'pipeline',
          },
        ],
        pipelines: [
          { id: 'pipeline', account_id: kind === 'pipeline' ? 'B' : 'A' },
        ],
      });
      expect((await post()).status).toBe(409);
      expect(mocks.db.writes).toEqual([]);
      expect(mocks.send).not.toHaveBeenCalled();
    }
  );
  it('reports a non-approved DB update error instead of acknowledging success', async () => {
    mocks.paymentGet.mockResolvedValue({
      ...(await mocks.paymentGet()),
      status: 'rejected',
    });
    mocks.db.failUpdate();
    expect((await post()).status).toBe(500);
  });
  it('scopes every order mutation by persisted account and preference', async () => {
    await post();
    for (const call of mocks.db.calls.filter(
      (c) => c.payload && c.table === 'orders'
    )) {
      expect(call.equalities).toContainEqual(['account_id', 'A']);
      expect(call.equalities).toContainEqual(['preference_id', 'pref-A']);
    }
  });
  it('unknown gateway preference requires reconciliation instead of silent acknowledgement', async () => {
    mocks.db = database([]);
    expect((await post()).status).toBe(409);
  });

  it.each([
    ['payment id mismatch', 'paymentGet', { id: 124 }],
    ['payment collector mismatch', 'paymentGet', { collector_id: 10 }],
    ['merchant id mismatch', 'merchantGet', { id: 457 }],
    ['merchant collector mismatch', 'merchantGet', { collector: { id: 10 } }],
    [
      'payment not in merchant order',
      'merchantGet',
      { payments: [{ id: 124 }] },
    ],
    [
      'merchant reference mismatch',
      'merchantGet',
      { external_reference: 'OTHER' },
    ],
    ['preference collector mismatch', 'preferenceGet', { collector_id: 10 }],
    ['preference id mismatch', 'preferenceGet', { id: 'pref-B' }],
    [
      'preference reference mismatch',
      'preferenceGet',
      { external_reference: 'OTHER' },
    ],
    [
      'preference currency mismatch',
      'preferenceGet',
      { items: [{ quantity: 1, unit_price: 28, currency_id: 'USD' }] },
    ],
    [
      'preference amount mismatch',
      'preferenceGet',
      { items: [{ quantity: 1, unit_price: 29, currency_id: 'BRL' }] },
    ],
  ] as const)(
    'blocks %s without mutations',
    async (_name, boundary, change) => {
      mocks[boundary].mockResolvedValue({
        ...(await mocks[boundary]()),
        ...change,
      });
      expect((await post()).status).toBe(409);
      expect(mocks.db.writes).toEqual([]);
    }
  );
  it.each([1, 2])(
    'explicitly blocks legacy without trusted preference (%i reference matches)',
    async (count) => {
      mocks.db = database(
        Array.from({ length: count }, (_, i) => order(String(i), ''))
      );
      mocks.paymentGet.mockResolvedValue({
        ...(await mocks.paymentGet()),
        order: undefined,
      });
      expect((await post()).status).toBe(409);
      expect(mocks.db.writes).toEqual([]);
    }
  );
  it('fails closed on database read errors', async () => {
    mocks.db.fail();
    expect((await post()).status).toBe(500);
    expect(mocks.db.writes).toEqual([]);
  });
  it('blocks a preference bound to multiple accounts instead of taking the first', async () => {
    mocks.db = database([order('B', 'pref-A'), order('A', 'pref-A')]);
    expect((await post()).status).toBe(500);
    expect(mocks.db.writes).toEqual([]);
  });
  it('linked legacy notifications keep paid durable through real deal-stage follow-up and notify only once', async () => {
    mocks.db = database(
      [{ ...order('A', 'pref-A'), contact_id: 'contact', deal_id: 'deal' }],
      {
        contacts: [
          {
            id: 'contact',
            account_id: 'A',
            user_id: 'user',
            phone: 'dummy-phone',
          },
        ],
        deals: [
          {
            id: 'deal',
            account_id: 'A',
            contact_id: 'contact',
            pipeline_id: 'pipeline',
          },
        ],
        pipelines: [{ id: 'pipeline', account_id: 'A' }],
        pipeline_stages: [
          { id: 'cooking', pipeline_id: 'pipeline', name: 'Na Cozinha' },
        ],
        conversations: [
          {
            id: 'conversation',
            account_id: 'A',
            contact_id: 'contact',
            user_id: 'user',
          },
        ],
      }
    );
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(mocks.db.orders[0].status).toBe('paid');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.db.tables.deals[0]).toMatchObject({
      value: 28,
      stage_id: 'cooking',
    });
    for (const call of mocks.db.calls.filter((c) =>
      ['contacts', 'deals', 'conversations'].includes(c.table)
    )) {
      expect(call.equalities).toContainEqual(['account_id', 'A']);
    }
  });
  it('duplicate concurrent notifications have exactly one winning transition', async () => {
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(mocks.db.writes.flatMap((w) => w.ids)).toEqual(['order-A']);
  });
  it.each([
    ['missing amount', { transaction_amount: undefined }],
    ['one cent short', { transaction_amount: 27.99 }],
    ['overpaid', { transaction_amount: 28.01 }],
    ['fractional cent', { transaction_amount: 28.001 }],
    ['NaN amount', { transaction_amount: NaN }],
    ['missing currency', { currency_id: undefined }],
    ['wrong currency', { currency_id: 'USD' }],
  ])(
    'does not mutate ANY status for %s, including rejected/in_process',
    async (_name, change) => {
      for (const status of ['approved', 'rejected', 'in_process']) {
        mocks.paymentGet.mockResolvedValue({
          ...(await mocks.paymentGet()),
          ...change,
          status,
        });
        await post();
        expect(mocks.db.writes).toEqual([]);
      }
    }
  );
  it('routes SAME28 in two accounts by persisted preference, never latest reference or payload account', async () => {
    expect((await post()).status).toBe(200);
    expect(mocks.db.orders.map((r) => [r.account_id, r.status])).toEqual([
      ['B', 'pending'],
      ['A', 'paid'],
    ]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
