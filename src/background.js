import piexif from 'piexifjs';

const DEFAULT_OPTIONS = {
	imageFolder: '',
	videoFolder: '',
	allowedHosts: [
		'x.com',
		'twitter.com',
		'abs.twimg.com',
		'api.x.com',
		'pbs.twimg.com',
		'video.twimg.com',
	],
};

const SUPPORTED_HOSTS = new Set(DEFAULT_OPTIONS.allowedHosts);

const TWITTER_MEDIA_HOST = 'video.twimg.com';
const twitterRequestsByTab = new Map();
const twitterVariantsByTab = new Map();
const twitterMetadataByTab = new Map();
const TWITTER_GRAPHQL_URLS = [
	'*://x.com/i/api/graphql/*',
	'*://twitter.com/i/api/graphql/*',
	'*://api.x.com/i/api/graphql/*',
	'*://api.twitter.com/i/api/graphql/*',
];

function normalizeFolder(input) {
	if (!input || typeof input !== 'string') {
		return '';
	}

	const cleaned = input.trim().replace(/\\/g, '/');
	const parts = cleaned.split('/').map((part) => part.trim()).filter((part) => part && part !== '.' && part !== '..');
	return parts.join('/');
}

function normalizeHost(value) {
	if (!value || typeof value !== 'string') {
		return '';
	}
	return value.trim().toLowerCase();
}

function isHostAllowed(hostname) {
	const host = normalizeHost(hostname);
	if (!host) {
		return false;
	}
	return SUPPORTED_HOSTS.has(host);
}

function extractFilename(url) {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split('/').filter(Boolean);
		const lastSegment = segments.at(-1);
		if (lastSegment) {
			return decodeURIComponent(lastSegment);
		}
	} catch (error) {
		// Ignore invalid URLs and fallback to a generated filename.
	}
	return '';
}

function extractExtensionFromUrl(url) {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname || '';
		const lastDot = path.lastIndexOf('.');
		if (lastDot !== -1 && lastDot < path.length - 1) {
			return path.slice(lastDot).toLowerCase();
		}
		const format = parsed.searchParams.get('format') || parsed.searchParams.get('fm') || parsed.searchParams.get('ext');
		if (format && /^[a-z0-9]+$/i.test(format)) {
			return `.${format.toLowerCase()}`;
		}
	} catch (error) {
		// Ignore invalid URLs.
	}
	return '';
}

function highestQualityTwitterImageUrl(url) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'pbs.twimg.com' || !parsed.pathname.startsWith('/media/')) {
			return url;
		}

		// X serves the same image at different sizes via the `name` parameter.
		// `orig` requests the uploaded dimensions, regardless of the size used in the feed.
		parsed.searchParams.set('name', 'orig');
		return parsed.toString();
	} catch {
		return url;
	}
}

function ensureExtension(filename, url, mimeType) {
	if (/\.[a-z0-9]{2,5}$/i.test(filename)) {
		return filename;
	}
	const urlExtension = extractExtensionFromUrl(url);
	if (urlExtension) {
		return `${filename}${urlExtension}`;
	}
	const mimeExtension = extensionFromMimeType(mimeType);
	if (mimeExtension) {
		return `${filename}${mimeExtension}`;
	}
	return filename;
}

function buildFilename(url, folder, mediaType, mimeType) {
	const baseName = extractFilename(url) || `${mediaType || 'download'}-${Date.now()}`;
	const withExtension = ensureExtension(baseName, url, mimeType);
	if (!folder) {
		return withExtension;
	}
	return `${folder}/${withExtension}`;
}

function buildFilenameFromHint(folder, filenameHint, mediaType) {
	const baseName = filenameHint || `${mediaType || 'download'}-${Date.now()}`;
	if (!folder) {
		return baseName;
	}
	return `${folder}/${baseName}`;
}

