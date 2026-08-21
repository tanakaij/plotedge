# PlotEdge update — restore flow, PlotIn mode pass, linked features, PlotAir

Drop these over your tree preserving paths. **28 files: 23 modified, 5 new.**
`npm test` → **577/577 passing** (baseline was 471).

**Service worker bumped to v29.** This one **also changes `SHELL_ASSETS`**, unlike the
bumps before it, because PlotAir adds a new shipped file (`js/17e-plotair.js`) —
a file the app loads but the shell never cached is a file that is missing the
first time the device goes offline. Hard refresh, or close all tabs, on first
load after deploy.

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
- **The Collect cards themselves** — and this is the part that took two passes.
  The first version only textured the cards, at very low ink, on the theory that
  legibility beats visibility. That was the wrong call: at that strength the plan
  was not subtle, it was **absent**, and a faint pattern over an unchanged card
  still reads as the same card. Two things fixed it. The ink came up to a real
  blueprint strength — `soft-light` blends it *into* the surface rather than over
  it, so text on the card loses no contrast at any strength. And the card
  **surface tokens** themselves now shift indoors: cooler and bluer for the
  drafting-paper read, with the ambient lift dropped for a crisp inset hairline,
  because a drawing lies flat on a table and does not float. Because these are
  tokens, redefining them on the panel cascades to every card, input and
  sub-surface at once — the whole screen shifts rather than the cards
  individually. The luminance move is deliberately small and the hue move large:
  a card that gets much lighter or darker changes how every piece of text on it
  contrasts, which is not worth paying for atmosphere.
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

### And four more things that make it a mode, not a pattern

The texture said *inside*; nothing else on the screen did. These four were the
gap.

**The ambience is cooler and stiller.** The mesh is by far the largest coloured
thing on screen and it ran identically in both environments, so switching
changed the line work and left the atmosphere untouched. `--mesh-i` now drops to
roughly half what Collect already uses, the blobs slow again on top of the form
screen's existing slowdown — a moving light source is a window or the sun;
indoors light does not travel — and a low-saturation blue-grey film pulls the
whole backdrop toward interior lighting. Deliberately a *neutral* film rather
than a hue rotation: rotating would fight the pillar, desaturating leaves its
identity intact.

**The GPS row stops being the headline.** PlotIn never gated capture on a fix,
but the screen never said so: `.gps-bar` kept its full size, its 36px ring, its
accuracy readout and its "Tap Start to begin", and the PlotIn note was added
*above* it. The largest element in step 2 was the outdoor instrument sitting on
top of a sentence explaining it wasn't needed — a screen arguing with itself, and
the instrument wins because it's bigger. The two now swap weight. Nothing is
hidden: GPS genuinely works near a window, and the row restores to full strength
the moment it has something real to say (`.gps-ring.good` / `.acquiring`).

**The dock reports a floor, not a fix.** Outdoors that line is accuracy — the
number that decides whether the next tap is worth making. Indoors there is no
fix, so it read "GPS off" permanently: a dead status in the one piece of chrome
on screen for the whole session. It now carries `Level 2 · NORTHWOOD-A`, floor
first, because the floor is the field that's wrong when something is wrong.
Capture forty vertices believing you set Level 1 when you set Level 2 and the
survey is silently wrong, with no geometry cue to catch it the way a bad fix
betrays itself outdoors. Unset, it says so — as a prompt, not an error, and
never as a modal.

**The environment toggle looks like a mode switch.** Two bare text pills,
visually identical to the geometry toggle in the schema editor, despite being the
one control on Collect that changes how capture works. Now an icon (open sky with
a horizon / building elevation), the name, and a second line stating the
*consequence* — "PlotIn" says nothing about what changes; "Indoors · plan" does.

Collect's cards also square off one step down the radius scale while indoors — a
rounded card reads as *app*, a squarer one reads as *drawing*. A step **within**
the four-step scale, not a fresh number; `theme.test.js` enforces that and
rightly.

---

## 3. Reference IDs are identifiers, so they have to be unique

`ref` is described on the Collect form as *"matches your other app's ID"* — its
whole job is to tie a feature to the same asset in another system. Nothing
enforced that. Two features could both carry `POLE-014` and the app would save
both without a word.

That is not the same mistake as two features sharing a *name*. A duplicate name
is untidy and occasionally deliberate, which is why that check asks rather than
refuses. A duplicate ref makes the register **ambiguous**: a join against the
other system now matches two rows, and there is nothing left in the data to say
which one was meant. It surfaces months later, in front of someone who cannot
ask the crew which pole they were standing at.

