import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { buildCameraMetadata } from "../cameraMetadata.js";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIR_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 0xffff;

const textDecoder = new TextDecoder("utf-8");

const findZipEndOfCentralDir = (view, length) => {
  const start = Math.max(0, length - (ZIP_END_OF_CENTRAL_DIR_MIN_SIZE + ZIP_MAX_COMMENT_SIZE));
  for (let offset = length - ZIP_END_OF_CENTRAL_DIR_MIN_SIZE; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIR) return offset;
  }
  return -1;
};

const findZipEntry = (bytes, targetName) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const eocdOffset = findZipEndOfCentralDir(view, length);
  if (eocdOffset < 0) return null;

  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirEnd = centralDirOffset + centralDirSize;
  if (centralDirEnd > length) return null;

  let offset = centralDirOffset;
  while (offset + 46 <= centralDirEnd) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_DIR_HEADER) break;

    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const name = textDecoder.decode(bytes.subarray(nameStart, nameEnd));
    const entryName = name.split(/[\\/]/).pop()?.toLowerCase();

    if (entryName === targetName) {
      return {
        compression,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
    }

    offset = nameEnd + extraLength + commentLength;
  }

  return null;
};

const inflateRaw = async (data) => {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is not available");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
};

const readZipEntryData = async (bytes, entry) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerOffset = entry.localHeaderOffset;
  if (headerOffset + 30 > bytes.byteLength) return null;
  if (view.getUint32(headerOffset, true) !== ZIP_LOCAL_FILE_HEADER) return null;

  const nameLength = view.getUint16(headerOffset + 26, true);
  const extraLength = view.getUint16(headerOffset + 28, true);
  const dataStart = headerOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) return null;

  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return inflateRaw(compressed);

  throw new Error(`Unsupported zip compression method: ${entry.compression}`);
};

const readSogMetaJson = async (bytes) => {
  const entry = findZipEntry(bytes, "meta.json");
  if (!entry) return null;
  const data = await readZipEntryData(bytes, entry);
  if (!data) return null;
  try {
    return JSON.parse(textDecoder.decode(data));
  } catch (error) {
    throw new Error(`Invalid meta.json: ${error?.message ?? error}`);
  }
};

const readSogMetadata = async (bytes) => {
  const meta = await readSogMetaJson(bytes);
  if (!meta || typeof meta !== "object") return null;
  const sharpMetadata = meta.sharp_metadata;
  if (!sharpMetadata || typeof sharpMetadata !== "object") return null;
  return buildCameraMetadata(sharpMetadata);
};

export const sogFormat = {
  id: "sog",
  label: "SOG",
  extensions: ["sog"],
  async loadData({ file, bytes }) {
    const mesh = new SplatMesh({
      fileBytes: bytes,
      fileType: SplatFileType.PCSOGSZIP,
      fileName: file?.name,
    });
    await mesh.initialized;
    return mesh;
  },
  async loadMetadata({ bytes }) {
    return readSogMetadata(bytes);
  },
};