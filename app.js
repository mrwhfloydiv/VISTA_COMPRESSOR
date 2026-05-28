// ============================================================
// Vista PDF — Merge & Compress
// All processing happens client-side. Files never leave the browser.
// ============================================================

const { PDFDocument, StandardFonts, rgb } = PDFLib;

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

// ----- State -----
const state = {
  files: [],              // [{ id, file, name, size, thumbDataUrl, pageCount, color }]
  pages: [],              // [{ id, fileId, fileName, color, originalIndex, thumbDataUrl }]
  pagesBuilt: false,      // true once state.pages has been populated for the current files
  preset: 'recommended',
  resultBlob: null,
  resultName: null,
  resultMergedBytes: 0,   // size of the merged-but-not-compressed PDF (for Sankey)
  resultFinalBytes: 0,    // size after compression
  resultOriginalTotal: 0, // sum of input file sizes (for Sankey & stats)
  resultCompressedBytes: 0, // size after Ghostscript, before OCR (for honest deltas)
  resultOcrEnabled: false,  // was the searchable toggle on for this run?
};

// Distinct stripe colors assigned to source files in the page editor
const FILE_COLORS = [
  '#b22c2e', // Vista red
  '#2563eb', // blue
  '#ebaa1f', // Vista yellow
  '#16a34a', // green
  '#9333ea', // purple
  '#ea580c', // orange
  '#0d9488', // teal
  '#db2777', // pink
  '#1e40af', // deep blue
  '#65a30d', // lime
];
function colorForIndex(i) { return FILE_COLORS[i % FILE_COLORS.length]; }

let nextId = 1;

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const browseBtn = $('browseBtn');
const addMoreBtn = $('addMoreBtn');
const clearAllBtn = $('clearAllBtn');
const fileStrip = $('fileStrip');
const stripTrack = $('stripTrack');
const stripCount = $('stripCount');
const compressionPanel = $('compressionPanel');
const processBtn = $('processBtn');
const resultPanel = $('resultPanel');
const downloadBtn = $('downloadBtn');
const restartBtn = $('restartBtn');
const continueToEditBtn = $('continueToEditBtn');
const continueToCompressBtn = $('continueToCompressBtn');
const editResetBtn = $('editResetBtn');
const editUndoBtn = $('editUndoBtn');
const pageGrid = $('pageGrid');
const pageCount = $('pageCount');
const fileLegend = $('fileLegend');
const pageRenderProgress = $('pageRenderProgress');
const pageRenderLabel = $('pageRenderLabel');
const pageRenderFill = $('pageRenderFill');
const pageZoomModal = $('pageZoomModal');
const pageZoomImage = $('pageZoomImage');
const pageZoomMeta = $('pageZoomMeta');
const pageZoomCloseBtn = $('pageZoomCloseBtn');
const pageZoomRemoveBtn = $('pageZoomRemoveBtn');
const insertContextMenu = $('insertContextMenu');
const insertFileInput = $('insertFileInput');
const heroBlock = $('heroBlock');
const stepStrip = $('stepStrip');
const busyOverlay = $('busyOverlay');
const busyText = $('busyText');
const busySub = $('busySub');
const busyProgress = $('busyProgress');
const busyProgressFill = $('busyProgressFill');
const busyProgressMeta = $('busyProgressMeta');

// ============================================================
// STAGE MACHINE — DROP → REARRANGE → COMPRESS → RESULT
// ============================================================
// All four stages live in the DOM at once. Only the active one is
// display:block; transitions are CSS animations (stageIn / stageOut).
// The step strip and grid background never change — only the stage
// content crossfades.

const STAGES = ['drop', 'rearrange', 'edit', 'compress', 'result'];
let currentStage = 'drop';
let stageTransition = null; // promise-of-current-transition

function getStageEl(name) { return document.querySelector(`.stage[data-stage="${name}"]`); }
function getStepEl(name)  { return document.querySelector(`.step[data-step="${name}"]`); }

function updateStepStrip(name) {
  const targetIdx = STAGES.indexOf(name);
  STAGES.forEach((s, i) => {
    const el = getStepEl(s);
    if (!el) return;
    el.classList.toggle('active', i === targetIdx);
    el.classList.toggle('done',   i  <  targetIdx);
  });
  updateStepLocks();
}

// Lock/unlock steps based on what state allows visiting them
function updateStepLocks() {
  const hasFiles = state.files.length > 0;
  const hasPages = state.pages.length > 0;
  const hasResult = state.resultBlob != null;
  const map = {
    drop: false,                       // always reachable
    rearrange: !hasFiles,              // need a queue
    edit:      !hasFiles,              // need files (pages auto-build on entry)
    compress:  !hasFiles || (state.pagesBuilt && !hasPages),  // need files; if pages built, need ≥1 page
    result:    !hasResult,             // need an actual result to view
  };
  STAGES.forEach(s => {
    const el = getStepEl(s);
    if (el) el.classList.toggle('locked', map[s]);
  });
}

// Wire step strip for navigation
document.querySelectorAll('.step[data-step]').forEach(step => {
  step.addEventListener('click', () => {
    if (step.classList.contains('locked')) return;
    if (step.classList.contains('active')) return;
    goToStage(step.dataset.step);
  });
});

async function goToStage(name) {
  if (name === currentStage) return;
  if (!STAGES.includes(name)) return;

  // Serialize transitions if one is in flight
  if (stageTransition) await stageTransition;

  stageTransition = (async () => {
    const oldEl = getStageEl(currentStage);
    const newEl = getStageEl(name);

    // Hero collapses on any stage > 'drop', re-expands on return
    heroBlock.classList.toggle('collapsed', name !== 'drop');

    // Update step strip immediately so the active pulse moves with the transition
    updateStepStrip(name);

    // Fade out current
    if (oldEl && oldEl !== newEl) {
      oldEl.classList.remove('is-active');
      oldEl.classList.add('is-leaving');
      await new Promise(r => setTimeout(r, 300));
      oldEl.classList.remove('is-leaving');
    }

    // Fade in new
    if (newEl) {
      newEl.classList.add('is-active');
    }

    currentStage = name;

    // Lazy-build the page list when entering EDIT for the first time
    if (name === 'edit' && state.files.length > 0 && !state.pagesBuilt) {
      // Fire-and-forget so the stage transition isn't blocked
      buildPagesForEdit().catch(err => console.error('buildPagesForEdit:', err));
    } else if (name === 'edit' && state.pagesBuilt) {
      renderPageGrid();
    }

    // Update the "Keep scrolling" indicator after the stage settles
    setTimeout(() => {
      if (typeof updateScrollIndicator === 'function') updateScrollIndicator();
    }, 320);
  })();
  await stageTransition;
  stageTransition = null;
}

// ============================================================
// FILE INTAKE
// ============================================================

dropZone.addEventListener('click', () => fileInput.click());
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
addMoreBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  ingestFiles(Array.from(e.target.files || []));
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach(ev => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(ev => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (ev === 'dragleave' && e.target !== dropZone) return;
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || [])
    .filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  ingestFiles(files);
});

// Also let the user drop files anywhere on the page once at least one is queued
['dragover', 'drop'].forEach(ev => {
  document.addEventListener(ev, (e) => {
    if (e.target.closest('.drop-zone, .file-strip')) return;
    e.preventDefault();
  });
});

async function ingestFiles(files) {
  if (!files.length) return;
  showBusy('Reading files…', 'Generating previews for your queue.');
  for (const file of files) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) continue;
    const fileIndex = state.files.length;
    const entry = {
      id: nextId++,
      file,
      name: file.name,
      size: file.size,
      thumbDataUrl: null,
      pageCount: null,
      color: colorForIndex(fileIndex),    // stripe color for the page editor
    };
    state.files.push(entry);
    // Files changed → existing page list is stale; rebuild on next EDIT visit
    state.pagesBuilt = false;
    // Render placeholder card immediately
    renderStrip();
    // Then generate thumbnail in background
    generateThumbnail(entry).then(() => renderStrip()).catch(() => {});
  }
  hideBusy();
  renderStrip();
  // Advance to REARRANGE the first time files come in (or stay there)
  if (state.files.length > 0 && currentStage === 'drop') {
    goToStage('rearrange');
  }
}

