#!/usr/bin/env python3
"""
Inject the runtime permissions PlotEdge needs into the AndroidManifest.xml that
`npx cap add android` generates.

The default Capacitor manifest only declares INTERNET. Android will not show a
permission toggle in Settings -> Apps -> PlotEdge -> Permissions for anything
that is not declared here, and requestPermissions() for an undeclared
permission is auto-denied without ever showing a prompt. That is why GPS and
camera silently fail in the APK while working fine in the browser.

Safe to run more than once - it skips anything already present.
"""

import pathlib
import sys

MANIFEST = pathlib.Path("android/app/src/main/AndroidManifest.xml")

PERMISSIONS = [
    # navigator.geolocation (WebView geolocation prompt -> Capacitor asks for these two)
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    # getUserMedia({video}) for the barcode scanner, and <input capture="environment">
    "android.permission.CAMERA",
    # getUserMedia({audio}) for voice notes
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    # Exports are written to Documents/PlotEdge via @capacitor/filesystem so the crew can
    # actually find them in a file manager. On API 28 and below that needs an explicit write
    # permission -- without it the write fails and the export silently produces nothing, which
    # is the failure this app already shipped once. maxSdkVersion is applied below: from API 29
    # scoped storage covers Documents without any permission at all, and leaving an unbounded
    # WRITE_EXTERNAL_STORAGE in the manifest gets the app flagged on newer targets.
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.READ_EXTERNAL_STORAGE",
]

# Permissions that only apply to older API levels. Kept separate from PERMISSIONS above because
# they need the maxSdkVersion attribute, not a bare name.
PERMISSION_MAX_SDK = {
    "android.permission.WRITE_EXTERNAL_STORAGE": "28",
    "android.permission.READ_EXTERNAL_STORAGE": "32",
}

# required="false" so the Play Store / sideload never filters the app off a
# device that happens to be missing the hardware.
FEATURES = [
    "android.hardware.camera",
    "android.hardware.location.gps",
]


def patch_soft_input_mode(xml: str) -> str:
    """
    Force android:windowSoftInputMode="adjustResize" on the launcher <activity>.

    ═══════════════════════════════════════════════════════════════════════════
    WHY — this is the "modal snaps and flickers when the keyboard opens" bug.

    The CSS in css/05-components.css reasons about the keyboard like this:

        "On Android (adjustResize) --kbh stays ~0 because 100dvh already
         excludes the keyboard, so the same rules are correct on both
         platforms without branching."

    That assumption was never true for THIS app. Two things break it:

      1. `npx cap add android` does not write windowSoftInputMode at all, and
         the platform default is adjustUnspecified — which on a full-screen
         WebView activity resolves to adjustPan, not adjustResize. adjustPan
         does not resize the window; it SLIDES the whole thing up, so a
         position:fixed overlay is dragged off the top of the screen while its
         own layout still believes it is full height.

      2. scripts/patch-android-ui.py calls
             WindowCompat.setDecorFitsSystemWindows(getWindow(), false)
         for edge-to-edge. That opts the window out of automatic inset
         consumption, so even where adjustResize would have applied, the IME
         inset is no longer subtracted from the WebView's height.

    Net effect: 100dvh keeps reporting the FULL screen with the keyboard up, so
    --kbh (innerHeight - visualViewport.height) resolves to the entire keyboard
    height instead of ~0, and the sheet is asked to absorb ~320px of padding
    that the CSS was written on the assumption it would never receive. The
    layout is then correct only at the two endpoints and wrong for every frame
    in between, which is exactly the snap/flicker on every keyboard toggle.

    adjustResize restores the contract the stylesheet is written against: the
    WebView is genuinely shorter while the IME is up, dvh units mean what they
    say, and --kbh settles near zero on Android as documented.
    ═══════════════════════════════════════════════════════════════════════════
    """
    import re as _re

    # The launcher activity is the only one Capacitor generates, but match on
    # MainActivity explicitly so a widget/deep-link activity added later by
    # patch-android-widget.py is never the one that gets rewritten.
    m = _re.search(r"<activity\b[^>]*?MainActivity[^>]*?>", xml, _re.DOTALL)
    if not m:
        m = _re.search(r"<activity\b[^>]*>", xml, _re.DOTALL)
    if not m:
        print("  WARNING: no <activity> tag; skipping windowSoftInputMode")
        return xml

    tag = m.group(0)
    if "android:windowSoftInputMode" in tag:
        new_tag = _re.sub(
            r'android:windowSoftInputMode="[^"]*"',
            'android:windowSoftInputMode="adjustResize"',
            tag,
        )
        print('  updating: android:windowSoftInputMode="adjustResize"')
    else:
        new_tag = tag[:-1].rstrip() + ' android:windowSoftInputMode="adjustResize">'
        print('  adding: android:windowSoftInputMode="adjustResize"')
    return xml.replace(tag, new_tag, 1)


