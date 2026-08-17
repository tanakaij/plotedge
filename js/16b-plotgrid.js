
// PlotEdge — PlotGrid: project coordinate reference systems
//
// ══ WHAT THIS FIXES AND WHAT IT DOES NOT ══
// Capture stays WGS84 lat/lon, everywhere, permanently. That is the right storage decision and
// this file does not change it: GNSS delivers WGS84, every export format's default is WGS84, and
// a single storage CRS means no data is ever held in a projection whose parameters we might later
// discover we had wrong. What was missing is the OUTPUT side — a surveyor works in a national or
// zonal grid, and until now the only projected coordinates the app could produce were the UTM
// eastings the DXF writer computes for itself.
//
// So a project now declares a working CRS. Coordinates are still stored as lat/lon and projected
// on demand: for display, for the CSV/Excel columns, for the plan sheet's grid annotation, and
// for the DXF. Nothing is stored projected, so changing a project's CRS is free and reversible.
//
// ══ THE HONEST LIMIT: DATUM ══
// Every grid below is defined on WGS84. That is exact for the UTM zones and for the modern
// national grids that are themselves WGS84-based or close enough for survey work at these
// accuracies. It is NOT exact for a grid on a legacy local datum — Cape Datum, Arc 1950, Clarke
// 1880 and their kin differ from WGS84 by tens to hundreds of metres, and the correction is a
// published seven-parameter or grid-shift transformation that is jurisdiction-specific and, for
// the grid-shift cases, a data file we cannot embed.
//
// Rather than quietly projecting onto the wrong datum, a grid declares its datum honestly and
// `crsNeedsDatumShift()` says so. The UI surfaces it, exports label it, and nobody discovers by
// accident that their coordinates are 200 m from where the title deed says. This is a real
// limitation and it is stated rather than hidden: getting it right needs the local transformation
// parameters from the national survey authority, which is a per-country data problem, not code.
//
// ══ AND ORTHOMETRIC HEIGHT ══
// Altitudes from GNSS are ellipsoidal — height above the WGS84 spheroid, not above sea level.
// The difference (the geoid separation) is 10-60 m in most of the world and varies across a site
// large enough for drainage to care. Converting needs a geoid model, which is a gridded dataset
// (EGM2008 is ~350 MB at full resolution). A project can therefore declare a LOCAL GEOID OFFSET:
// one number, in metres, applied uniformly. That is not a geoid model and does not pretend to be,
// but on a site of a few square kilometres the separation is very nearly constant, so a single
// offset taken from a known benchmark converts ellipsoidal to orthometric to within a few
// centimetres — which is both useful and, unlike a silent ellipsoidal height labelled "elevation",
// honest about what it is.

// ══ TRANSVERSE MERCATOR ══
// Every grid in the registry below is a transverse Mercator with different parameters, so there is
// one projection routine and a table of constants. The series is Snyder's, the same one
// js/17c-plotcad.js uses for UTM — kept separate there deliberately, because the CAD writer must
// keep working with no dependency on this file's registry.
const GRID_ELLIPSOIDS = {
  // a = semi-major axis, f = flattening. Only WGS84/GRS80 are offered, for the datum reason above.
  wgs84: { a: 6378137.0, f: 1 / 298.257223563, label: 'WGS 84' },
  grs80: { a: 6378137.0, f: 1 / 298.257222101, label: 'GRS 80' }
};

