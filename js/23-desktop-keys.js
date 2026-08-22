// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 23-desktop-keys.js — KEYBOARD SHORTCUTS (DESKTOP ONLY)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A desktop tool is judged within about a minute on whether the keyboard works. css/13-desktop.css
// took that as far as CSS can — focus is visible — and stopped there deliberately, because real
// shortcuts need a keydown handler and JavaScript is the one thing that CANNOT be contained by a
// media query. So it lives here instead, in its own file, behind its own gate.
//
// ══ WHY THE APK NEVER RUNS ANY OF THIS ══
// install() is the only thing this file does at load, and it returns before binding ANYTHING unless
// every one of these holds:
//
//   · html does not carry .native-android   — index.html sets this before first paint whenever
//                                             Capacitor reports Android. The build stating what it
//                                             is, not a heuristic.
//   · isNativeShell() is false              — js/07-navigation.js; true inside any Capacitor shell,
//                                             so this also covers a future iOS build.
//   · matchMedia('(hover:hover) and (pointer:fine)') — there is a real pointing device, i.e. a
//                                             laptop or desktop rather than a touchscreen.
//
// On the APK the function returns at the first check and NO event listener is ever registered.
// That is the important property: this is not "a handler that ignores phones", it is a handler that
// does not exist on phones. Nothing to fire, nothing to leak, nothing to slow the capture path.
// Verified by tests/desktop-keys.test.js, which boots the app with .native-android set and asserts
// that pressing every bound key does nothing at all.
//
// Width is deliberately NOT part of the gate, unlike the CSS. Someone with a mouse who has dragged
// the window narrow still has a keyboard and still expects it to work; the rail collapsing back to
// a phone layout is a visual question, not a reason to take their shortcuts away.
//
// ══ WHY NOT IN index.html ══
// The help sheet's markup is built here at runtime rather than added to index.html, so the APK's
// DOM is byte-identical to what it was before this file existed. Nothing to hide, nothing to skip
// over, no dead nodes in the tree on a device that can never show them.

