import * as THREE from 'three';

// Spark draws one quad per instance. Drawing 128 quads per instance took a 1.18M-splat draw
// on Intel UHD 630 from about 60 ms to about 50 ms, with identical sampled pixels.
// This depends on Spark 2.2 shader internals, so it refuses to apply if they change.
const SPLATS_PER_INSTANCE = 128;
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

const states = new WeakMap();

const buildGeometry = (spark, quadIndices) => {
  const positions = new Float32Array(SPLATS_PER_INSTANCE * 12);
  const indices = new Uint16Array(SPLATS_PER_INSTANCE * 6);
  for (let splat = 0; splat < SPLATS_PER_INSTANCE; splat += 1) {
    for (let corner = 0; corner < 4; corner += 1) {
      // position.z is unused by Spark's shader, so it carries the splat's slot in the batch.
      positions.set([CORNERS[corner * 2], CORNERS[corner * 2 + 1], splat], (splat * 4 + corner) * 3);
    }
    for (let i = 0; i < 6; i += 1) indices[splat * 6 + i] = splat * 4 + quadIndices[i];
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // Spark assigns its splat count to instanceCount every frame, so convert it here.
  let instances = 0;
  Object.defineProperty(geometry, 'instanceCount', {
    get: () => instances,
    set: (activeSplats) => {
      spark.material.uniforms.batchActiveSplats.value = activeSplats;
      instances = Math.ceil(activeSplats / SPLATS_PER_INSTANCE);
    },
  });
  return geometry;
};

const patchVertexShader = (shader) => {
  if (!shader.includes('gl_InstanceID') || !shader.includes('void main() {')) return null;
  return shader
    .replaceAll('gl_InstanceID', 'batchSplatId')
    .replace(
      'void main() {',
      `uniform int batchActiveSplats;
void main() {
    int batchSplatId = gl_InstanceID * ${SPLATS_PER_INSTANCE} + int(position.z);
    // The last batch is usually partial, and its spare slots hold stale ordering data.
    if (batchSplatId >= batchActiveSplats) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }`,
    );
};

const getState = (spark) => {
  if (states.has(spark)) return states.get(spark);
  const quadIndices = spark.geometry.index?.array;
  const batchedShader = patchVertexShader(spark.material.vertexShader);
  let state = null;
  if (batchedShader && quadIndices?.length === 6) {
    spark.material.uniforms.batchActiveSplats = { value: 0 };
    state = {
      originalGeometry: spark.geometry,
      originalShader: spark.material.vertexShader,
      batchedGeometry: buildGeometry(spark, quadIndices),
      batchedShader,
    };
  } else {
    console.warn('[splatBatching] Spark internals changed; batched drawing is unavailable');
  }
  states.set(spark, state);
  return state;
};

export const setSplatBatching = (spark, enabled) => {
  const state = spark && getState(spark);
  if (!state) return;
  const geometry = enabled ? state.batchedGeometry : state.originalGeometry;
  if (spark.geometry === geometry) return;
  spark.geometry = geometry;
  spark.material.vertexShader = enabled ? state.batchedShader : state.originalShader;
  spark.material.needsUpdate = true;
  geometry.instanceCount = spark.activeSplats;
};