def patch_backup_attrs(xml: str) -> str:
    """
    Force android:allowBackup="true" (and the Android 12+ equivalent) on the
    <application> tag. Set explicitly rather than relying on the platform
    default, because the default flipped between target SDK levels and the
    generated manifest does not pin it either way.
    """
    import re as _re

    m = _re.search(r"<application\b[^>]*>", xml)
    if not m:
        print("  WARNING: no <application> tag; skipping backup attributes")
        return xml
    tag = m.group(0)
    new_tag = tag
    for attr, value in (
        ("android:allowBackup", "true"),
        ("android:fullBackupOnly", "true"),
    ):
        if attr in new_tag:
            new_tag = _re.sub(
                rf'{attr}="[^"]*"', f'{attr}="{value}"', new_tag
            )
            print(f"  updating: {attr}=\"{value}\"")
        else:
            new_tag = new_tag[:-1].rstrip() + f' {attr}="{value}">'
            print(f"  adding: {attr}=\"{value}\"")
    return xml.replace(tag, new_tag, 1)



# ══ .plotpack FILE ASSOCIATION ══
# Without this, a .plotpack arriving by WhatsApp, Gmail or Bluetooth is a file the
# launcher has no opener for: the user taps it and Android offers nothing, or
# offers a text editor. Since .plotpack is deliberately a short opaque extension
# rather than a self-describing one like .plotedge, this association IS what
# makes the format usable by someone who receives one cold.
#
# Three filters, not one, because Android matches a file's type from three
# different sources depending on how it arrived and none of them is reliable
# alone:
#   1. mimeType — set when the sender declares it. Almost never, for a custom
#      extension, so this catches the well-behaved minority.
#   2. pathPattern on a content:// or file:// URI — the extension match. This is
#      the one that fires for a downloaded attachment. The doubled-up patterns
#      cover directories containing a literal dot, which Android's glob handles
#      badly (a documented, long-standing quirk: .*\.plotpack fails on
#      /storage/emulated/0/Download.old/x.plotpack without them).
#   3. A wildcard mimeType with the same pathPattern, for the very common case
#      of a chat app handing over application/octet-stream.
#
# android:exported is mandatory from API 31 and the whole point here, so it is
# spelled out rather than inherited.
PLOTPACK_INTENT_FILTER = """
        <!-- PlotEdge project bundles (.plotpack) — injected at build time -->
        <intent-filter android:label="Open with PlotEdge">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:mimeType="application/vnd.plotedge.plotpack+zip" />
        </intent-filter>
        <intent-filter android:label="Open with PlotEdge">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="content" />
            <data android:scheme="file" />
            <data android:host="*" />
            <data android:pathPattern=".*\\.plotpack" />
            <data android:pathPattern=".*\\..*\\.plotpack" />
            <data android:pathPattern=".*\\..*\\..*\\.plotpack" />
        </intent-filter>
        <intent-filter android:label="Open with PlotEdge">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:scheme="content" />
            <data android:mimeType="application/octet-stream" />
            <data android:pathPattern=".*\\.plotpack" />
        </intent-filter>
"""


