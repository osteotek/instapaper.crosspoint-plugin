// Articles for Instapaper: download saved Instapaper articles as EPUB.
//
// Uses Instapaper API v2 with a personal access token: each user registers
// their own Instapaper application and generates a token for their own
// account. The article text endpoint is free for that "personal use" case.
//
// The card stores the token, and optionally a converter Worker's address, in
// config.json. device.json reads the same file, so with a converter the
// reader can list and download articles on its own.
//
// Sync lists one Instapaper section or folder and saves each new article to
// DEST_DIR. With a converter, the reader downloads the finished EPUB, images
// included, from the Worker. Without one, the page fetches the parsed text
// and builds a text-only EPUB itself (epub.js). Downloads go to the SD card
// through /api/fetch, because the relay holds a response in the reader's RAM
// and refuses anything over 32 KB.
(function () {
  const API_BASE = 'https://www.instapaper.com/api/2';
  const DEST_DIR = '/Instapaper';
  const DEFAULT_LIMIT = 10;
  const MAX_LIMIT = 50;
  // /api/plugin-fs accepts at most 256 KB per file; converter downloads go
  // through /api/fetch, which has no limit.
  const MAX_EPUB_BYTES = 256 * 1024;
  const SECTIONS = [
    { id: 'home', title: 'Home' },
    { id: 'archive', title: 'Archive' },
    { id: 'liked', title: 'Liked' },
  ];
  // Bookmark categories without text to read.
  const NO_TEXT_CATEGORIES = { 2: 'a video', 3: 'a PDF' };

  const utf8Encoder = new TextEncoder();

  // A converter address without a trailing slash, or '' when it is not one.
  function normalizeWorkerUrl(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[^/\s]+(\/\S*)?$/.test(url) ? url : '';
  }

  // GET / on the Worker answers with this text.
  const WORKER_BANNER = 'Articles for Instapaper converter';

  // config.json: `use_worker` is the switch, `worker_address` the address the
  // user entered, and `worker_url` the address in use ('' when off). The
  // reader's device.json reads `worker_url`. Older configs only had
  // `worker_url`.
  function converterSettings(cfg) {
    const address = cfg.worker_address || cfg.worker_url || '';
    const use = cfg.use_worker === undefined ? !!cfg.worker_url : !!cfg.use_worker;
    return { use_worker: use && !!address, worker_address: address, worker_url: use ? address : '' };
  }

  // Progress and archiving: the reader queues a reader.exit event for every
  // book it leaves and sends it on its next Wi-Fi connection; the converter
  // drops events for other books, and archives an article left on its "End
  // of article" page (worker/events.js). The handler lives in device.json
  // only while the option is on, because the firmware keeps retrying events
  // it cannot deliver. It reads the article ID from the book's sidecar,
  // written at download time.
  const EXIT_HANDLER = {
    request: {
      method: 'POST',
      url: '{cfg.worker_url}/events/exit',
      headers: { Authorization: 'Bearer {token}', 'Content-Type': 'application/json' },
      body: '{"instapaper_id":"{meta.instapaper_id}","percent":"{event.percent}","ts":"{event.ts}"}',
    },
  };

  // `manifest` with the reader.exit handler added or removed.
  function withExitEvents(manifest, enabled) {
    const out = Object.assign({}, manifest);
    if (enabled) out.events = { 'reader.exit': EXIT_HANDLER };
    else delete out.events;
    return out;
  }

  // The reader's list picker. Without the converter it lists Home, Archive
  // and Liked straight from Instapaper. With it, the converter's /lists adds
  // your folders (worker/lists.js); the reader fetches browse.lists_url
  // without headers, hence the token in the query. The reader only loads
  // lists_url when browse.lists is empty, so it is one or the other.
  const DIRECT_LISTS = [
    { title: 'Home' },
    { title: 'Archive', url: API_BASE + '/bookmarks?section=archive&limit=100' },
    { title: 'Liked', url: API_BASE + '/bookmarks?section=liked&limit=100' },
  ];
  const WORKER_LISTS_URL = '{cfg.worker_url}/lists?token={token}';

  function withListSource(manifest, useWorker) {
    const browse = Object.assign({}, manifest.browse);
    delete browse.lists;
    delete browse.lists_url;
    if (useWorker) browse.lists_url = WORKER_LISTS_URL;
    else browse.lists = DIRECT_LISTS;
    return Object.assign({}, manifest, { browse });
  }

  // device.json as the saved settings need it.
  function manifestFor(manifest, cfg) {
    const converter = converterSettings(cfg);
    return withExitEvents(withListSource(manifest, converter.use_worker), converter.use_worker && !!cfg.archive);
  }

  // The article's ID next to the book ("<book>.meta.json"), for the event.
  function sidecarFor(file, bookmarkId) {
    return [file + '.meta.json', bytesToBase64(utf8Encoder.encode(JSON.stringify({ instapaper_id: String(bookmarkId) })))];
  }

  // The same request the reader's device.json download makes. `url` stays
  // last and unencoded: the Worker reads it raw to the end of the query.
  function workerArticleUrl(cfg, bookmark) {
    return (
      cfg.worker_url +
      '/bookmarks/' +
      bookmark.id +
      '.epub?lang=' +
      encodeURIComponent(cfg.lang || 'en') +
      '&url=' +
      (bookmark.url || '')
    );
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // --- Instapaper API -----------------------------------------------------------

  function authHeaders(cfg) {
    return { Authorization: 'Bearer ' + cfg.token };
  }

  function sectionQuery(section) {
    return section.indexOf('folder:') === 0
      ? 'folder_id=' + encodeURIComponent(section.slice(7))
      : 'section=' + encodeURIComponent(section);
  }

  function apiError(status, body) {
    let message = '';
    try {
      message = JSON.parse(body).error.message || '';
    } catch (e) {}
    let text;
    if (status === 401) text = 'Instapaper did not accept the access token';
    else if (status === 403) text = 'Instapaper refused: ' + (message || 'not allowed');
    else if (status === 429) text = 'Instapaper rate limit reached, try again later';
    else text = 'Instapaper answered HTTP ' + status + (message ? ': ' + message : '');
    const err = new Error(text);
    err.status = status;
    return err;
  }

  // Small responses (account, folders) come back through the relay.
  async function relayJson(api, cfg, path) {
    const r = await api.relay('GET', API_BASE + path, authHeaders(cfg), '');
    if (r.status !== 200) throw apiError(r.status, r.body);
    return JSON.parse(r.body);
  }

  // Large responses go to `tmpPath` on the SD card first. /api/fetch reports a
  // failed request without its body, so on failure the same request is sent
  // through the relay to learn the status; error bodies are small.
  async function fetchJson(api, cfg, io, path, tmpPath) {
    try {
      await api.fetchToSd(API_BASE + path, tmpPath, authHeaders(cfg));
    } catch (fetchError) {
      let r;
      try {
        r = await api.relay('GET', API_BASE + path, authHeaders(cfg), '');
      } catch (e) {
        throw fetchError;
      }
      throw r.status !== 200 ? apiError(r.status, r.body) : fetchError;
    }
    const value = await io.readJson(tmpPath);
    if (!value) throw new Error('could not read the download back from the SD card');
    return value;
  }

  async function account(api, cfg) {
    return relayJson(api, cfg, '/me');
  }

  async function listSections(api, cfg) {
    const { folders } = await relayJson(api, cfg, '/folders');
    return SECTIONS.concat((folders || []).map((f) => ({ id: 'folder:' + f.id, title: f.title })));
  }

  // --- Sync ----------------------------------------------------------------------------

  function clampLimit(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
  }

  // Each returns '' when the article is saved, a reason to skip it, or throws.

  // Builds a text-only EPUB in the page from Instapaper's parsed text.
  async function saveInPage(api, cfg, io, bookmark, file, tmpPath) {
    const { articleContent, articleDocumentHtml, articleFromParse, buildEpub } = io.epub;
    let parsed;
    try {
      parsed = await fetchJson(api, cfg, io, '/bookmarks/' + bookmark.id + '/parse', tmpPath);
    } catch (e) {
      if (e.status === 400) return 'Instapaper has no text for it';
      throw e;
    }
    if (!(parsed.content && parsed.content.body)) return 'Instapaper has no text for it';
    const article = articleFromParse(bookmark, parsed);
    const content = articleContent(io.parseHtml(articleDocumentHtml(parsed.content.body)), article.title, io.language);
    const epub = await buildEpub(article, content, io.now());
    if (epub.length > MAX_EPUB_BYTES) {
      return 'too large to save without the converter (' + Math.round(epub.length / 1024) + ' KB)';
    }
    await api.writeFile(file, bytesToBase64(epub));
    return '';
  }

  // Has the reader download the EPUB, images included, from the converter.
  // /api/fetch reports a failure without its body, so the request is repeated
  // through the relay to learn why; the Worker's error answers are short.
  async function saveWithWorker(api, cfg, bookmark, file) {
    const url = workerArticleUrl(cfg, bookmark);
    try {
      await api.fetchToSd(url, file, authHeaders(cfg));
      return '';
    } catch (fetchError) {
      let r;
      try {
        r = await api.relay('GET', url, authHeaders(cfg), '');
      } catch (e) {
        throw fetchError;
      }
      if (r.status === 200) throw fetchError;
      if (r.status === 422) return 'Instapaper has no text for it';
      if (r.status === 401 || r.status === 403 || r.status === 429) throw apiError(r.status, '');
      const err = new Error('the converter answered HTTP ' + r.status + (r.body ? ': ' + r.body.trim().slice(0, 120) : ''));
      err.status = r.status;
      throw err;
    }
  }

  // `report(text, done, total)` follows the sync: `done` of `total` articles
  // handled so far; total is 0 while the list is loading.
  // `io` supplies the browser parts, so tests can run this in Node:
  //   epub (the epub.js module), readJson(path) -> object or null,
  //   deleteFile(path), parseHtml(html) -> Document, language, now() -> ms.
  // `state.articles` maps bookmark ID to {file, section} for every EPUB this
  // plugin wrote. It is saved after each change, so an interrupted sync keeps
  // what it finished.
  async function syncArticles(cfg, api, io, report) {
    const { fileBaseName, normalizeSpace } = io.epub;
    const section = cfg.section || 'home';
    const statePath = api.dir + '/state.json';
    const tmpPath = api.dir + '/download.json';
    const state = (await io.readJson(statePath)) || {};
    const articles = state.articles || {};
    const saveState = () => api.writeFile(statePath, bytesToBase64(utf8Encoder.encode(JSON.stringify({ articles }))));
    const result = { added: [], skipped: [], removed: 0 };

    try {
      report('Listing articles...', 0, 0);
      const listing = await fetchJson(api, cfg, io, '/bookmarks?' + sectionQuery(section) + '&limit=' + clampLimit(cfg.limit), tmpPath);
      const bookmarks = listing.bookmarks || [];
      const fresh = bookmarks.filter((b) => !articles[b.id]);
      const usedNames = new Set(Object.values(articles).map((a) => a.file.toLowerCase()));

      const counts = () =>
        result.added.length || result.skipped.length
          ? ' (' + result.added.length + ' added, ' + result.skipped.length + ' skipped)'
          : '';
      if (!fresh.length) report('No new articles.', 1, 1);
      for (let i = 0; i < fresh.length; i++) {
        const bookmark = fresh[i];
        const title = normalizeSpace(bookmark.title) || 'Article ' + bookmark.id;
        if (NO_TEXT_CATEGORIES[bookmark.category]) {
          result.skipped.push({ title, reason: 'it is ' + NO_TEXT_CATEGORIES[bookmark.category] });
          report('Skipped ' + (i + 1) + ' of ' + fresh.length + counts() + ': ' + title, i + 1, fresh.length);
          continue;
        }
        report('Downloading ' + (i + 1) + ' of ' + fresh.length + counts() + ': ' + title, i, fresh.length);
        let file = DEST_DIR + '/' + fileBaseName(bookmark.title, bookmark.id) + '.epub';
        if (usedNames.has(file.toLowerCase())) {
          file = DEST_DIR + '/' + fileBaseName(bookmark.title, bookmark.id) + ' (' + bookmark.id + ').epub';
        }
        let skipReason;
        try {
          skipReason = cfg.worker_url
            ? await saveWithWorker(api, cfg, bookmark, file)
            : await saveInPage(api, cfg, io, bookmark, file, tmpPath);
        } catch (e) {
          // These stop the whole sync; anything else only skips this article.
          if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
          skipReason = e.message;
        }
        if (skipReason) {
          result.skipped.push({ title, reason: skipReason });
          report('Skipped ' + (i + 1) + ' of ' + fresh.length + counts() + ': ' + title, i + 1, fresh.length);
          continue;
        }
        await api.writeFile(...sidecarFor(file, bookmark.id));
        usedNames.add(file.toLowerCase());
        articles[bookmark.id] = { file, section };
        await saveState();
        result.added.push(title);
        report('Saved ' + (i + 1) + ' of ' + fresh.length + counts() + ': ' + title, i + 1, fresh.length);
      }

      // Articles fetched from this section that are no longer among its
      // newest `limit`: archived, moved or deleted in Instapaper.
      if (cfg.remove_gone) {
        report('Removing articles that left the folder...', fresh.length || 1, fresh.length || 1);
        const listed = new Set(bookmarks.map((b) => String(b.id)));
        for (const id of Object.keys(articles)) {
          if (articles[id].section !== section || listed.has(id)) continue;
          await io.deleteFile(articles[id].file);
          await io.deleteFile(articles[id].file + '.meta.json').catch(() => {});
          delete articles[id];
          result.removed++;
        }
        if (result.removed) await saveState();
      }
    } finally {
      await io.deleteFile(tmpPath).catch(() => {});
    }
    return result;
  }

  // The headline of a sync result; the card lists skipped articles below it.
  function summary(result) {
    const parts = [result.added.length ? 'Added ' + result.added.length + ' articles.' : 'No new articles.'];
    if (result.removed) parts.push('Removed ' + result.removed + '.');
    if (result.skipped.length) parts.push('Skipped ' + result.skipped.length + ':');
    return parts.join(' ');
  }

  if (typeof __instapaperTest === 'object' && __instapaperTest) {
    Object.assign(__instapaperTest, {
      clampLimit,
      normalizeWorkerUrl,
      converterSettings,
      withExitEvents,
      withListSource,
      manifestFor,
      account,
      listSections,
      syncArticles,
      summary,
    });
  }

  // --- Settings card -------------------------------------------------------------------

  CrossPoint.registerPlugin(async (container, api) => {
    const CONFIG_PATH = api.dir + '/config.json';
    const link = (url, text) => '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>';
    const code = (text) => '<code>' + text + '</code>';
    // A collapsible numbered list of setup steps.
    const steps = (id, summary, open, items, after) =>
      '<details id="' +
      id +
      '"' +
      (open ? ' open' : '') +
      ' style="margin:8px 0"><summary><b>' +
      summary +
      '</b></summary><ol style="padding-left:20px">' +
      items.map((item) => '<li style="margin:4px 0">' + item + '</li>').join('') +
      '</ol>' +
      (after ? '<p>' + after + '</p>' : '') +
      '</details>';

    const tokenHelp = steps('ip-token-help', 'How to get an access token (once, about a minute)', true, [
      'Sign in on ' + link('https://www.instapaper.com', 'instapaper.com') + '.',
      'Open ' +
        link('https://www.instapaper.com/developers/applications', 'instapaper.com/developers/applications') +
        ' and create an application. Any name works, for example "CrossPoint". You do not need callback URIs. ' +
        'Leave it in Owner Only mode; do not submit it for review.',
      'The client ID and client secret it shows are not needed here.',
      'Open the application and select <b>Generate access token</b>. Copy it right away: Instapaper shows it only once.',
      'Paste the token above and tap <b>Connect</b>.',
    ]);
    const converterHelp = steps(
      'ip-worker-help',
      'How to set up the converter (once, about 10 minutes)',
      false,
      [
        'Create a free Cloudflare account at ' + link('https://dash.cloudflare.com/sign-up', 'dash.cloudflare.com/sign-up') + '.',
        'On a computer, install ' + link('https://nodejs.org', 'Node.js') + ' 24 or newer.',
        'Download this plugin\'s source repository and open a terminal in its folder (the one with ' +
          code('cloudflare.config.ts') +
          ').',
        'Run ' + code('npm install') + ', then ' + code('npx cf auth login') + ' and sign in to Cloudflare.',
        'Run ' +
          code('npx cf deploy') +
          '. If it asks for a workers.dev subdomain, pick any name. It prints the address, for example ' +
          code('https://instapaper-epub.yourname.workers.dev') +
          '.',
        'Turn on the option above, paste the address and tap <b>Save converter</b>.',
      ],
      'Anyone who knows the address can use the converter with their own Instapaper token, which counts against ' +
        'your Cloudflare free plan, so keep it to yourself. The plugin\'s README has more detail.',
    );

    container.innerHTML =
      '<h2>Articles for Instapaper</h2>' +
      '<p id="ip-status">Loading...</p>' +
      '<div id="ip-signin">' +
      '<div class="setting-row"><span class="setting-name">Access token</span>' +
      '<span class="setting-control"><input type="password" id="ip-token" autocomplete="off"></span></div>' +
      '<div class="setting-row"><button type="button" class="btn-small btn-add" id="ip-signin-btn">Connect</button></div>' +
      tokenHelp +
      '</div>' +
      '<div id="ip-sync" style="display:none">' +
      '<div class="setting-row"><span class="setting-name">Folder</span>' +
      '<span class="setting-control"><select id="ip-section"></select></span></div>' +
      '<div class="setting-row"><span class="setting-name">Newest articles to download</span>' +
      '<span class="setting-control"><input type="number" id="ip-limit" min="1" max="' +
      MAX_LIMIT +
      '"></span></div>' +
      '<div class="setting-row"><span class="setting-name">Delete articles that left the folder</span>' +
      '<span class="setting-control"><input type="checkbox" id="ip-remove"></span></div>' +
      '<div class="setting-row">' +
      '<button type="button" class="btn-small btn-add" id="ip-sync-btn">Sync now</button> ' +
      '<button type="button" class="btn-small" id="ip-signout">Disconnect</button>' +
      '</div>' +
      '<progress id="ip-progress" style="width:100%;display:none"></progress>' +
      '<div id="ip-sync-result"></div>' +
      '<p style="color:#666" id="ip-sync-note"></p>' +
      '<h3>Converter (optional)</h3>' +
      '<div class="setting-row"><span class="setting-name">Use a Cloudflare Worker converter</span>' +
      '<span class="setting-control"><input type="checkbox" id="ip-use-worker"></span></div>' +
      '<div class="setting-row"><span class="setting-name">Converter address</span>' +
      '<span class="setting-control"><input type="text" id="ip-worker" placeholder="https://….workers.dev"></span></div>' +
      '<div class="setting-row"><span class="setting-name">Send reading progress and archive finished articles</span>' +
      '<span class="setting-control"><input type="checkbox" id="ip-archive"></span></div>' +
      '<div class="setting-row"><button type="button" class="btn-small" id="ip-worker-btn">Save converter</button></div>' +
      '<p id="ip-worker-result"></p>' +
      '<p style="color:#666">The converter is a small Cloudflare Worker that runs on your own free Cloudflare account. ' +
      'With it, articles include their images, there is no size limit, and you can also download articles on the ' +
      'reader itself (Home &gt; Plugins). Your token is sent to it with each download. Without it, Sync saves text ' +
      'only.</p>' +
      '<p style="color:#666">With progress and archiving on, when you leave an Instapaper article on the reader, ' +
      'its reading position is sent to Instapaper. Every article ends with an "End of article" page: leave the ' +
      'article on that page and it moves to your Instapaper Archive. This happens the next time the reader ' +
      'connects to Wi-Fi. It works for articles downloaded after you turn it on.</p>' +
      converterHelp +
      '</div>';

    const el = (id) => document.getElementById(id);
    const status = (text) => {
      el('ip-status').textContent = text;
    };
    const showConverterResult = (text) => {
      el('ip-worker-result').textContent = text;
    };

    // Sync status under the Sync button: a progress bar while it runs, then
    // the summary with one line per skipped article.
    function showSyncProgress(text, done, total) {
      const bar = el('ip-progress');
      bar.style.display = '';
      if (total > 0) {
        bar.max = total;
        bar.value = done;
      } else {
        bar.removeAttribute('value'); // indeterminate while the list loads
      }
      el('ip-sync-result').textContent = text;
    }

    function showSyncResult(text, skipped) {
      el('ip-progress').style.display = 'none';
      const box = el('ip-sync-result');
      box.textContent = '';
      const line = document.createElement('p');
      line.textContent = text;
      box.appendChild(line);
      if (skipped && skipped.length) {
        const list = document.createElement('ul');
        for (const s of skipped) {
          const item = document.createElement('li');
          item.textContent = s.title + ': ' + s.reason;
          list.appendChild(item);
        }
        box.appendChild(list);
      }
    }

    async function readJson(path) {
      try {
        const r = await fetch('/download?path=' + encodeURIComponent(path));
        return r.ok ? JSON.parse(await r.text()) : null;
      } catch (e) {
        return null;
      }
    }

    async function deleteFile(path) {
      const r = await fetch('/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'path=' + encodeURIComponent(path),
      });
      if (!r.ok && r.status !== 404) throw new Error('could not delete ' + path + ' (HTTP ' + r.status + ')');
    }

    const io = {
      epub: await import(api.pluginFile('epub.js')),
      readJson,
      deleteFile,
      parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
      language: (navigator.language || '').split('-')[0].toLowerCase(),
      now: () => Date.now(),
    };

    const writeConfig = (cfg) => api.writeFile(CONFIG_PATH, bytesToBase64(utf8Encoder.encode(JSON.stringify(cfg))));

    // Brings device.json in line with `cfg`. Returns whether the reader must
    // restart: it reads event handlers at boot, but re-reads the lists every
    // time the plugin opens. Runs one at a time, since the card also calls it
    // when it loads.
    let manifestQueue = Promise.resolve();
    function syncManifest(cfg) {
      const run = manifestQueue.then(async () => {
        const r = await fetch(api.pluginFile('device.json'));
        if (!r.ok) throw new Error('could not read device.json (HTTP ' + r.status + ')');
        const before = JSON.parse(await r.text());
        const after = manifestFor(before, cfg);
        if (JSON.stringify(after) === JSON.stringify(before)) return false;
        const text = JSON.stringify(after, null, 2) + '\n';
        await api.writeFile(api.dir + '/device.json', bytesToBase64(utf8Encoder.encode(text)));
        return !!before.events !== !!after.events;
      });
      manifestQueue = run.catch(() => {});
      return run;
    }

    function showConverter(cfg) {
      const converter = converterSettings(cfg);
      el('ip-use-worker').checked = converter.use_worker;
      el('ip-archive').checked = !!cfg.archive;
      el('ip-worker-help').open = !converter.use_worker;
      el('ip-worker').value = converter.worker_address;
      el('ip-sync-note').textContent =
        'Articles are saved as EPUB in ' +
        DEST_DIR +
        ' on the SD card, ' +
        (converter.use_worker ? 'with images, through the converter.' : 'as text only.');
    }

    function showSections(sections, selected) {
      const select = el('ip-section');
      select.innerHTML = '';
      for (const s of sections) {
        const option = document.createElement('option');
        option.value = s.id;
        option.textContent = s.title;
        select.appendChild(option);
      }
      select.value = sections.some((s) => s.id === selected) ? selected : 'home';
    }

    // Your own folders load in the background, so the buttons work at once.
    function showConnected(cfg) {
      el('ip-signin').style.display = 'none';
      el('ip-sync').style.display = '';
      el('ip-limit').value = clampLimit(cfg.limit);
      el('ip-remove').checked = !!cfg.remove_gone;
      showConverter(cfg);
      showSections(SECTIONS, cfg.section);
      status('Connected as ' + cfg.username + '.');
      // A newly copied plugin version brings its default device.json.
      syncManifest(cfg).then(
        (restart) => restart && status('Connected as ' + cfg.username + '. Restart the reader once to apply your settings.'),
        (e) => status('Connected as ' + cfg.username + '. Could not update the reader settings: ' + e.message + '.'),
      );
      listSections(api, cfg).then(
        (sections) => showSections(sections, el('ip-section').value || cfg.section),
        (e) => status('Connected as ' + cfg.username + '. Could not load your folders: ' + e.message + '.'),
      );
    }

    function showDisconnected() {
      el('ip-signin').style.display = '';
      el('ip-sync').style.display = 'none';
      status('Not connected.');
    }

    let saved = (await readJson(CONFIG_PATH)) || {};
    if (saved.token) showConnected(saved);
    else showDisconnected();

    el('ip-signin-btn').onclick = async () => {
      const token = el('ip-token').value.trim();
      if (!token) {
        status('Paste an access token first.');
        return;
      }
      status('Checking the token...');
      try {
        const user = await account(api, { token });
        const cfg = Object.assign(
          {
            token,
            username: user.username,
            user_id: user.id,
            section: 'home',
            limit: DEFAULT_LIMIT,
            remove_gone: false,
            lang: io.language || 'en',
          },
          converterSettings(saved),
        );
        await writeConfig(cfg);
        saved = cfg;
        el('ip-token').value = '';
        showConnected(cfg);
      } catch (e) {
        status('Could not connect: ' + e.message + '.');
      }
    };

    el('ip-signout').onclick = async () => {
      try {
        // Keep the converter settings; drop the token and account.
        saved = converterSettings(saved);
        await writeConfig(saved);
        showSyncResult('');
        showDisconnected();
      } catch (e) {
        status('Error: ' + e.message);
      }
    };

    el('ip-sync-btn').onclick = async () => {
      const button = el('ip-sync-btn');
      if (!saved.token) {
        showSyncResult('Connect first.');
        return;
      }
      button.disabled = true;
      el('ip-signout').disabled = true;
      button.textContent = 'Syncing...';
      try {
        const cfg = Object.assign({}, saved, {
          section: el('ip-section').value || 'home',
          limit: clampLimit(el('ip-limit').value),
          remove_gone: el('ip-remove').checked,
        });
        await writeConfig(cfg);
        saved = cfg;
        const result = await syncArticles(cfg, api, io, showSyncProgress);
        showSyncResult(summary(result), result.skipped);
      } catch (e) {
        showSyncResult('Error: ' + e.message + '.');
      } finally {
        button.disabled = false;
        el('ip-signout').disabled = false;
        button.textContent = 'Sync now';
      }
    };

    el('ip-worker-btn').onclick = async () => {
      const use = el('ip-use-worker').checked;
      const typed = el('ip-worker').value.trim();
      const address = normalizeWorkerUrl(typed);
      if ((use || typed) && !address) {
        showConverterResult('Enter the converter address as https://name.account.workers.dev.');
        return;
      }
      try {
        if (use) {
          showConverterResult('Checking the converter...');
          let r;
          try {
            r = await api.relay('GET', address + '/', {}, '');
          } catch (e) {
            r = { status: 0, body: '' };
          }
          if (r.status !== 200 || r.body.indexOf(WORKER_BANNER) < 0) {
            showConverterResult('No converter answered at ' + address + (r.status ? ' (HTTP ' + r.status + ').' : '.'));
            return;
          }
        }
        const archive = el('ip-archive').checked;
        const cfg = Object.assign({}, saved, {
          use_worker: use,
          worker_address: address,
          worker_url: use ? address : '',
          lang: saved.lang || io.language || 'en',
          archive,
        });
        await writeConfig(cfg);
        saved = cfg;
        showConverter(cfg);
        const messages = [
          use
            ? 'Converter on. Sync now includes images, and Home > Plugins > Articles for Instapaper works on the reader.'
            : 'Converter off. Sync saves text only. The reader can list your articles but not download them.',
        ];
        if (archive && !use) messages.push('Progress and archiving need the converter, so they are off.');
        if (await syncManifest(cfg)) {
          messages.push('Restart the reader once so it picks up the change to progress and archiving.');
        }
        showConverterResult(messages.join(' '));
      } catch (e) {
        showConverterResult('Error: ' + e.message + '.');
      }
    };

    // For /plugins-run jobs: syncs with the saved settings.
    api.registerAction('sync', async () => {
      const cfg = (await readJson(CONFIG_PATH)) || {};
      if (!cfg.token) throw new Error('not connected');
      const result = await syncArticles(cfg, api, io, () => {});
      return { added: result.added.length, skipped: result.skipped.length, removed: result.removed };
    });
  });
})();
