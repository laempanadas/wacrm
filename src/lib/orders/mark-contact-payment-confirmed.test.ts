import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TAG_AGUARDANDO,
  TAG_CONFIRMADO,
  markContactPaymentConfirmed,
} from './create-order';

type Row = Record<string, unknown>;

// In-memory stand-in for the tag queries (select/insert/upsert/delete).
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: Row = {};
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
    const run = () => {
      const rows = (tables[table] ??= []);
      if (op === 'insert') {
        const row = { id: `tag-${rows.length + 1}`, ...payload };
        rows.push(row);
        return [row];
      }
      if (op === 'upsert') {
        if (
          !rows.some(
            (r) =>
              r.contact_id === payload.contact_id && r.tag_id === payload.tag_id
          )
        ) {
          rows.push(payload);
        }
        return [payload];
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !matches(r));
        return [];
      }
      return rows.filter(matches);
    };
    const q = {
      select: () => q,
      insert: (p: Row) => ((op = 'insert'), (payload = p), q),
      upsert: (p: Row) => ((op = 'upsert'), (payload = p), q),
      delete: () => ((op = 'delete'), q),
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (r: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const ctx = { accountId: 'acc', userId: 'user' };
const tagNames = (tables: Record<string, Row[]>, contactId: string) =>
  tables.contact_tags
    .filter((ct) => ct.contact_id === contactId)
    .map((ct) => tables.tags.find((t) => t.id === ct.tag_id)?.name);

describe('markContactPaymentConfirmed', () => {
  it('swaps Aguardando Pagamento for Confirmado', async () => {
    const tables: Record<string, Row[]> = {
      tags: [{ id: 'wait', account_id: 'acc', name: TAG_AGUARDANDO }],
      contact_tags: [{ contact_id: 'c1', tag_id: 'wait' }],
    };
    await markContactPaymentConfirmed(fakeDb(tables), ctx, 'c1');

    expect(tagNames(tables, 'c1')).toEqual([TAG_CONFIRMADO]);
    expect(tables.tags.find((t) => t.name === TAG_CONFIRMADO)).toMatchObject({
      account_id: 'acc',
      user_id: 'user',
    });
  });

  it('reuses an existing Confirmado tag and is idempotent', async () => {
    const tables: Record<string, Row[]> = {
      tags: [{ id: 'ok', account_id: 'acc', name: TAG_CONFIRMADO }],
      contact_tags: [{ contact_id: 'c1', tag_id: 'ok' }],
    };
    await markContactPaymentConfirmed(fakeDb(tables), ctx, 'c1');
    await markContactPaymentConfirmed(fakeDb(tables), ctx, 'c1');

    expect(tables.tags).toHaveLength(1);
    expect(tagNames(tables, 'c1')).toEqual([TAG_CONFIRMADO]);
  });

  it("leaves other contacts' tags alone", async () => {
    const tables: Record<string, Row[]> = {
      tags: [{ id: 'wait', account_id: 'acc', name: TAG_AGUARDANDO }],
      contact_tags: [
        { contact_id: 'c1', tag_id: 'wait' },
        { contact_id: 'c2', tag_id: 'wait' },
      ],
    };
    await markContactPaymentConfirmed(fakeDb(tables), ctx, 'c1');

    expect(tagNames(tables, 'c2')).toEqual([TAG_AGUARDANDO]);
  });
});
