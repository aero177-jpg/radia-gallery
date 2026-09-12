import { buildCameraMetadata } from "./cameraMetadata.js";

const textDecoder = new TextDecoder("utf-8");

const FIELD_BYTES = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8,
};

const parsePlyHeader = (fileBytes) => {
  const bytes = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  const elements = [];
  const comments = [];
  let currentElement = null;
  let format = null;
  let lineStart = 0;

  while (lineStart < bytes.length) {
    let lineEnd = lineStart;
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) lineEnd += 1;

    const line = textDecoder.decode(bytes.subarray(lineStart, lineEnd)).replace(/\r$/, "").trim();
    const tokens = line.split(/\s+/);
    const keyword = tokens[0];

    if (keyword === "format") {
      format = tokens[1];
    } else if (keyword === "comment") {
      comments.push(tokens.slice(1).join(" "));
    } else if (keyword === "element") {
      currentElement = {
        name: tokens[1],
        count: Number(tokens[2]),
        properties: {},
      };
      elements.push(currentElement);
    } else if (keyword === "property" && currentElement) {
      if (tokens[1] === "list") {
        currentElement.properties[tokens[4]] = {
          isList: true,
          countType: tokens[2],
          type: tokens[3],
        };
      } else {
        currentElement.properties[tokens[2]] = {
          isList: false,
          type: tokens[1],
        };
      }
    } else if (keyword === "end_header") {
      if (format !== "binary_little_endian" && format !== "binary_big_endian") {
        throw new Error(`Unsupported PLY format: ${format ?? "unknown"}`);
      }

      return {
        data: bytes.subarray(lineEnd < bytes.length ? lineEnd + 1 : lineEnd),
        elements,
        comments,
        littleEndian: format === "binary_little_endian",
      };
    }

    lineStart = lineEnd < bytes.length ? lineEnd + 1 : lineEnd;
  }

  throw new Error("PLY header is missing end_header");
};

const readScalar = (dataView, offset, type, littleEndian) => {
  switch (type) {
    case "char":
      return dataView.getInt8(offset);
    case "uchar":
      return dataView.getUint8(offset);
    case "short":
      return dataView.getInt16(offset, littleEndian);
    case "ushort":
      return dataView.getUint16(offset, littleEndian);
    case "int":
      return dataView.getInt32(offset, littleEndian);
    case "uint":
      return dataView.getUint32(offset, littleEndian);
    case "float":
      return dataView.getFloat32(offset, littleEndian);
    case "double":
      return dataView.getFloat64(offset, littleEndian);
    default:
      throw new Error(`Unsupported PLY field type: ${type}`);
  }
};

const computeStrideForItem = (properties, dataView, itemOffset, littleEndian) => {
  let offset = itemOffset;
  const listLengths = {};

  for (const [propertyName, property] of properties) {
    if (!property.isList) {
      const bytes = FIELD_BYTES[property.type];
      if (bytes == null) {
        throw new Error(`Unsupported PLY field type: ${property.type}`);
      }
      offset += bytes;
      continue;
    }

    const countType = property.countType;
    const countTypeBytes = FIELD_BYTES[countType];
    const valueBytes = FIELD_BYTES[property.type];
    if (countTypeBytes == null || valueBytes == null) {
      throw new Error(`Unsupported PLY list field types: ${countType}, ${property.type}`);
    }

    const length = readScalar(dataView, offset, countType, littleEndian);
    offset += countTypeBytes;
    listLengths[propertyName] = length;
    offset += length * valueBytes;
  }

  return { stride: offset - itemOffset, listLengths };
};

const computeElementStrideInfo = (element, dataView, elementOffset, littleEndian) => {
  const properties = Object.entries(element.properties);
  const hasLists = properties.some(([, prop]) => prop.isList);

  if (!hasLists) {
    const stride = properties.reduce((sum, [, prop]) => sum + FIELD_BYTES[prop.type], 0);
    return { stride, constant: true };
  }

  if (element.count <= 0) {
    return { stride: 0, constant: true };
  }

  const first = computeStrideForItem(properties, dataView, elementOffset, littleEndian);
  if (element.count === 1) {
    return { stride: first.stride, constant: true };
  }

  const secondOffset = elementOffset + first.stride;
  const second = computeStrideForItem(properties, dataView, secondOffset, littleEndian);

  if (second.stride !== first.stride) {
    return { stride: first.stride, constant: false };
  }

  for (const [key, value] of Object.entries(first.listLengths)) {
    if (second.listLengths[key] !== value) {
      return { stride: first.stride, constant: false };
    }
  }

  return { stride: first.stride, constant: true };
};

const skipElement = (element, dataView, elementOffset, littleEndian) => {
  if (element.count <= 0) return elementOffset;

  const properties = Object.entries(element.properties);
  const hasLists = properties.some(([, prop]) => prop.isList);

  if (!hasLists) {
    const stride = properties.reduce((sum, [, prop]) => sum + FIELD_BYTES[prop.type], 0);
    return elementOffset + element.count * stride;
  }

  const strideInfo = computeElementStrideInfo(
    element,
    dataView,
    elementOffset,
    littleEndian,
  );
  if (strideInfo.constant) {
    return elementOffset + element.count * strideInfo.stride;
  }

  let offset = elementOffset;
  for (let index = 0; index < element.count; index += 1) {
    offset += computeStrideForItem(properties, dataView, offset, littleEndian).stride;
  }
  return offset;
};

const readSinglePropertyElement = (element, dataView, elementOffset, littleEndian) => {
  const properties = Object.entries(element.properties);
  if (properties.length !== 1) return null;

  const [propertyName, property] = properties[0];
  if (property.isList) return null;

  const stride = FIELD_BYTES[property.type];
  if (stride == null) {
    throw new Error(`Unsupported PLY field type: ${property.type}`);
  }

  const values = new Array(element.count);
  let offset = elementOffset;
  for (let i = 0; i < element.count; i += 1) {
    values[i] = readScalar(dataView, offset, property.type, littleEndian);
    offset += stride;
  }

  return { propertyName, values, nextOffset: offset };
};

export const readPlyCamera = async (fileBytes) => {
  const ply = parsePlyHeader(fileBytes);

  const wanted = new Set(["intrinsic", "extrinsic", "image_size", "color_space"]);
  const raw = {};

  let offset = 0;
  const dataView = new DataView(ply.data.buffer, ply.data.byteOffset, ply.data.byteLength);
  for (const element of ply.elements) {
    if (wanted.has(element.name)) {
      const read = readSinglePropertyElement(element, dataView, offset, ply.littleEndian);
      if (read) {
        raw[element.name] = read.values;
        offset = read.nextOffset;
        continue;
      }
    }

    offset = skipElement(element, dataView, offset, ply.littleEndian);
  }

  return buildCameraMetadata({
    ...raw,
    headerComments: ply.comments,
  });
};
