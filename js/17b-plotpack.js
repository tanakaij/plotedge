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
    showToast('Bundle library not loaded, reconnect once and try again');
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
      ? `✓ ${name}, ${features.length} features, ${photoCount} photos`
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
    'everything inside with ordinary tools. Nothing here is encrypted or',
    'obfuscated.',
    '',
    '  manifest.json      what this bundle is, and a sha-256 of each text part',
    '  schema.json        the feature type definitions (fields, options, rules)',
    '  features.json      the survey at full fidelity, including per-vertex data',
    '  features.geojson   plain GeoJSON. Open this one in QGIS or geojson.io',
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
  'plotedge_plotlens_enabled', 'plotedge_plotwords_seen', 'plotedge_widget_dynamic', 'plotedge_value_bank', 'plotedge_plotmate_clock', 'plotedge_plotmate_device',
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
    showToast('Bundle library not loaded, reconnect once and try again');
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
      'Preferences only: theme, units, basemap, quick actions and similar.',
      'It contains no survey data, no photos and no passwords or access tokens.',
      '',
      'Open PlotEdge and use Import to apply it to this or another device.'
    ].join('\n'));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const name = `PlotEdge_settings_${ts()}.${PLOTPACK_EXT}`;
    const res = await saveExportFile(blob, name, PLOTPACK_MIME);
    noteExportSaved(res, name);
    if (status) status.textContent = res.ok
      ? `✓ ${name}, ${Object.keys(settings).length} settings`
      : 'Settings pack could not be written';
  } catch(e){
    console.warn('PlotEdge: settings export failed', e);
    showToast('Could not build the settings pack');
    if (status) status.textContent = '';
  }
}


function renderSettingsImportWizard(){
  const host = plotpackWizardHost();
  if (!host || !pendingPlotpackImport) return;
  const n = Object.keys(pendingPlotpackImport.settings || {}).length;
  host.style.display = '';
  host.innerHTML = `
    <div class="import-summary">
      <div class="import-summary-title">Device settings pack</div>
      <div class="import-summary-meta">${n} setting${n === 1 ? '' : 's'} · exported ${escapeHtml((pendingPlotpackImport.manifest.exportedAt || '').slice(0, 10))}</div>
    </div>
    <p class="import-note">This replaces this device's preferences: theme, units, basemap,
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


// ══ TWO WAYS IN, ONE WIZARD ══
// A .plotpack can arrive through the Import panel's own PlotPack card (the obvious route, and
// the only one that names the format) or through the general "import data from other software"
// picker, which still accepts the extension so a file chosen there is not simply refused. Both
// end in the same wizard, so the wizard has to render into whichever card the user actually
// used — dropping the summary into a collapsed card three rows further down would look like
// nothing had happened.
//
// Recorded on the pending import rather than read from the DOM at render time, because by then
// there is nothing left to say which picker produced the file.
const PLOTPACK_DEFAULT_HOST = 'plotpackImportWizard';

function plotpackWizardHost(){
  const id = (pendingPlotpackImport && pendingPlotpackImport.hostId) || PLOTPACK_DEFAULT_HOST;
  return document.getElementById(id) || document.getElementById('importWizard');
}

// The Import panel's dedicated PlotPack card. Kept separate from handleImportFileChosen() rather
// than routed through it: this input only ever accepts one format, so it can say something useful
// when the wrong file is picked instead of listing three extensions.
function handlePlotpackFileChosen(event){
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!isPlotpackFile(file)){
    showToast('That is not a .plotpack file. Use the cards below for .json, .csv or .gpkg');
    return;
  }
  preparePlotpackImport(file, PLOTPACK_DEFAULT_HOST);
}


async function preparePlotpackImport(file, hostId){
  if (typeof JSZip === 'undefined'){
    showToast('Bundle library not loaded, reconnect once and try again');
    return;
  }
  try {
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile){
      showToast('Not a PlotEdge bundle, no manifest inside');
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
        showToast('Settings pack is damaged, ask for it to be sent again');
        return;
      }
      pendingPlotpackImport = { zip, manifest, settings: JSON.parse(raw), fileName: file.name, hostId };
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
      showToast('Bundle is incomplete. Features or schema missing');
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
      showToast(`Bundle is damaged (${bad.join(', ')}), ask for it to be sent again`);
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
      fileName: file.name,
      hostId
    };
    renderPlotpackImportWizard();
  } catch (e){
    console.warn('PlotEdge: .plotpack import failed', e);
    showToast('Could not read that bundle. It may be damaged');
  }
}


function renderPlotpackImportWizard(){
  const host = plotpackWizardHost();
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
    <p class="import-note">This restores everything (schema, photos, per-vertex data and notes) into a <strong>new project</strong>. Nothing already on this device is touched.</p>
    <!-- The dispatcher, not the project importer. preparePlotpackImport() only ever renders THIS
         wizard for a project pack (a settings pack gets renderSettingsImportWizard instead), so
         going straight to the project importer here would in fact work today — but "works because
         of a branch three functions away" is the exact shape of the bug that made settings packs
         silently no-op, and there is one dispatcher for a reason. -->
    <button class="btn btn-primary" onclick="runPendingPlotpackImport()">Restore as a new project</button>
    <button class="btn btn-outline" onclick="cancelPlotpackImport()">Cancel</button>`;
}


