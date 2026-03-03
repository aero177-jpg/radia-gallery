/**
 * Cloudflare R2 Storage Source Adapter
 * Manifest-first storage for authenticated R2 buckets.
 * Layout (required):
 * {bucket}/collections/{collectionId}/manifest.json
 * {bucket}/collections/{collectionId}/assets/*
 */

import {
	ListObjectsV2Command,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AssetSource } from './AssetSource.js';
import { createSourceId, MANIFEST_VERSION, SUPPORTED_MANIFEST_VERSIONS } from './types.js';
import { saveSource } from './sourceManager.js';
import { getSupportedExtensions } from '../formats/index.js';
import { getR2Client, buildR2Endpoint } from './r2Client.js';
import { loadR2ManifestCache, loadR2Settings, saveR2ManifestCache } from './r2Settings.js';

const METADATA_SUFFIXES = ['.meta.json', '.metadata.json'];

const isMetadataFile = (filename) => METADATA_SUFFIXES.some((suffix) => filename.toLowerCase().endsWith(suffix));

const getExtension = (filename) => {
	const parts = filename.split('.');
	return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
};

const getFilename = (path) => {
	const parts = path.split('/');
	return parts[parts.length - 1] || path;
};

const getBaseName = (filename) => {
	const name = getFilename(filename);
	const lastDot = name.lastIndexOf('.');
	return lastDot > 0 ? name.slice(0, lastDot) : name;
};

const getMetadataAssetBase = (filename) => {
	const name = getFilename(filename);
	const lowerName = name.toLowerCase();
	const matchedSuffix = METADATA_SUFFIXES.find((suffix) => lowerName.endsWith(suffix));
	if (!matchedSuffix) return null;
	const withoutSuffix = name.slice(0, -matchedSuffix.length);
	return getBaseName(withoutSuffix).toLowerCase();
};

const DEFAULT_PERMISSIONS = {
	canRead: true,
	canWrite: true,
	canDelete: true,
};

const stripLeadingSlash = (value) => value.replace(/^\/+/, '');

const toRelativeFromBase = (fullPath, basePrefix) => {
	const normalized = stripLeadingSlash(fullPath);
	const base = stripLeadingSlash(basePrefix);
	if (normalized.startsWith(`${base}/`)) {
		return normalized.slice(base.length + 1);
	}
	return normalized;
};

const streamToText = async (body) => {
	if (!body) return '';
	const response = new Response(body);
	return response.text();
};

const listAllObjects = async (client, bucket, options = {}) => {
	const results = [];
	let continuationToken = undefined;
	do {
		const command = new ListObjectsV2Command({
			Bucket: bucket,
			...options,
			ContinuationToken: continuationToken,
		});
		const response = await client.send(command);
		if (response?.Contents?.length) {
			results.push(...response.Contents);
		}
		continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
	} while (continuationToken);
	return results;
};

export class R2BucketSource extends AssetSource {
	constructor(config) {
		super(config);
		this._manifest = null;
	}

	_permissions() {
		const next = {
			...DEFAULT_PERMISSIONS,
			...(this.config?.config?.permissions || {}),
		};
		next.canRead = true;
		return next;
	}

	_canWrite() {
		return this._permissions().canWrite;
	}

	_canDelete() {
		return this._permissions().canDelete;
	}

	_isOffline() {
		return typeof navigator !== 'undefined' && navigator.onLine === false;
	}

	_client() {
		const fallbackSettings = loadR2Settings();
		const fallbackSecret = (
			fallbackSettings?.accountId === this.config.config.accountId &&
			fallbackSettings?.bucket === this.config.config.bucket
		)
			? fallbackSettings.secretAccessKey
			: '';

		return getR2Client({
			accountId: this.config.config.accountId,
			accessKeyId: this.config.config.accessKeyId,
			secretAccessKey: this.config.config.secretAccessKey || fallbackSecret,
			endpoint: this.config.config.endpoint,
		});
	}

	_bucket() {
		return this.config.config.bucket;
	}

	_basePrefix() {
		return `collections/${this.config.config.collectionId}`;
	}

	_assetPrefix() {
		return `${this._basePrefix()}/assets`;
	}

