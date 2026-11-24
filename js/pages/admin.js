/**
 * admin.js — Atelier Wardrobe Admin (Add Garment Studio)
 * Handles image upload/cleaning, metadata, anchor placement canvas,
 * default size chart filling, validation, IndexedDB storage, and file downloads.
 */

import { cleanGarmentImage, hasTransparentBackground, magicEraseRegion } from '../core/garmentImage.js';
import {
  listCustomGarments,
  saveCustomGarment,
  deleteCustomGarment,
  getCustomGarment
} from '../core/garmentStore.js';
import { FilesetResolver, PoseLandmarker } from '../../lib/mediapipe/vision_bundle.mjs';

// --- State ---
const state = {
  rawImage: null,          // HTMLImageElement
  activeImage: null,       // HTMLImageElement or HTMLCanvasElement
  activeBlob: null,        // Blob (PNG)
  anchors: {},             // { pointName: [x, y] in original image px }
  currentPointIndex: 0,
  draggingPoint: null,     // Name of anchor being dragged, if any
  defaultCharts: null,     // Loaded from data/defaultCharts.json
  catalogGarments: [],     // Existing catalog garments for ID uniqueness
  savedCustoms: [],        // Custom garments from IndexedDB
  canvasScale: 1.0,        // Display scale factor (canvas px / image px)
  isEditingExisting: false, // Flag if editing an existing custom garment
  tolerance: 22,           // Current cleaning tolerance (default 22)
  magicEraserActive: false, // Whether magic eraser is active
  eraserHistory: [],       // History stack for Undo eraser: Array<ImageData>
  cleanedCanvas: null,     // Current cleaned canvas
  refPose: null,           // Phase 4B: { width, height, l11, l12, l13, l14, l15, l16, l23, l24 }
  refPoseRaw: null,        // Original detected refPose on reference photo
  refPoseGhost: null,      // Phase 4C: refPose converted into ghost PNG coordinates
  refImage: null,          // HTMLImageElement of worn reference
  ghostToRef: { scale: 1.0, dx: 0, dy: 0 }, // Phase 4C: refPx = ghostPx * scale + (dx, dy)
  alignOpacity: 0.5,       // Ghost opacity on alignment panel
  isDraggingGhost: false,
  dragStartMouse: { x: 0, y: 0 },
  dragStartOffset: { dx: 0, dy: 0 },
  ghostBbox: null,         // Alpha bounding box of ghost image
  neckFront: null,         // Phase 6: Collar V point in ghost PNG coordinates { x, y }
  neckFrontRaw: null,      // Phase 6: Collar V point in reference photo coordinates { x, y }
  refLandmarks: null,      // Phase 7: Raw 33 landmarks from worn reference
  cutFromWorn: false,      // Phase 7: Whether garment was cut from worn reference
  mannequinLegs: 'black',  // Phase 7: 'black' | 'green'
  garmentIsWhite: false,   // Phase 7: boolean
  neckline: 'closed'       // Phase 7: 'closed' | 'openV'
};

// Anchor points definition in order
const BASE_ANCHOR_KEYS = [
  'collarL', 'collarR',
  'shoulderL', 'shoulderR',
  'armpitL', 'armpitR',
  'hemL', 'hemR'
];

const CUFF_ANCHOR_KEYS = [
  'cuffOuterL', 'cuffInnerL',
  'cuffOuterR', 'cuffInnerR'
];

/**
 * Returns the expected sequence of anchor points based on current sleeveType.
 */
function getExpectedAnchorKeys() {
  const sleeveType = document.getElementById('garment-sleeve-type')?.value || 'long';
  if (sleeveType === 'none') {
    return [...BASE_ANCHOR_KEYS];
  }
  return [...BASE_ANCHOR_KEYS, ...CUFF_ANCHOR_KEYS];
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadDefaultCharts();
  await loadCatalogGarments();
  await refreshSavedList();
  setupUIEventListeners();
  setupAnchorCanvas();
  updateAnchorPrompt();
});

// Load default chart templates
async function loadDefaultCharts() {
  try {
    const res = await fetch('data/defaultCharts.json');
    if (res.ok) {
      const data = await res.json();
      state.defaultCharts = data.templates || {};
    }
  } catch (err) {
    console.warn('Could not load defaultCharts.json:', err);
  }
}

// Load catalog garments for ID collision check
async function loadCatalogGarments() {
  try {
    const res = await fetch('data/garments.json');
    if (res.ok) {
      const data = await res.json();
      state.catalogGarments = data.garments || [];
    }
  } catch (err) {
    console.warn('Could not load garments.json:', err);
  }
}

// Refresh saved custom garments list
async function refreshSavedList() {
  try {
    state.savedCustoms = await listCustomGarments();
  } catch (err) {
    console.warn('Could not fetch custom garments:', err);
    state.savedCustoms = [];
  }

  const badge = document.getElementById('saved-count-badge');
  if (badge) badge.textContent = state.savedCustoms.length;

  const container = document.getElementById('saved-garments-list');
  if (!container) return;

  if (state.savedCustoms.length === 0) {
    container.innerHTML = `<p class="muted text-sm" style="grid-column:1/-1;">No custom garments saved in this browser yet.</p>`;
    return;
  }

  container.innerHTML = '';
  for (const item of state.savedCustoms) {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.innerHTML = `
      <div class="saved-card-thumb">
        <img src="${item.image}" alt="${item.name}">
      </div>
      <div class="saved-card-body">
        <h4 class="saved-card-title">${item.name}</h4>
        <div class="saved-card-meta">
          <span>${item.category}</span> ·
          <span>${item.type}</span> ·
          <span>${item.gender}</span> ·
          <span>${item.sleeveType || 'long'}</span>
        </div>
      </div>
      <div class="saved-card-actions">
        <a href="dressing.html?garment=${encodeURIComponent(item.id)}" target="_blank" class="btn btn-ghost" style="font-size:0.75rem;">Try On ↗</a>
        <button type="button" class="btn btn-ghost edit-btn" style="font-size:0.75rem;">Edit</button>
        <button type="button" class="btn btn-ghost del-btn" style="font-size:0.75rem;color:#991B1B;">Delete</button>
      </div>
    `;

    card.querySelector('.edit-btn').addEventListener('click', () => loadGarmentIntoForm(item));
    card.querySelector('.del-btn').addEventListener('click', async () => {
      if (confirm(`Delete "${item.name}" from your wardrobe?`)) {
        await deleteCustomGarment(item.id);
        await refreshSavedList();
      }
    });

    container.appendChild(card);
  }
}

