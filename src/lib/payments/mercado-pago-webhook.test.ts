import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  extractPaymentId,
  isOrderPaid,
  isValidMercadoPagoSignature,
} from "./mercado-pago-webhook";

const q = (s = "") => new URLSearchParams(s);

describe("extractPaymentId", () => {
  it("reads the Webhooks body format (payment.updated and payment.created)", () => {
    expect(
      extractPaymentId({ type: "payment", action: "payment.updated", data: { id: "123" } }, q()),
    ).toBe("123");
    expect(extractPaymentId({ action: "payment.created", data: { id: 456 } }, q())).toBe("456");
  });

  it("reads the query string formats (Webhooks and legacy IPN)", () => {
    expect(extractPaymentId(null, q("type=payment&data.id=789"))).toBe("789");
    expect(extractPaymentId(null, q("topic=payment&id=321"))).toBe("321");
  });

  it("ignores non-payment notifications", () => {
    expect(extractPaymentId({ type: "merchant_order", data: { id: "1" } }, q())).toBeNull();
    expect(extractPaymentId(null, q("topic=merchant_order&id=1"))).toBeNull();
    expect(extractPaymentId({ type: "payment", data: {} }, q())).toBeNull();
  });
});

describe("isValidMercadoPagoSignature", () => {
  const secret = "test-secret";
  const sign = (manifest: string) =>
    crypto.createHmac("sha256", secret).update(manifest).digest("hex");

  it("accepts a signature built with Mercado Pago's manifest", () => {
    const v1 = sign("id:123;request-id:req-1;ts:1700000000;");
    expect(
      isValidMercadoPagoSignature({
        xSignature: `ts=1700000000,v1=${v1}`,
        xRequestId: "req-1",
        dataId: "123",
        secret,
      }),
    ).toBe(true);
  });

  it("lowercases alphanumeric data.id before signing", () => {
    const v1 = sign("id:abc123;request-id:req-1;ts:1;");
    expect(
      isValidMercadoPagoSignature({
        xSignature: `ts=1, v1=${v1}`,
        xRequestId: "req-1",
        dataId: "ABC123",
        secret,
      }),
    ).toBe(true);
  });

  it("omits missing parts from the manifest", () => {
    const v1 = sign("id:123;ts:1;");
    expect(
      isValidMercadoPagoSignature({ xSignature: `ts=1,v1=${v1}`, xRequestId: null, dataId: "123", secret }),
    ).toBe(true);
  });

  it("rejects a wrong secret, a tampered id, or a malformed header", () => {
    const v1 = sign("id:123;request-id:req-1;ts:1;");
    const base = { xSignature: `ts=1,v1=${v1}`, xRequestId: "req-1", dataId: "123" };
    expect(isValidMercadoPagoSignature({ ...base, secret: "other" })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...base, dataId: "999", secret })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...base, xSignature: `v1=${v1}`, secret })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...base, xSignature: null, secret })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...base, xSignature: "ts=1,v1=zz", secret })).toBe(false);
  });
});

describe("isOrderPaid", () => {
  it("treats paid in any casing as paid", () => {
    expect(isOrderPaid("paid")).toBe(true);
    expect(isOrderPaid("PAID")).toBe(true);
    expect(isOrderPaid("pending")).toBe(false);
    expect(isOrderPaid(null)).toBe(false);
  });
});
