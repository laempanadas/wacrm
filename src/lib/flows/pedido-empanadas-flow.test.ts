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

  it("renders the seeded cart variables so the customer sees their order", () => {
    const cartNode = PEDIDO_EMPANADAS_FLOW.nodes.find(
      (n) => n.node_key === "mostrar_carrinho",
    );
    expect(cartNode).toBeDefined();
    expect(JSON.stringify(cartNode!.config)).toContain("{{vars.itens_texto}}");
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
