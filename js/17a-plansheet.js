// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Plan sheet and survey register (the two PDF deliverables)
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.
//
// Split out of js/17-export.js when that file passed 2,000 lines and the suite
// (rightly) called it unwieldy. The two documents in here are the ones a client
// or a project office actually receives, as opposed to the machine-readable
// formats next door — so they are the ones whose layout is worth reading as its
// own file rather than hunting for inside the GeoPackage writer.

// ══════════════════════════════════════════════════════════════════════════════
// SURVEY REGISTER (.pdf) — the printable attribute schedule
// ══════════════════════════════════════════════════════════════════════════════
// A document that gets issued, filed and read a year later, so it has to say
// what it is on every page. Previously it opened "PlotEdge Export — <name>" and
// a row count, then a bare table: nothing about the client, the site, the
// coordinate system, when it was captured, or which page of how many you were
// holding. That is fine as a data dump and no use at all as a record.
//
// Structure now: a masthead and project header on page 1, a running header and
// numbered footer on every page, the schedule itself, and a closing summary that
// states totals and the accuracy the positions were actually captured at.
function pdfMeta(){
  const p = projects.find(x=>x.id===activeProjectId) || {};
  const verts = savedFeatures.flatMap(f=>f.vertices||[]);
  const accs = verts.map(v=>v.acc).filter(a=>a!=null && a>0);
  const lats = verts.map(v=>v.lat).filter(v=>v!=null);
  const lons = verts.map(v=>v.lon).filter(v=>v!=null);
  let totLen=0, totArea=0;
  savedFeatures.forEach(f=>{
    const vs=(f.vertices||[]).filter(v=>v.lat!=null);
    if(f.geometryType==='line' && vs.length>=2) totLen+=lineLengthM(vs);
    if(f.geometryType==='polygon' && vs.length>=3){ const pa=polygonAreaAndPerimeterM(vs); totArea+=pa.area; totLen+=pa.perimeter; }
  });
  return {
    project: p,
    features: savedFeatures.length,
    vertices: verts.length,
    photos: verts.reduce((n,v)=>n+((v.photos||[]).length),0),
    types: new Set(savedFeatures.map(f=>resolveFeatureType(f).key)).size,
    accAvg: accs.length ? accs.reduce((s,a)=>s+a,0)/accs.length : null,
    accWorst: accs.length ? Math.max(...accs) : null,
    extent: lats.length ? { n:Math.max(...lats), s:Math.min(...lats), e:Math.max(...lons), w:Math.min(...lons) } : null,
    totLen, totArea,
    issued: new Date()
  };
}

// Drawn on every page by autoTable's didDrawPage hook, so pagination cannot
// produce a sheet with no identification on it.
function pdfPageFurniture(doc, meta, title){
  const pageW=doc.internal.pageSize.getWidth(), pageH=doc.internal.pageSize.getHeight();
  doc.setDrawColor(200); doc.setLineWidth(0.5);
  doc.line(28,34,pageW-28,34);
  doc.setFont(undefined,'bold'); doc.setFontSize(7.5); doc.setTextColor(60);
  doc.text(String(meta.project.name||activeProjectDisplayName()),28,28);
  doc.setFont(undefined,'normal'); doc.setTextColor(130);
  doc.text(title,pageW/2,28,{align:'center'});
  doc.text(meta.issued.toLocaleDateString(),pageW-28,28,{align:'right'});
  doc.line(28,pageH-26,pageW-28,pageH-26);
  doc.setFontSize(6.6); doc.setTextColor(140);
  doc.text('WGS 84 (EPSG:4326) \u00B7 GNSS field capture \u00B7 not a cadastral survey',28,pageH-16);
  const page=doc.internal.getNumberOfPages();
  doc.text('Page '+page,pageW-28,pageH-16,{align:'right'});
}