**Still a warning, not a block.** Refs legitimately arrive pre-printed and
occasionally duplicated on the asset itself, and a crew standing in front of a
stencilled tag that genuinely reads `POLE-014` twice must be able to record what
is there — refusing the save would mean the true state of the world cannot be
entered, which is the wrong end to be strict at. The prompt names the other
feature, which is the part that matters: it turns *"that's a duplicate"* into
*"that's the one I did on Tuesday"*.

Environment-agnostic by construction. `ref` is a plain field on every feature and
uniqueness is scoped to the project, so a sink captured in PlotIn and a pole
captured in PlotOut are covered by the same rule without either mode knowing
about it.

### The bug this surfaced

Adding the check broke an existing capture-stack test, and it was right to.

`generateReferenceId()` was *saved features of this type + 1* — correct only
while exactly one capture is in flight. The capture stack exists precisely so it
is not: pause a road to record the side road crossing it, pause that to record a
sign, and three captures are open at once. **None of them is saved yet, so all
three autofilled the same number.** Three features shipped as `ROAD-002`.

Nothing caught it, because a duplicated ref still looks like a ref.

The counter now takes the first number nobody is using — checked against what is
saved, what is parked on the stack, and what is in the form right now. Ordinary
projects number exactly as before; it only diverges where a collision would
actually have happened.

### Why this and not nested features

The question that prompted it was whether a sink inside a bathroom, or a
transformer on a pole, should be stored *inside* its parent. It should not. The
sink is an asset with its own identity, condition and replacement cost — nesting
makes it reachable only by walking its parent, which breaks the query you run
most (*every sink in the building, worst condition first*) to gain one you can
get by grouping. Flat rows with a pointer express the same containment and
survive every export format; nesting has no representation in GeoJSON, CSV or
shapefile and has to be flattened at each hand-off.

That relationship is capturable **today**: add a `Parent ref` field to the
feature types that need it and pin it with PlotSeed, which already carries values
forward and marks them as inherited. Nothing needs building for that.

What *did* need building is this. A pointer is worth nothing if the thing it
points at is not unique — so unique refs are the prerequisite either way, and
they earn their place on their own merits regardless of whether a model-level
parent field ever follows.

---

## 4. Linking one feature to another

A sink in a bathroom. A transformer on a pole. A valve in a chamber. Same
relationship, and all of it was *already* recordable — type the parent's
Reference ID into an ordinary text field.

That is exactly the problem. A typed ref is a pointer with no spell-check.
`ROOM-04` for `ROOM-004` orphans the fixture, nothing objects, and it is found
months later by whoever is joining the register against another system.

**New field type: "Link to another feature."** Same stored value — the parent's
ref, a plain string — but the crew *picks* it from the refs already in the
project. You cannot mistype a value you selected. In the schema editor it takes
a **Points at** setting naming which feature type it may link to, so the picker
offers the four Rooms on this floor rather than every feature in the project.

### Why a field type and not a parent column on every feature

Because the value stays a string, **nothing downstream changes shape**. The
review table, the attribute query engine and every export path read it through
the generic attribute route with no knowledge that link fields exist — so
`"Room ref" = 'ROOM-004'` works in the Review query box today, and the value
lands in GeoJSON, CSV and your asset management system as a normal column. No
plotpack format bump, nothing permanent to regret: delete the field from the
schema and the project is back where it started.

It is also **not nesting**, deliberately. The fixture stays its own feature, its
own row, its own record with its own condition and replacement cost. Storing it
inside its parent would make *every sink in the building, worst condition first*
a tree walk instead of a filter — and that is the query that actually gets run.
Flat rows with a pointer express the same containment and survive every export
format; nesting has no representation in any of them.

### And the parent can now see what points at it

A plain string only reads in one direction: open the sink and it names
`ROOM-004`; open `ROOM-004` and nothing said three fixtures were in it. The
feature inspector now lists everything pointing at the feature you have open,
grouped by the field carrying the link (a room pointed at by four fixtures *and*
one meter is two relationships, not a list of five), as tappable rows you can
open.

This is only possible **because the field type declares itself**. When it was an
ordinary text field, nothing distinguished a pointer from any other string on the
record — the app would have had to guess which values look like refs, which is
the kind of heuristic that works until somebody records a serial number.

### One ordering constraint worth knowing

Refs are assigned at capture time, so a link can only point at something already
captured. **Capture the room, then its fixtures.** Natural, but it is an
ordering, and the picker says so rather than just showing an empty list: *"Nothing
to link to yet — capture Room first, then come back."*

