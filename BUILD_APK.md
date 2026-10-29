# Build the Android APK

The authoritative workflow is `.github/workflows/build-apk.yml`. Its visible copy is `VISIBLE-COPIES/github-workflows/build-apk.yml`. Use these files, not older workflow snippets in historical release notes.

Upload the complete source tree to the existing repository, including vendor, scanner, native, scripts, signing, package-lock.json and the workflow. Run **Build PlotEdge APK** in Actions or push to its configured main/master branch. Download the APK from the completed workflow's artifact/release.

The workflow uses Node 20, Java 17 and Python/Pillow. It runs npm ci and tests, builds local runtime bundles, stages the web assets, adds Android, applies the native patches, syncs Capacitor, and builds/signs the APK.

Patch order:

1. patch-android-manifest.py
2. Icon generation
3. patch-android-ui.py (rewrites MainActivity)
4. patch-android-widget.py
5. patch-android-scanner.py (registers PlotScan)
6. patch-android-signing.py
7. cap sync android, then the workflow's Gradle build

For a local build, install the Android SDK/JDK and follow the same staging commands and order. npm run build creates web assets only; it does not create an APK.

## Preserve installed data

Keep the existing signing/plotedge-release.keystore byte-identical and retain application ID com.plotedge.app. The key in this package is unchanged from the supplied source. Use an increasing Android version code. Repository-specific signing overrides use the PLOTEDGE_* variables in the actual workflow/script.

Export bundles before updating. Do not uninstall to work around an incompatible signing key or rejected version: uninstalling can remove local projects and media.

## Target-device verification

Browser/source tests are included. Native APK compilation and a physical scanner test still need to run on the target device. Check permissions, Files import, cancellation, USB inventory, background/resume, and export/restore. Live acquisition requires a model-specific SDK.
