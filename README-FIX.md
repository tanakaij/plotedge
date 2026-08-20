# PlotEdge — sheet header fix

Drop these four files over the same paths in `plotedge-main/`. No markup changes, no new
files, no build step. `npm test` → 450/450.

```
css/12-polish.css
js/21c-sheet-chrome.js
js/07-navigation.js
tests/survey.test.js
```

## Why the previous attempts didn't hold

The four symptoms weren't four bugs. `.sheet-head-bar` was `position:sticky` inside
`.modal-box`, and `.modal-box` was at the same time the rounded card, the scroll container,
a `will-change:transform` compositing layer, and a masked element (the corner-clip hack in
`05-components.css`). Every reported fault falls out of that one arrangement, so patching
them individually kept moving the problem:

| Screenshot | What you saw | Cause |
|---|---|---|
| Help & about | content painting above the sheet's own top edge | a sticky element promotes to its own layer; inside a rounded, transformed, masked scroller WebView stops clipping the layers scrolling behind it to the corner. The `mask-image` in `05-components.css` was already a failed attempt at this. |
| Go to | "Coordinate" sliced in half by the header | correct sticky behaviour that *looks* broken — `scrollFocusedIntoView()` uses `block:'center'`, and the box's `max-height` collapses when the keyboard opens |
| Settings | top of the "Appearance" card clipped | same |
| PlotArchive | title crammed against the copy | the bar's `margin:-22px -20px 18px` assumed `.modal-box`'s exact padding, and `.pa-controls` was a *second* sticky block offset by a JS-measured `--sheet-head-h` |

## What changed

**The sheet is three rows now.** `.modal-box` stops scrolling and becomes a flex column of
header / `.sheet-body` / action row. The body is the only scroller. Corner clipping goes
back to plain `overflow:hidden` on a rounded box, and the mask is switched off. Nothing is
pinned over anything, so nothing can overlap, escape, or collide. `.pa-box` already used
this exact pattern, so it's the codebase's own precedent rather than a new idea.

**The header follows the theme.** It was flat `var(--card-bg)` — identical to the sheet
under it. That's structural, not a wrong value: the six pillars override `--grad-1` and
`--accent-*` but never `--card-bg`, so it was the one surface in the app that *couldn't*
respond to a theme change. It's now an opaque `--card-bg` base under a `--sheet-head-tint`
accent gradient, tracking pillar and light/dark the way `header` and `.subpage-header` do.

## Two bugs found on the way, both fixed

1. **Every sheet had two close buttons in the browser.** `installModalCloseButtons()` defers
   to `DOMContentLoaded` when `readyState === 'loading'` — true in the app, so it ran *after*
   `normalizeSheetChrome()` and injected a `.modal-x` into all 30 sheets. Only
   `.modal-box:has(> .sheet-head-bar) > .modal-x{display:none}` was hiding it, i.e. it
   depended on `:has()` support. In the test harness scripts are appended after parse, so
   the order flips and the suite's existing `strayX` assertion passed for a bug that shipped.
   The new test reproduces the app's ordering explicitly (verified: it fails without the fix).
2. `markSheetScrollable()` measured `.modal-box`, which is no longer the scroller — it now
   measures `.sheet-body`, so the action row keeps its divider.

Nothing depends on `:has()` any more: `js/21c-sheet-chrome.js` sets a `has-sheet-chrome`
class, so an older field WebView can't silently fall back to the layout this replaces.

## Worth knowing

- `--sheet-head-h` is still published but nothing depends on it for correctness now; a stale
  value costs a few pixels of padding instead of hiding the top of a sheet.
- `#confirmModal` is still exempt, as before.
- All 30 sheets verified: header first, body second, action row last, close button right-most,
  no stray `.modal-x`, and re-running either pass in either order is a no-op.
