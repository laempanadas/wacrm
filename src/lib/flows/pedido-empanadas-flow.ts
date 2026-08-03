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
 *   4. Confirmação final específica para cada forma de pagamento.
 *
 * Regras de negócio (La Empanadas):
 *   - Delivery é feito via 99/Uber, então o cliente paga ANTES
 *     (Pix, Cartão ou link do Mercado Pago). Dinheiro não é aceito.
 *   - Retirada no local aceita Dinheiro, Pix, Cartão e Mercado Pago.
 *
 * Este é um TEMPLATE conversacional (mesma forma dos demais em
 * `templates.ts`) — usa apenas os tipos de nó já suportados pelo
 * engine (start / send_message / collect_input / send_buttons /
 * send_list / handoff). O engine de flows não cria negociações; a
 * criação automática do card no pipeline "Pedidos Delivery" é feita
 * pelo endpoint `/api/orders` (veja `src/lib/orders/create-order.ts`),
 * que o frontend/automação chama ao final do fluxo com os dados
 * coletados (nome, tipo, endereço, forma de pagamento e valor).
 *
 * O nó de `handoff` final entrega a conversa a um atendente com um
 * resumo do pedido na nota, para conferência e registro.
 *
 * ⚠️ O texto das mensagens segue o roteiro aprovado do La Empanadas —
 * altere com cuidado.
 */

import type { FlowTemplate } from './templates';
import type {
  CollectInputNodeConfig,
  HandoffNodeConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
} from './types';

export const PEDIDO_EMPANADAS_FLOW: FlowTemplate = {
  slug: 'pedido_empanadas',
  name: 'Pedido de empanadas',
  description:
    'Registra pedidos pelo WhatsApp: boas-vindas, tipo de entrega (delivery x retirada), endereço, forma de pagamento (Mercado Pago quando online) e confirmação. Delivery paga antes; retirada aceita dinheiro.',
  icon: 'MessageSquare',
  trigger_type: 'first_inbound_message',
  trigger_config: {},
  entry_node_id: 'start',
  nodes: [
    {
      node_key: 'start',
      node_type: 'start',
      config: { next_node_key: 'ask_name' },
    },

    // 1. Boas-vindas + captura do nome.
    {
      node_key: 'ask_name',
      node_type: 'collect_input',
      config: {
        prompt_text:
          '🫔 Olá! Bem-vindo à La Empanadas!\nPara registrar seu pedido, preciso de algumas informações.\nQual é o seu nome completo?',
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
            next_node_key: 'ask_address',
          },
          {
            reply_id: 'retirada',
            title: '2️⃣ Retirada',
            next_node_key: 'ask_payment_retirada',
          },
        ],
      } as SendButtonsNodeConfig,
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
            next_node_key: 'confirm_pix',
          },
          {
            reply_id: 'cartao',
            title: '2️⃣ Cartão',
            next_node_key: 'confirm_cartao_delivery',
          },
          {
            reply_id: 'mercado_pago',
            title: '3️⃣ Mercado Pago',
            next_node_key: 'confirm_mercado_pago',
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
                next_node_key: 'confirm_pix',
              },
              {
                reply_id: 'cartao',
                title: '2️⃣ Cartão',
                next_node_key: 'confirm_pagamento_retirada',
              },
              {
                reply_id: 'dinheiro',
                title: '3️⃣ Dinheiro',
                next_node_key: 'confirm_pagamento_retirada',
              },
              {
                reply_id: 'mercado_pago',
                title: '4️⃣ Mercado Pago',
                next_node_key: 'confirm_mercado_pago',
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },

    // 4. Confirmações.
    {
      node_key: 'confirm_pix',
      node_type: 'send_message',
      config: {
        text: '✅ Pedido registrado!\n💚 Pix: laempanadas@email.com (ou chave: XX.XXX.XXX/XXXX-XX)\nValor: R$ {{vars.valor_total}}\n\nEnvie o comprovante aqui no chat para confirmarmos! 📲',
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
        text: '✅ Pedido registrado! Gerando seu link de pagamento...\n🔗 {{vars.link_mercado_pago}}\n\nApós o pagamento confirmado, iniciaremos o preparo.\nTempo estimado: 30-40 minutos. 🍽️',
        next_node_key: 'handoff_pedido',
      } as SendMessageNodeConfig,
    },

    // Entrega ao atendente com resumo do pedido para registro no pipeline.
    {
      node_key: 'handoff_pedido',
      node_type: 'handoff',
      config: {
        note: '🫔 Novo pedido — Cliente: {{vars.nome}}. Endereço (se delivery): {{vars.endereco}}. Confira a forma de pagamento na conversa e registre o pedido no pipeline "Pedidos Delivery".',
      } as HandoffNodeConfig,
    },
  ],
};
