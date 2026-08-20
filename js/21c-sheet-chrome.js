// ══ SHEET CHROME ══
// One header, one close button, in one place, for all thirty sheets.
//
// ══ THE PROBLEM ══
// Sheet headings had drifted into four unrelated conventions — .modal-msg (11 sheets),
// .ft-picker-title (7), .modal-title (4), .sheet-head-title (3) — plus #inspectModal, which had
// no heading at all. Each class carried its own size, weight and margin, so the heading moved and
// changed shape depending on which sheet you opened.
//
// Worse, exactly one sheet in thirty (#plotvaultModal) had a close button. Everywhere else the
// way out was a Cancel or Done button of varying name, in varying position, sometimes below the
// fold — and on the three .sheet-head sheets the dismiss was the LEFT-hand button, which is the
// opposite corner from where it now lives.
//
// ══ WHY THIS IS DONE IN JS AND NOT IN THE MARKUP ══
// The obvious fix is to hand-edit thirty blocks of HTML. That was rejected for three reasons:
//
//  1. Sheet titles are written by id from JS all over the app — #attrStatsTitle, #ftFieldSheetTitle,
//     #attrSheetTitle, #plotarchiveSubtitle. Retyping thirty headers means thirty chances to drop
//     an id, and a dropped id is silent: the sheet opens with a stale title and nothing throws.
//  2. A markup pass fixes the thirty sheets that exist today and does nothing for the thirty-first.
//     This runs over whatever is in the DOM, so a sheet added next month gets the same chrome
//     without anybody remembering to add it.
//  3. It keeps the diff honest. The header is defined once here and once in css/12-polish.css,
//     rather than smeared across index.html where a future change means finding all thirty again.
//
// The pass MOVES each sheet's existing heading node into the new bar rather than replacing it.
// That is the detail that makes the whole approach safe: the node keeps its id, its class and its
// identity, so every getElementById that writes a title keeps hitting the same element.

// ══ WHAT THE CLOSE BUTTON DOES ══
// It calls closeTopOverlay() — the exact function the Android hardware Back button and the header
// back arrow already route through (js/07-navigation.js). That is deliberate and it is the reason
// this file needs no per-sheet registry of close handlers.
//
// closeTopOverlay() walks an ordered list of every sheet and calls that sheet's OWN named close —
// closeFtFieldSheet(false), closePlotArchive(), closeSettingsGroup(group) and so on — so each
// sheet's real cleanup runs: drafts discarded or preserved as that sheet has already decided,
// keyboards dismissed, pending confirm callbacks cleared. A generic `classList.remove('show')`
// here would skip all of it, and the failures would be quiet ones — a keyboard left up, a
// half-edited field neither committed nor discarded.
//
// The payoff is that X and Back can never disagree about what closing a sheet means, because they
// are the same call.

// Sheets whose first text node is NOT a title and must not be hoisted into a header bar.
// #confirmModal's .modal-msg is the confirm QUESTION — the whole content of the dialog. Promoting
// it into a header would put the question in 16.5px display bold on a tinted bar and leave the
// body empty, and a two-button decision does not need a dismiss affordance in a third corner.
const SHEET_CHROME_SKIP = new Set(['confirmModal']);

// Sheets with no heading node of their own, and the title to build one from. #inspectModal renders
// its whole body from JS and never had a heading; it is the one sheet where a title has to be
// supplied rather than moved.
const SHEET_CHROME_TITLES = { inspectModal: 'Feature details' };

// The four heading conventions, most-specific first. Only the FIRST match in a sheet is taken —
// several sheets contain nested elements that also match (a .modal-msg inside a card, an
// .atlas-bm-title inside the CRS picker), and hoisting one of those would gut the sheet's body.
const SHEET_CHROME_HEADINGS = ['.sheet-head-title', '.modal-title', '.ft-picker-title', '.modal-msg'];

// A subtitle line sitting directly under the heading — .modal-sub (Analytics, PlotMind, …) or
// #qaDrawerSub's "N more actions… · tap to run, or customise the grid below" (js/05-projects.js).
// Folded into the SAME header bar as the title rather than left as a second, separately-pinned
// element below it — two independently sticky pieces read as two headers stacked on top of each
// other, each with its own edge and background seam; one bar with two lines in it reads as one.
const SHEET_CHROME_SUBTITLES = ['.modal-sub', '.qa-drawer-sub'];

const SHEET_CLOSE_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

// Depth-limited on purpose. A heading is a direct child of .modal-box, or a child of a wrapper
// that is itself a direct child (the .sheet-head row). Anything deeper is content, not chrome —
// that is the rule that stops the CRS picker's inner .atlas-bm-title being mistaken for the
// sheet's own heading.
function findSheetHeading(box){
  for (const sel of SHEET_CHROME_HEADINGS){
    for (const el of box.children){
      if (el.matches(sel)) return el;
      if (el.classList.contains('sheet-head')){
        const inner = [...el.children].find(c => c.matches(sel));
        if (inner) return inner;
      }
    }
  }
  return null;
}

