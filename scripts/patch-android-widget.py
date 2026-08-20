#!/usr/bin/env python3
"""
Inject PlotEdge's home screen widget into the Android project that
`npx cap add android` generates.

WHY THIS IS A BUILD-TIME PATCH
------------------------------
The android/ folder is not committed - it is regenerated from scratch on every
CI run - so anything native has to be re-injected each build. This follows the
same pattern as patch-android-manifest.py and patch-android-ui.py.

WHAT THE WIDGET SHOWS
---------------------
An at-a-glance field status card: the active project, its feature count, how
many vertices are mid-capture, and how many projects still hold unexported
data. The point is answering "is there work on this phone I haven't got off it
yet?" without unlocking into the app.

HOW IT GETS ITS DATA
--------------------
A widget is a separate process from the WebView and cannot read localStorage.
index.html mirrors a small JSON summary into Capacitor's Preferences plugin on
every save; that plugin writes to the "CapacitorStorage" SharedPreferences
file, which this widget reads back. If the key is missing (fresh install, or a
build without the plugin) the widget degrades to its quick-action buttons
rather than showing an error.

REFRESH BEHAVIOUR - KNOWN LIMIT
-------------------------------
Android caps updatePeriodMillis at 30 minutes, and pushing an update the moment
the app saves would need a custom Capacitor plugin to broadcast from JS. So the
widget refreshes on its 30-minute tick, whenever it is re-laid-out, and
immediately when its own refresh button is tapped. The refresh button is what
makes that limit liveable.

Safe to run more than once - every write is idempotent.
"""

import pathlib
import re
import sys

PKG = "com.plotedge.app"
JAVA_DIR = pathlib.Path("android/app/src/main/java/com/plotedge/app")
RES = pathlib.Path("android/app/src/main/res")
MANIFEST = pathlib.Path("android/app/src/main/AndroidManifest.xml")

# ══ THEME ══
# Every colour in the widget used to be a hex literal in the layout and the
# drawables, all of them dark (#141A26 card, #FFFFFF text). A widget sits on the
# user's wallpaper next to first-party widgets that follow the system theme, so
# on a light-themed phone PlotEdge was the one black slab on the home screen.
#
# RemoteViews cannot read the app's theme, and it cannot call setTextColor from
# a colour attribute either — but it DOES resolve @color references through the
# normal resource qualifier system when the launcher inflates it. So declaring
# the same names twice, once in values/ and once in values-night/, is all it
# takes: the launcher picks the right set for whatever mode the system is in,
# and re-inflates on change. No Java involved.
COLORS_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Light theme. Mirrors index.html's light tokens: card-bg #FFFFFF,
     surface-sunken #F1F5F9, text-tertiary for the eyebrow.
     (CSS token names are written without their leading dashes on purpose:
     a literal double-hyphen is not legal inside an XML comment.) -->
<resources>
    <color name="pe_widget_bg">#FFFFFF</color>
    <color name="pe_widget_stroke">#E2E8F0</color>
    <color name="pe_widget_eyebrow">#64748B</color>
    <color name="pe_widget_title">#0F172A</color>
    <color name="pe_widget_body">#475569</color>
    <color name="pe_widget_accent">#2E6BE6</color>
    <color name="pe_widget_warn">#B45309</color>
    <color name="pe_widget_btn_primary">#2E6BE6</color>
    <color name="pe_widget_btn_primary_text">#FFFFFF</color>
    <color name="pe_widget_btn">#F1F5F9</color>
    <color name="pe_widget_btn_stroke">#E2E8F0</color>
    <color name="pe_widget_btn_text">#0F172A</color>
</resources>
"""

COLORS_NIGHT_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Dark theme. These are the values the widget previously hardcoded for every
     mode, so a dark-themed device sees exactly what it saw before. -->
<resources>
    <color name="pe_widget_bg">#141A26</color>
    <color name="pe_widget_stroke">#26314A</color>
    <color name="pe_widget_eyebrow">#7C8AA5</color>
    <color name="pe_widget_title">#FFFFFF</color>
    <color name="pe_widget_body">#A9B4C7</color>
    <color name="pe_widget_accent">#4F8EF7</color>
    <color name="pe_widget_warn">#F5A524</color>
    <color name="pe_widget_btn_primary">#2E6BE6</color>
    <color name="pe_widget_btn_primary_text">#FFFFFF</color>
    <color name="pe_widget_btn">#1E2736</color>
    <color name="pe_widget_btn_stroke">#2C3750</color>
    <color name="pe_widget_btn_text">#DDE4EF</color>
</resources>
"""

