// Converter Worker for Articles for Instapaper.
//
// GET /bookmarks/{id}.epub?lang=<fallback>&title=<title>&url=<article URL>
// POST /events/exit (reading progress and archiving; see events.js)
// with the caller's own "Authorization: Bearer <Instapaper token>".
//
// The reader's device.json catalog downloads articles through this Worker:
// it fetches Instapaper's parsed text for the bookmark and its images, and
// returns them as an EPUB built by src/epub.js (the web card uses the
// same module, without images). Images are converted for the reader by
// images.js. It keeps no state and no secrets; every request runs with the
// token the reader sends.
//
// All parameters are percent-encoded (the reader's {title_enc} and
// {url_enc}). Without `title`, the article uses the page's own title.
import { DOMParser } from 'linkedom';
import {
  articleContent,
  articleDocumentHtml,
  articleFromParse,
  buildEpub,
  placeImages,
  readerFileName,
} from '../src/epub.js';
import { readerExit } from './events.js';
import { fetchCover, fetchImages } from './images.js';

const INSTAPAPER_API = 'https://www.instapaper.com/api/2';
// Matches WORKER_BANNER in plugin.js, which checks the address with it.
const BANNER = 'Articles for Instapaper converter';

function textResponse(status, message) {
  return new Response(message + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function readQuery(search) {
  const params = new URLSearchParams(search);
  return { lang: params.get('lang') || '', title: params.get('title') || '', url: params.get('url') || '' };
}

async function instapaperMessage(response) {
  try {
    return (await response.json()).error.message || '';
  } catch (e) {
    return '';
  }
}

export async function convert(request) {
  const url = new URL(request.url);
  if (url.pathname === '/events/exit') {
    return request.method === 'POST' ? readerExit(request) : textResponse(405, 'Use POST.');
  }
  if (request.method !== 'GET') return textResponse(405, 'Only GET is supported.');
  if (url.pathname === '/') {
    return textResponse(200, BANNER + '. GET /bookmarks/{id}.epub or POST /events/exit with your Instapaper token.');
  }
  const route = /^\/bookmarks\/(\d+)\.epub$/.exec(url.pathname);
  if (!route) return textResponse(404, 'Not found.');

  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return textResponse(401, 'Send your Instapaper token as "Authorization: Bearer <token>".');

  const id = Number(route[1]);
  const upstream = await fetch(INSTAPAPER_API + '/bookmarks/' + id + '/parse', {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!upstream.ok) {
    const message = await instapaperMessage(upstream);
    // 400 means Instapaper has no text for this bookmark; the request was fine.
    const status = upstream.status === 400 ? 422 : upstream.status;
    return textResponse(status, 'Instapaper answered HTTP ' + upstream.status + (message ? ': ' + message : '') + '.');
  }
  const parsed = await upstream.json();
  if (!(parsed.content && parsed.content.body)) return textResponse(422, 'Instapaper has no text for this article.');

  const query = readQuery(url.search);
  const article = articleFromParse({ id, url: query.url, title: query.title }, parsed);
  const doc = new DOMParser().parseFromString(articleDocumentHtml(parsed.content.body), 'text/html');
  const text = articleContent(doc, article.title, query.lang.toLowerCase().split('-')[0], {
    images: true,
    baseUrl: query.url,
  });
  const { files, stats } = await fetchImages(text.images, query.url);
  // The cover: Instapaper's lead image, else the first image the article keeps.
  const thumbnail = (parsed.metadata && parsed.metadata.thumbnail) || '';
  const firstKept = files.findIndex(Boolean);
  const coverUrl = /^https?:/.test(thumbnail) ? thumbnail : firstKept >= 0 ? text.images[firstKept].url : '';
  const cover = coverUrl ? await fetchCover(coverUrl, query.url) : null;
  const epub = await buildEpub(article, placeImages(text, files, cover), Date.now());
  const filename = readerFileName(article.title).replace(/[^\x20-\x7E]/g, '_');
  return new Response(epub, {
    headers: {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
      'Cache-Control': 'private, no-store',
      // For checking a deployment: images found, kept, and converted by Cloudflare.
      'X-Images':
        stats.found +
        ' found, ' +
        stats.kept +
        ' kept, ' +
        stats.converted +
        ' converted, ' +
        (cover ? 'cover ' + cover.width + 'x' + cover.height + (cover.resized ? ' converted' : ' original') : 'no cover'),
    },
  });
}

export default {
  fetch(request) {
    return convert(request).catch((e) => textResponse(502, 'Conversion failed: ' + e.message));
  },
};
