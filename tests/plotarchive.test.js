'use strict';
// Covers the four things added in this pass, and the one that was quietly broken before it:
//
//   1. PLOTARCHIVE — the preset feature type library. The risk here is not that the catalogue is
//      wrong, it is that a preset produces a feature type shaped SLIGHTLY differently from one
//      built in the editor: a missing `scope`, a condition pointing at a label instead of an id,
//      a calculated expression naming a field that was never generated. All of those look fine in
//      the picker and fail on the Collect form, which is the worst place to find out.
//   2. SYMBOLOGY REACHING EVERY SURFACE — four renderers were drawing their own colours and
//      ignoring the feature type's shape, line style and fill. A grep-shaped check is the only
//      thing that stops a fifth being added the same way.
//   3. THE TEMPLATE PROJECT — the first thing most people see the app do, so it has to actually
//      demonstrate the schema engine rather than three types with two text boxes.
//   4. IMPORT — .plotpack was reachable but described nowhere, which is indistinguishable from
//      unsupported.
const fs = require('fs');
const path = require('path');
const { ROOT, readShell } = require('./lib');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const shell = readShell();
const archiveSrc = read('js/03b-plotarchive.js');

// ══════════════════════════════════════════════════════════════════════════════
// PLOTARCHIVE
// ══════════════════════════════════════════════════════════════════════════════

// The catalogue is plain data with no dependencies, so it can be evaluated on its own rather than
// booting the whole app — which keeps this suite fast and means a failure points at the catalogue
// rather than at whatever else was mid-boot.
function loadCatalogue() {
  const vm = require('vm');
  const ctx = { };
  vm.createContext(ctx);
  // Everything up to the first function declaration is the two const tables.
  const cut = archiveSrc.indexOf('function plotarchiveFieldId');
  vm.runInContext(archiveSrc.slice(0, cut) + '\nthis.CAT = PLOTARCHIVE; this.CATS = PLOTARCHIVE_CATEGORIES;', ctx);
  return { entries: ctx.CAT, cats: ctx.CATS };
}

const { entries, cats } = loadCatalogue();

check('the catalogue is big enough to be worth opening', () => {
  // A library of five is a list; the point is arriving with the common case already built.
  assert(entries.length >= 20, `only ${entries.length} presets`);
  assert(cats.length >= 5, `only ${cats.length} categories`);
});