def patch_plotpack_association(xml):
    """Attach the .plotpack VIEW filters to the launcher activity."""
    # Function-local, matching every other patcher in this file. Not a style
    # choice to copy blindly: this module is imported by tooling that must not
    # pay for imports it will not use, and the neighbouring functions all do the
    # same. Omitting it is a NameError that only fires in CI, because nothing
    # here runs during npm test.
    import re as _re

    # Guard on the MIME string that is actually emitted below. It used to read
    # "vnd.plotedge.project", left behind by the .pteg -> .plotpack rename, so it
    # never matched and a second run appended a duplicate set of filters. CI runs
    # this once against a freshly generated manifest, so nothing would have caught
    # it there either.
    if PLOTPACK_INTENT_FILTER.strip().splitlines()[0] in xml or "vnd.plotedge.plotpack" in xml:
        print("  .plotpack association already present; skipping")
        return xml
    m = _re.search(r"<activity\b[^>]*?MainActivity[^>]*?>", xml, _re.DOTALL)
    if not m:
        print("  WARNING: no MainActivity tag; skipping .plotpack association")
        return xml
    at = m.end()
    print("  .plotpack file association added to MainActivity")
    return xml[:at] + PLOTPACK_INTENT_FILTER + xml[at:]


def main() -> int:
    if not MANIFEST.exists():
        print(f"ERROR: {MANIFEST} not found - run this after `npx cap add android`.")
        return 1

    xml = MANIFEST.read_text(encoding="utf-8")

    additions = []
    for perm in PERMISSIONS:
        if perm in xml:
            print(f"  already present: {perm}")
            continue
        max_sdk = PERMISSION_MAX_SDK.get(perm)
        if max_sdk:
            additions.append(
                f'    <uses-permission android:name="{perm}" android:maxSdkVersion="{max_sdk}" />'
            )
            print(f"  adding: {perm} (maxSdkVersion={max_sdk})")
        else:
            additions.append(f'    <uses-permission android:name="{perm}" />')
            print(f"  adding: {perm}")

    for feat in FEATURES:
        if feat in xml:
            print(f"  already present: {feat}")
            continue
        additions.append(
            f'    <uses-feature android:name="{feat}" android:required="false" />'
        )
        print(f"  adding: {feat} (required=false)")

    # ══ AUTO-BACKUP ══
    # All captured data lives in the WebView's localStorage, i.e. inside the app
    # data directory. Android's Auto Backup / device-transfer will carry that
    # directory to a new phone or restore it after a factory reset, but ONLY if
    # allowBackup is on. Capacitor's generated manifest leaves it unset, so a
    # crew changing devices silently starts from nothing. This is a second line
    # of defence behind the in-app backup file, not a replacement for it — a
    # sideloaded APK is not restored by Play, so the export is still the copy
    # that matters most.
    xml = patch_backup_attrs(xml)

    # ══ KEYBOARD RESIZE ══
    # Must run here, not in patch-android-ui.py: that script rewrites
    # MainActivity.java but never touches the <activity> tag, and the widget
    # patch only appends siblings. See patch_soft_input_mode's docstring for
    # why the default (adjustPan, plus edge-to-edge) breaks every bottom sheet.
    xml = patch_soft_input_mode(xml)

    # ══ .plotpack ASSOCIATION ══
    # Same reason as the keyboard patch above: this needs the <activity> tag,
    # which only this script touches.
    xml = patch_plotpack_association(xml)

    if not additions:
        print("Backup attributes checked; nothing else to do.")
        MANIFEST.write_text(xml, encoding="utf-8")
        return 0

    if "</manifest>" not in xml:
        print("ERROR: no closing </manifest> tag - manifest looks malformed.")
        return 1

    block = "\n    <!-- PlotEdge hardware permissions (injected at build time) -->\n"
    block += "\n".join(additions) + "\n"

    xml = xml.replace("</manifest>", block + "</manifest>", 1)
    MANIFEST.write_text(xml, encoding="utf-8")
    print(f"Patched {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
