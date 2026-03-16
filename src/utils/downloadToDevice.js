import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const isNative = () => Capacitor.isNativePlatform();

const sanitizeFilename = (filename, fallback = 'download.bin') => {
  const trimmed = String(filename || '').trim();
  const safeName = trimmed
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  return safeName || fallback;
};

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error || new Error('Failed to read file for export.'));
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const commaIndex = result.indexOf(',');
    resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
  };
  reader.readAsDataURL(blob);
});

const downloadBlobOnWeb = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'web-download' };
};

export const downloadBlobToDevice = async (blob, filename) => {
  const safeFilename = sanitizeFilename(filename);

  if (!isNative()) {
    return downloadBlobOnWeb(blob, safeFilename);
  }

  const exportPath = `exports/${Date.now()}-${safeFilename}`;
  const data = await blobToBase64(blob);
  const writtenFile = await Filesystem.writeFile({
    path: exportPath,
    data,
    directory: Directory.Documents,
    recursive: true,
  });

  try {
    const shareAvailability = await Share.canShare();
    if (shareAvailability?.value !== false && writtenFile?.uri) {
      await Share.share({
        title: safeFilename,
        text: `Exported from Radia: ${safeFilename}`,
        url: writtenFile.uri,
        dialogTitle: `Export ${safeFilename}`,
      });
      return { method: 'native-share', uri: writtenFile.uri };
    }
  } catch (err) {
    console.warn('[DownloadToDevice] Native share unavailable after file save:', err);
  }

  return { method: 'native-file', uri: writtenFile?.uri || null };
};