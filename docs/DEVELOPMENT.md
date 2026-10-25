# Articles for Instapaper: development notes

How the plugin and its converter Worker are built, the decisions behind
them, and how they were tested. The user guide is the repository
[README](../README.md).

## Layout

- `README.md`: the user guide. `instapaper.crosspoint-plugin/README.md` is a
  short summary installed with the plugin, kept small because the reader
  downloads every installed file.
- `docs/DEVELOPMENT.md`: these notes.
- `instapaper.crosspoint-plugin/manifest.json`: title, version, and web Settings mount.
- `src/plugin.js`: the Settings card (token, optional converter) and the web
  sync. Edit this; `instapaper.crosspoint-plugin/plugin.js` is its minified
  build.
- `instapaper.crosspoint-plugin/device.json`: the on-reader catalog. It lists Instapaper
  directly and downloads each article through the converter Worker. The card
  rewrites parts of it to match the converter settings (see below).
- `src/epub.js`: turns Instapaper's parsed HTML into an EPUB. One ES module
  shared by the web card (loaded with `import()`), the Worker and the tests.
  `instapaper.crosspoint-plugin/epub.js` is its minified build.
- `instapaper.crosspoint-plugin/DETAILS.md`: the details page Plugin Hub
  shows before installing (headings, `- ` lists and bold only).
- `wrangler.jsonc` and `cloudflare.config.ts`: the same Worker for Wrangler
  (and the Deploy to Cloudflare button) and for `cf`; a test checks they
  agree. `npm run deploy` runs `wrangler deploy`, `npm run deploy:cf` runs
  `cf deploy`.
- `.github/workflows/`: `test.yml` runs `npm test` on every push and pull
  request; `release.yml` publishes a GitHub Release when a `vX.Y.Z` tag is
  pushed.
- `scripts/build.mjs`: `npm run build:plugin` minifies `src/plugin.js` and
  `src/epub.js` with esbuild into the payload folder. The build is committed,
  because Plugin Hub installs the payload folder exactly as tagged.
- `worker/`: the converter, a Cloudflare Worker. `index.js` handles the
  request; `images.js` fetches and converts images. `cloudflare.config.ts`
  configures it: `cf dev` runs it locally and `cf deploy` publishes it.
- `test/`: Node tests. Run `npm install`, then `npm test` (Node 22 or newer).
  They test `src/`, fail when the built files are stale, and run a sync on
  the minified files.

## Instapaper API

API v2 (`https://www.instapaper.com/api/2`), with a personal access token sent
as `Authorization: Bearer`. Each user registers their own application. The
article text endpoint is free only for personal use, where the application's
owner reads their own account, and the API terms do not allow sharing keys.

| Use | Endpoint | Caller |
| --- | --- | --- |
| Check the token | `GET /me` | web card, through the relay |
| Folder list | `GET /folders` | web card, through the relay |
| Bookmark list | `GET /bookmarks?section=…` or `?folder_id=…`, `limit` | web card through `/api/fetch`; reader catalog |
| Article text | `GET /bookmarks/{id}/parse` | web card through `/api/fetch`; Worker |

## On the reader

Instapaper only returns article text as JSON, and `device.json` can only save
a response as a file. The Worker closes that gap:
`GET /bookmarks/{id}.epub?lang=…&url=…` with the reader's
`Authorization: Bearer` token calls `/parse` with the same token and returns
the EPUB. It keeps no state and holds no secrets. `GET /` answers with a
banner, which the web card checks before saving the address.

- **Shared config.** The web card writes `config.json` with `token`, `lang`
  and the converter settings: `use_worker` (the switch), `worker_address`
  (kept while the switch is off) and `worker_url` (the address in use, empty
  when off). `device.json` reads the token from it (`token.path`) and the
  rest as `{cfg.*}`.
- **Web sync.** With `worker_url` set, the page has the reader download each
  EPUB from the Worker with `/api/fetch`, straight to the SD card, so images
  come along and the 256 KB `/api/plugin-fs` limit does not apply; on a
  failure it repeats the request through the relay to read the Worker's
  short error answer. Without it, the page fetches `/parse` and builds a
  text-only EPUB with `epub.js`.
- **Lists.** The browse URLs have no `{page}`, so the reader fetches the
  newest 100 once and pages them locally (`plugincatalogpaging::isStaticFeed`).
  Instapaper pages by `offset`, which the templates cannot express.
