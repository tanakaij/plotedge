# PlotEdge update

Drop these over your tree preserving paths. 16 files: 13 modified, 3 new.
`npm test` -> 448/448 passing (baseline was 442).

**New files**
- `css/12-polish.css` — the shared sheet chrome, plus the PlotArchive spacing fix
- `js/21b-plotalert.js` — major-events-only notifications
- `js/21c-sheet-chrome.js` — retrofits one header + close button onto every sheet

**Service worker bumped to v19.** Existing installs serve the old shell until it
activates: hard refresh, or close all tabs, on first load after deploy.

**Every file in this drop, with why it changed**

| Path | Why |
|---|---|
| `index.html` | new css/js tags; shade verdict badge; PlotArchive control block; Major alerts row |
| `css/03-base.css` | shade tone tints for every state; SVG glyph sizing |
| `css/12-polish.css` | **new** — sheet chrome + PlotArchive spacing + focus/scrollbar standardisation |
| `css/11-plotarchive.css` | *unchanged* — overridden from 12-polish.css by load order |
| `js/13-dashboard.js` | SVG tone + subject glyph tables, replacing the emoji |
| `js/21b-plotalert.js` | **new** — notification policy, delivery and throttle |
| `js/21c-sheet-chrome.js` | **new** — the header/close retrofit pass |
| `js/01-theme-and-settings.js` | syncs the Major alerts toggle when Settings opens |
| `js/17-export.js` | export clock, so a long export can report completion |
| `js/22-boot.js` | calls `normalizeSheetChrome()` and `plotalertInit()` |
| `plotedge-sw.js` | v18 -> v19; caches the three new files |
| `scripts/patch-android-ui.py` | `PlotEdgeNative` bridge, notification channel, widget mirror listener |
| `scripts/patch-android-manifest.py` | declares `POST_NOTIFICATIONS` |
| `scripts/patch-android-widget.py` | `refreshAll()`; refresh affordance on the 2x1 tile |
| `tests/survey.test.js` | updated emoji assertions; 4 new checks |
| `tests/android-patch.test.js` | 2 new checks for the widget push and the bridge |
| `CHANGES.md` | this file |

`css/11-plotarchive.css` is listed only to be explicit that it is **not** in the
drop: the PlotArchive fixes live in `12-polish.css`, which loads after it, so the
original file is untouched and the two can be reasoned about separately.

---

## 1. The status shade no longer uses emoji

The four verdict glyphs and the six subject glyphs are gone. They are stroked
24px SVGs now, on the same icon grid as the rest of the app.

The old comment in `js/13-dashboard.js` defended emoji on legibility grounds — a
shape carries severity where a 7px dot does not. That part was right. What was
wrong was emoji as the way to get it:

- They are the platform's artwork, not ours. Samsung, Pixel and a browser each
  draw them differently, so the one surface meant to read as a calibrated
  severity scale was the only surface whose appearance PlotEdge did not control.
- **They cannot take a colour.** An emoji is a full-colour bitmap glyph, so the
  green tick stayed green even on a warning row. That is why the CSS had to mute
  the marks with `filter:grayscale(1)` — a hack only needed because the glyph
  refuses to be styled.

Severity is still carried in the shape (tick / i / triangle / octagon are as
distinct as the emoji were) and now also in colour, because `currentColor`
finally flows into the glyph.

## 2. The collapsed bar shows live state

This was deliberate and documented: `ok` and `info` got no tint at all, on the
theory that "green is the ABSENCE of a mark".

The cost was a bar that, in the state it is in almost all of the time, looked
identical to an inert container. Nothing about it said it was reporting
anything, so there was no reason to believe it would notice a problem either. A
signal that only exists when things are wrong cannot be told apart from a signal
that is broken.

All three verdict tones now paint the rail. Separation is carried by
**intensity** rather than presence: `ok` gets a quiet 38%-alpha rail and leaves
the border alone; `warn` and `bad` get a full-strength rail, a tinted border and
coloured summary text. The bar always reads as live; only a problem is loud.

Every colour resolves through one pair of custom properties (`--shade-tint`,
`--shade-tint-rgb`) so a tone is defined once and the rail, border, marks and
badge cannot drift apart.

## 3. PlotArchive is no longer cramped

The subtitle, search field, category chips and result count were four
separately-margined rows, each tuned in isolation. Their combined height left
the list — the entire point of the sheet — opening about 90px tall on a short
phone.

- Search and chips are now one pinned control block under a single divider, so
  they stay put while results scroll beneath them.
- The count moved onto the chip row's baseline instead of claiming its own line.
- The list gets the space back, plus `min-height:180px` so a wrapped subtitle can
  never squeeze it down again.
- The expanded field list was indented to 44px to clear the checkbox above it,
  which left it in a narrow gutter. It gets the full width and a tinted well.

## 4. One header, one close button, on every sheet

An audit of all 30 `.modal-overlay`s found four competing heading conventions:

| Convention | Sheets |
|---|---|
| `.modal-msg` | 11 (also used for confirm *body* text) |
| `.ft-picker-title` | 7 |
| `.modal-title` | 4 |
| `.sheet-head-title` | 3 |
| nothing at all | 1 (`#inspectModal`) |

...and exactly **one** sheet in thirty had a close button. Heading size, weight
and spacing changed depending on which sheet you opened, and whether you could
dismiss one without hunting for its Cancel button was a coin flip.

`.sheet-head-bar` is now the only sheet header: accent-tinted background running
corner to corner, 800-weight display-face title, close button always on the
right. It is `position:sticky`, so a long sheet keeps its title instead of
scrolling it away into an unlabelled wall of controls.

