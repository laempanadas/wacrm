import { describe, it, expect } from "vitest";
import { PEDIDO_EMPANADAS_FLOW } from "./pedido-empanadas-flow";
import { validateFlowForActivation } from "./validate";

describe("PEDIDO_EMPANADAS_FLOW template", () => {
  it("is triggered by a catalog order", () => {
    expect(PEDIDO_EMPANADAS_FLOW.trigger_type).toBe("catalog_order");
  });

  it("has a valid entry node that exists among its nodes", () => {
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
    keys.map((k) => JSON.stringify(node(k)?.config)).join("\n");

  it("shows the cart and asks delivery vs pickup in a single message", () => {
    const cartNode = node("pedido_recebido");
    expect(cartNode?.node_type).toBe("send_buttons");
    const cfg = JSON.stringify(cartNode!.config);
    expect(cfg).toContain("{{vars.itens_lista}}");
    expect(cfg).toContain("{{vars.total_formatado}}");
  });

  it("does not ask for the name (it comes from the WhatsApp profile)", () => {
    const collected = PEDIDO_EMPANADAS_FLOW.nodes
      .filter((n) => n.node_type === "collect_input")
      .map((n) => (n.config as { var_key: string }).var_key);
    expect(collected).toEqual(["endereco"]);
  });

  it("delivery collects the address and sends the Mercado Pago link", () => {
    const keys = path("set_delivery");
    expect(keys).toContain("ask_endereco");
    expect(text(keys)).toContain("{{vars.link_mercado_pago}}");
    expect(JSON.stringify(node("set_delivery")!.config)).toContain('"value":"delivery"');
  });

  it("pickup is paid at the store — no payment link", () => {
    const keys = path("set_retirada");
    expect(keys).toContain("registrar_retirada");
    expect(text(keys)).not.toContain("link_mercado_pago");
    expect(JSON.stringify(node("set_retirada")!.config)).toContain('"value":"retirada"');
  });

  it("passes flow validation for activation with no errors", () => {
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
      })),
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});