A link whose target is later deleted is **kept and flagged** (`no longer in this
project`) rather than silently dropped. Losing a recorded relationship because
the other end moved is worse than showing one that needs looking at, and the crew
is the only one who can decide which.

---

## 5. Two bugs the end-to-end sweep found

Everything above was tested per seam and passed. Walking the **whole** indoor job
in sequence — switch to PlotIn, trace a room, save it, capture a fixture inside
it, link the two, park one mid-capture, resume, re-open the room — found two
failures that were invisible in isolation. Both are now covered by
`tests/indoor-flow.test.js`.

**The indoor address was thrown away after every save.**
`resetCollectEnvironmentFields()` ran unconditionally on save, dropping back to
PlotOut with Building and Floor blank. Right for an explicit *clear this form*;
wrong for a save. A building visit is a sink, a toilet, a basin and a geyser —
all on Level 2 of NORTH-A — so it meant re-selecting PlotIn and retyping the same
address four times, and **every retype is a chance to type Level 1**. The address
now survives a save (opt-in at that one call site, so every other caller keeps its
old behaviour) and an explicit clear still clears.

This is the same reasoning PlotSeed applies to pinned attributes. The difference:
PlotSeed's carry-over is opt-in per field because it can hide an unobserved
answer. The indoor address cannot — the dock chip shows it continuously, so it
can never be inherited unnoticed.

**The dock froze silently.** The level chip cleared `#cdDot` from the DOM instead
of hiding it, so the *next* call resolved it to `null`, hit the guard at the top
of `updateCollectDockStatus()` and returned early. The dock then stopped updating
entirely — typing a floor, switching back to PlotOut, capturing a vertex — and
nothing threw. The dot is re-appended and hidden by CSS, with a comment marking
that as load-bearing.

---

## 6. Keeping the form light for a first-time user

The two-line environment switch is right at the moment the mode is being chosen
and wrong for every capture that will never change it. Most crews work outdoors
all day, and that control sits near the top of card 1 — so it was presenting a
decision to someone who does not have one to make, as the first thing they meet.

It now has two states. At rest in PlotOut it collapses to a single compact row
that reads as a setting already handled. It expands to the full two-line form on
focus or hover, and permanently whenever PlotIn is selected — where the screen
genuinely behaves differently because of it.

CSS-only and never `display:none`: both options stay in the DOM at full tap-target
size and stay reachable by keyboard and screen reader. This is a change of
emphasis, not availability — a mode switch that cannot be found is worse than one
that is merely loud.

**Net effect on a first run:** nothing else added. The link field is opt-in per
schema and the template project does not use one; Building/Floor still only appear
in PlotIn; the dock chip replaces the fix reading rather than adding a row; the
ref prompt only fires on a real clash, which collision-free autofill now makes
rare; and the linked-features list renders nothing when there are no links.

---

## 7. Two more bugs

**The indoor texture leaked onto the Welcome screen.** `updateIndoorTexture()`
gated on *PlotIn + the Collect tab*, and `getCurrentTab()` keeps reporting
`collect` after you leave the project — the tab stays where you left it, for when
you come back. So both conditions held on Welcome and Projects, and the indoor
floor plan painted over the landing screen's own contour texture. Two different
environments' artwork on one screen, and a landing screen that quietly changed
depending on what the last project happened to be doing.

Now three conditions: the treatment also requires `#view-app` to be the active
view, read off `.active` rather than tracked in a variable so it cannot drift
from what is on screen. And `activateView()` re-runs the check, because leaving a
project never went through the branch that did.

**Restoring the same backup twice made a silent second copy.** Restoring always
mints a fresh project id — that is deliberate, and it is why a restore can never
overwrite work. It is also exactly why a repeat restore was undetectable:
everything identifying the original had just been replaced.

Import now records `restoredFrom: { projectId, exportedAt, restoredAt }`
alongside the new identity, on both the `.plotpack` and `.plotedge.json` paths.
That supports three grades of answer, because they need three different
responses:

| Match | Meaning | Response |
|---|---|---|
| Same project **and** same export stamp | Literally the same file, twice | Primary becomes **Open "Ward 7"**; a second copy is demoted to the secondary button |
| Same project, different export | A later backup of something already here | Says so, primary action unchanged |
| Same *name* only | Two visits to one site | Nothing — this is ordinary |

Name is deliberately **not** a grade of its own. Two projects called Ward 7 are
normal, and treating that as a duplicate would refuse the most common case there
is.

