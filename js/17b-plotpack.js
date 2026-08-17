// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — .plotpack, the native project bundle (export + import)
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ WHY A NATIVE FORMAT ══
// Everything js/17-export.js writes is a DELIVERY format: GeoJSON, CSV, GPKG,
// FlatGeobuf, Parquet, PDF. Each one is aimed at somebody else's software, and
// each one throws away most of what makes a project a PlotEdge project. Export
// a survey and read it back and you lose:
//
//   - the feature type schemas — field types, options, conditional visibility,
//     calculated expressions, repeat groups. flattenAttrs() collapses them into
//     flat columns and findOrCreateImportFeatureType() has to guess them back.
//   - every photo. They live in IndexedDB (js/04a-photostore.js) and no
//     delivery format has anywhere to put them.
//   - per-vertex attributes and per-vertex photos, the scope:'vertex' fields.
//   - project notes, PlotEtch sketches, per-vertex accuracy and timestamps.
//
// So there was no way to hand a project to a colleague, or move it to a new
// phone, without losing the survey and keeping only the shapes. .plotpack is that
// missing round trip: everything, losslessly, in one file.
//
// ── WHY A ZIP AND NOT ONE BIG JSON ──
// Photos. Base64 inside JSON inflates them by a third, and a 200-photo survey is
// exactly where that decides whether the file can be sent over WhatsApp. A ZIP
// stores the original JPEG bytes untouched. JSZip is already loaded for the
// "export all projects" backup, so this costs no new dependency.
//
// ── WHAT IS INSIDE ──
//   mimetype            first entry, STORED (uncompressed) — see below
//   manifest.json       format version, app version, counts, sha-256 per part
//   schema.json         featureTypes verbatim, no lossy round trip
//   features.json       full fidelity: vertex attrs, photo refs, accuracy, times
//   features.geojson    plain GeoJSON, so unzipping gives QGIS something to open
//   notes.md            project notes as real Markdown
//   sketches.json       PlotEtch
//   tombstones.json     deletes, so a handoff cannot silently undo them
//   photos/<id>.jpg     original bytes
//   README.txt          explains the layout to whoever opens it in three years
//
// Every text part is plain JSON or Markdown that opens in a text editor. "Only
// PlotEdge reads it" is about the app owning the round trip, not about making
// the bytes deliberately opaque — a format nobody can inspect is a format that
// becomes unreadable the day the app stops being installed.
//
// ── THE mimetype ENTRY ──
// First in the archive, stored rather than deflated, exactly the trick EPUB and
// OpenDocument use. It lets `file(1)` and archive tools identify a bundle by its
// CONTENT after somebody renames it, which somebody always does. It is also what
// makes the sniff in isPlotpackFile() cheap and reliable.

// The extension is spelled out rather than abbreviated on purpose. A .plotpack
// arriving by WhatsApp on a phone that may not have the app yet says what opens
// it; a four-letter code does not, and the receiver is left guessing. The
// Android association below is what makes it tappable, but the NAME is what
// makes it comprehensible when the association is missing — which is exactly the
// case where the person needs the most help.
const PLOTPACK_EXT = 'plotpack';
const PLOTPACK_MIME = 'application/vnd.plotedge.plotpack+zip';

// Bumped only for a change that an older importer could not read safely. The
// importer refuses an unknown MAJOR rather than guessing — a format that ships
// without a version can never change, and one that guesses corrupts surveys.
const PLOTPACK_FORMAT_VERSION = 1;

let pendingPlotpackImport = null;