# ══ DYNAMIC COLOUR (MATERIAL YOU) ══
# The two palettes above are PlotEdge's own brand colours. They are correct on
# any device, but on a phone running Android 12+ every first-party widget on the
# home screen is tinted from the wallpaper — so a widget carrying fixed brand
# blue sits next to Clock, Weather and Calendar all sharing a palette, and reads
# as the one thing that does not belong. That is the complaint, and it is not a
# Pixel complaint: dynamic colour is part of AOSP from API 31, so Samsung One UI
# 4+, OnePlus, Xiaomi, Oppo and Motorola all do the same thing.
#
# Android exposes the wallpaper-derived palette as REAL COLOUR RESOURCES from
# API 31 — @android:color/system_accent1_600 and friends. That matters here,
# because RemoteViews cannot resolve theme attributes (?attr/colorPrimary) but
# it resolves @color and @android:color references perfectly well. So this needs
# no Java, no MaterialDynamicColors dependency, and no runtime branch: it is the
# same trick as values-night/, one qualifier further along.
#
# -v31 means a device below Android 12 never sees these files and falls back to
# the brand palette above, which is exactly right — the system_* resources do
# not exist there and referencing them would be a build-time link error on those
# devices' resource set.
#
# ── WHY THESE PARTICULAR SLOTS ──
# accent1 is the primary wallpaper hue, accent2 a desaturated companion, and
# neutral1/neutral2 the greys derived from it. The convention Android's own
# widgets follow is: surfaces from accent2/neutral at the light end, text from
# neutral at the dark end, and the one emphasis colour from accent1. The number
# is lightness, 0 (white) to 1000 (black), so the light and dark files are
# near-mirrors of each other.
COLORS_DYNAMIC_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Android 12+ light. Wallpaper-derived; see the note in the patch script. -->
<resources>
    <color name="pe_widget_bg">@android:color/system_accent2_50</color>
    <color name="pe_widget_stroke">@android:color/system_accent2_100</color>
    <color name="pe_widget_eyebrow">@android:color/system_neutral2_600</color>
    <color name="pe_widget_title">@android:color/system_neutral1_900</color>
    <color name="pe_widget_body">@android:color/system_neutral2_700</color>
    <color name="pe_widget_accent">@android:color/system_accent1_600</color>
    <!-- Deliberately NOT wallpaper-derived. A warning that turns lilac because
         the user picked a purple wallpaper has stopped being a warning; amber
         is doing semantic work here, not decorative work. -->
    <color name="pe_widget_warn">#B45309</color>
    <color name="pe_widget_btn_primary">@android:color/system_accent1_600</color>
    <color name="pe_widget_btn_primary_text">@android:color/system_accent1_0</color>
    <color name="pe_widget_btn">@android:color/system_accent2_100</color>
    <color name="pe_widget_btn_stroke">@android:color/system_accent2_200</color>
    <color name="pe_widget_btn_text">@android:color/system_neutral1_900</color>
</resources>
"""

COLORS_DYNAMIC_NIGHT_XML = """<?xml version="1.0" encoding="utf-8"?>
<!-- Android 12+ dark. The mirror of the file above: surfaces move to the dark
     end of the neutral ramp and the accent moves to the light end, so contrast
     is preserved whatever hue the wallpaper produced. -->
<resources>
    <color name="pe_widget_bg">@android:color/system_neutral1_800</color>
    <color name="pe_widget_stroke">@android:color/system_accent2_700</color>
    <color name="pe_widget_eyebrow">@android:color/system_neutral2_300</color>
    <color name="pe_widget_title">@android:color/system_neutral1_50</color>
    <color name="pe_widget_body">@android:color/system_neutral2_200</color>
    <color name="pe_widget_accent">@android:color/system_accent1_200</color>
    <color name="pe_widget_warn">#F59E0B</color>
    <color name="pe_widget_btn_primary">@android:color/system_accent1_200</color>
    <color name="pe_widget_btn_primary_text">@android:color/system_accent1_900</color>
    <color name="pe_widget_btn">@android:color/system_accent2_700</color>
    <color name="pe_widget_btn_stroke">@android:color/system_accent2_600</color>
    <color name="pe_widget_btn_text">@android:color/system_neutral1_50</color>
</resources>
"""

WIDGET_JAVA = """package com.plotedge.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * Home screen widget showing PlotEdge capture status.
 *
 * Reads the summary index.html mirrors into Capacitor's Preferences store (the
 * "CapacitorStorage" SharedPreferences file). Everything is defensive: a
 * missing key, malformed JSON, or a field of the wrong type all fall back to
 * the neutral "no project open" state rather than throwing, because an
 * exception here shows the user a permanently blank grey box that only a
 * re-add of the widget clears.
 */
