/**
 * Flow de pedidos — La Empanadas.
 *
 * Fluxo conversacional completo para registrar um pedido pelo WhatsApp:
 *
 *   1. Boas-vindas + captura do nome do cliente.
 *   2. Escolha do tipo de recebimento (Delivery x Retirada).
 *   3a. Delivery  → captura de endereço → pagamento SEM dinheiro
 *       (Pix / Cartão / Mercado Pago).
 *   3b. Retirada  → pagamento COM dinheiro
 *       (Pix / Cartão / Dinheiro / Mercado Pago).
 *   4. Gravação das variáveis de controle (`tipo_entrega`, `forma_pagamento`).
 *   5. Execução da ação customizada `create_order_deal` para criação do card no pipeline.
 *   6. Confirmação final específica para cada forma de pagamento e handoff.
 *
 * Regras de negócio (La Empanadas):
 *   - Delivery é feito via 99/Uber, então o cliente paga ANTES
 *     (Pix, Cartão ou link do Mercado Pago). Dinheiro não é aceito.
 *   - Retirada no local aceita Dinheiro, Pix, Cartão e Mercado Pago.
 *
 * O nó de `custom_action` (com `create_order_deal`) dispara no backend a criação
 * do card de negociação na etapa/pipeline de pedidos. Em seguida, o nó de `handoff`
 * entrega a conversa ao atendente com o resumo do pedido na nota.
 *
 * ⚠️ O texto das mensagens segue o roteiro aprovado do La Empanadas —
 * altere com cuidado.
 */

import type { FlowTemplate } from './templates';
import type {
  CollectInputNodeConfig,
  CustomActionNodeConfig,
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  SetVarNodeConfig,
} from './types';

