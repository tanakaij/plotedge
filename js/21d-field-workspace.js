let quickEntryEnabled = true,
  fieldReviewFilter = "",
  fieldReviewIndex = new Map(),
  fieldReviewPage = 0,
  fieldTablePage = 0;
const FIELD_PAGE_SIZE = 30;
function syncInlineFieldVisibility() {
  if (!quickEntryEnabled) return;
  document
    .querySelectorAll("#quickAttributeFields .attr-pane")
    .forEach((p, i) => {
      const f = attrSheetFields[i];
      p.hidden = !!(f && hiddenAttrIds.has(f.id));
    });
}
function applyQuickEntry() {
  const fields = document.getElementById("attrFields"),
    target = document.getElementById(
      quickEntryEnabled ? "quickAttributeFields" : "attrFieldsHome",
    );
  if (fields && target && fields.parentElement !== target)
    target.appendChild(fields);
  const summary = document.getElementById("attrSummary");
  if (summary) summary.hidden = quickEntryEnabled;
  document
    .querySelectorAll("#attrFields .attr-pane")
    .forEach((p) => (p.hidden = false));
  const b = document.getElementById("quickEntryToggle");
  if (b) {
    b.textContent = quickEntryEnabled
      ? "One field at a time"
      : "Show all fields";
    b.setAttribute("aria-pressed", String(quickEntryEnabled));
  }
  syncInlineFieldVisibility();
}
function toggleQuickEntry() {
  quickEntryEnabled = !quickEntryEnabled;
  localStorage.setItem("plotedge-quick-entry", String(quickEntryEnabled));
  closeAttrSheet();
  applyQuickEntry();
}
function fieldSaveStatus() {
  const e = document.getElementById("fieldSaveStatus");
  if (!e) return;
  const p = projects.find((p) => p.id === activeProjectId),
    name = document.getElementById("fieldProjectName");
  if (name) name.textContent = p ? p.name : "Choose a project";
  const s =
      typeof recordStore !== "undefined"
        ? recordStore.status()
        : { active: false },
    online = navigator.onLine !== false;
  let label = s.pending
    ? "Saving to device…"
    : s.error
      ? "Device save needs attention"
      : "Saved on device";
  if (!activeProjectId) label = "Choose a project to collect";
  else if (!s.pending && !s.error && readDraft(activeProjectId))
    label = "Draft saved on device";
  const endpoint = getCloudEndpoint(),
    q = loadUploadQueue(),
    backup = endpoint
      ? q.length
        ? `${q.length} photo backup${q.length === 1 ? "" : "s"} pending`
        : "Photo backup queue clear"
      : "Cloud backup not configured";
  const exported =
    p && p.lastBundleExportedAt
      ? "Project bundle exported " + timeAgo(p.lastBundleExportedAt)
      : "Project bundle not yet exported";
  e.dataset.state = s.error ? "error" : s.pending ? "pending" : "saved";
  e.innerHTML = `<span class="field-status-dot" aria-hidden="true"></span><div><strong>${escapeHtml(label)}</strong><span>${online ? "Online" : "Offline"} · ${escapeHtml(backup)} · ${escapeHtml(exported)}</span></div>${s.error ? '<button onclick="retryDeviceSave()">Retry save</button>' : ""}`;
}
async function retryDeviceSave() {
  const ok = await recordStore.retry();
  fieldSaveStatus();
  showToast(
    ok
      ? "Records saved to device"
      : "Save is still blocked. Export a backup and check free storage.",
  );
}
function fieldMissingRequired(f) {
  const fields = resolveFeatureType(f).fields || [],
    attrs = f.attrs || {},
    empty = (v) =>
      v == null ||
      v === "" ||
      (Array.isArray(v) && !v.length) ||
      (typeof v === "number" && !Number.isFinite(v));
  const missing = (a, values) => {
    if (!fieldConditionMet(a, values)) return false;
    const v = values[a.id];
    if (a.required && empty(v)) return true;
    return (
      a.type === "repeat_group" &&
      Array.isArray(v) &&
      v.some((row) =>
        (a.subfields || []).some((sub) => sub.required && empty(row[sub.id])),
      )
    );
  };
  return fields.some((a) =>
    featureFieldScope(a, f) === "vertex"
      ? (f.vertices || []).some((v) => missing(a, { ...attrs, ...v.attrs }))
      : missing(a, attrs),
  );
}
function buildFieldReviewIndex() {
  const index = new Map(),
    refs = new Map();
  savedFeatures.forEach((f) => {
    const k = String(f.ref || "")
      .trim()
      .toLowerCase();
    if (k) refs.set(k, (refs.get(k) || 0) + 1);
  });
  savedFeatures.forEach((f) => {
    const issues = [],
      v = f.vertices || [],
      g = f.geometryType || "point",
      min = g === "polygon" ? 3 : g === "line" ? 2 : 1;
    if (
      v.length < min ||
      v.some(
        (p) =>
          !Number.isFinite(p.lat) ||
          !Number.isFinite(p.lon) ||
          Math.abs(p.lat) > 90 ||
          Math.abs(p.lon) > 180,
      )
    )
      issues.push("Missing or invalid geometry");
    if (fieldMissingRequired(f)) issues.push("Required answers are missing");
    if (v.some((p) => p.acc != null && p.acc > 15))
      issues.push("GPS accuracy exceeds 15 m");
    if (
      refs.get(
        String(f.ref || "")
          .trim()
          .toLowerCase(),
      ) > 1
    )
      issues.push("Reference ID is used more than once");
    if (g === "polygon" && v.length <= 500) {
      let crosses = false;
      for (let i = 0; i < v.length && !crosses; i++)
        for (let j = i + 2; j < v.length; j++) {
          if (i === 0 && j === v.length - 1) continue;
          if (
            pmSegmentsCross(
              v[i],
              v[(i + 1) % v.length],
              v[j],
              v[(j + 1) % v.length],
            )
          ) {
            crosses = true;
            break;
          }
        }
      if (crosses) issues.push("Boundary crosses itself");
    }
    if ((f.scans || []).some((s) => s.units === "unknown"))
      issues.push("Scan measurement units are not set");
    index.set(f.id, issues);
  });
  fieldReviewIndex = index;
  return index;
}
function fieldReviewState(f) {
  return (fieldReviewIndex.get(f.id) || []).length ||
    f.reviewStatus === "needs_attention"
    ? "attention"
    : f.reviewStatus === "reviewed"
      ? "reviewed"
      : "collected";
}
function fieldReviewPass(f) {
  return !fieldReviewFilter || fieldReviewState(f) === fieldReviewFilter;
}
function setFieldReviewFilter(v) {
  fieldReviewFilter = v;
  fieldReviewPage = fieldTablePage = 0;
  renderFeatures();
}
function renderFieldReviewBar() {
  const e = document.getElementById("fieldReviewBar");
  if (!e) return;
  buildFieldReviewIndex();
  const c = { attention: 0, collected: 0, reviewed: 0 };
  savedFeatures.forEach((f) => c[fieldReviewState(f)]++);
  e.innerHTML =
    '<div><span class="field-eyebrow">QUALITY REVIEW</span><h2>Make every record ready</h2></div><div class="review-status-tabs">' +
    [
      ["", "All records", savedFeatures.length],
      ["attention", "Needs attention", c.attention],
      ["collected", "Collected", c.collected],
      ["reviewed", "Reviewed", c.reviewed],
    ]
      .map(
        ([k, l, n]) =>
          `<button class="${fieldReviewFilter === k ? "active" : ""}" aria-pressed="${fieldReviewFilter === k}" onclick="setFieldReviewFilter('${k}')">${l}<span>${n}</span></button>`,
      )
      .join("") +
    '</div><button class="field-text-button" onclick="markSelectedReviewed()">Mark selected table rows reviewed</button>';
}
function fieldReviewCardHtml(f) {
  const state = fieldReviewState(f),
    issues = fieldReviewIndex.get(f.id) || [],
    label = {
      attention: "Needs attention",
      collected: "Collected",
      reviewed: "Reviewed",
    }[state],
    id = escapeHtml(JSON.stringify(f.id));
  return `<div class="record-review-row"><span class="record-status ${state}">${label}</span><button class="field-text-button" onclick="setFeatureReview(${id},'${state === "reviewed" ? "collected" : "reviewed"}')">${state === "reviewed" ? "Reopen review" : "Mark reviewed"}</button></div>${issues.length ? `<ul class="record-issues">${issues.map((i) => "<li>" + escapeHtml(i) + "</li>").join("")}</ul>` : ""}${scanAttachmentHtml(f.scans, f.id)}`;
}
async function setFeatureReview(id, value) {
  const f = savedFeatures.find((f) => String(f.id) === String(id));
  if (!f) return;
  buildFieldReviewIndex();
  if (value === "reviewed" && (fieldReviewIndex.get(f.id) || []).length) {
    showToast("Resolve the listed issues before marking this record reviewed.");
    return;
  }
  f.reviewStatus = value;
  f.reviewedAt = value === "reviewed" ? new Date().toISOString() : null;
  plotmateTouch(f, "ft");
  const ok =
    persist() !== false && (!recordStore.active || (await recordStore.flush()));
  renderFeatures();
  fieldSaveStatus();
  if (!ok) showToast("Review change is pending a successful device save.");
}
async function markSelectedReviewed() {
  if (typeof attrSelection === "undefined" || !attrSelection.size) {
    showToast("Select records using the checkboxes in Table view first.");
    return;
  }
  buildFieldReviewIndex();
  let changed = 0,
    skipped = 0;
  savedFeatures.forEach((f) => {
    if (!attrSelection.has(f.id)) return;
    if ((fieldReviewIndex.get(f.id) || []).length) {
      skipped++;
      return;
    }
    f.reviewStatus = "reviewed";
    f.reviewedAt = new Date().toISOString();
    plotmateTouch(f, "ft");
    changed++;
  });
  const ok =
    persist() !== false && (!recordStore.active || (await recordStore.flush()));
  renderFeatures();
  showToast(
    ok
      ? `${changed} reviewed${skipped ? " · " + skipped + " need attention" : ""}`
      : "Review changes are pending a successful save.",
  );
}
function fieldPageRows(rows, table) {
  const pages = Math.max(1, Math.ceil(rows.length / FIELD_PAGE_SIZE));
  if (table) fieldTablePage = Math.min(fieldTablePage, pages - 1);
  else fieldReviewPage = Math.min(fieldReviewPage, pages - 1);
  const p = table ? fieldTablePage : fieldReviewPage;
  return rows.slice(p * FIELD_PAGE_SIZE, (p + 1) * FIELD_PAGE_SIZE);
}
function fieldPager(total, table) {
  if (total <= FIELD_PAGE_SIZE) return "";
  const p = table ? fieldTablePage : fieldReviewPage,
    pages = Math.ceil(total / FIELD_PAGE_SIZE);
  return `<div class="field-pager"><button ${p === 0 ? "disabled" : ""} onclick="changeFieldPage(-1,${!!table})">Previous</button><span>${p * FIELD_PAGE_SIZE + 1}–${Math.min(total, (p + 1) * FIELD_PAGE_SIZE)} of ${total}</span><button ${p === pages - 1 ? "disabled" : ""} onclick="changeFieldPage(1,${!!table})">Next</button></div>`;
}
function changeFieldPage(d, table) {
  if (table) {
    fieldTablePage = Math.max(0, fieldTablePage + d);
    renderAttributeTable();
  } else {
    fieldReviewPage = Math.max(0, fieldReviewPage + d);
    renderFeatures();
  }
  document
    .getElementById(table ? "attrTableWrap" : "featuresList")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}
function initFieldWorkspace() {
  try {
    quickEntryEnabled =
      localStorage.getItem("plotedge-quick-entry") !== "false";
  } catch (_) {}
  applyQuickEntry();
  renderScanAttachments();
  fieldSaveStatus();
  window.addEventListener("plotedge-storage", fieldSaveStatus);
  window.addEventListener("online", fieldSaveStatus);
  window.addEventListener("offline", fieldSaveStatus);
  document.addEventListener("keydown", (e) => {
    const overlay = document.getElementById("scanViewerOverlay");
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeScanViewer();
    }
    if (e.key === "Tab") {
      const list = [
        ...overlay.querySelectorAll(
          "button:not([disabled]),select:not([disabled])",
        ),
      ].filter((el) => el.offsetParent !== null);
      const first = list[0],
        last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  document
    .getElementById("scanViewerOverlay")
    .addEventListener("click", (e) => {
      if (e.target.id === "scanViewerOverlay") closeScanViewer();
    });
}
