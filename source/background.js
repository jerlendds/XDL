const DEFAULT_OPTIONS = {
	imageFolder: '',
	videoFolder: '',
};

const TWITTER_MEDIA_HOST = 'video.twimg.com';
const twitterRequestsByTab = new Map();
const twitterVariantsByTab = new Map();
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

function buildFilename(url, folder, mediaType) {
	const baseName = extractFilename(url) || `${mediaType || 'download'}-${Date.now()}`;
	if (!folder) {
		return baseName;
	}
	return `${folder}/${baseName}`;
}

function buildFilenameFromHint(folder, filenameHint, mediaType) {
	const baseName = filenameHint || `${mediaType || 'download'}-${Date.now()}`;
	if (!folder) {
		return baseName;
	}
	return `${folder}/${baseName}`;
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

async function handleDownloadRequest(message) {
	const { url, mediaType } = message;
	if (!url) {
		throw new Error('Missing URL');
	}

	const options = await getOptions();
	const folder = normalizeFolder(mediaType === 'video' ? options.videoFolder : options.imageFolder);
	const filename = buildFilename(url, folder, mediaType);

	const downloadId = await chrome.downloads.download({
		url,
		filename,
		saveAs: false,
	});

	return { ok: true, downloadId };
}

async function handleBlobDownloadRequest(message) {
	const { data, mimeType, filenameHint, mediaType } = message;
	if (!data) {
		throw new Error('Missing blob data');
	}

	const options = await getOptions();
	const folder = normalizeFolder(mediaType === 'video' ? options.videoFolder : options.imageFolder);
	const filename = buildFilenameFromHint(folder, filenameHint, mediaType);
	const blob = new Blob([data], { type: mimeType || 'application/octet-stream' });
	const objectUrl = URL.createObjectURL(blob);

	const downloadId = await chrome.downloads.download({
		url: objectUrl,
		filename,
		saveAs: false,
	});

	setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);

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
	return handleDownloadRequest({ url, mediaType: 'video' });
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
	});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message) {
		return false;
	}

	if (message.type === 'download-media') {
		handleDownloadRequest(message)
			.then((result) => sendResponse(result))
			.catch((error) => {
				console.warn('XDL: Download failed', error);
				sendResponse({ ok: false, error: error.message });
			});
		return true;
	}

	if (message.type === 'download-media-blob') {
		handleBlobDownloadRequest(message)
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
