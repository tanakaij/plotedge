// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — PlotArchive: a library of ready-made feature types
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ THE PROBLEM THIS SOLVES ══
// A new project cannot be collected into until it has a feature type, and building one means
// naming it, choosing geometry, picking a colour, then adding every field one at a time through a
// sheet — label, type, options, required, scope. For a pole with a material, a condition, an owner
// and five defect sub-fields that is twenty-odd interactions before anybody has captured anything.
//
// And the result is nearly always the same shape as somebody else's. A water meter has a serial,
// a reading, a size and a condition wherever it is installed. A parcel has a reference, a land use
// and a tenure. The variation between two crews' versions of "utility pole" is real but small —
// it is a renamed field and an extra choice, not a different idea.
//
// So: ship the common ones, and make the crew's job editing rather than authoring. Everything in
// here lands as an ORDINARY feature type the moment it is added — same storage, same editor, same
// behaviour. There is no such thing as an "archive type" at rest, and nothing downstream needs to
// know a type came from here. That is the whole design constraint: a preset is a starting point,
// not a category of thing.
//
// ── WHY THE FIELDS MATTER MORE THAN THE NAMES ──
// A library of bare names would save almost nothing — "Utility Pole" is quick to type. The value
// is entirely in arriving with the fields already right: the choice lists populated, the required
// ones marked, the per-vertex ones scoped, the calculated ones wired. So every entry below carries
// a real schema, and several carry the schema features people otherwise never discover (skip
// logic, calculations, vertex scope, repeating groups).


// ══ THE CATALOGUE ══
// Ids are stable strings, not generated: they are what plotarchiveIsAdded() matches on so the
// sheet can say "already in this project", and they are recorded on the created type as
// `archiveId` for the same reason. Renaming an entry is free; changing its id is not.
//
// `fields` here use a compact shape — the fifth element of the tuple is optional extras — because
// the full field object has ten keys and writing them out per field made the catalogue unreadable
// at a glance, which for a catalogue is the whole point. plotarchiveBuildField() below expands
// them into exactly what the feature type editor produces, so a preset and a hand-built type are
// indistinguishable once added.
//
// f(label, type, options, extras)
//   extras: { required, scope:'vertex', placeholder, condition:{ on, op, value }, expr:[a,'-',b],
//             subfields:[...] }
//   condition.on and expr name OTHER FIELDS IN THE SAME PRESET BY LABEL — resolved to generated
//   ids at build time, since the ids do not exist until the type is created.
const PLOTARCHIVE_CATEGORIES = [
  { id: 'utilities',   label: 'Utilities & services', icon: '⚡' },
  { id: 'water',       label: 'Water & sanitation',   icon: '💧' },
  { id: 'land',        label: 'Land & boundary',      icon: '📐' },
  { id: 'buildings',   label: 'Buildings & structures', icon: '🏠' },
  { id: 'transport',   label: 'Roads & transport',    icon: '🛣️' },
  { id: 'environment', label: 'Environment & land cover', icon: '🌳' },
  { id: 'community',   label: 'Community & facilities', icon: '🏥' }
];