public class PlotEdgeWidget extends AppWidgetProvider {

    private static final String PREFS = "CapacitorStorage";
    private static final String KEY = "plotedge_widget";
    public static final String ACTION_REFRESH = "com.plotedge.app.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) render(ctx, mgr, id);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (ACTION_REFRESH.equals(intent.getAction())) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PlotEdgeWidget.class));
            onUpdate(ctx, mgr, ids);
            // Keep the 2x1 tiles in step - otherwise tapping Refresh on the big
            // card leaves a small one beside it showing stale numbers.
            int[] small = mgr.getAppWidgetIds(new ComponentName(ctx, PlotEdgeWidgetSmall.class));
            if (small.length > 0) {
                ctx.sendBroadcast(new Intent(ctx, PlotEdgeWidgetSmall.class)
                        .setAction(PlotEdgeWidgetSmall.ACTION_REFRESH));
            }
        }
    }

    private void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.plotedge_widget);

        // Named `summary`, not `s`: this method already declares a
        // `StringBuilder s` further down when it assembles the stats line, and
        // a second `s` in the same scope is a compile error.
        Summary summary = readSummary(ctx);
        String project = summary.project;
        int features = summary.features, inProgress = summary.inProgress;
        int unsynced = summary.unsynced, projectCount = summary.projects;

        if (project == null || project.length() == 0) {
            v.setTextViewText(R.id.widget_project,
                    projectCount > 0 ? "No project open" : "No projects yet");
            v.setTextViewText(R.id.widget_stats,
                    projectCount > 0 ? projectCount + " project" + (projectCount == 1 ? "" : "s") + " on device"
                                     : "Tap to create one");
        } else {
            v.setTextViewText(R.id.widget_project, project);
            StringBuilder s = new StringBuilder();
            s.append(features).append(features == 1 ? " feature" : " features");
            if (inProgress > 0) s.append("  ·  ").append(inProgress).append(" in progress");
            v.setTextViewText(R.id.widget_stats, s.toString());
        }

        // The unsynced line is the whole reason to glance at this widget, so it is only shown
        // when it actually says something - a permanent "0 unsynced" is noise.
        if (unsynced > 0) {
            v.setTextViewText(R.id.widget_warn,
                    unsynced + " project" + (unsynced == 1 ? "" : "s") + " not exported yet");
            v.setViewVisibility(R.id.widget_warn, android.view.View.VISIBLE);
        } else {
            v.setViewVisibility(R.id.widget_warn, android.view.View.GONE);
        }

        // After the text is set: setTextColor on a view whose text is replaced
        // afterwards is not lost, but keeping the order obvious matters more.
        applyTheme(v, summary.theme, R.id.widget_root,
                new int[]{ R.id.widget_project },
                new int[]{ R.id.widget_stats },
                new int[]{ R.id.widget_eyebrow },
                new int[]{ R.id.widget_warn });

        v.setOnClickPendingIntent(R.id.widget_root, deepLink(ctx, "projects", 1));
        v.setOnClickPendingIntent(R.id.widget_capture, deepLink(ctx, "collect", 2));
        v.setOnClickPendingIntent(R.id.widget_map, deepLink(ctx, "review", 3));

        Intent refresh = new Intent(ctx, PlotEdgeWidget.class).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.widget_refresh,
                PendingIntent.getBroadcast(ctx, 4, refresh, flags()));

        mgr.updateAppWidget(widgetId, v);
    }

    /**
     * plotedge://<target> is caught by MainActivity's intent-filter and surfaced to the web app
     * as Capacitor's appUrlOpen, which does the actual navigating. Keeping the routing in JS
     * means the widget does not need to know anything about the app's screen structure.
     */
    private PendingIntent deepLink(Context ctx, String target, int requestCode) {
        return deepLinkFor(ctx, target, requestCode);
    }

    /** Shared with PlotEdgeWidgetSmall so both tiles route identically. */
    public static PendingIntent deepLinkFor(Context ctx, String target, int requestCode) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("plotedge://" + target));
        i.setPackage(ctx.getPackageName());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, i, flags());
    }

    /** Plain holder for the mirrored summary. */
    public static class Summary {
        public String project;
        public int features, inProgress, unsynced, projects;
        /**
         * The app's LIVE theme, resolved to ARGB ints by widgetThemeColors() in
         * js/04-store.js and mirrored here on every save.
         *
         * Null means "use the values/ and values-night/ colour resources", which
         * is what this widget did before it could follow the in-app theme, and
         * is still correct on a fresh install that has never saved anything.
         * Applying a HALF-resolved palette would mix app colours with resource
         * colours and match neither, so the JS side sends all of it or none.
         */
        public JSONObject theme;
    }

    /**
     * Reads the summary index.html mirrors into Capacitor's Preferences store.
     * Static and public because the 2x1 tile needs exactly the same numbers -
     * two independent readers would be two chances to drift.
     *
     * Never throws: a missing key, malformed JSON or a field of the wrong type
     * all return an empty Summary, which every caller already renders as the
     * neutral "no project open" state. An exception here would leave the user a
     * permanently blank grey box that only re-adding the widget clears.
     */
    public static Summary readSummary(Context ctx) {
        Summary s = new Summary();
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY, null);
            if (raw != null) {
                JSONObject o = new JSONObject(raw);
                s.project = o.isNull("project") ? null : o.optString("project", null);
                s.features = o.optInt("features", 0);
                s.inProgress = o.optInt("inProgress", 0);
                s.unsynced = o.optInt("unsynced", 0);
                s.projects = o.optInt("projects", 0);
                s.theme = o.optJSONObject("theme");
            }
        } catch (Exception ignored) {
            // Neutral state.
        }
        return s;
    }

    /**
     * Paints a RemoteViews with the app's own theme.
     *
     * ══ WHY THIS EXISTS ══
     * The widget already followed the SYSTEM light/dark setting, through the
     * values/ and values-night/ colour resources further up this file. That is
     * not the same thing as following the theme the user picked IN PlotEdge:
     * choose the light theme on a dark-set phone, or switch data domain and
     * change the accent, and the widget stayed on whatever the OS said - the one
     * tile on the home screen not matching its own app.
     *
     * RemoteViews cannot read the app's CSS, cannot resolve a theme attribute,
     * and runs in the launcher's process. What it CAN do is take literal colour
     * ints through setTextColor and the setBackgroundColor remote method, which
     * is what this does.
     *
     * setInt(id, "setBackgroundColor", c) rather than a drawable: a RemoteViews
     * cannot tint a shape drawable, so the rounded background loses its corners
     * when overridden this way. That is why only the leaf views are painted here
     * and widget_root keeps its @drawable/plotedge_widget_bg - the corners and
     * stroke stay, and the fill is the one thing that would clash.
     *
     * Silent no-op when theme is null. Never throws: an exception in a widget
     * update leaves a permanently blank grey box that only re-adding the widget
     * clears.
     */
    public static void applyTheme(RemoteViews v, JSONObject theme,
                                  int rootId, int[] titleIds, int[] bodyIds,
                                  int[] eyebrowIds, int[] warnIds) {
        if (theme == null) return;
        try {
            setColor(v, theme, "bg", rootId, true);
            for (int id : titleIds)   setColor(v, theme, "title", id, false);
            for (int id : bodyIds)    setColor(v, theme, "body", id, false);
            for (int id : eyebrowIds) setColor(v, theme, "eyebrow", id, false);
            for (int id : warnIds)    setColor(v, theme, "warn", id, false);
        } catch (Exception ignored) {
            // Partially themed is still readable; a crash is not.
        }
    }

    private static void setColor(RemoteViews v, JSONObject theme, String key, int id, boolean bg) {
        if (!theme.has(key)) return;
        int c = theme.optInt(key, 0);
        if (c == 0) return;   // 0 is fully transparent - never a colour we meant
        if (bg) v.setInt(id, "setBackgroundColor", c);
        else v.setTextColor(id, c);
    }

    /** FLAG_IMMUTABLE is mandatory from Android 12 (API 31); the constant exists from API 23. */
    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    /**
     * Redraw every PlotEdge tile on the home screen, both sizes, right now.
     *
     * ══ WHY THIS EXISTS ══
     * Android clamps updatePeriodMillis to 30 minutes, so a widget's own tick is
     * far too slow to reflect "I just switched project". The app writes fresh
     * numbers into SharedPreferences on every single save (publishWidgetSummary()
     * in js/04-store.js), so the DATA was never the stale part - only the drawn
     * tile was. Until now nothing told the tile to look again.
     *
     * MainActivity calls this from a SharedPreferences listener, which means the
     * home screen updates the moment the app saves anything: switch project,
     * capture a feature, run an export, and the tile behind the app is already
     * correct when you go back to it.
     *
     * Static and public so there is ONE redraw path. A caller that redrew only
     * the size it happened to know about is how the two tiles end up disagreeing.
     */
    public static void refreshAll(Context ctx) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            if (mgr == null) return;

            int[] large = mgr.getAppWidgetIds(new ComponentName(ctx, PlotEdgeWidget.class));
            if (large != null && large.length > 0) {
                ctx.sendBroadcast(new Intent(ctx, PlotEdgeWidget.class).setAction(ACTION_REFRESH));
            }
            int[] small = mgr.getAppWidgetIds(new ComponentName(ctx, PlotEdgeWidgetSmall.class));
            if (small != null && small.length > 0) {
                ctx.sendBroadcast(new Intent(ctx, PlotEdgeWidgetSmall.class)
                        .setAction(PlotEdgeWidgetSmall.ACTION_REFRESH));
            }
        } catch (Exception ignored) {
            // A widget refresh is never worth taking the app down for.
        }
    }
}
"""

WIDGET_LAYOUT = """<?xml version="1.0" encoding="utf-8"?>
<!-- Deliberately plain: widgets are re-inflated by the launcher process, which supports only a
     small subset of views, and any unsupported attribute silently yields a blank grey box. -->
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="14dp"
    android:background="@drawable/plotedge_widget_bg">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical">

        <TextView
            android:id="@+id/widget_eyebrow"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="PLOTEDGE"
            android:textColor="@color/pe_widget_eyebrow"
            android:textSize="10sp"
            android:textStyle="bold"
            android:letterSpacing="0.12" />

        <TextView
            android:id="@+id/widget_refresh"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Refresh"
            android:textColor="@color/pe_widget_accent"
            android:textSize="11sp"
            android:textStyle="bold"
            android:padding="4dp" />
    </LinearLayout>

    <TextView
        android:id="@+id/widget_project"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="6dp"
        android:maxLines="1"
        android:ellipsize="end"
        android:text="No project open"
        android:textColor="@color/pe_widget_title"
        android:textSize="16sp"
        android:textStyle="bold" />

    <TextView
        android:id="@+id/widget_stats"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="2dp"
        android:maxLines="1"
        android:ellipsize="end"
        android:text=""
        android:textColor="@color/pe_widget_body"
        android:textSize="12sp" />

    <TextView
        android:id="@+id/widget_warn"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="4dp"
        android:maxLines="1"
        android:ellipsize="end"
        android:text=""
        android:textColor="@color/pe_widget_warn"
        android:textSize="11sp"
        android:textStyle="bold"
        android:visibility="gone" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="10dp"
        android:orientation="horizontal">

        <TextView
            android:id="@+id/widget_capture"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:layout_marginEnd="6dp"
            android:gravity="center"
            android:paddingTop="9dp"
            android:paddingBottom="9dp"
            android:text="Capture"
            android:textColor="@color/pe_widget_btn_primary_text"
            android:textSize="12sp"
            android:textStyle="bold"
            android:background="@drawable/plotedge_widget_btn_primary" />

        <TextView
            android:id="@+id/widget_map"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:gravity="center"
            android:paddingTop="9dp"
            android:paddingBottom="9dp"
            android:text="Map"
            android:textColor="@color/pe_widget_btn_text"
            android:textSize="12sp"
            android:textStyle="bold"
            android:background="@drawable/plotedge_widget_btn" />
    </LinearLayout>
