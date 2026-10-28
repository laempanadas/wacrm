import { describe, expect, it } from 'vitest';
import {
  aliasesForCatalogName,
  parseCatalogOrder,
  parseTextOrder,
} from './text-order-parser';
import { catalogEntries } from './order-catalog';
import { hasValidatedQuantifiedOrderIntent } from './order-intent';
import cardapio from '../../../assets/js/cardapio.json';

const chicken = {
  id: 'tenant-chicken-uuid',
  nome: 'Empanada de Frango com Espinafre e Cheddar',
  preco: 19.75,
  aliases: ['frango'],
};

describe('affirmative quantified routing intent', () => {
  const catalog = catalogEntries([
    { id: 'tenant-meat', name: 'Carne', price: 19, is_available: true },
  ]);

  it.each([
    'não quero 2 carne',
    'não gostaria de pedir 2 carne',
    'quanto custa 2 carne?',
    'por favor não quero 2 carne',
    'texto desconhecido 2 carne',
    'quero 2 carne e 1 lagosta',
  ])(
    'retains review for negation, questions and unresolved requests: %s',
    (text) => {
      expect(hasValidatedQuantifiedOrderIntent(text, catalog)).toBe(false);
      expect(
        parseCatalogOrder(text, catalog).unresolved?.length
      ).toBeGreaterThan(0);
    }
  );

  it.each([
    'quero pedir 2 carne',
    'gostaria de pedir 2 carne',
    'por favor 2 carne',
  ])(
    'recognizes affirmative framing without creating a checkout pendency: %s',
    (text) => {
      expect(hasValidatedQuantifiedOrderIntent(text, catalog)).toBe(true);
      const parsed = parseCatalogOrder(text, catalog);
      expect(parsed.unresolved).toEqual([]);
      expect(parsed.items).toEqual([
        expect.objectContaining({
          id: 'tenant-meat',
          quantity: 2,
          unitPrice: 19,
        }),
      ]);
    }
  );
});

describe('ricota catalog aliases', () => {
  const name = 'Empanada de Espinafre com Ricota e Tomate Seco';
  const row = {
    id: 'tenant-ricota-uuid',
    name,
    price: 21.25,
    is_available: true,
  };

  it.each(['ricota', 'ricota e tomate seco'])(
    'recognizes the official flavor through %s without changing live identity or price',
    (alias) => {
      expect(aliasesForCatalogName(name)).toContain(alias);
      for (const text of [
        `+ 1 empanada ${alias}`,
        `+ 1 frango, + 1 ${alias}`,
      ]) {
        const legacy = parseTextOrder(text);
        expect(legacy.unresolved).toEqual([]);
        expect(legacy.requiresKitchenReview).toBe(false);
        expect(legacy.items.at(-1)).toMatchObject({
          title: name,
          quantity: 1,
          unitPrice: 14,
        });
        const live = parseCatalogOrder(text, [
          ...catalogEntries([row]),
          chicken,
        ]);
        expect(live.unresolved).toEqual([]);
        expect(live.requiresKitchenReview).toBe(false);
        expect(live.items.at(-1)).toMatchObject({
          id: row.id,
          quantity: 1,
          unitPrice: 21.25,
        });
      }
    }
  );

  it.each([true, false])(
    'does not steal a ricota alias from another tenant item (available=%s)',
    (available) => {
      const catalog = catalogEntries([
        row,
        {
          id: 'other-ricota',
          name: 'Empanada de Ricota',
          price: 12,
          is_available: available,
        },
      ]);
      expect(catalog.every((entry) => !entry.aliases.includes('ricota'))).toBe(
        true
      );
      expect(parseCatalogOrder('+ 1 ricota', catalog).hasItems).toBe(false);
      expect(
        parseCatalogOrder('+ 1 ricota e tomate seco', catalog).items[0]?.id
      ).toBe(row.id);
    }
  );

  it('never falls back to static prices or unavailable products', () => {
    for (const catalog of [
      [],
      catalogEntries([{ ...row, is_available: false }]),
    ]) {
      const parsed = parseCatalogOrder('+ 1 ricota e tomate seco', catalog);
      expect(parsed.hasItems).toBe(false);
      expect(parsed.total).toBe(0);
      expect(parsed.unresolved?.length).toBeGreaterThan(0);
    }
  });
});

