#!/usr/bin/env python3
"""
Fix two things in the generated Android shell that Capacitor can't do for us.

Run after `npx cap add android`. Like the manifest patcher, this has to run on
every build because android/ is regenerated from scratch each time.

1. LAUNCHER ICON
   resources/icon.png is full-bleed artwork - the mark touches its own canvas
   edge. @capacitor/assets treats a lone icon.png as a "logo", stretches it
   across the entire adaptive-icon foreground and pairs it with a plain white
   background. Android then clips that with the launcher's circle mask, so the
   mark gets its top and bottom shaved off and reads much larger than every
   other icon in the drawer.

   Android's spec: the layer is 108dp, only the middle 72dp is guaranteed
   visible, and artwork belongs inside a ~66dp keyline within that. Supplying
   pre-padded source files to @capacitor/assets doesn't work either - it emits
   them at legacy icon sizes (192px at xxxhdpi instead of 432px), so they get
   upscaled and go soft. So we compose the mipmaps directly here at the right
   densities and write our own adaptive-icon XML.

2. EDGE-TO-EDGE SYSTEM BARS
   By default the WebView is laid out below the status bar, so the app's own
   background stops short of the clock and battery. Modern Android apps draw
   underneath the bars instead. index.html is already written for this (it uses
   env(safe-area-inset-*) throughout), so this only needs the native half:
   transparent bars, decor that doesn't fit system windows, and the real inset
   values pushed into CSS custom properties.

   That last part matters: Android WebView below version 140 has a bug that
   reports env(safe-area-inset-top) as 0 even in edge-to-edge mode. Field
   devices often run older WebViews, so we can't rely on the CSS variable
   alone - MainActivity reads the true insets and hands them to the page, and
   the CSS takes whichever value is larger.

   The status/nav bar ICON color (dark-on-light vs light-on-dark) can't be
   pinned to one value the way the background can, because PlotEdge's own
   background swaps between a near-black dark theme and a light/pink theme
   (index.html's data-theme). A dark icon reads fine on the light theme's
   header but disappears on the dark theme's, and vice versa. So MainActivity
   exposes a tiny JS interface ("AndroidChrome") that index.html's existing
   applyTheme() calls every time the theme changes, flipping the system bar
   icons to match whichever theme is actually on screen.
"""

import pathlib
import re
import sys

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow is required. Install with: pip install pillow")
    sys.exit(1)

ANDROID = pathlib.Path("android/app/src/main")
RES = ANDROID / "res"
SOURCE_ICON = pathlib.Path("resources/icon.png")

# ══ ICON PLATE COLOUR ══
# This used to be hardcoded to (10, 4, 5) — --grad-1 from the dark theme — on the
# assumption that resources/icon.png was a transparent mark that wanted a dark
# plate behind it. It is not. The source artwork is a fully OPAQUE 2048x2048 PNG
# that carries its own near-white background (roughly #F8F8F8), with zero
# transparent pixels anywhere.
#
# So the old pipeline did this: trimmed_mark() asked for the alpha bounding box,
# got the whole canvas back because nothing was transparent, and handed the
# entire white square to compose(). compose() then scaled that white square down
# to ARTWORK_FRACTION of the layer and centred it over the near-black plate. The
# result on a home screen was a black tile with a small white square floating in
# the middle of it — the "black edges around the white background" this fixes.
#
# The plate is now read off the artwork itself rather than declared here, so the
# background layer and the artwork's own background are the same colour and the
# seam between them disappears. FALLBACK_BG only applies if the source turns out
# to be a genuinely transparent mark, in which case white is still the right
# plate for this logo.
FALLBACK_BG = (255, 255, 255, 255)

# How far a pixel may sit from the sampled corner colour and still count as
# plate rather than artwork. Generous enough to absorb JPEG-ish ringing and the
# gentle vignette this particular source has (its corners range 236-248), tight
# enough that it never eats into the mark, which is a dark maroon (67, 17, 20).
PLATE_TOLERANCE = 26

# Adaptive icon layers are 108dp square. Multiply by each density's scale.
DENSITY_SCALE = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}
ADAPTIVE_DP = 108
LEGACY_DP = 48