check('every preset is internally consistent', () => {
  const seen = new Set();
  const VALID_TYPES = new Set(['text','textarea','number','boolean','single_select','multi_select','date','barcode','calculated','repeat_group']);
  entries.forEach(e => {
    assert(e.id && !seen.has(e.id), `duplicate or missing preset id: ${e.id}`);
    seen.add(e.id);
    assert(e.name && e.blurb, `${e.id} is missing a name or blurb`);
    assert(cats.some(c => c.id === e.cat), `${e.id} sits in unknown category "${e.cat}"`);
    assert(Array.isArray(e.geometryTypes) && e.geometryTypes.length, `${e.id} permits no geometry`);
    e.geometryTypes.forEach(g => assert(['point','line','polygon'].includes(g), `${e.id}: bad geometry ${g}`));
    assert(/^#[0-9A-Fa-f]{6}$/.test(e.color), `${e.id} has no explicit colour`);
    assert(['circle','square','triangle'].includes(e.shape), `${e.id}: bad shape ${e.shape}`);
    assert(['solid','dashed','dotted'].includes(e.lineStyle), `${e.id}: bad line style ${e.lineStyle}`);
    assert(e.fields.length, `${e.id} has no fields — a preset with no schema saves nobody anything`);
    e.fields.forEach(f => {
      assert(VALID_TYPES.has(f[1]), `${e.id}/${f[0]}: unknown field type ${f[1]}`);
      // A choice field with no choices is refused by saveFeatureType(), so a preset that shipped
      // one could be added and then never saved again from the editor.
      if (f[1] === 'single_select' || f[1] === 'multi_select') {
        assert((f[2] || []).length, `${e.id}/${f[0]} is a choice field with no choices`);
      }
      if (f[1] === 'repeat_group') {
        assert(((f[3] || {}).subfields || []).length, `${e.id}/${f[0]} is a repeating group with no sub-fields`);
      }
    });
  });
});

check('every condition and calculation names a field that exists in its own preset', () => {
  // ══ THE FAILURE THIS CATCHES ══
  // Conditions and expressions in the catalogue refer to other fields BY LABEL, because the ids do
  // not exist until the type is built. A typo therefore cannot fail at load — it produces a
  // condition whose controlling field is never found, which plotarchiveBuildField() drops, leaving
  // a field that should have been conditional permanently visible; or a calculated expression with
  // a bare English phrase in it, which evaluates to nothing forever.
  const bad = [];
  entries.forEach(e => {
    const labels = new Set(e.fields.map(f => f[0]));
    e.fields.forEach(f => {
      const x = f[3] || {};
      if (x.condition && !labels.has(x.condition.on)) {
        bad.push(`${e.id}/${f[0]} is conditional on "${x.condition.on}", which is not a field in this preset`);
      }
      if (f[1] === 'calculated') {
        assert(Array.isArray(x.expr) && x.expr.length, `${e.id}/${f[0]} is calculated but has no expression`);
        x.expr.forEach(tok => {
          // A string token is either a known field label or an operator. Anything else is a typo
          // that would be emitted into the expression verbatim.
          if (typeof tok === 'string' && !labels.has(tok) && !/^[-+*/()]$/.test(tok)) {
            bad.push(`${e.id}/${f[0]}: expression token "${tok}" is neither a field nor an operator`);
          }
        });
      }
    });
  });
  assert(!bad.length, bad.join('\n        '));
});

check('a boolean condition is written against the value the form actually stores', () => {
  // Boolean fields store 'Yes'/'No', not true/false — a condition written as `value: true` would
  // compare against a string and never fire. Cheap to get wrong, invisible until somebody in the
  // field wonders why a follow-up question never appears.
  const bad = [];
  entries.forEach(e => {
    const byLabel = {};
    e.fields.forEach(f => { byLabel[f[0]] = f; });
    e.fields.forEach(f => {
      const c = (f[3] || {}).condition;
      if (!c) return;
      const on = byLabel[c.on];
      if (on && on[1] === 'boolean' && !['Yes', 'No'].includes(c.value)) {
        bad.push(`${e.id}/${f[0]} tests boolean "${c.on}" against ${JSON.stringify(c.value)} — should be 'Yes' or 'No'`);
      }
    });
  });
  assert(!bad.length, bad.join('\n        '));
});

check('the library covers every geometry, and shows off multi-geometry', () => {
  const geos = new Set(entries.flatMap(e => e.geometryTypes));
  ['point', 'line', 'polygon'].forEach(g => assert(geos.has(g), `no preset captures a ${g}`));
  assert(entries.some(e => e.geometryTypes.length > 1),
    'no preset permits more than one geometry — the multi-geometry feature is undiscoverable');
  assert(entries.some(e => e.fill === false),
    'no preset is outline-only, so fill:false is never demonstrated');
  assert(entries.some(e => e.lineStyle !== 'solid'), 'every preset is solid — line style is never shown');
  assert(new Set(entries.map(e => e.shape)).size > 1, 'every preset is the same point shape');
});

check('the library demonstrates every schema feature the editor can produce', () => {
  // The value of a preset library is arriving with the fields RIGHT, and the features people
  // never find on their own are exactly the ones worth shipping pre-wired.
  const all = entries.flatMap(e => e.fields);
  const has = pred => all.some(pred);
  assert(has(f => (f[3] || {}).required), 'no preset marks a field required');
  assert(has(f => (f[3] || {}).condition), 'no preset uses skip logic');
  assert(has(f => (f[3] || {}).scope === 'vertex'), 'no preset scopes a field per-vertex');
  assert(has(f => f[1] === 'calculated'), 'no preset uses a calculated field');
  assert(has(f => f[1] === 'repeat_group'), 'no preset uses a repeating group');
  assert(has(f => f[1] === 'barcode'), 'no preset uses a barcode field');
});

check('a preset becomes an ordinary feature type, not a special one', () => {
  // The design constraint: there is no such thing as an "archive type" at rest. If anything
  // downstream started branching on archiveId, a preset type would begin behaving differently
  // from a hand-built one and the library would stop being a shortcut and start being a mode.
  const readers = fs.readdirSync(path.join(ROOT, 'js'))
    .filter(f => f !== '03b-plotarchive.js')
    .filter(f => /archiveId/.test(read('js/' + f)));
  assert(!readers.length, `archiveId is read outside the library by: ${readers.join(', ')}`);
});

check('the built field carries every key the editor writes', () => {
  // saveFeatureType() writes exactly these. A preset missing one produces a type that renders or
  // validates differently — `scope` undefined is the dangerous one, since effectiveFieldScope()
  // would then decide per call site.
  const fn = archiveSrc.slice(archiveSrc.indexOf('function plotarchiveBuildField'),
                              archiveSrc.indexOf('// expr is a small token array'));
  ['id:', 'label,', 'type,', 'options:', 'required:', 'placeholder:', 'scope:', 'condition:', 'expression:', 'subfields:']
    .forEach(k => assert(fn.includes(k), `plotarchiveBuildField does not write ${k}`));
  // The literal in the source is `type === 'repeat_group' ? 'feature' : (...)`, so the closing
  // quote sits between the name and the `?`.
  assert(/repeat_group'\s*\?\s*'feature'/.test(fn),
    'a repeating group is not forced to feature scope, as the editor does');
});

check('adding is all-or-nothing', () => {
  // Same rule as finalizeSaveFeature(): if the write is refused, put everything back. A half-added
  // batch leaves the crew guessing which of the five they picked survived.
  const fn = archiveSrc.slice(archiveSrc.indexOf('function plotarchiveAddSelected'));
  assert(/const before = featureTypes\.slice\(\)/.test(fn), 'no rollback snapshot is taken');
  assert(/persist\(\) === false/.test(fn), 'the return value of persist() is ignored');
  assert(/featureTypes = before/.test(fn), 'a refused write is not rolled back');
});

check('PlotArchive is wired into creating a feature type, not only into the list', () => {
  // ══ WHY THE SECOND ENTRY POINT EXISTS ══
  // The list-screen button is only reachable BEFORE deciding to build a type. Somebody who taps
  // "New feature type" first and only then thinks "there is probably a ready-made pole" had to
  // back out of the form, lose it, add from the list, and reopen what they had just left. The
  // editor row is the same catalogue in a mode where picking FILLS THE OPEN FORM rather than
  // creating anything, so Save stays where it was.
  assert(/id="ftArchiveRow"/.test(shell), 'the feature type editor has no PlotArchive row');
  assert(/openPlotArchiveForEditor\(\)/.test(shell), 'the editor row does not open the library');
  const schema = read('js/03-schema.js');
  // Creating shows it; editing an existing type must not, or the row is an invitation to
  // overwrite the user's own fields sitting directly above them.
  assert(/setFtArchiveRowVisible\(true\)/.test(schema), 'newFeatureType does not reveal the row');
  assert(/setFtArchiveRowVisible\(false\)/.test(schema), 'editFeatureType does not hide the row');

  const src = read('js/03b-plotarchive.js');
  assert(/function plotarchiveLoadIntoEditor/.test(src), 'there is no editor-fill path');
  const load = src.slice(src.indexOf('function plotarchiveLoadIntoEditor'), src.indexOf('// ══ ADDING ══'));
  // The whole point is that it commits nothing.
  assert(!/persist\(\)/.test(load), 'loading a preset into the form writes to storage');
  assert(!/featureTypes\.push/.test(load), 'loading a preset into the form creates a feature type');
  // It must reuse the shared builder, or a loaded preset and an added one can diverge.
  assert(/plotarchiveToFeatureType\(/.test(load), 'the editor path builds its own type instead of reusing the builder');
  ['editingFtFields', 'editingFtColor', 'editingFtShape', 'editingFtLineStyle', 'editingFtFill']
    .forEach(v => assert(load.includes(v), `the editor path does not set ${v}`));
  assert(/setFtGeo\(built\.geometryTypes, true\)/.test(load), 'the preset geometries are not reflected in the form');
  // A name the user already typed is theirs.
  assert(/!nameEl\.value\.trim\(\)/.test(load), 'loading a preset overwrites a name the user typed');
  // The sheet's button routes through the mode, so it cannot add when it says it will load.
  assert(/plotarchiveCommit\(\)/.test(shell), 'the sheet button bypasses the mode router');
  assert(/plotarchiveMode === 'editor'/.test(src), 'the two modes are not distinguished');
});

check('PlotArchive is reachable, cached and explained', () => {
  assert(/<script src="js\/03b-plotarchive\.js">/.test(shell), 'the module is never loaded');
  assert(/css\/11-plotarchive\.css/.test(shell), 'the stylesheet is never loaded');
  const sw = read('plotedge-sw.js');
  assert(sw.includes('js/03b-plotarchive.js') && sw.includes('css/11-plotarchive.css'),
    'the new files are not in the offline shell cache — an offline launch would 404 on them');
  assert(/openPlotArchive\(\)/.test(shell), 'nothing in the UI opens it');
  assert(/id="plotarchiveModal"/.test(shell), 'the sheet markup is missing');
  // Back must close it by name, or closePlotArchive()'s keyboard dismissal never runs.
  assert(/plotarchiveModal/.test(read('js/07-navigation.js')), 'Back does not know about the sheet');
  assert(/plotarchive:/.test(read('js/21a-plotwords.js')), 'the name has no glossary entry');
});

// ══════════════════════════════════════════════════════════════════════════════
// SYMBOLOGY REACHES EVERY SURFACE
// ══════════════════════════════════════════════════════════════════════════════

check('no renderer hard-codes a colour where a feature type has one', () => {
  // ══ THE BUG THIS PINS ══
  // The Collect shape preview drew every feature in the accent colour and the Collect satellite
  // map drew every line in --orange, whatever the feature type said. Both looked deliberate, so
  // both survived several passes over that file — the crew only found out after saving, when
  // Review and PlotAtlas drew the same feature differently.
  const geo = read('js/09-geometry.js');
  const preview = geo.slice(geo.indexOf('function updateShapePreview'), geo.indexOf('// ══ VERTEX SATELLITE MAP ══'));
  assert(/featureTypeSymbol\(/.test(preview), 'the shape preview does not resolve the type symbol');
  assert(/leafletDashArray\(/.test(preview), 'the shape preview cannot draw a dashed type');
  assert(/sym\.filled/.test(preview), 'the shape preview ignores fill:false');
  assert(/shapeMarkup\(sym\.shape/.test(preview), 'preview vertices are always circles');

  const vmap = geo.slice(geo.indexOf('function renderVertexMap'));
  assert(/featureTypeSymbol\(/.test(vmap), 'the satellite map does not resolve the type symbol');
  assert(!/cssVar\('--orange'\)/.test(vmap), 'the satellite map still hard-codes orange');
});

check('every list that names a feature type draws its real symbol', () => {
  // A geometry character (●/—/▱) says what SHAPE the geometry is, which the vertex count already
  // says. It cannot show a dashed outline-only parcel, so the lists and the map disagreed.
  assert(/legendGlyphSvg\(/.test(read('js/12-review.js')), 'Review cards show no symbol');
  assert(/legendGlyphSvg\(/.test(read('js/03-schema.js')), 'the feature type manager shows no symbol');
  assert(/legendGlyphSvg\(/.test(read('js/13-dashboard.js')), 'dashboard recent activity shows no symbol');
});

check('every map surface honours shape, line style and fill', () => {
  // The four accessors are the contract. A surface that draws features and calls none of them is
  // a surface inventing its own symbology.
  const surfaces = {
    'js/14-map.js': 'the Review map',
    'js/14a-plotatlas.js': 'PlotAtlas',
    'js/21-webmap.js': 'the exported web map',
    'js/17a-plansheet.js': 'the plan sheet'
  };
  Object.keys(surfaces).forEach(f => {
    const src = read(f);
    assert(/featureTypeLineStyle\(/.test(src), `${surfaces[f]} ignores line style`);
    assert(/featureTypeShape\(|pdfDashPattern\(/.test(src), `${surfaces[f]} ignores point shape`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE TEMPLATE PROJECT
// ══════════════════════════════════════════════════════════════════════════════

check('the template demonstrates the schema engine, not just three text boxes', () => {
  const src = read('js/05-projects.js');
  const fn = src.slice(src.indexOf('function createTemplateProject'), src.indexOf('const TEMPLATE_PROJECT_NOTES'));
  assert((fn.match(/id: uid\('ft'\)/g) || []).length >= 5, 'the template ships fewer than five feature types');
  assert(/required: ?true/.test(fn), 'nothing in the template is required');
  assert(/condition:\s*\{/.test(fn), 'the template never demonstrates skip logic');
  assert(/'calculated'/.test(fn), 'the template never demonstrates a calculated field');
  assert(/scope: ?'vertex'/.test(fn), 'the template never demonstrates a per-vertex field');
  assert(/'repeat_group'/.test(fn), 'the template never demonstrates a repeating group');
  assert(/'barcode'/.test(fn), 'the template never demonstrates a barcode field');
  assert(/fill: false/.test(fn), 'no template type is outline-only');
  assert(/lineStyle: 'dashed'|lineStyle: 'dotted'/.test(fn), 'every template type is solid');
  assert(/geometryTypes: \['polygon', ?'point'\]/.test(fn), 'the template has no multi-geometry type');
});

check('the template explains itself in a place that survives a handoff', () => {
  const src = read('js/05-projects.js');
  assert(/notes: TEMPLATE_PROJECT_NOTES/.test(src), 'the template ships no notes');
  const notes = src.slice(src.indexOf('const TEMPLATE_PROJECT_NOTES'));
  ['skip logic', 'repeating group', 'vertex', 'calculated'].forEach(w =>
    assert(new RegExp(w, 'i').test(notes), `the template notes never mention ${w}`));
});

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT
// ══════════════════════════════════════════════════════════════════════════════

check('the Import screen says PlotPack can be imported', () => {
  // ══ THE GAP THIS CLOSES ══
  // preparePlotpackImport() has always worked and the general file picker has always accepted the
  // extension. But the only card describing that picker was headed "Import data" and said "a .gpkg
  // or .csv file captured in QGIS, ArcGIS, or another field app". The app's own native format —
  // the one the export screen calls "the format to send to a colleague" — was named nowhere on the
  // screen that receives it, which to anyone holding a .plotpack is indistinguishable from not
  // being supported.
  const panel = shell.slice(shell.indexOf('id="panel-import"'), shell.indexOf('id="panel-export"'));
  assert(/PlotPack/.test(panel), 'the Import panel never mentions PlotPack');
  assert(/id="plotpackFileInput"/.test(panel), 'there is no dedicated PlotPack picker');
  assert(/handlePlotpackFileChosen/.test(panel), 'the PlotPack picker is not wired up');
  assert(/settings pack/i.test(panel), 'settings packs are never mentioned, so they cannot be found');
  assert(/id="plotpackImportWizard"/.test(panel), 'the PlotPack card has nowhere to show its summary');
});

check('a PlotPack summarises itself in whichever card was used', () => {
  // Two pickers accept the format. Dropping the summary into the other card would read as nothing
  // having happened at all.
  const src = read('js/17b-plotpack.js');
  assert(/function plotpackWizardHost/.test(src), 'the wizard still targets one hard-coded host');
  assert(/hostId/.test(src), 'the chosen host is not carried on the pending import');
  assert(/preparePlotpackImport\(file, 'importWizard'\)/.test(read('js/18-import.js')),
    'the general picker does not name its own host');
  // Cancel must wipe BOTH, since the pending import that named the host is gone by then.
  const cancel = src.slice(src.indexOf('function cancelPlotpackImport'));
  assert(/\['plotpackImportWizard', 'importWizard'\]/.test(cancel), 'cancel leaves a stale summary behind');
});

check('no user-facing copy still leans on an em dash', () => {
  // ══ WHAT COUNTS AS USER-FACING ══
  // Code commentary is exempt: it is written for whoever maintains this, not shown to anybody.
  // What IS checked is every string the app can render and every text node and attribute in the
  // shell. The em dash survives in exactly one role, as a GLYPH: the no-data placeholder in a KPI
  // or coordinate box, and the icon on the Line geometry picker. Both are recognised by having no
  // whitespace between the dash and the markup or quote around it, which is the same test the
  // rewrite used. ">—<" is a placeholder; "</code> — compare" was prose and is now punctuated.
  const bad = [];
  const isGlyph = (str, at) => {
    const before = str.slice(0, at);
    return before === '' || /[>"'“(\[=]$/.test(before);
  };
  // The shell, minus comments, <script> and <style>.
  let vis = shell
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  for (let i = 0; i < vis.length; i++) {
    if (vis[i] === '—' && !isGlyph(vis, i)) {
      bad.push('index.html: …' + vis.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' '));
    }
  }
  // Every string and template literal in every module.
  const acorn = require('acorn');
  fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).forEach(f => {
    const src = read('js/' + f);
    const toks = [];
    try { acorn.parse(src, { ecmaVersion: 2022, onToken: toks }); } catch (e) { return; }
    toks.filter(t => t.type.label === 'string' || t.type.label === 'template').forEach(t => {
      // An HTML comment inside a template is commentary too.
      const seg = src.slice(t.start, t.end).replace(/<!--[\s\S]*?-->/g, '');
      for (let i = 0; i < seg.length; i++) {
        if (seg[i] === '—' && !isGlyph(seg, i)) {
          bad.push('js/' + f + ': …' + seg.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' '));
        }
      }
    });
  });
  assert(!bad.length, `${bad.length} em dash(es) left in copy:\n        ${bad.slice(0, 12).join('\n        ')}`);
});

check('the no-data glyph and the Line icon survived the em dash sweep', () => {
  // The other half of the rule above. Stripping these would have been the easy way to pass it and
  // would have blanked every KPI and coordinate readout in the app.
  assert((shell.match(/>—</g) || []).length >= 8, 'the no-data placeholders were stripped');
  assert(/>— Line</.test(shell), 'the Line geometry picker lost its icon');
  assert(/'—'/.test(read('js/08-gps.js')), 'the GPS readouts lost their no-data glyph');
});

check('the glossary describes the module it actually names', () => {
  // ══ THE ERROR THIS CAUGHT ══
  // PlotVault's entry read "Photo storage. Where your photos are kept and backed up." That is the
  // device photo store (js/04a-photostore.js), a different module entirely. PlotVault reads
  // reference layers out of a bucket over HTTP range requests and cannot write anything at all,
  // so anyone following the old wording would have opened it looking for their photos and found a
  // URL box. Pinned here because a glossary is the one place a wrong description is authoritative.
  const words = read('js/21a-plotwords.js');
  const vault = words.slice(words.indexOf('plotvault: {'), words.indexOf('plotlens: {'));
  assert(!/photo/i.test(vault), 'the PlotVault entry still describes photo storage');
  assert(/reference|read/i.test(vault), 'the PlotVault entry does not say what it reads');
  // And the quick action that opens it has to agree.
  const reg = read('js/16-geometry-math.js');
  const entry = reg.slice(reg.indexOf("{ id:'plotvault'"), reg.indexOf("{ id:'plotvault'") + 400);
  assert(!/Push and pull/i.test(entry), 'the PlotVault action still claims it can write');
});

check('the app does not claim an importer it has never had', () => {
  // handleImportFileChosen() accepts plotpack, csv and gpkg. GeoJSON is an EXPORT format here, and
  // the Import action description had borrowed it from that list.
  const reg = read('js/16-geometry-math.js');
  const entry = reg.slice(reg.indexOf("{ id:'import'"), reg.indexOf("{ id:'export'"));
  assert(!/GeoJSON/.test(entry), 'the Import action still advertises GeoJSON import, which does not exist');
});

module.exports = results;
if (require.main === module) {
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
    if (!r.ok) bad++;
  }
  console.log(`\n  plotarchive: ${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
}
