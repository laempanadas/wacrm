import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  STANDARD_DELIVERY_CUSTOM_FIELDS,
  parseAddressComponents,
  getSavedCustomerAddress,
  saveContactOrderFields,
} from './custom-fields';

describe('STANDARD_DELIVERY_CUSTOM_FIELDS', () => {
  it('contém a lista completa dos 6 campos oficiais', () => {
    expect(STANDARD_DELIVERY_CUSTOM_FIELDS).toEqual([
      'endereco_completo',
      'bairro',
      'cidade',
      'ponto_referencia',
      'forma_pagamento',
      'itens_ultimo_pedido',
    ]);
  });
});

describe('parseAddressComponents', () => {
  it('retorna objeto vazio para endereço indefinido ou vazio', () => {
    expect(parseAddressComponents('')).toEqual({});
    expect(parseAddressComponents(undefined)).toEqual({});
    expect(parseAddressComponents('   ')).toEqual({});
  });

  it('extrai bairro e cidade quando separados por hífen', () => {
    const res = parseAddressComponents(
      'Rua das Flores, 123 - Centro, São Paulo'
    );
    expect(res.endereco_completo).toBe(
      'Rua das Flores, 123 - Centro, São Paulo'
    );
    expect(res.bairro).toBe('Centro');
    expect(res.cidade).toBe('São Paulo');
  });

  it('extrai ponto de referência com "ref:" ou "próximo ao"', () => {
    const res1 = parseAddressComponents(
      'Av Brasil, 500 - Ref: ao lado da padaria'
    );
    expect(res1.ponto_referencia).toBe('ao lado da padaria');

    const res2 = parseAddressComponents('Rua A, 10 - próximo ao mercado');
    expect(res2.ponto_referencia).toBe('mercado');
  });

  it('extrai ponto de referência entre parênteses', () => {
    const res = parseAddressComponents('Rua B, 20 (apto 102)');
    expect(res.ponto_referencia).toBe('apto 102');
  });

  it('extrai bairro explicitado com prefixo "bairro:"', () => {
    const res = parseAddressComponents(
      'Rua Central, 50, Bairro Jardim América'
    );
    expect(res.bairro).toBe('Jardim América');
  });
});

describe('saveContactOrderFields and getSavedCustomerAddress', () => {
  type Row = Record<string, unknown>;

  function fakeDb(tables: Record<string, Row[]>) {
    let seq = 0;
    const from = (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'upsert' = 'select';
      let payload: Row | Row[] = {};
      const rows = () => (tables[table] ??= []);
      const run = (): Row[] => {
        if (op === 'insert') {
          const list = Array.isArray(payload) ? payload : [payload];
          const created = list.map((item) => {
            const row = { id: `${table}-${++seq}`, ...item };
            rows().push(row);
            return row;
          });
          return created;
        }
        if (op === 'upsert') {
          const list = Array.isArray(payload) ? payload : [payload];
          return list.map((item) => {
            const existing = rows().find(
              (r) =>
                r.contact_id === item.contact_id &&
                r.custom_field_id === item.custom_field_id
            );
            if (existing) {
              Object.assign(existing, item);
              return existing;
            }
            const row = { id: `${table}-${++seq}`, ...item };
            rows().push(row);
            return row;
          });
        }
        return rows().filter((r) => filters.every(([k, v]) => r[k] === v));
      };

      const q = {
        select: () => q,
        insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
        upsert: (p: Row | Row[]) => ((op = 'upsert'), (payload = p), q),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        in: (k: string, vs: unknown[]) => {
          filters.push([k, vs]); // simulated
          return q;
        },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => void) =>
          resolve({ data: run(), error: null }),
      };
      return q;
    };
    return { from } as unknown as SupabaseClient;
  }

  it('salva campos customizados padronizados criando definições ausentes', async () => {
    const tables: Record<string, Row[]> = {
      custom_fields: [],
      contact_custom_values: [],
    };
    const db = fakeDb(tables);

    await saveContactOrderFields(db, 'acc-1', 'cont-1', {
      enderecoCompleto: 'Rua das Flores, 123 - Centro, Curitiba',
      formaPagamento: 'Pix',
      itensUltimoPedido: '2x Empanada de Carne',
    });

    expect(tables.custom_fields.length).toBeGreaterThanOrEqual(1);
    expect(tables.contact_custom_values.length).toBeGreaterThanOrEqual(1);
  });
});