// --- Card 1: Upload & Image Cleaning ---
function setupUIEventListeners() {
  const fileInput = document.getElementById('garment-file-input');
  const selectBtn = document.getElementById('select-image-btn');
  const nameInput = document.getElementById('garment-name');
  const idInput = document.getElementById('garment-id');
  const colorInput = document.getElementById('garment-color');
  const colorHex = document.getElementById('garment-color-hex');
  const removeBgBtn = document.getElementById('remove-bg-btn');
  const acceptCleanedBtn = document.getElementById('accept-cleaned-btn');
  const keepOriginalBtn = document.getElementById('keep-original-btn');
  const fillChartBtn = document.getElementById('fill-default-chart-btn');
  const saveBtn = document.getElementById('save-garment-btn');
  const downloadBtn = document.getElementById('download-files-btn');
  const sleeveSelect = document.getElementById('garment-sleeve-type');

  selectBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelected);

  // Auto-generate slug ID from name
  nameInput.addEventListener('input', () => {
    if (!state.isEditingExisting) {
      const slug = nameInput.value.toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      idInput.value = slug;
    }
  });

  // Color picker sync
  colorInput.addEventListener('input', () => {
    colorHex.textContent = colorInput.value;
  });

  // Sleeve type changes require updating anchor sequence
  sleeveSelect.addEventListener('change', () => {
    updateAnchorPrompt();
    drawAnchorsOnCanvas();
  });

  // Background removal handlers
  removeBgBtn.addEventListener('click', handleRemoveBackground);

  // Tolerance slider live adjustment (8 - 40, default 22)
  const tolSlider = document.getElementById('tolerance-slider');
  const tolVal = document.getElementById('tolerance-val');
  if (tolSlider) {
    tolSlider.addEventListener('input', () => {
      const val = parseInt(tolSlider.value, 10) || 22;
      state.tolerance = val;
      if (tolVal) tolVal.textContent = val;
      if (state.rawImage) {
        handleRemoveBackground();
      }
    });
  }

  // Magic eraser toggle and handlers
  const magicBtn = document.getElementById('magic-eraser-btn');
  const magicHint = document.getElementById('magic-eraser-hint');
  const cleanedCanvas = document.getElementById('cleaned-canvas');
  const undoEraserBtn = document.getElementById('undo-eraser-btn');
  const resetCleanBtn = document.getElementById('reset-cleaning-btn');

  if (magicBtn) {
    magicBtn.addEventListener('click', () => {
      state.magicEraserActive = !state.magicEraserActive;
      if (state.magicEraserActive) {
        magicBtn.textContent = '🪄 Magic Eraser: ON';
        magicBtn.classList.remove('btn-ghost');
        magicBtn.classList.add('btn-primary');
        if (magicHint) magicHint.style.display = 'flex';
        if (cleanedCanvas) cleanedCanvas.style.cursor = 'crosshair';
      } else {
        magicBtn.textContent = '🪄 Magic Eraser: OFF';
        magicBtn.classList.add('btn-ghost');
        magicBtn.classList.remove('btn-primary');
        if (magicHint) magicHint.style.display = 'none';
        if (cleanedCanvas) cleanedCanvas.style.cursor = 'default';
      }
    });
  }

  // Brush eraser: press and drag to erase small leftovers that the colour-based Magic Eraser
  // cannot select (anti-aliased fingers, hair strands, thin strips). The preview is enlarged while
  // an eraser is on, because at 240 px high these leftovers are only a few pixels wide.
  const brushBtn = document.getElementById('brush-eraser-btn');
  const brushHint = document.getElementById('brush-eraser-hint');
  const brushSize = document.getElementById('brush-size-slider');
  // The brushes only work on the "Cleaned Canvas" editor. After "Use Cleaned Image" that editor is
  // hidden, so users clicked the preview image and nothing happened. Show it again (filled with the
  // current garment image) and scroll to it whenever a brush is switched on.
  const ensureEditorVisible = () => {
    const section = document.getElementById('bg-remove-section');
    const comp = document.getElementById('clean-compare-container');
    if (section) section.style.display = 'flex';
    if (comp) comp.style.display = 'flex';
    const src = state.activeImage || state.rawImage;
    if (cleanedCanvas && src && (!state.cleanedCanvas || cleanedCanvas.width === 0 || cleanedCanvas.width === 300)) {
      cleanedCanvas.width = src.naturalWidth || src.width;
      cleanedCanvas.height = src.naturalHeight || src.height;
      cleanedCanvas.getContext('2d').drawImage(src, 0, 0);
      state.cleanedCanvas = cleanedCanvas;
    }
    const compOrig = document.getElementById('compare-original-img');
    if (compOrig && state.refImage && !compOrig.src) compOrig.src = state.refImage.src;
    cleanedCanvas?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const setEnlarged = (on) => {
    if (on) ensureEditorVisible();
    const wrap = document.getElementById('cleaned-preview-wrap');
    if (wrap) { wrap.style.maxHeight = on ? 'none' : '240px'; }
    if (cleanedCanvas) {
      cleanedCanvas.style.maxHeight = on ? '640px' : '240px';
      cleanedCanvas.style.cursor = on ? 'crosshair' : 'default';
    }
  };
  if (brushBtn) {
    brushBtn.addEventListener('click', () => {
      state.brushEraserActive = !state.brushEraserActive;
      brushBtn.textContent = state.brushEraserActive ? '🧽 Brush Eraser: ON' : '🧽 Brush Eraser: OFF';
      brushBtn.classList.toggle('btn-primary', state.brushEraserActive);
      brushBtn.classList.toggle('btn-ghost', !state.brushEraserActive);
      if (brushHint) brushHint.style.display = state.brushEraserActive ? 'flex' : 'none';
      if (state.brushEraserActive && state.magicEraserActive && magicBtn) magicBtn.click();
      setEnlarged(state.brushEraserActive || state.magicEraserActive);
    });
  }
  // Restore brush: paints the ORIGINAL worn-reference pixels back (same canvas frame for
  // cut-from-worn garments). Fixes parts of the garment the automatic cut removed by mistake
  // (cuff edges near the hands, the top of a tall collar near the chin).
  const restoreBtn = document.getElementById('restore-brush-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      state.restoreBrushActive = !state.restoreBrushActive;
      restoreBtn.textContent = state.restoreBrushActive ? '🖌️ Restore Brush: ON' : '🖌️ Restore Brush: OFF';
      restoreBtn.classList.toggle('btn-primary', state.restoreBrushActive);
      restoreBtn.classList.toggle('btn-ghost', !state.restoreBrushActive);
      if (state.restoreBrushActive && state.brushEraserActive && brushBtn) brushBtn.click();
      if (state.restoreBrushActive && state.magicEraserActive && magicBtn) magicBtn.click();
      const hint = document.getElementById('brush-eraser-hint');
      const txt = document.getElementById('brush-hint-text');
      if (hint) hint.style.display = (state.restoreBrushActive || state.brushEraserActive) ? 'flex' : 'none';
      if (txt && state.restoreBrushActive) txt.innerHTML = '🖌️ <strong>Restore Brush active:</strong> drag over parts of the garment that were cut away by mistake; the original photo is painted back. Then click <strong>Use Cleaned Image</strong>.';
      setEnlarged(state.restoreBrushActive || state.brushEraserActive || state.magicEraserActive);
    });
  }
  if (brushBtn) {
    brushBtn.addEventListener('click', () => {
      if (state.brushEraserActive && state.restoreBrushActive && restoreBtn) restoreBtn.click();
      const txt = document.getElementById('brush-hint-text');
      if (txt && state.brushEraserActive) txt.innerHTML = '🧽 <strong>Brush Eraser active:</strong> press and drag over leftovers (fingers, hair, thin strips). Then click <strong>Use Cleaned Image</strong>.';
      setEnlarged(state.restoreBrushActive || state.brushEraserActive || state.magicEraserActive);
    });
  }
  if (magicBtn) {
    magicBtn.addEventListener('click', () => {
      if (state.magicEraserActive && state.restoreBrushActive && restoreBtn) restoreBtn.click();
      if (state.magicEraserActive && state.brushEraserActive && brushBtn) brushBtn.click();
      setEnlarged(state.brushEraserActive || state.magicEraserActive);
    });
  }
  if (cleanedCanvas) {
    let brushing = false;
    const brushAt = (e) => {
      const rect = cleanedCanvas.getBoundingClientRect();
      const sx = cleanedCanvas.width / rect.width;
      const x = (e.clientX - rect.left) * sx;
      const y = (e.clientY - rect.top) * (cleanedCanvas.height / rect.height);
      const r = (parseFloat(brushSize?.value) || 12) * sx;
      const ctx = cleanedCanvas.getContext('2d');
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (state.restoreBrushActive) {
        const src = state.refImage;
        if (src) {
          ctx.clip();
          ctx.drawImage(src, 0, 0, cleanedCanvas.width, cleanedCanvas.height);
        }
      } else {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fill();
      }
      ctx.restore();
    };
    cleanedCanvas.addEventListener('pointerdown', (e) => {
      if (!state.brushEraserActive && !state.restoreBrushActive) return;
      e.preventDefault();
      const ctx = cleanedCanvas.getContext('2d');
      state.eraserHistory.push(ctx.getImageData(0, 0, cleanedCanvas.width, cleanedCanvas.height));
      if (undoEraserBtn) undoEraserBtn.disabled = false;
      brushing = true;
      cleanedCanvas.setPointerCapture?.(e.pointerId);
      brushAt(e);
    });
    cleanedCanvas.addEventListener('pointermove', (e) => { if (brushing) brushAt(e); });
    const stop = () => { brushing = false; };
    cleanedCanvas.addEventListener('pointerup', stop);
    cleanedCanvas.addEventListener('pointercancel', stop);
  }

  if (cleanedCanvas) {
    cleanedCanvas.addEventListener('click', (e) => {
      if (state.brushEraserActive || state.restoreBrushActive) return;
      if (!state.magicEraserActive || !state.cleanedCanvas) return;
      const rect = cleanedCanvas.getBoundingClientRect();
      const scaleX = cleanedCanvas.width / rect.width;
      const scaleY = cleanedCanvas.height / rect.height;
      const clickX = Math.floor((e.clientX - rect.left) * scaleX);
      const clickY = Math.floor((e.clientY - rect.top) * scaleY);

      // Save snapshot for undo
      const ctx = cleanedCanvas.getContext('2d');
      const snapshot = ctx.getImageData(0, 0, cleanedCanvas.width, cleanedCanvas.height);
      state.eraserHistory.push(snapshot);
      if (undoEraserBtn) undoEraserBtn.disabled = false;

      // Run magic erase on connected region
      const tol = state.tolerance || 22;
      const modified = magicEraseRegion(cleanedCanvas, clickX, clickY, tol);
      if (!modified) {
        state.eraserHistory.pop();
        if (undoEraserBtn) undoEraserBtn.disabled = state.eraserHistory.length === 0;
      }
    });
  }

  if (undoEraserBtn) {
    undoEraserBtn.addEventListener('click', () => {
      if (state.eraserHistory.length > 0 && state.cleanedCanvas) {
        const prev = state.eraserHistory.pop();
        const ctx = state.cleanedCanvas.getContext('2d');
        ctx.putImageData(prev, 0, 0);
        undoEraserBtn.disabled = state.eraserHistory.length === 0;
      }
    });
  }

  if (resetCleanBtn) {
    resetCleanBtn.addEventListener('click', () => {
      if (!state.rawImage || !state.cleanedCanvas) return;
      const ctx = state.cleanedCanvas.getContext('2d');
      ctx.clearRect(0, 0, state.cleanedCanvas.width, state.cleanedCanvas.height);
      ctx.drawImage(state.rawImage, 0, 0);
      state.eraserHistory = [];
      if (undoEraserBtn) undoEraserBtn.disabled = true;
    });
  }

  acceptCleanedBtn.addEventListener('click', () => {
    if (state.cleanedCanvas) {
      state.cleanedCanvas.toBlob((blob) => {
        if (!blob) return;
        state.activeBlob = blob;
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          state.activeImage = img;
          document.getElementById('upload-preview-img').src = objectUrl;
          document.getElementById('clean-compare-container').style.display = 'none';
          if (state.magicEraserActive && magicBtn) {
            magicBtn.click();
          }
          initAnchorCanvasImage();
          // Phase 4C: If refImage and refPose exist, update auto-align guess and draw
          if (state.refImage && (state.refPoseRaw || state.refPose) && !state.cutFromWorn) {
            state.ghostBbox = null;
            state.ghostToRef = computeAutoGhostToRef();
            updateAlignUI();
            drawAlignCanvas();
          }
        };
        img.src = objectUrl;
      }, 'image/png');
    }
  });

  keepOriginalBtn.addEventListener('click', () => {
    document.getElementById('clean-compare-container').style.display = 'none';
    if (state.magicEraserActive && magicBtn) {
      magicBtn.click();
    }
  });

  // Size chart handlers
  fillChartBtn.addEventListener('click', handleFillDefaultChart);

  // Template fit & Worn Reference Image handlers (Phase 4B)
  const templateCheckbox = document.getElementById('garment-render-mode');
  if (templateCheckbox) {
    templateCheckbox.addEventListener('change', updateTemplateRefSectionVisibility);
  }

  const selectRefBtn = document.getElementById('select-ref-image-btn');
  const refFileInput = document.getElementById('ref-image-input');
  const clearRefBtn = document.getElementById('clear-ref-image-btn');

  if (selectRefBtn && refFileInput) {
    selectRefBtn.addEventListener('click', () => refFileInput.click());
    refFileInput.addEventListener('change', handleRefImageSelected);
  }

  if (clearRefBtn) {
    clearRefBtn.addEventListener('click', handleClearRefImage);
  }

  // Phase 7: Cut garment directly from worn reference
  const cutGarmentBtn = document.getElementById('cut-garment-btn');
  if (cutGarmentBtn) {
    cutGarmentBtn.addEventListener('click', handleCutGarmentFromWorn);
  }

  // Phase 4C: Setup alignment panel controls
  setupGhostAlignListeners();

  // Save & Export handlers
  saveBtn.addEventListener('click', handleSaveGarment);
  downloadBtn.addEventListener('click', handleDownloadFiles);
}

/**
 * Handle image file selection
 */
async function handleFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  // Validation: Max 5 MB
  if (file.size > 5 * 1024 * 1024) {
    alert('File is too large. Maximum allowed size is 5 MB.');
    return;
  }

  document.getElementById('file-name-label').textContent = file.name;

  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    // Validation: Min width 800 px
    if (img.naturalWidth < 800) {
      alert(`Image width is ${img.naturalWidth}px. Minimum recommended width is 800px for accurate try-on fitting.`);
    }

    state.rawImage = img;
    state.activeImage = img;
    state.activeBlob = file;

    // Phase 4C: If refImage and refPose exist, update auto-align guess and draw
    if (state.refImage && (state.refPoseRaw || state.refPose)) {
      state.ghostBbox = null;
      state.ghostToRef = computeAutoGhostToRef();
      const alignPanel = document.getElementById('ghost-align-panel');
      if (alignPanel) alignPanel.style.display = 'flex';
      updateAlignUI();
      drawAlignCanvas();
    }

    // Display in Card 1 preview
    const previewImg = document.getElementById('upload-preview-img');
    const placeholder = document.getElementById('upload-placeholder-text');
    previewImg.src = objectUrl;
    previewImg.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';

    // Check transparency
    const hasTrans = hasTransparentBackground(img);
    const bgSection = document.getElementById('bg-remove-section');
    if (!hasTrans) {
      bgSection.style.display = 'flex';
      handleRemoveBackground();
    } else {
      bgSection.style.display = 'none';
    }

    // Set up anchor canvas
    initAnchorCanvasImage();
  };
  img.src = objectUrl;
}

/**
 * Background removal using cleanGarmentImage (protectCentre: false for admin page)
 */
async function handleRemoveBackground() {
  if (!state.rawImage) return;

  const tolerance = state.tolerance || 22;
  // Admin cleaning uses protectCentre = false (flood fill whole image, no central barrier, no 2% rollback)
  const cleanedCanvas = cleanGarmentImage(state.rawImage, {
    tolerance,
    protectCentre: false
  });

  const canvas = document.getElementById('cleaned-canvas');
  if (canvas && cleanedCanvas) {
    canvas.width = cleanedCanvas.width;
    canvas.height = cleanedCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cleanedCanvas, 0, 0);
    state.cleanedCanvas = canvas;
    state.eraserHistory = [];
    const undoEraserBtn = document.getElementById('undo-eraser-btn');
    if (undoEraserBtn) undoEraserBtn.disabled = true;
  }

  const compOrig = document.getElementById('compare-original-img');
  if (compOrig) compOrig.src = state.rawImage.src;

  const compareContainer = document.getElementById('clean-compare-container');
  if (compareContainer) compareContainer.style.display = 'flex';
}

// --- Phase 4B: Reference Pose Detection & Landmark Sync ---

let adminPoseLandmarker = null;
async function getAdminPoseLandmarker() {
  if (adminPoseLandmarker) return adminPoseLandmarker;
  const vision = await FilesetResolver.forVisionTasks('./lib/mediapipe');
  try {
    adminPoseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: './lib/mediapipe/pose_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      numPoses: 1,
      outputSegmentationMasks: true
    });
  } catch (gpuErr) {
    console.warn('MediaPipe GPU delegate unavailable in Admin, falling back to CPU:', gpuErr);
    adminPoseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: './lib/mediapipe/pose_landmarker.task',
        delegate: 'CPU'
      },
      runningMode: 'IMAGE',
      numPoses: 1,
      outputSegmentationMasks: true
    });
  }
  return adminPoseLandmarker;
}

