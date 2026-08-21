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

let featureTypes = [];     // [{id,name,geometryType,geometryTypes,fields:[{id,label,type,options,required,placeholder}]}] — active project's custom schema

// ══ MULTI-GEOMETRY FEATURE TYPES ══
// A feature type is a semantic class ("Septic Tank"), not a geometry. The same class is
// legitimately captured at different fidelity depending on what the field crew can see: a
// point when all you can reach is the lid, a polygon when the footprint is exposed. Rather
// than forcing two near-identical types with duplicated attribute schemas, a type now
// declares which geometries it PERMITS, and each capture records which one it USED.
//
// `geometryTypes` is the new array; `geometryType` is kept in sync as its first entry so
// every existing reader (exports, PlotAtlas, PlotMind, analytics, the legacy .plotedge.json
// backup) keeps working unchanged against types that only allow one geometry — which is
// every type that existed before this change. Nothing needs migrating on load.
//
// Note what is deliberately NOT allowed: a single FEATURE with several geometries. That
// would be a GeometryCollection, which ArcGIS refuses outright, QGIS handles poorly, and
// which has no meaningful length or area. A septic with both a footprint and a lid is two
// features sharing a reference id.
const GEOMETRY_KINDS = ['point','line','polygon'];

function ftGeometries(ft){
  if (!ft) return ['point'];
  const list = Array.isArray(ft.geometryTypes) ? ft.geometryTypes.filter(g=>GEOMETRY_KINDS.includes(g)) : [];
  if (list.length) return GEOMETRY_KINDS.filter(g=>list.includes(g)); // canonical order, deduped
  return [GEOMETRY_KINDS.includes(ft.geometryType) ? ft.geometryType : 'point'];
}

function ftDefaultGeometry(ft){
  const list = ftGeometries(ft);
  // The stored singular wins when it is still permitted, so a type that allowed only
  // polygons before and has since gained point capture still opens on polygon.
  return list.includes(ft && ft.geometryType) ? ft.geometryType : list[0];
}

function ftAllowsGeometry(ft, geo){ return ftGeometries(ft).includes(geo); }

function ftIsMultiGeometry(ft){ return ftGeometries(ft).length > 1; }

// Human label for a type's geometry capability, used anywhere the old code printed
// `ft.geometryType` straight into the UI.
function ftGeometryLabel(ft){
  const list = ftGeometries(ft);
  return list.length > 1 ? list.join(' / ') : list[0];
}

// ── Session geometry ──
// Which geometry the capture currently in progress is building. For a single-geometry type
// this is just that type's geometry and nothing observable changes. For a multi-geometry
// type it is what the crew picked on the Collect screen, and it is what gets written onto
// the saved feature — the feature type's own list only ever says what was permitted.
let activeGeometryType = 'point';

function currentCaptureGeometry(){
  const ft = (typeof getFeatureType === 'function' && document.getElementById('featureTypeSelect'))
    ? getFeatureType(document.getElementById('featureTypeSelect').value) : null;
  if (!ft) return activeGeometryType || 'point';
  return ftAllowsGeometry(ft, activeGeometryType) ? activeGeometryType : ftDefaultGeometry(ft);
}

// A field scoped per-vertex is meaningless on a point capture (one vertex — "per vertex" and
// "once per feature" would be the same question asked twice). Under multi-geometry the scope
// can no longer be resolved when the type is DEFINED, because the same type may be captured
// as both. So the schema keeps 'vertex' and it collapses here, at capture time, against the
// geometry actually in use.
// The saved-feature counterpart to effectiveFieldScope: resolves a field's scope against the
// geometry the feature was actually captured as, which is what decides whether its value lives
// in f.attrs or in each vertex's own attrs. Anything reading back a stored feature must use this
// rather than field.scope, or a point capture of a multi-geometry type has its per-vertex fields
// looked for in the wrong place and they render as missing.
function featureFieldScope(field, f){
  return effectiveFieldScope(field, (f && f.geometryType) || 'point');
}