async function generateThumbnail(entry) {
  if (typeof pdfjsLib === 'undefined') return;
  try {
    const arrayBuffer = await entry.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    entry.pageCount = pdf.numPages;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.35 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    entry.thumbDataUrl = canvas.toDataURL('image/jpeg', 0.7);
    // Remember orientation so the card can size the thumb-box correctly
    entry.thumbAspect = viewport.width / viewport.height;
  } catch (err) {
    console.warn('Thumbnail generation failed:', err);
  }
}

// ============================================================
// RENDER FILE STRIP
// ============================================================

function renderStrip() {
  stripTrack.innerHTML = '';
  state.files.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.draggable = true;
    card.dataset.id = entry.id;

    const thumb = entry.thumbDataUrl
      ? `<img src="${entry.thumbDataUrl}" alt="">`
      : `<div class="file-thumb-placeholder">PDF</div>`;

    const sizeStr = formatBytes(entry.size);
    const pagesStr = entry.pageCount != null ? `${entry.pageCount}p · ` : '';

    // Adapt the thumbnail box to the page's actual aspect ratio (handles landscape PDFs)
    const aspect = entry.thumbAspect && entry.thumbAspect > 0 ? entry.thumbAspect : 0.77;
    const thumbStyle = `aspect-ratio:${aspect}; height:auto;`;

    card.innerHTML = `
      <div class="file-order">${i + 1}</div>
      <button type="button" class="file-remove" data-remove="${entry.id}" title="Remove">×</button>
      <div class="file-thumb" style="${thumbStyle}">${thumb}</div>
      <div class="file-meta">
        <div class="file-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
        <div class="file-size">${pagesStr}${sizeStr}</div>
      </div>
    `;

    attachDragHandlers(card);
    stripTrack.appendChild(card);
  });

  stripCount.textContent = state.files.length === 1 ? '1 file' : `${state.files.length} files`;

  stripTrack.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.remove);
      state.files = state.files.filter(f => f.id !== id);
      state.pagesBuilt = false; state.pages = [];
      renderStrip();
      // If the queue is empty, slide back to DROP
      if (state.files.length === 0) goToStage('drop');
    });
  });
}

clearAllBtn.addEventListener('click', () => {
  if (!state.files.length) return;
  if (state.files.length > 1 && !confirm('Remove all queued files?')) return;
  state.files = [];
  state.pagesBuilt = false; state.pages = [];
  renderStrip();
  goToStage('drop');
});

// REARRANGE → EDIT PAGES
continueToEditBtn.addEventListener('click', () => {
  if (!state.files.length) return;
  goToStage('edit');
});

// EDIT PAGES → COMPRESSION
continueToCompressBtn.addEventListener('click', () => {
  if (!state.pages.length) return;
  goToStage('compress');
});

// Restore all originally-loaded pages (un-delete everything, restore original order)
editResetBtn.addEventListener('click', () => {
  if (!state.files.length) return;
  pushUndo();   // let user undo a Restore All if they didn't mean it
  state.pagesBuilt = false;
  state.pages = [];
  buildPagesForEdit().catch(err => console.error(err));
});

// ============================================================
// PAGE EDITOR — render every page of every queued file as a grid
// of cards, color-stripe by source file, allow delete + reorder.
// ============================================================

// ----- Undo stack for the EDIT stage -----
// Each entry is a snapshot of state.pages + state.files (shallow clones).
// Pushed before any mutating action (delete, reorder, insert). Ctrl+Z pops.
const undoStack = [];
const MAX_UNDO = 50;

function pushUndo() {
  undoStack.push({
    pages: state.pages.map(p => ({ ...p })),
    files: state.files.map(f => ({ ...f })),
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButton();
}
function clearUndoHistory() {
  undoStack.length = 0;
  updateUndoButton();
}
function updateUndoButton() {
  if (!editUndoBtn) return;
  if (undoStack.length) editUndoBtn.removeAttribute('disabled');
  else editUndoBtn.setAttribute('disabled', '');
}
function undo() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  state.pages = prev.pages;
  state.files = prev.files;
  renderPageGrid();
  renderFileLegend();
  renderStrip();
  updateStepLocks();
  updateUndoButton();
}

editUndoBtn.addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  if (currentStage !== 'edit') return;
  // Ctrl+Z (or Cmd+Z on macOS), but ignore if focus is on a text input
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
});

// Cache of loaded PDF.js documents, keyed by fileId. Held during the EDIT
// stage so high-res zoom renders and inserts don't have to re-parse each PDF.
const pdfDocCache = new Map();

async function getPdfDoc(fileId) {
  if (pdfDocCache.has(fileId)) return pdfDocCache.get(fileId);
  const file = state.files.find(f => f.id === fileId);
  if (!file) return null;
  const buf = await file.file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  pdfDocCache.set(fileId, doc);
  return doc;
}

// Page-thumb aspect ratios captured during render so the cards lay out correctly
// for landscape orientations.
function pageCardAspect(pageEntry) {
  return pageEntry?.aspect && pageEntry.aspect > 0 ? pageEntry.aspect : 0.77;
}

async function buildPagesForEdit() {
  state.pages = [];
  state.pagesBuilt = false;

  pageRenderProgress.classList.remove('hidden');
  pageRenderLabel.textContent = 'Reading files…';
  pageRenderFill.style.width = '0%';
  pageGrid.innerHTML = '';
  fileLegend.innerHTML = '';

  // Pass 1: open every PDF, count pages, build placeholder entries
  let totalPages = 0;
  for (const file of state.files) {
    try {
      const pdf = await getPdfDoc(file.id);
      file.pageCount = pdf.numPages;
      for (let p = 1; p <= pdf.numPages; p++) {
        state.pages.push({
          id: nextId++,
          fileId: file.id,
          fileName: file.name,
          color: file.color,
          originalIndex: p - 1,    // zero-based — matches pdf-lib copyPages
          pageNum: p,              // one-based — for display
          thumbDataUrl: null,
        });
        totalPages++;
      }
    } catch (err) {
      console.warn('Could not open', file.name, err);
    }
  }
  state.pagesBuilt = true;

  renderFileLegend();
  renderPageGrid();
  updateStepLocks();

  // Pass 2: render thumbnails. Cards fill in as each render completes so
  // the user can start interacting before everything is drawn.
  let done = 0;
  for (const file of state.files) {
    const pdf = pdfDocCache.get(file.id);
    if (!pdf) continue;
    for (let p = 1; p <= pdf.numPages; p++) {
      try {
        const pdfPage = await pdf.getPage(p);
        const viewport = pdfPage.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
        const aspect = viewport.width / viewport.height;
        const entry = state.pages.find(pg => pg.fileId === file.id && pg.originalIndex === p - 1);
        if (entry) {
          entry.thumbDataUrl = dataUrl;
          entry.aspect = aspect;
          const card = pageGrid.querySelector(`[data-page-id="${entry.id}"]`);
          if (card) {
            const thumb = card.querySelector('.page-thumb');
            if (thumb) {
              thumb.innerHTML = `<img src="${dataUrl}" alt="">`;
              thumb.style.aspectRatio = aspect;
              thumb.style.height = 'auto';
            }
          }
        }
      } catch (err) {
        console.warn('Page render failed:', err);
      }
      done++;
      pageRenderLabel.textContent = `Rendering page ${done} of ${totalPages}…`;
      pageRenderFill.style.width = `${Math.round(100 * done / totalPages)}%`;
    }
  }

  pageRenderProgress.classList.add('hidden');
}

