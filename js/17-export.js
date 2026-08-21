// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Export: GeoJSON, CSV, GeoPackage, FlatGeobuf, Parquet, Excel, PDF, backup
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ EXPORT ══
function ts(){return new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');}

// ══ EXPORTS AND THE MEDIA STORE ══
// Photo bytes live in IndexedDB now, not in the project record (see
// js/04a-photostore.js for why). Every export below still wants base64 — a
// GeoJSON `photos_data_uris` property, a CSV column, a JPEG inside a zip, a
// .plotedge.json backup that has to round-trip on another device — so rather
// than rewriting each one to be blob-aware, they call this first. It puts
// `dataUrl` back on the records in memory; persistStore() strips it again on the
// next save, so a hydrated photo can never find its way back into localStorage.
//
// photoStoreIdle() is awaited first because a capture's disk write is
// deliberately not awaited by the capture UI: exporting the instant after
// shooting a photo would otherwise race the write and miss it.
async function hydrateExportPhotos(...sources){
  if (typeof collectPhotoRecords !== 'function') return [];
  const photos = collectPhotoRecords(...sources);
  if (!photos.length) return photos;
  try {
    if (typeof photoStoreIdle === 'function') await photoStoreIdle();
    if (typeof photoStoreHydrate === 'function') await photoStoreHydrate(photos);
  } catch(e){ console.warn('PlotEdge: could not hydrate photos for export', e); }
  return photos;
}

// The base64 an export needed is dead weight the moment it finishes, and on a
// photo-heavy project it is tens of megabytes of live string. Always paired with
// hydrateExportPhotos() above.
function releaseExportPhotos(photos){
  if (typeof photoStoreShed === 'function') photoStoreShed(photos || []);
}

// ══════════════════════════════════════════════════════════════════════════════
// WRITING A FILE TO THE DEVICE
// ══════════════════════════════════════════════════════════════════════════════
// Every export in this file used to end at:
//
//   const a = Object.assign(document.createElement('a'), {href: blobUrl, download: name});
//   a.click(); URL.revokeObjectURL(a.href);
//
// which produces no file at all inside the Android APK. A Capacitor WebView has no download
// manager attached, so `download` is inert — the click is accepted, nothing is written, and the
// export reports success. That is why exported projects could not be found in Documents or
// anywhere else, and why there was never anything to import back.
//
// The same two lines are also wrong in a real browser: revokeObjectURL() runs synchronously in
// the same tick as click(), which can invalidate the URL before the browser has finished reading
// it, and Firefox ignores an anchor that was never inserted into the document.
//
// So: on a native build, write through Capacitor's Filesystem plugin into Documents/PlotEdge and
// TELL THE USER THE PATH — an export whose location is a mystery is barely better than one that
// never happened. On the web, do the anchor properly. Either way the caller gets a promise that
// resolves to a human-readable description of where the bytes went, or null if they did not go.
const EXPORT_DIR = 'PlotEdge';

function capPlugin(name){
  try {
    if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return null;
    return (window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  } catch(e) { return null; }
}

// Filesystem.writeFile wants base64 for binary data. Everything the exports produce is either a
// string, a Uint8Array/ArrayBuffer (GeoPackage, FlatGeobuf, Parquet, XLSX) or a Blob (the zips),
// so this normalises all three. FileReader is used rather than btoa(String.fromCharCode(...)),
// which blows the call-stack argument limit on anything more than a few hundred KB — and a
// GeoPackage with embedded photos is routinely tens of megabytes.
function toBase64(content, mime){
  return new Promise((resolve, reject) => {
    let blob;
    if (content instanceof Blob) blob = content;
    else blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const comma = s.indexOf(',');
      resolve(comma === -1 ? s : s.slice(comma + 1));
    };
    r.onerror = () => reject(r.error || new Error('could not read data for writing'));
    r.readAsDataURL(blob);
  });
}

// True when the app can write real files to the device filesystem. Used to word the UI honestly
// rather than promising a "download" that the platform cannot perform.
function canWriteDeviceFiles(){ return !!capPlugin('Filesystem'); }

async function saveExportFile(content, name, mime){
  const Filesystem = capPlugin('Filesystem');
  if (Filesystem && Filesystem.writeFile) {
    const data = await toBase64(content, mime);
    // Documents is the directory a file manager actually shows the user. ExternalStorage is the
    // fallback for older devices where Documents is not addressable; Data is the last resort —
    // it is app-private (and wiped on uninstall), so it is only ever used to avoid failing
    // outright, and the returned label says so.
    const targets = [
      { dir: 'DOCUMENTS',        label: 'Documents/' + EXPORT_DIR },
      { dir: 'EXTERNAL_STORAGE', label: 'Storage/' + EXPORT_DIR },
      { dir: 'DATA',             label: 'app storage (use Share to move it out)' }
    ];
    let lastErr = null;
    for (const t of targets) {
      try {
        if (Filesystem.mkdir) {
          // Already-exists is the normal case, not a failure.
          try { await Filesystem.mkdir({ path: EXPORT_DIR, directory: t.dir, recursive: true }); } catch(e) {}
        }
        const res = await Filesystem.writeFile({
          path: EXPORT_DIR + '/' + name,
          data,
          directory: t.dir,
          recursive: true
        });
        return { ok: true, where: t.label + '/' + name, uri: (res && res.uri) || null, native: true };
      } catch(e) { lastErr = e; }
    }
    console.warn('PlotEdge: device write failed', lastErr);
    return { ok: false, where: null, uri: null, native: true, error: lastErr };
  }

  // Browser / PWA path.
  try {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);          // Firefox ignores an anchor outside the document
    a.click();
    // Long enough for the browser to have taken its own reference to the blob. Revoking in the
    // same tick as click() is what truncated large exports.
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
    return { ok: true, where: 'your Downloads folder', uri: null, native: false };
  } catch(e) {
    console.warn('PlotEdge: download failed', e);
    return { ok: false, where: null, uri: null, native: false, error: e };
  }
}


// Offers the OS share sheet for a file just written natively, so it can be sent to Drive, email,
// or a laptop without the user having to go hunting through a file manager first. Silently does
// nothing where the plugin isn't present — sharing is a convenience, never the delivery mechanism.
async function offerShareFile(uri, title){
  const Share = capPlugin('Share');
  if (!Share || !Share.share || !uri) return false;
  try { await Share.share({ title: title || 'PlotEdge export', url: uri, dialogTitle: 'Send export' }); return true; }
  catch(e) { return false; }
}


// Reports where the file landed, in the one place the user is already looking. Kept in a single
// function so every export format says the same thing the same way — the old code had each
// export inventing its own wording, and none of them said where anything went.
function noteExportSaved(res, name){
  const status = document.getElementById('exportStatus');
  if (!res || !res.ok) {
    const msg = 'Could not write "' + name + '" to this device.';
    if (status) status.textContent = '✕ ' + msg;
    showToast(msg + ' Check storage permission and free space.');
    return false;
  }
  const msg = 'Saved "' + name + '" to ' + res.where;
  if (status) status.textContent = '✓ ' + msg;
  showToast(msg);
  // A long export is the one case where the person has usually put the phone down. The toast
  // above is only seen by somebody still watching the screen; this reaches whoever walked off.
  // PlotAlert decides whether it was long enough and whether the app is actually backgrounded —
  // that judgement lives with the rest of the alert policy rather than being duplicated here.
  if (typeof plotalertExportFinished === 'function' && _exportStartedAt){
    plotalertExportFinished(name, (Date.now() - _exportStartedAt) / 1000);
  }
  _exportStartedAt = 0;
  _lastExportUri = res.uri || null;
  _lastExportName = name;
  updateShareLastExportBtn();
  return true;
}

let _lastExportUri = null, _lastExportName = '';
// Stamped by every path that begins an export and cleared by noteExportSaved(). Zero means "no
// export is in flight", which is what stops a stale figure being reported if a write completes
// through some route that never set it.
let _exportStartedAt = 0;

function updateShareLastExportBtn(){
  const btn = document.getElementById('shareLastExportBtn');
  if (!btn) return;
  btn.style.display = _lastExportUri ? '' : 'none';
  const lbl = document.getElementById('shareLastExportLabel');
  if (lbl) lbl.textContent = 'Send "' + _lastExportName + '"…';
}

function shareLastExport(){
  if (!_lastExportUri){ showToast('Nothing exported yet in this session'); return; }
  offerShareFile(_lastExportUri, _lastExportName).then(ok=>{
    if (!ok) showToast('Sharing is not available on this device. The file is already saved.');
  });
}


// Kept so the many existing call sites read the same, but it is now a real write with a real
// answer rather than a click into the void.
function dl(content,name,mime){
  return saveExportFile(content,name,mime).then(res => { noteExportSaved(res, name); return res; });
}


async function exportGeoJSON(){
  if(!savedFeatures.length){showToast('No features to export');return;}
  // Photo bytes live in the media store now; the GeoJSON carries them inline as
  // photos_data_uris, so they have to be read back before the properties are
  // built. See hydrateExportPhotos() at the top of this file.
  const _photos = await hydrateExportPhotos(savedFeatures);
  // Split by feature type AND geometry — see featureLayerKey() below for why a mixed-geometry
  // type cannot go out as one .geojson layer even though GeoJSON itself would allow it.
  const byType={}; const typeLabels=layerLabelMap(savedFeatures);
  savedFeatures.forEach(f=>{ (byType[featureLayerKey(f)]=byType[featureLayerKey(f)]||[]).push(f); });
  const types=Object.keys(byType); const stamp=ts();
  const status=document.getElementById('exportStatus');
  if(types.length>1 && status) status.textContent=`Saving ${types.length} files…`;
  // Awaited one at a time rather than fired on a 650ms timer. The timer existed to space out
  // browser downloads, but it also meant the "✓ done" message was written before the writes had
  // finished — and on a native build, before they had even been attempted. Now the summary is
  // only shown once every file has genuinely been written, and a failure is reported as one.
  let written=0, lastRes=null, lastName='';
  for(const key of types){
    const label=typeLabels[key];
    const fc={type:'FeatureCollection',name:label,features:byType[key].flatMap(f=>geoJSONFeaturesFor(f,label))};
    const name=`${label.replace(/\s+/g,'_')}_${stamp}.geojson`;
    const res=await saveExportFile(JSON.stringify(fc,null,2),name,'application/json');
    if(res.ok){ written++; lastRes=res; lastName=name; }
    // Browsers throttle back-to-back downloads; a native write has no such limit.
    if(!res.native && types.length>1) await new Promise(r=>setTimeout(r,650));
  }
  releaseExportPhotos(_photos);
  if(!written){ noteExportSaved({ok:false}, 'GeoJSON'); return; }
  if(written===1 && lastRes){ noteExportSaved(lastRes, lastName); }
  else {
    const where=lastRes?lastRes.where.replace(/\/[^/]*$/,''):'this device';
    if(status) status.textContent=`✓ ${written} GeoJSON file${written>1?'s':''} saved to ${where}`;
    showToast(`${written} GeoJSON file${written>1?'s':''} saved to ${where}`);
    _lastExportUri=lastRes?lastRes.uri:null; _lastExportName=lastName; updateShareLastExportBtn();
  }
  markProjectExported();
}


