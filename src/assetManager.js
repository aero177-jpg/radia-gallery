/**
 * Asset Manager module - handles multi-asset list, navigation, and preview generation
 */

import { getSupportedExtensions } from "./formats/index.js";

// Supported image extensions for preview matching
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];

// Asset list state
let assetList = [];
let currentAssetIndex = -1;
let onAssetChangeCallback = null;
let onPreviewGeneratedCallback = null;

// Store reference to capture function (injected from fileLoader)
let capturePreviewFn = null;

const isObjectUrl = (value) => typeof value === 'string' && value.startsWith('blob:');

import { bgImageUrl } from './viewer.js';

const scheduleRevokeObjectUrl = (url, asset) => {
  if (!url || !isObjectUrl(url)) return;
  setTimeout(() => {
    if (!asset || asset.preview === url) return;
    if (bgImageUrl === url) return;
    URL.revokeObjectURL(url);
  }, 1200);
};

const replaceAssetPreviewUrl = (asset, url) => {
  if (!asset) return;
  const previous = asset.preview;
  if (previous && isObjectUrl(previous) && previous !== url) {
    scheduleRevokeObjectUrl(previous, asset);
  }
  asset.preview = url;
};

const revokeAssetPreviewUrl = (asset) => {
  if (asset?.preview && isObjectUrl(asset.preview)) {
    URL.revokeObjectURL(asset.preview);
  }
};

/**
 * Set the function used to capture previews from the main renderer
 */
export const setCapturePreviewFn = (fn) => {
  capturePreviewFn = fn;
};

/**
 * Capture preview for the current asset using the main renderer.
 * Uses object URLs to avoid embedding base64 previews in memory/state.
 */
export const captureCurrentAssetPreview = async () => {
  if (currentAssetIndex < 0 || !capturePreviewFn) return null;
  
  const capturedIndex = currentAssetIndex;
  const asset = assetList[capturedIndex];
  if (!asset) return null;
  const capturedAssetId = asset.id;
  
  try {
    const result = await capturePreviewFn();
    if (!result || !result.url) return null;

    replaceAssetPreviewUrl(asset, result.url);
    asset.previewSource = result.source ?? 'generated';
    asset.previewMeta = {
      width: result.width,
      height: result.height,
      format: result.format,
      updated: result.updated ?? Date.now(),
    };

    if (onPreviewGeneratedCallback) {
      let callbackIndex = capturedIndex;
      if (assetList[callbackIndex]?.id !== capturedAssetId) {
        callbackIndex = assetList.findIndex((candidate) => candidate?.id === capturedAssetId);
      }
      if (callbackIndex >= 0) {
        onPreviewGeneratedCallback(asset, callbackIndex, result);
      }
    }
    return result;
  } catch (err) {
    console.warn('Failed to capture preview', err);
    return null;
  }
};

/**
 * Get file extension in lowercase
 */
const getExtension = (filename) => {
  const parts = filename.split(".");
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : "";
};

/**
 * Get base filename without extension
 */
const getBaseName = (filename) => {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
};

/**
 * Create an object URL for a File so previews avoid base64 overhead.
 */
const createObjectUrl = (file) => URL.createObjectURL(file);

/**
 * Filter and sort files by supported extensions
 */
