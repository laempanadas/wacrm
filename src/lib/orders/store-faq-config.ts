/** Informação aprovada pela loja. Preencha null somente após confirmar a política.
 * Não adicionar prazos, horários ou aceitação de benefícios por suposição.
 */
export interface StoreFaqConfig {
  prazo: string | null;
  taxa_entrega: string | null;
  horario: string | null;
  como_pagar: string | null;
  formas_pagamento: string | null;
  pagar_na_entrega: string | null;
  pluxee: string | null;
}

export const STORE_FAQ: Readonly<StoreFaqConfig> = Object.freeze({
  prazo: null,
  taxa_entrega: 'A entrega é GRÁTIS, sem taxa adicional e sem valor mínimo.',
  horario: null,
  como_pagar:
    'Para pagar, use o link do seu pedido no Mercado Pago. Para obter o Pix Copia e Cola, escolha Pix no checkout. O link gerado não significa que o pagamento foi aprovado.',
  formas_pagamento: null,
  pagar_na_entrega: null,
  pluxee: null,
});

export const STORE_FAQ_UNCONFIRMED =
  'Vou confirmar essa informação com a equipe. Um atendente vai te responder.';
