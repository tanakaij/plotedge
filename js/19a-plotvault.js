// ═══════════════════════════════════════════════════════════════════════════
// PlotVault — read reference data straight out of object storage
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.
//
// Loaded at 19a because it needs ensureFlatgeobuf() from js/17-export.js and the
// map globals from js/14-map.js, and nothing loaded later needs it.
//
// ══ WHAT THIS IS ══
// PlotEdge already WRITES cloud-native formats — GeoPackage, FlatGeobuf,
// GeoParquet, GeoJSON. What it could not do is READ them as anything other than
// a whole-file download, which is the half of "cloud-native" that actually
// matters: the formats exist so you DON'T have to download the file.
//
// A FlatGeobuf file carries a packed Hilbert R-tree in its header. Given a
// bounding box, a client can walk that index and issue HTTP Range requests for
// only the byte ranges holding features that intersect — so a crew can pull the
// forty manholes around them out of a 2 GB municipal dataset over a phone
// connection, having transferred a few hundred kilobytes. No tile server, no
// database, no API. Just a file on a bucket and a client that knows how to read
// it, which is exactly the constraint this project chose.
//
// The flatgeobuf library already loaded for exports (js/17-export.js:815) does
// both directions; only serialize() was ever used. This file uses deserialize().
//
// ══ WHAT THIS IS NOT ══
// It is a READ path only, and deliberately so. Writing to a bucket needs
// credentials, which means either shipping secrets into a sideloaded APK (never)
// or a serverless signing endpoint (a backend, which PlotMate's transport will
// bring). Reads need neither: a public or presigned bucket URL is enough, so
// this ships now and stands alone.
//
// It is also ONLINE-only, and that is a real boundary rather than an oversight.
// Range requests need network. Capture stays exactly as offline-first as it has
// always been — nothing here touches the capture path, the store, or persist().
// PlotVault is reference data you consult when you have signal, not data you
// depend on to work.


const PLOTVAULT_KEY = 'plotedge_plotvault_sources';

// Range requests are the whole mechanism, so a bucket that does not serve them
// is not a slow PlotVault — it is a broken one, and it fails in the worst
// possible way: flatgeobuf asks for bytes 0-1000, gets the ENTIRE multi-gigabyte
// file back with a 200 instead of a 206, and the tablet either OOMs or burns the
// crew's data allowance in silence. probeSource() below exists to turn that into
// a sentence someone can act on, before a single feature is requested.
const PLOTVAULT_PROBE_TIMEOUT_MS = 12000;

// Guard against a bbox that covers half a continent. The R-tree makes a large
// query cheap to PLAN and still expensive to TRANSFER, and there is no progress
// bar that makes 400 MB acceptable on a field tablet. Features are counted as
// they stream and the read stops here, with an honest message, rather than
// running the device out of memory.
const PLOTVAULT_MAX_FEATURES = 5000;


function plotvaultSources() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLOTVAULT_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

function plotvaultSaveSources(list) {
  try { localStorage.setItem(PLOTVAULT_KEY, JSON.stringify(list)); } catch (e) {}
}


// ══ PREFLIGHT ══
// Answers one question — "will streaming actually work against this URL?" — and
// distinguishes the three failure modes, because they have three different
// fixes and a generic "couldn't load" sends people to the wrong one:
//
//   · CORS not configured        -> fix the bucket's CORS policy
//   · Range requests unsupported -> fix the CDN/proxy in front of the bucket
//   · Not found / wrong path     -> fix the URL
//
// A cross-origin fetch that is blocked by CORS is indistinguishable from a
// network failure in JS by design (the browser refuses to tell us why), so the
// message names it as a possibility rather than asserting it.
async function plotvaultProbeSource(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLOTVAULT_PROBE_TIMEOUT_MS);
  try {
    // A 0-0 range asks for a single byte. A server that honours ranges answers
    // 206 with content-range; one that ignores them answers 200 and would have
    // sent the whole file. Cheaper and more definitive than trusting the
    // Accept-Ranges header, which proxies are known to advertise and not honour.
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
    clearTimeout(timer);

    if (res.status === 404) return { ok: false, why: 'Nothing found at that URL — check the path and the file name.' };
    if (res.status === 403) return { ok: false, why: 'Access denied. The object needs to be public, or the URL needs to be a presigned one that has not expired.' };
    if (!res.ok && res.status !== 206) return { ok: false, why: `The server answered ${res.status}.` };

    if (res.status !== 206) {
      return { ok: false, why: 'That server ignores range requests, so reading a bounding box would download the entire file. Serve the bucket directly, or configure the CDN in front of it to pass Range through.' };
    }

    const total = (res.headers.get('content-range') || '').split('/')[1];
    return { ok: true, bytes: total && total !== '*' ? parseInt(total, 10) : null };
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return { ok: false, why: 'The server did not respond in time.' };
    return { ok: false, why: 'Could not reach that URL. If the address is right, the bucket most likely needs a CORS policy allowing this origin — and it must expose the Content-Range header.' };
  }
}