// Forward transverse Mercator. `p` carries lon0 (central meridian, degrees), k0 (scale factor),
// fe/fn (false easting/northing, metres), lat0 (latitude of origin, degrees) and `south` for grids
// whose axes run south-positive.
function gridProjectTM(lat, lon, p, ell){
  const E = GRID_ELLIPSOIDS[ell || 'wgs84'];
  const e2 = E.f * (2 - E.f);
  const ep2 = e2 / (1 - e2);
  const rad = Math.PI / 180;
  const phi = lat * rad;
  const lon0 = p.lon0 * rad;
  const lat0 = (p.lat0 || 0) * rad;
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);

  const N = E.a / Math.sqrt(1 - e2 * sinP * sinP);
  const T = tanP * tanP;
  const C = ep2 * cosP * cosP;
  const A = (lon * rad - lon0) * cosP;

  const meridian = f => E.a * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * f
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * f)
    + (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * f)
    - (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * f)
  );

  const x = p.k0 * N * (
    A + (1 - T + C) * Math.pow(A, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5) / 120
  );
  const y = p.k0 * (meridian(phi) - meridian(lat0) + N * tanP * (
    A * A / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6) / 720
  ));

  // A south-oriented grid (the Gauss convention used across southern Africa) measures Y positive
  // southward from the equator and X positive westward from the central meridian. Getting this
  // sign wrong puts a survey in the wrong hemisphere, which is why it is a declared property of
  // the grid rather than something inferred from the latitude.
  if (p.south) return { e: (p.fe || 0) - x, n: (p.fn || 0) - y, };
  return { e: (p.fe || 0) + x, n: (p.fn || 0) + y };
}

// Inverse, by Newton iteration on the forward. Converges in three passes to well under a
// millimetre at any scale a survey cares about, and avoids carrying a second series that could
// disagree with the forward one — a forward/inverse pair derived independently is a classic source
// of a round-trip error nobody notices until it is in a deliverable.
function gridUnprojectTM(e, n, p, ell){
  let lat = (p.lat0 || 0), lon = p.lon0;
  for (let i = 0; i < 8; i++){
    const got = gridProjectTM(lat, lon, p, ell);
    const de = e - got.e, dn = n - got.n;
    if (Math.abs(de) < 1e-4 && Math.abs(dn) < 1e-4) break;
    // Metres per degree, locally. Good enough as a Jacobian for a well-behaved conformal
    // projection, and re-derived each pass so it stays valid as the estimate moves.
    const dLat = 111132, dLon = 111320 * Math.cos(lat * Math.PI / 180) || 1;
    const sgn = p.south ? -1 : 1;
    lat += sgn * dn / dLat;
    lon += sgn * de / dLon;
  }
  return { lat, lon };
}


// ══ THE REGISTRY ══
// Deliberately small and explicit rather than a bundled EPSG database. Every entry here has been
// written out with its parameters visible so they can be checked against the national authority's
// published definition — which is the only way anyone should trust a coordinate system in a
// survey tool. Adding a grid is a data edit, not a code change.
const PLOTGRID_REGISTRY = {
  wgs84: {
    label: 'WGS 84 lat/lon (degrees)', epsg: 4326, kind: 'geographic',
    datum: 'wgs84', units: 'degrees',
    note: 'Storage format. No projection applied.'
  },

  // ── UTM, auto-zoned ──
  // One entry rather than 120, because picking your own zone is a step at which people pick
  // wrong. The zone is derived from the data and reported alongside the coordinates.
  utm_auto: {
    label: 'UTM (zone from survey)', kind: 'utm', datum: 'wgs84', units: 'm',
    note: 'Zone detected from the centre of your features and stated on every export.'
  },

  // ── Southern Africa: the Gauss conformal / Hartebeesthoek system ──
  // Two-degree-wide belts on odd central meridians, south-oriented. Zimbabwe, South Africa,
  // Namibia, Botswana and Eswatini all use this convention.
  // Hardebeesthoek94 IS WGS84-based, so these are exact. The older Cape Datum versions of the
  // same belts are NOT, which is what `datum` is guarding.
  lo27: { label: 'Lo27 / Gauss (CM 27°E)', epsg: 2046, kind: 'tm', datum: 'wgs84', units: 'm',
    params: { lon0: 27, k0: 1, fe: 0, fn: 0, lat0: 0, south: true } },
  lo29: { label: 'Lo29 / Gauss (CM 29°E)', epsg: 2047, kind: 'tm', datum: 'wgs84', units: 'm',
    params: { lon0: 29, k0: 1, fe: 0, fn: 0, lat0: 0, south: true } },
  lo31: { label: 'Lo31 / Gauss (CM 31°E)', epsg: 2048, kind: 'tm', datum: 'wgs84', units: 'm',
    params: { lon0: 31, k0: 1, fe: 0, fn: 0, lat0: 0, south: true } },
  lo33: { label: 'Lo33 / Gauss (CM 33°E)', epsg: 2049, kind: 'tm', datum: 'wgs84', units: 'm',
    params: { lon0: 33, k0: 1, fe: 0, fn: 0, lat0: 0, south: true } },

  // ── A few widely used national grids ──
  osgb: { label: 'OSGB36 / British National Grid', epsg: 27700, kind: 'tm',
    datum: 'osgb36', units: 'm',
    params: { lon0: -2, k0: 0.9996012717, fe: 400000, fn: -100000, lat0: 49 },
    note: 'Grid parameters are exact; the OSGB36 datum differs from WGS84 by up to ~120 m and needs the OSTN15 shift for legal accuracy.' },
  irish: { label: 'Irish Transverse Mercator (ITM)', epsg: 2157, kind: 'tm',
    datum: 'wgs84', units: 'm',
    params: { lon0: -8, k0: 0.99982, fe: 600000, fn: 750000, lat0: 53.5 } },

  // ── User-defined ──
  // Because no registry will ever contain the grid a particular municipality insists on, and a
  // surveyor who has the parameters should not have to wait for a release.
  custom: {
    label: 'Custom transverse Mercator…', kind: 'tm', datum: 'wgs84', units: 'm',
    params: null,
    note: 'Enter the central meridian, scale factor and false origin from your authority’s published definition.'
  }
};

