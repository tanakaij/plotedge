# Field collection and scanner update — 29 October 2026

## Changes

- Cleaner capture cards, inline form fields, light/dark styling and touch controls. The original one-field-at-a-time option remains available. Required dropdowns now start with an empty choice.
- Save & Next waits for the device write before clearing the capture. Failed writes retain the form and expose Retry save.
- Project records use ordered IndexedDB transactions with a previous snapshot. Legacy migration verifies an exact read-back before removing the old copy. Startup blocks if the marked database is missing.
- Repaired undefined service-worker cache names. Map libraries, exporters, WASM SQLite and the 3D viewer are bundled locally for offline use.
- Review states: Collected, Needs attention and Reviewed. Filters and bulk review for selected table rows. Checks flag required answers, invalid/insufficient geometry, duplicate references, GPS accuracy over 15 metres, polygon edge crossings (up to 500 vertices), and unknown scan units. These are screening checks, not survey certification.
- Lists and tables show 30 records per page; exports retain all records. Fixed the inactive desktop Review layout and duplicate pagination controls.
- GLB/PLY attachments preserve originals, identify duplicates with SHA-256, record scanner/source/units, provide a 3D preview, support approximate two-point measurements, and export originals. Save, edit and pause/resume retain attachments.
- Version 2 project bundles include original scans and unfinished captures. Unfinished work restores as paused captures. Restore verifies scan hashes and remaps file IDs. Corrupt or missing scan originals block the project commit.
- Fixed single-project JSON restore and the missing project IDs in all-project JSON backups. JSON backups now include scan originals. GeoJSON/CSV carry review and scan metadata; GIS ZIPs include originals and an attachment index. CSV preserves zero/false values.

## Practical limits

| Item | Behavior |
|---|---|
| Scan input | GLB 2.0 or PLY, up to 64 MiB per file |
| PLY preview | ASCII and binary little/big endian; fixed vertex properties; sampled to at most 150,000 displayed points |
| PLY faces | Preview uses vertices; the unchanged original retains faces and other data |
| GLB preview | Self-contained models, up to 2 million vertices; no external resources or added Draco/KTX decoders |
| Bundle scans | Up to 128 MiB of originals per project bundle; JSON backup limited to 64 MiB before base64 |
| Bundle photo restore | Up to 32 MiB per photo and 256 MiB total |
| Measurements | Approximate; use the correct source units. PLY sampling can affect results |
| Coordinates | Local/unregistered. A feature GPS location is a geotag, not geographic registration of the scan |
| Android scanner | Files import and USB inventory; live acquisition requires the scanner model and its SDK/protocol |
| Connectivity | Offline capture/review/export/preview after installation. Unvisited map tiles and external services require a connection |
| Sync | Device storage plus existing optional photo upload; no new multi-user project-sync backend |

Large textured models can exceed a phone's available memory despite passing the file-size check. Simplify them in the scanner app. A failed preview leaves the original exportable. Removing an attachment removes its reference; originals are retained conservatively for recovery, so discarded imports can consume space.

## Update safely

Export a Project Bundle outside the app before updating. Preserve the existing Android application ID and signing key; install an update over the existing app. Do not uninstall to force an update. Keep the same browser origin/profile for PWA updates.

Version 1 project bundles and JSON backups still import. New backups are version 2; older app versions cannot safely read them. Local storage is not a separate backup. Export before clearing app/browser data or changing devices.

This is a source package, not a prebuilt APK. Native APK compilation and operation with a physical scanner were not validated here. See `VALIDATION.md` for the automated checks and `SCANNER-INTEGRATION.md` for device integration.
