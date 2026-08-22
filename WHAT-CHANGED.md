# PlotEdge — update bundle (final)

Seventeen files. Drop them over the same paths in `plotedge-main/`.
**`npm test` → 630/630 passed** (577 at the start).

No new dependencies. `index.html` gains two `<link>`/`<script>` lines and nothing else.

---

## 1 · Bugs fixed

**`NaN × NaN km`** — `haversineM` takes four scalars; `05a-plotbounds.js` passed it two objects at
five call sites. The label was the visible symptom, but the same bug made `outsideProjectBounds()`
return `NaN`, so `d > 1000` was always false and the confirm read *"NaN m outside the project area"*.
**The outlier check had never once graded a distance correctly.**

**PlotAir could never open.** `renderDataHubScreen()` sets `activeProjectId = null` — leaving the
project is what "go to Data" means — and PlotAir's guard read that exact field. Navigating to the
button cleared what the button checked. Behind it: `savedFeatures` and `featureTypes` are per-project
and empty from the hub, `plotairSources()` looked for `proj.boundary` (a key nothing writes; it's
`proj.bounds`, a rectangle), and **imported flight photos were silently discarded** into a detached
array `persistStore()` never writes, while the toast claimed success.

**Notifications never fired.** The preference defaults on, but permission was only requested from the
Settings toggle — so a normal install could never deliver one. Also `navigator.serviceWorker.ready`
is a promise, always truthy, and never settles when no worker is registered: the old code reported
success having delivered nothing.

**Auto-scan found nothing.** `readdir` ran without ever requesting `READ_EXTERNAL_STORAGE`, so every
location threw and the per-folder `catch { continue }` ate it as a missing folder.

**The capture resume prompt was a nag loop.** A blocking confirm after *every* save while anything
sat on the stack, with no `onCancel` — so declining did nothing and it returned on the next save
forever. Pause a fence line, collect thirty poles, get thirty identical dialogs. Self-defeating: a
prompt you can't dismiss stops being read, which is how a paused capture gets forgotten — the exact
failure the stack exists to prevent. Now asks once per paused capture.

**The Restore button ambushed.** An empty scan closed the sheet, fired a toast and forced the OS file
picker open — on the *common* path. Now offers the picker on a "nothing found" step. This inverted a
deliberate, test-pinned decision; `restoreShowEmpty()` and that one assertion are the whole change if
you want it back.

## 2 · Desktop view (`css/13-desktop.css`, `js/23-desktop-keys.js`)

Direction: **instrument, not app.** The phone is for capture; the desktop is for reviewing four
hundred features. Signature is the rail as a levelling staff — a ruled edge with a graduation tick
per screen, the active one taking the accent.

- **Review is master–detail.** Sticky map in a right column, list scrolling past it. CSS Grid, so the
  DOM is untouched.
- **Rail, width, density, tabular numerals, hover, focus rings, themed scrollbars.**
- **Keyboard:** `1`–`5` tabs, `P` projects, `,` settings, `/` search, `?` help, `Esc` close.
- **Ambient mesh calmed and stopped** — on a 27" display a drifting wash behind a table of
  coordinates is the largest object in the room.
- PlotAtlas and PlotWords no longer paint over the rail.

**The APK cannot be affected.** CSS: four locks (`min-width:1024px`, `hover:hover`, `pointer:fine`,
`html:not(.native-android)`), any one sufficient. JS: `install()` returns before binding *anything* —
not a handler that ignores phones, a handler that doesn't exist on them. Delete both files and the
APK renders identically.

## 3 · Four bugs my own tests caught in my own work

Worth listing, because they're the argument for the tests existing:

1. **Dead selectors.** `.list-row`, `.feature-row`, `.stat-value`, `.mono`, `.modal-wide` — none
   exist. The density pass I'd called "the substance" did nothing.
2. **A malformed comment.** A stray `*/` split one comment into a closed comment plus raw prose
   sitting in the stylesheet as live CSS.
3. **A dead descendant selector.** `#panel-collect .field-row2` — both parts real, the combination
   matches nothing.
4. **A grid collision.** `#attrTableWrap { grid-column: 1 / -1 }` would have drawn the attribute
   table *on top of* the sticky map, because `setReviewView()` leaves the map visible in table mode.
   Grid allows overlap silently — no error, nothing in the console.

Each now has a test, and I verified each fails on purpose before shipping.

## 4 · What I did not do, and why

- **Touch targets stay 44px.** Buttons, fields and card interiors remain phone-sized. This is the
  largest remaining gap between this and software designed for a desk. It means editing every
  component's own stylesheet rather than the shell, which is a fork risk I wasn't willing to take
  without you seeing the current state first.
- **Content caps at 1180px**, so a 1920px monitor has dead space either side. Deliberate for text.
- **The capture form stays single-column.** Two columns break Tab order — Tab follows the DOM, so the
  form would read left-right visually and top-bottom by keyboard. On the screen where someone types
  survey data all day, that's worse than scrolling.
- **The attribute table doesn't take full width** — see the collision above. Doing it properly means
  hiding the map in table mode, which is a JS change, and the map is useful there.

## 5 · The one thing I could never verify

**There is no browser in my environment.** Every structural claim is proven by tests — gating,
selectors, load order, precaching. But **nothing here has been seen rendered.** That applies to the
ambient-gradient change, the rail graduations, and most of all the Review grid: a sticky item
spanning 99 rows is correct per spec and is still the riskiest thing I've written blind.

Open it on your monitor. If something looks wrong, trust your eyes over my account of it — and the
places to look first are `--tick-w` / `.nav-btn::before` for the rail, and the `#panel-review` grid
block for Review.