// ══ THE READ ══
// Streams features intersecting `bbox` out of a remote .fgb. Returns a GeoJSON
// FeatureCollection.
//
// deserialize() yields features as they arrive rather than resolving once at the
// end, so onProgress can report a running count. That matters more here than it
// looks: this is the one operation in the app whose duration depends on somebody
// else's server, and a spinner with no number is indistinguishable from a hang.
async function plotvaultReadBbox(url, bbox, onProgress) {
  await ensureFlatgeobuf();
  if (typeof flatgeobuf === 'undefined' || !flatgeobuf.geojson || !flatgeobuf.geojson.deserialize) {
    throw new Error('The FlatGeobuf reader could not be loaded.');
  }
  const rect = { minX: bbox.minLon, minY: bbox.minLat, maxX: bbox.maxLon, maxY: bbox.maxLat };
  const features = [];
  let truncated = false;

  for await (const f of flatgeobuf.geojson.deserialize(url, rect)) {
    features.push(f);
    if (onProgress && features.length % 25 === 0) onProgress(features.length);
    if (features.length >= PLOTVAULT_MAX_FEATURES) { truncated = true; break; }
  }
  if (onProgress) onProgress(features.length);
  return { type: 'FeatureCollection', features: features, truncated: truncated };
}


// ══ WHAT COUNTS AS "HERE" ══
// The bbox is taken from the review map's current view, not from the project
// extent. Those differ constantly — a crew zooms to one corner of a large site —
// and the view is what the person is actually looking at, which makes the
// transfer proportional to the question being asked rather than to the size of
// the project.
function plotvaultViewBbox() {
  if (!reviewMap || typeof reviewMap.getBounds !== 'function') return null;
  const b = reviewMap.getBounds();
  if (!b || !b.isValid || !b.isValid()) return null;
  return {
    minLon: b.getWest(), minLat: b.getSouth(),
    maxLon: b.getEast(), maxLat: b.getNorth()
  };
}


// Reference layers are held apart from reviewMapLayerGroup, which is rebuilt
// wholesale by renderReviewMap() on every feature change. Sharing that group
// would mean a remote read vanishing the moment the crew captured a point —
// silently, and long after the read that fetched it.
let plotvaultLayers = {};

function plotvaultClearLayer(sourceUrl) {
  const layer = plotvaultLayers[sourceUrl];
  if (layer && reviewMap) { try { reviewMap.removeLayer(layer); } catch (e) {} }
  delete plotvaultLayers[sourceUrl];
}

function plotvaultClearAll() {
  Object.keys(plotvaultLayers).forEach(plotvaultClearLayer);
}


async function plotvaultLoadIntoMap(source) {
  const bbox = plotvaultViewBbox();
  if (!bbox) { showToast('Open the map first, then load reference data for the view you can see.'); return; }
  if (!navigator.onLine) { showToast('PlotVault needs a connection — reference data is read live from the bucket.'); return; }

  showToast('Reading ' + (source.name || 'reference data') + '…');
  try {
    const fc = await plotvaultReadBbox(source.url, bbox, (n) => {
      const el = document.getElementById('plotvaultStatus');
      if (el) el.textContent = n + ' feature' + (n === 1 ? '' : 's') + ' so far…';
    });

    plotvaultClearLayer(source.url);
    if (!fc.features.length) {
      showToast('No reference features in this view.');
      return;
    }

    // Reference data is deliberately styled as background: thin, muted, dashed
    // and non-interactive. It must never be mistakable for something this crew
    // captured — a surveyor acting on somebody else's manhole because it looked
    // like their own is the actual risk this styling exists to prevent.
    const layer = L.geoJSON(fc, {
      interactive: false,
      style: { color: 'var(--text-tertiary)', weight: 1.5, opacity: 0.75, dashArray: '4 3', fillOpacity: 0.06 },
      pointToLayer: (feat, latlng) => L.circleMarker(latlng, {
        radius: 3.5, weight: 1.5, opacity: 0.8, fillOpacity: 0.25, interactive: false
      })
    });
    layer.addTo(reviewMap);
    plotvaultLayers[source.url] = layer;

    showToast(fc.truncated
      ? `Showing the first ${PLOTVAULT_MAX_FEATURES} features — zoom in for the rest`
      : `${fc.features.length} reference feature${fc.features.length === 1 ? '' : 's'} loaded`);
  } catch (e) {
    console.error('PlotVault read failed:', e);
    showToast('Could not read that source. Check it in PlotVault settings.');
  } finally {
    const el = document.getElementById('plotvaultStatus');
    if (el) el.textContent = '';
  }
}