# Fraction of the full 108dp layer the artwork's longest side covers. Android publishes
# per-shape keylines inside the 72dp visible area, and the right one depends on the mark's
# proportions: a square mark sits on a 66dp keyline (0.44 of 108dp once you allow for the
# mask), a vertical rectangle on a 44x60dp one. This mark is portrait (roughly 7:10), so
# height is the governing side and 60/108 is the target. Fitting a tall mark to the square
# figure instead makes it read noticeably smaller than neighbouring icons.
ARTWORK_FRACTION = 0.55
# Legacy (pre-Android 8) icons are never masked and get no inset, so the artwork can run
# much closer to the canvas edge - 44dp of the 48dp legacy keyline.
LEGACY_ARTWORK_FRACTION = 0.88

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Written by scripts/patch-android-ui.py. Padding is baked into the
     foreground PNG, so no <inset> is applied here - and the background layer
     fills all 108dp so no launcher mask can ever clip past its edge. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""

MAIN_ACTIVITY = """package com.plotedge.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.util.List;

import com.getcapacitor.BridgeActivity;

/**
 * Written by scripts/patch-android-ui.py - edits here are overwritten on the
 * next build. Change the script instead.
 *
 * Puts the app in edge-to-edge mode and forwards the real system bar insets to
 * the web layer as CSS custom properties (--sb-top / --sb-bottom / --sb-left /
 * --sb-right). index.html reads those alongside env(safe-area-inset-*) and
 * takes whichever is larger, which covers the Android WebView < 140 bug where
 * the env() values come back as 0.
 */
public class MainActivity extends BridgeActivity {

    private static final int CAMERA_PERMISSION_REQUEST = 8421;
    private String pendingInsetJs = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // AndroidManifest.xml *declares* CAMERA, but on API 23+ that alone
        // does not grant it - the vertex-photo button in index.html routes
        // through Capacitor's Camera plugin (see openVertexPhotoCapture()),
        // which does its own runtime permission check before it can launch
        // the native camera Activity. Asking here too, at launch, means it's
        // already granted by the time the user taps that button, so there's
        // no extra prompt breaking up the capture flow. Also covers the
        // plain <input capture="environment"> fallback used outside the
        // native app, whose WebView file chooser only offers a "take photo"
        // option once CAMERA has actually been granted.
        requestCameraPermissionIfNeeded();

        // Draw behind the status and navigation bars.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // Attached to the content view rather than the decor view: replacing the
        // decor view's listener would take over the framework's own inset
        // dispatch, and we only want to observe.
        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            float density = getResources().getDisplayMetrics().density;

            // ══ IME INSET — THE HALF THAT WAS MISSING ══
            // AndroidManifest declares windowSoftInputMode="adjustResize", but the
            // setDecorFitsSystemWindows(false) call above opts this window OUT of the
            // framework's automatic inset consumption. On API 30+ that means the
            // WebView is NOT resized when the keyboard opens: it keeps full height and
            // is simply handed an ime() inset that nothing was reading.
            //
            // Consequence in CSS: 100dvh stays the FULL screen with the keyboard up, so
            // --kbh (computed in JS as innerHeight - visualViewport.height) resolves to
            // the entire keyboard height rather than the ~0 that css/05-components.css
            // documents as the Android case. The overlay is then asked to animate
            // ~320px of padding-bottom on the same frames the sheet is sliding in and
            // the IME is animating up — the stutter, the grey band, and the focus drop.
            //
            // Reading the inset here and publishing it as --kbh-native gives the web
            // layer an authoritative, animation-synced keyboard height that does not
            // depend on visualViewport timing at all.
            int imeBottomPx = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            boolean imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            int kbhDp = imeVisible ? Math.round(imeBottomPx / density) : 0;

            pendingInsetJs =
                "document.documentElement.style.setProperty('--sb-top','" +
                Math.round(bars.top / density) + "px');" +
                "document.documentElement.style.setProperty('--sb-bottom','" +
                Math.round(bars.bottom / density) + "px');" +
                "document.documentElement.style.setProperty('--sb-left','" +
                Math.round(bars.left / density) + "px');" +
                "document.documentElement.style.setProperty('--sb-right','" +
                Math.round(bars.right / density) + "px');" +
                "window.__plotedgeNativeKbh&&window.__plotedgeNativeKbh(" + kbhDp + ");";

            pushInsets();
            // Returning the insets unconsumed lets the WebView see them too, so
            // env(safe-area-inset-*) still works on WebView 140+.
            return windowInsets;
        });

        // ══ IME ANIMATION FENCE ══
        // The inset listener alone still delivers the keyboard height as a series of
        // intermediate values while the IME slides. Every one of those retargets the
        // overlay's transitioned padding-bottom mid-flight, which is the "layout
        // stutters" half of the bug — CSS easing a value that is itself being animated
        // by the platform on a different clock.
        //
        // onPrepare/onEnd bracket that window so the web layer can drop its own
        // transitions for the duration and simply track the platform's animation
        // frame-for-frame, then hand control back to CSS once the IME has settled.
        // API 30+ only; below that these callbacks never fire and the JS fallback in
        // js/01-theme-and-settings.js stays in charge, which is the correct behaviour.
        ViewCompat.setWindowInsetsAnimationCallback(content,
            new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {

                @Override
                public void onPrepare(WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                        evalJs("window.__plotedgeKbAnimating&&window.__plotedgeKbAnimating(true);");
                    }
                }

                @Override
                public WindowInsetsCompat onProgress(
                        WindowInsetsCompat insets,
                        List<WindowInsetsAnimationCompat> running) {
                    return insets;
                }

                @Override
                public void onEnd(WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                        evalJs("window.__plotedgeKbAnimating&&window.__plotedgeKbAnimating(false);");
                    }
                }
            });

        // index.html's applyTheme() calls AndroidChrome.setLightStatusBar(...)
        // on every theme change (including the initial one at page load), so
        // the status/nav bar icons always match whichever theme - light/pink
        // or dark - is actually on screen. Added here, before the page starts
        // loading, so it's ready the moment the first script tag runs.
        final WebView bridgeWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (bridgeWebView != null) {
            bridgeWebView.addJavascriptInterface(new StatusBarBridge(), "AndroidChrome");
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // The first inset callback usually lands before the page has finished
        // loading, so the properties get set on a document that is then thrown
        // away. Re-applying on resume and on a short delay makes it stick
        // regardless of which order those two finish in.
        pushInsets();
        final View content = findViewById(android.R.id.content);
        if (content != null) {
            content.postDelayed(this::pushInsets, 250);
            content.postDelayed(this::pushInsets, 1200);
        }
    }

    private void pushInsets() {
        if (pendingInsetJs == null || getBridge() == null) {
            return;
        }
        final WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        final String js = pendingInsetJs;
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    /** Fire-and-forget JS into the bridge WebView, on the WebView's own thread. */
    private void evalJs(final String js) {
        if (getBridge() == null) {
            return;
        }
        final WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void requestCameraPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.CAMERA},
                CAMERA_PERMISSION_REQUEST
            );
        }
    }

    /**
     * Bridges index.html's theme switcher to the native status/nav bar icon
     * color. WebView JS-interface methods run on a background thread, so the
     * actual WindowInsetsController call is posted back to the UI thread.
     */
    private class StatusBarBridge {
        @JavascriptInterface
        public void setLightStatusBar(final boolean lightBackground) {
            runOnUiThread(() -> {
                WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                // "Light" here means the SYSTEM BAR BACKGROUND behind the icons is
                // light, so the icons themselves need to render dark to stay
                // visible - i.e. this is Android's "light status bar" flag, which
                // is the same polarity as iOS's dark-content style.
                controller.setAppearanceLightStatusBars(lightBackground);
                controller.setAppearanceLightNavigationBars(lightBackground);
            });
        }
    }
}
"""

