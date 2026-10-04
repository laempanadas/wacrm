import { describe, it, expect } from 'vitest';
import { PEDIDO_EMPANADAS_FLOW } from './pedido-empanadas-flow';
import { validateFlowForActivation } from './validate';

describe('PEDIDO_EMPANADAS_FLOW template', () => {
  it('is triggered by a catalog order', () => {
    expect(PEDIDO_EMPANADAS_FLOW.trigger_type).toBe('catalog_order');
  });

  it('has a valid entry node that exists among its nodes', () => {
    const keys = PEDIDO_EMPANADAS_FLOW.nodes.map((n) => n.node_key);
    expect(keys).toContain(PEDIDO_EMPANADAS_FLOW.entry_node_id);
  });

  const node = (key: string) =>
    PEDIDO_EMPANADAS_FLOW.nodes.find((n) => n.node_key === key);

  // Walks next_node_key from a node, following `pick` at button nodes.
  const path = (from: string): string[] => {
    const keys: string[] = [];
    let key: string | undefined = from;
    while (key && !keys.includes(key)) {
      keys.push(key);
      const cfg = node(key)?.config as Record<string, unknown> | undefined;
      key = cfg?.next_node_key as string | undefined;
    }
    return keys;
  };
  const text = (keys: string[]) =>
    keys.map((k) => JSON.stringify(node(k)?.config)).join('\n');

  it('shows the cart and asks delivery vs pickup in a single message with exact required text and buttons', () => {
    const cartNode = node('pedido_recebido');
    expect(cartNode?.node_type).toBe('send_buttons');
    const cfg = cartNode!.config as {
      text: string;
      buttons: Array<{
        reply_id: string;
        title: string;
        next_node_key: string;
      }>;
    };
    expect(cfg.text).toBe(
      '🫔 *Pedido recebido!* ({{vars.total_formatado}})\n{{vars.itens_lista}}\n\nComo prefere receber?'
    );
    expect(cfg.buttons).toEqual([
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
    ]);
  });

  it('does not ask for the name (it comes from the WhatsApp profile)', () => {
    const collected = PEDIDO_EMPANADAS_FLOW.nodes
      .filter((n) => n.node_type === 'collect_input')
      .map((n) => (n.config as { var_key: string }).var_key);
    expect(collected).toEqual(['endereco']);
  });

  it('delivery collects the address and sends the Mercado Pago link with required confirmation message', () => {
    const keys = path('ask_endereco');
    expect(keys).toContain('gerar_pagamento');
    expect(text(keys)).toContain('{{vars.link_mercado_pago}}');
    expect(JSON.stringify(node('set_delivery')!.config)).toContain(
      '"value":"delivery"'
    );

    const paymentMsgNode = node('link_pagamento');
    const pCfg = paymentMsgNode!.config as { text: string };
    expect(pCfg.text).toBe(
      '🫔 *Pedido Confirmado!*\n{{vars.itens_lista}}\n💵 *Total: {{vars.total_formatado}}*\n📍 *Entrega:* {{vars.endereco}}\n\n💳 *Pague online com Pix ou Cartão pelo link abaixo:*\n{{vars.link_mercado_pago}}\n\nAssim que o pagamento for aprovado, seu pedido entra automaticamente em preparo!'
    );
  });

  it('offers the last address to returning customers with exact required prompt and buttons', () => {
    const cond = node('tem_endereco_salvo')!.config as Record<string, string>;
    expect(cond.subject_key).toBe('ultimo_endereco');
    expect(cond.operator).toBe('present');
    expect(cond.false_next).toBe('ask_endereco');

    const askNode = node(cond.true_next);
    const ask = askNode!.config as {
      text: string;
      buttons: Array<{
        reply_id: string;
        title: string;
        next_node_key: string;
      }>;
    };
    expect(ask.text).toBe(
      '📍 Entregar no endereço cadastrado?\n_{{vars.ultimo_endereco}}_'
    );
    expect(ask.buttons).toEqual([
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
    ]);

    const askEnderecoNode = node('ask_endereco');
    const askAddrCfg = askEnderecoNode!.config as {
      prompt_text: string;
      var_key: string;
    };
    expect(askAddrCfg.prompt_text).toBe(
      '📍 Por favor, digite seu endereço de entrega (Rua, Número e Bairro):'
    );
    expect(askAddrCfg.var_key).toBe('endereco');

    const reuse = node('usar_ultimo_endereco')!.config as Record<
      string,
      string
    >;
    expect(reuse.var_key).toBe('endereco');
    expect(reuse.value).toBe('{{vars.ultimo_endereco}}');
    expect(reuse.next_node_key).toBe('gerar_pagamento');
  });

  it('pickup is paid at the store — no payment link', () => {
    const keys = path('set_retirada');
    expect(keys).toContain('registrar_retirada');
    expect(text(keys)).not.toContain('link_mercado_pago');
    expect(JSON.stringify(node('set_retirada')!.config)).toContain(
      '"value":"retirada"'
    );
  });

  it('passes flow validation for activation with no errors', () => {
    const issues = validateFlowForActivation(
      {
        name: PEDIDO_EMPANADAS_FLOW.name,
        trigger_type: PEDIDO_EMPANADAS_FLOW.trigger_type,
        trigger_config: PEDIDO_EMPANADAS_FLOW.trigger_config as Record<
          string,
          unknown
        >,
        entry_node_id: PEDIDO_EMPANADAS_FLOW.entry_node_id,
      },
      PEDIDO_EMPANADAS_FLOW.nodes.map((n) => ({
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config as Record<string, unknown>,
      }))
    );
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });
});
