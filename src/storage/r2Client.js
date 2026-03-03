/**
 * Shared Cloudflare R2 (S3-compatible) client factory.
 * Ensures one S3Client per credential set.
 */
import { S3Client } from '@aws-sdk/client-s3';

const clientCache = new Map();

export const buildR2Endpoint = (accountId) => {
  const normalized = String(accountId || '').trim();
  return normalized ? `https://${normalized}.r2.cloudflarestorage.com` : '';
};

export const getR2Client = ({ accountId, endpoint, accessKeyId, secretAccessKey }) => {
  const resolvedEndpoint = endpoint || buildR2Endpoint(accountId);
  const normalizedEndpoint = String(resolvedEndpoint || '').trim();
  const normalizedAccessKey = String(accessKeyId || '').trim();
  const normalizedSecretKey = String(secretAccessKey || '').trim();
  const cacheKey = `${normalizedEndpoint}::${normalizedAccessKey}::${normalizedSecretKey}`;

  if (!clientCache.has(cacheKey)) {
    const client = new S3Client({
      region: 'auto',
      endpoint: normalizedEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: normalizedAccessKey,
        secretAccessKey: normalizedSecretKey,
      },
    });
    clientCache.set(cacheKey, client);
  }

  return clientCache.get(cacheKey);
};
