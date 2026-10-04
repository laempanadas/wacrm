/**
 * Zero-Token Fast Path for common queries.
 * Intercepts frequent patterns before calling the LLM, saving tokens and latency.
 * Normalized matching: lowercase + removes diacritics.
 *
 * COST-OPTIMIZATION: Uses condensed delivery templates to minimize per-message charges
 * from Meta WhatsApp Cloud API. Each response is a complete, self-contained message.
 */

import {
  TEMPLATE_ATENDIMENTO_CARDAPIO,
  TEMPLATE_HORARIO_FUNCIONAMENTO,
  TEMPLATE_FORMAS_PAGAMENTO,
} from '@/lib/orders/delivery-templates'
import { hasOrderIntent } from '@/lib/orders/text-order-parser'

export { hasOrderIntent }

export interface FastPathMatch {
  matched: boolean
  response: string | null
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

function matchesPatterns(text: string, patterns: string[]): boolean {
  const normalized = normalizeText(text)
  return patterns.some((p) => normalized.includes(p))
}

/**
 * Check if the message matches a zero-token pattern.
 * Returns the precompiled response if matched, otherwise null.
 */
export function checkZeroTokenMatch(messageText: string): FastPathMatch {
  if (!messageText || messageText.trim().length === 0) {
    return { matched: false, response: null }
  }

  // Se a mensagem contiver indicativos de pedido, NÃO dispara o fast-path!
  // Permite que o processador de pedidos trate a mensagem adequadamente.
  if (hasOrderIntent(messageText)) {
    return { matched: false, response: null }
  }

  const normalized = normalizeText(messageText)

  // PADRÃO 1: Status/Atendimento ("Estão atendendo?", "Aberto?", "Boa noite")
  if (matchesPatterns(messageText, [
    'estao atendendo',
    'estao abertos',
    'voces estao',
    'aberto',
    'esta aberto',
    'tá aberto',
    'ta aberto',
    'boa noite',
    'boa tarde',
    'bom dia',
    'ola',
    'olá',
    'oi',
  ])) {
    return {
      matched: true,
      response: TEMPLATE_ATENDIMENTO_CARDAPIO,
    }
  }

  // PADRÃO 2: Cardápio/Menu/Sabores
  // Ordem importa: verifica patterns mais específicos primeiro
  if (matchesPatterns(messageText, [
    'cardapio',
    'cardápio',
    'menu',
    'sabores',
    'quais sao',
    'quais são',
    'o que voces tem',
    'o que tem',
    'opcoes',
    'opções',
  ])) {
    // Exclui se é pergunta sobre horário/pagamento
    if (normalized.includes('hora') || normalized.includes('paga') || normalized.includes('pix')) {
      return { matched: false, response: null }
    }
    return {
      matched: true,
      response: TEMPLATE_ATENDIMENTO_CARDAPIO,
    }
  }

  // Fallback: "empanad" apenas se for pergunta genérica sobre empanadas
  if (normalized.includes('empanad') &&
      !normalized.includes('pedir') &&
      !normalized.includes('quantidade') &&
      !normalized.includes('quantas') &&
      !normalized.includes('quero')) {
    return {
      matched: true,
      response: TEMPLATE_ATENDIMENTO_CARDAPIO,
    }
  }

  // PADRÃO 3: Pagamento/Pix/Mercado Pago
  if (matchesPatterns(messageText, [
    'chave pix',
    'pix',
    'pagamento',
    'como pago',
    'como pagar',
    'como pagamos',
    'qual o pix',
    'qual o link',
    'manda o link',
    'manda link',
    'link pagamento',
    'mercado pago',
    'cartao',
    'cartão',
    'credito',
    'crédito',
    'debito',
    'débito',
  ])) {
    return {
      matched: true,
      response: TEMPLATE_FORMAS_PAGAMENTO,
    }
  }

  // PADRÃO 4: Horário/Funcionamento
  if (matchesPatterns(messageText, [
    'horario',
    'horário',
    'ate que horas',
    'até que horas',
    'que horas',
    'funciona',
    'funciona ate',
    'funciona até',
    'qual hora',
    'fecha',
    'abre',
  ])) {
    return {
      matched: true,
      response: TEMPLATE_HORARIO_FUNCIONAMENTO,
    }
  }

  return { matched: false, response: null }
}

/**
 * Optionally load zero-token responses from a database or external config.
 * For now, responses are hardcoded in checkZeroTokenMatch.
 * This stub allows future extension without changing the auto-reply logic.
 */
export async function loadZeroTokenResponses(): Promise<void> {
  // Placeholder for future config-driven responses
}