</LinearLayout>
"""

# ══ SMALL WIDGET (2x1) ══
# The 4x2 card is a lot of home screen to give up if all you want is the
# unsynced count. This is the same data at a glance: project name, one stats
# line, and the tile is a single tap into the app.
#
# ══ WHY IT NOW HAS A REFRESH CONTROL ══
# It shipped without one on the reasoning that at 2x1 "a tap target inside a tap
# target is a mis-tap generator". That reasoning was sound about a BUTTON and
# wrong about the outcome: the tile had no way at all to be brought up to date
# between Android's 30-minute ticks, so switching project in the app left the
# small tile showing the previous project's name until the next tick - which is
# the "widgets are not changing" report.
#
# The compromise is a refresh AFFORDANCE rather than a button: the eyebrow row
# ("PLOTEDGE" plus a small refresh mark on the right) is the tap target, and the
# rest of the tile keeps the whole-surface deep link. So the two targets are
# split along a line the eye can already see, and the small one sits in the
# corner furthest from where a thumb lands to open the app.
#
# The SharedPreferences listener in MainActivity (scripts/patch-android-ui.py)
# means this is now a backstop rather than the primary path - the tile updates
# on its own the moment the app saves. It stays because that listener only runs
# while the app process is alive, and a widget read hours later still wants a
# way to be told to look again.
WIDGET_SMALL_LAYOUT = """<?xml version="1.0" encoding="utf-8"?>
<!-- Same launcher-process constraints as the large layout: plain views only. -->
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/widget_small_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:gravity="center_vertical"
    android:padding="12dp"
    android:background="@drawable/plotedge_widget_bg">

    <LinearLayout
        android:id="@+id/widget_small_refresh"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical">

        <TextView
            android:id="@+id/widget_small_eyebrow"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="PLOTEDGE"
            android:textColor="@color/pe_widget_eyebrow"
            android:textSize="9sp"
            android:textStyle="bold"
            android:letterSpacing="0.12" />

        <!-- A mark, not a labelled button: "Refresh" in words does not fit a 2x1
             tile beside the brand without crowding both. The row around it is
             the tap target, so the glyph itself never has to be hit precisely. -->
        <TextView
            android:id="@+id/widget_small_refresh_icon"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="\\u21bb"
            android:textColor="@color/pe_widget_accent"
            android:textSize="13sp"
            android:textStyle="bold"
            android:paddingStart="8dp"
            android:paddingEnd="2dp" />
    </LinearLayout>

    <TextView
        android:id="@+id/widget_small_project"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="3dp"
        android:maxLines="1"
        android:ellipsize="end"
        android:text="No project open"
        android:textColor="@color/pe_widget_title"
        android:textSize="14sp"
        android:textStyle="bold" />

    <TextView
        android:id="@+id/widget_small_stats"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="1dp"
        android:maxLines="1"
        android:ellipsize="end"
        android:text=""
        android:textColor="@color/pe_widget_body"
        android:textSize="11sp" />