const PLOTARCHIVE = [
  // ── UTILITIES & SERVICES ──
  {
    id: 'utility_pole', cat: 'utilities', name: 'Utility Pole',
    blurb: 'Power or telecoms pole with condition, height and a repeating defect log.',
    geometryTypes: ['point'], color: '#8B5CF6', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Pole reference', 'text', [], { required: true, placeholder: 'e.g. P-014' }],
      ['Owner', 'single_select', ['Electricity utility', 'Telecoms', 'Municipal', 'Private', 'Unknown']],
      ['Material', 'single_select', ['Wood', 'Concrete', 'Steel', 'Composite'], { required: true }],
      ['Pole height (m)', 'number', [], { placeholder: 'e.g. 9.5' }],
      ['Lowest wire (m)', 'number', [], { placeholder: 'e.g. 6.2' }],
      // Ground clearance is the number that decides whether a pole is a hazard, and it is the
      // difference of two things already being measured — so it should never be typed.
      ['Ground clearance (m)', 'calculated', [], { expr: ['Pole height (m)', '-', 'Lowest wire (m)'] }],
      ['Condition', 'single_select', ['Good', 'Fair', 'Poor', 'Failed'], { required: true }],
      ['Transformer fitted', 'boolean'],
      ['Defects', 'repeat_group', [], { subfields: [
        ['Defect type', 'single_select', ['Cracked', 'Rotten', 'Leaning', 'Corroded', 'Bird damage'], { required: true }],
        ['Severity', 'single_select', ['Low', 'Medium', 'High'], { required: true }],
        ['Noted on', 'date'],
        ['Comment', 'text']
      ]}]
    ]
  },
  {
    id: 'street_light', cat: 'utilities', name: 'Street Light',
    blurb: 'Lighting column with lamp type, mounting and a working/not-working check.',
    geometryTypes: ['point'], color: '#F59E0B', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Light ID', 'barcode', [], { placeholder: 'Scan or type the asset tag' }],
      ['Lamp type', 'single_select', ['LED', 'Sodium', 'Mercury vapour', 'Fluorescent', 'Unknown']],
      ['Mounting', 'single_select', ['Column', 'Wall bracket', 'Pole mounted', 'Suspended']],
      ['Working', 'boolean', [], { required: true }],
      ['Fault', 'single_select', ['Lamp out', 'Flickering', 'Column damaged', 'Door missing', 'Cabling exposed'], {
        // Only asked once somebody has said it does not work.
        condition: { on: 'Working', op: 'eq', value: 'No' }
      }],
      ['Column height (m)', 'number'],
      ['Last inspected', 'date']
    ]
  },
  {
    id: 'transformer', cat: 'utilities', name: 'Transformer / Substation',
    blurb: 'Distribution transformer with rating, mounting and access notes.',
    geometryTypes: ['point', 'polygon'], color: '#EF4444', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Asset number', 'text', [], { required: true }],
      ['Rating (kVA)', 'number'],
      ['Mounting', 'single_select', ['Pole mounted', 'Ground mounted', 'Kiosk', 'Indoor']],
      ['Fenced', 'boolean'],
      ['Access', 'single_select', ['Open', 'Locked (key held)', 'Locked (no key)', 'Obstructed']],
      ['Oil leak visible', 'boolean'],
      ['Condition', 'single_select', ['Good', 'Fair', 'Poor'], { required: true }],
      ['Notes', 'textarea']
    ]
  },
  {
    id: 'power_line', cat: 'utilities', name: 'Power Line',
    blurb: 'Overhead line run, with voltage and a per-vertex span check.',
    geometryTypes: ['line'], color: '#A855F7', shape: 'circle', lineStyle: 'dashed', fill: true,
    fields: [
      ['Line reference', 'text', [], { required: true }],
      ['Voltage', 'single_select', ['LV (< 1kV)', '11 kV', '33 kV', '66 kV', '132 kV+', 'Unknown'], { required: true }],
      ['Configuration', 'single_select', ['Overhead bare', 'Overhead bundled', 'Underground']],
      // Vertex scope: a span is a thing between two poles, so its clearance belongs to the point
      // it was measured at, not to the whole run.
      ['Clearance at this point (m)', 'number', [], { scope: 'vertex' }],
      ['Vegetation encroachment', 'single_select', ['None', 'Light', 'Touching', 'Severe'], { scope: 'vertex' }]
    ]
  },

  // ── WATER & SANITATION ──
  {
    id: 'water_meter', cat: 'water', name: 'Water Meter',
    blurb: 'Connection meter with serial, reading, size and a leak check.',
    geometryTypes: ['point'], color: '#0EA5E9', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Meter serial', 'barcode', [], { required: true, placeholder: 'Scan the meter' }],
      ['Account / stand number', 'text'],
      ['Reading', 'number', [], { placeholder: 'As shown on the dial' }],
      ['Reading date', 'date'],
      ['Meter size (mm)', 'single_select', ['15', '20', '25', '40', '50', '80', '100']],
      ['Meter condition', 'single_select', ['Good', 'Dial fogged', 'Damaged', 'Buried', 'Missing'], { required: true }],
      ['Leaking', 'boolean'],
      ['Box / chamber condition', 'single_select', ['Good', 'Cracked', 'Lid missing', 'Buried']]
    ]
  },
  {
    id: 'borehole', cat: 'water', name: 'Borehole / Well',
    blurb: 'Water point with pump type, yield and a functional-status check.',
    geometryTypes: ['point'], color: '#06B6D4', shape: 'triangle', lineStyle: 'solid', fill: true,
    fields: [
      ['Borehole ID', 'text', [], { required: true }],
      ['Pump type', 'single_select', ['Hand pump', 'Submersible electric', 'Solar', 'Diesel', 'None (open well)'], { required: true }],
      ['Status', 'single_select', ['Functional', 'Partially functional', 'Not functional', 'Abandoned'], { required: true }],
      ['Reason not functional', 'textarea', [], {
        condition: { on: 'Status', op: 'neq', value: 'Functional' },
        placeholder: 'What is wrong, and what would fix it?'
      }],
      ['Depth (m)', 'number'],
      ['Static water level (m)', 'number'],
      ['Yield (l/s)', 'number'],
      ['Water quality tested', 'boolean'],
      ['Households served', 'number'],
      ['Commissioned', 'date']
    ]
  },
  {
    id: 'septic_tank', cat: 'water', name: 'Septic Tank',
    blurb: 'On-site sanitation, as a lid point where that is all you can reach, or a footprint.',
    geometryTypes: ['point', 'polygon'], color: '#84CC16', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Tank reference', 'text'],
      ['Serving property', 'text'],
      ['Capacity (litres)', 'number'],
      ['Material', 'single_select', ['Concrete', 'Plastic', 'Brick', 'Fibreglass', 'Unknown']],
      ['Last emptied', 'date'],
      ['Condition', 'single_select', ['Good', 'Cracked', 'Overflowing', 'Collapsed'], { required: true }],
      ['Lid secure', 'boolean'],
      ['Notes', 'textarea']
    ]
  },
  {
    id: 'pipeline', cat: 'water', name: 'Pipeline',
    blurb: 'Water or sewer run, with material, diameter and per-vertex depth.',
    geometryTypes: ['line'], color: '#3B82F6', shape: 'circle', lineStyle: 'dashed', fill: true,
    fields: [
      ['Pipeline reference', 'text', [], { required: true }],
      ['Carries', 'single_select', ['Potable water', 'Raw water', 'Sewer', 'Storm water'], { required: true }],
      ['Material', 'single_select', ['uPVC', 'HDPE', 'Steel', 'Asbestos cement', 'Concrete', 'Unknown']],
      ['Diameter (mm)', 'number'],
      ['Depth at this point (m)', 'number', [], { scope: 'vertex' }],
      ['Installed', 'date']
    ]
  },
  {
    id: 'manhole', cat: 'water', name: 'Manhole / Chamber',
    blurb: 'Access chamber with cover condition, invert depth and a surcharge check.',
    geometryTypes: ['point'], color: '#64748B', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Chamber ID', 'text', [], { required: true }],
      ['Cover material', 'single_select', ['Cast iron', 'Concrete', 'Steel', 'Plastic', 'Missing']],
      ['Cover condition', 'single_select', ['Good', 'Cracked', 'Loose', 'Missing'], { required: true }],
      ['Depth to invert (m)', 'number'],
      ['Surcharged', 'boolean'],
      ['Silt / blockage', 'single_select', ['None', 'Light', 'Heavy', 'Blocked']]
    ]
  },

  // ── LAND & BOUNDARY ──
  {
    id: 'boundary_marker', cat: 'land', name: 'Boundary Marker',
    blurb: 'Beacon or peg with condition, and a description that appears only when damaged.',
    geometryTypes: ['point'], color: '#10B981', shape: 'triangle', lineStyle: 'solid', fill: true,
    fields: [
      ['Marker ID', 'barcode', [], { required: true, placeholder: 'Scan or type the tag' }],
      ['Marker type', 'single_select', ['Concrete beacon', 'Iron peg', 'Survey nail', 'Stone', 'Fence corner']],
      ['Condition', 'single_select', ['Good', 'Leaning', 'Damaged', 'Missing'], { required: true }],
      ['Damage description', 'textarea', [], {
        condition: { on: 'Condition', op: 'eq', value: 'Damaged' },
        placeholder: 'What is wrong with it?'
      }],
      ['Found or placed', 'single_select', ['Found existing', 'Newly placed', 'Reinstated']],
      ['Surveyed on', 'date']
    ]
  },
  {
    id: 'parcel', cat: 'land', name: 'Land Parcel',
    blurb: 'Cadastral parcel with reference, land use and tenure. Outline only, so imagery reads through.',
    geometryTypes: ['polygon'], color: '#F59E0B', shape: 'circle', lineStyle: 'dotted', fill: false,
    fields: [
      ['Parcel reference', 'text', [], { required: true, placeholder: 'e.g. PLOT-01' }],
      ['Land use', 'single_select', ['Residential', 'Commercial', 'Industrial', 'Agricultural', 'Institutional', 'Vacant', 'Public open space'], { required: true }],
      ['Tenure', 'single_select', ['Freehold', 'Leasehold', 'Customary', 'State', 'Disputed', 'Unknown']],
      ['Registered owner', 'text'],
      ['Occupied', 'boolean'],
      ['Corners verified', 'boolean'],
      ['Surveyed on', 'date'],
      ['Notes', 'textarea']
    ]
  },
  {
    id: 'fence_line', cat: 'land', name: 'Fence Line',
    blurb: 'Boundary fence with type, height and a per-vertex condition.',
    geometryTypes: ['line'], color: '#A16207', shape: 'circle', lineStyle: 'dashed', fill: true,
    fields: [
      ['Fence type', 'single_select', ['Wire mesh', 'Barbed wire', 'Palisade', 'Wall', 'Hedge', 'Post and rail'], { required: true }],
      ['Height (m)', 'number'],
      ['On the boundary', 'boolean'],
      ['Condition at this point', 'single_select', ['Intact', 'Sagging', 'Broken', 'Missing'], { scope: 'vertex' }],
      ['Notes', 'textarea']
    ]
  },
  {
    id: 'easement', cat: 'land', name: 'Easement / Servitude',
    blurb: 'A right-of-way or wayleave strip. Dashed outline, no fill.',
    geometryTypes: ['polygon', 'line'], color: '#EC4899', shape: 'circle', lineStyle: 'dashed', fill: false,
    fields: [
      ['Easement reference', 'text', [], { required: true }],
      ['Purpose', 'single_select', ['Access', 'Water pipeline', 'Sewer', 'Power line', 'Drainage', 'Other'], { required: true }],
      ['Width (m)', 'number'],
      ['Beneficiary', 'text'],
      ['Registered', 'boolean'],
      ['Notes', 'textarea']
    ]
  },

  // ── BUILDINGS & STRUCTURES ──
  {
    id: 'building', cat: 'buildings', name: 'Building',
    blurb: 'Footprint where the building is exposed, a single point where it is not.',
    geometryTypes: ['polygon', 'point'], color: '#EF4444', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Building name / number', 'text', [], { required: true }],
      ['Structure type', 'single_select', ['House', 'Apartment block', 'Shop', 'Office', 'Shed', 'Workshop', 'Warehouse', 'Other'], { required: true }],
      ['Storeys', 'number', [], { placeholder: 'e.g. 2' }],
      ['Wall material', 'single_select', ['Brick', 'Block', 'Concrete', 'Timber', 'Sheet metal', 'Mud / traditional']],
      ['Roof material', 'single_select', ['Tile', 'Sheet metal', 'Thatch', 'Concrete', 'Asbestos', 'Other']],
      ['Services connected', 'multi_select', ['Water', 'Electricity', 'Sewer', 'Data']],
      ['Occupied', 'boolean'],
      ['Condition', 'single_select', ['Good', 'Fair', 'Poor', 'Derelict'], { required: true }]
    ]
  },
  {
    id: 'building_inspection', cat: 'buildings', name: 'Building Inspection',
    blurb: 'A condition survey visit: inspector, date, and a repeating room-by-room defect log.',
    geometryTypes: ['point', 'polygon'], color: '#F97316', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Property reference', 'text', [], { required: true }],
      ['Inspector', 'text', [], { required: true }],
      ['Inspection date', 'date', [], { required: true }],
      ['Overall rating', 'single_select', ['A (good)', 'B (fair)', 'C (poor)', 'D (failed)'], { required: true }],
      ['Follow-up required', 'boolean'],
      ['Findings', 'repeat_group', [], { subfields: [
        ['Element', 'single_select', ['Roof', 'Walls', 'Floors', 'Windows', 'Doors', 'Plumbing', 'Electrical', 'Drainage'], { required: true }],
        ['Condition', 'single_select', ['Good', 'Fair', 'Poor', 'Failed'], { required: true }],
        ['Action', 'single_select', ['None', 'Monitor', 'Repair', 'Replace']],
        ['Estimated cost', 'number'],
        ['Comment', 'text']
      ]}]
    ]
  },
  {
    id: 'water_tank', cat: 'buildings', name: 'Water Tank / Reservoir',
    blurb: 'Storage structure with capacity, material and a level reading.',
    geometryTypes: ['point', 'polygon'], color: '#0284C7', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Tank reference', 'text', [], { required: true }],
      ['Capacity (litres)', 'number'],
      ['Material', 'single_select', ['Plastic', 'Steel', 'Concrete', 'Fibreglass']],
      ['Mounting', 'single_select', ['Ground', 'Stand', 'Elevated tower', 'Underground']],
      ['Level at inspection', 'single_select', ['Full', 'Three quarters', 'Half', 'Quarter', 'Empty']],
      ['Leaking', 'boolean'],
      ['Condition', 'single_select', ['Good', 'Fair', 'Poor'], { required: true }]
    ]
  },

  // ── ROADS & TRANSPORT ──
  {
    id: 'road', cat: 'transport', name: 'Road / Access Track',
    blurb: 'Road centreline with surface, width and a per-vertex condition.',
    geometryTypes: ['line'], color: '#0EA5E9', shape: 'circle', lineStyle: 'dashed', fill: true,
    fields: [
      ['Road name', 'text', [], { placeholder: 'e.g. Mill Lane' }],
      ['Surface', 'single_select', ['Paved', 'Gravel', 'Earth', 'Unformed'], { required: true }],
      ['Width (m)', 'number', [], { placeholder: 'e.g. 4.5' }],
      ['Passable by truck', 'boolean'],
      ['Condition at this point', 'single_select', ['Good', 'Rutted', 'Potholed', 'Washed out', 'Blocked'], { scope: 'vertex' }]
    ]
  },
  {
    id: 'road_sign', cat: 'transport', name: 'Road Sign',
    blurb: 'Traffic or street sign with class, legibility and a damage check.',
    geometryTypes: ['point'], color: '#DC2626', shape: 'triangle', lineStyle: 'solid', fill: true,
    fields: [
      ['Sign code', 'text', [], { placeholder: 'e.g. R1-1, or the local code' }],
      ['Sign class', 'single_select', ['Regulatory', 'Warning', 'Guidance', 'Street name', 'Information'], { required: true }],
      ['Legible', 'boolean', [], { required: true }],
      ['Problem', 'multi_select', ['Faded', 'Obscured by vegetation', 'Bent', 'Graffiti', 'Post damaged', 'Missing'], {
        condition: { on: 'Legible', op: 'eq', value: 'No' }
      }],
      ['Mounting height (m)', 'number'],
      ['Reflective', 'boolean']
    ]
  },
  {
    id: 'culvert', cat: 'transport', name: 'Culvert / Drainage Structure',
    blurb: 'Cross drainage with type, size and a blockage check.',
    geometryTypes: ['point', 'line'], color: '#0891B2', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Structure ID', 'text', [], { required: true }],
      ['Type', 'single_select', ['Pipe culvert', 'Box culvert', 'Causeway', 'Bridge', 'Open drain'], { required: true }],
      ['Diameter / span (mm)', 'number'],
      ['Number of barrels', 'number'],
      ['Blockage', 'single_select', ['Clear', 'Partly blocked', 'Fully blocked'], { required: true }],
      ['Headwall condition', 'single_select', ['Good', 'Cracked', 'Undermined', 'Collapsed', 'None']],
      ['Scour present', 'boolean']
    ]
  },

  // ── ENVIRONMENT & LAND COVER ──
  {
    id: 'tree', cat: 'environment', name: 'Tree',
    blurb: 'Individual tree with species, girth, health and a calculated canopy spread.',
    geometryTypes: ['point'], color: '#16A34A', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Tag number', 'barcode'],
      ['Species', 'text', [], { placeholder: 'Common or botanical name' }],
      ['Girth at breast height (cm)', 'number'],
      ['Height (m)', 'number'],
      ['Canopy radius (m)', 'number'],
      // Canopy diameter from radius: trivial arithmetic, but it is the number that goes on the
      // plan and typing it twice is how the two stop agreeing.
      ['Canopy diameter (m)', 'calculated', [], { expr: ['Canopy radius (m)', '*', 2] }],
      ['Health', 'single_select', ['Healthy', 'Stressed', 'Dying', 'Dead'], { required: true }],
      ['Action', 'single_select', ['None', 'Monitor', 'Prune', 'Fell', 'Protect']],
      ['Protected', 'boolean']
    ]
  },
  {
    id: 'land_cover', cat: 'environment', name: 'Land Cover Parcel',
    blurb: 'A mapped cover class (cropland, bush, wetland) as a filled polygon.',
    geometryTypes: ['polygon'], color: '#65A30D', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Cover class', 'single_select', ['Cropland', 'Grassland', 'Bush / shrub', 'Forest', 'Wetland', 'Bare ground', 'Built up', 'Open water'], { required: true }],
      ['Dominant species', 'text'],
      ['Canopy cover (%)', 'number'],
      ['Grazing present', 'boolean'],
      ['Erosion', 'single_select', ['None', 'Sheet', 'Rill', 'Gully']],
      ['Observed on', 'date'],
      ['Notes', 'textarea']
    ]
  },
  {
    id: 'water_body', cat: 'environment', name: 'Water Body',
    blurb: 'Dam, pond or pan with permanence and a use check.',
    geometryTypes: ['polygon', 'point'], color: '#2563EB', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Name', 'text'],
      ['Type', 'single_select', ['Dam', 'Pond', 'Pan', 'River', 'Reservoir', 'Canal'], { required: true }],
      ['Permanence', 'single_select', ['Permanent', 'Seasonal', 'Ephemeral'], { required: true }],
      ['Used for', 'multi_select', ['Domestic', 'Livestock', 'Irrigation', 'Fishing', 'None']],
      ['Fenced', 'boolean'],
      ['Approximate depth (m)', 'number']
    ]
  },
  {
    id: 'soil_sample', cat: 'environment', name: 'Soil Sample Point',
    blurb: 'Sampling location with depth, texture and a lab reference.',
    geometryTypes: ['point'], color: '#92400E', shape: 'triangle', lineStyle: 'solid', fill: true,
    fields: [
      ['Sample ID', 'barcode', [], { required: true }],
      ['Sampled on', 'date', [], { required: true }],
      ['Depth from (cm)', 'number'],
      ['Depth to (cm)', 'number'],
      ['Texture', 'single_select', ['Sand', 'Loamy sand', 'Sandy loam', 'Loam', 'Clay loam', 'Clay']],
      ['Colour', 'text'],
      ['Sent to lab', 'boolean'],
      ['Lab reference', 'text', [], { condition: { on: 'Sent to lab', op: 'eq', value: 'Yes' } }]
    ]
  },

  // ── COMMUNITY & FACILITIES ──
  {
    id: 'school', cat: 'community', name: 'School',
    blurb: 'Education facility with level, enrolment and services.',
    geometryTypes: ['point', 'polygon'], color: '#7C3AED', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['School name', 'text', [], { required: true }],
      ['Level', 'multi_select', ['Pre-primary', 'Primary', 'Secondary', 'Tertiary', 'Vocational'], { required: true }],
      ['Ownership', 'single_select', ['Government', 'Private', 'Mission', 'Community']],
      ['Learners enrolled', 'number'],
      ['Classrooms', 'number'],
      ['Services', 'multi_select', ['Water', 'Electricity', 'Sanitation', 'Internet', 'Feeding scheme']],
      ['Condition', 'single_select', ['Good', 'Fair', 'Poor'], { required: true }]
    ]
  },
  {
    id: 'health_facility', cat: 'community', name: 'Health Facility',
    blurb: 'Clinic or hospital with level, staffing and opening hours.',
    geometryTypes: ['point', 'polygon'], color: '#DB2777', shape: 'square', lineStyle: 'solid', fill: true,
    fields: [
      ['Facility name', 'text', [], { required: true }],
      ['Level', 'single_select', ['Health post', 'Clinic', 'Health centre', 'District hospital', 'Referral hospital'], { required: true }],
      ['Ownership', 'single_select', ['Government', 'Private', 'Mission', 'NGO']],
      ['Beds', 'number'],
      ['Clinical staff', 'number'],
      ['Open', 'single_select', ['24 hours', 'Weekdays only', 'Selected days', 'Closed']],
      ['Services', 'multi_select', ['Maternity', 'Laboratory', 'Pharmacy', 'Ambulance', 'Cold chain']],
      ['Power backup', 'boolean']
    ]
  },
  {
    id: 'community_asset', cat: 'community', name: 'Community Asset',
    blurb: 'A general-purpose asset record. Anything owned and inspected on a cycle.',
    geometryTypes: ['point', 'polygon', 'line'], color: '#0D9488', shape: 'circle', lineStyle: 'solid', fill: true,
    fields: [
      ['Asset name', 'text', [], { required: true }],
      ['Asset number', 'barcode'],
      ['Category', 'single_select', ['Building', 'Equipment', 'Infrastructure', 'Vehicle', 'Land', 'Other'], { required: true }],
      ['Owner / custodian', 'text'],
      ['Acquired', 'date'],
      ['Replacement value', 'number'],
      ['Condition', 'single_select', ['Excellent', 'Good', 'Fair', 'Poor', 'Failed'], { required: true }],
      ['In use', 'boolean'],
      ['Inspection notes', 'textarea']
    ]
  }
];