function renderPageGrid() {
  pageGrid.innerHTML = '';
  state.pages.forEach((page, i) => {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.draggable = true;
    card.dataset.pageId = page.id;
    card.style.setProperty('--source-color', page.color);

    const thumb = page.thumbDataUrl
      ? `<img src="${page.thumbDataUrl}" alt="">`
      : `<div class="page-thumb-skeleton"></div>`;

    card.innerHTML = `
      <span class="page-stripe"></span>
      <div class="page-order">${i + 1}</div>
      <button type="button" class="page-remove" data-page-remove="${page.id}" title="Remove page">×</button>
      <div class="page-thumb">${thumb}</div>
      <div class="page-origin">
        <span class="page-origin-file" title="${escapeHtml(page.fileName)}">${escapeHtml(page.fileName)}</span>
        <span class="page-origin-meta">PAGE ${page.pageNum}</span>
      </div>
    `;

    attachPageDragHandlers(card);

    // Click anywhere on the card (except × button) → open zoom modal
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-page-remove]')) return;
      openPageZoom(page.id);
    });
    // Right-click → context menu with insert options
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openInsertContextMenu(page.id, e.clientX, e.clientY);
    });

    pageGrid.appendChild(card);
  });

  pageGrid.querySelectorAll('[data-page-remove]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.pageRemove);
      removePage(id);
    });
  });

  pageCount.textContent = state.pages.length === 1 ? '1 page' : `${state.pages.length} pages`;
}