</LinearLayout>
"""

WIDGET_SMALL_INFO = """<?xml version="1.0" encoding="utf-8"?>
<!-- 2x1. minResizeWidth lets it be pulled wider without becoming a second copy
     of the large card - the layout just gets more room for the project name. -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp"
    android:minHeight="40dp"
    android:targetCellWidth="2"
    android:targetCellHeight="1"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/plotedge_widget_small"
    android:previewLayout="@layout/plotedge_widget_small"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal"
    android:widgetCategory="home_screen"
    android:description="@string/plotedge_widget_small_description" />
"""

WIDGET_SMALL_JAVA = """package com.plotedge.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * The 2x1 variant. Deliberately a thin shell: it reuses PlotEdgeWidget's summary
 * reader and its deep-link builder rather than duplicating the defensive JSON
 * parsing, so the two tiles can never disagree about what the device holds.
 */
public class PlotEdgeWidgetSmall extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "com.plotedge.app.WIDGET_REFRESH_SMALL";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) render(ctx, mgr, id);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent.getAction();
        // Also listens for the large tile's refresh so tapping Refresh on one
        // updates both rather than leaving them showing different numbers.
        if (ACTION_REFRESH.equals(action) || PlotEdgeWidget.ACTION_REFRESH.equals(action)) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            onUpdate(ctx, mgr, mgr.getAppWidgetIds(new ComponentName(ctx, PlotEdgeWidgetSmall.class)));
        }
    }

    private void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.plotedge_widget_small);
        PlotEdgeWidget.Summary s = PlotEdgeWidget.readSummary(ctx);

        if (s.project == null || s.project.length() == 0) {
            v.setTextViewText(R.id.widget_small_project,
                    s.projects > 0 ? "No project open" : "No projects yet");
            v.setTextViewText(R.id.widget_small_stats,
                    s.projects > 0 ? s.projects + " project" + (s.projects == 1 ? "" : "s") + " on device"
                                   : "Tap to create one");
        } else {
            v.setTextViewText(R.id.widget_small_project, s.project);
            StringBuilder line = new StringBuilder();
            line.append(s.features).append(s.features == 1 ? " feature" : " features");
            // At this size the unsynced count is the single most useful thing
            // the tile can say, so it displaces the in-progress count.
            if (s.unsynced > 0) line.append("  \u00b7  ").append(s.unsynced).append(" unsynced");
            else if (s.inProgress > 0) line.append("  \u00b7  ").append(s.inProgress).append(" in progress");
            v.setTextViewText(R.id.widget_small_stats, line.toString());
        }

        PlotEdgeWidget.applyTheme(v, s.theme, R.id.widget_small_root,
                new int[]{ R.id.widget_small_project },
                new int[]{ R.id.widget_small_stats },
                new int[]{ R.id.widget_small_eyebrow }, new int[]{});

        // ORDER MATTERS. The eyebrow row is registered FIRST and the root SECOND.
        // A RemoteViews click on a child only wins over one on its parent when
        // the child actually carries its own handler, so both have to be set and
        // the refresh row - the more specific view - has to be one of them.
        Intent refresh = new Intent(ctx, PlotEdgeWidgetSmall.class).setAction(ACTION_REFRESH);
        v.setOnClickPendingIntent(R.id.widget_small_refresh,
                PendingIntent.getBroadcast(ctx, 12, refresh,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        v.setOnClickPendingIntent(R.id.widget_small_root,
                PlotEdgeWidget.deepLinkFor(ctx, "projects", 11));
        mgr.updateAppWidget(widgetId, v);
    }
}
"""

WIDGET_INFO = """<?xml version="1.0" encoding="utf-8"?>
<!-- minWidth/minHeight target a 4x2 cell footprint, the smallest size this much text fits in.
     updatePeriodMillis is 30 minutes because Android silently clamps anything lower; the in-widget
     Refresh button covers the gap between ticks.
     previewLayout is API 31+. Below that the picker falls back to previewImage, and a provider
     with NEITHER renders as a blank tile in the picker on older launchers - which reads as "the
     widget isn't there". The launcher icon is not a pretty preview, but it is recognisable and
     always present, so it is the right floor. -->
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="110dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/plotedge_widget"
    android:previewLayout="@layout/plotedge_widget"
    android:previewImage="@mipmap/ic_launcher"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:description="@string/plotedge_widget_description" />
