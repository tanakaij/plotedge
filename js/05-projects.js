// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Projects UI, landing screen, data hub, project manager, templates, notes
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ PROJECTS UI ══
// The actual screen-swap, shared by showProjects() (a genuine forward navigation, e.g. the
// bottom-nav "Projects" tab or the popstate replay) and cancelProjectForm() (returning to a
// projects list that's already sitting one stop back in history — see cancelProjectForm below).
// ══ SEPARATION OF VIEWS ══
// "Welcome to PlotEdge" (#view-projects) is now strictly an onboarding / empty state: it only
// renders on a cold launch with no projects yet. The moment there is at least one project, every
// route into "projects" — the bottom-nav Projects tab, the back arrow out of a project, a Back
// press replaying a 'projects' history stop — lands on the Project Manager dashboard instead.
// Both screens are driven from this one function so the two can never disagree about which is
// showing, and so the choice is re-evaluated after a create/delete without any caller changes.
function renderProjectsScreen() {
  const target = projects.length ? 'view-projectmgr' : 'view-projects';
  // Remember which project the crew was in *before* clearing activeProjectId — the Project
  // Manager's "Currently Active" card depends on it, and the write below would otherwise erase it.
  if (activeProjectId) setActiveProjectRef(activeProjectId);
  activateView(target);
  activeProjectId = null;
  saveLastSession(null);
  if (target === 'view-projectmgr') { renderProjectManager(); document.getElementById('scrollRoot').scrollTo(0, 0); }
  else renderProjectsList();
}

// ══ THE LANDING SCREEN, ON DEMAND ══
// #view-projects (the brand lockup, New / Template / Restore) was only ever reachable when the
// account held zero projects: renderProjectsScreen() routes straight past it to the Project
// Manager the moment one exists. So once a crew had a single project there was no way back to
// the home screen at all — the three primary actions on it were only reachable via the Project
// Manager's own buttons, and there was no "start of the app" to return to.
// This is deliberately separate from renderProjectsScreen(): that function answers "take me out
// of this project", which should still land on the list where you pick the next one. This one
// answers "take me home", and forces the landing screen whatever the project count.
function renderLandingScreen() {
  if (activeProjectId) setActiveProjectRef(activeProjectId);
  activateView('view-projects');
  activeProjectId = null;
  saveLastSession(null);
  renderProjectsList();   // the band comes from VIEW_SCREEN_STATE via activateView()
  document.getElementById('scrollRoot').scrollTo(0, 0);
}

function showLanding() {
  renderLandingScreen();
  pushNavState('landing');
}


function showProjects() {
  renderProjectsScreen();
  pushNavState('projects');
}


// ══ DATA HUB ══
// Deliberately separate from showProjects(). Two different intents were being served by one
// function: "take me out of this project" (the header back arrow, the popstate fallbacks, a
// deleted-project guard) wants the *project list*, because that's where you pick the next one to
// open. "Data" in the bottom nav wants the hub. Routing both through one function would mean
// every back-out landed on a menu instead of the list, which is a step backwards from where the
// app was. So showProjects() is untouched and this is additive.
// The zero-projects case still falls through to Welcome: a hub whose every row reads "0 projects,
// nothing to back up, 0 KB" is worse than the first-run screen.
function renderDataHubScreen() {
  if (!projects.length) { renderProjectsScreen(); return; }
  if (activeProjectId) setActiveProjectRef(activeProjectId);
  activateView('view-datahub');
  activeProjectId = null;
  saveLastSession(null);
  renderDataHub();
  document.getElementById('scrollRoot').scrollTo(0, 0);
}

function showDataHub() {
  renderDataHubScreen();
  pushNavState('datahub');
}

// Reached from the hub's Projects row. Keeps the hub stop underneath it so Back returns there.
function showProjectManagerFromHub() {
  if (!projects.length) { renderProjectsScreen(); return; }
  activateView('view-projectmgr');
  renderProjectManager();
  document.getElementById('scrollRoot').scrollTo(0, 0);
  pushNavState('projects');
}

function showBackupRestore() {
  activateView('view-backup');
  renderBackupStatus();
  document.getElementById('scrollRoot').scrollTo(0, 0);
  pushNavState('backup');
}

function showStorage() {
  activateView('view-storage');
  renderStorage();
  document.getElementById('scrollRoot').scrollTo(0, 0);
  pushNavState('storage');
}


// Every figure on the hub comes from getProjectStats(), the same helper the Project Manager cards
// and the home screen widget already use. "Not synced" in particular has a specific meaning —
// exported *since the last change*, so a stale export doesn't count — and re-deriving it here
// would be exactly the drift publishWidgetSummary() was fixed for.
function dataHubTotals(){
  let features = 0, inProgress = 0, bytes = 0, unsynced = 0, lastExport = null;
  projects.forEach(p=>{
    const s = getProjectStats(p);
    features += s.features;
    inProgress += s.inProgress;
    bytes += s.bytes;
    if (s.features && !s.synced) unsynced++;
    if (s.exported && (!lastExport || new Date(s.exported) > new Date(lastExport))) lastExport = s.exported;
  });
  return { count: projects.length, features, inProgress, bytes, unsynced, lastExport };
}

function plural(n, word){ return n + ' ' + word + (n === 1 ? '' : 's'); }


function renderDataHub(){
  document.querySelectorAll('.nav-btn[id^="navBtn-"]').forEach(b=>b.classList.toggle('active', b.id === 'navBtn-data'));
  const t = dataHubTotals();
  const sum = document.getElementById('hubSummary');
  if (sum) {
    const stat = (val, label) =>
      `<div class="hub-stat"><div class="hub-stat-val">${escapeHtml(String(val))}</div><div class="hub-stat-lbl">${escapeHtml(label)}</div></div>`;
    sum.innerHTML = stat(t.count, t.count === 1 ? 'Project' : 'Projects')
                  + stat(t.features, t.features === 1 ? 'Feature' : 'Features')
                  + stat(formatBytes(t.bytes), 'On device');
  }

  const backupSub = t.unsynced
    ? plural(t.unsynced, 'project') + ' not exported yet'
    : (t.lastExport ? 'Last export ' + timeAgo(t.lastExport) : 'Nothing exported yet');
  const projectsSub = t.inProgress
    ? plural(t.count, 'project') + ' · ' + t.inProgress + ' mid-capture'
    : plural(t.count, 'project') + ' · ' + plural(t.features, 'feature');

  const row = (fn, icon, title, sub, badge) =>
    `<button class="hub-row" onclick="${fn}">
       <span class="hub-row-icon">${icon}</span>
       <span class="hub-row-body">
         <span class="hub-row-title">${escapeHtml(title)}</span>
         <span class="hub-row-sub">${escapeHtml(sub)}</span>
       </span>
       ${badge ? `<span class="hub-row-badge">${escapeHtml(badge)}</span>` : ''}
       <svg class="hub-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
     </button>`;

  const icoFolder = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const icoBackup = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const icoDisk = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>';

  const rows = document.getElementById('hubRows');
  if (rows) {
    const icoExit = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    rows.innerHTML =
      row('showProjectManagerFromHub()', icoFolder, 'Projects', projectsSub, t.unsynced ? t.unsynced + ' unsynced' : '')
    + row('showBackupRestore()', icoBackup, 'Backup & Restore', backupSub, '')
    + row('showStorage()', icoDisk, 'Storage', formatBytes(t.bytes) + ' used on this device', '')
    // Exit lives here because Data is the only tab that is about the app rather than about the
    // survey in front of you — the same reasoning that put Backup and Storage on it. Native only:
    // a browser tab cannot close itself, so on web this row simply isn't rendered rather than
    // being rendered and doing nothing.
    + (isNativeShell() ? row('confirmExitApp()', icoExit, 'Exit PlotEdge', 'Your work stays saved on this device', '') : '');
  }
}


