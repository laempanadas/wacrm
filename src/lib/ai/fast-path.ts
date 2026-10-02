/**
 * Zero-Token Fast Path for common queries.
 * Intercepts frequent patterns before calling the LLM, saving tokens and latency.
 * Normalized matching: lowercase + removes diacritics.
 */

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
      response: 'Boa noite! Sim, estamos sim! 🥟 O que vai querer pedir hoje? Nosso cardápio está aqui: https://www.laempanadas.com.br/',
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
      response: '🥟 *La Empanadas*\n\n📱 Veja nosso cardápio completo:\nhttps://www.laempanadas.com.br/\n\nOu manda uma mensagem dizendo o que quer que a gente te ajuda! 😊',
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
      response: '🥟 *La Empanadas*\n\n📱 Veja nosso cardápio completo:\nhttps://www.laempanadas.com.br/\n\nOu manda uma mensagem dizendo o que quer que a gente te ajuda! 😊',
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
      response: '💳 *Formas de Pagamento:*\n\n✅ *Pix* (aprovação imediata)\n✅ *Cartão de Crédito*\n✅ *Dinheiro na entrega*\n\nVocê receberá o link para pagar assim que confirmarmos seu pedido. Qualquer dúvida, me chama! 🥟',
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
      response: '🕐 *Horário de Funcionamento:*\n\n⏰ Segunda a Domingo\n📍 19h às 00h (meia-noite)\n\nVocê pode fazer seu pedido agora! 🥟',
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