- **Folders.** `browse.lists_url` points at the Worker's `GET /lists`, which
  fetches `/folders` and answers in the reader's list-index shape
  (`{"lists": [{title, url}]}`): Home, Archive, Liked, then one
  `/bookmarks?folder_id=…&limit=100` list per folder. The reader fetches
  `lists_url` without headers and expects that exact shape
  (`PluginCatalogActivity::loadBrowseListIndex`), which Instapaper's own
  `/folders` cannot meet, so the token goes in the query string
  (`lists_url: "{cfg.worker_url}/lists?token={token}"`). The reader logs the
  URL, token included, when that request fails.
- **List source follows the converter.** The reader loads `lists_url` only
  when `browse.lists` is empty, so a manifest has one or the other. The
  shipped `device.json` has fixed Home, Archive and Liked lists that go
  straight to Instapaper, so listing works without the converter (Fetch then
  fails: there is nothing to build the EPUB). With the converter on, the card
  replaces them with `lists_url`. `manifestFor()` derives the whole
  manifest state (lists and the `reader.exit` handler) from the settings; the
  card applies it on Save converter and whenever it loads, which also repairs
  a `device.json` overwritten by copying a new plugin version. Lists need no
  restart; the event handler does.
- **`url` comes last.** The reader puts `{url}` into the download URL without
  encoding it, so the Worker takes everything after `url=` as the article
  address. It is used only for the byline and `dc:source`.
- **Errors.** The Worker passes Instapaper's 401, 403 and 429 through, and
  answers 422 when Instapaper has no text for the bookmark.
- **Progress and archiving.** Every download writes the sidecar
  `<book>.meta.json` with `instapaper_id` (`download.sidecar` on the reader,
  `/api/plugin-fs` in the web sync). While the option is on, the card adds a
  `reader.exit` handler to `device.json` that posts `{instapaper_id, percent,
  ts}` to the Worker's `POST /events/exit` (`worker/events.js`). The Worker
  sends `percent` as Instapaper progress and archives at 100%. The firmware
  fires `reader.exit` for every book and keeps an undelivered event queued,
  blocking later ones, so the Worker answers 200 to anything it can never
  act on (another book, a missing ID, a deleted bookmark) and only lets
  token, rate-limit and server errors retry. The handler is removed when the
  option is off, because without the converter every event would fail. The
  handler has no `connect`, so events wait for the next Wi-Fi connection
  instead of joining Wi-Fi at every sleep. Event subscriptions are read at
  boot, hence the restart.
- **End page.** The reader reports progress for the top of the current page
  (`EpubReaderActivity::getScreenshotInfo`), so the last page of an N-page
  article reports (N-1)/N, and no threshold works for short articles. Every
  EPUB therefore ends with a tiny `end.xhtml` page, and the article file is
  padded with a comment to 200 times its size: progress is weighted by
  uncompressed file size (`Epub::calculateProgress`), so the end page starts
  at 99.5% or more, which rounds to 100%. The padding compresses to almost
  nothing.
- **Images.** The parsed HTML keeps only `<img src>`. `articleContent()`
  leaves a marker for each image and lists its URL; the Worker fetches the
  images and `placeImages()` turns markers into `<img>` or drops them. Each
  image is fetched with `cf.image` as a grayscale baseline JPEG within
  800 x 800: the longest side of any supported panel, and the reader decodes
  progressive JPEG only at 1/8 detail (`JpegToFramebufferConverter.cpp`). If
  no transformation happens (local dev, monthly quota used), the original is
  kept only when the reader can decode it (JPEG, PNG up to 4,096 px wide,
  non-interlaced GIF up to 3,072 px) and it is under 1 MB. At most 30 images
  and 3 MB of originals per article, within the free plan's 50 subrequests.
  Images are stored in the ZIP without compression. Image fetching stops
  after 15 seconds and the cover after 8 more, so a slow image host cannot
  hold up the article. The `X-Images` response header reports how many were
  found, kept and converted, and the cover.
- **Cover.** The reader renders an EPUB's cover at its portrait screen size
  (`JpegToBmpConverter::jpegFileToBmpStream`) for the cover screen and Home
  thumbnails, and takes JPEGs up to 2048 x 3072, progressive ones at 1/8
  detail. The Worker fetches the lead image (`metadata.thumbnail`, else the
  first kept image) once more as a 528 x 800 grayscale baseline JPEG with
  `fit: "cover"` and `gravity: "auto"`, which holds the largest portrait
  screen (X3: 528 x 792); the reader scales it down for smaller ones. If
  Cloudflare does not convert it, the original is used only when it is a
  baseline JPEG within those limits and under 1 MB. The cover is a separate
  `images/cover.jpg` marked both ways the reader reads
  (`properties="cover-image"` and `<meta name="cover">`).
