import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  processFreeTextOrderInbound,
  type TextOrderFlowContext,
} from './text-order-flow';
import { createOrderWithMercadoPago } from './create-order-with-mercado-pago';
import { loadOrderCatalog } from './order-catalog';
import { applyContactTag } from './create-order';
import type { OrderDraft } from './order-draft';

vi.mock('./create-order-with-mercado-pago', () => ({
  createOrderWithMercadoPago: vi.fn(),
}));
vi.mock('./order-catalog', () => ({ loadOrderCatalog: vi.fn() }));
vi.mock('./custom-fields', () => ({
  getSavedCustomerAddress: vi.fn(async () => null),
  saveContactOrderFields: vi.fn(async () => undefined),
}));
vi.mock('./create-order', () => ({
  applyContactTag: vi.fn(async () => undefined),
  TAG_HUMANO: 'Precisa de Atendente',
}));

function fixture() {
  let state: OrderDraft | null = null;
  let processing: string | null = null;
  const events = new Set<string>();
  const outbox = new Set<string>();
  const messages: Record<string, unknown>[] = [];
  let failMessages = false;
  let activeFlow: {
    id: string;
    account_id: string;
    status: string;
    consent_revision: number;
    vars: Record<string, unknown>;
  } | null = null;
  const flowUpdates: Record<string, unknown>[] = [];
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, string>) => {
      if (name === 'flow_checkout_correct') {
        if (
          !activeFlow ||
          activeFlow.id !== args.p_run_id ||
          activeFlow.account_id !== args.p_account_id
        )
          return { data: [], error: null };
        const corrected = {
          ...activeFlow,
          status: 'handed_off',
          consent_revision: activeFlow.consent_revision + 1,
          vars: {
            ...activeFlow.vars,
            pending_order_change: args.p_text,
            catalog_review_text: args.p_text,
            pedido_confirmado: 'false',
          },
        };
        flowUpdates.push(corrected);
        activeFlow = null;
        return { data: [corrected], error: null };
      }
      if (name !== 'claim_order_turn')
        throw new Error(`Unexpected RPC ${name}`);
      if (events.has(args.p_message_id))
        return { data: { outcome: 'duplicate' }, error: null };
      events.add(args.p_message_id);
      if (processing) return { data: { outcome: 'busy' }, error: null };
      processing = args.p_message_id;
      return {
        data: { outcome: 'claimed', id: 'draft-1', state },
        error: null,
      };
    }),
    from(table: string) {
      let operation = 'select';
      let payload: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const result = () => {
        if (table === 'flow_runs') {
          if (operation === 'select') return { data: activeFlow, error: null };
          flowUpdates.push(payload);
          if (payload.status === 'handed_off') activeFlow = null;
          return { data: null, error: null };
        }
        if (table === 'order_drafts') {
          if (operation === 'select')
            return { data: state ? { state } : null, error: null };
          if (filters.processing_message_id !== processing)
            return { data: null, error: { message: 'claim mismatch' } };
          state = structuredClone(payload.state) as OrderDraft;
          if (payload.processing_message_id === null) processing = null;
          return { data: { id: 'draft-1' }, error: null };
        }
        if (table === 'order_message_outbox' && operation === 'insert') {
          const key = String(payload.effect_key);
          if (outbox.has(key))
            return {
              data: null,
              error: { code: '23505', message: 'duplicate' },
            };
          outbox.add(key);
        }
        if (table === 'messages' && operation === 'insert') {
          if (failMessages)
            return {
              data: null,
              error: { message: 'DB unavailable after Meta accepted' },
            };
          messages.push(payload);
        }
        return { data: null, error: null };
      };
      const builder = {
        select() {
          return builder;
        },
        eq(key: string, value: unknown) {
          filters[key] = value;
          return builder;
        },
        insert(value: Record<string, unknown>) {
          operation = 'insert';
          payload = value;
          return builder;
        },
        update(value: Record<string, unknown>) {
          operation = 'update';
          payload = value;
          return builder;
        },
        async maybeSingle() {
          return result();
        },
        async single() {
          return result();
        },
        then(resolve: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return builder;
    },
  };
  const context: Omit<
    TextOrderFlowContext,
    'inboundText' | 'inboundMessageId'
  > = {
    supabase: db as unknown as SupabaseClient,
    accountId: 'account-1',
    userId: 'owner-1',
    conversationId: 'conversation-1',
    contactRecord: { id: 'contact-1', name: 'Rafael', phone: '5511999999999' },
    contactName: 'Rafael',
    senderPhone: '5511999999999',
    phoneNumberId: 'phone-1',
    accessToken: 'fake-test-token',
    inboundTimestamp: '2026-10-11T01:00:00.000Z',
  };
  return {
    messages,
    db,
    flowUpdates,
    setActiveCatalog: () => {
      activeFlow = {
        id: 'catalog-run-2',
        account_id: 'account-1',
        status: 'active',
        consent_revision: 0,
        vars: {
          catalog_order_version: 1,
          itens: [{ id: 'sausage', quantity: 1 }],
        },
      };
    },
    state: () => state!,
    setFailMessages: () => {
      failMessages = true;
    },
    turn: (inboundText: string, inboundMessageId: string) =>
      processFreeTextOrderInbound({
        ...context,
        inboundText,
        inboundMessageId,
      }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-11T02:00:00Z');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid-test' }] }), {
          status: 200,
        })
    )
  );
  vi.mocked(loadOrderCatalog).mockResolvedValue([
    { id: 'meat', nome: 'Carne', preco: 14, aliases: ['carne'] },
    { id: 'sausage', nome: 'Calabresa', preco: 14, aliases: ['calabresa'] },
    {
      id: 'cheese',
      nome: 'Queijo com tomate',
      preco: 14,
      aliases: ['queijo com tomate'],
    },
    { id: 'escarole', nome: 'Escarola', preco: 14, aliases: ['escarola'] },
  ]);
  vi.mocked(createOrderWithMercadoPago).mockResolvedValue({
    ok: true,
    orderId: 'order-1',
    dealId: 'deal-1',
    link_mercado_pago:
      'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=test',
  });
});

