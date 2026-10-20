import { describe, expect, it } from 'vitest';
import { advanceOrderDraft, type OrderDraft } from './order-draft';

const catalog = [
  { id: 'meat', nome: 'Carne', preco: 14, aliases: ['carne'] },
  {
    id: 'tomato',
    nome: 'Queijo com tomate',
    preco: 15,
    aliases: ['queijo', 'queijo com tomate'],
  },
  {
    id: 'onion',
    nome: 'Queijo com cebola caramelizada',
    preco: 16,
    aliases: ['queijo com cebola caramelizada'],
  },
];
const initial = (): OrderDraft => ({
  id: 'conversation',
  version: 0,
  items: [],
  unresolved: [],
  stage: 'collecting',
  total: 0,
});

describe('draft conversation safety', () => {
  const correction = 'Queijo não é tomate, é o queijo com cebola caramelizada';
  it('replaces only the uniquely identified cheese line, keeping quantity and other lines', () => {
    const first = advanceOrderDraft(
      initial(),
      '2 queijo\n3 carne\nRua Flores, 10 Centro',
      catalog
    ).draft;
    const snapshot = structuredClone(first);
    const result = advanceOrderDraft(first, correction, catalog);
    expect(
      result.draft.items.map(({ id, quantity }) => ({ id, quantity }))
    ).toEqual([
      { id: 'onion', quantity: 2 },
      { id: 'meat', quantity: 3 },
    ]);
    expect(result.draft.items[0].unitPrice).toBe(16);
    expect(result.draft.total).toBe(74);
    expect(result.draft.items[1]).toEqual(first.items[1]);
    expect(result.draft.deliveryAddress).toBe(first.deliveryAddress);
    expect(result.draft.unresolved).toEqual([]);
    expect(result.draft.version).toBeGreaterThan(first.version);
    expect(result.draft.stage).toBe('awaiting_confirmation');
    expect(result.checkout).toBe(false);
    expect(first).toEqual(snapshot);
  });
  it.each([
    'repeated lines',
    'ambiguous destination',
    'ambiguous source',
    'unknown destination',
  ])('preserves the cart for review with %s', (ambiguity) => {
    const first = advanceOrderDraft(
      initial(),
      ambiguity === 'repeated lines'
        ? '2 queijo\n1 queijo\n3 carne'
        : '2 queijo\n3 carne',
      catalog
    ).draft;
    const live =
      ambiguity === 'ambiguous destination'
        ? [...catalog, { ...catalog[2], id: 'onion-other' }]
        : ambiguity === 'ambiguous source'
          ? [...catalog, { ...catalog[1], id: 'tomato-other' }]
          : ambiguity === 'unknown destination'
            ? catalog.slice(0, 2)
            : catalog;
    const result = advanceOrderDraft(first, correction, live);
    expect(result.draft.items).toEqual(first.items);
    expect(result.draft.unresolved.join(' ')).toContain(correction);
    expect(result.draft.stage).toBe('needs_human');
    expect(result.checkout).toBe(false);
  });
  it.each(['Oi', 'Alô ??', 'Olá!', 'Bom dia'])(
    'does not change an empty or populated cart for %s',
    (text) => {
      for (const first of [
        initial(),
        advanceOrderDraft(initial(), '2 carne', catalog).draft,
      ]) {
        const snapshot = structuredClone(first);
        const result = advanceOrderDraft(first, text, catalog);
        expect(result.checkout).toBe(false);
        expect(result.draft).toEqual(snapshot);
        expect(result.draft.stage).not.toBe('needs_human');
        expect(result.reply).toMatch(/olá/i);
        expect(first).toEqual(snapshot);
      }
    }
  );
  it.each([
    'Pix feito',
    'Pode confirmar ?',
    'Já pageui',
    'Vixi está meio confuso',
    'Se Alberto...',
  ])('never interprets %s as checkout or an address', (text) => {
    for (const first of [
      advanceOrderDraft(initial(), '2 carne', catalog).draft,
      advanceOrderDraft(initial(), '2 carne\nRua Flores, 10 Centro', catalog)
        .draft,
    ]) {
      const result = advanceOrderDraft(
        first,
        text,
        catalog,
        'Rua Salva, 20 Centro'
      );
      expect(result.checkout).toBe(false);
      expect(result.draft.items).toEqual(first.items);
      expect(result.draft.deliveryAddress).toBe(first.deliveryAddress);
    }
  });
  it('adds E 5 de carne without replacing earlier quantities', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const result = advanceOrderDraft(first, 'E 5 de carne', catalog);
    expect(result.draft.items[0].quantity).toBe(7);
    expect(result.draft.total).toBe(98);
    expect(result.draft.unresolved).toEqual([]);
    expect(result.checkout).toBe(false);
  });
});
