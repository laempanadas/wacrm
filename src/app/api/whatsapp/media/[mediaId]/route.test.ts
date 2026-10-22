import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';

let authenticated = true;
let profile: { account_id: string } | null;
let config: {
  access_token: string;
  account_id: string;
  user_id: string;
  phone_number_id?: string;
} | null;
let mediaAccount = 'account-a';
let mediaVisible = true;
const queries: Array<{
  table: string;
  select: string;
  filters: Record<string, unknown>;
}> = [];
const fetchMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: authenticated ? { id: 'teammate' } : null },
        error: null,
      }),
    },
    from: (table: string) => {
      const query = {
        table,
        select: '',
        filters: {} as Record<string, unknown>,
      };
      queries.push(query);
      const result = () => {
        if (table === 'profiles') return { data: profile, error: null };
        if (table === 'whatsapp_config')
          return {
            data:
              query.filters.account_id === config?.account_id ? config : null,
            error: null,
          };
        if (table === 'messages')
          return {
            data:
              mediaVisible &&
              query.filters.media_url === '/api/whatsapp/media/12345' &&
              query.filters['conversations.account_id'] === mediaAccount &&
              query.select.includes('conversations!inner')
                ? { id: 'message-a' }
                : null,
            error: null,
          };
        throw new Error('Unexpected table');
      };
      const builder = {
        select: (value: string) => {
          query.select = value;
          return builder;
        },
        eq: (key: string, value: unknown) => {
          query.filters[key] = value;
          return builder;
        },
        limit: () => builder,
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      return builder;
    },
  }),
}));
import { GET } from './route';
const call = (mediaId = '12345') =>
  GET(new Request('https://crm.test/api/whatsapp/media/' + mediaId), {
    params: Promise.resolve({ mediaId }),
  });

beforeEach(() => {
  authenticated = true;
  profile = { account_id: 'account-a' };
  config = {
    access_token: encrypt('dummy-meta-token'),
    account_id: 'account-a',
    user_id: 'owner-not-teammate',
    phone_number_id: '98765',
  };
  mediaAccount = 'account-a';
  mediaVisible = true;
  queries.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValueOnce(
    Response.json({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/test',
      mime_type: 'image/jpeg',
    })
  );
  fetchMock.mockResolvedValueOnce(
    new Response(new Uint8Array([255, 216, 255, 0]), {
      headers: { 'content-type': 'image/jpeg' },
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['image/jpeg', 'image/jpeg'],
  ['image/png', 'image/png'],
  ['application/octet-stream', 'image/jpeg'],
  ['', 'image/jpeg'],
])(
  'streams %s with correct MIME and private security headers',
  async (upstreamMime, expectedMime) => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        url: 'https://lookaside.fbsbx.com/test',
        mime_type: 'image/jpeg',
      })
    );
    const bytes = new Uint8Array([255, 216, 0, 255]);
    const upstream = new Response(bytes, {
      headers: upstreamMime ? { 'content-type': upstreamMime } : {},
    });
    const bufferSpy = vi.spyOn(upstream, 'arrayBuffer');
    fetchMock.mockResolvedValueOnce(upstream);
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(expectedMime);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(bufferSpy).not.toHaveBeenCalled();
    expect(queries.find((q) => q.table === 'profiles')?.filters).toEqual({
      user_id: 'teammate',
    });
    expect(queries.find((q) => q.table === 'whatsapp_config')?.filters).toEqual(
      { account_id: 'account-a' }
    );
  }
);