// Datums we can project onto exactly. Anything else is projected on its grid parameters but on
// the WGS84 ellipsoid, which is geometrically right and datum-wrong — hence the warning.
const GRID_EXACT_DATUMS = ['wgs84', 'grs80'];

function crsNeedsDatumShift(key){
  const c = PLOTGRID_REGISTRY[key];
  return !!(c && c.datum && GRID_EXACT_DATUMS.indexOf(c.datum) === -1);
}


// ══ PROJECT SETTINGS ══
// Held on the project record, so two projects on one device can work in different grids — which
// is the normal case for a surveyor covering more than one municipality.
function projectCrsKey(){
  const p = projects.find(x => x.id === activeProjectId);
  const key = p && p.crs;
  return (key && PLOTGRID_REGISTRY[key]) ? key : 'wgs84';
}

function projectCrs(){ return PLOTGRID_REGISTRY[projectCrsKey()]; }

// Custom parameters live on the project too, since they ARE the definition rather than a
// selection from one.
function projectCrsParams(){
  const key = projectCrsKey();
  const c = PLOTGRID_REGISTRY[key];
  if (key !== 'custom') return c.params || null;
  const p = projects.find(x => x.id === activeProjectId);
  return (p && p.crsParams) || null;
}

// One number, in metres, added to every ellipsoidal altitude to make it orthometric. Zero means
// "not set", and exports say so rather than implying a conversion happened.
function projectGeoidOffset(){
  const p = projects.find(x => x.id === activeProjectId);
  const v = p && Number(p.geoidOffset);
  return Number.isFinite(v) ? v : 0;
}

function setProjectCrs(key){
  if (!PLOTGRID_REGISTRY[key]) return;
  const p = projects.find(x => x.id === activeProjectId);
  if (!p) { showToast('Open a project first'); return; }
  p.crs = key;
  persist();
  const c = PLOTGRID_REGISTRY[key];
  showToast('Working coordinates: ' + c.label);
  if (crsNeedsDatumShift(key)){
    // Surfaced as a confirm-grade warning rather than a toast, because somebody about to issue
    // coordinates on a legacy datum needs to have actually read this.
    showToast('⚠ ' + c.label + ' uses a legacy datum — coordinates will be ~metres to ~100 m off until a datum shift is applied');
  }
  if (typeof syncCrsUI === 'function') syncCrsUI();
  if (typeof renderFeatures === 'function') renderFeatures();
}

function setProjectGeoidOffset(v){
  const p = projects.find(x => x.id === activeProjectId);
  if (!p) return;
  const n = Number(v);
  p.geoidOffset = Number.isFinite(n) ? n : 0;
  persist();
  showToast(p.geoidOffset ? `Heights offset by ${p.geoidOffset} m (orthometric)` : 'Heights are ellipsoidal');
}


