# Changelog

Each section becomes the GitHub Release notes for that version. Plugin Hub
offers the update; your token and settings stay.

## 1.0.3

- Plugin Hub shows a details page for the plugin before you install it.
- The converter can be deployed with a Deploy to Cloudflare button, with no
  command line needed.
- Author names no longer end with a publication date stuck to them.

## 1.0.2

- The plugin's JavaScript is minified: about 31 KB instead of 62 KB on the SD
  card, so the reader's Settings page and Plugin Hub installs load faster. The
  readable source is in `src/`.

## 1.0.1

- The reader's Settings page loads faster: the EPUB builder is loaded on the
  first sync instead of every time the page opens.
- The README installed on the SD card is now a short summary that links to the
  full guide.

## 1.0.0

First release.

- Sync saved Instapaper articles to the reader as EPUB from its web Settings
  page.
- Optional Cloudflare Worker converter, deployed to your own account: images
  and covers sized for the reader, browsing your folders and downloading on the
  reader itself, reading progress sync, and archiving articles you finish.
- Send highlights made on the reader to Instapaper.