# Transparent bars. windowLightStatusBar/windowLightNavigationBar start false
# (light icons) here purely as the first-paint default before any JS has run -
# MainActivity's StatusBarBridge + index.html's applyTheme() immediately
# override this to match whichever theme (light/pink or dark) is active, and
# keep it in sync every time the person switches themes afterward.
EDGE_TO_EDGE_ITEMS = """        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>
        <item name="android:enforceNavigationBarContrast">false</item>
        <item name="android:enforceStatusBarContrast">false</item>
"""


def detect_plate(img: Image.Image):
    """
    The flat background colour the artwork is painted on, or None if it has none.

    Decided from the four corners. If they agree with each other within
    PLATE_TOLERANCE the artwork is a plate-backed logo and their average is that
    plate; if they disagree the artwork runs to its own edges and there is
    nothing to key out.
    """
    w, h = img.size
    corners = [
        img.getpixel((1, 1)),
        img.getpixel((w - 2, 1)),
        img.getpixel((1, h - 2)),
        img.getpixel((w - 2, h - 2)),
    ]
    if any(c[3] < 250 for c in corners):
        return None  # already transparent at the edges: a real cut-out mark
    for channel in range(3):
        values = [c[channel] for c in corners]
        if max(values) - min(values) > PLATE_TOLERANCE:
            return None  # corners disagree: full-bleed artwork, not a plate
    avg = tuple(round(sum(c[i] for c in corners) / 4) for i in range(3))
    return (avg[0], avg[1], avg[2], 255)


