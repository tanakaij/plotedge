// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Web map publishing to GitHub Pages
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ WEB MAP (GitHub Pages) ══ — publishes a self-contained, read-only Leaflet page per project to
// a GitHub repo the person owns, via direct browser calls to api.github.com (GitHub's REST API
// supports CORS from any origin, so no PlotEdge-run server sits in the middle of this). Uses the
// Git Data API (blobs/trees/commits) rather than the simpler Contents API, because the Contents
// API rejects anything much over ~1MB in one call — too easy to hit once photos are embedded —
// while the Git Data API used here handles files up to 100MB and, as a side benefit, also handles
// the very first commit into a brand-new empty repo without any special-casing.
const GH_TOKEN_KEY='plotedge_gh_token', GH_OWNER_KEY='plotedge_gh_owner', GH_REPO_KEY='plotedge_gh_repo';

const WEBMAP_SLUGS_KEY='plotedge_webmap_slugs', WEBMAPS_KEY='plotedge_webmaps';


function utf8ToBase64(str){ return btoa(unescape(encodeURIComponent(str))); }


// Deliberately does NOT send the X-GitHub-Api-Version header some GitHub examples include —
// that header isn't in api.github.com's CORS allow-list yet and fails the browser's preflight,
// even though the exact same call works fine from curl/Node. Every call below goes through here.
async function ghRequest(path, opts){
  opts = opts || {};
  const token = localStorage.getItem(GH_TOKEN_KEY);
  const headers = Object.assign(
    { 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json' },
    opts.body ? {'Content-Type':'application/json'} : {},
    opts.headers || {}
  );
  return fetch('https://api.github.com'+path, Object.assign({}, opts, {headers}));
}


// ── Setup / connection ──
async function connectGithub(){
  const tokenInput = document.getElementById('ghTokenInput').value.trim();
  const repoInput = document.getElementById('ghRepoInput').value.trim() || 'plotedge-maps';
  if (!tokenInput){ showToast('Paste your token first'); return; }
  const btn = document.getElementById('ghConnectBtn');
  const statusEl = document.getElementById('ghConnectStatus');
  const prevToken = localStorage.getItem(GH_TOKEN_KEY);
  btn.disabled=true; btn.textContent='Connecting…'; statusEl.textContent='';
  try{
    localStorage.setItem(GH_TOKEN_KEY, tokenInput);
    const userRes = await ghRequest('/user');
    if (!userRes.ok) throw new Error("Could not verify that token — check it was copied correctly and hasn't expired.");
    const user = await userRes.json();
    const owner = user.login;
    const repoRes = await ghRequest('/repos/'+owner+'/'+repoInput);
    if (repoRes.status===404) throw new Error('Repo "'+owner+'/'+repoInput+'" not found, or the token can\'t see it. Create the repo on GitHub first, then scope the token to it.');
    if (!repoRes.ok) throw new Error('Could not access that repo — check the token has Contents and Pages permissions.');
    localStorage.setItem(GH_OWNER_KEY, owner);
    localStorage.setItem(GH_REPO_KEY, repoInput);
    document.getElementById('ghTokenInput').value='';
    showToast('Connected to GitHub');
    updateWebmapCardUI();
  }catch(err){
    console.error(err);
    if (prevToken) localStorage.setItem(GH_TOKEN_KEY, prevToken); else localStorage.removeItem(GH_TOKEN_KEY);
    statusEl.textContent = err.message || 'Could not connect. Check your token.';
  }finally{
    btn.disabled=false; btn.textContent='Connect';
  }
}

function disconnectGithub(){
  showConfirm('Disconnect GitHub from this device? Anything already published stays live — this only removes the saved token here.', ()=>{
    localStorage.removeItem(GH_TOKEN_KEY);
    localStorage.removeItem(GH_OWNER_KEY);
    localStorage.removeItem(GH_REPO_KEY);
    updateWebmapCardUI();
    showToast('Disconnected');
  }, 'Disconnect', 'default');
}


// ── Local records: stable per-project folder slug, and the "is this project currently live" registry ──
function webmapSlugFor(project){
  // Guarded like getWebmapRegistry() below. This was the one localStorage read on the publish
  // path that trusted its own stored value: a corrupt entry threw here and took out the whole
  // publish flow, rather than degrading to "no slugs recorded yet" the way every other reader
  // of this store already does.
  let slugs = {};
  try { slugs = JSON.parse(localStorage.getItem(WEBMAP_SLUGS_KEY)||'{}') || {}; } catch(e) { slugs = {}; }
  if (slugs[project.id]) return slugs[project.id];
  const base = (project.name||'project').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50) || 'project';
  slugs[project.id]=base;
  try { localStorage.setItem(WEBMAP_SLUGS_KEY, JSON.stringify(slugs)); } catch(e) {}
  return base;
}

