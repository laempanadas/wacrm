import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EMPANADA_IMAGE } from '@/lib/cardapio/menu';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  single: vi.fn(),
  eq: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.account,
  toErrorResponse: () =>
    Response.json({ error: 'Internal server error' }, { status: 500 }),
}));
const { POST } = await import('./route');
const { PATCH, DELETE } = await import('./[id]/route');
const request = (method: string, body: unknown) =>
  new Request('http://localhost/api/menu/item-1', {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
const params = { params: Promise.resolve({ id: 'item-1' }) };

describe('internal menu writes', () => {
  beforeEach(() => {
    const query = {
      select: () => query,
      single: mocks.single,
      eq: mocks.eq,
      insert: mocks.insert,
      update: mocks.update,
      delete: mocks.remove,
    };
    mocks.eq.mockReturnValue(query);
    mocks.insert.mockReturnValue(query);
    mocks.update.mockReturnValue(query);
    mocks.remove.mockReturnValue(query);
    mocks.account.mockResolvedValue({
      accountId: 'account-a',
      supabase: { from: () => query },
    });
    mocks.single.mockResolvedValue({
      data: {
        id: 'item-1',
        account_id: 'account-a',
        name: 'Carne',
        category: 'Salgadas',
        price: '8.50',
        is_available: true,
        image_url: null,
      },
      error: null,
    });
  });

  it('creates and normalizes a persisted item without dropping database fields', async () => {
    const response = await POST(
      request('POST', {
        name: ' Carne ',
        price: '8,50',
        category: ' Salgadas ',
      })
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      item: {
        id: 'item-1',
        account_id: 'account-a',
        name: 'Carne',
        category: 'Salgadas',
        price: 8.5,
        is_available: true,
        image_url: DEFAULT_EMPANADA_IMAGE,
      },
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'account-a', price: 8.5 })
    );
  });

  it('preserves the create fallback when the database rejects the insert', async () => {
    mocks.single.mockResolvedValue({
      data: null,
      error: { message: 'unavailable' },
    });
    const response = await POST(
      request('POST', { name: 'Carne', price: 8.5, category: 'Salgadas' })
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      item: {
        id: expect.stringMatching(/^mock-created-/),
        name: 'Carne',
        price: 8.5,
        category: 'Salgadas',
        description: null,
        image_url: DEFAULT_EMPANADA_IMAGE,
        is_available: true,
      },
    });
  });

  it('updates only the current account and normalizes persisted fields', async () => {
    const response = await PATCH(request('PATCH', { price: '8,50' }), params);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ price: 8.5 });
    expect(mocks.eq.mock.calls).toEqual([
      ['id', 'item-1'],
      ['account_id', 'account-a'],
    ]);
    expect((await response.json()).item).toEqual(
      expect.objectContaining({
        price: 8.5,
        image_url: DEFAULT_EMPANADA_IMAGE,
        account_id: 'account-a',
      })
    );
  });

  it('preserves partial-update fallback defaults', async () => {
    mocks.single.mockResolvedValue({
      data: null,
      error: { message: 'unavailable' },
    });
    const response = await PATCH(
      request('PATCH', { is_available: false }),
      params
    );
    expect(await response.json()).toEqual({
      item: {
        id: 'item-1',
        name: 'Item Atualizado',
        category: 'Empanadas Salgadas',
        price: 8.5,
        is_available: false,
        image_url: DEFAULT_EMPANADA_IMAGE,
      },
    });
  });

  it('rejects invalid prices without calling the database', async () => {
    const response = await PATCH(request('PATCH', { price: -1 }), params);
    expect(response.status).toBe(400);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it('deletes only within the current account', async () => {
    const response = await DELETE(request('DELETE', null), params);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.eq.mock.calls).toEqual([
      ['id', 'item-1'],
      ['account_id', 'account-a'],
    ]);
  });
});