function cancelPlotpackImport(){
  // Cleared BEFORE the hosts are read, so both are wiped by id rather than through
  // plotpackWizardHost() — which would resolve against a pending import that no longer exists and
  // leave the summary sitting in whichever card it was not looking at.
  pendingPlotpackImport = null;
  ['plotpackImportWizard', 'importWizard'].forEach(id => {
    const host = document.getElementById(id);
    if (host){ host.style.display = 'none'; host.innerHTML = ''; }
  });
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
    // ══ PROGRESS IS COUNTED, NOT MIMED ══
    // The photo count is knowable before the loop starts, so the restore sheet shows a real
    // determinate bar instead of an indeterminate sweep that says only "something is happening".
    // This is the slow part of a restore by a wide margin — a bundle can carry hundreds of photos,
    // each one a zip entry inflated to a blob and then to a data URL — and it is the part someone
    // is most afraid of being interrupted, so it is the part that has to report honestly.
    // plotpackProgressHook is null on every path except the sheet (see restoreShowWorking()), so
    // the Import screen's behaviour is completely unchanged.
    const photoTotal = p.features.reduce((n, f) =>
      n + (f.photos || []).length +
      (f.vertices || []).reduce((m, v) => m + (v.photos || []).length, 0), 0);
    let photoDone = 0;
    const reportPhoto = () => {
      if (typeof plotpackProgressHook === 'function' && plotpackProgressHook) {
        try { plotpackProgressHook(photoDone, photoTotal); } catch(e) {}
      }
    };
    reportPhoto();
    for (const f of p.features){
      const all = [].concat(f.photos || [], ...(f.vertices || []).map(v => v.photos || []));
      for (const ph of all){
        // Every exit from this iteration steps the counter, including the three that skip a photo.
        // A bar that stalls on a bundle with missing photos is a bar that reports a failure that
        // did not happen.
        if (!ph.file){ missing++; photoDone++; reportPhoto(); continue; }
        const entry = p.zip.file(ph.file);
        if (!entry){ missing++; photoDone++; reportPhoto(); continue; }
        const blob = await entry.async('blob');
        const dataUrl = await photoBlobToDataUrl(blob);
        if (!dataUrl){ missing++; photoDone++; reportPhoto(); continue; }
        await photoStoreSave({ id: ph.id, dataUrl, thumbUrl: dataUrl });
        restored++;
        photoDone++; reportPhoto();
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
      lastExportedAt: null,
      // ══ WHERE THIS CAME FROM ══
      // The four fields above deliberately overwrite the bundled record so the restored project
      // belongs to THIS device — a fresh id, a non-colliding name, stamps describing the restore.
      // That is correct, and it is also why a second restore of the same file used to be
      // undetectable: everything that identified the original had just been replaced.
      // This keeps the original identity alongside the new one. `projectId` + `exportedAt` together
      // name one specific export of one specific project, which is the only signal precise enough
      // to say "you already have exactly this" rather than "you have something with a similar
      // name" — and two visits to one site legitimately produce two projects called Ward 7.
      restoredFrom: { projectId: src.id || null, exportedAt: p.manifest.exportedAt || null,
                      restoredAt: new Date().toISOString() }
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
    showToast(`"${name}" restored. Open it from Projects`);
    // Returned so the restore sheet can render a real "what just happened" step from the same
    // numbers this function already has. Every pre-existing caller ignores the return value, so
    // nothing else changes.
    return { ok: true, kind: 'project', projectId: id, name, features: p.features.length, photos: restored, missing };
  } catch (e){
    console.warn('PlotEdge: .plotpack restore failed', e);
    if (status) status.textContent = '';
    showToast('Restore failed, nothing was changed');
    return { ok: false, kind: 'project' };
  }
}


// ══ ONE PLACE THAT DECIDES WHICH KIND OF PACK IS PENDING ══
// preparePlotpackImport() detects TWO kinds of .plotpack (PLOTPACK_KIND_PROJECT and
// PLOTPACK_KIND_SETTINGS — see the `kind` branch near its top), and they need completely different
// confirm actions: a project pack mints a new project, a settings pack writes allowlisted keys to
// localStorage. Every restore path has to make that choice, and originally each one made it for
// itself by wiring its confirm button straight to importPlotpackBundle() — which reads
// p.features, undefined on a settings pack. So "Apply these settings" threw, the throw was
// swallowed by importPlotpackBundle()'s own try/catch and reported as "Restore failed, nothing was
// changed", and the settings were silently never applied.
// This is the one place that decision is made. Every restore path calls this, never
// importPlotpackBundle() directly — the restore sheet's confirm step, the Import screen's
// device-scan rows, and anything added later. tests/plotpack.test.js enforces that statically, so
// a future path that copies the old pattern fails the suite rather than shipping the bug back.
async function runPendingPlotpackImport(){
  if (pendingPlotpackImport && pendingPlotpackImport.settings){ importDeviceSettings(); return { ok: true, kind: 'settings' }; }
  return await importPlotpackBundle();
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


// ══════════════════════════════════════════════════════════════════════════
// AUTO-DETECT LOCAL BACKUPS — offered on a genuinely empty device
// ══════════════════════════════════════════════════════════════════════════
// scripts/patch-android-manifest.py turned off Android's OS-level Auto Backup because it was
// silently restoring old app data on a fresh install — the exact bug this replaces. A fresh
// install now ALWAYS lands on an empty Welcome screen (js/22-boot.js). This is the deliberate,
// visible substitute: if one or more .plotpack / .plotedge.json files are sitting in the app's
// own export folder (Documents/PlotEdge — wherever js/17-export.js's saveExportFile() already
// writes to), a dismissible banner on Welcome offers to bring them back. Detection is automatic
// and silent; importing never is — the person always taps Restore, per file.
//
// A crew reinstalling PlotEdge on a new phone commonly has several old per-project exports
// sitting in that folder, not one — one per site they were working. All of them are surfaced,
// not just the newest, and each imports independently: importing one never removes the others
// from the list, since a JSON/plotpack import always creates a brand-new project id rather than
// overwriting anything (see importOneBackupProject() / importPlotpackBundle()).
//
// Deliberately scoped to projects.length === 0: this can never fire once a real project exists
// on the device, so it can never interrupt someone mid-survey by resurrecting an old bundle.
const AUTO_BACKUP_DISMISS_KEY = 'plotedge_dismissed_backups'; // JSON array of dismissed file keys
let _detectedBackups = []; // [{name, dir, mtime}, ...], newest first

// Keyed on the full path now, not just the name: the scan reaches several folders, and
// "PlotEdge_all.plotedge.json" in Download and the same name in Documents/PlotEdge are two
// different files that must dismiss independently.
function backupFileKey(f){ return f.dir + ':' + (f.path || f.name) + ':' + f.mtime; }

function readDismissedBackupKeys(){
  try { return new Set(JSON.parse(localStorage.getItem(AUTO_BACKUP_DISMISS_KEY) || '[]')); }
  catch(e){ return new Set(); }
}
function addDismissedBackupKeys(entries){
  const set = readDismissedBackupKeys();
  entries.forEach(f => set.add(backupFileKey(f)));
  try { localStorage.setItem(AUTO_BACKUP_DISMISS_KEY, JSON.stringify([...set])); } catch(e) {}
}

// ══ WHERE A BACKUP ACTUALLY IS ══
// This used to read exactly two paths: Documents/PlotEdge and Storage/PlotEdge — i.e. only the
// folders saveExportFile() itself writes to. That covers one scenario (same handset, app
// reinstalled, the export folder survived) and misses the two that matter most:
//   · New phone. The .plotpack arrived by WhatsApp, Bluetooth, email or USB and is sitting in
//     Download/, or the root of Documents/.
//   · A colleague sent a project across. Same thing.
// In both cases the scan reported "no backups found" on a device that visibly had one, which does
// not read as "I only looked in one folder" — it reads as "your data is gone".
// Each location is carried on the entry now (path + label), because these files are no longer all
// under EXPORT_DIR and the reader can't reconstruct the path from the name any more.
const BACKUP_SCAN_LOCATIONS = [
  { dir: 'DOCUMENTS',        path: EXPORT_DIR, label: 'Documents/' + EXPORT_DIR },
  { dir: 'EXTERNAL_STORAGE', path: EXPORT_DIR, label: 'Storage/' + EXPORT_DIR },
  { dir: 'DOCUMENTS',        path: '',         label: 'Documents' },
  { dir: 'EXTERNAL_STORAGE', path: 'Download', label: 'Download' },
  { dir: 'EXTERNAL_STORAGE', path: '',         label: 'Storage' }
];

// A Downloads folder with several thousand files is ordinary, and this runs on a phone while
// somebody waits on the Welcome screen. The cap is per location and generous enough that it can
// only ever bite on a folder nobody could pick a file out of by hand either.
const BACKUP_SCAN_MAX_ENTRIES = 1500;

// Reading mtime costs a stat() call per file. Worth it for the handful in an export folder, not
// for every candidate in a big Downloads directory — so it is only paid where readdir() didn't
// already supply one and the result set is still small enough to matter.
const BACKUP_SCAN_MAX_STATS = 40;

function isBackupFileName(name){ return !!name && /\.(plotpack|plotedge\.json)$/i.test(name); }

// Looks in every location a backup plausibly lands in, and returns EVERY match, newest first —
// not just the most recent. A device can genuinely hold several distinct project backups worth
// offering separately. Deduplicated on dir+path+name, since the same file is reachable through
// more than one of the locations above (Documents/PlotEdge is inside Documents).
async function findAllDeviceBackupFiles(){
  const Filesystem = capPlugin('Filesystem');
  if (!Filesystem || !Filesystem.readdir) return [];
  const results = [];
  const seen = new Set();
  let stats = 0;
  for (const loc of BACKUP_SCAN_LOCATIONS){
    let entries;
    try {
      const res = await Filesystem.readdir({ path: loc.path, directory: loc.dir });
      entries = (res && res.files) || [];
    } catch(e) { continue; } // folder doesn't exist on this target — normal, try the next one
    if (entries.length > BACKUP_SCAN_MAX_ENTRIES) entries = entries.slice(0, BACKUP_SCAN_MAX_ENTRIES);
    for (const raw of entries){
      // Older @capacitor/filesystem returns plain filename strings from readdir(); newer
      // versions return {name, type, mtime, uri, size} objects. Normalise both.
      const name = typeof raw === 'string' ? raw : raw.name;
      if (!isBackupFileName(name)) continue;
      if (raw && typeof raw === 'object' && raw.type === 'directory') continue;
      const full = loc.path ? loc.path + '/' + name : name;
      const key = loc.dir + ':' + full;
      if (seen.has(key)) continue;
      seen.add(key);
      let mtime = (raw && typeof raw === 'object' && raw.mtime) || 0;
      let size  = (raw && typeof raw === 'object' && raw.size)  || 0;
      if ((!mtime || !size) && stats < BACKUP_SCAN_MAX_STATS){
        stats++;
        try {
          const st = await Filesystem.stat({ path: full, directory: loc.dir });
          mtime = mtime || (st && st.mtime) || 0;
          size  = size  || (st && st.size)  || 0;
        } catch(e) {}
      }
      results.push({ name, dir: loc.dir, path: full, where: loc.label, mtime, size });
    }
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

// The folders the scan actually covers, for the empty state. Naming them is the difference between
// "you have no backups" (wrong, and frightening) and "not in these five places — try the picker".
function backupScanLocationSummary(){
  return [...new Set(BACKUP_SCAN_LOCATIONS.map(l => l.label))].join(', ');
}

function formatBackupSize(bytes){
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

// A filename tells a crew nothing about which sites are inside it — choosing between six old
// exports called PlotEdge_all_<date>.plotedge.json is six speculative restores. The project names
// are right there in the JSON, so they are read and shown.
// Size-gated on purpose: a .plotedge.json carries its photos inline as base64, so these files can
// run to hundreds of megabytes, and reading one to label a list row would stall the screen for
// exactly the crews with the most data. Above the threshold the row keeps its size and date, which
// are free. .plotpack is never opened here at all — it is a zip, and JSZip has to take the whole
// archive (photos included) into memory before the manifest can be read.
const BACKUP_PEEK_MAX_BYTES = 4 * 1024 * 1024;

async function peekBackupContents(entry){
  if (!entry || entry._peeked) return entry;
  entry._peeked = true;
  if (!/\.plotedge\.json$/i.test(entry.name)) return entry;
  if (entry.size && entry.size > BACKUP_PEEK_MAX_BYTES) return entry;
  const Filesystem = capPlugin('Filesystem');
  if (!Filesystem || !Filesystem.readFile) return entry;
  try {
    const res = await Filesystem.readFile({ path: entry.path, directory: entry.dir });
    if (!res || !res.data) return entry;
    const payload = JSON.parse(decodeURIComponent(escape(atob(res.data))));
    if (!payload || payload.peBackup !== PE_BACKUP_VERSION) return entry;
    const metas = payload.kind === 'all' ? (payload.projects || [])
                : payload.kind === 'project' ? [payload.project] : [];
    entry.projectNames = metas.filter(Boolean).map(m => m.name).filter(Boolean);
    entry.featureCount = metas.filter(Boolean)
      .reduce((n, m) => n + (((payload.data || {})[m.id] || {}).savedFeatures || []).length, 0);
  } catch(e) { /* unreadable or not a backup — the row keeps its plain label */ }
  return entry;
}

// Restoring is always additive: importOneBackupProject() mints a fresh id, so nothing on the device
// is ever overwritten. The cost of that safety is that restoring the same file twice leaves two
// identical projects and no hint of why — and Home reaches the Welcome screen even when projects
// already exist, so a re-scan and re-restore is an easy accident. This is the warning, not a block:
// two projects of the same name can be entirely legitimate (two visits to one site).
function backupLooksAlreadyRestored(entry){
  if (!entry || !entry.projectNames || !entry.projectNames.length) return false;
  const here = new Set(projects.map(p => (p.name || '').trim().toLowerCase()));
  return entry.projectNames.some(n => here.has((n || '').trim().toLowerCase()));
}

// ══ HAVE I ALREADY GOT EXACTLY THIS? ══
// Three grades of answer, because they call for three different responses and collapsing them into
// one boolean is what made the old name-only check too weak to act on.
//   'same-export'  — same source project AND same export timestamp. This is literally the same file
//                    restored twice. Unambiguous, and the only grade worth blocking on.
//   'same-project' — same source project, different export. A LATER backup of something already
//                    here, which is a legitimate thing to want (restore Tuesday's version alongside
//                    Monday's) and must not be refused.
//   null           — no relationship worth mentioning.
// Name is deliberately not a grade of its own. Two projects called "Ward 7" are ordinary — two
// visits to one site — and treating that as a duplicate would refuse the most normal case there is.
function findRestoredTwin(manifest){
  const src = (manifest || {}).project || {};
  if (!src.id) return null;
  const exportedAt = (manifest || {}).exportedAt || null;
  let looser = null;
  for (const proj of (projects || [])){
    const from = proj.restoredFrom;
    if (!from || from.projectId !== src.id) continue;
    if (exportedAt && from.exportedAt === exportedAt) return { grade: 'same-export', project: proj };
    // Kept as a fallback rather than returned immediately: an exact match anywhere in the list
    // outranks a loose one, and the list is not ordered by relevance.
    looser = looser || { grade: 'same-project', project: proj };
  }
  return looser;
}

// One row's supporting line: kind, size, date, folder — and, where peekBackupContents() managed to
// read it, what is actually inside.
function describeBackupEntry(f){
  const bits = [/\.plotpack$/i.test(f.name) ? 'PlotPack (whole project)' : 'JSON backup'];
  if (f.projectNames && f.projectNames.length){
    bits.push(f.projectNames.length + ' project' + (f.projectNames.length === 1 ? '' : 's') +
      ' · ' + f.projectNames.slice(0, 3).join(', ') + (f.projectNames.length > 3 ? '…' : ''));
    if (f.featureCount) bits.push(f.featureCount + ' feature' + (f.featureCount === 1 ? '' : 's'));
  }
  const size = formatBackupSize(f.size);
  if (size) bits.push(size);
  if (f.mtime) bits.push(new Date(f.mtime).toLocaleDateString());
  if (f.where) bits.push(f.where);
  return bits.join(' · ');
}

// ══ SETTINGS PACKS SORT THEMSELVES OUT OF THE SCAN, SILENTLY ══
// A device-settings pack (.plotpack, PLOTPACK_KIND_SETTINGS) carries no survey data at all —
// theme, units, basemap, quick actions and similar, and explicitly nothing destructive (see
// exportDeviceSettings()'s own README.txt above). findAllDeviceBackupFiles() only tells .plotpack
// apart from .plotedge.json by extension, so a settings pack looks identical to a project pack
// until its manifest is actually opened. peekPlotpackKind() opens it and tags entry.packKind;
// the zip is cached on the entry so a settings pack that gets applied doesn't get read twice.
async function peekPlotpackKind(entry){
  if (!/\.plotpack$/i.test(entry.name)) return entry;
  if (typeof JSZip === 'undefined') return entry; // library not loaded — falls back to the normal manual-restore row
  const Filesystem = capPlugin('Filesystem');
  if (!Filesystem || !Filesystem.readFile) return entry;
  try {
    const res = await Filesystem.readFile({ path: entry.path, directory: entry.dir });
    if (!res || !res.data) return entry;
    const zip = await JSZip.loadAsync(res.data, { base64: true });
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) return entry;
    const manifest = JSON.parse(await manifestFile.async('string'));
    entry.packKind = manifest.format;
    entry._zipCache = zip;
  } catch(e) { /* unreadable — treated as an ordinary project-pack row, same as before this existed */ }
  return entry;
}

// Reads settings.json out of an already-identified settings pack and writes every allowlisted
// key straight into localStorage — the same allowlist importDeviceSettings() enforces for a
// manually-picked pack, just without the wizard tap. No reload is forced here (unlike the manual
// path): this only ever runs before a single project exists, so there is nothing on screen yet
// that a live theme/units change could visibly disrupt — the very next render simply picks up
// the restored values.
async function autoApplyDetectedSettingsPack(entry){
  try {
    let zip = entry._zipCache;
    if (!zip){
      const Filesystem = capPlugin('Filesystem');
      if (!Filesystem || !Filesystem.readFile) return false;
      const res = await Filesystem.readFile({ path: entry.path, directory: entry.dir });
      if (!res || !res.data) return false;
      zip = await JSZip.loadAsync(res.data, { base64: true });
    }
    const raw = zip.file('settings.json') ? await zip.file('settings.json').async('string') : null;
    if (raw == null) return false;
    const settings = JSON.parse(raw);
    let applied = 0;
    Object.keys(settings).forEach(k => {
      if (DEVICE_SETTING_KEYS.indexOf(k) === -1) return; // allowlist enforced on the way in, same as manual import
      try { localStorage.setItem(k, settings[k]); applied++; } catch(e) {}
    });
    return applied > 0;
  } catch(e){
    console.warn('PlotEdge: auto-apply settings pack failed', e);
    return false;
  }
}

// Called once at boot (js/22-boot.js), only on the "genuine first run" path. No-op in the
// browser/PWA build — there is no device folder to scan without the Filesystem plugin, so
// nothing is offered there and the Welcome screen behaves exactly as it always has.
async function checkForDetectedBackup(){
  if (projects.length) return;
  if (!capPlugin('Filesystem')) return;
  try {
    const all = await findAllDeviceBackupFiles();
    if (!all.length) return;
    const dismissed = readDismissedBackupKeys();
    let pending = all.filter(f => !dismissed.has(backupFileKey(f)));
    if (!pending.length) return;

    // Sort settings packs out of the pending list before anything is shown: on a fresh install
    // (this is the one call site, and it only runs while projects.length === 0) they apply
    // themselves automatically rather than waiting for a tap. Project packs are untouched here —
    // those add real survey data and still go through the normal Restore confirm below.
    await Promise.all(pending.filter(f => /\.plotpack$/i.test(f.name)).map(peekPlotpackKind));
    const settingsPacks = pending.filter(f => f.packKind === PLOTPACK_KIND_SETTINGS);
    pending = pending.filter(f => f.packKind !== PLOTPACK_KIND_SETTINGS);

    if (settingsPacks.length){
      // If more than one settings pack is sitting on the device, the newest (the list is already
      // sorted newest-first) is the one that gets applied; all of them are marked seen either way
      // so a stale one doesn't keep resurfacing on a later scan.
      const applied = await autoApplyDetectedSettingsPack(settingsPacks[0]);
      addDismissedBackupKeys(settingsPacks);
      if (applied) showToast('✓ Restored your device settings from ' + settingsPacks[0].name);
    }

    if (!pending.length) return;
    _detectedBackups = pending;
    showDetectedBackupBanner(pending);
  } catch(e) {
    console.warn('PlotEdge: backup auto-detect failed', e);
  }
}

function showDetectedBackupBanner(list){
  const banner = document.getElementById('foundBackupBanner');
  const title = document.getElementById('foundBackupTitle');
  const sub = document.getElementById('foundBackupSub');
  const btn = document.getElementById('foundBackupBtn');
  if (!banner) return;
  if (list.length === 1){
    if (title) title.textContent = 'Backup found on this device';
    if (sub) sub.textContent = list[0].name + ' · ' + describeBackupEntry(list[0]);
    if (btn) btn.textContent = 'Restore';
  } else {
    if (title) title.textContent = list.length + ' backups found on this device';
    if (sub) sub.textContent = 'Different projects, most recent first. Pick which to restore.';
    if (btn) btn.textContent = 'Choose';
  }
  banner.style.display = '';
}

// The banner's one action button. It used to branch — a single match restored in place, several
// rendered a picker list into #foundBackupWizard directly underneath the banner, and either way
// the confirm step then appeared inline in the middle of the Welcome page. Both routes now open
// the same sheet (see openRestoreSheet() at the bottom of this file), which handles the
// one-versus-several distinction itself: one entry goes straight to its confirm step, several show
// the list first. Restoring the wrong one of several by accident is still worse than one extra
// tap, so that ordering is unchanged — only where it happens has.
function handleFoundBackupAction(){
  if (!_detectedBackups.length) return;
  openRestoreSheet(_detectedBackups, { source: 'detected' });
}

// Removes one entry from the pending list (it has either been imported or its own confirm step
// was cancelled — see the two callers below) and either re-renders the remaining picker or, if
// that was the last one, closes the whole banner/wizard.
function removeDetectedBackupEntry(entry){
  _detectedBackups = _detectedBackups.filter(f => backupFileKey(f) !== backupFileKey(entry));
  // The banner is the only thing left on the page to update — the list itself lives in the restore
  // sheet now, which re-reads whatever it was handed when it renders its own "restore another"
  // step. Once nothing is pending the banner has nothing left to offer, so it closes.
  if (_detectedBackups.length) showDetectedBackupBanner(_detectedBackups);
  else dismissFoundBackupBannerUI();
}

// UI-only close: hides the banner without touching the dismissed-keys store. Used once the list is
// empty because every entry was already imported (or cancelled/removed), so there is nothing left
// that would need re-dismissing later. The inline wizard host it also used to clear no longer
// exists — the restore flow lives in #restoreModal, which owns its own teardown.
function dismissFoundBackupBannerUI(){
  const banner = document.getElementById('foundBackupBanner');
  if (banner) banner.style.display = 'none';
}

function dismissFoundBackupBanner(){
  if (_detectedBackups.length) addDismissedBackupKeys(_detectedBackups);
  _detectedBackups = [];
  dismissFoundBackupBannerUI();
}

// ══════════════════════════════════════════════════════════════════════════
// WELCOME SCREEN — the same two gaps, on the screen people actually land on
// ══════════════════════════════════════════════════════════════════════════
// The "Restore from backup" button on #view-projects only ever opened handleBackupImportFile()
// (js/17-export.js), which parses JSON and rejects anything else — a .plotpack chosen there failed
// with "Not a PlotEdge backup file" even though .plotpack is the newer, preferred format
// (js/17b-plotpack.js's own file-type note says as much). This dispatches on the extension the
// person actually picked instead of assuming JSON.
function handleWelcomeRestoreFile(event){
  const file = event.target.files && event.target.files[0];
  if (!file){ event.target.value = ''; return; }
  event.target.value = '';

  if (/\.plotpack$/i.test(file.name)){
    // Straight into the sheet's Check step. This used to render the confirm markup into
    // #foundBackupWizard — a hidden div in the middle of the Welcome page — and then re-wire its
    // two buttons by hand, which is what produced the block of unstyled black text and the pair of
    // buttons appearing out of nowhere between the banner and New project.
    restoreBeginFile(file);
    return;
  }
  // .plotedge.json picked from the OS picker. Read here rather than handed to
  // handleBackupImportFile() so it gets the same confirm-then-report treatment as everything else:
  // that function imports silently and reports with a toast, which on a fresh device is the one
  // moment someone most needs to be shown what they just got back.
  restoreBeginJsonFile(file);
}


// ══ ONE RECOVERY INTENT ══
// The Welcome screen used to carry two rows: "Restore from backup" (OS file picker) and "Scan for
// backups" (findAllDeviceBackupFiles). Presenting them as peers asked the person to choose between
// two things they cannot tell apart, at the one moment they are least equipped to — and the Scan
// row could only ever apologise on web, where capPlugin('Filesystem') is absent.
// They are one intent: find my data. This scans the device where that is possible, shows anything
// it finds, and otherwise hands straight over to the file picker — which reaches Downloads, Drive,
// the SD card and everywhere else the scan cannot. An empty scan is no longer a dead end with a
// toast; it says which folders were searched and opens the picker anyway.
// Deliberately bypasses the dismissed-keys filter checkForDetectedBackup() applies: a person who
// presses this is asking to see everything again, including something dismissed earlier.
async function welcomeRestore(){
  const btn = document.getElementById('importBackupBtn');
  const sub = document.getElementById('welcomeRestoreSub');
  // No device to scan (browser/PWA build) — go straight to the picker rather than open a sheet
  // whose only possible outcome is an apology.
  if (!capPlugin('Filesystem')){ triggerBackupImport(); return; }

  const subOriginal = sub && sub.textContent;
  if (sub) sub.textContent = 'Looking on this device\u2026';
  if (btn) btn.classList.add('is-scanning');
  // The sheet opens BEFORE the scan runs, on its own Find step, rather than after it. A readdir()
  // across five folders on a phone with a full Downloads directory is not instant, and the old
  // behaviour — a row that quietly changed its subtitle and then, seconds later, made a banner
  // appear ABOVE the button that had been tapped — is why a scan could look like nothing had
  // happened at all. A sheet sliding up is unmistakably a response to the tap.
  openRestoreSheet(null, { source: 'scan' });
  try {
    const all = await findAllDeviceBackupFiles();
    if (!all.length){
      // Not a dead end and not a sheet full of apology: the picker can reach Downloads, Drive, the
      // SD card and everywhere else the scan cannot, so the sheet steps aside and hands over.
      // (tests/backup-scan.test.js pins this: an empty scan must open the picker.)
      closeRestoreModal();
      showToast('Nothing in ' + backupScanLocationSummary() + ' \u2014 pick a file instead');
      triggerBackupImport();
      return;
    }
    // Labelling a row with what is actually inside it is worth a short wait; peekBackupContents()
    // is size-gated and no-ops on .plotpack, so this can only ever read a handful of small files.
    for (const f of all.slice(0, 8)) await peekBackupContents(f);
    // Deliberately bypasses the dismissed-keys filter checkForDetectedBackup() applies: a person
    // who presses this is asking to see everything again, including something dismissed earlier.
    _detectedBackups = all;
    restoreShowChoose(all);
  } catch(e){
    console.warn('PlotEdge: welcome-screen backup scan failed', e);
    closeRestoreModal();
    showToast('Could not read device storage \u2014 pick a file instead');
    triggerBackupImport();
  } finally {
    if (sub) sub.textContent = subOriginal;
    if (btn) btn.classList.remove('is-scanning');
  }
}


// ══════════════════════════════════════════════════════════════════════════
// MANUAL BACKUP SCAN — Settings › Data › Backup & Restore
// ══════════════════════════════════════════════════════════════════════════
// checkForDetectedBackup() above is deliberately a one-shot: it runs once at boot and only when
// projects.length === 0, so it can never resurrect an old bundle over someone's shoulder mid-survey.
// That leaves no way to look again — after copying a new .plotpack onto the device, after dismissing
// the Welcome banner, or simply because a device already has projects on it and the banner therefore
// never ran at all. This is that on-demand path: a "Scan for backups" button in Backup & Restore that
// calls the same findAllDeviceBackupFiles(), but renders into its own container and keeps its own
// list, so it never touches _detectedBackups or the Welcome banner's dismissed-keys bookkeeping.
let _manualScanBackups = [];

async function scanForBackupsManually(){
  const btn = document.getElementById('scanBackupsBtnPm');
  const out = document.getElementById('manualBackupScanResults');
  if (!out) return;
  if (!capPlugin('Filesystem')){
    out.innerHTML = '<div class="hub-block-desc">Scanning device storage isn\u2019t available in this build.</div>';
    return;
  }
  if (btn){ btn.disabled = true; btn.textContent = 'Scanning\u2026'; }
  out.innerHTML = '<div class="hub-block-desc">Looking in ' + escapeHtml(backupScanLocationSummary()) + '\u2026</div>';
  try {
    _manualScanBackups = await findAllDeviceBackupFiles();
    for (const f of _manualScanBackups.slice(0, 8)) await peekBackupContents(f);
    renderManualScanResults();
  } catch(e){
    console.warn('PlotEdge: manual backup scan failed', e);
    out.innerHTML = '<div class="hub-block-desc">Scan failed. Nothing was changed.</div>';
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = 'Scan for backups'; }
  }
}

function renderManualScanResults(){
  const out = document.getElementById('manualBackupScanResults');
  if (!out) return;
  if (!_manualScanBackups.length){
    // Names the folders rather than saying "no backups found". The scan cannot see a file that
    // arrived by email or Drive and was never saved down, so the honest answer is where it looked
    // plus the picker, which can reach everywhere it cannot.
    out.innerHTML = '<div class="hub-block-desc">No .plotpack or .plotedge.json files in ' +
      escapeHtml(backupScanLocationSummary()) + '. A backup sent by email, chat or Drive will not ' +
      'appear here until it has been saved to the device \u2014 use Restore from backup above to ' +
      'pick it directly.</div>';
    return;
  }
  out.innerHTML = _manualScanBackups.map((f, i) => {
    const dupe = backupLooksAlreadyRestored(f)
      ? '<div class="import-summary-meta" style="color:var(--warn-ink);">Looks like a project already on this device</div>' : '';
    return '<div class="import-summary" style="display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:8px;">' +
      '<div style="min-width:0;">' +
        '<div class="import-summary-title" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(f.name) + '</div>' +
        '<div class="import-summary-meta">' + escapeHtml(describeBackupEntry(f)) + '</div>' + dupe +
      '</div>' +
      '<button class="btn btn-primary" style="flex-shrink:0;margin:0;" onclick="restoreManualScanEntry(' + i + ')">Restore</button>' +
    '</div>';
  }).join('') + '<div id="manualScanImportWizard"></div>';
}

// The Settings-screen scan's per-row action. It used to be a near-copy of the Welcome path —
// read the file, render the legacy confirm wizard into its own inline host, re-wire the buttons —
// which is exactly the duplication that let the two routes drift apart and look different from
// each other. Both now hand the entry to the same sheet, so there is one confirm step, one
// progress report and one finished state in the whole app.
function restoreManualScanEntry(i){
  const entry = _manualScanBackups[i];
  if (!entry) return;
  openRestoreSheet([entry], {
    source: 'manual',
    // Folded out of THIS list only once the person has actually committed — a bundle that fails
    // its checksum, or a confirm step that is cancelled, stays in the list to try again.
    onRestored: () => {
      _manualScanBackups = _manualScanBackups.filter((_, idx) => idx !== i);
      renderManualScanResults();
    }
  });
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


// ═══════════════════════════════════════════════════════════════════════════
// THE RESTORE SHEET
// ═══════════════════════════════════════════════════════════════════════════
// Everything below replaces the inline restore flow that used to happen in the middle of the
// Welcome page.
//
// ══ WHAT WAS WRONG ══
// There was no sheet at all. Three entry points — the device scan, the OS file picker, and the
// boot-time "backup found" banner — each rendered the confirm step straight into
// #foundBackupWizard, a hidden div sitting between the banner and the New project button. So
// choosing a file made a block of body text ("Home · 1 features · 3 feature types · 0 photos ·
// Exported 2026-08-20 · This restores everything into a new project…") plus two full-width
// buttons appear in the page flow, shoving New project, Start from a template and Restore from
// backup down the screen. Nothing animated, nothing was dimmed, and the buttons that appeared sat
// directly above three other buttons that did completely different things. It reads as the page
// breaking rather than as a question being asked — and with two "Restore" affordances a few
// hundred pixels apart, it is genuinely ambiguous which one is being answered.
// Worse, each of the three paths then re-wired those freshly-rendered buttons by hand, so the
// three routes did not even behave identically to one another.
//
// ══ WHAT THIS DOES INSTEAD ══
// One sheet, five steps, strictly one at a time:
//
//     find  →  Looking on this device        (scan running)
//              Choose a backup               (several found)
//     check →  Confirm                       (what is in this file, and what restoring will do)
//     apply →  Restoring                     (determinate progress, no way to cancel mid-write)
//              Restored                      (what actually came back, and what to do next)
//
// The page behind never moves. The header, the close button and the scroll/action layout all come
// from the shared sheet chrome (applySheetChrome() in js/21c-sheet-chrome.js), so this looks and
// behaves like every other sheet in the app, and the X, a backdrop tap and the Android hardware
// Back button all resolve to closeRestoreModal() through closeTopOverlay().
//
// ══ THE ONE INVARIANT ══
// A step that is writing to the store cannot be dismissed. closeRestoreModal() refuses while
// _restoreBusy is set, and the action row hides both buttons for the duration. Restoring is
// additive (importPlotpackBundle() mints a fresh project id and touches nothing existing), so an
// interruption cannot corrupt anything — but it CAN leave a project holding half its photos, with
// no indication that is what happened. Making the write uninterruptible is cheaper than making a
// half-written project explicable.

// Set only while the sheet is driving a restore; null everywhere else, so the Import screen's own
// path through importPlotpackBundle() is completely unaffected. See the progress block in that
// function.
let plotpackProgressHook = null;

let _restoreBusy = false;          // a write is in flight — the sheet cannot be dismissed
let _restoreList = [];             // the entries this sheet was opened with, minus any already done
let _restoreEntry = null;          // the entry currently being confirmed (null for a picked file)
let _restoreSource = null;         // 'scan' | 'detected' | 'manual' | 'file' — only used for copy
let _restoreOnRestored = null;     // caller's bookkeeping, run once a restore actually commits
let _restorePendingJson = null;    // parsed .plotedge.json awaiting confirm (packs use pendingPlotpackImport)
let _restorePrimaryFn = null;
let _restoreSecondaryFn = null;

const RESTORE_ICON_PACK =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><rect x="2" y="4" width="20" height="4" rx="1"/><path d="M10 12h4"/></svg>';
const RESTORE_ICON_JSON =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>';
const RESTORE_ICON_CHEVRON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="9 6 15 12 9 18"/></svg>';
const RESTORE_ICON_SHIELD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const RESTORE_ICON_TICK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="20 6 9 17 4 12"/></svg>';


// ══ SHEET PLUMBING ══
// Four tiny setters rather than one render-the-whole-sheet function. Each step then says only what
// it changes, which is what keeps the steps readable — and it means the header does not flicker
// through a rebuild every time only the body needs to change.

function restoreSetHead(title, sub){
  const t = document.getElementById('restoreTitle');
  const s = document.getElementById('restoreSub');
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
}

// stage is 'find' | 'check' | 'apply'. Anything before the current stage is marked done, so the
// rail reads as a journey with a known length rather than as three lights.
function restoreSetStage(stage){
  const rail = document.getElementById('restoreRail');
  if (!rail) return;
  const order = ['find', 'check', 'apply'];
  const at = order.indexOf(stage);
  rail.querySelectorAll('.restore-rail-step').forEach(el => {
    const i = order.indexOf(el.dataset.stage);
    el.classList.toggle('is-done', i < at);
    el.classList.toggle('is-now', i === at);
  });
}

function restoreSetBody(html){
  const body = document.getElementById('restoreBody');
  if (body) body.innerHTML = html;
}

// Either argument may be null to hide that button. Handlers are held in JS rather than written
// into onclick attributes so a step can close over whatever it needs (an entry, an index, a
// payload) without stringifying it into markup.
function restoreSetActions(primary, secondary){
  const p = document.getElementById('restorePrimary');
  const s = document.getElementById('restoreSecondary');
  const row = document.getElementById('restoreActions');
  _restorePrimaryFn = primary && primary.fn || null;
  _restoreSecondaryFn = secondary && secondary.fn || null;
  if (p){
    p.style.display = primary ? '' : 'none';
    if (primary){ p.textContent = primary.label; p.disabled = !!primary.disabled; }
  }
  if (s){
    s.style.display = secondary ? '' : 'none';
    if (secondary) s.textContent = secondary.label;
  }
  // A row with nothing in it is 45px of empty card and a divider under the content for no reason.
  if (row) row.style.display = (primary || secondary) ? '' : 'none';
}

function restorePrimaryAction(){ if (_restorePrimaryFn) _restorePrimaryFn(); }
function restoreSecondaryAction(){ if (_restoreSecondaryFn) _restoreSecondaryFn(); }


// ══ OPEN / CLOSE ══

// list may be null (the scan opens the sheet before it has anything to show). opts carries
// `source` for copy and `onRestored` for the caller's own list bookkeeping.
function openRestoreSheet(list, opts){
  opts = opts || {};
  _restoreList = Array.isArray(list) ? list.slice() : [];
  _restoreSource = opts.source || 'file';
  _restoreOnRestored = opts.onRestored || null;
  _restoreEntry = null;
  _restorePendingJson = null;
  _restoreBusy = false;
  const el = document.getElementById('restoreModal');
  if (el) el.classList.add('show');
  // One entry is not a choice, it is a confirmation — skip straight to Check. Several is a
  // genuine decision and gets the list, because restoring the wrong one of six old exports is a
  // duplicate project and a cleanup nobody asked for.
  if (_restoreList.length === 1) restoreOpenEntry(_restoreList[0]);
  else if (_restoreList.length) restoreShowChoose(_restoreList);
  else restoreShowScanning();
}

// Asked by closeTopOverlay()'s last-resort sweep, which is the one path that can strip .show off a
// sheet WITHOUT going through that sheet's own close. Everything else respects the refusal inside
// closeRestoreModal() below; this is how the sweep learns to as well.
function restoreIsLocked(){ return !!_restoreBusy; }

function closeRestoreModal(){
  // The one refusal. A write in flight is not interruptible — see the invariant note at the top of
  // this section. Nothing is said out loud: both buttons are already hidden during a write, so the
  // only ways to reach this are the X, a backdrop tap or hardware Back, and silently declining all
  // three for the two seconds a restore takes is less alarming than a toast telling someone their
  // dismissal was refused.
  if (_restoreBusy) return;
  const el = document.getElementById('restoreModal');
  if (el) el.classList.remove('show');
  // A pending pack holds an entire inflated zip. Dropping it here rather than on the next open is
  // the difference between one bundle in memory and every bundle the person has looked at.
  if (pendingPlotpackImport) cancelPlotpackImport();
  _restorePendingJson = null;
  _restoreEntry = null;
  plotpackProgressHook = null;
}


// ══ STEP: FIND (scanning) ══
function restoreShowScanning(){
  restoreSetHead('Restore from backup', 'Looking for backups on this device.');
  restoreSetStage('find');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-spinner"></div>' +
      '<div class="restore-state-title">Searching this device</div>' +
      '<div class="restore-state-sub">Checking ' + escapeHtml(backupScanLocationSummary()) + '.</div>' +
    '</div>');
  restoreSetActions(null, { label: 'Cancel', fn: closeRestoreModal });
}


// ══ STEP: FIND (choose) ══
function restoreShowChoose(list){
  _restoreList = list.slice();
  const n = _restoreList.length;
  restoreSetHead(n + ' backup' + (n === 1 ? '' : 's') + ' found',
    'Newest first. Nothing is changed until you confirm the next step.');
  restoreSetStage('find');
  restoreSetBody(_restoreList.map((f, i) => {
    // Soft note, never a block. Restoring always mints a fresh project id, so a second copy is a
    // nuisance rather than a risk — but silently producing an identical "Ward 7" with no hint of
    // why is a cleanup nobody asked for.
    const dupe = backupLooksAlreadyRestored(f)
      ? '<div class="restore-row-meta restore-row-warn">Looks like a project already on this device</div>' : '';
    const icon = /\.plotpack$/i.test(f.name) ? RESTORE_ICON_PACK : RESTORE_ICON_JSON;
    return '<button type="button" class="restore-row" data-i="' + i + '">' +
      '<span class="restore-row-icon">' + icon + '</span>' +
      '<span class="restore-row-body">' +
        '<span class="restore-row-name">' + escapeHtml(f.name) + '</span>' +
        '<span class="restore-row-meta">' + escapeHtml(describeBackupEntry(f)) + '</span>' + dupe +
      '</span>' +
      '<span class="restore-row-chevron">' + RESTORE_ICON_CHEVRON + '</span>' +
    '</button>';
  }).join(''));
  // Delegated rather than an onclick per row: the index is already on the element, and this way the
  // handler cannot go stale when the list is re-rendered after one entry is restored.
  const body = document.getElementById('restoreBody');
  if (body) body.querySelectorAll('.restore-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = _restoreList[parseInt(btn.dataset.i, 10)];
      if (entry) restoreOpenEntry(entry);
    });
  });
  // The scan cannot see a file that arrived by email or Drive and was never saved down, so the
  // picker stays one tap away rather than being the thing you have to back all the way out to find.
  restoreSetActions({ label: 'Choose a file\u2026', fn: () => { closeRestoreModal(); triggerBackupImport(); } },
                    { label: 'Cancel', fn: closeRestoreModal });
}