// EXPORT CHOICE — documented here since it's the key modelling decision for this rewrite:
// Point features may have several captured vertices (multi-angle re-shoots of the "same" spot).
// We export those as one GeoJSON Point Feature *per capture* rather than a single MultiPoint,
// because MultiPoint geometries share one flat `properties` object across all their points —
// that would silently drop each capture's own attrs/photos/angle-labels. One-Feature-per-capture
// keeps every vertex's data queryable as its own row/feature in QGIS/ArcGIS attribute tables.
// Line/polygon features are inherently a single connected shape, so they export as one Feature
// with a LineString/Polygon geometry; polygon rings are auto-closed per the GeoJSON spec by
// repeating the first vertex's coordinates as the ring's last coordinate. Per-vertex attrs/photo
// counts for lines/polygons are preserved losslessly in a nested `vertices` property array.
function geoJSONFeaturesFor(f, label){
  const verts=f.vertices||[];
  const geo=f.geometryType||'point';
  // crsStatement() (js/16b-plotgrid.js) is stamped onto every feature rather than only into a
  // file header: a GeoJSON layer loaded into somebody's QGIS alongside four others loses its
  // header context immediately, and a projected coordinate with no CRS statement is a guess with
  // decimals. Geometry itself stays WGS84 per the GeoJSON spec — this records the project's
  // WORKING grid and, importantly, whether its datum was actually applied.
  const baseProps={feature_name:f.name,reference_id:f.ref||'',feature_type:label,assigned_to:f.assignedTo||'',...flattenAttrs(f.attrs),feature_saved_at:f.savedAt,notes:f.notes||'',
    working_crs:(typeof crsStatement==='function'?crsStatement():null)};
  const coordsOf=v=>(v.alt!==null&&v.alt!==undefined)?[+v.lon.toFixed(7),+v.lat.toFixed(7),+v.alt.toFixed(2)]:[+v.lon.toFixed(7),+v.lat.toFixed(7)];

  // Embeds each photo's actual image data (base64 data: URI), not just a count/filename, so the
  // photos travel *inside* the GeoJSON/GPKG/FlatGeobuf file itself — no separate photos folder
  // needed to see what was captured. Semicolon-joined per vertex (same convention as the existing
  // photo_cloud_urls field) so it stays a flat string column rather than nested JSON, which keeps
  // it valid as a plain TEXT column once it reaches GeoPackage. This does make files much larger;
  // the original "Download Photos" / zip-export routes are unaffected and still give plain .jpg
  // files for anyone who just wants the images without the geodata wrapper.
  if (geo==='point'){
    return verts.map((v,vi)=>({
      type:'Feature',
      geometry:{type:'Point',coordinates:coordsOf(v)},
      properties:{...baseProps,...flattenAttrs(v.attrs),vertex_index:vi+1,total_vertices:verts.length,accuracy_m:(v.acc!=null?+v.acc.toFixed(2):null),captured_at:v.time,...(v.fix||{}),photo_count:(v.photos||[]).length,photo_angle_labels:(v.photos||[]).map(p=>p.angleLabel).filter(Boolean).join(';'),photo_cloud_urls:(v.photos||[]).map(p=>p.cloudUrl).filter(Boolean).join(';'),photos_data_uris:(v.photos||[]).map(p=>p.dataUrl).filter(Boolean).join(';')}
    }));
  }
  const ring=verts.map(coordsOf);
  const coordinates = geo==='polygon' ? [ ring.length ? [...ring, ring[0]] : ring ] : ring; // polygon: close ring; line: as-is
  return [{
    type:'Feature',
    geometry:{type: geo==='polygon'?'Polygon':'LineString', coordinates},
    properties:{...baseProps,vertex_count:verts.length,total_photo_count:verts.reduce((s,v)=>s+(v.photos||[]).length,0),
      vertices: verts.map((v,vi)=>({index:vi+1,accuracy_m:(v.acc!=null?+v.acc.toFixed(2):null),captured_at:v.time,attrs:flattenAttrs(v.attrs),photo_count:(v.photos||[]).length,cloud_urls:(v.photos||[]).map(p=>p.cloudUrl).filter(Boolean).join(';'),photos_data_uris:(v.photos||[]).map(p=>p.dataUrl).filter(Boolean).join(';')}))}
  }];
}


// Multi-select arrays become semicolon-joined strings, booleans become yes/no, for flat export formats
function flattenAttrs(attrs){
  const out={};
  Object.entries(attrs||{}).forEach(([k,v])=>{
    if (Array.isArray(v) && v.length && typeof v[0]==='object' && v[0]!==null){
      // A repeating-group value: array of {subfield_id: value} entries (see js/06-collect.js).
      // flattenAttrs has no access to the schema here (it's schema-agnostic by design — every
      // other attr flattens the same way regardless of type), so sub-field ids stand in for
      // labels; anyone reading the export can cross-reference the feature type's field list.
      out[k] = v.map(inst => Object.entries(inst||{})
        .map(([sk,sv])=>`${sk}=${Array.isArray(sv)?sv.join(','):(sv===true?'yes':sv===false?'no':(sv==null?'':sv))}`)
        .join(';')).join(' | ');
      return;
    }
    out[k]=Array.isArray(v)?v.join(';'):(v===true?'yes':v===false?'no':(v==null?'':v));
  });
  return out;
}


// ══ LAYER IDENTITY UNDER MULTI-GEOMETRY ══
// A feature type is one semantic class in the app but may hold captures of more than one
// geometry (see the block comment in js/02-state.js). A layer in a GIS file is not allowed that
// freedom: a shapefile and an Esri feature class permit exactly one geometry each, a FlatGeobuf
// header names exactly one, and while GeoPackage tolerates a generic GEOMETRY column, a QGIS
// user opening it gets one symbology for points and polygons together — which is not what
// anybody wants from a septic layer.
//
// So the split happens here, at the file boundary, and only where the type actually has mixed
// captures: "Septic" stays one layer called Septic while every capture is a polygon, and becomes
// Septic_point / Septic_polygon the moment both exist. One type in the app, conformant files out.
function featureLayerKey(f){
  const base = f.featureTypeId || f.layer || 'unclassified';
  return base + '::' + (f.geometryType || 'point');
}

// Labels are only suffixed when the suffix is doing work. Deciding that needs the whole set, so
// it is computed once per export rather than per feature.
function layerLabelMap(features){
  const geosPerBase = {}; const baseLabel = {};
  features.forEach(f=>{
    const base = f.featureTypeId || f.layer || 'unclassified';
    baseLabel[base] = resolveFeatureType(f).label;
    (geosPerBase[base] = geosPerBase[base] || new Set()).add(f.geometryType || 'point');
  });
  const out = {};
  features.forEach(f=>{
    const base = f.featureTypeId || f.layer || 'unclassified';
    const geo = f.geometryType || 'point';
    out[base + '::' + geo] = geosPerBase[base].size > 1 ? `${baseLabel[base]}_${geo}` : baseLabel[base];
  });
  return out;
}

// Groups savedFeatures into one GeoJSON FeatureCollection per layer — the same grouping
// exportGeoJSON() uses — so GeoPackage/FlatGeobuf/PostGIS can share one code path instead of
// re-deriving layers three different ways.
function collectFeatureCollectionsByType(){
  const byType={};
  const labels=layerLabelMap(savedFeatures);
  savedFeatures.forEach(f=>{
    (byType[featureLayerKey(f)]=byType[featureLayerKey(f)]||[]).push(f);
  });
  return Object.keys(byType).map(key=>({
    key, label:labels[key],
    fc:{type:'FeatureCollection', name:labels[key], features:byType[key].flatMap(f=>geoJSONFeaturesFor(f,labels[key]))}
  }));
}


// Turns a feature-type label into a safe SQL/table identifier for GeoPackage layers and the
// PostGIS command block (lowercase, alnum+underscore only, can't start with a digit or collide
// with the reserved gpkg_ prefix used by GeoPackage's own metadata tables).
function sanitizeTableName(label){
  let t=(label||'layer').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
  if(!t) t='layer';
  if(/^[0-9]/.test(t)) t='t_'+t;
  if(t.startsWith('gpkg_')) t='layer_'+t;
  return t.slice(0,60);
}


// Pure CSV builder — reads the current global savedFeatures/resolveFeatureType, returns the CSV
// text with no side effects (no download, no toast). Used by both the single-project exportCSV()
// button and exportAllProjects()'s per-project CSV inside the zip.
function buildCSVString(){
  const featAttrKeys=[]; const seenF=new Set();
  const vtxAttrKeys=[]; const seenV=new Set();
  savedFeatures.forEach(f=>{
    Object.keys(f.attrs||{}).forEach(k=>{if(!seenF.has(k)){seenF.add(k);featAttrKeys.push(k);}});
    (f.vertices||[]).forEach(v=>Object.keys(v.attrs||{}).forEach(k=>{if(!seenV.has(k)){seenV.add(k);vtxAttrKeys.push(k);}}));
  });
  // feature_id is PlotEdge's own stable internal id (assigned once at capture time and never
  // re-editable) — added specifically so rows can be grouped back into the correct line/polygon
  // by an ID that can't collide, rather than by feature_name/reference_id, which are just text
  // the user can edit or accidentally duplicate. Use this as the "group by" field in QGIS's
  // Points to Path tool (or any similar join), ordered by vertex_index, to rebuild geometry
  // exactly as captured — this is also what PlotEdge's own CSV re-import now groups by (see
  // importCSVData below), so a round trip through this export never risks merging two features
  // that happen to share a name.
  const heads=['feature_id','reference_id','feature_name','feature_type','geometry_type','assigned_to',...featAttrKeys,...vtxAttrKeys.map(k=>'vtx_'+k),'vertex_index','total_vertices','latitude','longitude','altitude_m','accuracy_m','captured_at','feature_saved_at','notes','photo_count','photo_names','photo_cloud_urls','photo_data_uris'];
  const rows=savedFeatures.flatMap(f=>{
    const info=resolveFeatureType(f);
    const flat=flattenAttrs(f.attrs);
    const fileBase=(f.featureTypeId?info.label:f.layer)||'feature';
    const verts=f.vertices||[];
    return verts.map((v,i)=>{
      const vflat=flattenAttrs(v.attrs);
      const photoNames=(v.photos||[]).map((p,pi)=>`${fileBase}_${f.name.replace(/\s+/g,'_')}_v${i+1}_photo${pi+1}${p.angleLabel?('_'+p.angleLabel.replace(/\s+/g,'_')):''}.jpg`).join(';');
      const photoCloudUrls=(v.photos||[]).map(p=>p.cloudUrl).filter(Boolean).join(';');
      // Photos embedded directly as base64 data: URIs, same convention as GeoJSON/GPKG's
      // photos_data_uris — makes this CSV self-contained but considerably larger per row with photos.
      const photoDataUris=(v.photos||[]).map(p=>p.dataUrl).filter(Boolean).join(';');
      return [
        q(f.id),q(f.ref||''),q(f.name),q(info.label),q(f.geometryType||'point'),q(f.assignedTo||''),
        ...featAttrKeys.map(k=>q(flat[k]||'')),
        ...vtxAttrKeys.map(k=>q(vflat[k]||'')),
        i+1,verts.length,v.lat.toFixed(7),v.lon.toFixed(7),
        (v.alt!==null&&v.alt!==undefined)?v.alt.toFixed(2):'',(v.acc!=null?v.acc.toFixed(2):''),
        q(v.time),q(f.savedAt),q(f.notes||''),(v.photos||[]).length,q(photoNames),q(photoCloudUrls),q(photoDataUris)
      ];
    });
  });
  return [heads.join(','),...rows.map(r=>r.join(','))].join('\r\n');
}