Not blocked outright, either: a crew that wants a scratch copy to experiment on
should be able to have one, and refusing would be deciding something only they
can. The escape hatch is just no longer the button under your thumb.

The guard proved itself immediately — it fired inside `plotpack.test.js`, whose
earlier checks had already restored that exact bundle. That test now covers both
paths.

---

## 8. PlotAir — planning a drone flight

A new module, named to match the others and reachable from **Data → PlotAir**.
It turns a boundary this project already holds into a mapping flight, and
exports a KML (and a plain waypoint CSV) to open in whatever flight app you use.

Set the camera and the altitude and it reports **ground sample distance**, area,
line count, path length, air time, photo count and batteries — recomputing live
as you move the altitude, because that is how an altitude actually gets chosen.
There is also a solver in the other direction: say *2 cm/px* and it gives you the
height that delivers it, which is the right way round when the job has a
legibility requirement (a meter dial, a pole number) rather than a height limit.

### Three things it deliberately is not

**It does not fly the drone.** Manufacturer SDKs are native and need app-level
integration a WebView cannot reach; MAVLink needs USB or serial. No control, no
telemetry, no over-the-air upload.

**It does not process imagery.** Structure-from-motion is desktop or cloud work
by an order of magnitude.

**It has no ground control point workflow — on purpose.** GCPs are the obvious
drone feature and the wrong one at 3–5 m. A GCP at phone-GPS accuracy is *worse
than none*: it drags the photogrammetric solution away from where a good relative
reconstruction would have put it. There should be no GCP export here until there
is an RTK or PPK source. Flight planning has no such problem — the plan only has
to cover the polygon, the aircraft navigates on its own GNSS, and every real
flight carries buffer anyway — which is exactly why it is the drone work worth
building on this hardware.

### Some detail worth knowing

- **The boundary is one you already surveyed.** Any polygon feature, or the
  project's PlotBounds working area. Nothing is re-entered by hand — that is how
  a plan ends up covering somewhere slightly different from the survey.
- **Concave boundaries are clipped properly.** Even-odd scan-line clipping, so an
  L-shaped yard does not get flown as its convex hull. Tested: the L-shape plans
  12 ha and a shorter path than the 16 ha square that contains it.
- **Lawnmower, not deadhead.** Lines alternate direction so the aircraft turns at
  the end of each one. Turn distance is counted in the path length, because a
  tight spacing is exactly what multiplies turns.
- **Every parameter travels in the KML.** A file that says only where to fly is
  unreproducible six months later, and the first question anyone asks of imagery
  is what altitude and overlap produced it. The airspace caveat travels with it
  too.
- **It says what it does not know.** The sheet carries a warning, not a tooltip:
  this computes geometry and knows nothing about the airspace over the site, the
  height limits in force, or whose consent is needed.

### On the testing

`tests/plotair.test.js` checks the arithmetic against figures derived by hand,
not against the code's own output — a P4P at 100 m must give 2.74 cm/px, a 150 m
frame and 45 m line spacing at 70% side overlap. A wrong number here throws
nothing and looks fine; it is discovered after somebody has flown the site and
found the images will not reconstruct.

It also pins the mistake most likely to be made in this file: the shutter
interval must use the **along-track** frame dimension, not the across-track one.
Getting that wrong produces images that overlap sideways but not forwards, which
fails reconstruction while every number on the screen still looks plausible.

### The return leg: flight photos

PlotAir planned a flight and nothing came back. It does now — and the design is
shaped entirely by one number.

A 16 ha mission at these defaults is about **700 frames at 8–12 MB each: 6–8 GB.**
No amount of compression makes that something a phone app holds. So nothing here
copies a photograph.

- **It never reads a whole file.** EXIF lives in the APP1 segment at the head of
  a JPEG, so it slices the first 128 KB — `File.slice()` reads only that. Seven
  hundred photos costs tens of megabytes of reads instead of eight gigabytes.
- **It never decodes an image.** Drone JPEGs carry their own thumbnail in EXIF
  IFD1, and it is lifted as bytes. Decoding a 12 MP frame to a canvas 700 times
  would kill the app long before storage became the problem — this path never
  constructs an `Image` at all.
- **It thins on the way in.** A mapping flight is 80% overlap *by design* —
  consecutive frames are the same picture, because they are inputs to
  photogrammetry rather than documentation. One frame per N metres (default 20)
  is what a person actually wants to look at, and kept-versus-found is always
  reported so the thinning is never silent.