// ══ UI ══
function openPlotVault() {
  renderPlotVault();
  document.getElementById('plotvaultModal').classList.add('show');
}

function closePlotVault() {
  dismissKeyboard();
  document.getElementById('plotvaultModal').classList.remove('show');
}

function renderPlotVault() {
  const el = document.getElementById('plotvaultList');
  if (!el) return;
  const sources = plotvaultSources();
  if (!sources.length) {
    el.innerHTML = '<div class="pv-empty">No sources yet. Add the URL of a FlatGeobuf (.fgb) file on your bucket — PlotEdge reads only the part of it you are looking at.</div>';
    return;
  }
  el.innerHTML = sources.map((s, i) => {
    const loaded = !!plotvaultLayers[s.url];
    return `<div class="pv-row">
      <div class="pv-row-body">
        <div class="pv-row-name">${escapeHtml(s.name || 'Untitled source')}</div>
        <div class="pv-row-url">${escapeHtml(s.url)}</div>
      </div>
      <button class="pv-row-btn" type="button" onclick="${loaded ? `plotvaultToggleOff(${i})` : `plotvaultLoadIndex(${i})`}">${loaded ? 'Hide' : 'Load'}</button>
      <button class="pv-row-x" type="button" onclick="plotvaultRemove(${i})" aria-label="Remove source">×</button>
    </div>`;
  }).join('');
}

function plotvaultLoadIndex(i) {
  const s = plotvaultSources()[i];
  if (s) plotvaultLoadIntoMap(s).then(renderPlotVault);
}

function plotvaultToggleOff(i) {
  const s = plotvaultSources()[i];
  if (s) { plotvaultClearLayer(s.url); renderPlotVault(); }
}

function plotvaultRemove(i) {
  const list = plotvaultSources();
  const s = list[i];
  if (!s) return;
  plotvaultClearLayer(s.url);
  list.splice(i, 1);
  plotvaultSaveSources(list);
  renderPlotVault();
}

async function plotvaultAddSource() {
  const nameEl = document.getElementById('plotvaultName');
  const urlEl = document.getElementById('plotvaultUrl');
  const status = document.getElementById('plotvaultStatus');
  const url = (urlEl.value || '').trim();
  const name = (nameEl.value || '').trim();

  if (!url) { showToast('Paste the URL of a .fgb file'); return; }
  if (!/^https:\/\//i.test(url)) { showToast('The URL must start with https://'); return; }

  // Probed before it is saved, not after: a source that cannot stream is worse
  // than no source, because it fails at the moment someone is standing in a
  // field relying on it rather than at the moment they configured it.
  if (status) status.textContent = 'Checking the server…';
  const probe = await plotvaultProbeSource(url);
  if (!probe.ok) {
    if (status) status.textContent = '';
    showToast(probe.why);
    return;
  }

  const list = plotvaultSources();
  list.push({ name: name || url.split('/').pop() || 'Reference layer', url: url, bytes: probe.bytes || null });
  plotvaultSaveSources(list);
  nameEl.value = ''; urlEl.value = '';
  if (status) status.textContent = '';
  const size = probe.bytes ? ' (' + Math.round(probe.bytes / 1048576) + ' MB on the server)' : '';
  showToast('Source added' + size + ' — it streams, nothing was downloaded');
  renderPlotVault();
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = { plotvaultSources, plotvaultSaveSources, plotvaultProbeSource, plotvaultViewBbox, PLOTVAULT_KEY, PLOTVAULT_MAX_FEATURES };
}