function getWebmapRegistry(){ try{ return JSON.parse(localStorage.getItem(WEBMAPS_KEY)||'{}'); }catch(e){ return {}; } }

function getWebmapRecord(projectId){ return getWebmapRegistry()[projectId] || null; }

function saveWebmapRecord(projectId, rec){ const reg=getWebmapRegistry(); reg[projectId]=rec; localStorage.setItem(WEBMAPS_KEY, JSON.stringify(reg)); }

function removeWebmapRecord(projectId){ const reg=getWebmapRegistry(); delete reg[projectId]; localStorage.setItem(WEBMAPS_KEY, JSON.stringify(reg)); }


// ── Git Data API plumbing (blob → tree → commit → ref) ──
// Reads the target branch's current commit + tree SHA once, shared by both commit and delete
// below. commitSha/treeSha come back null for a brand-new empty repo (no commits yet) — both
// ghCommitFile and ghDeletePath know how to handle that starting state.
async function ghHeadCommit(){
  const owner=localStorage.getItem(GH_OWNER_KEY), repo=localStorage.getItem(GH_REPO_KEY);
  const repoRes = await ghRequest('/repos/'+owner+'/'+repo);
  if (!repoRes.ok) throw new Error('Could not read repo details.');
  const repoInfo = await repoRes.json();
  const branch = repoInfo.default_branch || 'main';
  const refRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/ref/heads/'+branch);
  if (refRes.status===404) return { owner, repo, branch, commitSha:null, treeSha:null };
  if (!refRes.ok) throw new Error('Could not read the branch.');
  const refInfo = await refRes.json();
  const commitSha = refInfo.object.sha;
  const commitRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/commits/'+commitSha);
  if (!commitRes.ok) throw new Error('Could not read the latest commit.');
  const commitInfo = await commitRes.json();
  return { owner, repo, branch, commitSha, treeSha: commitInfo.tree.sha };
}

async function ghCommitFile(path, contentStr, message){
  const {owner,repo,branch,commitSha,treeSha} = await ghHeadCommit();
  const blobRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/blobs', {method:'POST', body:JSON.stringify({content:utf8ToBase64(contentStr), encoding:'base64'})});
  if (!blobRes.ok) throw new Error('Could not upload the page content to GitHub.');
  const blob = await blobRes.json();
  const treeBody = { tree:[{path, mode:'100644', type:'blob', sha:blob.sha}] };
  if (treeSha) treeBody.base_tree = treeSha;
  const treeRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/trees', {method:'POST', body:JSON.stringify(treeBody)});
  if (!treeRes.ok) throw new Error('Could not prepare the update.');
  const tree = await treeRes.json();
  const commitRes2 = await ghRequest('/repos/'+owner+'/'+repo+'/git/commits', {method:'POST', body:JSON.stringify({message, tree:tree.sha, parents: commitSha?[commitSha]:[]})});
  if (!commitRes2.ok) throw new Error('Could not create the commit.');
  const newCommit = await commitRes2.json();
  if (commitSha){
    const patchRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/refs/heads/'+branch, {method:'PATCH', body:JSON.stringify({sha:newCommit.sha})});
    if (!patchRes.ok) throw new Error('Could not update the branch.');
  } else {
    const createRefRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/refs', {method:'POST', body:JSON.stringify({ref:'refs/heads/'+branch, sha:newCommit.sha})});
    if (!createRefRes.ok) throw new Error('Could not create the branch.');
  }
  return { branch };
}

