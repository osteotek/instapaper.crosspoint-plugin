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
`GET /bookmarks/{id}.epub?lang=…&title=…&url=…` with the reader's
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
- **Folders.** The shipped `device.json` has fixed Home, Archive and Liked
  lists, each with its own URL, and `browse.lists_url` fetches Instapaper's
  `/folders` with `lists_headers` carrying the token
  (`catalog.list_index_mapping`). `lists_items: "folders"` reads the array;
  the default `title` and `id` fields fit Instapaper's folder objects, which
  have no `url`, so each folder browses `browse.url`
  (`/bookmarks?folder_id={list_id_enc}&limit=100`). The reader shows the
  folders after the fixed lists, fetches them once per visit, keeps the
  fixed lists if the fetch fails, and shows the sign-in message on 401/403.
  Firmware before 30 October 2026 ignores `lists_url` next to `lists` and
  shows only the fixed lists. Listing works without the converter (Fetch then
  fails: there is nothing to build the EPUB). `manifestFor()` only adds or
  removes the event handlers; the card applies it on Save converter and
  whenever it loads, which also repairs a `device.json` replaced by an
  update. Event handlers need a restart.
- **Encoded fields.** The download URL uses `{title_enc}` and `{url_enc}`,
  which the firmware percent-encodes (`catalog.encoded_item_fields`), so the
  Worker reads ordinary query parameters. `url` is used only for the byline
  and `dc:source`.
- **Errors.** The Worker passes Instapaper's 401, 403 and 429 through, and
  answers 422 when Instapaper has no text for the bookmark.
- **Progress and archiving.** Every download writes the sidecar
  `<book>.meta.json` with `instapaper_id` (`download.sidecar` on the reader,
  `/api/plugin-fs` in the web sync). While the option is on, the card adds a
  `reader.exit` handler to `device.json` that posts `{instapaper_id, percent,
  end_percent, ts}` to the Worker's `POST /events/exit` (`worker/events.js`).
  The Worker sends `percent` as Instapaper progress and archives when either
  value is 100 (then progress is sent as 100%). The same
  request is bound to `sleep.enter`, which joins Wi-Fi at sleep, so
  sleeping in an article sends it before the reader sleeps; `reader.exit`
  alone would wait for the next Wi-Fi connection. Both handlers have
  `require_meta: "instapaper_id"`, so the firmware queues events only for
  books whose sidecar has the ID: other books queue nothing and never make
  the reader join Wi-Fi at sleep. Sleeping in an article sends the request
  twice (`sleep.enter` at sleep, then `reader.exit` on the next connection);
  progress and the archive move are both safe to repeat. The firmware keeps
  an undelivered event queued, blocking later ones, so the Worker answers
  200 to anything it can never act on (a missing ID, a deleted bookmark)
  and only lets token, rate-limit and server errors retry. The handlers are
  removed when the option is off, because without the converter every
  event would fail. Event subscriptions are read at boot, hence the
  restart.
- **Last page.** `percent` is progress at the top of the current page, so
  the last page of an N-page article reports (N-1)/N. `end_percent` is
  measured at the bottom of the page and rounded down, so it is 100 only on
  the last page. Firmware without it leaves the literal
  `{event.end_percent}`; the Worker then archives only at `percent` 100, on
  the reader's end-of-book screen. Plugin 1.0.3 and older ended every EPUB
  with an `end.xhtml` page and padded the article so that page started at
  100%; those articles still archive from it.
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
- **Titles.** The reader and the web sync both send the listed title as
  `&title=` (Instapaper has no endpoint for one bookmark, `GET
  /bookmarks/{id}` is 405, so the Worker cannot look it up). An untitled
  bookmark sends an empty one, and the Worker uses the parsed page title
  without a trailing " — Site" that matches the article's site.
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
- Folders, on firmware `d9764e2b`: the simulated reader's picker showed
  Home, Archive, Liked, then Bitcoin and Economics from Instapaper's
  `/folders`, with the converter on. Economics listed its one article
  through `browse.url` with the folder's id.
- Without the converter the simulated reader listed Home with its articles
  straight from Instapaper, and Fetch failed with "Download failed".
- Progress and archiving, end to end with a temporary bookmark (deleted
  afterwards): the card added the `reader.exit` handler, and after a restart
  the reader subscribed to it. The catalog download wrote the sidecar.
  Leaving the article on its end page queued `percent: "100"`. On the next
  Wi-Fi join the reader sent it, and Instapaper showed the bookmark archived
  with progress 1.0. An earlier `percent: "0"` event was sent and dropped
  without blocking the queue.
- Last page, on firmware `d9764e2b` with the Worker running locally: Fetch
  on the simulated reader saved a 23-page article and its sidecar, with no
  end page. Leaving it on page 22 queued `percent: "91"`,
  `end_percent: "95"`; on page 23, `percent: "96"`, `end_percent: "100"`.
  A one-page article left on its page queued `end_percent: "100"`. The
  events were kept queued rather than sent, so nothing was archived; the
  Worker's handling of them is covered by `npm test`.
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
