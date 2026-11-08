// Spark reads each splat's camera distance back from the GPU before every sort, which blocks
// the main thread during the copy. For a single unmodified mesh those distances can be computed
// from the CPU copy of the centers in a worker instead. Anything else, or any worker failure,
// falls back to Spark's readback.

// Above this the worker's copy of the positions costs too much memory.
const MAX_SPLATS = 4_000_000;

let worker = null;
let workerFailed = false;
let nextRequestId = 1;
let uploaded = null;
const pending = new Map();

const rejectPending = (error) => {
  pending.forEach(({ reject }) => reject(error));
  pending.clear();
};

const stopWorker = () => {
  worker?.terminate();
  worker = null;
  uploaded = null;
  rejectPending(new Error('Splat depth worker stopped'));
};

const getWorker = () => {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('./splatDepth.worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    workerFailed = true;
    console.warn('[splatCpuSort] Worker unavailable; using GPU readback', error);
    return null;
  }
  worker.onmessage = ({ data }) => {
    pending.get(data.id)?.resolve(data.distances);
    pending.delete(data.id);
  };
  worker.onerror = (event) => {
    workerFailed = true;
    console.warn('[splatCpuSort] Worker failed; using GPU readback', event.message);
    stopWorker();
  };
  return worker;
};

const getCpuSource = (spark, current, numSplats) => {
  // VR moves the mesh every frame, which would resend its positions on every sort.
  if (spark.renderer?.xr?.isPresenting || numSplats > MAX_SPLATS) return null;
  if (spark.sortRadial === false || spark.enableLod || current.mapping?.length !== 1) return null;
  const { node, base, count } = current.mapping[0];
  const packedArray = node?.packedSplats?.packedArray;
  const unmodified = !node?.objectModifier && !node?.worldModifier && !node?.edits?.length && node?.opacity === 1;
  if (!packedArray || !unmodified || base !== 0 || count !== numSplats) return null;
  if (node.packedSplats.numSplats !== numSplats) return null;
  return { mesh: node, packedArray };
};

const uploadMeshIfChanged = ({ mesh, packedArray }, numSplats) => {
  const matrix = mesh.matrixWorld.elements;
  if (
    uploaded?.packedArray === packedArray
    && uploaded.numSplats === numSplats
    && uploaded.matrix.every((value, i) => value === matrix[i])
  ) {
    return;
  }
  const packed = packedArray.slice(0, numSplats * 4);
  worker.postMessage({ type: 'mesh', packed, matrix: [...matrix], numSplats }, [packed.buffer]);
  uploaded = { packedArray, numSplats, matrix: [...matrix] };
};

const requestDistances = async (source, origin, numSplats, target) => {
  uploadMeshIfChanged(source, numSplats);
  const id = nextRequestId;
  nextRequestId += 1;
  const distances = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'fill', id, origin: [origin.x, origin.y, origin.z], numSplats });
  });
  target.set(distances);
  worker?.postMessage({ type: 'recycle', distances }, [distances.buffer]);
};

export const setCpuDepthSort = (spark, enabled) => {
  if (!spark) return;
  delete spark.readbackDepth;
  if (!enabled) {
    stopWorker();
    return;
  }
  const readFromGpu = spark.readbackDepth;
  spark.readbackDepth = async function readbackDepth(args) {
    const source = getCpuSource(this, args.current, args.numSplats);
    if (!source || !getWorker()) return readFromGpu.call(this, args);
    try {
      await requestDistances(source, args.current.viewOrigin, args.numSplats, new Float32Array(args.readback.buffer));
      return args.readback;
    } catch {
      return readFromGpu.call(this, args);
    }
  };
};

export const fillCpuDistancesForTest = async (spark, current, numSplats, target) => {
  const source = getCpuSource(spark, current, numSplats);
  if (!source || !getWorker()) return false;
  await requestDistances(source, current.viewOrigin, numSplats, target);
  return true;
};
