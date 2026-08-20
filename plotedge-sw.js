// plotedge-sw.js — PlotEdge's actual service worker.
//
// REBUILT FROM SPEC, NOT RECOVERED. The file that used to live at this path had been silently
// overwritten by an older copy of .github/workflows/build-apk.yml (a save that went to the wrong
// filename at some point) — no service worker code was running at all; registration was failing
// on a parse error and the .catch(()=>{}) next to it was swallowing that silently. There was no
// git history to recover it from, so this is a from-scratch rebuild against the behavior index.html
// and DEPLOY.md already document elsewhere in this project:
//   - "network-first for the shell, so a fresh deploy is fetched on the very next load rather than
//     served from cache" (index.html, SERVICE WORKER + UPDATE DETECTION comment)
//   - "cache: 'no-store' in the service worker's fetch handler, updateViaCache:'none' on
//     registration" (DEPLOY.md)
//   - "areas already viewed ... so they still show up offline" for the Review map's basemap tiles
//     (index.html, ensureReviewMap offline banner)
//   - relative paths throughout, so this keeps working when deployed to a GitHub Pages subpath
//     rather than a domain root (DEPLOY.md, "subpath vs. root")

const SW_VERSION = 'v19';   // bumped: css/12-polish.css, js/21b-plotalert.js, js/21c-sheet-chrome.js added
const SHELL_CACHE = `plotedge-shell-${SW_VERSION}`;
const TILE_CACHE = `plotedge-tiles-${SW_VERSION}`;

// Resolved against the SW's own scope (not '/') so this keeps working whether PlotEdge is served
// from a domain root or a GitHub Pages subpath like /plotedge/ — an absolute '/index.html' would
// 404 under a subpath.
//
// ══ THE APP IS NO LONGER ONE FILE ══
// index.html used to carry the whole stylesheet and application inline, so caching it cached
// everything. Now it is a shell that pulls in css/ and js/, and caching only the shell would give
// an offline launch a blank, unstyled page — the worst possible failure for a field app, because
// it looks like data loss. Every file index.html references is listed here.
// Keep this in step with the <link> and <script> tags: tests/split.test.js fails the build if they
// ever disagree.
const APP_ASSETS = [
  'css/01-tokens.css',
  'css/02-mesh.css',
  'css/03-base.css',
  'css/04-screens.css',
  'css/05-components.css',
  'css/06-plotatlas.css',
  'css/07-analytics.css',
  'css/08-plotwords.css',
  'css/09-capture-form.css',
  'css/10-quick-actions.css',
  'css/11-plotarchive.css',
  'css/12-polish.css',
  'js/01-theme-and-settings.js',
  'js/02-state.js',
  'js/03-schema.js',
  'js/03a-plotmate.js',
  'js/03b-plotarchive.js',
  'js/04-store.js',
  'js/04a-photostore.js',
  'js/05-projects.js',
  'js/05a-plotbounds.js',
  'js/06-collect.js',
  'js/06a-capture-stack.js',
  'js/06b-plotseed.js',
  'js/07-navigation.js',
  'js/08-gps.js',
  'js/09-geometry.js',
  'js/10-photos.js',
  'js/11-features.js',
  'js/11a-attr-query.js',
  'js/12-review.js',
  'js/13-dashboard.js',
  'js/13a-analytics.js',
  'js/13b-map-rotate.js',
  'js/14-map.js',
  'js/14a-plotatlas.js',
  'js/15-plotetch.js',
  'js/16-geometry-math.js',
  'js/16a-plotmind.js',
  'js/16b-plotgrid.js',
  'js/16c-plotbank.js',
  'js/17-export.js',
  'js/17a-plansheet.js',
  'js/17b-plotpack.js',
  'js/17c-plotcad.js',
  'js/17d-plotfix.js',
  'js/18-import.js',
  'js/19-sync.js',
  'js/19a-plotvault.js',
  'js/20-ui-feedback.js',
  'js/21-webmap.js',
  'js/21a-plotwords.js',
  'js/21b-plotalert.js',
  'js/21c-sheet-chrome.js',
  'js/22-boot.js',
  // ══ IMAGES ══
  // These were base64 data URLs inline in index.html and the manifest until
  // scripts/extract-inline-images.py pulled them out (half a megabyte of image
  // data the browser had to parse as markup on every cold start). They are real
  // files now, which is what makes them cacheable — but it also means an
  // offline launch 404s on any one that is missing from this list, which for
  // the splash logo and the welcome mark is a visibly broken first screen.
  'resources/favicon-128.png',
  'resources/apple-touch-icon-180.png',
  'resources/splash-logo-320.png',
  'resources/welcome-mark-176.png',
  'resources/icon-192x192-any.png',
  'resources/icon-512x512-any.png',
  'resources/icon-512x512-maskable.png',
];