function renderBackupStatus(){
  const el = document.getElementById('backupNote');
  if (!el) return;
  const t = dataHubTotals();
  el.innerHTML = t.unsynced
    ? `<div class="hub-note hub-note-warn"><strong>${escapeHtml(plural(t.unsynced, 'project'))}</strong> ${t.unsynced === 1 ? 'has' : 'have'} captured data that hasn't been exported yet. Back up before wiping the app or handing the device on.</div>`
    : `<div class="hub-note">Everything captured on this device has been exported${t.lastExport ? ' — most recently ' + escapeHtml(timeAgo(t.lastExport)) : ''}.</div>`;
}


function renderStorage(){
  const el = document.getElementById('storageBody');
  if (!el) return;
  const t = dataHubTotals();
  // Sizes come straight from getProjectStats().bytes, which measures the serialised JSON this app
  // actually writes to localStorage. It is not the OS's idea of app size (no code, no caches, no
  // basemap tiles), so the screen says "project data" rather than implying a device-wide figure.
  const rows = projects.map(p => {
    const s = getProjectStats(p);
    return { name: p.name, bytes: s.bytes, color: featureTypeColor(p.id) };
  }).sort((a,b) => b.bytes - a.bytes);

  const total = rows.reduce((n,r) => n + r.bytes, 0);
  const bar = total > 0
    ? `<div class="storage-bar">${rows.map(r =>
         `<div class="storage-bar-seg" style="width:${(r.bytes/total*100).toFixed(2)}%;background:${r.color};"></div>`
       ).join('')}</div>`
    : '';

  el.innerHTML =
    `<div class="hub-block">
       <div class="hub-block-title">${escapeHtml(formatBytes(total))} of project data</div>
       <div class="hub-block-desc">Across ${escapeHtml(plural(t.count,'project'))} and ${escapeHtml(plural(t.features,'feature'))}. This counts the captured data PlotEdge stores on the device — photos are the bulk of it — and not the app itself or any cached map tiles.</div>
       ${bar}
       ${rows.map(r =>
         `<div class="storage-row">
            <span class="storage-dot" style="background:${r.color};"></span>
            <span class="storage-row-name">${escapeHtml(r.name)}</span>
            <span class="storage-row-size">${escapeHtml(formatBytes(r.bytes))}</span>
          </div>`).join('')}
     </div>
     <div class="hub-block">
       <div class="hub-block-title">Freeing up space</div>
       <div class="hub-block-desc">Back up a finished project, check the file downloaded, then delete the project from Data › Projects. Deleting is undoable for a few seconds only, so confirm the backup first.</div>
       <button class="btn-pill btn-pill-outline" onclick="showBackupRestore()" style="margin-top:0;">Go to Backup &amp; Restore</button>
     </div>`;
}


// ══ TEMPLATE PROJECT ══
// Offered on the Welcome screen. A brand-new project is unusable until it has at least one
// feature type (Collect keeps Capture/Save disabled without one), so this ships three — one of
// each geometry — with a couple of representative fields apiece. Ids are generated per call so
// two template projects never share field ids.
function createTemplateProject(){
  const uid = pre => pre + '_' + Math.random().toString(36).slice(2,9);
  const field = (label, type, opts, placeholder) =>
    ({ id: uid('f'), label, type, options: opts || [], required: false, placeholder: placeholder || '' });

  const tplTypes = [
    { id: uid('ft'), name: 'Boundary Marker', geometryType: 'point', color: '#10B981', fields: [
        field('Marker condition', 'single_select', ['Good','Damaged','Missing']),
        field('Notes', 'textarea', [], 'Anything worth recording on site')
    ]},
    { id: uid('ft'), name: 'Access Road', geometryType: 'line', color: '#0EA5E9', fields: [
        field('Surface', 'single_select', ['Paved','Gravel','Earth']),
        field('Width (m)', 'number', [], 'e.g. 4.5')
    ]},
    { id: uid('ft'), name: 'Plot Boundary', geometryType: 'polygon', color: '#F59E0B', fields: [
        field('Plot reference', 'text', [], 'e.g. PLOT-01'),
        field('Surveyed', 'boolean')
    ]}
  ];

  const id = 'p_' + Date.now();
  const now = new Date().toISOString();
  projects.push({
    id, name: 'Sample Survey',
    description: 'Template project — rename it, edit the feature types, or delete it once you have your own.',
    client: '', manager: '', site: '', siteLat: null, siteLon: null,
    createdAt: now, updatedAt: now, lastExportedAt: null
  });
  projectData[id] = { savedFeatures: [], currentVertices: [], featureTypes: tplTypes, notes: '', notesUpdatedAt: null, sketches: [] };
  persistStore();
  showToast('Template project created');
  // replaceNav mirrors saveProjectForm(): turn the Welcome stop into the project's dashboard stop
  // rather than stacking one on top of a screen the user can no longer return to meaningfully.
  openProject(id, { replaceNav: true });
}

// Cancel/X on the New Project or Edit Project form, and the "return to the list" step after a
// successful save. Both always start from the projects list (that's the only place the form is
// ever opened from — see showNewProject()/editProject()), so 'projects' is already the very next
// stop down in history. Consuming that stop with history.back() — rather than calling
// showProjects(), which would push a *second* 'projects' stop on top of the form's own — is what
// keeps Back from bouncing through a stale, already-submitted form (this was the root cause of
// Back landing on the create-project form instead of the dashboard after Manage feature types).
function cancelProjectForm() {
  editingProjectId = null;
  renderProjectsScreen();
  history.back();
}

function showNewProject() {
  editingProjectId = null;
  document.getElementById('newProjectTitle').textContent = 'New project';
  document.getElementById('newProjSaveBtnLabel').textContent = 'Create project';
  activateView('view-newproject');
  document.getElementById('newProjName').value='';
  document.getElementById('newProjDesc').value='';
  document.getElementById('newProjClient').value='';
  document.getElementById('newProjManager').value='';
  document.getElementById('newProjSite').value='';
  newProjSiteLat = null; newProjSiteLon = null;
  const siteEl0 = document.getElementById('newProjSite');
  if (siteEl0){ delete siteEl0.dataset.lat; delete siteEl0.dataset.lon; }
  syncProjectFormCrs(null); // resets the picker to WGS84 rather than inheriting the last project's
  const hint=document.getElementById('locateHint'); if (hint){hint.textContent='';hint.classList.remove('err');}
  focusWhenSettled('newProjName');
  pushNavState('newproject');
}


