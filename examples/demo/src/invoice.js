export function subtotal(items) {
  if (items.some(item => !Number.isInteger(item.cents) || item.cents < 0 || !Number.isInteger(item.quantity) || item.quantity < 0)) {
    throw new TypeError('Prices and quantities must be nonnegative integers');
  }
  return items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
}

export function totalWithTax(items, percent) {
  if (!Number.isFinite(percent) || percent < 0) throw new TypeError('Invalid tax');
  return Math.round(subtotal(items) * (1 + percent / 100));
}