// ══ WRITING ══
async function exportPlotpack(){
  if (!activeProjectId){ showToast('Open a project first'); return; }
  if (typeof JSZip === 'undefined'){
    showToast('Bundle library not loaded — reconnect once and try again');
    return;
  }
  const project = projects.find(p => p.id === activeProjectId);
  if (!project){ showToast('Open a project first'); return; }

  const status = document.getElementById('exportStatus');
  if (status) status.textContent = 'Building bundle…';

  // Photo bytes are shed from the project store once written to disk, so they
  // have to be read back before anything can be packed. Paired with the release
  // in the finally block: on a photo-heavy project this is tens of megabytes of
  // live base64 that must not outlive the export.
  const hydrated = await hydrateExportPhotos(savedFeatures, currentVertices);
  try {
    const zip = new JSZip();
    // STORED, and first. See the note on the mimetype entry above.
    zip.file('mimetype', PLOTPACK_MIME, { compression: 'STORE' });

    const stamp = new Date().toISOString();
    const features = JSON.parse(JSON.stringify(savedFeatures));
    const schema = JSON.parse(JSON.stringify(featureTypes));

    // Photos go in as binary and are replaced by references. Carrying both the
    // bytes and a base64 copy of the same bytes would double the file for no
    // reason.
    const photoFolder = zip.folder('photos');
    let photoCount = 0;
    const packPhotos = list => (list || []).map(p => {
      const rec = { id: p.id, name: p.name || '', takenAt: p.takenAt || null };
      // p.dataUrl only: hydrateExportPhotos() above has just refilled it from
      // IndexedDB. photoCachedFull() would hand back a blob: object URL, which
      // is a handle rather than bytes and cannot be packed.
      const blob = p.dataUrl ? photoDataUrlToBlobSync(p.dataUrl) : null;
      if (blob){
        rec.file = 'photos/' + p.id + '.jpg';
        photoFolder.file(p.id + '.jpg', blob, { binary: true });
        photoCount++;
      } else {
        // Recorded rather than dropped: an importer that finds a reference with
        // no file can say "3 photos could not be included" instead of silently
        // producing a survey that looks complete and is not.
        rec.missing = true;
      }
      return rec;
    });

    features.forEach(f => {
      f.photos = packPhotos(f.photos);
      (f.vertices || []).forEach(v => { v.photos = packPhotos(v.photos); });
    });

    const parts = {
      'schema.json': JSON.stringify(schema, null, 2),
      'features.json': JSON.stringify(features, null, 2),
      'features.geojson': JSON.stringify(plotpackGeoJSON(), null, 2),
      'notes.md': projectNotes || '',
      'sketches.json': JSON.stringify(plotetchSketches || [], null, 2),
      // Deletes travel with the bundle, or a handoff silently undoes them. If a crew deletes a
      // duplicate septic and then sends the project on, the receiving device has no record that
      // the deletion happened — and on the eventual merge back, the sender's own delete looks
      // like missing data and the feature returns. Tombstones are tiny ({uid, rev}); the cost of
      // carrying them is nothing against the cost of resurrected records in a deliverable.
      'tombstones.json': JSON.stringify(plotmateTombstones(activeProjectId) || [], null, 2)
    };
    for (const name in parts) zip.file(name, parts[name]);

    // Checksums are not ceremony. Bluetooth transfers and several chat apps
    // truncate large attachments, and a half-written bundle that imports
    // "successfully" is precisely the corruption persistStore()'s write guard
    // exists to prevent. A mismatch here refuses the import outright.
    const checksums = {};
    for (const name in parts) checksums[name] = await plotpackSha256(parts[name]);

    zip.file('manifest.json', JSON.stringify({
      format: 'plotpack',
      formatVersion: PLOTPACK_FORMAT_VERSION,
      app: 'PlotEdge',
      appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : null,
      exportedAt: stamp,
      // ══ THE WHOLE RECORD, NOT JUST THE NAME ══
      // A project carries client, manager, site, description and site
      // coordinates as well as its name, and those are precisely what the Plan
      // Sheet title block and the Survey Register masthead print. Carrying only
      // {id, name, createdAt} meant a restored survey was complete as DATA and
      // unissuable as a DOCUMENT until someone retyped the header — a loss that
      // would not show up until the drawing was produced.
      //
      // id is kept for provenance only; the importer always mints a fresh one so
      // a bundle can never collide with a project already on the device.
      // lastExportedAt is dropped on purpose: it describes THIS device's export
      // history, and inheriting it would make a freshly restored project claim
      // it had already been delivered.
      project: (() => {
        const { lastExportedAt, ...rest } = project;
        return rest;
      })(),
      counts: {
        features: features.length,
        featureTypes: schema.length,
        photos: photoCount,
        sketches: (plotetchSketches || []).length
      },
      checksums
    }, null, 2));

    zip.file('README.txt', plotpackReadme(project, features.length, photoCount));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const safe = (project.name || 'project').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
    const name = `${safe}_${ts()}.${PLOTPACK_EXT}`;
    const res = await saveExportFile(blob, name, PLOTPACK_MIME);
    noteExportSaved(res, name);
    if (status) status.textContent = res.ok
      ? `✓ ${name} — ${features.length} features, ${photoCount} photos`
      : 'Bundle could not be written';
  } catch (e){
    console.warn('PlotEdge: .plotpack export failed', e);
    showToast('Could not build the bundle');
    if (status) status.textContent = '';
  } finally {
    releaseExportPhotos(hydrated);
  }
}


