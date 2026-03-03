const toExtrinsic4x4RowMajor = (raw) => {
  if (!raw) {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  if (raw.length === 16) return [...raw];

  if (raw.length === 12) {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    m[0] = raw[0];
    m[1] = raw[1];
    m[2] = raw[2];
    m[3] = raw[3];

    m[4] = raw[4];
    m[5] = raw[5];
    m[6] = raw[6];
    m[7] = raw[7];

    m[8] = raw[8];
    m[9] = raw[9];
    m[10] = raw[10];
    m[11] = raw[11];

    const r00 = m[0];
    const r01 = m[1];
    const r02 = m[2];
    const r10 = m[4];
    const r11 = m[5];
    const r12 = m[6];
    const r20 = m[8];
    const r21 = m[9];
    const r22 = m[10];

    m[0] = r00;
    m[1] = r10;
    m[2] = r20;
    m[4] = r01;
    m[5] = r11;
    m[6] = r21;
    m[8] = r02;
    m[9] = r12;
    m[10] = r22;

    return m;
  }

  throw new Error(`Unrecognized extrinsic element length: ${raw.length}`);
};

const parseIntrinsics = (raw, imageWidth, imageHeight) => {
  if (!raw) return null;

  if (raw.length === 9) {
    if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;
    return {
      fx: raw[0],
      fy: raw[4],
      cx: raw[2],
      cy: raw[5],
      imageWidth,
      imageHeight,
    };
  }

  if (raw.length === 16) {
    if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;
    return {
      fx: raw[0],
      fy: raw[5],
      cx: raw[2],
      cy: raw[6],
      imageWidth,
      imageHeight,
    };
  }

  if (raw.length === 4) {
    const legacyWidth = Number.parseInt(raw[2]);
    const legacyHeight = Number.parseInt(raw[3]);
    const width = Number.isFinite(imageWidth) ? imageWidth : legacyWidth;
    const height = Number.isFinite(imageHeight) ? imageHeight : legacyHeight;
    return {
      fx: raw[0],
      fy: raw[1],
      cx: (width - 1) * 0.5,
      cy: (height - 1) * 0.5,
      imageWidth: width,
      imageHeight: height,
    };
  }

  return null;
};

const normalizeColorSpaceIndex = (value) => {
  if (Array.isArray(value)) {
    return Number.isFinite(value[0]) ? value[0] : undefined;
  }
  return Number.isFinite(value) ? value : undefined;
};

const buildCameraMetadata = (raw = {}) => {
  const imageSize = raw.image_size;
  const imageWidth = Array.isArray(imageSize) ? imageSize[0] : undefined;
  const imageHeight = Array.isArray(imageSize) ? imageSize[1] : undefined;
  const intrinsics = parseIntrinsics(raw.intrinsic, imageWidth, imageHeight);
  if (!intrinsics) return null;

  return {
    intrinsics,
    extrinsicCv: toExtrinsic4x4RowMajor(raw.extrinsic),
    colorSpaceIndex: normalizeColorSpaceIndex(raw.color_space),
    headerComments: raw.headerComments ?? [],
  };
};

export { toExtrinsic4x4RowMajor, parseIntrinsics, buildCameraMetadata };