function syncRefPoseWithGhost(refPose, ghostImg) {
  if (!refPose || !ghostImg) return refPose;
  const ghostW = ghostImg.naturalWidth || ghostImg.width;
  const ghostH = ghostImg.naturalHeight || ghostImg.height;
  if (!ghostW || !ghostH) return refPose;

  if (refPose.width === ghostW && refPose.height === ghostH) {
    return refPose;
  }

  const baseW = refPose.rawRefWidth || refPose.width;
  const baseH = refPose.rawRefHeight || refPose.height;
  const arGhost = ghostW / ghostH;
  const arRef = baseW / baseH;
  const arDiff = Math.abs(arGhost - arRef) / arRef;

  const scaleX = ghostW / baseW;
  const scaleY = ghostH / baseH;

  const scalePoint = (pt) => pt ? { x: +(pt.x * scaleX).toFixed(1), y: +(pt.y * scaleY).toFixed(1) } : null;

  return {
    width: ghostW,
    height: ghostH,
    rawRefWidth: baseW,
    rawRefHeight: baseH,
    arWarning: arDiff > 0.02
      ? `Reference image aspect ratio (${arRef.toFixed(3)}) differs from ghost PNG (${arGhost.toFixed(3)}) by ${(arDiff * 100).toFixed(1)}%.`
      : null,
    l11: scalePoint(refPose.rawL11 || refPose.l11),
    l12: scalePoint(refPose.rawL12 || refPose.l12),
    l13: scalePoint(refPose.rawL13 || refPose.l13),
    l14: scalePoint(refPose.rawL14 || refPose.l14),
    l15: scalePoint(refPose.rawL15 || refPose.l15),
    l16: scalePoint(refPose.rawL16 || refPose.l16),
    l23: scalePoint(refPose.rawL23 || refPose.l23),
    l24: scalePoint(refPose.rawL24 || refPose.l24),
    rawL11: refPose.rawL11 || refPose.l11,
    rawL12: refPose.rawL12 || refPose.l12,
    rawL13: refPose.rawL13 || refPose.l13,
    rawL14: refPose.rawL14 || refPose.l14,
    rawL15: refPose.rawL15 || refPose.l15,
    rawL16: refPose.rawL16 || refPose.l16,
    rawL23: refPose.rawL23 || refPose.l23,
    rawL24: refPose.rawL24 || refPose.l24
  };
}

async function handleRefImageSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const fileNameLabel = document.getElementById('ref-file-name');
  if (fileNameLabel) fileNameLabel.textContent = file.name;

  const statusEl = document.getElementById('ref-pose-status');
  statusEl.style.display = 'block';
  statusEl.className = 'notice-banner';
  statusEl.textContent = 'Detecting mannequin pose landmarks via MediaPipe...';

  const clearBtn = document.getElementById('clear-ref-image-btn');
  if (clearBtn) clearBtn.style.display = 'inline-flex';

  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    state.refImage = img;
    try {
      const landmarker = await getAdminPoseLandmarker();
      const poseResult = landmarker.detect(img);

      if (!poseResult || !poseResult.landmarks || poseResult.landmarks.length === 0) {
        statusEl.className = 'error-banner';
        statusEl.textContent = '❌ No mannequin/person detected in the reference photo. Please check the image.';
        return;
      }

      const l = poseResult.landmarks[0];
      if (!l[11] || !l[12]) {
        statusEl.className = 'error-banner';
        statusEl.textContent = '❌ Shoulder landmarks could not be detected with sufficient confidence.';
        return;
      }

      const refW = img.naturalWidth;
      const refH = img.naturalHeight;

      const rawPose = {
        width: refW,
        height: refH,
        rawRefWidth: refW,
        rawRefHeight: refH,
        l11: { x: +(l[11].x * refW).toFixed(1), y: +(l[11].y * refH).toFixed(1) },
        l12: { x: +(l[12].x * refW).toFixed(1), y: +(l[12].y * refH).toFixed(1) },
        l13: l[13] ? { x: +(l[13].x * refW).toFixed(1), y: +(l[13].y * refH).toFixed(1) } : null,
        l14: l[14] ? { x: +(l[14].x * refW).toFixed(1), y: +(l[14].y * refH).toFixed(1) } : null,
        l15: l[15] ? { x: +(l[15].x * refW).toFixed(1), y: +(l[15].y * refH).toFixed(1) } : null,
        l16: l[16] ? { x: +(l[16].x * refW).toFixed(1), y: +(l[16].y * refH).toFixed(1) } : null,
        l23: l[23] ? { x: +(l[23].x * refW).toFixed(1), y: +(l[23].y * refH).toFixed(1) } : null,
        l24: l[24] ? { x: +(l[24].x * refW).toFixed(1), y: +(l[24].y * refH).toFixed(1) } : null
      };
      rawPose.rawL11 = rawPose.l11;
      rawPose.rawL12 = rawPose.l12;
      rawPose.rawL13 = rawPose.l13;
      rawPose.rawL14 = rawPose.l14;
      rawPose.rawL15 = rawPose.l15;
      rawPose.rawL16 = rawPose.l16;
      rawPose.rawL23 = rawPose.l23;
      rawPose.rawL24 = rawPose.l24;

      state.refPoseRaw = rawPose;
      state.refPose = rawPose;

      // Phase 6: Auto-detect collar front point (V point) on worn reference image
      const neckFrontRaw = detectCollarFrontPoint(img, poseResult.landmarks[0]);
      state.neckFrontRaw = neckFrontRaw;
      state.neckFront = neckFrontRaw ? { ...neckFrontRaw } : null;
      state.refLandmarks = poseResult.landmarks[0];

      drawRefPoseCanvas(img, rawPose);

      // Phase 4C: If ghost image is loaded, auto-align and display alignment panel
      const ghostImg = state.activeImage || state.rawImage;
      if (ghostImg) {
        state.ghostBbox = null;
        state.ghostToRef = computeAutoGhostToRef();
        const alignPanel = document.getElementById('ghost-align-panel');
        if (alignPanel) alignPanel.style.display = 'flex';
        updateAlignUI();
        drawAlignCanvas();
      }

      const shoulderSpan = Math.hypot(rawPose.l11.x - rawPose.l12.x, rawPose.l11.y - rawPose.l12.y);
      let torsoHeight = 0;
      if (rawPose.l23 && rawPose.l24) {
        const midShoulder = { x: (rawPose.l11.x + rawPose.l12.x)/2, y: (rawPose.l11.y + rawPose.l12.y)/2 };
        const midHip = { x: (rawPose.l23.x + rawPose.l24.x)/2, y: (rawPose.l23.y + rawPose.l24.y)/2 };
        torsoHeight = Math.hypot(midHip.x - midShoulder.x, midHip.y - midShoulder.y);
      }

      statusEl.className = 'success-banner';
      let msg = `✓ Reference pose detected: Shoulder span ${shoulderSpan.toFixed(1)}px, Torso height ${torsoHeight.toFixed(1)}px.`;
      statusEl.innerHTML = msg;
    } catch (err) {
      statusEl.className = 'error-banner';
      statusEl.textContent = `Error detecting pose: ${err.message}`;
    }
  };
  img.src = objectUrl;
}

/**
 * Phase 6: Auto-detect collar front point (collar V point) on worn reference mannequin image:
 * scans vertical line at shoulder midpoint x downward from chin to find lowest skin pixel.
 */
function detectCollarFrontPoint(img, landmarks) {
  if (!img || !landmarks || !landmarks[11] || !landmarks[12]) return null;

  const refW = img.naturalWidth || img.width;
  const refH = img.naturalHeight || img.height;

  const canvas = document.createElement('canvas');
  canvas.width = refW;
  canvas.height = refH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const l11 = { x: landmarks[11].x * refW, y: landmarks[11].y * refH };
  const l12 = { x: landmarks[12].x * refW, y: landmarks[12].y * refH };
  const midShoulderX = Math.round((l11.x + l12.x) / 2);
  const midShoulderY = Math.round((l11.y + l12.y) / 2);
  const shoulderSpan = Math.hypot(l11.x - l12.x, l11.y - l12.y);

  // Chin Y from mouth landmarks 9/10, nose 0, or shoulder reference
  let chinY;
  if (landmarks[9] && landmarks[10]) {
    chinY = Math.round(((landmarks[9].y + landmarks[10].y) / 2) * refH + 0.05 * shoulderSpan);
  } else if (landmarks[0]) {
    chinY = Math.round(landmarks[0].y * refH + 0.25 * shoulderSpan);
  } else {
    chinY = Math.round(midShoulderY - 0.3 * shoulderSpan);
  }

  const maxY = Math.min(refH - 1, Math.round(midShoulderY + 0.45 * shoulderSpan));
  const startY = Math.max(0, chinY);

  if (maxY <= startY) {
    return { x: midShoulderX, y: Math.round(midShoulderY + 0.12 * shoulderSpan) };
  }

  const stripW = 5;
  const stripX = Math.max(0, Math.min(refW - stripW, midShoulderX - 2));
  const stripH = maxY - startY + 1;
  const imgData = ctx.getImageData(stripX, startY, stripW, stripH);
  const data = imgData.data;

  let lowestSkinY = null;

  // Skin rule: NOT near-white (all channels > 215, ignores white T-shirt)
  // and NOT near-black (luminance < 60)
  for (let row = 0; row < stripH; row++) {
    let isSkinRow = false;
    for (let col = 0; col < stripW; col++) {
      const idx = (row * stripW + col) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      const isNearWhite = (r > 215 && g > 215 && b > 215);
      const isNearBlack = (lum < 60);
      const isSkinTone = (r > 65 && r > b && (r - b) > 8);

      if (!isNearWhite && !isNearBlack && isSkinTone) {
        isSkinRow = true;
        break;
      }
    }

    if (isSkinRow) {
      lowestSkinY = startY + row;
    }
  }

  const finalY = lowestSkinY !== null ? lowestSkinY : Math.round(midShoulderY + 0.12 * shoulderSpan);
  return { x: midShoulderX, y: finalY };
}