	_toStoragePath(relative) {
		return `${this._basePrefix()}/${stripLeadingSlash(relative)}`;
	}

	async _signedUrlFor(relativePath) {
		const client = this._client();
		const command = new GetObjectCommand({
			Bucket: this._bucket(),
			Key: this._toStoragePath(relativePath),
		});
		return getSignedUrl(client, command, { expiresIn: 900 });
	}

	getCapabilities() {
		const permissions = this._permissions();
		return {
			canList: permissions.canRead,
			canStream: true,
			canReadMetadata: true,
			canReadPreviews: false,
			persistent: true,
			writable: this._canWrite(),
		};
	}

	async connect(options = {}) {
		const normalized = typeof options === 'boolean'
			? { refreshManifest: options }
			: options;

		const { refreshManifest = true, verifyUpload = false } = normalized;
		const permissions = this._permissions();
		if (!permissions.canRead) {
			return { success: false, error: 'Read permission is required' };
		}

		const isOffline = this._isOffline();

		if (refreshManifest || !this._manifest) {
			await this._loadManifest({ allowStale: true });
		}

		if (isOffline) {
			if (this._manifest) {
				this._connected = true;
				await saveSource(this.toJSON());
				return { success: true, offline: true };
			}
			return { success: false, error: 'Offline and no cached manifest available', offline: true };
		}

		try {
			await this._ensureManifestLoaded();

			if (verifyUpload && this._canWrite()) {
				const uploadCheck = await this.verifyUploadPermission();
				if (!uploadCheck.success) {
					return uploadCheck;
				}
			}

			this._connected = true;
			await saveSource(this.toJSON());
			return { success: true };
		} catch (error) {
			if (this._manifest) {
				console.log('[R2] Network error, using cached manifest:', error.message);
				this._connected = true;
				await saveSource(this.toJSON());
				return { success: true, offline: true };
			}
			return { success: false, error: error.message };
		}
	}

