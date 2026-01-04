# XDL Hover Downloader

Firefox extension that adds a download button when you hover images or videos, with special handling for X.com (Twitter) media.

## Features

- Hover-to-download button on images and videos.
- Optimized X/Twitter video downloads (prefers the best available MP4 variant).
- Supports blob URLs by streaming the data through the background script.
- Optional subfolders for images and videos.

## Usage

1. Open X.com (or any site with images/videos).
2. Hover a media element to reveal the download button.
3. Click the button to download the media.

For X/Twitter videos, the extension listens for media requests and GraphQL responses to find a progressive MP4 URL before downloading.

## Options

Open the extension options page to set download folders:

- Images folder: subfolder under your default Downloads directory.
- Videos folder: subfolder under your default Downloads directory.

Leave blank to download directly into your default Downloads folder.

## Development setup

### Build

```bash
npm install
npm run build
```

This creates the `distribution` folder with the unpacked extension.

### Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on".
3. Select `distribution/manifest.json`.

For iterative work, run `npm run watch` and reload the extension from the about:debugging page after changes.

## Permissions

- `downloads`: save media to disk.
- `storage`: persist options.
- `webRequest` + `webRequestBlocking`: detect X/Twitter video URLs.
- `<all_urls>`: required to observe media requests and handle downloads across sites.

## Notes

- This project uses Manifest V2 for Firefox compatibility.
- Not affiliated with X (Twitter). Please respect content rights and the platform's terms.