function sanitizeFilenamePart(value) {
	return String(value || '').trim().replace(/^@/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
}

function buildMetadataFilename(folder, metadata, url, mimeType, fallbackMediaType) {
	const postId = sanitizeFilenamePart(metadata?.postId);
	const handle = sanitizeFilenamePart(metadata?.twitterHandle);
	if (!postId || !handle) {
		return buildFilename(url, folder, fallbackMediaType, mimeType);
	}
	const extension = extensionFromMimeType(mimeType) || extractExtensionFromUrl(url) || '.jpg';
	const filename = `${postId}_${handle}${extension}`;
	return folder ? `${folder}/${filename}` : filename;
}

function arrayBufferToDataUrl(buffer, mimeType) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

function dataUrlToUint8Array(dataUrl) {
	const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function toExifDate(value) {
	if (!value) {
		return '';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toISOString().slice(0, 19).replace(/[-T]/g, (character) => character === 'T' ? ' ' : ':');
}

function stringifyExifMetadata(metadata) {
	const toAsciiJson = (value) => JSON.stringify(value).replace(/[\u007F-\uFFFF]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
	const full = toAsciiJson(metadata);
	if (full.length <= 48_000) {
		return full;
	}
	const { apiTweet, apiMedia, apiUser, ...pageMetadata } = metadata;
	const apiPayload = toAsciiJson({ apiTweet, apiMedia, apiUser });
	let payloadLength = Math.min(apiPayload.length, 32_000);
	let bounded = '';
	do {
		bounded = toAsciiJson({
			...pageMetadata,
			apiMetadataTruncated: true,
			apiPayload: apiPayload.slice(0, payloadLength),
		});
		payloadLength = Math.max(0, payloadLength - Math.max(1000, bounded.length - 47_000));
	} while (bounded.length > 48_000 && payloadLength > 0);
	return bounded;
}

function decimalToDmsRational(value) {
	const degrees = Math.floor(value);
	const minutesFloat = (value - degrees) * 60;
	const minutes = Math.floor(minutesFloat);
	const seconds = (minutesFloat - minutes) * 60;
	return [ [ degrees, 1 ], [ minutes, 1 ], [ Math.round(seconds * 10_000), 10_000 ] ];
}

function getMetadataCoordinates(metadata) {
	const coordinates = metadata?.apiTweet?.coordinates?.coordinates;
	if (Array.isArray(coordinates) && coordinates.length >= 2) {
		const longitude = Number(coordinates[0]);
		const latitude = Number(coordinates[1]);
		if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
			return { latitude, longitude };
		}
	}
	return null;
}

function embedJpegMetadata(buffer, mimeType, metadata) {
	const dataUrl = arrayBufferToDataUrl(buffer, mimeType);
	let exif;
	try {
		exif = piexif.load(dataUrl);
	} catch {
		exif = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
	}
	const json = stringifyExifMetadata(metadata);
	exif['0th'][piexif.ImageIFD.Make] = 'X (Twitter)';
	exif['0th'][piexif.ImageIFD.Model] = `@${metadata.twitterHandle || ''}`;
	exif['0th'][piexif.ImageIFD.Artist] = metadata.userName || metadata.twitterHandle || '';
	exif['0th'][piexif.ImageIFD.Software] = 'XDL Hover Downloader';
	exif['0th'][piexif.ImageIFD.ImageDescription] = [metadata.postUrl, metadata.mediaUrl].filter(Boolean).join(' | ').slice(0, 2000);
	exif['0th'][piexif.ImageIFD.DocumentName] = `${metadata.postId || ''}_${metadata.twitterHandle || ''}`;
	exif.Exif[piexif.ExifIFD.ImageUniqueID] = `${metadata.postId || ''}:${metadata.photoNumber || 1}:${metadata.mediaId || ''}`;
	const exifDate = toExifDate(metadata.postedAt);
	if (exifDate) {
		exif.Exif[piexif.ExifIFD.DateTimeOriginal] = exifDate;
		exif.Exif[piexif.ExifIFD.DateTimeDigitized] = exifDate;
	}
	const coordinates = getMetadataCoordinates(metadata);
	if (coordinates) {
		exif.GPS[piexif.GPSIFD.GPSLatitudeRef] = coordinates.latitude >= 0 ? 'N' : 'S';
		exif.GPS[piexif.GPSIFD.GPSLatitude] = decimalToDmsRational(Math.abs(coordinates.latitude));
		exif.GPS[piexif.GPSIFD.GPSLongitudeRef] = coordinates.longitude >= 0 ? 'E' : 'W';
		exif.GPS[piexif.GPSIFD.GPSLongitude] = decimalToDmsRational(Math.abs(coordinates.longitude));
	}
	// piexifjs defines UserComment as ASCII. Keep enough headroom for the EXIF APP1
	// segment's 64 KiB limit while preserving the complete page payload in normal cases.
	exif.Exif[piexif.ExifIFD.UserComment] = json;
	const exifBytes = piexif.dump(exif);
	return dataUrlToUint8Array(piexif.insert(exifBytes, dataUrl));
}

function crc32(bytes) {
	let crc = 0xFFFFFFFF;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
		}
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPngChunk(type, data) {
	const typeBytes = new TextEncoder().encode(type);
	const output = new Uint8Array(12 + data.length);
	const view = new DataView(output.buffer);
	view.setUint32(0, data.length);
	output.set(typeBytes, 4);
	output.set(data, 8);
	const crcInput = new Uint8Array(typeBytes.length + data.length);
	crcInput.set(typeBytes);
	crcInput.set(data, typeBytes.length);
	view.setUint32(8 + data.length, crc32(crcInput));
	return output;
}

function embedPngMetadata(buffer, metadata) {
	const bytes = new Uint8Array(buffer);
	const iendOffset = bytes.length - 12;
	if (iendOffset < 8 || new TextDecoder().decode(bytes.subarray(iendOffset + 4, iendOffset + 8)) !== 'IEND') {
		return bytes;
	}
	const keyword = new TextEncoder().encode('XDLMetadata');
	const value = new TextEncoder().encode(JSON.stringify(metadata));
	const data = new Uint8Array(keyword.length + 5 + value.length);
	data.set(keyword);
	data.set(value, keyword.length + 5);
	const chunk = createPngChunk('iTXt', data);
	const output = new Uint8Array(bytes.length + chunk.length);
	output.set(bytes.subarray(0, iendOffset));
	output.set(chunk, iendOffset);
	output.set(bytes.subarray(iendOffset), iendOffset + chunk.length);
	return output;
}

function embedImageMetadata(buffer, mimeType, metadata) {
	const normalized = (mimeType || '').split(';')[0].trim().toLowerCase();
	if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
		return embedJpegMetadata(buffer, 'image/jpeg', metadata);
	}
	if (normalized === 'image/png') {
		return embedPngMetadata(buffer, metadata);
	}
	return new Uint8Array(buffer);
}

async function saveBlob(blob, filename) {
	const objectUrl = URL.createObjectURL(blob);
	try {
		return await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
	} finally {
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
	}
}

function extractTwitterMediaId(url) {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/\/(?:amplify_video|ext_tw_video|tweet_video)\/(\d+)\//);
		if (match) {
			return match[1];
		}
	} catch (error) {
		// Ignore invalid URLs.
	}
	return '';
}

function normalizeMediaId(raw) {
	if (!raw) {
		return '';
	}
	if (typeof raw === 'number') {
		return String(raw);
	}
	if (typeof raw === 'string') {
		if (raw.includes('_')) {
			return raw.split('_').pop() || '';
		}
		return raw;
	}
	return '';
}

function isProgressiveTwitterMp4(url) {
	if (!url || !url.includes('video.twimg.com') || !url.includes('.mp4')) {
		return false;
	}
	if (url.includes('/0/0/') || url.includes('/0/3000/') || url.includes('/3000/6000/')) {
		return false;
	}
	if (url.includes('.m4s')) {
		return false;
	}
	return /\/vid\/avc1\/\d+x\d+\/[^/]+\.mp4/.test(url);
}

function recordTwitterVideoRequest(tabId, url) {
	if (tabId < 0 || !url) {
		return;
	}
	const mediaId = extractTwitterMediaId(url);
	const now = Date.now();
	let entry = twitterRequestsByTab.get(tabId);
	if (!entry) {
		entry = { byMediaId: new Map(), lastSeen: null };
		twitterRequestsByTab.set(tabId, entry);
	}

	const record = { url, timestamp: now };
	if (mediaId) {
		entry.byMediaId.set(mediaId, record);
	}
	entry.lastSeen = record;
}

function parseResolutionFromUrl(url) {
	const match = url.match(/\/(\d+)x(\d+)\//);
	if (!match) {
		return 0;
	}
	const width = Number(match[1]) || 0;
	const height = Number(match[2]) || 0;
	return width * height;
}

function scoreMp4Variant(variant) {
	if (!variant) {
		return 0;
	}
	const bitrate = Number(variant.bitrate) || 0;
	const resolution = parseResolutionFromUrl(variant.url || '');
	return bitrate * 1_000_000 + resolution;
}

function recordTwitterVariant(tabId, mediaId, variant) {
	if (tabId < 0 || !mediaId || !variant || !variant.url) {
		return;
	}
	let entry = twitterVariantsByTab.get(tabId);
	if (!entry) {
		entry = { byMediaId: new Map(), lastSeen: null };
		twitterVariantsByTab.set(tabId, entry);
	}

	const current = entry.byMediaId.get(mediaId);
	if (!current || scoreMp4Variant(variant) > scoreMp4Variant(current)) {
		entry.byMediaId.set(mediaId, variant);
		entry.lastSeen = variant;
	}
}

function recordTwitterApiMetadata(tabId, tweet) {
	const mediaItems = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media;
	if (!Array.isArray(mediaItems)) {
		return;
	}
	const user = tweet.core?.user_results?.result || null;
	let tabMetadata = twitterMetadataByTab.get(tabId);
	if (!tabMetadata) {
		tabMetadata = new Map();
		twitterMetadataByTab.set(tabId, tabMetadata);
	}
	for (const media of mediaItems) {
		const apiMetadata = {
			apiTweet: tweet.legacy,
			apiMedia: media,
			apiUser: user ? {
				restId: user.rest_id,
				legacy: user.legacy,
				core: user.core,
				verification: user.verification,
				professional: user.professional,
			} : null,
		};
		const keys = [
			normalizeMediaId(media.id_str || media.id || media.media_key),
			normalizeMediaId(media.media_key),
		];
		try {
			const mediaUrl = media.media_url_https || media.media_url || '';
			keys.push(new URL(mediaUrl).pathname.split('/').filter(Boolean).at(-1));
		} catch {
			// Ignore malformed API media URLs.
		}
		for (const key of keys.filter(Boolean)) {
			tabMetadata.set(key, apiMetadata);
		}
	}
}

function extractTwitterVariantsFromJson(data, tabId) {
	const visited = new Set();
	const stack = [ data ];

	while (stack.length) {
		const value = stack.pop();
		if (!value || typeof value !== 'object') {
			continue;
		}
		if (visited.has(value)) {
			continue;
		}
		visited.add(value);
		if (value.legacy && (value.rest_id || value.id_str)) {
			recordTwitterApiMetadata(tabId, value);
		}

		if (value.video_info && Array.isArray(value.video_info.variants)) {
			const mediaId = normalizeMediaId(value.id_str || value.id || value.media_key);
			if (mediaId) {
				for (const variant of value.video_info.variants) {
					if (!variant || variant.content_type !== 'video/mp4' || !variant.url) {
						continue;
					}
					recordTwitterVariant(tabId, mediaId, {
						url: variant.url,
						bitrate: variant.bitrate || 0,
					});
				}
			}
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				stack.push(item);
			}
		} else {
			for (const item of Object.values(value)) {
				stack.push(item);
			}
		}
	}
}

async function resolveTwitterVideoUrl(tabId, mediaId) {
	const variantsEntry = twitterVariantsByTab.get(tabId);
	if (variantsEntry) {
		if (mediaId && variantsEntry.byMediaId.has(mediaId)) {
			return variantsEntry.byMediaId.get(mediaId).url;
		}
		if (variantsEntry.lastSeen) {
			return variantsEntry.lastSeen.url;
		}
	}

	const entry = twitterRequestsByTab.get(tabId);
	if (!entry) {
		return '';
	}
	let record = null;
	if (mediaId && entry.byMediaId.has(mediaId)) {
		record = entry.byMediaId.get(mediaId);
	} else {
		record = entry.lastSeen;
	}
	if (!record || !record.url) {
		return '';
	}
	if (record.url.includes('.mp4') && isProgressiveTwitterMp4(record.url)) {
		return record.url;
	}

	return '';
}

function getOptions() {
	return new Promise((resolve) => {
		chrome.storage.sync.get(DEFAULT_OPTIONS, (result) => {
			resolve(result || { ...DEFAULT_OPTIONS });
		});
	});
}

function getSenderHostname(sender) {
	const url = sender?.tab?.url || '';
	if (!url) {
		return '';
	}
	try {
		return new URL(url).hostname;
	} catch (error) {
		return '';
	}
}

async function ensureAllowedSender(sender, options) {
	const hostname = getSenderHostname(sender);
	if (!hostname) {
		return;
	}
	if (!isHostAllowed(hostname)) {
		throw new Error('Site not allowed');
	}
}

async function handleDownloadRequest(message, sender) {
	const { url, mediaType, metadata } = message;
	if (!url) {
		throw new Error('Missing URL');
	}

	const options = await getOptions();
	await ensureAllowedSender(sender, options);
	const folder = normalizeFolder(mediaType === 'video' ? options.videoFolder : options.imageFolder);
	const downloadUrl = mediaType === 'image' ? highestQualityTwitterImageUrl(url) : url;
	const apiMetadata = metadata?.mediaId
		? twitterMetadataByTab.get(sender?.tab?.id)?.get(metadata.mediaId)
		: null;
	const completeMetadata = metadata ? { ...metadata, ...apiMetadata } : null;
	if (mediaType === 'image' && completeMetadata?.postId && completeMetadata?.twitterHandle) {
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`Image fetch failed with ${response.status}`);
		}
		const mimeType = response.headers.get('content-type') || '';
		const embedded = embedImageMetadata(await response.arrayBuffer(), mimeType, completeMetadata);
		const filename = buildMetadataFilename(folder, completeMetadata, downloadUrl, mimeType, mediaType);
		const downloadId = await saveBlob(new Blob([embedded], { type: mimeType || 'application/octet-stream' }), filename);
		return { ok: true, downloadId };
	}

	const mimeType = await fetchContentType(downloadUrl);
	const filename = completeMetadata
		? buildMetadataFilename(folder, completeMetadata, downloadUrl, mimeType, mediaType)
		: buildFilename(downloadUrl, folder, mediaType, mimeType);

	const downloadId = await chrome.downloads.download({
		url: downloadUrl,
		filename,
		saveAs: false,
	});

	return { ok: true, downloadId };
}