function renderFileLegend() {
  fileLegend.innerHTML = '';
  state.files.forEach(file => {
    const count = state.pages.filter(p => p.fileId === file.id).length;
    if (count === 0) return;
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-swatch" style="background:${file.color}"></span>
      <span class="legend-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="legend-count">${count}p</span>
    `;
    fileLegend.appendChild(item);
  });
}

function removePage(id) {
  const card = pageGrid.querySelector(`[data-page-id="${id}"]`);
  if (card) {
    pushUndo();   // snapshot BEFORE the mutation so undo restores this page
    card.classList.add('removing');
    setTimeout(() => {
      state.pages = state.pages.filter(p => p.id !== id);
      renderPageGrid();
      renderFileLegend();
      updateStepLocks();
    }, 240);
  }
}

// Custom pointer-based drag for the page editor.
// - The card visually "lifts" into your cursor (floating preview, slight tilt + shadow)
// - The original slot fades to a muted phantom so you can see where it came from
// - A hand-drawn red squiggle pulses in the grid gap showing exactly where it'll land
let pageDragState = null;
const PAGE_DRAG_THRESHOLD = 5;   // pixels of movement before drag actually starts

function attachPageDragHandlers(card) {
  card.draggable = false;        // we're handling it manually now — no native drag
  card.addEventListener('pointerdown', (e) => {
    // Left click only, and ignore the × button + zoom-on-click target
    if (e.button !== 0) return;
    if (e.target.closest('[data-page-remove]')) return;
    const rect = card.getBoundingClientRect();
    pageDragState = {
      sourceId: Number(card.dataset.pageId),
      sourceCard: card,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      cardW: rect.width,
      started: false,
      preview: null,
      targetCard: null,
      dropBefore: false,
    };
  });
}

document.addEventListener('pointermove', (e) => {
  const s = pageDragState;
  if (!s) return;

  // Don't start the drag until movement passes the threshold (so a quick
  // click still opens the zoom modal cleanly).
  if (!s.started) {
    const dx = Math.abs(e.clientX - s.startX);
    const dy = Math.abs(e.clientY - s.startY);
    if (dx < PAGE_DRAG_THRESHOLD && dy < PAGE_DRAG_THRESHOLD) return;
    s.started = true;
    // Build the floating preview (clone of the source card)
    const clone = s.sourceCard.cloneNode(true);
    clone.classList.remove('dragging-source', 'drop-before', 'drop-after');
    clone.classList.add('page-drag-preview');
    clone.style.width = `${s.cardW}px`;
    document.body.appendChild(clone);
    s.preview = clone;
    // Mute the source slot
    s.sourceCard.classList.add('dragging-source');
    // Use grabbing cursor across the whole document while dragging
    document.body.style.cursor = 'grabbing';
    e.target.setPointerCapture?.(e.pointerId);
  }

  // Move preview with the cursor
  s.preview.style.left = `${e.clientX - s.offsetX}px`;
  s.preview.style.top  = `${e.clientY - s.offsetY}px`;

  // Hit-test which card the cursor is over (preview has pointer-events:none)
  const below = document.elementFromPoint(e.clientX, e.clientY);
  const target = below?.closest?.('.page-card');

  // Clear previous indicators
  pageGrid.querySelectorAll('.drop-before, .drop-after').forEach(c =>
    c.classList.remove('drop-before', 'drop-after')
  );

  if (target && target !== s.sourceCard) {
    const r = target.getBoundingClientRect();
    const isBefore = e.clientX < r.left + r.width / 2;
    target.classList.add(isBefore ? 'drop-before' : 'drop-after');
    s.targetCard = target;
    s.dropBefore = isBefore;
  } else {
    s.targetCard = null;
  }
});

document.addEventListener('pointerup', (e) => {
  const s = pageDragState;
  if (!s) return;
  pageDragState = null;

  if (!s.started) return;   // it was just a click, not a drag

  // Commit the reorder
  if (s.targetCard) {
    const targetId = Number(s.targetCard.dataset.pageId);
    const srcIdx = state.pages.findIndex(p => p.id === s.sourceId);
    let tgtIdx = state.pages.findIndex(p => p.id === targetId);
    if (srcIdx >= 0 && tgtIdx >= 0 && targetId !== s.sourceId) {
      pushUndo();
      const [moved] = state.pages.splice(srcIdx, 1);
      if (srcIdx < tgtIdx) tgtIdx -= 1;
      state.pages.splice(s.dropBefore ? tgtIdx : tgtIdx + 1, 0, moved);
    }
  }

  // Cleanup
  s.preview?.remove();
  s.sourceCard?.classList.remove('dragging-source');
  pageGrid.querySelectorAll('.drop-before, .drop-after').forEach(c =>
    c.classList.remove('drop-before', 'drop-after')
  );
  document.body.style.cursor = '';

  // Re-render so order updates everywhere
  renderPageGrid();
});

// Cancel drag if user presses Escape mid-flight
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !pageDragState) return;
  const s = pageDragState;
  pageDragState = null;
  if (s.started) {
    s.preview?.remove();
    s.sourceCard?.classList.remove('dragging-source');
    pageGrid.querySelectorAll('.drop-before, .drop-after').forEach(c =>
      c.classList.remove('drop-before', 'drop-after')
    );
    document.body.style.cursor = '';
  }
});

// ============================================================
// PAGE ZOOM MODAL — click any card to inspect the page at full size
// ============================================================

let currentZoomPageId = null;

async function openPageZoom(pageId) {
  const page = state.pages.find(p => p.id === pageId);
  if (!page) return;
  currentZoomPageId = pageId;

  pageZoomMeta.innerHTML = `
    <span class="zoom-color-dot" style="background:${page.color}"></span>
    <span class="zoom-meta-name">${escapeHtml(page.fileName)}</span>
    <span class="zoom-meta-pageinfo">PAGE ${page.pageNum}</span>
  `;
  pageZoomImage.innerHTML = '<div class="page-zoom-skeleton">Rendering at full size…</div>';
  pageZoomModal.classList.remove('hidden');

  try {
    const pdf = await getPdfDoc(page.fileId);
    if (!pdf) throw new Error('Source file no longer available');
    const pdfPage = await pdf.getPage(page.pageNum);
    const viewport = pdfPage.getViewport({ scale: 1.6 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    if (currentZoomPageId !== pageId) return;  // user closed while rendering
    pageZoomImage.innerHTML = `<img src="${canvas.toDataURL('image/jpeg', 0.85)}" alt="">`;
  } catch (err) {
    pageZoomImage.innerHTML = `<div class="page-zoom-skeleton">Could not render: ${escapeHtml(err.message)}</div>`;
  }
}

function closePageZoom() {
  pageZoomModal.classList.add('hidden');
  currentZoomPageId = null;
}

pageZoomCloseBtn.addEventListener('click', closePageZoom);
pageZoomModal.querySelector('.page-zoom-backdrop').addEventListener('click', closePageZoom);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pageZoomModal.classList.contains('hidden')) closePageZoom();
});
pageZoomRemoveBtn.addEventListener('click', () => {
  if (currentZoomPageId == null) return;
  const id = currentZoomPageId;
  closePageZoom();
  removePage(id);
});

// ============================================================
// INSERT PAGES — right-click context menu
// ============================================================

let insertTargetPageId = null;
let insertPosition = 'after';

function openInsertContextMenu(pageId, clientX, clientY) {
  insertTargetPageId = pageId;
  // Clamp to viewport so it doesn't run off the edge
  const menuW = 240, menuH = 96;
  const x = Math.min(clientX, window.innerWidth  - menuW - 8);
  const y = Math.min(clientY, window.innerHeight - menuH - 8);
  insertContextMenu.style.left = `${Math.max(8, x)}px`;
  insertContextMenu.style.top  = `${Math.max(8, y)}px`;
  insertContextMenu.classList.remove('hidden');
}

function closeInsertContextMenu() {
  insertContextMenu.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  if (insertContextMenu.classList.contains('hidden')) return;
  if (insertContextMenu.contains(e.target)) return;
  closeInsertContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !insertContextMenu.classList.contains('hidden')) closeInsertContextMenu();
});

insertContextMenu.querySelectorAll('button[data-position]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    insertPosition = btn.dataset.position;
    closeInsertContextMenu();
    insertFileInput.click();
  });
});

insertFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length || insertTargetPageId == null) return;
  await insertPagesFromFiles(files, insertTargetPageId, insertPosition);
});

// Wrap an image file (jpg/png) into a single-page Letter-sized PDF so it can
// flow through the same page-editor + merge pipeline as the other PDFs.
async function imageFileToPdfFile(imgFile) {
  const bytes = await imgFile.arrayBuffer();
  const doc = await PDFDocument.create();
  const name = imgFile.name.toLowerCase();
  let img;
  if (imgFile.type === 'image/jpeg' || /\.jpe?g$/.test(name)) {
    img = await doc.embedJpg(bytes);
  } else if (imgFile.type === 'image/png' || /\.png$/.test(name)) {
    img = await doc.embedPng(bytes);
  } else {
    throw new Error('Unsupported image type: ' + (imgFile.type || imgFile.name));
  }
  // US Letter, image fit-to-page with a small margin, preserving aspect ratio
  const PAGE_W = 612, PAGE_H = 792, margin = 36;
  const maxW = PAGE_W - margin * 2;
  const maxH = PAGE_H - margin * 2;
  const ratio = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawImage(img, {
    x: (PAGE_W - w) / 2,
    y: (PAGE_H - h) / 2,
    width: w, height: h,
  });
  const pdfBytes = await doc.save();
  // Preserve original filename but switch extension to indicate the wrap
  const baseName = imgFile.name.replace(/\.[^.]+$/, '');
  return new File([pdfBytes], `${baseName} (image).pdf`, { type: 'application/pdf' });
}

async function insertPagesFromFiles(files, targetPageId, position) {
  const targetIdx = state.pages.findIndex(p => p.id === targetPageId);
  if (targetIdx < 0) return;
  pushUndo();   // snapshot before insertion so undo removes everything we add
  let insertIdx = position === 'before' ? targetIdx : targetIdx + 1;

  showBusy('Adding pages…', 'Reading and rendering new pages.');

  for (let inFile of files) {
    const lname = inFile.name.toLowerCase();
    const isImage =
      inFile.type === 'image/jpeg' || inFile.type === 'image/png' ||
      /\.(jpe?g|png)$/.test(lname);
    const isPdf =
      inFile.type === 'application/pdf' || lname.endsWith('.pdf');
    if (!isPdf && !isImage) continue;

    // Convert images to single-page PDFs so the rest of the pipeline is uniform
    if (isImage) {
      try { inFile = await imageFileToPdfFile(inFile); }
      catch (err) { console.warn('Image wrap failed:', err); continue; }
    }

    const fileIndex = state.files.length;
    const fileEntry = {
      id: nextId++,
      file: inFile,
      name: inFile.name,
      size: inFile.size,
      thumbDataUrl: null,
      pageCount: null,
      color: colorForIndex(fileIndex),
    };
    state.files.push(fileEntry);

    const pdf = await getPdfDoc(fileEntry.id);
    fileEntry.pageCount = pdf.numPages;

    const newPages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      newPages.push({
        id: nextId++,
        fileId: fileEntry.id,
        fileName: fileEntry.name,
        color: fileEntry.color,
        originalIndex: p - 1,
        pageNum: p,
        thumbDataUrl: null,
      });
    }
    state.pages.splice(insertIdx, 0, ...newPages);
    insertIdx += newPages.length;

    // Render the new thumbnails before unblocking
    for (const newPage of newPages) {
      try {
        const pdfPage = await pdf.getPage(newPage.pageNum);
        const viewport = pdfPage.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        newPage.thumbDataUrl = canvas.toDataURL('image/jpeg', 0.65);
      } catch (err) {
        console.warn('Page render failed:', err);
      }
    }
  }

  renderFileLegend();
  renderPageGrid();
  renderStrip();         // queue stays in sync — new files appear in REARRANGE too
  updateStepLocks();
  hideBusy();
}

// ============================================================
// DRAG TO REORDER
// ============================================================

let dragSrcId = null;

function attachDragHandlers(card) {
  card.addEventListener('dragstart', (e) => {
    dragSrcId = Number(card.dataset.id);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragSrcId));
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    stripTrack.querySelectorAll('.file-card').forEach(c =>
      c.classList.remove('drop-before', 'drop-after')
    );
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (Number(card.dataset.id) === dragSrcId) return;
    // Determine left-of-target vs right-of-target based on cursor x
    const rect = card.getBoundingClientRect();
    const isBefore = e.clientX < rect.left + rect.width / 2;
    card.classList.toggle('drop-before', isBefore);
    card.classList.toggle('drop-after', !isBefore);
  });
  card.addEventListener('dragleave', () =>
    card.classList.remove('drop-before', 'drop-after')
  );
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isBefore = card.classList.contains('drop-before');
    card.classList.remove('drop-before', 'drop-after');
    const targetId = Number(card.dataset.id);
    if (dragSrcId == null || targetId === dragSrcId) return;
    const srcIdx = state.files.findIndex(f => f.id === dragSrcId);
    let tgtIdx = state.files.findIndex(f => f.id === targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    // After removing src, the target index may shift if src was before it
    const [moved] = state.files.splice(srcIdx, 1);
    if (srcIdx < tgtIdx) tgtIdx -= 1;
    state.files.splice(isBefore ? tgtIdx : tgtIdx + 1, 0, moved);
    dragSrcId = null;
    state.pagesBuilt = false; state.pages = [];   // page list is stale if file order changed
    renderStrip();
  });
}

// ============================================================
// COMPRESSION PRESET PICKER
// ============================================================

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.preset = btn.dataset.preset;
  });
});

// ============================================================
// MERGE + COMPRESS
// ============================================================

processBtn.addEventListener('click', async () => {
  if (!state.files.length) return;
  try {
    showBusy('Merging your PDFs…', 'Reading pages, stitching everything together.');
    // If the page editor has been visited, use the curated page list; otherwise fall back to full files.
    const mergedBytes = state.pagesBuilt
      ? await mergePages(state.pages)
      : await mergePdfs(state.files);

    // One clean message for the whole compress phase — same look as the merge step.
    showBusy('Compressing your PDF…', presetSubText(state.preset));
    const originalTotal = state.files.reduce((s, f) => s + f.size, 0);
    const compressedBytes = await compressPdf(mergedBytes, state.preset);
    state.resultCompressedBytes = compressedBytes.byteLength;
    let finalBytes = compressedBytes;

    // Optional OCR pass to make scanned pages searchable
    const wantsSearchable = document.getElementById('searchableToggle')?.checked;
    state.resultOcrEnabled = !!wantsSearchable;
    if (wantsSearchable) {
      showBusyWithProgress('Making your PDF searchable…',
        'Checking which pages need OCR…', 0, '', '');
      finalBytes = await makeSearchable(finalBytes, (p) => {
        if (p.phase === 'detect') {
          showBusyWithProgress('Making your PDF searchable…',
            'Checking which pages need OCR…', 0, '', '');
        } else if (p.phase === 'ocr') {
          const left  = `Page ${p.page} of ${p.total}`;
          const right = formatEta(p.etaSec);
          const skipMsg = p.skipCount > 0 ? ` · ${p.skipCount} already searchable, skipped` : '';
          showBusyWithProgress(
            'Making your PDF searchable…',
            `Reading text on scanned pages${skipMsg}.`,
            (p.page - 1) / p.total,
            left, right
          );
        } else if (p.phase === 'done') {
          const skipMsg = p.skipCount > 0 ? ` (${p.skipCount} were already searchable)` : '';
          showBusyWithProgress('Wrapping up…',
            `OCR complete${skipMsg}. Saving the searchable PDF…`,
            1, `${p.ocrCount} of ${p.total} OCR'd`, 'done');
        }
      });
    }

    state.resultBlob = new Blob([finalBytes], { type: 'application/pdf' });
    state.resultName = buildResultName(state.files);
    state.resultOriginalTotal = originalTotal;
    state.resultMergedBytes = mergedBytes.byteLength;
    state.resultFinalBytes = finalBytes.byteLength;

    renderResult();
    bumpCounter(state.files.length, await countPages(finalBytes));
    hideBusy();
  } catch (err) {
    hideBusy();
    console.error(err);
    alert('Something went wrong while processing.\n\n' + err.message +
          '\n\nCheck the file isn\'t encrypted/password-protected and try again.');
  }
});

