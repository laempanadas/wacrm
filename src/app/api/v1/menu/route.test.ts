import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/v1/respond';

interface MockMenuItemRow {
  id: string;
  account_id: string;
  name: string;
  price: string | number;
  category: string;
  is_available: boolean;
  description: string | null;
  emoji: string | null;
  created_at: string;
  updated_at: string;
}

let mockRequireApiKey: () => Promise<{
  authType: 'api_key';
  accountId: string;
  keyId: string;
  scopes: string[];
  supabase: {
    from: (table: string) => {
      select: () => {
        eq: () => {
          order: () => {
            order: () => Promise<{ data: MockMenuItemRow[]; error: null }>;
          };
        };
      };
      insert: (items: Record<string, unknown>[]) => {
        select: () => {
          order: () => {
            order: () => Promise<{ data: MockMenuItemRow[]; error: null }>;
          };
        };
      };
    };
  };
}>;

let mockDbRows: MockMenuItemRow[] = [];
let insertCalledWith: Record<string, unknown>[] = [];

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => mockRequireApiKey(),
}));

const { GET } = await import('./route');

describe('GET /api/v1/menu', () => {
  beforeEach(() => {
    mockDbRows = [
      {
        id: 'item-1',
        account_id: 'acc-123',
        name: 'Carne ao molho',
        price: '8.50',
        category: 'Empanadas Clássicas',
        is_available: true,
        description: 'Carne bovina temperada',
        emoji: '🥩',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'item-2',
        account_id: 'acc-123',
        name: 'Camarão com cream cheese',
        price: 10.5,
        category: 'Empanadas Especiais',
        is_available: false,
        description: null,
        emoji: '🦐',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    insertCalledWith = [];

    mockRequireApiKey = async () => ({
      authType: 'api_key',
      accountId: 'acc-123',
      keyId: 'key-1',
      scopes: ['menu:read'],
      supabase: {
        from: (table: string) => {
          expect(table).toBe('menu_items');
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  order: async () => ({
                    data: mockDbRows,
                    error: null,
                  }),
                }),
              }),
            }),
            insert: (items: Record<string, unknown>[]) => {
              insertCalledWith = items;
              return {
                select: () => ({
                  order: () => ({
                    order: async () => ({
                      data: items.map((it, idx) => ({
                        id: `seeded-${idx}`,
                        account_id: 'acc-123',
                        name: String(it.name),
                        price: Number(it.price),
                        category: String(it.category),
                        is_available: Boolean(it.is_available),
                        description: (it.description as string | null) ?? null,
                        emoji: (it.emoji as string | null) ?? null,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      })),
                      error: null,
                    }),
                  }),
                }),
              };
            },
          };
        },
      },
    });
  });

  it('rejects unauthenticated requests (missing/invalid key)', async () => {
    mockRequireApiKey = async () => {
      throw new ApiError('unauthorized', 'Missing or invalid API key', 401);
    };

    const req = new Request('https://crm.laempanadas.com.br/api/v1/menu');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('unauthorized');
  });

  it('returns items with their availability status', async () => {
    const req = new Request('https://crm.laempanadas.com.br/api/v1/menu', {
      headers: { authorization: 'Bearer wacrm_live_testkey123' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(2);

    expect(body.data[0]).toEqual({
      id: 'item-1',
      name: 'Carne ao molho',
      price: 8.5,
      category: 'Empanadas Clássicas',
      is_available: true,
      description: 'Carne bovina temperada',
      emoji: '🥩',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    expect(body.data[1]).toEqual({
      id: 'item-2',
      name: 'Camarão com cream cheese',
      price: 10.5,
      category: 'Empanadas Especiais',
      is_available: false,
      description: null,
      emoji: '🦐',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
  });

  it('auto-seeds default menu items when account has 0 items', async () => {
    mockDbRows = []; // Empty DB

    const req = new Request('https://crm.laempanadas.com.br/api/v1/menu', {
      headers: { authorization: 'Bearer wacrm_live_testkey123' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(insertCalledWith.length).toBeGreaterThan(0);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].is_available).toBe(true);
  });
});