async function handleBlobDownloadRequest(message, sender) {
	const { data, mimeType, filenameHint, mediaType, metadata } = message;
	if (!data) {
		throw new Error('Missing blob data');
	}

	const options = await getOptions();
	await ensureAllowedSender(sender, options);
	const folder = normalizeFolder(mediaType === 'video' ? options.videoFolder : options.imageFolder);
	const filename = metadata
		? buildMetadataFilename(folder, metadata, metadata.mediaUrl || '', mimeType, mediaType)
		: buildFilenameFromHint(folder, filenameHint, mediaType);
	const embedded = mediaType === 'image' && metadata
		? embedImageMetadata(data, mimeType, metadata)
		: new Uint8Array(data);
	const blob = new Blob([embedded], { type: mimeType || 'application/octet-stream' });
	const downloadId = await saveBlob(blob, filename);

	return { ok: true, downloadId };
}

async function handleTwitterVideoDownload(message, sender) {
	const tabId = sender?.tab?.id;
	if (tabId === undefined || tabId < 0) {
		throw new Error('Missing tab context');
	}
	const mediaId = message.mediaId || '';
	const url = await resolveTwitterVideoUrl(tabId, mediaId);
	if (!url) {
		throw new Error('Unable to resolve Twitter video URL');
	}
	return handleDownloadRequest({ url, mediaType: 'video', metadata: message.metadata }, sender);
}

