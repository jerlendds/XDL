import { DEFAULT_ALLOWED_HOSTS, dedupeHosts, extractHost } from './allowed-hosts.js';

const form = document.getElementById('site-form');
const input = document.getElementById('site-input');
const list = document.getElementById('site-list');
const addCurrentButton = document.getElementById('add-current');
const errorMessage = document.getElementById('site-error');

let allowedHosts = [];

function setError(message) {
	errorMessage.textContent = message || '';
}

function renderList() {
	list.textContent = '';
	if (!allowedHosts.length) {
		const empty = document.createElement('li');
		empty.textContent = 'No allowed sites yet.';
		list.append(empty);
		return;
	}

	for (const host of allowedHosts) {
		const item = document.createElement('li');
		const label = document.createElement('span');
		label.textContent = host;
		const removeButton = document.createElement('button');
		removeButton.type = 'button';
		removeButton.textContent = 'Remove';
		removeButton.dataset.host = host;
		item.append(label, removeButton);
		list.append(item);
	}
}

function saveHosts() {
	return new Promise((resolve) => {
		chrome.storage.sync.set({ allowedHosts }, () => resolve());
	});
}

async function loadHosts() {
	return new Promise((resolve) => {
		chrome.storage.sync.get({ allowedHosts: DEFAULT_ALLOWED_HOSTS }, (result) => {
			resolve(Array.isArray(result?.allowedHosts) ? result.allowedHosts : DEFAULT_ALLOWED_HOSTS);
		});
	});
}

async function addHost(raw) {
	const host = extractHost(raw);
	if (!host) {
		setError('Enter a valid domain or URL.');
		return;
	}
	setError('');
	allowedHosts = dedupeHosts([ ...allowedHosts, host ]);
	await saveHosts();
	renderList();
	input.value = '';
}

function removeHost(host) {
	allowedHosts = allowedHosts.filter((entry) => entry !== host);
	saveHosts().then(renderList);
}

function getActiveHostname() {
	return new Promise((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			if (chrome.runtime.lastError) {
				resolve('');
				return;
			}
			const url = tabs?.[0]?.url || '';
			try {
				resolve(new URL(url).hostname);
			} catch (error) {
				resolve('');
			}
		});
	});
}

async function init() {
	allowedHosts = dedupeHosts(await loadHosts());
	renderList();

	const activeHost = await getActiveHostname();
	if (activeHost) {
		addCurrentButton.textContent = `Add ${activeHost}`;
	} else {
		addCurrentButton.textContent = 'Add current site';
		addCurrentButton.disabled = true;
	}
}

form.addEventListener('submit', (event) => {
	event.preventDefault();
	addHost(input.value);
});

addCurrentButton.addEventListener('click', async () => {
	const host = await getActiveHostname();
	if (!host) {
		setError('Unable to read the active site.');
		return;
	}
	addHost(host);
});

list.addEventListener('click', (event) => {
	const button = event.target.closest('button');
	if (!button || !button.dataset.host) {
		return;
	}
	removeHost(button.dataset.host);
});

init();
