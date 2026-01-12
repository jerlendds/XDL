const DEFAULT_ALLOWED_HOSTS = [
  "x.com",
  "dribbble.com",
  "behance.com",
  "seesaw.website",
  "designspells.com",
];

function normalizeHost(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function dedupeHosts(hosts) {
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

function isHostAllowed(hostname, allowedHosts) {
  const host = normalizeHost(hostname);
  if (!host) {
    return false;
  }
  const list = Array.isArray(allowedHosts) ? allowedHosts : [];
  return list.some((allowed) => {
    const allowedHost = normalizeHost(allowed);
    return (
      allowedHost && (host === allowedHost || host.endsWith(`.${allowedHost}`))
    );
  });
}

console.log("XDL content script loaded for", chrome.runtime.getManifest().name);

const BUTTON_ID = "xdl-download-button";
const VISIBLE_CLASS = "xdl-visible";
const TWITTER_HOSTS = ["x.com", "twitter.com", "mobile.twitter.com"];

const ICON_SVG = `
<svg class="_6c706db0523bd9a7-downloadHoverButtonIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 1 0 0 2h18a1 1 0 1 0 0-2H3Z" class=""></path></svg>
`.trim();

let currentTarget = null;
let positionFrame = null;
let downloadInProgress = false;
let allowedHosts = DEFAULT_ALLOWED_HOSTS;
let isAllowedSite = false;
let listenersAttached = false;

const VIDEO_CONTAINER_SELECTOR = [
  '[data-testid="videoPlayer"]',
  '[data-testid="videoComponent"]',
  '[data-testid="videoContainer"]',
].join(",");

function isTwitterHost() {
  const hostname = window.location.hostname || "";
  if (TWITTER_HOSTS.includes(hostname)) {
    return true;
  }
  return hostname.endsWith(".twitter.com") || hostname.endsWith(".x.com");
}

function extractTwitterMediaIdFromUrl(url) {
  if (!url) {
    return "";
  }
  const match = url.match(
    /\/(?:amplify_video|ext_tw_video|tweet_video)(?:_thumb)?\/(\d+)\//
  );
  return match ? match[1] : "";
}

function getTwitterMediaId(target) {
  if (!target) {
    return "";
  }
  const poster = target.getAttribute("poster") || target.poster || "";
  return extractTwitterMediaIdFromUrl(poster);
}

function requestTwitterVideoDownload(target) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "download-twitter-video",
        mediaId: getTwitterMediaId(target),
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "Unknown error" });
      }
    );
  });
}

function ensureButton() {
  let button = document.getElementById(BUTTON_ID);
  if (button) {
    return button;
  }

  button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.innerHTML = ICON_SVG;
  button.setAttribute("aria-label", "Download media");
  button.setAttribute("title", "Download media");
  button.addEventListener("click", handleDownloadClick);
  document.body.append(button);
  return button;
}

function isMediaElement(element) {
  return element && (element.tagName === "IMG" || element.tagName === "VIDEO");
}

function getMediaTarget(element) {
  if (!element) {
    return null;
  }

  const button = document.getElementById(BUTTON_ID);
  if (button && button.contains(element)) {
    return currentTarget;
  }

  const video = findVideoTarget(element);
  if (video) {
    return video;
  }

  const media = element.closest("img");
  return isMediaElement(media) ? media : null;
}

function findVideoTarget(element) {
  const direct = element.closest("video");
  if (direct) {
    return direct;
  }

  const container = element.closest(VIDEO_CONTAINER_SELECTOR);
  if (container) {
    const within = container.querySelector("video");
    if (within) {
      return within;
    }
  }

  const parent = element.closest("figure, div, article");
  if (parent) {
    const within = parent.querySelector("video");
    if (within) {
      return within;
    }
  }

  return null;
}

function hideButton() {
  const button = document.getElementById(BUTTON_ID);
  if (!button) {
    return;
  }
  button.classList.remove(VISIBLE_CLASS);
  currentTarget = null;
}

function showButtonFor(target) {
  const button = ensureButton();
  currentTarget = target;
  updateButtonPosition();
  button.classList.add(VISIBLE_CLASS);
}

function updateButtonPosition() {
  const button = document.getElementById(BUTTON_ID);
  if (!button || !currentTarget) {
    return;
  }

  if (!document.contains(currentTarget)) {
    hideButton();
    return;
  }

  const rect = currentTarget.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 24) {
    hideButton();
    return;
  }

  if (
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth
  ) {
    hideButton();
    return;
  }

  const size = 32;
  const padding = 6;
  const top = Math.min(
    Math.max(rect.top + padding, 4),
    window.innerHeight - size - 4
  );
  const left = Math.min(
    Math.max(rect.right - size - padding, 4),
    window.innerWidth - size - 4
  );

  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
}

function schedulePositionUpdate() {
  if (!currentTarget || positionFrame !== null) {
    return;
  }
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = null;
    updateButtonPosition();
  });
}

