/** Splits a list into lists of at most `size` items, in order. */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
