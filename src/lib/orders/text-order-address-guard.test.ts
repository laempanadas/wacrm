import { describe, expect, it } from 'vitest';
import {
  extractAddressFromText,
  isCompleteDeliveryAddress,
  isAddressConfirmation,
  parseTextOrder,
} from './text-order-parser';

describe('delivery address requires a street and house number', () => {
  it.each([
    'sim mas está confuso',
    'não é esse endereço, confirmo',
    'sim mas sem pimentão',
    'pode ser outro endereço',
  ])(
    'does not confirm a saved address from a partial affirmative: %s',
    (text) => {
      expect(isAddressConfirmation(text)).toBe(false);
    }
  );
  it.each([
    'Vixi está meio confuso',
    'Seria este pedido',
    'Rua das Flores',
    'entregar na Rua das Flores, Centro',
    'Rua 7 de Setembro',
    '01310-100',
    'Meu CEP é 01310-100',
    'Rua das Flores, CEP 01310-100',
    'Rua das Flores, 01310100',
    'Rua das Flores, 01310-100',
    'Rua das Flores, apto 12',
    'Rua das Flores, bloco B, apto 12',
    'Bairro Centro, 10',
  ])('does not accept an incomplete address or comment: %s', (text) => {
    expect(extractAddressFromText(text)).toBeNull();
    expect(parseTextOrder(text).deliveryAddress).toBeUndefined();
    expect(isCompleteDeliveryAddress(text)).toBe(false);
  });

  it.each(['Rua das Flores, 10', 'Av Brasil 450', 'Rua 7 de Setembro, 10'])(
    'extracts street and number but still requires locality for completeness: %s',
    (address) => {
      expect(extractAddressFromText(address)).toBe(address);
      expect(parseTextOrder(address).deliveryAddress).toBe(address);
      expect(isCompleteDeliveryAddress(address)).toBe(false);
    }
  );

  it.each(['10A', '10a'])(
    'accepts an alphabetical house-number suffix: %s',
    (number) => {
      const address = `Rua Flores,${number} Centro`;
      expect(extractAddressFromText(address)).toBe(address);
      expect(isCompleteDeliveryAddress(address)).toBe(true);
      const parsed = parseTextOrder(`2 carne\n${address}, tudo separado`);
      expect(parsed.deliveryAddress).toBe(address);
      expect(parsed.items[0].quantity).toBe(2);
      expect(parsed.items[0].notes).toContain('tudo separado');
      expect(parsed.requiresKitchenReview).toBe(true);
    }
  );

  it.each([
    'Rua Flores, 55 apto 123 C, Centro',
    'Rua Flores 55 apto 123 C Centro',
  ])('preserves a house number and apartment with letter: %s', (address) => {
    expect(extractAddressFromText(address)).toBe(address);
    expect(isCompleteDeliveryAddress(address)).toBe(true);
    const parsed = parseTextOrder(`2 carne\n${address}`);
    expect(parsed.deliveryAddress).toBe(address);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].quantity).toBe(2);
    expect(parsed.items[0].notes).toBeUndefined();
    expect(parsed.unresolved).toEqual([]);
    const noted = parseTextOrder(`2 carne\n${address}, tudo separado`);
    expect(noted.deliveryAddress).toBe(address);
    expect(noted.items[0].notes).toContain('tudo separado');
    expect(noted.requiresKitchenReview).toBe(true);
  });

  it.each([
    'Rua das Flores, 10 Centro',
    'Rua 7 de Setembro 10 Centro',
    'Rua das Flores, 10 Centro, CEP 01310-100',
  ])('keeps complete numbered addresses valid: %s', (address) => {
    expect(extractAddressFromText(address)).toBe(address);
    expect(isCompleteDeliveryAddress(address)).toBe(true);
  });
});
