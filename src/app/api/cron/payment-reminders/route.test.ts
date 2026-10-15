import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OrderFixture {
  id: string;
  account_id: string | null;
  contact_id: string | null;
  payer_phone: string | null;
  payment_url: string;
  payer_name: string;
  total: number;
  reminded_at?: string;
}
const state = vi.hoisted(() => ({
  queries: 0,
  orders: [] as OrderFixture[],
  contacts: [] as { id: string; account_id: string; phone: string | null }[],
  contactError: null as { message: string } | null,
  configError: null as { message: string } | null,
  lookups: [] as { table: string; filters: [string, unknown][] }[],
  decrypt: vi.fn((value: string) => value),
  configs: [] as {
    account_id: string;
    access_token: string;
    phone_number_id: string;
  }[],
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      state.queries++;
      const filters: [string, unknown][] = [];
      state.lookups.push({ table, filters });
      let single = false;
      let limit: number | undefined;
      let update: { reminded_at?: string } | undefined;
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        lte: () => query,
        gte: () => query,
        order: () => query,
        is: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        maybeSingle: () => {
          single = true;
          return query;
        },
        returns: () => query,
        update: (value: { reminded_at?: string }) => {
          update = value;
          return query;
        },
        then(resolve: (result: { data: unknown; error: unknown }) => void) {
          if (update) {
            for (const order of state.orders) {
              if (
                filters.every(
                  ([key, value]) =>
                    key === 'status' ||
                    order[key as keyof OrderFixture] === value
                )
              ) {
                Object.assign(order, update);
              }
            }
          }
          const rows =
            table === 'orders'
              ? state.orders
              : (table === 'contacts' ? state.contacts : state.configs).filter(
                  (row) =>
                    filters.every(
                      ([key, value]) => row[key as keyof typeof row] === value
                    )
                );
          const limited = limit === undefined ? rows : rows.slice(0, limit);
          resolve({
            data: single ? (limited[0] ?? null) : limited,
            error:
              table === 'contacts'
                ? state.contactError
                : table === 'whatsapp_config'
                  ? state.configError
                  : null,
          });
        },
      };
      return query;
    },
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: state.decrypt,
}));
const { GET } = await import('./route');
const fetchMock = vi.fn();
const order = (account: string | null, id = 'order-1'): OrderFixture => ({
  id,
  account_id: account,
  contact_id: `contact-${account}`,
  payer_phone: '5511999999999',
  payment_url: 'https://checkout.example/pay',
  payer_name: 'Cliente',
  total: 8.5,
});
const config = (account: string) => ({
  account_id: account,
  access_token: account,
  phone_number_id: account,
});
const run = (headers: HeadersInit = { 'x-cron-secret': 'test-cron-secret' }) =>
  GET(new Request('http://localhost/api/cron/payment-reminders', { headers }));

