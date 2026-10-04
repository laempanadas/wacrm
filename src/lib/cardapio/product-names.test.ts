import { describe, expect, it } from 'vitest';
import { productNameFromCardapio } from './product-names';

describe('productNameFromCardapio', () => {
  it('maps a catalog retailer_id to the product name', () => {
    expect(productNameFromCardapio('beb_coca_2l')).toBe('Coca-Cola 2L');
  });

  it('ignores case and stray spaces in the id', () => {
    expect(productNameFromCardapio('emp_Frango com Espinafre e Cheddar')).toBe(
      'Empanada de Frango com Espinafre e Cheddar'
    );
    expect(productNameFromCardapio('EMP_ROMEU')).toBe(
      'Empanada Romeu e Julieta'
    );
  });

  it('returns undefined for unknown ids', () => {
    expect(productNameFromCardapio('nao_existe')).toBeUndefined();
  });
});
