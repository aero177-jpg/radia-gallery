// Computes each splat's camera distance off the main thread. See splatCpuSort.js.

// Centers are stored as 16-bit floats; a table keeps decoding cheap.
const HALF_TO_FLOAT = new Float32Array(65536);
for (let bits = 0; bits < 65536; bits += 1) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 0) HALF_TO_FLOAT[bits] = sign * fraction * 2 ** -24;
  else if (exponent === 31) HALF_TO_FLOAT[bits] = fraction ? NaN : sign * Infinity;
  else HALF_TO_FLOAT[bits] = sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

let positions = new Float32Array(0);
let spareBuffer = null;

const setMesh = ({ packed, matrix: e, numSplats }) => {
  if (positions.length !== numSplats * 3) positions = new Float32Array(numSplats * 3);
  for (let i = 0, word = 0, out = 0; i < numSplats; i += 1, word += 4, out += 3) {
    const xy = packed[word + 1];
    const x = HALF_TO_FLOAT[xy & 0xffff];
    const y = HALF_TO_FLOAT[xy >>> 16];
    const z = HALF_TO_FLOAT[packed[word + 2] & 0xffff];
    // Spark treats a splat as inactive when all three scales are zero; an infinite
    // coordinate gives it the same infinite distance the GPU pass writes.
    positions[out] = (packed[word + 3] & 0xffffff) === 0 ? Infinity : e[0] * x + e[4] * y + e[8] * z + e[12];
    positions[out + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    positions[out + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
};

const fill = ({ id, origin, numSplats }) => {
  const distances = spareBuffer?.length === numSplats ? spareBuffer : new Float32Array(numSplats);
  spareBuffer = null;
  const [originX, originY, originZ] = origin;
  for (let i = 0, p = 0; i < numSplats; i += 1, p += 3) {
    const x = positions[p] - originX;
    const y = positions[p + 1] - originY;
    const z = positions[p + 2] - originZ;
    distances[i] = Math.sqrt(x * x + y * y + z * z);
  }
  self.postMessage({ id, distances }, [distances.buffer]);
};

self.onmessage = ({ data }) => {
  if (data.type === 'mesh') setMesh(data);
  else if (data.type === 'fill') fill(data);
  else if (data.type === 'recycle') spareBuffer = data.distances;
};
