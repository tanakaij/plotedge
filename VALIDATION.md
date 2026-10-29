# Validation — 29 October 2026

## Results

| Check | Result |
|---|---|
| `npm test` | 641 / 641 passed on the final source |
| Chromium acceptance suite | 22 / 22 passed |
| Runtime dependency bundling | 30 local runtime assets prepared successfully |
| Android staging | Capacitor platform generation, manifest/UI/widget/scanner patches and `cap sync android` succeeded |
| Scanner registration | PlotScan registered before MainActivity's super.onCreate; USB host feature optional |
| Signing identity | Release keystore preserved from the supplied archive |

The browser suite used a real Chromium browser with a local HTTP server, simulated geolocation and offline network mode. It exercised mobile and desktop layouts, light/dark rendering, inline forms, original PLY/GLB storage, duplicate/invalid-file rejection, worker-based PLY preview, GLB rendering, two-point measurement, pause/resume, save/edit, transaction failure and Retry, scan checksum validation, bundle/JSON restoration, snapshots over 5 MB, quality filters and pagination. It also checks that an unfinished notes-only capture travels with the bundle. No uncaught browser errors occurred.

The record-store tests cover verified legacy migration, cold reload, ordered writes, retained backups, failed migration, failed commit/retry and startup with missing database contents. PLY tests cover ASCII, both binary byte orders, Unicode headers, large-coordinate precision, sampling and malformed data. The Android patch test checks idempotent registration and restricted temporary-file deletion.

## Not validated here

- A compiled/signed APK on a physical Android device. The Android SDK/native build was not run; staging and source tests do not substitute for it.
- An attached physical scanner, its power/USB behavior or its vendor capture SDK. Live acquisition is not implemented.
- Survey-grade scan registration or measurement accuracy; the viewer reports approximate local-coordinate distances.
- Real field GPS accuracy, very large textured models on low-memory phones, or external backup/service endpoints.

Before field deployment, build the APK, install it over the existing signed app after exporting a backup, and test the actual phone/scanner with a small capture and a full export/restore cycle.
