export function invoiceLine(item) {
  const amount = item.price * item.quantity;
  const price = "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${item.name} x${item.quantity}: ${price}`;
}

export function invoiceTotal(items) {
  const amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const price = "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Total: ${price}`;
}