if (chrome.webRequest?.onBeforeRequest) {
	chrome.webRequest.onBeforeRequest.addListener(
		(details) => {
			if (!details || typeof details.url !== 'string') {
				return;
			}
			if (!details.url.includes(TWITTER_MEDIA_HOST)) {
				return;
			}
			if (!details.url.includes('.m3u8') && !details.url.includes('.mp4')) {
				return;
			}
			recordTwitterVideoRequest(details.tabId, details.url);
		},
		{ urls: [ `*://${TWITTER_MEDIA_HOST}/*` ] },
	);

	if (chrome.webRequest.filterResponseData) {
		chrome.webRequest.onBeforeRequest.addListener(
			(details) => {
				if (!details || details.tabId < 0) {
					return;
				}
				const filter = chrome.webRequest.filterResponseData(details.requestId);
				const decoder = new TextDecoder('utf-8');
				let buffer = '';

				filter.ondata = (event) => {
					buffer += decoder.decode(event.data, { stream: true });
					filter.write(event.data);
				};

				filter.onstop = () => {
					buffer += decoder.decode();
					try {
						const json = JSON.parse(buffer);
						extractTwitterVariantsFromJson(json, details.tabId);
					} catch (error) {
						// Ignore parsing failures for non-JSON responses.
					}
					filter.disconnect();
				};
			},
			{ urls: TWITTER_GRAPHQL_URLS },
			[ 'blocking' ],
		);
	}

	chrome.tabs.onRemoved.addListener((tabId) => {
		twitterRequestsByTab.delete(tabId);
		twitterVariantsByTab.delete(tabId);
		twitterMetadataByTab.delete(tabId);
	});
}

