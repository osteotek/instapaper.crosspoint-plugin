# Articles for Instapaper

A plugin for [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader).
It is not made or endorsed by Instapaper.

Downloads your saved Instapaper articles to the reader as EPUB books. You
sync them from the reader's web page. With the optional converter, articles
include their images, you can also download them on the reader itself, and
the reader can send your reading progress to Instapaper and archive the
articles you finish.

## What you need

- An Instapaper account.
- For the optional converter: a free Cloudflare account, and a computer with
  [Node.js](https://nodejs.org) 24 or newer to deploy it once.

## Step 1: Get an Instapaper access token

The plugin uses Instapaper's API with your own access token. Instapaper gives
one to the owner of an "application", which you create for yourself. It takes
a minute and needs no approval.

1. Sign in on [instapaper.com](https://www.instapaper.com).
2. Open the [Applications](https://www.instapaper.com/developers/applications)
   page and create a new application. Any name works, for example
   "CrossPoint". You do not need callback URIs. A new application is in
   **Owner Only** mode: it works only with your own account, which is all the
   plugin needs. Do not submit it for review.
3. Instapaper shows a client ID and a client secret. The plugin does not need
   them.
4. Open the application and select **Generate access token**. Copy the token
   right away: Instapaper shows it only once. If you lose it, generate a new
   one; the old one stops working.

## Step 2: Install the plugin and connect

1. On the reader, turn on **Settings > Connectivity > Plugins**.
2. Install the plugin with Plugin Hub: on the reader, open **Home > Plugins >
   Plugin Hub > Community Plugins**, select **Articles for Instapaper** and
   install it. (Or copy the files of the `instapaper.crosspoint-plugin`
   folder to `/.crosspoint/plugins/instapaper/` on the SD card.) Restart the
   reader.
3. On the reader, start **File Transfer**. Open the web address it shows in a
   browser on the same network, and go to **Settings**.
4. On the **Articles for Instapaper** card, paste the token and tap
   **Connect**. The card shows "Connected as" with your Instapaper username.

You can now sync text-only articles from this page (see
[Use on the web page](#use-on-the-web-page)).

## Step 3 (optional): Set up the converter

The converter is a small Cloudflare Worker, included in this plugin's source
repository, that turns an Instapaper article and its images into an EPUB.
With it, articles include their images, there is no size limit, and you can
download articles on the reader itself. Without it, the web page builds
text-only EPUBs. The reader cannot do this alone: Instapaper only gives
article text as JSON, which the reader cannot open.

The Worker runs on your own Cloudflare account. The free plan is enough.

1. Create a free account at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and
   confirm your email address.
2. On your computer, install [Node.js](https://nodejs.org) 24 or newer.
3. Download or clone the plugin's repository,
   [github.com/osteotek/instapaper.crosspoint-plugin](https://github.com/osteotek/instapaper.crosspoint-plugin), and open a
   terminal in its folder (the one with `cloudflare.config.ts`).
4. Install the tools:

   ```sh
   npm install
   ```

5. Sign in to Cloudflare and follow the prompts (it opens a browser window
   to confirm):

   ```sh
   npx cf auth login
   ```

6. Deploy the converter:

   ```sh
   npx cf deploy
   ```

   If you can use more than one Cloudflare account, it asks which one. If it
   asks you to choose a `workers.dev` subdomain, pick any name: it becomes
   part of the address. At the end it prints the converter's address, for
   example `https://instapaper-epub.yourname.workers.dev`.
7. Check it: open that address in a browser. It should say "Articles for
   Instapaper converter".
8. On the reader's web page, on the **Articles for Instapaper** card, find
   **Converter (optional)**. Turn on **Use a Cloudflare Worker converter**,
   paste the address and tap **Save converter**. The card checks that the
   converter answers.
9. Optional: to send reading progress and archive finished articles (see
   [Progress and archiving](#progress-and-archiving)), also turn on **Send
   reading progress and archive finished articles** and tap **Save
   converter**. Then restart the reader once.

To update the converter later, get the new version of the repository and run
`npx cf deploy` again. To stop using it, turn the option off and tap **Save
converter**; the address is kept for later. To remove it completely, delete
the `instapaper-epub` Worker in the Cloudflare dashboard under
**Workers & Pages**.

Anyone who knows the address can use the converter with their own Instapaper
token, which counts against your Cloudflare free plan. Keep the address to
yourself.

## Use on the reader

1. Open **Home > Plugins > Articles for Instapaper**.
2. Pick **Home**, **Archive** or **Liked**; with the converter, your own
   folders are listed too, fresh each time you open the plugin. The newest
   100 articles of each are listed, 8 per page.
3. With the converter, select an article and press **Fetch**. It is saved in
   `/Instapaper/` and appears in **Browse Files** and the library.

Without the converter the reader can list your articles but not download
them: **Fetch** shows "Download failed". Use **Sync now** on the web page
instead.

With the converter, articles include their images, whether you fetch them on
the reader or sync them on the web page. The converter has Cloudflare turn
each image into a grayscale JPEG of at most 800 x 800 pixels, which the
reader decodes quickly and at full detail. Each article also gets a cover, made
from its lead image (or its first image) and sized for the reader's cover
screen and Home thumbnails: a 528 x 800 grayscale picture, cropped around the
most important part. To hide images, use the reader's own image setting.

Articles you fetch on the reader are titled with the title of the web page,
without a trailing site name; articles from **Sync now** use the title
Instapaper lists. The file name always uses the title Instapaper lists.

## Progress and archiving

With the converter and **Send reading progress and archive finished
articles** on:

- When you leave an Instapaper article on the reader, its reading position is
  sent to Instapaper, so its other apps continue where you stopped.
- Every article ends with an **End of article** page. Leave the article on
  that page, and it moves to your Instapaper Archive.

The reader sends this the next time it connects to Wi-Fi: when you open the
plugin on the reader, start File Transfer, or use another Wi-Fi feature. It
does not turn on Wi-Fi by itself for this, to save battery.

This works for articles downloaded after you turn it on (each needs a small
`.meta.json` file next to it, written at download time). After turning the
option on or off, restart the reader once: the reader reads this setting when
it starts. With **Delete articles archived or deleted in Instapaper** on, the
next web sync also removes them from the SD card.

## Use on the web page

1. On the card, pick a folder (Home, Archive, Liked, or one of your own
   folders) and how many of its newest articles to download.
2. Tap **Sync now**. A progress bar under the button shows which article is
   downloading. Keep the page open until it says how many were added; any
   skipped articles are listed with the reason. Articles are saved in
   `/Instapaper/`, named the way the reader names them. Articles already on
   the card, whether synced here or fetched on the reader, are not downloaded
   again; skipped ones are tried again on the next sync.

**Delete articles archived or deleted in Instapaper:** when this is on, a sync
asks Instapaper what changed since the last sync and deletes the Instapaper
articles on the card that were archived or deleted, wherever you did it: in
Instapaper's apps, or on the reader with the archive option. The first sync
with it on looks back 30 days. Articles in the folder you sync are kept, so
syncing Archive keeps your archived articles. Files that did not come from
this plugin are never deleted.

## Highlights

Tap **Send highlights** to send the passages you highlighted on the reader in
Instapaper articles to Instapaper. Highlights that were sent before are not
sent again. It works for articles downloaded with this version of the plugin
or later (it finds them by their `.meta.json` file).

- Without Instapaper Premium, Instapaper accepts five highlights a month. The
  card says when the limit is reached; the rest are sent the next month.
- If the same passage appears more than once in an article, Instapaper marks
  its first occurrence.
- Notes are not sent, and highlights deleted on the reader stay in
  Instapaper.

An app on your network can also start a web sync: send a `sync` job for the
`instapaper` plugin to `/api/plugin-jobs` while the reader's web page (or
`/plugins-run`) is open.

## Updating

Plugin Hub shows **Update** when a new version is out. Your token and settings
stay. An update replaces `device.json`, so afterwards open the reader's web
**Settings** page once: the card puts your folders and, if it is on, the
progress-and-archiving handler back. If progress and archiving is on, restart
the reader after that.

## Limits

- Images need the converter. SVG drawings, icons smaller than 120 pixels, and
  images that fail to download are left out. An article keeps at most 30
  images.
- Cloudflare's free plan converts 5,000 different images a month. After that,
  only images the reader can show as they are (JPEG, PNG, GIF under 1 MB) are
  kept until the next month.
- PDFs and videos saved to Instapaper have no text, so they cannot be
  downloaded. So are pages Instapaper cannot extract text from.
- Instapaper has no article language, so the plugin guesses it from the
  writing system, for hyphenation. Latin-script articles use your browser's
  language, or English.
- Without the converter, a web sync skips an article whose EPUB would be over
  256 KB, roughly 100,000 words of English. With it, there is no size limit.
- Progress and archiving need the converter. Likes and folders are not sent
  back to Instapaper.
- Fetching on the reader an article that is already on the card replaces it
  with a fresh copy (the reader's catalog does not check).

## Privacy

The access token is stored in `config.json` in the plugin folder on the SD
card. Anyone with the card, or with access to the reader's web page while File
Transfer runs, can read it. With the converter, each download sends the token
to it; it passes the token to Instapaper and keeps nothing. To list your
folders, the reader sends the token in the converter's web address, because
that request cannot carry headers. The address only travels over HTTPS, but
the reader writes it to its debug log if the request fails.

To stop the token from working, tap **Disconnect**, then revoke or regenerate
it on the application's page on instapaper.com.

## Development

How the plugin and the converter work, and how to release a new version:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