export const PEDIDO_EMPANADAS_FLOW: FlowTemplate = {
  slug: 'pedido_empanadas',
  name: 'Pedido de empanadas',
  description:
    'Dispara quando o cliente envia o carrinho pelo catálogo da Meta. Mostra o resumo do pedido e coleta tipo de entrega (delivery x retirada), endereço, forma de pagamento (Mercado Pago quando online) e confirmação. Delivery paga antes; retirada aceita dinheiro.',
  icon: 'MessageSquare',
  // Dispara automaticamente quando chega um pedido do catálogo da Meta
  // (mensagem do tipo `order`). O engine injeta nas variáveis do run:
  //   vars.itens_texto      → resumo legível do carrinho
  //   vars.total            → total em número (ex: 27.5)
  //   vars.total_formatado  → total formatado (ex: "R$ 27,50")
  //   vars.itens            → itens estruturados (SKU, quantidade, preço)
  trigger_type: 'catalog_order',
  trigger_config: {},
  entry_node_id: 'start',
  nodes: [
    {
      node_key: 'start',
      node_type: 'start',
      config: { next_node_key: 'mostrar_carrinho' },
    },

    // 0. Resumo do carrinho recebido pelo catálogo da Meta.
    {
      node_key: 'mostrar_carrinho',
      node_type: 'send_message',
      config: {
        text: '🫔 Recebemos seu pedido pelo catálogo!\n\n{{vars.itens_texto}}\n\nAgora vamos confirmar alguns dados para concluir. 👇',
        next_node_key: 'ask_name',
      } as SendMessageNodeConfig,
    },

    // 1. Captura do nome.
    {
      node_key: 'ask_name',
      node_type: 'collect_input',
      config: {
        prompt_text: 'Qual é o seu nome completo?',
        var_key: 'nome',
        next_node_key: 'ask_delivery_type',
      } as CollectInputNodeConfig,
    },

    // 2. Tipo de recebimento.
    {
      node_key: 'ask_delivery_type',
      node_type: 'send_buttons',
      config: {
        text: 'Obrigado, {{vars.nome}}! 😊\nComo prefere receber seu pedido?\n\n1️⃣ Delivery (entregamos via 99 ou Uber Entrega)\n2️⃣ Retirada no local\n\nDigite 1 ou 2:',
        buttons: [
          {
            reply_id: 'delivery',
            title: '1️⃣ Delivery',
            next_node_key: 'set_delivery_type_delivery',
          },
          {
            reply_id: 'retirada',
            title: '2️⃣ Retirada',
            next_node_key: 'set_delivery_type_retirada',
          },
        ],
      } as SendButtonsNodeConfig,
    },

    // Gravadores do tipo de recebimento
    {
      node_key: 'set_delivery_type_delivery',
      node_type: 'set_var',
      config: {
        var_key: 'tipo_entrega',
        value: 'delivery',
        next_node_key: 'ask_address',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'set_delivery_type_retirada',
      node_type: 'set_var',
      config: {
        var_key: 'tipo_entrega',
        value: 'retirada',
        next_node_key: 'ask_payment_retirada',
      } as SetVarNodeConfig,
    },

    // 3a. Delivery → endereço.
    {
      node_key: 'ask_address',
      node_type: 'collect_input',
      config: {
        prompt_text:
          'Ótimo! Qual é o endereço completo para entrega?\n(Rua, número, complemento e bairro)',
        var_key: 'endereco',
        next_node_key: 'ask_payment_delivery',
      } as CollectInputNodeConfig,
    },

    // 3a. Delivery → pagamento (sem dinheiro).
    {
      node_key: 'ask_payment_delivery',
      node_type: 'send_buttons',
      config: {
        text: 'Qual a forma de pagamento?\n\n1️⃣ Pix\n2️⃣ Cartão (débito/crédito)\n3️⃣ Mercado Pago (link de pagamento online)\n\n⚠️ Para delivery, não aceitamos pagamento em dinheiro.',
        buttons: [
          {
            reply_id: 'pix',
            title: '1️⃣ Pix',
            next_node_key: 'set_payment_pix',
          },
          {
            reply_id: 'cartao',
            title: '2️⃣ Cartão',
            next_node_key: 'set_payment_cartao_delivery',
          },
          {
            reply_id: 'mercado_pago',
            title: '3️⃣ Mercado Pago',
            next_node_key: 'set_payment_mercado_pago',
          },
        ],
      } as SendButtonsNodeConfig,
    },

    // 3b. Retirada → pagamento (com dinheiro; 4 opções via lista).
    {
      node_key: 'ask_payment_retirada',
      node_type: 'send_list',
      config: {
        text: 'Qual a forma de pagamento?\n\n1️⃣ Pix\n2️⃣ Cartão (débito/crédito)\n3️⃣ Dinheiro\n4️⃣ Mercado Pago (link de pagamento online)',
        button_label: 'Formas de pagamento',
        sections: [
          {
            rows: [
              {
                reply_id: 'pix',
                title: '1️⃣ Pix',
                next_node_key: 'set_payment_pix',
              },
              {
                reply_id: 'cartao',
                title: '2️⃣ Cartão',
                next_node_key: 'set_payment_cartao_retirada',
              },
              {
                reply_id: 'dinheiro',
                title: '3️⃣ Dinheiro',
                next_node_key: 'set_payment_dinheiro',
              },
              {
                reply_id: 'mercado_pago',
                title: '4️⃣ Mercado Pago',
                next_node_key: 'set_payment_mercado_pago',
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },

    // Sets de Forma de Pagamento
    {
      node_key: 'set_payment_pix',
      node_type: 'set_var',
      config: {
        var_key: 'forma_pagamento',
        value: 'pix',
        next_node_key: 'create_order_deal_node',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'set_payment_cartao_delivery',
      node_type: 'set_var',
      config: {
        var_key: 'forma_pagamento',
        value: 'cartao',
        next_node_key: 'create_order_deal_node',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'set_payment_cartao_retirada',
      node_type: 'set_var',
      config: {
        var_key: 'forma_pagamento',
        value: 'cartao',
        next_node_key: 'create_order_deal_node',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'set_payment_dinheiro',
      node_type: 'set_var',
      config: {
        var_key: 'forma_pagamento',
        value: 'dinheiro',
        next_node_key: 'create_order_deal_node',
      } as SetVarNodeConfig,
    },
    {
      node_key: 'set_payment_mercado_pago',
      node_type: 'set_var',
      config: {
        var_key: 'forma_pagamento',
        value: 'mercado_pago',
        next_node_key: 'create_order_deal_node',
      } as SetVarNodeConfig,
    },

    // Ação Customizada: cria o card de negociação
    {
      node_key: 'create_order_deal_node',
      node_type: 'custom_action',
      config: {
        action: 'create_order_deal',
        next_node_key: 'route_confirmation',
      } as CustomActionNodeConfig,
    },

    // Roteador de confirmação baseado na forma de pagamento
    {
      node_key: 'route_confirmation',
      node_type: 'condition',
      config: {
        subject: 'var',
        subject_key: 'forma_pagamento',
        operator: 'equals',
        value: 'pix',
        true_next: 'confirm_pix',
        false_next: 'route_confirmation_mercado_pago',
      },
    },
    {
      node_key: 'route_confirmation_mercado_pago',
      node_type: 'condition',
      config: {
        subject: 'var',
        subject_key: 'forma_pagamento',
        operator: 'equals',
        value: 'mercado_pago',
        true_next: 'confirm_mercado_pago',
        false_next: 'route_confirmation_delivery_vs_retirada',
      },
    },
    {
      node_key: 'route_confirmation_delivery_vs_retirada',
      node_type: 'condition',
      config: {
        subject: 'var',
        subject_key: 'tipo_entrega',
        operator: 'equals',
        value: 'delivery',
        true_next: 'confirm_cartao_delivery',
        false_next: 'confirm_pagamento_retirada',
      },
    },

    // 4. Confirmações.
    {
      node_key: 'confirm_pix',
      node_type: 'send_message',
      config: {
        text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com (ou chave: XX.XXX.XXX/XXXX-XX)\nValor: {{vars.total_formatado}}\n\nEnvie o comprovante aqui no chat para confirmarmos! 📲',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },
    {
      node_key: 'confirm_cartao_delivery',
      node_type: 'send_message',
      config: {
        text: '✅ Pedido registrado!\n💳 Pagamento na entrega.\nTempo estimado: 30-40 minutos. 🍽️',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },
    {
      node_key: 'confirm_pagamento_retirada',
      node_type: 'send_message',
      config: {
        text: '✅ Pedido registrado!\n💳 Pagamento na retirada.\nTempo estimado: 30-40 minutos. 🍽️',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },
    {
      node_key: 'confirm_mercado_pago',
      node_type: 'send_message',
      config: {
        text: '✅ Pedido registrado!\nTotal do pedido: {{vars.total_formatado}}\n\nGerando seu link de pagamento...\n🔗 {{vars.link_mercado_pago}}\n\nApós o pagamento confirmado, iniciaremos o preparo.\nTempo estimado: 30-40 minutos. 🍽️',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },

    // Entrega ao atendente com resumo do pedido para registro no pipeline.
    {
      node_key: 'handoff_pedido',
      node_type: 'handoff',
      config: {
        note: '🫔 Novo pedido (catálogo Meta) — Cliente: {{vars.nome}}.\nItens: {{vars.itens_texto}}\nTotal: {{vars.total_formatado}}\nEndereço (se delivery): {{vars.endereco}}.\nConfira a forma de pagamento na conversa e registre o pedido no pipeline "Pedidos Delivery".',
      } as HandoffNodeConfig,
    },
  ],
};