async function ghDeletePath(path, message){
  const {owner,repo,branch,commitSha,treeSha} = await ghHeadCommit();
  if (!commitSha) throw new Error('Nothing published yet.');
  // sha:null on a tree entry (with base_tree set) is the Git Data API's way of removing that one
  // path from the resulting tree — every other file (other projects' folders included) is left
  // exactly as-is, no need to walk/rebuild the whole tree by hand.
  const treeRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/trees', {method:'POST', body:JSON.stringify({base_tree:treeSha, tree:[{path, mode:'100644', type:'blob', sha:null}]})});
  if (!treeRes.ok) throw new Error('Could not prepare the removal.');
  const tree = await treeRes.json();
  const commitRes2 = await ghRequest('/repos/'+owner+'/'+repo+'/git/commits', {method:'POST', body:JSON.stringify({message, tree:tree.sha, parents:[commitSha]})});
  if (!commitRes2.ok) throw new Error('Could not create the commit.');
  const newCommit = await commitRes2.json();
  const patchRes = await ghRequest('/repos/'+owner+'/'+repo+'/git/refs/heads/'+branch, {method:'PATCH', body:JSON.stringify({sha:newCommit.sha})});
  if (!patchRes.ok) throw new Error('Could not update the branch.');
}

async function ensurePagesEnabled(branch){
  const owner=localStorage.getItem(GH_OWNER_KEY), repo=localStorage.getItem(GH_REPO_KEY);
  const res = await ghRequest('/repos/'+owner+'/'+repo+'/pages');
  if (res.ok || res.status!==404) return; // already on, or an unrelated hiccup not worth blocking publish over
  try{ await ghRequest('/repos/'+owner+'/'+repo+'/pages', {method:'POST', body:JSON.stringify({source:{branch, path:'/'}})}); }
  catch(e){ console.warn('Could not auto-enable Pages', e); }
}


// ── Building the published page itself ──
// Same downscale approach as the Map Layout basemap's DPI choice — small enough that a project
// with dozens of photos still loads quickly on mobile data, without needing a separate assets
// folder (everything, including photos, lives inside the one committed index.html).
function resizePhotoForWeb(dataUrl, maxW, quality){
  maxW = maxW || 480; quality = quality || 0.62;
  return new Promise(resolve=>{
    try{
      const img = new Image();
      img.onload = ()=>{
        try{
          const scale = Math.min(1, maxW/img.width);
          const w = Math.max(1, Math.round(img.width*scale)), h = Math.max(1, Math.round(img.height*scale));
          const c = document.createElement('canvas'); c.width=w; c.height=h;
          c.getContext('2d').drawImage(img,0,0,w,h);
          resolve(c.toDataURL('image/jpeg', quality));
        }catch(e){ resolve(null); }
      };
      img.onerror = ()=>resolve(null);
      img.src = dataUrl;
    }catch(e){ resolve(null); }
  });
}