describe('payment reminders tenant boundaries', () => {
  beforeEach(() => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'test-cron-secret');
    state.queries = 0;
    state.orders = [order('account-a')];
    state.configs = [config('account-a')];
    state.contacts = ['account-a', 'account-b', 'missing-account'].map(
      (account) => ({
        id: `contact-${account}`,
        account_id: account,
        phone: '5511999999999',
      })
    );
    state.contactError = null;
    state.configError = null;
    state.lookups = [];
    fetchMock
      .mockReset()
      .mockImplementation(async () =>
        Response.json({ messages: [{ id: 'wamid.sent' }] })
      );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('fails closed when the cron secret is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    expect((await run()).status).toBe(503);
    expect(state.queries).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    new Headers(),
    new Headers({ 'x-cron-secret': 'wrong' }),
    new Headers({ 'x-cron-secret': 'wrong-cron-token' }),
  ])(
    'rejects unauthorized execution before database or message effects: %j',
    async (headers) => {
      expect((await run(headers)).status).toBe(401);
      expect(state.queries).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('never sends an order using another account configuration', async () => {
    state.orders = [order('missing-account')];
    const response = await run();
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.orders[0].reminded_at).toBeUndefined();
  });

  it('blocks a forged order linking another account contact before decrypt or send', async () => {
    state.orders[0].contact_id = 'contact-account-b';
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
    expect(state.orders[0].reminded_at).toBeUndefined();
    expect(state.lookups).toContainEqual({
      table: 'contacts',
      filters: [
        ['id', 'contact-account-b'],
        ['account_id', 'account-a'],
      ],
    });
  });

  it.each([
    ['missing link', null, '5511999999999', '5511999999999', false],
    ['missing contact', 'nonexistent', '5511999999999', '5511999999999', false],
    [
      'missing contact phone',
      'contact-account-a',
      null,
      '5511999999999',
      false,
    ],
    [
      'different phone',
      'contact-account-a',
      '5511888888888',
      '5511999999999',
      false,
    ],
    [
      'same suffix, different country',
      'contact-account-a',
      '4411999999999',
      '5511999999999',
      false,
    ],
    ['empty normalized phones', 'contact-account-a', '+ ()', '---', false],
    [
      'contact lookup error with data',
      'contact-account-a',
      '5511999999999',
      '5511999999999',
      true,
    ],
  ])(
    'rejects %s before decrypt or send',
    async (_label, contactId, phone, payer, lookupError) => {
      state.orders[0].contact_id = contactId;
      state.orders[0].payer_phone = payer;
      state.contacts[0].phone = phone;
      if (lookupError) state.contactError = { message: 'lookup failed' };
      const response = await run();
      expect(response.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.decrypt).not.toHaveBeenCalled();
      expect(state.orders[0].reminded_at).toBeUndefined();
    }
  );

  it.each(['5511999999999', '+55 (11) 99999-9999', '+1 (415) 555-1212'])(
    'sends the exact normalized verified recipient %s with the order payment link',
    async (phone) => {
      state.contacts[0].phone = phone;
      state.orders[0].payer_phone = phone.replace(/\D/g, '');
      const response = await run();
      expect((await response.json()).details[0].status).toBe('sent');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toBe(phone.replace(/\D/g, ''));
      expect(body.interactive.action.parameters.url).toBe(
        state.orders[0].payment_url
      );
      expect(state.decrypt).toHaveBeenCalledWith('account-a');
      expect(state.orders[0].reminded_at).toEqual(expect.any(String));
    }
  );

  it.each(['foreign-contact', 'no-url', 'no-contact', 'phone-mismatch'])(
    'does not let a newer invalid %s order suppress a valid reminder',
    async (invalid) => {
      const forged = order('account-a', 'newer-invalid');
      if (invalid === 'foreign-contact')
        forged.contact_id = 'contact-account-b';
      if (invalid === 'no-url') forged.payment_url = '';
      if (invalid === 'no-contact') forged.contact_id = null;
      if (invalid === 'phone-mismatch') {
        state.contacts.push({
          id: 'different-phone',
          account_id: 'account-a',
          phone: '5511888888888',
        });
        forged.contact_id = 'different-phone';
      }
      state.orders = [forged, order('account-a', 'older-valid')];
      const response = await run();
      expect((await response.json()).details).toContainEqual(
        expect.objectContaining({ orderId: 'older-valid', status: 'sent' })
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('deduplicates a shared phone within each account, not across accounts', async () => {
    state.orders = [
      order('account-a'),
      order('account-a', 'older'),
      order('account-b', 'order-2'),
    ];
    state.configs.push(config('account-b'));
    const response = await run();
    expect((await response.json()).processed).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://graph.facebook.com/v21.0/account-a/messages',
      'https://graph.facebook.com/v21.0/account-b/messages',
    ]);
    expect(state.orders.every((entry) => entry.reminded_at)).toBe(true);
  });

  it('looks up the sending account directly even beyond five configured accounts', async () => {
    state.configs = [
      ...Array.from({ length: 6 }, (_, i) => config(`unrelated-${i}`)),
      config('account-a'),
    ];
    const response = await run();
    expect((await response.json()).details[0].status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      state.lookups.filter(({ table }) => table === 'whatsapp_config')
    ).toEqual([
      { table: 'whatsapp_config', filters: [['account_id', 'account-a']] },
    ]);
  });

  it('rejects configuration lookup errors even when data is returned', async () => {
    state.configError = { message: 'configuration lookup failed' };
    const response = await run();
    expect(response.status).toBe(200);
    expect((await response.json()).details[0].status).toBe(
      'skipped_config_error'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
    expect(state.orders[0].reminded_at).toBeUndefined();
  });

  it('skips a missing account config without failing the entire cron', async () => {
    state.configs = [];
    const response = await run();
    expect(response.status).toBe(200);
    expect((await response.json()).details[0].status).toBe(
      'skipped_no_account_config'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
  });

  it('only marks the sending account orders as reminded', async () => {
    state.orders = [order('account-a'), order('account-b', 'order-2')];
    await run();
    expect(state.orders[0].reminded_at).toEqual(expect.any(String));
    expect(state.orders[1].reminded_at).toBeUndefined();
  });

  it('does not send unowned legacy orders', async () => {
    state.orders = [order(null)];
    const response = await run();
    expect((await response.json()).details[0].status).toBe(
      'skipped_no_account_config'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the text fallback when Meta rejects the interactive message', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: 'unsupported' } })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await run();
      expect((await response.json()).details[0]).toEqual(
        expect.objectContaining({ status: 'sent', messageId: 'wamid.sent' })
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).type).toBe('text');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    [new Error('Meta unavailable'), 'Meta unavailable'],
    [{ message: 'structured failure' }, 'structured failure'],
    ['unstructured failure', undefined],
    [null, undefined],
  ])(
    'handles thrown unknown values without another exception (%j)',
    async (thrown, message) => {
      fetchMock.mockRejectedValue(thrown);
      const response = await run();
      const detail = (await response.json()).details[0];
      expect(detail.status).toBe('error');
      expect(detail.error).toBe(message);
      expect(state.orders[0].reminded_at).toBeUndefined();
    }
  );
});
