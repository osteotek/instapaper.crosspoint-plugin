import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { inflateRawSync, crc32 } from 'node:zlib';
import { JSDOM } from 'jsdom';
import * as epub from '../instapaper/epub.js';
import worker from '../worker/index.js';
import { fetchImages, imageInfo, readerCanShow } from '../worker/images.js';
import { readerExit } from '../worker/events.js';

const root = new URL('../instapaper/', import.meta.url);
const parseHtml = (html) => new JSDOM(html).window.document;

async function loadPlugin() {
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
  vm.runInContext(await readFile(new URL('plugin.js', root), 'utf8'), context, { filename: 'plugin.js' });
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

test('fileBaseName makes FAT-safe names', async () => {
  const { fileBaseName } = epub;
  assert.equal(fileBaseName('a/b: c?  d.', 7), 'a b c d');
  assert.equal(fileBaseName('   ', 7), 'Article 7');
  assert.equal(fileBaseName('x'.repeat(100), 7).length, 60);
  assert.equal(Array.from(fileBaseName('😀'.repeat(70), 7)).length, 60);
});

test('clampLimit falls back to 10 and caps at 50', async () => {
  const { clampLimit } = await loadPlugin();
  assert.equal(clampLimit('abc'), 10);
  assert.equal(clampLimit(0), 10);
  assert.equal(clampLimit(5.7), 5);
  assert.equal(clampLimit(500), 50);
});

// Fake Instapaper v2 and device: /api/fetch writes responses into an SD card
// in a Map and fails on non-2xx like the firmware; the relay returns them.
// `worker` maps bookmark IDs to the converter's answer: [status, body].
function fakeDevice({ bookmarks = [], parses = {}, folders = [], worker = {} } = {}) {
  const sd = new Map();
  const calls = [];
  const deleted = [];
  const respond = (url, headers) => {
    assert.equal(headers.Authorization, 'Bearer tok');
    if (url.startsWith('https://w.example/')) {
      calls.push(url.slice('https://w.example'.length));
      const id = /^https:\/\/w\.example\/bookmarks\/(\d+)\.epub\?/.exec(url)[1];
      const [status, body] = worker[id] || [404, 'Not found.'];
      return { status, headers: [], body };
    }
    const u = new URL(url);
    assert.equal(u.origin, 'https://www.instapaper.com');
    assert.ok(u.pathname.startsWith('/api/2/'));
    const path = u.pathname.slice(6);
    calls.push(path + u.search);
    const json = (value, status = 200) => ({ status, headers: [], body: JSON.stringify(value) });
    if (path === '/me') return json({ id: 5, username: 'reader@example.com', premium: false });
    if (path === '/folders') return json({ folders });
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
      assert.equal(method, 'GET');
      return respond(url, headers);
    },
    async fetchToSd(url, dest, headers) {
      const r = respond(url, headers);
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
    async deleteFile(path) {
      deleted.push(path);
      sd.delete(path);
    },
    epub,
    parseHtml,
    language: 'en',
    now: () => Date.UTC(2026, 9, 25),
  };
  return { api, io, sd, calls, deleted };
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

test('syncArticles downloads new articles, skips what has no text and removes gone ones', async () => {
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
  const cfg = Object.assign({ section: 'folder:9', limit: 20, remove_gone: true }, connected);
  const result = await syncArticles(cfg, device.api, device.io, () => {});

  assert.deepEqual(Array.from(result.added), ['First: story', 'First/ story']);
  assert.deepEqual(
    Array.from(result.skipped, (s) => s.title + ': ' + s.reason),
    ['A PDF: it is a PDF', 'Broken: Instapaper has no text for it', 'Empty: Instapaper has no text for it'],
  );
  assert.equal(device.calls[0], '/bookmarks?folder_id=9&limit=20');
  assert.ok(!device.calls.includes('/bookmarks/2/parse'), 'a PDF is not fetched');
  const first = readZip(device.sd.get('/Instapaper/First story.epub'));
  assert.deepEqual(await device.io.readJson('/Instapaper/First story.epub.meta.json'), { instapaper_id: '1' });
  assert.match(first[2].text, /<dc:creator>Ann<\/dc:creator>/);
  assert.ok(device.sd.has('/Instapaper/First story (4).epub'));
  assert.ok(device.deleted.includes('/plugins/instapaper/download.json'));
  assert.ok(!device.sd.has('/plugins/instapaper/download.json'));
  assert.match(summary(result), /^Added 2 articles\. Skipped "A PDF": it is a PDF\./);

  // Second run: 1 left the folder. 4 came from another section, so it stays.
  const state = await device.io.readJson('/plugins/instapaper/state.json');
  state.articles[4].section = 'home';
  await device.api.writeFile('/plugins/instapaper/state.json', btoa(JSON.stringify(state)));
  device.calls.length = 0;
  device.deleted.length = 0;
  const second = fakeDevice({ bookmarks: [bookmark(6, 'New')], parses: { 6: parsed('<p>Six</p>') } });
  Object.assign(second.api, { writeFile: device.api.writeFile });
  Object.assign(second.io, { readJson: device.io.readJson, deleteFile: device.io.deleteFile });
  second.api.fetchToSd = async (url, dest, headers) => {
    const r = await second.api.relay('GET', url, headers);
    device.sd.set(dest, new TextEncoder().encode(r.body));
    return { complete: true };
  };
  const again = await syncArticles(cfg, second.api, second.io, () => {});
  assert.deepEqual(Array.from(again.added), ['New']);
  assert.equal(again.removed, 1);
  assert.deepEqual(Array.from(device.deleted), [
    '/Instapaper/First story.epub',
    '/Instapaper/First story.epub.meta.json',
    '/plugins/instapaper/download.json',
  ]);
  const after = await device.io.readJson('/plugins/instapaper/state.json');
  assert.deepEqual(Array.from(Object.keys(after.articles)).sort(), ['4', '6']);
});

test('syncArticles skips articles already on the card and keeps files when removal is off', async () => {
  const { syncArticles } = await loadPlugin();
  const device = fakeDevice({ bookmarks: [bookmark(1, 'A')], parses: { 1: parsed('<p>A</p>') } });
  const cfg = Object.assign({ section: 'home', limit: 5, remove_gone: false }, connected);
  await syncArticles(cfg, device.api, device.io, () => {});
  device.calls.length = 0;
  const again = await syncArticles(cfg, device.api, device.io, () => {});
  assert.equal(again.added.length, 0);
  assert.deepEqual(Array.from(device.calls), ['/bookmarks?section=home&limit=5']);

  const gone = fakeDevice({ bookmarks: [] });
  Object.assign(gone.api, { writeFile: device.api.writeFile });
  Object.assign(gone.io, { readJson: device.io.readJson });
  gone.api.fetchToSd = async (url, dest) => {
    device.sd.set(dest, new TextEncoder().encode('{"bookmarks":[],"total":0}'));
    return { complete: true };
  };
  const result = await syncArticles(cfg, gone.api, gone.io, () => {});
  assert.equal(result.removed, 0);
  assert.ok(device.sd.has('/Instapaper/A.epub'));
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
  assert.ok(device.calls.includes('/bookmarks/1.epub?lang=de&url=https://news.example.org/a?x=1&y=2'), 'url last and raw');
  assert.ok(!device.calls.some((c) => c.endsWith('/parse')), 'the page does not parse when the converter is on');
  assert.match(summary(result), /Skipped "No text": Instapaper has no text for it\. Skipped "Broken": the converter answered HTTP 502: Conversion failed: boom\. Skipped "A PDF"/);

  const rejected = fakeDevice({ bookmarks: [bookmark(1, 'A'), bookmark(2, 'B')], worker: { 1: [401, 'Instapaper answered HTTP 401.'] } });
  await assert.rejects(syncArticles(cfg, rejected.api, rejected.io, () => {}), /did not accept the access token/);
  assert.ok(!rejected.calls.some((c) => c.startsWith('/bookmarks/2.epub')), 'a rejected token stops the sync');
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
// get `answer`; image URLs get `images[url]` ([status, bytes, resized]).
async function callWorker(path, headers, answer, images = {}) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization, transform: !!(init.cf && init.cf.image) });
    if (String(url).startsWith('https://www.instapaper.com/')) {
      const [status, body] = answer;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    const [status, bytes, resized] = images[url] || [404, new Uint8Array(0)];
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

test('worker embeds converted images in the EPUB', async () => {
  const parsedBody = {
    metadata: { title: 'Pictures', author: null },
    content: { body: '<p>Before <img src="/a.jpg" alt="A &amp; B"> after</p><figure><img src="https://cdn.example/b.svg"><figcaption>Cap</figcaption></figure>', direction: 'ltr' },
  };
  const { response, seen } = await callWorker(
    '/bookmarks/7.epub?lang=en&url=https://news.example.org/story',
    { Authorization: 'Bearer tok' },
    [200, parsedBody],
    { 'https://news.example.org/a.jpg': [200, jpegBytes(800, 600), true] },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Images'), '2 found, 1 kept, 1 converted');
  assert.ok(seen.some((s) => s.url === 'https://news.example.org/a.jpg' && s.transform), 'relative src resolved against the article URL');
  const files = readZip(new Uint8Array(await response.arrayBuffer()));
  const image = files.find((f) => f.name === 'OEBPS/images/1.jpg');
  assert.ok(image, 'image packed');
  assert.equal(image.method, 0, 'images are stored, not deflated');
  assert.match(files[2].text, /<item id="image1" href="images\/1\.jpg" media-type="image\/jpeg"\/>/);
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

test('device.json lists Instapaper on the reader and downloads through the worker', async () => {
  const manifest = JSON.parse(await readFile(new URL('device.json', root), 'utf8'));
  const plugin = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.version, plugin.version);
  assert.deepEqual(manifest.token, { file: 'config.json', path: 'token' });
  assert.deepEqual(manifest.config, { file: 'config.json' });
  assert.equal(manifest.browse.headers.Authorization, 'Bearer {token}');
  assert.equal(manifest.browse.items, 'bookmarks');
  // No {page}: the reader fetches the list once and pages it locally.
  for (const url of [manifest.browse.url].concat(manifest.browse.lists.map((l) => l.url).filter(Boolean))) {
    assert.match(url, /^https:\/\/www\.instapaper\.com\/api\/2\/bookmarks\?section=(home|archive|liked)&limit=100$/);
  }
  assert.deepEqual(manifest.browse.lists.map((l) => l.title), ['Home', 'Archive', 'Liked']);
  // url must stay last: the worker reads it raw to the end of the query.
  assert.equal(manifest.download.url, '{cfg.worker_url}/bookmarks/{id}.epub?lang={cfg.lang}&url={url}');
  assert.equal(manifest.download.headers.Authorization, 'Bearer {token}');
  assert.equal(manifest.download.filename, '{title}.epub');
  assert.deepEqual(manifest.download.sidecar, { path: '{dest}.meta.json', body: '{"instapaper_id":"{id}"}' });
});

test('manifest and package agree', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['description', 'mount', 'title', 'version']);
  assert.equal(manifest.mount, 'settings');
});
