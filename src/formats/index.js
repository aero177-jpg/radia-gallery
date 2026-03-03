import { plyFormat } from "./ply.js";
import { sogFormat } from "./sog.js";

const formats = [plyFormat, sogFormat];

const getExtension = (fileName) => {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
};

const uniq = (items) => [...new Set(items)];

export const getFormatHandler = (file) => {
  const extension = getExtension(file?.name ?? "");
  if (!extension) return null;
  return formats.find((format) => format.extensions.includes(extension)) ?? null;
};

export const getSupportedExtensions = () =>
  uniq(formats.flatMap((format) => format.extensions.map((ext) => `.${ext}`)));

export const getFormatAccept = () => getSupportedExtensions().join(",");

const getSupportedLabel = () => formats.map((format) => format.label).join(" / ");
