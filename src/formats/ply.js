import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { readPlyCamera } from "../plyCamera.js";

export const plyFormat = {
  id: "ply",
  label: "PLY",
  extensions: ["ply"],
  async loadData({ file, bytes, stream, streamLength, runtimeLodEnabled = false, onProgress }) {
    const mesh = new SplatMesh({
      ...(stream ? { stream, streamLength } : { fileBytes: bytes }),
      fileType: SplatFileType.PLY,
      fileName: file?.name,
      lod: runtimeLodEnabled,
      onProgress,
    });
    await mesh.initialized;
    return mesh;
  },
  async loadMetadata({ bytes }) {
    return readPlyCamera(bytes);
  },
};