/**
 * Modelos de mensagem WhatsApp do La Empanadas.
 *
 * Mensagens pré-prontas para cada etapa do pipeline de pedidos e para
 * campanhas de recompra. Use os placeholders {nome_cliente},
 * {numero_pedido} e [link] — substitua ao enviar. Formatação em
 * *negrito* segue o padrão do WhatsApp.
 */

export interface MessageTemplate {
  /** Identificador estável. */
  id: string;
  /** Título exibido na UI. */
  title: string;
  /** Emoji ilustrativo. */
  emoji: string;
  /** Corpo da mensagem, com placeholders. */
  body: string;
}

export const WHATSAPP_MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    id: 'novo-pedido',
    title: 'Novo Pedido recebido',
    emoji: '🫔',
    body: `🫔 *La Empanadas*
Olá {nome_cliente}! Recebemos seu pedido #{numero_pedido}.
Estamos verificando a disponibilidade e confirmaremos em instantes.
Obrigado pela preferência! 🙏`,
  },
  {
    id: 'confirmado',
    title: 'Pedido Confirmado',
    emoji: '✅',
    body: `✅ *La Empanadas*
Ótimas notícias, {nome_cliente}! Seu pedido #{numero_pedido} foi confirmado!
🧑‍🍳 Nossas empanadas já estão sendo preparadas com todo carinho.
Tempo estimado: 30-40 minutos.`,
  },
  {
    id: 'saiu-entrega',
    title: 'Saiu para Entrega',
    emoji: '🛵',
    body: `🛵 *La Empanadas*
{nome_cliente}, seu pedido #{numero_pedido} saiu para entrega!
O motoboy está a caminho. Fique atento ao interfone/portão.
Qualquer dúvida, estamos aqui! 😊`,
  },
  {
    id: 'entregue',
    title: 'Pedido Entregue',
    emoji: '🎉',
    body: `🎉 *La Empanadas*
Esperamos que esteja delicioso, {nome_cliente}!
Avalie nossa entrega e nos diga como foi.
Obrigado pela preferência! Até a próxima 🫔❤️`,
  },
  {
    id: 'cancelado',
    title: 'Pedido Cancelado',
    emoji: '😔',
    body: `😔 *La Empanadas*
{nome_cliente}, infelizmente seu pedido #{numero_pedido} foi cancelado.
Pedimos desculpas pelo inconveniente.
Entre em contato para mais informações ou para realizar um novo pedido.`,
  },
  {
    id: 'recompra',
    title: 'Lembrete de recompra (Campanha)',
    emoji: '🫔',
    body: `🫔 *La Empanadas*
Olá {nome_cliente}! Já faz um tempinho que não te vemos por aqui.
Que tal pedir suas empanadas favoritas hoje?
Nosso cardápio completo: [link]
Estamos esperando você! 😋`,
  },
];
