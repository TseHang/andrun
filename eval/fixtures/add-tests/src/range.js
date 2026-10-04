/** The numbers from start up to, but not including, end. A negative step counts down. */
export function range(start, end, step = 1) {
  if (step === 0) throw new RangeError("step must not be 0");
  const out = [];
  if (step > 0) {
    for (let n = start; n < end; n += step) out.push(n);
  } else {
    for (let n = start; n > end; n += step) out.push(n);
  }
  return out;
}