// ══ READING ONE ENTRY OFF THE DEVICE ══
// Both file kinds land on the same Check step. The read itself gets its own visible state because
// a .plotedge.json carrying inline base64 photos can run to hundreds of megabytes, and a sheet
// that appears to freeze while it is decoded is indistinguishable from one that has crashed.
async function restoreOpenEntry(entry){
  _restoreEntry = entry;
  const Filesystem = capPlugin('Filesystem');
  if (!Filesystem || !Filesystem.readFile){ restoreShowError('Could not reach device storage.'); return; }

  restoreSetHead('Opening backup', escapeHtml(entry.name));
  restoreSetStage('check');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-spinner"></div>' +
      '<div class="restore-state-title">Reading the file</div>' +
      '<div class="restore-state-sub">Checking it is complete and undamaged before anything is written.</div>' +
    '</div>');
  restoreSetActions(null, { label: 'Cancel', fn: restoreBackToList });

  try {
    const res = await Filesystem.readFile({ path: entry.path || (EXPORT_DIR + '/' + entry.name), directory: entry.dir });
    const base64 = res && res.data;
    if (!base64) throw new Error('empty read');

    if (/\.plotpack$/i.test(entry.name)){
      const bytes = atob(base64);
      const arr = new Uint8Array(bytes.length);
      for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
      const file = new File([arr], entry.name, { type: PLOTPACK_MIME });
      await restorePreparePack(file);
    } else {
      const text = decodeURIComponent(escape(atob(base64)));
      restorePrepareJson(text, entry.name);
    }
  } catch(e){
    console.warn('PlotEdge: restore read failed', e);
    restoreShowError('Could not read that backup file.');
  }
}

