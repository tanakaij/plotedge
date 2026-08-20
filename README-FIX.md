# PlotEdge — sheet headers, backup recovery, Welcome appearance

Drop these over the same paths in `plotedge-main/`. Includes the earlier header fix, so this
supersedes `plotedge-header-fix.zip`. `npm test` → **468/468** (was 448; 18 of the new ones are
a new suite, `tests/backup-scan.test.js`, wired into `tests/run.js`).

```
index.html
css/03-base.css          css/12-polish.css
js/05-projects.js        js/07-navigation.js
js/17b-plotpack.js       js/21c-sheet-chrome.js
tests/backup-scan.test.js  tests/survey.test.js  tests/run.js
```

---

## 1 · Sheet headers (from the previous round)

Unchanged from `plotedge-header-fix.zip` — the sheet is three flex rows (header / `.sheet-body` /
actions), nothing is sticky, the corner clip is plain `overflow:hidden`, the header carries a
themed accent tint, and the duplicate `.modal-x` injected on every sheet in the browser is gone.

## 2 · Backup recovery

**The scan can now find backups that arrived from somewhere else.** `findAllDeviceBackupFiles()`
read only `Documents/PlotEdge` and `Storage/PlotEdge` — i.e. only where PlotEdge itself writes — so
a `.plotpack` sent by WhatsApp, email or USB, sitting in `Download/`, produced "no backups found".
It now searches five locations, deduplicates across the overlaps, and carries a real path per entry
(`{name, dir, path, where, mtime, size}`) rather than reconstructing one from the filename.

Two caps keep it honest on a phone: `BACKUP_SCAN_MAX_ENTRIES` (1500 per folder — a Downloads
directory bigger than that is not hand-searchable either) and `BACKUP_SCAN_MAX_STATS` (40, since
`stat()` is a call per file and only pays for itself in a small folder).

**Scan and Restore are one row.** They were never peers — scanning is a shortcut for restoring, and
a reinstalling crew has no basis on which to choose. `welcomeRestore()` scans where it can, shows
what it finds, and otherwise opens the file picker, which reaches Drive, Downloads and the SD card.
An empty scan names the folders it searched and opens the picker anyway. On web it *is* the picker,
so the row that could previously only apologise is gone.

**Rows say what is inside them.** `peekBackupContents()` reads the project names and feature count
out of a `.plotedge.json` so a list of six exports isn't six guesses. Size-gated at 4 MB, and it
never opens a `.plotpack` — that's a zip, and JSZip would pull the whole archive, photos included,
into memory to read one manifest. Those rows show size and folder instead.

**Restoring a file twice is flagged.** Imports stay additive (`importOneBackupProject()` mints a
fresh id, nothing is overwritten) — `backupLooksAlreadyRestored()` just adds a note, since two
projects of one name can be legitimate.

The Data hub scan (`scanForBackupsManually`) gets all of the same.

## 3 · Welcome appearance

- **Recovery row is visually distinct.** All three rows were one shape; the restore row's icon tile
  now uses the accent tint `.install-banner-icon` already uses. On light themes that also fixes a
  real contrast problem — `#F1F5F9` tile inside a `#FFFFFF` card holding a `#64748B` glyph, on the
  theme meant for sunlight.
- **Spinner instead of a lying chevron.** The chevron promised "opens a screen"; the scan worked in
  place and rendered above the button. `.is-scanning` dims the row, blocks the tap, and spins in the
  trailing slot. The banner also gets `scrollIntoView` so the result is never off-screen from the
  control that caused it.
- **`#foundBackupBanner` no longer wears the install nag's clothes** — accent surface and a 4px
  accent left edge, so "your data is here" and "install this app" are told apart before either is read.
- **`.welcome-shell` uncentres when the projects list has rows** (`.has-projects`, set by
  `renderProjectsList()`). A centred flex column taller than its container overflows past the start
  edge where scrolling can't reach it, stranding the logo and New project above the top.
- **Light-mode logo halo.** It was `--accent-rgb-deep` at 0.38 — the darkest accent variant, blurred
  behind a logo on a near-white canvas. Light themes get the ordinary accent at 0.20 and a softer
  drop-shadow.
- **Compact density reaches these rows**, which it previously skipped entirely.

## Notes

- Your existing suite caught two of my mistakes (a class with no pressed state, and a function left
  unreachable). Both fixed rather than worked around.
- `manualScanWelcome()` is removed, not aliased — nothing called it once the rows merged.
- I still can't render here, so the light-theme colour judgements are read from tokens. Worth your
  eyes on the halo and the tinted tile across the six pillars before you ship.