function drawRefPoseCanvas(img, pose) {
  const wrap = document.getElementById('ref-preview-wrap');
  const canvas = document.getElementById('ref-pose-canvas');
  if (!wrap || !canvas) return;

  wrap.style.display = 'flex';
  canvas.width = pose.width || img.naturalWidth;
  canvas.height = pose.height || img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  ctx.lineWidth = Math.max(3, Math.round(canvas.width / 250));
  ctx.strokeStyle = '#00e5ff';

  const drawBone = (p1, p2) => {
    if (!p1 || !p2) return;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  };

  drawBone(pose.l12, pose.l11);
  drawBone(pose.l12, pose.l14);
  drawBone(pose.l14, pose.l16);
  drawBone(pose.l11, pose.l13);
  drawBone(pose.l13, pose.l15);
  if (pose.l24 && pose.l23) {
    drawBone(pose.l12, pose.l24);
    drawBone(pose.l11, pose.l23);
    drawBone(pose.l24, pose.l23);
  }

  const ptRadius = Math.max(5, Math.round(canvas.width / 160));
  const nodes = [
    { pt: pose.l12, label: 'R Shoulder (12)', color: '#00e5ff' },
    { pt: pose.l11, label: 'L Shoulder (11)', color: '#00e5ff' },
    { pt: pose.l14, label: 'R Elbow (14)', color: '#ffea00' },
    { pt: pose.l13, label: 'L Elbow (13)', color: '#ffea00' },
    { pt: pose.l16, label: 'R Wrist (16)', color: '#ff9100' },
    { pt: pose.l15, label: 'L Wrist (15)', color: '#ff9100' },
    { pt: pose.l24, label: 'R Hip (24)', color: '#76ff03' },
    { pt: pose.l23, label: 'L Hip (23)', color: '#76ff03' }
  ];

  ctx.font = `bold ${Math.max(12, Math.round(canvas.width / 65))}px sans-serif`;
  for (const n of nodes) {
    if (!n.pt) continue;
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(n.pt.x, n.pt.y, ptRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    const textWidth = ctx.measureText(n.label).width;
    const pad = 4;
    const tx = Math.max(pad, Math.min(canvas.width - textWidth - pad, n.pt.x - textWidth / 2));
    const ty = n.pt.y - ptRadius - 6;
    ctx.fillRect(tx - pad, ty - 12, textWidth + pad * 2, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(n.label, tx, ty);
  }
}

function displayLoadedRefPose(refPose) {
  const statusEl = document.getElementById('ref-pose-status');
  const fileNameLabel = document.getElementById('ref-file-name');
  const clearBtn = document.getElementById('clear-ref-image-btn');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.className = 'success-banner';
    const sSpan = Math.hypot(refPose.l11.x - refPose.l12.x, refPose.l11.y - refPose.l12.y);
    let extra = '';
    if (state.ghostToRef && (state.ghostToRef.scale !== 1 || state.ghostToRef.dx !== 0 || state.ghostToRef.dy !== 0)) {
      extra = ` | Ghost alignment: ${state.ghostToRef.scale}× (dx:${state.ghostToRef.dx}, dy:${state.ghostToRef.dy})`;
    }
    statusEl.innerHTML = `✓ Reference pose loaded from garment: Shoulder span ${sSpan.toFixed(1)}px (${refPose.width}×${refPose.height}px frame)${extra}.`;
  }
  if (fileNameLabel) {
    fileNameLabel.textContent = 'Reference pose data attached';
  }
  if (clearBtn) {
    clearBtn.style.display = 'inline-flex';
  }
}

function clearRefPoseDisplay() {
  const statusEl = document.getElementById('ref-pose-status');
  const fileNameLabel = document.getElementById('ref-file-name');
  const clearBtn = document.getElementById('clear-ref-image-btn');
  const previewWrap = document.getElementById('ref-preview-wrap');
  const fileInput = document.getElementById('ref-image-input');
  if (statusEl) statusEl.style.display = 'none';
  if (fileNameLabel) fileNameLabel.textContent = 'No reference image chosen';
  if (clearBtn) clearBtn.style.display = 'none';
  if (previewWrap) previewWrap.style.display = 'none';
  if (fileInput) fileInput.value = '';
}

function handleClearRefImage() {
  state.refPose = null;
  state.refPoseRaw = null;
  state.refPoseGhost = null;
  state.refImage = null;
  state.refLandmarks = null;
  state.neckFront = null;
  state.neckFrontRaw = null;
  state.cutFromWorn = false;
  state.ghostToRef = { scale: 1.0, dx: 0, dy: 0 };
  const alignPanel = document.getElementById('ghost-align-panel');
  if (alignPanel) alignPanel.style.display = 'none';
  const autoAlignBadge = document.getElementById('auto-align-badge');
  if (autoAlignBadge) autoAlignBadge.style.display = 'none';
  clearRefPoseDisplay();
}

function updateTemplateRefSectionVisibility() {
  const isTemplate = document.getElementById('garment-render-mode')?.checked;
  const section = document.getElementById('template-ref-section');
  const anchorSub = document.getElementById('anchors-card-sub');
  if (section) {
    section.style.display = isTemplate ? 'flex' : 'none';
  }
  if (anchorSub) {
    anchorSub.textContent = isTemplate
      ? 'Optional for standard-pose AI garments (refPose handles alignment)'
      : 'Click points in order on the photo';
  }
}

// --- Phase 7: Cut garment directly from worn reference image (skips Gemini Step B) ---

/**
 * Cuts the garment directly out of the step A worn reference image in the browser.
 * Uses MediaPipe PoseLandmarker segmentation masks + pose landmarks + color/geometric heuristics.
 * Zero AI calls.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} refImg - Full-resolution worn reference image
 * @param {object} options
 * @param {string} options.mannequinLegs - 'black' | 'green'
 * @param {boolean} options.garmentIsWhite - whether garment is white/very light
 * @param {string} options.neckline - 'closed' | 'openV'
 * @returns {Promise<HTMLCanvasElement>} Clean garment PNG canvas on exact same frame
 */
async function cutGarmentFromWornImage(refImg, options = {}) {
  const mannequinLegs = options.mannequinLegs || 'black';
  const garmentIsWhite = Boolean(options.garmentIsWhite);
  const neckline = options.neckline || 'closed';

  const landmarker = await getAdminPoseLandmarker();
  const poseResult = landmarker.detect(refImg);
  if (!poseResult || !poseResult.landmarks || poseResult.landmarks.length === 0) {
    throw new Error('No mannequin or person detected in reference image.');
  }

  const landmarks = poseResult.landmarks[0];
  const sm = (poseResult.segmentationMasks && poseResult.segmentationMasks.length > 0)
    ? poseResult.segmentationMasks[0]
    : null;

  const W = refImg.naturalWidth || refImg.width;
  const H = refImg.naturalHeight || refImg.height;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(refImg, 0, 0, W, H);
  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;

  // Extract segmentation mask data
  let maskW = 0, maskH = 0, maskData = null;
  if (sm) {
    maskW = sm.width;
    maskH = sm.height;
    maskData = sm.getAsFloat32Array ? sm.getAsFloat32Array() : (sm.getAsUint8Array ? sm.getAsUint8Array() : null);
  }
  const maskIsUint8 = maskData && !(maskData instanceof Float32Array);

  const getPt = (idx) => {
    if (!landmarks || !landmarks[idx]) return null;
    return { x: landmarks[idx].x * W, y: landmarks[idx].y * H };
  };

  const p0 = getPt(0);
  const p7 = getPt(7), p8 = getPt(8);
  const p9 = getPt(9), p10 = getPt(10);
  const p11 = getPt(11), p12 = getPt(12);
  const p13 = getPt(13), p14 = getPt(14);
  const p15 = getPt(15), p16 = getPt(16);
  const p17 = getPt(17), p18 = getPt(18);
  const p19 = getPt(19), p20 = getPt(20);
  const p21 = getPt(21), p22 = getPt(22);
  const p23 = getPt(23), p24 = getPt(24);
  const p27 = getPt(27), p28 = getPt(28);

  const shoulderSpan = (p11 && p12) ? Math.hypot(p11.x - p12.x, p11.y - p12.y) : W * 0.25;
  const pxPerCm = shoulderSpan / 36.0;

  // Step 2a: Base mask. For every pixel (x, y), if MediaPipe confidence >= 0.5, alpha = 255 else 0
  const alpha = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const my = maskData ? Math.min(maskH - 1, Math.max(0, Math.floor(y * (maskH / H)))) : 0;
    const rowOffset = y * W;
    for (let x = 0; x < W; x++) {
      let isFg = true;
      if (maskData) {
        const mx = Math.min(maskW - 1, Math.max(0, Math.floor(x * (maskW / W))));
        const val = maskData[my * maskW + mx];
        isFg = val >= (maskIsUint8 ? 128 : 0.5);
      }
      if (isFg) {
        alpha[rowOffset + x] = 255;
      }
    }
  }

  // Step 2b: Remove head
  // Fit an ellipse to the head using landmarks 7, 8 (ears), 0 (nose), 9, 10 (mouth):
  // center = ear midpoint, radiusX = distance(7,8) * 0.95, radiusY = radiusX * 1.3,
  // top = top of hair (ear.y - radiusY * 0.6), bottom = chin (mouth.y + 1.5 cm).
  // Set alpha = 0 inside this ellipse and anywhere above it within the neck x-range.
  let earMidX = W * 0.5, earMidY = H * 0.15, earDist = shoulderSpan * 0.45;
  if (p7 && p8) {
    earMidX = (p7.x + p8.x) / 2;
    earMidY = (p7.y + p8.y) / 2;
    earDist = Math.hypot(p7.x - p8.x, p7.y - p8.y);
  } else if (p0) {
    earMidX = p0.x;
    earMidY = p0.y - 15;
  }
  const radiusX = Math.max(15, earDist * 0.95);
  const radiusY = radiusX * 1.3;
  const mouthY = (p9 && p10) ? (p9.y + p10.y) / 2 : (p0 ? p0.y + 20 : earMidY + radiusY * 0.8);
  const chinY = mouthY + 1.5 * pxPerCm;

  const earMinX = (p7 && p8) ? Math.min(p7.x, p8.x) : earMidX - radiusX;
  const earMaxX = (p7 && p8) ? Math.max(p7.x, p8.x) : earMidX + radiusX;
  const neckMinX = earMinX - (earMaxX - earMinX) * 0.15;
  const neckMaxX = earMaxX + (earMaxX - earMinX) * 0.15;

  for (let y = 0; y <= Math.min(H - 1, Math.ceil(chinY)); y++) {
    const rowOffset = y * W;
    for (let x = 0; x < W; x++) {
      const dx = (x - earMidX) / radiusX;
      const dy = (y - earMidY) / radiusY;
      const insideEllipse = (dx * dx + dy * dy <= 1.0) && (y <= chinY);
      const aboveWithinNeck = (y < earMidY) && (x >= neckMinX && x <= neckMaxX);
      if (insideEllipse || aboveWithinNeck) {
        alpha[rowOffset + x] = 0;
      }
    }
  }

  // Step 2c: Remove skin
  // Scan pixels in the neck column (between ears, from chin to shoulder line + 4 cm)
  // and the hand regions (wrist 15/16 extended to fingers 17-22, radius ~ 1.5x wrist width)
  // and feet (below ankle landmarks 27/28):
  // if skin-toned (warm hue: R > B + 18 and R >= G, luminance > 60, not near-white (all channels > 215)), alpha = 0.
  const shoulderY = (p11 && p12) ? (p11.y + p12.y) / 2 : chinY + 5 * pxPerCm;
  const neckBottomY = shoulderY + 4.0 * pxPerCm;

  // Browser check (cardigan): fingers survived with 2.5 cm, so the hand regions are bigger now.
  const wristRadius = Math.max(24, 4.0 * pxPerCm);
  const handLeftCenters = [];
  if (p15) {
    handLeftCenters.push({ x: p15.x, y: p15.y, r: wristRadius });
    const fingersL = [p17, p19, p21].filter(Boolean);
    if (fingersL.length > 0) {
      const avgFx = fingersL.reduce((s, p) => s + p.x, 0) / fingersL.length;
      const avgFy = fingersL.reduce((s, p) => s + p.y, 0) / fingersL.length;
      handLeftCenters.push({
        x: p15.x + (avgFx - p15.x) * 1.2,
        y: p15.y + (avgFy - p15.y) * 1.2,
        r: wristRadius * 1.6
      });
    }
  }

  const handRightCenters = [];
  if (p16) {
    handRightCenters.push({ x: p16.x, y: p16.y, r: wristRadius });
    const fingersR = [p18, p20, p22].filter(Boolean);
    if (fingersR.length > 0) {
      const avgFx = fingersR.reduce((s, p) => s + p.x, 0) / fingersR.length;
      const avgFy = fingersR.reduce((s, p) => s + p.y, 0) / fingersR.length;
      handRightCenters.push({
        x: p16.x + (avgFx - p16.x) * 1.2,
        y: p16.y + (avgFy - p16.y) * 1.2,
        r: wristRadius * 1.6
      });
    }
  }

  const ankleY = (p27 && p28) ? Math.min(p27.y, p28.y) : (p27 ? p27.y : (p28 ? p28.y : H + 100));

  for (let y = 0; y < H; y++) {
    const rowOffset = y * W;
    const inNeckY = (y >= chinY && y <= neckBottomY);
    const inFeet = (y >= ankleY);
    for (let x = 0; x < W; x++) {
      const idx = rowOffset + x;
      if (alpha[idx] === 0) continue;

      const inNeck = inNeckY && (x >= neckMinX && x <= neckMaxX);
      let inHand = false;
      for (let i = 0; i < handLeftCenters.length; i++) {
        const h = handLeftCenters[i];
        if (Math.hypot(x - h.x, y - h.y) <= h.r) { inHand = true; break; }
      }
      if (!inHand) {
        for (let i = 0; i < handRightCenters.length; i++) {
          const h = handRightCenters[i];
          if (Math.hypot(x - h.x, y - h.y) <= h.r) { inHand = true; break; }
        }
      }

      if (inNeck || inHand || inFeet) {
        const pIdx = idx * 4;
        const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const notNearWhite = !(r > 215 && g > 215 && b > 215);
        const isSkin = (r > b + 18) && (r >= g) && (lum > 60) && notNearWhite;
        if (isSkin) {
          alpha[idx] = 0;
        }
      }
    }
  }

  // Step 2d: Remove the mannequin's white T-shirt
  // Unless "Garment is white" is checked: for pixels in torso area (between shoulders 11/12 and hips 23/24, inside torso x-range),
  // remove near-white low-saturation pixels: min(R,G,B) > 200 and max(R,G,B) - min(R,G,B) < 22.
  if (!garmentIsWhite) {
    const torsoTopY = (p11 && p12) ? Math.min(p11.y, p12.y) : shoulderY;
    const torsoBottomY = (p23 && p24) ? Math.max(p23.y, p24.y) : H * 0.75;
    const torsoMinX = Math.min(
      p11 ? p11.x : W * 0.2,
      p12 ? p12.x : W * 0.8,
      p23 ? p23.x : W * 0.3,
      p24 ? p24.x : W * 0.7
    ) - 15;
    const torsoMaxX = Math.max(
      p11 ? p11.x : W * 0.2,
      p12 ? p12.x : W * 0.8,
      p23 ? p23.x : W * 0.3,
      p24 ? p24.x : W * 0.7
    ) + 15;

    // Start at the chin: the T-shirt's crew neck sits ABOVE the shoulder joints.
    const startY = Math.max(0, Math.floor(Math.min(torsoTopY, chinY)));
    const endY = Math.min(H - 1, Math.ceil(torsoBottomY));
    const startX = Math.max(0, Math.floor(torsoMinX));
    const endX = Math.min(W - 1, Math.ceil(torsoMaxX));

    for (let y = startY; y <= endY; y++) {
      const rowOffset = y * W;
      for (let x = startX; x <= endX; x++) {
        const idx = rowOffset + x;
        if (alpha[idx] === 0) continue;
        const pIdx = idx * 4;
        const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
        const minRGB = Math.min(r, g, b);
        const maxRGB = Math.max(r, g, b);
        // 175 (not 200): the T-shirt inside a collar/V is in shadow.
        if (minRGB > 175 && (maxRGB - minRGB) < 22) {
          alpha[idx] = 0;
        }
      }
    }
  }

  // Step 2e: Remove the mannequin's leggings
  // Below the hip line (landmarks 23/24):
  // - If "Black leggings": remove dark low-saturation pixels (luminance < 45 and max(R,G,B) - min(R,G,B) < 25)
  // - If "Green leggings": remove green-screen pixels (G > R + 40 and G > B + 40, plus any green spill: G > 100 and G > R * 1.15 and G > B * 1.15 anywhere on the canvas)
  const hipLineY = (p23 && p24) ? Math.min(p23.y, p24.y) : ((p11 && p12) ? shoulderY + 45 * pxPerCm : H * 0.55);
  const isGreen = (mannequinLegs === 'green');
  const waistLineY = (p23 && p24 && p11 && p12) ? shoulderY + 0.62 * (hipLineY - shoulderY) : hipLineY;

  for (let y = 0; y < H; y++) {
    const belowHip = (y >= hipLineY);
    const rowOffset = y * W;
    for (let x = 0; x < W; x++) {
      const idx = rowOffset + x;
      if (alpha[idx] === 0) continue;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];

      if (isGreen) {
        // Green spill anywhere on canvas
        if (g > 100 && g > r * 1.15 && g > b * 1.15) {
          alpha[idx] = 0;
          continue;
        }
        if (belowHip && (g > r + 40 && g > b + 40)) {
          alpha[idx] = 0;
        }
      } else {
        // Black leggings can show through a front opening above the hips (e.g. a cardigan split),
        // so start at the waist line for the black option.
        if (y >= waistLineY) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const satRange = Math.max(r, g, b) - Math.min(r, g, b);
          if (lum < 45 && satRange < 25) {
            alpha[idx] = 0;
          }
        }
      }
    }
  }

  // Step 2f: Clean up:
  // 1. Morphological open then close (2px radius) on alpha channel
  function separableFilter(src, isMin, radius) {
    const temp = new Uint8Array(W * H);
    const dst = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const rowOffset = y * W;
      for (let x = 0; x < W; x++) {
        let val = src[rowOffset + x];
        const startX = Math.max(0, x - radius);
        const endX = Math.min(W - 1, x + radius);
        for (let kx = startX; kx <= endX; kx++) {
          const v = src[rowOffset + kx];
          val = isMin ? (v < val ? v : val) : (v > val ? v : val);
        }
        temp[rowOffset + x] = val;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let val = temp[y * W + x];
        const startY = Math.max(0, y - radius);
        const endY = Math.min(H - 1, y + radius);
        for (let ky = startY; ky <= endY; ky++) {
          const v = temp[ky * W + x];
          val = isMin ? (v < val ? v : val) : (v > val ? v : val);
        }
        dst[y * W + x] = val;
      }
    }
    return dst;
  }

  // Open (erode -> dilate), then Close (dilate -> erode)
  let a = separableFilter(alpha, true, 2);
  a = separableFilter(a, false, 2);
  a = separableFilter(a, false, 2);
  a = separableFilter(a, true, 2);

  // 2. Connected-component check: keep only components that overlap the torso bounding box
  // (landmarks 11, 12, 23, 24) or are larger than 0.5% of the garment area
  let totalArea = 0;
  for (let i = 0; i < W * H; i++) {
    if (a[i] > 0) totalArea++;
  }
  const minAreaThreshold = Math.round(totalArea * 0.005);

  const tMinX = Math.min(
    p11 ? p11.x : W * 0.2,
    p12 ? p12.x : W * 0.8,
    p23 ? p23.x : W * 0.3,
    p24 ? p24.x : W * 0.7
  ) - 10;
  const tMaxX = Math.max(
    p11 ? p11.x : W * 0.2,
    p12 ? p12.x : W * 0.8,
    p23 ? p23.x : W * 0.3,
    p24 ? p24.x : W * 0.7
  ) + 10;
  const tMinY = (p11 && p12) ? Math.min(p11.y, p12.y) - 5 : shoulderY - 5;
  const tMaxY = (p23 && p24) ? Math.max(p23.y, p24.y) + 5 : H * 0.75;

  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);

  for (let y = 0; y < H; y++) {
    const rowOffset = y * W;
    for (let x = 0; x < W; x++) {
      const idx = rowOffset + x;
      if (a[idx] === 0 || visited[idx]) continue;

      let head = 0, tail = 0;
      queue[tail++] = idx;
      visited[idx] = 1;
      let overlapsTorso = false;

      while (head < tail) {
        const curr = queue[head++];
        const cx = curr % W;
        const cy = Math.floor(curr / W);

        if (!overlapsTorso && cx >= tMinX && cx <= tMaxX && cy >= tMinY && cy <= tMaxY) {
          overlapsTorso = true;
        }

        if (cx > 0) {
          const n = curr - 1;
          if (a[n] > 0 && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cx < W - 1) {
          const n = curr + 1;
          if (a[n] > 0 && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cy > 0) {
          const n = curr - W;
          if (a[n] > 0 && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
        if (cy < H - 1) {
          const n = curr + W;
          if (a[n] > 0 && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
        }
      }

      if (!overlapsTorso && tail < minAreaThreshold) {
        for (let i = 0; i < tail; i++) {
          a[queue[i]] = 0;
        }
      }
    }
  }

  // 3. Defringe: along alpha boundary, if pixel was adjacent to a removed near-white pixel, desaturate/darken slightly
  for (let y = 1; y < H - 1; y++) {
    const rowOffset = y * W;
    for (let x = 1; x < W - 1; x++) {
      const idx = rowOffset + x;
      if (a[idx] > 0) {
        let nearRemovedWhite = false;
        const neighbors = [idx - 1, idx + 1, idx - W, idx + W];
        for (let i = 0; i < 4; i++) {
          const n = neighbors[i];
          if (a[n] === 0) {
            const npIdx = n * 4;
            if (data[npIdx] > 190 && data[npIdx + 1] > 190 && data[npIdx + 2] > 190) {
              nearRemovedWhite = true;
              break;
            }
          }
        }
        if (nearRemovedWhite) {
          const pIdx = idx * 4;
          const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          data[pIdx] = Math.round(r * 0.85 + lum * 0.05);
          data[pIdx + 1] = Math.round(g * 0.85 + lum * 0.05);
          data[pIdx + 2] = Math.round(b * 0.85 + lum * 0.05);
        }
      }
    }
  }

  // 4. Soft edge: 1px feather (simple 3x3 box blur on alpha only along the boundary)
  const feathered = new Uint8Array(a);
  for (let y = 1; y < H - 1; y++) {
    const rowOffset = y * W;
    for (let x = 1; x < W - 1; x++) {
      const idx = rowOffset + x;
      let has0 = false, hasPos = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nA = a[(y + dy) * W + (x + dx)];
          if (nA === 0) has0 = true;
          if (nA > 0) hasPos = true;
        }
      }
      if (has0 && hasPos) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += a[(y + dy) * W + (x + dx)];
          }
        }
        feathered[idx] = Math.round(sum / 9);
      }
    }
  }

  // Write alpha back to imgData
  for (let i = 0; i < W * H; i++) {
    data[i * 4 + 3] = feathered[i];
  }
  ctx.putImageData(imgData, 0, 0);

  try { sm?.close?.(); } catch (_) {}

  return canvas;
}