// Cancel from a per-file step goes back to the list where there is one, and closes the sheet where
// there is not — backing out of a single-file confirm into an empty list would be a dead screen.
function restoreBackToList(){
  if (pendingPlotpackImport) cancelPlotpackImport();
  _restorePendingJson = null;
  _restoreEntry = null;
  if (_restoreList.length > 1) restoreShowChoose(_restoreList);
  else closeRestoreModal();
}


// ══ PREPARING A .plotpack ══
// preparePlotpackImport() does the real work — JSZip parse, manifest and format-version check,
// per-part SHA-256 verification — and reports its own failures by toast. It also insists on
// rendering its legacy confirm markup into a host element, so it is pointed at #restoreWizardSink
// (display:none) and that render is discarded: the sheet builds its own summary from
// pendingPlotpackImport instead. Rendering the old buttons and then re-wiring them is exactly what
// the three old paths did, and it is why they drifted apart.
async function restorePreparePack(file){
  await preparePlotpackImport(file, 'restoreWizardSink');
  const sink = document.getElementById('restoreWizardSink');
  if (sink) sink.innerHTML = '';
  if (!pendingPlotpackImport){
    // preparePlotpackImport() has already said why by toast — damaged bundle, wrong format, needs
    // a newer PlotEdge. Repeating its reasoning here would mean keeping two copies of the same
    // list of failure modes in step with each other.
    restoreShowError('That bundle could not be opened.');
    return;
  }
  if (pendingPlotpackImport.settings) restoreShowSettingsConfirm();
  else restoreShowPackConfirm(file.name);
}