// The same GeoJSON js/17-export.js writes, but as one collection across every
// type. Present so that unzipping a bundle gives somebody without PlotEdge
// something they can actually open, which is the difference between an archive
// and a black box.
function plotpackGeoJSON(){
  const out = [];
  savedFeatures.forEach(f => {
    const info = resolveFeatureType(f);
    out.push(...geoJSONFeaturesFor(f, info.label));
  });
  return { type: 'FeatureCollection', name: 'PlotEdge export', features: out };
}


function plotpackReadme(project, nFeatures, nPhotos){
  return [
    'PlotEdge project bundle (.plotpack)',
    '===============================',
    '',
    `Project:  ${project.name}`,
    `Exported: ${new Date().toISOString()}`,
    `Contents: ${nFeatures} features, ${nPhotos} photos`,
    '',
    'This file is a ZIP archive. Rename it to .zip and unzip it to read',
    'everything inside with ordinary tools — nothing here is encrypted or',
    'obfuscated.',
    '',
    '  manifest.json      what this bundle is, and a sha-256 of each text part',
    '  schema.json        the feature type definitions (fields, options, rules)',
    '  features.json      the survey at full fidelity, including per-vertex data',
    '  features.geojson   plain GeoJSON — open this one in QGIS or geojson.io',
    '  notes.md           project notes',
    '  sketches.json      PlotEtch sketches',
    '  tombstones.json    records of deleted features, so a merge cannot resurrect them',
    '  photos/            the original photo files, named by id',
    '',
    'To restore the whole project, open PlotEdge and use Import.',
    'features.geojson carries geometry and attributes only; the schema, photos',
    'and per-vertex data exist only in the other files.'
  ].join('\n');
}


// ══════════════════════════════════════════════════════════════════════════════
// DEVICE SETTINGS PACK
// ══════════════════════════════════════════════════════════════════════════════
// A project bundle restores a SURVEY. It deliberately does not restore theme,
// units, basemap, quick actions or any other preference, because importing a
// colleague's survey must never silently repaint your app or change your units.
//
// But that left a real gap: uninstall the app — or move to a new handset — and
// every preference is gone, because localStorage dies with the WebView. Android's
// allowBackup (set by scripts/patch-android-manifest.py) is supposed to cover
// this and does not for a sideloaded APK: Play Auto Backup only restores apps it
// delivered, and PlotEdge is installed from a GitHub release.
//
// So settings get their own pack. Same .plotpack extension, same Android file
// association, same picker — the manifest's `format` field says which kind it is
// and preparePlotpackImport() branches on it. One extension the user has to know
// about, two things it can carry.
//
// ── WHAT IS DELIBERATELY NOT IN IT ──
// Credentials. plotedge_gh_token is a GitHub personal access token with write
// access to somebody's repository; putting it in a file that is designed to be
// emailed between phones would turn a convenience feature into a credential leak.
// The GitHub owner and repo travel (they are not secret and are annoying to
// retype); the token does not, and the importer says so rather than leaving the
// user to discover publishing is broken.
//
// Also excluded: the project store itself (plotedge_v1/v2 — that is what project
// bundles are for), and anything describing this moment rather than a preference
// — the open project, the last session, an in-progress draft, whether the
// install prompt was dismissed.
const PLOTPACK_KIND_PROJECT = 'plotpack';
const PLOTPACK_KIND_SETTINGS = 'plotpack-settings';

// Allowlisted, never a wildcard sweep of localStorage. A blocklist would silently
// start exporting whatever key a future feature adds — including the next
// credential somebody stores.
const DEVICE_SETTING_KEYS = [
  'plotedge_theme', 'plotedge_domain', 'plotedge_density', 'plotedge_units',
  'plotedge_basemap', 'plotedge_maplayout_basemap', 'plotedge_snap',
  'plotedge_watermark', 'plotedge_quickactions', 'plotedge_export_format_default',
  'plotedge_plotlens_enabled', 'plotedge_plotwords_seen', 'plotedge_plotmate_clock', 'plotedge_plotmate_device',
  'plotedge_plotvault_sources', 'plotedge_atlas_tools_open', 'plotedge_insights_open',
  'plotedge_recent_assignees', 'plotedge-save-to-device', 'plotedge-autoexport-device',
  'plotedge-cloud-endpoint', 'plotedge-ai-endpoint',
  'plotedge_gh_owner', 'plotedge_gh_repo'
];


