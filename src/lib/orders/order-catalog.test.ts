import { describe, expect, it } from 'vitest';
import { catalogEntries } from './order-catalog';
import { parseCatalogOrder } from './text-order-parser';

describe('account catalog grounding', () => {
  it('preserves the reported 5/2/2 order using only account catalog prices', () => {
    const catalog = catalogEntries([
      {
        id: 'ham',
        name: 'Empanada de Presunto e Queijo',
        price: 11,
        is_available: true,
      },
      {
        id: 'tuna',
        name: 'Empanada de Atum com Queijo',
        price: 13,
        is_available: true,
      },
      {
        id: 'caprese',
        name: 'Empanada de Queijo, Tomate, Manjericão e Orégano',
        price: 17.25,
        is_available: true,
      },
    ]);
    const parsed = parseCatalogOrder(
      '5 presunto e queijo, 2 atum, 2 queijo tomate e manjericão',
      catalog
    );
    expect(parsed.items.map(({ id, quantity }) => ({ id, quantity }))).toEqual([
      { id: 'ham', quantity: 5 },
      { id: 'tuna', quantity: 2 },
      { id: 'caprese', quantity: 2 },
    ]);
    expect(parsed.total).toBe(5 * 11 + 2 * 13 + 2 * 17.25);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.requiresKitchenReview).toBe(false);
  });
  it('uses live prices and refuses ambiguous shorthand and unavailable items', () => {
    const rows = [
      {
        id: 'a',
        name: 'Empanada de Carne com Ovos',
        price: 17.9,
        is_available: true,
      },
      { id: 'b', name: 'Carne ao molho', price: 9, is_available: true },
      { id: 'c', name: 'Calabresa', price: 10, is_available: false },
    ];
    const catalog = catalogEntries(rows);
    expect(parseCatalogOrder('2 carne', catalog).unresolved).toEqual([
      '2 carne',
    ]);
    expect(parseCatalogOrder('2 carne com ovos', catalog).total).toBe(35.8);
    expect(parseCatalogOrder('1 calabresa', catalog).hasItems).toBe(false);
    expect(parseCatalogOrder('1 escarola', catalog).hasItems).toBe(false);
  });
});