async function mergePdfs(entries) {
  const merged = await PDFDocument.create();
  for (const entry of entries) {
    const bytes = await entry.file.arrayBuffer();
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  return await merged.save({ useObjectStreams: true });
}

// Merge a curated list of pages (from the editor) into one PDF.
// Loads each source file once, then copies only the selected pages
// in the order the editor set.
async function mergePages(pages) {
  const merged = await PDFDocument.create();
  const docCache = new Map();
  for (const page of pages) {
    let src = docCache.get(page.fileId);
    if (!src) {
      const file = state.files.find(f => f.id === page.fileId);
      if (!file) continue;
      const bytes = await file.file.arrayBuffer();
      src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      docCache.set(page.fileId, src);
    }
    const [copied] = await merged.copyPages(src, [page.originalIndex]);
    merged.addPage(copied);
  }
  return await merged.save({ useObjectStreams: true });
}

// Real iLovePDF-grade compression via Ghostscript compiled to WebAssembly.
// Tuned settings (measured on Janie's 127MB Shield AI bundle):
//   low         → ~53 MB  (-58%)  — /printer, 300 DPI, archive-grade
//   recommended → ~23 MB  (-82%)  — /ebook   tuned: 110 DPI + JPEG 65, sharp text
//   extreme     → ~16 MB  (-87%)  — /screen  tuned: 95 DPI + JPEG 60, screen-ready
// The 16MB WASM binary is downloaded once on first compression and cached by the browser.

const GS_PRESET_FLAGS = {
  low: [
    '-dPDFSETTINGS=/printer',
  ],
  recommended: [
    '-dPDFSETTINGS=/ebook',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageResolution=110',
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dGrayImageResolution=110',
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    '-dMonoImageResolution=600',
    '-dColorImageFilter=/DCTEncode',
    '-dGrayImageFilter=/DCTEncode',
    '-dJPEGQ=65',
  ],
  extreme: [
    '-dPDFSETTINGS=/screen',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageResolution=95',
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dGrayImageResolution=95',
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    '-dMonoImageResolution=600',
    '-dColorImageFilter=/DCTEncode',
    '-dGrayImageFilter=/DCTEncode',
    '-dJPEGQ=60',
  ],
};

let gsWasmBytes = null;   // cached WASM binary after first download
let gsFactoryPromise = null;

async function ensureGsWasmBytes(onProgress) {
  if (gsWasmBytes) return gsWasmBytes;
  const resp = await fetch('./lib/ghostscript-wasm/gs.wasm');
  if (!resp.ok) throw new Error(`Failed to download Ghostscript WASM (${resp.status})`);
  if (onProgress && resp.body) {
    // Stream the download so we can show progress for the 16MB binary
    const total = Number(resp.headers.get('content-length')) || 16_000_000;
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received / total);
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    gsWasmBytes = buf.buffer;
  } else {
    gsWasmBytes = await resp.arrayBuffer();
  }
  return gsWasmBytes;
}

async function ensureGsFactory() {
  if (!gsFactoryPromise) {
    gsFactoryPromise = import('./lib/ghostscript-wasm/gs.mjs').then(m => m.default);
  }
  return gsFactoryPromise;
}

async function compressPdf(bytes, preset, onProgress) {
  const presetFlags = GS_PRESET_FLAGS[preset] || GS_PRESET_FLAGS.recommended;

  // First call downloads the 16MB WASM. Subsequent calls reuse the cached bytes.
  const wasmBytes = await ensureGsWasmBytes(onProgress);
  const createGS = await ensureGsFactory();

  const gs = await createGS({
    instantiateWasm(imports, cb) {
      WebAssembly.instantiate(wasmBytes, imports)
        .then(r => cb(r.instance, r.module))
        .catch(e => { throw new Error('WASM instantiate failed: ' + e); });
      return {};
    },
  });

  // Mount the input bytes into Ghostscript's in-memory filesystem
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  gs.FS.writeFile('/input.pdf', input);

  const exit = gs.callMain([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dSAFER',
    ...presetFlags,
    '-sOutputFile=/output.pdf',
    '/input.pdf',
  ]);

  if (exit !== 0) {
    throw new Error(`Ghostscript exited with status ${exit}. The PDF may be encrypted or malformed.`);
  }

  const output = gs.FS.readFile('/output.pdf');
  // Free the input file from the WASM heap
  try { gs.FS.unlink('/input.pdf'); gs.FS.unlink('/output.pdf'); } catch {}

  // SAFETY NET: if Ghostscript made the file LARGER (happens with already-
  // optimized scans where re-encoding a low-quality JPEG at our settings
  // ADDS artifacts), keep the original instead. The user wanted "compressed",
  // never "bigger than what they had."
  if (output.byteLength > input.byteLength) {
    console.log(`Compression would grow file (${output.byteLength} > ${input.byteLength}) — keeping original`);
    return input;
  }
  return output;
}

async function countPages(bytes) {
  try {
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount();
  } catch { return 0; }
}

// ============================================================
// OCR — Tesseract.js, bakes an invisible text layer behind each page
// so the compressed scan supports Ctrl+F and copy/paste.
// ============================================================
let tesseractScriptPromise = null;
function ensureTesseractScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractScriptPromise) return tesseractScriptPromise;
  tesseractScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './lib/tesseract/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('Failed to load Tesseract.js'));
    document.head.appendChild(script);
  });
  return tesseractScriptPromise;
}

// Lazy-load Noto Sans (unicode-capable font) so the OCR text layer
// can encode smart quotes, em-dashes, accented chars, etc.
let notoFontBytesPromise = null;
function ensureNotoBytes() {
  if (!notoFontBytesPromise) {
    notoFontBytesPromise = fetch('./lib/NotoSans-Regular.ttf')
      .then(r => { if (!r.ok) throw new Error('Failed to fetch NotoSans'); return r.arrayBuffer(); });
  }
  return notoFontBytesPromise;
}

// Render a PDF page to a canvas at a target DPI suitable for OCR.
async function renderPageToCanvas(pdfJsPage, dpi = 200) {
  const viewport = pdfJsPage.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await pdfJsPage.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport };
}