- **Titles.** The reader cannot pass the listed title to the Worker:
  templates are substituted unencoded and the firmware sends the URL path
  as is (`SecureHttpClient::parseUrl`), so spaces would break the request,
  and Instapaper has no endpoint for one bookmark (`GET /bookmarks/{id}` is
  405). Reader downloads therefore use the parsed page title without a
  trailing " — Site" that matches the article's site; the web sync sends the
  listed title, encoded, as `&title=` before the raw `url`.
- **CPU.** The free plan allows about 10 ms of CPU per request. HTML parsing
  is cheap (1 ms for a 60 KB body); deflating the text and the CRC-32 over
  every image byte cost the most, so the CRC is slice-by-4 (about 1.5 ms per
  MB in Node) and images are not deflated.

## Design notes

- **Transport.** The device relay keeps the whole response in RAM and refuses
  more than 32 KB. A 10-item bookmark list is about 11 KB, but one article
  was 289 KB of JSON. Lists and articles therefore go through `/api/fetch`,
  which streams to `download.json` in the plugin folder; the page then reads
  that file. `/api/fetch` does not return the body of a failed request, so on
  failure the plugin repeats the request through the relay to get the status.
- **EPUB.** One XHTML chapter, plus `nav.xhtml` and `toc.ncx`. Elements are
  kept without attributes from a short list (paragraphs, headings, lists,
  quotes, tables, emphasis); scripts, media and forms are dropped; other
  elements are unwrapped. An unwrapped block inside a text element becomes a
  line break, and a top-level block holding text becomes a paragraph, so words
  do not run together. Entries are deflated with `CompressionStream` when the
  browser has it, because `/api/plugin-fs` accepts at most 256 KB.
- **State and names.** Every download, from the web sync or the reader's
  catalog, writes `<file>.meta.json` with `instapaper_id`. The web sync scans
  `/Instapaper/` for those sidecars, so it knows reader downloads too, and
  names files with `readerFileName()`, a copy of
  `StringUtils::sanitizeFilenamePreservingExtension("{title}.epub", 100)`.
  A different file by that name gets ` (<id>)` instead of being replaced.
  `state.json` caches the ID-to-file map, the archive check's `since`, and
  the keys of highlights already sent; only files with a sidecar are ever
  deleted.
- **Archive check.** `GET /bookmarks?since=` returns everything changed since
  then, across all sections, with `deleted_ids`, paged by offset. Archived or
  deleted IDs among the articles on the card are deleted, except those in
  the folder being synced. `since` is saved five minutes early, so the next
  check overlaps rather than misses.
- **Highlights.** The card reads `/.crosspoint/clippings/epub_*.bin`
  (`ClippingStore`, versions 1 to 4), finds each book's `instapaper_id` from
  its sidecar, and posts each passage to `POST /bookmarks/{id}/highlights`
  through the relay. 400 means Instapaper already has it; 403 is the free
  plan's five-a-month limit and stops the run.
- **Page load.** The reader serves plugin files uncompressed every time its
  Settings page opens. So the installed JavaScript is minified (`plugin.js`
  42 KB to 21 KB, `epub.js` 20 KB to 10 KB), the card loads `epub.js` only
  on the first sync (highlights, the converter settings and the rest of the
  card do not need it), and the installed README is a short summary. Each
  minified file starts with a comment naming its version and source file.
- **Language.** The parse response has no language. The plugin uses the
  dominant script (Cyrillic, Greek, Hebrew, Arabic, CJK), else the browser's
  language when it uses Latin script, else English.

## Tested against

