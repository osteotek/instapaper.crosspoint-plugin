import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { inflateRawSync, crc32 } from 'node:zlib';
import { JSDOM } from 'jsdom';
import * as epub from '../src/epub.js';
import worker from '../worker/index.js';
import { COVER_TRANSFORM, fetchCover, fetchImages, imageInfo, readerCanShow } from '../worker/images.js';
import { readerExit } from '../worker/events.js';
import { folderLists } from '../worker/lists.js';
import { buildFiles } from '../scripts/build.mjs';

const root = new URL('../instapaper.crosspoint-plugin/', import.meta.url);
const parseHtml = (html) => new JSDOM(html).window.document;

// Loads the readable source by default; `built` loads the minified copy that
// is installed on the reader.
async function loadPlugin(built = false) {
  const hooks = {};
  let render = null;
  const context = vm.createContext({
    __instapaperTest: hooks,
    CrossPoint: { registerPlugin(fn) { render = fn; } },
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    btoa,
    atob,
    Blob,
    Response,
    CompressionStream,
  });
  const file = built ? new URL('plugin.js', root) : new URL('../src/plugin.js', import.meta.url);
  vm.runInContext(await readFile(file, 'utf8'), context, { filename: 'plugin.js' });
  assert.equal(typeof render, 'function', 'plugin.js should register a render function');
  return hooks;
}

// Minimal ZIP reader: checks the structure the reader's EPUB code relies on.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(pos, true), 0x02014b50, 'central directory entry');
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const offset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    assert.equal(view.getUint32(offset, true), 0x04034b50, 'local header for ' + name);
    const localNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLength + extraLength;
    const raw = bytes.subarray(start, start + view.getUint32(offset + 18, true));
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc, 'CRC for ' + name);
    files.push({ name, method, offset, text: new TextDecoder().decode(data) });
    pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  return files;
}

function assertWellFormedXml(text, label) {
  const doc = new JSDOM(text, { contentType: 'application/xml' }).window.document;
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, label + ' should be well-formed XML');
}

test('articleContent keeps text structure and drops scripts, images and attributes', async () => {
  const { articleContent } = epub;
  const doc = parseHtml(
    '<h1>Same title</h1><div class="x"><p id="a">One &amp; <a href="https://e.com">two</a> &lt;3</p>' +
      '<script>alert(1)</script><figure><picture><img src="a.png"></picture><figcaption>Cap</figcaption></figure>' +
      '<p>Line<br>break<hr></p><ul><li><em>x</em></li></ul><span>tail\u0001</span></div>',
  );
  const content = articleContent(doc, ' Same   title ', 'en');
  assert.equal(content.language, 'en');
  assert.equal(content.hasTitle, true);
  assert.equal(
    content.body,
    '<h1>Same title</h1><p>One &amp; two &lt;3</p><figcaption>Cap</figcaption>' +
      '<p>Line<br/>break</p><hr/><p></p><ul><li><em>x</em></li></ul>tail',
  );
  assertWellFormedXml('<body>' + content.body + '</body>', 'article body');
  assert.equal(articleContent(parseHtml('<p>Hi</p>'), 'Other', 'fr').hasTitle, false);
});

test('articleContent keeps words in unwrapped blocks apart', async () => {
  const { articleContent } = epub;
  // Shapes from real Instapaper parse output.
  const caption = articleContent(
    parseHtml('<figure><figcaption><div><div>Photo caption, 2026</div><div>Photographer</div></div></figcaption></figure>'),
    'x',
    'en',
  );
  assert.equal(caption.body, '<figcaption>Photo caption, 2026<br/>Photographer</figcaption>');
  const loose = articleContent(parseHtml('<div><div>Loose text <em>here</em></div><section><p>Para</p></section></div>'), 'x', 'en');
  assert.equal(loose.body, '<p>Loose text <em>here</em></p><p>Para</p>');
});

test('guessLanguage reads the script, then falls back to the browser language', async () => {
  const { guessLanguage } = epub;
  assert.equal(guessLanguage('Ни один народ не любит правду о себе, and some English.', 'en'), 'ru');
  assert.equal(guessLanguage('Η γλώσσα', 'en'), 'el');
  assert.equal(guessLanguage('日本語のテキストです', 'en'), 'ja');
  assert.equal(guessLanguage('Die Brücke über den Fluss', 'de'), 'de');
  assert.equal(guessLanguage('An English text', 'ru'), 'en');
  assert.equal(guessLanguage('', ''), 'en');
});

const sampleArticle = {
  id: 42,
  title: 'Fish & "Chips" <today>',
  author: 'Jane Doe',
  site: 'example.com',
  url: 'https://www.example.com/a',
  description: 'About  food.',
  pubtime: 1705276800,
  rtl: false,
};

test('buildEpub writes a valid EPUB with mimetype first and stored', async () => {
  const { buildEpub, articleContent } = epub;
  const body = '<p>' + 'Body text that repeats. '.repeat(200) + '</p>';
  const content = articleContent(parseHtml(body), sampleArticle.title, 'en');
  const bytes = await buildEpub(sampleArticle, content, Date.UTC(2026, 9, 25, 12, 0, 0));
  const files = readZip(bytes);
  assert.deepEqual(
    Array.from(files, (f) => f.name),
    ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx', 'OEBPS/article.xhtml', 'OEBPS/end.xhtml'],
  );
  assert.equal(files[0].offset, 0);
  assert.equal(files[0].method, 0);
  assert.equal(files[0].text, 'application/epub+zip');
  assert.equal(files[5].method, 8, 'the article should be deflated');
  assert.ok(bytes.length < body.length / 2, bytes.length + ' bytes');
  for (const f of files.slice(1)) assertWellFormedXml(f.text, f.name);

  const opf = files[2].text;
  assert.match(opf, /<dc:title>Fish &amp; &quot;Chips&quot; &lt;today&gt;<\/dc:title>/);
  assert.match(opf, /<dc:creator>Jane Doe<\/dc:creator>/);
  assert.match(opf, /<dc:language>en<\/dc:language>/);
  assert.match(opf, /<dc:identifier id="bookid">urn:instapaper:bookmark:42<\/dc:identifier>/);
  assert.match(opf, /<dc:description>About food\.<\/dc:description>/);
  assert.match(opf, /<dc:date>2024-01-15<\/dc:date>/);
  assert.match(opf, /<meta property="dcterms:modified">2026-10-25T12:00:00Z<\/meta>/);
  assert.match(files[5].text, /<h1>Fish &amp; &quot;Chips&quot; &lt;today&gt;<\/h1><p><i>Jane Doe · example\.com<\/i><\/p><p>Body/);
});

test('buildEpub marks right-to-left articles', async () => {
  const { buildEpub, articleContent } = epub;
  const content = articleContent(parseHtml('<p>שלום עולם</p>'), 'x', 'en');
  const files = readZip(await buildEpub(Object.assign({}, sampleArticle, { rtl: true }), content, 0));
  assert.match(files[2].text, /<dc:language>he<\/dc:language>/);
  assert.match(files[2].text, /page-progression-direction="rtl"/);
  assert.match(files[5].text, /<html [^>]*dir="rtl"/);
});

