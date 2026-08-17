import { taxFor } from "./tax.js";

export interface CartItem {
  priceCents: number;
  qty: number;
}

export const TAX_RATE = 0.0875;

export function subtotalOf(items: CartItem[]): number {
  return items.reduce((acc, item) => acc + item.priceCents * item.qty, 0);
}

export function cartTotal(items: CartItem[]): number {
  const subtotal = subtotalOf(items);
  return subtotal + taxFor(subtotal, TAX_RATE);
}