async function buildWebmapFeatureData(onProgress){
  // Photo bytes live in the media store; resizePhotoForWeb() below takes a
  // data URL, so read them back before the walk. Shed again at the end — a
  // published map with a hundred photos would otherwise leave a hundred
  // full-size base64 strings alive in the heap for the rest of the session.
  const _photos = await hydrateExportPhotos(savedFeatures);
  try {
  const project = projects.find(p=>p.id===activeProjectId);
  const legendMap = new Map();
  const features = [];
  let photoIdx=0, totalPhotos=0;
  savedFeatures.forEach(f=>(f.vertices||[]).forEach(v=>totalPhotos+=(v.photos||[]).length));
  for (const f of savedFeatures){
    const info = resolveFeatureType(f);
    const color = featureTypeColor(info.key);
    legendMap.set(info.key, {label:info.label, color});
    const geo = f.geometryType || 'point';
    const verts = f.vertices || [];
    const baseAttrs = flattenAttrs(f.attrs);
    if (f.ref) baseAttrs['Reference'] = f.ref;
    if (f.assignedTo) baseAttrs['Assigned to'] = f.assignedTo;
    if (f.notes) baseAttrs['Notes'] = f.notes;
    if (geo==='point'){
      for (const v of verts){
        const photos=[];
        for (const p of (v.photos||[])){
          photoIdx++; if (onProgress) onProgress('Resizing photos… '+photoIdx+'/'+totalPhotos);
          const small = await resizePhotoForWeb(p.dataUrl);
          if (small) photos.push(small);
        }
        features.push({ name:f.name, type:info.label, color, geo:'point', coords:[v.lat,v.lon], attrs:{...baseAttrs, ...flattenAttrs(v.attrs)}, photos });
      }
    } else {
      const photos=[];
      for (const v of verts){
        for (const p of (v.photos||[])){
          photoIdx++; if (onProgress) onProgress('Resizing photos… '+photoIdx+'/'+totalPhotos);
          const small = await resizePhotoForWeb(p.dataUrl);
          if (small) photos.push(small);
        }
      }
      features.push({ name:f.name, type:info.label, color, geo, coords:verts.map(v=>[v.lat,v.lon]), attrs:baseAttrs, photos });
    }
  }
  return { features, legend:Array.from(legendMap.values()), meta:{ name: project?project.name:'Project', generatedAt:new Date().toISOString() } };
  } finally { releaseExportPhotos(_photos); }
}

