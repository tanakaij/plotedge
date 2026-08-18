
// PlotEdge — PlotWords: making the Plot* names learnable without renaming them
//
// ══ THE PROBLEM THIS SOLVES ══
// PlotEdge's modules carry their own names — PlotEtch, PlotAtlas, PlotMind and the rest. That is
// deliberate and worth keeping: the names are distinctive, they make the app feel like one product
// rather than a pile of features, and a crew that uses them daily says "send me the PlotPack"
// rather than "send me the export bundle". A brand that people actually speak is not something to
// throw away for the sake of a first-run experience.
//
// But a name is only an asset once you know what it means, and until then it is a wall. Somebody
// opening the app for the first time meets eleven proper nouns and cannot tell which one draws a
// shape and which one shows a map. "PlotEtch snapping" tells a new surveyor nothing about what it
// snaps to.
//
// So: keep every name, and make each one explain itself the first time it is met. Three layers,
// in descending order of how much work they do:
//
//   1. A one-line strip the FIRST time a module is opened, dismissed per module. This carries most
//      of the weight because it arrives at the exact moment somebody is looking at the thing and
//      wondering what it is — which no amount of documentation elsewhere can match.
//   2. Descriptor subtitles wherever a name appears as a button or tile, permanently.
//   3. A glossary screen listing every name, for whoever dismissed a strip and forgot.
//
// ══ WHY NOT TOOLTIPS ══
// There is no hover on a phone, and a long-press hint is undiscoverable — you have to already
// suspect there is something to find. The strip is unmissable once and gone forever after, which
// is the correct trade for a thing you need to be told exactly once.

// ══ THE VOCABULARY ══
// One entry per name. `short` is the subtitle that sits under a button, kept to about four words
// so it fits a tile. `long` is the strip and glossary sentence: plain English, no GIS vocabulary
// that itself needs explaining, and it says what the thing DOES rather than what it is.
//
// Written for somebody who has never used a GIS. "Draw features by tapping the map" rather than
// "vector digitizing over a raster basemap" — if a descriptor needs its own descriptor it has
// failed.
const PLOTWORDS = {
  plotetch: {
    name: 'PlotEtch',
    short: 'Draw on the map',
    long: 'Draw features by tapping the map, for things you can see but cannot walk to — the far side of a river, a roof, the middle of a dam. Sketches have no GPS accuracy, so send one to Capture and save it there to make it a real feature.',
    open: 'openPlotEtch'
  },
  plotatlas: {
    name: 'PlotAtlas',
    short: 'Full-screen map',
    long: 'The full-screen map. Everything you have captured, with measuring tools, layer switching and the ability to tap any feature to see its details.',
    open: 'openPlotAtlas'
  },
  plotmind: {
    name: 'PlotMind',
    short: 'Ask about your data',
    long: 'Ask questions about your survey in plain language — "how many poles are missing photos", "which features were captured on Tuesday" — and get an answer without building a query.',
    open: 'openPlotMind'
  },
  plotvault: {
    name: 'PlotVault',
    short: 'Photo storage',
    long: 'Where your photos are kept and backed up. Shows how much space they are using and lets you free some up without losing the survey.',
    open: 'openPlotVault'
  },
  plotlens: {
    name: 'PlotLens',
    short: 'Replay as a slideshow',
    long: 'Plays your photos back in the order you captured them, so a site walk becomes a slideshow you can narrate and show a client.',
    open: 'showPlotLens'
  },
  plotin: {
    name: 'PlotIn',
    short: 'Indoor capture',
    long: 'Indoor capture. GPS does not work reliably inside a building, so instead of waiting for a fix you tap your position on a satellite image or a floor plan. Needs a building and floor to be set.'
  },
  plotout: {
    name: 'PlotOut',
    short: 'Outdoor capture',
    long: 'Ordinary outdoor capture, using the GPS. This is the normal mode — you only need PlotIn when you go inside.'
  },
  plotpack: {
    name: 'PlotPack',
    short: 'Send a whole project',
    long: 'PlotEdge’s own file type. One .plotpack holds an entire project — features, photos, notes and the feature type setup — so you can hand a job to a colleague or move it to another phone. It is really a ZIP, so anyone can open it even without PlotEdge.'
  },
  plotgrid: {
    name: 'PlotGrid',
    short: 'Coordinate system',
    long: 'Which coordinate system your exported numbers come out in. Leave it on WGS 84 lat/lon unless a client or your Surveyor-General asked for a specific grid, in which case pick theirs here.'
  },
  plotfix: {
    name: 'PlotFix',
    short: 'GPS quality',
    long: 'Shows how good your GPS fix actually is — fix type, satellites, accuracy — and can stop you capturing when it is not good enough for the job. Every point you save records what its fix was, so you can prove it later.'
  },
  plotmate: {
    name: 'PlotMate',
    short: 'Shared projects',
    long: 'Keeps a project consistent when more than one crew is working on it. Each device records its own edits so they can be combined later without anything being lost or a deleted feature coming back.'
  },
  plotcad: {
    name: 'PlotCAD',
    short: 'CAD drawing export',
    long: 'Exports your survey as a CAD drawing (.dxf) in real metres, ready to open in AutoCAD, Civil 3D or BricsCAD. Layers are split by feature type so a draughtsman can work with it straight away.'
  }
};

// Dismissals are per name, so meeting PlotMind for the first time still explains itself months
// after PlotEtch was learned. Stored under one key as a map rather than eleven keys, to keep the
// device-settings allowlist in js/17b-plotpack.js to a single entry.
const PLOTWORDS_SEEN_KEY = 'plotedge_plotwords_seen';