"""

WIDGET_BG = """<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="@color/pe_widget_bg" />
    <corners android:radius="20dp" />
    <stroke android:width="1dp" android:color="@color/pe_widget_stroke" />
</shape>
"""

BTN_PRIMARY = """<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="@color/pe_widget_btn_primary" />
    <corners android:radius="11dp" />
</shape>
"""

BTN_PLAIN = """<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="@color/pe_widget_btn" />
    <corners android:radius="11dp" />
    <stroke android:width="1dp" android:color="@color/pe_widget_btn_stroke" />
</shape>
"""

RECEIVER_LARGE = """
    <!-- PlotEdge home screen widget (injected at build time) -->
    <!-- exported MUST be true. An AppWidgetProvider is a BroadcastReceiver that the *system*
         (AppWidgetService, a different process) delivers APPWIDGET_UPDATE to. With
         exported="false" that broadcast is refused, and - the symptom people actually notice -
         the launcher's widget picker does not list the widget at all, so there is no way to add
         it to a home screen. The only thing reachable through this receiver is a redraw of a
         status card the user already chose to place, so there is nothing here worth closing off. -->
    <receiver
        android:name=".PlotEdgeWidget"
        android:label="@string/plotedge_widget_label"
        android:exported="true">
        <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            <action android:name="com.plotedge.app.WIDGET_REFRESH" />
        </intent-filter>
        <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/plotedge_widget_info" />
    </receiver>
