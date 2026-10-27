// Reading events from the reader: progress sync and archiving.
//
// The plugin's device.json binds reader.exit and sleep.enter to POST
// /events/exit, only for books whose sidecar has an instapaper_id
// (require_meta). The firmware keeps an event queued (blocking later ones)
// until it gets a 2xx. So anything that can never succeed is answered 200
// and dropped; only failures that may pass (an invalid token, rate limits,
// Instapaper being down) are retried. Sleeping in an article sends it twice
// (sleep.enter, then reader.exit); both calls are safe to repeat.

const INSTAPAPER_API = 'https://www.instapaper.com/api/2';
// Progress reaches 100% only on the "End of article" page the plugin adds to
// every article (src/epub.js), so this means "turned to the end".
const ARCHIVE_AT = 100;

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value) + '\n', {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Event fields arrive as strings; an unfilled template variable stays as
// literal "{...}" text, which these checks reject.
function wholeNumber(value, min, max) {
  const text = String(value === undefined ? '' : value);
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

// Answer for an Instapaper failure: retry what may pass, drop the rest.
function failure(status, step) {
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return jsonResponse(status === 429 || status >= 500 ? 503 : status, { error: step + ': Instapaper HTTP ' + status });
  }
  return jsonResponse(200, { ignored: step + ': Instapaper HTTP ' + status });
}

export async function readerExit(request, fetchImpl = fetch) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return jsonResponse(401, { error: 'missing token' });
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(200, { ignored: 'not JSON' });
  }
  const id = wholeNumber(body.instapaper_id, 1, Number.MAX_SAFE_INTEGER);
  const percent = wholeNumber(body.percent, 0, 100);
  if (id === null) return jsonResponse(200, { ignored: 'not an Instapaper article' });
  if (percent === null) return jsonResponse(200, { ignored: 'no progress' });
  // event.ts is 0 when the reader's clock was never set.
  const ts = wholeNumber(body.ts, 1, 4102444800) || Math.floor(Date.now() / 1000);

  const call = (path, value) =>
    fetchImpl(INSTAPAPER_API + path, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const result = { id, percent, progress: false, archived: false };

  // Leaving an article at its start says nothing; do not reset progress
  // made in another app.
  if (percent > 0) {
    const r = await call('/bookmarks/' + id, { progress: { percentage: percent / 100, timestamp: ts } });
    if (!r.ok) return failure(r.status, 'progress');
    result.progress = true;
  }
  if (percent >= ARCHIVE_AT) {
    const r = await call('/bookmarks/' + id + '/move', { section: 'archive' });
    if (!r.ok) return failure(r.status, 'archive');
    result.archived = true;
  }
  return jsonResponse(200, result);
}
