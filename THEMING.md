# PlotEdge — Theme System

Two independent axes plus an intensity band, all expressed as attributes on `<html>`:

| Attribute     | Values                                                                          | Owns                                        |
|---------------|---------------------------------------------------------------------------------|---------------------------------------------|
| `data-theme`  | `light` \| `dark`                                                                | Surfaces, text, contrast.                   |
| `data-domain` | `land` \| `water` \| `climate` \| `environment` \| `people` \| `geospatial`      | Accent family, ambient mesh, page canvas.   |
| `data-screen` | `home` \| `form` \| `map` \| `settings`                                          | Ambient mesh opacity and loop speed.        |

All twelve theme × pillar combinations are valid and are expressed by a single selector pair per
pillar, e.g. `html[data-domain="geospatial"]` and
`html[data-domain="geospatial"][data-theme="light"]`.

---

## The six pillars

| Key           | Name             | Identity                                   | Accent hue |
|---------------|------------------|--------------------------------------------|------------|
| `land`        | Earth & Land     | Ochre → gold, sand canvas                  | 70° / 46°  |
| `water`       | Water            | Ocean blue → sky, navy canvas              | 255° / 266°|
| `climate`     | Climate          | Violet → fuchsia, lilac canvas             | 322° / 325°|
| `environment` | Environment      | Emerald → lime, green canvas               | 163° / 167°|
| `people`      | People & Places  | Rose → magenta, pink canvas                | 13° / 14°  |
| `geospatial`  | Geospatial       | Cyan accent on **graphite**, plus graticule| 212° / 224°|

Hues are given dark / light.

### Why the previous five looked alike

Three failures compounding, all of them now covered by tests:

1. **Three greens and two blues.** `#10B981`, `#22C55E` and `#A3E635` are one colour at arm's
   length in daylight; so are `#38BDF8` and `#22D3EE`. Five names, two perceived palettes.
2. **Light mode had no palette at all.** Every light-mode block reset `--grad-1`/`--grad-2` back
   to the same `#F8FAFC`/`#E7EEF5`. Light mode is the *sunlight* mode — the one used on a survey —
   and in it the page base never moved between themes.
3. **The per-screen wash ignored the domain.** `#view-projects` and every `#panel-*` hardcoded a
   fixed sky-blue as the gradient's second stop, so the bottom-right half of the background was
   the same blue under all five themes.

Plus the light-mode glows were pastels — Survey's were `#E2E8F0` and `#CBD5E1`, literally greys
over a near-white base.

### What replaced it

Accents are spaced deliberately around the OKLCh wheel rather than picked by eye. Two rounds of
this were needed: the first attempt still had Water, Climate and Geospatial reading as one
blue-purple family on a phone, even though they passed a token-level hue test. The reason is that
**the canvas dominates the screen area, and comparing tokens is not comparing what the eye sees.**

So the tests now composite the actual background — canvas plus every blob at its real opacity and
blend mode — and compare pillars on the result. Three changes came out of that:

1. **Water moved out of cyan into ocean blue,** and Geospatial took the cyan. Cyan reads as an
   instrument HUD and navy reads as water, so this is also the better semantic fit.
2. **Geospatial's mesh went achromatic.** Its glows were carrying teal, which is what let it blur
   into both Water and Environment. Graphite mesh, cyan only in the accent and the graticule.
3. **Light-mode canvases roughly doubled in depth.** There was 12–13:1 of text headroom sitting
   unused, and a deeper tint is *more* legible outdoors, not less.

### Sunlight

Light mode is the mode used on a survey, and direct sun crushes low-contrast detail first. Two
constraints beyond the usual:

- **Body text clears 7:1 (AAA) against the worst point of the composited mesh**, in both themes —
  not against the flat canvas, because a blob can pool exactly where a label sits. This is what
  caught the blend-mode retune: the old blob opacities (0.75 / 0.70) were set for plain alpha
  stacking, and under `screen` they pushed the mesh to mid-luminance, dropping some labels to
  ~4.4:1. Legible indoors, gone in sun.
- **Every accent clears 3:1 against its own background** (WCAG 1.4.11, non-text UI). The capture
  button, the GPS ring and the active tab all depend on it. Deepening the canvases forced three
  accents one step darker to hold this.

### Geospatial

The only pillar with a texture as well as a palette, and the only deliberately **neutral** one. A
coordinate graticule (`--grain`, the same 64×64 tile `.has-graticule` already uses) is laid over
the ambient mesh, inverted on light. It sits behind every card and input, never under text, and is
suppressed on the map screen and in high-contrast mode.

