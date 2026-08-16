// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Import: CSV, GeoPackage, PostGIS command generation
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ IMPORT (CSV + GeoPackage) ══
// Mirrors the export side: CSV/GeoPackage in, using the same feature/vertex model saveFeature()
// builds, so imported data behaves exactly like anything captured natively (shows on the map,
// exports again, edits normally). GeoPackage reuses the sql.js engine already loaded for export;
// proj4 is a new, much smaller (~40KB) addition, only fetched if a layer actually needs
// reprojecting.
let _proj4Promise=null;

function ensureProj4(){
  if(_proj4Promise) return _proj4Promise;
  _proj4Promise=loadScript('https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.2/proj4.js');
  return _proj4Promise;
}


// Columns that carry structural meaning (geometry, grouping, or feature-level metadata) rather
// than becoming an arbitrary attribute field on import — shared between CSV and GeoPackage import
// so both agree on "what's plumbing vs. what's real data".
const IMPORT_META_ALIASES = {
  featureId:['feature_id'],
  name:['feature_name','name'], ref:['reference_id','ref'], assignedTo:['assigned_to','assignedto'],
  notes:['notes'], type:['feature_type','type'], geo:['geometry_type'],
  lat:['lat','latitude','y'], lon:['lon','lng','long','longitude','x'], wkt:['wkt','geometry','geom'],
  vi:['vertex_index'], tv:['total_vertices'], acc:['accuracy_m'], capturedAt:['captured_at'], alt:['altitude_m']
};

function detectCol(headers, key){
  const aliases = IMPORT_META_ALIASES[key];
  const lower = headers.map(h=>h.toLowerCase().trim());
  for(const a of aliases){ const idx=lower.indexOf(a); if(idx!==-1) return headers[idx]; }
  return null;
}


// Finds an existing feature type (by name+geometry) to reuse, or creates one — so repeated imports
// or a multi-layer GeoPackage don't spawn duplicate types every run. Unrecognized columns become
// new text fields so nothing from the source file is silently dropped.
function findOrCreateImportFeatureType(label, geometryType, extraColumns){
  let ft = featureTypes.find(t=>t.name.toLowerCase()===String(label).toLowerCase() && (!geometryType || t.geometryType===geometryType));
  if(!ft){
    ft = { id:'ft_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), name:String(label), geometryType:geometryType||'point', fields:[], color:null };
    featureTypes.push(ft);
  }
  const existing = new Set(ft.fields.map(f=>f.label.toLowerCase()));
  (extraColumns||[]).forEach(col=>{
    if(existing.has(col.toLowerCase())) return;
    existing.add(col.toLowerCase());
    ft.fields.push({ id:'f_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), label:col, type:'text', options:[], required:false, placeholder:'', scope:'feature' });
  });
  return ft;
}


// ── CSV ──
// RFC4180-ish parser: handles quoted fields containing the delimiter/newlines/escaped quotes.
// Delimiter is auto-detected (see detectCSVDelimiter) rather than hardcoded, so semicolon-
// delimited European exports (common when the file also uses commas as decimal separators) and
// tab/pipe-delimited files work the same way plain comma CSVs always have.
function detectCSVDelimiter(text){
  const candidates = [',', ';', '\t', '|'];
  // Only look at the header line, and only count delimiter chars that fall outside a quoted
  // field — a quoted "Smith, John" shouldn't bump the comma count for a semicolon file.
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] || '';
  let best = ',', bestCount = -1;
  for (const d of candidates){
    let count = 0, inQuotes = false;
    for (let i=0; i<firstLine.length; i++){
      const c = firstLine[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === d && !inQuotes) count++;
    }
    // Prefer the delimiter that actually splits the header into more than one column; ties go to
    // whichever candidate appears earlier in the list (comma stays the default when genuinely
    // ambiguous, e.g. a single-column file).
    if (count > bestCount){ bestCount = count; best = d; }
  }
  return bestCount > 0 ? best : ',';
}

function parseCSV(text, delimiter){
  const delim = delimiter || detectCSVDelimiter(text);
  const rows=[]; let row=[]; let field=''; let inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuotes){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i++; } else { inQuotes=false; } }
      else field+=c;
    } else {
      if(c==='"') inQuotes=true;
      else if(c===delim){ row.push(field); field=''; }
      else if(c==='\r'){ /* \n below ends the row */ }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else field+=c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  if(!rows.length) return {headers:[], rows:[], delimiter:delim};
  const headers=rows[0].map(h=>h.trim());
  const dataRows=rows.slice(1).filter(r=>r.some(c=>c!==''));
  return { headers, rows: dataRows.map(r=>{ const o={}; headers.forEach((h,i)=>o[h]=r[i]??''); return o; }), delimiter:delim };
}


