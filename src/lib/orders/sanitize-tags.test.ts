import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeTagsAndCustomFields } from './sanitize-tags';
import { TAG_AGUARDANDO } from './create-order';

describe('sanitizeTagsAndCustomFields', () => {
  type Row = Record<string, unknown>;

  function fakeDb(tables: Record<string, Row[]>) {
    let seq = 0;
    const from = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
      let payload: Row | Row[] = {};
      const rows = () => (tables[table] ??= []);

      const run = (): Row[] => {
        if (op === 'insert') {
          const list = Array.isArray(payload) ? payload : [payload];
          return list.map((item) => {
            const row = { id: `${table}-${++seq}`, ...item };
            rows().push(row);
            return row;
          });
        }
        if (op === 'delete') {
          const toDelete = rows().filter((r) =>
            filters.every(([k, v]) => r[k] === v)
          );
          tables[table] = rows().filter((r) => !toDelete.includes(r));
          return toDelete;
        }
        if (op === 'update') {
          const matched = rows().filter((r) =>
            filters.every(([k, v]) => r[k] === v)
          );
          matched.forEach((r) => Object.assign(r, payload));
          return matched;
        }
        return rows().filter((r) => filters.every(([k, v]) => r[k] === v));
      };

      const q = {
        select: () => q,
        insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
        upsert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
        update: (p: Row) => ((op = 'update'), (payload = p), q),
        delete: () => ((op = 'delete'), q),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        then: (resolve: (r: { data: Row[]; error: null }) => void) =>
          resolve({ data: run(), error: null }),
      };
      return q;
    };
    return { from } as unknown as SupabaseClient;
  }

  it('higieniza tags proibidas e mescla aguardando_pagamento', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [{ id: 'acc-1' }],
      tags: [
        {
          id: 'tag-1',
          account_id: 'acc-1',
          name: 'aguardando_pagamento',
          color: '#000',
        },
        {
          id: 'tag-2',
          account_id: 'acc-1',
          name: 'aguardando_tipo',
          color: '#111',
        },
        { id: 'tag-3', account_id: 'acc-1', name: 'em_preparo', color: '#222' },
        { id: 'tag-4', account_id: 'acc-1', name: 'VIP', color: '#333' },
      ],
      contact_tags: [
        { contact_id: 'cont-1', tag_id: 'tag-1' },
        { contact_id: 'cont-1', tag_id: 'tag-2' },
      ],
      custom_fields: [],
      contact_custom_values: [],
    };

    const db = fakeDb(tables);
    const stats = await sanitizeTagsAndCustomFields(db, 'acc-1');

    // 1 mesclagem de aguardando_pagamento (renomeada para Aguardando Pagamento)
    expect(stats.mergedAguardando).toBe(1);
    // 2 tags proibidas removidas: aguardando_tipo e em_preparo
    expect(stats.removedForbiddenTags).toBe(2);
    // 6 campos customizados padronizados criados
    expect(stats.createdCustomFields).toBe(6);

    const remainingTags = tables.tags.map((t) => t.name);
    expect(remainingTags).toContain(TAG_AGUARDANDO);
    expect(remainingTags).toContain('VIP');
    expect(remainingTags).not.toContain('aguardando_tipo');
    expect(remainingTags).not.toContain('em_preparo');
  });
});
