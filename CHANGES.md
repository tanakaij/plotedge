# PlotEdge update — restore flow + PlotIn texture

Drop these over your tree preserving paths. **10 files: 9 modified, 1 new.**
`npm test` → **502/502 passing** (baseline was 471).

**Service worker bumped to v21.** No new shipped files, so `SHELL_ASSETS` is
unchanged — the bump exists only so installed copies stop serving the old shell.
Hard refresh, or close all tabs, on first load after deploy.

---

## 1. Restoring a backup is a sheet now, not a hole in the Welcome page

### What was wrong

There was no modal. Three entry points — the device scan, the OS file picker and
the boot-time "backup found" banner — each rendered the confirm step *into the
page*, in a hidden `<div id="foundBackupWizard">` sitting between the banner and
the New project button.

So picking a file made this appear inline, mid-screen, with no animation and
nothing dimmed behind it:

```
Home
1 features · 3 feature types · 0 photos
Exported 2026-08-20
This restores everything (schema, photos, per-vertex data and notes) into a
new project. Nothing already on this device is touched.
[ Restore as a new project ]
[ Cancel ]
```

…which then shoved **New project**, **Start from a template** and **Restore from
backup** down the screen. Two "Restore" affordances a few hundred pixels apart,
and no way to tell which one the buttons belonged to. It reads as the page
breaking rather than as a question being asked.

Underneath, each of the three paths re-wired those freshly-rendered buttons by
hand, which is how the three routes had drifted into behaving differently from
one another.

### What replaces it

One sheet — `#restoreModal` — running five steps, strictly one at a time:

| Rail | Step | What it shows |
|---|---|---|
| **Find** | Searching | live spinner naming the folders being scanned |
| **Find** | Choose | one tappable row per backup: what is inside it, its size, its date, where it is |
| **Check** | Confirm | project name, **counts as figures**, and the "into a new project, nothing is touched" promise |
| **Restore** | Restoring | determinate progress bar, real photo-by-photo count |
| **Restore** | Restored | what actually came back, plus *Restore another* when more were found |

The page behind never moves. The header, close button and scroll/action layout
all come from the existing shared sheet chrome (`js/21c-sheet-chrome.js`), so it
matches every other sheet in the app, and the X, a backdrop tap and the Android
hardware Back button all resolve to the same `closeRestoreModal()`.

### Things worth knowing

- **The sheet opens before the scan finishes.** A `readdir()` across five folders
  on a phone with a full Downloads directory is not instant, and the old
  behaviour — a row that quietly changed its subtitle, then made a banner appear
  *above* the button that had been tapped — is why a scan could look like a tap
  that did nothing.
- **A restore in flight cannot be dismissed.** Restoring is additive, so an
  interruption cannot corrupt anything, but it *can* leave a project holding half
  its photos with nothing on screen to say so. `closeRestoreModal()` refuses while
  a write is running, both buttons are hidden for the duration, and
  `closeTopOverlay()`'s last-resort sweep now honours that refusal too — it used
  to strip `.show` off any sheet it did not recognise, mid-loop.
- **JSON backups get a confirm step for the first time.** A `.plotedge.json` is
  additive and so has nothing destructive to confirm — but "nothing to confirm"
  is not "nothing to show", and on a fresh device this is the moment someone most
  needs to be told what they are about to get back. A toast after the fact is not
  that.
- **One dispatcher, enforced.** Every restore path calls
  `runPendingPlotpackImport()`, never `importPlotpackBundle()` directly. That is
  what keeps a settings pack from being read as a project pack, and it is now a
  static test rather than a convention.
- **Failures land somewhere.** Every rejection reaches a real error step with a
  way forward, instead of a toast on an unchanged screen.

---

## 2. PlotIn now feels like being inside a building

### What was wrong

Two things, and the second was the bigger one.

1. **It was not visible.** The texture was five stacked `linear-gradient`s making
   a small brick weave, painted in `--text-primary` at 0.09 alpha — a hairline in
   the same ink as the body text, at roughly 1.1:1 against the page. Below the
   threshold at which a repeating pattern registers at all.