// Minimal WKT reader — POINT/LINESTRING/POLYGON, optional Z, case-insensitive. Covers PlotEdge's
// own round-trip exports and most simple survey CSVs; MULTI* geometries are reported as
// unsupported by the caller rather than guessed at.
function parseWKT(wkt){
  const m = /^\s*(MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|POINT|LINESTRING|POLYGON)\s*Z?\s*\((.*)\)\s*$/is.exec(String(wkt).trim());
  if(!m) return null;
  const type = m[1].toUpperCase();
  const body = m[2];
  const parseCoord = s=>s.trim().split(/\s+/).map(Number);
  if(type==='POINT') return { geometryType:'point', vertices:[parseCoord(body)] };
  if(type==='LINESTRING') return { geometryType:'line', vertices: body.split(',').map(parseCoord) };
  if(type==='POLYGON'){
    const ringMatch = /\(([^()]*)\)/.exec(body);
    if(!ringMatch) return null;
    let coords = ringMatch[1].split(',').map(parseCoord);
    if(coords.length>1){
      const [fx,fy]=coords[0], [lx,ly]=coords[coords.length-1];
      if(fx===lx && fy===ly) coords=coords.slice(0,-1);
    }
    return { geometryType:'polygon', vertices:coords };
  }
  return null;
}


function prepareCSVImport(file){
  const reader=new FileReader();
  reader.onload=()=>{
    const {headers, rows, delimiter} = parseCSV(reader.result);
    if(!headers.length || !rows.length){ showToast('CSV appears empty'); return; }
    const latCol=detectCol(headers,'lat'), lonCol=detectCol(headers,'lon'), wktCol=detectCol(headers,'wkt');
    if(!wktCol && (!latCol || !lonCol)){ showToast('No latitude/longitude or WKT geometry column found in this CSV'); return; }
    if (delimiter !== ','){
      const label = delimiter==='\t' ? 'tab' : delimiter==='|' ? 'pipe' : 'semicolon';
      showToast(`Detected ${label}-delimited CSV — imported accordingly.`);
    }
    pendingImport = { kind:'csv', fileName:file.name, headers, rows, latCol, lonCol, wktCol,
      target: activeProjectId ? 'current' : 'new', newProjectName: file.name.replace(/\.csv$/i,'') };
    renderImportWizard();
  };
  reader.onerror=()=>showToast('Could not read that file');
  reader.readAsText(file);
}


