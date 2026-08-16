// ═══════════════════════════════════════════════════════════════════════════
// PlotEdge — Toast, undo toast, confirm modal
// ═══════════════════════════════════════════════════════════════════════════
// Part of an ordered set: js/*.js are plain classic scripts loaded in filename
// order by index.html. Order matters — a file can only use top-level names
// declared in itself or in a file loaded before it. Renumbering or reordering
// them will break the app; `npm test` checks this.


// ══ TOAST ══
let tt;

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('show'),2800);}


// ══ UNDO TOAST ══
// Soft-delete pattern for deleteFeature/deletePoint/deleteVertexPhoto/deleteProject: the delete
// happens immediately (no blocking confirm needed for single-item deletes in the field), then a
// toast offers a few seconds to Undo before it's permanent. Only one undo is live at a time —
// starting a new one silently commits whichever delete preceded it.
let _undoTimer = null, _undoPending = null;

function showUndoToast(msg, restoreFn, duration){
  const t = document.getElementById('undoToast');
  if (!t){ showToast(msg); return; }
  _undoPending = restoreFn;
  document.getElementById('undoToastMsg').textContent = msg;
  t.classList.add('show');
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(()=>{ t.classList.remove('show'); _undoPending=null; }, duration||6000);
}

function undoLastDelete(){
  const t = document.getElementById('undoToast');
  t.classList.remove('show');
  clearTimeout(_undoTimer);
  const fn = _undoPending;
  _undoPending = null;
  if (fn) fn();
}

(function(){ const btn = document.getElementById('undoToastBtn'); if (btn) btn.addEventListener('click', undoLastDelete); })();


// Wire up swipe-to-delete once — the containers are static, only their innerHTML is re-rendered.
attachSwipeToDelete('pointsList', '.point-item', deletePoint);

attachSwipeToDelete('vertexPhotoGrid', '.photo-cell', deleteVertexPhoto);


// ══ CONFIRM MODAL ══
// Replaces window.confirm(), which some mobile webviews / installed-PWA contexts
// silently block or swallow — making buttons that rely on it appear "not working".
let _confirmCallback = null;

let _confirmCancelCallback = null;

// onCancel is optional and fires on Cancel / backdrop / Back / X — anything that
// dismisses without confirming. Needed by the crash-recovery prompt, which has
// to be able to drop the draft when the answer is "no", or it would re-ask on
// every single project open.
function showConfirm(message, onConfirm, okLabel, tone, onCancel){
  document.getElementById('confirmModalMsg').textContent = message;
  const okBtn = document.getElementById('confirmModalOk');
  okBtn.textContent = okLabel || 'Delete';
  okBtn.classList.remove('tone-danger','tone-default');
  okBtn.classList.add(tone === 'default' ? 'tone-default' : 'tone-danger');
  _confirmCallback = onConfirm;
  _confirmCancelCallback = onCancel || null;
  document.getElementById('confirmModal').classList.add('show');
}

function closeConfirmModal(result){
  document.getElementById('confirmModal').classList.remove('show');
  const cb = _confirmCallback, cancelCb = _confirmCancelCallback;
  _confirmCallback = null; _confirmCancelCallback = null;
  if (result) { if (cb) cb(); }
  else if (cancelCb) cancelCb();
}
