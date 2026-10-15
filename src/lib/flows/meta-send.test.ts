import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  send: vi.fn(),
  decrypt: vi.fn(() => 'test-token'),
}));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.from }),
}));
vi.mock('@/lib/whatsapp/payment-message', () => ({
  sendWhatsAppPaymentMessage: mocks.send,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mocks.decrypt }));
import { engineSendPayment } from './meta-send';
const args = {
  accountId: 'account',
  userId: 'user',
  contactId: 'contact',
  conversationId: 'conversation',
  effectKey: 'flow:run:payment',
  bodyText: 'Pedido confirmado',
  buttonUrl: 'https://pay.example/checkout',
};
let outbox: Record<string, unknown> | null;
let failTable: string | null;
let inbound: string;
let filters: Array<[string, string, unknown]>;
let writes: Array<{ table: string; value: Record<string, unknown> }>;
beforeEach(() => {
  vi.clearAllMocks();
  outbox = null;
  failTable = null;
  inbound = new Date(Date.now() - 60_000).toISOString();
  filters = [];
  writes = [];
  mocks.send.mockResolvedValue({
    messageId: 'wamid.test',
    contentType: 'interactive',
    formattedText: 'Pedido confirmado',
    interactivePayload: { type: 'cta_url' },
  });
  mocks.from.mockImplementation((table: string) => {
    let operation = 'select';
    let value: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    for (const key of ['select', 'order', 'limit']) q[key] = () => q;
    q.eq = (key: string, v: unknown) => {
      filters.push([table, key, v]);
      return q;
    };
    for (const key of ['insert', 'update'])
      q[key] = (v: Record<string, unknown>) => {
        operation = key;
        value = v;
        writes.push({ table, value });
        return q;
      };
    const result = () => {
      if (table === failTable)
        return {
          data: null,
          error: { code: 'XX000', message: 'DB unavailable' },
        };
      if (table === 'order_message_outbox') {
        if (operation === 'insert') {
          if (outbox)
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key' },
            };
          outbox = { ...value };
        } else if (operation === 'update') outbox = { ...outbox, ...value };
        return { data: outbox, error: null };
      }
      return {
        data:
          table === 'contacts'
            ? { id: 'contact', phone: '5511999999999' }
            : table === 'whatsapp_config'
              ? { phone_number_id: 'test-number', access_token: 'test-cipher' }
              : table === 'conversations'
                ? { id: 'conversation' }
                : table === 'messages' && operation === 'select'
                  ? { created_at: inbound }
                  : { id: 'row' },
        error: null,
      };
    };
    q.then = (resolve: (v: unknown) => void) =>
      Promise.resolve(result()).then(resolve);
    q.single = q.maybeSingle = async () => result();
    return q;
  });
});
describe('flow payment outbox', () => {
  it('replays a completed JSONB claim regardless of JSON key ordering without resending', async () => {
    await engineSendPayment(args);
    const payload = outbox!.payload as { request: Record<string, unknown> };
    payload.request = Object.fromEntries(
      Object.entries(payload.request).reverse()
    );
    expect(await engineSendPayment(args)).toEqual({
      whatsapp_message_id: 'wamid.test',
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('allows only one send under overlapping identical requests', async () => {
    const results = await Promise.allSettled([
      engineSendPayment(args),
      engineSendPayment(args),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(outbox?.status).toBe('sent');
  });
  it('blocks a changed checkout URL under an existing effect key', async () => {
    await engineSendPayment(args);
    await expect(
      engineSendPayment({ ...args, buttonUrl: 'https://pay.example/other' })
    ).rejects.toThrow('input changed');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each(['sending', 'uncertain'])(
    'does not retry an existing %s claim',
    async (status) => {
      mocks.send.mockRejectedValueOnce(new Error('timeout'));
      await expect(engineSendPayment(args)).rejects.toThrow('timeout');
      outbox!.status = status;
      await expect(engineSendPayment(args)).rejects.toThrow('reconcile');
      expect(mocks.send).toHaveBeenCalledTimes(1);
    }
  );
  it('fails closed on a non-unique claim database error', async () => {
    failTable = 'order_message_outbox';
    await expect(engineSendPayment(args)).rejects.toThrow(
      'Payment claim failed'
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['messages', 'contacts', 'conversations', 'whatsapp_config'])(
    'does not send on %s lookup errors',
    async (table) => {
      failTable = table;
      await expect(engineSendPayment(args)).rejects.toThrow();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(outbox?.status).toBe('uncertain');
    }
  );
  it('uses shared-sender window failure without trying phone variants or fallback itself', async () => {
    inbound = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mocks.send.mockRejectedValueOnce(
      new Error('customer service window closed')
    );
    await expect(engineSendPayment(args)).rejects.toThrow('window closed');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ lastCustomerMessageAt: inbound })
    );
    expect(outbox?.status).toBe('uncertain');
  });
  it('keeps the known Meta receipt blocked after message persistence fails', async () => {
    mocks.send.mockImplementationOnce(async () => {
      failTable = 'messages';
      return {
        messageId: 'wamid.known',
        contentType: 'text',
        formattedText: 'Pedido confirmado\nhttps://pay.example/checkout',
      };
    });
    await expect(engineSendPayment(args)).rejects.toThrow(
      'message persistence failed'
    );
    expect(outbox).toMatchObject({
      status: 'uncertain',
      message_id: 'wamid.known',
    });
    failTable = null;
    await expect(engineSendPayment(args)).rejects.toThrow('reconcile');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('delivers using the actual latest customer timestamp and persists the native CTA', async () => {
    expect(await engineSendPayment(args)).toEqual({
      whatsapp_message_id: 'wamid.test',
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        lastCustomerMessageAt: inbound,
        buttonUrl: args.buttonUrl,
      })
    );
    expect(filters).toContainEqual(['messages', 'sender_type', 'customer']);
    expect(filters).toContainEqual(['conversations', 'account_id', 'account']);
    expect(writes).toContainEqual({
      table: 'messages',
      value: expect.objectContaining({
        interactive_payload: { type: 'cta_url' },
        content_type: 'interactive',
      }),
    });
    expect(outbox?.status).toBe('sent');
  });
});