it('returns 401 without reading tenant data for unauthenticated callers', async () => {
  authenticated = false;
  expect((await call()).status).toBe(401);
  expect(queries).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('returns 403 for a missing account profile', async () => {
  profile = null;
  expect((await call()).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('denies a message from another tenant even when its ID is known', async () => {
  mediaAccount = 'account-b';
  expect((await call()).status).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('returns actionable 409 when the account has no WhatsApp config', async () => {
  config = null;
  expect((await call()).status).toBe(409);
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['plaintext-not-supported', 'bad:bad:bad'])(
  'returns safe 422 for undecryptable credentials (%s)',
  async (ciphertext) => {
    config!.access_token = ciphertext;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await call();
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain(ciphertext);
      expect(log).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  }
);
it('rejects an empty decrypted token before making requests', async () => {
  config!.access_token = encrypt('');
  expect((await call()).status).toBe(422);
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['../config', '123?access_token=bad', '', 'abc', '123%2f456'])(
  'rejects invalid media identifiers %s',
  async (id) => {
    expect((await call(id)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it.each([
  ['metadata', 404, undefined, 404],
  ['metadata', 400, 100, 404],
  ['metadata', 410, undefined, 410],
  ['metadata', 400, 190, 424],
  ['metadata', 401, undefined, 424],
  ['metadata', 403, undefined, 424],
  ['metadata', 429, undefined, 503],
  ['metadata', 500, undefined, 502],
  ['download', 404, undefined, 410],
  ['download', 410, undefined, 410],
  ['download', 403, undefined, 410],
  ['download', 401, undefined, 424],
  ['download', 503, undefined, 502],
] as const)(
  'maps %s HTTP %i code %s to useful safe %i',
  async (stage, httpStatus, code, expected) => {
    fetchMock.mockReset();
    if (stage === 'download')
      fetchMock.mockResolvedValueOnce(
        Response.json({
          url: 'https://lookaside.fbsbx.com/test',
          mime_type: 'image/jpeg',
        })
      );
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code, message: 'UPSTREAM_SECRET_BODY dummy-meta-token' } },
        { status: httpStatus }
      )
    );
    if (stage === 'download' && httpStatus === 404) {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          url: 'https://lookaside.fbsbx.com/refreshed',
          mime_type: 'image/jpeg',
        })
      );
      fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await call();
      expect(response.status).toBe(expected);
      const text = await response.text();
      expect(text).not.toContain('UPSTREAM_SECRET_BODY');
      expect(text).not.toContain('dummy-meta-token');
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  }
);
it('sanitizes upstream network exceptions', async () => {
  fetchMock
    .mockReset()
    .mockRejectedValue(new Error('UPSTREAM_SECRET_BODY dummy-meta-token'));
  const response = await call();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('UPSTREAM_SECRET_BODY');
});
it('maps timeout failures to 504', async () => {
  fetchMock
    .mockReset()
    .mockRejectedValue(new DOMException('secret URL', 'TimeoutError'));
  expect((await call()).status).toBe(504);
});

it.each([401, 403, 404, 409, 422, 424, 502])(
  'marks HTTP %i error responses private/no-store with nosniff',
  async (status) => {
    if (status === 401) authenticated = false;
    if (status === 403) profile = null;
    if (status === 404) mediaVisible = false;
    if (status === 409) config = null;
    if (status === 422) config!.access_token = 'not-encrypted';
    if (status === 424 || status === 502) {
      fetchMock
        .mockReset()
        .mockResolvedValueOnce(
          Response.json({}, { status: status === 424 ? 401 : 500 })
        );
    }
    const response = await call();
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }
);

it('refreshes the signed URL exactly once after download 404 and streams the second result', async () => {
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({
        url: 'https://lookaside.fbsbx.com/old',
        mime_type: 'image/jpeg',
      })
    )
    .mockResolvedValueOnce(Response.json({}, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({
        url: 'https://lookaside.fbsbx.com/fresh',
        mime_type: 'image/png',
      })
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71])
  );
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    '/v21.0/12345',
    '/old',
    '/v21.0/12345',
    '/fresh',
  ]);
  for (const index of [0, 2])
    expect(
      new URL(fetchMock.mock.calls[index][0]).searchParams.get(
        'phone_number_id'
      )
    ).toBe('98765');
});
it('stops after one refresh when the download is still unavailable', async () => {
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({ url: 'https://lookaside.fbsbx.com/old' })
    )
    .mockResolvedValueOnce(Response.json({}, { status: 404 }))
    .mockResolvedValueOnce(
      Response.json({ url: 'https://lookaside.fbsbx.com/fresh' })
    )
    .mockResolvedValueOnce(Response.json({}, { status: 404 }));
  expect((await call()).status).toBe(410);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
it.each([401, 403, 410, 429, 500])(
  'does not retry download status %i',
  async (status) => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ url: 'https://lookaside.fbsbx.com/test' })
      )
      .mockResolvedValueOnce(Response.json({}, { status }));
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }
);
it('does not retry a metadata 404', async () => {
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(Response.json({}, { status: 404 }));
  expect((await call()).status).toBe(404);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('scopes metadata resolution to the authenticated account phone number', async () => {
  const response = await call();
  expect(response.status).toBe(200);
  const metadataUrl = new URL(fetchMock.mock.calls[0][0]);
  expect(metadataUrl.searchParams.get('phone_number_id')).toBe('98765');
  expect(queries.find((q) => q.table === 'whatsapp_config')?.select).toContain(
    'phone_number_id'
  );
  await response.body!.cancel();
});
it('rejects missing phone configuration without falling back to another number', async () => {
  delete config!.phone_number_id;
  expect((await call()).status).toBe(409);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('denies arbitrary media IDs not linked to a visible message before contacting Meta', async () => {
  mediaVisible = false;
  const response = await call();
  expect(response.status).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});
