import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findActiveConversationDeal,
  findRecentOpenDeal,
  ensureAutoDealForConversation,
} from './auto-deal-lifecycle';

type ActiveDeal = NonNullable<
  Awaited<ReturnType<typeof findActiveConversationDeal>>
>;

interface DealQuery {
  eq(column: string, value: string): DealQuery;
  gte(column: string, value: string): DealQuery;
  order(column: string, options: { ascending: boolean }): DealQuery;
  limit(count: number): DealQuery;
  maybeSingle(): Promise<{ data: ActiveDeal | null; error: null }>;
}

describe('auto-deal-lifecycle', () => {
  describe('findActiveConversationDeal', () => {
    it('should return null when no active deal exists', async () => {
      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn((): DealQuery => ({
            eq: vi.fn(function (this: DealQuery) {
              return this;
            }),
            gte: vi.fn(function (this: DealQuery) {
              return this;
            }),
            order: vi.fn(function (this: DealQuery) {
              return this;
            }),
            limit: vi.fn(function (this: DealQuery) {
              return this;
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      };

      const result = await findActiveConversationDeal(
        mockDb as unknown as SupabaseClient,
        'account-1',
        'contact-1',
        'conv-1'
      );

      expect(result).toBeNull();
    });

    it('should return deal when active deal exists', async () => {
      const mockDeal = { id: 'deal-1', value: 100, stage_id: 'stage-1' };
      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn((): DealQuery => ({
            eq: vi.fn(function (this: DealQuery) {
              return this;
            }),
            gte: vi.fn(function (this: DealQuery) {
              return this;
            }),
            order: vi.fn(function (this: DealQuery) {
              return this;
            }),
            limit: vi.fn(function (this: DealQuery) {
              return this;
            }),
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: mockDeal, error: null }),
          })),
        })),
      };

      const result = await findActiveConversationDeal(
        mockDb as unknown as SupabaseClient,
        'account-1',
        'contact-1',
        'conv-1'
      );

      expect(result).toEqual(mockDeal);
    });
  });

  describe('findRecentOpenDeal', () => {
    it('should return null when no recent deal exists', async () => {
      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn((): DealQuery => ({
            eq: vi.fn(function (this: DealQuery) {
              return this;
            }),
            gte: vi.fn(function (this: DealQuery) {
              return this;
            }),
            order: vi.fn(function (this: DealQuery) {
              return this;
            }),
            limit: vi.fn(function (this: DealQuery) {
              return this;
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
      };

      const result = await findRecentOpenDeal(
        mockDb as unknown as SupabaseClient,
        'account-1',
        'contact-1'
      );

      expect(result).toBeNull();
    });
  });

  describe('ensureAutoDealForConversation', () => {
    it('should reuse existing deal if active deal exists in same conversation', async () => {
      const existingDeal = { id: 'deal-1', value: 50, stage_id: 'stage-1' };

      const mockDb = {
        from: vi.fn(() => ({
          select: vi.fn((): DealQuery => ({
            eq: vi.fn(function (this: DealQuery) {
              return this;
            }),
            gte: vi.fn(function (this: DealQuery) {
              return this;
            }),
            order: vi.fn(function (this: DealQuery) {
              return this;
            }),
            limit: vi.fn(function (this: DealQuery) {
              return this;
            }),
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: existingDeal, error: null }),
          })),
        })),
      };

      const result = await ensureAutoDealForConversation(
        mockDb as unknown as SupabaseClient,
        {
          accountId: 'account-1',
          userId: 'user-1',
          contactId: 'contact-1',
          contactName: 'João',
          conversationId: 'conv-1',
        }
      );

      expect(result.dealId).toBe('deal-1');
      expect(result.isNew).toBe(false);
    });
  });
});