async function exportCSV(){
  if(!savedFeatures.length){showToast('No features to export');return;}
  // buildCSVString() emits a photo_data_uris column, so the bytes must be back
  // on the records before it runs.
  const _photos = await hydrateExportPhotos(savedFeatures);
  const csv=buildCSVString();
  releaseExportPhotos(_photos);
  const total=savedFeatures.reduce((s,f)=>s+(f.vertices||[]).length,0);
  const name=`plotedge_${ts()}.csv`;
  // The success line is written by noteExportSaved() once the bytes are actually down, not
  // guessed here — this used to claim "✓ CSV" even when nothing had been written.
  saveExportFile(csv,name,'text/csv').then(res=>{
    if(noteExportSaved(res,name)){
      const status=document.getElementById('exportStatus');
      if(status) status.textContent += `, ${savedFeatures.length} features, ${total} rows`;
      markProjectExported();
    }
  });
}


async function exportPhotos(){
  const _photos = await hydrateExportPhotos(savedFeatures);
  const all=savedFeatures.flatMap(f=>{
    const info=resolveFeatureType(f);
    const base=(f.featureTypeId?info.label:f.layer)||'feature';
    return (f.vertices||[]).flatMap((v,vi)=>(v.photos||[]).map((p,pi)=>({dataUrl:p.dataUrl,name:`${base.replace(/\s+/g,'_')}_${f.name.replace(/\s+/g,'_')}_v${vi+1}_photo${pi+1}${p.angleLabel?('_'+p.angleLabel.replace(/\s+/g,'_')):''}.jpg`})));
  });
  if(!all.length){releaseExportPhotos(_photos);showToast('No photos to export');return;}
  const status=document.getElementById('exportStatus');
  if(status) status.textContent=`Saving ${all.length} photo${all.length>1?'s':''}…`;
  let written=0, lastRes=null;
  for(const ph of all){
    // A data: URI is not a file. Anchor-clicking one wrote nothing in the WebView, exactly like
    // the other exports — fetch the bytes back out and put them through the same writer.
    let blob;
    try { blob = await (await fetch(ph.dataUrl)).blob(); }
    catch(e) { continue; }
    const res = await saveExportFile(blob, ph.name, 'image/jpeg');
    if(res.ok){ written++; lastRes=res; }
    if(!res.native) await new Promise(r=>setTimeout(r,700));
  }
  releaseExportPhotos(_photos);
  if(!written){ noteExportSaved({ok:false},'photos'); return; }
  const where = lastRes ? lastRes.where.replace(/\/[^/]*$/,'') : 'this device';
  if(status) status.textContent=`✓ ${written} photo${written>1?'s':''} saved to ${where}`;
  showToast(`${written} photo${written>1?'s':''} saved to ${where}`);
  markProjectExported();
}