// Entry point for a .plotpack chosen from the OS picker rather than found by a scan.
async function restoreBeginFile(file){
  openRestoreSheet(null, { source: 'file' });
  restoreSetHead('Opening backup', file.name);
  restoreSetStage('check');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-spinner"></div>' +
      '<div class="restore-state-title">Reading the file</div>' +
      '<div class="restore-state-sub">Checking it is complete and undamaged before anything is written.</div>' +
    '</div>');
  restoreSetActions(null, { label: 'Cancel', fn: closeRestoreModal });
  try { await restorePreparePack(file); }
  catch(e){
    console.warn('PlotEdge: restore file read failed', e);
    restoreShowError('Could not read that bundle. It may be damaged.');
  }
}

// Same, for a .plotedge.json chosen from the picker.
function restoreBeginJsonFile(file){
  openRestoreSheet(null, { source: 'file' });
  restoreSetHead('Opening backup', file.name);
  restoreSetStage('check');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-spinner"></div>' +
      '<div class="restore-state-title">Reading the file</div>' +
      '<div class="restore-state-sub">Checking it is a PlotEdge backup before anything is written.</div>' +
    '</div>');
  restoreSetActions(null, { label: 'Cancel', fn: closeRestoreModal });
  const reader = new FileReader();
  reader.onload = () => restorePrepareJson(String(reader.result || ''), file.name);
  reader.onerror = () => restoreShowError('Could not read that file.');
  reader.readAsText(file);
}


