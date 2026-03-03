import { SplatMesh, SplatFileType } from "@sparkjsdev/spark";
import { readPlyCamera } from "../plyCamera.js";

export const plyFormat = {
  id: "ply",
  label: "PLY",
  extensions: ["ply"],
  async loadData({ file, bytes }) {
    const mesh = new SplatMesh({
      fileBytes: bytes,
      fileType: SplatFileType.PLY,
      fileName: file?.name,
    });
    await mesh.initialized;
    return mesh;
  },
  async loadMetadata({ bytes }) {
    return readPlyCamera(bytes);
  },
};