// Only counts a subtitle that is the heading's OWN immediate next sibling in .modal-box's flow —
// never something merely nearby. That is what stops, say, PlotArchive's .pa-controls block (a
// search field + chips, not a caption) from being mistaken for one, and it is also why this only
// runs for a heading that is itself a direct child of box (the three-sheet Cancel/Title/Done case,
// where heading lives inside .sheet-head, has no comparable "next sibling" to check).
function findSheetSubtitle(box, heading){
  if (heading.parentElement !== box) return null;
  const sib = heading.nextElementSibling;
  if (!sib) return null;
  return SHEET_CHROME_SUBTITLES.some(sel => sib.matches(sel)) ? sib : null;
}

function buildSheetClose(){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sheet-close';
  btn.setAttribute('aria-label', 'Close');
  btn.innerHTML = SHEET_CLOSE_SVG;
  // Not an inline onclick: this element is built here, so the handler belongs here too. Routed
  // through closeTopOverlay() so the X and the hardware Back button are literally the same path.
  btn.addEventListener('click', () => {
    if (typeof closeTopOverlay === 'function') closeTopOverlay();
  });
  return btn;
}

// Applies the standard chrome to one .modal-overlay. Idempotent — a sheet that already carries a
// bar is left alone, so this can be re-run after any markup is injected without stacking headers.
function applySheetChrome(overlay){
  if (!overlay || SHEET_CHROME_SKIP.has(overlay.id)) return;
  const box = overlay.querySelector(':scope > .modal-box');
  if (!box || box.querySelector(':scope > .sheet-head-bar')) return;

  let heading = findSheetHeading(box);
  const oldHead = heading && heading.parentElement.classList.contains('sheet-head')
    ? heading.parentElement : null;

  if (!heading){
    const title = SHEET_CHROME_TITLES[overlay.id];
    if (!title) return;              // nothing to label it with; leave the sheet exactly as it is
    heading = document.createElement('div');
    heading.textContent = title;
  }

  // Found BEFORE the heading is moved anywhere — findSheetSubtitle reads its live position in box.
  const subtitle = findSheetSubtitle(box, heading);

  const bar = document.createElement('div');
  bar.className = 'sheet-head-bar';

  // MOVED, not cloned and not rebuilt. The node arrives with its id and its class intact, so
  // #attrStatsTitle and friends keep resolving to the same element and every renderer that writes
  // a sheet title by id carries on working with no change.
  heading.classList.add('sheet-head-name');

  // Title and subtitle share one wrapper so they read, and pin, as a single header — not two
  // separately-sticky elements stacked with a seam between them. #attrStatsTitle-style ids stay on
  // the nodes themselves (only their parent changes), so nothing that writes a title or subtitle by
  // id elsewhere in the app needs to change.
  const textWrap = document.createElement('div');
  textWrap.className = 'sheet-head-text';
  textWrap.appendChild(heading);
  if (subtitle){
    subtitle.classList.add('sheet-head-desc');
    textWrap.appendChild(subtitle);
  }
  bar.appendChild(textWrap);

  // ── The old .sheet-head row ──
  // Three sheets had Cancel | Title | Done. The X now does what the left-hand button did — and it
  // does it through closeTopOverlay(), which for these sheets resolves to closeFtFieldSheet(false)
  // / closeFtSubfieldSheet(false) / closeAttrSheet(), i.e. the same call that button made. So the
  // left button is dropped as a duplicate and the primary is promoted into the bar.
  if (oldHead){
    const primary = oldHead.querySelector('.sheet-head-btn.primary');
    if (primary){
      primary.classList.remove('sheet-head-btn', 'primary');
      primary.classList.add('sheet-head-action');
      bar.appendChild(primary);
    }
    oldHead.remove();
  }

  bar.appendChild(buildSheetClose());

  // A pre-existing .modal-x would now be a second close button in a different corner.
  const strayX = box.querySelector(':scope > .modal-x');
  if (strayX) strayX.remove();

  box.insertBefore(bar, box.firstChild);

  // ══ FIX: SECOND STICKY BLOCK COLLIDING WITH THE HEADER ══
  // Some sheets (PlotArchive's search+chips row, .pa-controls) pin their own control block with
  // `position:sticky; top:0` INSIDE this same scroll container. Before this bar existed that was
  // fine — there was nothing else at top:0 to collide with. Now there is: two independent
  // top:0 sticky elements in one scrollport both try to occupy the same pixel, and the header
  // (higher z-index) wins, so the second block gets pinned right underneath it and its top ~50px
  // renders hidden/clipped behind the header the moment the sheet scrolls. That is the "header is
  // cutting off the modal" bug.
  // Measuring the real, just-inserted bar height (rather than hardcoding a number) means this
  // keeps working if the header ever grows a subtitle line, wraps a long title, or its padding
  // changes — any of which would silently reopen the same collision if the offset were a fixed
  // guess in CSS. Consumed by css/12-polish.css as `top: var(--sheet-head-h, 52px)`.
  box.style.setProperty('--sheet-head-h', bar.offsetHeight + 'px');
}

function normalizeSheetChrome(){
  document.querySelectorAll('.modal-overlay').forEach(applySheetChrome);
}