function extensionFromMimeType(mimeType) {
	const normalized = (mimeType || '').split(';')[0].trim().toLowerCase();
	const map = {
		'video/mp4': '.mp4',
		'video/webm': '.webm',
		'video/ogg': '.ogv',
		'image/jpeg': '.jpg',
		'image/jpg': '.jpg',
		'image/png': '.png',
		'image/gif': '.gif',
		'image/webp': '.webp',
		'image/avif': '.avif',
		'image/svg+xml': '.svg',
		'image/bmp': '.bmp',
		'image/tiff': '.tiff',
	};
	return map[normalized] || '';
}

async function fetchContentType(url) {
	try {
		const response = await fetch(url, { method: 'HEAD' });
		return response.headers.get('content-type') || '';
	} catch {
		return '';
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message) {
		return false;
	}

	if (message.type === 'download-media') {
		handleDownloadRequest(message, sender)
			.then((result) => sendResponse(result))
			.catch((error) => {
				console.warn('XDL: Download failed', error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}

	if (message.type === 'download-media-blob') {
		handleBlobDownloadRequest(message, sender)
			.then((result) => sendResponse(result))
			.catch((error) => {
				console.warn('XDL: Blob download failed', error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}

	if (message.type === 'download-twitter-video') {
		handleTwitterVideoDownload(message, sender)
			.then((result) => sendResponse(result))
			.catch((error) => {
				console.warn('XDL: Twitter video download failed', error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}

	return false;
});