// Quick check: does this page already have meaningful text content?
// Returns true if the page has at least `minChars` of extractable text.
async function pageHasText(pdfJsPage, minChars = 30) {
  try {
    const tc = await pdfJsPage.getTextContent();
    const text = tc.items.map(it => it.str || '').join(' ').replace(/\s+/g, '');
    return text.length >= minChars;
  } catch {
    return false;
  }
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s left`;
}

// Normalize a string into chars that Helvetica/WinAnsi can encode.
// Replaces smart quotes, em/en-dashes, ellipses, NBSP with ASCII equivalents.
// Returns null if any unrepresentable chars remain (caller should use unicode font).
function tryNormalizeToWinAnsi(text) {
  const normalized = text
    .replace(/[‘’‚‛]/g, "'")     // single smart quotes
    .replace(/[“”„‟]/g, '"')     // double smart quotes
    .replace(/[‐‑‒–—―]/g, '-') // hyphens, dashes
    .replace(/…/g, '...')                        // ellipsis
    .replace(/[   ]/g, ' ')            // no-break spaces
    .replace(/•/g, '*');                         // bullet
  // WinAnsi covers Latin-1 + a handful of extras. Reject if anything outside that range.
  return /[^\x09\x0A\x0D\x20-\x7E -ſ]/.test(normalized) ? null : normalized;
}

// Take a compressed PDF and return a new PDF with the same visual content
// PLUS an invisible text layer baked into each page (so Ctrl+F finds words).
//
// Optimizations:
//   • Skips pages that already have a text layer (no OCR cost for digital PDFs)
//   • Picks Helvetica (zero embed cost) when text is ASCII-only
//   • Only falls back to embedded Noto Sans subset when truly needed (saves ~25 KB)
async function makeSearchable(pdfBytes, onProgress) {
  const Tesseract = await ensureTesseractScript();

  const outDoc = await PDFDocument.load(pdfBytes);
  const numPages = outDoc.getPageCount();
  const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;

  // 1) Find pages that need OCR
  onProgress?.({ phase: 'detect', page: 0, total: numPages, ocrCount: 0, skipCount: 0, etaSec: null });
  const pagesToOcr = [];
  let skipCount = 0;
  for (let p = 1; p <= numPages; p++) {
    const pdfJsPage = await pdfJsDoc.getPage(p);
    if (await pageHasText(pdfJsPage, 30)) skipCount++;
    else pagesToOcr.push(p);
  }
  if (pagesToOcr.length === 0) {
    await pdfJsDoc.destroy();
    onProgress?.({ phase: 'done', page: numPages, total: numPages, ocrCount: 0, skipCount, etaSec: 0 });
    return pdfBytes;
  }

  // 2) OCR pass — collect words but DON'T draw yet, so we can decide on font first
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: './lib/tesseract/worker.min.js',
    corePath:   './lib/tesseract/tesseract-core-lstm.wasm.js',
    langPath:   './lib/tesseract/lang-data/',
  });

  const wordsPerPage = new Map();   // pageNum → [{text, bbox, viewport, pdfW, pdfH}]
  const startTs = performance.now();
  let perPageMs = 1500;
  for (let i = 0; i < pagesToOcr.length; i++) {
    const p = pagesToOcr[i];
    const remaining = pagesToOcr.length - i;
    onProgress?.({
      phase: 'ocr', page: i + 1, total: pagesToOcr.length,
      pageNum: p, ocrCount: i, skipCount,
      etaSec: (remaining * perPageMs) / 1000,
    });

    const pdfJsPage = await pdfJsDoc.getPage(p);
    const { canvas, viewport } = await renderPageToCanvas(pdfJsPage, 200);

    const pStart = performance.now();
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    perPageMs = i === 0 ? performance.now() - pStart
                         : perPageMs * 0.6 + (performance.now() - pStart) * 0.4;

    const words = [];
    for (const block of (data.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        for (const line of (para.lines || [])) {
          for (const w of (line.words || [])) {
            const txt = (w.text || '').trim();
            if (!txt) continue;
            if (typeof w.confidence === 'number' && w.confidence < 40) continue;
            words.push({ text: txt, bbox: w.bbox });
          }
        }
      }
    }

    const outPage = outDoc.getPage(p - 1);
    const sz = outPage.getSize();
    wordsPerPage.set(p, {
      words,
      vpW: viewport.width, vpH: viewport.height,
      pdfW: sz.width, pdfH: sz.height,
    });
    canvas.width = canvas.height = 0;
  }
  await worker.terminate();
  await pdfJsDoc.destroy();

  // 3) Decide which font to use — Helvetica is free, Noto costs ~25 KB.
  // Walk all OCR'd words: if every word can be normalized to WinAnsi → Helvetica.
  // Otherwise → embed Noto Sans for full unicode.
  let allAscii = true;
  for (const { words } of wordsPerPage.values()) {
    for (const w of words) {
      if (tryNormalizeToWinAnsi(w.text) === null) {
        allAscii = false;
        break;
      }
    }
    if (!allAscii) break;
  }

  let layerFont;
  let fontKind = 'helvetica';
  if (allAscii) {
    layerFont = await outDoc.embedFont(StandardFonts.Helvetica);
  } else {
    try {
      const notoBytes = await ensureNotoBytes();
      if (window.fontkit) outDoc.registerFontkit(window.fontkit);
      layerFont = await outDoc.embedFont(notoBytes, { subset: true });
      fontKind = 'noto';
    } catch (err) {
      console.warn('Fontkit/Noto failed, dropping to Helvetica + normalize:', err);
      layerFont = await outDoc.embedFont(StandardFonts.Helvetica);
    }
  }

  // 4) Bake the words into each page
  for (const [p, { words, vpW, vpH, pdfW, pdfH }] of wordsPerPage) {
    const outPage = outDoc.getPage(p - 1);
    const scaleX = pdfW / vpW;
    const scaleY = pdfH / vpH;
    for (const w of words) {
      const txt = fontKind === 'helvetica' ? tryNormalizeToWinAnsi(w.text) : w.text;
      if (!txt) continue;
      const bx0 = w.bbox?.x0 ?? 0;
      const by0 = w.bbox?.y0 ?? 0;
      const by1 = w.bbox?.y1 ?? 0;
      const x = bx0 * scaleX;
      const y = pdfH - by1 * scaleY;
      const fontSize = Math.max(4, (by1 - by0) * scaleY * 0.85);
      try {
        outPage.drawText(txt, { x, y, size: fontSize, font: layerFont, color: rgb(0,0,0), opacity: 0 });
      } catch { /* skip unrenderable */ }
    }
  }

  onProgress?.({
    phase: 'done',
    page: pagesToOcr.length, total: pagesToOcr.length,
    ocrCount: pagesToOcr.length, skipCount, etaSec: 0,
    totalMs: performance.now() - startTs,
    fontKind,
  });

  return await outDoc.save({ useObjectStreams: true });
}

function presetSubText(preset) {
  return ({
    low: 'Light squeeze — keeping things crisp.',
    recommended: 'Email-ready balance: sharp text, smaller images.',
    extreme: 'Maximum crunch — squeezing every byte.',
  })[preset] || '';
}

function buildResultName(entries) {
  if (entries.length === 1) {
    const base = entries[0].name.replace(/\.pdf$/i, '');
    return `${base}_compressed.pdf`;
  }
  return `vista_merged_${new Date().toISOString().slice(0,10)}.pdf`;
}

// ============================================================
// RESULT PANEL
// ============================================================

function renderResult() {
  const originalBytes = state.resultOriginalTotal || 0;
  const finalBytes    = state.resultFinalBytes    || 0;
  const ocrEnabled    = !!state.resultOcrEnabled;

  $('statBefore').textContent = formatBytes(originalBytes);
  $('statAfter').textContent  = formatBytes(finalBytes);

  // Middle stat: "Compressed" or "Searchable" depending on whether OCR was on
  $('statAfterLabel').textContent = ocrEnabled ? 'Searchable' : 'Compressed';

  // Right stat: honestly reflect what happened to size
  const diff = originalBytes - finalBytes;   // positive = saved, negative = grew
  if (diff >= 0) {
    const pct = originalBytes > 0 ? Math.round((diff / originalBytes) * 100) : 0;
    $('statSaved').textContent = `${pct}%`;
    $('statSavedLabel').textContent = 'Saved';
    $('statDeltaArrow').textContent = '=';
    // Use accent class for visual highlight
    $('statSaved').parentElement.classList.add('highlight');
    $('statSaved').parentElement.classList.remove('warning');
  } else {
    // File grew — almost always means OCR overhead on a tiny doc
    $('statSaved').textContent = `+${formatBytes(-diff)}`;
    $('statSavedLabel').textContent = ocrEnabled ? 'OCR overhead' : 'Larger';
    $('statDeltaArrow').textContent = ' ';
    $('statSaved').parentElement.classList.remove('highlight');
    $('statSaved').parentElement.classList.add('warning');
  }

  // "Searchable text included" badge above the stats — only when OCR ran
  $('searchableBadge').classList.toggle('hidden', !ocrEnabled);

  renderSankey(state.files, state.resultMergedBytes, state.resultFinalBytes);
  goToStage('result');
}

// ============================================================
// SANKEY DIAGRAM — inputs → merged → compressed
// ============================================================

function renderSankey(files, mergedBytes, finalBytes) {
  const container = $('sankeyContainer');
  if (!container) return;
  if (!files.length || !mergedBytes || !finalBytes) {
    container.innerHTML = '';
    return;
  }

  const W = 820, H = 440;       // taller box so every label can breathe
  const PAD_X_LEFT  = 210;      // wide left margin for 2-line filename labels
  const PAD_X_RIGHT = 140;
  const PAD_Y = 28;
  const COL_W = 22;

  const leftX  = PAD_X_LEFT;
  const midX   = (W - COL_W) / 2;
  const rightX = W - PAD_X_RIGHT - COL_W;

  const inputsTotal = files.reduce((s, f) => s + f.size, 0);
  // Pick the LARGEST flow as the height reference so everything fits in the box,
  // including the OCR-overhead case where finalBytes > mergedBytes
  const refSize = Math.max(inputsTotal, mergedBytes, finalBytes);
  const maxH = H - PAD_Y * 2;

  // ---- Layout: input bars with gaps + minimum height ----
  const GAP_Y    = 16;          // generous vertical breathing room between inputs
  const minBarH  = 36;          // enough to fit 2-line title + size below
  const totalGap = (files.length - 1) * GAP_Y;
  const availForBars = maxH - totalGap;

  // Step 1 — natural proportional heights, scaled against refSize so bars
  // never exceed the available space even when finalBytes > inputsTotal.
  let bars = files.map(f => (f.size / refSize) * availForBars);
  // Step 2 — enforce min for tiny files
  bars = bars.map(h => Math.max(h, minBarH));
  // Step 3 — if that overflowed, scale down the bars that are above min so total fits
  const total = bars.reduce((a, b) => a + b, 0);
  const excess = total - availForBars;
  if (excess > 0) {
    const sumLarge = bars.reduce((a, h) => a + (h > minBarH ? h : 0), 0);
    if (sumLarge > 0) {
      bars = bars.map(h => h > minBarH
        ? Math.max(minBarH, h - (h / sumLarge) * excess)
        : h);
    }
  }

  // Position input bars vertically with gaps
  let cur = PAD_Y;
  const inputBars = files.map((f, i) => {
    const bar = { i, x: leftX, y: cur, w: COL_W, h: bars[i], name: f.name, size: f.size };
    cur += bar.h;
    if (i < files.length - 1) cur += GAP_Y;
    return bar;
  });

  // ---- Merged bar (middle): scaled against refSize so it stays in proportion
  // with both the input ribbons and the compressed bar.
  const mergedH = Math.max((mergedBytes / refSize) * availForBars, 14);
  const mergedY = PAD_Y + (maxH - mergedH) / 2; // vertically centered

  const mergedBar = { x: midX, y: mergedY, w: COL_W, h: mergedH, size: mergedBytes };

  // ---- Compressed bar (right) — also scaled against refSize so it never
  // overflows the box, even when OCR overhead pushes finalBytes > mergedBytes.
  const cH = Math.max((finalBytes / refSize) * availForBars, 14);
  const compressedBar = {
    x: rightX, y: PAD_Y + (maxH - cH) / 2,  // centered against the full box height
    w: COL_W, h: cH, size: finalBytes,
  };

  // ---- Flow paths: each input → contiguous slice of merged ----
  // Input-side width = the actual bar height (which may have been min-padded).
  // Merged-side width = the file's proportional share of mergedBytes, so the
  // sum of ribbon ends matches mergedH exactly. Ribbons taper between the two.
  let mFlowY = mergedY;
  const inputFlows = inputBars.map((b, i) => {
    const file = files[i];
    const mergedSideH = (file.size / inputsTotal) * mergedH;
    const path = makeFlowPath(b.x + b.w, b.y, b.h, midX, mFlowY, mergedSideH);
    mFlowY += mergedSideH;
    return path;
  });

  // ---- Flow: merged → compressed (tapering) ----
  const mergedFlow = makeFlowPath(
    midX + COL_W, mergedBar.y, mergedBar.h,
    rightX, compressedBar.y, compressedBar.h
  );

  // ---- Build SVG — wrap each input (bar + flow + labels) in a <g> for hover grouping ----
  const labelXOff = 12;
  const flowStagger = (i) => 80 + i * 45;
  const barStagger  = (i) => 50 + i * 25;
  const lblStagger  = (i) => 320 + i * 35;

  const inputGroups = inputBars.map((b, i) => {
    const titleLines = splitTitle(b.name, 30, 2);
    const lblY = b.y + b.h / 2;
    const lineH = 12;
    // Vertical layout for label block: title (1 or 2 lines) + size below
    // Total block height = titleLines.length * lineH + sizeLine (+spacing)
    const blockH = titleLines.length * lineH + lineH + 2;
    const top = lblY - blockH / 2 + 9; // +9 for SVG baseline correction

    const titleHtml = titleLines.map((line, ln) => `
      <text x="${b.x - labelXOff}" y="${top + ln * lineH}" text-anchor="end" class="sankey-label"
            style="font-size:11px; animation-delay:${lblStagger(i) + ln * 30}ms;">${escapeHtml(line)}</text>
    `).join('');

    const sizeY = top + titleLines.length * lineH + 2;

    return `
      <g class="sankey-input" data-i="${i}">
        <path class="sankey-flow" d="${inputFlows[i]}" fill="url(#flowMerge)"
              style="animation-delay:${flowStagger(i)}ms;"/>
        <rect class="sankey-bar" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"
              fill="#5a6168"
              style="animation-delay:${barStagger(i)}ms; transform-origin: ${b.x + b.w/2}px ${b.y + b.h/2}px;"/>
        ${titleHtml}
        <text x="${b.x - labelXOff}" y="${sizeY}" text-anchor="end" class="sankey-label size"
              style="font-size:11px; animation-delay:${lblStagger(i) + titleLines.length * 30 + 30}ms;">${formatBytes(b.size)}</text>
      </g>
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="flowMerge" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0"   stop-color="rgba(181, 217, 238, 0.55)"/>
          <stop offset="1"   stop-color="rgba(90, 97, 104, 0.42)"/>
        </linearGradient>
        <linearGradient id="flowCompress" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0"   stop-color="rgba(20, 25, 28, 0.40)"/>
          <stop offset="1"   stop-color="rgba(178, 44, 46, 0.62)"/>
        </linearGradient>
      </defs>

      ${inputGroups}

      <g>
        <path class="sankey-flow" d="${mergedFlow}" fill="url(#flowCompress)"
              style="animation-delay:${flowStagger(inputBars.length + 1)}ms;"/>
        <rect class="sankey-bar" x="${mergedBar.x}" y="${mergedBar.y}" width="${mergedBar.w}" height="${mergedBar.h}"
              fill="#14191c"
              style="animation-delay:${260}ms; transform-origin: ${mergedBar.x + mergedBar.w/2}px ${mergedBar.y + mergedBar.h/2}px;"/>
        <rect class="sankey-bar" x="${compressedBar.x}" y="${compressedBar.y}" width="${compressedBar.w}" height="${compressedBar.h}"
              fill="#b22c2e"
              style="animation-delay:${460}ms; transform-origin: ${compressedBar.x + compressedBar.w/2}px ${compressedBar.y + compressedBar.h/2}px;"/>

        <text x="${mergedBar.x + mergedBar.w/2}" y="${mergedBar.y - 12}" text-anchor="middle"
              class="sankey-label head"
              style="font-size:12px; animation-delay:380ms;">MERGED</text>
        <text x="${mergedBar.x + mergedBar.w/2}" y="${mergedBar.y + mergedBar.h + 22}" text-anchor="middle"
              class="sankey-label size"
              style="font-size:13px; animation-delay:420ms;">${formatBytes(mergedBytes)}</text>

        <text x="${compressedBar.x + compressedBar.w + labelXOff}" y="${compressedBar.y + compressedBar.h/2 - 4}"
              class="sankey-label head compressed"
              style="font-size:12px; animation-delay:560ms;">COMPRESSED</text>
        <text x="${compressedBar.x + compressedBar.w + labelXOff}" y="${compressedBar.y + compressedBar.h/2 + 12}"
              class="sankey-label size"
              style="font-size:13px; animation-delay:620ms;">${formatBytes(finalBytes)}</text>
      </g>
    </svg>
  `;

  // Hover interaction — highlight the hovered input group, dim the others.
  container.querySelectorAll('.sankey-input').forEach(g => {
    g.addEventListener('mouseenter', () => {
      container.classList.add('has-hover');
      g.classList.add('is-hovered');
    });
    g.addEventListener('mouseleave', () => {
      container.classList.remove('has-hover');
      g.classList.remove('is-hovered');
    });
  });
}

function makeFlowPath(x1, y1, h1, x2, y2, h2) {
  // Cubic-bezier filled ribbon connecting (x1,y1,h1) to (x2,y2,h2).
  const cx1 = x1 + (x2 - x1) * 0.5;
  const cx2 = x1 + (x2 - x1) * 0.5;
  return [
    `M ${x1} ${y1}`,
    `C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
    `L ${x2} ${y2 + h2}`,
    `C ${cx2} ${y2 + h2}, ${cx1} ${y1 + h1}, ${x1} ${y1 + h1}`,
    `Z`,
  ].join(' ');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Wrap a filename into at most `maxLines` lines, each ≤ `maxPerLine` chars.
