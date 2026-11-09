// Spark stores splat centers as 16-bit floats. A table keeps decoding them cheap.
export const HALF_TO_FLOAT = new Float32Array(65536);

for (let bits = 0; bits < 65536; bits += 1) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 0) HALF_TO_FLOAT[bits] = sign * fraction * 2 ** -24;
  else if (exponent === 31) HALF_TO_FLOAT[bits] = fraction ? NaN : sign * Infinity;
  else HALF_TO_FLOAT[bits] = sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