test('withoutSiteSuffix drops a trailing site name only', () => {
  const { withoutSiteSuffix } = epub;
  assert.equal(withoutSiteSuffix('Long interview title — Meduza', 'https://meduza.io/feature/x'), 'Long interview title');
  assert.equal(withoutSiteSuffix('My Students Can’t Read | The Atlantic', 'https://www.theatlantic.com/a'), 'My Students Can’t Read');
  assert.equal(withoutSiteSuffix('Agents - The New Stack', 'https://thenewstack.io/x'), 'Agents');
  assert.equal(withoutSiteSuffix('Rust - A Language Guide', 'https://example.com/x'), 'Rust - A Language Guide', 'not the site');
  assert.equal(withoutSiteSuffix('Plain title', ''), 'Plain title');
});

test('readerFileName names files like the reader catalog does', () => {
  const { readerFileName } = epub;
  // Expected values follow StringUtils::sanitizeFilenamePreservingExtension.
  assert.equal(readerFileName('First: story'), 'First_ story.epub');
  assert.equal(readerFileName('  ..Hidden?'), 'Hidden_.epub');
  assert.equal(readerFileName('Ends with dots...'), 'Ends with dots.epub');
  assert.equal(readerFileName('Tab\there'), 'Tabhere.epub', 'control characters are dropped');
  assert.equal(readerFileName(''), 'book.epub');
  const long = readerFileName('x'.repeat(200));
  assert.equal(long, 'x'.repeat(95) + '.epub');
  // Cut at a whole character: 47 two-byte letters fit 95 bytes, a 48th does not.
  assert.equal(readerFileName('ж'.repeat(60)), 'ж'.repeat(47) + '.epub');
  assert.equal(readerFileName('x'.repeat(200), ' (42)'), 'x'.repeat(90) + ' (42).epub');
});

test('clampLimit falls back to 10 and caps at 50', async () => {
  const { clampLimit } = await loadPlugin();
  assert.equal(clampLimit('abc'), 10);
  assert.equal(clampLimit(0), 10);
  assert.equal(clampLimit(5.7), 5);
  assert.equal(clampLimit(500), 50);
});