Its canvas is graphite and its mesh is slate; the cyan appears only in the accent. That
black-panel-with-one-live-colour is the instrument read — a total station display, a CAD viewport
— and being the only achromatic pillar is precisely what keeps it distinct. The theme tests hold
it to that from both sides: its canvas chroma must stay below 0.030, and its accent chroma must
stay above 0.070, since with a neutral mesh the accent is the only thing carrying the palette.

### Migration

Devices in the field hold one of the old keys. `DOMAIN_ALIASES` in `css/01-tokens.css` maps them by
meaning, not by colour, and the same table is duplicated (deliberately, tiny) in the pre-paint
boot script because that runs before the main bundle exists:

| Old key    | Old name               | New key       |
|------------|------------------------|---------------|
| `default`  | Hydrology & Field      | `water`       |
| `forestry` | Canopy & Conservation  | `environment` |
| `agric`    | Precision Ag & Soils   | `land`        |
| `survey`   | Cadastral & Parcels    | `geospatial`  |
| `climate`  | Weather & Risk         | `climate`     |

Agriculture maps to Earth & Land rather than Environment: it was the soils pillar.

### Ambient character

Four blobs, not two: three left the middle third of a tall phone screen unlit, and the field broke
into separate smudges exactly where the eye spends most of its time.

The blobs use `mix-blend-mode` — `screen` on dark (they are glows: light adds), `multiply` on light
(they are pigment: light subtracts). Stacked alpha only averages toward the canvas, which gives
four separate smudges and a muddy middle; blending makes overlapping blobs produce genuinely new
colours. That is the difference between an ambient gradient and a coloured fog. Guarded by
`@supports`, with a plain-alpha fallback that reads flatter but never wrong.

The falloff is a four-stop radial rather than two, so no blob has a findable edge at any size, and
there is still no `filter: blur()` anywhere — a blurred layer is re-rasterised whenever its size
changes, which measurably froze scrolling on a field device.

The eight animation periods (34/41/47/43 s drift, 23/29/31/37 s breathe) are pairwise coprime, so
the blobs never resynchronise into a visible loop. Breathe floors sit at roughly 55% of each peak:
a blob that reaches zero reads as a light switching off, which is the opposite of ambient.

### Confirming a switch

Even with six well-separated palettes a change can land on a screen with almost nothing
accent-coloured in view (a long scrolled list, the map tab). `setDomainTheme()` (js/01-theme-and-settings.js) therefore plays a
single 900 ms `domain-bloom` swell of the mesh alongside the toast. It animates opacity on an
already-composited layer and nothing else, so it costs no layout and no paint, and it is disabled
under `prefers-reduced-motion`.

---

## Deviations from the original brief

Two, both deliberate. Everything else is implemented as specified.

**1. The domain lives on `data-domain`, not `data-theme`.**
The brief asked for `data-theme="default|forestry|…"` plus a `.dark` class. PlotEdge already
uses `data-theme` for light/dark, and that attribute is read by roughly 200 CSS rules, the
synchronous pre-paint boot script in `<head>`, `applyTheme()`, the Android status-bar bridge
(`AndroidChrome.setLightStatusBar`) and the PWA `theme-color` meta tag. Re-pointing all of that
at a `.dark` class would have been a large, high-risk rewrite with no visual difference in the
result. Splitting the two concerns onto two attributes gives the same expressive power.

**2. Four specified colours were moved or adjusted. Each was measured; see below.**

*Dark mode — canvas colours cannot be glow colours.* `#0B1B13` (Deep Timber), `#020617`
(Graphite Obsidian), `#1C1917` (Rich Soil) and `#0F172A` (Stratosphere) are all **darker than the
app canvas**. Rendered as blobs they composite to a 5–10/255 channel delta — invisible. They are
canvas colours, so that is where they now go: each becomes its domain's `--grad-1`, which makes
the whole dark screen carry the domain tone (a truer "Deep Timber" than an unseeable smudge), and
the lit tone of each specified pair becomes the blob. Every specified colour is still used.

*Light mode — three accents failed WCAG AA.* Light mode is the sunlight mode, so its contrast has
to be the strongest in the app. Button labels here are 13–16px bold, which does **not** qualify as
large text, so the threshold is 4.5:1.

| Domain | Specified | White label | Dark label | Resolution |
|---|---|---|---|---|
| forestry | `#15803D` | **5.02** ✓ | 2.97 | kept exactly |
| agric | `#65A30D` | 3.09 | **4.73** ✓ | kept exactly — `--text-on-accent` flips to `#1A2E05` |
| default | `#059669` | 3.77 | 4.02 | → `#047857` (5.48) |
| survey | `#0284C7` | 4.10 | 3.39 | → `#0369A1` (5.93) |
| climate | `#0891B2` | 3.68 | 3.64 | → `#0E7490` (5.36) |