function importCSVData(pending, stats){
  const { headers, rows, latCol, lonCol, wktCol } = pending;
  const typeCol=detectCol(headers,'type'), nameCol=detectCol(headers,'name'), refCol=detectCol(headers,'ref'),
        assignedCol=detectCol(headers,'assignedTo'), notesCol=detectCol(headers,'notes'), geoCol=detectCol(headers,'geo'),
        viCol=detectCol(headers,'vi'), accCol=detectCol(headers,'acc'), capCol=detectCol(headers,'capturedAt'), altCol=detectCol(headers,'alt'),
        featureIdCol=detectCol(headers,'featureId');
  const reservedLower = new Set([latCol,lonCol,wktCol,typeCol,nameCol,refCol,assignedCol,notesCol,geoCol,viCol,accCol,capCol,altCol,featureIdCol].filter(Boolean).map(c=>c.toLowerCase()));
  const extraCols = headers.filter(h=>!reservedLower.has(h.toLowerCase()));

  // Rows belonging to the same feature need to be grouped back together before they can become
  // one multi-vertex line/polygon. feature_id (added to PlotEdge's own CSV export) is the
  // unambiguous way to do that — it can't collide the way feature_name/reference_id can if two
  // features happen to share a name. Only fall back to grouping by name when a CSV doesn't have
  // that column at all (e.g. hand-edited, or exported by another tool).
  const canGroup = !!(featureIdCol || (nameCol && viCol));
  const groups=[];
  if(canGroup){
    const byKey=new Map();
    const keyCol = featureIdCol || nameCol;
    rows.forEach(r=>{ const key=r[keyCol]||''; if(!byKey.has(key)) byKey.set(key,[]); byKey.get(key).push(r); });
    byKey.forEach(list=>groups.push(viCol ? list.slice().sort((a,b)=>(+a[viCol]||0)-(+b[viCol]||0)) : list));
  } else {
    rows.forEach(r=>groups.push([r]));
  }

  const ftCache={};
  groups.forEach(list=>{
    const first=list[0];
    let geomType='point', vertices=[];
    if(wktCol && first[wktCol]){
      const parsed=parseWKT(first[wktCol]);
      if(!parsed){ stats.skippedFeatures++; return; }
      geomType=parsed.geometryType;
      vertices=parsed.vertices.map(c=>({lat:c[1],lon:c[0],alt:c.length>2?c[2]:null,acc:0,time:new Date().toISOString(),attrs:{},photos:[]}));
    } else if(latCol && lonCol){
      const pts=list.map(r=>({
        lon:parseFloat(r[lonCol]), lat:parseFloat(r[latCol]),
        alt:(altCol && r[altCol]!=='') ? parseFloat(r[altCol]) : null,
        acc:(accCol && r[accCol]!=='') ? parseFloat(r[accCol]) : 0,
        time:(capCol && r[capCol]) ? r[capCol] : new Date().toISOString()
      })).filter(c=>!isNaN(c.lon)&&!isNaN(c.lat));
      if(!pts.length){ stats.skippedFeatures++; return; }
      const declaredGeo = (geoCol && first[geoCol] || '').toLowerCase();
      geomType = ['point','line','polygon'].includes(declaredGeo) ? declaredGeo : (pts.length>1 ? 'line' : 'point');
      vertices = pts.map(p=>({lat:p.lat,lon:p.lon,alt:p.alt,acc:p.acc,time:p.time,attrs:{},photos:[]}));
    }
    if(!vertices.length){ stats.skippedFeatures++; return; }

    const label = (typeCol && first[typeCol]) ? first[typeCol] : 'Imported';
    const cacheKey = label.toLowerCase()+'|'+geomType;
    let ft = ftCache[cacheKey];
    if(!ft){ ft = findOrCreateImportFeatureType(label, geomType, extraCols); ftCache[cacheKey]=ft; }
    const fieldIdByCol={}; extraCols.forEach(c=>{ const f=ft.fields.find(x=>x.label.toLowerCase()===c.toLowerCase()); if(f) fieldIdByCol[c]=f.id; });
    const attrs={}; extraCols.forEach(c=>{ const v=first[c]; if(v!=null && v!=='' && fieldIdByCol[c]) attrs[fieldIdByCol[c]]=v; });

    savedFeatures.push({
      id: Date.now()+Math.floor(Math.random()*1000),
      name: (nameCol && first[nameCol]) || `Imported ${stats.imported+1}`,
      ref: (refCol && first[refCol]) || '',
      featureTypeId: ft.id, featureTypeName: ft.name,
      assignedTo: (assignedCol && first[assignedCol]) || '',
      attrs, notes: (notesCol && first[notesCol]) || '',
      geometryType: geomType, vertices, savedAt: new Date().toISOString()
    });
    stats.imported++;
  });
}


// ── GeoPackage ──
// WKB reader mirroring the writer above (geometryToWKB/wkbHeader etc.) — same subset of the
// spec (Point/LineString/Polygon, optional Z via the ISO +1000 type offset GDAL/GeoPackage use by
// default), with a defensive fallback for EWKB-style high-bit flags some tools still emit.
function readWKB(bytes, offset){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = offset;
  const le = dv.getUint8(o)===1; o+=1;
  let type = dv.getUint32(o, le); o+=4;
  let hasZ=false, hasSRID=false, baseType;
  if(type & 0x80000000){
    hasZ = !!(type & 0x80000000);
    hasSRID = !!(type & 0x20000000);
    baseType = type & 0xff;
    if(hasSRID){ o+=4; }
  } else if(type>=1000 && type<4000){
    hasZ = true;
    baseType = type % 1000;
  } else {
    baseType = type;
  }
  const dim = hasZ?3:2;
  const readPoint=()=>{ const c=[]; for(let d=0;d<dim;d++){ c.push(dv.getFloat64(o,le)); o+=8; } return c; };
  const readRing=()=>{ const n=dv.getUint32(o,le); o+=4; const pts=[]; for(let i=0;i<n;i++) pts.push(readPoint()); return pts; };
  if(baseType===1) return { type:'Point', coordinates:readPoint() };
  if(baseType===2) return { type:'LineString', coordinates:readRing() };
  if(baseType===3){ const nRings=dv.getUint32(o,le); o+=4; const rings=[]; for(let i=0;i<nRings;i++) rings.push(readRing()); return { type:'Polygon', coordinates:rings }; }
  return null; // Multi*/GeometryCollection — unsupported, caller counts it as a skipped feature
}