// Fake Instapaper v2 and device. /api/fetch writes responses into an SD card
// in a Map and fails on non-2xx like the firmware; the relay returns them.
// `worker` maps bookmark IDs to the converter's answer: [status, body];
// `changes` is the answer to /bookmarks?since=; `highlight` answers highlight
// POSTs (status, by default 200).
function fakeDevice({ bookmarks = [], parses = {}, folders = [], worker = {}, changes = null, highlight = () => 200 } = {}) {
  const sd = new Map();
  const calls = [];
  const deleted = [];
  const respond = (method, url, headers, body) => {
    assert.equal(headers.Authorization, 'Bearer tok');
    if (url.startsWith('https://w.example/')) {
      calls.push(url.slice('https://w.example'.length));
      const id = /^https:\/\/w\.example\/bookmarks\/(\d+)\.epub\?/.exec(url)[1];
      const [status, text] = worker[id] || [404, 'Not found.'];
      return { status, headers: [], body: text };
    }
    const u = new URL(url);
    assert.equal(u.origin, 'https://www.instapaper.com');
    assert.ok(u.pathname.startsWith('/api/2/'));
    const path = u.pathname.slice(6);
    calls.push((method === 'POST' ? 'POST ' : '') + path + u.search);
    const json = (value, status = 200) => ({ status, headers: [], body: JSON.stringify(value) });
    const h = path.match(/^\/bookmarks\/(\d+)\/highlights$/);
    if (h && method === 'POST') return json({}, highlight(h[1], JSON.parse(body).text));
    assert.equal(method, 'GET');
    if (path === '/me') return json({ id: 5, username: 'reader@example.com', premium: false });
    if (path === '/folders') return json({ folders });
    if (path === '/bookmarks' && u.searchParams.has('since')) return json(changes || { bookmarks: [], deleted_ids: [] });
    if (path === '/bookmarks') {
      const limit = Number(u.searchParams.get('limit'));
      return json({ bookmarks: bookmarks.slice(0, limit), total: bookmarks.length });
    }
    const m = path.match(/^\/bookmarks\/(\d+)\/parse$/);
    if (m && parses[m[1]] === 401) return json({ error: { code: 401, message: 'Authentication failed' } }, 401);
    if (m && parses[m[1]]) return json(parses[m[1]]);
    if (m) return json({ error: { code: 400, message: 'Parsed content unavailable' } }, 400);
    return json({ error: { code: 404 } }, 404);
  };
  const api = {
    dir: '/plugins/instapaper',
    async relay(method, url, headers, body) {
      return respond(method, url, headers, body);
    },
    async fetchToSd(url, dest, headers) {
      const r = respond('GET', url, headers);
      if (r.status !== 200) throw Object.assign(new Error('/api/fetch made no progress'), { status: 500 });
      sd.set(dest, new TextEncoder().encode(r.body));
      return { status: 200, complete: true };
    },
    async writeFile(path, b64) {
      sd.set(path, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      return {};
    },
  };
  const io = {
    async readJson(path) {
      return sd.has(path) ? JSON.parse(new TextDecoder().decode(sd.get(path))) : null;
    },
    async readBytes(path) {
      return sd.get(path) || null;
    },
    async listDir(dir) {
      return Array.from(sd.keys())
        .filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/'))
        .map((k) => k.slice(dir.length + 1));
    },
    async deleteFile(path) {
      deleted.push(path);
      sd.delete(path);
    },
    loadEpub: async () => epub,
    parseHtml,
    language: 'en',
    now: () => Date.UTC(2026, 9, 25),
  };
  // Puts a file on the card the way the reader's catalog would: the EPUB and
  // its sidecar.
  const fetchedOnReader = (name, id) => {
    sd.set('/Instapaper/' + name, new TextEncoder().encode('EPUB'));
    sd.set('/Instapaper/' + name + '.meta.json', new TextEncoder().encode(JSON.stringify({ instapaper_id: String(id) })));
  };
  return { api, io, sd, calls, deleted, fetchedOnReader };
}

const bookmark = (id, title, extra) =>
  Object.assign({ id, title, url: 'https://news.example.org/' + id, description: '', author: null, pubtime: null, category: 0 }, extra);
const parsed = (body, extra) =>
  Object.assign({ metadata: { title: 'x', author: null, description: null }, content: { body, images: [], words: 3, paywalled: false, direction: 'ltr' } }, extra);
const connected = { token: 'tok', username: 'u' };

test('account and listSections use the bearer token', async () => {
  const { account, listSections } = await loadPlugin();
  const device = fakeDevice({ folders: [{ id: 9, title: 'Long reads', count: 1 }] });
  assert.equal((await account(device.api, connected)).username, 'reader@example.com');
  assert.deepEqual(
    Array.from(await listSections(device.api, connected), (s) => s.id + '=' + s.title),
    ['home=Home', 'archive=Archive', 'liked=Liked', 'folder:9=Long reads'],
  );
  const bad = fakeDevice();
  bad.api.relay = async () => ({ status: 401, headers: [], body: '{"error":{"code":401,"message":"Authentication failed"}}' });
  await assert.rejects(account(bad.api, connected), /did not accept the access token/);
});

test('syncArticles downloads new articles and skips what has no text', async () => {
  const { syncArticles, summary } = await loadPlugin();
  const device = fakeDevice({
    bookmarks: [
      bookmark(1, 'First: story'),
      bookmark(2, 'A PDF', { category: 3 }),
      bookmark(3, 'Broken'),
      bookmark(4, 'First/ story'),
      bookmark(5, 'Empty'),
    ],
    parses: { 1: parsed('<p>One</p>', { metadata: { author: { name: 'Ann' } } }), 4: parsed('<p>Four</p>'), 5: parsed(null) },
  });
  const cfg = Object.assign({ section: 'folder:9', limit: 20 }, connected);
  const result = await syncArticles(cfg, device.api, device.io, () => {});

  assert.deepEqual(Array.from(result.added), ['First: story', 'First/ story']);
  assert.deepEqual(
    Array.from(result.skipped, (s) => s.title + ': ' + s.reason),
    ['A PDF: it is a PDF', 'Broken: Instapaper has no text for it', 'Empty: Instapaper has no text for it'],
  );
  assert.equal(device.calls[0], '/bookmarks?folder_id=9&limit=20');
  assert.ok(!device.calls.includes('/bookmarks/2/parse'), 'a PDF is not fetched');
  // Named like the reader's catalog names them; a clash gets the ID.
  const first = readZip(device.sd.get('/Instapaper/First_ story.epub'));
  assert.match(first[2].text, /<dc:creator>Ann<\/dc:creator>/);
  assert.deepEqual(await device.io.readJson('/Instapaper/First_ story.epub.meta.json'), { instapaper_id: '1' });
  assert.ok(device.sd.has('/Instapaper/First_ story (4).epub'));
  assert.ok(device.deleted.includes('/plugins/instapaper/download.json'));
  assert.ok(!device.sd.has('/plugins/instapaper/download.json'));
  assert.equal(summary(result), 'Added 2 articles. Skipped 3:');
  assert.deepEqual(Object.keys((await device.io.readJson('/plugins/instapaper/state.json')).articles).sort(), ['1', '4']);
});

test('syncArticles reports progress article by article', async () => {
  const { syncArticles } = await loadPlugin();
  const device = fakeDevice({
    bookmarks: [bookmark(1, 'One'), bookmark(2, 'A PDF', { category: 3 }), bookmark(3, 'Gone')],
    parses: { 1: parsed('<p>One</p>') },
  });
  const calls = [];
  await syncArticles(Object.assign({ section: 'home', limit: 5 }, connected), device.api, device.io, (text, done, total) =>
    calls.push([text, done, total]),
  );
  assert.deepEqual(calls, [
    ['Listing articles...', 0, 0],
    ['Downloading 1 of 3: One', 0, 3],
    ['Saved 1 of 3 (1 added, 0 skipped): One', 1, 3],
    ['Skipped 2 of 3 (1 added, 1 skipped): A PDF', 2, 3],
    ['Downloading 3 of 3 (1 added, 1 skipped): Gone', 2, 3],
    ['Skipped 3 of 3 (1 added, 2 skipped): Gone', 3, 3],
  ]);
  // Nothing new: the bar fills at once. (Skipped articles are retried, so use
  // a list where everything was saved.)
  const done = fakeDevice({ bookmarks: [bookmark(1, 'One')], parses: { 1: parsed('<p>One</p>') } });
  const cfg = Object.assign({ section: 'home', limit: 5 }, connected);
  await syncArticles(cfg, done.api, done.io, () => {});
  const none = [];
  await syncArticles(cfg, done.api, done.io, (...args) => none.push(args));
  assert.deepEqual(none, [['Listing articles...', 0, 0], ['No new articles.', 1, 1]]);
});

test('syncArticles does not download again what the reader already fetched', async () => {
  const { syncArticles } = await loadPlugin();
  const device = fakeDevice({
    bookmarks: [bookmark(1, 'Fetched on the reader'), bookmark(2, 'Mine'), bookmark(3, 'New')],
    parses: { 2: parsed('<p>2</p>'), 3: parsed('<p>3</p>') },
  });
  device.fetchedOnReader('Fetched on the reader.epub', 1);
  device.sd.set('/Instapaper/Mine.epub', new TextEncoder().encode('a file of yours, no sidecar'));
  const cfg = Object.assign({ section: 'home', limit: 5 }, connected);
  const result = await syncArticles(cfg, device.api, device.io, () => {});
  assert.deepEqual(Array.from(result.added), ['Mine', 'New']);
  assert.ok(!device.calls.includes('/bookmarks/1/parse'), 'found by its sidecar');
  assert.equal(new TextDecoder().decode(device.sd.get('/Instapaper/Mine.epub')), 'a file of yours, no sidecar', 'never replaced');
  assert.ok(device.sd.has('/Instapaper/Mine (2).epub'));
  const state = await device.io.readJson('/plugins/instapaper/state.json');
  assert.deepEqual(state.articles['1'], { file: '/Instapaper/Fetched on the reader.epub' });

  // A file you deleted is forgotten, so it can be downloaded again.
  device.sd.delete('/Instapaper/New.epub');
  device.calls.length = 0;
  const again = await syncArticles(cfg, device.api, device.io, () => {});
  assert.deepEqual(Array.from(again.added), ['New']);
});

test('syncArticles deletes articles archived or deleted in Instapaper', async () => {
  const { syncArticles } = await loadPlugin();
  const device = fakeDevice({
    bookmarks: [],
    changes: {
      bookmarks: [
        Object.assign(bookmark(1, 'Archived'), { archived: true }),
        Object.assign(bookmark(2, 'Progress changed'), { archived: false }),
        Object.assign(bookmark(9, 'Not on the card'), { archived: true }),
      ],
      deleted_ids: [3],
    },
  });
  device.fetchedOnReader('Archived.epub', 1);
  device.fetchedOnReader('Progress changed.epub', 2);
  device.fetchedOnReader('Deleted.epub', 3);
  const cfg = Object.assign({ section: 'home', limit: 5, remove_archived: true }, connected);
  const result = await syncArticles(cfg, device.api, device.io, () => {});
  assert.equal(result.removed, 2);
  assert.deepEqual(Array.from(device.deleted).filter((p) => p.startsWith('/Instapaper')).sort(), [
    '/Instapaper/Archived.epub',
    '/Instapaper/Archived.epub.meta.json',
    '/Instapaper/Deleted.epub',
    '/Instapaper/Deleted.epub.meta.json',
  ]);
  assert.ok(device.sd.has('/Instapaper/Progress changed.epub'));
  // The first check looks back 30 days; the next starts where it ended.
  const now = Date.UTC(2026, 9, 25) / 1000;
  assert.ok(device.calls.includes('/bookmarks?since=' + (now - 30 * 24 * 3600) + '&limit=500&offset=0'));
  const state = await device.io.readJson('/plugins/instapaper/state.json');
  assert.equal(state.since, now - 300);
  device.calls.length = 0;
  await syncArticles(cfg, device.api, device.io, () => {});
  assert.ok(device.calls.includes('/bookmarks?since=' + (now - 300) + '&limit=500&offset=0'));

  // Syncing Archive keeps the archived articles it lists.
  const archive = fakeDevice({
    bookmarks: [Object.assign(bookmark(1, 'Archived'), { archived: true })],
    changes: { bookmarks: [Object.assign(bookmark(1, 'Archived'), { archived: true })], deleted_ids: [] },
  });
  archive.fetchedOnReader('Archived.epub', 1);
  const kept = await syncArticles(Object.assign({}, cfg, { section: 'archive' }), archive.api, archive.io, () => {});
  assert.equal(kept.removed, 0);
  assert.ok(archive.sd.has('/Instapaper/Archived.epub'));

  // With the option off nothing is checked or deleted.
  device.calls.length = 0;
  await syncArticles(Object.assign({}, cfg, { remove_archived: false }), device.api, device.io, () => {});
  assert.ok(!device.calls.some((c) => c.includes('since=')));
});

test('syncArticles stops when the token is rejected', async () => {
  const { syncArticles } = await loadPlugin();
  const device = fakeDevice({ bookmarks: [bookmark(1, 'A'), bookmark(2, 'B')], parses: { 1: 401, 2: parsed('<p>B</p>') } });
  const cfg = Object.assign({ section: 'home', limit: 5 }, connected);
  await assert.rejects(syncArticles(cfg, device.api, device.io, () => {}), /did not accept the access token/);
  assert.ok(!device.calls.includes('/bookmarks/2/parse'));
  assert.ok(device.deleted.includes('/plugins/instapaper/download.json'));
});

test('syncArticles downloads EPUBs from the converter when it is on', async () => {
  const { syncArticles, summary } = await loadPlugin();
  const device = fakeDevice({
    bookmarks: [
      bookmark(1, 'With pictures', { url: 'https://news.example.org/a?x=1&y=2' }),
      bookmark(2, 'No text'),
      bookmark(3, 'Broken'),
      bookmark(4, 'A PDF', { category: 3 }),
    ],
    worker: { 1: [200, 'EPUB-BYTES'], 2: [422, 'Instapaper has no text for this article.'], 3: [502, 'Conversion failed: boom'] },
  });
  const cfg = Object.assign({ section: 'home', limit: 10, lang: 'de', worker_url: 'https://w.example' }, connected);
  const result = await syncArticles(cfg, device.api, device.io, () => {});
  assert.deepEqual(Array.from(result.added), ['With pictures']);
  assert.equal(new TextDecoder().decode(device.sd.get('/Instapaper/With pictures.epub')), 'EPUB-BYTES');
  assert.ok(
    device.calls.includes('/bookmarks/1.epub?lang=de&title=With%20pictures&url=https://news.example.org/a?x=1&y=2'),
    'title encoded, url last and raw',
  );
  assert.ok(!device.calls.some((c) => c.endsWith('/parse')), 'the page does not parse when the converter is on');
  assert.equal(summary(result), 'Added 1 articles. Skipped 3:');
  assert.deepEqual(
    Array.from(result.skipped, (s) => s.title + ': ' + s.reason),
    ['No text: Instapaper has no text for it', 'Broken: the converter answered HTTP 502: Conversion failed: boom', 'A PDF: it is a PDF'],
  );

  const rejected = fakeDevice({ bookmarks: [bookmark(1, 'A'), bookmark(2, 'B')], worker: { 1: [401, 'Instapaper answered HTTP 401.'] } });
  await assert.rejects(syncArticles(cfg, rejected.api, rejected.io, () => {}), /did not accept the access token/);
  assert.ok(!rejected.calls.some((c) => c.startsWith('/bookmarks/2.epub')), 'a rejected token stops the sync');
});

// Writes a clipping store the way ClippingStore::writeToFile does (version 4).
function clippingStore(path, texts) {
  const enc = new TextEncoder();
  const parts = [];
  const u8 = (v) => parts.push(Uint8Array.of(v));
  const u16 = (v) => parts.push(Uint8Array.of(v & 255, v >> 8));
  const u32 = (v) => parts.push(Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24));
  const str32 = (s) => {
    const b = enc.encode(s);
    u32(b.length);
    parts.push(b);
  };
  u8(4);
  u16(texts.length);
  str32('Book title');
  str32('Author');
  str32(path);
  for (const text of texts) {
    u16(0); // spine
    parts.push(new Uint8Array(14)); // pages, word indices, word count, paragraph
    u32(1761400000); // timestamp
    u32(0); // layout signature
    parts.push(new Uint8Array(4 + 4 + 8 + 1 + 65)); // offsets, revision, pending, id
    parts.push(new Uint8Array(48)); // chapter title
    const b = enc.encode(text);
    u16(b.length);
    parts.push(b);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

test('sendHighlights posts highlights from Instapaper articles once', async () => {
  const { sendHighlights, highlightSummary, parseClippingStore } = await loadPlugin();
  const posted = [];
  const device = fakeDevice({
    highlight: (id, text) => {
      posted.push(id + ': ' + text);
      return text === 'Already there' ? 400 : 200;
    },
  });
  device.fetchedOnReader('Article.epub', 42);
  device.sd.set('/.crosspoint/clippings/epub_1.bin', clippingStore('/Instapaper/Article.epub', ['  First highlight ', 'Already there', '']));
  device.sd.set('/.crosspoint/clippings/epub_2.bin', clippingStore('/Books/Not Instapaper.epub', ['Ignored']));
  device.sd.set('/.crosspoint/clippings/notes.txt', new TextEncoder().encode('not a store'));
  assert.deepEqual(Array.from(parseClippingStore(device.sd.get('/.crosspoint/clippings/epub_1.bin')).clippings), [
    '  First highlight ',
    'Already there',
    '',
  ]);

  const progress = [];
  const result = await sendHighlights(connected, device.api, device.io, (...a) => progress.push(a));
  assert.deepEqual(posted, ['42: First highlight', '42: Already there']);
  assert.deepEqual({ sent: result.sent, already: result.already, books: result.books }, { sent: 1, already: 1, books: 1 });
  assert.equal(highlightSummary(result), 'Sent 1 highlights. 1 were already in Instapaper.');
  assert.deepEqual(progress[0], ['Reading highlights...', 0, 0]);

  // A second run sends nothing; sync keeps the record of sent highlights.
  posted.length = 0;
  const { syncArticles } = await loadPlugin();
  await syncArticles(Object.assign({ section: 'home', limit: 5 }, connected), device.api, device.io, () => {});
  const again = await sendHighlights(connected, device.api, device.io, () => {});
  assert.deepEqual(posted, []);
  assert.equal(again.already, 2);
  assert.equal(highlightSummary(again), 'No new highlights. 2 were already in Instapaper.');
});

test('sendHighlights stops at the free monthly limit and on a rejected token', async () => {
  const { sendHighlights, highlightSummary } = await loadPlugin();
  let count = 0;
  const device = fakeDevice({ highlight: () => (++count > 1 ? 403 : 200) });
  device.fetchedOnReader('Article.epub', 42);
  device.sd.set('/.crosspoint/clippings/epub_1.bin', clippingStore('/Instapaper/Article.epub', ['One', 'Two', 'Three']));
  const result = await sendHighlights(connected, device.api, device.io, () => {});
  assert.equal(count, 2, 'stops at the first 403');
  assert.equal(result.sent, 1);
  assert.equal(result.limited, true);
  assert.match(highlightSummary(result), /five highlights a month without Premium/);
  // Next month the rest go, the first is not sent again.
  count = -10;
  const later = await sendHighlights(connected, device.api, device.io, () => {});
  assert.equal(later.sent, 2);

  const rejected = fakeDevice({ highlight: () => 401 });
  rejected.fetchedOnReader('Article.epub', 42);
  rejected.sd.set('/.crosspoint/clippings/epub_1.bin', clippingStore('/Instapaper/Article.epub', ['One']));
  await assert.rejects(sendHighlights(connected, rejected.api, rejected.io, () => {}), /did not accept the access token/);
});

test('converterSettings keeps the address when the converter is off', async () => {
  const { converterSettings } = await loadPlugin();
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(converterSettings({})), { use_worker: false, worker_address: '', worker_url: '' });
  assert.deepEqual(plain(converterSettings({ worker_url: 'https://w' })), { use_worker: true, worker_address: 'https://w', worker_url: 'https://w' });
  assert.deepEqual(plain(converterSettings({ use_worker: false, worker_address: 'https://w', worker_url: '' })), { use_worker: false, worker_address: 'https://w', worker_url: '' });
  assert.deepEqual(plain(converterSettings({ use_worker: true, worker_address: '' })), { use_worker: false, worker_address: '', worker_url: '' });
});

test('normalizeWorkerUrl accepts http(s) addresses only', async () => {
  const { normalizeWorkerUrl } = await loadPlugin();
  assert.equal(normalizeWorkerUrl(' https://a.b.workers.dev/ '), 'https://a.b.workers.dev');
  assert.equal(normalizeWorkerUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeWorkerUrl('a.b.workers.dev'), '');
  assert.equal(normalizeWorkerUrl(''), '');
});

// Runs the Worker's fetch handler with Instapaper replaced by `answer`.
// Minimal image headers, enough for imageInfo(): a JPEG with a SOF marker
// (0xC0 baseline, 0xC2 progressive), a PNG IHDR, and a GIF with one image
// descriptor.
function jpegBytes(width, height, sof = 0xc0) {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, sof, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x02, 0xff, 0xd9,
  ]);
}
function pngBytes(width, height) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function gifBytes(width, height, interlaced) {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0, 0,
    0x21, 0xf9, 0x04, 0, 0, 0, 0, 0x00,
    0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, interlaced ? 0x40 : 0x00, 0x3b,
  ]);
}