def key_out_plate(img: Image.Image, plate) -> Image.Image:
    """Make every pixel within PLATE_TOLERANCE of `plate` transparent."""
    pixels = img.load()
    w, h = img.size
    pr, pg, pb, _ = plate
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if abs(r - pr) <= PLATE_TOLERANCE and abs(g - pg) <= PLATE_TOLERANCE and abs(b - pb) <= PLATE_TOLERANCE:
                pixels[x, y] = (r, g, b, 0)
    return img


def load_mark():
    """
    The bare mark plus the plate colour it should sit on.

    Returns (mark, plate). `mark` is cropped to the artwork's real bounds with
    the flat background keyed out, which is what makes the keyline fractions
    below mean anything — scaling a plate-backed square to 55% of the layer
    sizes the PLATE to 55%, not the logo, so the logo ends up far too small
    inside a box that is far too visible.
    """
    img = Image.open(SOURCE_ICON).convert("RGBA")
    plate = detect_plate(img)
    if plate is not None:
        print(f"  detected background plate rgb{plate[:3]} — keying it out")
        img = key_out_plate(img, plate)
    else:
        plate = FALLBACK_BG
        print("  no flat background plate detected — treating source as a cut-out mark")
    box = img.split()[3].getbbox()
    return (img.crop(box) if box else img), plate


def compose(mark: Image.Image, size: int, fraction: float, background) -> Image.Image:
    """Fit the mark into `fraction` of a square canvas, centered, over `background`."""
    target = size * fraction
    ratio = min(target / mark.width, target / mark.height)
    scaled = mark.resize(
        (max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (size, size), background)
    canvas.alpha_composite(
        scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2)
    )
    return canvas


def write_icons() -> None:
    if not SOURCE_ICON.exists():
        print(f"  SKIP icons: {SOURCE_ICON} not found")
        return

    mark, plate = load_mark()
    print(f"  source mark {mark.width}x{mark.height} after trim")

    for density, scale in DENSITY_SCALE.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)

        adaptive_px = round(ADAPTIVE_DP * scale)
        legacy_px = round(LEGACY_DP * scale)

        compose(mark, adaptive_px, ARTWORK_FRACTION, (0, 0, 0, 0)).save(
            folder / "ic_launcher_foreground.png"
        )
        Image.new("RGBA", (adaptive_px, adaptive_px), plate).save(
            folder / "ic_launcher_background.png"
        )

        legacy = compose(mark, legacy_px, LEGACY_ARTWORK_FRACTION, plate)
        legacy.save(folder / "ic_launcher.png")
        legacy.save(folder / "ic_launcher_round.png")

        print(f"  {density}: adaptive {adaptive_px}px, legacy {legacy_px}px")

    anydpi = RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    print("  wrote adaptive-icon XML (background fills the full 108dp layer)")


def write_main_activity() -> None:
    matches = list(pathlib.Path("android/app/src/main/java").rglob("MainActivity.java"))
    if not matches:
        print("  SKIP MainActivity: not found")
        return
    for path in matches:
        path.write_text(MAIN_ACTIVITY, encoding="utf-8")
        print(f"  rewrote {path}")


def patch_styles() -> None:
    styles = RES / "values" / "styles.xml"
    if not styles.exists():
        print("  SKIP styles.xml: not found")
        return

    xml = styles.read_text(encoding="utf-8")
    if "windowLightStatusBar" in xml:
        print("  styles.xml already patched")
        return

    # AppTheme.NoActionBar is the theme MainActivity actually runs under once
    # the splash screen hands off.
    pattern = re.compile(
        r'(<style name="AppTheme\.NoActionBar"[^>]*>\n)', re.MULTILINE
    )
    patched, count = pattern.subn(r"\1" + EDGE_TO_EDGE_ITEMS, xml)
    if not count:
        print("  WARNING: could not find AppTheme.NoActionBar - styles.xml unchanged")
        return

    styles.write_text(patched, encoding="utf-8")
    print("  patched styles.xml for transparent system bars")


def main() -> int:
    if not ANDROID.exists():
        print(f"ERROR: {ANDROID} not found - run after `npx cap add android`.")
        return 1

    print("Launcher icons:")
    write_icons()
    print("Edge-to-edge:")
    patch_styles()
    write_main_activity()
    return 0


if __name__ == "__main__":
    sys.exit(main())