/**
 * UI Event handler for cutting garment directly out of worn reference image
 */
async function handleCutGarmentFromWorn() {
  if (!state.refImage) {
    const statusMsg = document.getElementById('cut-status-msg');
    if (statusMsg) {
      statusMsg.className = 'error-banner';
      statusMsg.textContent = '❌ Please select a worn reference image first.';
      statusMsg.style.display = 'block';
    }
    return;
  }

  const statusMsg = document.getElementById('cut-status-msg');
  if (statusMsg) {
    statusMsg.className = 'notice-banner';
    statusMsg.textContent = '✂️ Cutting garment from worn image...';
    statusMsg.style.display = 'block';
  }

  const cutBtn = document.getElementById('cut-garment-btn');
  if (cutBtn) cutBtn.disabled = true;

  try {
    const mannequinLegs = document.getElementById('cut-legs-select')?.value || 'black';
    const garmentIsWhite = Boolean(document.getElementById('cut-garment-white')?.checked);
    const neckline = document.getElementById('cut-neckline-select')?.value || 'closed';

    const cutCanvas = await cutGarmentFromWornImage(state.refImage, {
      mannequinLegs,
      garmentIsWhite,
      neckline
    });

    // Convert cutCanvas to PNG blob
    const blob = await new Promise(resolve => cutCanvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to create PNG blob from cut canvas');

    state.activeBlob = blob;
    state.cutFromWorn = true;
    state.mannequinLegs = mannequinLegs;
    state.garmentIsWhite = garmentIsWhite;
    state.neckline = neckline;

    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = objectUrl;
    });

    state.rawImage = img;
    state.activeImage = img;

    // Display in Card 1 preview
    const previewImg = document.getElementById('upload-preview-img');
    const placeholder = document.getElementById('upload-placeholder-text');
    if (previewImg) {
      previewImg.src = objectUrl;
      previewImg.style.display = 'block';
    }
    if (placeholder) placeholder.style.display = 'none';

    // Populate cleaned-canvas so Magic Eraser and Tolerance work on it
    const cleanedCanvas = document.getElementById('cleaned-canvas');
    if (cleanedCanvas) {
      cleanedCanvas.width = cutCanvas.width;
      cleanedCanvas.height = cutCanvas.height;
      const cctx = cleanedCanvas.getContext('2d');
      cctx.clearRect(0, 0, cleanedCanvas.width, cleanedCanvas.height);
      cctx.drawImage(cutCanvas, 0, 0);
      state.cleanedCanvas = cleanedCanvas;
      state.eraserHistory = [];
      const undoEraserBtn = document.getElementById('undo-eraser-btn');
      if (undoEraserBtn) undoEraserBtn.disabled = true;
    }

    const compOrig = document.getElementById('compare-original-img');
    if (compOrig && state.refImage) compOrig.src = state.refImage.src;

    const bgSection = document.getElementById('bg-remove-section');
    if (bgSection) bgSection.style.display = 'flex';
    const compContainer = document.getElementById('clean-compare-container');
    if (compContainer) compContainer.style.display = 'flex';

    // Auto-hook coordinates: ghost frame == reference frame!
    const basePose = state.refPoseRaw || state.refPose;
    if (basePose) {
      state.refPoseGhost = { ...basePose };
    }
    state.ghostToRef = { scale: 1.0, dx: 0, dy: 0 };

    // Auto-detect collar front point (V point) on worn reference
    if (state.refPose && (state.refLandmarks || state.refPoseRaw)) {
      const neckRaw = state.refLandmarks
        ? detectCollarFrontPoint(state.refImage, state.refLandmarks)
        : null;
      if (neckRaw) {
        state.neckFrontRaw = neckRaw;
        state.neckFront = { ...neckRaw };
      }
    }

    // Hide Align panel, show auto-align badge
    const alignPanel = document.getElementById('ghost-align-panel');
    if (alignPanel) alignPanel.style.display = 'none';
    const autoAlignBadge = document.getElementById('auto-align-badge');
    if (autoAlignBadge) autoAlignBadge.style.display = 'flex';

    initAnchorCanvasImage();

    if (statusMsg) {
      statusMsg.className = 'success-banner';
      statusMsg.textContent = '✓ Garment cut successfully from worn reference image. Aligned automatically!';
      statusMsg.style.display = 'block';
    }
  } catch (err) {
    console.error('Error cutting garment:', err);
    if (statusMsg) {
      statusMsg.className = 'error-banner';
      statusMsg.textContent = `❌ Cut error: ${err.message}`;
      statusMsg.style.display = 'block';
    }
  } finally {
    if (cutBtn) cutBtn.disabled = false;
  }
}