// Reuses the same #view-newproject form/layout to edit an existing project's metadata
// (name/client/site/siteLat/siteLon) rather than creating a duplicate.
function editProject(id) {
  const p = projects.find(x=>x.id===id);
  if (!p) return;
  editingProjectId = id;
  document.getElementById('newProjectTitle').textContent = 'Edit project';
  document.getElementById('newProjSaveBtnLabel').textContent = 'Save changes';
  activateView('view-newproject');
  syncProjectFormCrs(id);
  document.getElementById('newProjName').value = p.name || '';
  document.getElementById('newProjDesc').value = p.description || '';
  document.getElementById('newProjClient').value = p.client || '';
  document.getElementById('newProjManager').value = p.manager || '';
  document.getElementById('newProjSite').value = p.site || '';
  newProjSiteLat = p.siteLat ?? null;
  const _se = document.getElementById('newProjSite');
  if (_se){
    if (p.siteLat != null){ _se.dataset.lat = p.siteLat; _se.dataset.lon = p.siteLon; }
    else { delete _se.dataset.lat; delete _se.dataset.lon; }
  }
  newProjSiteLon = p.siteLon ?? null;
  const hint=document.getElementById('locateHint'); if (hint){hint.textContent='';hint.classList.remove('err');}
  focusWhenSettled('newProjName');
  pushNavState('newproject', { editId: id });
}

// ── "Use current location" on the New Project site field ──
// Single-fix GPS (not a watch — this only tags the site, unlike the continuous GPS in Collect).
// Reverse-geocodes via OSM Nominatim (free, no API key, no backend needed) to fill in a
// human-readable place name. Nominatim's usage policy asks for a descriptive Referer/User-Agent —
// browsers can't set a custom User-Agent header from JS, but they do send Referer automatically,
// and this is single, on-demand, user-initiated lookups (not bulk/automated), which fits within
// their policy for light usage: https://operations.osmfoundation.org/policies/nominatim/
// Never blocks project creation: any failure (no GPS, offline, geocoder unreachable) just falls
// back to raw coordinates in the field, or a toast + manual entry if even GPS itself fails.
function useCurrentLocationForSite() {
  const btn = document.getElementById('locateBtn');
  const hint = document.getElementById('locateHint');
  const input = document.getElementById('newProjSite');
  if (!('geolocation' in navigator)) {
    showToast('Location isn\'t available on this device');
    return;
  }
  btn.classList.add('busy');
  btn.innerHTML = '<svg class="locate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="9" stroke-opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>';
  hint.classList.remove('err');
  hint.textContent = 'Locating…';

  const restoreBtn = () => {
    btn.classList.remove('busy');
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M20.94 11a8.994 8.994 0 0 0-7.94-7.94"/><path d="M3.06 13a8.994 8.994 0 0 0 7.94 7.94"/><path d="M11 3.06a8.994 8.994 0 0 0-7.94 7.94"/><path d="M13 20.94a8.994 8.994 0 0 0 7.94-7.94"/><circle cx="12" cy="12" r="3"/></svg>';
  };
  const useRawCoords = (lat, lon) => {
    newProjSiteLat = lat; newProjSiteLon = lon;
    const _siteEl = document.getElementById('newProjSite');
    if (_siteEl){ _siteEl.dataset.lat = lat; _siteEl.dataset.lon = lon; }
    input.value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  };

  navigator.geolocation.getCurrentPosition(
    async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      newProjSiteLat = lat; newProjSiteLon = lon;
    const _siteEl = document.getElementById('newProjSite');
    if (_siteEl){ _siteEl.dataset.lat = lat; _siteEl.dataset.lon = lon; }
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 8000);
        // ══ ZOOM 16, NOT 12 ══
        // zoom=12 is a city/district query: Nominatim does not return suburbs at that level at
        // all, it returns the nearest thing it ranks as a settlement. Standing in Hatfield — a
        // Harare suburb — that resolved outward to Chitungwiza, a separate town 20 km away with
        // its own OSM entry. The coordinates were always right; only the name was wrong, which is
        // the worst kind of wrong because nothing looks broken.
        // 16 is suburb/neighbourhood level, which is the granularity a site field actually wants.
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('geocoder unavailable');
        const data = await res.json();
        const a = data && data.address;
        // ══ SPECIFIC FIRST ══
        // The old chain was town || village || city || municipality || county || state — `suburb`
        // and `neighbourhood` were not in it at all, so even at a fine zoom a suburb name would
        // have been discarded in favour of a town. And `town` came before `city`, which is
        // backwards for anywhere inside a city: it is exactly how a neighbouring town wins over
        // the city you are standing in.
        const local = a && (a.suburb || a.neighbourhood || a.quarter || a.residential ||
                            a.hamlet || a.village || a.city_district);
        const wider = a && (a.city || a.town || a.municipality || a.county || a.state);
        // "Hatfield, Harare" rather than either alone. A bare suburb is ambiguous on a job sheet
        // and a bare city is useless — the pair is what somebody reading the project later needs.
        const place = (local && wider && local !== wider) ? `${local}, ${wider}` : (local || wider);

        // Sanity check against the fix. Nominatim returns the centre of whatever it matched, so a
        // result far from where we actually are means it reached outward for something larger —
        // the failure above, caught rather than trusted. 25 km comfortably contains any legitimate
        // suburb-to-city-centre distance while still catching a jump to the next town.
        const centreLat = data && parseFloat(data.lat), centreLon = data && parseFloat(data.lon);
        let farAway = false;
        if (Number.isFinite(centreLat) && Number.isFinite(centreLon)){
          const dLat = (centreLat - lat) * 111320;
          const dLon = (centreLon - lon) * 111320 * Math.cos(lat * Math.PI / 180);
          farAway = Math.sqrt(dLat * dLat + dLon * dLon) > 25000;
        }

        if (place && !farAway) {
          input.value = place;
          hint.textContent = `Located · ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        } else if (place) {
          // Named, but the name is for somewhere else. Coordinates are never wrong, so they win —
          // and the name is offered in the hint rather than silently dropped, because it is
          // sometimes still the right answer and the crew can retype it.
          useRawCoords(lat, lon);
          hint.textContent = `Located. Nearest named place (${place}) is far from here — used coordinates.`;
        } else {
          useRawCoords(lat, lon);
          hint.textContent = 'Located. No place name found nearby, used coordinates.';
        }
      } catch (err) {
        // Offline or geocoder unreachable — coordinates are still useful in the field
        useRawCoords(lat, lon);
        hint.textContent = 'Located. Offline, used raw coordinates.';
      } finally {
        restoreBtn();
      }
    },
    err => {
      restoreBtn();
      hint.classList.add('err');
      hint.textContent = 'Couldn\'t get location. Type the site manually.';
      showToast(err.code === 1 ? 'Location permission denied' : 'Couldn\'t get your location');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}


function renderProjectsList() {
  const el = document.getElementById('projectsList');
  const label = document.getElementById('projectsListLabel');
  // Every other route onto #view-projects (renderProjectsScreen, refreshProjectsScreen, boot)
  // only lands here when projects.length === 0, so this is normally a true cold launch and the
  // welcome copy above already says everything that needs saying — no need for an extra empty-
  // state box under it. renderLandingScreen() (the Home button) is the one path that forces this
  // screen open regardless of count; when it does that with existing projects, this is what
  // actually shows them instead of leaving the crew on a screen with nowhere to display the list.
  if (!el) return;
  if (!projects.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    if (label) label.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (label) label.style.display = '';
  el.innerHTML = projects.slice().reverse().map(p=>{
    const d = projectData[p.id] || {savedFeatures:[]};
    const nF = (d.savedFeatures||[]).length;
    const nInProgress = (d.currentVertices||[]).length;
    const metaBits = [p.client, p.manager, p.site].filter(Boolean).join(' · ');
    let meta = metaBits ? `${metaBits} · ${nF} feature${nF===1?'':'s'}` : `${nF} feature${nF===1?'':'s'}`;
    // Surfaces an unfinished line/polygon (or a point mid multi-angle capture) that's still sitting
    // in progress on the Collect tab — persist() writes currentVertices after every vertex, so this
    // survives an app switch, backgrounding, or reload even before the feature is finished/saved.
    const inProgressBadge = nInProgress ? `<span class="project-row-inprogress">● ${nInProgress} vertex${nInProgress===1?'':'es'} in progress</span>` : '';
    const exportBadge = !nF ? '' : p.lastExportedAt
      ? `<span class="project-row-export">✓ exported ${timeAgo(p.lastExportedAt)}</span>`
      : `<span class="project-row-export warn">not exported yet</span>`;
    return `<div class="project-row" onclick="openProject('${p.id}')">
      <div class="project-row-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
      <div class="project-row-body">
        <div class="project-row-name">${escapeHtml(p.name)}</div>
        <div class="project-row-meta">${escapeHtml(meta)}${inProgressBadge}${exportBadge}</div>
      </div>
      <button class="project-row-edit" title="Edit project" aria-label="Edit project" onclick="event.stopPropagation();editProject('${p.id}')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="project-row-del" onclick="event.stopPropagation();deleteProject('${p.id}')">×</button>
      <div class="project-row-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`;
  }).join('');
}

