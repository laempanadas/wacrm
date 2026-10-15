import { describe, expect, it } from 'vitest';
import { groundCatalogOrder } from './catalog-order';
const id = '11111111-1111-4111-8111-111111111111';
const catalog = [
  { id, nome: 'Empanada de Carne', preco: 14.5, aliases: ['carne'] },
];
describe('catalog order grounding', () => {
  it('uses the live account menu price and UUID rather than inbound prices', () => {
    expect(
      groundCatalogOrder(
        [{ retailer_id: id, quantity: 2, unit_price: 0.01 }],
        catalog
      )
    ).toEqual({
      items: [
        {
          id,
          title: 'Empanada de Carne',
          description: 'Empanada de Carne',
          quantity: 2,
          unitPrice: 14.5,
        },
      ],
      total: 29,
    });
  });
  it('resolves a unique exact name or alias without fuzzy matching', () => {
    expect(
      groundCatalogOrder(
        [
          {
            retailer_id: 'old-meta-id',
            name: 'carne',
            quantity: 1,
            unit_price: 8,
          },
        ],
        catalog
      ).items[0].id
    ).toBe(id);
    expect(() =>
      groundCatalogOrder(
        [
          {
            retailer_id: 'old-meta-id',
            name: 'carne sem cebola',
            quantity: 1,
            unit_price: 8,
          },
        ],
        catalog
      )
    ).toThrow();
  });
  it('fails closed for ambiguous names, unmatched UUIDs, notes and invalid quantities', () => {
    const line = {
      retailer_id: 'meta-id',
      name: 'carne',
      quantity: 1,
      unit_price: 8,
    };
    expect(() =>
      groundCatalogOrder([line], [...catalog, { ...catalog[0], id: 'other' }])
    ).toThrow();
    expect(() =>
      groundCatalogOrder(
        [{ ...line, retailer_id: '22222222-2222-4222-8222-222222222222' }],
        catalog
      )
    ).toThrow();
    expect(() =>
      groundCatalogOrder([{ ...line, retailer_id: id }], catalog, 'sem cebola')
    ).toThrow();
    for (const quantity of [0, -1, 1.5, NaN])
      expect(() =>
        groundCatalogOrder([{ ...line, retailer_id: id, quantity }], catalog)
      ).toThrow();
  });
});