const SHELL_URLS = [
  new URL('./', self.registration.scope).href,
  new URL('./index.html', self.registration.scope).href,
  new URL('./plotedge.manifest.json', self.registration.scope).href,
  ...APP_ASSETS.map((p) => new URL('./' + p, self.registration.scope).href),
];

// The two raster tile sources the Review map (and the PDF map-layout export) pull from — see
// reviewMapStreetLayer/reviewMapSatelliteLayer and mapLayoutTileUrl() in index.html. Recognizing
// these by host+path is what lets the fetch handler treat "map imagery" differently from
// "app shell": tiles are cached opportunistically and never block on the network, the shell is
// always network-first.
function isTileRequest(url) {
  return (
    (url.hostname.endsWith('.tile.openstreetmap.org')) ||
    (url.hostname === 'server.arcgisonline.com' && url.pathname.includes('/World_Imagery/MapServer/tile/'))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      // Take over from any previously-waiting SW immediately rather than waiting for every open
      // tab to close first — index.html's controllerchange handler is what actually reloads open
      // tabs, on a short delay so a brand-new install doesn't trigger a pointless reload of itself.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE && name !== TILE_CACHE)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs etc. (e.g. optional backup/tagging endpoints)

  const url = new URL(req.url);

  if (isTileRequest(url)) {
    event.respondWith(handleTileRequest(req));
    return;
  }

  // Same-origin app-shell requests: HTML/JS/CSS/manifest, i.e. everything this app itself serves.
  // Cross-origin, non-tile requests (Nominatim geocoding, the optional photo-recognition/backup
  // endpoints, published web-map pushes to api.github.com, etc.) are left completely alone — they
  // need a live network round trip to mean anything, and caching them would be actively wrong.
  if (url.origin === self.location.origin) {
    event.respondWith(handleShellRequest(req));
  }
});

// Network-first, falling back to cache only when actually offline — this is the behavior that
// makes "push new files, reload within a minute, see the change" true (DEPLOY.md's own test
// steps). cache:'no-store' on the fetch itself means this never gets short-circuited by the HTTP
// cache sitting in between the SW and the network, on top of the no-store already being enforced
// by updateViaCache:'none' at the registration layer in index.html.
async function handleShellRequest(req) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    // Last resort for a bare navigation with nothing cached yet (e.g. first-ever load happened
    // offline, which can't really happen, but a partial/corrupted install shouldn't hard-fail a
    // navigation either) — hand back the app shell itself rather than a bare network error.
    if (req.mode === 'navigate') {
      const shell = await caches.match(new URL('./index.html', self.registration.scope).href);
      if (shell) return shell;
    }
    throw err;
  }
}

// Cache-first, refreshed in the background — the opposite priority from the shell, deliberately.
// A basemap tile doesn't change under you the way app code does, and a field crew panning across
// an area they already loaded needs it to appear instantly and work with no signal, not to wait
// on a network round trip that may never complete. A failed fetch (offline, tile server down) just
// leaves the tile cache as-is; Leaflet already handles a missing tile as a transparent gap rather
// than an error, so nothing here needs to synthesize a placeholder image.
async function handleTileRequest(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => undefined);
  if (cached) {
    network; // let it refresh the cache in the background; the caller doesn't wait on it
    return cached;
  }
  const fresh = await network;
  return fresh || Response.error();
}
