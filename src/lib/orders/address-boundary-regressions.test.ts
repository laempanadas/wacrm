import { describe, expect, it } from 'vitest';
import { advanceOrderDraft, type OrderDraft } from './order-draft';
import {
  extractAddressFromText,
  isCompleteDeliveryAddress,
  parseCatalogOrder,
  parseTextOrder,
} from './text-order-parser';

describe('address boundaries preserve commercial clauses', () => {
  const catalog = [
    { id: 'live-carne', nome: 'Carne', preco: 19, aliases: ['carne'] },
  ];
  const emptyDraft = (): OrderDraft => ({
    id: 'address-boundary',
    version: 0,
    items: [],
    unresolved: [],
    stage: 'collecting',
    total: 0,
  });

  it.each(
    [' - ', '; ', ', ', ' / ', ' — ', ' e ', ': ', ' (', ' – ', '-'].flatMap(
      (separator) =>
        [
          'bem assadas',
          'sou alérgico a leite',
          'adicionar molho',
          'embrulhar separadamente',
          'instrução inédita XYZ',
        ].map((clause) => ({ separator, clause }))
    )
  )(
    'retains unknown clause $separator / $clause and blocks checkout',
    ({ separator, clause }) => {
      const address = 'Rua Flores, 10 Centro';
      const text = `2 carne, entregar na ${address}${separator}${clause}`;
      const parsed = parseCatalogOrder(text, catalog);
      expect(parsed.deliveryAddress).toBe(address);
      expect(parsed.rawText).toBe(text);
      expect(
        [
          ...parsed.items.map((item) => item.notes || ''),
          ...(parsed.unresolved || []),
        ].join(' ')
      ).toContain(clause);
      expect(parsed.items[0]).toMatchObject({
        quantity: 2,
        unitPrice: 19,
        totalPrice: 38,
      });
      expect(isCompleteDeliveryAddress(`${address}${separator}${clause}`)).toBe(
        false
      );

      const first = advanceOrderDraft(emptyDraft(), text, catalog);
      expect(first.draft.stage).toBe('needs_human');
      expect(first.checkout).toBe(false);
      expect(first.reply).toContain(clause);
      const confirmation = advanceOrderDraft(
        first.draft,
        'confirmo o pedido',
        catalog
      );
      expect(confirmation.checkout).toBe(false);
      expect(confirmation.draft.stage).toBe('needs_human');
    }
  );

  it.each([
    'Rua Flores, 10 Centro, apto 12 bloco B',
    'Rua Flores, 10 Centro / SP',
    'Rua Flores, 10 Centro - sem número no portão',
    'Rua Flores, 10 Centro, CEP 01310-100',
  ])('retains a standalone suffix after address complements: %s', (address) => {
    const first = advanceOrderDraft(emptyDraft(), '2 carne', catalog);
    const addressed = advanceOrderDraft(
      first.draft,
      `${address}; instrução inédita: NÃO descartar`,
      catalog
    );
    expect(addressed.draft.deliveryAddress).toBe(address);
    expect(addressed.draft.unresolved.join(' ')).toContain(
      'instrução inédita: NÃO descartar'
    );
    expect(addressed.draft.stage).toBe('needs_human');
    expect(
      advanceOrderDraft(addressed.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });

  it.each([' - ', ' / '])(
    'preserves kitchen instructions after %s',
    (separator) => {
      const parsed = parseTextOrder(
        `2 carne, entregar na Rua Flores, 10 Centro${separator}sem pimentão`
      );
      expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(parsed.items[0].notes).toContain('sem pimentão');
      expect(parsed.requiresKitchenReview).toBe(true);
      expect(
        isCompleteDeliveryAddress(
          `Rua Flores, 10 Centro${separator}sem pimentão`
        )
      ).toBe(false);
    }
  );

  it.each([' / ', ' - '])('preserves unknown items after %s', (separator) => {
    const parsed = parseCatalogOrder(
      `2 carne, entregar na Rua Flores, 10 Centro${separator}3 lagosta`,
      [{ id: 'live-carne', nome: 'Carne', preco: 19, aliases: ['carne'] }]
    );
    expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(parsed.unresolved).toContain('3 lagosta');
    expect(parsed.items[0]).toMatchObject({ id: 'live-carne', quantity: 2 });
  });

  it.each([
    'sem pimentão',
    'com molho extra',
    'observação: bem assada',
    'quero lagosta',
  ])(
    'does not silently accept an unpunctuated commercial clause: %s',
    (clause) => {
      const text = `Rua Flores, 10 Centro ${clause}`;
      const parsed = parseTextOrder(text);
      expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(parsed.unresolved?.join(' ')).toContain(clause);
      expect(isCompleteDeliveryAddress(text)).toBe(false);
    }
  );

  it.each(['3 lagosta', 'três lagosta'])(
    'keeps unpunctuated unknown quantities available for clarification: %s',
    (clause) => {
      const parsed = parseTextOrder(
        `2 carne, entregar na Rua Flores, 10 Centro ${clause}`
      );
      expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(parsed.unresolved).toContain(clause);
      expect(parsed.items[0].quantity).toBe(2);
    }
  );

  it('uses the actual house number when a later comma introduces an unknown item', () => {
    const parsed = parseTextOrder(
      '2 carne, entregar na Rua Flores 10 Centro, 3 lagosta'
    );
    expect(parsed.deliveryAddress).toBe('Rua Flores 10 Centro');
    expect(parsed.unresolved).toContain('3 lagosta');
  });

  it.each(['3 lagosta', 'sem pimentão'])(
    'continues detecting commercial clauses after legitimate complements: %s',
    (clause) => {
      const parsed = parseTextOrder(
        `Rua Flores, 10 Centro apto 12 bloco B ${clause}`
      );
      expect(parsed.deliveryAddress).toBe(
        'Rua Flores, 10 Centro apto 12 bloco B'
      );
      expect(parsed.unresolved?.join(' ')).toContain(clause);
    }
  );

  it.each([
    'Rua Flores, 10 - Centro',
    'Rua Flores, 10 Centro / SP',
    'Rua Flores, 10 Centro, apto 12 bloco B',
    'Rua Flores, 10 Centro apto 12 bloco B',
    'Rua Flores, 10 Centro, 3 andar',
    'Rua Flores, 10 Centro 3 andar',
    'Rua Flores, 10 Bairro Dois Irmãos',
    'Rua Flores, 10 Centro - sem número no portão',
    'Rua Flores, 10 Centro com portaria',
    'Rua Flores, 10 Centro, CEP 01310-100',
    'Rua 7 de Setembro, 10 Centro',
    'Rua 7 de Setembro 10 Centro',
  ])('preserves legitimate address details: %s', (address) => {
    expect(extractAddressFromText(address)).toBe(address);
    expect(isCompleteDeliveryAddress(address)).toBe(true);
    const parsed = parseTextOrder(`2 carne, entregar na ${address}`);
    expect(parsed.deliveryAddress).toBe(address);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.requiresKitchenReview).toBe(false);
    const first = advanceOrderDraft(
      emptyDraft(),
      `2 carne, entregar na ${address}`,
      catalog
    );
    expect(first.draft.stage).toBe('awaiting_confirmation');
    expect(
      advanceOrderDraft(first.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(true);
  });
});