// The published page is entirely self-contained: Leaflet from CDN, everything else (feature data,
// photos, styling, popup/legend/basemap-toggle logic) inlined into this one file, so "delete" is
// ever only one commit removing one path. \u003c is used instead of a literal < inside the embedded
// JSON so a stray "<\/script>" in someone's notes/attribute text can't prematurely close the page's
// own script tag.
function buildWebmapHTML(project, data){
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = escapeHtml(project ? project.name : 'PlotEdge Web Map');
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">\n'
    + '<title>'+title+' — Web Map</title>\n'
    + '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />\n'
    + '<style>\n'
    + ':root{--accent:#047857;--ink:#0F172A;--muted:#64748B;--bg:#F1F5F9;--card:#ffffff;--border:#CBD5E1;}\n'
    + '@media (prefers-color-scheme: dark){:root{--accent:#10B981;--ink:#F8FAFC;--muted:#94A3B8;--bg:#0B0F19;--card:#1E293B;--border:#334155;}}\n'
    + '*{box-sizing:border-box;}\nhtml,body{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);}\n'
    + '#map{position:absolute;inset:0;z-index:0;}\n'
    + '.pe-topbar{position:absolute;top:0;left:0;right:0;z-index:1000;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px;pointer-events:none;}\n'
    + '.pe-topbar-title{pointer-events:auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:8px 14px;font-weight:800;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,0.14);}\n'
    + '.pe-topbar-title span{display:block;font-weight:500;font-size:11px;color:var(--muted);margin-top:1px;}\n'
    + '.pe-controls{pointer-events:auto;display:flex;gap:8px;}\n'
    + '.pe-btn{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.14);color:var(--ink);}\n'
    + '.pe-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);}\n'
    + '.pe-legend{position:absolute;bottom:16px;left:12px;z-index:1000;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 12px;max-width:60vw;max-height:38vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,0.14);font-size:12px;}\n'
    + '.pe-legend-item{display:flex;align-items:center;gap:7px;margin-bottom:5px;}\n.pe-legend-item:last-child{margin-bottom:0;}\n'
    + '.pe-legend-swatch{width:10px;height:10px;border-radius:50%;flex-shrink:0;}\n'
    + '.pe-popup{min-width:200px;max-width:260px;}\n.pe-popup-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;}\n'
    + '.pe-popup-name{font-size:14px;font-weight:800;margin-bottom:6px;}\n.pe-popup-attrs{font-size:12px;line-height:1.6;margin-bottom:6px;}\n.pe-popup-attrs b{color:var(--muted);font-weight:600;}\n'
    + '.pe-popup-photos{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;}\n.pe-popup-photos img{width:50px;height:50px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--border);}\n'
    + '.pe-lightbox{position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.88);display:none;align-items:center;justify-content:center;padding:24px;}\n.pe-lightbox.show{display:flex;}\n.pe-lightbox img{max-width:100%;max-height:100%;border-radius:8px;}\n'
    + '.pe-footer{position:absolute;bottom:10px;right:12px;z-index:1000;font-size:10.5px;color:var(--muted);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:4px 9px;pointer-events:auto;opacity:0.9;}\n'
    + '@media (max-width:640px){.pe-topbar-title{padding:7px 11px;font-size:12.5px;}.pe-legend{max-width:78vw;font-size:11px;bottom:12px;}.pe-footer{display:none;}}\n'
    + '.leaflet-popup-content-wrapper{border-radius:12px;}\n'
    + '</style>\n</head>\n<body>\n<div id="map"></div>\n'
    + '<div class="pe-topbar"><div class="pe-topbar-title">'+title+'<span id="peCount"></span></div>'
    + '<div class="pe-controls"><button class="pe-btn active" id="peBasemapStreet" onclick="peSetBasemap(\'street\')">Street</button><button class="pe-btn" id="peBasemapSat" onclick="peSetBasemap(\'satellite\')">Satellite</button></div></div>\n'
    + '<div class="pe-legend" id="peLegend"></div>\n'
    + '<div class="pe-footer">Published with PlotEdge · '+new Date().toLocaleDateString()+'</div>\n'
    + '<div class="pe-lightbox" id="peLightbox" onclick="this.classList.remove(\'show\')"><img id="peLightboxImg" src=""></div>\n'
    + '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>\n'
    + '<script>\n'
    + 'const DATA = '+dataJson+';\n'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]));}\n'
    + 'const map = L.map("map",{zoomControl:true,attributionControl:true}).setView([0,0],2);\n'
    + 'const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"});\n'
    + 'const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Esri, Maxar, Earthstar Geographics"});\n'
    + 'streetLayer.addTo(map);\n'
    + 'function peSetBasemap(mode){\n'
    + '  document.getElementById("peBasemapStreet").classList.toggle("active", mode==="street");\n'
    + '  document.getElementById("peBasemapSat").classList.toggle("active", mode==="satellite");\n'
    + '  if(mode==="satellite"){ if(map.hasLayer(streetLayer)) map.removeLayer(streetLayer); satLayer.addTo(map); }\n'
    + '  else { if(map.hasLayer(satLayer)) map.removeLayer(satLayer); streetLayer.addTo(map); }\n'
    + '}\n'
    + 'function peOpenLightbox(src){ document.getElementById("peLightboxImg").src=src; document.getElementById("peLightbox").classList.add("show"); }\n'
    + 'function popupHtml(f){\n'
    + '  const rows = Object.entries(f.attrs||{}).filter(([k,v])=>v!=="" && v!=null).map(([k,v])=>"<div><b>"+esc(k)+":</b> "+esc(v)+"</div>").join("");\n'
    + '  const photos = (f.photos||[]).map(src=>\'<img src="\'+src+\'" onclick="event.stopPropagation();peOpenLightbox(this.src)">\').join("");\n'
    + '  return \'<div class="pe-popup"><div class="pe-popup-type" style="color:\'+f.color+\';">\'+esc(f.type)+\'</div><div class="pe-popup-name">\'+esc(f.name)+\'</div>\'\n'
    + '    + (rows?(\'<div class="pe-popup-attrs">\'+rows+\'</div>\'):"")\n'
    + '    + (photos?(\'<div class="pe-popup-photos">\'+photos+\'</div>\'):"") + "</div>";\n'
    + '}\n'
    + 'const bounds = [];\n'
    + 'DATA.features.forEach(f=>{\n'
    + '  if (f.geo==="point"){\n'
    + '    const ll=[f.coords[0],f.coords[1]]; bounds.push(ll);\n'
    + '    L.circleMarker(ll,{radius:7,color:"#fff",weight:2,fillColor:f.color,fillOpacity:0.95}).bindPopup(popupHtml(f)).addTo(map);\n'
    + '  } else {\n'
    + '    const lls=f.coords.map(c=>[c[0],c[1]]); lls.forEach(ll=>bounds.push(ll));\n'
    + '    if (lls.length){\n'
    + '      if (f.geo==="polygon") L.polygon(lls,{color:f.color,weight:2,fillColor:f.color,fillOpacity:0.25}).bindPopup(popupHtml(f)).addTo(map);\n'
    + '      else L.polyline(lls,{color:f.color,weight:3}).bindPopup(popupHtml(f)).addTo(map);\n'
    + '    }\n'
    + '  }\n'
    + '});\n'
    + 'if (bounds.length===1) map.setView(bounds[0],17); else if (bounds.length>1) map.fitBounds(bounds,{padding:[30,30]});\n'
    + 'document.getElementById("peCount").textContent = DATA.features.length+" feature"+(DATA.features.length===1?"":"s");\n'
    + 'document.getElementById("peLegend").innerHTML = DATA.legend.map(l=>\'<div class="pe-legend-item"><span class="pe-legend-swatch" style="background:\'+l.color+\'"></span>\'+esc(l.label)+"</div>").join("") || \'<span style="color:var(--text-secondary);">No features</span>\';\n'
    + '<\/script>\n</body>\n</html>';
}