function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }


// ══════════════════ PROJECT MANAGER ══════════════════
// The working projects screen (#view-projectmgr). Everything below only ever reads the store and
// re-renders — it never mutates the "currently open project" globals, so it is safe to call from
// anywhere, including while a project is open.
let pmFilter = 'all';

let pmQuery = '';

let pmOpenMenuId = null;


// ── Per-project rollup ──
// Deliberately computed on demand rather than cached on the project record: the underlying data
// (features, photos, vertices) is edited from a dozen places in this file, and a cached count is
// a count that eventually goes stale. The lists here are short (a handful of projects), so the
// cost is irrelevant next to the correctness.
function getProjectStats(p, opts){
  const d = projectData[p.id] || {};
  const feats = d.savedFeatures || [];
  const inProgress = (d.currentVertices || []).length;
  // ══ BYTES ARE OPT-OUT BECAUSE THIS IS ON THE SAVE PATH ══
  // publishWidgetSummary() runs at the end of every persistStore() — so on every
  // photo capture — and loops over EVERY project calling this. It only ever
  // reads .synced and .features, but it was paying for a full JSON.stringify of
  // each project plus a Blob clone of the result, every time. On a project
  // holding base64 photos that is several complete copies of everything, per
  // photo. Callers that actually display a size opt in; the hot one does not.
  // The Blob is gone regardless: the store is JSON of base64 and ASCII, where
  // string length and byte count coincide, so it bought nothing.
  let bytes = 0;
  if (!(opts && opts.skipBytes)) {
    try { bytes = JSON.stringify(d).length; } catch(e) { bytes = 0; }
  }
  // Last modified: prefer the explicit stamp persist() writes, then fall back to the newest
  // feature save/edit. Projects created before updatedAt existed have no stamp at all, and the
  // feature scan is what keeps their card honest instead of showing the creation date forever.
  let modified = p.updatedAt || null;
  feats.forEach(f=>{
    const t = f.editedAt || f.savedAt;
    if (t && (!modified || new Date(t) > new Date(modified))) modified = t;
  });
  if (!modified) modified = p.createdAt || null;
  // "Synced" means exported/published *since the last change*. An export that predates newer
  // captures isn't a backup of what's actually on the device, so it deliberately doesn't count —
  // a stale green tick on a phone about to go into the field is worse than no tick at all.
  const exported = p.lastExportedAt || null;
  const synced = !!exported && (!modified || new Date(exported) >= new Date(modified));
  return { features: feats.length, inProgress, bytes, modified, exported, synced };
}

function formatBytes(b){
  if (!b) return '0 KB';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b/1024).toFixed(b/1024 < 10 ? 1 : 0) + ' KB';
  return (b/(1024*1024)).toFixed(1) + ' MB';
}

// The card's description line. Falls back to the client · manager · site trio so projects created
// before the Description field existed still read as something other than a bare name.
function projectDescription(p){
  if (p.description) return p.description;
  return [p.client, p.manager, p.site].filter(Boolean).join(' · ');
}


// ── Search + filters ──
function onPmSearchInput(){
  const input = document.getElementById('pmSearch');
  pmQuery = input.value.trim().toLowerCase();
  document.getElementById('pmSearchClear').classList.toggle('show', !!input.value);
  renderPmList();
}

function clearPmSearch(){
  const input = document.getElementById('pmSearch');
  input.value = ''; pmQuery = '';
  document.getElementById('pmSearchClear').classList.remove('show');
  renderPmList();
  input.focus();
}

function setPmFilter(f){
  pmFilter = f;
  document.querySelectorAll('#pmFilters .pm-chip').forEach(c=>c.classList.toggle('active', c.dataset.filter === f));
  renderPmList();
}

function pmFilteredProjects(){
  const RECENT_MS = 7 * 24 * 3600 * 1000;
  // .reverse() on a copy: projects are stored oldest-first (push on create), and newest-first is
  // the useful order on a management screen.
  return projects.slice().reverse().filter(p=>{
    if (pmQuery){
      const hay = [p.name, p.description, p.client, p.manager, p.site].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(pmQuery)) return false;
    }
    if (pmFilter === 'all') return true;
    const s = getProjectStats(p);
    if (pmFilter === 'recent')   return !!s.modified && (Date.now() - new Date(s.modified).getTime()) < RECENT_MS;
    if (pmFilter === 'synced')   return s.synced;
    if (pmFilter === 'unsynced') return s.features > 0 && !s.synced;
    return true;
  });
}


