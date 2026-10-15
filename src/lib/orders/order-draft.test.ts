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
  it('asks whether a bare changed quantity is an addition or replacement without mutating the line', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const changed = advanceOrderDraft(first, '5 carne', catalog);
    expect(changed.draft.items.map((item) => item.quantity)).toEqual([2]);
    expect(changed.draft.unresolved.join(' ')).toContain('5 carne');
    expect(changed.reply).toMatch(/adicionar|substituir/i);
    expect(changed.checkout).toBe(false);
    expect(changed.draft.stage).toBe('needs_human');
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
    expect(next.items.map((item) => item.quantity)).toEqual([1, 2, 5]);
    expect(next.unresolved).toEqual([]);
  });
  it.each(['Rua Flores', 'Rua Flores, 10', 'Rua Flores Centro'])(
    'blocks checkout until a complete delivery address is provided: %s',
    (address) => {
      const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
      const addressed = advanceOrderDraft(first, address, catalog);
      expect(addressed.draft.deliveryAddress).toBe(address);
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
  it('preserves an ambiguous quantity after an address on the same line for clarification', () => {
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const corrected = advanceOrderDraft(
      first,
      'Rua Flores, 10 Centro, 3 carne',
      catalog
    );
    expect(corrected.draft.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(corrected.draft.items.map((item) => item.quantity)).toEqual([2]);
    expect(corrected.draft.total).toBe(28);
    expect(corrected.draft.unresolved.join(' ')).toContain('3 carne');
    expect(corrected.checkout).toBe(false);
    expect(
      advanceOrderDraft(corrected.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
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
  it('applies additions and corrections without dropping other lines or doubling repeats', () => {
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
    expect(repeated.items.map((item) => item.quantity)).toEqual([3, 1]);
    const added = advanceOrderDraft(
      repeated,
      'adicione mais 2 carne',
      catalog
    ).draft;
    expect(added.items.map((item) => item.quantity)).toEqual([3, 1, 2]);
    const removed = advanceOrderDraft(added, 'remova linha 2', catalog).draft;
    expect(removed.items.map((item) => item.id)).toEqual(['meat', 'meat']);
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
