// Shared by the web card (plugin.js), the converter Worker (worker/) and the
// tests: turns Instapaper's parsed article HTML into a small EPUB.
//
// Callers parse the HTML themselves (DOMParser in the browser, linkedom in the
// Worker) and pass the Document in, so this module needs no DOM of its own.
//
// Images are optional: with `images: true`, articleContent() leaves a marker
// for each <img> and lists its URL; the caller fetches what it can and
// placeImages() turns the markers into <img> elements or drops them.

const utf8Encoder = new TextEncoder();

// --- Article HTML to XHTML -----------------------------------------------------

// Elements kept as they are, without attributes. Everything else not in
// DROPPED_TAGS is unwrapped: its children stay, the element goes.
const KEPT_TAGS = new Set(
  (
    'p h1 h2 h3 h4 h5 h6 blockquote ul ol li dl dt dd pre code em strong b i u s sub sup small ' +
    'figcaption table thead tbody tfoot tr th td caption q cite abbr del ins mark kbd samp var'
  ).split(' '),
);
const VOID_TAGS = new Set(['br', 'hr']);
const DROPPED_TAGS = new Set(
  (
    'script style noscript template iframe object embed video audio canvas svg math img ' +
    'source track map form input button select textarea head title link meta'
  ).split(' '),
);
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeXml(text) {
  return String(text)
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Unwrapped elements that start a new line in a browser.
const BLOCK_TAGS = new Set(
  'div section article header footer main aside nav figure address details summary center hgroup'.split(' '),
);
// Kept elements whose content is a run of text, not further blocks.
const TEXT_TAGS = new Set('p h1 h2 h3 h4 h5 h6 li dt dd figcaption caption th td pre'.split(' '));

// Marks an image's place in the body: \u0001<index><i|b>\u0001, where `i`
// sits inside text and `b` stands alone. escapeXml() strips \u0001 from text,
// so a marker can only come from here.
const IMAGE_MARKER = /\u0001(\d+)([ib])\u0001/g;

function imageMarker(img, inText, images) {
  let url;
  try {
    url = new URL((img.getAttribute('src') || '').trim(), images.baseUrl || undefined).href;
  } catch (e) {
    return '';
  }
  if (!/^https?:/.test(url)) return '';
  let index = images.byUrl.get(url);
  if (index === undefined) {
    index = images.list.length;
    images.byUrl.set(url, index);
    images.list.push({ url, alt: normalizeSpace(img.getAttribute('alt')) });
  }
  return '\u0001' + index + (inText ? 'i' : 'b') + '\u0001';
}

function hasOwnText(element) {
  return Array.from(element.childNodes).some((n) => n.nodeType === 3 && n.data.trim());
}

// `inText` is true inside a TEXT_TAGS element, where an unwrapped block
// becomes a line break so its words do not run into the previous ones.
// Outside one, a block that holds text directly becomes a paragraph.
// `images` ({baseUrl, list, byUrl}) collects <img> sources; without it images
// are dropped.
export function toXhtml(node, inText, images) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += escapeXml(child.data);
    } else if (child.nodeType === 1) {
      const tag = child.localName;
      if (tag === 'img' && images) {
        out += imageMarker(child, inText, images);
      } else if (DROPPED_TAGS.has(tag)) {
        continue;
      } else if (VOID_TAGS.has(tag)) {
        out += '<' + tag + '/>';
      } else if (KEPT_TAGS.has(tag)) {
        out += '<' + tag + '>' + toXhtml(child, inText || TEXT_TAGS.has(tag), images) + '</' + tag + '>';
      } else if (!BLOCK_TAGS.has(tag)) {
        out += toXhtml(child, inText, images);
      } else if (inText) {
        const inner = toXhtml(child, true, images);
        if (out.trim() && inner.trim() && !out.endsWith('<br/>')) out += '<br/>';
        out += inner;
      } else if (hasOwnText(child)) {
        out += '<p>' + toXhtml(child, true, images) + '</p>';
      } else {
        out += toXhtml(child, false, images);
      }
    }
  }
  return out;
}

export function normalizeSpace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The parse response has no language, and the reader picks hyphenation
// rules from dc:language. Guess from the script; for Latin text use the
// browser's language when it is written in Latin script too.
const SCRIPT_LANGUAGES = [
  [/[぀-ヿ]/g, 'ja'],
  [/[가-힯]/g, 'ko'],
  [/[一-鿿]/g, 'zh'],
  [/[Ѐ-ӿ]/g, 'ru'],
  [/[Ͱ-Ͽ]/g, 'el'],
  [/[֐-׿]/g, 'he'],
  [/[؀-ۿ]/g, 'ar'],
];
const NON_LATIN = new Set(SCRIPT_LANGUAGES.map(([, lang]) => lang).concat(['uk', 'bg', 'sr', 'be', 'fa']));