// ══ BUILDING A REAL FEATURE TYPE OUT OF A PRESET ══
// The output of this has to be byte-for-byte the shape saveFeatureType() writes, or a preset type
// behaves subtly differently from a hand-built one — a missing `scope` renders a feature-scoped
// field as vertex-scoped, a missing `condition:null` makes refreshFieldConditionsAndCalcs() throw.
// So this mirrors that function's field mapping deliberately rather than approximating it.
function plotarchiveFieldId(){
  return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function plotarchiveBuildField(tuple, idByLabel){
  const [label, type, options, extras] = tuple;
  const x = extras || {};
  return {
    id: idByLabel[label],
    label,
    type,
    options: options || [],
    required: !!x.required,
    placeholder: x.placeholder || '',
    // Same rule as the editor: a repeating group is always feature-scoped, because an entry list
    // hanging off a single vertex is not a thing the capture form can render.
    scope: type === 'repeat_group' ? 'feature' : (x.scope === 'vertex' ? 'vertex' : 'feature'),
    // The catalogue names the controlling field BY LABEL, because the ids do not exist until this
    // function runs. A condition pointing at a label that is not in the preset is dropped rather
    // than written as a dangling reference — a condition on a field that does not exist would
    // hide the dependent field forever with no way to reveal it.
    condition: (x.condition && idByLabel[x.condition.on])
      ? { fieldId: idByLabel[x.condition.on], op: x.condition.op || 'eq', value: x.condition.value == null ? '' : String(x.condition.value) }
      : null,
    expression: type === 'calculated' ? plotarchiveExpression(x.expr, idByLabel) : '',
    subfields: type === 'repeat_group'
      ? (x.subfields || []).map(st => ({
          id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
          label: st[0], type: st[1], options: st[2] || [],
          required: !!(st[3] && st[3].required), placeholder: (st[3] && st[3].placeholder) || ''
        }))
      : []
  };
}

// expr is a small token array — ['Pole height (m)', '-', 'Lowest wire (m)'] — where a string that
// names a field in this preset becomes that field's generated id and anything else is passed
// through as a literal. Written this way so the catalogue can express a calculation without
// knowing the ids, and so a typo in a field name fails loudly here rather than producing an
// expression that silently evaluates to nothing.
function plotarchiveExpression(expr, idByLabel){
  if (!Array.isArray(expr) || !expr.length) return '';
  return expr.map(tok => {
    if (typeof tok === 'string' && idByLabel[tok]) return idByLabel[tok];
    return String(tok);
  }).join(' ');
}

// Same collision guard as plotpackUniqueName(): adding "Building" twice should give you a second
// one to edit, not two rows you cannot tell apart in the picker on Collect.
function plotarchiveUniqueName(name){
  const taken = new Set(featureTypes.map(t => (t.name || '').trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let n = 2; n < 500; n++){
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return `${name} ${Date.now()}`;
}

function plotarchiveEntry(id){ return PLOTARCHIVE.find(e => e.id === id); }

// Already in this project? Matched on archiveId rather than on name, so a type the crew has since
// renamed to "Pole (MV)" is still recognised as the one they added — which is the whole reason
// archiveId is written onto the created type in the first place.
function plotarchiveIsAdded(id){
  return featureTypes.some(t => t.archiveId === id);
}

function plotarchiveToFeatureType(entry){
  // Every label gets its id first, so a condition or a calculation can point at a field defined
  // LATER in the same preset — the catalogue should not have to be written in dependency order.
  const idByLabel = {};
  entry.fields.forEach(t => { idByLabel[t[0]] = plotarchiveFieldId(); });
  const geos = entry.geometryTypes && entry.geometryTypes.length ? entry.geometryTypes.slice() : ['point'];
  return {
    id: 'ft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: plotarchiveUniqueName(entry.name),
    // geometryType stays the FIRST permitted geometry, matching saveFeatureType(): it is what
    // every pre-existing reader in the app treats as "the" geometry of a type.
    geometryType: geos[0],
    geometryTypes: geos,
    color: entry.color || null,
    shape: entry.shape || 'circle',
    lineStyle: entry.lineStyle || 'solid',
    fill: entry.fill !== false,
    fields: entry.fields.map(t => plotarchiveBuildField(t, idByLabel)),
    // Provenance. Used by plotarchiveIsAdded() above, and it costs nothing to carry — but it is
    // deliberately NOT read anywhere that changes behaviour. An added type is an ordinary type.
    archiveId: entry.id
  };
}


// ══ THE PICKER ══
let plotarchiveSelected = new Set();
let plotarchiveCategory = 'all';
let plotarchiveQuery = '';
let plotarchiveExpanded = null;   // id of the entry whose field list is open

// ══ TWO MODES, BECAUSE THERE ARE TWO MOMENTS ══
// 'project'  the library was opened from the Feature Types list. Picking commits: the chosen
//            presets become real feature types straight away, several at a time.
// 'editor'   the library was opened from INSIDE the feature type editor, which is the moment
//            somebody is actually building one. Picking must not commit anything. It loads the
//            preset into the form that is already open, leaving Save exactly where it was, so the
//            preset is a starting point being edited rather than a thing that appeared and now
//            has to be found and edited afterwards.
//
// Without the second mode the library was only reachable BEFORE deciding to create a type. The
// person who tapped "New feature type" first, then realised there was probably a ready-made pole,
// had to back out, lose the form, add from the list, then reopen what they had just left. Same
// catalogue, same rows; the difference is only what a tap means, so the two share everything
// except plotarchiveCommit().
let plotarchiveMode = 'project';

function openPlotArchive(mode){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  plotarchiveMode = mode === 'editor' ? 'editor' : 'project';
  plotarchiveSelected = new Set();
  plotarchiveCategory = 'all';
  plotarchiveQuery = '';
  plotarchiveExpanded = null;
  const input = document.getElementById('plotarchiveSearch');
  if (input) input.value = '';
  renderPlotArchive();
  document.getElementById('plotarchiveModal').classList.add('show');
  // First-open explainer, same as every other Plot* module (js/21a-plotwords.js).
  if (typeof plotwordsExplain === 'function') plotwordsExplain('plotarchive');
}

// Opened from the feature type editor's own "Start from PlotArchive" row.
function openPlotArchiveForEditor(){ openPlotArchive('editor'); }

function closePlotArchive(){
  const el = document.getElementById('plotarchiveModal');
  if (el) el.classList.remove('show');
  if (typeof dismissKeyboard === 'function') dismissKeyboard();
}

function plotarchiveSetCategory(cat){
  plotarchiveCategory = cat;
  renderPlotArchive();
}

function plotarchiveOnSearch(v){
  plotarchiveQuery = (v || '').trim().toLowerCase();
  renderPlotArchive();
}

function plotarchiveToggle(id){
  if (plotarchiveSelected.has(id)) plotarchiveSelected.delete(id);
  else {
    // One form, one starting point: in editor mode a second pick REPLACES the first rather than
    // adding to it, because there is nowhere for a second preset to go.
    if (plotarchiveMode === 'editor') plotarchiveSelected.clear();
    plotarchiveSelected.add(id);
  }
  renderPlotArchive();
}

// Tapping the row body opens the field list rather than selecting, so "what is actually in this?"
// is answerable without committing to it. Selection is the checkbox, deliberately separate: a
// list where reading and choosing are the same gesture is a list you cannot browse.
function plotarchiveToggleExpand(id){
  plotarchiveExpanded = plotarchiveExpanded === id ? null : id;
  renderPlotArchive();
}

function plotarchiveMatches(entry){
  if (plotarchiveCategory !== 'all' && entry.cat !== plotarchiveCategory) return false;
  if (!plotarchiveQuery) return true;
  // Field labels are searched too, which is what makes the box worth having: "serial" finds the
  // water meter, "defect" finds the pole, and neither word is in either name.
  const hay = [
    entry.name, entry.blurb,
    ...entry.fields.map(f => f[0]),
    ...entry.fields.flatMap(f => (f[2] || []))
  ].join(' ').toLowerCase();
  return hay.includes(plotarchiveQuery);
}

function plotarchiveFieldSummary(entry){
  const bits = [];
  const n = entry.fields.length;
  bits.push(`${n} field${n === 1 ? '' : 's'}`);
  if (entry.fields.some(f => f[3] && f[3].required)) bits.push('required');
  if (entry.fields.some(f => f[3] && f[3].condition)) bits.push('skip logic');
  if (entry.fields.some(f => f[1] === 'calculated')) bits.push('calculated');
  if (entry.fields.some(f => f[3] && f[3].scope === 'vertex')) bits.push('per-vertex');
  if (entry.fields.some(f => f[1] === 'repeat_group')) bits.push('repeating');
  return bits.join(' · ');
}

function renderPlotArchive(){
  const chipsEl = document.getElementById('plotarchiveChips');
  const listEl = document.getElementById('plotarchiveList');
  const countEl = document.getElementById('plotarchiveCount');
  const addBtn = document.getElementById('plotarchiveAddBtn');
  if (!listEl) return;

  if (chipsEl){
    const chip = (id, label, icon) =>
      `<button type="button" class="pa-chip ${plotarchiveCategory === id ? 'sel' : ''}" onclick="plotarchiveSetCategory('${id}')">${icon ? icon + ' ' : ''}${escapeHtml(label)}</button>`;
    chipsEl.innerHTML = chip('all', 'All', '📚')
      + PLOTARCHIVE_CATEGORIES.map(c => chip(c.id, c.label, c.icon)).join('');
  }

  const shown = PLOTARCHIVE.filter(plotarchiveMatches);
  if (!shown.length){
    listEl.innerHTML = `<div class="empty-box"><strong>Nothing matches</strong>Try a different word, or switch to All.</div>`;
  } else {
    listEl.innerHTML = shown.map(e => {
      const sel = plotarchiveSelected.has(e.id);
      const added = plotarchiveIsAdded(e.id);
      const open = plotarchiveExpanded === e.id;
      const geos = (e.geometryTypes || ['point']);
      // The same legend glyph the maps and the feature type list draw, so what the picker promises
      // is literally what will be rendered once the type exists.
      const glyphs = geos.map(g =>
        `<span class="pa-glyph">${legendGlyphSvg(g, e.color, e.shape, e.lineStyle, e.fill !== false)}</span>`).join('');
      const fieldRows = open ? `<div class="pa-fields">${e.fields.map(f => {
        const extras = f[3] || {};
        const tags = [];
        if (extras.required) tags.push('required');
        if (extras.scope === 'vertex') tags.push('per vertex');
        if (extras.condition) tags.push('conditional');
        if (f[1] === 'calculated') tags.push('calculated');
        if (f[1] === 'repeat_group') tags.push(`${(extras.subfields || []).length} sub-fields`);
        const typeLabel = (FIELD_TYPES.find(t => t.value === f[1]) || {}).label || f[1];
        return `<div class="pa-field-row">
            <span class="pa-field-label">${escapeHtml(f[0])}</span>
            <span class="pa-field-type">${escapeHtml(typeLabel)}${(f[2] || []).length ? ` · ${(f[2] || []).length} choices` : ''}</span>
            ${tags.length ? `<span class="pa-field-tags">${tags.map(t => `<span class="pa-field-tag">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
          </div>`;
      }).join('')}</div>` : '';

      return `<div class="pa-row ${sel ? 'sel' : ''}">
        <div class="pa-row-head">
          <button type="button" class="pa-check ${sel ? 'on' : ''}" onclick="plotarchiveToggle('${e.id}')"
                  role="checkbox" aria-checked="${sel ? 'true' : 'false'}" aria-label="Select ${escapeHtml(e.name)}">
            ${sel ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
          </button>
          <button type="button" class="pa-row-body" onclick="plotarchiveToggleExpand('${e.id}')" aria-expanded="${open ? 'true' : 'false'}">
            <span class="pa-row-title">
              <span class="pa-glyphs">${glyphs}</span>
              <span class="pa-row-name">${escapeHtml(e.name)}</span>
              ${added ? '<span class="pa-added">In project</span>' : ''}
            </span>
            <span class="pa-row-blurb">${escapeHtml(e.blurb)}</span>
            <span class="pa-row-meta">${escapeHtml(plotarchiveFieldSummary(e))}</span>
          </button>
          <svg class="pa-row-chevron ${open ? 'open' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        ${fieldRows}
      </div>`;
    }).join('');
  }

  const n = plotarchiveSelected.size;
  if (countEl) countEl.textContent = n ? `${n} selected` : `${shown.length} of ${PLOTARCHIVE.length} shown`;
  if (addBtn){
    addBtn.disabled = !n;
    // The button has to say what the tap will actually do, because the two modes do genuinely
    // different things and "Add" would be a lie in the editor, where nothing is saved.
    addBtn.textContent = plotarchiveMode === 'editor'
      ? (n ? 'Load into the form' : 'Load into the form')
      : (n ? `Add ${n} feature type${n === 1 ? '' : 's'}` : 'Add feature types');
  }
  const sub = document.getElementById('plotarchiveSubtitle');
  if (sub) sub.textContent = plotarchiveMode === 'editor'
    ? 'Pick one to load into the form you are filling in. Nothing is saved until you tap Save, and every field stays editable.'
    : 'Pick one or more to add to this project. Tap a row to see its fields first. Everything is fully editable once added.';
}

// ══ COMMITTING ══
// The single entry point behind the sheet's action button. Which of the two it runs is the ONLY
// behavioural difference between the modes.
function plotarchiveCommit(){
  if (plotarchiveMode === 'editor') plotarchiveLoadIntoEditor();
  else plotarchiveAddSelected();
}

// ══ LOADING INTO THE OPEN EDITOR ══
// Writes the preset into the editor's working state and nothing else. No feature type is created,
// persist() is never called, and `editingFt` is left exactly as it was: if the editor was opened
// on an EXISTING type, loading a preset overwrites the form but still saves back over that same
// type, which is what "start this one from a preset" has to mean.
//
// Everything goes through the same plotarchiveToFeatureType() the other mode uses, so a loaded
// preset and an added one cannot diverge. The built type is then unpacked into the editor's
// working variables in the same shape editFeatureType() uses, which is what makes the form
// render it correctly without any preset-specific rendering path.
function plotarchiveLoadIntoEditor(){
  const id = [...plotarchiveSelected][0];
  const entry = plotarchiveEntry(id);
  if (!entry) return;
  const built = plotarchiveToFeatureType(entry);

  // A name the user has already typed is theirs and is not overwritten: they may be building
  // "MV Pole" and reaching for the generic pole's fields.
  const nameEl = document.getElementById('ftName');
  if (nameEl && !nameEl.value.trim()) nameEl.value = entry.name;

  editingFtFields = built.fields;
  editingFtColor = built.color;
  editingFtShape = built.shape;
  editingFtLineStyle = built.lineStyle;
  editingFtFill = built.fill;
  // silent: reflect the preset's geometries without the toast writeFtGeoSelection() fires when a
  // human taps the toggle.
  setFtGeo(built.geometryTypes, true);
  renderFtFieldsList();
  renderFtColorPicker();
  renderFtStyleControls();

  closePlotArchive();
  showToast(`"${entry.name}" loaded. Edit anything, then tap Save`);
}

// ══ ADDING ══
// Additive and non-destructive: nothing already in the project is touched, and a name collision
// becomes "Building 2" rather than a merge. If the write is refused the whole batch is rolled
// back — a half-added set would leave the crew guessing which of the five they picked survived.
function plotarchiveAddSelected(){
  const ids = [...plotarchiveSelected];
  if (!ids.length) return;
  const before = featureTypes.slice();
  const added = [];
  ids.forEach(id => {
    const entry = plotarchiveEntry(id);
    if (!entry) return;
    const ft = plotarchiveToFeatureType(entry);
    featureTypes.push(ft);
    added.push(ft);
  });
  if (!added.length) return;
  if (persist() === false){
    featureTypes = before;
    showToast('Could not save to this device, nothing was added');
    return;
  }
  populateFeatureTypeSelect();
  closePlotArchive();
  renderFeatureTypesList();
  // One added type goes straight into its own editor: the overwhelmingly common case is "this one,
  // with two changes", and making that a second navigation would be the difference between the
  // library saving work and merely relocating it. A batch does not, because there is no single
  // type to open and guessing would be worse than landing on the list.
  if (added.length === 1){
    showToast(`"${added[0].name}" added. Edit anything you like`);
    editFeatureType(added[0].id);
  } else {
    showToast(`${added.length} feature types added ✓`);
  }
}