The last three sit in a mid-lightness dead zone where *no* label colour reaches 4.5:1, so each
moves one step darker; hue is unchanged. Agric keeps its exact lime because flipping the label to
near-black passes — which is what a separate `--text-on-accent` token is for.
`--badge-text` is darker again in every domain, because it sits on a 14%-accent tint of white
that is nearly white; the accent itself would only reach ~3.2:1 there.

**All ten theme × domain combinations now pass AA** for button labels, badge text, body and
secondary text (4.5:1) and for accent-on-card and focus rings (3:1).

**3. The `default` domain keeps the app's emerald accent instead of `#0F172A`.**
The brief listed `#0F172A` as the light-mode primary for the default palette. In this app
`--accent-primary` is not only a button fill — it is also the active bottom-nav tab, the capture
button, the GPS-fix ring and every selected state. A near-black accent makes all of those read
as *disabled*, and it is the exact same value as `--text-primary` (`#0F172A`), so accent and body
text would become indistinguishable. `#0F172A` is still present as `--cta`, which is what the
high-contrast pill buttons already use. **The specified mesh colours for `default` are applied
as written.**

---

## Token contract

The brief's token names are declared as **one-directional aliases** onto the tokens the app
already uses. This matters: declaring them as a second independent set would mean every
component had a 50/50 chance of reading whichever one was stale after a retint.

| Brief token              | Aliases →                | Notes |
|--------------------------|--------------------------|-------|
| `--canvas-bg`            | `--bg-primary`           | |
| `--surface-card`         | `--card-bg`              | 100% opaque in light mode, on purpose — glare resistance |
| `--surface-modal`        | `--card-bg`              | |
| `--modal-backdrop`       | *(own value)*            | `rgba(0,0,0,0.65)` dark / `rgba(15,23,42,0.45)` light |
| `--text-primary`         | *(native)*               | |
| `--text-secondary`       | *(native)*               | |
| `--text-on-accent`       | `--on-accent`            | |
| `--primary-accent`       | `--accent-primary`       | |
| `--primary-accent-hover` | `--accent-hover`         | |
| `--border-subtle`        | `--card-border`          | |
| `--border-focus`         | *(own value)*            | Always the **brighter** end of the accent family — see below |
| `--badge-bg`             | *(own value)*            | `rgba(var(--accent-rgb), 0.14)` |
| `--badge-text`           | *(own value)*            | |
| `--glow-1` / `--glow-2`  | *(own value)*            | Mesh blobs |
| `--glow-3`               | `--accent-primary`       | Addition to the brief — see below |

Write aliases in one direction only (alias → existing token). Never the reverse.

**Why `--border-focus` is not just the accent.** A focus ring has a different job from a button
fill: it must be findable at arm's length in direct sunlight. It stays in the accent hue but is
never allowed to be the muted end of it, and its halo is 3.5px at 0.26 alpha rather than the
usual 3px at 0.18.

**Why `--glow-3` exists.** Two blobs on a large phone screen read as two distinct smudges rather
than a field. The third is always the active accent, which is what ties the background to the
selected domain.

---

## The ambient mesh

One fixed layer (`.mesh-bg` / `#meshBg`), rendered once for the whole app, sitting at
`z-index: -1` directly after `<body>`.

**Why `-1` and not `0`.** A positioned element at `z-index: 0` paints in step 8 of the CSS
painting order — *after* the in-flow content of every card and form field. It would cover the
app. `-1` places it above the canvas background but below all block backgrounds and inline
content, which is exactly the slot a background layer wants.

**Views are transparent.** `#view-app`, `#view-projects`, `#view-projectmgr` and every `#panel-*`
previously painted their own opaque `--app-gradient`. They are now `background: transparent`, and
the single mesh layer paints the gradient instead. Two useful consequences: the gradient no
longer repaints as each panel scrolls, and the blobs stay fixed relative to the screen rather
than scrolling away with the content. `html, body` keeps an opaque `--grad-1` so there is never
a white flash before the mesh paints, and so overscroll/rubber-band areas have a colour.

**Status washes moved to the root.** The offline wash (`--net-a`) already lived on `<html>`. The
GPS fix-quality wash (`--gps-a`) lived on `#panel-collect`, which is now transparent, so
`setGPSUI()` mirrors `data-gps` onto `<html>` as well. The panel attribute is still set, so
anything else reading it is unaffected.

### Performance

**The first implementation used `filter: blur(80px)` with `scale()` in the keyframes, as the brief
specified. That caused visible scroll freezing and was replaced.** A blurred layer is
re-rasterised whenever its rasterised size changes, and `scale()` changes it *every frame*; the
blur radius also inflates the layer bounds well past the element's own size, so on a 1080p
display this was a ~1500px surface being re-blurred continuously. Three of them.

