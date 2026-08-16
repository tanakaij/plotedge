'use strict';
// Executes the real photo pipeline from index.html against instrumented stubs,
// so "only one image is in flight" is measured rather than asserted by reading
// the code. This is the path that was killing the app when several photos were
// added to one vertex.
const vm = require('vm');
const { readIndex } = require('./lib');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch(e => results.push({ name, ok: false, msg: e.message }));
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const html = readIndex();
const i = html.indexOf('// ══ PHOTO:BEGIN ══'), j = html.indexOf('// ══ PHOTO:END ══');

async function main() {
  if (i === -1 || j === -1) {
    results.push({ name: 'photo block is extractable for testing', ok: false, msg: 'PHOTO:BEGIN/PHOTO:END sentinels not found' });
    return;
  }
  results.push({ name: 'photo block is extractable for testing', ok: true });
  const src = html.slice(i, j);

  // Instrumented environment. Tracks how many decodes are alive at once and
  // whether every decoded bitmap and canvas is released.
  function boot(opts = {}) {
    const stats = { live: 0, peakLive: 0, opened: 0, closed: 0, canvases: 0, released: 0, toasts: [], saves: 0 };
    const mkCanvas = () => {
      stats.canvases++;
      let w = 0, h = 0;
      return {
        get width() { return w; }, set width(v) { w = v; if (v === 0) stats.released += 0.5; },
        get height() { return h; }, set height(v) { h = v; if (v === 0) stats.released += 0.5; },
        getContext: () => ({ drawImage() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }), save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {} }),
        toDataURL: () => 'data:image/jpeg;base64,' + 'x'.repeat(64)
      };
    };
    const ctx = {
      console: { error() {}, warn() {}, log() {} },
      Date, Math, JSON, Object, Array, String, Number, Promise, Error, isNaN, parseInt,
      setTimeout, clearTimeout,
      document: { createElement: tag => (tag === 'canvas' ? mkCanvas() : { style: {}, classList: { add() {}, remove() {}, toggle() {} } }), getElementById: () => null, querySelectorAll: () => [] },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      // The whole point: decoding is async and we count overlap.
      createImageBitmap: async () => {
        stats.opened++; stats.live++;
        stats.peakLive = Math.max(stats.peakLive, stats.live);
        await new Promise(r => setTimeout(r, 5));
        return {
          width: 4000, height: 3000,
          close() { stats.closed++; stats.live--; }
        };
      },
      showToast: m => stats.toasts.push(m),
      getWatermarkPref: () => false,
      drawPhotoWatermark: () => {},
      queuePhotoForBackup: () => {},
      queuePhotoForRecognition: () => {},
      getStorageUsageInfo: () => ({ bytes: 0, percent: opts.percent || 10 }),
      persist: () => { stats.saves++; return opts.persistFails ? false : true; },
      renderVertexPhotos: () => {}, renderPoints: () => {}, updateCaptureStrip: () => {},
      lastCompassHeading: 90,
      openVertexIndex: 0,
      currentVertices: [{ lat: 1, lon: 2, photos: [] }],
      _stats: stats
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'photo-block' });
    return ctx;
  }

  // ── the crash ────────────────────────────────────────────────────────────
  await check('ten photos at once decode ONE at a time, not ten', async () => {
    const ctx = boot();
    const files = Array.from({ length: 10 }, (_, n) => ({ name: `p${n}.jpg`, size: 4e6 }));
    ctx.handleVertexPhotos({ target: { files, value: 'x' } });
    await ctx.photoQueueIdle();
    assert(ctx._stats.opened === 10, `expected 10 decodes, got ${ctx._stats.opened}`);
    assert(ctx._stats.peakLive === 1,
      `peak concurrent decodes was ${ctx._stats.peakLive} — each holds a full-resolution bitmap, so this is the OOM`);
  });

  await check('every decoded bitmap is released, not left to the garbage collector', async () => {
    const ctx = boot();
    const files = Array.from({ length: 6 }, (_, n) => ({ name: `p${n}.jpg` }));
    ctx.handleVertexPhotos({ target: { files, value: 'x' } });
    await ctx.photoQueueIdle();
    assert(ctx._stats.closed === ctx._stats.opened,
      `${ctx._stats.opened} bitmaps decoded but only ${ctx._stats.closed} closed`);
  });

  await check('source files are never read into full-resolution data URLs', () => {
    const block = html.slice(i, j);
    assert(!/readAsDataURL/.test(block),
      'handleVertexPhotos still converts each File to a base64 string before decoding — that is ~5.5 MB per 12 MP photo held at once');
    assert(/createImageBitmap/.test(block), 'no createImageBitmap path, so images decode at full resolution first');
  });

  await check('all ten photos actually land on the vertex', async () => {
    const ctx = boot();
    const files = Array.from({ length: 10 }, (_, n) => ({ name: `p${n}.jpg` }));
    ctx.handleVertexPhotos({ target: { files, value: 'x' } });
    await ctx.photoQueueIdle();
    assert(ctx.currentVertices[0].photos.length === 10,
      `expected 10 photos stored, got ${ctx.currentVertices[0].photos.length} — serialising must not drop any`);
  });

  // ── memory in the lists ──────────────────────────────────────────────────
  await check('each photo gets a small thumbnail for list rendering', async () => {
    const ctx = boot();
    await ctx.addVertexPhoto({ name: 'a.jpg' }, 'a.jpg', true);
    const p = ctx.currentVertices[0].photos[0];
    assert(p && p.thumbUrl, 'no thumbUrl generated — lists decode the full 1200px image per photo');
    assert(p.dataUrl, 'full-resolution image was not kept for the lightbox and exports');
  });

  await check('lists and grids render the thumbnail, not the full image', () => {
    // The two full-screen viewers are meant to use the full image: the lightbox
    // and the PlotLens stage are the whole reason the 1200px copy is kept.
    // Everything else draws at 40-120px and must not decode a 4.3 MB bitmap.
    const FULL_SCREEN_OK = ['pl-frame', 'lightboxImg'];
    const bad = [...html.matchAll(/.{160}<img[^>]*src="\$\{(?:r\.)?p\.dataUrl\}/gs)]
      .filter(m => !FULL_SCREEN_OK.some(ok => m[0].includes(ok)));
    assert(bad.length === 0, `${bad.length} list <img> tags still point at the full-resolution dataUrl`);
    assert(/function photoThumbSrc/.test(html), 'no photoThumbSrc() helper');
    assert(/thumbUrl \|\| p\.dataUrl|p\.thumbUrl \|\| p\.dataUrl/.test(html),
      'photoThumbSrc has no fallback, so photos captured before thumbnails existed would render blank');
  });

  // ── limits and failure handling ──────────────────────────────────────────
  await check('a runaway session is capped rather than silently filling storage', async () => {
    const ctx = boot();
    const files = Array.from({ length: 30 }, (_, n) => ({ name: `p${n}.jpg` }));
    ctx.handleVertexPhotos({ target: { files, value: 'x' } });
    await ctx.photoQueueIdle();
    assert(ctx.currentVertices[0].photos.length === 24,
      `expected the 24-photo cap to hold, got ${ctx.currentVertices[0].photos.length}`);
    assert(ctx._stats.toasts.some(t => /cap/i.test(t)), 'the cap was applied without telling the user why');
  });

  await check('photos are refused before encoding when storage is nearly full', async () => {
    const ctx = boot({ percent: 95 });
    await ctx.addVertexPhoto({ name: 'a.jpg' }, 'a.jpg', true);
    assert(ctx._stats.opened === 0, 'the image was decoded before the storage check, wasting the memory anyway');
    assert(ctx.currentVertices[0].photos.length === 0, 'a photo was added despite storage being nearly full');
  });

  await check('a photo that cannot be saved is rolled back off the screen', async () => {
    const ctx = boot({ persistFails: true });
    await ctx.addVertexPhoto({ name: 'a.jpg' }, 'a.jpg', true);
    assert(ctx.currentVertices[0].photos.length === 0,
      'the photo stayed on screen after the save was refused — the display and the disk disagree');
  });

  await check('the fallback decode path does not leak the original photo', async () => {
    // Without createImageBitmap the source Blob is exposed via an object URL,
    // which pins the ENTIRE full-size photo in memory until it is revoked.
    // One leak per capture is invisible per shot and fatal over a session.
    const ctx = boot();
    ctx.createImageBitmap = undefined;
    let made = 0, revoked = 0;
    ctx.URL = { createObjectURL: () => { made++; return 'blob:' + made; }, revokeObjectURL: () => { revoked++; } };
    ctx.Image = function () {
      const self = this;
      setTimeout(() => { self.width = 4000; self.height = 3000; self.onload && self.onload(); }, 1);
      return self;
    };
    for (let n = 0; n < 5; n++) await ctx.addVertexPhoto({ name: 'a.jpg' }, 'a.jpg', true);
    await ctx.photoQueueIdle();
    assert(made === 5, `expected 5 object URLs, got ${made}`);
    assert(revoked === made, `${made} object URLs created but only ${revoked} revoked — each pins a full-size photo`);
  });

  await check('a corrupt image fails loudly instead of vanishing', async () => {
    const ctx = boot();
    ctx.createImageBitmap = async () => { throw new Error('decode failed'); };
    await ctx.addVertexPhoto({ name: 'bad.jpg' }, 'bad.jpg', false);
    await ctx.photoQueueIdle();
    assert(ctx._stats.toasts.some(t => /could not be processed/i.test(t)),
      'a failed decode was swallowed silently');
  });

  await check('one bad photo does not stall the rest of the queue', async () => {
    const ctx = boot();
    let n = 0;
    const good = ctx.createImageBitmap;
    ctx.createImageBitmap = async (...a) => { if (++n === 2) throw new Error('bad'); return good(...a); };
    const files = Array.from({ length: 4 }, (_, k) => ({ name: `p${k}.jpg` }));
    ctx.handleVertexPhotos({ target: { files, value: 'x' } });
    await ctx.photoQueueIdle();
    assert(ctx.currentVertices[0].photos.length === 3,
      `expected 3 of 4 to survive one bad file, got ${ctx.currentVertices[0].photos.length}`);
  });
}

main().then(() => {
  module.exports = results;
  if (require.main === module) {
    let bad = 0;
    for (const r of results) {
      console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : '\n        ' + r.msg}`);
      if (!r.ok) bad++;
    }
    console.log(`\n  photos: ${results.length - bad}/${results.length} passed`);
    process.exit(bad ? 1 : 0);
  }
});