// --- Phase 4C: Ghost PNG to Reference Alignment ---

/**
 * Computes the non-transparent alpha bounding box of an image or canvas.
 */
function computeAlphaBoundingBox(source) {
  if (!source) return null;
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  if (!w || !h) return null;

  let canvas, ctx;
  if (source instanceof HTMLCanvasElement) {
    canvas = source;
    ctx = canvas.getContext('2d');
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
  }
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 15) { // alpha > 15 (~6%)
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1, width: w, height: h };
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * Computes initial auto-guess for ghostToRef:
 * - Scale: ghost alpha bbox width matches mannequin wrist distance (l15, l16) + 15%
 * - Offset: ghost top aligns 8% of torso height above reference shoulder midpoint, centered horizontally
 */
function computeAutoGhostToRef() {
  const ghostImg = state.activeImage || state.rawImage;
  const refPose = state.refPoseRaw || state.refPose;
  if (!ghostImg || !refPose || !refPose.l11 || !refPose.l12) {
    return { scale: 1.0, dx: 0, dy: 0 };
  }

  const bbox = computeAlphaBoundingBox(ghostImg) || {
    minX: 0, minY: 0, maxX: (ghostImg.naturalWidth || ghostImg.width) - 1, maxY: (ghostImg.naturalHeight || ghostImg.height) - 1,
    width: ghostImg.naturalWidth || ghostImg.width, height: ghostImg.naturalHeight || ghostImg.height
  };
  state.ghostBbox = bbox;

  const ghostW = bbox.width;
  const ghostMinY = bbox.minY;
  const ghostCenterX = (bbox.minX + bbox.maxX) / 2;

  // 1. Mannequin wrist distance
  let wristDist = 0;
  if (refPose.l15 && refPose.l16) {
    wristDist = Math.hypot(refPose.l15.x - refPose.l16.x, refPose.l15.y - refPose.l16.y);
  }
  const shoulderSpan = Math.hypot(refPose.l11.x - refPose.l12.x, refPose.l11.y - refPose.l12.y);
  if (!wristDist || wristDist < shoulderSpan) {
    wristDist = shoulderSpan * 2.1;
  }

  // Target ghost width = wrist distance + 15%
  const targetGhostWidth = wristDist * 1.15;
  let scale = targetGhostWidth / (ghostW || 1);
  scale = Math.max(0.3, Math.min(2.0, scale));
  scale = Math.round(scale / 0.005) * 0.005;

  // 2. Reference shoulder midpoint and torso height
  const midShoulder = {
    x: (refPose.l11.x + refPose.l12.x) / 2,
    y: (refPose.l11.y + refPose.l12.y) / 2
  };
  let torsoHeight = 0;
  if (refPose.l23 && refPose.l24) {
    const midHip = {
      x: (refPose.l23.x + refPose.l24.x) / 2,
      y: (refPose.l23.y + refPose.l24.y) / 2
    };
    torsoHeight = Math.hypot(midHip.x - midShoulder.x, midHip.y - midShoulder.y);
  }
  if (!torsoHeight || torsoHeight < 50) {
    torsoHeight = shoulderSpan * 1.35;
  }

  // Ghost top aligns 8% of torso height above reference shoulder midpoint
  // refY_top = midShoulder.y - 0.08 * torsoHeight
  // refY_top = ghostMinY * scale + dy  ==>  dy = refY_top - ghostMinY * scale
  const targetTopY = midShoulder.y - 0.08 * torsoHeight;
  const dy = Math.round(targetTopY - ghostMinY * scale);

  // Ghost horizontal center aligned with midShoulder.x
  // midShoulder.x = ghostCenterX * scale + dx  ==>  dx = midShoulder.x - ghostCenterX * scale
  const dx = Math.round(midShoulder.x - ghostCenterX * scale);

  return { scale: +scale.toFixed(3), dx, dy };
}

/**
 * Gets mouse or touch coordinates relative to canvas internal pixel dimensions
 */
function getCanvasMouseCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const scaleX = canvas.width / (rect.width || 1);
  const scaleY = canvas.height / (rect.height || 1);
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

/**
 * Update UI labels and sliders in the alignment panel
 */
function updateAlignUI() {
  const scaleSlider = document.getElementById('align-scale-slider');
  const scaleVal = document.getElementById('align-scale-val');
  const opacitySlider = document.getElementById('align-opacity-slider');
  const opacityVal = document.getElementById('align-opacity-val');
  const offsetVal = document.getElementById('align-offset-val');

  if (scaleSlider) scaleSlider.value = state.ghostToRef.scale;
  if (scaleVal) scaleVal.textContent = `${Number(state.ghostToRef.scale).toFixed(3)}×`;
  if (opacitySlider) opacitySlider.value = state.alignOpacity;
  if (opacityVal) opacityVal.textContent = `${Math.round(state.alignOpacity * 100)}%`;
  if (offsetVal) offsetVal.textContent = `dx: ${Math.round(state.ghostToRef.dx)}, dy: ${Math.round(state.ghostToRef.dy)}`;
}

/**
 * Redraws the ghost-to-reference alignment preview canvas
 */