// ══ PREPARING A .plotedge.json ══
// Identical validation to handleBackupImportFile() in js/17-export.js — same version gate, same
// two payload kinds. What is different is that it no longer imports on sight: a JSON backup is
// additive and so has nothing destructive to confirm, but "nothing to confirm" is not the same as
// "nothing to show". On a fresh device this is the moment someone most needs to be told what they
// are about to get back, and a toast after the fact is not that.
function restorePrepareJson(text, label){
  let payload;
  try { payload = JSON.parse(text); }
  catch(e){ restoreShowError('That backup file is not valid JSON.'); return; }
  if (!payload || payload.peBackup !== PE_BACKUP_VERSION || !payload.kind){
    restoreShowError('That is not a PlotEdge backup file.'); return;
  }
  const metas = payload.kind === 'project' ? [payload.project]
              : payload.kind === 'all' ? (payload.projects || []) : null;
  if (!metas){ restoreShowError('Unrecognised backup type.'); return; }
  const list = metas.filter(Boolean);
  if (!list.length){ restoreShowError('That backup contained no projects.'); return; }

  const features = list.reduce((n, m) => n + (((payload.data || {})[m.id] || {}).savedFeatures || []).length, 0);
  const photos = list.reduce((n, m) => {
    const saved = ((payload.data || {})[m.id] || {}).savedFeatures || [];
    return n + saved.reduce((k, f) =>
      k + (f.photos || []).length + (f.vertices || []).reduce((j, v) => j + (v.photos || []).length, 0), 0);
  }, 0);

  _restorePendingJson = { payload, metas: list, label };
  restoreShowJsonConfirm({ label, list, features, photos });
}