// Reads the GeoPackage Binary header ('GP' magic + flags + srs_id) just far enough to find where
// the WKB body starts, skipping the optional envelope entirely since srs_id/bbox aren't needed —
// the layer's CRS comes from gpkg_geometry_columns instead.
function readGpkgGeom(bytes){
  if(!bytes || bytes.length<8 || bytes[0]!==0x47 || bytes[1]!==0x50) return null;
  const flags = bytes[3];
  const envelopeCode = (flags>>1) & 0x07;
  const envelopeSizes=[0,32,48,48,64];
  const wkbOffset = 8 + (envelopeSizes[envelopeCode]||0);
  return readWKB(bytes, wkbOffset);
}

// Maps a GeoPackage table's declared geometry type to PlotEdge's point/line/polygon model.
// MULTI*/GEOMETRYCOLLECTION aren't representable by a single PlotEdge feature, so the layer is
// flagged unsupported up front in the wizard rather than silently importing zero features.
function gpkgGeomTypeToApp(t){
  const up = String(t||'').toUpperCase();
  if(up==='POINT') return 'point';
  if(up==='LINESTRING') return 'line';
  if(up==='POLYGON') return 'polygon';
  return null;
}

function geometryToVertexCoords(geom){
  if(!geom) return null;
  if(geom.type==='Point') return { geometryType:'point', coords:[geom.coordinates] };
  if(geom.type==='LineString') return { geometryType:'line', coords:geom.coordinates };
  if(geom.type==='Polygon'){
    let ring = geom.coordinates[0]||[];
    if(ring.length>1){ const f=ring[0], l=ring[ring.length-1]; if(f[0]===l[0] && f[1]===l[1]) ring=ring.slice(0,-1); }
    return { geometryType:'polygon', coords:ring };
  }
  return null;
}


// EPSG 32601–32660 = UTM zones 1–60 North, 32701–32760 = 1–60 South (WGS84 datum) — covers the
// overwhelming majority of "reprojected to my local UTM zone" GeoPackages without needing a full
// EPSG database bundled into the app.
function utmProj4Def(epsg){
  if(epsg>=32601 && epsg<=32660) return `+proj=utm +zone=${epsg-32600} +datum=WGS84 +units=m +no_defs`;
  if(epsg>=32701 && epsg<=32760) return `+proj=utm +zone=${epsg-32700} +south +datum=WGS84 +units=m +no_defs`;
  return null;
}

const WEBMERCATOR_DEF = '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs';

function resolveGpkgSrs(db, srsId){
  const id = Number(srsId);
  if(id===4326 || id===0 || id===-1) return { ok:true, kind:'wgs84', epsg:4326 };
  let orgCode=null;
  try{
    const res = db.exec(`SELECT organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id=${id}`);
    if(res.length){ const row=res[0].values[0]; if((row[0]||'').toUpperCase()==='EPSG') orgCode=row[1]; }
  }catch(e){}
  if(orgCode==null) return { ok:false, kind:'unknown', epsg:id };
  if(Number(orgCode)===3857) return { ok:true, kind:'webmercator', epsg:3857 };
  const utm = utmProj4Def(Number(orgCode));
  if(utm) return { ok:true, kind:'utm', epsg:orgCode, def:utm };
  return { ok:false, kind:'unsupported', epsg:orgCode };
}

function makeReprojector(crs){
  const def = crs.kind==='webmercator' ? WEBMERCATOR_DEF : crs.def;
  return (c)=>{ const [lon,lat]=proj4(def,'WGS84',[c[0],c[1]]); return c.length>2 ? [lon,lat,c[2]] : [lon,lat]; };
}


