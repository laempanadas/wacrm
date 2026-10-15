import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  deferred: [] as Array<() => Promise<void>>,
  flow: vi.fn(),
  ai: vi.fn(),
  payment: vi.fn(),
  text: vi.fn(),
  autoDeal: vi.fn(),
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (callback: () => Promise<void>) => mocks.deferred.push(callback),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.db }));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'test-only-token',
  encrypt: () => 'encrypted',
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async () => ({
    id: 'contact',
    name: 'Maria',
    phone: '5511999999999',
  }),
  isUniqueViolation: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getCatalogProductNames: async () => ({}),
  getMediaUrl: vi.fn(),
  sendTextMessage: mocks.text,
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: async () => undefined,
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mocks.flow }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: mocks.ai }));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: async () => undefined,
}));
vi.mock('@/lib/deals/auto-deal-lifecycle', () => ({
  ensureAutoDealForConversation: mocks.autoDeal,
}));
vi.mock('@/lib/orders/create-order-with-mercado-pago', () => ({
  createOrderWithMercadoPago: mocks.payment,
}));
vi.mock('@/lib/orders/create-order', () => ({
  applyContactTag: async () => undefined,
  TAG_HUMANO: 'Precisa de Atendente',
}));
vi.mock('@/lib/orders/custom-fields', () => ({
  getSavedCustomerAddress: async () => null,
  saveContactOrderFields: async () => undefined,
}));

import { POST } from './route';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let oldDraft: Row;
function database() {
  return (table: string) => {
    let operation = 'select';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      const rows = (tables[table] ??= []);
      if (operation === 'insert') {
        if (
          table === 'whatsapp_inbound_receipts' &&
          rows.some(
            (r) =>
              r.account_id === payload.account_id &&
              r.meta_message_id === payload.meta_message_id
          )
        )
          return { data: null, error: { code: '23505' } };
        rows.push(structuredClone(payload));
        return { data: [payload], error: null };
      }
      const matched = rows.filter((row) =>
        filters.every(([key, value]) => row[key] === value)
      );
      if (operation === 'update')
        matched.forEach((row) => Object.assign(row, structuredClone(payload)));
      return {
        data: structuredClone(matched),
        count: matched.length,
        error: null,
      };
    };
    const single = async () => {
      const r = result();
      return { ...r, data: r.data?.[0] ?? null };
    };
    const q = {
      select: () => q,
      limit: () => q,
      order: () => q,
      in: () => q,
      eq: (key: string, value: unknown) => (filters.push([key, value]), q),
      insert: (value: Row) => ((operation = 'insert'), (payload = value), q),
      update: (value: Row) => ((operation = 'update'), (payload = value), q),
      maybeSingle: single,
      single,
      then: (resolve: (r: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return q;
  };
}
async function deliver(id: string, content: Row) {
  const response = await POST(
    new Request('https://test.invalid/api/whatsapp/webhook', {
      method: 'POST',
      body: JSON.stringify({
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    phone_number_id: 'phone',
                    display_phone_number: '5511000000000',
                  },
                  contacts: [
                    { profile: { name: 'Maria' }, wa_id: '5511999999999' },
                  ],
                  messages: [
                    {
                      id,
                      from: '5511999999999',
                      timestamp: '1791856800',
                      ...content,
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    })
  );
  expect(response.status).toBe(200);
  while (mocks.deferred.length) await mocks.deferred.shift()!();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.deferred.length = 0;
  oldDraft = {
    id: 'old-draft',
    version: 2,
    stage: 'payment_created',
    items: [],
    unresolved: [],
    total: 28,
  };
  tables = {
    whatsapp_config: [
      {
        account_id: 'account',
        user_id: 'owner',
        phone_number_id: 'phone',
        access_token: 'encrypted',
      },
    ],
    conversations: [
      {
        id: 'conversation',
        account_id: 'account',
        contact_id: 'contact',
        status: 'open',
        unread_count: 0,
      },
    ],
    order_drafts: [
      {
        account_id: 'account',
        conversation_id: 'conversation',
        state: structuredClone(oldDraft),
      },
    ],
    flow_runs: [],
    messages: [],
    whatsapp_inbound_receipts: [],
    broadcast_recipients: [],
  };
  mocks.db.from.mockImplementation(database());
  mocks.db.rpc.mockImplementation(async () => {
    throw new Error('A catalog reply must not acquire an old text-draft turn');
  });
  mocks.flow.mockImplementation(async (input) => {
    if (input.message.kind === 'catalog_order')
      tables.flow_runs.push({
        id: 'new-catalog-run',
        account_id: 'account',
        conversation_id: 'conversation',
        status: 'active',
        vars: {
          catalog_order_version: 1,
          itens: [
            {
              id: 'emp_hamburguer',
              title: 'Carne',
              quantity: 2,
              unitPrice: 14,
            },
          ],
        },
      });
    return { consumed: true, outcome: 'advanced' };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('No network in webhook routing regressions');
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('real WhatsApp POST and text processor ownership', () => {
  it.each(['button_reply', 'list_reply'])(
    'passes the original Meta prompt id to the engine for %s even without an internal message row',
    async (type) => {
      tables.flow_runs.push({
        account_id: 'account',
        conversation_id: 'conversation',
        status: 'active',
        vars: { catalog_order_version: 1, itens: [] },
      });
      await deliver('confirmation', {
        type: 'interactive',
        context: { id: 'summary-A' },
        interactive: {
          type,
          [type]: { id: 'confirmar_pedido', title: 'Confirmar pedido' },
        },
      });
      expect(mocks.flow).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            kind: 'interactive_reply',
            context_message_id: 'summary-A',
          }),
        })
      );
    }
  );
  it.each([
    { type: 'text', text: { body: 'Delivery' } },
    {
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'delivery', title: 'Delivery' },
      },
    },
  ])(
    'routes the new native cart and its reply once, preserving the completed text draft: $type',
    async (reply) => {
      const cart = {
        type: 'order',
        order: {
          catalog_id: 'catalog',
          product_items: [
            {
              product_retailer_id: 'emp_hamburguer',
              quantity: 2,
              item_price: 14,
              currency: 'BRL',
            },
          ],
        },
      };
      await deliver('new-cart', cart);
      await deliver('new-cart', cart);
      await deliver('new-reply', reply);
      await deliver('new-reply', reply);
      expect(mocks.flow).toHaveBeenCalledTimes(2);
      expect(mocks.flow.mock.calls[0][0].message.kind).toBe('catalog_order');
      expect(mocks.flow.mock.calls[1][0].message).toMatchObject({
        meta_message_id: 'new-reply',
        kind: reply.type === 'interactive' ? 'interactive_reply' : 'text',
      });
      expect(tables.whatsapp_inbound_receipts).toHaveLength(2);
      expect(tables.messages).toHaveLength(2);
      expect(tables.order_drafts[0].state).toEqual(oldDraft);
      expect(tables.flow_runs[0].status).toBe('active');
      expect(mocks.db.rpc).not.toHaveBeenCalled();
      expect(mocks.payment).not.toHaveBeenCalled();
      expect(mocks.text).not.toHaveBeenCalled();
      expect(mocks.ai).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
