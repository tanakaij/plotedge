# PlotEdge — update bundle (v3, supersedes v2)

Drop these ten files over the same paths in `plotedge-main/`. `index.html` untouched, no new
dependencies. **`npm test` → 599/599 passed** (577 before any of this).

| File | Fixes |
|---|---|
| `js/06a-capture-stack.js` | **The resume-capture nag** (new in v3) |
| `js/05a-plotbounds.js` | `NaN × NaN km`; the dead outlier check |
| `js/17e-plotair.js` | PlotAir not opening; sources; photo types; lost photo imports |
| `js/05-projects.js` | Data hub PlotAir row stuck on "Open a project first" |
| `js/21b-plotalert.js` | Notifications never delivered |
| `js/17b-plotpack.js` | Auto-scan finding nothing; the Restore-button file-picker ambush |
| `css/02-mesh.css` | Ambient gradient invisible outside the home screen |
| `tests/*` | 18 regression tests across three suites |

---

## The capture resume prompt (v3)

`offerResumeAfterSave()` raised a **blocking confirm after every single save** for as long as
anything sat on the capture stack — and declining did nothing to stop it. There was no `onCancel`,
so the refusal was invisible to the module and the identical dialog returned on the next save, and
the one after that, indefinitely. The only way out was to finish or discard the paused capture.

Pause a fence line, then collect a run of thirty poles: **thirty modal dialogs**, each asking a
question already answered "no" twenty-nine times.

Worse than annoying, it was self-defeating. A prompt that can't be dismissed for good stops being
read — people learn to tap past it without looking. That is precisely how a paused capture gets
forgotten, which is the failure the capture stack exists to prevent.

Now it asks **once per paused capture**. Decline it and it stays declined until the stack itself
changes. Nothing is lost: the resume bar is already on screen naming what's paused and offering
Resume in one tap. The bar is the persistent affordance; this dialog only ever needed to be the
introduction to it.

The memory resets whenever the question genuinely changes — pausing something new, resuming,
discarding, or opening another project. Five tests cover those, four of which fail against your
original code.

---

## Earlier fixes, recapped

**`NaN × NaN km`** — `haversineM` takes four scalars; `05a-plotbounds.js` passed it two objects at
five sites. The label was cosmetic, but the same bug made `outsideProjectBounds()` return `NaN`, so
`d > 1000` was always false and the confirm read *"NaN m outside the project area"*. **Your outlier
check had never graded a distance correctly.**

**PlotAir** — `renderDataHubScreen()` nulls `activeProjectId`, and PlotAir's guard read that exact
field, so navigating to the button cleared what the button checked. Unreachable by construction.
Behind it: `savedFeatures` and `featureTypes` are both per-project and empty from the hub, and
`plotairSources()` looked for `proj.boundary`, a key nothing ever writes (it's `proj.bounds`, a
rectangle). And **imported flight photos were silently discarded** — pushed to a detached array
that `persistStore()` doesn't write, while the toast claimed success.

**Notifications** — the preference defaulted on, but permission was only ever requested from the
Settings toggle, so a normal install could never deliver one. Also, the service-worker path tested
`navigator.serviceWorker.ready`, a promise that is always truthy and never settles when no worker
is registered — it reported success having delivered nothing.

**Auto-scan** — `readdir` ran without ever requesting `READ_EXTERNAL_STORAGE`, so every location
threw and the per-folder `catch { continue }` ate it as a missing folder.

**Restore button** — an empty scan closed the sheet, fired a toast and forced the OS file picker
open, on the common path. Now offers the picker on a "nothing found" step instead. Note this
inverted a deliberate, test-pinned decision; `restoreShowEmpty()` and that one assertion are the
whole change if you want it back.

## Sheet audit

All 32 `.modal-overlay` sheets: opener found, called, verified. 31 open; the 32nd (`bufferModal`)
correctly declines with "Select a sketch first". Every sheet is closable by Back through its own
named close. PlotAir was the only genuinely unreachable one.

## Still unverified

The ambient-gradient change (form band 0.28 → 0.50, settings 0.40 → 0.62; map stays 0) is the one
fix I could not run, since there's no browser in my environment. All 33 theme tests pass and the new
values sit under the home band the 7:1 sunlight floor is measured against. If the mesh is still
invisible, check `.mesh-bg { contain: strict }` against your WebView version.
