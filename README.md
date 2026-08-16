# PlotEdge

Offline-first field data collection for GIS and survey work. Runs as a PWA and ships as a
sideloaded Android APK via Capacitor.

```
npm install
npm test          # 95 checks, no browser needed
```

Open `index.html` directly in a browser to run the app — there is no build step.

---

## Two files you must create on GitHub

This archive deliberately contains **no dot-paths**. macOS hides them in Finder and Archive
Utility sometimes drops them silently when expanding a `.zip`, so shipping them in an archive is a
good way to lose them without noticing. Create both directly in the GitHub web UI instead
(**Add file → Create new file**, and type the full path including the slashes — GitHub creates the
folders for you):

| Path | Without it |
|---|---|
| `.github/workflows/build-apk.yml` | No APK is ever built. |
| `.gitignore` | `node_modules/` and the generated `android/` tree get committed. |

Their contents were supplied alongside this archive.

Until they exist locally, `npm test` skips the four checks that read the workflow and says so —
everything else still runs. Those four run in CI, where the file exists. Pull after creating them
and the full set runs locally too.

---

## Layout

The app used to be a single 16,800-line `index.html`. It is now a shell plus two ordered asset
folders.

```
index.html                 shell + the pre-paint boot script (see below)
css/   01-tokens           design tokens, light/dark, the six pillars
       02-mesh             ambient mesh, screen intensity bands, textures
       03-base             reset, layout, views, headers, bottom nav, PlotLens player
       04-screens          digitizing aids, attribute table, PlotEtch
       05-components       dashboard cards, fields, buttons, modals, sheets
       06-plotatlas        the full-screen map screen
       07-analytics        charts and PlotMind
js/    01..22              application, in load order
                           (17a is the two PDF deliverables: plan sheet + register)
tests/                     the suite; `npm test` runs it
scripts/                   Android build-time patches (manifest, widget, signing)
signing/                   the release keystore — see BUILD_APK.md before touching it
```

### The four named surfaces

| Surface | What it is for |
|---|---|
| **Capture** | Walking the geometry with GPS, one vertex at a time. The bottom-nav tab. |
| **PlotEtch** | Drawing a shape by tapping a map, for what you can see but cannot walk. |
| **PlotAtlas** | The full-screen map: reviewing, measuring, clustering, density, feature cards. |
| **PlotLens** | Turning the captured photos into a narrated story, with a route minimap. |

**PlotMind** sits across all of them: on-device analysis of whatever has been captured. It is
classical statistics and computational geometry — k-NN, k-means, median-absolute-deviation
outliers, segment intersection — not a model, and it never touches the network.

### Where photos live

Not in `localStorage`. Photo bytes are Blobs in IndexedDB (`js/04a-photostore.js`); the project
store keeps only the record. `persistStore()` enforces this with a `JSON.stringify` replacer that
drops `dataUrl`/`thumbUrl` on every write, so a hydrated photo can never leak back into the 5 MB
text budget. Anything that genuinely needs the base64 — exports, backups, the cloud queue —
calls `hydrateExportPhotos()` first and `releaseExportPhotos()` after.

Existing devices migrate themselves on the next launch; see the media-store block in
`js/22-boot.js`.

Not in this archive — create them on GitHub (see above): `.gitignore`,
`.github/workflows/build-apk.yml`.

### Two rules

**Load order is the API.** `css/` and `js/` are plain files loaded in filename order, not ES
modules. A script can only use top-level names declared in itself or in a file above it — in the
old single file every function hoisted to the top of one script, so anything could call anything.
Renumbering or reordering will break the app in ways that are not obvious from reading one file.
`tests/split.test.js` fails the build on any cross-file forward reference — including the subtle
kind, where a load-time statement *reaches* a later file two calls down through function bodies —
and on orphaned files, and on load order that disagrees with the filenames. `tests/smoke.js` boots
the whole app in a DOM as a backstop.

Corollary: **top-level statements that call into the app belong in `js/22-boot.js`**, not next to
the function they relate to. `applyTheme(currentTheme())` lives there for this reason.

**The pre-paint boot script stays inline in `index.html`.** It resolves theme, palette and screen
band before first paint. Moved to an external file it would be fetched after the HTML parses,
flashing the wrong palette on every cold launch.

### Adding a file

1. Create it with the next number in `css/` or `js/`.
2. Add the `<link>` or `<script>` tag to `index.html`, in the same position.
3. Add the path to `APP_ASSETS` in `plotedge-sw.js` and bump `SW_VERSION`.
4. `npm test`.

Steps 2 and 3 are not optional: miss 2 and the file is dead code, miss 3 and offline launches skip
it. The suite checks both.

---

## Documentation

| File | What's in it |
|---|---|
| `BUILD_APK.md` | The Android build, **the signing keystore, and why updates used to wipe data** |
| `DEPLOY.md` | Publishing the PWA, and what to upload |
| `THEMING.md` | The six pillars, sunlight legibility, the ambient mesh |
| `tests/README.md` | What each suite holds the app to, and why |
| `theme-preview.html` | Standalone palette preview — open it directly |

**Read the signing section of `BUILD_APK.md` before your first build.** The keystore must stay
byte-identical between builds; if it is lost, no future build can update an existing install and
every user has to uninstall and lose their captured data.
