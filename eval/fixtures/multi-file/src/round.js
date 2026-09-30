export function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.floor(value * factor) / factor;
}