// ── Render ──
function renderProjectManager(){
  const c = document.getElementById('pmCount');
  if (c) c.textContent = projects.length + (projects.length === 1 ? ' project' : ' projects');
  // No tab of #view-app is showing, so light up Projects instead of leaving whichever tab the
  // user last visited looking current.
  // Projects lives under the Data tab now, so the Data button is the one that lights up here.
  document.querySelectorAll('.nav-btn[id^="navBtn-"]').forEach(b=>b.classList.toggle('active', b.id === 'navBtn-data'));
  renderPmList();
}

const PM_ICON_FOLDER = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

// Sets which project is active without navigating away — the explicit "Set Active" quick action
// on an inactive project's row. (Opening a project via the card body itself still makes it active
// too, as a side effect of openProject(), but this lets you switch the active project from the
// list without leaving it.)
function setProjectActive(id){
  if (!projects.find(x=>x.id === id)) return;
  if (id === activeProjectRef) return;
  setActiveProjectRef(id);
  showToast('Set as active project');
  renderPmList();
}

function renderPmList(){
  const wrap = document.getElementById('pmListWrap');
  if (!wrap) return;
  closePmMenu(); // the menu lives inside a card that's about to be replaced
  const list = pmFilteredProjects();
  const LABELS = { all:'All projects', recent:'Recently modified', synced:'Synced', unsynced:'Not synced' };
  if (!list.length){
    wrap.innerHTML = '<div class="pm-section-label">' + LABELS[pmFilter] + '</div>' +
      '<div class="pm-empty"><strong>' + (pmQuery ? 'No matches' : 'Nothing in this filter') + '</strong>' +
      (pmQuery ? 'No project matches that search.' : 'Try another filter, or create a new project.') + '</div>';
    return;
  }
  // Pin the active project to the top of whichever filter it's showing under — same row shape as
  // everything else, just first, so "which project am I in" stays answerable at a glance without
  // a second card above the list.
  list.sort((a,b) => (b.id === activeProjectRef ? 1 : 0) - (a.id === activeProjectRef ? 1 : 0));
  wrap.innerHTML = '<div class="pm-section-label">' + LABELS[pmFilter] + ' · ' + list.length + '</div>' +
    list.map(pmCardHtml).join('');
}