2. **It had no coverage.** It lived on a single `z-index:-1` layer, and Collect is
   the most card-dense screen in the app. It painted *below* every opaque `.card`,
   so it only ever appeared in the ~16px gutters down the sides. Switching to
   PlotIn changed a strip of margin and nothing else.

### What replaces it

A purpose-drawn **architectural floor plan** — structural walls, two doorways with
their swing arcs, a stair run with a direction arrow, column squares, setout
stations and dimension lines with arrowheads. One seamless 240px inline SVG tile,
under 2 KB, no network cost. Under it, a 48px floor grid, so the walls read as a
surface you are standing on rather than a diagram floating in space.

Spread across three surfaces that together cover the screen:

- **The fixed layer** — accent-masked, exactly like the landing screen's contour
  texture, so it carries real chroma and tracks whichever pillar is active. Plus
  an overhead pool of light and an edge vignette, which is what actually sells
  "enclosed" before any line work is read.
- **Inside the Collect cards** — the same artwork, `soft-light`-blended into the
  card surface. This is the coverage fix: the cards that were hiding the texture
  now carry it. Blended rather than laid over, so the card stays one flat colour
  to the eye and nothing sitting on it loses contrast.
- **A one-shot reveal** on entering PlotIn — 620ms, `forwards`, then completely
  static. Collect stays the app's calmest screen (`data-screen="form"` dials the
  mesh down to 0.28 precisely so nothing moves behind someone typing a measurement
  under direct sun), but the change of environment is now *felt*, not just found.

**The ink is not just the accent.** On a light page, accent-at-low-alpha darkens,
which reads. On the dark theme it does the opposite — a dark accent over a
near-black page barely moves the luminance, which is the original "it's there but
you can't see it" complaint restated. So on dark the ink is the accent mixed
toward white: same hue, but lightening, which is the only direction that reads.
`color-mix()` with a plain `rgba()` fallback for any WebView without it.

Outdoor high-contrast mode strips all of it, same rule as the mesh.

---

## Every file in this drop, with why it changed

| Path | Why |
|---|---|
| `index.html` | `#restoreModal` markup + `#restoreWizardSink`; removed the inline `#foundBackupWizard` host |
| `css/01-tokens.css` | four new indoor tiles: `--indoor-plan-tile`, `--indoor-grid-tile`, `--indoor-plan-ink`, `--indoor-plan-ink-dark` |
| `css/02-mesh.css` | `.indoor-texture` rebuilt across three surfaces; the Collect-card coverage rule |
| `css/12-polish.css` | the restore sheet: progress rail, file rows, summary card, waiting/finished states |
| `js/07-navigation.js` | `closeTopOverlay()` routes the restore sheet through its own close, and the catch-all sweep honours a locked write |
| `js/17b-plotpack.js` | the whole restore sheet; determinate progress hook; three inline restore paths collapsed into one |
| `plotedge-sw.js` | v20 → v21 |
| `tests/plotpack.test.js` | the "one dispatcher" guard rewritten as an invariant rather than a pattern count |
| `tests/restore-sheet.test.js` | **new** — boots the real app and drives every step of the sheet |
| `tests/run.js` | registers the new suite |

### On the rewritten test guard

The old static check counted `confirmBtn.onclick = async () => {…}` rewire
blocks and required at least three. Those blocks only existed *because* three
paths each rendered the legacy wizard inline and then patched its buttons — they
are gone, so counting them would be checking for a pattern that no longer exists
and would pass trivially forever.

What actually has to stay true is the reason it was written: a `.plotpack` can be
a project pack **or** a settings pack, and only `runPendingPlotpackImport()`
looks at which. So the guard now asserts the invariant itself — exactly one
caller of `importPlotpackBundle()`, and it is the dispatcher.

`tests/restore-sheet.test.js` is a **runtime** suite on purpose. The failure it
exists to catch is a step that renders into nothing, and that never throws — it
just produces a screen with the wrong thing on it, which no amount of grepping
the source will notice.
