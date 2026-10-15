import { describe, expect, it } from 'vitest';
import { catalogEntries } from './order-catalog';
import { parseCatalogOrder } from './text-order-parser';

describe('account catalog grounding', () => {
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
