import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Scenario knobs ---------------------------------------------------------
let role: "agent" | "viewer" = "agent";
let tables: Record<string, Array<Record<string, unknown>>> = {};

vi.mock("@/lib/auth/account", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return {
    ...actual,
    requireRole: async () => {
      if (role === "viewer") throw new actual.ForbiddenError("Insufficient role");
      return { accountId: "acc", userId: "user" };
    },
  };
});

const markDealPaid = vi.fn();
vi.mock("@/lib/orders/mark-deal-paid", () => ({
  markDealPaid: (...args: unknown[]) => markDealPaid(...args),
}));

const markContactPaymentConfirmed = vi.fn();
vi.mock("@/lib/orders/create-order", async () => {
  const actual = await vi.importActual<typeof import("@/lib/orders/create-order")>(
    "@/lib/orders/create-order",
  );
  return {
    ...actual,
    markContactPaymentConfirmed: (...args: unknown[]) => markContactPaymentConfirmed(...args),
  };
});

// In-memory admin client covering select/update with eq filters.
vi.mock("@/lib/automations/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      const rows = () =>
        (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((patch = p), q),
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: { error: null }) => void) => {
          if (patch) rows().forEach((r) => Object.assign(r, patch));
          resolve({ error: null });
        },
      };
      return q;
    },
  }),
}));

const { POST } = await import("./route");
const call = (id: string) =>
  POST(new Request(`https://app.test/api/deals/${id}/mark-paid`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  role = "agent";
  markDealPaid.mockResolvedValue({ moved: true, dealId: "deal-1", stageId: "pago", stageCreated: false });
  markContactPaymentConfirmed.mockResolvedValue(undefined);
  tables = {
    deals: [{ id: "deal-1", account_id: "acc", contact_id: "c1", pipeline_id: "orders", status: "open" }],
    pipelines: [
      { id: "orders", name: "Pedidos Delivery" },
      { id: "sales", name: "Vendas" },
    ],
    orders: [{ id: "o1", account_id: "acc", deal_id: "deal-1", status: "pending" }],
  };
});

describe("POST /api/deals/[id]/mark-paid", () => {
  it("moves an order card to Pago, tags Confirmado and closes the order", async () => {
    const res = await call("deal-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, moved: true });
    expect(markDealPaid).toHaveBeenCalledWith(expect.anything(), { accountId: "acc", dealId: "deal-1" });
    expect(markContactPaymentConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: "acc", userId: "user" },
      "c1",
    );
    expect(tables.orders[0].status).toBe("paid");
  });

  it("only marks won for deals outside the orders pipeline", async () => {
    tables.deals[0].pipeline_id = "sales";
    const res = await call("deal-1");

    expect(await res.json()).toMatchObject({ ok: true, moved: false });
    expect(tables.deals[0].status).toBe("won");
    expect(markDealPaid).not.toHaveBeenCalled();
    expect(markContactPaymentConfirmed).not.toHaveBeenCalled();
  });

  it("returns 404 for a deal of another account", async () => {
    tables.deals[0].account_id = "other";
    expect((await call("deal-1")).status).toBe(404);
    expect(markDealPaid).not.toHaveBeenCalled();
  });

  it("rejects viewers", async () => {
    role = "viewer";
    expect((await call("deal-1")).status).toBe(403);
  });

  it("still succeeds when tagging fails (card already moved)", async () => {
    markContactPaymentConfirmed.mockRejectedValue(new Error("boom"));
    expect((await call("deal-1")).status).toBe(200);
  });
});