export function guessLanguage(text, browserLanguage) {
  const sample = String(text).slice(0, 5000);
  const letters = (sample.match(/\p{L}/gu) || []).length;
  for (const [pattern, lang] of SCRIPT_LANGUAGES) {
    if (letters && (sample.match(pattern) || []).length / letters > 0.3) return lang;
  }
  return browserLanguage && !NON_LATIN.has(browserLanguage) ? browserLanguage : 'en';
}

// `doc` is the parsed article body. Returns the parts the EPUB needs.
// options.images keeps image markers and lists their URLs in `images`;
// options.baseUrl resolves relative image sources.
export function articleContent(doc, title, browserLanguage, options) {
  const body = doc.body || doc.documentElement;
  const firstHeading = body.querySelector('h1');
  const images = options && options.images ? { baseUrl: options.baseUrl, list: [], byUrl: new Map() } : null;
  return {
    body: toXhtml(body, false, images),
    hasTitle: !!firstHeading && normalizeSpace(firstHeading.textContent) === normalizeSpace(title),
    language: guessLanguage(body.textContent, browserLanguage),
    images: images ? images.list : [],
  };
}

// `files[i]` is {data, mime, ext} for content.images[i], or null to drop it.
// Returns the content with <img> elements in place and `imageFiles` to pack.
// `cover` ({data, mime, ext}, optional) is packed as the book's cover; it is
// not shown in the text.
export function placeImages(content, files, cover) {
  const imageFiles = [];
  const fileFor = (n) => {
    const href = 'images/' + (n + 1) + '.' + files[n].ext;
    let entry = imageFiles.find((f) => f.href === href);
    if (!entry) {
      entry = { href, mime: files[n].mime, data: files[n].data };
      imageFiles.push(entry);
    }
    return entry;
  };
  const body = content.body.replace(IMAGE_MARKER, (marker, n, kind) => {
    if (!files[Number(n)]) return '';
    const img = '<img src="' + fileFor(Number(n)).href + '" alt="' + escapeXml(content.images[n].alt || '') + '"/>';
    return kind === 'i' ? img : '<p>' + img + '</p>';
  });
  if (cover) imageFiles.push({ href: 'images/cover.' + cover.ext, mime: cover.mime, data: cover.data, cover: true });
  return Object.assign({}, content, { body, imageFiles });
}

// --- EPUB ------------------------------------------------------------------------

export function siteName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

// The last page of every article. Turning to it is how the reader says "I
// finished this": progress there is 100%, which the converter takes as the
// signal to archive (worker/events.js).
export const END_PAGE_TEXT = 'End of article';

// The reader reports whole-book progress for the top of the current page,
// with each content file weighted by its uncompressed size
// (Epub::calculateProgress). Padding the article file to at least 200 times
// the end page's size makes the end page start at 99.5% or more, which the
// reader rounds to 100%, however short the article is. The padding is a
// comment, so it is invisible and compresses to almost nothing.
const END_PAGE_WEIGHT = 200;

function endPageXhtml(lang, dir) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="' +
    lang +
    '"' +
    dir +
    '><head><title>' +
    END_PAGE_TEXT +
    '</title></head><body><p><b>' +
    END_PAGE_TEXT +
    '</b></p></body></html>\n'
  );
}

function padArticle(articleXhtml, endPage) {
  const missing = END_PAGE_WEIGHT * utf8Encoder.encode(endPage).length - utf8Encoder.encode(articleXhtml).length;
  if (missing <= 0) return articleXhtml;
  const comment = '<!--' + ' '.repeat(missing) + '-->';
  return articleXhtml.replace('</body></html>', comment + '</body></html>');
}

