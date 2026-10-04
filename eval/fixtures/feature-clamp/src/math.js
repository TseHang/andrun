export function add(a, b) {
  return a + b;
}

export function average(values) {
  if (values.length === 0) return 0;
  return values.reduce(add, 0) / values.length;
}