function pmCardHtml(p){
  const s = getProjectStats(p);
  const desc = projectDescription(p);
  const isActive = p.id === activeProjectRef;
  const statusBadge = !s.features ? ''
    : s.synced ? '<span class="pm-badge synced">✓ Synced</span>'
               : '<span class="pm-badge unsynced">Not synced</span>';
  const progressBadge = s.inProgress
    ? '<span class="pm-badge progress">● ' + s.inProgress + ' in progress</span>' : '';
  const item = (fn, icon, label, cls) =>
    '<button class="pm-menu-item' + (cls ? ' ' + cls : '') + '" onclick="event.stopPropagation();' + fn + '(\'' + p.id + '\')">' + icon + label + '</button>';
  // Primary action differs by state (Open Map vs Set Active); Settings and Export are the same
  // for every row. Three buttons max, all one tap — nothing here hides behind the overflow menu.
  const primaryBtn = isActive
    ? '<button class="pm-act-btn primary" onclick="event.stopPropagation();openProjectFromManager(\'' + p.id + '\',\'review\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>' +
        'Open Map</button>'
    : '<button class="pm-act-btn primary" onclick="event.stopPropagation();setProjectActive(\'' + p.id + '\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        'Set Active</button>';
  return '<div class="pm-card' + (isActive ? ' active' : '') + '" role="button" tabindex="0" onclick="openProjectFromManager(\'' + p.id + '\')">' +
    '<div class="pm-card-top">' +
      '<div class="pm-card-icon">' + PM_ICON_FOLDER + '</div>' +
      '<div class="pm-card-head">' +
        '<div class="pm-card-name">' + escapeHtml(p.name) +
          (isActive ? '<span class="pm-active-pill"><span class="pm-dot"></span>Active</span>' : '') +
        '</div>' +
        (desc ? '<div class="pm-card-desc">' + escapeHtml(desc) + '</div>' : '') +
      '</div>' +
      '<button class="pm-menu-btn" aria-label="More actions for ' + escapeHtml(p.name) + '" aria-haspopup="true" onclick="event.stopPropagation();openPmMenu(\'' + p.id + '\')">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="pm-card-meta">' +
      '<span class="pm-meta-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/></svg><strong>' + s.features + '</strong> features</span>' +
      '<span class="pm-meta-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><strong>' + formatBytes(s.bytes) + '</strong></span>' +
      '<span class="pm-meta-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>' + (s.modified ? escapeHtml(timeAgo(s.modified)) : 'never') + '</span>' +
      statusBadge + progressBadge +
    '</div>' +
    '<div class="pm-card-actions">' +
      primaryBtn +
      '<button class="pm-act-btn" onclick="event.stopPropagation();editProject(\'' + p.id + '\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
        'Settings</button>' +
      '<button class="pm-act-btn" onclick="event.stopPropagation();pmExport(\'' + p.id + '\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        'Export</button>' +
    '</div>' +
    '<div class="pm-menu" id="pmMenu-' + p.id + '" onclick="event.stopPropagation()" role="menu">' +
      item('pmRename',    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', 'Rename') +
      item('pmDuplicate', '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', 'Duplicate') +
      item('pmBackup',    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', 'Backup (.json)') +
      '<div class="pm-menu-sep"></div>' +
      item('pmDelete',    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>', 'Delete', 'danger') +
    '</div>' +
  '</div>';
}


// ── Quick action menu ──
// Each menu is rendered inside its own card and positioned against it, so it travels with the
// card on scroll with no measuring or repositioning code. Only one is open at a time.
function openPmMenu(id){
  const wasOpen = pmOpenMenuId === id;
  closePmMenu();
  if (wasOpen) return; // second tap on the same button closes it
  const m = document.getElementById('pmMenu-' + id);
  if (!m) return;
  m.classList.add('open');
  // Lift the owning card above its siblings for as long as the menu is open — see the
  // .pm-card/.menu-open stacking note in the CSS. Without this the menu paints under the next
  // card and its items stop receiving taps.
  const card = m.closest('.pm-card');
  if (card) card.classList.add('menu-open');
  pmOpenMenuId = id;
}

function closePmMenu(){
  if (!pmOpenMenuId) return;
  const m = document.getElementById('pmMenu-' + pmOpenMenuId);
  if (m) m.classList.remove('open');
  // Clear by query rather than from `m` alone: a re-render between open and close can swap the
  // card element out from under us, and a stale .menu-open would leave that card permanently
  // stacked above the rest.
  document.querySelectorAll('.pm-card.menu-open').forEach(c => c.classList.remove('menu-open'));
  pmOpenMenuId = null;
}

// Bubble phase, not capture: the menu itself and its trigger both stopPropagation, so anything
// that reaches document is genuinely "outside". Card taps do reach here, but openProjectFromManager
// runs first and bails while a menu is open, so a tap outside an open menu only dismisses it
// rather than also opening a project.
document.addEventListener('click', ()=>{ closePmMenu(); });


function pmExport(id){ closePmMenu(); exportProjectZip(id); }

function pmBackup(id){ closePmMenu(); exportProjectBackupById(id); }

function pmRename(id){ closePmMenu(); openRenameModal(id); }

function pmDuplicate(id){ closePmMenu(); duplicateProject(id); }

function pmDelete(id){ closePmMenu(); deleteProject(id); }


// ── Context switching ──
// Tapping a card makes that project the active context and drops straight into it, which is the
// whole point of the screen — no intermediate "open?" step.
function openProjectFromManager(id, tab){
  if (pmOpenMenuId){ closePmMenu(); return; }
  if (!projects.find(x=>x.id === id)){
    showToast('That project no longer exists');
    renderProjectsScreen();
    return;
  }
  openProject(id);
  if (tab && tab !== 'dashboard'){
    switchTab(tab);
    // openProject() already pushed an 'app' stop for the dashboard; correct it in place rather
    // than stacking a second stop the user would have to press Back through twice.
    history.replaceState({ screen:'app', projectId:id, tab }, '');
  }
}


// Keeps whichever projects screen is currently showing in sync after a create/delete/rename, and
// flips between Welcome and the Manager when the project count crosses zero.
function refreshProjectsScreen(){
  const mgr = document.getElementById('view-projectmgr');
  const welcome = document.getElementById('view-projects');
  const hub = document.getElementById('view-datahub');
  const onMgr = mgr && mgr.classList.contains('active');
  const onWelcome = welcome && welcome.classList.contains('active');
  const onHub = hub && hub.classList.contains('active');
  if (!onMgr && !onWelcome && !onHub) return;
  // The hub is counts-only, so a create/delete/undo has to redraw it or the tiles and the
  // "not exported yet" badge keep quoting the pre-change numbers. Deleting the last project
  // drops back to Welcome, exactly as it does from the Project Manager.
  if (onHub) {
    if (!projects.length){ activateView('view-projects'); renderProjectsList(); return; }
    renderDataHub(); return;
  }
  if (onMgr && !projects.length){ activateView('view-projects'); renderProjectsList(); return; }
  if (onWelcome && projects.length){ activateView('view-projectmgr'); renderProjectManager(); return; }
  onMgr ? renderProjectManager() : renderProjectsList();
}


// ── Rename ──
// A dedicated single-field modal rather than reusing the full Edit Project form: renaming is the
// one metadata change frequent enough to be worth doing without leaving the list.
let _renameId = null;

// ══ MORE QUICK ACTIONS DRAWER ══ — the overflow half of the Dashboard's Quick actions block.
// Same open/close shape as every other bottom sheet here (toggle .show on the .modal-overlay), so
// it picks up the shared slide-up transition and gets closed by the hardware back button via
// closeTopOverlay().
function openMoreActions(){
  document.getElementById('moreActionsModal').classList.add('show');
}

function closeMoreActions(){
  document.getElementById('moreActionsModal').classList.remove('show');
}

// Every tile in the drawer routes through here rather than calling its action directly. All four
// actions either navigate away (New Project), open another sheet (Quick Notes), or kick off work
// that shows its own UI (Connect GPS, Backup All) — so the drawer has to be dismissed first or it
// sits stacked on top of, or underneath, whatever the action opens. Closing first also means the
// dashboard is what you come back to, which is where you started.
function runFromMoreActions(fn){
  closeMoreActions();
  // One frame of daylight so the sheet's slide-out actually renders before the next screen or
  // sheet takes over; without it the two transitions collide and the close reads as a flicker.
  requestAnimationFrame(()=>{ try { fn(); } catch(e){ console.error('Quick action failed:', e); } });
}


// ══ QUICK NOTES ══ — one freeform scratchpad per project, autosaved as you type (debounced so
// persist()/localStorage isn't hit on every keystroke). Lives in projectNotes/projectNotesUpdatedAt
// (loaded in openProject(), written back by persist()) rather than as its own screen — a sticky
// note doesn't need navigation chrome, just a place to type and a Done button.
let _quickNotesSaveTimer = null;

function openQuickNotesModal(){
  const ta = document.getElementById('quickNotesTextarea');
  if (ta) ta.value = projectNotes || '';
  renderQuickNotesSavedLabel();
  document.getElementById('quickNotesModal').classList.add('show');
  if (ta) focusWhenSettled(ta);
}

function closeQuickNotesModal(){
  document.getElementById('quickNotesModal').classList.remove('show');
}

function onQuickNotesInput(){
  const ta = document.getElementById('quickNotesTextarea');
  projectNotes = ta ? ta.value : '';
  clearTimeout(_quickNotesSaveTimer);
  _quickNotesSaveTimer = setTimeout(()=>{
    projectNotesUpdatedAt = new Date().toISOString();
    persist();
    renderQuickNotesSavedLabel();
  }, 500);
}

function renderQuickNotesSavedLabel(){
  const el = document.getElementById('quickNotesSavedLabel');
  if (!el) return;
  el.textContent = projectNotesUpdatedAt ? `Saved · ${timeAgo(projectNotesUpdatedAt)}` : '';
}

function openRenameModal(id){
  const p = projects.find(x=>x.id === id);
  if (!p) return;
  _renameId = id;
  const input = document.getElementById('renameInput');
  input.value = p.name || '';
  document.getElementById('renameModal').classList.add('show');
  focusWhenSettled(input, { select:true });
}

function closeRenameModal(save){
  const modal = document.getElementById('renameModal');
  if (save){
    const name = document.getElementById('renameInput').value.trim();
    if (!name){ showToast('Enter a project name'); return; } // keep the modal open
    const p = projects.find(x=>x.id === _renameId);
    if (p){
      p.name = name;
      p.updatedAt = new Date().toISOString();
      persistStore();
      // If it happens to be the project that's currently open, the in-app header is showing the
      // old name — update it in place rather than waiting for the next openProject().
      if (activeProjectId === p.id){
        const h = document.getElementById('activeProjName');
        if (h) h.textContent = p.name;
      }
      showToast('Project renamed');
    }
  }
  modal.classList.remove('show');
  _renameId = null;
  refreshProjectsScreen();
}


// ── Duplicate ──
function nextCopyName(base){
  const taken = new Set(projects.map(p=>p.name));
  let name = base + ' (copy)';
  let n = 2;
  while (taken.has(name)) name = base + ' (copy ' + (n++) + ')';
  return name;
}

function duplicateProject(id){
  const p = projects.find(x=>x.id === id);
  if (!p) return;
  const src = projectData[id] || { savedFeatures:[], currentVertices:[], featureTypes:[] };
  // Deep clone so editing the copy can never reach back into the original's features or photos.
  // The store is plain JSON already, so the round-trip fallback loses nothing structuredClone keeps.
  let clone;
  try { clone = structuredClone(src); }
  catch(e) { clone = JSON.parse(JSON.stringify(src)); }
  const newId = 'p_' + Date.now();
  const now = new Date().toISOString();
  const name = nextCopyName(p.name || 'Project');
  // A duplicate is a fresh capture context: it has never been exported, so it must not inherit
  // the original's export stamp and show a green "Synced" tick it hasn't earned.
  projects.push({ ...p, id:newId, name, createdAt:now, updatedAt:now, lastExportedAt:null });
  projectData[newId] = clone;
  persistStore();
  refreshProjectsScreen();
  showToast('Duplicated as "' + name + '"');
}


// ── Per-project zip export ──
// Same output shape as one project's folder inside exportAllProjects(), minus the wrapper folder.
// Uses that function's approach of temporarily pointing the shared export globals at this
// project's stored data, because collectFeatureCollectionsByType()/buildCSVString()/
// resolveFeatureType() all read the "currently open project" globals rather than taking an id.
// The restore sits in a finally block: if any of those helpers throws on malformed data, leaving
// the globals pointing at another project would silently corrupt the open session.
async function exportProjectZip(id){
  const p = projects.find(x=>x.id === id);
  if (!p) return;
  if (typeof JSZip === 'undefined'){
    showToast('Zip export needs a connection to load once. Try again online, or export from inside the project.');
    return;
  }
  const d = projectData[id] || { savedFeatures:[], featureTypes:[] };
  if (!(d.savedFeatures || []).length){ showToast('No captured features in this project yet'); return; }

  showToast('Zipping "' + p.name + '"…');
  // The zip embeds the JPEGs themselves, and photo bytes live in the media
  // store (IndexedDB) rather than in the project record — read them back first.
  const _photos = await hydrateExportPhotos(d);
  const saved = { featureTypes, savedFeatures, currentVertices, activeProjectId };
  const zip = new JSZip();
  const folderName = sanitizeFileSegment(p.name || 'Project');
  try {
    featureTypes  = d.featureTypes || [];
    savedFeatures = (d.savedFeatures || []).map(migrateFeatureToVertices);
    collectFeatureCollectionsByType().forEach(({label, fc})=>{
      zip.file(label.replace(/\s+/g,'_') + '.geojson', JSON.stringify(fc, null, 2));
    });
    zip.file(folderName + '_all_features.csv', buildCSVString());
    const photos = zip.folder('photos');
    savedFeatures.forEach(f=>{
      const info = resolveFeatureType(f);
      const base = (f.featureTypeId ? info.label : f.layer) || 'feature';
      (f.vertices || []).forEach((v, vi)=>{
        (v.photos || []).forEach((ph, pi)=>{
          // Skip rather than throw if a photo's bytes could not be read back:
          // one unreadable image must not take the whole zip down.
          if (!ph.dataUrl) return;
          const comma = ph.dataUrl.indexOf(',');
          const b64 = comma >= 0 ? ph.dataUrl.slice(comma + 1) : ph.dataUrl;
          const nm = base.replace(/\s+/g,'_') + '_' + String(f.name).replace(/\s+/g,'_') +
                     '_v' + (vi+1) + '_photo' + (pi+1) +
                     (ph.angleLabel ? '_' + ph.angleLabel.replace(/\s+/g,'_') : '') + '.jpg';
          photos.file(nm, b64, { base64:true });
        });
      });
    });
  } catch(err){
    showToast('Export failed. Try exporting from inside the project.');
    return;
  } finally {
    featureTypes    = saved.featureTypes;
    savedFeatures   = saved.savedFeatures;
    currentVertices = saved.currentVertices;
    activeProjectId = saved.activeProjectId;
    releaseExportPhotos(_photos);
  }

  zip.generateAsync({ type:'blob' }).then(async blob=>{
    // saveExportFile() lives in js/17-export.js, which loads after this file — that is fine, it is
    // only reached when the user taps Export, long after every script has run.
    const name = folderName + '_' + ts() + '.zip';
    const res = await saveExportFile(blob, name, 'application/zip');
    if (!res.ok){ showToast('Could not write "' + name + '" to this device. Check storage permission and free space.'); return; }
    p.lastExportedAt = new Date().toISOString();
    persistStore();
    refreshProjectsScreen();
    if (activeProjectId === p.id) refreshExportMeta();
    showToast('✓ "' + p.name + '" saved to ' + res.where);
  }).catch(()=>{ showToast('Could not build the zip. Try again.'); });
}

// ══ LAST-EXPORTED TRACKING ══
// Helps answer "have I already backed this project up today" at a glance during a multi-day job,
// without needing to remember or re-check every format was downloaded.
function timeAgo(iso){
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff/60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}

function markProjectExported(){
  if (!activeProjectId) return;
  const p = projects.find(x=>x.id===activeProjectId);
  if (!p) return;
  p.lastExportedAt = new Date().toISOString();
  persistStore();
  refreshExportMeta();
}

function refreshExportMeta(){
  const el = document.getElementById('lastExportNote');
  if (el){
    const p = projects.find(x=>x.id===activeProjectId);
    el.innerHTML = !p ? '' : (p.lastExportedAt
      ? `<strong>Last exported:</strong> ${timeAgo(p.lastExportedAt)}`
      : `<strong>Last exported:</strong> never. Export before ending this session`);
  }
  if (typeof updateWebmapCardUI === 'function') updateWebmapCardUI();
}


// Puts the project's stored grid onto the picker button. Called when the form opens, for both
// create (where it resets to the default) and edit.
function syncProjectFormCrs(projectId){
  const btn = document.getElementById('newProjCrsBtn');
  if (!btn || typeof PLOTGRID_REGISTRY === 'undefined') return;
  const p = projects.find(x => x.id === projectId);
  const key = (p && PLOTGRID_REGISTRY[p.crs]) ? p.crs : 'wgs84';
  btn.dataset.crs = key;
  btn.dataset.bounds = (p && p.bounds) ? JSON.stringify(p.bounds) : '';
  if (typeof syncProjectBoundsUI === 'function') syncProjectBoundsUI();
  document.getElementById('newProjCrsLabel').textContent = PLOTGRID_REGISTRY[key].label;
  const note = document.getElementById('newProjCrsNote');
  if (note){
    note.textContent = crsNeedsDatumShift(key)
      ? '⚠ Grid parameters are exact but the ' + PLOTGRID_REGISTRY[key].datum.toUpperCase() + ' datum shift is not applied.'
      : (PLOTGRID_REGISTRY[key].note || '');
    note.style.color = crsNeedsDatumShift(key) ? 'var(--danger)' : '';
  }
}

function saveProjectForm() {
  const name = document.getElementById('newProjName').value.trim();
  if (!name) { showToast('Enter a project name'); return; }
  const description = document.getElementById('newProjDesc').value.trim();
  const client = document.getElementById('newProjClient').value.trim();
  const manager = document.getElementById('newProjManager').value.trim();
  const site = document.getElementById('newProjSite').value.trim();
  // Chosen in the picker sheet and parked on the button until now, because the project did not
  // exist yet to hold it. Defaults to WGS84 for anyone who never opened the picker.
  const crs = document.getElementById('newProjCrsBtn')?.dataset.crs || 'wgs84';
  // Parked on the same element as the CRS for the same reason: on a new project there is nothing
  // to persist to until this function runs.
  let bounds = null;
  try { const raw = document.getElementById('newProjCrsBtn')?.dataset.bounds; if (raw) bounds = JSON.parse(raw); } catch(e) {}

  if (editingProjectId) {
    const p = projects.find(x=>x.id===editingProjectId);
    if (!p) { cancelProjectForm(); return; }
    // Only the project's own metadata changes here — projectData[id] (features/points/photos)
    // is untouched.
    p.name = name; p.description = description; p.client = client; p.manager = manager; p.site = site;
    p.siteLat = newProjSiteLat; p.siteLon = newProjSiteLon;
    // Changing the grid is non-destructive by design: capture is stored as WGS84 lat/lon, so this
    // only changes what the numbers are reported IN. Nothing needs reprojecting and nothing is
    // lost if it is changed back.
    p.crs = crs;
    p.bounds = bounds;
    p.updatedAt = new Date().toISOString();
    persistStore();
    if (activeProjectId === p.id) {
      document.getElementById('activeProjName').textContent = p.name;
      const metaBits = [p.client, p.manager, p.site].filter(Boolean).join(' · ');
      document.getElementById('activeProjMeta').textContent = metaBits;
      document.getElementById('dashProjectStrip').innerHTML = metaBits
        ? `<strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(metaBits)}`
        : `<strong>${escapeHtml(p.name)}</strong>`;
    }
    showToast('Project updated');
    cancelProjectForm(); // consumes this form's own history stop rather than stacking a new one
    return;
  }

  const id = 'p_' + Date.now();
  const nowIso = new Date().toISOString();
  projects.push({ id, name, description, client, manager, site, siteLat:newProjSiteLat, siteLon:newProjSiteLon, crs, bounds, createdAt:nowIso, updatedAt:nowIso });
  projectData[id] = { savedFeatures:[], currentVertices:[], featureTypes:[], notes:'', notesUpdatedAt:null };
  persistStore();
  // replaceNav: true — this form's own history stop gets turned directly into the new project's
  // dashboard stop, instead of the dashboard being pushed on top of (and leaving behind) the
  // now-submitted, empty form. Without this, Back from anywhere inside the new project would
  // eventually surface that stale create-project form.
  openProject(id, { replaceNav: true });
}

function deleteProject(id) {
  const p = projects.find(x=>x.id===id);
  if (!p) return;
  // Deleting a whole project can wipe a lot of field work at once (many features/vertices/
  // photos), so this keeps the confirm step, but *also* gives a brief Undo window afterward
  // in case the confirm was tapped by reflex.
  showConfirm(`Delete project "${p.name}" and all its captured data?`, () => {
    const idx = projects.findIndex(x=>x.id===id);
    const [removedProj] = projects.splice(idx,1);
    const removedData = projectData[id];
    delete projectData[id];
    // If the deleted project was the active context, drop the reference so the Project Manager
    // doesn't keep showing a "Currently Active" card for something that no longer exists.
    const wasActiveRef = activeProjectRef === id;
    if (wasActiveRef) setActiveProjectRef(null);
    // The user confirmed this removal, so it is allowed past the write guard
    // that otherwise refuses any save which reduces what is on disk.
    persistStore({ destructive: true });
    refreshProjectsScreen();
    showUndoToast(`Project "${removedProj.name}" deleted`, () => {
      projects.splice(idx,0,removedProj);
      projectData[id] = removedData;
      if (wasActiveRef) setActiveProjectRef(id);
      persistStore();
      refreshProjectsScreen();
      showToast('Project restored');
    }, 8000);
  });
}

function openProject(id, opts) {
  const p = projects.find(x=>x.id===id);
  if (!p) return;
  activeProjectId = id;
  setActiveProjectRef(id); // survives stepping back out to the projects list — see ACTIVE_PROJECT_KEY
  const d = projectData[id] || { savedFeatures:[], currentVertices:[], featureTypes:[] };
  savedFeatures = (d.savedFeatures || []).map(migrateFeatureToVertices);
  currentVertices = migrateCurrentVertices(d);
  openVertexIndex = null;
  featureTypes = d.featureTypes || [];
  projectNotes = d.notes || '';
  projectNotesUpdatedAt = d.notesUpdatedAt || null;
  // PlotEtch state is per-project like everything else here: an unfinished sketch or a selection
  // belongs to the project it was drawn in and must never bleed into the next one opened.
  plotetchSketches = d.sketches || [];
  peDraft = null; peSelectedId = null;
  // Paused captures are per-project for exactly the same reason as the sketches
  // above — a road half-collected on one site must never appear on the Collect
  // tab of another. loadCaptureStack() also drops anything malformed, so an old
  // or hand-edited store cannot put a broken row in the resume bar.
  loadCaptureStack(d.suspended);
  hiddenLayerKeys.clear();
  // A feature edit in progress belongs to whatever project was open before — never carry it
  // into a different project.
  editingFeatureId = null; editingFeatureSnapshot = null;
  document.getElementById('editModeBanner').style.display = 'none';
  document.getElementById('cancelEditBtn').style.display = 'none';

  document.getElementById('activeProjName').textContent = p.name;
  const metaBits = [p.client, p.manager, p.site].filter(Boolean).join(' · ');
  document.getElementById('activeProjMeta').textContent = metaBits;
  document.getElementById('dashProjectStrip').innerHTML = metaBits
    ? `<strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(metaBits)}`
    : `<strong>${escapeHtml(p.name)}</strong>`;

  activateView('view-app');

  populateFeatureTypeSelect();
  renderQuickActions();
  renderPoints(); renderVertexEditor(); renderFeatures(); updateStats();
  renderCaptureStack();
  // ══ CRASH RECOVERY ══
  // The vertices came back with the project store above; this is the rest of the
  // form (name, reference, attributes) that used to die with the WebView. Offered
  // rather than applied, so a crew that would rather start clean can.
  maybeOfferDraftRecovery(id);
  persist();
  const wasSuppressing = suppressNavPush;
  suppressNavPush = true; // avoid a duplicate history entry — we set the combined 'app' state once, below
  switchTab('dashboard');
  suppressNavPush = wasSuppressing;
  if (opts && opts.replaceNav) {
    // Collapse whatever history stop got us here (the new-project form) into this one, rather
    // than pushing 'app' on top of it and leaving it behind as a stale back-button stop.
    history.replaceState({ screen: 'app', projectId: id, tab: 'dashboard' }, '');
  } else {
    pushNavState('app', { projectId: id, tab: 'dashboard' });
  }
}
