/**
 * delivery-templates.ts
 *
 * Módulo de templates padronizados e condensados para otimizar custos com Meta WhatsApp.
 * Implementa a estratégia CONDENSAÇÃO DE MENSAGENS:
 * - Máximo 2 mensagens por pedido
 * - Templates enxutos e diretos
 * - Links únicos para reduzir fragmentação
 *
 * Integra com a estratégia de Cost-Cap da Meta:
 * - Evita multi-part messages
 * - Agrupa informações essenciais
 * - Respeita limites de auto-reply
 */

/**
 * Template para saudação inicial com link de cardápio.
 * Usado no fast-path para atender pedidos de cardápio/menu.
 */
export const TEMPLATE_ATENDIMENTO_CARDAPIO = `🥟 *La Empanadas Argentinas*

Estamos atendendo! Faça seu pedido direto pelo nosso cardápio:
👉 https://www.laempanadas.com.br/

Ou nos envie seu pedido por aqui que já agilizamos para você!`;

/**
 * Template para confirmação de pagamento e entrada do pedido na cozinha.
 * Trigger: Mercado Pago aprovado / Deal movido para estágio "Na Cozinha"
 */
export const TEMPLATE_PEDIDO_NA_COZINHA = `✅ *Pagamento Confirmado!*

🥟 Seu pedido já está no forno sendo preparado com muito carinho.
Em breve avisamos quando o entregador sair!`;

/**
 * Template para notificação de saída do entregador.
 * Trigger: Deal movido para "Pronto para Entrega" ou "Saiu para Entrega"
 */
export const TEMPLATE_SAIU_ENTREGA = `🛵💨 *Pedido a Caminho!*

Seu pedido acabou de sair com o entregador e logo chega aí quentinho.
Bom apetite!`;

/**
 * Template de fallback quando o bot atinge limite de mensagens automáticas.
 * Envia apenas o link do cardápio sem consumir mais tokens.
 * Trigger: autoReplyMaxPerConversation atingido
 */
export const TEMPLATE_LIMIT_REACHED = `👋 Obrigado por nos contactar!

Visite nosso cardápio: https://www.laempanadas.com.br/

Um agente responderá em breve. 🥟`;

/**
 * Template para respostas sobre horário de funcionamento.
 * Usado no fast-path para economizar tokens em perguntas frequentes.
 */
export const TEMPLATE_HORARIO_FUNCIONAMENTO = `🕐 *Horário de Funcionamento:*

⏰ Segunda a Domingo
📍 19h às 00h (meia-noite)

Você pode fazer seu pedido agora! 🥟`;

/**
 * Template para respostas sobre formas de pagamento.
 * Usado no fast-path para economizar tokens.
 */
export const TEMPLATE_FORMAS_PAGAMENTO = `💳 *Formas de Pagamento:*

✅ *Pix* (aprovação imediata)
✅ *Cartão de Crédito*
✅ *Dinheiro na entrega*

Você receberá o link para pagar assim que confirmarmos seu pedido.
Qualquer dúvida, me chama! 🥟`;

/**
 * Tipagem para templates de delivery.
 * Garante que todos os templates seguem a mesma estrutura.
 */
export type DeliveryTemplate = typeof TEMPLATE_ATENDIMENTO_CARDAPIO;

/**
 * Todos os templates disponíveis mapeados por chave.
 */
export const DELIVERY_TEMPLATES = {
  cardapio: TEMPLATE_ATENDIMENTO_CARDAPIO,
  pedido_na_cozinha: TEMPLATE_PEDIDO_NA_COZINHA,
  saiu_entrega: TEMPLATE_SAIU_ENTREGA,
  limit_reached: TEMPLATE_LIMIT_REACHED,
  horario: TEMPLATE_HORARIO_FUNCIONAMENTO,
  pagamento: TEMPLATE_FORMAS_PAGAMENTO,
} as const;

export type TemplateKey = keyof typeof DELIVERY_TEMPLATES;

/**
 * Função auxiliar para obter um template pelo nome.
 * Facilita extensibilidade futura (carregar de DB).
 */
export function getTemplate(key: TemplateKey): string {
  return DELIVERY_TEMPLATES[key];
}

/**
 * Valida se uma chave é um template válido.
 */
export function isValidTemplateKey(key: string): key is TemplateKey {
  return key in DELIVERY_TEMPLATES;
}