function attachListeners() {
  if (listenersAttached) {
    return;
  }
  listenersAttached = true;
  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("pointerout", handlePointerOut, true);
  window.addEventListener("scroll", schedulePositionUpdate, true);
  window.addEventListener("resize", schedulePositionUpdate);
}

function detachListeners() {
  if (!listenersAttached) {
    return;
  }
  listenersAttached = false;
  document.removeEventListener("pointerover", handlePointerOver, true);
  document.removeEventListener("pointerout", handlePointerOut, true);
  window.removeEventListener("scroll", schedulePositionUpdate, true);
  window.removeEventListener("resize", schedulePositionUpdate);
  if (positionFrame !== null) {
    window.cancelAnimationFrame(positionFrame);
    positionFrame = null;
  }
  hideButton();
  const button = document.getElementById(BUTTON_ID);
  if (button) {
    button.remove();
  }
}

function updateAllowedHosts(nextHosts) {
  allowedHosts = dedupeHosts(nextHosts);
  const allowed = isHostAllowed(window.location.hostname, allowedHosts);
  if (allowed === isAllowedSite) {
    return;
  }
  isAllowedSite = allowed;
  if (isAllowedSite) {
    attachListeners();
  } else {
    detachListeners();
  }
}

function loadAllowedHosts() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { allowedHosts: DEFAULT_ALLOWED_HOSTS },
      (result) => {
        if (chrome.runtime.lastError) {
          resolve(DEFAULT_ALLOWED_HOSTS);
          return;
        }
        resolve(
          Array.isArray(result?.allowedHosts)
            ? result.allowedHosts
            : DEFAULT_ALLOWED_HOSTS
        );
      }
    );
  });
}

function handlePointerOver(event) {
  const target = getMediaTarget(event.target);
  if (!target) {
    return;
  }
  if (currentTarget !== target) {
    showButtonFor(target);
  }
}

function handlePointerOut(event) {
  if (!currentTarget) {
    return;
  }
  const related = event.relatedTarget;
  if (
    related &&
    (currentTarget.contains(related) ||
      document.getElementById(BUTTON_ID)?.contains(related))
  ) {
    return;
  }
  if (
    currentTarget.contains(event.target) ||
    document.getElementById(BUTTON_ID)?.contains(event.target)
  ) {
    hideButton();
  }
}

function resolveMediaUrl(target) {
  if (!target) {
    return "";
  }

  if (target.tagName === "IMG") {
    return target.currentSrc || target.src || "";
  }

  if (target.tagName === "VIDEO") {
    return (
      target.currentSrc ||
      target.src ||
      target.querySelector("source[src]")?.src ||
      ""
    );
  }

  return "";
}

function isBlobUrl(url) {
  return url.startsWith("blob:");
}

function extensionFromMimeType(mimeType) {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  const map = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[normalized] || "";
}

async function downloadBlobUrl(url, mediaType) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed with ${response.status}`);
  }
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const mimeType = blob.type || response.headers.get("content-type") || "";
  const extension = extensionFromMimeType(mimeType);
  const filenameHint = `${mediaType}-${Date.now()}${extension}`;

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "download-media-blob",
        data: buffer,
        mimeType,
        filenameHint,
        mediaType,
      },
      (responseMessage) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(responseMessage || { ok: false, error: "Unknown error" });
      }
    );
  });
}

async function handleDownloadClick(event) {
  event.preventDefault();
  event.stopPropagation();

  if (!currentTarget) {
    return;
  }

  if (downloadInProgress) {
    return;
  }

  const url = resolveMediaUrl(currentTarget);
  const mediaType = currentTarget.tagName === "VIDEO" ? "video" : "image";
  downloadInProgress = true;

  try {
    if (mediaType === "video" && isTwitterHost()) {
      const twitterResponse = await requestTwitterVideoDownload(currentTarget);
      if (twitterResponse && twitterResponse.ok) {
        return;
      }
      if (twitterResponse && twitterResponse.error) {
        console.warn(
          "XDL: Twitter video download failed",
          twitterResponse.error
        );
      }
      // Avoid saving partial blobs when Twitter video lookup fails.
      return;
    }
    if (!url) {
      console.warn("XDL: Unable to resolve media URL for download");
      return;
    }
    if (isBlobUrl(url)) {
      const response = await downloadBlobUrl(url, mediaType);
      if (!response.ok) {
        console.warn("XDL: Download failed", response.error);
      }
    } else {
      chrome.runtime.sendMessage(
        { type: "download-media", url, mediaType },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "XDL: Download failed",
              chrome.runtime.lastError.message
            );
            return;
          }
          if (response && !response.ok) {
            console.warn("XDL: Download failed", response.error);
          }
        }
      );
    }
  } catch (error) {
    console.warn("XDL: Download failed", error.message);
  } finally {
    downloadInProgress = false;
  }
}

loadAllowedHosts().then(updateAllowedHosts);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.allowedHosts) {
    return;
  }
  updateAllowedHosts(changes.allowedHosts.newValue || DEFAULT_ALLOWED_HOSTS);
});