// ══ STEP: CHECK ══
// The counts are the whole reason this step exists: it is the one moment someone can tell whether
// the file they picked is the survey they think it is. So they are figures, not a sentence —
// "148" registers at a glance in a way that "148 features · 3 feature types · 96 photos" does not.
function restoreStatsHtml(stats){
  return '<div class="restore-stats">' + stats.map(s =>
    '<div class="restore-stat">' +
      '<div class="restore-stat-n">' + escapeHtml(String(s[0])) + '</div>' +
      '<div class="restore-stat-l">' + escapeHtml(s[1]) + '</div>' +
    '</div>').join('') + '</div>';
}

function restoreNoteHtml(html, warn){
  return '<div class="restore-note' + (warn ? ' is-warn' : '') + '">' +
    '<span class="restore-note-icon">' + RESTORE_ICON_SHIELD + '</span><span>' + html + '</span></div>';
}

function restoreShowPackConfirm(fileName){
  const m = pendingPlotpackImport.manifest;
  const c = m.counts || {};
  const name = (m.project && m.project.name) || 'PlotEdge bundle';
  const when = (m.exportedAt || '').slice(0, 10);
  restoreSetHead('Check this backup', 'Nothing on this device has been changed yet.');
  restoreSetStage('check');
  const stats = [[c.features || 0, 'Features'], [c.featureTypes || 0, 'Types'], [c.photos || 0, 'Photos']];
  if (c.sketches) stats.push([c.sketches, 'Sketches']);
  // v1 always creates a NEW project. Merging into an open one means deciding what to do about
  // colliding feature ids and same-id-different-fields schemas, and getting that wrong silently
  // corrupts a live survey. A duplicate project is a nuisance; a corrupted one is lost work.
  const card = '<div class="restore-card">' +
      '<div class="restore-card-name">' + escapeHtml(name) + '</div>' +
      '<div class="restore-card-file">' + escapeHtml(fileName || (_restoreEntry && _restoreEntry.name) || 'PlotPack') +
        (when ? ' \u00b7 exported ' + escapeHtml(when) : '') + '</div>' +
      restoreStatsHtml(stats) +
    '</div>';

  // ══ YOU ALREADY HAVE THIS ONE ══
  // Restoring always mints a new project, which is the right default — it can never overwrite work
  // — but it also means restoring the same file twice silently produces two identical projects,
  // and on a device holding several old exports that is easy to do and tedious to undo.
  // So an exact re-restore stops being the default action rather than being merely warned about.
  // Not blocked outright: a crew that genuinely wants a scratch copy to experiment on should be
  // able to have one, and refusing would be deciding something only they can. The escape hatch is
  // just no longer the button under your thumb.
  const twin = findRestoredTwin(pendingPlotpackImport.manifest);
  if (twin && twin.grade === 'same-export'){
    const twinName = twin.project.name || '(unnamed)';
    const twinWhen = (twin.project.restoredFrom.restoredAt || '').slice(0, 10);
    restoreSetHead('Already on this device', 'Nothing has been changed.');
    restoreSetStage('check');
    restoreSetBody(card + restoreNoteHtml(
      'You restored this exact backup' + (twinWhen ? ' on ' + escapeHtml(twinWhen) : '') +
      ', as <strong>' + escapeHtml(twinName) + '</strong>. Restoring it again would make a second ' +
      'copy \u2014 the one you already have is not touched either way.', true));
    // The useful action is the one that gets them to the data they already have.
    restoreSetActions({ label: 'Open \u201c' + twinName + '\u201d', fn: () => {
        closeRestoreModal();
        if (typeof openProject === 'function') openProject(twin.project.id);
      } },
      { label: 'Restore a second copy', fn: restoreCommit });
    return;
  }

  // Same project, different export — a later backup of something already here. Legitimate and
  // common (restore Tuesday's version alongside Monday's), so this only says so; the primary action
  // is unchanged.
  const olderNote = twin ? restoreNoteHtml(
    'A different backup of this project is already on this device, as <strong>' +
    escapeHtml(twin.project.name || '(unnamed)') + '</strong>. This one will come in beside it, not ' +
    'over it.', true) : '';

  restoreSetBody(card +
    restoreNoteHtml('This restores everything \u2014 schema, photos, per-vertex data and notes \u2014 into a ' +
      '<strong>new project</strong>. Nothing already on this device is touched.') + olderNote);
  restoreSetActions({ label: 'Restore as a new project', fn: restoreCommit },
                    { label: 'Cancel', fn: restoreBackToList });
}

