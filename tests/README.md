# PlotEdge test suite

    node tests/run.js

No dependencies beyond `jsdom` (`npm i -D jsdom`). Eleven suites, 213 checks.

| Suite | What it holds the app to |
|---|---|
| `split` | Guards the multi-file layout: every file is linked and every link resolves, load order matches filename order, no orphans, the SW caches every asset, CI stages them, and **no load-time code reaches a name declared in a later file**. |
| `smoke` | **Boots the real app in a DOM** and fails if any script throws or the app fails to wire itself up. |
| `integrity` | Every inline script parses; the document parses; no `onclick` names a function that does not exist; no stale domain keys. |
| `store` | Executes the real store block from `index.html` in a VM against a fake `localStorage`. Corrupt data is quarantined not overwritten; no save may reduce what is on disk unless explicitly destructive; the rolling backup is restorable; a truncated write rolls back; the capture draft round-trips. |
| `nav-build` | Executes the real nav block. One Back press moves one screen after a realistic tab tour; identical stops are never stacked; an invisible overlay cannot swallow a press. Also asserts the APK is signed with a stable key and that `versionCode` increments. |
| `photo` | Runs the real capture pipeline against instrumented stubs and **counts concurrent decodes**. Ten photos must decode one at a time, every bitmap must be closed, object URLs must be revoked, the per-vertex cap must hold, and a photo that fails to save must be rolled back off screen. |
| `capture-stack` | Drives the pause/resume flow and the rotation compass in a real DOM. A road is started, paused, a traffic sign collected on top of it, and the road resumed — its vertices, attributes and photos must all come back, and the sign must never inherit them. Also asserts the compass turns a drag into a bearing *relative to where the drag started*, taps back to north and hides there, and draws nothing at all on a map that cannot rotate. |
| `theme` | Parses the stylesheet and **composites the rendered background** — canvas plus every blob at its real opacity and blend mode — then checks contrast and pairwise separation on the result. |

## Why the theme suite composites

Comparing design tokens is not comparing what the eye sees. Water, Climate and Geospatial once
passed a token-level hue test while still reading as one blue-purple family on a phone, because
the canvas dominates the screen area. `tests/lib.js` reproduces the actual paint and the suite
compares pillars on that.

It also enforces sunlight legibility the same way: body text must clear **7:1 against the worst
point of the mesh** in both themes, not against the flat canvas, because a blob can pool exactly
where a label sits.

## Editing the palette

`tests/palette.json` is the source the CSS was generated from. If you retune colours, keep it in
step — `THEMING.md` explains the constraints, and the suite will tell you which one you broke and
by how much rather than just failing.

## Why the photo suite counts things

Adding several photos to one vertex used to kill the app. Not an exception the
app could report — the Android WebView renderer being reclaimed by the OS,
because each photo was decoded at full resolution (a 12 MP bitmap is ~48 MB) and
the grid then held every one of them at 1200px to draw 90px thumbnails.

Those are memory facts, not code shapes, so the suite measures them: it stubs
`createImageBitmap` with a counter and asserts peak concurrency is 1, and it
asserts every bitmap that is opened is closed. A refactor that reintroduced
parallelism would still read fine and would still fail here.

## Why there is a smoke test

Splitting the app out of one file removed a safety net nobody had noticed. In a
single script every function declaration hoists to the top, so a statement near
the beginning could call a function defined ten thousand lines below it. Across
separate classic scripts that stops being true, and the failure is invisible to a
direct-reference check because the forward reference sits inside a function
*body*, two calls down from the statement that looked harmless.

`applyTheme(currentTheme())` in `js/01` did exactly that: it reached
`syncPlotLensEntry()` in `js/15`, threw `ReferenceError` on every launch, and took
the rest of `js/01` with it. Static analysis said the split was clean. Running it
took four seconds to disagree.

`split.test.js` now walks the call graph transitively to catch that class, and
`smoke.js` boots the whole app as a backstop. Keep both: the analyzer explains
*why* something will break, the smoke test proves whether it does.


## features.test.js

The only suite that **drives** the app rather than reading it. It boots the real scripts in a DOM
with a Leaflet stand-in that returns real numbers from `getZoom()`, `getBounds()` and
`latLngToContainerPoint()` — a permissive proxy would let a divide-by-proxy through the clustering
and density maths untouched.

It exists because of one bug class the static suites cannot see. The old full-screen map pinned
`.review-map-wrap` over the viewport and gave `#reviewMap` `height:100%` — but `#reviewMap` sits
inside an auto-height `div`, so the percentage resolved to zero and "expanded" rendered a blank
screen you could scroll past. Every static check passed. So this suite asserts the height chain
directly, opens PlotAtlas and counts what was drawn, and checks that no control shares a corner
with the zoom control.

It also covers the storage ceiling head-on: it builds 100 features x 7 vertices x 3 photos — the
load that used to fail on the third feature — and fails if the project store crosses 5 MB or if a
single `dataUrl` reaches it.


## Why the capture stack gets a driven suite

Switching feature type mid-capture used to parse fine, wire up fine, and silently
move a road's vertices onto the traffic sign you stopped to collect — because
`onFeatureTypeChange()` rebuilds the attribute panes and deliberately does not
touch `currentVertices`. Nothing static can see that: the shapes are all correct.
So `capture-stack.test.js` walks the actual field scenario and asserts on the data
that comes back out.

It reaches app state through `window.eval` rather than through `w.someGlobal`.
Top-level `let`/`const` in a classic script live in the global *declarative*
environment, not on `window`, so assigning `w.currentVertices` would create an
unrelated property and the suite would pass while testing nothing.

The compass half is there because the bug it guards was arithmetic, not structure:
leaflet-rotate's control called `setBearing(deltaX)` with the raw pixel delta as an
**absolute** bearing. A drag from 40° with 100px of travel has one correct answer,
and the test states it.