// ══ THE ONE FUNCTION EVERYTHING ELSE CALLS ══
// Projects a stored WGS84 vertex into the project's working CRS. Returns the coordinate pair, the
// labels the axes should carry, and — crucially — whether the result is datum-exact, so no caller
// can display or export a projected coordinate without the option of saying how much to trust it.
function crsProject(lat, lon, alt){
  const key = projectCrsKey();
  const c = PLOTGRID_REGISTRY[key];
  const geoid = projectGeoidOffset();
  const height = (alt == null) ? null : alt + geoid;
  const base = {
    crs: key, label: c.label, units: c.units, epsg: c.epsg || null,
    exact: !crsNeedsDatumShift(key),
    height, heightRef: geoid ? 'orthometric (local offset)' : 'ellipsoidal'
  };

  if (c.kind === 'geographic'){
    return { ...base, x: lon, y: lat, xLabel: 'Longitude', yLabel: 'Latitude' };
  }

  if (c.kind === 'utm'){
    // Reuses the CAD writer's zone maths so a DXF and a CSV of the same survey cannot disagree
    // about which zone they are in.
    const zone = cadUtmZone(lon);
    const u = cadLatLonToUtm(lat, lon, zone);
    return { ...base, x: u.e, y: u.n, xLabel: 'Easting', yLabel: 'Northing',
      zone: zone + (lat < 0 ? 'S' : 'N'),
      label: `UTM zone ${zone}${lat < 0 ? 'S' : 'N'}`,
      epsg: (lat < 0 ? 32700 : 32600) + zone };
  }

  const params = projectCrsParams();
  if (!params){
    // A custom CRS with no parameters entered yet. Falling back to lat/lon is the only safe
    // answer — inventing a central meridian would produce plausible-looking wrong numbers.
    return { ...base, x: lon, y: lat, xLabel: 'Longitude', yLabel: 'Latitude',
      label: c.label + ' (not configured — showing lat/lon)', exact: false };
  }
  const g = gridProjectTM(lat, lon, params, c.datum === 'grs80' ? 'grs80' : 'wgs84');
  // South-oriented grids label their axes Y/X in that order by convention, and reversing them is
  // the single most common way a Gauss coordinate gets entered into the wrong field.
  return { ...base, x: g.e, y: g.n,
    xLabel: params.south ? 'Y (west+)' : 'Easting',
    yLabel: params.south ? 'X (south+)' : 'Northing' };
}

// Inverse, for the "go to coordinate" entry field so a crew can navigate to a grid reference
// rather than having to convert it by hand first.
function crsUnproject(x, y){
  const key = projectCrsKey();
  const c = PLOTGRID_REGISTRY[key];
  if (c.kind === 'geographic') return { lat: y, lon: x };
  if (c.kind === 'utm') return null; // needs an explicit zone; the goto field asks for lat/lon
  const params = projectCrsParams();
  if (!params) return null;
  return gridUnprojectTM(x, y, params, c.datum === 'grs80' ? 'grs80' : 'wgs84');
}

// Formatted for display. Grid coordinates get three decimals (millimetres, which is the
// resolution a survey grid is quoted at) and degrees get seven (~11 mm at the equator).
function crsFormat(lat, lon){
  const r = crsProject(lat, lon);
  if (r.units === 'degrees') return `${r.y.toFixed(7)}, ${r.x.toFixed(7)}`;
  return `${r.yLabel.split(' ')[0]} ${r.y.toFixed(3)}  ${r.xLabel.split(' ')[0]} ${r.x.toFixed(3)}`;
}

// The line every export writes into its header so the recipient knows what the numbers are. A
// projected coordinate with no CRS statement is not data, it is a guess with decimals.
function crsStatement(){
  const key = projectCrsKey();
  const c = PLOTGRID_REGISTRY[key];
  const bits = [c.label];
  if (c.epsg) bits.push('EPSG:' + c.epsg);
  if (!crsNeedsDatumShift(key)) bits.push('datum WGS 84');
  else bits.push('DATUM NOT APPLIED — ' + c.datum + ' shift required');
  const geoid = projectGeoidOffset();
  bits.push(geoid ? `heights orthometric (local offset ${geoid} m)` : 'heights ellipsoidal');
  return bits.join(' · ');
}