async function exportPDF(){
  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading PDF engine…';
  const _photos = await hydrateExportPhotos(savedFeatures);
  try{
    await ensureJsPdf();
    txt.textContent='Building PDF…';
    // Photos are raw base64 blobs — pointless (and enormous) in a printed table, so this table
    // drops that column. "Download Map Layout" is the format for a printable plan sheet with the
    // actual map, legend and title block; this one is the printable attribute schedule.
    const allRows=buildCSVString().split('\r\n').map(parseCsvLine);
    const header=allRows[0]||[];
    const dropIdx=header.indexOf('photo_data_uris');
    const rows=allRows.map(r=>dropIdx>-1 ? r.filter((_,i)=>i!==dropIdx) : r);
    const meta=pdfMeta();
    const p=meta.project;
    const { jsPDF } = window.jspdf;
    const doc=new jsPDF({orientation:'landscape',unit:'pt',format:'a4'});
    const pageW=doc.internal.pageSize.getWidth();

    // ── masthead ──
    doc.setFillColor(24,32,48);
    doc.rect(0,0,pageW,72,'F');
    doc.setTextColor(255); doc.setFont(undefined,'bold'); doc.setFontSize(17);
    doc.text(String(p.name||activeProjectDisplayName()),28,36);
    doc.setFont(undefined,'normal'); doc.setFontSize(8); doc.setTextColor(185);
    doc.text('SURVEY FEATURE REGISTER',28,52,{charSpace:1.1});
    doc.setFontSize(7.5); doc.setTextColor(200);
    doc.text('Issued '+meta.issued.toLocaleString(),pageW-28,36,{align:'right'});
    doc.text('PlotEdge field capture',pageW-28,52,{align:'right'});

    // ── project header: two columns of key/value, the way a report front sheet reads ──
    const left=[
      ['Client', p.client || '\u2014'],
      ['Site', p.site || '\u2014'],
      ['Project manager', p.manager || '\u2014'],
      ['Survey started', p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '\u2014']
    ];
    const right=[
      ['Features / vertices', meta.features + ' / ' + meta.vertices],
      ['Feature types', String(meta.types)],
      ['Photographs', String(meta.photos)],
      ['Coordinate system', 'WGS 84 geographic (EPSG:4326)']
    ];
    if (meta.accAvg != null) right.push(['Mean GNSS accuracy', '\u00B1' + formatLength(meta.accAvg) + '  (worst \u00B1' + formatLength(meta.accWorst) + ')']);
    if (meta.totLen)  left.push(['Total length surveyed', formatLength(meta.totLen)]);
    if (meta.totArea) left.push(['Total area enclosed', formatArea(meta.totArea)]);
    if (meta.extent) right.push(['Extent (N/S, E/W)',
      meta.extent.n.toFixed(5)+' / '+meta.extent.s.toFixed(5)+',  '+meta.extent.e.toFixed(5)+' / '+meta.extent.w.toFixed(5)]);

    const drawKV=(list,x,y,w)=>{
      let cy=y;
      list.forEach(([k,v])=>{
        doc.setFont(undefined,'normal'); doc.setFontSize(7); doc.setTextColor(130);
        doc.text(String(k).toUpperCase(),x,cy,{charSpace:0.4});
        doc.setFont(undefined,'bold'); doc.setFontSize(8.6); doc.setTextColor(35);
        doc.splitTextToSize(String(v),w).forEach(seg=>{ cy+=10.5; doc.text(seg,x,cy); });
        cy+=13;
      });
      return cy;
    };
    const colW=(pageW-28*2-30)/2;
    const endL=drawKV(left,28,94,colW);
    const endR=drawKV(right,28+colW+30,94,colW);
    const headerBottom=Math.max(endL,endR)+6;
    doc.setDrawColor(200); doc.setLineWidth(0.5);
    doc.line(28,headerBottom,pageW-28,headerBottom);

    if (p.description){
      doc.setFont(undefined,'normal'); doc.setFontSize(7.6); doc.setTextColor(90);
      doc.text(doc.splitTextToSize(String(p.description),pageW-56),28,headerBottom+13);
    }

    doc.setFont(undefined,'bold'); doc.setFontSize(9); doc.setTextColor(35);
    doc.text('Feature schedule',28,headerBottom+(p.description?36:20));

    doc.autoTable({
      head:[rows[0]||[]], body:rows.slice(1),
      startY: headerBottom+(p.description?44:28),
      styles:{fontSize:6,cellPadding:2.5,overflow:'linebreak',textColor:45,lineColor:[218,222,228],lineWidth:0.3},
      headStyles:{fillColor:[24,32,48],textColor:255,fontSize:6,fontStyle:'bold'},
      // Banding, not a grid of boxes: on a schedule this wide, following one row
      // across the page is the thing the reader is actually doing.
      alternateRowStyles:{fillColor:[246,248,250]},
      margin:{left:28,right:28,top:44,bottom:36}, theme:'striped',
      didDrawPage: ()=>{ if (doc.internal.getNumberOfPages()>1) pdfPageFurniture(doc,meta,'Feature schedule'); }
    });

    // ── closing statement ──
    let endY=(doc.lastAutoTable && doc.lastAutoTable.finalY) || 300;
    if (endY > doc.internal.pageSize.getHeight()-110){ doc.addPage(); pdfPageFurniture(doc,meta,'Feature schedule'); endY=60; }
    doc.setDrawColor(200); doc.setLineWidth(0.5);
    doc.line(28,endY+18,pageW-28,endY+18);
    doc.setFont(undefined,'bold'); doc.setFontSize(8); doc.setTextColor(35);
    doc.text('Basis and limitations',28,endY+34);
    doc.setFont(undefined,'normal'); doc.setFontSize(7); doc.setTextColor(95);
    doc.text(doc.splitTextToSize(
      'Positions were captured in the field by GNSS and are recorded in WGS 84 geographic coordinates '
      + '(EPSG:4326). Each vertex carries the horizontal accuracy reported by the receiver at the moment of '
      + 'capture; that figure is the stated limit of confidence for that position and is listed per row above. '
      + 'Lengths and areas are computed on the ellipsoid from the captured coordinates. This register is a '
      + 'record of a field survey and is not a cadastral, boundary or engineering setting-out survey; it must '
      + 'not be relied upon as one.', pageW-56),28,endY+47);

    // Page 1's furniture is drawn last, so it sits over the masthead rather than
    // being painted before it and hidden.
    if (doc.internal.getNumberOfPages()>1){
      doc.setPage(1);
      const ph=doc.internal.getPageHeight ? doc.internal.getPageHeight() : doc.internal.pageSize.getHeight();
      doc.setDrawColor(200); doc.setLineWidth(0.5);
      doc.line(28,ph-26,pageW-28,ph-26);
      doc.setFont(undefined,'normal'); doc.setFontSize(6.6); doc.setTextColor(140);
      doc.text('WGS 84 (EPSG:4326) \u00B7 GNSS field capture \u00B7 not a cadastral survey',28,ph-16);
      doc.text('Page 1 of '+doc.internal.getNumberOfPages(),pageW-28,ph-16,{align:'right'});
    }

    const pdfName=`${sanitizeFileSegment(p.name||'Project').replace(/\s+/g,'_')}_register_${ts()}.pdf`;
    const pdfRes=await saveExportFile(doc.output('blob'), pdfName, 'application/pdf');
    if(noteExportSaved(pdfRes,pdfName)){
      const st=document.getElementById('exportStatus');
      if(st) st.textContent += `, ${savedFeatures.length} features`;
      markProjectExported();
    }
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='PDF export failed';
    showToast('PDF export failed. Check console.');
  }finally{
    releaseExportPhotos(_photos);
    btn.disabled=false; updateExportFormatUI();
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// PROJECTION AND BASEMAP HELPERS
// ══════════════════════════════════════════════════════════════════════════════
// These sit here rather than in js/17-export.js because nothing else uses them:
// they exist only to place ground coordinates on a page, and to fetch the
// optional raster context behind them. Both PDF deliverables above and below
// share them.

// ══ MAP LAYOUT (.pdf) — a printable plan sheet: every feature plotted on a simple schematic
// (not raster basemap tiles — see note in EXPORT_FORMATS below for why), plus a legend of feature
// types/counts, a north arrow, and a scale bar. Everything is drawn with jsPDF's own vector
// primitives, so it works fully offline and never depends on tile-server CORS/loading. ══
function mapLayoutProjectPoint(lat,lon,proj){
  // Same equirectangular approximation used for the auto area/length attrs — consistent and
  // accurate at survey scale, and (unlike a raster basemap) lets the scale bar be exact rather
  // than estimated from a screenshot. At the small (survey-scale) extents this app is built for,
  // this is close enough to Web Mercator (what the raster basemap tiles below use) that the two
  // line up visually — the basemap is context, not a georeferenced product.
  const x=(lon*Math.PI/180)*proj.R*proj.cosLat;
  const y=(lat*Math.PI/180)*proj.R;
  return { x: proj.originX + (x-proj.x0)*proj.scale, y: proj.originY - (y-proj.y0)*proj.scale };
}


// ══ MAP LAYOUT BASEMAP (raster, optional) ══ — fetches OSM/Esri XYZ tiles covering the plot's
// lat/lon extent, stitches them into a canvas, and crops/scales that down to exactly the plot
// rect's pixel dimensions so it can be dropped in behind the vector features with doc.addImage().
// Resolved through ATLAS_BASEMAPS (js/14a-plotatlas.js), the one registry every map in the app
// reads, so a PDF prints on the basemap that was chosen in Settings rather than on whichever of
// two hard-coded sources this function happened to know about. No new CORS surface: the registry's
// five sources all send Access-Control-Allow-Origin: *.
function mapLayoutLonToTileX(lon,z){ return (lon+180)/360*Math.pow(2,z); }

function mapLayoutLatToTileY(lat,z){
  const rad=lat*Math.PI/180;
  return (1-Math.log(Math.tan(rad)+1/Math.cos(rad))/Math.PI)/2*Math.pow(2,z);
}

function mapLayoutTileUrl(mode,x,y,z){
  const registry = (typeof ATLAS_BASEMAPS !== 'undefined') ? ATLAS_BASEMAPS : null;
  const spec = registry && registry[mode];
  if (spec){
    // {s} subdomain and {r} retina placeholders are Leaflet's, not the servers' —
    // they have to be resolved by hand here because there is no Leaflet layer
    // doing it for us.
    return spec.url
      .replace('{s}', ['a','b','c'][(x+y)%3])
      .replace('{z}', z).replace('{x}', x).replace('{y}', y)
      .replace('{r}', '');
  }
  const sub=['a','b','c'][(x+y)%3];
  return `https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

// Fetches one tile as bytes (not via an <img> tag) so a successful CORS-enabled response decodes
// straight into an ImageBitmap without tainting the canvas we draw it onto. Both tile sources used
// here send Access-Control-Allow-Origin: *; a tile that fails (offline, rate-limited, etc.) just
// resolves to null and is left blank rather than aborting the whole basemap.
async function mapLayoutFetchTile(mode,x,y,z){
  try{
    const res=await fetch(mapLayoutTileUrl(mode,x,y,z),{mode:'cors'});
    if(!res.ok) return null;
    const blob=await res.blob();
    return await createImageBitmap(blob);
  }catch(e){ return null; }
}

// bbox = {west,south,east,north} in degrees. targetW/targetH = desired output pixel size (the
// exact pixel footprint of the plot rect, at export DPI). Returns a PNG data URL cropped/scaled
// to that exact size, or null if not enough tiles could be fetched to be worth showing.
async function mapLayoutBuildBasemapImage(bbox,targetW,targetH,mode){
  const MAX_TILES=64, MAX_Z=mode==='satellite'?18:19, MIN_Z=2;
  let z=MIN_Z, x1,x2,y1,y2,tx0,tx1,ty0,ty1;
  for(z=MIN_Z; z<=MAX_Z; z++){
    x1=mapLayoutLonToTileX(bbox.west,z); x2=mapLayoutLonToTileX(bbox.east,z);
    y1=mapLayoutLatToTileY(bbox.north,z); y2=mapLayoutLatToTileY(bbox.south,z);
    tx0=Math.floor(x1); tx1=Math.floor(x2); ty0=Math.floor(y1); ty1=Math.floor(y2);
    const tileCount=(tx1-tx0+1)*(ty1-ty0+1);
    const pxSpanX=(x2-x1)*256, pxSpanY=(y2-y1)*256;
    // Stop increasing zoom once resolution comfortably covers the target output, or once one more
    // zoom level would blow past the tile-count budget (then use the previous z's numbers).
    if((pxSpanX>=targetW && pxSpanY>=targetH) || tileCount>MAX_TILES){
      if(tileCount>MAX_TILES && z>MIN_Z){
        z--; x1=mapLayoutLonToTileX(bbox.west,z); x2=mapLayoutLonToTileX(bbox.east,z);
        y1=mapLayoutLatToTileY(bbox.north,z); y2=mapLayoutLatToTileY(bbox.south,z);
        tx0=Math.floor(x1); tx1=Math.floor(x2); ty0=Math.floor(y1); ty1=Math.floor(y2);
      }
      break;
    }
  }
  // The for-loop's own increment leaves z one past MAX_Z whenever it runs to completion without
  // ever breaking — which is the common case for a small, tightly-captured survey: at MAX_Z the
  // tile resolution still doesn't cover targetW/targetH, but the tile budget was never exceeded
  // either, so nothing ever triggers a break. tx0..ty1 above were computed during the last
  // iteration that actually ran (z === MAX_Z), so z has to be clamped back down to match them —
  // otherwise every tile fetch below requests a zoom level no server serves, at tile coordinates
  // that belong to a different zoom entirely, every fetch fails, and the printed sheet's basemap
  // is silently blank.
  if (z > MAX_Z) z = MAX_Z;
  const cols=tx1-tx0+1, rows=ty1-ty0+1;
  const stitch=document.createElement('canvas');
  stitch.width=cols*256; stitch.height=rows*256;
  const sctx=stitch.getContext('2d');
  const fetches=[];
  for(let ty=ty0; ty<=ty1; ty++){
    for(let tx=tx0; tx<=tx1; tx++){
      fetches.push(mapLayoutFetchTile(mode,tx,ty,z).then(bmp=>{
        if(bmp) sctx.drawImage(bmp,(tx-tx0)*256,(ty-ty0)*256);
        return !!bmp;
      }));
    }
  }
  const results=await Promise.all(fetches);
  const okCount=results.filter(Boolean).length;
  if(okCount===0) return null; // no basemap worth showing — export falls back to plain schematic
  // Crop the stitched sheet down to exactly the requested lat/lon bbox, then scale to the target
  // output pixel size in one draw so the final image lines up with the plot rect pixel-for-pixel.
  const cropX=(x1-tx0)*256, cropY=(y1-ty0)*256;
  const cropW=(x2-x1)*256, cropH=(y2-y1)*256;
  const out=document.createElement('canvas');
  out.width=targetW; out.height=targetH;
  const octx=out.getContext('2d');
  octx.drawImage(stitch,cropX,cropY,cropW,cropH,0,0,targetW,targetH);
  return out.toDataURL('image/png');
}


// ══════════════════════════════════════════════════════════════════════════════
// PLAN SHEET GEOMETRY
// ══════════════════════════════════════════════════════════════════════════════
// The layout follows the convention every survey drawing and engineering plan
// shares, and that a GIS print composer (QGIS, ArcGIS Pro) lays out by default:
// a bordered drawing frame, the map filling the left, and a TITLE BLOCK down the
// right-hand edge carrying everything needed to identify the sheet without
// reading the map. That column is not decoration — a plan without a stated
// scale, coordinate system, date and origin is not a document anyone downstream
// can responsibly use, and "PlotEdge Export" in 16pt at the top of the page was
// not telling them any of it.
//
// Landscape A4 because plans are wide, and because a portrait sheet with a
// title block loses too much of its width to it.
const SHEET_MARGIN = 22;          // outer paper margin to the drawing frame

const SHEET_TITLE_W = 196;        // title block column width

const SHEET_GUTTER = 10;

// One row of the title block. Every panel is drawn through this so the rules,
// padding and type sizes cannot drift between them.
function planPanel(doc, x, y, w, h, label, lines, opts){
  const o = opts || {};
  doc.setDrawColor(120); doc.setLineWidth(0.6);
  doc.rect(x, y, w, h);
  let cy = y + 11;
  if (label){
    doc.setFont(undefined,'bold'); doc.setFontSize(5.6); doc.setTextColor(130);
    doc.text(String(label).toUpperCase(), x + 6, cy, { charSpace: 0.6 });
    cy += 9;
  }
  doc.setFont(undefined, o.bold ? 'bold' : 'normal');
  doc.setFontSize(o.size || 8);
  doc.setTextColor(o.color != null ? o.color : 30);
  (lines || []).forEach(line => {
    if (line == null || line === '') return;
    // Wrapped, not clipped: a long client name silently cut off mid-word is the
    // kind of thing nobody notices until the drawing is issued.
    doc.splitTextToSize(String(line), w - 12).forEach(seg => {
      doc.text(seg, x + 6, cy);
      cy += (o.leading || 9.5);
    });
  });
  doc.setFont(undefined,'normal');
  return cy;
}

// Measures how tall a panel needs to be before drawing it, so the column can be
// laid out top-down without overlapping panels or leaving gaps.
function planPanelHeight(doc, w, label, lines, opts){
  const o = opts || {};
  let h = 8 + (label ? 9 : 0);
  doc.setFontSize(o.size || 8);
  (lines || []).forEach(line => {
    if (line == null || line === '') return;
    h += doc.splitTextToSize(String(line), w - 12).length * (o.leading || 9.5);
  });
  return h + 5;
}

// ══ A REAL DRAWING SCALE ══
// proj.scale is page-points per ground metre. A point is 1/72 inch, so the
// dimensionless ratio a plan states as "1:500" is metres-per-point x 72 / 0.0254.
// Rounded to the nearest conventional denominator, because "1:487" is not a
// scale anybody drafts to — and the plot is then re-fitted to that exact
// denominator so the printed sheet really is at the ratio it claims.
const PLAN_SCALE_DENOMS = [50,100,200,250,500,1000,1250,2000,2500,5000,10000,20000,25000,50000,100000];

function planScaleDenominator(pointsPerMetre){
  const exact = 1 / (pointsPerMetre * 0.0254 / 72);
  for (const d of PLAN_SCALE_DENOMS) if (d >= exact) return d;
  return Math.ceil(exact / 100000) * 100000;
}

function planPointsPerMetre(denom){ return 72 / (denom * 0.0254); }


async function exportMapLayout(){
  if(!savedFeatures.length){showToast('No features to export');return;}
  const btn=document.getElementById('exportFormatBtn'); const txt=document.getElementById('exportFormatBtnText');
  btn.disabled=true; txt.textContent='Loading engine…';
  document.getElementById('exportStatus').textContent='Loading PDF engine…';
  try{
    await ensureJsPdf();
    txt.textContent='Building layout…';
    const allVerts=savedFeatures.flatMap(f=>(f.vertices||[]).map(v=>({...v,ft:f.featureTypeId})));
    if(!allVerts.length){ showToast('No captured points to plot'); btn.disabled=false; updateExportFormatUI(); return; }
    const lats=allVerts.map(v=>v.lat), lons=allVerts.map(v=>v.lon);
    const latAvg=lats.reduce((s,v)=>s+v,0)/lats.length;
    const R=6378137, cosLat=Math.cos(latAvg*Math.PI/180);
    const toXY=(lat,lon)=>({ x:(lon*Math.PI/180)*R*cosLat, y:(lat*Math.PI/180)*R });
    const xs=allVerts.map(v=>toXY(v.lat,v.lon).x), ys=allVerts.map(v=>toXY(v.lat,v.lon).y);
    const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    const spanX=Math.max(maxX-minX,1), spanY=Math.max(maxY-minY,1);

    const { jsPDF } = window.jspdf;
    const doc=new jsPDF({orientation:'landscape',unit:'pt',format:'a4'});
    const pageW=doc.internal.pageSize.getWidth(), pageH=doc.internal.pageSize.getHeight();

    // ── drawing frame ──
    const frameX=SHEET_MARGIN, frameY=SHEET_MARGIN;
    const frameW=pageW-SHEET_MARGIN*2, frameH=pageH-SHEET_MARGIN*2;
    doc.setDrawColor(40); doc.setLineWidth(1.4);
    doc.rect(frameX,frameY,frameW,frameH);
    doc.setLineWidth(0.5);
    doc.rect(frameX+3,frameY+3,frameW-6,frameH-6);

    // ── the two columns: map on the left, title block on the right ──
    const titleX = frameX + frameW - 6 - SHEET_TITLE_W;
    const plotLeft = frameX + 9;
    const plotTop = frameY + 9;
    const plotW = titleX - SHEET_GUTTER - plotLeft;
    const plotH = frameH - 18;
    const plotBottom = plotTop + plotH;

    // ── scale: fit, then round DOWN to a drafting scale so nothing falls off ──
    const pad=1.12;
    const fitted=Math.min(plotW/(spanX*pad), plotH/(spanY*pad));
    const denom=planScaleDenominator(fitted);
    const scale=planPointsPerMetre(denom);
    const proj={ R,cosLat,scale,x0:(minX+maxX)/2,y0:(minY+maxY)/2,
      originX:plotLeft+plotW/2, originY:plotTop+plotH/2 };

    const project = projects.find(x=>x.id===activeProjectId) || {};
    const toLatLon=(x,y)=>({ lat:(y*180)/(R*Math.PI), lon:(x/(R*cosLat))*180/Math.PI });
    const halfW=(plotW/2)/scale, halfH=(plotH/2)/scale;
    const nw=toLatLon(proj.x0-halfW, proj.y0+halfH), se=toLatLon(proj.x0+halfW, proj.y0-halfH);
    const extent={ west:nw.lon, north:nw.lat, east:se.lon, south:se.lat };

    // ── optional raster basemap, clipped to the plot rect ──
    let basemapAttribution=null;
    const basemapMode=maplayoutBasemapMode();
    if(basemapMode!=='none'){
      txt.textContent='Fetching basemap tiles…';
      document.getElementById('exportStatus').textContent='Fetching basemap tiles…';
      const dpiScale=2;
      try{
        const dataUrl=await mapLayoutBuildBasemapImage(extent, Math.round(plotW*dpiScale), Math.round(plotH*dpiScale), basemapMode);
        if(dataUrl){
          doc.addImage(dataUrl,'PNG',plotLeft,plotTop,plotW,plotH);
          const registry=(typeof ATLAS_BASEMAPS!=='undefined') ? ATLAS_BASEMAPS : null;
          const spec=registry && registry[basemapMode];
          basemapAttribution = spec ? String(spec.attr).replace(/&copy;/g,'(c)').replace(/<[^>]+>/g,'') : 'Basemap imagery';
        }
      }catch(e){ console.error('Map layout basemap fetch failed',e); }
      txt.textContent='Building layout…';
      document.getElementById('exportStatus').textContent='Building layout…';
    }

    // ══ COORDINATE GRATICULE ══
    // The thing that separates a plan from a picture: ticks on all four edges at
    // round latitude/longitude intervals, labelled, so any point on the sheet
    // can be read off to a coordinate. Interval chosen so roughly four to six
    // lines fall inside the extent.
    const gratSteps=[0.00002,0.00005,0.0001,0.00025,0.0005,0.001,0.0025,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1];
    const lonSpan=Math.abs(extent.east-extent.west), latSpan=Math.abs(extent.north-extent.south);
    const pickStep=span=>{ for(const g of gratSteps) if(span/g<=6) return g; return gratSteps[gratSteps.length-1]; };
    const lonStep=pickStep(lonSpan), latStep=pickStep(latSpan);
    const fmtDeg=(v,step)=>v.toFixed(step<0.001?5:step<0.01?4:step<0.1?3:2)+'\u00B0';
    doc.setLineWidth(0.4);
    doc.setFontSize(5.4); doc.setTextColor(90);
    for(let lon=Math.ceil(extent.west/lonStep)*lonStep; lon<=extent.east; lon+=lonStep){
      const px=mapLayoutProjectPoint(latAvg,lon,proj).x;
      if(px<plotLeft+2||px>plotLeft+plotW-2) continue;
      doc.setDrawColor(200);
      doc.setLineDashPattern && doc.setLineDashPattern([1,3],0);
      doc.line(px,plotTop,px,plotBottom);
      doc.setLineDashPattern && doc.setLineDashPattern([],0);
      doc.setDrawColor(40);
      doc.line(px,plotTop,px,plotTop+5); doc.line(px,plotBottom-5,px,plotBottom);
      doc.text(fmtDeg(lon,lonStep),px,plotBottom-7,{align:'center'});
    }
    for(let lat=Math.ceil(extent.south/latStep)*latStep; lat<=extent.north; lat+=latStep){
      const py=mapLayoutProjectPoint(lat,(extent.west+extent.east)/2,proj).y;
      if(py<plotTop+2||py>plotBottom-2) continue;
      doc.setDrawColor(200);
      doc.setLineDashPattern && doc.setLineDashPattern([1,3],0);
      doc.line(plotLeft,py,plotLeft+plotW,py);
      doc.setLineDashPattern && doc.setLineDashPattern([],0);
      doc.setDrawColor(40);
      doc.line(plotLeft,py,plotLeft+5,py); doc.line(plotLeft+plotW-5,py,plotLeft+plotW,py);
      doc.text(fmtDeg(lat,latStep),plotLeft+7,py-2);
    }
    doc.setDrawColor(40); doc.setLineWidth(0.9);
    doc.rect(plotLeft,plotTop,plotW,plotH);

    // ── features, in feature-type colour ──
    savedFeatures.forEach(f=>{
      const verts=f.vertices||[];
      if(!verts.length) return;
      const ftKey = f.featureTypeId;
      const color=featureTypeColor(ftKey);
      const rgb=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];
      const pts=verts.map(v=>mapLayoutProjectPoint(v.lat,v.lon,proj));
      const lineStyle=featureTypeLineStyle(ftKey);
      const dash=pdfDashPattern(lineStyle,1.2);
      if(f.geometryType==='polygon' && pts.length>=3){
        const filled=featureTypeFilled(ftKey);
        if(filled){
          doc.setFillColor(...rgb); doc.setDrawColor(...rgb);
          doc.setGState && doc.setGState(new doc.GState({opacity:0.18}));
          doc.lines(pts.slice(1).map((p,i)=>[p.x-pts[i].x,p.y-pts[i].y]),pts[0].x,pts[0].y,[1,1],'F',true);
          doc.setGState && doc.setGState(new doc.GState({opacity:1}));
        }
        doc.setDrawColor(...rgb);
        doc.setLineWidth(1.2);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern(dash,0);
        doc.lines(pts.slice(1).map((p,i)=>[p.x-pts[i].x,p.y-pts[i].y]),pts[0].x,pts[0].y,[1,1],'S',true);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern([],0);
      } else if(f.geometryType==='line' && pts.length>=2){
        doc.setDrawColor(...rgb); doc.setLineWidth(1.5);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern(dash,0);
        for(let i=1;i<pts.length;i++) doc.line(pts[i-1].x,pts[i-1].y,pts[i].x,pts[i].y);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern([],0);
      } else {
        const shape=featureTypeShape(ftKey);
        doc.setFillColor(...rgb); doc.setDrawColor(...rgb);
        pts.forEach(p=>{
          if(shape==='square'){ doc.rect(p.x-2.3,p.y-2.3,4.6,4.6,'F'); }
          else if(shape==='triangle'){ doc.triangle(p.x,p.y-2.9,p.x-2.7,p.y+2,p.x+2.7,p.y+2,'F'); }
          else doc.circle(p.x,p.y,2.6,'F');
        });
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // TITLE BLOCK
    // ══════════════════════════════════════════════════════════════════════════
    let ty = plotTop;
    const tw = SHEET_TITLE_W;

    // Sheet identity
    doc.setFillColor(24,32,48);
    doc.rect(titleX,ty,tw,34,'F');
    doc.setTextColor(255); doc.setFont(undefined,'bold'); doc.setFontSize(12);
    doc.text('PlotEdge',titleX+8,ty+15);
    doc.setFont(undefined,'normal'); doc.setFontSize(6.4); doc.setTextColor(190);
    doc.text('FIELD SURVEY PLAN',titleX+8,ty+26,{charSpace:0.8});
    doc.setTextColor(30);
    ty += 34;

    const panel = (label, lines, opts) => {
      const h = planPanelHeight(doc, tw, label, lines, opts);
      planPanel(doc, titleX, ty, tw, h, label, lines, opts);
      ty += h;
    };

    panel('Project', [project.name || activeProjectDisplayName()], { bold:true, size:10.5, leading:12 });

    const partyLines = [];
    if (project.client)  partyLines.push('Client:  ' + project.client);
    if (project.manager) partyLines.push('Manager: ' + project.manager);
    if (project.site)    partyLines.push('Site:    ' + project.site);
    if (project.description) partyLines.push(project.description);
    if (partyLines.length) panel('Project details', partyLines, { size:7.4, leading:9 });

    // Coordinate system. Stated plainly rather than assumed: a plan whose CRS is
    // unstated cannot be combined with anyone else's data without a guess.
    const centreLat=(extent.north+extent.south)/2, centreLon=(extent.east+extent.west)/2;
    panel('Coordinate reference', [
      'Datum:      WGS 84 (EPSG:4326)',
      'Captured:   Geographic lat/long, decimal degrees',
      'Sheet proj: Equirectangular, standard parallel ' + centreLat.toFixed(3) + '\u00B0',
      'Origin:     ' + centreLat.toFixed(6) + ', ' + centreLon.toFixed(6)
    ], { size:6.6, leading:8.4 });

    // Scale + bar. The bar is drawn at the exact page length its ground distance
    // maps to, so it stays true if the sheet is photocopied at a reduction.
    const scaleH = 46;
    doc.setDrawColor(120); doc.setLineWidth(0.6);
    doc.rect(titleX,ty,tw,scaleH);
    doc.setFont(undefined,'bold'); doc.setFontSize(5.6); doc.setTextColor(130);
    doc.text('SCALE',titleX+6,ty+11,{charSpace:0.6});
    doc.setFont(undefined,'bold'); doc.setFontSize(11); doc.setTextColor(30);
    doc.text('1 : ' + denom.toLocaleString(),titleX+6,ty+24);
    doc.setFont(undefined,'normal');
    const niceSteps=[1,2,5,10,20,25,50,100,200,250,500,1000,2000,5000];
    let niceM=niceSteps[0];
    for(const step of niceSteps){ if(step*scale<=tw-70) niceM=step; else break; }
    const barLen=niceM*scale, barX=titleX+6, barY=ty+38;
    // Alternating filled/open segments — the standard drafted scale bar, easier
    // to read a part-length against than a plain rule.
    const segs=4, segLen=barLen/segs;
    for(let i=0;i<segs;i++){
      doc.setFillColor(i%2 ? 255 : 30); doc.setDrawColor(30); doc.setLineWidth(0.5);
      doc.rect(barX+i*segLen,barY-4,segLen,4.5, i%2 ? 'S':'FD');
    }
    doc.setFontSize(5.8); doc.setTextColor(60);
    doc.text('0',barX,barY+7);
    doc.text(niceM+' m',barX+barLen,barY+7,{align:'right'});
    ty += scaleH;

    // North arrow + survey totals, side by side
    const navH=54;
    doc.setDrawColor(120); doc.setLineWidth(0.6);
    doc.rect(titleX,ty,tw,navH);
    const naX=titleX+26, naY=ty+30;
    doc.setDrawColor(30); doc.setFillColor(30); doc.setLineWidth(1.1);
    doc.line(naX,naY+16,naX,naY-10);
    doc.triangle(naX-5.5,naY-4,naX+5.5,naY-4,naX,naY-14,'F');
    doc.circle(naX,naY+3,13,'S');
    doc.setFontSize(7); doc.setFont(undefined,'bold'); doc.setTextColor(30);
    doc.text('N',naX-2.2,naY-16);
    doc.setFont(undefined,'normal');
    doc.setFontSize(5.6); doc.setTextColor(130);
    doc.text('GRID NORTH \u00B7 SHEET IS NORTH-UP',naX+22,ty+13,{charSpace:0.4});
    let totLen=0, totArea=0;
    savedFeatures.forEach(f=>{
      const vs=(f.vertices||[]).filter(v=>v.lat!=null);
      if(f.geometryType==='line' && vs.length>=2) totLen+=lineLengthM(vs);
      if(f.geometryType==='polygon' && vs.length>=3){ const pa=polygonAreaAndPerimeterM(vs); totArea+=pa.area; totLen+=pa.perimeter; }
    });
    doc.setFontSize(6.6); doc.setTextColor(30);
    const totVerts=savedFeatures.reduce((n,f)=>n+(f.vertices||[]).length,0);
    doc.text('Features: '+savedFeatures.length,naX+22,ty+24);
    doc.text('Vertices: '+totVerts,naX+22,ty+33);
    if(totLen)  doc.text('Length:   '+formatLength(totLen),naX+22,ty+42);
    if(totArea) doc.text('Area:     '+formatArea(totArea),naX+22,ty+51);
    ty += navH;

    // Legend
    const typeCounts={};
    savedFeatures.forEach(f=>{ typeCounts[f.featureTypeId]=(typeCounts[f.featureTypeId]||0)+1; });
    const geoGlyph={point:'point',line:'line',polygon:'poly'};
    const legendKeys=Object.keys(typeCounts);
    const legendH=16+legendKeys.length*11+4;
    doc.setDrawColor(120); doc.setLineWidth(0.6);
    doc.rect(titleX,ty,tw,legendH);
    doc.setFont(undefined,'bold'); doc.setFontSize(5.6); doc.setTextColor(130);
    doc.text('LEGEND',titleX+6,ty+11,{charSpace:0.6});
    doc.setFont(undefined,'normal');
    let ly=ty+21;
    legendKeys.forEach(ftId=>{
      const ft=getFeatureType(ftId);
      const color=featureTypeColor(ftId);
      const rgb=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];
      const geo=(ft&&ft.geometryType)||'point';
      const shape=featureTypeShape(ftId);
      const lineStyle=featureTypeLineStyle(ftId);
      const filled=featureTypeFilled(ftId);
      const dash=pdfDashPattern(lineStyle,1);
      doc.setFillColor(...rgb); doc.setDrawColor(...rgb);
      // The swatch shows the symbology actually used on the sheet, so a legend
      // entry cannot describe a line and sit next to a dot.
      if(geo==='polygon'){
        doc.setLineWidth(0.8);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern(dash,0);
        doc.rect(titleX+7,ly-5.5,9,6, filled ? 'FD' : 'D');
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern([],0);
      } else if(geo==='line'){
        doc.setLineWidth(1.6);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern(dash,0);
        doc.line(titleX+7,ly-2.5,titleX+16,ly-2.5);
        if(dash && doc.setLineDashPattern) doc.setLineDashPattern([],0);
      } else if(shape==='square'){
        doc.rect(titleX+9.2,ly-4.8,4.6,4.6,'F');
      } else if(shape==='triangle'){
        doc.triangle(titleX+11.5,ly-5.4,titleX+8.8,ly-0.5,titleX+14.2,ly-0.5,'F');
      } else {
        doc.circle(titleX+11.5,ly-2.5,2.6,'F');
      }
      doc.setFontSize(6.8); doc.setTextColor(40);
      doc.text(((ft&&ft.name)||'Unclassified')+'  ('+typeCounts[ftId]+')',titleX+21,ly);
      ly+=11;
    });
    ty += legendH;

    // Issue block — who, when, which sheet, which revision.
    const issued=new Date();
    panel('Issued', [
      'Date:    ' + issued.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'2-digit'}),
      'Time:    ' + issued.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),
      'Surveyed: ' + (project.createdAt ? new Date(project.createdAt).toLocaleDateString() : '\u2014'),
      'Drawn by: PlotEdge ' + (typeof APP_VERSION!=='undefined' ? APP_VERSION : 'field app'),
      'Sheet:    1 of 1        Rev: A'
    ], { size:6.6, leading:8.4 });

    // Notes. The disclaimer belongs on the sheet, not in a chat message: this is
    // a GNSS field capture, not a cadastral survey, and it must not be mistaken
    // for one by whoever opens the file next year.
    const noteLines=[
      'Positions from GNSS field capture; accuracy as recorded per vertex.',
      'Not a cadastral or boundary survey. Not for construction setting-out.',
      'Areas and lengths computed on the ellipsoid from captured coordinates.'
    ];
    if(basemapAttribution) noteLines.push('Basemap is indicative context only: ' + basemapAttribution);
    panel('Notes', noteLines, { size:5.8, leading:7.4, color:90 });

    const layoutName=`${sanitizeFileSegment(project.name||'Project').replace(/\s+/g,'_')}_plan_${ts()}.pdf`;
    const layoutRes=await saveExportFile(doc.output('blob'), layoutName, 'application/pdf');
    if(noteExportSaved(layoutRes,layoutName)) markProjectExported();
  }catch(err){
    console.error(err);
    document.getElementById('exportStatus').textContent='Map layout export failed';
    showToast('Map layout export failed. Check console.');
  }finally{
    btn.disabled=false; updateExportFormatUI();
  }
}