// `article` is {id, title, author, site, url, description, pubtime, rtl}.
export function epubFiles(article, content, modified) {
  const title = normalizeSpace(article.title) || 'Untitled article';
  const id = 'urn:instapaper:bookmark:' + article.id;
  const lang = escapeXml(content.language);
  const dir = article.rtl ? ' dir="rtl"' : '';
  const byline = [article.author, article.site].filter(Boolean).map(escapeXml).join(' · ');
  const heading = (content.hasTitle ? '' : '<h1>' + escapeXml(title) + '</h1>') + (byline ? '<p><i>' + byline + '</i></p>' : '');
  const imageFiles = content.imageFiles || [];
  const body = content.body.replace(IMAGE_MARKER, '');
  const description = normalizeSpace(article.description);
  const metadata = [
    '<dc:identifier id="bookid">' + escapeXml(id) + '</dc:identifier>',
    '<dc:title>' + escapeXml(title) + '</dc:title>',
    article.author || article.site ? '<dc:creator>' + escapeXml(article.author || article.site) + '</dc:creator>' : '',
    '<dc:language>' + lang + '</dc:language>',
    article.url ? '<dc:source>' + escapeXml(article.url) + '</dc:source>' : '',
    description ? '<dc:description>' + escapeXml(description) + '</dc:description>' : '',
    article.pubtime ? '<dc:date>' + new Date(article.pubtime * 1000).toISOString().slice(0, 10) + '</dc:date>' : '',
    '<meta property="dcterms:modified">' + modified + '</meta>',
  ].filter(Boolean);
  // The reader takes the cover from either form (ContentOpfParser).
  const coverIndex = imageFiles.findIndex((f) => f.cover);
  if (coverIndex >= 0) metadata.push('<meta name="cover" content="image' + (coverIndex + 1) + '"/>');
  const xhtml = (body) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' +
    lang +
    '"' +
    dir +
    '><head><title>' +
    escapeXml(title) +
    '</title></head><body>' +
    body +
    '</body></html>\n';

  return [
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
        '</container>\n',
    ],
    [
      'OEBPS/content.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' +
        lang +
        '">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
        metadata.join('\n') +
        '\n</metadata>\n<manifest>\n' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
        '<item id="article" href="article.xhtml" media-type="application/xhtml+xml"/>\n' +
        '<item id="end" href="end.xhtml" media-type="application/xhtml+xml"/>\n' +
        imageFiles
          .map(
            (f, i) =>
              '<item id="image' +
              (i + 1) +
              '" href="' +
              f.href +
              '" media-type="' +
              f.mime +
              '"' +
              (f.cover ? ' properties="cover-image"' : '') +
              '/>\n',
          )
          .join('') +
        '</manifest>\n<spine toc="ncx"' +
        (article.rtl ? ' page-progression-direction="rtl"' : '') +
        '><itemref idref="article"/><itemref idref="end"/></spine>\n</package>\n',
    ],
    [
      'OEBPS/nav.xhtml',
      xhtml('<nav epub:type="toc"><ol><li><a href="article.xhtml">' + escapeXml(title) + '</a></li></ol></nav>'),
    ],
    [
      'OEBPS/toc.ncx',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' +
        escapeXml(id) +
        '"/></head><docTitle><text>' +
        escapeXml(title) +
        '</text></docTitle><navMap><navPoint id="article" playOrder="1"><navLabel><text>' +
        escapeXml(title) +
        '</text></navLabel><content src="article.xhtml"/></navPoint></navMap></ncx>\n',
    ],
    ['OEBPS/article.xhtml', padArticle(xhtml(heading + body), endPageXhtml(lang, dir))],
    ['OEBPS/end.xhtml', endPageXhtml(lang, dir)],
  ].concat(imageFiles.map((f) => ['OEBPS/' + f.href, f.data]));
}

// --- ZIP -------------------------------------------------------------------------
// `mimetype` must be the first entry and stored. Images are stored too; text
// is deflated when the runtime has CompressionStream and it makes it smaller.

// Slice-by-4 CRC-32: images make the CRC the Worker's main CPU cost.
const CRC_TABLES = [0, 1, 2, 3].map(() => new Uint32Array(256));
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLES[0][n] = c >>> 0;
}
for (let n = 0; n < 256; n++) {
  for (let t = 1; t < 4; t++) CRC_TABLES[t][n] = (CRC_TABLES[t - 1][n] >>> 8) ^ CRC_TABLES[0][CRC_TABLES[t - 1][n] & 0xff];
}