function plotwordsSeen(){
  try { return JSON.parse(localStorage.getItem(PLOTWORDS_SEEN_KEY) || '{}') || {}; }
  catch(e){ return {}; }
}

function plotwordsMarkSeen(key){
  try {
    const seen = plotwordsSeen();
    seen[key] = 1;
    localStorage.setItem(PLOTWORDS_SEEN_KEY, JSON.stringify(seen));
  } catch(e){ /* a full quota must not break opening a module */ }
}

// Exposed so Settings can offer "show the explanations again" — somebody handing the phone to a
// new crew member should not have to clear app data to get the first-run help back.
function plotwordsResetAll(){
  try { localStorage.removeItem(PLOTWORDS_SEEN_KEY); } catch(e){}
  showToast('Explanations will show again next time you open each tool');
}


// ══ THE FIRST-OPEN STRIP ══
// Called at the top of each module's open function. Returns immediately if the name has already
// been met, so the call site costs nothing to leave in permanently.
//
// Rendered into ONE fixed layer rather than into each module's own container. That is not the
// obvious design — prepending into the module would flow with its content — but half these
// modules are full-screen maps (PlotAtlas, PlotEtch) with no content column to prepend into, and
// the others are modals whose box is already scroll-constrained. A single fixed layer is the only
// shape that works for all of them, and it means adding an explainer to a future module is one
// call with no markup.
function plotwordsExplain(key){
  const word = PLOTWORDS[key];
  if (!word) return;
  if (plotwordsSeen()[key]) return;
  const layer = document.getElementById('plotwordsLayer');
  if (!layer) return;
  if (layer.querySelector(`[data-pw="${key}"]`)) return; // already showing — don't stack duplicates

  // Any strip still up for a different module is cleared first. Two explainers at once would
  // cover the screen and neither would be read.
  layer.innerHTML = '';

  const strip = document.createElement('div');
  strip.className = 'plotwords-strip';
  strip.setAttribute('role', 'note');
  strip.dataset.pw = key;
  strip.innerHTML = `
    <div class="plotwords-strip-body">
      <div class="plotwords-strip-name">${escapeHtml(word.name)}</div>
      <div class="plotwords-strip-text">${escapeHtml(word.long)}</div>
    </div>
    <button class="plotwords-strip-x" aria-label="Got it, hide this">Got it</button>`;
  strip.querySelector('.plotwords-strip-x').addEventListener('click', () => {
    plotwordsMarkSeen(key);
    strip.remove();
  });
  layer.appendChild(strip);
}

// Clears any strip on the way out of a module. Without this, closing PlotEtch while its explainer
// is still up would leave the strip floating over whatever screen you landed on — it is fixed to
// the viewport, not to the module that raised it.
function plotwordsDismissAll(){
  const layer = document.getElementById('plotwordsLayer');
  if (layer) layer.innerHTML = '';
}


// ══ THE GLOSSARY ══
// One screen, every name, with a button that opens the thing it describes where that makes sense.
// The opener is stored as a FUNCTION NAME rather than a reference because this file loads before
// several of the modules it points at; resolving at click time is what makes that safe.
function renderPlotWords(){
  const host = document.getElementById('plotWordsList');
  if (!host) return;
  const seen = plotwordsSeen();
  host.innerHTML = Object.keys(PLOTWORDS).map(key => {
    const w = PLOTWORDS[key];
    const canOpen = w.open && typeof window[w.open] === 'function';
    return `
      <div class="plotwords-row">
        <div class="plotwords-row-head">
          <div class="plotwords-row-name">${escapeHtml(w.name)}</div>
          <div class="plotwords-row-short">${escapeHtml(w.short)}</div>
        </div>
        <div class="plotwords-row-long">${escapeHtml(w.long)}</div>
        ${canOpen ? `<button class="plotwords-row-open" onclick="plotwordsOpen('${key}')">Open ${escapeHtml(w.name)}</button>` : ''}
      </div>`;
  }).join('');
  const note = document.getElementById('plotWordsNote');
  if (note){
    const n = Object.keys(PLOTWORDS).filter(k => seen[k]).length;
    note.textContent = n
      ? `${n} of ${Object.keys(PLOTWORDS).length} explained so far. Tap “Show all explanations again” below to reset.`
      : 'Each of these explains itself the first time you open it.';
  }
}

function plotwordsOpen(key){
  const w = PLOTWORDS[key];
  if (!w || !w.open) return;
  const fn = window[w.open];
  if (typeof fn !== 'function') { showToast('That tool is not available here'); return; }
  closeTopOverlay();
  fn();
}

// Opened as a view rather than an overlay, so it inherits the app's own screen transition and is
// already understood by the back-button chain, the chrome routing and the history stack — none of
// which had to be told about it.
function showPlotWords(){
  renderPlotWords();
  activateView('view-plotwords');
}

// Returns to Settings' own screen rather than wherever the user happened to be, because Settings
// is where this is reached from and dropping them somewhere else after a Back is disorienting.
function closePlotWords(){
  // Back to the Data hub, which is where Settings lives — dropping the user on whatever view
  // happened to be active underneath is disorienting after they went looking for help.
  // No fallback branch: showDataHub is defined in js/05-projects.js and always loaded. An
  // activateView() fallback here named a view that does not exist, which the ambient-band test
  // caught immediately — a dead branch is still a claim about what the app contains.
  showDataHub();
}