(function () {
  'use strict';

  // ── The shortcut table ──
  // Single letters, no modifiers. Modifier combinations belong to the browser and the OS, and an
  // app that takes Ctrl+D or Ctrl+W away from someone is an app they distrust for the rest of the
  // session. Single keys are safe here because they only fire when nothing is focused for typing —
  // see shouldIgnore() below.
  // Keys are grouped so the help sheet can present them the way people actually think about them:
  // where am I going, what am I doing, how do I get out.
  var GROUPS = [
    { title: 'Go to', keys: [
      ['1', 'Dashboard',  function () { switchTabNav('dashboard'); }],
      ['2', 'Collect',    function () { switchTabNav('collect'); }],
      ['3', 'Review',     function () { switchTabNav('review'); }],
      ['4', 'Import',     function () { switchTabNav('import'); }],
      ['5', 'Export',     function () { switchTabNav('export'); }],
      ['P', 'Projects',   function () { showProjects(); }],
      [',', 'Settings',   function () { openSettings(); }]
    ]},
    { title: 'Do', keys: [
      ['/', 'Search features', focusReviewSearch],
      ['?', 'This list',       function () { toggleHelp(); }]
    ]},
    { title: 'Leave', keys: [
      ['Esc', 'Close the top sheet', null]   // handled by the existing listeners; listed for completeness
    ]}
  ];

  // Searching lives on Review, so pressing / from anywhere should take you there first rather than
  // silently doing nothing. The tab switch is synchronous but the panel paints after it, hence the
  // deferred focus.
  function focusReviewSearch() {
    try { switchTabNav('review'); } catch (e) { return; }
    setTimeout(function () {
      var el = document.getElementById('reviewSearchInput');
      if (el) { el.focus(); el.select(); }
    }, 60);
  }

  // ── When a keystroke is NOT a shortcut ──
  // The whole design rests on this being right. A single-letter shortcut that fires while somebody
  // is naming a feature would be far worse than having no shortcuts at all: it would move the
  // screen out from under them mid-sentence, and they would never trust the keyboard again.
  function shouldIgnore(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return true;   // belongs to the browser or the OS
    var t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return false;
  }

  // A sheet being open means the person is answering a question. Navigating out from under it would
  // leave the app in a state the sheet's own code never expected — half a restore, an unsaved
  // capture. Escape and ? still work, because those are how you LEAVE.
  function overlayOpen() {
    return !!document.querySelector('.modal-overlay.show');
  }

  // ══ THE HELP SHEET ══
  // Built from the same table that drives the handler, so the two can never disagree — a printed
  // shortcut list that has drifted from the real bindings is worse than none.
  var helpEl = null;
  var lastFocus = null;

  function buildHelp() {
    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'shortcutsModal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Keyboard shortcuts');

    var html = '<div class="modal-content" style="max-width:440px;">'
      + '<div class="modal-title">Keyboard shortcuts</div>';
    GROUPS.forEach(function (g) {
      html += '<div style="margin-top:14px;font-size:var(--text-2xs);font-weight:600;'
        + 'letter-spacing:0.06em;text-transform:uppercase;color:var(--text-tertiary);">'
        + escapeHtml(g.title) + '</div>';
      g.keys.forEach(function (row) {
        html += '<div style="display:flex;align-items:center;gap:12px;padding:6px 0;">'
          + '<kbd style="min-width:26px;text-align:center;font-family:var(--mono);'
          + 'font-size:var(--text-xs);padding:3px 7px;border-radius:var(--radius-xs);'
          + 'background:var(--surface-sunken);border:1px solid var(--card-border);'
          + 'color:var(--text-primary);">' + escapeHtml(row[0]) + '</kbd>'
          + '<span style="font-size:var(--text-md);color:var(--text-secondary);">'
          + escapeHtml(row[1]) + '</span></div>';
      });
    });
    html += '<div class="modal-actions" style="margin-top:18px;">'
      + '<button class="btn btn-outline" style="width:100%;" data-close="1">Close</button>'
      + '</div></div>';
    wrap.innerHTML = html;

    // Backdrop and Close both resolve to the same path, matching every other sheet in the app.
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap || (ev.target.dataset && ev.target.dataset.close)) closeHelp();
    });
    document.body.appendChild(wrap);
    return wrap;
  }

  function openHelp() {
    if (!helpEl) helpEl = buildHelp();
    lastFocus = document.activeElement;
    helpEl.classList.add('show');
    // Focus moves into the sheet so the next Tab lands inside it rather than continuing through the
    // page behind — the minimum a dialog owes a keyboard user.
    var btn = helpEl.querySelector('button');
    if (btn) btn.focus();
  }

  function closeHelp() {
    if (!helpEl) return;
    helpEl.classList.remove('show');
    // Focus returns where it came from, so Escape does not dump the user at the top of the document.
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function helpOpen() { return !!(helpEl && helpEl.classList.contains('show')); }
  function toggleHelp() { helpOpen() ? closeHelp() : openHelp(); }

  function handler(e) {
    if (shouldIgnore(e)) return;

    // Escape, in capture phase, before anything else looks at it. The sheet is created at runtime so
    // it is not in closeTopOverlay()'s stacking table (js/07-navigation.js) and could not be closed
    // by the existing handler; stopping propagation here keeps the two from both acting on one
    // press and closing two things at once.
    if (e.key === 'Escape' && helpOpen()) {
      closeHelp();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') return;   // the existing handlers own it — see js/12-review.js

    if (e.key === '?') { toggleHelp(); e.preventDefault(); return; }

    // Any other sheet is open: the person is mid-answer. Say nothing.
    if (overlayOpen()) return;

    var key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    for (var i = 0; i < GROUPS.length; i++) {
      var rows = GROUPS[i].keys;
      for (var j = 0; j < rows.length; j++) {
        if (rows[j][0] === key && rows[j][2]) {
          try { rows[j][2](); } catch (err) { console.warn('PlotEdge: shortcut failed', key, err); }
          e.preventDefault();
          return;
        }
      }
    }
  }

  function install() {
    // ── The gate. See the header. Every check must pass or nothing is bound at all. ──
    try {
      if (document.documentElement.classList.contains('native-android')) return false;
      if (typeof isNativeShell === 'function' && isNativeShell()) return false;
      if (!window.matchMedia) return false;
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
    } catch (e) {
      return false;   // anything unexpected in the gate means DON'T install
    }
    // Capture phase so Escape reaches this before js/12-review.js's document-level handler.
    document.addEventListener('keydown', handler, true);
    return true;
  }

  // Exposed for the test suite and for anything that wants to show the list from a menu later.
  window.desktopKeysInstalled = install();
  window.openShortcutsHelp = openHelp;
  window.closeShortcutsHelp = closeHelp;
})();