async function prepareGpkgImport(file){
  const wizard=document.getElementById('importWizard');
  wizard.style.display='block';
  wizard.innerHTML='<p style="font-size:13px;color:var(--text-secondary);">Loading GeoPackage engine…</p>';
  try{
    const SQL = await ensureSqlJs();
    const buf = new Uint8Array(await file.arrayBuffer());
    const db = new SQL.Database(buf);
    const res = db.exec(`SELECT c.table_name, c.identifier, g.column_name, g.geometry_type_name, g.srs_id FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name=c.table_name WHERE c.data_type='features'`);
    if(!res.length){ showToast('No feature layers found in this GeoPackage'); wizard.style.display='none'; return; }
    const cols = res[0].columns;
    const tables = res[0].values.map(v=>{
      const o={}; cols.forEach((c,i)=>o[c]=v[i]);
      return { tableName:o.table_name, label:o.identifier||o.table_name, geomColumn:o.column_name, gpkgGeomType:o.geometry_type_name, srsId:o.srs_id, selected:true };
    });
    tables.forEach(t=>{ t.crsInfo = resolveGpkgSrs(db, t.srsId); t.appGeomType = gpkgGeomTypeToApp(t.gpkgGeomType); t.selected = t.selected && !!t.appGeomType && t.crsInfo.ok; });
    pendingImport = { kind:'gpkg', fileName:file.name, db, tables, target: activeProjectId ? 'current' : 'new', newProjectName: file.name.replace(/\.gpkg$/i,'') };
    renderImportWizard();
  } catch(err){
    console.error(err);
    showToast('Could not read that GeoPackage. Check console.');
    wizard.style.display='none';
  }
}


function importGpkgTable(db, table, stats){
  const crs = table.crsInfo;
  if(!crs.ok){ stats.skippedLayers.push(`${table.label}: unsupported CRS (EPSG:${crs.epsg})`); return; }
  if(!table.appGeomType){ stats.skippedLayers.push(`${table.label}: unsupported geometry (${table.gpkgGeomType||'unknown'})`); return; }
  const reprojFn = crs.kind==='wgs84' ? null : makeReprojector(crs);

  let res;
  try{ res = db.exec(`SELECT * FROM "${table.tableName}"`); } catch(e){ stats.skippedLayers.push(`${table.label}: could not read table`); return; }
  if(!res.length) return;
  const cols = res[0].columns;
  const geomIdx = cols.indexOf(table.geomColumn);
  const geomLower = table.geomColumn.toLowerCase();
  const meta={}; const extra=[];
  cols.forEach(c=>{
    const lc=c.toLowerCase();
    if(lc===geomLower || lc==='fid' || lc==='vertices_json') return;
    let matchedKey=null;
    for(const key of ['name','ref','assignedTo','notes']){ if(IMPORT_META_ALIASES[key].includes(lc)){ matchedKey=key; break; } }
    if(matchedKey) meta[matchedKey]=c; else extra.push(c);
  });

  const ft = findOrCreateImportFeatureType(table.label, table.appGeomType, extra);
  const fieldIdByCol={}; extra.forEach(c=>{ const f=ft.fields.find(x=>x.label.toLowerCase()===c.toLowerCase()); if(f) fieldIdByCol[c]=f.id; });
  const vjIdx = cols.indexOf('vertices_json');
  let counter=0;

  res[0].values.forEach(rowArr=>{
    const geomBytes = rowArr[geomIdx];
    if(!geomBytes){ stats.skippedFeatures++; return; }
    const bytes = geomBytes instanceof Uint8Array ? geomBytes : new Uint8Array(geomBytes);
    const geom = readGpkgGeom(bytes);
    const parsed = geom && geometryToVertexCoords(geom);
    if(!parsed){ stats.skippedFeatures++; return; }

    const vertices = parsed.coords.map(c=>{
      const p = reprojFn ? reprojFn(c) : c;
      return { lat:p[1], lon:p[0], alt:p.length>2?p[2]:null, acc:0, time:new Date().toISOString(), attrs:{}, photos:[] };
    });
    // Round-trip bonus: a PlotEdge-exported gpkg carries a vertices_json column with each
    // vertex's real accuracy/timestamp/attrs — use it instead of the placeholders above when present.
    if(vjIdx!==-1 && rowArr[vjIdx]){
      try{
        const vj = JSON.parse(rowArr[vjIdx]);
        if(Array.isArray(vj) && vj.length===vertices.length){
          vertices.forEach((v,i)=>{ v.acc=+vj[i].accuracy_m||0; v.time=vj[i].captured_at||v.time; v.attrs=vj[i].attrs||{}; });
        }
      }catch(e){}
    }

    const attrs={}; extra.forEach(c=>{ const idx=cols.indexOf(c); const val=rowArr[idx]; if(val!=null && val!=='' && fieldIdByCol[c]) attrs[fieldIdByCol[c]]=val; });
    savedFeatures.push({
      id: Date.now()+Math.floor(Math.random()*1000),
      name: (meta.name && rowArr[cols.indexOf(meta.name)]) || `${table.label} ${++counter}`,
      ref: (meta.ref && rowArr[cols.indexOf(meta.ref)]) || '',
      featureTypeId: ft.id, featureTypeName: ft.name,
      assignedTo: (meta.assignedTo && rowArr[cols.indexOf(meta.assignedTo)]) || '',
      attrs, notes: (meta.notes && rowArr[cols.indexOf(meta.notes)]) || '',
      geometryType: ft.geometryType, vertices, savedAt: new Date().toISOString()
    });
    stats.imported++;
  });
}


