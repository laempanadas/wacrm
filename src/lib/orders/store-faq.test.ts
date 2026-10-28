import { describe, expect, it } from 'vitest';
import { classifyFaq, faqResponse } from './store-faq';
import { STORE_FAQ, STORE_FAQ_UNCONFIRMED } from './store-faq-config';

describe('strict informational store FAQs', () => {
  it.each([
    ['Quanto tempo?', 'prazo'],
    ['QUANTO TEMPO DEMORA A ENTREGA???', 'prazo'],
    ['Qual o prazo de entrega?', 'prazo'],
    ['Qual a taxa de entrega?', 'taxa_entrega'],
    ['A entrega é grátis?', 'taxa_entrega'],
    ['A entrega é sem taxa?', 'taxa_entrega'],
    ['Tem taxa de entrega?', 'taxa_entrega'],
    ['Qual o horário de funcionamento?', 'horario'],
    ['Que horas vocês fecham?', 'horario'],
    ['Como pagar?', 'como_pagar'],
    ['Como faço para pagar?', 'como_pagar'],
    ['Como pago com Pix?', 'como_pagar'],
    ['Quais as formas de pagamento?', 'formas_pagamento'],
    ['Aceita cartão?', 'formas_pagamento'],
    ['Aceita Pluxee?', 'formas_pagamento'],
    ['Vocês aceitam Pluxee?', 'formas_pagamento'],
    ['Posso pagar na entrega?', 'pagar_na_entrega'],
    ['Aceita pagamento na entrega?', 'pagar_na_entrega'],
  ] as const)('classifies only the complete question: %s', (text, intent) => {
    expect(classifyFaq(text)).toBe(intent);
  });

  it.each([
    '',
    'sim',
    'CONFIRMO O PEDIDO',
    'já paguei',
    'Pix feito',
    'quanto tempo? adiciona 2 coca',
    'quanto tempo?\n2 carne',
    'qual a taxa de entrega? cancelar pedido',
    'como pagar? troca o endereço',
    'aceita Pluxee? então confirmo o pedido',
    'posso pagar na entrega? sem cebola',
    'a entrega é sem taxa? sem cebola',
    'não quero saber quanto tempo',
    'horário: Rua Flores, 10 Centro',
    'Quanto tempo? Como pagar?',
    'aceita Pluxee e adiciona 2 coca?',
    'qual o pix? já paguei',
  ])('leaves unrecognized, mixed or commercial input untouched: %s', (text) => {
    expect(classifyFaq(text)).toBeNull();
  });

  it('answers the configured information without inventing payment status', () => {
    expect(faqResponse('taxa_entrega', 'Tem taxa de entrega?')).toEqual({
      text: STORE_FAQ.taxa_entrega,
      needsHandoff: false,
    });
    expect(faqResponse('como_pagar', 'Como pagar?')).toEqual({
      text: STORE_FAQ.como_pagar,
      needsHandoff: false,
    });
  });

  it.each([
    'prazo',
    'horario',
    'formas_pagamento',
    'pagar_na_entrega',
  ] as const)(
    'requests confirmation from the team when %s is not configured',
    (intent) => {
      const config = { ...STORE_FAQ, [intent]: null };
      expect(faqResponse(intent, 'pergunta', config)).toEqual({
        text: STORE_FAQ_UNCONFIRMED,
        needsHandoff: true,
      });
    }
  );

  it('never infers Pluxee acceptance from the general list of payment methods', () => {
    const config = {
      ...STORE_FAQ,
      formas_pagamento: 'Pix e cartão.',
      pluxee: null,
    };
    expect(faqResponse('formas_pagamento', 'Aceita Pluxee?', config)).toEqual({
      text: STORE_FAQ_UNCONFIRMED,
      needsHandoff: true,
    });
  });

  it('uses a specific Pluxee policy only when explicitly configured', () => {
    const config = { ...STORE_FAQ, pluxee: 'Política confirmada pela loja.' };
    expect(faqResponse('formas_pagamento', 'Aceita Pluxee?', config)).toEqual({
      text: config.pluxee,
      needsHandoff: false,
    });
  });

  it('treats an empty configured answer as unknown without mutating config', () => {
    const config = Object.freeze({ ...STORE_FAQ, prazo: '  ' });
    expect(faqResponse('prazo', 'Quanto tempo?', config)).toEqual({
      text: STORE_FAQ_UNCONFIRMED,
      needsHandoff: true,
    });
    expect(config.prazo).toBe('  ');
  });
});
