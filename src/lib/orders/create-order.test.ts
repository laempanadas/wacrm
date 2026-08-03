import { describe, expect, it } from 'vitest';

import {
  TAG_AGUARDANDO,
  TAG_CONFIRMADO,
  buildOrderNotes,
  buildOrderTitle,
  deliveryKindLabel,
  paymentMethodLabel,
  selectStatusTagName,
} from './create-order';

describe('buildOrderTitle', () => {
  it("monta o título no formato 'Pedido - {nome}'", () => {
    expect(buildOrderTitle('Maria Silva')).toBe('Pedido - Maria Silva');
  });

  it("apara espaços e usa 'Cliente' quando o nome é vazio", () => {
    expect(buildOrderTitle('  ')).toBe('Pedido - Cliente');
    expect(buildOrderTitle('  João ')).toBe('Pedido - João');
  });
});

describe('selectStatusTagName', () => {
  it("retorna 'Confirmado' quando pago online", () => {
    expect(selectStatusTagName(true)).toBe(TAG_CONFIRMADO);
  });

  it("retorna 'Aguardando Pagamento' quando não pago online", () => {
    expect(selectStatusTagName(false)).toBe(TAG_AGUARDANDO);
  });
});

describe('paymentMethodLabel / deliveryKindLabel', () => {
  it('traduz as formas de pagamento', () => {
    expect(paymentMethodLabel('pix')).toBe('Pix');
    expect(paymentMethodLabel('dinheiro')).toBe('Dinheiro');
    expect(paymentMethodLabel('mercado_pago')).toBe(
      'Mercado Pago (link online)'
    );
  });

  it('traduz o tipo de recebimento', () => {
    expect(deliveryKindLabel('delivery')).toBe('Delivery');
    expect(deliveryKindLabel('retirada')).toBe('Retirada no local');
  });
});

describe('buildOrderNotes', () => {
  it('inclui endereço para delivery', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'delivery',
      paymentMethod: 'pix',
      deliveryAddress: 'Rua A, 123 - Centro',
    });
    expect(notes).toContain('Tipo: Delivery');
    expect(notes).toContain('Forma de pagamento: Pix');
    expect(notes).toContain('Endereço: Rua A, 123 - Centro');
  });

  it('marca endereço não informado no delivery', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'delivery',
      paymentMethod: 'cartao',
    });
    expect(notes).toContain('Endereço: (não informado)');
  });

  it('não inclui endereço para retirada', () => {
    const notes = buildOrderNotes({
      deliveryKind: 'retirada',
      paymentMethod: 'dinheiro',
    });
    expect(notes).toContain('Tipo: Retirada no local');
    expect(notes).not.toContain('Endereço');
  });
});