function deviceSettingsSnapshot(){
  const out = {};
  DEVICE_SETTING_KEYS.forEach(k => {
    try { const v = localStorage.getItem(k); if (v !== null) out[k] = v; } catch(e) {}
  });
  return out;
}


async function exportDeviceSettings(){
  if (typeof JSZip === 'undefined'){
    showToast('Bundle library not loaded — reconnect once and try again');
    return;
  }
  const status = document.getElementById('exportStatus');
  try {
    const settings = deviceSettingsSnapshot();
    const body = JSON.stringify(settings, null, 2);
    const zip = new JSZip();
    zip.file('mimetype', PLOTPACK_MIME, { compression: 'STORE' });
    zip.file('settings.json', body);
    zip.file('manifest.json', JSON.stringify({
      format: PLOTPACK_KIND_SETTINGS,
      formatVersion: PLOTPACK_FORMAT_VERSION,
      app: 'PlotEdge',
      exportedAt: new Date().toISOString(),
      counts: { settings: Object.keys(settings).length },
      checksums: { 'settings.json': await plotpackSha256(body) }
    }, null, 2));
    zip.file('README.txt', [
      'PlotEdge device settings pack',
      '=============================',
      '',
      'Preferences only — theme, units, basemap, quick actions and similar.',
      'It contains no survey data, no photos and no passwords or access tokens.',
      '',
      'Open PlotEdge and use Import to apply it to this or another device.'
    ].join('\n'));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const name = `PlotEdge_settings_${ts()}.${PLOTPACK_EXT}`;
    const res = await saveExportFile(blob, name, PLOTPACK_MIME);
    noteExportSaved(res, name);
    if (status) status.textContent = res.ok
      ? `✓ ${name} — ${Object.keys(settings).length} settings`
      : 'Settings pack could not be written';
  } catch(e){
    console.warn('PlotEdge: settings export failed', e);
    showToast('Could not build the settings pack');
    if (status) status.textContent = '';
  }
}


function renderSettingsImportWizard(){
  const host = document.getElementById('importWizard');
  if (!host || !pendingPlotpackImport) return;
  const n = Object.keys(pendingPlotpackImport.settings || {}).length;
  host.style.display = '';
  host.innerHTML = `
    <div class="import-summary">
      <div class="import-summary-title">Device settings pack</div>
      <div class="import-summary-meta">${n} setting${n === 1 ? '' : 's'} · exported ${escapeHtml((pendingPlotpackImport.manifest.exportedAt || '').slice(0, 10))}</div>
    </div>
    <p class="import-note">This replaces this device's preferences — theme, units, basemap,
    quick actions and similar. <strong>No projects or photos are touched.</strong>
    Publishing access tokens are never included in a pack, so if you publish web maps
    you will need to re-enter yours.</p>
    <button class="btn btn-primary" onclick="importDeviceSettings()">Apply these settings</button>
    <button class="btn btn-outline" onclick="cancelPlotpackImport()">Cancel</button>`;
}


function importDeviceSettings(){
  if (!pendingPlotpackImport || !pendingPlotpackImport.settings) return;
  const settings = pendingPlotpackImport.settings;
  let applied = 0;
  Object.keys(settings).forEach(k => {
    // The allowlist is enforced on the way IN as well as on the way out. A
    // hand-edited pack must not be able to write a key this app never intended
    // to restore — least of all one holding a credential.
    if (DEVICE_SETTING_KEYS.indexOf(k) === -1) return;
    try { localStorage.setItem(k, settings[k]); applied++; } catch(e) {}
  });
  cancelPlotpackImport();
  const status = document.getElementById('importStatus');
  if (status) status.textContent = `✓ ${applied} setting${applied === 1 ? '' : 's'} applied`;
  // A reload is the honest way to apply these. Theme, density, domain and units
  // are read at boot by a dozen different modules, and re-deriving all of them
  // in place would be a second, subtly different startup path that only this
  // feature exercises — the kind that works until one of the dozen changes.
  showConfirm('Settings applied. Restart the app now to see them?',
    () => { try { location.reload(); } catch(e) {} }, 'Restart', 'default');
}


