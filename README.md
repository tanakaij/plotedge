# PlotEdge

Field data collection for GIS and survey work, with an offline PWA and a Capacitor Android wrapper.

The October 2026 update adds inline forms, Save & Next, confirmed device-save status, quality review, and scanner attachments. See [UPGRADE-NOTES.md](UPGRADE-NOTES.md) for changes and limits.

## Run locally

```sh
npm ci
npm run build
npm test
python3 -m http.server 8080
```

Open `http://localhost:8080` on the same computer. Use an HTTP server rather than opening the HTML file directly: the service worker and scanner modules need a web origin. Deploy over HTTPS for phone location/camera access. Runtime libraries are included in `vendor/`; the build reproduces them from locked dependencies.

Optional browser acceptance tests:

```sh
npx playwright install chromium
npm run test:browser
```

The suite starts a local server and exercises offline reload, scan import/preview/measurement, pause/resume, edit, failed saves and backup restoration. `CHROMIUM_PATH` selects an installed Chromium binary; `QA_OUTPUT` selects a screenshot directory.

## Android and scanners

See [BUILD_APK.md](BUILD_APK.md). This archive contains source and the build workflow, not a prebuilt APK.

In Capture, choose **3D scans → Import scan** to attach GLB or PLY. Android uses the Files picker, including mounted USB storage where available. A scanner using its own application should export a supported file there first. Original files stay with project backups.

**Check attached USB devices** lists devices reported by Android. Live acquisition requires the scanner model and its Android SDK/protocol; see [SCANNER-INTEGRATION.md](SCANNER-INTEGRATION.md).

## Storage and backups

Project records use transactional IndexedDB snapshots in `plotedge-records`. Photos use `plotedge-media`; scans use `plotedge-scans`. Preferences and the current capture draft remain in localStorage. Migration verifies existing records before removing the legacy copy.

Export **Project Bundle (.plotpack)** outside the app before updates, storage clearing or a device move. Version 2 includes scans and paused captures; version 1 imports remain supported. JSON import supports versions 1 and 2. Older apps cannot safely read the new version 2 backups.

The offline cache includes the app and its runtime libraries. Unvisited map areas, geocoding and external services require a connection. An optional photo-upload endpoint does not synchronize all project records.

## Source layout

| Path | Purpose |
|---|---|
| `index.html`, `css/`, `js/` | Shell and ordered classic scripts |
| `scanner/` | Viewer source and PLY worker/parser |
| `vendor/` | Local runtime bundles and license notices |
| `native/android/` | Scanner file bridge and USB inventory |
| `scripts/`, `tests/` | Build patches and validation |
| `.github/workflows/build-apk.yml` | Android build workflow |
| `signing/` | Existing signing identity; preserve it |

Keep classic script order intact. Add new runtime files to index.html and the service-worker asset list and bump SW_VERSION. The tests enforce these relationships. The scanner viewer is a separate lazy-loaded ES module.

Required configuration is included. `VISIBLE-COPIES/` provides copies for upload tools that omit hidden paths; keep these synchronized with the actual files.
