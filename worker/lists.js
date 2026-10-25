// The reader's list picker: Home, Archive, Liked and your own folders.
//
// device.json points browse.lists_url here. The reader fetches that URL
// without headers (PluginCatalogActivity::loadBrowseListIndex), so the
// token comes in the query string: GET /lists?token=<Instapaper token>.
// The answer is the reader's list-index shape, {"lists": [{title, url}]};
// each url is an Instapaper bookmark list the reader then fetches itself,
// with the token in a header as usual.

const INSTAPAPER_API = 'https://www.instapaper.com/api/2';

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value) + '\n', {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// No {page}: the reader fetches the newest 100 once and pages them itself.
const listUrl = (query) => INSTAPAPER_API + '/bookmarks?' + query + '&limit=100';

export async function folderLists(request, fetchImpl = fetch) {
  const query = new URL(request.url).searchParams.get('token') || '';
  const header = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '');
  const token = query || (header ? header[1] : '');
  if (!token) return jsonResponse(401, { error: 'missing token' });

  const r = await fetchImpl(INSTAPAPER_API + '/folders', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!r.ok) return jsonResponse(r.status === 401 || r.status === 403 ? r.status : 502, { error: 'Instapaper HTTP ' + r.status });
  const { folders } = await r.json();
  const lists = [
    { title: 'Home', url: listUrl('section=home') },
    { title: 'Archive', url: listUrl('section=archive') },
    { title: 'Liked', url: listUrl('section=liked') },
  ].concat((folders || []).map((f) => ({ title: String(f.title), url: listUrl('folder_id=' + encodeURIComponent(f.id)) })));
  return jsonResponse(200, { lists });
}