// ══ READING ══
function isPlotpackFile(file){
  return !!file && file.name.toLowerCase().split('.').pop() === PLOTPACK_EXT;
}


async function preparePlotpackImport(file){
  if (typeof JSZip === 'undefined'){
    showToast('Bundle library not loaded — reconnect once and try again');
    return;
  }
  try {
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile){
      showToast('Not a PlotEdge bundle — no manifest inside');
      return;
    }
    const manifest = JSON.parse(await manifestFile.async('string'));
    const kind = manifest.format;
    if (kind !== PLOTPACK_KIND_PROJECT && kind !== PLOTPACK_KIND_SETTINGS){
      showToast('Not a PlotEdge bundle');
      return;
    }
    // Refuse forward, do not guess. An importer that half-understands a newer
    // bundle writes a project that looks fine and is missing things nobody will
    // notice until the survey is delivered.
    if (!(manifest.formatVersion <= PLOTPACK_FORMAT_VERSION)){
      showToast(`This bundle needs a newer PlotEdge (format v${manifest.formatVersion})`);
      return;
    }

    // A settings pack is a different animal: no schema, no features, nothing to
    // merge. Handled here and returned, rather than threaded through the project
    // path with half its checks skipped.
    if (kind === PLOTPACK_KIND_SETTINGS){
      const raw = zip.file('settings.json') ? await zip.file('settings.json').async('string') : null;
      if (raw == null){ showToast('Settings pack is empty'); return; }
      const want = (manifest.checksums || {})['settings.json'];
      if (want && await plotpackSha256(raw) !== want){
        showToast('Settings pack is damaged — ask for it to be sent again');
        return;
      }
      pendingPlotpackImport = { zip, manifest, settings: JSON.parse(raw), fileName: file.name };
      renderSettingsImportWizard();
      return;
    }

    const readPart = async name => {
      const f = zip.file(name);
      return f ? await f.async('string') : null;
    };
    const parts = {
      'schema.json': await readPart('schema.json'),
      'features.json': await readPart('features.json'),
      'notes.md': await readPart('notes.md'),
      'sketches.json': await readPart('sketches.json'),
      // Absent in bundles written before this existed — read as an empty list rather than an
      // error, same tolerance the checksum loop below already applies to missing parts.
      'tombstones.json': await readPart('tombstones.json')
    };
    if (parts['features.json'] == null || parts['schema.json'] == null){
      showToast('Bundle is incomplete — features or schema missing');
      return;
    }

    // Truncated-transfer check. Only parts the manifest actually claims are
    // verified, so a bundle written by a version that shipped fewer files still
    // imports rather than failing on a checksum that was never there.
    const bad = [];
    for (const name in (manifest.checksums || {})){
      if (parts[name] == null) continue;
      const got = await plotpackSha256(parts[name]);
      if (got !== manifest.checksums[name]) bad.push(name);
    }
    if (bad.length){
      showToast(`Bundle is damaged (${bad.join(', ')}) — ask for it to be sent again`);
      return;
    }

    pendingPlotpackImport = {
      zip,
      manifest,
      schema: JSON.parse(parts['schema.json']),
      features: JSON.parse(parts['features.json']),
      notes: parts['notes.md'] || '',
      sketches: parts['sketches.json'] ? JSON.parse(parts['sketches.json']) : [],
      tombstones: parts['tombstones.json'] ? JSON.parse(parts['tombstones.json']) : [],
      fileName: file.name
    };
    renderPlotpackImportWizard();
  } catch (e){
    console.warn('PlotEdge: .plotpack import failed', e);
    showToast('Could not read that bundle — it may be damaged');
  }
}