The current implementation is compositor-only:

| Guard | Where | Why |
|---|---|---|
| `background: radial-gradient(… transparent 70%)` — **no `filter`** | `.mesh-blob` | The softness is baked into the paint, so the layer is rasterised once and thereafter only translated. Same look, zero per-frame filter cost. Serves the brief's stated performance requirement better than the technique it named. |
| Keyframes translate **only** — no `scale()` | `.mesh-blob` | Scaling changes a layer's rasterised size, which is exactly what forces the repaint. The "breathing" that `scale` provided is done with `opacity`, which is free on the compositor. |
| `transform: translateZ(0)` + `contain: strict` | `.mesh-bg` | The views above are transparent, so without this the browser cannot scroll the page as an opaque blit and repaints the full viewport every frame. **This pair is what actually fixes the scroll stutter.** |
| `will-change: transform, opacity` | `.mesh-blob` | The only two properties a compositor animates without touching layout or paint. |
| `@media (prefers-reduced-motion: reduce)` | mesh | Pauses drift, keeps colour. The palette is doing legibility work; only the motion is a luxury. |
| `html.native-android` | mesh | Now only *slows* the animation (52s/38s) rather than killing it. The blur that made a kill-switch necessary is gone. |
| `html[data-contrast="high"]` | mesh | Outdoor mode exists to make a screen readable in direct sun. An ambient wash is the first thing to go. |

### Two layers, not one

`.mesh-bg` carries the app's base gradient and is **always fully opaque**. Only the inner
`.mesh-blobs` wrapper responds to `data-screen`. Fading the whole thing — the first attempt —
also faded the base gradient, so Collect and Review lost the background the rest of the app has
and flattened to a single dead tone.

> **If you add a blurred surface**, route it through a `--glass-N` token — never a literal
> `blur()` value. The `html.native-android` block neutralises all of them in one place, and a
> hardcoded value silently reintroduces the Android-only compositor stall.

### Screen intensity

| `data-screen` | Opacity | Loop | Rationale |
|---|---|---|---|
| `home`     | 80% (62% light) | 25s | Nothing here is being read closely |
| `form`     | 28%             | 40s | An input under direct sun must not sit on a moving wash. Slowed as well as faded — peripheral vision catches fast motion even at low opacity |
| `map`      | 0%              | —   | A tint over satellite tiles is a data-accuracy problem, not a cosmetic one. You cannot judge crop stress or water colour through a green haze |
| `settings` | 40%             | 25s | Read, but not filled in |

Set explicitly from the navigation entry points, never inferred from a route string:

- `switchTab()` → `collect` = `form`, `review` = `map`, everything else = `home`
- `openPlotEtch()` → `map`; `closePlotEtch()` → `home`
- `openSettings()` → `settings`, and **restores the previous band on close** (otherwise closing
  the sheet over the Map tab would leave the mesh switched back on over the tiles)

---

## JavaScript API

```js
setThemeMode('auto' | 'light' | 'dark')   // existing — persists the MODE, so 'auto' keeps following the OS
setDomainTheme('forestry', true)          // second arg shows a toast; persists to plotedge_domain
setScreenState('map')                     // not persisted — always derived from navigation
currentDomain()                           // -> 'forestry'
currentScreenState()                      // -> 'map'
```

Both `data-domain` and the initial `data-screen` are applied in the synchronous pre-paint script
in `<head>`, for the same reason as the theme: resolving them after first paint gives a visible
flash of the wrong palette on every cold start.

`setDomainTheme()` reuses the `theme-switching` class for one frame. Without it, every
accent-coloured control animates its own transition independently and the swap arrives as a
ragged several-hundred-millisecond wash instead of a clean cut.

## Adding a seventh pillar

1. Add a `html[data-domain="x"]` block and its `[data-theme="light"]` partner in `css/01-tokens.css`,
   setting the accent family, `--glow-1`/`--glow-2`/`--glow-4` and `--grad-1`/`--grad-2`.
2. Add the key to `GIS_DOMAINS` in `js/01-theme-and-settings.js`, and to `VALID_DOMAINS` in the pre-paint boot script (still inline in `index.html`).
3. Add a swatch to `#domainGrid`.
4. Mirror the block into `theme-preview.html`.
5. Run `node tests/run.js`. The theme suite will fail if the new accent is within 25° of an
   existing one, misses 4.5:1, reuses a canvas, or has a monochrome mesh — which is the point.

## Files

| File | Role |
|---|---|
| `index.html` | The app. Tokens, mesh, components and helpers all live here |
| `theme-preview.html` | Standalone reference — not shipped, not loaded by the app. Palette review on a device without navigating the real app |
| `THEMING.md` | This document |
