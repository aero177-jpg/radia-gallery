/**
 * Shared Supabase client factory
 * Ensures one GoTrueClient per (url, key) in the browser context.
 */
import { createClient } from '@supabase/supabase-js';

const clientCache = new Map();

export const getSupabaseClient = (url, key) => {
  const normalizedUrl = String(url || '').trim();
  const normalizedKey = String(key || '').trim();
  const cacheKey = `${normalizedUrl}::${normalizedKey}`;

  if (!clientCache.has(cacheKey)) {
    const client = createClient(normalizedUrl, normalizedKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    clientCache.set(cacheKey, client);
  }

  return clientCache.get(cacheKey);
};
