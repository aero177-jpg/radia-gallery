/**
 * Supabase API helpers for bucket exploration
 * 
 * Standalone functions to list and inspect bucket contents
 * before creating a full source connection.
 */

import { getSupportedExtensions } from '../formats/index.js';
import { loadSupabaseManifestCache } from './supabaseSettings.js';
import { getSupabaseClient } from './supabaseClient.js';

/**
 * List all collection folders in the bucket under `collections/`
 * Returns array of { id, name, assetCount, hasManifest }
 */
export async function listExistingCollections({ supabaseUrl, anonKey, bucket }) {
  if (!supabaseUrl || !anonKey || !bucket) {
    return { success: false, error: 'Missing Supabase configuration', collections: [] };
  }

  try {
    const client = getSupabaseClient(supabaseUrl, anonKey);
    const storage = client.storage.from(bucket);

    // List top-level folders under collections/
    const { data: folders, error: listError } = await storage.list('collections', {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    });

    if (listError) {
      return { success: false, error: listError.message, collections: [] };
    }

    if (!folders || folders.length === 0) {
      return { success: true, collections: [] };
    }

    const supportedExtensions = getSupportedExtensions();
    const collections = [];

    for (const folder of folders) {
      // Skip if it's a file, not a folder (folders have no metadata.size)
      if (folder.metadata && typeof folder.metadata.size === 'number') {
        continue;
      }

      const collectionId = folder.name;
      const basePath = `collections/${collectionId}`;

      // Check for manifest without downloading it
      const { data: manifestListing } = await storage.list(basePath, {
        limit: 1,
        search: 'manifest.json',
      });
      const hasManifest = Array.isArray(manifestListing)
        ? manifestListing.some((item) => item?.name === 'manifest.json')
        : false;

      let assetCount = 0;
      let collectionName = collectionId;

      const cachedManifest = hasManifest
        ? loadSupabaseManifestCache({ supabaseUrl, bucket, collectionId })
        : null;

      if (cachedManifest) {
        assetCount = cachedManifest.assets?.length || 0;
        if (cachedManifest.name) collectionName = cachedManifest.name;
      } else {
        // Count assets in assets/ folder (metadata only)
        const { data: assetFiles } = await storage.list(`${basePath}/assets`, { limit: 500 });
        if (assetFiles) {
          assetCount = assetFiles.filter((f) => {
            if (!f.name) return false;
            const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
            return supportedExtensions.includes(ext);
          }).length;
        }
      }

      collections.push({
        id: collectionId,
        name: collectionName,
        assetCount,
        hasManifest,
      });
    }

    return { success: true, collections };
  } catch (err) {
    return { success: false, error: err.message, collections: [] };
  }
}

/**
 * Test bucket connection with current settings
 */
export async function testBucketConnection({ supabaseUrl, anonKey, bucket }) {
  if (!supabaseUrl || !anonKey || !bucket) {
    return { success: false, error: 'Missing configuration' };
  }

  try {
    const client = getSupabaseClient(supabaseUrl, anonKey);
    const storage = client.storage.from(bucket);
    const { error } = await storage.list('', { limit: 1 });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