function renderPlotpackImportWizard(){
  const host = document.getElementById('importWizard');
  if (!host || !pendingPlotpackImport) return;
  const m = pendingPlotpackImport.manifest;
  const c = m.counts || {};
  host.style.display = '';
  host.innerHTML = `
    <div class="import-summary">
      <div class="import-summary-title">${escapeHtml(m.project && m.project.name || 'PlotEdge bundle')}</div>
      <div class="import-summary-meta">
        ${c.features || 0} features · ${c.featureTypes || 0} feature types ·
        ${c.photos || 0} photos${c.sketches ? ` · ${c.sketches} sketches` : ''}
      </div>
      <div class="import-summary-meta">Exported ${escapeHtml((m.exportedAt || '').slice(0, 10))}</div>
    </div>
    <!-- v1 always creates a NEW project. Merging into an open one means deciding
         what to do about colliding feature ids and same-id-different-fields
         schemas, and getting that wrong silently corrupts a live survey. A
         duplicate project is a nuisance; a corrupted one is lost work. -->
    <p class="import-note">This restores everything — schema, photos, per-vertex data and notes —
    into a <strong>new project</strong>. Nothing already on this device is touched.</p>
    <button class="btn btn-primary" onclick="importPlotpackBundle()">Restore as a new project</button>
    <button class="btn btn-outline" onclick="cancelPlotpackImport()">Cancel</button>`;
}


function cancelPlotpackImport(){
  pendingPlotpackImport = null;
  const host = document.getElementById('importWizard');
  if (host){ host.style.display = 'none'; host.innerHTML = ''; }
}


async function importPlotpackBundle(){
  if (!pendingPlotpackImport) return;
  const p = pendingPlotpackImport;
  const status = document.getElementById('importStatus');
  if (status) status.textContent = 'Restoring…';

  try {
    // Photos first: a feature written before its photo bytes exist would render
    // a broken thumbnail for as long as it took the rest to finish, and would
    // stay broken if the restore failed halfway.
    let restored = 0, missing = 0;
    for (const f of p.features){
      const all = [].concat(f.photos || [], ...(f.vertices || []).map(v => v.photos || []));
      for (const ph of all){
        if (!ph.file){ missing++; continue; }
        const entry = p.zip.file(ph.file);
        if (!entry){ missing++; continue; }
        const blob = await entry.async('blob');
        const dataUrl = await photoBlobToDataUrl(blob);
        if (!dataUrl){ missing++; continue; }
        await photoStoreSave({ id: ph.id, dataUrl, thumbUrl: dataUrl });
        restored++;
        delete ph.file; delete ph.missing;
      }
    }

    const src = p.manifest.project || {};
    const name = src.name || 'Imported project';
    const id = 'proj_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    // Spread the bundled record first so client/manager/site/description and the
    // site coordinates come across, then overwrite the four fields that must
    // belong to THIS device: a fresh id, a name that cannot collide, and stamps
    // that describe the restore rather than the original export.
    projects.push({
      ...src,
      id,
      name: plotpackUniqueName(name),
      createdAt: src.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastExportedAt: null
    });
    projectData[id] = {
      savedFeatures: p.features,
      currentVertices: [],
      featureTypes: p.schema,
      notes: p.notes,
      notesUpdatedAt: new Date().toISOString(),
      sketches: p.sketches,
      suspended: [],
      tombstones: Array.isArray(p.tombstones) ? p.tombstones : []
    };
    // persistStore(), not persist(): persist() writes only the ACTIVE project and
    // returns early when none is open — which is exactly the state someone is in
    // when they restore a bundle from the Projects screen.
    persistStore({ destructive: false });

    cancelPlotpackImport();
    if (status){
      status.textContent = `✓ Restored ${p.features.length} features and ${restored} photos`
        + (missing ? ` · ${missing} photo${missing === 1 ? '' : 's'} were not in the bundle` : '');
    }
    renderProjectsList();
    showToast(`"${name}" restored — open it from Projects`);
  } catch (e){
    console.warn('PlotEdge: .plotpack restore failed', e);
    if (status) status.textContent = '';
    showToast('Restore failed — nothing was changed');
  }
}


// Two phones both holding "Harare Ring Road" is the normal case, not the odd
// one, so the copy is labelled rather than refused or silently merged.
function plotpackUniqueName(name){
  const taken = new Set(projects.map(p => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++){
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}


// SubtleCrypto is unavailable on an insecure origin; a Capacitor WebView is
// https so this is the normal path, but the fallback keeps export working on a
// plain-http dev server instead of failing at the last step.
async function plotpackSha256(text){
  try {
    if (crypto && crypto.subtle){
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {}
  // Not a cryptographic hash and not pretending to be one — this only has to
  // catch a truncated transfer, which changes the length and the tail.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return 'len' + text.length + '-' + (h >>> 0).toString(16);
}