Roughly 15–25 KB per kept photo. The originals stay on the card, and the filename
travels with each record so the real frame can be found again.

**Altitude is recorded but never called elevation.** Some drones write height
above take-off, some write ellipsoidal height, and some put the absolute figure
in an XMP block this does not read. Horizontal position is dependable across
manufacturers; vertical is not, and labelling an unknown datum as elevation is
how a survey acquires a number nobody can defend later.

### The bug the EXIF tests found — twice

`plotairThinByDistance()` guarded with `isFinite(s.lat)`. **The global `isFinite`
coerces before testing, so `isFinite(null)` evaluates `isFinite(0)` — true.** A
photo the drone could not place passed every check and was positioned at 0°N 0°E,
in the Gulf of Guinea. It does not throw, it does not warn, and on a map centred
over the real site it does not even appear: the feature is simply somewhere else,
in the project, counted.

Every guard in PlotAir now goes through one non-coercing helper.

Sweeping for the same pattern found it a second time, pre-existing, in
`js/15-plotetch.js`: the GeoJSON importer filtered vertices the same way, so a
position of `[null,null]` — which bad exports do produce — would have landed a
sketch in the same place. Fixed with the same reasoning written next to it.

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
| `css/02-mesh.css` (2nd pass) | cooled + stilled mesh indoors; GPS row demotion; squarer Collect cards |
| `css/12-polish.css` (2nd pass) | the two-line environment switch; the dock level chip |
| `js/06-collect.js` | repaints the dock when the environment is switched |
| `js/22-boot.js` | the dock's PlotIn branch — level chip instead of fix quality — and live listeners on the two indoor fields |
| `js/06-collect.js` | the indoor address survives a save; the ref picker (feature and per-vertex scope); autofill counter skips refs held by saved features, parked captures and the live form |
| `js/11-features.js` | the ref-collision check on save, split out so it runs before the name check |
| `tests/capture-stack.test.js` | ten checks: ref collisions across parked captures, the prompt, empty refs, editing your own — plus the picker, flat storage, the back-reference list, the Review column, and dangling links |
| `js/02-state.js` | leaving a project clears the indoor treatment; the `feature_ref` field type, and its exclusion from repeat-group sub-fields |
| `js/03-schema.js` | the **Points at** control in the field editor |
| `js/16-geometry-math.js` | `featuresLinkingTo()` and the linked-features list in the inspector |
| `tests/indoor-flow.test.js` | **new** — the whole indoor job in sequence; found both bugs in §5 |
| `js/17-export.js` | the JSON restore path records the same provenance |
| `js/17e-plotair.js` | **new** — PlotAir: flight geometry, estimates, KML and CSV export, EXIF photo ingest, the sheet |
| `js/15-plotetch.js` | the same `isFinite` coercion bug in the GeoJSON importer |
| `tests/fixtures-exif.json` | **new** — JPEGs assembled byte by byte, both byte orders, known coordinates |
| `js/05-projects.js` | the PlotAir row on the Data hub |
| `js/21a-plotwords.js` | PlotAir's glossary entry |
| `tests/plotair.test.js` | **new** — the flight arithmetic, checked against hand calculations |
| `plotedge-sw.js` | v20 → v28, and `SHELL_ASSETS` gains the new file |
| `tests/plotpack.test.js` | the "one dispatcher" guard rewritten as an invariant; plus a real `.plotpack` driven end-to-end through the sheet |
| `tests/restore-sheet.test.js` | **new** — drives every step of the sheet, plus the PlotIn dock/toggle/GPS-row behaviour |
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

### On the two new runtime checks

`tests/restore-sheet.test.js` is a **runtime** suite on purpose. The failure it
exists to catch is a step that renders into nothing, and that never throws — it
just produces a screen with the wrong thing on it, which no amount of grepping
the source will notice. It drives every step, including the "cannot be dismissed
mid-write" invariant, against a JSON backup.

`plotpack.test.js` gains one more: the **same real bundle** its other checks
round-trip — real zip, real checksums, real photo bytes — driven through the
sheet rather than through `importPlotpackBundle()` directly. Every existing check
in that file asks *did the survey survive*; this one asks *did the person see
what happened*, which is the half that was broken. It asserts the Check step
writes nothing before you confirm, that the progress bar's total is the real
photo count (a bundle carrying two photos reporting "photo 1 of 1" is worse than
no bar), that the finished step's numbers come from the importer rather than
being guessed, and that the progress hook is detached afterwards — left attached,
the Import screen's own restores would report into a sheet that isn't on screen.
