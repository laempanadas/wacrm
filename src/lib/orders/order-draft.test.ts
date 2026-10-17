import { describe, expect, it } from 'vitest';
import { advanceOrderDraft, type OrderDraft } from './order-draft';
import type { ProductCatalogEntry } from './text-order-parser';

const catalog: ProductCatalogEntry[] = [
  { id: 'meat', nome: 'Carne', preco: 14, aliases: ['carne'] },
  { id: 'sausage', nome: 'Calabresa', preco: 14, aliases: ['calabresa'] },
];
const initial = (): OrderDraft => ({
  id: 'draft-1',
  version: 0,
  items: [],
  unresolved: [],
  stage: 'collecting',
  total: 0,
});

describe('structured order draft', () => {
  it('shows a revised summary when an acknowledgement coincides with a catalog price change', () => {
    const first = advanceOrderDraft(
      initial(),
      '2 carne\nRua Flores, 10 Centro',
      catalog
    );
    const repriced = advanceOrderDraft(first.draft, 'ok', [
      { ...catalog[0], preco: 15 },
    ]);
    expect(repriced.checkout).toBe(false);
    expect(repriced.reply).toContain('Resumo do pedido');
    expect(repriced.reply).toContain('Total: R$ 30,00');
  });
  it('acknowledges item selection briefly and shows the full summary only after the address', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog);
    expect(first.reply).toContain('Anotado!');
    expect(first.reply).toContain('2 itens');
    expect(first.reply).not.toContain('Resumo do pedido');
    expect(first.reply).not.toContain('1. 2x');
    expect(first.reply).not.toContain('Total:');
    const addressed = advanceOrderDraft(
      first.draft,
      'Rua Flores, 10 Centro',
      catalog
    );
    expect(addressed.reply).toContain('Resumo do pedido');
    expect(addressed.reply).toContain('1. 2x Carne');
    expect(addressed.reply).toContain('🚚 Entrega: *GRÁTIS*');
    expect(addressed.reply).toContain('Total: R$ 28,00');
    expect(addressed.checkout).toBe(false);
    const repeatedAddress = advanceOrderDraft(
      addressed.draft,
      'Rua Flores, 10 Centro',
      catalog
    );
    expect(repeatedAddress.reply).not.toContain('Resumo do pedido');
    expect(repeatedAddress.draft.version).toBe(addressed.draft.version);
    expect(repeatedAddress.checkout).toBe(false);
  });
  it.each([
    '2 carne\n3 carne',
    '2 carne\n2 carne',
    '1 carne\n2 carne',
    '2 carne\n1 carne',
  ])(
    'requires clarification instead of overwriting repeated correction lines: %s',
    (lines) => {
      const first = advanceOrderDraft(
        initial(),
        '1 carne\nRua Flores, 10 Centro',
        catalog
      ).draft;
      expect(first.stage).toBe('awaiting_confirmation');
      const snapshot = structuredClone(first);
      const correction = `na verdade ${lines}`;
      const changed = advanceOrderDraft(first, correction, catalog);

      expect(changed.draft.items.map((item) => item.quantity)).toEqual([1]);
      expect(changed.draft.total).toBe(14);
      expect(changed.draft.unresolved.join('\n')).toContain(correction);
      expect(changed.reply).toContain(correction);
      expect(changed.draft.stage).toBe('needs_human');
      expect(changed.checkout).toBe(false);
      expect(changed.draft.version).toBeGreaterThan(first.version);
      expect(first).toEqual(snapshot);
      const restored = JSON.parse(JSON.stringify(changed.draft)) as OrderDraft;
      expect(
        advanceOrderDraft(restored, 'confirmo o pedido', catalog).checkout
      ).toBe(false);
    }
  );
  it('adds a bare quantity to the existing cart instead of replacing or ignoring it', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const changed = advanceOrderDraft(first, '5 carne', catalog);
    expect(changed.draft.items.map((item) => item.quantity)).toEqual([7]);
    expect(changed.draft.total).toBe(98);
    expect(changed.draft.unresolved).toEqual([]);
    expect(changed.reply).toContain('7 itens');
    expect(changed.checkout).toBe(false);
    expect(changed.draft.stage).toBe('awaiting_address');
    expect(
      advanceOrderDraft(changed.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
  it('resolves repeated SKU lines against the previous turn rather than newly appended lines', () => {
    const first = advanceOrderDraft(initial(), '1 calabresa', catalog).draft;
    const followup = advanceOrderDraft(
      first,
      '2 carne\n5 carne',
      catalog
    ).draft;
    expect(followup.items.map((item) => item.quantity)).toEqual([1, 2, 5]);
    const next = advanceOrderDraft(followup, '1 calabresa', catalog).draft;
    expect(next.items.map((item) => item.quantity)).toEqual([2, 2, 5]);
    expect(next.unresolved).toEqual([]);
  });
  it.each([
    'Rua Flores',
    'Rua Flores Centro',
    'Rua Flores bem passada',
    'Rua Flores tudo separado',
  ])(
    'retains ambiguous address input for review instead of silently discarding it: %s',
    (text) => {
      const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
      const pending = advanceOrderDraft(first, text, catalog);
      expect(pending.draft.deliveryAddress).toBeUndefined();
      expect(pending.draft.unresolved).toContain(text);
      expect(pending.draft.stage).toBe('needs_human');
      expect(pending.reply).toContain(text);
      expect(pending.reply).toContain('esclarecimento');
      expect(pending.draft.items).toEqual(first.items);
      expect(pending.draft.version).toBeGreaterThan(first.version);
      expect(first.unresolved).toEqual([]);
      const restored = JSON.parse(JSON.stringify(pending.draft)) as OrderDraft;
      const addressed = advanceOrderDraft(
        restored,
        'Rua Flores, 10 Centro',
        catalog
      );
      expect(addressed.draft.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(addressed.draft.unresolved).toContain(text);
      expect(addressed.draft.stage).toBe('needs_human');
      expect(addressed.checkout).toBe(false);
      const confirmed = advanceOrderDraft(
        addressed.draft,
        'confirmo o pedido',
        catalog
      );
      expect(confirmed.draft.unresolved).toContain(text);
      expect(confirmed.reply).toContain(text);
      expect(confirmed.checkout).toBe(false);
    }
  );
  it.each(['Rua Flores, 10'])(
    'blocks checkout until a complete delivery address is provided: %s',
    (address) => {
      const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
      const addressed = advanceOrderDraft(first, address, catalog);
      expect(addressed.draft.deliveryAddress).toBe(
        address === 'Rua Flores, 10' ? address : undefined
      );
      expect(addressed.draft.stage).toBe('awaiting_address');
      expect(addressed.reply).toContain('Número e Bairro');
      expect(
        advanceOrderDraft(addressed.draft, 'confirmo o pedido', catalog)
          .checkout
      ).toBe(false);
      const complete = advanceOrderDraft(
        addressed.draft,
        'Rua Flores, 10 Centro',
        catalog
      );
      expect(complete.draft.stage).toBe('awaiting_confirmation');
      expect(complete.checkout).toBe(false);
      expect(
        advanceOrderDraft(complete.draft, 'confirmo o pedido', catalog).checkout
      ).toBe(true);
    }
  );
  it.each(['10A', '10a'])(
    'requires confirmation of the summary for an address with suffix %s',
    (number) => {
      const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
      const address = `Rua Flores,${number} Centro`;
      const addressed = advanceOrderDraft(first, address, catalog);
      expect(addressed.draft.deliveryAddress).toBe(address);
      expect(addressed.draft.unresolved).toEqual([]);
      expect(addressed.draft.stage).toBe('awaiting_confirmation');
      expect(addressed.reply).toContain(address);
      expect(addressed.reply).toContain('Resumo do pedido');
      expect(addressed.draft.version).toBeGreaterThan(first.version);
      expect(addressed.checkout).toBe(false);
      expect(
        advanceOrderDraft(addressed.draft, 'confirmo o pedido', catalog)
          .checkout
      ).toBe(true);
      const withNote = advanceOrderDraft(
        first,
        `${address}, tudo separado`,
        catalog
      );
      expect(withNote.draft.unresolved.join('\n')).toContain('tudo separado');
      expect(withNote.draft.stage).toBe('needs_human');
      expect(
        advanceOrderDraft(withNote.draft, 'confirmo o pedido', catalog).checkout
      ).toBe(false);
    }
  );
  it.each([
    'Rua Flores, 55 apto 123 C, Centro',
    'Rua Flores 55 apto 123 C Centro',
  ])('keeps apartment letters separate from order items: %s', (address) => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const addressed = advanceOrderDraft(first, address, catalog);
    expect(addressed.draft.deliveryAddress).toBe(address);
    expect(addressed.draft.unresolved).toEqual([]);
    expect(addressed.draft.items).toEqual(first.items);
    expect(addressed.draft.stage).toBe('awaiting_confirmation');
    expect(addressed.reply).toContain(address);
    expect(addressed.checkout).toBe(false);
    expect(
      advanceOrderDraft(addressed.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(true);
    const noted = advanceOrderDraft(
      first,
      `${address}, tudo separado`,
      catalog
    );
    expect(noted.draft.deliveryAddress).toBe(address);
    expect(noted.draft.unresolved.join('\n')).toContain('tudo separado');
    expect(noted.draft.stage).toBe('needs_human');
    expect(
      advanceOrderDraft(noted.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
  it('validates a saved address before requesting order confirmation', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const addressed = advanceOrderDraft(
      first,
      'no mesmo endereço',
      catalog,
      'Rua Flores'
    );
    expect(addressed.draft.stage).toBe('awaiting_address');
    expect(
      advanceOrderDraft(addressed.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
  it('adds items after the address and requires confirmation of the new total', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const corrected = advanceOrderDraft(
      first,
      'Rua Flores, 10 Centro, 3 carne',
      catalog
    );
    expect(corrected.draft.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(corrected.draft.items.map((item) => item.quantity)).toEqual([5]);
    expect(corrected.draft.total).toBe(70);
    expect(corrected.draft.unresolved).toEqual([]);
    expect(corrected.checkout).toBe(false);
    expect(
      advanceOrderDraft(corrected.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(true);
  });
  it.each([
    'sem pimentão',
    'a carne sem pimentão',
    'a carne sem queijo ou cream cheese',
  ])('preserves a later kitchen observation: %s', (observation) => {
    const captured = advanceOrderDraft(
      initial(),
      '2 carne\nRua Flores, 10 Centro',
      catalog
    ).draft;
    const changed = advanceOrderDraft(captured, observation, catalog);
    expect(changed.draft.unresolved).toContain(observation);
    expect(changed.draft.items[0].quantity).toBe(2);
    expect(changed.draft.stage).toBe('needs_human');
    expect(changed.reply).toContain(observation);
    const restored = JSON.parse(JSON.stringify(changed.draft)) as OrderDraft;
    expect(
      advanceOrderDraft(restored, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
  it('holds personalized and unrecognized orders for human review even after customer confirmation', () => {
    const captured = advanceOrderDraft(
      initial(),
      '2 carne sem pimentão, 5 carne, 1 lagosta',
      catalog
    );
    expect(captured.draft.items).toHaveLength(2);
    expect(captured.draft.items[0].notes).toBe('sem pimentão');
    expect(captured.draft.unresolved).toEqual(['1 lagosta']);
    expect(captured.draft.stage).toBe('needs_human');
    expect(
      advanceOrderDraft(captured.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
  it('invalidates confirmation when catalog price changes and never treats a correction as an address', () => {
    const captured = advanceOrderDraft(
      initial(),
      '2 carne, entregar na Rua Flores, 10 Centro',
      catalog
    );
    const changed = advanceOrderDraft(captured.draft, 'confirmo o pedido', [
      { ...catalog[0], preco: 15 },
    ]);
    expect(changed.checkout).toBe(false);
    expect(changed.draft.total).toBe(30);
    const pending = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    expect(
      advanceOrderDraft(pending, 'não quero queijo', catalog).draft
        .deliveryAddress
    ).toBeUndefined();
  });
  it('preserves explicit corrections and cumulatively merges later additions', () => {
    const first = advanceOrderDraft(
      initial(),
      '2 carne, 1 calabresa',
      catalog
    ).draft;
    const corrected = advanceOrderDraft(
      first,
      'na verdade 3 carne',
      catalog
    ).draft;
    expect(corrected.items.map((item) => item.quantity)).toEqual([3, 1]);
    const repeated = advanceOrderDraft(corrected, '3 carne', catalog).draft;
    expect(repeated.items.map((item) => item.quantity)).toEqual([6, 1]);
    const added = advanceOrderDraft(
      repeated,
      'adicione mais 2 carne',
      catalog
    ).draft;
    expect(added.items.map((item) => item.quantity)).toEqual([8, 1]);
    const removed = advanceOrderDraft(added, 'remova linha 2', catalog).draft;
    expect(removed.items.map((item) => item.id)).toEqual(['meat']);
  });
  it('requires confirmation of the addressed summary before checkout', () => {
    const captured = advanceOrderDraft(
      initial(),
      '2 carne, entregar na Rua Flores, 10 Centro',
      catalog
    );
    expect(captured.checkout).toBe(false);
    expect(captured.draft.stage).toBe('awaiting_confirmation');
    expect(captured.reply).toContain('CONFIRMO O PEDIDO');
    const confirmed = advanceOrderDraft(
      captured.draft,
      'confirmo o pedido',
      catalog
    );
    expect(confirmed.checkout).toBe(true);
    expect(confirmed.draft.items[0].quantity).toBe(2);
    expect(confirmed.draft.total).toBe(28);
  });
});