function drawAlignCanvas() {
  const canvas = document.getElementById('align-canvas');
  if (!canvas || !state.refImage) return;

  canvas.width = state.refImage.naturalWidth || state.refImage.width;
  canvas.height = state.refImage.naturalHeight || state.refImage.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw mannequin reference image
  ctx.drawImage(state.refImage, 0, 0, canvas.width, canvas.height);

  // 2. Draw ghost garment with alignment transform
  const ghostImg = state.activeImage || state.rawImage;
  if (ghostImg) {
    ctx.save();
    ctx.globalAlpha = Math.max(0.1, Math.min(1.0, state.alignOpacity ?? 0.5));
    ctx.translate(state.ghostToRef.dx, state.ghostToRef.dy);
    ctx.scale(state.ghostToRef.scale, state.ghostToRef.scale);
    ctx.drawImage(ghostImg, 0, 0);
    ctx.restore();
  }

  // 3. Draw subtle alignment guidelines
  const pose = state.refPoseRaw || state.refPose;
  if (pose && pose.l11 && pose.l12) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
    ctx.setLineDash([6, 6]);

    // Shoulder line
    ctx.beginPath();
    ctx.moveTo(pose.l12.x, pose.l12.y);
    ctx.lineTo(pose.l11.x, pose.l11.y);
    ctx.stroke();

    // Shoulder midpoint
    const midX = (pose.l11.x + pose.l12.x) / 2;
    const midY = (pose.l11.y + pose.l12.y) / 2;
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.arc(midX, midY, Math.max(4, Math.round(canvas.width / 200)), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // Phase 6: Show Collar V point (neckFront) as a dot on align preview
  const ptV = state.neckFrontRaw;
  if (ptV) {
    ctx.save();
    ctx.fillStyle = '#ff5a36'; // tailor's chalk coral
    ctx.beginPath();
    ctx.arc(ptV.x, ptV.y, Math.max(5, Math.round(canvas.width / 160)), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    const label = 'Collar V point';
    ctx.font = `bold ${Math.max(10, Math.round(canvas.width / 80))}px sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillRect(ptV.x + 8, ptV.y - 8, tw + 8, 16);
    ctx.fillStyle = '#ff5a36';
    ctx.fillText(label, ptV.x + 12, ptV.y + 4);
    ctx.restore();
  }
}

function handleAlignMouseDown(e) {
  state.isDraggingGhost = true;
  const canvas = document.getElementById('align-canvas');
  if (canvas) canvas.focus();
  const coords = getCanvasMouseCoords(e, canvas);
  state.dragStartMouse = coords;
  state.dragStartOffset = { dx: state.ghostToRef.dx, dy: state.ghostToRef.dy };
  const wrap = document.getElementById('align-canvas-wrap');
  if (wrap) wrap.style.cursor = 'grabbing';
}

function handleAlignMouseMove(e) {
  if (!state.isDraggingGhost) return;
  const canvas = document.getElementById('align-canvas');
  if (!canvas) return;
  const coords = getCanvasMouseCoords(e, canvas);
  const deltaX = coords.x - state.dragStartMouse.x;
  const deltaY = coords.y - state.dragStartMouse.y;
  state.ghostToRef.dx = Math.round(state.dragStartOffset.dx + deltaX);
  state.ghostToRef.dy = Math.round(state.dragStartOffset.dy + deltaY);
  updateAlignUI();
  drawAlignCanvas();
}

function handleAlignMouseUp() {
  if (state.isDraggingGhost) {
    state.isDraggingGhost = false;
    const wrap = document.getElementById('align-canvas-wrap');
    if (wrap) wrap.style.cursor = 'grab';
  }
}

/**
 * Setup event listeners for ghost alignment controls (sliders, canvas drag, keyboard arrows)
 */
function setupGhostAlignListeners() {
  const scaleSlider = document.getElementById('align-scale-slider');
  const opacitySlider = document.getElementById('align-opacity-slider');
  const resetBtn = document.getElementById('reset-align-btn');
  const canvas = document.getElementById('align-canvas');

  if (scaleSlider) {
    scaleSlider.addEventListener('input', (e) => {
      state.ghostToRef.scale = parseFloat(e.target.value) || 1.0;
      updateAlignUI();
      drawAlignCanvas();
    });
  }

  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      state.alignOpacity = parseFloat(e.target.value) || 0.5;
      updateAlignUI();
      drawAlignCanvas();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.ghostBbox = null;
      state.ghostToRef = computeAutoGhostToRef();
      updateAlignUI();
      drawAlignCanvas();
    });
  }

  if (canvas) {
    canvas.addEventListener('mousedown', handleAlignMouseDown);
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      handleAlignMouseDown(e);
    }, { passive: false });

    canvas.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') state.ghostToRef.dx -= step;
      if (e.key === 'ArrowRight') state.ghostToRef.dx += step;
      if (e.key === 'ArrowUp') state.ghostToRef.dy -= step;
      if (e.key === 'ArrowDown') state.ghostToRef.dy += step;
      updateAlignUI();
      drawAlignCanvas();
    });
  }

  window.addEventListener('mousemove', handleAlignMouseMove);
  window.addEventListener('touchmove', (e) => {
    if (state.isDraggingGhost) {
      e.preventDefault();
      handleAlignMouseMove(e);
    }
  }, { passive: false });
  window.addEventListener('mouseup', handleAlignMouseUp);
  window.addEventListener('touchend', handleAlignMouseUp);
}

// --- Card 3: Anchors Interactive Canvas ---
function setupAnchorCanvas() {
  const canvas = document.getElementById('anchor-canvas');
  const undoBtn = document.getElementById('undo-anchor-btn');
  const resetBtn = document.getElementById('reset-anchors-btn');

  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  window.addEventListener('mouseup', handleCanvasMouseUp);

  undoBtn.addEventListener('click', handleUndoAnchor);
  resetBtn.addEventListener('click', handleResetAnchors);
}

function initAnchorCanvasImage() {
  if (!state.activeImage) return;
  const canvas = document.getElementById('anchor-canvas');
  const wrap = document.getElementById('anchor-canvas-wrap');

  // Fit canvas width nicely to wrap container (max ~640px)
  const maxW = Math.min(wrap.clientWidth || 640, 700);
  const scale = maxW / state.activeImage.naturalWidth;
  state.canvasScale = scale;

  canvas.width = Math.round(state.activeImage.naturalWidth * scale);
  canvas.height = Math.round(state.activeImage.naturalHeight * scale);

  drawAnchorsOnCanvas();
}

/**
 * Draw image, grid, and placed anchor markers on the canvas
 */
function drawAnchorsOnCanvas() {
  const canvas = document.getElementById('anchor-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.activeImage) {
    ctx.drawImage(state.activeImage, 0, 0, canvas.width, canvas.height);
  }

  // Draw placed markers
  const expectedKeys = getExpectedAnchorKeys();
  const radius = 6;

  for (const key of expectedKeys) {
    const pt = state.anchors[key];
    if (!pt) continue;

    const cx = pt[0] * state.canvasScale;
    const cy = pt[1] * state.canvasScale;

    // Outer circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#2563EB';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();

    // Text Label
    ctx.font = '11px monospace';
    ctx.fillStyle = '#0F172A';
    const textW = ctx.measureText(key).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(cx + 8, cy - 8, textW + 4, 14);
    ctx.fillStyle = '#0F172A';
    ctx.fillText(key, cx + 10, cy + 3);
  }

  validateAndDisplayAnchors();
}

function handleCanvasMouseDown(e) {
  if (!state.activeImage) return;

  const canvas = document.getElementById('anchor-canvas');
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const imgX = Math.round(clickX / state.canvasScale);
  const imgY = Math.round(clickY / state.canvasScale);

  // Check if clicking near an existing marker to start dragging
  const expectedKeys = getExpectedAnchorKeys();
  const hitRadiusPx = 10 / state.canvasScale;

  for (const key of expectedKeys) {
    const pt = state.anchors[key];
    if (!pt) continue;
    const dist = Math.hypot(pt[0] - imgX, pt[1] - imgY);
    if (dist <= hitRadiusPx) {
      state.draggingPoint = key;
      return;
    }
  }

  // Otherwise, place next expected point in sequence
  for (const key of expectedKeys) {
    if (!state.anchors[key]) {
      state.anchors[key] = [imgX, imgY];
      updateAnchorPrompt();
      drawAnchorsOnCanvas();
      return;
    }
  }
}

function handleCanvasMouseMove(e) {
  if (!state.draggingPoint || !state.activeImage) return;

  const canvas = document.getElementById('anchor-canvas');
  const rect = canvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  const imgX = Math.max(0, Math.min(state.activeImage.naturalWidth, Math.round(currentX / state.canvasScale)));
  const imgY = Math.max(0, Math.min(state.activeImage.naturalHeight, Math.round(currentY / state.canvasScale)));

  state.anchors[state.draggingPoint] = [imgX, imgY];
  drawAnchorsOnCanvas();
}

function handleCanvasMouseUp() {
  if (state.draggingPoint) {
    state.draggingPoint = null;
    drawAnchorsOnCanvas();
  }
}

function handleUndoAnchor() {
  const expectedKeys = getExpectedAnchorKeys();
  for (let i = expectedKeys.length - 1; i >= 0; i--) {
    const key = expectedKeys[i];
    if (state.anchors[key]) {
      delete state.anchors[key];
      break;
    }
  }
  updateAnchorPrompt();
  drawAnchorsOnCanvas();
}

function handleResetAnchors() {
  state.anchors = {};
  updateAnchorPrompt();
  drawAnchorsOnCanvas();
}

function updateAnchorPrompt() {
  const expectedKeys = getExpectedAnchorKeys();
  const nextKey = expectedKeys.find(k => !state.anchors[k]);
  const badge = document.getElementById('current-point-badge');
  const inst = document.getElementById('point-instruction');

  if (nextKey) {
    badge.textContent = nextKey;
    badge.style.display = 'inline-block';
    inst.textContent = 'Click on photo to position this point';
  } else {
    badge.textContent = '✓ All Points Set';
    badge.style.background = '#10B981';
    inst.textContent = 'Drag any marker to fine-tune';
  }
}

/**
 * Anchor Validation:
 * left.x < right.x for every pair
 * armpit.y > shoulder.y
 * hem.y > armpit.y
 * collar.y <= shoulder.y
 */
function validateAnchors() {
  const isTemplate = document.getElementById('garment-render-mode')?.checked;
  if (isTemplate) {
    // Phase 4B: Manual anchors are optional for template garments
    return { valid: true };
  }

  const expectedKeys = getExpectedAnchorKeys();
  const missing = expectedKeys.filter(k => !state.anchors[k]);
  if (missing.length > 0) {
    return { valid: false, message: `Missing anchor points: ${missing.join(', ')}` };
  }

  const a = state.anchors;

  // Pairs check: left.x < right.x
  if (a.collarL[0] >= a.collarR[0]) {
    return { valid: false, message: 'Invalid alignment: collarL must be to the left of collarR (collarL.x < collarR.x).' };
  }
  if (a.shoulderL[0] >= a.shoulderR[0]) {
    return { valid: false, message: 'Invalid alignment: shoulderL must be to the left of shoulderR (shoulderL.x < shoulderR.x).' };
  }
  if (a.armpitL[0] >= a.armpitR[0]) {
    return { valid: false, message: 'Invalid alignment: armpitL must be to the left of armpitR (armpitL.x < armpitR.x).' };
  }
  if (a.hemL[0] >= a.hemR[0]) {
    return { valid: false, message: 'Invalid alignment: hemL must be to the left of hemR (hemL.x < hemR.x).' };
  }

  // Vertical relationship checks
  if (a.armpitL[1] <= a.shoulderL[1] || a.armpitR[1] <= a.shoulderR[1]) {
    return { valid: false, message: 'Invalid anatomy: Armpits must be lower than shoulders (armpit.y > shoulder.y).' };
  }
  if (a.hemL[1] <= a.armpitL[1] || a.hemR[1] <= a.armpitR[1]) {
    return { valid: false, message: 'Invalid anatomy: Hem must be lower than armpits (hem.y > armpit.y).' };
  }
  if (a.collarL[1] > a.shoulderL[1] || a.collarR[1] > a.shoulderR[1]) {
    return { valid: false, message: 'Invalid anatomy: Collar top must be at or above shoulders (collar.y <= shoulder.y).' };
  }

  return { valid: true };
}

function validateAndDisplayAnchors() {
  const result = validateAnchors();
  const msgEl = document.getElementById('anchor-validation-msg');
  if (!result.valid) {
    msgEl.textContent = result.message;
    msgEl.style.display = 'flex';
  } else {
    msgEl.style.display = 'none';
  }
  return result.valid;
}

// --- Card 4: Size Chart Table & Default Fill ---
function handleFillDefaultChart() {
  if (!state.defaultCharts) return;

  const gender = document.getElementById('garment-gender').value;
  const type = document.getElementById('garment-type').value;

  const targetKey = `${gender}_${type}`;
  let template = state.defaultCharts[targetKey];
  let usedFallback = false;
  let fallbackName = '';

  if (!template) {
    // Fall back to nearest with same gender
    const fallbacks = Object.keys(state.defaultCharts).filter(k => k.startsWith(`${gender}_`));
    if (fallbacks.length > 0) {
      template = state.defaultCharts[fallbacks[0]];
      usedFallback = true;
      fallbackName = template.name;
    }
  }

  const notice = document.getElementById('chart-fallback-notice');
  if (usedFallback) {
    notice.textContent = `Default chart used: ${fallbackName}, please check the numbers.`;
    notice.style.display = 'flex';
  } else {
    notice.style.display = 'none';
  }

  if (template && template.sizes) {
    for (const [sizeName, dims] of Object.entries(template.sizes)) {
      const row = document.querySelector(`#size-chart-table tr[data-size="${sizeName}"]`);
      if (!row) continue;
      for (const [field, val] of Object.entries(dims)) {
        const inp = row.querySelector(`input[data-field="${field}"]`);
        if (inp) inp.value = val;
      }
    }
    validateSizeChart();
  }
}

/**
 * Read size chart inputs into an object
 */
function readSizeChartFromTable() {
  const sizes = {};
  const rows = document.querySelectorAll('#size-chart-table tbody tr');
  rows.forEach((row) => {
    const sizeName = row.getAttribute('data-size');
    sizes[sizeName] = {};
    row.querySelectorAll('input').forEach((inp) => {
      const field = inp.getAttribute('data-field');
      sizes[sizeName][field] = parseFloat(inp.value) || 0;
    });
  });
  return sizes;
}

/**
 * Validate size chart
 */
function validateSizeChart() {
  const sizes = readSizeChartFromTable();
  const sleeveType = document.getElementById('garment-sleeve-type')?.value || 'long';
  const sizeKeys = ['S', 'M', 'L', 'XL'];
  const msgEl = document.getElementById('chart-validation-msg');

  // Check required numeric values
  for (const s of sizeKeys) {
    const row = sizes[s];
    if (!row) {
      msgEl.textContent = `Missing size ${s}`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    for (const field of ['chest', 'waist', 'shoulder', 'length', 'hem']) {
      if (!row[field] || isNaN(row[field]) || row[field] <= 0) {
        msgEl.textContent = `Size ${s}: ${field} must be a positive number.`;
        msgEl.style.display = 'flex';
        return { valid: false };
      }
    }

    // Range checks
    if (row.chest < 70 || row.chest > 160) {
      msgEl.textContent = `Size ${s}: chest ${row.chest}cm is outside plausible range (70–160 cm).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    if (row.shoulder < 30 || row.shoulder > 70) {
      msgEl.textContent = `Size ${s}: shoulder ${row.shoulder}cm is outside plausible range (30–70 cm).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    // Long coats (Length Style = "Long coat") reach the knee/calf, so allow up to 150 cm for them.
    const isLongCoat = document.getElementById('garment-length-style')?.value === 'long';
    const maxLength = isLongCoat ? 150 : 100;
    if (row.length < 40 || row.length > maxLength) {
      msgEl.textContent = `Size ${s}: length ${row.length}cm is outside plausible range (40–${maxLength} cm).`
        + (isLongCoat ? '' : ' For a knee/calf-length coat set "Length Style" to "Long coat".');
      msgEl.style.display = 'flex';
      return { valid: false };
    }

    if (sleeveType === 'long') {
      if (row.sleeve < 40 || row.sleeve > 80) {
        msgEl.textContent = `Size ${s}: sleeve ${row.sleeve}cm is outside plausible range (40–80 cm).`;
        msgEl.style.display = 'flex';
        return { valid: false };
      }
    }
  }

  // Progression checks: S < M < L < XL for chest, waist, hem, length
  for (let i = 0; i < sizeKeys.length - 1; i++) {
    const curr = sizes[sizeKeys[i]];
    const next = sizes[sizeKeys[i + 1]];
    const sCurr = sizeKeys[i];
    const sNext = sizeKeys[i + 1];

    if (curr.chest >= next.chest) {
      msgEl.textContent = `Chest progression error: Size ${sCurr} (${curr.chest}) must be smaller than Size ${sNext} (${next.chest}).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    if (curr.waist >= next.waist) {
      msgEl.textContent = `Waist progression error: Size ${sCurr} (${curr.waist}) must be smaller than Size ${sNext} (${next.waist}).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    if (curr.length >= next.length) {
      msgEl.textContent = `Length progression error: Size ${sCurr} (${curr.length}) must be smaller than Size ${sNext} (${next.length}).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
    if (curr.hem >= next.hem) {
      msgEl.textContent = `Hem progression error: Size ${sCurr} (${curr.hem}) must be smaller than Size ${sNext} (${next.hem}).`;
      msgEl.style.display = 'flex';
      return { valid: false };
    }
  }

  msgEl.style.display = 'none';
  return { valid: true, sizes };
}

// --- Card 5: Save & Preview ---
async function handleSaveGarment() {
  const statusEl = document.getElementById('save-status-msg');
  statusEl.style.display = 'none';

  // 1. Image Check
  if (!state.activeBlob) {
    statusEl.className = 'error-banner';
    statusEl.textContent = 'Please upload a garment image in Card 1.';
    statusEl.style.display = 'flex';
    return;
  }

  // 2. Details Check
  const name = document.getElementById('garment-name').value.trim();
  const id = document.getElementById('garment-id').value.trim();
  if (!name) {
    statusEl.className = 'error-banner';
    statusEl.textContent = 'Please enter a garment name in Card 2.';
    statusEl.style.display = 'flex';
    return;
  }
  if (!id) {
    statusEl.className = 'error-banner';
    statusEl.textContent = 'Please enter a valid slug ID in Card 2.';
    statusEl.style.display = 'flex';
    return;
  }

  // ID uniqueness check against catalog garments
  const catalogConflict = state.catalogGarments.find(g => g.id === id);
  if (catalogConflict) {
    statusEl.className = 'error-banner';
    statusEl.textContent = `ID "${id}" collides with a standard catalog item. Please choose a different ID.`;
    statusEl.style.display = 'flex';
    return;
  }

  // 3. Anchors Check (optional for template garments)
  const renderMode = document.getElementById('garment-render-mode')?.checked ? 'template' : 'warp';
  if (renderMode !== 'template') {
    const anchorValidation = validateAnchors();
    if (!anchorValidation.valid) {
      statusEl.className = 'error-banner';
      statusEl.textContent = `Card 3 Anchors error: ${anchorValidation.message}`;
      statusEl.style.display = 'flex';
      return;
    }
  }

  // 4. Size Chart Check
  const chartValidation = validateSizeChart();
  if (!chartValidation.valid) {
    statusEl.className = 'error-banner';
    statusEl.textContent = 'Please correct the size chart errors in Card 4.';
    statusEl.style.display = 'flex';
    return;
  }

  // Assemble Garment Data
  const category = document.getElementById('garment-category').value;
  const type = document.getElementById('garment-type').value;
  const gender = document.getElementById('garment-gender').value;
  const designFit = document.getElementById('garment-design-fit').value;
  const stretch = parseFloat(document.getElementById('garment-stretch').value) || 0.02;
  const sleeveType = document.getElementById('garment-sleeve-type').value;
  const color = document.getElementById('garment-color').value;
  const sizeChart = document.getElementById('garment-chart-type').value;

  // Phase 4C: Convert refPose to ghost coordinates using ghostToRef
  let savedRefPose = null;
  let savedRefPoseGhost = null;
  let savedGhostToRef = null;

  if (renderMode === 'template' && (state.refPose || state.refPoseRaw)) {
    const basePose = state.refPoseRaw || state.refPose;
    savedRefPose = { ...basePose };
    // Cut-from-worn garments share the reference frame: the transform is always identity.
    const g2r = state.cutFromWorn ? { scale: 1.0, dx: 0, dy: 0 } : (state.ghostToRef || { scale: 1.0, dx: 0, dy: 0 });
    savedGhostToRef = {
      scale: +(g2r.scale || 1.0).toFixed(4),
      dx: Math.round(g2r.dx || 0),
      dy: Math.round(g2r.dy || 0)
    };

    const ghostImg = state.activeImage || state.rawImage;
    const ghostW = ghostImg ? (ghostImg.naturalWidth || ghostImg.width) : basePose.width;
    const ghostH = ghostImg ? (ghostImg.naturalHeight || ghostImg.height) : basePose.height;

    const toGhostPt = (pt) => {
      if (!pt) return null;
      return {
        x: +((pt.x - savedGhostToRef.dx) / savedGhostToRef.scale).toFixed(1),
        y: +((pt.y - savedGhostToRef.dy) / savedGhostToRef.scale).toFixed(1)
      };
    };

    savedRefPoseGhost = {
      width: ghostW,
      height: ghostH,
      l11: toGhostPt(basePose.l11),
      l12: toGhostPt(basePose.l12),
      l13: toGhostPt(basePose.l13),
      l14: toGhostPt(basePose.l14),
      l15: toGhostPt(basePose.l15),
      l16: toGhostPt(basePose.l16),
      l23: toGhostPt(basePose.l23),
      l24: toGhostPt(basePose.l24)
    };
  }

  // Phase 6: Save collar V point (neckFront) converted to ghost coordinates
  let savedNeckFront = null;
  let savedNeckFrontRaw = null;
  if (renderMode === 'template') {
    // Cut-from-worn garments share the reference frame: the transform is always identity.
    const g2r = state.cutFromWorn ? { scale: 1.0, dx: 0, dy: 0 } : (state.ghostToRef || { scale: 1.0, dx: 0, dy: 0 });
    if (state.neckFrontRaw) {
      savedNeckFrontRaw = { ...state.neckFrontRaw };
      savedNeckFront = {
        x: +((state.neckFrontRaw.x - (g2r.dx || 0)) / (g2r.scale || 1.0)).toFixed(1),
        y: +((state.neckFrontRaw.y - (g2r.dy || 0)) / (g2r.scale || 1.0)).toFixed(1)
      };
    } else if (state.neckFront) {
      savedNeckFront = { ...state.neckFront };
    }
  }

  const garmentData = {
    id,
    name,
    category,
    type,
    gender,
    designFit,
    stretch,
    sleeveType,
    lengthStyle: document.getElementById('garment-length-style')?.value || 'regular',
    color,
    sizeChart,
    renderMode,
    refSize: document.getElementById('garment-ref-size')?.value || 'M',
    mannequinTorsoCm: parseFloat(document.getElementById('garment-mannequin-torso')?.value) || 46,
    refPose: savedRefPose,
    refPoseGhost: savedRefPoseGhost,
    ghostToRef: savedGhostToRef,
    neckFront: savedNeckFront,
    neckFrontRaw: savedNeckFrontRaw,
    cutFromWorn: Boolean(state.cutFromWorn),
    mannequinLegs: document.getElementById('cut-legs-select')?.value || state.mannequinLegs || 'black',
    garmentIsWhite: Boolean(document.getElementById('cut-garment-white')?.checked),
    neckline: document.getElementById('cut-neckline-select')?.value || state.neckline || 'closed',
    anchors: { ...state.anchors },
    sizes: chartValidation.sizes
  };

  try {
    let blobToSave = state.activeBlob;
    // For template garments: ensure background cleaning with protectCentre = false (no centre barrier)
    // and store the cleaned PNG blob in IndexedDB (skip re-cleaning if cut directly from worn reference)
    if (renderMode === 'template' && !state.cutFromWorn) {
      const canvasToClean = state.cleanedCanvas || cleanGarmentImage(state.activeImage || state.rawImage, {
        tolerance: state.tolerance || 22,
        protectCentre: false
      });
      if (canvasToClean && typeof canvasToClean.toBlob === 'function') {
        const cleanedBlob = await new Promise(resolve => canvasToClean.toBlob(resolve, 'image/png'));
        if (cleanedBlob) {
          blobToSave = cleanedBlob;
          state.activeBlob = cleanedBlob;
        }
      }
    }

    await saveCustomGarment(garmentData, blobToSave);

    statusEl.className = 'success-banner';
    statusEl.textContent = `✓ "${name}" successfully saved to your wardrobe!`;
    statusEl.style.display = 'flex';

    // Show Try On Link & Download Files Button
    const tryOnLink = document.getElementById('try-on-link');
    tryOnLink.href = `dressing.html?garment=${encodeURIComponent(id)}`;
    tryOnLink.style.display = 'inline-flex';

    document.getElementById('download-files-btn').style.display = 'inline-flex';

    state.lastSavedGarment = garmentData;
    await refreshSavedList();
  } catch (err) {
    statusEl.className = 'error-banner';
    statusEl.textContent = `Failed to save garment: ${err.message}`;
    statusEl.style.display = 'flex';
  }
}

/**
 * Download <id>.png and <id>.json files
 */
function handleDownloadFiles() {
  if (!state.lastSavedGarment || !state.activeBlob) {
    alert('Please save the garment first before downloading files.');
    return;
  }

  const id = state.lastSavedGarment.id;

  // 1. Download image <id>.png
  const imgUrl = URL.createObjectURL(state.activeBlob);
  const imgA = document.createElement('a');
  imgA.href = imgUrl;
  imgA.download = `${id}.png`;
  document.body.appendChild(imgA);
  imgA.click();
  document.body.removeChild(imgA);

  // 2. Download metadata <id>.json
  const exportData = {
    ...state.lastSavedGarment,
    image: `assets/garments/${id}.png`
  };
  const jsonStr = JSON.stringify(exportData, null, 2);
  const jsonBlob = new Blob([jsonStr], { type: 'application/json' });
  const jsonUrl = URL.createObjectURL(jsonBlob);
  const jsonA = document.createElement('a');
  jsonA.href = jsonUrl;
  jsonA.download = `${id}.json`;
  document.body.appendChild(jsonA);
  jsonA.click();
  document.body.removeChild(jsonA);
}

/**
 * Load an existing custom garment into the editor forms for editing
 */
async function loadGarmentIntoForm(item) {
  state.isEditingExisting = true;
  document.getElementById('garment-name').value = item.name || '';
  document.getElementById('garment-id').value = item.id || '';
  document.getElementById('garment-category').value = item.category || 'tops';
  document.getElementById('garment-type').value = item.type || 'sweater';
  document.getElementById('garment-gender').value = item.gender || 'female';
  document.getElementById('garment-design-fit').value = item.designFit || 'regular';
  document.getElementById('garment-stretch').value = item.stretch ?? 0.05;
  document.getElementById('garment-sleeve-type').value = item.sleeveType || 'long';
  document.getElementById('garment-color').value = item.color || '#161616';
  document.getElementById('garment-color-hex').textContent = item.color || '#161616';
  document.getElementById('garment-chart-type').value = item.sizeChart || 'estimated';
  const renderModeEl = document.getElementById('garment-render-mode');
  if (renderModeEl) {
    renderModeEl.checked = item.renderMode === 'template';
    updateTemplateRefSectionVisibility();
  }
  const lengthStyleEl = document.getElementById('garment-length-style');
  if (lengthStyleEl) lengthStyleEl.value = item.lengthStyle || 'regular';
  const refSizeEl = document.getElementById('garment-ref-size');
  if (refSizeEl) refSizeEl.value = item.refSize || 'M';
  const torsoCmEl = document.getElementById('garment-mannequin-torso');
  if (torsoCmEl) torsoCmEl.value = item.mannequinTorsoCm ?? 46;

  // Phase 4C: Load ghostToRef and refPoseGhost if available
  if (item.ghostToRef) {
    state.ghostToRef = { ...item.ghostToRef };
  } else {
    state.ghostToRef = { scale: 1.0, dx: 0, dy: 0 };
  }
  state.refPoseGhost = item.refPoseGhost || null;
  state.neckFront = item.neckFront ? { ...item.neckFront } : null;
  state.neckFrontRaw = item.neckFrontRaw ? { ...item.neckFrontRaw } : null;

  // Phase 7: Load cutFromWorn and mannequin options
  state.cutFromWorn = Boolean(item.cutFromWorn);
  state.mannequinLegs = item.mannequinLegs || 'black';
  state.garmentIsWhite = Boolean(item.garmentIsWhite);
  state.neckline = item.neckline || 'closed';

  const legsSelect = document.getElementById('cut-legs-select');
  if (legsSelect) legsSelect.value = state.mannequinLegs;
  const whiteCheck = document.getElementById('cut-garment-white');
  if (whiteCheck) whiteCheck.checked = state.garmentIsWhite;
  const necklineSelect = document.getElementById('cut-neckline-select');
  if (necklineSelect) necklineSelect.value = state.neckline;

  const autoAlignBadge = document.getElementById('auto-align-badge');
  if (autoAlignBadge) {
    autoAlignBadge.style.display = state.cutFromWorn ? 'flex' : 'none';
  }

  // Phase 4B/4C: Load refPose if available
  if (item.refPose) {
    state.refPose = item.refPose;
    state.refPoseRaw = item.refPose;
    displayLoadedRefPose(item.refPose);
    if (state.ghostToRef) {
      updateAlignUI();
    }
    if (state.cutFromWorn) {
      const alignPanel = document.getElementById('ghost-align-panel');
      if (alignPanel) alignPanel.style.display = 'none';
    }
  } else {
    state.refPose = null;
    state.refPoseRaw = null;
    clearRefPoseDisplay();
    const alignPanel = document.getElementById('ghost-align-panel');
    if (alignPanel) alignPanel.style.display = 'none';
  }

  // Load anchors
  state.anchors = item.anchors ? { ...item.anchors } : {};

  // Load size chart into table
  if (item.sizes) {
    for (const [sizeName, dims] of Object.entries(item.sizes)) {
      const row = document.querySelector(`#size-chart-table tr[data-size="${sizeName}"]`);
      if (!row) continue;
      for (const [field, val] of Object.entries(dims)) {
        const inp = row.querySelector(`input[data-field="${field}"]`);
        if (inp) inp.value = val;
      }
    }
  }

  // Load image
  if (item.image) {
    const img = new Image();
    img.onload = () => {
      state.rawImage = img;
      state.activeImage = img;
      fetch(item.image)
        .then(r => r.blob())
        .then(blob => { state.activeBlob = blob; });

      const previewImg = document.getElementById('upload-preview-img');
      previewImg.src = item.image;
      previewImg.style.display = 'block';
      const placeholder = document.getElementById('upload-placeholder-text');
      if (placeholder) placeholder.style.display = 'none';

      initAnchorCanvasImage();
    };
    img.src = item.image;
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}