function q(v){const s=String(v??'');return(s.includes(',')||s.includes('"')||s.includes('\n'))?'"'+s.replace(/"/g,'""')+'"':s;}


// ══ EXPORT ALL PROJECTS (zipped backup) ══
// Lives on the Projects landing screen rather than inside a single project's Export tab, since it
// backs up every project's data in one go — GeoJSON (grouped by feature type) + a flat CSV + all
// photos, one subfolder per project. Reuses the same per-project export helpers
// (collectFeatureCollectionsByType/buildCSVString/resolveFeatureType) by temporarily pointing the
// shared globals at each project's stored data in turn, since those helpers were written to read
// off the "currently open project" globals rather than taking a project id as a parameter.
async function exportAllProjects(){
  if (!projects.length){ showToast('No projects to export'); return; }
  // Not routed through runSelectedExport() — this is launched from the Project Manager, not the
  // Export tab — so it starts its own clock. Bundling every project is the slowest export there
  // is, which makes it the likeliest to finish after the phone has gone in a pocket.
  _exportStartedAt = Date.now();
  if (typeof JSZip === 'undefined'){
    showToast('Zip export needs a connection to load once. Try again online, or export projects individually from inside each one.');
    return;
  }
  // "Export all" now lives only in Data → Backup & Restore (#exportAllBtnPm); the Welcome screen
  // no longer carries one, since with zero projects it could only ever export an empty file. The
  // legacy id stays in this lookup and .filter(Boolean) drops whichever ids aren't in the DOM, so
  // the busy state still binds to whichever button actually exists.
  const btns = ['exportAllBtn','exportAllBtnPm'].map(i=>document.getElementById(i)).filter(Boolean);
  const setBusy = on => btns.forEach(b=>{ b.disabled = on; });
  setBusy(true);
  showToast('Zipping all projects…');

  // Every project's photos at once: this zip embeds the JPEGs themselves, and
  // they are read from the media store rather than the project record.
  const _photos = await hydrateExportPhotos(Object.values(projectData));

  const zip = new JSZip();
  const stamp = ts();
  const saved = { featureTypes, savedFeatures, currentVertices, activeProjectId };
  let projectsWithData = 0;
  const exportedProjectIds = [];

  projects.forEach(p=>{
    const d = projectData[p.id] || { savedFeatures:[], currentVertices:[], featureTypes:[] };
    if (!(d.savedFeatures||[]).length) return;
    projectsWithData++;
    exportedProjectIds.push(p.id);
    featureTypes = d.featureTypes || [];
    savedFeatures = d.savedFeatures || [];
    const folderName = sanitizeFileSegment(p.name || 'Project');
    const folder = zip.folder(folderName);

    collectFeatureCollectionsByType().forEach(({label, fc})=>{
      folder.file(`${label.replace(/\s+/g,'_')}.geojson`, JSON.stringify(fc, null, 2));
    });
    folder.file(`${folderName}_all_features.csv`, buildCSVString());

    const photosFolder = folder.folder('photos');
    savedFeatures.forEach(f=>{
      const info = resolveFeatureType(f);
      const base = (f.featureTypeId ? info.label : f.layer) || 'feature';
      (f.vertices||[]).forEach((v,vi)=>{
        (v.photos||[]).forEach((ph,pi)=>{
          // A photo whose blob could not be read back (media store unavailable,
          // or bytes genuinely lost) is skipped rather than throwing and taking
          // the whole zip down with it.
          if (!ph.dataUrl) return;
          const commaIdx = ph.dataUrl.indexOf(',');
          const b64 = commaIdx>=0 ? ph.dataUrl.slice(commaIdx+1) : ph.dataUrl;
          const name = `${base.replace(/\s+/g,'_')}_${f.name.replace(/\s+/g,'_')}_v${vi+1}_photo${pi+1}${ph.angleLabel?('_'+ph.angleLabel.replace(/\s+/g,'_')):''}.jpg`;
          photosFolder.file(name, b64, {base64:true});
        });
      });
    });
  });

  featureTypes = saved.featureTypes;
  savedFeatures = saved.savedFeatures;
  currentVertices = saved.currentVertices;
  activeProjectId = saved.activeProjectId;
  releaseExportPhotos(_photos);

  if (!projectsWithData){
    setBusy(false);
    showToast('No captured features in any project yet');
    return;
  }

  zip.generateAsync({type:'blob'}).then(async blob=>{
    const name=`PlotEdge_AllProjects_${stamp}.zip`;
    const res=await saveExportFile(blob,name,'application/zip');
    if(!noteExportSaved(res,name)){ setBusy(false); return; }
    showToast(`✓ ${projectsWithData} project${projectsWithData>1?'s':''} zipped`);
    const stamp2 = new Date().toISOString();
    exportedProjectIds.forEach(id=>{ const p2=projects.find(x=>x.id===id); if (p2) p2.lastExportedAt = stamp2; });
    persistStore(); refreshExportMeta();
    setBusy(false);
  }).catch(err=>{
    console.warn('Zip generation failed', err);
    showToast('Zip export failed. Try again, or export projects individually.');
    setBusy(false);
  });
}


// ══ GEOPACKAGE + FLATGEOBUF (lazy-loaded from CDN — kept out of the base bundle since a WASM
// SQLite build and a binary-format serializer both add real weight to what is otherwise a
// single-file, fully offline app) ══
function loadScript(src){
  return new Promise((resolve,reject)=>{
    if(document.querySelector(`script[data-src="${src}"]`)){ resolve(); return; }
    const s=document.createElement('script');
    s.src=src; s.dataset.src=src;
    s.onload=()=>resolve(); s.onerror=()=>reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
}

// ══ RASTER REFERENCE LAYER (GeoTIFF, lazy-loaded from CDN — same reasoning as GeoPackage/FlatGeobuf
// below: parsing raster imagery is a real dependency to carry around, so it only loads the first
// time someone actually taps "Raster". Kept as a pure client-side overlay: no server, no re-tiling
// pipeline — the file is parsed and rendered entirely in the browser, which is what keeps this
// feature compatible with the app's offline-first, single-file architecture. It is intentionally
// display + sampling only — GeoTIFFs are never bundled back into GeoJSON/GPKG/FGB exports, since
// those are vector formats and re-encoding raster into them wouldn't be a meaningful export. ══
let _georasterPromise=null;

function ensureGeoraster(){
  if(_georasterPromise) return _georasterPromise;
  // proj4 is loaded alongside georaster (not just when needed) because georaster-layer-for-leaflet
  // looks for a *global* window.proj4 at render time to reproject non-4326 rasters on the fly —
  // if it isn't present yet when the layer starts drawing tiles, a UTM GeoTIFF renders in the
  // wrong place with no error. Cheap enough (~40KB) to just always bring along with georaster.
  _georasterPromise=Promise.all([
    loadScript('https://cdn.jsdelivr.net/npm/georaster@1.6.0/dist/georaster.browser.bundle.min.js'),
    ensureProj4()
  ]).then(()=>loadScript('https://cdn.jsdelivr.net/npm/georaster-layer-for-leaflet@3.10.0/dist/georaster-layer-for-leaflet.min.js'));
  return _georasterPromise;
}

// Resolves a georaster's detected EPSG code (georaster.projection) to a proj4 definition string
// for OUR OWN sampling math (pixel lookups for sampleRasterAt/zonal stats). This is separate from
// display: georaster-layer-for-leaflet reprojects for rendering by itself via global proj4, but
// sampling indexes g.xmin/ymin/ymax/pixelWidth/pixelHeight directly, which are in the raster's
// native units — so a lat/lon query has to be converted into those same units first, or every
// sample from a UTM (or other projected) GeoTIFF would silently read the wrong pixel.
function resolveRasterSrs(epsg){
  if(!epsg || epsg===4326) return { ok:true, kind:'wgs84' };
  if(epsg===3857) return { ok:true, kind:'webmercator', def:WEBMERCATOR_DEF };
  const utm = utmProj4Def(Number(epsg));
  if(utm) return { ok:true, kind:'utm', def:utm };
  return { ok:false, kind:'unsupported', epsg };
}

// Converts a WGS84 {lat,lon} into the raster's native coordinate units so it can be compared
// against g.xmin/xmax/ymin/ymax for pixel indexing. Returns the same {lat,lon} unchanged for
// already-WGS84 rasters (the common case) so this is a no-op cost when no reprojection applies.
function toRasterUnits(lat, lon, crs){
  if(!crs || crs.kind==='wgs84') return {lat,lon};
  const [x,y] = proj4('WGS84', crs.def, [lon,lat]);
  return { lat:y, lon:x };
}

// Rough safety cap: fully-decoded raster pixel data lives in memory as one JS number per band per
// pixel, which balloons fast on mobile. 150MB is generous for a source file but still leaves the
// decoded array within what a phone browser tab can usually hold without crashing the tab.
const RASTER_MAX_BYTES = 150 * 1024 * 1024;

let rasterLayer = null;     // the active GeoRasterLayer, if any

let rasterGeoraster = null; // the parsed georaster object (kept for pixel sampling)

let rasterCrs = null;       // resolved CRS info for sampling math (see resolveRasterSrs)

let rasterFileNameStr = '';


function onRasterToggleClick(){
  if (rasterLayer){
    // Already have one loaded — clicking again just toggles the control panel rather than
    // re-opening a file picker, so opacity/remove stay reachable without re-uploading.
    const panel = document.getElementById('mapRasterPanel');
    panel.classList.toggle('show');
    return;
  }
  document.getElementById('rasterFileInput').click();
}


async function onRasterFileSelected(event){
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (!/\.tiff?$/i.test(file.name)){
    showToast('Please choose a .tif or .tiff file.');
    return;
  }
  if (file.size > RASTER_MAX_BYTES){
    showToast(`That file is ${(file.size/1024/1024).toFixed(0)}MB, larger than this app can safely decode on a phone. Try a downsampled/clipped export instead.`);
    return;
  }
  const map = ensureReviewMap();
  if (!map){ showToast('Map isn\'t ready yet, try again in a moment.'); return; }
  showToast('Loading raster…');
  try{
    await ensureGeoraster();
    const buf = await file.arrayBuffer();
    const georaster = await parseGeoraster(buf);
    removeRasterLayer(); // clear any previous one first
    rasterGeoraster = georaster;
    rasterCrs = resolveRasterSrs(georaster.projection);
    rasterLayer = new GeoRasterLayer({
      georaster,
      opacity: (document.getElementById('rasterOpacitySlider').value||80)/100,
      resolution: 128 // pixels-per-tile the layer renders at; keeps redraw snappy while panning/zooming
    });
    rasterLayer.addTo(map);
    // Bring the vector features back above the new raster so points/lines/polygons stay visible
    // and clickable rather than getting buried under the reference imagery. reviewMapLayerGroup is
    // a plain L.layerGroup (not a FeatureGroup), so bringToFront isn't available on it directly —
    // iterate its child layers instead.
    if (reviewMapLayerGroup && reviewMapLayerGroup.eachLayer){
      reviewMapLayerGroup.eachLayer(l => { if (l.bringToFront) l.bringToFront(); });
    }
    map.fitBounds(rasterLayer.getBounds());
    rasterFileNameStr = file.name;
    document.getElementById('rasterFileName').textContent = file.name;
    document.getElementById('mapRasterPanel').classList.add('show');
    document.getElementById('mapRasterToggle').classList.add('active');
    if (rasterCrs.ok){
      showToast('Raster loaded.');
    } else {
      // Display still works (georaster-layer-for-leaflet reprojects for rendering on its own via
      // global proj4), but our own sampling math above can't index pixels correctly without
      // knowing the projection, so pixel-value sampling and zonal stats are disabled for this file.
      showToast(`Raster loaded (displaying only, EPSG:${rasterCrs.epsg} isn't a projection this app can sample pixel values from).`);
    }
  }catch(err){
    console.error(err);
    showToast('Couldn\'t read that GeoTIFF. It may use a compression this app can\'t decode.');
  }
}


function onRasterOpacityChange(val){
  if (rasterLayer) rasterLayer.setOpacity(val/100);
}


function removeRasterLayer(){
  if (rasterLayer && reviewMap){
    reviewMap.removeLayer(rasterLayer);
  }
  rasterLayer = null;
  rasterGeoraster = null;
  rasterCrs = null;
  rasterFileNameStr = '';
  const panel = document.getElementById('mapRasterPanel');
  if (panel) panel.classList.remove('show');
  const btn = document.getElementById('mapRasterToggle');
  if (btn) btn.classList.remove('active');
}


// Samples the raster's first band under a lat/lon, for auto-filling a feature attribute (e.g.
// elevation from a DEM) at capture time. Returns null if there's no raster loaded or the point
// falls outside its extent — callers should treat that as "nothing to fill in", not an error.
function sampleRasterAt(lat, lon){
  if (!rasterGeoraster || !rasterCrs || !rasterCrs.ok) return null;
  const g = rasterGeoraster;
  const p = toRasterUnits(lat, lon, rasterCrs);
  if (p.lat < g.ymin || p.lat > g.ymax || p.lon < g.xmin || p.lon > g.xmax) return null;
  const col = Math.floor((p.lon - g.xmin) / g.pixelWidth);
  const row = Math.floor((g.ymax - p.lat) / g.pixelHeight);
  if (row < 0 || row >= g.height || col < 0 || col >= g.width) return null;
  try{
    const val = g.values[0][row][col];
    if (val === g.noDataValue) return null;
    return val;
  }catch(e){ return null; }
}


// Standard ray-casting point-in-polygon test on a simple ring of [lon,lat]-ish {lat,lon} vertices.
// Good enough for the polygons this app captures (single ring, no holes).
function pointInPolygonLL(lat, lon, vertices){
  let inside = false;
  for (let i=0, j=vertices.length-1; i<vertices.length; j=i++){
    const vi=vertices[i], vj=vertices[j];
    const intersect = ((vi.lat > lat) !== (vj.lat > lat)) &&
      (lon < (vj.lon - vi.lon) * (lat - vi.lat) / (vj.lat - vi.lat) + vi.lon);
    if (intersect) inside = !inside;
  }
  return inside;
}


// Zonal stats: for a polygon's vertex ring, walks every raster pixel inside its bounding box and
// keeps the ones that actually fall inside the ring (point-in-polygon per pixel centroid) —
// straightforward rather than fast, but PlotEdge's polygons are field-captured shapes (dozens of
// vertices, not thousands), so this stays well within what a phone can chew through in real time.
function computeZonalStats(vertices){
  if (!rasterGeoraster || !rasterCrs) return null;
  if (!rasterCrs.ok) return { unsupportedCrs:true };
  const g = rasterGeoraster;
  // Reproject the polygon ring once into the raster's native units, so every pixel-centroid
  // check below compares like-for-like coordinates — avoids re-running proj4 per pixel, which
  // would make this noticeably slower on anything but a tiny polygon.
  const ring = vertices.map(v => toRasterUnits(v.lat, v.lon, rasterCrs));
  const lats = ring.map(v=>v.lat), lons = ring.map(v=>v.lon);
  const minLat = Math.max(Math.min(...lats), g.ymin), maxLat = Math.min(Math.max(...lats), g.ymax);
  const minLon = Math.max(Math.min(...lons), g.xmin), maxLon = Math.min(Math.max(...lons), g.xmax);
  if (minLat >= maxLat || minLon >= maxLon) return null; // polygon doesn't overlap the raster at all

  const colStart = Math.max(0, Math.floor((minLon - g.xmin) / g.pixelWidth));
  const colEnd   = Math.min(g.width-1, Math.ceil((maxLon - g.xmin) / g.pixelWidth));
  const rowStart = Math.max(0, Math.floor((g.ymax - maxLat) / g.pixelHeight));
  const rowEnd   = Math.min(g.height-1, Math.ceil((g.ymax - minLat) / g.pixelHeight));

  // Safety cap: a huge polygon over a fine-resolution raster could imply millions of pixel
  // checks. Rather than freezing the tab, bail out with a clear reason so the user knows to try
  // a coarser raster or a smaller area instead of wondering why nothing happened.
  const pixelBudget = (colEnd-colStart+1) * (rowEnd-rowStart+1);
  if (pixelBudget > 2_000_000) return { tooLarge:true };

  let sum=0, count=0, min=Infinity, max=-Infinity;
  for (let row=rowStart; row<=rowEnd; row++){
    const lat = g.ymax - (row+0.5)*g.pixelHeight;
    for (let col=colStart; col<=colEnd; col++){
      const lon = g.xmin + (col+0.5)*g.pixelWidth;
      if (!pointInPolygonLL(lat, lon, ring)) continue;
      const val = g.values[0][row][col];
      if (val === g.noDataValue) continue;
      sum += val; count++;
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  if (!count) return { count:0 };
  return { count, mean:+(sum/count).toFixed(3), min:+min.toFixed(3), max:+max.toFixed(3) };
}


// Runs zonal stats for every polygon feature in the active project against the currently loaded
// raster, and writes the results into each feature's attrs (raster_mean/min/max/px_count) — same
// "just another attribute" approach as the per-vertex raster_sample, so results show up in the
// review list and every export format without any schema/UI changes elsewhere.
function runZonalStatsForProject(){
  if (!rasterGeoraster){ showToast('Load a raster first.'); return; }
  if (rasterCrs && !rasterCrs.ok){ showToast(`Can't run zonal stats, EPSG:${rasterCrs.epsg} isn't a projection this app can sample.`); return; }
  const polys = savedFeatures.filter(f => f.geometryType==='polygon' && f.vertices && f.vertices.length>=3);
  if (!polys.length){ showToast('No polygon features in this project to analyze.'); return; }
  let updated=0, outOfBounds=0, tooLarge=0;
  polys.forEach(f=>{
    const stats = computeZonalStats(f.vertices);
    if (!stats){ outOfBounds++; return; }
    if (stats.tooLarge || stats.unsupportedCrs){ tooLarge++; return; }
    if (!stats.count){ outOfBounds++; return; }
    f.attrs = f.attrs || {};
    f.attrs.raster_mean = stats.mean;
    f.attrs.raster_min = stats.min;
    f.attrs.raster_max = stats.max;
    f.attrs.raster_px_count = stats.count;
    updated++;
  });
  if (updated){ persist(); renderFeatures(); renderReviewMap(); }
  let msg = `Zonal stats added to ${updated} polygon${updated===1?'':'s'}.`;
  if (outOfBounds) msg += ` ${outOfBounds} outside raster extent.`;
  if (tooLarge) msg += ` ${tooLarge} skipped (too large for this raster's resolution).`;
  showToast(msg);
}


let _sqlJsPromise=null;

function ensureSqlJs(){
  if(_sqlJsPromise) return _sqlJsPromise;
  _sqlJsPromise=loadScript('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js')
    .then(()=>initSqlJs({locateFile:file=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`}));
  return _sqlJsPromise;
}

let _fgbPromise=null;

function ensureFlatgeobuf(){
  if(_fgbPromise) return _fgbPromise;
  _fgbPromise=loadScript('https://cdn.jsdelivr.net/npm/flatgeobuf@3.35.0/dist/flatgeobuf-geojson.min.js');
  return _fgbPromise;
}

// hyparquet-writer is published ESM-only (no UMD bundle), so it's loaded via dynamic import()
// rather than loadScript()'s classic <script> tag — jsdelivr's /+esm endpoint bundles whatever
// npm package you ask it for into a single importable ES module regardless of the package's own
// internal file layout, so this works the same way loadScript() does for the UMD engines above:
// fetched once, cached in this promise for the rest of the session.
let _hyparquetPromise=null;

function ensureHyparquetWriter(){
  if(_hyparquetPromise) return _hyparquetPromise;
  _hyparquetPromise=import('https://cdn.jsdelivr.net/npm/hyparquet-writer@0.15/+esm');
  return _hyparquetPromise;
}


// Minimal little-endian WKB writer — just enough of the spec for Point/LineString/Polygon,
// with an optional Z ordinate, to feed GeoPackage's geometry BLOB column.
function u32le(n){const b=new ArrayBuffer(4);new DataView(b).setUint32(0,n,true);return new Uint8Array(b);}

function concatBytes(arrs){const total=arrs.reduce((s,a)=>s+a.length,0);const out=new Uint8Array(total);let o=0;arrs.forEach(a=>{out.set(a,o);o+=a.length;});return out;}

function wkbHeader(baseType,hasZ){const b=new ArrayBuffer(5);const dv=new DataView(b);dv.setUint8(0,1);dv.setUint32(1,hasZ?baseType+1000:baseType,true);return new Uint8Array(b);}

function coordsBytes(coords,hasZ){const dim=hasZ?3:2;const b=new ArrayBuffer(coords.length*dim*8);const dv=new DataView(b);let o=0;coords.forEach(c=>{dv.setFloat64(o,c[0],true);o+=8;dv.setFloat64(o,c[1],true);o+=8;if(hasZ){dv.setFloat64(o,c.length>2?c[2]:0,true);o+=8;}});return new Uint8Array(b);}

function wkbPoint(c,hasZ){return concatBytes([wkbHeader(1,hasZ),coordsBytes([c],hasZ)]);}

function wkbLineString(coords,hasZ){return concatBytes([wkbHeader(2,hasZ),u32le(coords.length),coordsBytes(coords,hasZ)]);}

function wkbPolygon(rings,hasZ){const parts=[wkbHeader(3,hasZ),u32le(rings.length)];rings.forEach(r=>{parts.push(u32le(r.length));parts.push(coordsBytes(r,hasZ));});return concatBytes(parts);}

function geometryToWKB(geom,hasZ){
  if(geom.type==='Point') return wkbPoint(geom.coordinates,hasZ);
  if(geom.type==='LineString') return wkbLineString(geom.coordinates,hasZ);
  return wkbPolygon(geom.coordinates,hasZ);
}

function geomCoordHasZ(geom){
  const c=geom.type==='Point'?geom.coordinates:geom.type==='LineString'?geom.coordinates[0]:(geom.coordinates[0]||[])[0];
  return Array.isArray(c)&&c.length>2;
}

function flattenGeomCoords(geom){
  if(geom.type==='Point') return [geom.coordinates];
  if(geom.type==='LineString') return geom.coordinates;
  return geom.coordinates.flat();
}

// GeoPackage Binary header wrapping a WKB blob: 'GP' magic, version 0, flags (little-endian,
// no envelope, not empty — the envelope is optional per spec so skipping it keeps this simple
// without breaking validity), then the srs_id, then the raw WKB bytes.
function gpbBlob(srsId,wkbBytes){
  const head=new Uint8Array(8);
  head[0]=0x47;head[1]=0x50;head[2]=0;head[3]=0x01;
  new DataView(head.buffer).setInt32(4,srsId,true);
  return concatBytes([head,wkbBytes]);
}


async function exportGeoPackage(){
  // These formats embed photos_data_uris the same way GeoJSON does, so the
  // bytes have to come back out of the media store first.
  const _photos = await hydrateExportPhotos(savedFeatures);
  try {

  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading GeoPackage engine…';
  try{
    const SQL=await ensureSqlJs();
    txt.textContent='Building GeoPackage…';
    document.getElementById('exportStatus').textContent='Building GeoPackage…';
    const groups=collectFeatureCollectionsByType().filter(g=>g.fc.features.length);
    const db=new SQL.Database();
    db.run(`CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);`);
    db.run(`INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS',-1,'NONE',-1,'undefined',NULL),('Undefined geographic SRS',0,'NONE',0,'undefined',NULL),('WGS 84',4326,'EPSG',4326,'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',NULL);`);
    db.run(`CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));`);
    db.run(`CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name,column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name));`);

    // Total feature count across all layers, used for a single running progress readout below —
    // simpler for the user to track than a separate percentage per layer.
    const totalFeats = groups.reduce((n,g)=>n+g.fc.features.length,0);
    let doneFeats = 0;
    const PROGRESS_CHUNK = 200; // insert this many rows, then yield a frame so the status text
                                 // actually repaints and the tab doesn't look frozen on big exports

    for (const g of groups){
      const feats=g.fc.features;
      const tableName=sanitizeTableName(g.label);
      // Every layer reaching here is single-geometry by construction (featureLayerKey splits on
      // geometry), so feats[0] is representative. The defensive GEOMETRY fallback stays because a
      // mis-declared gpkg_geometry_columns row is the kind of corruption that only surfaces once
      // the file is in somebody else's QGIS — cheap insurance against a future grouping change.
      const geomKinds=new Set(feats.map(x=>x.geometry.type.toUpperCase()));
      const geomTypeGpkg=geomKinds.size===1 ? feats[0].geometry.type.toUpperCase() : 'GEOMETRY';
      const hasZ=feats.some(f=>geomCoordHasZ(f.geometry));
      const propKeys=[]; const seen=new Set();
      feats.forEach(f=>Object.keys(f.properties||{}).forEach(k=>{
        if(k==='vertices') return; // nested per-vertex array on lines/polygons — stored separately as JSON
        if(!seen.has(k)){seen.add(k);propKeys.push(k);}
      }));
      const hasVertices=feats.some(f=>f.properties&&f.properties.vertices);
      const cols=['fid INTEGER PRIMARY KEY AUTOINCREMENT','geom BLOB',...propKeys.map(k=>`"${k}" TEXT`)];
      if(hasVertices) cols.push('vertices_json TEXT');
      db.run(`CREATE TABLE "${tableName}" (${cols.join(', ')});`);

      const insertCols=['geom',...propKeys,...(hasVertices?['vertices_json']:[])];
      const stmt=db.prepare(`INSERT INTO "${tableName}" (${insertCols.map(c=>`"${c}"`).join(',')}) VALUES (${insertCols.map(()=>'?').join(',')})`);
      let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
      for (let fi=0; fi<feats.length; fi++){
        const f=feats[fi];
        const wkb=geometryToWKB(f.geometry,hasZ);
        const vals=[gpbBlob(4326,wkb),...propKeys.map(k=>{const v=f.properties[k];return v==null?null:String(v);}),...(hasVertices?[JSON.stringify(f.properties.vertices||[])]:[])];
        stmt.run(vals);
        flattenGeomCoords(f.geometry).forEach(c=>{minx=Math.min(minx,c[0]);maxx=Math.max(maxx,c[0]);miny=Math.min(miny,c[1]);maxy=Math.max(maxy,c[1]);});
        doneFeats++;
        if (doneFeats % PROGRESS_CHUNK === 0 && totalFeats > PROGRESS_CHUNK){
          document.getElementById('exportStatus').textContent=`Building GeoPackage… ${doneFeats}/${totalFeats} features`;
          await new Promise(r=>setTimeout(r,0)); // yield one frame so the status text actually paints
        }
      }
      stmt.free();

      db.run(`INSERT INTO gpkg_contents (table_name,data_type,identifier,min_x,min_y,max_x,max_y,srs_id) VALUES (?,'features',?,?,?,?,?,4326)`,[tableName,g.label,minx,miny,maxx,maxy]);
      db.run(`INSERT INTO gpkg_geometry_columns (table_name,column_name,geometry_type_name,srs_id,z,m) VALUES (?,'geom',?,4326,?,0)`,[tableName,geomTypeGpkg,hasZ?1:0]);
    }

    const bytes=db.export();
    db.close();
    await dl(bytes,`plotedge_${ts()}.gpkg`,'application/geopackage+sqlite3');
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='GeoPackage export failed';
    showToast('GeoPackage export failed. Check console.');
  }finally{
    btn.disabled=false; updateExportFormatUI();
  }
  } finally { releaseExportPhotos(_photos); }
}


async function exportFlatGeobuf(){
  // These formats embed photos_data_uris the same way GeoJSON does, so the
  // bytes have to come back out of the media store first.
  const _photos = await hydrateExportPhotos(savedFeatures);
  try {

  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading FlatGeobuf engine…';
  try{
    await ensureFlatgeobuf();
    txt.textContent='Building FlatGeobuf…';
    const groups=collectFeatureCollectionsByType().filter(g=>g.fc.features.length);
    const stamp=ts(); let i=0;
    const next=()=>{
      if(i>=groups.length){
        showToast(`${groups.length} FlatGeobuf file${groups.length>1?'s':''} saved`);
        btn.disabled=false; updateExportFormatUI();
        return;
      }
      const g=groups[i++];
      const bytes=flatgeobuf.geojson.serialize(g.fc);
      dl(bytes,`${g.label.replace(/\s+/g,'_')}_${stamp}.fgb`,'application/octet-stream');
      if(groups.length>1) document.getElementById('exportStatus').textContent=`Downloading FlatGeobuf files… ${i}/${groups.length}`;
      setTimeout(next,650);
    };
    next();
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='FlatGeobuf export failed';
    showToast('FlatGeobuf export failed. Check console.');
    btn.disabled=false; updateExportFormatUI();
  }
  } finally { releaseExportPhotos(_photos); }
}


// ══ GEOPARQUET (.parquet) ══ — one column-oriented .parquet file per feature type/layer, same
// per-layer grouping as GeoJSON/FlatGeobuf/GeoPackage above. Geometry is encoded as WKB (reusing
// the same wkb* writer functions GeoPackage's export already uses) in a GEOMETRY-logical-typed
// column, plus a GeoParquet-spec "geo" key/value metadata blob so QGIS, ArcGIS, DuckDB, and
// GeoPandas all recognize it as proper GeoParquet rather than just "a parquet file with a binary
// column". Uses hyparquet-writer — a small, dependency-free JS parquet writer (no WASM/Arrow
// needed) — loaded from CDN on first use, same lazy-load pattern as the other export engines.
async function exportGeoParquet(){
  // These formats embed photos_data_uris the same way GeoJSON does, so the
  // bytes have to come back out of the media store first.
  const _photos = await hydrateExportPhotos(savedFeatures);
  try {

  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading GeoParquet engine…';
  try{
    const {parquetWriteBuffer}=await ensureHyparquetWriter();
    txt.textContent='Building GeoParquet…';
    const groups=collectFeatureCollectionsByType().filter(g=>g.fc.features.length);
    const stamp=ts(); let i=0;
    const next=()=>{
      if(i>=groups.length){
        showToast(`${groups.length} GeoParquet file${groups.length>1?'s':''} saved`);
        markProjectExported();
        btn.disabled=false; updateExportFormatUI();
        return;
      }
      const g=groups[i++];
      const feats=g.fc.features;
      const hasZ=feats.some(f=>geomCoordHasZ(f.geometry));
      const geomTypes=[...new Set(feats.map(f=>f.geometry.type))];
      // bbox in the same pass as the WKB encoding, same corner-tracking approach GeoPackage's
      // export uses, needed for the GeoParquet "geo" metadata's per-column bbox.
      let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
      const wkbData=feats.map(f=>{
        flattenGeomCoords(f.geometry).forEach(c=>{minx=Math.min(minx,c[0]);maxx=Math.max(maxx,c[0]);miny=Math.min(miny,c[1]);maxy=Math.max(maxy,c[1]);});
        return geometryToWKB(f.geometry,hasZ);
      });
      // Attribute columns — every property GeoJSON/GeoPackage already carry for this layer, minus
      // the nested `vertices` array (lines/polygons only) which parquet's flat column model can't
      // hold directly — stored as its own JSON-text column instead, same call GeoPackage makes.
      const propKeys=[]; const seen=new Set();
      feats.forEach(f=>Object.keys(f.properties||{}).forEach(k=>{
        if(k==='vertices') return;
        if(!seen.has(k)){seen.add(k);propKeys.push(k);}
      }));
      const hasVertices=feats.some(f=>f.properties&&f.properties.vertices);
      const columnData=[
        {name:'geometry',data:wkbData,type:'GEOMETRY'},
        ...propKeys.map(k=>({name:k,data:feats.map(f=>{const v=f.properties[k];return v==null?'':String(v);}),type:'STRING'})),
      ];
      if(hasVertices) columnData.push({name:'vertices_json',data:feats.map(f=>JSON.stringify(f.properties.vertices||[])),type:'STRING'});

      // GeoParquet 1.1.0 file metadata — the "geo" key is the part every GeoParquet-aware reader
      // actually looks for; CRS is omitted deliberately since coordinates here are plain lon/lat
      // degrees, which is the spec's own default (OGC:CRS84) when no crs is given.
      const geoMeta={
        version:'1.1.0',
        primary_column:'geometry',
        columns:{ geometry:{ encoding:'WKB', geometry_types:geomTypes, bbox:[minx,miny,maxx,maxy] } }
      };
      const buf=parquetWriteBuffer({ columnData, kvMetadata:[{key:'geo',value:JSON.stringify(geoMeta)}] });
      dl(buf,`${g.label.replace(/\s+/g,'_')}_${stamp}.parquet`,'application/octet-stream');
      if(groups.length>1) document.getElementById('exportStatus').textContent=`Downloading GeoParquet files… ${i}/${groups.length}`;
      setTimeout(next,650);
    };
    next();
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='GeoParquet export failed';
    showToast('GeoParquet export failed. Check console.');
    btn.disabled=false; updateExportFormatUI();
  }
  } finally { releaseExportPhotos(_photos); }
}



// ══ EXCEL (.xlsx) — lazy-loaded SheetJS, same on-demand-CDN pattern as sql.js/FlatGeobuf above ══
let _xlsxPromise=null;

function ensureXlsx(){
  if(_xlsxPromise) return _xlsxPromise;
  _xlsxPromise=loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  return _xlsxPromise;
}

// Minimal RFC4126-style CSV line parser (handles quoted fields, escaped "" quotes, and commas
// inside quotes) — used only to turn buildCSVString()'s output into rows/cells for the sheet, so
// the Excel export can never drift out of sync with the CSV export; both read the same columns.
function parseCsvLine(line){
  const out=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(inQ){
      if(c==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else inQ=false; }
      else cur+=c;
    } else {
      if(c==='"') inQ=true;
      else if(c===','){ out.push(cur); cur=''; }
      else cur+=c;
    }
  }
  out.push(cur);
  return out;
}

// Free/community SheetJS can't embed a *viewable* image inside a cell (that's a paid-tier
// feature) — so, same as the CSV export, the photo_data_uris column here carries each photo's
// base64 data as text rather than a rendered thumbnail. Anyone who wants actual openable image
// files should use "Download Photos", or one of the embedded-photo formats above (GeoJSON/
// GPKG/FlatGeobuf), which do carry real image data QGIS/ArcGIS can extract.
async function exportExcel(){
  // These formats embed photos_data_uris the same way GeoJSON does, so the
  // bytes have to come back out of the media store first.
  const _photos = await hydrateExportPhotos(savedFeatures);
  try {

  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading Excel engine…';
  try{
    await ensureXlsx();
    txt.textContent='Building Excel…';
    // Excel has a hard 32,767-character-per-cell limit. photo_data_uris carries each photo as a
    // full base64 string, which routinely blows past that on any feature with a photo attached —
    // XLSX.write() throws on an oversized cell, which is why this export was failing outright.
    // Photos aren't viewable in a free-tier xlsx cell anyway (see note above), so swap any
    // oversized cell for a short pointer instead of the raw data.
    const XLSX_CELL_LIMIT=32767;
    const rows=buildCSVString().split('\r\n').map(parseCsvLine).map(row=>row.map(cell=>
      cell && cell.length>XLSX_CELL_LIMIT ? '[too large for Excel. Use "Download Photos" or GeoJSON/GPKG/FlatGeobuf]' : cell
    ));
    const wb=XLSX.utils.book_new();
    const ws=XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb,ws,'Features');
    const bytes=XLSX.write(wb,{bookType:'xlsx',type:'array'});
    await dl(bytes,`plotedge_${ts()}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    markProjectExported();
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='Excel export failed';
    showToast('Excel export failed. Check console.');
  }finally{
    btn.disabled=false; updateExportFormatUI();
  }
  } finally { releaseExportPhotos(_photos); }
}


// ══ PDF (.pdf) — tabular report, lazy-loaded jsPDF + autotable, same on-demand-CDN pattern as
// the other heavier export engines above. ══
let _jspdfPromise=null;

function ensureJsPdf(){
  if(_jspdfPromise) return _jspdfPromise;
  _jspdfPromise=loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js')
    .then(()=>loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js'));
  return _jspdfPromise;
}

function activeProjectDisplayName(){
  // Used to read the header's #activeProjName text — that element now shows a fixed per-tab
  // label ("PlotEdge"/"Capture"/"Review"/...), not the project's name, so this reads the project
  // record itself instead. See the header-title comment in index.html.
  const p = projects.find(x => x.id === activeProjectId);
  return (p && p.name) || 'Project';
}

// ══ PLOTEDGE BACKUP (round-trip import/export) ══
// Every other export* function above produces a one-way, read-only format for other GIS/office
// software. This is the opposite: a lossless snapshot of PlotEdge's own data model that PlotEdge
// itself can read back in, so people without a backend can move projects between devices or keep
// an offline archive that isn't just a localStorage wipe away from gone.
//
// Format choice: plain JSON, not a zip. Photos are already stored as base64 data-URLs inside
// savedFeatures[].vertices[].photos[], so a JSON dump is *already* complete and lossless with zero
// extra packing work — no separate photos/ folder to keep in sync with a manifest, no zip engine
// (JSZip) required, and the file opens in a text editor or renders in a browser tab if anyone
// wants to eyeball it. The trade-off is size (base64 is ~33% bigger than raw bytes, and JSON isn't
// compressed), which is why "Backup all projects" and per-project backups are offered as separate,
// deliberate actions rather than something that fires automatically.
const PE_BACKUP_VERSION = 1;

function peBackupEnvelope(kind){
  return { peBackup: PE_BACKUP_VERSION, app:'PlotEdge', kind, exportedAt: new Date().toISOString() };
}

// Strips runtime-only fields a re-import shouldn't carry over (sync/publish state is device- and
// session-specific, and re-importing a stale copy shouldn't claim to already be backed up).
function peBackupProjectMeta(p){
  const { id, lastExportedAt, ...meta } = p;
  return meta;
}

function peBackupProjectData(d){
  d = d || {};
  return {
    savedFeatures: d.savedFeatures || [],
    currentVertices: d.currentVertices || [],
    featureTypes: d.featureTypes || [],
    notes: d.notes || '',
    notesUpdatedAt: d.notesUpdatedAt || null,
    sketches: d.sketches || []
  };
}

// ── Export: current open project (used by the Export tab's format dropdown, like every other
// export*() in this file — reads the live in-memory globals, which are more current than
// projectData[activeProjectId] in the middle of an unsaved edit). ──
async function exportProjectBackup(){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  const p = projects.find(x=>x.id===activeProjectId);
  if (!p){ showToast('Project not found'); return; }
  // A backup that cannot restore its photos is not a backup. This is the one
  // format PlotEdge reads back in, so the bytes have to be inside the file.
  const _photos = await hydrateExportPhotos(savedFeatures, currentVertices);
  const payload = {
    ...peBackupEnvelope('project'),
    project: peBackupProjectMeta(p),
    data: peBackupProjectData({ savedFeatures, currentVertices, featureTypes, notes:projectNotes, notesUpdatedAt:projectNotesUpdatedAt, sketches:plotetchSketches })
  };
  dl(JSON.stringify(payload), sanitizeFileSegment(p.name||'Project') + '_backup_' + ts() + '.plotedge.json', 'application/json');
  releaseExportPhotos(_photos);
  markProjectExported();
}

// ── Export: a specific project from the Project Manager menu, whether or not it's the one
// currently open. Reads from the store (projectData[id]) rather than live globals, same as
// exportProjectZip() does for the same reason. ──
async function exportProjectBackupById(id){
  const p = projects.find(x=>x.id===id);
  if (!p){ showToast('Project not found'); return; }
  const d = projectData[id];
  if (!d || !((d.savedFeatures||[]).length || (d.currentVertices||[]).length)){
    showToast('No captured features in this project yet'); return;
  }
  const _photos = await hydrateExportPhotos(d);
  const payload = { ...peBackupEnvelope('project'), project: peBackupProjectMeta(p), data: peBackupProjectData(d) };
  dl(JSON.stringify(payload), sanitizeFileSegment(p.name||'Project') + '_backup_' + ts() + '.plotedge.json', 'application/json');
  releaseExportPhotos(_photos);
  p.lastExportedAt = new Date().toISOString();
  persistStore();
  refreshProjectsScreen();
  if (activeProjectId === p.id) refreshExportMeta();
  showToast('✓ "' + p.name + '" backed up');
}

// ── Export: every project in one file — the "Backup all projects" button on the Welcome and
// Project Manager screens. Flushes the currently open project first so its latest edits (which
// only live in the in-memory globals until persist() runs) aren't missed. ──
async function exportAllProjectsBackup(){
  if (!projects.length){ showToast('No projects to back up'); return; }
  _exportStartedAt = Date.now();
  if (activeProjectId) persist();
  const _photos = await hydrateExportPhotos(Object.values(projectData), savedFeatures, currentVertices);
  const payload = {
    ...peBackupEnvelope('all'),
    projects: projects.map(peBackupProjectMeta),
    data: Object.fromEntries(projects.map(p => [p.id, peBackupProjectData(projectData[p.id])]))
  };
  dl(JSON.stringify(payload), 'PlotEdge_backup_' + ts() + '.plotedge.json', 'application/json');
  releaseExportPhotos(_photos);
  const now = new Date().toISOString();
  projects.forEach(p => p.lastExportedAt = now);
  persistStore();
  refreshProjectsScreen();
  showToast('✓ Backed up ' + projects.length + ' project' + (projects.length===1?'':'s'));
}


// ── Import from the Import tab ──
// Same parsing and same additive guarantee as the Projects-screen import above, but this one is
// reached from *inside* an open project. It deliberately does NOT call refreshProjectsScreen():
// that navigates back out to the Project Manager, which would throw away whatever capture the
// crew had on screen. Instead it reports inline and offers an explicit Open, so leaving the
// current project is always the user's choice.
function handleProjectBackupImport(event){
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const out = document.getElementById('projectBackupResult');
  if (!file) return;
  const fail = msg => { out.innerHTML = '<div class="empty-box"><strong>Import failed</strong>' + escapeHtml(msg) + '</div>'; };
  out.innerHTML = '<div class="import-status">Reading ' + escapeHtml(file.name) + '…</div>';
  const reader = new FileReader();
  reader.onerror = () => fail('Could not read that file.');
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(reader.result); }
    catch(e){ return fail('That file isn’t valid JSON. Pick a .plotedge.json backup.'); }
    if (!payload || payload.peBackup !== PE_BACKUP_VERSION || !payload.kind){
      return fail('That isn’t a PlotEdge backup file. Use a .plotedge.json exported from PlotEdge.');
    }
    let ids = [];
    try {
      if (payload.kind === 'project'){
        ids.push(importOneBackupProject(payload.project, payload.data));
      } else if (payload.kind === 'all'){
        (payload.projects || []).forEach(meta => ids.push(importOneBackupProject(meta, (payload.data||{})[meta.id])));
      } else {
        return fail('Unrecognised backup type.');
      }
      persistStore();
    } catch(e){
      console.error(e);
      return fail('The file is a PlotEdge backup but its contents look corrupted.');
    }
    if (!ids.length) return fail('That backup contained no projects.');
    const rows = ids.map(id => {
      const p = projects.find(x=>x.id===id);
      const n = ((projectData[id]||{}).savedFeatures||[]).length;
      return '<div class="attr-sum-row" role="button" tabindex="0" onclick="openImportedProject(\'' + id + '\')">' +
        '<div class="attr-sum-body">' +
          '<div class="attr-sum-label">Imported</div>' +
          '<div class="attr-sum-val">' + escapeHtml(p ? p.name : id) + ' · ' + n + ' feature' + (n===1?'':'s') + '</div>' +
        '</div>' +
        '<span class="attr-sum-chev"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
      '</div>';
    }).join('');
    out.innerHTML = rows + '<div class="import-status">Tap a project above to open it. Your current project stays open until you do.</div>';
    showToast('✓ Imported ' + ids.length + ' project' + (ids.length===1?'':'s'));
  };
  reader.readAsText(file);
}

function openImportedProject(id){
  if (!projects.find(x=>x.id===id)){ showToast('That project no longer exists'); return; }
  if (activeProjectId) persist();
  openProject(id);
}


// ── Import ──
// Always additive: an imported project (or every project in an "all" backup) lands as a brand
// new project with a freshly minted id, never overwriting anything already on this device. That
// makes import safe to try — worst case you end up with an extra project to delete, never a
// clobbered one.
function triggerBackupImport(){ document.getElementById('backupImportInput').click(); }

function peUniqueName(base){
  base = base || 'Imported project';
  const taken = new Set(projects.map(p=>p.name));
  if (!taken.has(base)) return base;
  let n = 2, name = base + ' (imported)';
  while (taken.has(name)) name = base + ' (imported ' + (n++) + ')';
  return name;
}

function importOneBackupProject(meta, data){
  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  const now = new Date().toISOString();
  // restoredFrom mirrors what the .plotpack path records (js/17b-plotpack.js): the id above is
  // freshly minted so the project belongs to this device, which is correct and is also what makes a
  // second restore of the same file otherwise undetectable. Keeping the source id alongside it is
  // what lets "you already have exactly this" be answered precisely rather than by name — and two
  // projects called Ward 7 are ordinary, being two visits to one site.
  projects.push({ ...(meta||{}), id, name: peUniqueName((meta||{}).name), createdAt:(meta&&meta.createdAt)||now, updatedAt:now, lastExportedAt:null,
    restoredFrom: { projectId: (meta&&meta.id) || null, exportedAt: (meta&&meta.exportedAt) || null, restoredAt: now } });
  projectData[id] = peBackupProjectData(data);
  // A backup file carries its photos inline as base64. persistStore() strips
  // those fields on the way to localStorage, so unless they are moved into the
  // media store first the restore would land with every photo gone. Async, but
  // safe: the strip only happens at serialisation, so the in-memory copies are
  // still readable when this runs.
  if (typeof photoStoreMigrate === 'function'){
    const imported = collectPhotoRecords(projectData[id]);
    photoStoreMigrate(imported).then(()=>{
      photoStoreShed(imported);
      if (activeProjectId === id && typeof renderFeatures === 'function') renderFeatures();
    }).catch(()=>{});
  }
  return id;
}

function handleBackupImportFile(event){
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(reader.result); }
    catch(e){ showToast('Not a valid backup file (bad JSON)'); return; }
    if (!payload || payload.peBackup !== PE_BACKUP_VERSION || !payload.kind){
      showToast('Not a PlotEdge backup file'); return;
    }
    try {
      if (payload.kind === 'project'){
        importOneBackupProject(payload.project, payload.data);
        showToast('✓ Imported "' + peUniqueName((payload.project||{}).name).replace(/ \(imported.*\)$/,'') + '"');
      } else if (payload.kind === 'all'){
        const list = payload.projects || [];
        list.forEach(meta => importOneBackupProject(meta, (payload.data||{})[meta.id]));
        showToast('✓ Imported ' + list.length + ' project' + (list.length===1?'':'s'));
      } else {
        showToast('Unrecognized backup file'); return;
      }
      persistStore();
      refreshProjectsScreen();
    } catch(e){
      console.error(e);
      showToast('Import failed, file may be corrupted');
    }
  };
  reader.onerror = () => showToast('Could not read that file');
  reader.readAsText(file);
}


// ══ EXPORT FORMAT DROPDOWN — one card, one button; the select just swaps which underlying
// export*() function the button calls and updates its description/note/color to match. ══
// Each entry also carries `group` (which optgroup it belongs in) and `short` (its label in the
// Settings default-format picker, where there is no room for the full button text). Those two
// exist so both <select>s can be BUILT from this object at boot — see buildExportFormatSelects()
// at the bottom of this file. They used to be hand-written in index.html, and had drifted: the
// Settings picker was missing PlotPack, Device Settings and the legacy JSON backup entirely, so
// three formats could be exported but never set as the default.
const EXPORT_FORMATS = {
  // ── The native bundle. Supersedes the .plotedge.json backup below rather than
  // replacing it: same completeness, but a ZIP with the photos as real JPEGs
  // instead of base64 inside JSON, which is roughly a third smaller and is what
  // decides whether a photo-heavy survey can be sent over a chat app at all. It
  // also carries a manifest with per-part checksums (chat apps and Bluetooth
  // truncate large attachments, and a half-written restore is worse than a
  // failed one), a format version so it can change safely, and a plain
  // features.geojson inside so unzipping gives somebody without PlotEdge
  // something they can open. See js/17b-plotpack.js.
  plotpack: { label:'Download PlotPack', btnClass:'btn-geo', run:()=>exportPlotpack(),
    desc:'A single <code>.plotpack</code> file holding the entire project: every feature, photo, per-vertex reading, feature type definition, note and sketch. This is the format to send to a colleague or move to a new phone: PlotEdge restores it exactly as it was.',
    note:'A .plotpack is a ZIP: rename it to .zip and you can read the schema, the notes and a plain GeoJSON copy with ordinary tools, and the photos are in there as normal .jpg files. Tapping one on a phone with PlotEdge installed opens it here.',
    group:'plotedge', short:'PlotPack (whole project)', selectLabel:'PlotPack (.plotpack, whole project, photos included)' },
  plotedge: { label:'Download Backup (legacy JSON)', btnClass:'btn-geo', run:exportProjectBackup,
    desc:'The older single-file <code>.plotedge.json</code> backup, kept so bundles exported by earlier versions still have a matching writer. Prefer the Project Bundle above for anything new. Use it for device-to-device transfers or as a true backup; everything else below is a one-way export for other software.',
    note:'Photos are embedded as base64, so this file can be noticeably larger than the GIS formats below. To back up every project at once, use "Backup all projects" on the Projects screen instead of repeating this per project.',
    group:'plotedge', short:'Backup (.json, older format)', selectLabel:'Backup (.json, older format)' },
  geojson: { label:'Download GeoJSON', btnClass:'btn-geo', run:exportGeoJSON,
    desc:'Each layer as a separate <code>.geojson</code> file. All attributes included as properties. Load directly in QGIS or ArcGIS.', note:null,
    group:'vector', short:'GeoJSON', selectLabel:'GeoJSON (1 file per layer)' },
  gpkg: { label:'Download GeoPackage', btnClass:'btn-gpkg', run:exportGeoPackage,
    desc:'All layers in one <code>.gpkg</code> (SQLite) file, grouped by feature type as separate tables. Opens directly in QGIS/ArcGIS with no format conversion.',
    note:'First tap loads a small SQLite engine from a CDN (needs network signal once). GeoPackage and FlatGeobuf files are heavier to build than GeoJSON/CSV, so on datasets over ~500 features the status line below the button shows live progress rather than appearing frozen.',
    group:'vector', short:'GeoPackage', selectLabel:'GeoPackage (single .gpkg file)' },
  fgb: { label:'Download FlatGeobuf', btnClass:'btn-fgb', run:exportFlatGeobuf,
    desc:'Each layer as a compact, streamable <code>.fgb</code> file. Good for large datasets and fast partial loading in web maps or QGIS.',
    note:'First tap loads a small serializer from a CDN (needs network signal once).',
    group:'vector', short:'FlatGeobuf', selectLabel:'FlatGeobuf (1 file per layer)' },
  geoparquet: { label:'Download GeoParquet', btnClass:'btn-fgb', run:exportGeoParquet,
    desc:'Each layer as a columnar <code>.parquet</code> file (GeoParquet 1.1, WKB geometry). Compact, fast to query with DuckDB/GeoPandas, and opens directly in QGIS 3.28+ or ArcGIS Pro.',
    note:'First tap loads a small parquet-writer engine from a CDN (needs network signal once).',
    group:'vector', short:'GeoParquet', selectLabel:'GeoParquet (1 file per layer)' },
  csv: { label:'Download CSV', btnClass:'btn-csv', run:exportCSV,
    desc:'One row per point. All layer attributes included as columns. Sort by <code>reference_id</code> to compare with your other app.', note:null,
    group:'tables', short:'CSV', selectLabel:'CSV (flat table, all features)' },
  xlsx: { label:'Download Excel', btnClass:'btn-csv', run:exportExcel,
    desc:'Same table as CSV, as a native <code>.xlsx</code> workbook, opens directly in Excel with no import step.',
    note:'First tap loads a small spreadsheet engine from a CDN (needs network signal once). Embedded photos are included as base64 text in the photo_data_uris column, not as viewable images in the cell, free spreadsheet libraries can\'t render inline images, only paid ones can. Use "Download Photos" or GeoJSON/GPKG/FlatGeobuf if you need openable image files.',
    group:'tables', short:'Excel (.xlsx)', selectLabel:'Excel workbook (.xlsx)' },
  // Wrapped in an arrow rather than referenced directly: these two live in
  // js/17a-plansheet.js, which loads AFTER this file, so a bare reference here
  // would be evaluated while that file's declarations are still in their
  // temporal dead zone. The arrow defers the lookup to the moment it is tapped.
  pdf: { label:'Download Survey Register (PDF)', btnClass:'btn-csv', run:()=>exportPDF(),
    desc:'An issued document, not a data dump: a masthead carrying the project, client, site and coordinate system, the full feature schedule paginated with a running header and page numbers, and a closing basis-and-limitations statement. For review, sign-off and the project file.',
    note:'First tap loads a small PDF engine from a CDN (needs network signal once). Photos aren\'t included in this table: use "Download Photos" for those, or "Download Map Layout" for a printable page with the actual plotted points, legend, and scale.',
    group:'tables', short:'PDF report', selectLabel:'PDF report (.pdf)' },
  maplayout: { label:'Download Plan Sheet (PDF)', btnClass:'btn-gpkg', run:()=>exportMapLayout(),
    desc:'A landscape A4 plan sheet laid out the way a survey drawing is: bordered frame, a coordinate graticule over the map, and a full title block down the right edge: project and client, coordinate reference, a true drafting scale (1:500, 1:1000 …) with a segmented scale bar, north arrow, legend, survey totals, issue date and limitations.',
    note:'First tap loads a small PDF engine from a CDN (needs network signal once). The plot is fitted, then rounded to a conventional drafting scale so the printed sheet really is at the ratio it states. A raster basemap is optional and drawn behind the vectors; without one the sheet is a clean schematic that needs no network at all.',
    group:'tables', short:'Map layout', selectLabel:'Map layout (.pdf, legend + scale)' },
  // Preferences, not data. Separate from the project bundle on purpose: importing
  // a colleague's survey must never silently repaint your app or change your
  // units. See the DEVICE SETTINGS PACK section of js/17b-plotpack.js.
  settings: { label:'Download Device Settings', btnClass:'btn-csv', run:()=>exportDeviceSettings(),
    desc:'Your preferences only (theme, units, basemap, quick actions, export defaults and publishing targets) as a small <code>.plotpack</code> file. Restore it after a reinstall or on a new phone instead of setting everything up again.',
    note:'No survey data and no photos. Access tokens are never included: if you publish web maps you will need to re-enter yours after restoring. Android\'s own backup does not cover a sideloaded APK, which is why this exists.',
    group:'plotedge', short:'Device settings (preferences only)', selectLabel:'Device settings (.plotpack, preferences only)' },
  photos: { label:'Download Photos', btnClass:'btn-photos', run:exportPhotos,
    desc:'Saves each photo as <code>Layer_FeatureName_photo1.jpg</code> into your exports folder.', note:null,
    group:'tables', short:'Photos' },
  // Wrapped in an arrow for the same temporal-dead-zone reason as pdf/maplayout above:
  // exportCAD lives in js/17c-plotcad.js, which loads after this file.
  cad: { label:'Download CAD Drawing (DXF)', btnClass:'btn-gpkg', run:()=>exportCAD(),
    desc:'A <code>.dxf</code> drawing in true metres, one layer per feature type and geometry, with feature names and reference IDs on parallel annotation layers. Opens directly in AutoCAD, Civil 3D, BricsCAD, ZWCAD, DraftSight and LibreCAD.',
    note:'Coordinates are projected to WGS84 / UTM (zone detected from your survey) because CAD has no coordinate system of its own: the zone and its EPSG code are written into the drawing header. DXF carries no attribute table, so export CSV or GeoJSON alongside and join on reference_id. This is the one export that needs no network at all. A CAD office asking for DWG will open a DXF; if one insists, any of the packages above converts it in one step.',
    group:'cad', short:'CAD drawing (DXF)' }
};

// Which optgroup each format sits in, and the heading text for each. Order here is the order
// both selects render in.
const EXPORT_FORMAT_GROUPS = [
  { id:'plotedge', label:'PlotEdge (re-importable)' },
  { id:'vector',   label:'Vector layers' },
  { id:'cad',      label:'CAD' },
  { id:'tables',   label:'Tables & media' }
];

// ══ SELECT GENERATION ══
// Both the Export tab's format picker and Settings' default-format picker are built from
// EXPORT_FORMATS so a new format cannot be added to one and forgotten in the other. Every
// exportable format is offered as a default, including the three that were previously missing:
// there is no format you can run but cannot pre-select.
function buildExportFormatSelects(){
  const keysIn = gid => Object.keys(EXPORT_FORMATS).filter(k => (EXPORT_FORMATS[k].group||'tables') === gid);

  const exportSel = document.getElementById('exportFormatSelect');
  if (exportSel){
    const keep = exportSel.value;
    exportSel.innerHTML = EXPORT_FORMAT_GROUPS.map(g => {
      const keys = keysIn(g.id);
      if (!keys.length) return '';
      return `<optgroup label="${escapeHtml(g.label)}">` + keys.map(k =>
        `<option value="${k}">${escapeHtml(EXPORT_FORMATS[k].selectLabel || EXPORT_FORMATS[k].short || EXPORT_FORMATS[k].label)}</option>`
      ).join('') + '</optgroup>';
    }).join('');
    if (keep && EXPORT_FORMATS[keep]) exportSel.value = keep;
  }

  const settingsSel = document.getElementById('settingsExportFormat');
  if (settingsSel){
    const keep = settingsSel.value;
    settingsSel.innerHTML = EXPORT_FORMAT_GROUPS.map(g => {
      const keys = keysIn(g.id);
      if (!keys.length) return '';
      return `<optgroup label="${escapeHtml(g.label)}">` + keys.map(k =>
        `<option value="${k}">${escapeHtml(EXPORT_FORMATS[k].short || EXPORT_FORMATS[k].label)}</option>`
      ).join('') + '</optgroup>';
    }).join('');
    if (keep && EXPORT_FORMATS[keep]) settingsSel.value = keep;
  }
}

// ── Map Layout basemap mode ── 'none' | 'street' | 'satellite', remembered across sessions the
// same way the Review tab's own basemap preference is (separate key though — this one governs
// what gets baked into the exported PDF, which is a bigger/slower decision than just what you're
// looking at on screen, so they're allowed to differ).
const MAPLAYOUT_BASEMAP_KEY='plotedge_maplayout_basemap';

function maplayoutBasemapMode(){ try{ return localStorage.getItem(MAPLAYOUT_BASEMAP_KEY)||'none'; }catch(e){ return 'none'; } }

// Reflects a mode onto the seg-control buttons only (no storage write, no recursion) — used both
// by the click handler below and by updateExportFormatUI when the field is (re)shown.
function setMaplayoutBasemapModeUIOnly(mode){
  ['None','Street','Satellite'].forEach(label=>{
    const btn=document.getElementById('maplayoutBasemap'+label);
    if(btn) btn.classList.toggle('active', label.toLowerCase()===mode);
  });
}

function setMaplayoutBasemapMode(mode){
  try{ localStorage.setItem(MAPLAYOUT_BASEMAP_KEY,mode); }catch(e){}
  updateExportFormatUI();
}

function updateExportFormatUI(){
  const key=document.getElementById('exportFormatSelect').value;
  const f=EXPORT_FORMATS[key];
  document.getElementById('exportFormatDesc').innerHTML=f.desc;
  const btn=document.getElementById('exportFormatBtn');
  btn.className='btn '+f.btnClass;
  document.getElementById('exportFormatBtnText').textContent=f.label;
  const note=document.getElementById('exportFormatNote');
  let noteText=f.note;
  const basemapField=document.getElementById('maplayoutBasemapField');
  if(key==='maplayout'){
    basemapField.style.display='block';
    const mode=maplayoutBasemapMode();
    setMaplayoutBasemapModeUIOnly(mode);
    noteText = mode==='none'
      ? 'First tap loads a small PDF engine from a CDN (needs network signal once). This is a schematic plan (exact coordinates, plain background). Pick Street or Satellite above to draw a real basemap behind your features instead.'
      : `First tap loads a small PDF engine plus ${mode} map tiles for the area covered by your features (needs a live connection at export time). If tiles can't be fetched the layout still exports, just without the basemap.`;
  } else {
    basemapField.style.display='none';
  }
  if(noteText){ note.style.display='flex'; document.getElementById('exportFormatNoteText').textContent=noteText; }
  else note.style.display='none';
}

function runSelectedExport(){
  const key=document.getElementById('exportFormatSelect').value;
  // The one place every format on the Export tab is launched from, so it is the honest place to
  // start the clock. noteExportSaved() reads it to decide whether the export ran long enough to be
  // worth a notification.
  _exportStartedAt = Date.now();
  EXPORT_FORMATS[key].run();
}