The real Instapaper API, from
[crosspoint-simulator](https://github.com/crosspoint-reader/crosspoint-simulator)
running the firmware at `72ca92fe`. The browser was jsdom; `PluginHost.js.inc`,
`plugin.js` and every device endpoint were the firmware's own.

- A wrong token was rejected. The right one connected and listed the user's
  folders.
- Syncing Home with a limit of 10 added 9 articles and skipped a PDF, in about
  11 seconds. The largest was 9,200 words of Russian (289 KB of JSON, a 33 KB
  EPUB). A second sync and a `sync` job added nothing.
- Liked with a limit of 3 added 3. A limit of 2 with deletion on removed 1.
- All EPUBs passed a ZIP and XML check, and opened in the simulated reader:
  an English article as 22 pages, the Russian one as 102 pages with `ru`
  hyphenation.
- The Worker ran locally in workerd. On the simulated reader,
  **Home > Plugins > Articles for Instapaper > Home** listed the account's
  articles with authors, and **Fetch** downloaded two of them through the
  Worker (8 KB in 0.8 s, 33 KB in 1.5 s). Both opened in the reader. A PDF
  bookmark got 422 and a wrong token 401.
- Deployed to workers.dev with `cf deploy`, the Worker converted the images of
  four real articles: 12 of 12 (Substack), 4 of 5 (The Atlantic, an 80 x 108
  icon dropped), 1 of 1 (a 1.9 MB New Yorker PNG became 41 KB), and 1 of 4
  (three SVG diagrams dropped). Every kept image was a baseline JPEG within
  800 px, 1 to 66 KB; the largest EPUB was 443 KB in 2.2 s. No request hit a
  CPU limit error.
- The simulated reader fetched the 12-image article from the deployed Worker
  over HTTPS and showed its images; the reader decoded them at full scale in
  about 2 ms each.
- Web sync with the converter on downloaded three Archive articles from the
  deployed Worker straight to the SD card, including the 443 KB 12-image
  article that the 256 KB page path could not save. With the converter off,
  the page built text-only EPUBs and the address was kept.
- Folders: the deployed Worker's `/lists` returned Home, Archive, Liked,
  Bitcoin and Economics, and 401 for a wrong token. The simulated reader's
  plugin showed the same picker, and Economics listed its article.
- Without the converter the simulated reader listed Home with its articles
  straight from Instapaper, and Fetch failed with "Download failed". Turning
  the converter on and off on the card switched `device.json` between
  `lists_url` and the shipped lists, and the reader followed without a
  restart.
- Progress and archiving, end to end with a temporary bookmark (deleted
  afterwards): the card added the `reader.exit` handler, and after a restart
  the reader subscribed to it. The catalog download wrote the sidecar.
  Leaving the article on its end page queued `percent: "100"`. On the next
  Wi-Fi join the reader sent it, and Instapaper showed the bookmark archived
  with progress 1.0. An earlier `percent: "0"` event was sent and dropped
  without blocking the queue.
- Duplicates, cleanup, highlights and covers, with a temporary bookmark
  (deleted afterwards) and highlight uploads intercepted so as not to use
  the free monthly five: after two reader downloads, syncing Archive found
  both through their sidecars and downloaded nothing; Send highlights matched
  a clipping file to its article and posted both passages once; syncing Home
  added two articles and deleted the two archived ones. Deployed covers came
  out as 528 x 800 baseline JPEGs, and the simulated reader built its Home
  thumbnail from one.
- In headless Chrome against the simulator's real Settings page, the card
  loaded (including the `import()` of `epub.js`) and showed its setup steps
  in both the not-connected and connected states.
- The web card loaded `epub.js` from the device (`application/javascript`),
  rejected a malformed converter address and one with nothing listening, and
  saved a working one.

The simulator runs web handlers on a worker thread, while the firmware's main
loop releases request arguments after `handleClient()`
(`src/network/CrossPointWebServer.cpp`). Some requests therefore lost their
arguments in the simulator. The test harness retried only those errors and
counted them. This does not happen on the device, where handlers run inside
`handleClient()`.

## Releasing

Plugin Hub finds this repository by its `crosspoint-plugin` topic and installs
the `instapaper.crosspoint-plugin/` folder from the latest GitHub Release
(see the Plugin Hub contract in
[crosspoint-plugin-hub](https://github.com/crosspoint-reader/crosspoint-plugin-hub)).
To publish a version:

1. Set the same `MAJOR.MINOR.PATCH` version in
   `instapaper.crosspoint-plugin/manifest.json`, `instapaper.crosspoint-plugin/device.json`
   and `package.json`, list any new runtime file in the manifest's `files`,
   and add a `## X.Y.Z` section to `CHANGELOG.md`.
2. Run `npm run build:plugin` (the minified files carry the version) and
   `npm test`. The tests check the versions agree, the build is current and
   the changelog has the version.
3. Commit, tag `vX.Y.Z` and push both. The release workflow runs the tests,
   checks the tag against the manifest, and publishes the GitHub Release with
   the changelog section as its notes.
4. Plugin Hub's catalog refresh, every three hours, picks it up.

If the converter changed, also run `npm run deploy` (or `npm run deploy:cf`)
to update your own Worker.

The converter is deployed separately (`cf deploy`); each user runs their own.

## License

MIT. See [LICENSE](../LICENSE).
