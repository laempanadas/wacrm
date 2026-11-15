import { describe, it, expect, vi } from 'vitest';
import { findOrCreateConversationForContact } from './find-or-create';

// Minimal PostgREST-like fake: maybeSingle/single reject when more than one
// row matches, exactly like the real API. `order`/`limit` are honoured.
interface Row {
  id: string;
  account_id: string;
  contact_id: string;
  created_at: string;
}

function makeDb(opts: {
  rows?: Row[];
  findError?: { message: string } | null;
  insertError?: { code: string; message: string } | null;
  /** Rows that appear just before the insert (simulates a concurrent insert). */
  raceRowOnInsert?: Row;
}) {
  const rows = [...(opts.rows ?? [])];
  const inserts: unknown[] = [];
  let insertCount = 0;

  const db = {
    rows,
    inserts,
    from(table: string) {
      if (table !== 'conversations') throw new Error(`unexpected ${table}`);
      return {
        select() {
          const filters: Record<string, string> = {};
          let orderAsc = false;
          let limitTo: number | null = null;
          const q = {
            eq(key: string, value: string) {
              filters[key] = value;
              return q;
            },
            order(_key: string, opts2: { ascending: boolean }) {
              orderAsc = opts2.ascending;
              return q;
            },
            limit(n: number) {
              limitTo = n;
              return q;
            },
            async maybeSingle() {
              if (opts.findError) return { data: null, error: opts.findError };
              let matched = rows.filter(
                (r) =>
                  r.account_id === filters.account_id &&
                  r.contact_id === filters.contact_id
              );
              matched = matched.sort((a, b) =>
                orderAsc
                  ? a.created_at.localeCompare(b.created_at)
                  : b.created_at.localeCompare(a.created_at)
              );
              if (limitTo !== null) matched = matched.slice(0, limitTo);
              if (matched.length > 1) {
                return {
                  data: null,
                  error: { code: 'PGRST116', message: 'multiple rows' },
                };
              }
              return { data: matched[0] ?? null, error: null };
            },
          };
          return q;
        },
        insert(values: Record<string, string>) {
          inserts.push(values);
          insertCount += 1;
          return {
            select() {
              return {
                async single() {
                  if (opts.raceRowOnInsert) rows.push(opts.raceRowOnInsert);
                  if (opts.insertError) {
                    return { data: null, error: opts.insertError };
                  }
                  const row: Row = {
                    id: `new-${insertCount}`,
                    account_id: values.account_id,
                    contact_id: values.contact_id,
                    created_at: new Date().toISOString(),
                  };
                  rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return db;
}

const ACCOUNT = 'acc-1';
const CONTACT = 'contact-1';
const OWNER = 'owner-1';

describe('findOrCreateConversationForContact', () => {
  it('reuses the oldest conversation when duplicates already exist (no new row)', async () => {
    const db = makeDb({
      rows: [
        { id: 'newer', account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-01-02T00:00:00Z' },
        { id: 'oldest', account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-01-01T00:00:00Z' },
      ],
    });

    const result = await findOrCreateConversationForContact(
      db as never,
      ACCOUNT,
      OWNER,
      CONTACT
    );

    expect(result?.conversation.id).toBe('oldest');
    expect(result?.created).toBe(false);
    expect(db.inserts).toHaveLength(0);
  });

  it('creates a conversation when none exists', async () => {
    const db = makeDb({ rows: [] });

    const result = await findOrCreateConversationForContact(
      db as never,
      ACCOUNT,
      OWNER,
      CONTACT
    );

    expect(result?.created).toBe(true);
    expect(db.inserts).toEqual([
      { account_id: ACCOUNT, user_id: OWNER, contact_id: CONTACT },
    ]);
  });

  it('re-reads the winner when a concurrent insert wins the unique race', async () => {
    const winner: Row = {
      id: 'winner',
      account_id: ACCOUNT,
      contact_id: CONTACT,
      created_at: '2026-01-01T00:00:00Z',
    };
    const db = makeDb({
      rows: [],
      raceRowOnInsert: winner,
      insertError: { code: '23505', message: 'duplicate key' },
    });

    const result = await findOrCreateConversationForContact(
      db as never,
      ACCOUNT,
      OWNER,
      CONTACT
    );

    expect(result?.conversation.id).toBe('winner');
    expect(result?.created).toBe(false);
  });

  it('returns null (and does not insert) when the lookup fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ findError: { message: 'boom' } });

    const result = await findOrCreateConversationForContact(
      db as never,
      ACCOUNT,
      OWNER,
      CONTACT
    );

    expect(result).toBeNull();
    expect(db.inserts).toHaveLength(0);
    spy.mockRestore();
  });
});
