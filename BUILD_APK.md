name: Build Android APK

on:
  push:
    branches: [main]
  workflow_dispatch: {}

# Needed so the release step below is allowed to create/update a GitHub Release and upload a file
# to it. Without this, the default token is read-only and that step fails with a 403.
permissions:
  contents: write

jobs:
  build:
    name: Build APK
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Set up Java
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      # scripts/patch-android-ui.py needs Pillow (PIL) to compose the launcher icon mipmaps.
      # ubuntu-latest ships python3 but not pip/Pillow, so this has to be explicit.
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python dependencies for UI patch script
        run: pip install pillow

      - name: Install dependencies
        run: npm install

      # The Pages site keeps index.html / plotedge-sw.js / plotedge.manifest.json at the repo
      # root (that's what Pages serves). Capacitor wants its own web folder, so this step makes
      # a throwaway copy at build time — nothing here gets committed back to the repo, so there's
      # still only one real copy of the app to maintain.
      - name: Stage web app into www/ for Capacitor
        run: |
          mkdir -p www
          cp index.html www/index.html
          cp plotedge-sw.js www/plotedge-sw.js
          cp plotedge.manifest.json www/plotedge.manifest.json

      - name: Add Android platform
        run: npx cap add android

      # `cap add android` generates an AndroidManifest.xml that only declares INTERNET, and it's
      # regenerated from scratch on every run (the android/ folder isn't committed), so the extra
      # permissions have to be re-injected here each build rather than committed once. Without
      # this, Android auto-denies the permission request without showing a prompt AND hides the
      # toggles in Settings -> Apps -> PlotEdge -> Permissions, so GPS/camera silently do nothing.
      - name: Declare hardware permissions in AndroidManifest.xml
        run: python3 scripts/patch-android-manifest.py

      - name: Generate app icons from resources/icon.png
        run: npx capacitor-assets generate --android
        continue-on-error: true

      # THIS STEP WAS MISSING. Everything in patch-android-ui.py - the runtime CAMERA
      # permission request, edge-to-edge system bars, and the AndroidChrome status-bar
      # theming bridge - lives in a rewritten MainActivity.java that this script writes.
      # Without actually running it here, `cap add android`'s default, unmodified
      # MainActivity.java is what gets compiled every time, no matter how correct the
      # script itself is. Runs after the icon-generation step above so its own launcher
      # icon composition (see the script's docstring for why) overwrites capacitor-assets'
      # output rather than the other way around, and before `cap sync` / the Gradle build
      # so the rewritten MainActivity.java is in place before compilation.
      - name: Patch Android UI (edge-to-edge, camera permission, launcher icons)
        run: python3 scripts/patch-android-ui.py

      # SAME CLASS OF BUG AS THE STEP ABOVE. scripts/patch-android-widget.py is what writes
      # PlotEdgeWidget.java, the widget layout/info/drawable resources, and — critically — the
      # <receiver> + appwidget-provider meta-data in AndroidManifest.xml. It was never invoked
      # here, so none of that ever reached the APK: no provider is declared, so the launcher's
      # widget picker has nothing to list and the widget appears simply not to exist. The JS half
      # of the feature (the Preferences mirror around line 6086 of index.html and the appUrlOpen
      # deep-link router) was already shipping and had nothing to talk to.
      # Runs after patch-android-ui.py because that script rewrites MainActivity.java wholesale;
      # this one only appends to the manifest, so it must not be overwritten afterwards. Before
      # `cap sync` / Gradle so the Java + resources are in place at compile time.
      - name: Patch Android widget (home screen provider, deep links)
        run: python3 scripts/patch-android-widget.py

      - name: Sync web assets into the Android project
        run: npx cap sync android

      - name: Make gradlew executable
        run: chmod +x android/gradlew

      - name: Build debug APK
        run: cd android && ./gradlew assembleDebug --no-daemon

      # Rename to a fixed filename (no version/commit hash in it) so the download link handed out
      # below never changes — same URL works every time, even across rebuilds.
      - name: Rename APK for release
        run: cp android/app/build/outputs/apk/debug/app-debug.apk android/app/build/outputs/apk/debug/PlotEdge.apk

      - name: Upload APK (workflow artifact)
        uses: actions/upload-artifact@v4
        with:
          name: PlotEdge-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk

      # Publishes the same APK to a permanent GitHub Release tagged "latest" — unlike the artifact
      # above (expires after ~90 days, buried under Actions → this specific run), a Release has one
      # stable page and one stable download URL that never changes between builds:
      #   https://github.com/<you>/<repo>/releases/download/latest/PlotEdge.apk
      # Re-running this workflow updates that same "latest" release/tag in place rather than piling
      # up a new release per push, so there's never more than one to manage.
      - name: Publish APK to "latest" GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: latest
          name: PlotEdge (latest build)
          body: Automatically rebuilt from the latest push to `main`. Download `PlotEdge.apk` below.
          make_latest: true
          files: android/app/build/outputs/apk/debug/PlotEdge.apk

