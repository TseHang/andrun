export function average(values) {
  const total = values.reduce((a, b) => a + b, 0);
  return total / values.length;
}
