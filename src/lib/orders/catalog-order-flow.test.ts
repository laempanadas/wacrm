import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSavedCustomerAddress } from "./text-order-flow";

describe("getSavedCustomerAddress", () => {
  it("retrieves address from contact_custom_values when available", async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "custom_fields") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [{ id: "field_123", field_name: "Endereco_entrega" }],
            }),
          };
        }
        if (table === "contact_custom_values") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { value: "Rua das Flores, 123 - Centro" },
            }),
          };
        }
        return {};
      }),
    };

    const addr = await getSavedCustomerAddress(
      mockSupabase as unknown as SupabaseClient,
      "acc_1",
      "contact_1",
    );
    expect(addr).toBe("Rua das Flores, 123 - Centro");
  });

  it("falls back to orders.delivery_address if not in custom values", async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "custom_fields") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { delivery_address: "Av. Brasil, 450 - Bairro Alto" },
            }),
          };
        }
        return {};
      }),
    };

    const addr = await getSavedCustomerAddress(
      mockSupabase as unknown as SupabaseClient,
      "acc_1",
      "contact_1",
    );
    expect(addr).toBe("Av. Brasil, 450 - Bairro Alto");
  });

  it("falls back to deals.notes if neither custom values nor orders have address", async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "custom_fields") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          };
        }
        if (table === "deals") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  notes:
                    "Itens: 4x Carne\nEndereço: Rua dos Pinheiros, 789 - Jardins\nPagamento: Pix",
                },
              ],
            }),
          };
        }
        return {};
      }),
    };

    const addr = await getSavedCustomerAddress(
      mockSupabase as unknown as SupabaseClient,
      "acc_1",
      "contact_1",
    );
    expect(addr).toBe("Rua dos Pinheiros, 789 - Jardins");
  });

  it("returns null if no address is found in any source", async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "custom_fields") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === "orders") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          };
        }
        if (table === "deals") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        return {};
      }),
    };

    const addr = await getSavedCustomerAddress(
      mockSupabase as unknown as SupabaseClient,
      "acc_1",
      "contact_1",
    );
    expect(addr).toBeNull();
  });
});