// Runs the Worker's fetch handler with the network replaced: Instapaper URLs
// get `answer`; image URLs get `images[url]` ([status, bytes, resized]), and
// cover conversions `images['cover:' + url]`.
async function callWorker(path, headers, answer, images = {}) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization, transform: !!(init.cf && init.cf.image) });
    if (String(url).startsWith('https://www.instapaper.com/')) {
      const [status, body] = answer;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    const isCover = !!(init.cf && init.cf.image && init.cf.image.fit === 'cover');
    const [status, bytes, resized] = (isCover ? images['cover:' + url] : images[url]) || [404, new Uint8Array(0)];
    return new Response(bytes, { status, headers: resized ? { 'cf-resized': 'internal=ok' } : {} });
  };
  try {
    return { response: await worker.fetch(new Request('https://w.example' + path, { headers })), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('worker converts a bookmark to EPUB with the caller token', async () => {
  const parsedBody = {
    metadata: { title: 'Über Brücken', author: { name: 'Ann' }, description: 'D', pubtime: 1705276800 },
    content: { body: '<div><p>Die Brücke über den Fluss war älter als die Stadt.</p><img src="x"></div>', direction: 'ltr' },
  };
  const { response, seen } = await callWorker(
    '/bookmarks/42.epub?lang=de-DE&url=https://news.example.org/a?x=1&lang=fr',
    { Authorization: 'Bearer tok' },
    [200, parsedBody],
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/epub+zip');
  assert.equal(response.headers.get("Content-Disposition"), "attachment; filename=\"_ber Br_cken.epub\"");
  assert.deepEqual(seen[0], { url: 'https://www.instapaper.com/api/2/bookmarks/42/parse', auth: 'Bearer tok', transform: false });
  assert.ok(seen.slice(1).every((s) => s.auth === undefined), 'the token never goes to image hosts');
  const files = readZip(new Uint8Array(await response.arrayBuffer()));
  const opf = files[2].text;
  assert.match(opf, /<dc:title>Über Brücken<\/dc:title>/);
  assert.match(opf, /<dc:creator>Ann<\/dc:creator>/);
  assert.match(opf, /<dc:language>de<\/dc:language>/);
  assert.match(opf, /<dc:source>https:\/\/news\.example\.org\/a\?x=1&amp;lang=fr<\/dc:source>/);

  // The title the web sync sends wins over the page's own.
  const titled = await callWorker(
    '/bookmarks/42.epub?lang=de&title=Br%C3%BCcken%20%26%20Stra%C3%9Fen&url=https://news.example.org/a',
    { Authorization: 'Bearer tok' },
    [200, parsedBody],
  );
  assert.match(readZip(new Uint8Array(await titled.response.arrayBuffer()))[2].text, /<dc:title>Brücken &amp; Straßen<\/dc:title>/);
  assert.match(files[5].text, /<p><i>Ann · news\.example\.org<\/i><\/p><p>Die Brücke/);
  assert.doesNotMatch(files[5].text, /<img/);
});

test('worker reports missing tokens and articles without text', async () => {
  let r = await callWorker('/bookmarks/1.epub', {}, [200, {}]);
  assert.equal(r.response.status, 401);
  assert.equal(r.seen.length, 0, 'no Instapaper call without a token');
  r = await callWorker('/bookmarks/1.epub', { Authorization: 'Bearer tok' }, [400, { error: { code: 400, message: 'Parsed content unavailable' } }]);
  assert.equal(r.response.status, 422);
  assert.match(await r.response.text(), /Parsed content unavailable/);
  r = await callWorker('/bookmarks/1.epub', { Authorization: 'Bearer bad' }, [401, { error: { code: 401, message: 'Authentication failed' } }]);
  assert.equal(r.response.status, 401);
  r = await callWorker('/bookmarks/1.epub', { Authorization: 'Bearer tok' }, [200, { metadata: {}, content: { body: null } }]);
  assert.equal(r.response.status, 422);
  r = await callWorker('/other', { Authorization: 'Bearer tok' }, [200, {}]);
  assert.equal(r.response.status, 404);
  r = await callWorker('/', {}, [200, {}]);
  assert.match(await r.response.text(), /^Articles for Instapaper converter/);
});

test('imageInfo reads formats and sizes the reader can decode', () => {
  assert.deepEqual(imageInfo(jpegBytes(640, 480)), { type: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width: 640, height: 480, progressive: false });
  assert.equal(imageInfo(jpegBytes(640, 480, 0xc2)).progressive, true);
  assert.deepEqual(imageInfo(pngBytes(1200, 900)), { type: 'png', ext: 'png', mime: 'image/png', width: 1200, height: 900 });
  assert.equal(imageInfo(gifBytes(300, 200, false)).interlaced, false);
  assert.equal(imageInfo(gifBytes(300, 200, true)).interlaced, true);
  assert.equal(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(imageInfo(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), null);

  assert.equal(readerCanShow(imageInfo(jpegBytes(800, 600)), 5_000_000), true, 'converted size, any bytes');
  assert.equal(readerCanShow(imageInfo(jpegBytes(2000, 1500, 0xc2)), 2_000_000), false);
  assert.equal(readerCanShow(imageInfo(jpegBytes(2000, 1500, 0xc2)), 300_000), true);
  assert.equal(readerCanShow(imageInfo(pngBytes(5000, 100)), 1000), false, 'too wide for the PNG row buffer');
  assert.equal(readerCanShow(imageInfo(gifBytes(300, 200, true)), 1000), false, 'interlaced GIF');
  assert.equal(readerCanShow(imageInfo(jpegBytes(40, 40)), 1000), false, 'icon');
});

test('fetchImages converts through cf.image and falls back to readable originals', async () => {
  const calls = [];
  const answers = {
    'https://i/converted': { true: [200, jpegBytes(800, 533), true] },
    'https://i/untransformed-jpeg': { true: [200, jpegBytes(1600, 1066)], false: [200, jpegBytes(1600, 1066)] },
    'https://i/svg': { true: [415, new Uint8Array(0)], false: [200, new TextEncoder().encode('<svg/>')] },
    'https://i/big-png': { true: [200, pngBytes(3000, 2000)], false: [200, pngBytes(3000, 2000)] },
  };
  const fakeFetch = async (url, init) => {
    const transform = !!(init.cf && init.cf.image);
    calls.push(url + (transform ? ' (cf.image)' : ''));
    if (transform) assert.deepEqual(init.cf.image, { width: 800, height: 800, fit: 'scale-down', format: 'baseline-jpeg', saturation: 0, quality: 70, sharpen: 1, metadata: 'none', anim: false, background: '#FFFFFF' });
    const [status, bytes, resized] = answers[url][transform] || [404, new Uint8Array(0)];
    return new Response(bytes, { status, headers: resized ? { 'cf-resized': 'internal=ok' } : {} });
  };
  const list = Object.keys(answers).map((url) => ({ url, alt: '' }));
  const { files, stats } = await fetchImages(list, 'https://news.example.org/a', fakeFetch);
  assert.deepEqual(files.map((f) => f && f.ext), ['jpg', 'jpg', null, 'png']);
  assert.deepEqual(stats, { found: 4, kept: 3, converted: 1 });
  assert.ok(!calls.includes('https://i/converted'), 'a converted image is fetched once');
});

test('fetchImages gives up on slow image hosts within its time budget', async () => {
  // A host that never answers; the request ends only when it is aborted.
  const hanging = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const list = Array.from({ length: 20 }, (_, i) => ({ url: 'https://slow/' + i, alt: '' }));
  const started = Date.now();
  const { files, stats } = await fetchImages(list, '', hanging, 300);
  assert.ok(Date.now() - started < 2000, 'returned after ' + (Date.now() - started) + ' ms');
  assert.equal(stats.kept, 0);
  assert.equal(files.length, 20);
});

test('worker embeds converted images in the EPUB', async () => {
  const parsedBody = {
    metadata: { title: 'Pictures', author: null },
    content: { body: '<p>Before <img src="/a.jpg" alt="A &amp; B"> after</p><figure><img src="https://cdn.example/b.svg"><figcaption>Cap</figcaption></figure>', direction: 'ltr' },
  };
  const { response, seen } = await callWorker(
    '/bookmarks/7.epub?lang=en&url=https://news.example.org/story',
    { Authorization: 'Bearer tok' },
    [200, parsedBody],
    {
      'https://news.example.org/a.jpg': [200, jpegBytes(800, 600), true],
      'cover:https://news.example.org/a.jpg': [200, jpegBytes(528, 800), true],
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Images'), '2 found, 1 kept, 1 converted, cover 528x800 converted');
  assert.ok(seen.some((s) => s.url === 'https://news.example.org/a.jpg' && s.transform), 'relative src resolved against the article URL');
  const files = readZip(new Uint8Array(await response.arrayBuffer()));
  const image = files.find((f) => f.name === 'OEBPS/images/1.jpg');
  assert.ok(image, 'image packed');
  assert.equal(image.method, 0, 'images are stored, not deflated');
  // No lead image: the first kept image becomes the cover, converted for it.
  assert.match(files[2].text, /<item id="image1" href="images\/1\.jpg" media-type="image\/jpeg"\/>/);
  assert.match(files[2].text, /<item id="image2" href="images\/cover\.jpg" media-type="image\/jpeg" properties="cover-image"\/>/);
  assert.match(files[2].text, /<meta name="cover" content="image2"\/>/);
  assert.equal(files.find((f) => f.name === 'OEBPS/images/cover.jpg').method, 0, 'cover stored');
  const article = files.find((f) => f.name === 'OEBPS/article.xhtml').text;
  assert.match(article, /<p>Before <img src="images\/1\.jpg" alt="A &amp; B"\/> after<\/p><figcaption>Cap<\/figcaption>/);
  assertWellFormedXml(article, 'article with images');
});

// Runs POST /events/exit with Instapaper replaced by `answers[path]`.
async function exitEvent(body, answers = {}, auth = 'Bearer tok') {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const path = url.replace('https://www.instapaper.com/api/2', '');
    calls.push({ path, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const [status] = answers[path] || [200];
    return new Response('{}', { status });
  };
  const request = new Request('https://w.example/events/exit', {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await readerExit(request, fakeFetch);
  return { status: response.status, json: await response.json(), calls };
}

test('worker uses the lead image as the cover, without putting it in the text', async () => {
  const parsedBody = {
    metadata: { title: 'Lead', thumbnail: 'https://cdn.example/lead.jpg' },
    content: { body: '<p>Text <img src="https://cdn.example/inline.jpg"></p>', direction: 'ltr' },
  };
  const { response, seen } = await callWorker(
    '/bookmarks/8.epub?lang=en&url=https://news.example.org/story',
    { Authorization: 'Bearer tok' },
    [200, parsedBody],
    {
      'https://cdn.example/inline.jpg': [200, jpegBytes(800, 600), true],
      'cover:https://cdn.example/lead.jpg': [200, jpegBytes(528, 800), true],
    },
  );
  assert.equal(response.headers.get('X-Images'), '1 found, 1 kept, 1 converted, cover 528x800 converted');
  assert.ok(seen.some((s) => s.url === 'https://cdn.example/lead.jpg' && s.transform));
  const files = readZip(new Uint8Array(await response.arrayBuffer()));
  const opf = files[2].text;
  assert.match(opf, /<item id="image1" href="images\/1\.jpg" media-type="image\/jpeg"\/>/);
  assert.match(opf, /<item id="image2" href="images\/cover\.jpg" media-type="image\/jpeg" properties="cover-image"\/>/);
  assert.match(opf, /<meta name="cover" content="image2"\/>/);
  const article = files.find((f) => f.name === 'OEBPS/article.xhtml').text;
  assert.match(article, /images\/1\.jpg/);
  assert.doesNotMatch(article, /cover\.jpg/, 'the cover is not repeated in the text');

  // No images at all: no cover.
  const plain = await callWorker('/bookmarks/9.epub?lang=en&url=https://n.example/x', { Authorization: 'Bearer tok' }, [
    200,
    { metadata: { title: 'Plain' }, content: { body: '<p>Only text</p>' } },
  ]);
  assert.equal(plain.response.headers.get('X-Images'), '0 found, 0 kept, 0 converted, no cover');
  assert.doesNotMatch(readZip(new Uint8Array(await plain.response.arrayBuffer()))[2].text, /cover/);
});

test('fetchCover sizes the cover for the reader screen, or keeps a usable original', async () => {
  assert.deepEqual(
    { width: COVER_TRANSFORM.width, height: COVER_TRANSFORM.height, fit: COVER_TRANSFORM.fit, format: COVER_TRANSFORM.format, saturation: COVER_TRANSFORM.saturation },
    { width: 528, height: 800, fit: 'cover', format: 'baseline-jpeg', saturation: 0 },
  );
  const answer = (converted, original) => async (url, init) => {
    const [status, bytes, resized] = init.cf ? converted : original;
    return new Response(bytes, { status, headers: resized ? { 'cf-resized': 'internal=ok' } : {} });
  };
  let cover = await fetchCover('https://i/c', '', answer([200, jpegBytes(528, 800), true], [500, new Uint8Array(0)]));
  assert.deepEqual({ w: cover.width, h: cover.height, resized: cover.resized, ext: cover.ext }, { w: 528, h: 800, resized: true, ext: 'jpg' });

  // Not converted (local dev, quota used): a baseline JPEG within 2048 x 3072 is kept.
  cover = await fetchCover('https://i/c', '', answer([415, new Uint8Array(0)], [200, jpegBytes(1200, 900)]));
  assert.deepEqual({ w: cover.width, resized: cover.resized }, { w: 1200, resized: false });
  // Progressive, too large, or not a JPEG: no cover.
  assert.equal(await fetchCover('https://i/c', '', answer([415, new Uint8Array(0)], [200, jpegBytes(1200, 900, 0xc2)])), null);
  assert.equal(await fetchCover('https://i/c', '', answer([415, new Uint8Array(0)], [200, jpegBytes(3000, 2000)])), null);
  assert.equal(await fetchCover('https://i/c', '', answer([415, new Uint8Array(0)], [200, pngBytes(600, 800)])), null);
  // An unconverted answer to the conversion request is not taken as converted.
  cover = await fetchCover('https://i/c', '', answer([200, jpegBytes(1600, 1200)], [200, jpegBytes(1600, 1200)]));
  assert.equal(cover.resized, false);
});

test('reader.exit sends progress and archives articles left on the end page', async () => {
  let r = await exitEvent({ instapaper_id: '42', percent: '40', ts: '1761400000' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls, [{ path: '/bookmarks/42', auth: 'Bearer tok', body: { progress: { percentage: 0.4, timestamp: 1761400000 } } }]);
  assert.deepEqual(r.json, { id: 42, percent: 40, progress: true, archived: false });

  r = await exitEvent({ instapaper_id: '42', percent: '99', ts: '1761400000' });
  assert.equal(r.json.archived, false, 'the last article page is not the end page');

  r = await exitEvent({ instapaper_id: '42', percent: '100', ts: '0' });
  assert.deepEqual(r.calls.map((c) => c.path), ['/bookmarks/42', '/bookmarks/42/move']);
  assert.deepEqual(r.calls[1].body, { section: 'archive' });
  assert.equal(r.json.archived, true);
  assert.ok(r.calls[0].body.progress.timestamp > 1700000000, 'clock not set: the Worker uses its own time');

  r = await exitEvent({ instapaper_id: '42', percent: '0', ts: '1761400000' });
  assert.equal(r.calls.length, 0, 'leaving at the start does not reset progress');
});

test('the end page starts at 100% the way the reader computes progress', async () => {
  const { buildEpub, articleContent } = epub;
  for (const words of [3, 400, 20000]) {
    const body = '<p>' + 'word '.repeat(words) + '</p>';
    const files = readZip(await buildEpub(sampleArticle, articleContent(parseHtml(body), 'x', 'en'), 0));
    const size = (name) => new TextEncoder().encode(files.find((f) => f.name === name).text).length;
    const article = size('OEBPS/article.xhtml');
    const end = size('OEBPS/end.xhtml');
    // Epub::calculateProgress at the top of the end page, rounded like
    // EpubReaderActivity::getScreenshotInfo.
    assert.equal(Math.floor((article / (article + end)) * 100 + 0.5), 100, words + ' words');
    assert.match(files.find((f) => f.name === 'OEBPS/end.xhtml').text, /End of article/);
    assertWellFormedXml(files.find((f) => f.name === 'OEBPS/article.xhtml').text, 'padded article');
  }
  const opf = readZip(await buildEpub(sampleArticle, articleContent(parseHtml('<p>x</p>'), 'x', 'en'), 0))[2].text;
  assert.match(opf, /<itemref idref="article"\/><itemref idref="end"\/><\/spine>/);
});

test('reader.exit drops what can never succeed and retries what may', async () => {
  for (const body of [
    { instapaper_id: '{meta.instapaper_id}', percent: '50' },
    { instapaper_id: '', percent: '50' },
    { instapaper_id: '42', percent: '{event.percent}' },
    'not json',
  ]) {
    const r = await exitEvent(body);
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.ok(r.json.ignored);
    assert.equal(r.calls.length, 0);
  }
  const gone = await exitEvent({ instapaper_id: '42', percent: '50' }, { '/bookmarks/42': [404] });
  assert.equal(gone.status, 200, 'a deleted bookmark is dropped');
  assert.equal((await exitEvent({ instapaper_id: '42', percent: '50' }, { '/bookmarks/42': [401] })).status, 401);
  assert.equal((await exitEvent({ instapaper_id: '42', percent: '100' }, { '/bookmarks/42/move': [500] })).status, 503);
  assert.equal((await exitEvent({ instapaper_id: '42', percent: '50' }, {}, '')).status, 401);
});

test('withExitEvents adds and removes the reader.exit handler', async () => {
  const { withExitEvents } = await loadPlugin();
  const manifest = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  assert.equal(manifest.events, undefined, 'shipped without event handlers');
  const on = JSON.parse(JSON.stringify(withExitEvents(manifest, true)));
  assert.deepEqual(Object.keys(on.events), ['reader.exit']);
  const request = on.events['reader.exit'].request;
  assert.equal(request.url, '{cfg.worker_url}/events/exit');
  assert.equal(request.headers.Authorization, 'Bearer {token}');
  assert.equal(on.events['reader.exit'].connect, undefined, 'sent on the next Wi-Fi connection, not at sleep');
  // The body stays valid JSON whatever the reader substitutes.
  const filled = request.body.replace('{meta.instapaper_id}', '42').replace('{event.percent}', '97').replace('{event.ts}', '1761400000');
  assert.deepEqual(JSON.parse(filled), { instapaper_id: '42', percent: '97', ts: '1761400000' });
  assert.ok(JSON.parse(request.body), 'unfilled variables keep the body valid');
  assert.deepEqual(JSON.parse(JSON.stringify(withExitEvents(on, false))), manifest);
});

test('worker /lists answers the reader with Home, Archive, Liked and your folders', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (init.headers.Authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ folders: [{ id: 2358617, title: 'Bitcoin', count: 0 }, { id: 2358619, title: 'Economics & more', count: 1 }] }));
  };
  const call = (path, headers = {}) => folderLists(new Request('https://w.example' + path, { headers }), fakeFetch);

  const r = await call('/lists?token=tok');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ url: 'https://www.instapaper.com/api/2/folders', auth: 'Bearer tok' }]);
  const { lists } = await r.json();
  assert.deepEqual(
    lists.map((l) => l.title + ' -> ' + l.url.replace('https://www.instapaper.com/api/2/bookmarks?', '')),
    [
      'Home -> section=home&limit=100',
      'Archive -> section=archive&limit=100',
      'Liked -> section=liked&limit=100',
      'Bitcoin -> folder_id=2358617&limit=100',
      'Economics & more -> folder_id=2358619&limit=100',
    ],
  );
  assert.equal((await call('/lists', { Authorization: 'Bearer tok' })).status, 200, 'a header works too');
  assert.equal((await call('/lists')).status, 401);
  assert.equal((await call('/lists?token=bad')).status, 401);
  const routed = await worker.fetch(new Request('https://w.example/lists', { method: 'POST' }));
  assert.equal(routed.status, 405);
});

test('manifestFor switches the reader lists and events with the converter', async () => {
  const { manifestFor } = await loadPlugin();
  const shipped = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(manifestFor(shipped, {})), shipped, 'the shipped file matches the default settings');

  const converter = { use_worker: true, worker_address: 'https://w', worker_url: 'https://w' };
  const on = plain(manifestFor(shipped, converter));
  assert.equal(on.browse.lists, undefined);
  assert.equal(on.browse.lists_url, '{cfg.worker_url}/lists?token={token}');
  assert.equal(on.browse.url, shipped.browse.url);
  assert.equal(on.events, undefined, 'archiving is a separate switch');

  const archiving = plain(manifestFor(shipped, Object.assign({ archive: true }, converter)));
  assert.ok(archiving.events['reader.exit']);
  assert.deepEqual(plain(manifestFor(archiving, { use_worker: false, worker_address: 'https://w', archive: true })), shipped, 'converter off: back to the shipped file');
  assert.equal(manifestFor(shipped, { archive: true }).events, undefined, 'archiving needs the converter');
});

test('device.json lists Instapaper on the reader and downloads through the worker', async () => {
  const manifest = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  const plugin = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.version, plugin.version);
  assert.deepEqual(manifest.token, { file: 'config.json', path: 'token' });
  assert.deepEqual(manifest.config, { file: 'config.json' });
  assert.equal(manifest.browse.headers.Authorization, 'Bearer {token}');
  assert.equal(manifest.browse.items, 'bookmarks');
  // No {page}: the reader fetches the list once and pages it locally.
  assert.equal(manifest.browse.url, 'https://www.instapaper.com/api/2/bookmarks?section=home&limit=100');
  // Shipped for use without the converter: lists straight from Instapaper.
  assert.deepEqual(manifest.browse.lists.map((l) => l.title), ['Home', 'Archive', 'Liked']);
  for (const l of manifest.browse.lists.filter((l) => l.url)) {
    assert.match(l.url, /^https:\/\/www\.instapaper\.com\/api\/2\/bookmarks\?section=(archive|liked)&limit=100$/);
  }
  assert.equal(manifest.browse.lists_url, undefined);
  // url must stay last: the worker reads it raw to the end of the query.
  assert.equal(manifest.download.url, '{cfg.worker_url}/bookmarks/{id}.epub?lang={cfg.lang}&url={url}');
  assert.equal(manifest.download.headers.Authorization, 'Bearer {token}');
  assert.equal(manifest.download.filename, '{title}.epub');
  assert.deepEqual(manifest.download.sidecar, { path: '{dest}.meta.json', body: '{"instapaper_id":"{id}"}' });
});

test('the installed files are the current minified build of src/', async () => {
  const built = await buildFiles();
  for (const [name, code] of Object.entries(built)) {
    const installed = await readFile(new URL(name, root), 'utf8');
    assert.equal(installed, code, name + ' is stale: run npm run build');
    assert.ok(code.length < 0.6 * (await readFile(new URL('../src/' + name, import.meta.url), 'utf8')).length, name + ' is minified');
  }
});

test('the minified files work like the sources', async () => {
  // plugin.js registers its card and exposes the same functions.
  const minified = await loadPlugin(true);
  const source = await loadPlugin();
  assert.deepEqual(Object.keys(minified).sort(), Object.keys(source).sort());
  const manifest = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(minified.manifestFor(manifest, { use_worker: true, worker_address: 'https://w', archive: true }))),
    JSON.parse(JSON.stringify(source.manifestFor(manifest, { use_worker: true, worker_address: 'https://w', archive: true }))),
  );
  // epub.js keeps its exports; a whole sync runs on the minified pair.
  const builtEpub = await import(new URL('epub.js', root));
  assert.deepEqual(Object.keys(builtEpub).sort(), Object.keys(epub).sort());
  assert.equal(builtEpub.readerFileName('First: story'), 'First_ story.epub');
  const device = fakeDevice({ bookmarks: [bookmark(1, 'One')], parses: { 1: parsed('<p>One <em>two</em></p>') } });
  device.io.loadEpub = async () => builtEpub;
  const result = await minified.syncArticles(Object.assign({ section: 'home', limit: 5 }, connected), device.api, device.io, () => {});
  assert.deepEqual(Array.from(result.added), ['One']);
  const files = readZip(device.sd.get('/Instapaper/One.epub'));
  assert.match(files.find((f) => f.name === 'OEBPS/article.xhtml').text, /<p>One <em>two<\/em><\/p>/);
});

test('manifest meets the Plugin Hub contract', async () => {
  // PLUGIN_HUB_CONTRACT.md: one <id>.crosspoint-plugin/ payload whose stem is
  // manifest.name, a MAJOR.MINOR.PATCH version matching the release tag, and
  // every declared runtime file present.
  const { readdir } = await import('node:fs/promises');
  const repo = new URL('../', import.meta.url);
  const payloads = (await readdir(repo)).filter((n) => n.endsWith('.crosspoint-plugin'));
  assert.deepEqual(payloads, ['instapaper.crosspoint-plugin']);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.name, 'instapaper');
  assert.match(manifest.name, /^[a-z0-9-]+$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.mount, 'settings');
  const present = await readdir(root);
  for (const file of manifest.files) assert.ok(present.includes(file), file + ' is declared and present');
  for (const file of ['epub.js', 'device.json', 'plugin.js']) assert.ok(manifest.files.includes(file), file + ' is installed');
  const device = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(device.version, manifest.version);
  assert.equal(pkg.version, manifest.version);
  assert.equal(device.title, manifest.title);
});