function restoreShowSettingsConfirm(){
  const n = Object.keys(pendingPlotpackImport.settings || {}).length;
  const when = ((pendingPlotpackImport.manifest || {}).exportedAt || '').slice(0, 10);
  restoreSetHead('Check these settings', 'Nothing on this device has been changed yet.');
  restoreSetStage('check');
  restoreSetBody(
    '<div class="restore-card">' +
      '<div class="restore-card-name">Device settings pack</div>' +
      '<div class="restore-card-file">' + escapeHtml((_restoreEntry && _restoreEntry.name) || 'settings.plotpack') +
        (when ? ' \u00b7 exported ' + escapeHtml(when) : '') + '</div>' +
      restoreStatsHtml([[n, 'Settings']]) +
    '</div>' +
    // Warn-toned because this one genuinely overwrites something, unlike every other path here.
    restoreNoteHtml('This <strong>replaces</strong> this device\u2019s preferences: theme, units, basemap, ' +
      'quick actions and similar. No projects or photos are touched. Publishing access tokens are ' +
      'never included in a pack, so you will need to re-enter yours.', true));
  restoreSetActions({ label: 'Apply these settings', fn: restoreCommit },
                    { label: 'Cancel', fn: restoreBackToList });
}

function restoreShowJsonConfirm(info){
  const names = info.list.map(m => m.name).filter(Boolean);
  restoreSetHead('Check this backup', 'Nothing on this device has been changed yet.');
  restoreSetStage('check');
  restoreSetBody(
    '<div class="restore-card">' +
      '<div class="restore-card-name">' +
        escapeHtml(names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? '\u2026' : '') : 'JSON backup') +
      '</div>' +
      '<div class="restore-card-file">' + escapeHtml(info.label || 'backup.plotedge.json') + '</div>' +
      restoreStatsHtml([[info.list.length, 'Projects'], [info.features, 'Features'], [info.photos, 'Photos']]) +
    '</div>' +
    restoreNoteHtml('Each project comes back under a <strong>new project</strong> of its own. ' +
      'Nothing already on this device is touched.'));
  restoreSetActions({ label: info.list.length === 1 ? 'Restore as a new project' : 'Restore ' + info.list.length + ' projects', fn: restoreCommit },
                    { label: 'Cancel', fn: restoreBackToList });
}


// ══ STEP: APPLY ══
function restoreShowWorking(title, sub){
  restoreSetHead('Restoring', 'This can take a moment. Please keep the app open.');
  restoreSetStage('apply');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-spinner"></div>' +
      '<div class="restore-state-title">' + escapeHtml(title) + '</div>' +
      '<div class="restore-state-sub" id="restoreWorkingSub">' + escapeHtml(sub || '') + '</div>' +
      '<div class="restore-bar"><div class="restore-bar-fill" id="restoreBarFill"></div></div>' +
    '</div>');
  // Both buttons gone for the duration. There is nothing to decide during a write, and an enabled
  // Cancel that cannot actually stop a half-finished loop is worse than no Cancel at all.
  restoreSetActions(null, null);
}

function restoreSetProgress(done, total){
  const fill = document.getElementById('restoreBarFill');
  const sub = document.getElementById('restoreWorkingSub');
  // A bundle with no photos still completes its bar rather than sitting at zero and looking stuck.
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  if (fill) fill.style.width = pct + '%';
  if (sub) sub.textContent = total > 0
    ? 'Photo ' + Math.min(done + (done < total ? 1 : 0), total) + ' of ' + total
    : 'Writing features and schema';
}

// The one place that commits. Everything above it is reading and asking; everything below it is
// reporting.
async function restoreCommit(){
  if (_restoreBusy) return;
  _restoreBusy = true;
  const entry = _restoreEntry;
  try {
    if (_restorePendingJson){
      restoreShowWorking('Writing projects', 'Restoring saved features and photos');
      // Yielded to once so the sheet actually paints its Restoring step before the synchronous
      // import loop below blocks the main thread. Without it, a large JSON backup jumps straight
      // from Check to Restored and the progress step is never seen.
      await new Promise(r => setTimeout(r, 30));
      const { payload, metas } = _restorePendingJson;
      const ids = metas.map(meta => importOneBackupProject(meta, (payload.data || {})[meta.id])).filter(Boolean);
      restoreSetProgress(1, 1);
      if (!ids.length){ restoreShowError('That backup contained no projects.'); return; }
      persistStore();
      refreshProjectsScreen();
      restoreShowDone('Restored', ids.length + ' project' + (ids.length === 1 ? '' : 's') +
        ' are back on this device. Open them from Projects.');
    } else if (pendingPlotpackImport){
      const isSettings = !!pendingPlotpackImport.settings;
      restoreShowWorking(isSettings ? 'Applying settings' : 'Writing project',
        isSettings ? 'Restoring this device\u2019s preferences' : 'Restoring photos, then features');
      // Only hooked for the duration of this one call, and cleared in the finally below, so the
      // Import screen's own restores are never reporting into a sheet that is not on screen.
      plotpackProgressHook = restoreSetProgress;
      await new Promise(r => setTimeout(r, 30));
      const res = await runPendingPlotpackImport();
      if (res && res.ok === false){ restoreShowError('Restore failed. Nothing was changed.'); return; }
      if (isSettings){
        // importDeviceSettings() raises its own restart prompt, which is a second sheet on top of
        // this one — so this one gets out of the way rather than sitting behind it.
        closeRestoreModal();
        return;
      }
      const missing = (res && res.missing) || 0;
      restoreShowDone('Restored',
        ((res && res.features) || 0) + ' feature' + (((res && res.features) || 0) === 1 ? '' : 's') +
        ' and ' + ((res && res.photos) || 0) + ' photo' + (((res && res.photos) || 0) === 1 ? '' : 's') +
        ' are back. Open the project from Projects.' +
        (missing ? ' ' + missing + ' photo' + (missing === 1 ? ' was' : 's were') + ' not in the bundle.' : ''));
    } else {
      restoreShowError('Nothing to restore.');
      return;
    }
    // Bookkeeping runs only once something has actually committed — a cancelled confirm or a
    // damaged bundle leaves the entry in whichever list it came from, to try again.
    if (entry) removeDetectedBackupEntry(entry);
    if (_restoreOnRestored){ try { _restoreOnRestored(); } catch(e) {} }
    if (entry) _restoreList = _restoreList.filter(f => backupFileKey(f) !== backupFileKey(entry));
  } catch(e){
    console.warn('PlotEdge: restore commit failed', e);
    restoreShowError('Restore failed. Nothing was changed.');
  } finally {
    _restoreBusy = false;
    plotpackProgressHook = null;
    _restorePendingJson = null;
    _restoreEntry = null;
  }
}


// ══ STEP: DONE ══
function restoreShowDone(title, sub){
  restoreSetHead('Restored', 'Your data is back on this device.');
  restoreSetStage('apply');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-tick">' + RESTORE_ICON_TICK + '</div>' +
      '<div class="restore-state-title">' + escapeHtml(title) + '</div>' +
      '<div class="restore-state-sub">' + escapeHtml(sub) + '</div>' +
    '</div>');
  // A device holding several old exports is the normal case for a crew reinstalling, not the odd
  // one, so finishing one offers the next rather than making them start the whole flow again.
  const more = _restoreList.length > 1;
  restoreSetActions({ label: 'Done', fn: closeRestoreModal },
    more ? { label: 'Restore another', fn: () => restoreShowChoose(_restoreList) } : null);
}


// ══ STEP: ERROR ══
// Always reachable backwards. A failure that strands someone on a dead sheet is the same dead end
// the old "no backups found" toast was.
function restoreShowError(msg){
  restoreSetHead('Could not restore', 'Nothing on this device was changed.');
  restoreSetBody(
    '<div class="restore-state">' +
      '<div class="restore-state-title">' + escapeHtml(msg) + '</div>' +
      '<div class="restore-state-sub">The file may be damaged, or it may have been written by a ' +
        'newer version of PlotEdge. Try another backup, or pick a file directly.</div>' +
    '</div>');
  restoreSetActions({ label: 'Choose a file\u2026', fn: () => { closeRestoreModal(); triggerBackupImport(); } },
    _restoreList.length > 1 ? { label: 'Back', fn: () => restoreShowChoose(_restoreList) }
                            : { label: 'Close', fn: closeRestoreModal });
}