// Prefers breaking at word boundaries (spaces, dots, dashes, underscores).
// The last line truncates with an ellipsis if the name still doesn't fit.
function splitTitle(s, maxPerLine = 30, maxLines = 2) {
  if (!s) return [''];
  if (s.length <= maxPerLine) return [s];

  const lines = [];
  let rest = s;
  while (rest.length > 0 && lines.length < maxLines) {
    const isLast = lines.length === maxLines - 1;
    if (rest.length <= maxPerLine) {
      lines.push(rest);
      break;
    }
    if (isLast) {
      lines.push(rest.slice(0, maxPerLine - 1) + '…');
      break;
    }
    // Look backward from maxPerLine for a sensible break char
    let cut = maxPerLine;
    for (let i = maxPerLine; i > maxPerLine - 12 && i > 4; i--) {
      if (/[\s\.\-_]/.test(rest[i])) { cut = i + 1; break; }
    }
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return lines;
}

downloadBtn.addEventListener('click', () => {
  if (!state.resultBlob) return;
  const url = URL.createObjectURL(state.resultBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.resultName || 'vista_compressed.pdf';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

restartBtn.addEventListener('click', () => {
  state.files = [];
  state.pages = [];
  state.pagesBuilt = false;
  state.resultBlob = null;
  state.resultName = null;
  clearUndoHistory();
  renderStrip();
  goToStage('drop');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ============================================================
// BUSY OVERLAY
// ============================================================

function showBusy(text, sub) {
  busyText.textContent = text || 'Working…';
  busySub.textContent = sub || '';
  busyProgress.classList.add('hidden');     // hide progress bar by default
  busyOverlay.classList.remove('hidden');
}
function showBusyWithProgress(text, sub, frac, metaLeft, metaRight) {
  busyText.textContent = text || 'Working…';
  busySub.textContent = sub || '';
  const pct = Math.max(0, Math.min(1, frac || 0));
  busyProgressFill.style.width = `${Math.round(pct * 100)}%`;
  busyProgressMeta.innerHTML = `<span>${metaLeft || ''}</span><span class="meta-eta">${metaRight || ''}</span>`;
  busyProgress.classList.remove('hidden');
  busyOverlay.classList.remove('hidden');
}
function hideBusy() {
  busyOverlay.classList.add('hidden');
  busyProgress.classList.add('hidden');
}

// ============================================================
// USAGE COUNTER (local for now — Cloudflare Worker swap-in next)
// ============================================================

const COUNTER_KEY = 'vista_pdf_counter_v1';

function loadCounter() {
  try {
    const raw = localStorage.getItem(COUNTER_KEY);
    return raw ? JSON.parse(raw) : { uses: 0, files: 0, pages: 0 };
  } catch { return { uses: 0, files: 0, pages: 0 }; }
}
function saveCounter(c) {
  try { localStorage.setItem(COUNTER_KEY, JSON.stringify(c)); } catch {}
}
function renderCounter() {
  const c = loadCounter();
  $('counterUses').textContent = c.uses.toLocaleString();
  $('counterFiles').textContent = c.files.toLocaleString();
  $('counterPages').textContent = c.pages.toLocaleString();
}
function bumpCounter(files, pages) {
  const c = loadCounter();
  c.uses += 1;
  c.files += files;
  c.pages += (pages || 0);
  saveCounter(c);
  renderCounter();
}
renderCounter();
updateStepLocks();   // initialize step strip lock state at module load

// ============================================================
// WF stamp popup — hover 2s OR click → portrait + "Mark of Approval"
// ============================================================
(() => {
  const stamp = document.getElementById('wfStamp');
  const popup = document.getElementById('wfPopup');
  if (!stamp || !popup) return;

  const HOVER_DELAY = 2000;
  const HIDE_GRACE  = 200;   // small grace period so cursor can travel to popup

  let openTimer = null;
  let closeTimer = null;
  let isOpen = false;

  function open() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    popup.classList.add('visible');
    popup.setAttribute('aria-hidden', 'false');
    isOpen = true;
  }
  function close() {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    popup.classList.remove('visible');
    popup.setAttribute('aria-hidden', 'true');
    isOpen = false;
  }
  function scheduleOpen() {
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(open, HOVER_DELAY);
  }
  function scheduleClose() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!stamp.matches(':hover') && !popup.matches(':hover')) close();
    }, HIDE_GRACE);
  }
  function cancelOpen() {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  }

  stamp.addEventListener('mouseenter', scheduleOpen);
  stamp.addEventListener('mouseleave', () => { cancelOpen(); scheduleClose(); });

  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  });
  popup.addEventListener('mouseleave', scheduleClose);

  // Click on the stamp toggles the popup instantly (no 2s wait)
  stamp.addEventListener('click', (e) => {
    e.preventDefault();
    if (isOpen) close();
    else { cancelOpen(); open(); }
  });

  // Click outside dismisses
  document.addEventListener('click', (e) => {
    if (!isOpen) return;
    if (e.target.closest('.wf-stamp-wrap')) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });
})();

// ============================================================
// "Keep scrolling" indicator — shown on the EDIT stage when there's
// substantial content below the fold. Pulses at the bottom of the viewport.
// ============================================================
const scrollDownIndicator = document.getElementById('scrollDownIndicator');
function updateScrollIndicator() {
  if (!scrollDownIndicator) return;
  if (currentStage !== 'edit') {
    scrollDownIndicator.classList.remove('visible');
    return;
  }
  const distFromBottom =
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  // Show only if there's >200px of content still below the viewport
  scrollDownIndicator.classList.toggle('visible', distFromBottom > 200);
}
window.addEventListener('scroll', updateScrollIndicator, { passive: true });
window.addEventListener('resize', updateScrollIndicator);
// Recompute whenever the page grid mutates (renderPageGrid replaces children).
// MutationObserver fires once after each render — cheap and avoids polling.
if (pageGrid && typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => {
    // small defer so the new layout's height is reflected
    requestAnimationFrame(() => requestAnimationFrame(updateScrollIndicator));
  }).observe(pageGrid, { childList: true });
}

// ============================================================
// HELPERS
// ============================================================

function formatBytes(bytes) {
  if (bytes === 0 || bytes == null) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
