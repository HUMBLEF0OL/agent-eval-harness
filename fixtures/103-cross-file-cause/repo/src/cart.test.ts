import { describe, expect, it } from "vitest";
import { cartTotal } from "./cart.js";

describe("cartTotal", () => {
  it("rounds a half-cent-or-more of tax up to the next cent", () => {
    // subtotal 1234c, tax 107.975c -> 108c
    const items = [
      { priceCents: 499, qty: 2 },
      { priceCents: 236, qty: 1 },
    ];
    expect(cartTotal(items)).toBe(1342);
  });

  it("leaves a basket whose tax lands exactly on a cent unchanged", () => {
    // subtotal 1600c, tax exactly 140c
    const items = [{ priceCents: 800, qty: 2 }];
    expect(cartTotal(items)).toBe(1740);
  });

  it("keeps the total when the fractional cent is below half", () => {
    // subtotal 1201c, tax 105.0875c -> 105c
    const items = [{ priceCents: 1201, qty: 1 }];
    expect(cartTotal(items)).toBe(1306);
  });
});