// ── Publish / update ──
async function publishWebmap(){
  if (!savedFeatures.length){ showToast('No features to publish'); return; }
  const owner = localStorage.getItem(GH_OWNER_KEY), repo = localStorage.getItem(GH_REPO_KEY);
  if (!owner || !repo){ showToast('Connect GitHub first'); return; }
  const project = projects.find(p=>p.id===activeProjectId);
  if (!project){ showToast('No active project'); return; }
  const statusEl = document.getElementById('webmapPublishStatus');
  const box = document.getElementById('webmapStatusBox');
  box.querySelectorAll('button').forEach(b=>b.disabled=true);
  const wasLive = !!getWebmapRecord(project.id);
  try{
    statusEl.textContent = 'Preparing…';
    const data = await buildWebmapFeatureData(msg=>{ statusEl.textContent = msg; });
    statusEl.textContent = 'Building page…';
    const slug = webmapSlugFor(project);
    const html = buildWebmapHTML(project, data);
    statusEl.textContent = 'Uploading to GitHub…';
    const {branch} = await ghCommitFile(slug+'/index.html', html, (wasLive?'Update':'Publish')+' "'+project.name+'" web map via PlotEdge');
    statusEl.textContent = 'Checking GitHub Pages…';
    await ensurePagesEnabled(branch);
    const url = 'https://'+owner+'.github.io/'+repo+'/'+slug+'/';
    const prevRec = getWebmapRecord(project.id);
    saveWebmapRecord(project.id, { slug, url, publishedAt: (prevRec&&prevRec.publishedAt) || new Date().toISOString(), updatedAt: new Date().toISOString() });
    statusEl.textContent = '';
    showToast(wasLive ? 'Web map updated' : 'Web map published — it can take a minute to go live the first time');
  }catch(err){
    console.error(err);
    statusEl.textContent = '';
    showToast(err.message || 'Publish failed. Check console.');
  }finally{
    updateWebmapCardUI();
  }
}