"""

RECEIVER_SMALL = """
    <!-- 2x1 variant. Same exported=true reasoning as above: without it the
         launcher's picker will not list it. -->
    <receiver
        android:name=".PlotEdgeWidgetSmall"
        android:label="@string/plotedge_widget_small_label"
        android:exported="true">
        <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            <action android:name="com.plotedge.app.WIDGET_REFRESH_SMALL" />
        </intent-filter>
        <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/plotedge_widget_small_info" />
    </receiver>
"""

DEEP_LINK_FILTER = """
            <!-- plotedge:// deep links from the home screen widget -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="plotedge" />
            </intent-filter>
"""


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"  wrote {path}")


def main() -> int:
    if not MANIFEST.exists():
        print(f"ERROR: {MANIFEST} not found - run this after `npx cap add android`.")
        return 1

    write(JAVA_DIR / "PlotEdgeWidget.java", WIDGET_JAVA)
    write(JAVA_DIR / "PlotEdgeWidgetSmall.java", WIDGET_SMALL_JAVA)
    write(RES / "layout" / "plotedge_widget.xml", WIDGET_LAYOUT)
    write(RES / "layout" / "plotedge_widget_small.xml", WIDGET_SMALL_LAYOUT)
    write(RES / "xml" / "plotedge_widget_info.xml", WIDGET_INFO)
    write(RES / "xml" / "plotedge_widget_small_info.xml", WIDGET_SMALL_INFO)
    write(RES / "drawable" / "plotedge_widget_bg.xml", WIDGET_BG)
    write(RES / "drawable" / "plotedge_widget_btn_primary.xml", BTN_PRIMARY)
    write(RES / "drawable" / "plotedge_widget_btn.xml", BTN_PLAIN)
    # Written to a dedicated file rather than merged into the app's colors.xml:
    # Capacitor regenerates that one, and a name collision there would be a
    # build error rather than something we could resolve idempotently.
    write(RES / "values" / "plotedge_widget_colors.xml", COLORS_XML)
    write(RES / "values-night" / "plotedge_widget_colors.xml", COLORS_NIGHT_XML)
    # Same names again under -v31, so Android 12+ picks the wallpaper-derived
    # palette and everything older keeps the brand one. Four files, one set of
    # names, no runtime branch — the resource system does the choosing.
    write(RES / "values-v31" / "plotedge_widget_colors.xml", COLORS_DYNAMIC_XML)
    write(RES / "values-night-v31" / "plotedge_widget_colors.xml", COLORS_DYNAMIC_NIGHT_XML)

    # Description + label both live in strings.xml so the widget picker can show them.
    strings = RES / "values" / "strings.xml"
    if strings.exists():
        sx = strings.read_text(encoding="utf-8")
        added = []
        if "plotedge_widget_description" not in sx:
            sx = sx.replace(
                "</resources>",
                '    <string name="plotedge_widget_description">Capture status and quick actions</string>\n</resources>',
                1,
            )
            added.append("description")
        if "plotedge_widget_label" not in sx:
            sx = sx.replace(
                "</resources>",
                '    <string name="plotedge_widget_label">PlotEdge</string>\n</resources>',
                1,
            )
            added.append("label")
        if "plotedge_widget_small_description" not in sx:
            sx = sx.replace(
                "</resources>",
                '    <string name="plotedge_widget_small_description">Compact capture status</string>\n</resources>',
                1,
            )
            added.append("small description")
        if "plotedge_widget_small_label" not in sx:
            sx = sx.replace(
                "</resources>",
                '    <string name="plotedge_widget_small_label">PlotEdge (small)</string>\n</resources>',
                1,
            )
            added.append("small label")
        if added:
            strings.write_text(sx, encoding="utf-8")
            print(f"  added widget {' + '.join(added)} to strings.xml")
        else:
            print("  already present: widget description + label strings")
    else:
        print("  WARN: strings.xml not found - widget picker will show no description")

    xml = MANIFEST.read_text(encoding="utf-8")
    changed = False

    # Each receiver is checked and inserted independently. Testing for the pair as one unit was
    # the obvious shortcut and the wrong one: an android/ folder left over from before the 2x1
    # tile shipped already contains PlotEdgeWidget, so a combined check would fail, fall to the
    # else branch, and append BOTH receivers - leaving a duplicate .PlotEdgeWidget declaration
    # that fails the manifest merger.
    # The regex anchors on a name="..." boundary so ".PlotEdgeWidget" cannot match inside
    # ".PlotEdgeWidgetSmall".
    for cls, block in (("PlotEdgeWidget", RECEIVER_LARGE), ("PlotEdgeWidgetSmall", RECEIVER_SMALL)):
        if re.search(r'android:name="\.%s"' % cls, xml):
            # Self-healing rather than a bare "already present". A carried-over folder may still
            # hold the old exported="false" receiver, and that is precisely the state where the
            # widget silently never appears in the picker - so re-running has to correct it.
            fixed = re.sub(
                r'(<receiver\s+android:name="\.%s"(?:\s+[^>]*?)?)\s+android:exported="false"' % cls,
                r'\1 android:exported="true"',
                xml,
            )
            if fixed != xml:
                xml = fixed
                changed = True
                print(f"  repairing: {cls} was exported=false (would not appear in the picker)")
            else:
                print(f"  already present: {cls} receiver")
        else:
            if "</application>" not in xml:
                print("ERROR: no closing </application> tag - manifest looks malformed.")
                return 1
            xml = xml.replace("</application>", block + "</application>", 1)
            changed = True
            print(f"  adding: {cls} receiver")

    if 'android:scheme="plotedge"' in xml:
        print("  already present: plotedge:// deep link filter")
    else:
        # Attach the filter to MainActivity's own <activity> block. Anchoring on the LAUNCHER
        # filter's closing tag is what keeps it inside the right activity rather than landing in
        # whatever element happens to close first.
        m = re.search(
            r"(<intent-filter>\s*<action android:name=\"android\.intent\.action\.MAIN\"\s*/>\s*"
            r"<category android:name=\"android\.intent\.category\.LAUNCHER\"\s*/>\s*</intent-filter>)",
            xml,
        )
        if m:
            xml = xml[: m.end(1)] + DEEP_LINK_FILTER + xml[m.end(1) :]
            changed = True
            print("  adding: plotedge:// deep link filter")
        else:
            print("  WARN: could not find the LAUNCHER intent-filter - deep links NOT added.")
            print("        The widget will still render; its buttons just won't route.")

    if changed:
        MANIFEST.write_text(xml, encoding="utf-8")
        print(f"Patched {MANIFEST}")
    else:
        print("Manifest already up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
