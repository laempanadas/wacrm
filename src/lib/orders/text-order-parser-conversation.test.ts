import { describe, expect, it } from 'vitest';
import { advanceOrderDraft, type OrderDraft } from './order-draft';
import { extractAddressFromText, parseTextOrder } from './text-order-parser';

const catalog = [{ id: 'meat', nome: 'Carne', preco: 14, aliases: ['carne'] }];
const initial = (): OrderDraft => ({
  id: 'conversation',
  version: 0,
  items: [],
  unresolved: [],
  stage: 'collecting',
  total: 0,
});
const address = 'Rua Santo André, 55 apto 123 C vila Assunção, Santo André';
const message = `Vou colocar o endereço aqui: ${address}`;

describe('conversational address framing', () => {
  it('preserves the city without retaining the address introduction', () => {
    expect(extractAddressFromText(message)).toBe(address);
    const parsed = parseTextOrder(message);
    expect(parsed.deliveryAddress).toBe(address);
    expect(parsed.items).toEqual([]);
    expect(parsed.unresolved).toEqual([]);
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const result = advanceOrderDraft(first, message, catalog);
    expect(result.draft.deliveryAddress).toBe(address);
    expect(result.draft.items).toEqual(first.items);
    expect(result.draft.unresolved).toEqual([]);
    expect(result.draft.stage).toBe('awaiting_confirmation');
    expect(result.checkout).toBe(false);
  });
  it.each([
    'tudo separado',
    'bem assadas',
    'sem pimentão',
    'instrução inédita XYZ',
  ])('retains kitchen instructions after the city: %s', (note) => {
    const parsed = parseTextOrder(`${message}, ${note}`);
    expect(parsed.deliveryAddress).toBe(address);
    expect(parsed.unresolved?.join(' ')).toContain(note);
    const first = advanceOrderDraft(initial(), '2 carne', catalog).draft;
    const result = advanceOrderDraft(first, `${message}, ${note}`, catalog);
    expect(result.draft.stage).toBe('needs_human');
    expect(
      advanceOrderDraft(result.draft, 'confirmo o pedido', catalog).checkout
    ).toBe(false);
  });
});
