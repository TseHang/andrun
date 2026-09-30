import { roundTo } from "./round.js";

export function formatPrice(amount) {
  return `$${roundTo(amount, 2).toFixed(2)}`;
}
