import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSavedCustomerAddress } from './custom-fields';

type Row = Record<string, unknown>;

function addressDb(
  tables: Record<string, Row[]> = {},
  errors: Record<string, unknown> = {}
) {
  const from = vi.fn((table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let count = Infinity;
    let sortKey: string | undefined;
    const result = (single = false) => {
      let rows = (tables[table] ?? []).filter((row) =>
        filters.every((filter) => filter(row))
      );
      if (sortKey) {
        const key = sortKey;
        rows = [...rows].sort((a, b) =>
          String(b[key]).localeCompare(String(a[key]))
        );
      }
      rows = rows.slice(0, count);
      return {
        data: single ? (rows[0] ?? null) : rows,
        error: errors[table] ?? null,
      };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      not: (key: string, _operator: string, value: unknown) => {
        filters.push((row) => row[key] !== value);
        return query;
      },
      neq: (key: string, value: unknown) => {
        filters.push((row) => row[key] !== value);
        return query;
      },
      order: (key: string) => {
        sortKey = key;
        return query;
      },
      limit: (value: number) => {
        count = value;
        return query;
      },
      maybeSingle: async () => result(true),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return query;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}

const contact = { id: 'contact-1', account_id: 'account-1' };
const order = {
  contact_id: contact.id,
  account_id: contact.account_id,
  delivery_address: 'Rua dos Pedidos, 123',
  created_at: '2026-01-01',
};
const deal = {
  contact_id: contact.id,
  account_id: contact.account_id,
  notes: 'Endereço: Rua dos Negócios, 456',
  created_at: '2026-01-01',
};

describe('saved address tenant contract', () => {
  it.each([
    'contacts',
    'custom_fields',
    'contact_custom_values',
    'orders',
    'deals',
  ])('does not continue after an empty %s error response', async (table) => {
    const tables: Record<string, Row[]> = {
      contacts: [contact],
      custom_fields:
        table === 'contact_custom_values'
          ? [
              {
                id: 'field-1',
                account_id: contact.account_id,
                field_name: 'endereco_completo',
              },
            ]
          : [],
      orders: table === 'deals' ? [] : [order],
      deals: [deal],
    };
    tables[table] = [];
    const { db, from } = addressDb(tables, {
      [table]: { message: 'query failed' },
    });

    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBeNull();
    expect(from.mock.calls.at(-1)?.[0]).toBe(table);
  });

  it.each([
    { contacts: [] },
    { contacts: [{ ...contact, id: 'other-contact' }] },
  ])(
    'rejects a missing contact without address reads (%j)',
    async ({ contacts }) => {
      const { db, from } = addressDb({ contacts, orders: [order] });
      expect(
        await getSavedCustomerAddress(db, contact.account_id, contact.id)
      ).toBeNull();
      expect(from.mock.calls.map(([table]) => table)).toEqual(['contacts']);
    }
  );

  it('prefers a trimmed custom value over orders and deals within the account', async () => {
    const { db, from } = addressDb({
      contacts: [contact],
      custom_fields: [
        {
          id: 'foreign-field',
          account_id: 'foreign-account',
          field_name: 'endereco_completo',
        },
        {
          id: 'field-1',
          account_id: contact.account_id,
          field_name: 'Endereco_entrega',
        },
      ],
      contact_custom_values: [
        {
          contact_id: contact.id,
          custom_field_id: 'foreign-field',
          value: 'Foreign address',
        },
        {
          contact_id: 'other-contact',
          custom_field_id: 'field-1',
          value: 'Other address',
        },
        {
          contact_id: contact.id,
          custom_field_id: 'field-1',
          value: '  Rua Customizada, 789  ',
        },
      ],
      orders: [order],
      deals: [deal],
    });
    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBe('Rua Customizada, 789');
    expect(from.mock.calls.map(([table]) => table)).toEqual([
      'contacts',
      'custom_fields',
      'contact_custom_values',
    ]);
  });

  it('uses the latest account order after an empty custom-value query', async () => {
    const { db } = addressDb({
      contacts: [contact],
      custom_fields: [
        {
          id: 'field-1',
          account_id: contact.account_id,
          field_name: 'endereco_completo',
        },
      ],
      orders: [
        order,
        {
          ...order,
          delivery_address: '  Rua Mais Recente, 321  ',
          created_at: '2026-02-01',
        },
      ],
      deals: [deal],
    });
    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBe('Rua Mais Recente, 321');
  });

  it('skips unusable deal notes while preserving the three-most-recent limit', async () => {
    const { db } = addressDb({
      contacts: [contact],
      deals: [
        {
          ...deal,
          created_at: '2026-04-01',
          notes: 'Endereço: (não informado)',
        },
        { ...deal, created_at: '2026-03-01', notes: 'Endereço: curto' },
        { ...deal, created_at: '2026-02-01', notes: 'Pagamento: Pix' },
        deal,
      ],
    });
    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBeNull();
  });

  it.each([
    ['contacts', ['contacts']],
    ['custom_fields', ['contacts', 'custom_fields']],
    [
      'contact_custom_values',
      ['contacts', 'custom_fields', 'contact_custom_values'],
    ],
    ['orders', ['contacts', 'custom_fields', 'orders']],
    ['deals', ['contacts', 'custom_fields', 'orders', 'deals']],
  ] as const)(
    'fails closed on a returned %s error, even with usable data',
    async (table, expectedReads) => {
      const { db, from } = addressDb(
        {
          contacts: [contact],
          custom_fields:
            table === 'contact_custom_values' || table === 'custom_fields'
              ? [
                  {
                    id: 'field-1',
                    account_id: contact.account_id,
                    field_name: 'endereco_completo',
                  },
                ]
              : [],
          contact_custom_values: [
            {
              contact_id: contact.id,
              custom_field_id: 'field-1',
              value: 'Rua Customizada, 789',
            },
          ],
          orders: table === 'deals' ? [] : [order],
          deals: [deal],
        },
        { [table]: { message: 'database unavailable' } }
      );

      expect(
        await getSavedCustomerAddress(db, contact.account_id, contact.id)
      ).toBeNull();
      expect(from.mock.calls.map(([name]) => name)).toEqual(expectedReads);
    }
  );

  it('ignores a foreign-account deal linked to a valid contact', async () => {
    const { db } = addressDb({
      contacts: [contact],
      deals: [{ ...deal, account_id: 'foreign-account' }],
    });

    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBeNull();
  });

  it('ignores a foreign-account order linked to a valid contact', async () => {
    const { db } = addressDb({
      contacts: [contact],
      orders: [{ ...order, account_id: 'foreign-account' }],
      deals: [deal],
    });

    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBe('Rua dos Negócios, 456');
  });

  it('rejects a foreign-account contact before reading address sources', async () => {
    const { db, from } = addressDb({
      contacts: [{ ...contact, account_id: 'foreign-account' }],
      orders: [order],
    });

    expect(
      await getSavedCustomerAddress(db, contact.account_id, contact.id)
    ).toBeNull();
    expect(from.mock.calls.map(([table]) => table)).toEqual(['contacts']);
  });
});