**Why this is a JS retrofit and not 30 edited HTML blocks.** Sheet titles are
written by id from all over the app — `#attrStatsTitle`, `#ftFieldSheetTitle`,
`#attrSheetTitle`, `#plotarchiveSubtitle`. Retyping thirty headers is thirty
chances to drop one, and a dropped id is *silent*: the sheet opens with a stale
title and nothing throws. So `applySheetChrome()` **moves** each existing heading
node into the bar. It keeps its id, its class and its identity, so every renderer
that writes a title by id carries on working untouched.

**Why the X calls `closeTopOverlay()`.** That is the same function the Android
hardware Back button already routes through, and it walks an ordered list calling
each sheet's own named close — `closeFtFieldSheet(false)`, `closePlotArchive()`,
`closeSettingsGroup(group)`. So drafts are discarded or preserved as that sheet
already decided, keyboards get dismissed, pending confirm callbacks get cleared.
A generic `classList.remove('show')` would skip all of it, and the failures would
be quiet ones. X and Back cannot disagree, because they are the same call.

Two deliberate exceptions:
- `#confirmModal` is skipped — its `.modal-msg` is the confirm *question*, not a
  title, and a two-button decision does not need a dismiss in a third corner.
- On the three `Cancel | Title | Done` sheets the left button is dropped (the X
  makes the identical call) and `Done` is promoted into the bar.

## 5. Notifications, four events only

`js/21b-plotalert.js`. The test each event had to pass: would a crew member,
reading this on a lock screen in the rain, do something differently?

| Event | Fires when | Cooldown |
|---|---|---|
| Capture still open | backgrounded with live vertices or a paused capture | 30 min |
| Work not exported | backgrounded with features that never left the device | 12 h |
| Storage nearly full | at or above 90% | 3 h |
| Export finished | an export over 8s completed while backgrounded | none |

Rejected, with reasons recorded in the file so they do not get re-proposed: GPS
fix lost (constant under tree cover, which is surveying, not an incident),
feature saved (that is what toasts are for), sync available (offline is the
design point), and a daily "don't forget to export" nag.

**No new dependency.** `@capacitor/local-notifications` would have been the
obvious route. Instead this extends the `JavascriptInterface` MainActivity
already carries for the status bar — about forty lines of Java the build already
patches in, versus a Gradle dependency whose version has to track Capacitor's
across upgrades, for a feature that needs one call.

Three delivery paths, tried in order: `PlotEdgeNative.notify()` (APK), then
`registration.showNotification()` (installed PWA), then `new Notification()`
(browser). Silent no-op if none is available.

Policy is separated from delivery: `plotalertPending()` decides what should be
reported and touches nothing platform-specific; `plotalertDeliver()` owns whether
the OS drew it. Those are different questions and only the first is this app's
decision — which is also what makes the policy testable without asserting on
whether a given browser implements the Notification API.

Toggle: **Settings > Capture & export > Major alerts**, default on.

## 6. Widgets update when the app saves

The tiles read from SharedPreferences, which `publishWidgetSummary()` rewrites on
**every** save — so the data was never stale. What was stale was the drawn tile:
a widget only redraws on its own tick, and Android clamps that to a 30-minute
floor. Switch project, and the tile kept the old project's name for up to half an
hour.

Capacitor's Preferences plugin writes in the app's own process, so a plain
`OnSharedPreferenceChangeListener` in MainActivity sees every one of those writes
the instant it lands. Hearing it there and broadcasting a widget refresh closes
the loop with no custom plugin, no extra dependency, and no JS-side call that
could be forgotten at a new save site — it keys off the write itself.

The listener is held in a **field**, not registered as a lambda:
`SharedPreferences` keeps only a weak reference, so without a strong reference it
is collected at the next GC and the widget quietly goes stale again. That failure
is intermittent and looks exactly like the bug being fixed.

The 2x1 tile also gains a refresh affordance, which it shipped without. Rather
than a button — the original reasoning that "at 2x1 a tap target inside a tap
target is a mis-tap generator" was sound — the eyebrow row is the target, with
the rest of the tile keeping its whole-surface deep link. Two targets split along
a line the eye can already see, with the small one furthest from where a thumb
lands to open the app.

`POST_NOTIFICATIONS` added to the manifest patch (runtime-granted from API 33;
undeclared means `requestPermissions()` is auto-denied with no prompt, the same
failure already documented for GPS and camera).

---

## Tests

442 -> **448**, all passing. Six new checks:

- every sheet has the standard header, and the close button is the last child of
  the bar (structural, so an appended element breaks it rather than a CSS read)
- the chrome pass moves heading nodes rather than rebuilding them, asserted by
  the five ids that would silently resolve to nothing otherwise
- the close button actually dismisses, through the named close
- the alert catalogue stays at four events, respects the preference, and honours
  a cooldown that survives a relaunch
- the tiles are pushed an update, on the right SharedPreferences file, with the
  listener held in a field
- the native bridge is feature-detected in all three shells

The suite caught four things I would otherwise have shipped: a `--rs` variable
that does not exist, an off-scale `14px` radius, an unreachable
`plotalertExportFinished()`, and two em dashes in notification copy.

One test bug worth noting: an initial version compared `innerHTML` against the
raw path strings in `SHADE_TONES`. That fails, because serialisation rewrites
self-closing SVG tags into open/close pairs — it would have been comparing
against markup that never reaches the DOM. It asserts on the accessible label
instead, which is both stable and the thing a screen reader actually receives.

A design flaw the tests also surfaced: `plotalertOnBackground()` originally
returned "did the OS accept this notification", which made it untestable in jsdom
and conflated two separate questions. That is the split described in section 5.