function crc32(bytes) {
  const [t0, t1, t2, t3] = CRC_TABLES;
  let c = 0xffffffff;
  let i = 0;
  for (const end = bytes.length & ~3; i < end; i += 4) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t3[c & 0xff] ^ t2[(c >>> 8) & 0xff] ^ t1[(c >>> 16) & 0xff] ^ t0[c >>> 24];
  }
  for (; i < bytes.length; i++) c = t0[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(files) {
  const entries = [];
  for (const [name, text] of files) {
    // Strings are text; byte arrays are images, already compressed.
    const binary = typeof text !== 'string';
    const data = binary ? text : utf8Encoder.encode(text);
    const deflated = name === 'mimetype' || binary ? null : await deflateRaw(data);
    const useDeflate = deflated && deflated.length < data.length;
    entries.push({
      nameBytes: utf8Encoder.encode(name),
      size: data.length,
      body: useDeflate ? deflated : data,
      method: useDeflate ? 8 : 0,
      crc: crc32(data),
      offset: 0,
    });
  }
  const localSize = entries.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.body.length, 0);
  const centralSize = entries.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01, time 00:00
  let pos = 0;

  for (const e of entries) {
    e.offset = pos;
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true); // version needed
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 names
    view.setUint16(pos + 8, e.method, true);
    view.setUint16(pos + 12, DOS_DATE, true);
    view.setUint32(pos + 14, e.crc, true);
    view.setUint32(pos + 18, e.body.length, true);
    view.setUint32(pos + 22, e.size, true);
    view.setUint16(pos + 26, e.nameBytes.length, true);
    out.set(e.nameBytes, pos + 30);
    out.set(e.body, pos + 30 + e.nameBytes.length);
    pos += 30 + e.nameBytes.length + e.body.length;
  }

  const centralStart = pos;
  for (const e of entries) {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true); // version made by
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, e.method, true);
    view.setUint16(pos + 14, DOS_DATE, true);
    view.setUint32(pos + 16, e.crc, true);
    view.setUint32(pos + 20, e.body.length, true);
    view.setUint32(pos + 24, e.size, true);
    view.setUint16(pos + 28, e.nameBytes.length, true);
    view.setUint32(pos + 42, e.offset, true);
    out.set(e.nameBytes, pos + 46);
    pos += 46 + e.nameBytes.length;
  }

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - centralStart, true);
  view.setUint32(pos + 16, centralStart, true);
  return out;
}

export function buildEpub(article, content, now) {
  const modified = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
  return zip(epubFiles(article, content, modified));
}

// The name the reader's catalog gives a download of `title`
// (StringUtils::sanitizeFilenamePreservingExtension("{title}.epub", 100)), so
// the web sync and the reader write the same file. Leading spaces and dots
// are skipped, FAT's reserved characters become '_', control characters are
// dropped, the stem is cut at a whole character within 95 bytes, and
// trailing spaces and dots are trimmed.
// `suffix` (such as " (123)") is kept whole, after the stem.
export function readerFileName(title, suffix = '') {
  const STEM_BYTES = 100 - '.epub'.length - utf8Encoder.encode(suffix).length;
  let stem = '';
  let bytes = 0;
  const chars = Array.from(String(title || '').replace(/^[ .]+/, ''));
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    let piece;
    if ('/\\:*?"<>|'.includes(ch)) piece = '_';
    else if (cp >= 128 || (cp >= 32 && cp < 127)) piece = ch;
    else continue;
    const size = utf8Encoder.encode(piece).length;
    if (bytes + size > STEM_BYTES) break;
    stem += piece;
    bytes += size;
  }
  stem = stem.replace(/[ .]+$/, '');
  return (stem || 'book') + suffix + '.epub';
}

// A page title without a trailing " — Site", " | Site" or " - Site" that
// names the article's own site ("… — Meduza" on meduza.io).
export function withoutSiteSuffix(title, url) {
  const match = /^(.+?)\s+[-–—|·]\s+([^-–—|·]{1,40})$/.exec(normalizeSpace(title));
  if (!match) return normalizeSpace(title);
  const letters = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = letters(match[2]);
  const site = letters(siteName(url).replace(/\.[a-z]+$/i, ''));
  return suffix && site && (site.startsWith(suffix) || suffix.startsWith(site)) ? match[1] : normalizeSpace(title);
}

// The article fields epubFiles() needs, from a bookmark (any of id, title,
// url, author, description, pubtime) and its /parse response. The bookmark's
// title is the one Instapaper lists; the parsed one is the page's own title.
export function articleFromParse(bookmark, parsed) {
  const meta = parsed.metadata || {};
  const content = parsed.content || {};
  return {
    id: bookmark.id,
    title: bookmark.title || withoutSiteSuffix(meta.title || '', bookmark.url),
    author: (meta.author && meta.author.name) || bookmark.author || '',
    site: siteName(bookmark.url),
    url: bookmark.url || '',
    description: bookmark.description || meta.description || '',
    pubtime: bookmark.pubtime || meta.pubtime || null,
    rtl: content.direction === 'rtl',
  };
}

// Wraps a /parse body so every parser yields a document with a <body>.
export function articleDocumentHtml(body) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + body + '</body></html>';
}