describe('signed quantity safety', () => {
  it.each([
    '-1 frango',
    '- 1 frango',
    '−2 carne',
    '– 2 calabresa',
    '-12 carne',
    '+ -1 frango',
  ])('never converts a negative amount to a positive order: %s', (text) => {
    expect(parseTextOrder(text).hasItems).toBe(false);
    expect(parseCatalogOrder(text, [chicken]).hasItems).toBe(false);
  });
});

describe('official menu contract', () => {
  it.each(cardapio.itens)(
    'preserves the complete official product, including punctuation: $nome',
    (product) => {
      const result = parseTextOrder(`+ 1 ${product.nome}`);
      expect(result.unresolved).toEqual([]);
      expect(result.requiresKitchenReview).toBe(false);
      expect(result.items).toEqual([
        expect.objectContaining({
          id: product.id,
          title: product.nome,
          quantity: 1,
          unitPrice: product.preco,
          totalPrice: product.preco,
        }),
      ]);
      expect(result.total).toBe(product.preco);
    }
  );

  it.each(cardapio.itens)(
    'uses only tenant identity and current price for official name: $nome',
    (product) => {
      const row = {
        id: `tenant-${product.id}`,
        name: product.nome,
        price: 23.45,
        is_available: true,
      };
      const result = parseCatalogOrder(
        `+ 1 ${product.nome}`,
        catalogEntries([row])
      );
      expect(result.unresolved).toEqual([]);
      expect(result.requiresKitchenReview).toBe(false);
      expect(result.items).toEqual([
        expect.objectContaining({
          id: row.id,
          title: product.nome,
          unitPrice: row.price,
          quantity: 1,
        }),
      ]);
      expect(result.total).toBe(row.price);
    }
  );
});

describe('addition regression boundaries', () => {
  it.each([
    ['2 carne 2 calabresa', [2, 2]],
    ['+ 2 carne', [2]],
    ['+ 1 empanada ricota e tomate seco', [1]],
    ['+ 1 frango, + 1 ricota', [1, 1]],
    ['+ 1 frango sem cebola + 1 ricota', [1, 1]],
  ] as const)(
    'preserves quantities and genuine notes: %s',
    (text, quantities) => {
      const parsed = parseTextOrder(text);
      expect(parsed.items.map((item) => item.quantity)).toEqual(quantities);
      expect(parsed.unresolved).toEqual([]);
      expect(parsed.requiresKitchenReview).toBe(false);
      if (text.includes('sem cebola'))
        expect(parsed.items[0].notes).toBe('sem cebola');
    }
  );

  it.each(['sem cebola + molho', '+ molho', 'obs: bem assada'])(
    'retains a real kitchen instruction rather than dropping plus: %s',
    (note) => {
      const parsed = parseTextOrder(`+ 1 frango ${note}`);
      expect(parsed.items[0].notes).toBe(note);
      expect(parsed.requiresKitchenReview).toBe(true);
    }
  );

  it('preserves delivery complements without treating them as quantities or kitchen notes', () => {
    const parsed = parseTextOrder(
      '+ 1 frango, + 1 ricota, entregar na Rua Augusta, 500 apto 21 - Centro'
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.deliveryAddress).toBe('Rua Augusta, 500 apto 21 - Centro');
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.requiresKitchenReview).toBe(false);
  });
});

describe('quantity addition separators', () => {
  it.each([
    '+ 1 empanada frango',
    '+1frango',
    '1 frango + 1 frango',
    '+ 1 frango, + 1 frango',
  ])(
    'does not turn addition syntax into unresolved text or kitchen notes: %s',
    (text) => {
      for (const result of [
        parseTextOrder(text),
        parseCatalogOrder(text, [chicken]),
      ]) {
        expect(result.hasItems).toBe(true);
        expect(result.unresolved).toEqual([]);
        expect(result.requiresKitchenReview).toBe(false);
        expect(result.items.every((item) => item.notes === undefined)).toBe(
          true
        );
      }
    }
  );
});
