/**
 * Flow de Pedidos Otimizado — La Empanadas
 *
 * Jornada do Pedido:
 *   1. Recebe o carrinho do catálogo da Meta com itens e total.
 *   2. Coleta o nome e endereço de entrega.
 *   3. Gera link seguro do Mercado Pago (Pix / Cartão).
 *   4. Registra no CRM e aguarda confirmação de pagamento.
 */

import type { FlowTemplate } from './templates';
import type {
  CollectInputNodeConfig,
  CustomActionNodeConfig,
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendMessageNodeConfig,
} from './types';

export const PEDIDO_EMPANADAS_FLOW: FlowTemplate = {
  slug: 'pedido_empanadas',
  name: 'Pedido de Empanadas — Catálogo Meta',
  description:
    'Dispara quando o cliente envia a sacola do catálogo. Confirma endereço, gera link do Mercado Pago e registra o pedido.',
  icon: 'MessageSquare',
  trigger_type: 'catalog_order',
  trigger_config: {},
  entry_node_id: 'start',
  nodes: [
    {
      node_key: 'start',
      node_type: 'start' as const,
      config: { next_node_key: 'resumo_pedido' },
    },

    // 1. Resumo claro dos itens recebidos
    {
      node_key: 'resumo_pedido',
      node_type: 'send_message' as const,
      config: {
        text: '🫔 *Pedido recebido com sucesso!*\n\n{{vars.itens_texto}}\n\n💵 *Total:* {{vars.total_formatado}}\n\nPara concluirmos a entrega, vamos confirmar dois dados rápidos! 👇',
        next_node_key: 'ask_nome',
      } as SendMessageNodeConfig,
    },

    // 2. Coleta do Nome
    {
      node_key: 'ask_nome',
      node_type: 'collect_input' as const,
      config: {
        prompt_text: 'Qual é o seu *nome completo*?',
        var_key: 'nome',
        next_node_key: 'ask_tipo_entrega',
      } as CollectInputNodeConfig,
    },

    // 3. Escolha: Delivery ou Retirada
    {
      node_key: 'ask_tipo_entrega',
      node_type: 'send_buttons' as const,
      config: {
        text: 'Prazer, *{{vars.nome}}*! 😊\nComo deseja receber suas empanadas?',
        buttons: [
          {
            reply_id: 'delivery',
            title: '🛵 Delivery',
            next_node_key: 'ask_endereco',
          },
          {
            reply_id: 'retirada',
            title: '🛍️ Retirada no Local',
            next_node_key: 'confirm_retirada',
          },
        ],
      } as SendButtonsNodeConfig,
    },

    // 4a. Se Delivery: Pede endereço completo
    {
      node_key: 'ask_endereco',
      node_type: 'collect_input' as const,
      config: {
        prompt_text:
          '📍 Por favor, digite o *endereço completo de entrega*:\n(Rua, número, complemento e bairro)',
        var_key: 'endereco',
        next_node_key: 'gerar_pagamento_delivery',
      } as CollectInputNodeConfig,
    },

    // 4b. Se Retirada: Informa endereço da loja
    {
      node_key: 'confirm_retirada',
      node_type: 'send_message' as const,
      config: {
        text: 'Perfeito! Nosso endereço para retirada:\n📍 *Av. Industrial, 750*\nTempo estimado de preparo: 20-30 minutos.',
        next_node_key: 'gerar_pagamento_retirada',
      } as SendMessageNodeConfig,
    },

    // 5. Ação Backend: Cria card no Pipeline e gera Checkout Mercado Pago
    {
      node_key: 'gerar_pagamento_delivery',
      node_type: 'custom_action' as const,
      config: {
        action: 'create_order_deal',
        next_node_key: 'mensagem_link_pagamento',
      } as CustomActionNodeConfig,
    },
    {
      node_key: 'gerar_pagamento_retirada',
      node_type: 'custom_action' as const,
      config: {
        action: 'create_order_deal',
        next_node_key: 'mensagem_link_pagamento',
      } as CustomActionNodeConfig,
    },

    // 6. Mensagem com o Link do Mercado Pago
    {
      node_key: 'mensagem_link_pagamento',
      node_type: 'send_message' as const,
      config: {
        text: '✅ *Tudo pronto para o preparo!*\n\nTotal do pedido: *{{vars.total_formatado}}*\n\nPara iniciarmos a produção na cozinha, realize o pagamento no link seguro abaixo (*Pix ou Cartão*):\n\n👉 {{vars.link_mercado_pago}}\n\nAssim que o pagamento for aprovado, seu pedido entra automaticamente em produção! 🥟🔥',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },

    // 7. Notifica o atendente humano no CRM
    {
      node_key: 'handoff_pedido',
      node_type: 'handoff' as const,
      config: {
        note: '🫔 Novo pedido via Catálogo Meta — Cliente: {{vars.nome}} | Total: {{vars.total_formatado}} | Endereço: {{vars.endereco}}.',
      } as HandoffNodeConfig,
    },
  ],
};
