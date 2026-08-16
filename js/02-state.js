// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Legacy schema migration, global state, view switching, feature-type colours
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ LEGACY LAYER SCHEMA (v2 data) ══
// Kept read-only so old projects/features saved before custom feature types still render/export.
// Each layer: { label, crew, crewClass, attrs: [{id, label, type, options?}] }
const LEGACY_LAYERS = {
  Pivots: {
    label: 'Pivots', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'point_type',      label:'Point Type',      type:'select', options:['centre','north'] },
      { id:'status',          label:'Status',          type:'select', options:['active','inactive','under repair'] },
      { id:'area_ha',         label:'Area Covered (ha)',type:'number' },
      { id:'crop',            label:'Crop',            type:'select', options:['maize','wheat','soya','other'] },
      { id:'irrigation_type', label:'Irrigation Type', type:'select', options:['centre pivot','drip','flood','sprinkler'] }
    ]
  },
  Dams: {
    label: 'Dams', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'capacity_m3',   label:'Capacity (m³)',   type:'number' },
      { id:'water_source',  label:'Water Source',    type:'select', options:['rainfall','river','borehole'] },
      { id:'condition',     label:'Condition',       type:'select', options:['good','fair','low','empty'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Dam_Walls: {
    label: 'Dam Walls', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'material',       label:'Material',       type:'select', options:['concrete','earthen','masonry'] },
      { id:'length_m',       label:'Length (m)',     type:'number' },
      { id:'condition',      label:'Condition',      type:'select', options:['good','fair','poor'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Effluent_Ponds: {
    label: 'Effluent Ponds', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'type',           label:'Type',           type:'select', options:['primary','secondary','holding'] },
      { id:'condition',      label:'Condition',      type:'select', options:['good','fair','full','dry'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Bridges_Culverts: {
    label: 'Bridges / Culverts', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'type',           label:'Type',           type:'select', options:['bridge','culvert'] },
      { id:'material',       label:'Material',       type:'select', options:['concrete','metal','timber'] },
      { id:'condition',      label:'Condition',      type:'select', options:['good','fair','poor'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Boreholes: {
    label: 'Boreholes', crew: 'BKG Lead', crewClass: 'crew-lead',
    attrs: [
      { id:'primary_use', label:'Primary Use', type:'select', options:['irrigation','livestock','domestic'] },
      { id:'status',      label:'Status',      type:'select', options:['active','inactive','unknown'] }
    ]
  },
  Roads_Paths: {
    label: 'Roads / Paths', crew: 'Technician 1', crewClass: 'crew-t1',
    attrs: [
      { id:'type',      label:'Type',      type:'select', options:['main road','farm track','footpath'] },
      { id:'surface',   label:'Surface',   type:'select', options:['gravel','dirt','paved'] },
      { id:'condition', label:'Condition', type:'select', options:['good','fair','poor'] }
    ]
  },
  Pasture_Areas: {
    label: 'Pasture Areas', crew: 'Technician 1', crewClass: 'crew-t1',
    attrs: [
      { id:'grass_type', label:'Grass Type', type:'select', options:['natural','planted','mixed'] },
      { id:'condition',  label:'Condition',  type:'select', options:['good','fair','degraded'] }
    ]
  },
  Water_Points_Pumps: {
    label: 'Water Points / Pumps', crew: 'Technician 1', crewClass: 'crew-t1',
    attrs: [
      { id:'type',      label:'Type',      type:'select', options:['pump','trough','valve','water tank','flow meter','other'] },
      { id:'status',    label:'Status',    type:'select', options:['active','inactive','unknown'] },
      { id:'condition', label:'Condition', type:'select', options:['good','fair','poor'] }
    ]
  },
  Houses_Structures: {
    label: 'Houses / Structures', crew: 'Technician 2', crewClass: 'crew-t2',
    attrs: [
      { id:'use',            label:'Use',            type:'select', options:['residence','storage','equipment','pump','office'] },
      { id:'construction',   label:'Construction',   type:'select', options:['brick','timber','metal sheet'] },
      { id:'condition',      label:'Condition',      type:'select', options:['good','fair','poor'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Silos: {
    label: 'Silos', crew: 'Technician 2', crewClass: 'crew-t2',
    attrs: [
      { id:'capacity_tonnes', label:'Capacity (tonnes)', type:'number' },
      { id:'crop_stored',     label:'Crop Stored',       type:'select', options:['wheat','maize','soya','other'] },
      { id:'condition',       label:'Condition',         type:'select', options:['good','fair','poor'] },
      { id:'visible_defects', label:'Visible Defects',   type:'select', options:['yes','no'] }
    ]
  },
  Ponds: {
    label: 'Ponds', crew: 'Technician 2', crewClass: 'crew-t2',
    attrs: [
      { id:'type',      label:'Type',      type:'select', options:['natural','constructed','seasonal'] },
      { id:'condition', label:'Condition', type:'select', options:['good','fair','dry'] },
      { id:'area_m2',   label:'Area (m²)', type:'number' }
    ]
  },
  Livestock_Infrastructure: {
    label: 'Livestock Infrastructure', crew: 'Technician 2', crewClass: 'crew-t2',
    attrs: [
      { id:'type',           label:'Type',           type:'select', options:['kraal','dip tank','loading ramp','feeding trough'] },
      { id:'condition',      label:'Condition',      type:'select', options:['good','fair','poor'] },
      { id:'visible_defects',label:'Visible Defects',type:'select', options:['yes','no'] }
    ]
  },
  Unknown_Unclassified: {
    label: 'Unknown / Unclassified', crew: 'All Collectors', crewClass: 'crew-all',
    attrs: [
      { id:'feature_type', label:'Feature Type', type:'text', placeholder:'e.g. Water / Structure' },
      { id:'condition',    label:'Condition',    type:'select', options:['good','fair','poor','unknown'] },
      { id:'photo_taken',  label:'Photo Taken',  type:'select', options:['yes','no'] }
    ]
  }
};


// ══ STATE ══
let watchId = null, gpsActive = false, currentPos = null;

// A "vertex" is one physical capture instant: {lat,lon,alt,acc,time,attrs:{},photos:[{dataUrl,name,takenAt,heading,angleLabel}]}.
// point features: 1+ vertices (multi-angle captures of the "same" point). line: 2+ ordered vertices. polygon: 3+ ordered vertices (ring auto-closed on export).
let currentVertices = [], openVertexIndex = null, savedFeatures = [];

// ══ PLOTIN / PLOTOUT ══ — which capture workflow the Collect form is currently in.
// 'PlotOut' (default): standard outdoor GNSS capture, GPS fix required before Capture is usable.
// 'PlotIn': indoor capture — GPS is unreliable/absent by design, so the satellite/plan tap map
// becomes the primary way to place a vertex instead of a gate in front of the GPS button. See
// setCollectEnvironment() in js/06-collect.js.
let currentEnvironment = 'PlotOut';

let featureTypes = [];     // [{id,name,geometryType,fields:[{id,label,type,options,required,placeholder}]}] — active project's custom schema

let projectNotes = '';     // freeform per-project scratchpad text (Quick Notes), saved with everything else in persist()

let projectNotesUpdatedAt = null;

let projects = [];         // [{id,name,client,site,siteLat,siteLon,createdAt}]

let activeProjectId = null;

let newProjSiteLat = null, newProjSiteLon = null; // set by "Use current location" on the New Project form, saved onto the project record

let editingFeatureId = null;       // id of the savedFeatures entry currently being edited via the Collect form, or null when capturing a brand-new feature

let editingFeatureSnapshot = null; // deep copy of that feature's form-relevant fields, taken when editing starts — used to detect unsaved changes on Cancel

let editingProjectId = null;       // id of the projects entry currently being edited via the New/Edit Project form, or null when creating a new project

const STORAGE_KEY = 'plotedge_v2';

const LEGACY_KEY = 'plotedge_v1';

const LAST_SESSION_KEY = 'plotedge_last_session'; // {projectId, tab} — so a reload or returning to the app

                                                   // after being backgrounded lands back where you left off
                                                   // instead of always resetting to the projects list.
function saveLastSession(tab){
  try { localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ projectId: activeProjectId, tab: tab || null })); } catch(e) {}
}


// ══ ACTIVE PROJECT CONTEXT ══
// activeProjectId is deliberately nulled whenever the user steps out to the projects list, so
// that persist()/markProjectExported() can never write into a project that isn't open. But the
// Project Manager still needs to know which project the crew is *working in* so it can surface
// the "Currently Active" card — that outlives any single visit to the list, and must survive a
// reload, so it gets its own key rather than riding on LAST_SESSION_KEY (which the projects
// screen intentionally clears).
const ACTIVE_PROJECT_KEY = 'plotedge_active_project';

let activeProjectRef = null;

try { activeProjectRef = localStorage.getItem(ACTIVE_PROJECT_KEY) || null; } catch(e) {}

function setActiveProjectRef(id){
  activeProjectRef = id || null;
  try { id ? localStorage.setItem(ACTIVE_PROJECT_KEY, id) : localStorage.removeItem(ACTIVE_PROJECT_KEY); } catch(e) {}
}


// ══ VIEW SWITCHING ══
// Every screen swap in the app goes through here. It used to be an inlined two-liner repeated at
// nine call sites, which was fine while "which chrome shows on this screen" was purely a CSS
// descendant question. Now that the bottom nav lives at <body> level (so the Project Manager can
// share it), that question has to be answered in JS on every swap — centralising it means a new
// screen can't silently inherit the wrong chrome, and there is exactly one line to edit if the
// rule changes.
// view-datahub joins these: it's a top-level nav destination, so the bottom bar must stay docked
// on it. #view-backup and #view-storage are deliberately NOT here — they're focused subpages
// reached from the hub, and they follow the same chrome-less pattern as Feature Types / New
// Project, which each carry their own back arrow instead.
const CHROME_VIEWS = new Set(['view-app', 'view-projectmgr', 'view-datahub']);

// ══ EVERY VIEW DECLARES ITS AMBIENT BAND ══
// setScreenState() was called from four navigation entry points and nowhere else, so eleven of
// the twelve views never set a band at all — they simply inherited whatever the previous screen
// had left on <html>. Leaving Collect (form, 0.28) for the Data hub rendered the hub at Collect's
// intensity; arriving from Review (map, 0) left it completely flat. That is why the ambient
// gradient appeared not to respond to the screen: it was responding, just to the wrong screen.
// Putting the mapping here means a view cannot be added without getting a band, which is the
// property that was actually missing.
const VIEW_SCREEN_STATE = {
  'view-projects':         'home',      // landing
  'view-projectmgr':       'home',
  'view-datahub':          'home',
  'view-backup':           'settings',  // lists of controls, read but not filled in
  'view-storage':          'settings',
  'view-featuretypes':     'settings',
  'view-featuretype-edit': 'form',      // schema editing is data entry
  'view-newproject':       'form',
  'view-media':            'map',       // a photo wall must not be tinted, same reason as tiles
  'view-plotlens':         'map',
  'view-plotetch':         'map'        // full-bleed tracing over satellite imagery
  // 'view-app' is deliberately absent: its band depends on which tab is open inside it, so
  // switchTab() owns it. See the call there.
};

function activateView(id){
  // .view.active carries a 0.22s enter animation (see 03-base.css). Re-activating the view that
  // is ALREADY showing — which happens on every switchTab() into a tab of #view-app — would
  // otherwise replay that fade on a screen the user never left, reading as a flicker on what
  // should be an instant tab change. Removing and re-adding the class in one synchronous block
  // does not restart a CSS animation in practice (there is no style recalculation in between),
  // but relying on that is relying on an implementation detail; this states the intent instead.
  const already = document.getElementById(id);
  const isSame = already && already.classList.contains('active');
  if (!isSame){
    document.querySelectorAll('.view.active').forEach(v=>v.classList.remove('active'));
    if (already) already.classList.add('active');
  }
  document.body.dataset.chrome = CHROME_VIEWS.has(id) ? 'nav' : 'none';
  const band = VIEW_SCREEN_STATE[id];
  if (band) setScreenState(band);
  else if (id === 'view-app') switchTabScreenState(getCurrentTab());
  if (typeof closePmMenu === 'function') closePmMenu();
}

// Shared by switchTab() and by activateView('view-app'), so entering a project and switching tabs
// inside it can never disagree about the band.
function switchTabScreenState(tab){
  setScreenState(tab === 'collect' ? 'form' : tab === 'review' ? 'map' : 'home');
}

const FIELD_TYPES = [
  { value:'text',          label:'Text (single line)' },
  { value:'textarea',      label:'Text (multi-line)' },
  { value:'number',        label:'Number' },
  { value:'boolean',       label:'Yes / No' },
  { value:'single_select', label:'Single choice' },
  { value:'multi_select',  label:'Multiple choice' },
  { value:'date',          label:'Date' },
  { value:'barcode',       label:'Barcode / QR' },
  { value:'calculated',    label:'Calculated (from other fields)' },
  { value:'repeat_group',  label:'Repeating group (multiple entries)' }
];

// What a repeating group's own sub-fields may be. Deliberately a smaller set than FIELD_TYPES:
// no nested repeat_group (unbounded nesting isn't worth the complexity for a field crew form),
// no calculated (a calculation reads other TOP-LEVEL fields by id — teaching it to reach inside a
// specific group instance is a materially bigger feature), no barcode (the scan button targets a
// single DOM id; wiring one scanner per dynamically-added instance is solvable but out of scope
// for this pass). Text/number/choice/date cover the overwhelming majority of real repeating data
// (occupants, damage entries, inspection line items).
const REPEAT_SUBFIELD_TYPES = FIELD_TYPES.filter(t => !['calculated','barcode','repeat_group'].includes(t.value));


// Look up a feature type by id within the active project's schema
function getFeatureType(id) { return featureTypes.find(t => t.id === id); }


// ══ PER-FEATURE-TYPE COLOR (shared by review-list badges, feature-type manager, and the map/legend) ══
// Deterministically hashes a feature type's id (or a legacy layer name) into a fixed palette, so
// the same type always gets the same color everywhere without needing an explicit color field
// in the schema.
const FEATURE_COLOR_PALETTE = ['#10B981','#0EA5E9','#F59E0B','#8E44AD','#EF4444','#D4AC0D','#64748B','#E84393'];

function featureTypeColor(key){
  if(!key) return FEATURE_COLOR_PALETTE[0];
  // User-defined feature types can pin an explicit color (set via the swatch picker in the
  // feature type editor); fall back to the deterministic hash so legacy/unclassified keys and
  // types without an explicit pick still get a stable, distinguishable color.
  const ft = featureTypes.find(t=>t.id===key);
  if (ft && ft.color) return ft.color;
  let hash=0;
  const s=String(key);
  for(let i=0;i<s.length;i++){ hash=(hash*31+s.charCodeAt(i))>>>0; }
  return FEATURE_COLOR_PALETTE[hash % FEATURE_COLOR_PALETTE.length];
}

// Picks readable dark/light text for an arbitrary hex background (YIQ perceived-brightness split).
function contrastText(hex){
  const c=hex.replace('#','');
  const r=parseInt(c.substr(0,2),16), g=parseInt(c.substr(2,2),16), b=parseInt(c.substr(4,2),16);
  const yiq=(r*299+g*587+b*114)/1000;
  return yiq>=128 ? '#0A0600' : '#FFFFFF';
}

function hexToRgba(hex,alpha){
  const c=hex.replace('#','');
  const r=parseInt(c.substr(0,2),16), g=parseInt(c.substr(2,2),16), b=parseInt(c.substr(4,2),16);
  return `rgba(${r},${g},${b},${alpha})`;
}


// Resolve display info for a saved feature, whether it uses the new custom
// schema (f.featureTypeId) or the old hardcoded layer key (f.layer).
function resolveFeatureType(f) {
  if (f.featureTypeId) {
    const ft = getFeatureType(f.featureTypeId);
    if (ft) return { label: ft.name, fields: ft.fields, isLegacy:false, key: ft.id, geometryType: ft.geometryType };
    // feature type was since deleted — fall back to whatever was saved on the feature
    return { label: f.featureTypeName || 'Deleted type', fields: [], isLegacy:false, key: f.featureTypeId, geometryType: f.geometryType||'point' };
  }
  const legacy = LEGACY_LAYERS[f.layer];
  return { label: legacy ? legacy.label : (f.layer || 'Unknown'), fields: (legacy ? legacy.attrs : []) || [], isLegacy:true, key: f.layer, geometryType: f.geometryType||'point' };
}
