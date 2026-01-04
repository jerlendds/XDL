export const DEFAULT_ALLOWED_HOSTS = [
	'x.com',
	'dribbble.com',
	'behance.com',
	'seesaw.website',
	'designspells.com',
];

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
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		output.push(normalized);
	}
	return output;
}

export function isHostAllowed(hostname, allowedHosts) {
	const host = normalizeHost(hostname);
	if (!host) {
		return false;
	}
	const list = Array.isArray(allowedHosts) ? allowedHosts : [];
	return list.some((allowed) => {
		const allowedHost = normalizeHost(allowed);
		return allowedHost && (host === allowedHost || host.endsWith(`.${allowedHost}`));
	});
}
