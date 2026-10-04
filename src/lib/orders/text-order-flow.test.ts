import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processFreeTextOrderInbound } from './text-order-flow';
import * as createOrderWithMpModule from './create-order-with-mercado-pago';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('text-order-flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock global fetch for WhatsApp API calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid_12345' }] }),
    } as unknown as Response);
  });

  it('handles order items without address: asks for address', async () => {
    const messagesInserted: Array<{ table: string; data: unknown }> = [];
    const mockSupabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            not: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            in: () => Promise.resolve({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: async (data: unknown) => {
          messagesInserted.push({ table, data });
          return { error: null };
        },
        upsert: async () => ({ error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await processFreeTextOrderInbound({
      supabase: mockSupabase,
      accountId: 'acc_1',
      userId: 'usr_1',
      contactRecord: { id: 'cnt_1', name: 'Carlos', phone: '5511999999999' },
      contactName: 'Carlos',
      senderPhone: '5511999999999',
      conversationId: 'conv_1',
      inboundText: '2 carne, 2 calabresa, 1 coca zero lata',
      phoneNumberId: 'phone_1',
      accessToken: 'token_1',
    });

    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('address_requested');

    // Verificou se enviou a mensagem perguntando o endereço com os itens e o total
    expect(global.fetch).toHaveBeenCalled();
    const fetchCalls = vi.mocked(global.fetch).mock.calls;
    const requestBody = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(requestBody.text.body).toContain('Pedido anotado:');
    expect(requestBody.text.body).toContain('2x Empanada de Carne com Ovos');
    expect(requestBody.text.body).toContain(
      '2x Empanada de Calabresa com Cream Cheese'
    );
    expect(requestBody.text.body).toContain('1x Coca-Cola sem Açúcar 350ml');
    expect(requestBody.text.body).toContain('Total: R$ 64,50');
    expect(requestBody.text.body).toContain('Para onde devemos entregar?');
  });

  it('handles order items WITH address in same message: creates order and sends MP link', async () => {
    vi.spyOn(
      createOrderWithMpModule,
      'createOrderWithMercadoPago'
    ).mockResolvedValue({
      ok: true,
      dealId: 'deal_123',
      link_mercado_pago: 'https://mercadopago.com/checkout/123',
      preferenceId: 'pref_123',
    });

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            not: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            in: () => Promise.resolve({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await processFreeTextOrderInbound({
      supabase: mockSupabase,
      accountId: 'acc_1',
      userId: 'usr_1',
      contactRecord: { id: 'cnt_1', name: 'Maria', phone: '5511999999999' },
      contactName: 'Maria',
      senderPhone: '5511999999999',
      conversationId: 'conv_1',
      inboundText:
        'quero 2 de carne e 1 coca zero, entregar na Rua das Flores, 123 - Centro',
      phoneNumberId: 'phone_1',
      accessToken: 'token_1',
    });

    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('order_created');
    expect(
      createOrderWithMpModule.createOrderWithMercadoPago
    ).toHaveBeenCalledWith(
      { accountId: 'acc_1', userId: 'usr_1' },
      expect.objectContaining({
        contactId: 'cnt_1',
        customerName: 'Maria',
        deliveryKind: 'delivery',
        deliveryAddress: expect.stringContaining('Rua das Flores'),
      })
    );
  });

  it('handles address response to previous "Pedido anotado": confirms order and generates MP link', async () => {
    vi.spyOn(
      createOrderWithMpModule,
      'createOrderWithMercadoPago'
    ).mockResolvedValue({
      ok: true,
      dealId: 'deal_456',
      link_mercado_pago: 'https://mercadopago.com/checkout/456',
      preferenceId: 'pref_456',
    });

    const previousBotMessage =
      '🫔 *Pedido anotado:*\n' +
      '• 2x Empanada de Carne com Ovos\n' +
      '• 1x Coca-Cola sem Açúcar 350ml\n\n' +
      '💵 *Total: R$ 36,50*\n\n' +
      'Para onde devemos entregar? Por favor, envie seu *endereço completo* (Rua, Número e Bairro).';

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({
                    data: [{ content_text: previousBotMessage }],
                    error: null,
                  }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            not: () => ({
              neq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: [{ content_text: previousBotMessage }],
                  error: null,
                }),
            }),
            in: () => Promise.resolve({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
      }),
    } as unknown as SupabaseClient;

    const result = await processFreeTextOrderInbound({
      supabase: mockSupabase,
      accountId: 'acc_1',
      userId: 'usr_1',
      contactRecord: { id: 'cnt_1', name: 'João', phone: '5511999999999' },
      contactName: 'João',
      senderPhone: '5511999999999',
      conversationId: 'conv_1',
      inboundText: 'Rua das Palmeiras, 150 - Bairro Centro',
      phoneNumberId: 'phone_1',
      accessToken: 'token_1',
    });

    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('order_created');
    expect(
      createOrderWithMpModule.createOrderWithMercadoPago
    ).toHaveBeenCalledWith(
      { accountId: 'acc_1', userId: 'usr_1' },
      expect.objectContaining({
        contactId: 'cnt_1',
        customerName: 'João',
        deliveryKind: 'delivery',
        deliveryAddress: 'Rua das Palmeiras, 150 - Bairro Centro',
        items: expect.arrayContaining([
          expect.objectContaining({
            title: 'Empanada de Carne com Ovos',
            quantity: 2,
          }),
          expect.objectContaining({
            title: 'Coca-Cola sem Açúcar 350ml',
            quantity: 1,
          }),
        ]),
      })
    );
  });

  it('returns handled: false for non-order messages', async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await processFreeTextOrderInbound({
      supabase: mockSupabase,
      accountId: 'acc_1',
      userId: 'usr_1',
      contactRecord: { id: 'cnt_1', name: 'Maria', phone: '5511999999999' },
      contactName: 'Maria',
      senderPhone: '5511999999999',
      conversationId: 'conv_1',
      inboundText: 'boa tarde, tudo bem?',
      phoneNumberId: 'phone_1',
      accessToken: 'token_1',
    });

    expect(result.handled).toBe(false);
  });
});
