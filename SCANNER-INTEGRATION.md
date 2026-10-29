# Android scanner integration

The `PlotScan` Capacitor plugin implements file import and USB inventory. It does not implement a generic scanner driver.

## Field workflow

1. Capture using the scanner's supported Android application.
2. Export a self-contained GLB 2.0 or PLY file within the limits in `UPGRADE-NOTES.md`.
3. In PlotEdge Capture, choose **3D scans → Import scan**. Android Files can include mounted USB storage when Android exposes it.
4. Set PLY units before measuring. GLB defaults to metres.
5. Save the feature and export a **Project Bundle** to transfer it with the original scan.

Android's document picker grants access to the selected file. This workflow does not request broad storage access or USB communication permission. Temporary imports are bounded to 64 MiB and cleaned from the plugin's own cache directory after transfer.

| Method | Result |
|---|---|
| `getCapabilities()` | `{supportsFileImport: true, liveCapture: false, usbDevices: [{name, vendorId, productId}]}` |
| `pickScan()` | `{name, path, bytes, source: "android-files"}` or `{cancelled: true}` |
| `releaseImport({path})` | Deletes only a temporary file directly inside the scanner import cache |

`scripts/patch-android-scanner.py` copies the Java plugin, registers it in MainActivity, and declares USB host support as optional. It runs after the UI/widget patches because the UI patch rewrites MainActivity.

## Live acquisition

Identify the scanner model, USB vendor/product IDs, Android SDK/protocol, redistribution terms, supported Android/CPU versions, power requirements and output units. Device detection alone does not establish protocol compatibility.

A vendor adapter must handle permission, connect/disconnect, capture/cancel, progress and bounded-memory output, then pass the completed file through the validated import path. Only advertise `liveCapture: true` after testing on that physical scanner. Check unplug/replug, permission denial, low storage, large files, cancellation, app backgrounding and device rotation.

References: [Android USB host](https://developer.android.com/develop/connectivity/usb/host) and [document access](https://developer.android.com/training/data-storage/shared/documents-files).
