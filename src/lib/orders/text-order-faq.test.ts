import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderDraft } from './order-draft';
import { processFreeTextOrderInbound } from './text-order-flow';
import { STORE_FAQ, STORE_FAQ_UNCONFIRMED } from './store-faq-config';

const effects = vi.hoisted(() => ({
  checkout: vi.fn(),
  send: vi.fn(),
  payment: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('./create-order-with-mercado-pago', () => ({
  createOrderWithMercadoPago: effects.checkout,
}));
vi.mock('./order-catalog', () => ({ loadOrderCatalog: effects.catalog }));
vi.mock('./custom-fields', () => ({
  getSavedCustomerAddress: vi.fn(),
  saveContactOrderFields: vi.fn(),
}));
vi.mock('./create-order', () => ({
  applyContactTag: vi.fn(),
  TAG_HUMANO: 'Humano',
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTextMessage: effects.send }));
vi.mock('@/lib/whatsapp/payment-message', () => ({
  sendWhatsAppPaymentMessage: effects.payment,
}));
vi.mock('@/lib/payments/mercado-pago', () => ({
  getExistingPaymentLink: vi.fn(),
}));

function fixture() {
  let state: OrderDraft = {
    id: 'draft',
    version: 3,
    stage: 'payment_created',
    total: 28,
    paymentReference: 'CANONICAL-ORIGINAL',
    deliveryAddress: 'Rua Flores, 10 Centro',
    items: [
      {
        id: 'meat',
        title: 'Carne',
        quantity: 2,
        unitPrice: 14,
        totalPrice: 28,
        notes: 'sem cebola',
      },
    ],
    unresolved: [],
    cartUpdatedAt: '2026-10-11T01:00:00Z',
  };
  const initial = structuredClone(state);
  let paused = false;
  let busy = false;
  let processing: string | null = null;
  const events = new Map<string, string>();
  const outbox = new Map<string, Record<string, unknown>>();
  const messages: Record<string, unknown>[] = [];
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'claim_order_turn') {
        if (busy) return { data: { outcome: 'busy' }, error: null };
        processing = String(args.p_message_id);
        events.set(processing, 'processing');
        return {
          data: {
            outcome: 'claimed',
            id: state.id,
            state: structuredClone(state),
          },
          error: null,
        };
      }
      if (name === 'handle_conversation_handoff') {
        if (args.p_request) paused = true;
        return {
          data: { blocked: paused, episode_id: 'episode', notice: 'waiting' },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }),
    from(table: string) {
      let operation = 'select';
      let payload: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const result = () => {
        if (table === 'conversations')
          return {
            data: { ai_autoreply_disabled: paused, status: 'open' },
            error: null,
          };
        if (table === 'flow_runs') return { data: null, error: null };
        if (table === 'orders')
          return { data: { status: 'pending' }, error: null };
        if (table === 'order_inbound_events') {
          const id = String(filters.meta_message_id);
          if (operation === 'update') events.set(id, String(payload.status));
          return {
            data: events.has(id) ? { status: events.get(id) } : null,
            error: null,
          };
        }
        if (table === 'order_drafts') {
          if (operation === 'update') {
            if (processing !== filters.processing_message_id)
              return { data: null, error: { message: 'claim lost' } };
            state = structuredClone(payload.state) as OrderDraft;
            if (payload.processing_message_id === null) processing = null;
            return { data: { id: state.id }, error: null };
          }
          return {
            data: {
              state: structuredClone(state),
              updated_at: state.cartUpdatedAt,
            },
            error: null,
          };
        }
        if (table === 'order_message_outbox') {
          const key = String(payload.effect_key ?? filters.effect_key);
          if (operation === 'insert') {
            if (outbox.has(key))
              return { data: null, error: { code: '23505' } };
            outbox.set(key, structuredClone(payload));
          } else if (operation === 'update')
            Object.assign(outbox.get(key)!, payload);
        }
        if (table === 'messages' && operation === 'insert')
          messages.push(payload);
        return { data: null, error: null };
      };
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return q;
        },
        update: (value: Record<string, unknown>) => {
          operation = 'update';
          payload = value;
          return q;
        },
        insert: (value: Record<string, unknown>) => {
          operation = 'insert';
          payload = value;
          return q;
        },
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return q;
    },
  };
  return {
    db,
    messages,
    outbox,
    events,
    initial,
    state: () => state,
    pause: () => {
      paused = true;
    },
    busy: () => {
      busy = true;
    },
    paused: () => paused,
    turn: (inboundText: string, inboundMessageId = 'faq-message') =>
      processFreeTextOrderInbound({
        supabase: db as unknown as SupabaseClient,
        accountId: 'account',
        userId: 'user',
        conversationId: 'conversation',
        contactRecord: {
          id: 'contact',
          name: 'Cliente',
          phone: '5511999999999',
        },
        contactName: 'Cliente',
        senderPhone: '5511999999999',
        phoneNumberId: 'phone',
        accessToken: 'dummy-test-token',
        inboundTimestamp: '2026-10-11T01:00:00Z',
        inboundText,
        inboundMessageId,
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-11T02:00:00Z');
  effects.send.mockResolvedValue({ messageId: 'wamid-faq' });
});
afterEach(() => vi.useRealTimers());

describe('post-checkout FAQs with real turn/outbox orchestration', () => {
  it.each([
    ['Tem taxa de entrega?', STORE_FAQ.taxa_entrega],
    ['Como pagar?', STORE_FAQ.como_pagar],
  ])(
    'answers %s once without touching the frozen order',
    async (text, answer) => {
      const f = fixture();
      const result = await f.turn(text!);
      expect(result).toMatchObject({ handled: true, outcome: 'faq_answered' });
      expect(f.state()).toEqual(f.initial);
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0].content_text).toBe(answer);
      expect(f.outbox.get('faq:faq-message')).toMatchObject({ status: 'sent' });
      expect(f.events.get('faq-message')).toBe('completed');
      expect(f.paused()).toBe(false);
      expect(f.db.rpc).not.toHaveBeenCalledWith(
        'handle_conversation_handoff',
        expect.anything()
      );
      await f.turn(text!);
      expect(effects.send).toHaveBeenCalledTimes(1);
      expect(effects.checkout).not.toHaveBeenCalled();
      expect(effects.payment).not.toHaveBeenCalled();
      expect(effects.catalog).not.toHaveBeenCalled();
    }
  );

  it.each([
    'Quanto tempo?',
    'Aceita Pluxee?',
    'Posso pagar na entrega?',
    'Qual o horário?',
  ])(
    'answers unknown policy %s conservatively and keeps human review',
    async (text) => {
      const f = fixture();
      expect((await f.turn(text)).outcome).toBe('needs_human');
      expect(f.messages[0].content_text).toBe(STORE_FAQ_UNCONFIRMED);
      expect(f.outbox.get('faq:faq-message')).toMatchObject({ status: 'sent' });
      expect(f.state()).toEqual(f.initial);
      expect(f.paused()).toBe(true);
      expect(f.db.rpc).toHaveBeenCalledWith(
        'handle_conversation_handoff',
        expect.objectContaining({ p_request: true, p_reason: 'payment_review' })
      );
      expect(effects.checkout).not.toHaveBeenCalled();
      expect(effects.payment).not.toHaveBeenCalled();
    }
  );

  it.each([
    'quanto tempo? adiciona 2 coca',
    'como pagar? troca meu endereço',
    'já paguei',
  ])('does not hide a mixed change or assertion as FAQ: %s', async (text) => {
    const f = fixture();
    expect((await f.turn(text)).outcome).toBe('needs_human');
    expect(f.outbox.has('faq:faq-message')).toBe(false);
    expect(f.state()).toEqual(f.initial);
    expect(effects.checkout).not.toHaveBeenCalled();
  });

  it('does not override a persisted human pause for a FAQ', async () => {
    const f = fixture();
    f.pause();
    expect((await f.turn('Como pagar?')).outcome).toBe('needs_human');
    expect(f.outbox.has('faq:faq-message')).toBe(false);
    expect(f.state()).toEqual(f.initial);
    expect(effects.checkout).not.toHaveBeenCalled();
  });

  it('does not bypass an uncertain/busy turn to answer a FAQ', async () => {
    const f = fixture();
    f.busy();
    expect((await f.turn('Como pagar?')).outcome).toBe('needs_human');
    expect(f.outbox.has('faq:faq-message')).toBe(false);
    expect(f.state()).toEqual(f.initial);
    expect(effects.checkout).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous FAQ send reserved instead of replaying or creating a payment', async () => {
    const f = fixture();
    effects.send.mockRejectedValueOnce(new Error('ambiguous Meta send'));
    expect((await f.turn('Como pagar?')).outcome).toBe('needs_human');
    expect(f.outbox.get('faq:faq-message')).toMatchObject({
      status: 'uncertain',
    });
    expect(f.events.get('faq-message')).toBe('failed');
    await f.turn('Como pagar?');
    expect(effects.send).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual(f.initial);
    expect(effects.checkout).not.toHaveBeenCalled();
  });
});
