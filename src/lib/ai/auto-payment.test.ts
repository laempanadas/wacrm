import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openPaymentFingerprint } from '@/lib/payments/open-payment-identity';
const h = vi.hoisted(() => ({ link: vi.fn() }));
vi.mock('@/lib/payments/mercado-pago', () => ({
  getExistingPaymentLink: h.link,
}));
import { parseAiTotal, resolveAiPayment } from './auto-payment';

const scope = {
  accountId: 'account',
  conversationId: 'conversation',
  contactId: 'contact',
};
function database(rows: Record<string, unknown>) {
  const from = vi.fn((table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
    };
    return q;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}
beforeEach(() =>
  h.link.mockResolvedValue('https://www.mercadopago.com.br/checkout/same')
);
describe('AI total control', () => {
  it('extracts exact positive cents without exposing the control', () => {
    expect(parseAiTotal('Seu pedido. [TOTAL:140.00]')).toEqual({
      text: 'Seu pedido.',
      kind: 'valid',
      cents: 14000,
    });
  });
  it.each([
    '[TOTAL:0.00]',
    '[TOTAL:-1.00]',
    '[TOTAL:NaN]',
    '[TOTAL:1,00]',
    '[ TOTAL:1.00 ]',
    '[TOTAL:01.00]',
    '[TOTAL:1.0]',
    '[TOTAL:1000000.00]',
    '[TOTAL:1.00][TOTAL:1.00]',
    '[TOTAL:1.00][TOTAL:2.00]',
    '[TOTAL:Infinity]',
    '[TOTAL:1.00',
  ])('rejects invalid control %s and strips it', (marker) => {
    expect(parseAiTotal(`Olá ${marker}`)).toEqual({
      kind: 'invalid',
      text: 'Olá',
    });
  });
  it('leaves ordinary conversation alone', () => {
    expect(parseAiTotal('Total: R$ 140,00')).toEqual({
      kind: 'none',
      text: 'Total: R$ 140,00',
    });
  });
  it.each([
    ['Pronto [TOTAL:\n140.00]', 'Pronto'],
    ['Pronto [TOTAL:140.00]\n[TOTAL:\n999.00]', 'Pronto'],
    [
      'Pronto [TOTAL:\r\n140.00] Confira o endereço.',
      'Pronto  Confira o endereço.',
    ],
    ['Pronto [TOTAL:140.00]\r\n[TOTAL:\r\n999.00]', 'Pronto'],
    ['Pronto [TOTAL:\n140.00', 'Pronto'],
    ['Pronto [TOTAL:140.00]\n[TOTAL:\n999.00', 'Pronto'],
    ['Pronto [TOTAL:\n999.00]\n[TOTAL:140.00]', 'Pronto'],
    [
      'Pronto [TOTAL:[TOTAL:140.00]] Confira o endereço.',
      'Pronto  Confira o endereço.',
    ],
    ['Pronto [TOTAL:\n[TOTAL:140.00]', 'Pronto'],
    ['Pronto [TOTAL:140.00[TOTAL:\r\n999.00]] Fim.', 'Pronto  Fim.'],
  ])(
    'rejects every malformed/mixed opening and strips its fragments: %j',
    (raw, text) => {
      expect(parseAiTotal(raw)).toEqual({ kind: 'invalid', text });
    }
  );
  it('uses only the bound canonical checkout and same reference', async () => {
    const draft = {
      id: 'draft',
      version: 2,
      stage: 'payment_created',
      paymentReference: 'ORIGINAL',
      total: 140,
      items: [{ id: 'sku', title: 'Empanada', quantity: 10, unitPrice: 14 }],
      unresolved: [],
      deliveryAddress: 'Rua A, 10, Centro',
    };
    const order = {
      id: 'order',
      account_id: 'account',
      contact_id: 'contact',
      external_reference: 'ORIGINAL',
      preference_id: 'pref',
      payment_url: 'https://www.mercadopago.com.br/checkout/same',
      status: 'pending',
      total: 140,
      payment_fingerprint: openPaymentFingerprint({
        items: draft.items,
        delivery_kind: 'delivery',
        delivery_address: draft.deliveryAddress,
        observations: '',
      }),
    };
    const { db } = database({ order_drafts: { state: draft }, orders: order });
    const result = await resolveAiPayment(db, scope, 14000);
    expect(result).toEqual({
      kind: 'payment',
      url: order.payment_url,
      reference: 'ORIGINAL',
      cents: 14000,
    });
    expect(h.link).toHaveBeenCalledWith(order);
  });
  it.each([
    ['no cart', null],
    ['empty cart', { items: [] }],
    [
      'missing address',
      {
        id: 'draft',
        version: 1,
        items: [{ id: 'sku', quantity: 1, unitPrice: 140 }],
        deliveryAddress: '',
      },
    ],
    [
      'unconfirmed cart',
      {
        id: 'draft',
        version: 1,
        items: [{ id: 'sku', quantity: 1, unitPrice: 140 }],
        deliveryAddress: 'Rua A, 10, Centro',
        unresolved: [],
        stage: 'awaiting_confirmation',
        total: 140,
      },
    ],
    [
      'unresolved observations',
      {
        id: 'draft',
        version: 1,
        items: [{ id: 'sku', quantity: 1, unitPrice: 140 }],
        deliveryAddress: 'Rua A, 10, Centro',
        unresolved: ['unknown'],
        stage: 'payment_created',
        total: 140,
      },
    ],
    [
      'amount mismatch',
      {
        id: 'draft',
        version: 1,
        items: [{ id: 'sku', quantity: 1, unitPrice: 141 }],
        deliveryAddress: 'Rua A, 10, Centro',
        unresolved: [],
        stage: 'payment_created',
        total: 141,
      },
    ],
  ])(
    'clarifies %s without gateway lookup or database writes',
    async (_label, draft) => {
      const { db, from } = database({
        order_drafts: draft && { state: draft },
      });
      expect(await resolveAiPayment(db, scope, 14000)).toEqual(
        expect.objectContaining({ kind: 'clarify', text: expect.any(String) })
      );
      expect(h.link).not.toHaveBeenCalled();
      expect(from.mock.calls).toEqual([['order_drafts']]);
    }
  );
  it.each(['paid', 'checkout_uncertain', 'cancelled', null])(
    'never offers a non-pending canonical order (%s)',
    async (status) => {
      const draft = {
        id: 'draft',
        version: 2,
        stage: 'payment_created',
        total: 140,
        items: [{ id: 'sku', title: 'Empanada', quantity: 10, unitPrice: 14 }],
        unresolved: [],
        deliveryAddress: 'Rua A, 10, Centro',
      };
      const { db } = database({
        order_drafts: { state: draft },
        orders: {
          id: 'order',
          account_id: 'account',
          contact_id: 'contact',
          external_reference: 'TEXT-draft-2',
          preference_id: 'pref',
          payment_url: 'https://www.mercadopago.com.br/same',
          status,
          total: 140,
        },
      });
      expect(await resolveAiPayment(db, scope, 14000)).toEqual(
        expect.objectContaining({ kind: 'clarify' })
      );
      expect(h.link).not.toHaveBeenCalled();
    }
  );
  it('does not trust an equal amount or bound reference for a changed cart', async () => {
    const draft = {
      id: 'draft',
      version: 2,
      stage: 'payment_created',
      paymentReference: 'ORIGINAL',
      total: 140,
      items: [{ id: 'sku', title: 'Empanada', quantity: 10, unitPrice: 14 }],
      unresolved: [],
      deliveryAddress: 'Rua A, 10, Centro',
    };
    const order = {
      id: 'order',
      account_id: 'account',
      contact_id: 'contact',
      external_reference: 'ORIGINAL',
      preference_id: 'pref',
      payment_url: 'https://www.mercadopago.com.br/checkout/same',
      status: 'pending',
      total: 140,
      payment_fingerprint: openPaymentFingerprint({
        items: [
          {
            id: 'different-sku',
            title: 'Outro produto',
            quantity: 1,
            unitPrice: 140,
          },
        ],
        delivery_kind: 'delivery',
        delivery_address: draft.deliveryAddress,
        observations: '',
      }),
    };
    const { db } = database({ order_drafts: { state: draft }, orders: order });
    expect(await resolveAiPayment(db, scope, 14000)).toEqual(
      expect.objectContaining({ kind: 'clarify' })
    );
    expect(h.link).not.toHaveBeenCalled();
  });
});