function copyWebmapUrl(url){
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(()=>showToast('Link copied')).catch(()=>showToast(url));
  else showToast(url);
}


// ── Delete (typed confirmation — see webmapDeleteModal) ──
function openWebmapDeleteModal(){
  const project = projects.find(p=>p.id===activeProjectId);
  if (!project) return;
  document.getElementById('webmapDeleteProjName').textContent = project.name;
  document.getElementById('webmapDeleteConfirmInput').value='';
  document.getElementById('webmapDeleteConfirmBtn').disabled=true;
  document.getElementById('webmapDeleteModal').classList.add('show');
}

function closeWebmapDeleteModal(){ document.getElementById('webmapDeleteModal').classList.remove('show'); }

function checkWebmapDeleteConfirm(){
  const project = projects.find(p=>p.id===activeProjectId);
  const val = document.getElementById('webmapDeleteConfirmInput').value;
  document.getElementById('webmapDeleteConfirmBtn').disabled = !(project && val === project.name);
}

async function confirmDeleteWebmap(){
  const project = projects.find(p=>p.id===activeProjectId);
  if (!project) return;
  const rec = getWebmapRecord(project.id);
  if (!rec){ closeWebmapDeleteModal(); return; }
  const btn = document.getElementById('webmapDeleteConfirmBtn');
  btn.disabled=true; btn.textContent='Deleting…';
  try{
    await ghDeletePath(rec.slug+'/index.html', 'Remove "'+project.name+'" web map via PlotEdge');
    removeWebmapRecord(project.id);
    closeWebmapDeleteModal();
    showToast('Web map deleted');
  }catch(err){
    console.error(err);
    showToast(err.message || 'Could not delete. Check console.');
  }finally{
    btn.disabled=false; btn.textContent='Delete web map';
    updateWebmapCardUI();
  }
}


// ── Card UI (called from refreshExportMeta() whenever the Export tab is opened) ──
function updateWebmapCardUI(){
  const setupBlock = document.getElementById('ghSetupBlock');
  const connectedBlock = document.getElementById('ghConnectedBlock');
  if (!setupBlock || !connectedBlock) return;
  const token = localStorage.getItem(GH_TOKEN_KEY), owner = localStorage.getItem(GH_OWNER_KEY), repo = localStorage.getItem(GH_REPO_KEY);
  if (!token || !owner || !repo){
    setupBlock.style.display='block'; connectedBlock.style.display='none';
    return;
  }
  setupBlock.style.display='none'; connectedBlock.style.display='block';
  document.getElementById('ghConnectedInfo').innerHTML = 'Connected as <strong>'+escapeHtml(owner)+'</strong> → <code>'+escapeHtml(owner)+'/'+escapeHtml(repo)+'</code>';
  const project = projects.find(p=>p.id===activeProjectId);
  const box = document.getElementById('webmapStatusBox');
  if (!project){ box.innerHTML=''; return; }
  const rec = getWebmapRecord(project.id);
  if (!rec){
    box.innerHTML = '<div class="webmap-status-badge offline">Not published</div>'
      + '<button class="btn btn-geo" style="margin-bottom:0;" onclick="publishWebmap()"'+(savedFeatures.length?'':' disabled')+'>Publish web map</button>'
      + (savedFeatures.length?'':'<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;">Capture at least one feature first.</div>');
  } else {
    box.innerHTML = '<div class="webmap-status-badge live">Live</div>'
      + '<div class="webmap-url-row"><a href="'+rec.url+'" target="_blank" rel="noopener">'+rec.url+'</a>'
      + '<button onclick="copyWebmapUrl(\''+rec.url+'\')" title="Copy link"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>'
      + '<div class="webmap-meta-label">Updated '+timeAgo(rec.updatedAt)+'</div>'
      + '<div class="webmap-btn-row"><button class="btn btn-outline" onclick="publishWebmap()">Update web map</button><button class="btn tone-danger" onclick="openWebmapDeleteModal()">Delete</button></div>';
  }
}
