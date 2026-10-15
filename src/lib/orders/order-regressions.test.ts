import { describe, expect, it } from 'vitest';
import {
  hasOrderIntent,
  isCompleteDeliveryAddress,
  parseCatalogOrder,
  parseTextOrder,
} from './text-order-parser';

export const RAFAEL_ORDER =
  '1 queijo com tomate\n2 carne sem pimentão\n2 calabresa sem queijo ou cream cheese\n1 escarola\n5 carne';

describe('lossless order extraction', () => {
  it.each([
    ' e sem pimentão',
    ', sem queijo ou cream cheese',
    '; observação: bem assada',
  ])('does not consume a kitchen note as part of the address: %s', (suffix) => {
    const parsed = parseTextOrder(
      `2 carne, entregar na Rua Flores, 10 Centro${suffix}`
    );
    expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(parsed.items[0].notes).toContain(
      suffix.replace(/^[,; ]+(?:e )?/, '')
    );
    expect(parsed.requiresKitchenReview).toBe(true);
  });
  it('preserves a standalone kitchen suffix after an address for clarification', () => {
    const parsed = parseTextOrder('Rua Flores, 10 Centro e sem pimentão');
    expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(parsed.unresolved?.join(' ')).toContain('sem pimentão');
  });
  it.each([' e 3 lagosta', ' e três lagosta'])(
    'preserves an unknown conjunction-delimited item: %s',
    (suffix) => {
      const parsed = parseTextOrder(
        `2 carne, entregar na Rua Flores, 10 Centro${suffix}`
      );
      expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(parsed.unresolved?.join(' ')).toContain('lagosta');
    }
  );
  it('keeps the true street prefix and the item after conjunction plus quantity', () => {
    const parsed = parseTextOrder(
      '2 carne, entregar na Rua Flores, 10 Centro e 1 calabresa'
    );
    expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
    expect(parsed.items.map((item) => item.quantity)).toEqual([2, 1]);
    expect(parsed.items.map((item) => item.id)).toEqual([
      'emp_hamburguer',
      'empcalabresa',
    ]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.requiresKitchenReview).toBe(false);
  });
  it.each([
    'Rua Flores, 10 Centro',
    'Av. Brasil, 123, Centro',
    'Rua Um,123 Centro',
    'Rua Flores 10 Centro',
  ])(
    'validates a street, number and additional locality text: %s',
    (address) => {
      expect(isCompleteDeliveryAddress(address)).toBe(true);
    }
  );
  it.each([
    '',
    'Rua Flores',
    'Rua Flores, 10',
    'Centro 10',
    '01310-100',
    'Rua Flores, 10 Centro, 3 lagosta',
  ])('rejects incomplete or mixed address input: %s', (address) => {
    expect(isCompleteDeliveryAddress(address)).toBe(false);
  });
  it.each(['3 lagosta', 'três lagosta'])(
    'does not swallow an unknown quantity after the address: %s',
    (request) => {
      const parsed = parseTextOrder(
        `2 carne\nRua Flores, 10 Centro, ${request}`
      );
      expect(parsed.deliveryAddress).toBe('Rua Flores, 10 Centro');
      expect(parsed.unresolved).toEqual([request]);
      expect(parsed.items[0].quantity).toBe(2);
    }
  );
  it.each(['quero lagosta e 2 carne', 'Boa noite, quero lagosta e 2 carne'])(
    'preserves an unknown prefix alongside known quantities: %s',
    (text) => {
      const parsed = parseTextOrder(text);
      expect(parsed.items.map((item) => item.quantity)).toEqual([2]);
      expect(parsed.unresolved?.join(' ')).toContain('lagosta');
    }
  );
  it.each([
    'Boa noite, quero 2 carne',
    'oi, vou querer 2 carne',
    'na verdade 3 carne',
    'adicione mais 2 carne',
  ])('consumes only recognized conversational fillers: %s', (text) => {
    expect(parseTextOrder(text).unresolved).toEqual([]);
  });
  it('routes an unknown product requested without quantity to clarification, not the LLM', () => {
    expect(hasOrderIntent('quero lagosta')).toBe(true);
    expect(parseCatalogOrder('quero lagosta', []).unresolved).toEqual([
      'quero lagosta',
    ]);
  });
  it('preserves comma-separated observations and items after an address', () => {
    const result = parseTextOrder(
      'Rua Flores, 10 Centro\n2 calabresa sem queijo, sem cream cheese\n1 carne'
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0].notes).toBe('sem queijo, sem cream cheese');
    expect(result.items[1].quantity).toBe(1);
    expect(result.deliveryAddress).toBe('Rua Flores, 10 Centro');
  });
  it('does not silently drop an unknown item or substitute an invented catalog price', () => {
    const result = parseCatalogOrder('2 carne, 1 lagosta', [
      { id: 'live-meat', nome: 'Carne', preco: 19.25, aliases: ['carne'] },
    ]);
    expect(result.unresolved).toEqual(['1 lagosta']);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(38.5);
    expect(parseCatalogOrder('2 carne', []).items).toEqual([]);
  });
  it('preserves every Rafael line and its customization instead of merging meat', () => {
    const result = parseTextOrder(RAFAEL_ORDER);
    expect(result.items).toHaveLength(5);
    expect(
      result.items
        .filter((item) => item.id === 'emp_hamburguer')
        .map((item) => item.quantity)
    ).toEqual([2, 5]);
    expect(result.items[1]).toMatchObject({
      notes: 'sem pimentão',
      quantity: 2,
    });
    expect(result.items[2]).toMatchObject({
      notes: 'sem queijo ou cream cheese',
      quantity: 2,
    });
    expect(result.total).toBe(154);
  });
});
