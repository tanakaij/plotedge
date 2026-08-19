# PlotEdge update

Drop these over your tree preserving paths. 40 files: 37 modified, 3 new.
`npm test` -> 442/442 passing (baseline was 418).

**New files**
- `js/03b-plotarchive.js` — the preset feature type library
- `css/11-plotarchive.css` — its styles (own file; 05-components.css is near the size limit)
- `tests/plotarchive.test.js` — 21 checks covering everything below

**Service worker bumped to v18.** Existing installs serve the old shell until it
activates: hard refresh, or close all tabs, on first load after deploy.

---

## 1. Symbology now reaches every surface

Four renderers were inventing their own colours and ignoring shape, line style
and fill:

| Surface | Was | Now |
|---|---|---|
| Collect shape preview | accent colour, solid, always filled, circle dots | type colour, dash, `fill:false`, point shape |
| Collect satellite map | hard-wired `--orange`, always filled | type colour, dash, fill; pins tinted to match |
| Review cards | text glyph | real `legendGlyphSvg()` symbol |
| Feature Types list | text glyph | real symbol per permitted geometry |

`featureTypeSymbol()` added to `js/02-state.js` so "did this surface honour
styling?" is greppable. A test asserts every map surface calls the accessors.

## 2. Project & Operational Status

Six rows, each with a subject glyph and a tone-derived verdict. Collapsed bar
carries the marks and a single verdict badge on the RIGHT, plus a tinted left
rail: green tick when clean, amber/red warning when not.

**The drag bug.** `dataset.dragged` was set after every drag but only cleared by
a click on the peek bar. The grab handle is not a button and fires no click, so
a drag started there left the flag set permanently and the NEXT REAL TAP was
swallowed. Now an expiring timestamp plus pointer capture. Regression test:
"a tap is never swallowed by a drag that has already finished".

`info` deliberately ranks level with `ok`, not between `ok` and `warn` — the
Working grid row is permanently informational, so ranking it higher would mean
the bar could never once show the tick.

## 3. PlotArchive

27 presets across 7 categories, each with a real schema. Search covers field
labels and choice values, so "serial" finds the water meter and "defect" finds
the pole. Rows expand to show fields before you commit; selecting and reading
are separate gestures. All-or-nothing add with rollback.

**Two entry points, because there are two moments:**
- Feature Types list -> `project` mode, picking creates types directly.
- Inside the feature type editor -> `editor` mode, picking FILLS THE OPEN FORM.
  Nothing is saved, `persist()` is never called, Save stays where it was. A name
  you already typed is kept.

Presets become ORDINARY feature types. A test asserts `archiveId` is never read
outside the library, so this cannot drift into being a mode.

## 4. Template project

Five types demonstrating required fields, skip logic, a calculated field,
per-vertex scope, a repeating group, barcode, outline-only fill, dashed/dotted,
and multi-geometry. Ships explanatory notes INSIDE the project, so they survive
a .plotpack handoff.

## 5. Import

PlotPack always worked but was described nowhere: the only relevant card was
headed "Import data" and said ".gpkg or .csv from QGIS, ArcGIS, or another field
app". Now a dedicated "Open a PlotPack" card naming both project and settings
packs. Both pickers still accept the format; the wizard renders into whichever
was used.

## 6. Wording

- **Glossary.** Added PlotArchive plus four names already shipping unexplained:
  PlotSeed, PlotBounds, PlotBank, PlotWords. The coverage test only scans
  index.html for visible text, which is how JS-rendered names slipped past.
- **PlotVault described the wrong module.** Its entry read "Photo storage. Where
  your photos are kept and backed up" — that is the device photo store.
  PlotVault reads reference layers off a bucket over HTTP range requests and
  cannot write anything. Its quick action also claimed "Push and pull this
  project against a shared cloud vault", a capability that does not exist. Both
  corrected and pinned by test.
- **GeoJSON import advertised but never implemented.** `handleImportFileChosen`
  accepts plotpack, csv and gpkg only. Corrected.
- **Help text** still claimed the .json backup was the only format that reads
  back in.

## 7. Em dashes removed from user-facing text

220 rewrites across index.html and 31 modules, punctuated contextually (comma,
colon, or full stop with capitalisation depending on what follows).

**Code comments were deliberately left alone** — they are written for whoever
maintains this, not shown to anybody.

**44 em dashes remain, all glyphs**: the no-data placeholder in every KPI and
coordinate box, and the icon on the Line geometry picker. Stripping those would
have blanked the GPS readouts. The rule is whitespace: `>—<` is a placeholder,
`</code> — compare` is prose. Two tests enforce both halves — no prose dashes
left, and the glyphs still present.