function effectiveFieldScope(field, geo){
  const scope = (field && field.scope === 'vertex') ? 'vertex' : 'feature';
  return (scope === 'vertex' && geo === 'point') ? 'feature' : scope;
}

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
  'view-plotwords':        'settings',  // a glossary is read, not filled in — same band as Help
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
  // Leaving a project has to clear the indoor treatment too. switchTabScreenState() only runs on
  // the view-app branch above, so without this the floor plan stayed on screen all the way out to
  // Welcome — see updateIndoorTexture() in js/06-collect.js for why the tab alone is not enough.
  if (typeof updateIndoorTexture === 'function') updateIndoorTexture();
  if (typeof closePmMenu === 'function') closePmMenu();
}

// Shared by switchTab() and by activateView('view-app'), so entering a project and switching tabs
// inside it can never disagree about the band.
function switchTabScreenState(tab){
  setScreenState(tab === 'collect' ? 'form' : tab === 'review' ? 'map' : 'home');
  // Leaving/entering Collect can flip whether the PlotIn indoor texture (css/02-mesh.css) should
  // be on screen, even though currentEnvironment itself didn't change — see updateIndoorTexture()
  // in js/06-collect.js.
  if (typeof updateIndoorTexture === 'function') updateIndoorTexture();
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
  // ══ LINKING ONE FEATURE TO ANOTHER ══
  // The relationship this exists for is containment and attachment: a sink in a bathroom, a
  // transformer on a pole, a valve in a chamber. All of it was already recordable — type the
  // parent's Reference ID into an ordinary text field — and that is exactly the problem. A typed
  // ref is a pointer with no spell-check: "ROOM-04" for "ROOM-004" orphans the fixture, nothing
  // objects, and it is found months later by someone joining the register against another system.
  //
  // So this stores the same thing — the parent's ref, a plain string — but the crew PICKS it from
  // the refs already in the project instead of typing it. You cannot mistype a value you selected.
  //
  // ══ WHY A FIELD TYPE AND NOT A PARENT COLUMN ON EVERY FEATURE ══
  // Because the value stays a string, nothing downstream changes shape: plotpack, GeoJSON, CSV and
  // any external asset system see an ordinary attribute, exactly as they would have seen the typed
  // text field. There is no format version to bump and nothing permanent to regret — delete the
  // field from the schema and the project is back where it started.
  // It is also opt-in per feature type, which matters because most types have nothing to point at.
  // And it is deliberately NOT nesting: the fixture stays its own feature, its own row, its own
  // record with its own condition and replacement cost. Storing it inside its parent would make
  // "every sink in the building, worst condition first" a tree walk instead of a filter, which is
  // the query that actually gets run.
  { value:'feature_ref',   label:'Link to another feature' },
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
// feature_ref joins the exclusions for the same reason barcode is here: the picker is rebuilt from
// the project's live refs and targets a single DOM id, and wiring one per dynamically-added group
// instance is solvable but out of scope for this pass. A group entry that needs to name a parent
// can carry the parent on the FEATURE instead, which is where containment naturally sits anyway.
const REPEAT_SUBFIELD_TYPES = FIELD_TYPES.filter(t => !['calculated','barcode','repeat_group','feature_ref'].includes(t.value));


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


// ══ PER-FEATURE-TYPE SYMBOLOGY (shape / line style / fill) ══
// A second, colorblind-safe channel alongside featureTypeColor() above — same "shared by every
// renderer" role, just for shape instead of hue. Every reader goes through these three accessors
// rather than reading t.shape/t.lineStyle/t.fill directly, so a feature type saved before this
// existed (or a legacy/unclassified layer with no matching type at all) silently gets the sane
// default instead of every call site needing its own fallback.
const POINT_SHAPES = ['circle','square','triangle'];
const LINE_STYLES  = ['solid','dashed','dotted'];

function featureTypeShape(key){
  const ft = featureTypes.find(t=>t.id===key);
  const s = ft && ft.shape;
  return POINT_SHAPES.includes(s) ? s : 'circle';
}

function featureTypeLineStyle(key){
  const ft = featureTypes.find(t=>t.id===key);
  const s = ft && ft.lineStyle;
  return LINE_STYLES.includes(s) ? s : 'solid';
}

// Polygon fill. Stored inverted (fill:false means "outline only") so that every feature type
// saved before this existed — where the field is simply absent — keeps rendering exactly as it
// always has: filled.
function featureTypeFilled(key){
  const ft = featureTypes.find(t=>t.id===key);
  return !(ft && ft.fill === false);
}

// ══ ONE CALL FOR THE WHOLE SYMBOL ══
// The four accessors above are the primitives, but almost every renderer wants all four at once
// and was writing the same four-line preamble. Worse, a renderer that only remembered three of
// them (the Collect preview drew every type in the accent colour with a solid stroke, the Collect
// satellite map drew every line orange) looked deliberate rather than unfinished, so the gap
// survived several passes over those files. Asking for the symbol as one object is what makes
// "did this surface honour the type's styling?" answerable by grep instead of by eye.
function featureTypeSymbol(key){
  return {
    color: featureTypeColor(key),
    shape: featureTypeShape(key),
    lineStyle: featureTypeLineStyle(key),
    filled: featureTypeFilled(key)
  };
}

// The feature type the Collect tab is currently capturing as — read from the picker rather than
// from a saved feature, because during capture there is no feature yet. Returns null before a
// type is chosen, which every featureType* accessor already treats as "use the defaults".
function currentCaptureFtKey(){
  const sel = document.getElementById('featureTypeSelect');
  return sel && sel.value ? sel.value : null;
}

// Leaflet's dashArray option, scaled to the stroke weight so a thick review-map polygon border
// and a thin PlotAtlas measurement line both read as "dashed" rather than one looking solid.
// Returns null for solid, which is what Leaflet/most callers treat as "no dash option at all".
function leafletDashArray(style, weight){
  const w = weight || 2;
  if (style === 'dashed') return (w*3).toFixed(1) + ' ' + (w*2).toFixed(1);
  if (style === 'dotted') return (w*0.9).toFixed(1) + ' ' + (w*1.8).toFixed(1);
  return null;
}

// Same idea for jsPDF, which takes the pattern in page units (mm on the plan sheet) via
// doc.setLineDashPattern([on,off], phase) rather than a CSS-style string.
function pdfDashPattern(style, weight){
  const w = weight || 1;
  if (style === 'dashed') return [w*2.2, w*1.6];
  if (style === 'dotted') return [w*0.6, w*1.2];
  return null;
}

// Renders a shape as a small standalone SVG string — used both for the Leaflet divIcon markers
// (square/triangle points, which circleMarker can't draw) and for every non-Leaflet map surface
// (dashboard preview, plan sheet legend swatches, exported web map) so all four places draw the
// exact same glyph. `r` is the visual radius/half-size in px/mm; circle is included for callers
// that want one code path even though Leaflet callers use circleMarker directly for that case.
function shapeGlyphSvg(shape, r, color, weight, fillOpacity, strokeColor){
  const w = weight != null ? weight : 2;
  const stroke = strokeColor || '#fff';
  const fo = fillOpacity != null ? fillOpacity : 1;
  const size = (r*2 + w*2);
  const c = size/2;
  if (shape === 'square'){
    const s = r*1.6, x = c - s/2, y = c - s/2;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${color}" fill-opacity="${fo}" stroke="${stroke}" stroke-width="${w}"/></svg>`;
  }
  if (shape === 'triangle'){
    const R = r*1.25;
    const p1 = `${c},${(c-R).toFixed(1)}`, p2 = `${(c-R*0.87).toFixed(1)},${(c+R*0.6).toFixed(1)}`, p3 = `${(c+R*0.87).toFixed(1)},${(c+R*0.6).toFixed(1)}`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><polygon points="${p1} ${p2} ${p3}" fill="${color}" fill-opacity="${fo}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/></svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity="${fo}" stroke="${stroke}" stroke-width="${w}"/></svg>`;
}

// Same three glyphs as shapeGlyphSvg() above, but as a bare SVG element (no wrapping <svg>/
// viewBox) positioned at an arbitrary cx/cy — for embedding directly inside a canvas that's
// already an <svg>, like the dashboard's hand-rolled preview map. attrs is an extra string of
// SVG attributes (class, fill-opacity, stroke, etc.) appended as-is.
function shapeMarkup(shape, cx, cy, r, attrs){
  attrs = attrs || '';
  if (shape === 'square'){
    const s = r*1.7, x = cx - s/2, y = cy - s/2;
    return `<rect x="${x}" y="${y}" width="${s}" height="${s}" ${attrs}/>`;
  }
  if (shape === 'triangle'){
    const R = r*1.3;
    const p1 = `${cx},${(cy-R).toFixed(2)}`, p2 = `${(cx-R*0.87).toFixed(2)},${(cy+R*0.6).toFixed(2)}`, p3 = `${(cx+R*0.87).toFixed(2)},${(cy+R*0.6).toFixed(2)}`;
    return `<polygon points="${p1} ${p2} ${p3}" ${attrs}/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" ${attrs}/>`;
}

// L.circleMarker exactly as before (cheapest, and canvas-rendered rather than one DOM node per
// point), square/triangle fall back to a divIcon built from shapeGlyphSvg() since circleMarker
// can only ever draw a circle. Kept as one function so every render site asks for a shape without
// caring which Leaflet primitive that turns into.
function featurePointLayer(latlng, opts){
  opts = opts || {};
  const shape = opts.shape || 'circle';
  const radius = opts.radius != null ? opts.radius : 7;
  const weight = opts.weight != null ? opts.weight : 2;
  const fillOpacity = opts.fillOpacity != null ? opts.fillOpacity : 1;
  const color = opts.fillColor || opts.color || '#0EA5E9';
  if (shape === 'circle') {
    return L.circleMarker(latlng, opts);
  }
  const size = radius*2 + weight*2;
  const icon = L.divIcon({
    className: 'pe-shape-marker',
    html: shapeGlyphSvg(shape, radius, color, weight, fillOpacity, opts.color === opts.fillColor ? color : '#fff'),
    iconSize: [size, size],
    iconAnchor: [size/2, size/2]
  });
  const markerOpts = { icon, interactive: opts.interactive !== false };
  if (opts.draggable) markerOpts.draggable = true;
  if (opts.zIndexOffset != null) markerOpts.zIndexOffset = opts.zIndexOffset;
  return L.marker(latlng, markerOpts);
}

// Small inline-SVG legend swatch shared by every legend (map legend strip, PlotAtlas legend, the
// exported web map's legend, the dashboard preview popup). Draws the type's actual symbol —
// shape for points, a short dashed/solid stroke for lines, a filled/outline square for polygons —
// rather than a plain color dot, so the legend actually explains what's on the map instead of
// just repeating the color key.
function legendGlyphSvg(geometryType, color, shape, lineStyle, filled){
  const S = 16;
  if (geometryType === 'polygon'){
    const dash = leafletDashArray(lineStyle, 1.6);
    return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="${filled ? color : 'none'}" fill-opacity="${filled?0.35:0}" stroke="${color}" stroke-width="1.6" ${dash?`stroke-dasharray="${dash}"`:''}/></svg>`;
  }
  if (geometryType === 'line'){
    const dash = leafletDashArray(lineStyle, 2);
    return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="${color}" stroke-width="2.4" stroke-linecap="round" ${dash?`stroke-dasharray="${dash}"`:''}/></svg>`;
  }
  return shapeGlyphSvg(shape, 5.5, color, 1.6, 1, 'transparent');
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
    // geometryType here is the type's DEFAULT/declared geometry, kept for callers that only
    // want a glyph. Anything describing a specific saved feature must read f.geometryType,
    // which records what that capture actually was.
    if (ft) return { label: ft.name, fields: ft.fields, isLegacy:false, key: ft.id, geometryType: ftDefaultGeometry(ft), geometryTypes: ftGeometries(ft) };
    // feature type was since deleted — fall back to whatever was saved on the feature
    return { label: f.featureTypeName || 'Deleted type', fields: [], isLegacy:false, key: f.featureTypeId, geometryType: f.geometryType||'point' };
  }
  const legacy = LEGACY_LAYERS[f.layer];
  return { label: legacy ? legacy.label : (f.layer || 'Unknown'), fields: (legacy ? legacy.attrs : []) || [], isLegacy:true, key: f.layer, geometryType: f.geometryType||'point' };
}
