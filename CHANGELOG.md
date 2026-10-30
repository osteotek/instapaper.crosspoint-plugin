# Changelog

Each section becomes the GitHub Release notes for that version. Plugin Hub
offers the update; your token and settings stay.

## Unreleased

Needs CrossPoint firmware from 30 October 2026 or newer (newer than
2.0.0rc). Firmware from 27 October on works without the folders and
last-page archiving below.

- The reader lists your own folders after Home, Archive and Liked, also
  without the converter. The reader gets them from Instapaper with the token
  in a header; the converter's `/lists` address, which carried the token in
  the URL, is gone.
- Leaving an article on its last page archives it. New articles no longer
  end with an "End of article" page; older ones still archive from that page.

- With progress and archiving on, putting the reader to sleep in an
  Instapaper article sends its progress (and archives it from the End of
  article page) right away, instead of on the next Wi-Fi connection.
- Only Instapaper articles queue progress events; sleeping in other books
  never turns on Wi-Fi.
- Articles fetched on the reader use the title Instapaper lists, like
  articles from Sync now.

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