const filterSupportedFiles = (files) => {
  const extensions = getSupportedExtensions();
  return Array.from(files)
    .filter(file => {
      const ext = getExtension(file.name);
      return extensions.includes(ext);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Find image files that could be used as previews
 */
const findImageFiles = (files) => {
  return Array.from(files).filter(file => {
    const ext = getExtension(file.name);
    return IMAGE_EXTENSIONS.includes(ext);
  });
};

/**
 * Match assets with corresponding image files by base filename
 */
const matchPreviewImages = async (assets, imageFiles) => {
  // Create a map of base names to image files
  const imageMap = new Map();
  for (const img of imageFiles) {
    const baseName = getBaseName(img.name).toLowerCase();
    // Store the first match (in case of multiple images with same base name)
    if (!imageMap.has(baseName)) {
      imageMap.set(baseName, img);
    }
  }
  
  // Match assets with images
  for (const asset of assets) {
    const assetBaseName = getBaseName(asset.name).toLowerCase();
    const matchingImage = imageMap.get(assetBaseName);
    
    if (matchingImage) {
      const objectUrl = createObjectUrl(matchingImage);
      replaceAssetPreviewUrl(asset, objectUrl);
      asset.previewSource = "image"; // Mark as image-sourced preview
      asset.previewMeta = { source: 'sidecar', updated: Date.now() };
    }
  }
  
  return assets;
};

/**
 * Add files to the existing asset list
 */
export const addAssets = async (files) => {
  const supportedFiles = filterSupportedFiles(files);
  
  if (supportedFiles.length === 0) {
    return { count: assetList.length, added: 0, newAssets: [] };
  }
  
  // Find image files for potential preview matching
  const imageFiles = findImageFiles(files);
  
  const startId = assetList.length;
  
  // Create new asset entries
  const newAssets = supportedFiles.map((file, index) => ({
    id: `asset-${Date.now()}-${startId + index}`,
    file,
    name: file.name,
    preview: null,
    previewSource: null,
    loaded: false,
  }));
  
  // Try to match assets with image previews
  if (imageFiles.length > 0) {
    await matchPreviewImages(newAssets, imageFiles);
  }
  
  assetList = [...assetList, ...newAssets];
  
  return { count: assetList.length, added: newAssets.length, newAssets };
};

/**
 * Set the asset list from files (single file, multiple files, or folder contents)
 * Also looks for matching image files to use as previews
 */
export const setAssetList = async (files) => {
  // Release existing object URLs before replacing the list
  assetList.forEach(revokeAssetPreviewUrl);

  const supportedFiles = filterSupportedFiles(files);
  
  if (supportedFiles.length === 0) {
    return { count: 0, assets: [] };
  }
  
  // Find image files for potential preview matching
  const imageFiles = findImageFiles(files);
  
  // Create asset entries
  assetList = supportedFiles.map((file, index) => ({
    id: `asset-${Date.now()}-${index}`,
    file,
    name: file.name,
    preview: null,
    previewSource: null,
    loaded: false,
  }));
  
  // Try to match assets with image previews
  if (imageFiles.length > 0) {
    await matchPreviewImages(assetList, imageFiles);
    const matchedCount = assetList.filter(a => a.preview).length;
    if (matchedCount > 0) {
      console.log(`[AssetManager] Matched ${matchedCount}/${assetList.length} assets with image previews`);
    }
  }
  
  // Reset index
  currentAssetIndex = -1;
  
  return { count: assetList.length, assets: assetList };
};

/**
 * Get the current asset list
 */
export const getAssetList = () => assetList;

/**
 * Get the current asset index
 */
export const getCurrentAssetIndex = () => currentAssetIndex;

/**
 * Get an asset by index
 */
export const getAssetByIndex = (index) => {
  if (index < 0 || index >= assetList.length) return null;
  return assetList[index];
};

/**
 * Set the current asset by index and trigger callback
 */
export const setCurrentAssetIndex = (index) => {
  if (index < 0 || index >= assetList.length) return false;
  currentAssetIndex = index;
  assetList[index].loaded = true;
  return true;
};

/**
 * Remove an asset by index
 */
export const removeAsset = (index) => {
  if (index < 0 || index >= assetList.length) return false;
  revokeAssetPreviewUrl(assetList[index]);
  
  assetList.splice(index, 1);
  
  // Update current index if needed
  if (assetList.length === 0) {
    currentAssetIndex = -1;
  } else if (currentAssetIndex >= index) {
    // If we removed the current asset or one before it, adjust index
    if (currentAssetIndex === index) {
        if (currentAssetIndex >= assetList.length) {
            currentAssetIndex = Math.max(0, assetList.length - 1);
        }
    } else {
        currentAssetIndex--;
    }
  }
  
  return true;
};

/**
 * Navigate to next asset
 */
export const nextAsset = () => {
  if (assetList.length === 0) return null;
  const nextIndex = (currentAssetIndex + 1) % assetList.length;
  setCurrentAssetIndex(nextIndex);
  return assetList[nextIndex];
};

/**
 * Navigate to previous asset
 */
export const prevAsset = () => {
  if (assetList.length === 0) return null;
  const prevIndex = currentAssetIndex <= 0 ? assetList.length - 1 : currentAssetIndex - 1;
  setCurrentAssetIndex(prevIndex);
  return assetList[prevIndex];
};

/**
 * Get current asset
 */
const getCurrentAsset = () => {
  if (currentAssetIndex < 0 || currentAssetIndex >= assetList.length) return null;
  return assetList[currentAssetIndex];
};

/**
 * Check if we have multiple assets
 */
export const hasMultipleAssets = () => assetList.length > 1;

/**
 * Get total asset count
 */
export const getAssetCount = () => assetList.length;

/**
 * Set callback for when asset changes
 */
const onAssetChange = (callback) => {
  onAssetChangeCallback = callback;
};

/**
 * Set callback for when a preview is generated
 */
export const onPreviewGenerated = (callback) => {
  onPreviewGeneratedCallback = callback;
};

/**
 * Clear all assets
 */
export const clearAssets = () => {
  assetList.forEach(revokeAssetPreviewUrl);
  assetList = [];
  currentAssetIndex = -1;
};

/**
 * Set assets directly from pre-adapted asset descriptors.
 * Used by storage source loading which provides already-formatted assets.
 * @param {Object[]} assets - Array of asset descriptors
 */
export const setAdaptedAssets = (assets) => {
  assetList.forEach(revokeAssetPreviewUrl);
  assetList = assets.map((asset, index) => ({
    ...asset,
    id: asset.id || `adapted-${Date.now()}-${index}`,
    loaded: false,
  }));
  currentAssetIndex = -1;
  return { count: assetList.length, assets: assetList };
};