---

## Signing, updates, and why data used to disappear

**Read this before your next install.**

`android/` is not committed — `npx cap add android` regenerates it on every CI run. Gradle signs
`assembleDebug` with the auto-generated key at `~/.android/debug.keystore`, and a GitHub Actions
runner is a fresh VM where that file does not exist. So Gradle silently created a **brand-new
random signing key on every single build**, and every APK carried a different signature.

Android refuses to update an app whose signature does not match the installed one
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The package installer's only route forward is
uninstall-then-install — which is the "cancel the first attempt, then go for update" behaviour —
and that deletes `/data/data/com.plotedge.app`. The WebView's `localStorage` lives in there, so
every project, feature type and setting went with it. It was never a crash inside the app; it was
the installer removing the app directory because it could not recognise the new APK as the same
app. `cap add android` also always writes `versionCode 1`, so every build looked like a
same-version reinstall.

### What now happens

`scripts/patch-android-signing.py` runs before the Gradle build and:

- applies a **persistent** keystore to the build type that is shipped, so the signature is
  identical across builds;
- sets `versionCode` from `github.run_number`, which only ever counts up — Android's requirement
  for accepting an in-place update;
- fails the build outright if no keystore can be resolved, rather than producing an APK that
  would force another uninstall.

`scripts/patch-android-manifest.py` additionally sets `android:allowBackup="true"` so Android's
device-transfer and restore carry the survey data to a new phone.

### One-time migration

The APK currently on your phone was signed with a throwaway key that nothing can match, so **the
first install after this change still needs a manual uninstall.** Export a backup from
Data → Backup & Restore before you do it. Every update after that one is a clean in-place update
and leaves your data alone.

### Where the key lives

By default, `signing/plotedge-release.keystore`, committed to the repo. This is a self-signed
sideload key, not a Play Store upload key — its only job is to stay byte-identical between builds.

If you would rather it were not in the repo, set these four repository secrets and the workflow
will prefer them automatically, with no code change:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 -w0 signing/plotedge-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | `plotedge` (or your own, if you regenerate the key) |
| `ANDROID_KEY_ALIAS` | `plotedge` |
| `ANDROID_KEY_PASSWORD` | `plotedge` |

Keep a copy of the keystore somewhere safe either way. **If it is lost, no future build can update
an existing install** — every user would have to uninstall and lose their data again, which is the
exact failure this exists to prevent.

---

## Photo capture and memory

Adding several photos to one vertex used to kill the app. This was **not** a crash the app could
catch or report — it was the Android WebView renderer being reclaimed by the OS, which looks
identical to a crash from the outside and takes any unsaved form state with it.

Three things were happening, all memory:

1. **Every photo was decoded at full resolution before being downscaled.** A 12 MP phone photo
   decodes to ~48 MB of bitmap. The downscale to 1200px happened after.
2. **Lists and grids drew the full 1200px image.** The browser decodes each `<img>` to a real
   bitmap regardless of its CSS size, so a vertex with 24 photos held ~99 MB purely to draw
   90-pixel thumbnails.
3. **Every capture re-serialised everything.** `persist()` stringified the whole store, then
   `getStorageUsageInfo()` cloned it into a Blob to measure it, then `publishWidgetSummary()`
   serialised and Blob-cloned *every project* to count unsynced ones — a figure that never used
   the sizes it was paying for.

### What changed

- `createImageBitmap()` decodes **straight to 1200px**, so the full-size bitmap is never
  created, and the source `File` is used directly so no full-resolution data URL exists either.
  Bitmaps are `close()`d and canvases zeroed rather than left to the garbage collector.
- Photos are processed **one at a time** through a queue, and each stores a 220px `thumbUrl`
  that every list and grid renders instead of the full image. The full copy is kept for the
  lightbox, PlotLens and exports.
- Storage size is tracked as bytes written rather than re-measured, the rolling backup is
  throttled to once a minute, and the widget refresh no longer asks for sizes it does not read.

Measured, for one vertex filled to 24 photos:

| | before | after |
|---|---|---|
| Transient peak per capture | ~58 MB | ~4.5 MB |
| Grid memory at 24 photos | ~99 MB | ~3.3 MB |
| String churn over the session | ~732 MB | ~146 MB |

A cap of 24 photos per vertex now applies, and captures are refused with a clear message once
storage passes 92% rather than failing at the write. Both are in `index.html` as
`PHOTO_MAX_PER_VERTEX` and the pre-flight check in `addVertexPhoto()`.

`tests/photo.test.js` measures the concurrency directly — it stubs `createImageBitmap` with a
counter and fails if peak concurrent decodes is ever above one.
