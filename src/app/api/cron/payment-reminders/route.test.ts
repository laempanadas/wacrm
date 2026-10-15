import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OrderFixture {
  id: string;
  account_id: string | null;
  payer_phone: string | null;
  payment_url: string;
  payer_name: string;
  total: number;
  reminded_at?: string;
}
const state = vi.hoisted(() => ({
  queries: 0,
  orders: [] as OrderFixture[],
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
        limit: () => query,
        returns: () => query,
        update: (value: { reminded_at?: string }) => {
          update = value;
          return query;
        },
        then(resolve: (result: { data: unknown; error: null }) => void) {
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
          resolve({
            data: table === 'orders' ? state.orders : state.configs,
            error: null,
          });
        },
      };
      return query;
    },
  }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => value,
}));
const { GET } = await import('./route');
const fetchMock = vi.fn();
const order = (account: string | null, id = 'order-1'): OrderFixture => ({
  id,
  account_id: account,
  payer_phone: '11999999999',
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