	async _loadManifest({ bypassCache = false, allowStale = false } = {}) {
		const cacheKey = {
			accountId: this.config.config.accountId,
			bucket: this.config.config.bucket,
			collectionId: this.config.config.collectionId,
		};
		const isOffline = this._isOffline();

		if (!bypassCache) {
			const cachedManifest = isOffline || allowStale
				? loadR2ManifestCache(cacheKey, { maxAgeMs: -1 })
				: loadR2ManifestCache(cacheKey);
			if (cachedManifest) {
				this._manifest = cachedManifest;
				this.config.config.hasManifest = true;
				if (cachedManifest.name) {
					this.name = cachedManifest.name;
					this.config.name = cachedManifest.name;
				}
				return cachedManifest;
			}
		}

		if (isOffline) {
			return null;
		}

		try {
			const client = this._client();
			const manifestKey = this._toStoragePath('manifest.json');
			const response = await client.send(new GetObjectCommand({
				Bucket: this._bucket(),
				Key: manifestKey,
			}));

			const text = await streamToText(response.Body);
			const manifest = JSON.parse(text);

			if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
				throw new Error(`Unsupported manifest version: ${manifest.version}`);
			}

			this._manifest = manifest;
			this.config.config.hasManifest = true;
			saveR2ManifestCache(cacheKey, manifest);

			if (manifest.name) {
				this.name = manifest.name;
				this.config.name = manifest.name;
			}

			return manifest;
		} catch (error) {
			if (this._manifest) {
				console.warn('[R2] Manifest fetch failed, using cached manifest:', error.message);
				return this._manifest;
			}
			this.config.config.hasManifest = false;
			this._manifest = null;
			return null;
		}
	}

	async _saveManifest(manifest) {
		const payload = JSON.stringify(manifest, null, 2);
		const manifestKey = this._toStoragePath('manifest.json');
		const client = this._client();
		await client.send(new PutObjectCommand({
			Bucket: this._bucket(),
			Key: manifestKey,
			Body: payload,
			ContentType: 'application/json',
			CacheControl: 'no-cache',
		}));
		this._manifest = manifest;
		this.config.config.hasManifest = true;
		saveR2ManifestCache({
			accountId: this.config.config.accountId,
			bucket: this.config.config.bucket,
			collectionId: this.config.config.collectionId,
		}, manifest);
		await saveSource(this.toJSON());
	}

	async _ensureManifestLoaded() {
		if (!this._manifest && this.config.config.hasManifest !== false) {
			await this._loadManifest({ allowStale: true });
		}
		const isOffline = this._isOffline();
		if (!this._manifest && !isOffline) {
			// NOTE: We auto-generate a manifest on first connect for existing buckets.
			// If this causes friction, consider moving this to an explicit "Rescan" action later.
			const generated = await this._generateManifestFromBucket();
			if (generated) {
				await this._saveManifest(generated);
			}
		}
		return this._manifest;
	}

	async _scanBucket() {
		const client = this._client();
		const assetPrefix = `${this._assetPrefix()}/`;
		const objects = await listAllObjects(client, this._bucket(), { Prefix: assetPrefix });

		const storageFiles = objects.map((item) => item.Key).filter(Boolean);
		const relativeFiles = storageFiles.map((path) => toRelativeFromBase(path, this._basePrefix()));
		const supportedExtensions = getSupportedExtensions();

		const assetPaths = relativeFiles.filter((path) => supportedExtensions.includes(getExtension(path)));
		const metadataByBase = this._buildMetadataMap(storageFiles);

		const objectByRelative = new Map();
		for (const obj of objects) {
			if (!obj.Key) continue;
			objectByRelative.set(toRelativeFromBase(obj.Key, this._basePrefix()), obj);
		}

		return {
			objects,
			storageFiles,
			relativeFiles,
			assetPaths,
			metadataByBase,
			objectByRelative,
		};
	}

	async _generateManifestFromBucket() {
		const scan = await this._scanBucket();

		const assets = scan.assetPaths.map((path) => {
			const base = getBaseName(path).toLowerCase();
			const obj = scan.objectByRelative.get(path);
			return {
				path,
				name: getFilename(path),
				size: obj?.Size,
				metadata: scan.metadataByBase.get(base) || null,
			};
		});

		return {
			version: MANIFEST_VERSION,
			name: this.config.config.collectionName || this.config.config.collectionId,
			assets,
		};
	}

	async listAssets() {
		if (!this._connected) {
			throw new Error('Not connected');
		}

		await this._ensureManifestLoaded();
		const supportedExtensions = getSupportedExtensions();
		const assets = [];

		if (!this._manifest) {
			this._assets = [];
			return [];
		}

		for (const item of this._manifest.assets || []) {
			const ext = getExtension(item.path);
			if (!supportedExtensions.includes(ext)) continue;

			assets.push({
				id: `${this.id}/${item.path}`,
				name: item.name || getFilename(item.path),
				path: item.path,
				sourceId: this.id,
				sourceType: this.type,
				size: item.size,
				preview: null,
				previewSource: null,
				_metadataPath: typeof item.metadata === 'string' ? item.metadata : null,
				_inlineMetadata: typeof item.metadata === 'object' ? item.metadata : null,
				loaded: false,
			});
		}

		this._assets = assets;
		return assets;
	}

	async fetchAssetData(asset) {
		const url = await this._signedUrlFor(asset.path);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
		}
		return response.arrayBuffer();
	}

	async fetchAssetStream(asset) {
		const url = await this._signedUrlFor(asset.path);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch asset: ${response.status} ${response.statusText}`);
		}
		return response.body;
	}

	async fetchPreview(asset) {
		return null;
	}

	async fetchMetadata(asset) {
		if (asset._inlineMetadata) {
			return asset._inlineMetadata;
		}

		if (asset._metadataPath) {
			const url = await this._signedUrlFor(asset._metadataPath);
			const response = await fetch(url);
			if (response.ok) {
				return response.json();
			}
		}

		return null;
	}

	_buildMetadataMap(filePaths) {
		const metadataByBase = new Map();

		for (const path of filePaths) {
			const relative = toRelativeFromBase(path, this._basePrefix());

			const metadataBase = getMetadataAssetBase(relative);
			if (metadataBase) {
				metadataByBase.set(metadataBase, relative);
			}
		}

		return metadataByBase;
	}

	async rescan({ applyChanges = false } = {}) {
		if (!this._connected) {
			const result = await this.connect({ refreshManifest: true });
			if (!result.success) return { success: false, error: result.error };
		}

		const scan = await this._scanBucket();

		const manifestAssets = this._manifest?.assets || [];
		const manifestPaths = new Set(manifestAssets.map((a) => a.path));

		const newPaths = scan.assetPaths.filter((path) => !manifestPaths.has(path));
		const missingPaths = Array.from(manifestPaths).filter((path) => !scan.assetPaths.includes(path));

		const additions = newPaths.map((path) => {
			const base = getBaseName(path).toLowerCase();
			return {
				path,
				name: getFilename(path),
				metadata: scan.metadataByBase.get(base) || null,
			};
		});

		if (applyChanges) {
			const nextManifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };
			const existingByPath = new Map(nextManifest.assets.map((a) => [a.path, a]));

			additions.forEach((item) => {
				if (!existingByPath.has(item.path)) {
					nextManifest.assets.push(item);
				}
			});

			await this._saveManifest(nextManifest);
			await this.listAssets();
		}

		return {
			success: true,
			added: additions,
			missing: missingPaths,
			hasManifest: !!this._manifest,
			totalFiles: scan.assetPaths.length,
			applied: !!applyChanges,
		};
	}

	async uploadAssets(files) {
		if (!this._canWrite()) {
			return { success: false, error: 'Write permission is disabled for this source' };
		}

		if (!this._connected) {
			const result = await this.connect({ refreshManifest: true });
			if (!result.success) return { success: false, error: result.error };
		}

		await this._ensureManifestLoaded();
		const manifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };
		const supportedExtensions = getSupportedExtensions();
		const client = this._client();
		const results = { uploaded: [], failed: [] };
		const existingByPath = new Map(manifest.assets.map((a) => [a.path, a]));
		const assetsByBase = new Map();
		for (const asset of manifest.assets) {
			const base = getBaseName(asset.path).toLowerCase();
			const list = assetsByBase.get(base) || [];
			list.push(asset);
			assetsByBase.set(base, list);
		}

		for (const file of files) {
			const ext = getExtension(file.name);
			const base = getBaseName(file.name).toLowerCase();
			const metadataBase = getMetadataAssetBase(file.name);

			if (!supportedExtensions.includes(ext) && !isMetadataFile(file.name)) {
				results.failed.push({ name: file.name, error: 'Unsupported file type' });
				continue;
			}

			const targetPath = `${this._assetPrefix()}/${file.name}`;
			const relative = toRelativeFromBase(targetPath, this._basePrefix());
			try {
				// AWS SDK v3 in browser requires ArrayBuffer/Uint8Array for Body
				const arrayBuffer = await file.arrayBuffer();
				await client.send(new PutObjectCommand({
					Bucket: this._bucket(),
					Key: targetPath,
					Body: new Uint8Array(arrayBuffer),
					ContentType: file.type || 'application/octet-stream',
					CacheControl: 'public, max-age=31536000, immutable',
				}));
			} catch (error) {
				results.failed.push({ name: file.name, error: error.message });
				continue;
			}

			if (supportedExtensions.includes(ext)) {
				if (!existingByPath.has(relative)) {
					const newAsset = {
						path: relative,
						name: file.name,
						size: file.size,
					};
					manifest.assets.push(newAsset);
					existingByPath.set(relative, newAsset);
					const list = assetsByBase.get(base) || [];
					list.push(newAsset);
					assetsByBase.set(base, list);
				} else {
					const existing = existingByPath.get(relative);
					existing.name = file.name;
					existing.size = file.size;
				}
			} else if (metadataBase) {
				const matched = assetsByBase.get(metadataBase) || [];
				for (const asset of matched) {
					asset.metadata = relative;
				}
			}

			results.uploaded.push({ name: file.name, path: relative });
		}

		await this._saveManifest(manifest);
		await this.listAssets();
		return { success: results.failed.length === 0, ...results };
	}

	async deleteAssets(items) {
		if (!this._canDelete()) {
			return { success: false, error: 'Delete permission is disabled for this source' };
		}

		if (!this._connected) {
			const result = await this.connect({ refreshManifest: true });
			if (!result.success) return { success: false, error: result.error };
		}

		await this._ensureManifestLoaded();
		const manifest = this._manifest || { version: MANIFEST_VERSION, name: this.name, assets: [] };

		const normalized = Array.isArray(items) ? items : [items];
		const targetPaths = new Set();
		const removedPaths = new Set();
		const failures = [];

		for (const item of normalized) {
			const rawPath = typeof item === 'string'
				? item
				: item?.path || item?._remoteAsset?.path;

			if (!rawPath) {
				failures.push({ path: null, error: 'Missing path' });
				continue;
			}

			const relativePath = toRelativeFromBase(stripLeadingSlash(rawPath), this._basePrefix());
			removedPaths.add(relativePath);

			const manifestEntry = manifest.assets.find((a) => a.path === relativePath);
			if (manifestEntry?.metadata) {
				targetPaths.add(this._toStoragePath(manifestEntry.metadata));
			}

			targetPaths.add(this._toStoragePath(relativePath));
		}

		if (targetPaths.size === 0) {
			return { success: false, error: 'No valid paths to delete', failed: failures };
		}

		const client = this._client();
		const deleteResponse = await client.send(new DeleteObjectsCommand({
			Bucket: this._bucket(),
			Delete: {
				Objects: Array.from(targetPaths).map((Key) => ({ Key })),
				Quiet: true,
			},
		}));

		const failedDeleteKeys = new Set((deleteResponse?.Errors || []).map((item) => item?.Key).filter(Boolean));
		for (const item of deleteResponse?.Errors || []) {
			failures.push({ path: item?.Key || null, error: item?.Message || item?.Code || 'Delete failed' });
		}

		const removedSuccessfully = Array.from(removedPaths).filter((path) => !failedDeleteKeys.has(this._toStoragePath(path)));

		if (removedSuccessfully.length > 0) {
			const removedSet = new Set(removedSuccessfully);
			manifest.assets = manifest.assets.filter((a) => !removedSet.has(a.path));
			await this._saveManifest(manifest);
			await this.listAssets();
		}

		return { success: failures.length === 0, removed: removedSuccessfully, failed: failures };
	}

	async verifyUploadPermission() {
		if (!this._canWrite()) {
			return { success: false, error: 'Write permission is disabled for this source' };
		}

		const client = this._client();
		const probeName = `${this._basePrefix()}/__upload_probe_${Date.now()}.txt`;

		try {
			await client.send(new PutObjectCommand({
				Bucket: this._bucket(),
				Key: probeName,
				Body: 'ok',
				ContentType: 'text/plain',
				CacheControl: 'public, max-age=31536000, immutable',
			}));
			await client.send(new DeleteObjectsCommand({
				Bucket: this._bucket(),
				Delete: { Objects: [{ Key: probeName }], Quiet: true },
			}));
			return { success: true };
		} catch (error) {
			return { success: false, error: error.message };
		}
	}
}

export const createR2BucketSource = ({
	accountId,
	accessKeyId,
	secretAccessKey,
	bucket,
	collectionId,
	name,
	collectionName,
	permissions,
}) => {
	const id = createSourceId('r2-bucket');
	const displayName = name || collectionName || `R2: ${bucket ? `${bucket}/` : ''}${collectionId}`;
	const endpoint = buildR2Endpoint(accountId);
	const normalizedPermissions = {
		...DEFAULT_PERMISSIONS,
		...(permissions || {}),
	};
	normalizedPermissions.canRead = true;

	const config = {
		id,
		type: 'r2-bucket',
		name: displayName,
		createdAt: Date.now(),
		lastAccessed: Date.now(),
		isDefault: false,
		config: {
			accountId: String(accountId || '').trim(),
			accessKeyId: String(accessKeyId || '').trim(),
			secretAccessKey: String(secretAccessKey || '').trim(),
			endpoint,
			bucket: String(bucket || '').trim(),
			collectionId: String(collectionId || '').trim(),
			collectionName: collectionName || displayName,
			permissions: normalizedPermissions,
			hasManifest: false,
		},
	};

	return new R2BucketSource(config);
};

export const restoreR2BucketSource = (config) => {
	return new R2BucketSource(config);
};