// ── Shared wizard UI + run ──
let pendingImport = null;

function handleImportFileChosen(event){
  const file = event.target.files[0];
  event.target.value='';
  if(!file) return;
  const ext = file.name.toLowerCase().split('.').pop();
  // .plotpack first: it is the only one of the three that restores a whole project
  // rather than merging a layer into the open one, so it takes a different
  // wizard entirely. See js/17b-plotpack.js.
  if(ext==='plotpack') preparePlotpackImport(file);
  else if(ext==='csv') prepareCSVImport(file);
  else if(ext==='gpkg') prepareGpkgImport(file);
  else showToast('Choose a .plotpack, .csv or .gpkg file');
}

function setImportTarget(t){ if(pendingImport){ pendingImport.target=t; renderImportWizard(); } }

function toggleImportLayer(idx){ pendingImport.tables[idx].selected = !pendingImport.tables[idx].selected; renderImportWizard(); }

function renderImportWizard(){
  const el = document.getElementById('importWizard');
  if(!pendingImport){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='block';
  const p = pendingImport;
  const activeProj = projects.find(x=>x.id===activeProjectId);
  let html = `<div class="import-target-row">
    <div class="import-target-opt ${p.target==='current'?'sel':''} ${activeProj?'':'disabled'}" ${activeProj?`onclick="setImportTarget('current')"`:''} style="${activeProj?'':'opacity:0.5;pointer-events:none;'}">Into "${escapeHtml(activeProj?activeProj.name:'—')}"</div>
    <div class="import-target-opt ${p.target==='new'?'sel':''}" onclick="setImportTarget('new')">As a new project</div>
  </div>`;
  if(p.target==='new'){
    html += `<div class="field" style="margin-bottom:14px;"><label>New project name</label><input type="text" id="importNewProjName" value="${escapeHtml(p.newProjectName||'')}" oninput="pendingImport.newProjectName=this.value"></div>`;
  }
  if(p.kind==='csv'){
    const geomNote = p.wktCol ? `Geometry column: <strong>${escapeHtml(p.wktCol)}</strong> (WKT)` : `Coordinates: <strong>${escapeHtml(p.latCol)}</strong> / <strong>${escapeHtml(p.lonCol)}</strong>`;
    html += `<p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">${p.rows.length} row${p.rows.length===1?'':'s'} found. ${geomNote}.</p>`;
  } else {
    html += p.tables.map((t,i)=>{
      const crs = t.crsInfo;
      const canImport = crs.ok && !!t.appGeomType;
      let metaText;
      if(!t.appGeomType) metaText = `Unsupported geometry (${escapeHtml(t.gpkgGeomType||'unknown')}), will be skipped`;
      else if(!crs.ok) metaText = `Unsupported CRS (EPSG:${crs.epsg}), will be skipped`;
      else metaText = crs.kind==='wgs84' ? 'WGS 84' : crs.kind==='webmercator' ? 'Web Mercator (EPSG:3857), will reproject' : `UTM EPSG:${crs.epsg}, will reproject`;
      return `<div class="import-layer-row">
        <input type="checkbox" ${t.selected?'checked':''} ${canImport?'':'disabled'} onchange="toggleImportLayer(${i})">
        <div class="import-layer-body">
          <div class="import-layer-name">${escapeHtml(t.label)} <span style="color:var(--text-secondary);font-weight:500;">· ${escapeHtml(t.gpkgGeomType||'')}</span></div>
          <div class="import-layer-meta ${canImport?'':'warn'}">${metaText}</div>
        </div>
      </div>`;
    }).join('');
  }
  html += `<button class="btn btn-primary" id="importRunBtn" style="margin-top:4px;margin-bottom:0;" onclick="runImport()">Start import</button>`;
  el.innerHTML = html;
}

async function runImport(){
  if(!pendingImport) return;
  const btn=document.getElementById('importRunBtn');
  if(btn) btn.disabled=true;

  if(pendingImport.kind==='gpkg'){
    const needsProj = pendingImport.tables.some(t=>t.selected && t.crsInfo.ok && t.crsInfo.kind!=='wgs84');
    if(needsProj){
      document.getElementById('importStatus').textContent='Loading projection engine…';
      try{ await ensureProj4(); }catch(e){ showToast('Could not load projection engine. Try again online.'); if(btn) btn.disabled=false; return; }
    }
  }

  const finishImport = ()=>{
    const stats = { imported:0, skippedFeatures:0, skippedLayers:[] };
    if(pendingImport.kind==='csv'){
      importCSVData(pendingImport, stats);
    } else {
      pendingImport.tables.filter(t=>t.selected).forEach(t=>importGpkgTable(pendingImport.db, t, stats));
    }
    persist();
    renderPoints(); renderVertexEditor(); renderFeatures(); updateStats(); populateFeatureTypeSelect();
    if (typeof reviewMap!=='undefined' && reviewMap) renderReviewMap();
    maybeAutoExportToDevice();
    switchTab('review');
    const parts=[`${stats.imported} feature${stats.imported===1?'':'s'} imported`];
    if(stats.skippedFeatures) parts.push(`${stats.skippedFeatures} skipped`);
    if(stats.skippedLayers.length) parts.push(`${stats.skippedLayers.length} layer${stats.skippedLayers.length===1?'':'s'} skipped`);
    document.getElementById('importStatus').textContent = parts.join(' · ');
    showToast(stats.imported ? `Imported ${stats.imported} feature${stats.imported===1?'':'s'}` : 'Nothing was imported. Check the file.');
    const wiz=document.getElementById('importWizard'); wiz.style.display='none'; wiz.innerHTML='';
    pendingImport=null;
    if(btn) btn.disabled=false;
  };

  if(pendingImport.target==='new'){
    const name = (document.getElementById('importNewProjName')?.value || pendingImport.newProjectName || 'Imported project').trim() || 'Imported project';
    const id = 'p_'+Date.now();
    projects.push({ id, name, client:'', manager:'', site:'', createdAt:new Date().toISOString() });
    projectData[id] = { savedFeatures:[], currentVertices:[], featureTypes:[], notes:'', notesUpdatedAt:null };
    persistStore();
    openProject(id);
    finishImport();
  } else {
    finishImport();
  }
}


// ══ POSTGIS (offline app → no live DB writes; generate a command the user runs locally) ══
function generatePostGISCommand(){
  if(!savedFeatures.length){showToast('No features to export yet');return;}
  const host=document.getElementById('pgHost').value.trim()||'localhost';
  const port=document.getElementById('pgPort').value.trim()||'5432';
  const dbname=document.getElementById('pgDb').value.trim()||'gis';
  const user=document.getElementById('pgUser').value.trim()||'postgres';
  const schema=document.getElementById('pgSchema').value.trim()||'public';
  const groups=collectFeatureCollectionsByType().filter(g=>g.fc.features.length);
  const lines=groups.map(g=>`ogr2ogr -f PostgreSQL PG:"host=${host} port=${port} dbname=${dbname} user=${user}" "${g.label.replace(/\s+/g,'_')}_<timestamp>.geojson" -nln ${schema}.${sanitizeTableName(g.label)} -nlt PROMOTE_TO_MULTI -overwrite`);
  const cmd=`# Run locally after downloading the GeoJSON export above.\n# Replace <timestamp> with the stamp in the filename you actually downloaded.\n# You'll be prompted for the DB password, or set PGPASSWORD first.\n${lines.join('\n')}`;
  document.getElementById('pgCmdBlock').textContent=cmd;
  document.getElementById('pgCmdWrap').style.display='block';
  showToast('Command generated');
}

function copyPostGISCommand(){
  const text=document.getElementById('pgCmdBlock').textContent;
  if(!text){showToast('Generate a command first');return;}
  navigator.clipboard.writeText(text).then(()=>showToast('Command copied')).catch(()=>showToast('Copy failed. Select and copy manually.'));
}
