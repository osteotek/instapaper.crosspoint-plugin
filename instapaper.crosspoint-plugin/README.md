# Articles for Instapaper

Downloads your saved Instapaper articles to the reader as EPUB books.

1. Create an Instapaper application at
   instapaper.com/developers/applications and select **Generate access
   token**.
2. Open the reader's web page (File Transfer), go to **Settings**, paste the
   token on the **Articles for Instapaper** card and tap **Connect**.
3. Tap **Sync now** to download articles to `/Instapaper/`.

Optional: deploy the converter (a free Cloudflare Worker) for images, covers,
your folders and downloads on the reader, reading progress and archiving.

Full guide: https://github.com/osteotek/instapaper.crosspoint-plugin
