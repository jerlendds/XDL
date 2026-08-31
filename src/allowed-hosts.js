export const DEFAULT_ALLOWED_HOSTS = [
	'x.com',
	'twitter.com',
	'abs.twimg.com',
	'api.x.com',
	'pbs.twimg.com',
	'video.twimg.com',
];

const SUPPORTED_HOSTS = new Set(DEFAULT_ALLOWED_HOSTS);

export const DEFAULT_OPTIONS = {
	imageFolder: '',
	videoFolder: '',
	allowedHosts: DEFAULT_ALLOWED_HOSTS,
};

export function normalizeHost(value) {
	if (!value || typeof value !== 'string') {
		return '';
	}
	return value.trim().toLowerCase();
}

export function extractHost(input) {
	const trimmed = normalizeHost(input);
	if (!trimmed) {
		return '';
	}
	try {
		return new URL(trimmed).hostname;
	} catch (error) {
		// Ignore, we'll try to coerce it into a host.
	}
	try {
		return new URL(`https://${trimmed}`).hostname;
	} catch (error) {
		return '';
	}
}

export function dedupeHosts(hosts) {
	if (!Array.isArray(hosts)) {
		return [];
	}
	const seen = new Set();
	const output = [];
	for (const host of hosts) {
		const normalized = normalizeHost(host);
		if (!normalized || !SUPPORTED_HOSTS.has(normalized) || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		output.push(normalized);
	}
	return output;
}

export function isHostAllowed(hostname) {
	const host = normalizeHost(hostname);
	return SUPPORTED_HOSTS.has(host);
}
