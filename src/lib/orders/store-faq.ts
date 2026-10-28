import {
  STORE_FAQ,
  STORE_FAQ_UNCONFIRMED,
  type StoreFaqConfig,
} from './store-faq-config';

export type FaqIntent = Exclude<keyof StoreFaqConfig, 'pluxee'>;

function normalizedQuestion(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
    .replace(/[\t ]+/g, ' ');
}

// Whole-question matches only: no keyword/substring match may consume a change,
// confirmation, payment assertion or a second clause hidden inside a question.
const QUESTIONS: ReadonlyArray<readonly [FaqIntent, RegExp]> = [
  [
    'prazo',
    /^(?:quanto tempo(?: demora(?: a entrega)?)?|qual (?:o )?prazo(?: de entrega)?|em quanto tempo chega)$/,
  ],
  [
    'taxa_entrega',
    /^(?:qual (?:a )?taxa de entrega|qual (?:o )?(?:valor|preco)(?: da| de) entrega|(?:a )?entrega e (?:gratis|sem taxa)|tem taxa de entrega)$/,
  ],
  [
    'horario',
    /^(?:qual (?:o )?horario(?: de funcionamento)?|que horas (?:voces )?(?:abrem|fecham)|ate que horas (?:voces )?(?:atendem|funcionam))$/,
  ],
  [
    'como_pagar',
    /^(?:como (?:pagar|pago)(?: com pix)?|como faco (?:para|pra) pagar|como funciona o pagamento|como pego o pix copia e cola|qual (?:o|a) (?:pix|chave pix))$/,
  ],
  [
    'formas_pagamento',
    /^(?:quais (?:as|sao as) formas de pagamento|(?:voces )?aceita(?:m)? (?:pluxee|pix|cartao|vale refeicao|vale alimentacao))$/,
  ],
  [
    'pagar_na_entrega',
    /^(?:(?:posso|pode) pagar na entrega|(?:voces )?aceita(?:m)? (?:pagamento|pagar) na entrega)$/,
  ],
];

export function classifyFaq(text: string): FaqIntent | null {
  const question = normalizedQuestion(text);
  return QUESTIONS.find(([, pattern]) => pattern.test(question))?.[0] ?? null;
}

/** Resolution is pure and cannot authorize checkout or infer an unknown policy. */
export function faqResponse(
  intent: FaqIntent,
  text: string,
  config: Readonly<StoreFaqConfig> = STORE_FAQ
): { text: string; needsHandoff: boolean } {
  const key =
    intent === 'formas_pagamento' && /\bpluxee\b/.test(normalizedQuestion(text))
      ? 'pluxee'
      : intent;
  const answer = config[key];
  return typeof answer === 'string' && answer.trim()
    ? { text: answer, needsHandoff: false }
    : { text: STORE_FAQ_UNCONFIRMED, needsHandoff: true };
}