describe('text order pipeline (all external effects mocked)', () => {
  it('invalidates active catalog correction through the locked consent RPC, not a direct vars overwrite', async () => {
    const f = fixture();
    f.setActiveCatalog();
    const result = await f.turn('troca para 3 carne', 'catalog-correction');
    expect(result).toMatchObject({ handled: true, outcome: 'needs_human' });
    expect(f.db.rpc).toHaveBeenCalledWith('flow_checkout_correct', {
      p_account_id: 'account-1',
      p_run_id: 'catalog-run-2',
      p_text: 'troca para 3 carne',
    });
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
    expect(
      f.db.rpc.mock.calls.some(([name]) => name === 'claim_order_turn')
    ).toBe(false);
  });
  it.each(['Delivery', 'Rua Nova, 20 Centro', 'confirmo o pedido'])(
    'lets the new active catalog own a reply after a completed text checkout: %s',
    async (reply) => {
      const f = fixture();
      await f.turn('2 carne, entregar na Rua Flores, 10 Centro', 'text-items');
      await f.turn('confirmo o pedido', 'text-confirm');
      expect(f.state().stage).toBe('payment_created');
      f.setActiveCatalog();
      const before = structuredClone(f.state());
      expect(await f.turn(reply, 'catalog-reply')).toEqual({ handled: false });
      expect(f.state()).toEqual(before);
      expect(f.flowUpdates).toEqual([]);
      expect(f.db.rpc).toHaveBeenCalledTimes(2);
      expect(f.messages).toHaveLength(2);
      expect(createOrderWithMercadoPago).toHaveBeenCalledTimes(1);
    }
  );
  it('preserves Rafael customization lines in persisted state and summary and hands off without payment', async () => {
    const f = fixture();
    const result = await f.turn(
      '1 queijo com tomate\n2 carne sem pimentão\n2 calabresa sem queijo ou cream cheese\n1 escarola\n5 carne',
      'rafael'
    );
    expect(result.outcome).toBe('needs_human');
    expect(f.state().items.map((item) => item.quantity)).toEqual([
      1, 2, 2, 1, 5,
    ]);
    expect(f.state().items[1].notes).toBe('sem pimentão');
    expect(f.state().items[2].notes).toBe('sem queijo ou cream cheese');
    expect(f.messages[0].content_text).toContain(
      '2x Calabresa — sem queijo ou cream cheese'
    );
    expect(f.messages[0].content_text).toContain('5x Carne');
    expect(applyContactTag).toHaveBeenCalled();
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
    await f.turn('confirmo o pedido', 'rafael-confirm');
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
  });
  it('requires summary confirmation even with an address and persists the real CTA type/payload', async () => {
    const f = fixture();
    expect(
      (await f.turn('2 carne, entregar na Rua Flores, 10 Centro', 'items'))
        .outcome
    ).toBe('confirmation_requested');
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
    expect((await f.turn('confirmo o pedido', 'confirm')).outcome).toBe(
      'order_created'
    );
    expect(createOrderWithMercadoPago).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-1' }),
      expect.objectContaining({
        externalReference: 'TEXT-draft-1-2',
        items: [
          expect.objectContaining({ id: 'meat', quantity: 2, unitPrice: 14 }),
        ],
      })
    );
    const payment = f.messages[1];
    expect(payment.content_type).toBe('interactive');
    expect(payment.interactive_payload).toMatchObject({ type: 'cta_url' });
    expect(payment.content_text).toContain('La Empanadas');
    expect(payment.content_text).toContain('R$ 28,00');
    expect(payment.content_text).not.toContain('https://');
    expect(payment.content_text).not.toContain('[Botão:');
  });
  it('applies subsequent corrections and preserves unrelated products across address turns', async () => {
    const f = fixture();
    await f.turn('2 carne, 1 calabresa', 'first');
    await f.turn('na verdade 3 carne', 'correction');
    expect(f.state().items.map((item) => item.quantity)).toEqual([3, 1]);
    await f.turn('Rua Flores, 10 Centro', 'address');
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
    await f.turn('confirmo o pedido', 'confirm');
    expect(createOrderWithMercadoPago).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        items: [
          expect.objectContaining({ quantity: 3 }),
          expect.objectContaining({ quantity: 1 }),
        ],
      })
    );
  });
  it('never omits an unknown line or invents a price', async () => {
    const f = fixture();
    expect((await f.turn('2 carne, 1 lagosta', 'unknown')).outcome).toBe(
      'needs_human'
    );
    expect(f.state().unresolved).toEqual(['1 lagosta']);
    expect(f.messages[0].content_text).toContain('1 lagosta');
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
  });
  it('deduplicates inbound retries, messages and checkout calls', async () => {
    const f = fixture();
    await f.turn('2 carne, entregar na Rua Flores, 10 Centro', 'items');
    expect(
      (await f.turn('2 carne, entregar na Rua Flores, 10 Centro', 'items'))
        .outcome
    ).toBe('duplicate');
    await f.turn('confirmo o pedido', 'confirm');
    expect((await f.turn('confirmo o pedido', 'confirm')).outcome).toBe(
      'duplicate'
    );
    expect(f.messages).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createOrderWithMercadoPago).toHaveBeenCalledTimes(1);
  });
  it('does not resend a Meta-accepted message when history persistence fails', async () => {
    const f = fixture();
    f.setFailMessages();
    expect((await f.turn('2 carne', 'items')).outcome).toBe('needs_human');
    await f.turn('2 carne', 'items');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed on catalog errors and leaves normal messages to other responders', async () => {
    const f = fixture();
    expect((await f.turn('boa tarde', 'greeting')).handled).toBe(false);
    vi.mocked(loadOrderCatalog).mockRejectedValueOnce(
      new Error('catalog unavailable')
    );
    expect((await f.turn('1 carne', 'items')).outcome).toBe('needs_human');
    expect(fetch).not.toHaveBeenCalled();
    expect(createOrderWithMercadoPago).not.toHaveBeenCalled();
  });
});
