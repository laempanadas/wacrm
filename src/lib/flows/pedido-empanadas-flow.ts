/**
 * src/lib/flows/pedido-empanadas-flow.ts
 *
 * Flow de Pedidos — La Empanadas (Catálogo Meta)
 *
 * Jornada enxuta, sem perguntas repetidas:
 *   1. Recebe o carrinho e, na MESMA mensagem, mostra itens + total e
 *      pergunta Delivery ou Retirada. O nome vem do perfil do WhatsApp.
 *   2a. Delivery: oferece o último endereço (botão "Mesmo endereço")
 *       ou pede um novo → gera o link do Mercado Pago (pagamento
 *       somente online) → envia o link.
 *   2b. Retirada: registra o pedido e confirma, com pagamento na loja
 *       (sem link, sem lembrete de pagamento).
 *   3. Notifica a equipe (handoff) com o resumo do pedido.
 */

import type { FlowTemplate } from './templates';
import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  CustomActionNodeConfig,
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendMessageNodeConfig,
  SetVarNodeConfig,
} from './types';

export const PEDIDO_EMPANADAS_FLOW: FlowTemplate = {
  slug: 'pedido_empanadas',
  name: 'Pedido de Empanadas — Catálogo Meta',
  description:
    'Dispara quando o cliente envia a sacola do catálogo. Delivery: pede o endereço e envia o link do Mercado Pago. Retirada: confirma com pagamento na loja.',
  icon: 'MessageSquare',
  trigger_type: 'catalog_order',
  trigger_config: {},
  entry_node_id: 'start',
  nodes: [
    {
      node_key: 'start',
      node_type: 'start' as const,
      config: { next_node_key: 'pedido_recebido' },
    },

    // 1. Resumo + escolha de entrega numa única mensagem
    {
      node_key: 'pedido_recebido',
      node_type: 'send_buttons' as const,
      config: {
        text: '🫔 *Pedido recebido!* ({{vars.total_formatado}})\n{{vars.itens_lista}}\n\nComo prefere receber?',
        buttons: [
          {
            reply_id: 'delivery',
            title: '🛵 Delivery',
            next_node_key: 'set_delivery',
          },
          {
            reply_id: 'retirada',
            title: '🛍️ Retirar na loja',
            next_node_key: 'set_retirada',
          },
        ],
      } as SendButtonsNodeConfig,
    },

    // 2a. Delivery — pagamento somente online
    {
      node_key: 'set_delivery',
      node_type: 'set_var' as const,
      config: {
        var_key: 'tipo_entrega',
        value: 'delivery',
        next_node_key: 'tem_endereco_salvo',
      } as SetVarNodeConfig,
    },
    {
      // Cliente que já pediu antes: oferece o último endereço de entrega.
      node_key: 'tem_endereco_salvo',
      node_type: 'condition' as const,
      config: {
        subject: 'var',
        subject_key: 'ultimo_endereco',
        operator: 'present',
        true_next: 'ask_mesmo_endereco',
        false_next: 'ask_endereco',
      } as ConditionNodeConfig,
    },
    {
      node_key: 'ask_mesmo_endereco',
      node_type: 'send_buttons' as const,
      config: {
        text: '📍 Entregar no endereço cadastrado?\n_{{vars.ultimo_endereco}}_',
        buttons: [
          {
            reply_id: 'mesmo_endereco',
            title: '✅ Confirmar',
            next_node_key: 'usar_ultimo_endereco',
          },
          {
            reply_id: 'outro_endereco',
            title: '✏️ Outro endereço',
            next_node_key: 'ask_endereco',
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: 'usar_ultimo_endereco',
      node_type: 'set_var' as const,
      config: {
        var_key: 'endereco',
        value: '{{vars.ultimo_endereco}}',
        next_node_key: 'confirmar_delivery',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'ask_endereco',
      node_type: 'collect_input' as const,
      config: {
        prompt_text:
          '📍 Por favor, digite seu endereço de entrega (Rua, Número e Bairro):',
        var_key: 'endereco',
        next_node_key: 'confirmar_delivery',
      } as CollectInputNodeConfig,
    },
    {
      node_key: 'confirmar_delivery',
      node_type: 'send_buttons',
      config: {
        text: 'Confira seu pedido antes do pagamento:\n{{vars.itens_lista}}\nTotal: {{vars.total_formatado}}\nEntrega: {{vars.endereco}}\nObservações: {{vars.observacoes}}\nPagamento online via Mercado Pago. Confirmar?',
        buttons: [
          {
            reply_id: 'confirmar_pedido',
            title: 'Confirmar pedido',
            next_node_key: 'set_confirmado_delivery',
          },
          {
            reply_id: 'corrigir_pedido',
            title: 'Corrigir pedido',
            next_node_key: 'handoff_correcao',
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: 'set_confirmado_delivery',
      node_type: 'set_var',
      config: {
        var_key: 'pedido_confirmado',
        value: 'true',
        next_node_key: 'gerar_pagamento',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'confirmar_retirada',
      node_type: 'send_buttons',
      config: {
        text: 'Confira seu pedido:\n{{vars.itens_lista}}\nTotal: {{vars.total_formatado}}\nRetirada na loja — pagamento na retirada.\nObservações: {{vars.observacoes}}\nConfirmar?',
        buttons: [
          {
            reply_id: 'confirmar_pedido',
            title: 'Confirmar pedido',
            next_node_key: 'set_confirmado_retirada',
          },
          {
            reply_id: 'corrigir_pedido',
            title: 'Corrigir pedido',
            next_node_key: 'handoff_correcao',
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: 'set_confirmado_retirada',
      node_type: 'set_var',
      config: {
        var_key: 'pedido_confirmado',
        value: 'true',
        next_node_key: 'registrar_retirada',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'handoff_correcao',
      node_type: 'handoff',
      config: {
        note: 'Revisar pedido antes de cobrar: {{vars.itens_texto}} | Observações: {{vars.observacoes}} | Endereço: {{vars.endereco}}',
      } as HandoffNodeConfig,
    },
    {
      // Cria o card no pipeline, o pedido em `orders` e o link do
      // Mercado Pago (vars.link_mercado_pago). Sem link, o engine avisa
      // o cliente e transfere para um atendente.
      node_key: 'gerar_pagamento',
      node_type: 'custom_action' as const,
      config: {
        action: 'create_order_deal',
        next_node_key: 'link_pagamento',
      } as CustomActionNodeConfig,
    },
    {
      node_key: 'link_pagamento',
      node_type: 'send_message' as const,
      config: {
        text: '🫔 *Pedido confirmado!*\n{{vars.itens_lista}}\nTotal: {{vars.total_formatado}}\nEntrega: {{vars.endereco}}\nObservações: {{vars.observacoes}}\n\nPague com Pix ou cartão pelo botão abaixo. Após a aprovação, seu pedido entra em preparo.',
        next_node_key: 'handoff_delivery',
      } as SendMessageNodeConfig,
    },
    {
      node_key: 'handoff_delivery',
      node_type: 'handoff' as const,
      config: {
        note: '🛵 Pedido DELIVERY (aguardando pagamento online) — Cliente: {{vars.nome}} | Total: {{vars.total_formatado}} | Endereço: {{vars.endereco}}',
      } as HandoffNodeConfig,
    },

    // 2b. Retirada — pagamento na loja, sem link
    {
      node_key: 'set_retirada',
      node_type: 'set_var' as const,
      config: {
        var_key: 'tipo_entrega',
        value: 'retirada',
        next_node_key: 'confirmar_retirada',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'registrar_retirada',
      node_type: 'custom_action' as const,
      config: {
        action: 'create_order_deal',
        next_node_key: 'confirm_retirada',
      } as CustomActionNodeConfig,
    },
    {
      node_key: 'confirm_retirada',
      node_type: 'send_message' as const,
      config: {
        text: '✅ *Pedido confirmado!*\n\n📍 Retire na *Av. Industrial, 750*\n⏱️ Fica pronto em 20-30 minutos\n💵 Pagamento na retirada: *{{vars.total_formatado}}*',
        next_node_key: 'handoff_retirada',
      } as SendMessageNodeConfig,
    },
    {
      node_key: 'handoff_retirada',
      node_type: 'handoff' as const,
      config: {
        note: '🛍️ Pedido RETIRADA (pagar na loja) — Cliente: {{vars.nome}} | Total: {{vars.total_formatado}}',
      } as HandoffNodeConfig,
    },
  ],
};
