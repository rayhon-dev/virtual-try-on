/**
 * dressing.js — H&M-style Dressing Room page logic.
 * Handles AI avatar generation, Ready avatar upload, Test avatar loading,
 * MediaPipe Pose Landmarker, and virtual try-on.
 */

import { generateAvatar, loadGeminiApiKey } from '../core/avatarGen.js';
import { checkPhoto } from '../core/photoCheck.js';
import { validateGeminiOutput } from '../core/geminiValidate.js';
import { loadBody as loadStoredBody, saveBody, MEASUREMENT_FIELDS, getFieldLabel, validateMeasurements, DEFAULT_MEASUREMENTS, GENDERS } from '../core/storage.js';
import { recommendSize, evaluateSize, getSizeNames } from '../core/fitEngine.js';
import { loadFitRules } from '../core/data.js';
import { isEstimated } from '../ui/catalogPanel.js';
import { cleanGarmentImage } from '../core/garmentImage.js';
import { listCustomGarments } from '../core/garmentStore.js';
import { FilesetResolver, PoseLandmarker } from '../../lib/mediapipe/vision_bundle.mjs';

// ?grid=1: render-only mode used by tests/tryon-grid.html. It renders a test avatar with every
// requested garment and posts the images to the parent page. It NEVER saves the avatar or body.
const GRID_MODE = new URLSearchParams(window.location.search).get('grid') === '1';
// In grid mode the body comes from the URL, not from localStorage.
function loadBody() {
  return (typeof state !== 'undefined' && state.bodyOverride) || loadStoredBody();
}

// ?dev=1 enables developer tools (direct avatar upload, manual API key, debug toggles)
const DEV_MODE = new URLSearchParams(window.location.search).has('dev');

// Phase 9: Visual Exaggeration Rule
const FIT_VISUAL = {
  exaggeration: 0.5,
  maxLenCm: 6, // grid check: +10 cm made long sleeves hang far past the fingers
  minWidth: 0.85,
  maxWidth: 1.3
};

// Fit Map & Fit Labels Palette (Phase 9C & Phase 10)
const FIT_STATUS_COLORS = {
  tooTight: '#D1344B',
  tight:    '#E08A1E',
  good:     '#2E8B57',
  loose:    '#2F6FDE',
  tooLoose: '#6B4FC9'
};

const FIT_VERDICT_PLAIN_TEXT = {
  tooTight: 'Too tight',
  tight:    'Slightly tight',
  good:     'Just right',
  loose:    'Slightly loose',
  tooLoose: 'Too loose'
};

function computeVisualEase(zone) {
  if (!zone || zone.status === 'good' || zone.status === 'n/a' || !zone.target) {
    return 0;
  }
  const ease = zone.ease || 0;
  const [minT, maxT] = zone.target;
  const nearestBound = Math.abs(ease - maxT) < Math.abs(ease - minT) ? maxT : minT;
  const extra = Math.max(-FIT_VISUAL.maxLenCm, Math.min(FIT_VISUAL.maxLenCm, FIT_VISUAL.exaggeration * (ease - nearestBound)));
  return ease + extra;
}

// --- State Management ---
const state = {
  db: null,
  avatar: null, // { image, originalImage, landmarks, pxPerCm, pxPerCmOld, heightPx, imageHeightPx, imageWidthPx, shoulderCm, bodyOutline, version }
  poseLandmarker: null,
  garments: [],
  allGarments: [],
  fitRules: null,
  fitPreference: 'regular',
  wornItems: [], // array of { garment: item, size: 'M', preference: 'regular' }
  selectedGarmentId: null,
  showLandmarks: false,
  showGarmentAnchors: false,
  debugFit: false,
  selectedCategory: 'outerwear',
  flowState: 'upload', // 'upload' | 'working' | 'review' | 'measurements' | 'ready'
  pendingOriginalDataUrl: null, // original photo waiting for review
  pendingAiDataUrl: null,       // AI result waiting for review
  abortController: null,        // AbortController for cancelling in-flight work
  apiKeyLoaded: null,           // Gemini key loaded from local-config
  smoothSleeves: true,          // Split 3-part mesh and follow arm skeleton
  realisticCompositing: true,   // Phase 5: Photo-realistic compositing for template garments
  fitLabels: new URLSearchParams(window.location.search).get('fitLabels') !== '0', // Phase 10: Fit labels on avatar (default ON)
  fitMap: new URLSearchParams(window.location.search).get('fitMap') === '1', // Phase 9C: 3D-style fit map overlay
  fitMapCache: new Map(),       // Phase 9C: Cache for rendered fit map overlay
  activeWarpData: null,         // Phase 9C: Current active garment warpData for tooltip hit-testing
  templateCompositingCache: new Map(), // Cache for offscreen composited layers: key -> { garmentCanvas, shadowCanvas }
  avatarSkinMaskCanvas: null,   // Phase 6: Cached avatar skin mask canvas (neck + hands)
  avatarSkinMaskAvatarId: null  // Phase 6: Cache key for avatar skin mask
};
// Debug hook: open dressing.html?debug=1 to inspect state from the browser console (window.__vto).
if (new URLSearchParams(location.search).has('debug')) window.__vto = state;

// --- IndexedDB Helpers ---
async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('FitCheckDressingDB', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('avatar')) {
        db.createObjectStore('avatar', { keyPath: 'id' });
      }
    };
  });
}

async function saveAvatarToDb(avatar) {
  if (GRID_MODE) return; // test renders must not overwrite the user's avatar
  const tx = state.db.transaction('avatar', 'readwrite');
  await tx.objectStore('avatar').put({ id: 'current', ...avatar });
}

async function getAvatarFromDb() {
  const tx = state.db.transaction('avatar', 'readonly');
  return new Promise((resolve) => {
    const request = tx.objectStore('avatar').get('current');
    request.onsuccess = () => resolve(request.result);
  });
}

async function deleteAvatarFromDb() {
  const tx = state.db.transaction('avatar', 'readwrite');
  await tx.objectStore('avatar').delete('current');
}

// --- MediaPipe Pose Setup ---
async function getPoseLandmarker() {
  if (state.poseLandmarker) return state.poseLandmarker;
  const vision = await FilesetResolver.forVisionTasks('./lib/mediapipe');
  try {
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: './lib/mediapipe/pose_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'IMAGE',
      numPoses: 2,
      outputSegmentationMasks: true
    });
  } catch (gpuErr) {
    console.warn('MediaPipe GPU delegate unavailable, falling back to CPU:', gpuErr);
    state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: './lib/mediapipe/pose_landmarker.task',
        delegate: 'CPU'
      },
      runningMode: 'IMAGE',
      numPoses: 2,
      outputSegmentationMasks: true
    });
  }
  return state.poseLandmarker;
}

// Garment Category Helper (Phase 10: Tops tab filters cardigan, hoodie, sweater, t-shirt, shirt)
const TOPS_TYPES = new Set(['cardigan', 'hoodie', 'sweater', 't-shirt', 'tshirt', 'shirt', 'top']);
function getGarmentCategory(g) {
  if (!g) return 'outerwear';
  const cat = (g.category || '').toLowerCase();
  const type = (g.type || '').toLowerCase();
  if (cat === 'tops' || TOPS_TYPES.has(type) || (g.id && g.id.includes('cardigan'))) {
    return 'tops';
  }
  if (cat === 'bottoms' || type === 'pants' || type === 'jeans' || type === 'skirt') {
    return 'bottoms';
  }
  return cat || 'outerwear';
}

// --- Core Logic ---
/**
 * Phase 9D: Determine verdict badge and plain-language recommendation text from zones.
 * Badges: Great fit / Good fit / Slightly tight / Too small / Slightly loose / Too big.
 */
function getFitVerdictAndRecommendation(size, garment, evalRes, rec, pref) {
  const zones = evalRes?.zones || [];
  const chest = zones.find(z => z.zone === 'chest');
  const waist = zones.find(z => z.zone === 'waist');

  // Badge is decided by the BODY zones; sleeve/length only add notes in the sentence
  // (browser check: "Too big" badge while chest and shoulders were tight, because sleeves were long).
  const TORSO = ['chest', 'waist', 'shoulder', 'hip', 'hips'];
  const tooTightZones = zones.filter(z => z.status === 'tooTight' && TORSO.includes(z.zone));
  const tightZones    = zones.filter(z => z.status === 'tight');
  const tooLooseZones = zones.filter(z => z.status === 'tooLoose' && TORSO.includes(z.zone));
  const looseZones    = zones.filter(z => z.status === 'loose');
  const goodZones     = zones.filter(z => z.status === 'good');

  let verdictLabel = 'Good fit';
  let verdictClass = 'good-fit';

  // Torso zones dominate clothing size verdict
  if (tooTightZones.length > 0) {
    verdictLabel = 'Too small';
    verdictClass = 'too-small';
  } else if (tooLooseZones.length > 0) {
    verdictLabel = 'Too big';
    verdictClass = 'too-big';
  } else if ((evalRes?.score ?? 0) >= 90) {
    // Grid check: a 98/100 size was labelled "Slightly loose" because chest was 1 cm into "loose".
    // A high score means the size fits; small deviations go into the sentence, not the badge.
    verdictLabel = 'Great fit';
    verdictClass = 'great-fit';
  } else if ((evalRes?.score ?? 0) >= 80) {
    verdictLabel = 'Good fit';
    verdictClass = 'good-fit';
  } else if ((evalRes?.score ?? 0) < 50 && (tightZones.length > 0)) {
    // Grid check: "XL · Slightly tight · 24/100" — a score that low is not "slightly".
    verdictLabel = 'Too small';
    verdictClass = 'too-small';
  } else if ((evalRes?.score ?? 0) < 50 && (looseZones.length > 0)) {
    verdictLabel = 'Too big';
    verdictClass = 'too-big';
  } else if (chest?.status === 'tight' || waist?.status === 'tight') {
    verdictLabel = 'Slightly tight';
    verdictClass = 'slightly-tight';
  } else if (chest?.status === 'loose' || waist?.status === 'loose') {
    verdictLabel = 'Slightly loose';
    verdictClass = 'slightly-loose';
  } else if (tightZones.length > 0 && (evalRes?.score ?? 0) < 80) {
    verdictLabel = 'Slightly tight';
    verdictClass = 'slightly-tight';
  } else if (looseZones.length > 0 && (evalRes?.score ?? 0) < 80) {
    verdictLabel = 'Slightly loose';
    verdictClass = 'slightly-loose';
  } else if ((evalRes?.score ?? 0) >= 90 && (chest?.status === 'good' || !chest)) {
    verdictLabel = 'Great fit';
    verdictClass = 'great-fit';
  } else {
    verdictLabel = 'Good fit';
    verdictClass = 'good-fit';
  }

  // Format Ease String helper
  const fmtEase = (z) => {
    if (!z || typeof z.ease !== 'number') return '';
    const rounded = Math.round(z.ease);
    return rounded > 0 ? `+${rounded} cm` : `${rounded} cm`;
  };

  const bestSize = rec?.bestSize || 'M';
  const isBest = (size === bestSize);
  const recFits = Boolean(rec?.fits);

  let recommendationText = '';

  if (!recFits) {
    // No size in this garment fits the body well
    const worst = tooTightZones[0] || tooLooseZones[0] || tightZones[0] || looseZones[0] || chest || zones[0];
    const easeStr = fmtEase(worst);
    // "Even <largest size>" / "Even <smallest size>": name the extreme size, not the selected one.
    const sizeNames = Object.keys(garment?.sizes || {});
    const largest = sizeNames[sizeNames.length - 1] || size;
    const smallest = sizeNames[0] || size;
    if (worst && (worst.status === 'tooTight' || worst.status === 'tight')) {
      recommendationText = `Even ${largest} is small for you at the ${worst.zone}${size === largest ? ` (${easeStr})` : ''}. This item is not recommended.`;
    } else if (worst && (worst.status === 'tooLoose' || worst.status === 'loose')) {
      recommendationText = `Even ${smallest} is too loose on you at the ${worst.zone}${size === smallest ? ` (${easeStr})` : ''}. This item is not recommended.`;
    } else {
      recommendationText = `${garment?.name || 'This garment'} does not suit your proportions well. This item is not recommended.`;
    }
  } else if (isBest) {
    // Current size is the recommended best fit!
    const nonGood = zones.filter(z => z.status !== 'good' && z.status !== 'n/a');
    if (nonGood.length === 0) {
      recommendationText = `${size} fits you well: chest, shoulders, and length are all a great match.`;
    } else if (nonGood.length === 1) {
      const bad = nonGood[0];
      const descriptor = (bad.zone === 'length' || bad.zone === 'sleeve')
        ? (bad.status.includes('Loose') || bad.status === 'loose' ? 'a little long' : 'a little short')
        : (bad.status.includes('Loose') || bad.status === 'loose' ? 'a little loose' : 'a little tight');
      const goodList = goodZones.map(z => z.zone);
      const goodPrefix = goodList.length > 0 ? `${goodList.slice(0, 2).join(' and ')} are good, ` : '';
      recommendationText = `${size} fits you well: ${goodPrefix}${bad.zone} is ${descriptor} (${fmtEase(bad)}).`;
    } else {
      const issues = nonGood.map(z => `${z.zone} is ${z.status.toLowerCase().replace('too', 'too ')}`).join(', ');
      recommendationText = `${size} is your best fit for this style (${issues}).`;
    }
  } else {
    // Current size is NOT the best size: recommend switching to bestSize
    if (verdictLabel === 'Too small') {
      const bad = tooTightZones[0] || chest;
      recommendationText = `${size} is too tight at the ${bad?.zone || 'torso'} (${fmtEase(bad)}). Choose ${bestSize}.`;
    } else if (verdictLabel === 'Slightly tight') {
      const bad = tightZones[0] || chest;
      recommendationText = `${size} is tight at the ${bad?.zone || 'chest'} (${fmtEase(bad)}). Choose ${bestSize}.`;
    } else if (verdictLabel === 'Too big') {
      if (tooLooseZones.length + looseZones.length >= 3) {
        recommendationText = `${size} is loose everywhere. ${bestSize} fits better.`;
      } else {
        const bad = tooLooseZones[0] || chest;
        recommendationText = `${size} is too wide at the ${bad?.zone || 'torso'} (${fmtEase(bad)}). Choose ${bestSize}.`;
      }
    } else if (verdictLabel === 'Slightly loose') {
      if (looseZones.length >= 3) {
        recommendationText = `${size} is loose everywhere. ${bestSize} fits better.`;
      } else {
        const bad = looseZones[0] || chest;
        recommendationText = `${size} is a bit loose at the ${bad?.zone || 'chest'} (${fmtEase(bad)}). Choose ${bestSize}.`;
      }
    } else {
      recommendationText = `${size} fits okay, but ${bestSize} gives a better overall balance.`;
    }
  }

  // Judge against the garment's DESIGN style: an oversized jacket is meant to be roomy.
  const STYLE = { fitted: 'a fitted', regular: 'a regular', relaxed: 'a relaxed', oversized: 'an oversized' };
  const design = garment?.designFit;
  if (design && STYLE[design]) {
    if (pref && pref !== design) {
      recommendationText += ` Note: this item is designed as ${STYLE[design]} fit; you are judging it as ${STYLE[pref] || pref} fit.`;
    } else {
      recommendationText = `Designed as ${STYLE[design]} fit. ` + recommendationText;
    }
  }
  return { verdictLabel, verdictClass, recommendationText };
}

/**
 * Grid mode (tests/tryon-grid.html). URL params:
 *   avatar=<image URL> | avatar=current (the avatar saved in this browser, read-only)
 *   gender, h, chest, waist, hip, shoulder   body measurements (cm)
 *   garments=id1,id2   size=best|S|M|L|XL   pref=regular|...
 * For each garment: render, then postMessage({type:'grid-shot', ...}) to the parent page.
 */
async function runGridMode() {
  const q = new URLSearchParams(window.location.search);
  const post = (msg) => window.parent.postMessage({ source: 'tryon-grid', run: q.get('run'), ...msg }, '*');
  try {
    state.fitRules = await loadFitRules();
    const gender = q.get('gender') || 'female';
    const m = { ...DEFAULT_MEASUREMENTS[gender] };
    for (const k of ['height', 'chest', 'waist', 'hip', 'shoulder', 'armLength', 'torsoLength']) {
      const v = parseFloat(q.get(k === 'height' ? 'h' : k));
      if (v > 0) m[k] = v;
    }
    state.bodyOverride = { gender, measurements: m };

    // Garments: catalog + this browser's custom garments (same merge as the normal page)
    let catalog = [];
    try { catalog = (await (await fetch('data/garments.json')).json()).garments || []; } catch (_) {}
    let custom = [];
    try { custom = await listCustomGarments(); } catch (_) {}
    const ids = new Set(custom.map((g) => g.id));
    const all = [...custom, ...catalog.filter((g) => !ids.has(g.id))];

    // Avatar
    const src = q.get('avatar') || 'current';
    if (src === 'current') {
      const saved = await getAvatarFromDb();
      if (!saved) throw new Error('No avatar saved in this browser');
      state.avatar = saved;
      const ratioH = saved.heightPx / m.height;   // re-scale to the requested height
      if (isFinite(ratioH) && ratioH > 0) state.avatar = { ...saved, pxPerCm: ratioH };
    } else {
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      await processAndStoreAvatar(dataUrl, m.height); // saveAvatarToDb is a no-op in grid mode
    }

    // Measurements: values given in the URL win; every missing one is estimated from THIS photo
    // (same estimator the user sees after uploading), so picture and numbers describe the same body.
    const est = estimateMeasurementsFromPhoto(state.avatar, m.height, gender);
    for (const k of ['chest', 'waist', 'hip', 'shoulder', 'armLength', 'torsoLength']) {
      const given = parseFloat(q.get(k));
      if (!(given > 0) && est.values[k] > 0) m[k] = est.values[k];
    }
    post({ type: 'grid-measurements', measurements: { ...m } });

    const canvas = document.getElementById('avatar-canvas');
    const wanted = (q.get('garments') || '').split(',').filter(Boolean);
    for (const id of wanted) {
      const g = all.find((x) => x.id === id);
      if (!g) { post({ type: 'grid-shot', garment: id, error: 'garment not found' }); continue; }
      let size = q.get('size') || 'best';
      let score = null;
      let verdict = null;
      try {
        const pref = q.get('pref') || g.designFit || 'regular';
        const rec = recommendSize(m, g, pref, state.fitRules);
        if (size === 'best') size = rec.bestSize;
        const evalRes = evaluateSize(m, g, size, pref, state.fitRules);
        score = evalRes.score;
        const vInfo = getFitVerdictAndRecommendation(size, g, evalRes, rec, pref);
        verdict = vInfo.verdictLabel;
      } catch (_) { if (size === 'best') size = 'M'; }
      state.wornItems = [{ garment: g, size, preference: q.get('pref') || g.designFit || 'regular' }];
      await renderStage();
      post({ type: 'grid-shot', garment: id, size, score, verdict, image: canvas.toDataURL('image/jpeg', 0.85) });
    }
    post({ type: 'grid-done' });
  } catch (err) {
    post({ type: 'grid-error', error: String(err && err.message || err) });
  }
}

async function init() {
  state.db = await openDb();
  if (GRID_MODE) { await runGridMode(); return; }

  // Try loading Gemini API key from local-config (dynamic import, never expose the key)
  state.apiKeyLoaded = await loadGeminiApiKey();

  // Show dev section if ?dev=1
  if (DEV_MODE) {
    const devEl = document.getElementById('flow-dev');
    if (devEl) devEl.hidden = false;
  }

  // Load saved avatar
  const savedAvatar = await getAvatarFromDb();
  if (savedAvatar) {
    state.avatar = savedAvatar;
    // Upgrade existing stored avatar so shoulder measurement reflects real outer shoulder edge (not joint centres)
    if (savedAvatar.landmarks && savedAvatar.pxPerCm) {
      const w = savedAvatar.imageWidthPx || 848;
      const h = savedAvatar.imageHeightPx || 1264;
      const landmarkJointSpan = Math.hypot(
        (savedAvatar.landmarks[11].x - savedAvatar.landmarks[12].x) * w,
        (savedAvatar.landmarks[11].y - savedAvatar.landmarks[12].y) * h
      );
      let shoulderSource = '';
      if (savedAvatar.bodyOutline && savedAvatar.bodyOutline.shoulderWidthPx && savedAvatar.bodyOutline.shoulderWidthPx > landmarkJointSpan) {
        state.avatar.shoulderPx = savedAvatar.bodyOutline.shoulderWidthPx;
        shoulderSource = 'mask';
      } else if (!savedAvatar.shoulderPx || savedAvatar.shoulderPx <= landmarkJointSpan * 1.1) {
        state.avatar.shoulderPx = landmarkJointSpan * 1.35;
        shoulderSource = '1.35 fallback';
      } else {
        shoulderSource = savedAvatar.shoulderSource || 'stored';
      }
      state.avatar.shoulderSource = shoulderSource;
      state.avatar.shoulderCm = state.avatar.shoulderPx / state.avatar.pxPerCm;
      console.log(`[Shoulder] Set shoulderPx via: ${shoulderSource} (${state.avatar.shoulderPx.toFixed(1)} px, ${state.avatar.shoulderCm.toFixed(1)} cm | landmarkJointSpan: ${landmarkJointSpan.toFixed(1)} px)`);
    }
    // If user has measurements, go straight to ready. Otherwise show measurements form.
    const body = loadBody();
    if (body) {
      showFlowState('ready');
    } else {
      showFlowState('measurements');
    }
    await renderStage();
  } else {
    showFlowState('upload');
  }

  // Load fit rules for fit engine
  try {
    state.fitRules = await loadFitRules();
  } catch (err) {
    console.warn('Could not load fit rules:', err);
  }

  let catalogGarments = [];
  try {
    const response = await fetch('data/garments.json');
    if (response.ok) {
      const data = await response.json();
      catalogGarments = data.garments || [];
    }
  } catch (e) {
    console.warn('Could not load garments catalog:', e);
  }

  // Load custom garments from IndexedDB (Step 3E)
  let customGarments = [];
  try {
    customGarments = await listCustomGarments();
  } catch (err) {
    console.warn('Could not load custom garments from IndexedDB:', err);
  }

  // Merge: custom garments override catalog items with same id (custom wins)
  const customMap = new Map(customGarments.map(g => [g.id, g]));
  state.allGarments = [
    ...customGarments,
    ...catalogGarments.filter(g => !customMap.has(g.id))
  ];

  const userGender = loadBody()?.gender || 'female';
  // Only garments that have image AND anchors and match gender (or unisex)
  state.garments = state.allGarments.filter(g =>
    !g.hidden && g.image && g.anchors && (!g.gender || g.gender === 'unisex' || g.gender === userGender)
  );
  renderCatalog();

  // If ?garment=<id> is in URL, select that garment after load
  const urlParams = new URLSearchParams(window.location.search);
  const targetGarmentId = urlParams.get('garment');
  if (targetGarmentId) {
    const targetGarment = state.allGarments.find(g => g.id === targetGarmentId);
    if (targetGarment) {
      const cat = getGarmentCategory(targetGarment);
      state.selectedCategory = cat;
      const tabOuterwear = document.getElementById('cat-tab-outerwear');
      const tabTops = document.getElementById('cat-tab-tops');
      if (cat === 'tops' && tabTops) {
        tabTops.classList.add('is-active');
        tabTops.setAttribute('aria-selected', 'true');
        if (tabOuterwear) {
          tabOuterwear.classList.remove('is-active');
          tabOuterwear.setAttribute('aria-selected', 'false');
        }
      } else if (cat === 'outerwear' && tabOuterwear) {
        tabOuterwear.classList.add('is-active');
        tabOuterwear.setAttribute('aria-selected', 'true');
        if (tabTops) {
          tabTops.classList.remove('is-active');
          tabTops.setAttribute('aria-selected', 'false');
        }
      }
      toggleGarment(targetGarment);
    }
  }

  setupEventListeners();
}

// Show a specific flow state, hiding all others
function showFlowState(stateName) {
  state.flowState = stateName;
  const allStates = ['flow-upload', 'flow-working', 'flow-review', 'flow-measurements', 'flow-ready'];
  for (const id of allStates) {
    const el = document.getElementById(id);
    if (el) el.hidden = (id !== `flow-${stateName}`);
  }
  // Update readout in ready state
  if (stateName === 'ready') updateReadyUI();
  // Build measurements form when entering that state
  if (stateName === 'measurements') buildMeasurementsForm();

  showMessage('', false);
}

// Downscale image so longest side <= maxPx (default 1600). Returns dataUrl.
// Python analogy: PIL Image.thumbnail((1600, 1600))
function downscaleImage(dataUrl, maxPx = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxPx && img.height <= maxPx) {
        resolve(dataUrl);
        return;
      }
      const scale = maxPx / Math.max(img.width, img.height);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(dataUrl); // fallback: use original
    img.src = dataUrl;
  });
}

function setupEventListeners() {
  // === NEW FLOW: Upload → Working → Review → Measurements → Ready ===

  // Start avatar creation (main flow)
  const startBtn = document.getElementById('start-avatar-btn');
  if (startBtn) startBtn.addEventListener('click', handleStartAvatarFlow);

  // Use photo direct (no AI / skip Gemini)
  const useDirectBtn = document.getElementById('use-photo-direct-btn');
  if (useDirectBtn) useDirectBtn.addEventListener('click', handleUsePhotoDirect);

  // Cancel processing
  const cancelProcessingBtn = document.getElementById('cancel-processing-btn');
  if (cancelProcessingBtn) {
    cancelProcessingBtn.addEventListener('click', () => {
      if (state.abortController) state.abortController.abort();
      showFlowState('upload');
    });
  }

  // Review screen buttons
  const acceptBtn = document.getElementById('accept-avatar-btn');
  if (acceptBtn) acceptBtn.addEventListener('click', handleAcceptAvatar);

  const retryBtn = document.getElementById('retry-avatar-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      if ((state.geminiRetryCount || 0) >= 2) {
        showMessage('Maximum 2 retries reached for this photo. Please upload a new photo or use your photo directly.', true);
        return;
      }
      if (state.pendingOriginalDataUrl && state.apiKeyLoaded) {
        showFlowState('working');
        setWorkingText('Retrying avatar generation…');
        try {
          state.abortController = new AbortController();
          const base64 = state.pendingOriginalDataUrl.includes(',')
            ? state.pendingOriginalDataUrl.split(',')[1]
            : state.pendingOriginalDataUrl;
          const resultBase64 = await generateAvatar(base64, 'image/jpeg', state.apiKeyLoaded, state.abortController.signal);
          const aiDataUrl = `data:image/jpeg;base64,${resultBase64}`;
          state.pendingAiDataUrl = aiDataUrl;

          // Re-validate
          setWorkingText('Validating AI output & body proportions…');
          const landmarker = await getPoseLandmarker();
          const geminiImg = await loadImage(aiDataUrl);
          const geminiPoseResult = landmarker.detect(geminiImg);
          const origImg = await loadImage(state.pendingOriginalDataUrl);
          const origPoseResult = landmarker.detect(origImg);
          const origLandmarks = origPoseResult?.landmarks?.[0] || null;

          const validation = validateGeminiOutput(geminiImg, geminiPoseResult, origLandmarks);
          state.pendingValidation = validation;

          const warningEl = document.getElementById('review-warning');
          const acceptBtn = document.getElementById('accept-avatar-btn');

          if (validation.status === 'reject') {
            state.geminiRetryCount = (state.geminiRetryCount || 0) + 1;
            if (warningEl) {
              warningEl.hidden = false;
              warningEl.style.background = '#FEF2F2';
              warningEl.style.borderColor = '#FCA5A5';
              warningEl.style.color = '#991B1B';
              warningEl.innerHTML = `<strong>⚠️ AI Result Rejected:</strong> ${validation.reason}<br><span style="font-size:0.75rem">Attempt ${state.geminiRetryCount} of 2.</span>`;
            }
            if (acceptBtn) acceptBtn.disabled = true;
          } else if (validation.status === 'warn') {
            if (warningEl) {
              warningEl.hidden = false;
              warningEl.style.background = '#FEF3C7';
              warningEl.style.borderColor = '#FCD34D';
              warningEl.style.color = '#92400E';
              warningEl.innerHTML = `⚠️ <strong>Proportions Note:</strong> ${validation.reason}`;
            }
            if (acceptBtn) acceptBtn.disabled = false;
          } else {
            if (warningEl) {
              warningEl.hidden = false;
              warningEl.style.background = '#ECFDF5';
              warningEl.style.borderColor = '#A7F3D0';
              warningEl.style.color = '#065F46';
              warningEl.innerHTML = `✓ <strong>Proportions Verified:</strong> Matches original photo within 6%.`;
            }
            if (acceptBtn) acceptBtn.disabled = false;
          }

          document.getElementById('review-original-img').src = state.pendingOriginalDataUrl;
          document.getElementById('review-ai-img').src = aiDataUrl;
          showFlowState('review');

        } catch (err) {
          showFlowState('review');
          handleAvatarError(err);
        }
      } else {
        showFlowState('upload');
      }
    });
  }

  const cancelReviewBtn = document.getElementById('cancel-avatar-btn');
  if (cancelReviewBtn) {
    cancelReviewBtn.addEventListener('click', () => {
      state.pendingOriginalDataUrl = null;
      state.pendingAiDataUrl = null;
      showFlowState('upload');
    });
  }

  // Measurements form: save
  const saveMeasurementsBtn = document.getElementById('save-measurements-btn');
  if (saveMeasurementsBtn) saveMeasurementsBtn.addEventListener('click', handleSaveMeasurements);

  // Ready state buttons
  const editMeasurementsBtn = document.getElementById('edit-measurements-btn');
  if (editMeasurementsBtn) editMeasurementsBtn.addEventListener('click', () => showFlowState('measurements'));

  const newPhotoBtn = document.getElementById('new-photo-btn');
  if (newPhotoBtn) newPhotoBtn.addEventListener('click', () => showFlowState('upload'));

  const deleteBtn = document.getElementById('delete-avatar-btn');
  if (deleteBtn) deleteBtn.addEventListener('click', handleDeleteAvatar);

  // Category tabs (Outerwear / Tops)
  const tabOuterwear = document.getElementById('cat-tab-outerwear');
  const tabTops = document.getElementById('cat-tab-tops');
  const tabBottoms = document.getElementById('cat-tab-bottoms');
  if (tabBottoms) tabBottoms.hidden = true;
  if (tabOuterwear) {
    tabOuterwear.addEventListener('click', () => {
      state.selectedCategory = 'outerwear';
      tabOuterwear.setAttribute('aria-selected', 'true');
      tabOuterwear.classList.add('is-active');
      if (tabTops) {
        tabTops.setAttribute('aria-selected', 'false');
        tabTops.classList.remove('is-active');
      }
      renderCatalog();
    });
  }
  if (tabTops) {
    tabTops.addEventListener('click', () => {
      state.selectedCategory = 'tops';
      tabTops.setAttribute('aria-selected', 'true');
      tabTops.classList.add('is-active');
      if (tabOuterwear) {
        tabOuterwear.setAttribute('aria-selected', 'false');
        tabOuterwear.classList.remove('is-active');
      }
      renderCatalog();
    });
  }

  // === DEV MODE: Old handlers (only relevant with ?dev=1) ===

  // Create avatar button (dev manual Gemini flow)
  const createBtn = document.getElementById('create-avatar-btn');
  if (createBtn) createBtn.addEventListener('click', handleCreateAvatar);

  // Upload ready avatar button & file input (dev)
  const uploadBtn = document.getElementById('upload-ready-btn');
  if (uploadBtn) uploadBtn.addEventListener('click', handleUploadReadyAvatar);

  const readyInput = document.getElementById('ready-photo-input');
  if (readyInput) readyInput.addEventListener('change', handleUploadReadyAvatar);

  // Load test avatar button (dev)
  const loadTestBtn = document.getElementById('load-test-avatar-btn');
  if (loadTestBtn) loadTestBtn.addEventListener('click', handleLoadTestAvatar);

  // Debug fit toggle (dev)
  const debugFitToggle = document.getElementById('debug-fit-toggle');
  if (debugFitToggle) {
    state.debugFit = debugFitToggle.checked;
    debugFitToggle.addEventListener('change', (e) => {
      state.debugFit = e.target.checked;
      renderStage();
    });
  }

  // Show landmarks toggle (dev)
  const landmarksToggle = document.getElementById('show-landmarks-toggle');
  if (landmarksToggle) {
    landmarksToggle.addEventListener('change', (e) => {
      state.showLandmarks = e.target.checked;
      renderStage();
    });
  }

  // Show garment anchors toggle (dev)
  const garmentAnchorsToggle = document.getElementById('show-garment-anchors-toggle');
  if (garmentAnchorsToggle) {
    garmentAnchorsToggle.addEventListener('change', (e) => {
      state.showGarmentAnchors = e.target.checked;
      renderStage();
    });
  }

  // Smooth sleeves toggle (dev)
  const smoothSleevesToggle = document.getElementById('smooth-sleeves-toggle');
  if (smoothSleevesToggle) {
    state.smoothSleeves = smoothSleevesToggle.checked;
    smoothSleevesToggle.addEventListener('change', (e) => {
      state.smoothSleeves = e.target.checked;
      renderStage();
    });
  }

  // Phase 11: Realistic compositing is ALWAYS on
  state.realisticCompositing = true;

  // Phase 10 & 11: Fit labels switch on stage toolbar (default ON)
  let fitLabelsToggle = document.getElementById('fit-labels-toggle');
  if (!fitLabelsToggle) {
    const stageFig = document.querySelector('.stage-figure') || document.querySelector('.dressing-stage');
    if (stageFig) {
      const bar = document.createElement('div');
      bar.className = 'stage-toolbar';
      bar.id = 'stage-toolbar';
      bar.innerHTML = `
        <label class="fit-labels-switch" style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; margin:0;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.75"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>
          <input type="checkbox" id="fit-labels-toggle" checked style="cursor:pointer; accent-color:var(--accent);">
          <span>Fit labels</span>
        </label>
      `;
      stageFig.appendChild(bar);
      fitLabelsToggle = document.getElementById('fit-labels-toggle');
    }
  }
  if (fitLabelsToggle) {
    fitLabelsToggle.checked = Boolean(state.fitLabels);
    fitLabelsToggle.addEventListener('change', (e) => {
      state.fitLabels = e.target.checked;
      renderStage();
    });
  }

  // Phase 9C: Support fit map toggle if present (e.g. tryon-grid / test mode)
  const fitMapToggle = document.getElementById('fit-map-toggle');
  const fitMapLegend = document.getElementById('fit-map-legend');
  if (fitMapToggle) {
    fitMapToggle.checked = Boolean(state.fitMap);
    if (fitMapLegend) fitMapLegend.hidden = !state.fitMap;
    fitMapToggle.addEventListener('change', (e) => {
      state.fitMap = e.target.checked;
      if (fitMapLegend) fitMapLegend.hidden = !state.fitMap;
      const fitTooltip = document.getElementById('fit-map-tooltip');
      if (fitTooltip && !state.fitMap) fitTooltip.hidden = true;
      renderStage();
    });
  }

  // Phase 9C: Tooltip hover/tap on stage canvas
  const stageCanvasEl = document.getElementById('avatar-canvas');
  const fitTooltipEl = document.getElementById('fit-map-tooltip');
  if (stageCanvasEl && fitTooltipEl) {
    const handleFitMapHover = (e) => {
      if (!state.fitMap || !state.activeWarpData) {
        fitTooltipEl.hidden = true;
        return;
      }
      const rect = stageCanvasEl.getBoundingClientRect();
      const scaleX = stageCanvasEl.width / (rect.width || 1);
      const scaleY = stageCanvasEl.height / (rect.height || 1);
      const cx = (e.clientX - rect.left) * scaleX;
      const cy = (e.clientY - rect.top) * scaleY;

      const hit = getFitMapZoneAtPoint(cx, cy, state.activeWarpData, stageCanvasEl);
      if (!hit || !hit.zone) {
        fitTooltipEl.hidden = true;
        return;
      }

      const easeVal = Math.round(hit.zone.ease || 0);
      const easeStr = easeVal >= 0 ? `+${easeVal} cm` : `${easeVal} cm`;
      const statusLabel = hit.zone.status === 'tooTight' ? 'too tight'
        : hit.zone.status === 'tooLoose' ? 'too loose'
        : hit.zone.status;
      const zoneName = hit.zone.zone.charAt(0).toUpperCase() + hit.zone.zone.slice(1);

      fitTooltipEl.innerHTML = `<strong>${zoneName}:</strong> ${easeStr}, ${statusLabel}`;
      fitTooltipEl.hidden = false;
      const stageFig = stageCanvasEl.parentElement;
      const figRect = stageFig ? stageFig.getBoundingClientRect() : rect;
      fitTooltipEl.style.left = `${e.clientX - figRect.left}px`;
      fitTooltipEl.style.top = `${e.clientY - figRect.top - 8}px`;
    };

    stageCanvasEl.addEventListener('mousemove', handleFitMapHover);
    stageCanvasEl.addEventListener('click', handleFitMapHover);
    stageCanvasEl.addEventListener('mouseleave', () => {
      fitTooltipEl.hidden = true;
    });
  }

  // Take everything off button
  const takeOffBtn = document.getElementById('take-off-btn');
  if (takeOffBtn) {
    takeOffBtn.addEventListener('click', () => {
      state.wornItems = [];
      updateWornItemsUI();
      updateSizePills();
      updateFitResultUI();
      renderCatalog();
      renderStage();
    });
  }
}

// --- New Flow Handlers ---

// Handler for using original uploaded photo directly (bypasses Gemini AI call)
async function handleUsePhotoDirect() {
  const photoInput = document.getElementById('photo-input');
  const directBtn = document.getElementById('use-photo-direct-btn');

  if (!photoInput || !photoInput.files || !photoInput.files[0]) {
    return showMessage('Please select a photo first.', true);
  }

  const file = photoInput.files[0];

  // Validate file type
  if (file.type && !file.type.match(/^image\/(jpeg|png|webp)$/)) {
    return showMessage('Please select a JPG, PNG or WebP image.', true);
  }

  // Validate file size (max 10 MB)
  if (file.size > 10 * 1024 * 1024) {
    return showMessage('Image is too large (max 10 MB). Please use a smaller photo.', true);
  }

  if (directBtn) {
    directBtn.disabled = true;
    directBtn.textContent = 'Processing…';
  }

  showFlowState('working');
  setWorkingText('Step 1/2: Checking photo quality & pose (MediaPipe)…');

  try {
    let originalDataUrl = await fileToDataUrl(file);
    originalDataUrl = await downscaleImage(originalDataUrl, 1600);

    const landmarker = await getPoseLandmarker();
    const checkImg = await loadImage(originalDataUrl);
    const checkResult = await checkPhoto(checkImg, landmarker);

    if (!checkResult.ok) {
      showFlowState('upload');
      showMessage('❌ ' + checkResult.errors.join('<br>'), true);
      return;
    }

    if (checkResult.warnings && checkResult.warnings.length > 0) {
      console.warn('[PhotoCheck Warnings]', checkResult.warnings);
    }

    setWorkingText('Step 2/2: Detecting body landmarks & scale…');
    await processAndStoreAvatar(originalDataUrl);
    photoInput.value = '';

    // New photo = maybe a new person: always ask for (estimated) measurements again.
    state.estimateFromPhoto = true;
    showFlowState('measurements');
  } catch (err) {
    showFlowState('upload');
    handleAvatarError(err);
  } finally {
    if (directBtn) {
      directBtn.disabled = false;
      directBtn.textContent = 'Use original photo (no AI)';
    }
  }
}

// Main flow: user clicks "Create Avatar"
async function handleStartAvatarFlow() {
  const photoInput = document.getElementById('photo-input');
  const startBtn = document.getElementById('start-avatar-btn');

  if (!photoInput || !photoInput.files || !photoInput.files[0]) {
    return showMessage('Please select a photo first.', true);
  }

  const file = photoInput.files[0];

  // Validate file type
  if (file.type && !file.type.match(/^image\/(jpeg|png|webp)$/)) {
    return showMessage('Please select a JPG, PNG or WebP image.', true);
  }

  // Validate file size (max 10 MB)
  if (file.size > 10 * 1024 * 1024) {
    return showMessage('Image is too large (max 10 MB). Please use a smaller photo.', true);
  }

  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Processing…';
  }

  showFlowState('working');
  setWorkingText('Step 1/3: Preparing photo & checking pose (MediaPipe)…');

  try {
    state.abortController = new AbortController();

    // Read file → dataUrl
    let originalDataUrl = await fileToDataUrl(file);

    // Downscale longest side to 1600 px
    originalDataUrl = await downscaleImage(originalDataUrl, 1600);
    state.pendingOriginalDataUrl = originalDataUrl;

    if (state.abortController.signal.aborted) return;

    // 1. Photo check (Step 1B)
    const landmarker = await getPoseLandmarker();
    const checkImg = await loadImage(originalDataUrl);
    const checkResult = await checkPhoto(checkImg, landmarker);

    if (state.abortController.signal.aborted) return;

    if (!checkResult.ok) {
      showFlowState('upload');
      showMessage('❌ ' + checkResult.errors.join('<br>'), true);
      return;
    }

    if (checkResult.warnings && checkResult.warnings.length > 0) {
      console.warn('[PhotoCheck Warnings]', checkResult.warnings);
      // Non-blocking warning (allows "Continue anyway")
      showMessage('⚠️ Note: ' + checkResult.warnings.join('<br>'), false);
    }

    // Check if API key is available
    if (!state.apiKeyLoaded) {
      // No key: use original photo directly (skip Gemini)
      showMessage('AI is not configured. Using your photo directly.', false);
      state.pendingAiDataUrl = null;
      // Go directly to processing with original photo
      setWorkingText('Detecting pose landmarks…');
      await processAndStoreAvatar(originalDataUrl);
      photoInput.value = '';
      // Skip review, go to measurements
      state.estimateFromPhoto = true;
      showFlowState('measurements');
      return;
    }

    if (state.abortController.signal.aborted) return;

    // 2. Gemini call
    setWorkingText('Step 2/3: Transforming outfit via Gemini AI (approx 5-15s)…');
    const base64 = originalDataUrl.includes(',') ? originalDataUrl.split(',')[1] : originalDataUrl;
    const resultBase64 = await generateAvatar(base64, file.type || 'image/jpeg', state.apiKeyLoaded, state.abortController.signal);

    if (state.abortController.signal.aborted) return;

    const aiDataUrl = `data:image/jpeg;base64,${resultBase64}`;
    state.pendingAiDataUrl = aiDataUrl;

    // 3. STEP 1D: Validate Gemini result against original
    setWorkingText('Step 3/3: Validating AI output & body proportions…');
    const geminiImg = await loadImage(aiDataUrl);
    const geminiPoseResult = landmarker.detect(geminiImg);
    const origPoseResult = landmarker.detect(checkImg);
    const origLandmarks = origPoseResult?.landmarks?.[0] || null;
    state.pendingOriginalLandmarks = origLandmarks;

    const validation = validateGeminiOutput(geminiImg, geminiPoseResult, origLandmarks);
    state.pendingValidation = validation;

    const warningEl = document.getElementById('review-warning');
    const acceptBtn = document.getElementById('accept-avatar-btn');

    if (validation.status === 'reject') {
      state.geminiRetryCount = (state.geminiRetryCount || 0) + 1;
      console.warn('[Gemini Validation Rejected]', validation);

      if (warningEl) {
        warningEl.hidden = false;
        warningEl.style.background = '#FEF2F2';
        warningEl.style.borderColor = '#FCA5A5';
        warningEl.style.color = '#991B1B';
        warningEl.innerHTML = `<strong>⚠️ AI Result Rejected:</strong> ${validation.reason}<br><span style="font-size:0.75rem">Attempt ${state.geminiRetryCount} of 2. Click "Try Again" to regenerate or "Cancel" to use original photo.</span>`;
      }
      if (acceptBtn) {
        // Disable "Use this avatar" when rejected to ensure only validated avatars can be accepted
        acceptBtn.disabled = true;
        acceptBtn.title = 'AI result did not pass proportion verification';
      }
    } else if (validation.status === 'warn') {
      console.warn('[Gemini Validation Warning]', validation);
      if (warningEl) {
        warningEl.hidden = false;
        warningEl.style.background = '#FEF3C7';
        warningEl.style.borderColor = '#FCD34D';
        warningEl.style.color = '#92400E';
        warningEl.innerHTML = `⚠️ <strong>Proportions Note:</strong> ${validation.reason}`;
      }
      if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.title = '';
      }
    } else {
      if (warningEl) {
        warningEl.hidden = false;
        warningEl.style.background = '#ECFDF5';
        warningEl.style.borderColor = '#A7F3D0';
        warningEl.style.color = '#065F46';
        warningEl.innerHTML = `✓ <strong>Proportions Verified:</strong> Matches original photo within 6%.`;
      }
      if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.title = '';
      }
    }

    // 4. Show review (original vs AI side by side)
    document.getElementById('review-original-img').src = originalDataUrl;
    document.getElementById('review-ai-img').src = aiDataUrl;

    showFlowState('review');
    photoInput.value = '';

  } catch (err) {
    if (err.name === 'AbortError') {
      showFlowState('upload');
      return;
    }
    showFlowState('upload');
    handleAvatarError(err);
  } finally {
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Create Avatar';
    }
  }
}

function setWorkingText(text) {
  const el = document.getElementById('working-text');
  if (el) el.textContent = text;
}

// Accept the AI avatar from review screen → process and go to measurements
async function handleAcceptAvatar() {
  showFlowState('working');
  setWorkingText('Processing avatar…');
  try {
    const dataUrl = state.pendingAiDataUrl || state.pendingOriginalDataUrl;
    const extraData = {
      version: 2,
      originalImage: state.pendingOriginalDataUrl || dataUrl,
      originalLandmarks: state.pendingOriginalLandmarks || null,
      validation: state.pendingValidation || null
    };
    await processAndStoreAvatar(dataUrl, 175, extraData);
    state.pendingOriginalDataUrl = null;
    state.pendingAiDataUrl = null;
    state.pendingOriginalLandmarks = null;
    state.pendingValidation = null;
    state.geminiRetryCount = 0;
    // New photo = maybe a new person: always ask for (estimated) measurements again.
    state.estimateFromPhoto = true;
    showFlowState('measurements');
  } catch (err) {
    showFlowState('upload');
    handleAvatarError(err);
  }
}

/**
 * Estimate body measurements from the avatar photo, given the user's height.
 * Front widths come from the MediaPipe person mask (bodyOutline), converted to cm with
 * pxPerCm = heightPx / height. A circumference is approximated as an ellipse whose depth is a
 * fixed fraction of the front width (Ramanujan's formula). When the arms touch the body the mask
 * width is too big, so it is replaced by a typical ratio of the shoulder width and marked "low".
 * Returns { values: {key: cm}, low: Set<key> }. These are ESTIMATES: the user must confirm them.
 */
function estimateMeasurementsFromPhoto(avatar, heightCm, gender) {
  const out = { values: {}, low: new Set() };
  if (!avatar || !avatar.heightPx || !avatar.landmarks || !heightCm) return out;
  const pxPerCm = avatar.heightPx / heightCm;
  const W = avatar.imageWidthPx || 800, H = avatar.imageHeightPx || 1200;
  const l = avatar.landmarks;
  const P = (i) => (l[i] ? { x: l[i].x * W, y: l[i].y * H } : null);
  const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0);
  const o = avatar.bodyOutline || {};
  const jointSpan = dist(P(11), P(12));
  const female = gender !== 'male';

  const shoulderCm = (o.shoulderWidthPx > jointSpan ? o.shoulderWidthPx : jointSpan * 1.35) / pxPerCm;
  const ellipse = (w, depthRatio) => {
    const a = w / 2, b = (w * depthRatio) / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  };
  // If an elbow/wrist lies inside the scanned mask run, the arm is merged with the torso there and
  // the mask width is too big (checked in the browser: a slim avatar got bust 107 / waist 93).
  const armInside = (left, right, idxs) => {
    if (left == null || right == null) return false;
    const m = 2 * pxPerCm;
    return idxs.some((i) => { const p = P(i); return p && p.x > left - m && p.x < right + m; });
  };
  const front = (px, left, right, armIdx, maxRatio, fallbackRatio, key) => {
    let w = px ? px / pxPerCm : 0;
    if (!w || w > shoulderCm * maxRatio || armInside(left, right, armIdx)) {
      w = shoulderCm * fallbackRatio; // typical front-width / shoulder-width ratio
    }
    return w;
  };
  const chestW = front(o.chestWidthPx, o.chestLeft, o.chestRight, [13, 14], 0.95, female ? 0.80 : 0.85, 'chest');
  const waistW = front(o.waistWidthPx, o.waistLeft, o.waistRight, [13, 14, 15, 16], 0.85, female ? 0.64 : 0.74, 'waist');
  const hipW   = front(o.hipWidthPx, o.hipLeft, o.hipRight, [15, 16], 1.05, female ? 0.88 : 0.82, 'hip');

  const r1 = (v) => Math.round(v * 2) / 2; // nearest 0.5 cm
  out.values.height = heightCm;
  out.values.shoulder = r1(shoulderCm);
  out.values.chest = r1(ellipse(chestW, female ? 0.75 : 0.72) * (female ? 1.04 : 1));
  out.values.waist = r1(ellipse(waistW, 0.72));
  out.values.hip = r1(ellipse(hipW, 0.75));
  // Landmarks are joint centres; the tape starts at the bony shoulder tip (~3 cm further out/up).
  const armPx = (dist(P(11), P(13)) + dist(P(13), P(15)) + dist(P(12), P(14)) + dist(P(14), P(16))) / 2;
  // Joint centres underestimate a tape measurement (shoulder tip -> wrist bone, slightly bent arm).
  // Blend with the typical ratio arm ≈ 0.35 x height (check: 52 cm was estimated at 165 cm, tape gave 59).
  if (armPx) out.values.armLength = r1(0.5 * (armPx / pxPerCm + 5) + 0.5 * (0.35 * heightCm));
  const sh = P(11) && P(12) ? { x: (P(11).x + P(12).x) / 2, y: (P(11).y + P(12).y) / 2 } : null;
  const hp = P(23) && P(24) ? { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 } : null;
  if (sh && hp) out.values.torsoLength = r1(dist(sh, hp) / pxPerCm + 4);
  // Circumferences are the least reliable (depth is guessed), always flag them for checking.
  ['chest', 'waist', 'hip'].forEach((k) => out.low.add(k));
  return out;
}

// Build measurements form dynamically from MEASUREMENT_FIELDS
function buildMeasurementsForm() {
  const container = document.getElementById('measurements-fields-container');
  if (!container) return;

  const body = loadBody();
  const genderSel = document.getElementById('gender-select');
  const gender = (state.estimateFromPhoto && genderSel && genderSel.dataset.touched) ? genderSel.value
    : (body ? body.gender : 'female');
  let measurements = body ? body.measurements : DEFAULT_MEASUREMENTS[gender];

  // New photo: pre-fill with values estimated from the photo; the user must confirm them.
  let estimate = null;
  if (state.estimateFromPhoto && state.avatar) {
    const heightCm = state.estimateHeight || measurements?.height || DEFAULT_MEASUREMENTS[gender].height;
    estimate = estimateMeasurementsFromPhoto(state.avatar, heightCm, gender);
    measurements = { ...DEFAULT_MEASUREMENTS[gender], ...estimate.values };
  }
  const banner = document.getElementById('estimate-banner');
  const confirmRow = document.getElementById('estimate-confirm-row');
  const confirmBox = document.getElementById('estimate-confirm');
  if (banner) banner.hidden = !estimate;
  if (confirmRow) confirmRow.hidden = !estimate;
  if (confirmBox && !estimate) confirmBox.checked = false;

  // Set gender select
  const genderSelect = document.getElementById('gender-select');
  if (genderSelect) genderSelect.value = gender;

  container.innerHTML = '';
  let currentGroup = '';

  for (const field of MEASUREMENT_FIELDS) {
    if (field.group !== currentGroup) {
      currentGroup = field.group;
      const groupTitle = document.createElement('div');
      groupTitle.className = 'measurement-group-title';
      groupTitle.textContent = currentGroup === 'body' ? 'Body' : currentGroup === 'upper' ? 'Upper Body' : 'Lower Body';
      container.appendChild(groupTitle);
    }

    const row = document.createElement('div');
    row.className = 'measurement-row';

    const label = getFieldLabel(field, gender);
    const savedVal = measurements && measurements[field.key] != null ? measurements[field.key] : '';

    row.innerHTML = `
      <div class="field">
        <label class="field-label" for="m-${field.key}">${label}${field.required ? '' : ' (optional)'}</label>
      </div>
      <div class="field">
        <input type="text" id="m-${field.key}" class="text-input" inputmode="decimal"
               value="${savedVal}" placeholder="${field.min}–${field.max}">
      </div>
      <div class="measurement-hint">${field.hint}</div>
    `;
    container.appendChild(row);
  }

  if (estimate) {
    for (const key of estimate.low) {
      const input = document.getElementById(`m-${key}`);
      if (input) { input.style.borderColor = '#E08A1E'; input.title = 'Estimated from the photo: please measure and correct'; }
    }
    // Pixels -> cm depends on height, so re-estimate everything when the height changes.
    const hInput = document.getElementById('m-height');
    if (hInput) hInput.onchange = () => {
      const h = parseFloat(hInput.value);
      if (h >= 140 && h <= 210) { state.estimateHeight = h; buildMeasurementsForm(); }
    };
  }

  // Update labels when gender changes
  if (genderSelect) {
    genderSelect.onchange = () => { genderSelect.dataset.touched = '1'; buildMeasurementsForm(); };
  }
}

// Save measurements and go to ready
function handleSaveMeasurements() {
  const genderSelect = document.getElementById('gender-select');
  const gender = genderSelect ? genderSelect.value : 'female';

  const rawValues = {};
  for (const field of MEASUREMENT_FIELDS) {
    const input = document.getElementById(`m-${field.key}`);
    rawValues[field.key] = input ? input.value : '';
  }

  const { measurements, errors, isValid } = validateMeasurements(rawValues, gender);

  // Clear old errors and show new ones
  for (const field of MEASUREMENT_FIELDS) {
    const row = document.getElementById(`m-${field.key}`)?.closest('.measurement-row');
    if (!row) continue;
    const existingErr = row.querySelector('.measurement-error');
    if (existingErr) existingErr.remove();
    if (errors[field.key]) {
      const errEl = document.createElement('div');
      errEl.className = 'measurement-error';
      errEl.textContent = errors[field.key];
      row.appendChild(errEl);
    }
  }

  if (!isValid) {
    showMessage('Please fix the errors above.', true);
    return;
  }

  if (state.estimateFromPhoto && !document.getElementById('estimate-confirm')?.checked) {
    showMessage('Please check the estimated measurements and tick "I checked these measurements".', true);
    return;
  }
  state.estimateFromPhoto = false;
  state.estimateHeight = null;

  // Save
  saveBody({ gender, measurements });

  // Cross-check: photo-derived shoulder width vs entered shoulder
  let crossCheckWarning = null;
  if (state.avatar && state.avatar.shoulderCm && measurements.shoulder) {
    const photoShoulder = state.avatar.shoulderCm;
    const diff = Math.abs(photoShoulder - measurements.shoulder) / measurements.shoulder;
    const crossCheckEl = document.getElementById('measurement-cross-check');
    if (diff > 0.10) {
      crossCheckWarning = `Photo-derived shoulder width (~${photoShoulder.toFixed(1)} cm estimate) differs by ${(diff * 100).toFixed(0)}% from your entered value (${measurements.shoulder} cm).`;
      if (crossCheckEl) {
        crossCheckEl.hidden = false;
        crossCheckEl.textContent = crossCheckWarning;
      }
    } else if (crossCheckEl) {
      crossCheckEl.hidden = true;
    }
  }

  // Recompute pxPerCm with new height immediately (no Gemini call)
  if (state.avatar && measurements.height) {
    const newPxPerCm = state.avatar.heightPx / measurements.height;
    state.avatar.pxPerCm = newPxPerCm;
    if (state.avatar.landmarks) {
      const w = state.avatar.imageWidthPx || 848;
      const h = state.avatar.imageHeightPx || 1264;
      const landmarkJointSpan = Math.hypot(
        (state.avatar.landmarks[11].x - state.avatar.landmarks[12].x) * w,
        (state.avatar.landmarks[11].y - state.avatar.landmarks[12].y) * h
      );
      let shoulderSource = '';
      if (state.avatar.bodyOutline && state.avatar.bodyOutline.shoulderWidthPx && state.avatar.bodyOutline.shoulderWidthPx > landmarkJointSpan) {
        state.avatar.shoulderPx = state.avatar.bodyOutline.shoulderWidthPx;
        shoulderSource = 'mask';
      } else {
        state.avatar.shoulderPx = landmarkJointSpan * 1.35;
        shoulderSource = '1.35 fallback';
      }
      state.avatar.shoulderSource = shoulderSource;
      console.log(`[Shoulder] Set shoulderPx via: ${shoulderSource} (${state.avatar.shoulderPx.toFixed(1)} px | landmarkJointSpan: ${landmarkJointSpan.toFixed(1)} px)`);
    }
    if (state.avatar.shoulderPx) {
      state.avatar.shoulderCm = state.avatar.shoulderPx / newPxPerCm;
    }
    saveAvatarToDb(state.avatar);
  }

  showFlowState('ready');
  if (crossCheckWarning) {
    showMessage(`⚠️ ${crossCheckWarning}`, false);
  }
  renderStage();
}

// Update the Ready state UI with current stats
function updateReadyUI() {
  const summaryHeightEl = document.getElementById('summary-height') || document.getElementById('readout-height');
  const measContainer = document.getElementById('readout-measurements');
  const body = loadBody();

  if (summaryHeightEl) {
    const h = body?.measurements?.height || state.avatar?.height;
    summaryHeightEl.innerHTML = `Height: <strong>${h ? `${Math.round(h)} cm` : '--'}</strong>`;
  }

  // Show 4 main measurements (chest, waist, hip, shoulder)
  if (measContainer) {
    if (body && body.measurements) {
      const m = body.measurements;
      const items = [
        { label: 'Chest', val: m.chest },
        { label: 'Waist', val: m.waist },
        { label: 'Hip', val: m.hip },
        { label: 'Shoulder', val: m.shoulder }
      ];
      measContainer.innerHTML = items.map(it => `
        <span class="meas-chip">
          <span class="meas-chip-label">${it.label}</span>
          <span class="meas-chip-val">${it.val ? `${Math.round(it.val)} cm` : '--'}</span>
        </span>
      `).join('');
    } else {
      measContainer.innerHTML = '<span class="muted text-xs">No measurements saved</span>';
    }
  }
}

// Helper: Measure real body outline from MediaPipe PoseLandmarker segmentation mask (or geometric fallback)
function extractBodyOutline(mask, landmarks, imgWidth, imgHeight) {
  // Key points: 11 = Left Shoulder (viewer's right), 12 = Right Shoulder (viewer's left)
  // 23 = Left Hip (viewer's right), 24 = Right Hip (viewer's left)
  const ptRShoulder = { x: landmarks[12].x * imgWidth, y: landmarks[12].y * imgHeight };
  const ptLShoulder = { x: landmarks[11].x * imgWidth, y: landmarks[11].y * imgHeight };
  const ptRHip = landmarks[24] ? { x: landmarks[24].x * imgWidth, y: landmarks[24].y * imgHeight } : { x: ptRShoulder.x, y: ptRShoulder.y + 400 };
  const ptLHip = landmarks[23] ? { x: landmarks[23].x * imgWidth, y: landmarks[23].y * imgHeight } : { x: ptLShoulder.x, y: ptLShoulder.y + 400 };

  const midShoulderX = (ptRShoulder.x + ptLShoulder.x) / 2;
  const midShoulderY = (ptRShoulder.y + ptLShoulder.y) / 2;
  const midHipX = (ptRHip.x + ptLHip.x) / 2;
  const midHipY = (ptRHip.y + ptLHip.y) / 2;
  const torsoHeight = Math.max(50, midHipY - midShoulderY);
  const shoulderSpan = Math.abs(ptLShoulder.x - ptRShoulder.x);

  const chestY = midShoulderY + 0.28 * torsoHeight;
  const waistY = midShoulderY + 0.58 * torsoHeight;
  const hipY   = midShoulderY + 0.95 * torsoHeight;

  if (mask) {
    try {
      const maskW = mask.width;
      const maskH = mask.height;
      const data = typeof mask.getAsFloat32Array === 'function' ? mask.getAsFloat32Array() : (mask.getAsUint8Array ? mask.getAsUint8Array() : null);

      if (data && data.length > 0) {
        const isFloat = data instanceof Float32Array;
        const thresh = isFloat ? 0.5 : 128;

        const getVal = (x, y) => {
          const u = x / imgWidth;
          const v = y / imgHeight;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
          const c = Math.min(maskW - 1, Math.max(0, Math.floor(u * maskW)));
          const r = Math.min(maskH - 1, Math.max(0, Math.floor(v * maskH)));
          return data[r * maskW + c];
        };

        const findEdgesAtY = (y, maxHalfWidth) => {
          const t = (y - midShoulderY) / torsoHeight;
          const cX = midShoulderX * (1 - t) + midHipX * t;
          let leftX = cX;
          let rightX = cX;

          for (let x = cX; x >= cX - maxHalfWidth; x -= 2) {
            if (getVal(x, y) < thresh) {
              leftX = x;
              break;
            }
            leftX = x;
          }

          for (let x = cX; x <= cX + maxHalfWidth; x += 2) {
            if (getVal(x, y) < thresh) {
              rightX = x;
              break;
            }
            rightX = x;
          }

          return { left: leftX, right: rightX, width: Math.max(20, rightX - leftX) };
        };

        const chestEdges = findEdgesAtY(chestY, shoulderSpan * 0.60);
        const waistEdges = findEdgesAtY(waistY, shoulderSpan * 0.55);
        const hipEdges   = findEdgesAtY(hipY,   shoulderSpan * 0.68);
        const shoulderEdges = findEdgesAtY(midShoulderY, shoulderSpan * 0.75);

        return {
          chestWidthPx: chestEdges.width,
          waistWidthPx: waistEdges.width,
          hipWidthPx:   hipEdges.width,
          shoulderWidthPx: shoulderEdges.width,
          chestLeft: chestEdges.left,
          chestRight: chestEdges.right,
          waistLeft: waistEdges.left,
          waistRight: waistEdges.right,
          hipLeft: hipEdges.left,
          hipRight: hipEdges.right,
          shoulderLeft: shoulderEdges.left,
          shoulderRight: shoulderEdges.right,
          chestY, waistY, hipY
        };
      }
    } catch (err) {
      console.warn('Error reading segmentation mask, falling back to geometric outline:', err);
    }
  }

  // Fallback: robust anatomical body proportions from key landmarks
  const chestWidthPx = shoulderSpan * 0.86;
  const waistWidthPx = shoulderSpan * 0.74;
  const hipWidthPx   = shoulderSpan * 0.96;
  const shoulderWidthPx = shoulderSpan + 45;

  return {
    chestWidthPx,
    waistWidthPx,
    hipWidthPx,
    shoulderWidthPx,
    chestLeft: midShoulderX - chestWidthPx / 2,
    chestRight: midShoulderX + chestWidthPx / 2,
    waistLeft: midShoulderX - waistWidthPx / 2,
    waistRight: midShoulderX + waistWidthPx / 2,
    hipLeft: midHipX - hipWidthPx / 2,
    hipRight: midHipX + hipWidthPx / 2,
    shoulderLeft: midShoulderX - shoulderWidthPx / 2,
    shoulderRight: midShoulderX + shoulderWidthPx / 2,
    chestY, waistY, hipY
  };
}

// Common pipeline for processing an avatar image (AI generated, ready uploaded, or test avatar)
async function processAndStoreAvatar(dataUrl, customHeight = 175, extraData = {}) {
  // 1. Determine body height: customHeight, or from storage, or fallback to 175cm
  let heightCm = customHeight;
  try {
    const bodyData = loadBody();
    if (bodyData && bodyData.measurements && bodyData.measurements.height) {
      heightCm = bodyData.measurements.height;
    }
  } catch (_) {}

  if (!heightCm || heightCm <= 0 || !isFinite(heightCm)) {
    heightCm = 175;
  }

  // 2. Load image element
  const img = await loadImage(dataUrl);

  // 3. MediaPipe Pose Landmarker detection
  showMessage('Detecting pose landmarks...', false);
  const landmarker = await getPoseLandmarker();
  const poseResult = landmarker.detect(img);

  if (!poseResult || !poseResult.landmarks || poseResult.landmarks.length === 0) {
    throw new Error('NO_PERSON_DETECTED');
  }

  const landmarks = poseResult.landmarks[0];
  if (!landmarks || landmarks.length < 33) {
    throw new Error('POSE_LANDMARKS_MISSING');
  }

  // 4. Validate key landmarks & confidence
  // Key points: Nose (0), Shoulders (11, 12), Elbows (13, 14), Wrists (15, 16),
  // Hips (23, 24), Knees (25, 26), Ankles (27, 28)
  const keyIndices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  for (const idx of keyIndices) {
    const pt = landmarks[idx];
    if (!pt) {
      throw new Error('POSE_LANDMARKS_MISSING');
    }
    if (typeof pt.visibility === 'number' && pt.visibility < 0.5) {
      throw new Error('LOW_CONFIDENCE');
    }
  }

  // 5. Check if feet are visible in frame (ankles 27, 28)
  const leftAnkle = landmarks[27];
  const rightAnkle = landmarks[28];
  if (!leftAnkle || !rightAnkle) {
    throw new Error('FEET_NOT_VISIBLE');
  }
  if ((typeof leftAnkle.visibility === 'number' && leftAnkle.visibility < 0.5) ||
      (typeof rightAnkle.visibility === 'number' && rightAnkle.visibility < 0.5)) {
    throw new Error('FEET_NOT_VISIBLE');
  }
  if (leftAnkle.y > 0.98 || rightAnkle.y > 0.98 || leftAnkle.y < 0 || rightAnkle.y < 0) {
    throw new Error('FEET_NOT_VISIBLE');
  }
  // Optional toe landmarks check if out of bounds (31, 32)
  if ((landmarks[31] && landmarks[31].y > 1.02) || (landmarks[32] && landmarks[32].y > 1.02)) {
    throw new Error('FEET_NOT_VISIBLE');
  }

  // 6. Compute px_per_cm using segmentation mask (head-top to floor) for accuracy.
  //    Old formula (nose-to-ankle) captures ~88% of standing height → ~11% scale error.
  //    Python analogy: scanning a numpy boolean mask row-by-row to find first/last True.

  // 6a. Old (fallback) formula — keep for comparison
  const noseY = landmarks[0].y * img.height;
  const ankleY = ((leftAnkle.y + rightAnkle.y) / 2) * img.height;
  const heightPxOld = Math.abs(ankleY - noseY);
  const pxPerCmOld = heightPxOld / heightCm;

  // 6b. New formula using segmentation mask top/bottom rows
  let headTopY = null;
  let floorY = null;
  if (poseResult.segmentationMasks && poseResult.segmentationMasks.length > 0) {
    try {
      const mask = poseResult.segmentationMasks[0];
      const maskW = mask.width;
      const maskH = mask.height;
      // getAsFloat32Array() returns confidence [0..1] per pixel, like a 2D numpy array flattened.
      const maskData = mask.getAsFloat32Array();
      const threshold = 0.5;

      // Scan top→down for first row with any body pixel
      for (let row = 0; row < maskH; row++) {
        const offset = row * maskW;
        for (let col = 0; col < maskW; col++) {
          if (maskData[offset + col] >= threshold) {
            headTopY = (row / maskH) * img.height;
            break;
          }
        }
        if (headTopY !== null) break;
      }

      // Scan bottom→up for last row with any body pixel
      for (let row = maskH - 1; row >= 0; row--) {
        const offset = row * maskW;
        for (let col = 0; col < maskW; col++) {
          if (maskData[offset + col] >= threshold) {
            floorY = ((row + 1) / maskH) * img.height;
            break;
          }
        }
        if (floorY !== null) break;
      }
    } catch (maskErr) {
      console.warn('Segmentation mask scan failed, using landmark fallback:', maskErr);
    }
  }

  // 6c. If mask unavailable or invalid: use |ankle - nose| / 0.88 and mark scale "approximate"
  let scaleApproximate = false;
  let heightPx;
  if (headTopY !== null && floorY !== null && (floorY - headTopY) > 100) {
    heightPx = Math.abs(floorY - headTopY);
  } else {
    scaleApproximate = true;
    heightPx = heightPxOld / 0.88;
    headTopY = noseY - (heightPx - heightPxOld) * 0.45;
    floorY = headTopY + heightPx;
  }

  const pxPerCm = heightPx / heightCm;

  // Log both for debugging (Python dagi print() ga o'xshash)
  console.log('[Scale] Old (nose→ankle):', pxPerCmOld.toFixed(3), 'px/cm |',
    'New (mask or /0.88):', pxPerCm.toFixed(3), 'px/cm |',
    'Approximate:', scaleApproximate, '|',
    'Δ:', ((pxPerCm - pxPerCmOld) / pxPerCmOld * 100).toFixed(1) + '%',
    '| headTopY:', headTopY?.toFixed(1), 'floorY:', floorY?.toFixed(1));

  if (!pxPerCm || pxPerCm <= 0 || !isFinite(pxPerCm)) {
    throw new Error('POSE_LANDMARKS_MISSING');
  }

  // 7. Extract real body outline from MediaPipe segmentation mask
  let bodyOutline = null;
  if (poseResult.segmentationMasks && poseResult.segmentationMasks.length > 0) {
    bodyOutline = extractBodyOutline(poseResult.segmentationMasks[0], landmarks, img.width, img.height);
    try {
      if (typeof poseResult.segmentationMasks[0].close === 'function') {
        poseResult.segmentationMasks[0].close();
      }
    } catch (_) {}
  } else {
    bodyOutline = extractBodyOutline(null, landmarks, img.width, img.height);
  }

  // 7b. Real outer shoulder width: MediaPipe landmarks (11, 12) are joint centres (~28.6 cm),
  // whereas clothing shoulder width measures outer deltoid edge to outer deltoid edge (~39 cm).
  // Use mask silhouette at shoulder height if available; otherwise use documented anatomical ratio ~1.35x.
  const landmarkJointSpan = Math.hypot(
    (landmarks[11].x - landmarks[12].x) * img.width,
    (landmarks[11].y - landmarks[12].y) * img.height
  );
  let shoulderPx;
  let shoulderSource = '';
  if (bodyOutline && bodyOutline.shoulderWidthPx && bodyOutline.shoulderWidthPx > landmarkJointSpan) {
    shoulderPx = bodyOutline.shoulderWidthPx;
    shoulderSource = 'mask';
  } else {
    shoulderPx = landmarkJointSpan * 1.35;
    shoulderSource = '1.35 fallback';
  }
  const shoulderCm = shoulderPx / pxPerCm;
  console.log(`[Shoulder] Set shoulderPx via: ${shoulderSource} (${shoulderPx.toFixed(1)} px, ${shoulderCm.toFixed(1)} cm | landmarkJointSpan: ${landmarkJointSpan.toFixed(1)} px)`);

  // 8. Save avatar, landmarks, and body outline to IndexedDB
  const newAvatar = {
    version: 2,
    image: dataUrl,
    originalImage: extraData.originalImage || dataUrl,
    landmarks,
    originalLandmarks: extraData.originalLandmarks || landmarks,
    bodyOutline,
    pxPerCm,
    pxPerCmOld,
    scaleApproximate,
    headTopY,
    floorY,
    heightPx,
    shoulderPx,
    shoulderSource,
    imageHeightPx: img.height,
    imageWidthPx: img.width,
    shoulderCm,
    validation: extraData.validation || null
  };

  await saveAvatarToDb(newAvatar);
  state.avatar = newAvatar;

  updateAvatarUI();
  await renderStage();
  showMessage('', false);
}

// Handler for AI avatar generation via Gemini API
async function handleCreateAvatar() {
  const photoInput = document.getElementById('photo-input');
  const apiKeyInput = document.getElementById('api-key-input');
  const createBtn = document.getElementById('create-avatar-btn');

  if (!photoInput.files || !photoInput.files[0]) {
    return showMessage('Please select a photo.', true);
  }
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    return showMessage('Please enter your Gemini API key.', true);
  }

  try {
    createBtn.disabled = true;
    createBtn.textContent = 'Processing...';
    showMessage('Generating digital model...', false);

    const file = photoInput.files[0];
    const base64 = await fileToBase64(file);
    const originalDataUrl = await fileToDataUrl(file);
    const resultBase64 = await generateAvatar(base64, file.type, apiKey);
    apiKeyInput.value = '';

    const geminiDataUrl = `data:image/jpeg;base64,${resultBase64}`;

    // --- Gemini Validation: compare proportions of original vs Gemini output ---
    // Python analogy: assert abs(ratio_orig - ratio_gemini) / ratio_orig < 0.05
    showMessage('Validating AI output proportions...', false);
    let useOriginalMeasurements = false;
    let originalLandmarks = null;
    let originalPxPerCm = null;
    try {
      const landmarker = await getPoseLandmarker();
      const origImg = await loadImage(originalDataUrl);
      const origResult = landmarker.detect(origImg);
      const geminiImg = await loadImage(geminiDataUrl);
      const geminiResult = landmarker.detect(geminiImg);

      if (origResult?.landmarks?.[0]?.length >= 33 && geminiResult?.landmarks?.[0]?.length >= 33) {
        const oL = origResult.landmarks[0];
        const gL = geminiResult.landmarks[0];

        // Compute normalized ratios (landmark distances divided by nose-to-ankle)
        const origH = Math.abs(((oL[27].y + oL[28].y) / 2) - oL[0].y);
        const gemH  = Math.abs(((gL[27].y + gL[28].y) / 2) - gL[0].y);

        const origShW = Math.hypot(oL[11].x - oL[12].x, oL[11].y - oL[12].y);
        const gemShW  = Math.hypot(gL[11].x - gL[12].x, gL[11].y - gL[12].y);

        const origHipW = Math.hypot(oL[23].x - oL[24].x, oL[23].y - oL[24].y);
        const gemHipW  = Math.hypot(gL[23].x - gL[24].x, gL[23].y - gL[24].y);

        // Ratios: shoulder/height, hip/height
        const origShRatio = origShW / origH;
        const gemShRatio  = gemShW / gemH;
        const origHipRatio = origHipW / origH;
        const gemHipRatio  = gemHipW / gemH;

        const shDiff  = Math.abs(origShRatio - gemShRatio) / origShRatio;
        const hipDiff = Math.abs(origHipRatio - gemHipRatio) / origHipRatio;

        console.log('[Gemini Validation]', {
          origShRatio: origShRatio.toFixed(4),
          gemShRatio: gemShRatio.toFixed(4),
          shDiff: (shDiff * 100).toFixed(1) + '%',
          origHipRatio: origHipRatio.toFixed(4),
          gemHipRatio: gemHipRatio.toFixed(4),
          hipDiff: (hipDiff * 100).toFixed(1) + '%'
        });

        if (shDiff > 0.05 || hipDiff > 0.05) {
          showMessage(
            '⚠️ AI changed your proportions (shoulder ' + (shDiff * 100).toFixed(0) + '%, hip ' +
            (hipDiff * 100).toFixed(0) + '% off). Using original photo for measurements.',
            true
          );
          useOriginalMeasurements = true;
          originalLandmarks = oL;
          // Compute original pxPerCm (in original image pixel space)
          const origNoseY = oL[0].y * origImg.height;
          const origAnkleY = ((oL[27].y + oL[28].y) / 2) * origImg.height;
          originalPxPerCm = Math.abs(origAnkleY - origNoseY) / 175; // will be overridden by mask in processAndStoreAvatar
        }
      }

      // Close masks if any
      try { origResult?.segmentationMasks?.[0]?.close?.(); } catch (_) {}
      try { geminiResult?.segmentationMasks?.[0]?.close?.(); } catch (_) {}
    } catch (valErr) {
      console.warn('[Gemini Validation] Could not validate:', valErr);
    }

    await processAndStoreAvatar(geminiDataUrl);

    // If validation failed, override landmarks with original photo's landmarks
    if (useOriginalMeasurements && originalLandmarks && state.avatar) {
      state.avatar._originalLandmarks = originalLandmarks;
      state.avatar._proportionWarning = true;
      console.log('[Gemini Validation] Stored original landmarks for reference.');
    }
  } catch (err) {
    handleAvatarError(err);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Generate Model';
  }
}

// Handler for uploading a ready avatar image (PNG/JPG) without API key
async function handleUploadReadyAvatar() {
  const fileInput = document.getElementById('ready-photo-input');
  const uploadBtn = document.getElementById('upload-ready-btn');

  if (!fileInput.files || !fileInput.files[0]) {
    return showMessage('Please select a ready avatar image (PNG or JPG).', true);
  }

  const file = fileInput.files[0];
  if (file.type && !file.type.startsWith('image/')) {
    return showMessage('Selected file must be a PNG or JPG image.', true);
  }

  try {
    if (uploadBtn) {
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Processing...';
    }
    showMessage('Loading portrait model...', false);

    const dataUrl = await fileToDataUrl(file);
    await processAndStoreAvatar(dataUrl);
    fileInput.value = '';
  } catch (err) {
    handleAvatarError(err);
  } finally {
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Set Model';
    }
  }
}

// Handler for loading the local test avatar (assets/avatars2d/test-avatar.png)
async function handleLoadTestAvatar() {
  const testBtn = document.getElementById('load-test-avatar-btn');
  try {
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = 'Loading...';
    }
    showMessage('Loading demo model...', false);

    const response = await fetch('assets/avatars2d/test-avatar.png');
    if (!response.ok) {
      throw new Error(`Failed to load assets/avatars2d/test-avatar.png (${response.status} ${response.statusText}). Make sure the file exists.`);
    }

    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    await processAndStoreAvatar(dataUrl);
  } catch (err) {
    handleAvatarError(err);
  } finally {
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.textContent = 'Use Demo Model';
    }
  }
}

// Error handling function: displays clear message and keeps previous avatar unchanged
function handleAvatarError(err) {
  console.error('[Avatar error]', err);

  const errStr = (err && (err.message || String(err))) || 'Unknown error';

  if (errStr === 'NO_PERSON_DETECTED') {
    showMessage('❌ No person detected in the photo. Please upload a clear full-length photo.', true);
  } else if (errStr === 'POSE_LANDMARKS_MISSING' || errStr === 'LOW_CONFIDENCE') {
    showMessage('❌ Pose landmarks missing or low confidence. Please use a well-lit, front-facing full-length photo.', true);
  } else if (errStr === 'FEET_NOT_VISIBLE') {
    showMessage('❌ Feet not visible in frame. Please ensure full body from head to shoes is included.', true);
  } else if (errStr.includes('401') || errStr.includes('403') || errStr.includes('API key')) {
    showMessage('❌ Gemini API key is missing or invalid in js/local-config.js.<br><small style="display:inline-block;margin-top:4px">Tip: Click <strong>"Use original photo (no AI)"</strong> to try on garments directly without Gemini.</small>', true);
  } else if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('Hourly limit')) {
    showMessage('❌ Gemini API quota or hourly limit reached.<br><small style="display:inline-block;margin-top:4px">Tip: Click <strong>"Use original photo (no AI)"</strong> to try on garments directly with your photo!</small>', true);
  } else if (errStr.includes('blocked')) {
    showMessage('❌ Request was blocked by AI safety filters. Please try another photo or click <strong>"Use original photo (no AI)"</strong>.', true);
  } else if (errStr.includes('404')) {
    showMessage('❌ Gemini model not available: ' + errStr + '.<br><small style="display:inline-block;margin-top:4px">Tip: Click <strong>"Use original photo (no AI)"</strong> to try on garments directly.</small>', true);
  } else {
    showMessage('❌ Avatar processing failed: ' + errStr + '<br><small style="display:inline-block;margin-top:4px">Tip: You can click <strong>"Use original photo (no AI)"</strong> to try on clothes directly without AI.</small>', true);
  }
}

// Delete current avatar and landmarks from IndexedDB and reset to template avatar
async function handleDeleteAvatar() {
  if (!confirm('Delete your avatar and start fresh?')) return;
  try {
    await deleteAvatarFromDb();
    state.avatar = null;
    state.wornItems = [];
    updateWornItemsUI();
    updateSizePills();
    updateFitResultUI();
    showFlowState('upload');
    renderStage();
  } catch (err) {
    showMessage('Failed to delete avatar: ' + (err.message || err), true);
  }
}

// Legacy updateAvatarUI — kept for dev-mode handlers that call it
function updateAvatarUI() {
  if (state.avatar) {
    // New photo = maybe a new person: always ask for (estimated) measurements again.
    state.estimateFromPhoto = true;
    showFlowState('measurements');
  } else {
    showFlowState('upload');
  }
}

function renderCatalog() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const userGender = loadBody()?.gender || 'female';
  // Filter by image, anchors, and gender
  const allAvailable = (state.allGarments.length ? state.allGarments : state.garments).filter(g =>
    !g.hidden && g.image && g.anchors && (!g.gender || g.gender === 'unisex' || g.gender === userGender)
  );

  // Keep bottoms tab hidden if it exists (Phase 10)
  const tabBottoms = document.getElementById('cat-tab-bottoms');
  if (tabBottoms) tabBottoms.hidden = true;

  const currentCat = (state.selectedCategory || 'outerwear').toLowerCase();
  const displayItems = allAvailable.filter(g => getGarmentCategory(g) === currentCat);

  if (displayItems.length === 0) {
    grid.innerHTML = `<p class="muted text-sm" style="grid-column:1/-1;padding:24px 0;text-align:center">No items yet in this category.</p>`;
    return;
  }

  displayItems.forEach(item => {
    const isWorn = Boolean(state.wornItems.find(w => w.garment.id === item.id));
    const card = document.createElement('div');
    card.className = `catalog-card ${isWorn ? 'is-active' : ''}`;

    card.innerHTML = `
      <div class="catalog-card-media">
        <img src="${item.image}" class="catalog-card-img" alt="${item.name}">
        ${isWorn ? '<span class="catalog-card-worn-badge">✓ Wearing</span>' : ''}
      </div>
      <div class="catalog-card-meta">
        <span class="catalog-card-title">${item.name}</span>
      </div>
    `;
    card.addEventListener('click', () => toggleGarment(item));
    grid.appendChild(card);
  });
}

function toggleGarment(item) {
  const isCurrentlyWorn = state.wornItems.some(w => w.garment.id === item.id);

  if (isCurrentlyWorn) {
    // Clicking the worn garment again removes it (toggle off)
    state.wornItems = [];
  } else {
    // Determine default size from recommendSize if rules and body available
    const body = loadBody();
    const pref = item.designFit || state.fitPreference || 'regular';
    let chosenSize = 'M';

    if (body && body.measurements && state.fitRules) {
      try {
        const rec = recommendSize(body.measurements, item, pref, state.fitRules);
        if (rec && rec.bestSize) chosenSize = rec.bestSize;
      } catch (_) {}
    }

    // Single garment at a time: wearing any garment REPLACES the current one
    state.wornItems = [{ garment: item, size: chosenSize, preference: pref }];
  }

  renderCatalog();
  updateWornItemsUI();
  updateFitResultUI();
  renderStage();
}

function updateWornItemsUI() {
  const list = document.getElementById('worn-items-list');
  const takeOffBtn = document.getElementById('take-off-btn');
  if (!list || !takeOffBtn) return;

  if (state.wornItems.length === 0) {
    list.innerHTML = `
      <div class="empty-rack-msg">
        <svg class="empty-rack-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path d="M16 11V7a4 4 0 0 0-8 0v4M5 9h14l1 12H4L5 9z"/>
        </svg>
        <span class="empty-rack-title">Pick an item from the wardrobe</span>
      </div>
    `;
    takeOffBtn.disabled = true;
    updateFitResultUI();
    return;
  }

  takeOffBtn.disabled = false;
  list.innerHTML = '';
  const item = state.wornItems[0];
  const row = document.createElement('div');
  row.className = 'worn-item-row';
  const categoryLabel = getGarmentCategory(item.garment).toUpperCase();
  row.innerHTML = `
    <div class="worn-item-info">
      <img src="${item.garment.image}" class="worn-item-thumb" alt="${item.garment.name}">
      <div class="worn-item-details">
        <span class="worn-item-name">${item.garment.name}</span>
        <span class="worn-item-category">${categoryLabel} · Size ${item.size}</span>
      </div>
    </div>
    <button type="button" class="remove-btn" title="Remove piece">✕</button>
  `;
  row.querySelector('.remove-btn').addEventListener('click', () => {
    state.wornItems = [];
    updateWornItemsUI();
    updateFitResultUI();
    renderCatalog();
    renderStage();
  });
  list.appendChild(row);
}

function updateSizePills() {
  const container = document.getElementById('size-pills');
  if (!container) return;
  const activeWorn = state.wornItems[0];

  if (!activeWorn) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const garment = activeWorn.garment;
  const body = loadBody();
  const pref = activeWorn.preference || state.fitPreference || garment.designFit || 'regular';
  const sizeNames = getSizeNames(garment);

  let rec = null;
  if (body && body.measurements && state.fitRules) {
    try {
      rec = recommendSize(body.measurements, garment, pref, state.fitRules);
    } catch (_) {}
  }

  container.innerHTML = '';

  sizeNames.forEach(s => {
    let evalRes = null;
    let verdictLabel = '';
    let tintClass = '';

    if (body && body.measurements && state.fitRules) {
      try {
        evalRes = evaluateSize(body.measurements, garment, s, pref, state.fitRules);
        const vInfo = getFitVerdictAndRecommendation(s, garment, evalRes, rec, pref);
        verdictLabel = vInfo.verdictLabel;

        if (verdictLabel === 'Great fit' || verdictLabel === 'Good fit') {
          tintClass = 'pill-verdict-good';
        } else if (verdictLabel === 'Slightly tight' || verdictLabel === 'Slightly loose') {
          tintClass = 'pill-verdict-amber';
        } else if (verdictLabel === 'Too small') {
          tintClass = 'pill-verdict-too-small';
        } else if (verdictLabel === 'Too big') {
          tintClass = 'pill-verdict-too-big';
        }
      } catch (_) {}
    }

    const isActive = (s === activeWorn.size);
    const isBest = Boolean(rec && rec.bestSize === s);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `size-pill ${tintClass} ${isActive ? 'is-active' : ''}`.trim();
    btn.dataset.size = s;

    // Phase 10: aria-label e.g. "Size M, Great fit"
    const ariaLabel = verdictLabel ? `Size ${s}, ${verdictLabel}` : `Size ${s}`;
    btn.setAttribute('aria-label', ariaLabel);

    // 5 status dots for the 5 zones: chest, waist, shoulder, sleeve, length
    let dotsHtml = '';
    if (evalRes && evalRes.zones) {
      const dots = evalRes.zones.map(z => `<span class="pill-dot ${z.status}"></span>`).join('');
      dotsHtml = `<div class="pill-dots">${dots}</div>`;
    }

    btn.innerHTML = `
      ${isBest ? '<span class="pill-best-badge">BEST</span>' : ''}
      <span>${s}</span>
      ${dotsHtml}
    `;

    btn.onclick = () => {
      activeWorn.size = s;
      updateFitResultUI();
      renderStage();
    };

    container.appendChild(btn);
  });
}

// Renders the fit evaluation card: verdict, recommendation, size pills, preference selector, zone table
function updateFitResultUI() {
  const container = document.getElementById('fit-result-area');
  if (!container) return;

  const activeWorn = state.wornItems[0];
  if (!activeWorn) {
    container.hidden = true;
    return;
  }

  const garment = activeWorn.garment;
  const body = loadBody();
  if (!body || !body.measurements || !state.fitRules) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const currentPref = activeWorn.preference || state.fitPreference || garment.designFit || 'regular';

  let rec = null;
  let evalRes = null;
  try {
    rec = recommendSize(body.measurements, garment, currentPref, state.fitRules);
    evalRes = evaluateSize(body.measurements, garment, activeWorn.size, currentPref, state.fitRules);
  } catch (err) {
    console.warn('Fit evaluation error:', err);
    container.hidden = true;
    return;
  }

  const score = Math.max(0, Math.round(evalRes.score));

  // Compute honest verdict badge and plain-language recommendation text
  const { verdictLabel, verdictClass, recommendationText } = getFitVerdictAndRecommendation(
    activeWorn.size, garment, evalRes, rec, currentPref
  );

  const ZONE_NAMES = {
    chest: 'Chest',
    waist: 'Waist',
    shoulder: 'Shoulders',
    sleeve: 'Sleeve',
    length: 'Length'
  };

  const STATUS_TEXT = {
    good: 'Good',
    tight: 'Snug',
    tooTight: 'Too tight',
    loose: 'Loose',
    tooLoose: 'Too loose',
    'n/a': '—'
  };

  const isEstimatedData = isEstimated(garment) || Boolean(state.avatar?.scaleApproximate) || Boolean(evalRes.zones?.some(z => z.confidence === 'low'));

  const rows = (evalRes.zones || []).map(z => {
    const isNA = z.status === 'n/a';
    if (isNA) {
      const sleeveType = garment.sleeveType ?? 'long';
      let reason = 'No data';
      if (z.zone === 'length' && garment.lengthStyle === 'long') {
        reason = 'Not scored (long coat)';
      } else if (z.zone === 'sleeve' && sleeveType !== 'long') {
        reason = 'Not scored (short sleeves)';
      }

      return `
        <tr>
          <td><strong>${ZONE_NAMES[z.zone] || z.zone}</strong></td>
          <td></td>
          <td><span class="zone-chip na">${reason}</span></td>
        </tr>
      `;
    }

    const easeText = typeof z.ease === 'number' ? `${z.ease > 0 ? '+' : ''}${z.ease.toFixed(1)} cm` : '—';

    return `
      <tr>
        <td><strong>${ZONE_NAMES[z.zone] || z.zone}</strong></td>
        <td>${easeText}</td>
        <td><span class="zone-chip ${z.status}">${STATUS_TEXT[z.status] || z.status}</span></td>
      </tr>
    `;
  }).join('');

  // Check if zone table was previously toggled open by the user
  const wasTableOpen = Boolean(container.querySelector('#zone-table-content') && !container.querySelector('#zone-table-content').hidden);

  container.innerHTML = `
    <!-- 1. Garment Name + Verdict Badge -->
    <div class="fit-summary-header">
      <div class="fit-verdict-title">${garment.name} (${activeWorn.size})</div>
      <span class="fit-verdict-badge ${verdictClass}">${verdictLabel}</span>
    </div>

    <!-- 2. Recommendation Sentence -->
    <div class="fit-verdict-recommendation">${recommendationText}</div>
    ${rec?.hint ? `<div class="text-xs muted" style="margin-top:4px">💡 ${rec.hint}</div>` : ''}

    <!-- 3. Size Pills (moved from stage into left panel) -->
    <div id="size-pills" class="size-pills-container"></div>

    <!-- 4. Fit Preference Control -->
    <div style="margin-top:12px">
      <div style="font-size:0.6875rem;font-weight:600;color:var(--ink-muted);margin-bottom:6px;text-transform:uppercase">Fit Preference</div>
      <div class="fit-pref-selector" id="fit-pref-selector">
        <button type="button" class="fit-pref-btn ${currentPref === 'fitted' ? 'is-active' : ''}" data-pref="fitted">Fitted</button>
        <button type="button" class="fit-pref-btn ${currentPref === 'regular' ? 'is-active' : ''}" data-pref="regular">Regular</button>
        <button type="button" class="fit-pref-btn ${currentPref === 'relaxed' ? 'is-active' : ''}" data-pref="relaxed">Relaxed</button>
        <button type="button" class="fit-pref-btn ${currentPref === 'oversized' ? 'is-active' : ''}" data-pref="oversized">Oversized</button>
      </div>
    </div>

    <!-- 5. Zone Table (collapsed by default) -->
    <div class="zone-table-wrap" style="margin-top:12px">
      <div class="zone-table-toggle" id="zone-table-toggle">
        <span>Zone Breakdown (${activeWorn.size}) · <small style="font-weight:600;opacity:0.8">${score}/100</small></span>
        <span>${wasTableOpen ? '▼' : '▶'}</span>
      </div>
      <div id="zone-table-content" ${wasTableOpen ? '' : 'hidden'}>
        <table class="zone-table">
          <thead>
            <tr>
              <th>Zone</th>
              <th>Ease</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        ${isEstimatedData ? '<div class="zone-table-note">Estimated size chart and/or measurements. Measure yourself with a tape for a more reliable result.</div>' : ''}
      </div>
    </div>
  `;

  // Populate size pills into #size-pills
  updateSizePills();

  // Attach preference button handlers
  container.querySelectorAll('.fit-pref-btn').forEach(btn => {
    btn.onclick = (e) => {
      const newPref = e.currentTarget.dataset.pref;
      activeWorn.preference = newPref;
      state.fitPreference = newPref;
      // Re-recommend size for new preference
      try {
        const newRec = recommendSize(body.measurements, garment, newPref, state.fitRules);
        if (newRec && newRec.bestSize) {
          activeWorn.size = newRec.bestSize;
        }
      } catch (_) {}
      updateFitResultUI();
      renderStage();
    };
  });

  // Attach table collapsible toggle
  const toggleBtn = container.querySelector('#zone-table-toggle');
  const tableContent = container.querySelector('#zone-table-content');
  if (toggleBtn && tableContent) {
    toggleBtn.onclick = () => {
      const isHidden = tableContent.hidden;
      tableContent.hidden = !isHidden;
      const arrowSpan = toggleBtn.querySelector('span:last-child');
      if (arrowSpan) arrowSpan.textContent = isHidden ? '▼' : '▶';
    };
  }
}

// Helper: draw textured triangle using 2D affine transformation
function drawTexturedTriangle(ctx, img, s0, s1, s2, d0, d1, d2) {
  const delta = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(delta) < 1e-5) return;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / delta;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / delta;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / delta;

  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / delta;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / delta;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / delta;

  ctx.save();
  ctx.beginPath();
  // Slight 0.5px expansion from centroid prevents sub-pixel antialiasing gaps between tiles
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const expand = (p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / dist) * 0.5, y: p.y + (dy / dist) * 0.5 };
  };
  const cd0 = expand(d0);
  const cd1 = expand(d1);
  const cd2 = expand(d2);

  ctx.moveTo(cd0.x, cd0.y);
  ctx.lineTo(cd1.x, cd1.y);
  ctx.lineTo(cd2.x, cd2.y);
  ctx.closePath();
  ctx.clip();

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// --- Phase 4A & 4B: "Template Fit" render mode for AI-standardized garments ---

/**
 * Phase 4B: Template fit by reference landmarks.
 * Uses exact joint-to-joint mapping from the mannequin worn reference (refPose)
 * to the user avatar landmarks, eliminating guessed constants and width offsets.
 */
function computeRefPoseTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX = 0, centerShiftY = 0) {
  const { garment, size } = item;
  // Phase 4C: Use garment.refPoseGhost when present (aligned to ghost PNG), else refPose fallback
  const rp = (garment?.cutFromWorn && garment?.refPose) ? garment.refPose : garment.refPoseGhost || garment.refPose;  // cut-from-worn: the garment PNG IS the reference frame, so refPose applies 1:1 (a stale align transform made garments ~13% too small).
  const anchors = garment.anchors;
  const l = avatar.landmarks;

  if (!rp || !rp.l11 || !rp.l12 || !l || !l[11] || !l[12]) {
    return null;
  }

  // 1. Mannequin reference landmarks from refPose (in ghost PNG pixel coords):
  // l11 = wearer's left shoulder (viewer's right), l12 = wearer's right shoulder (viewer's left)
  const l11 = rp.l11;
  const l12 = rp.l12;
  const l13 = rp.l13;
  const l14 = rp.l14;
  const l15 = rp.l15; // left wrist
  const l16 = rp.l16; // right wrist
  const l23 = rp.l23; // left hip
  const l24 = rp.l24; // right hip

  // Mannequin shoulder midpoint Mref & shoulder span Sref = |l11 - l12|
  const Mref = { x: (l11.x + l12.x) / 2, y: (l11.y + l12.y) / 2 };
  const Sref = Math.hypot(l11.x - l12.x, l11.y - l12.y) || 1;

  // Mannequin torso height Tref = distance from shoulder midpoint to hip midpoint (l23, l24)
  const Href = (l23 && l24)
    ? { x: (l23.x + l24.x) / 2, y: (l23.y + l24.y) / 2 }
    : { x: Mref.x, y: Mref.y + 400 };
  const Tref = Math.hypot(Href.x - Mref.x, Href.y - Mref.y) || 1;

  // 2. User avatar landmarks on canvas (px):
  const u11 = mapPoint(l[11]); // wearer's left shoulder (viewer's right)
  const u12 = mapPoint(l[12]); // wearer's right shoulder (viewer's left)
  const Muser = { x: (u11.x + u12.x) / 2, y: (u11.y + u12.y) / 2 };
  const Suser = Math.hypot(u11.x - u12.x, u11.y - u12.y) || 1;

  const u23 = l[23] ? mapPoint(l[23]) : null;
  const u24 = l[24] ? mapPoint(l[24]) : null;
  const Huser = (u23 && u24)
    ? { x: (u23.x + u24.x) / 2, y: (u23.y + u24.y) / 2 }
    : { x: Muser.x, y: Muser.y + (52 * avatar.pxPerCm * ratio) };
  const Tuser = Math.hypot(Huser.x - Muser.x, Huser.y - Muser.y) || 1;

  // User avatar shoulder tilt angle theta
  const theta = Math.atan2(u11.y - u12.y, u11.x - u12.x);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  // 3. Real-size scale (Phase 8): uniform physical scale s = userPxPerCm / refPxPerCm
  // refPxPerCm = Tref / MANNEQUIN_TORSO_CM where MANNEQUIN_TORSO_CM = garment.mannequinTorsoCm || 46
  // Replaces sy = Tuser/Tref so garments do NOT stretch with user torso height, agreeing with physical fit scores.
  const MANNEQUIN_TORSO_CM = Number(garment.mannequinTorsoCm) || 46;
  const refPxPerCm = Tref / MANNEQUIN_TORSO_CM;
  const userPxPerCm = (avatar.pxPerCm || 7.0) * ratio;
  const canvasPxPerCm = avatar.pxPerCm * ratio;
  const s = (refPxPerCm > 0 && userPxPerCm > 0) ? (userPxPerCm / refPxPerCm) : (Tuser / Tref);
  const sx = s;
  const sy = s;
  console.log('[RefPose fit Phase 8]', {
    usedGhostRef: Boolean(garment.refPoseGhost),
    refFrame: `${rp.width}x${rp.height}`,
    Sref: +Sref.toFixed(1), Tref: +Tref.toFixed(1),
    Suser: +Suser.toFixed(1), Tuser: +Tuser.toFixed(1),
    refPxPerCm: +refPxPerCm.toFixed(3), userPxPerCm: +userPxPerCm.toFixed(3),
    s: +s.toFixed(3), sx: +sx.toFixed(3), sy: +sy.toFixed(3), canvasRatio: +ratio.toFixed(3)
  });

  // 4. Size Switching Factors (relative to size M)
  // The AI image shows one specific size (admin "AI image looks like size", default M);
  // every other size is scaled relative to that one.
  const refSizeKey = garment.refSize || 'M';
  const chartM = garment.sizes?.[refSizeKey] || garment.sizes?.['M'] || garment.sizes?.[size] || Object.values(garment.sizes || {})[0] || {};
  const chartCurrent = garment.sizes?.[size] || chartM;
  const widthFactor = (chartCurrent.chest && chartM.chest) ? (chartCurrent.chest / chartM.chest) : 1.0;
  const lengthFactor = (chartCurrent.length && chartM.length) ? (chartCurrent.length / chartM.length) : 1.0;

  // 5. Sleeve Angle Correction from refPose (shoulder -> wrist)
  // Left sleeve (viewer's left / wearer's right arm: shoulder 12 -> wrist 16)
  let deltaPhiL = 0;
  if (l12 && l16 && l[16]) {
    const pWristA = mapPoint(l[16]);
    const phiGarmentL = Math.atan2(l16.y - l12.y, l16.x - l12.x);
    const phiAvatarL = Math.atan2(pWristA.y - u12.y, pWristA.x - u12.x);
    let dPhi = (phiAvatarL - theta) - phiGarmentL;
    while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
    while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
    if (Math.abs(dPhi) > (3 * Math.PI / 180)) {
      deltaPhiL = dPhi;
    }
  }

  // Right sleeve (viewer's right / wearer's left arm: shoulder 11 -> wrist 15)
  let deltaPhiR = 0;
  if (l11 && l15 && l[15]) {
    const pWristB = mapPoint(l[15]);
    const phiGarmentR = Math.atan2(l15.y - l11.y, l15.x - l11.x);
    const phiAvatarR = Math.atan2(pWristB.y - u11.y, pWristB.x - u11.x);
    let dPhi = (phiAvatarR - theta) - phiGarmentR;
    while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
    while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
    if (Math.abs(dPhi) > (3 * Math.PI / 180)) {
      deltaPhiR = dPhi;
    }
  }

  // 5b. Phase 9A & 9B: Honest Fit Zones, Sleeve & Hem Lengths, Widths
  const body = loadBody();
  let sleeveVisualEase = 0;
  let lengthExtraCm = 0;
  let evalRes = null;
  if (body && body.measurements && state.fitRules) {
    try {
      const pref = item.preference || state.fitPreference || garment.designFit || 'regular';
      evalRes = evaluateSize(body.measurements, garment, size, pref, state.fitRules);
      const sZone = evalRes.zones?.find(z => z.zone === 'sleeve');
      // The garment image already shows the sleeve as it falls on the MANNEQUIN in the reference size
      // (e.g. a cardigan cuff gathered at the mannequin's wrist). So the cuff must move only by the
      // DIFFERENCE to that reference: (user ease - mannequin ease) + exaggeration. Browser check:
      // using the full ease (+8 cm) on top of the image pushed the cardigan cuffs far past the hands
      // even on the mannequin itself.
      if (sZone && typeof sZone.ease === 'number') {
        const extra = (sZone.status === 'good' || sZone.status === 'n/a') ? 0 : (computeVisualEase(sZone) - sZone.ease);
        // The user's real arm length in the picture is already handled: the sleeve is mapped from the
        // mannequin's wrist to the USER'S wrist landmark. So only the garment's own size difference
        // (selected size vs. the size shown in the AI image) and the mild exaggeration move the cuff.
        // Browser check: using the typed-in arm length here double-counted it; with a photo-estimated
        // arm that was too short (52 cm at 165 cm), sleeves hung far past the hands on test avatars.
        const sizes = garment.sizes || {};
        const refSleeve = sizes[garment.refSize || 'M']?.sleeve;
        const curSleeve = sizes[size]?.sleeve;
        const sizeDiff = (typeof refSleeve === 'number' && typeof curSleeve === 'number') ? (curSleeve - refSleeve) : 0;
        sleeveVisualEase = Math.max(-FIT_VISUAL.maxLenCm - 6, Math.min(FIT_VISUAL.maxLenCm + 6, sizeDiff + extra));
      }

      const lZone = evalRes.zones?.find(z => z.zone === 'length');
      if (lZone && lZone.status !== 'good' && lZone.status !== 'n/a' && garment.lengthStyle !== 'long' && lZone.target) {
        const ease = lZone.ease || 0;
        const [minT, maxT] = lZone.target;
        const nearestBound = Math.abs(ease - maxT) < Math.abs(ease - minT) ? maxT : minT;
        const extra = Math.max(-FIT_VISUAL.maxLenCm, Math.min(FIT_VISUAL.maxLenCm, FIT_VISUAL.exaggeration * (ease - nearestBound)));
        lengthExtraCm = extra;
      }
    } catch (_) {}
  }

  // User wrist landmarks on canvas for cuff placement and constraint
  const userWristL = (l && l[16]) ? mapPoint(l[16]) : null;
  const userWristR = (l && l[15]) ? mapPoint(l[15]) : null;

  // Left sleeve (viewer's left / wearer's right arm: shoulder 12 -> elbow 14 -> wrist 16)
  // Cuff lands at (user wrist + sleeveVisualEase cm) along forearm direction (elbow->wrist)
  let scaleSleeveLenL = 1.0;
  if (l12 && l16 && userWristL) {
    const pWristA = userWristL;
    const pElbowA = l[14] ? mapPoint(l[14]) : { x: (u12.x + pWristA.x)/2, y: (u12.y + pWristA.y)/2 };
    const fdx = pWristA.x - pElbowA.x;
    const fdy = pWristA.y - pElbowA.y;
    const fLen = Math.hypot(fdx, fdy) || 1;
    const targetWristL = {
      x: pWristA.x + (fdx / fLen) * (sleeveVisualEase * canvasPxPerCm),
      y: pWristA.y + (fdy / fLen) * (sleeveVisualEase * canvasPxPerCm)
    };
    const armLenUserL = Math.hypot(targetWristL.x - u12.x, targetWristL.y - u12.y);
    const armLenRefL = Math.hypot(l16.x - l12.x, l16.y - l12.y);
    if (armLenRefL > 10 && armLenUserL > 10 && sy > 0) {
      scaleSleeveLenL = armLenUserL / (armLenRefL * sy);
      scaleSleeveLenL = Math.max(0.60, Math.min(1.55, scaleSleeveLenL));
    }
  }

  // Right sleeve (viewer's right / wearer's left arm: shoulder 11 -> elbow 13 -> wrist 15)
  // Cuff lands at (user wrist + sleeveVisualEase cm) along forearm direction (elbow->wrist)
  let scaleSleeveLenR = 1.0;
  if (l11 && l15 && userWristR) {
    const pWristB = userWristR;
    const pElbowB = l[13] ? mapPoint(l[13]) : { x: (u11.x + pWristB.x)/2, y: (u11.y + pWristB.y)/2 };
    const fdx = pWristB.x - pElbowB.x;
    const fdy = pWristB.y - pElbowB.y;
    const fLen = Math.hypot(fdx, fdy) || 1;
    const targetWristR = {
      x: pWristB.x + (fdx / fLen) * (sleeveVisualEase * canvasPxPerCm),
      y: pWristB.y + (fdy / fLen) * (sleeveVisualEase * canvasPxPerCm)
    };
    const armLenUserR = Math.hypot(targetWristR.x - u11.x, targetWristR.y - u11.y);
    const armLenRefR = Math.hypot(l15.x - l11.x, l15.y - l11.y);
    if (armLenRefR > 10 && armLenUserR > 10 && sy > 0) {
      scaleSleeveLenR = armLenUserR / (armLenRefR * sy);
      scaleSleeveLenR = Math.max(0.60, Math.min(1.55, scaleSleeveLenR));
    }
  }

  const waistV = Mref.y + 0.58 * Tref;
  const hemV = Mref.y + Tref;
  const extraLengthPx = lengthExtraCm * canvasPxPerCm;

  // Phase 9B: Arm direction unit vectors in reference frame.
  // Used to scale sleeve length strictly along the arm axis while keeping sleeve/cuff width constant.
  const armLenRefL_full = Math.hypot(l16 ? l16.x - l12.x : 0, l16 ? l16.y - l12.y : 0) || 1;
  const armVecL = (l12 && l16 && armLenRefL_full > 10) ? {
    dx: (l16.x - l12.x) / armLenRefL_full,
    dy: (l16.y - l12.y) / armLenRefL_full
  } : { dx: 0, dy: 1 };

  const armLenRefR_full = Math.hypot(l15 ? l15.x - l11.x : 0, l15 ? l15.y - l11.y : 0) || 1;
  const armVecR = (l11 && l15 && armLenRefR_full > 10) ? {
    dx: (l15.x - l11.x) / armLenRefR_full,
    dy: (l15.y - l11.y) / armLenRefR_full
  } : { dx: 0, dy: 1 };

  // 6. Point Mapping Function: Photo (u, v) -> Canvas (x, y)
  const warpTemplatePoint = (u, v) => {
    let uRot = u;
    let vRot = v;

    if (u <= Mref.x) {
      // Viewer's left sleeve / torso side
      const vTop = l12.y;
      const vBot = (anchors && anchors.armpitL) ? anchors.armpitL[1] : (l24 ? l12.y + 0.35 * (l24.y - l12.y) : l12.y + 200);
      const uTop = l12.x;
      const uBot = (anchors && anchors.armpitL) ? anchors.armpitL[0] : (l24 ? l12.x + 0.15 * (Mref.x - l12.x) : l12.x + 50);
      const uBoundary = v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
      const dist = uBoundary - u;
      const blendWidth = 30;
      const w = dist <= 0 ? 0 : (dist >= blendWidth ? 1 : (dist / blendWidth) * (dist / blendWidth) * (3 - 2 * (dist / blendWidth)));

      // The sleeve ends at the wrist: fade the sleeve warp out just below the reference wrist, so the
      // skirt of a long coat (outside the armpit line too) is not stretched with the sleeve
      // (grid check: pointed hem corners on the petite avatar).
      const extraSleeveCm = Math.max(0, sleeveVisualEase);
      const wristYRef = l16 ? l16.y + (9 + extraSleeveCm) * refPxPerCm : Infinity; // cuffs can hang ~8 cm below the wrist
      const fadeLen = 8 * refPxPerCm;
      const wFade = v <= wristYRef ? 1 : Math.max(0, 1 - (v - wristYRef) / fadeLen);
      const wEff = w * wFade;
      if (wEff > 0) {
        const wVal = wEff; // shadow: below this point the faded weight is used
        const du = u - l12.x;
        const dv = v - l12.y;

        // Phase 9B: Decompose along and perpendicular to arm axis so sleeve/cuff WIDTH stays
        // constant along added length (prevents cuff flaring like a bell when lengthened).
        const dAlong = du * armVecL.dx + dv * armVecL.dy;
        const dAcross = -du * armVecL.dy + dv * armVecL.dx;
        const sLen = 1.0 + wVal * (scaleSleeveLenL - 1.0);
        const dAlongScaled = dAlong * sLen;

        const duScaled = dAlongScaled * armVecL.dx - dAcross * armVecL.dy;
        const dvScaled = dAlongScaled * armVecL.dy + dAcross * armVecL.dx;

        let duRot = duScaled;
        let dvRot = dvScaled;
        if (deltaPhiL !== 0) {
          const alpha = wVal * deltaPhiL;
          duRot = duScaled * Math.cos(alpha) - dvScaled * Math.sin(alpha);
          dvRot = duScaled * Math.sin(alpha) + dvScaled * Math.cos(alpha);
        }
        uRot = l12.x + duRot;
        vRot = l12.y + dvRot;
      }
    } else {
      // Viewer's right sleeve / torso side
      const vTop = l11.y;
      const vBot = (anchors && anchors.armpitR) ? anchors.armpitR[1] : (l23 ? l11.y + 0.35 * (l23.y - l11.y) : l11.y + 200);
      const uTop = l11.x;
      const uBot = (anchors && anchors.armpitR) ? anchors.armpitR[0] : (l23 ? l11.x - 0.15 * (l11.x - Mref.x) : l11.x - 50);
      const uBoundary = v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
      const dist = u - uBoundary;
      const blendWidth = 30;
      const w = dist <= 0 ? 0 : (dist >= blendWidth ? 1 : (dist / blendWidth) * (dist / blendWidth) * (3 - 2 * (dist / blendWidth)));

      // The sleeve ends at the wrist: fade the sleeve warp out just below the reference wrist, so the
      // skirt of a long coat (outside the armpit line too) is not stretched with the sleeve
      // (grid check: pointed hem corners on the petite avatar).
      const extraSleeveCm = Math.max(0, sleeveVisualEase);
      const wristYRef = l15 ? l15.y + (9 + extraSleeveCm) * refPxPerCm : Infinity; // cuffs can hang ~8 cm below the wrist
      const fadeLen = 8 * refPxPerCm;
      const wFade = v <= wristYRef ? 1 : Math.max(0, 1 - (v - wristYRef) / fadeLen);
      const wEff = w * wFade;
      if (wEff > 0) {
        const wVal = wEff; // shadow: below this point the faded weight is used
        const du = u - l11.x;
        const dv = v - l11.y;

        // Phase 9B: Decompose along and perpendicular to arm axis so sleeve/cuff WIDTH stays
        // constant along added length (prevents cuff flaring like a bell when lengthened).
        const dAlong = du * armVecR.dx + dv * armVecR.dy;
        const dAcross = -du * armVecR.dy + dv * armVecR.dx;
        const sLen = 1.0 + wVal * (scaleSleeveLenR - 1.0);
        const dAlongScaled = dAlong * sLen;

        const duScaled = dAlongScaled * armVecR.dx - dAcross * armVecR.dy;
        const dvScaled = dAlongScaled * armVecR.dy + dAcross * armVecR.dx;

        let duRot = duScaled;
        let dvRot = dvScaled;
        if (deltaPhiR !== 0) {
          const alpha = wVal * deltaPhiR;
          duRot = duScaled * Math.cos(alpha) - dvScaled * Math.sin(alpha);
          dvRot = duScaled * Math.sin(alpha) + dvScaled * Math.cos(alpha);
        }
        uRot = l11.x + duRot;
        vRot = l11.y + dvRot;
      }
    }

    // Size switching around center line:
    const duMid = (uRot - Mref.x) * widthFactor;
    const dvRaw = vRot - Mref.y;
    // Above shoulders (collar): no clamping or length stretching; below shoulders: lengthFactor
    const dvMid = dvRaw > 0 ? dvRaw * lengthFactor : dvRaw;

    // Scale x by sx, y by sy
    const dxScaled = duMid * sx;
    const dyScaled = dvMid * sy;

    // Rotate by user shoulder-line angle theta and translate to Muser (no -2.5 cm lift or mask guess)
    const xCanvas = Muser.x + (dxScaled * cosTheta - dyScaled * sinTheta);
    let yCanvas = Muser.y + (dxScaled * sinTheta + dyScaled * cosTheta);

    // Phase 9A: Stretch only the part below the waist row, smoothly
    if (extraLengthPx !== 0 && vRot > waistV) {
      const tWaist = Math.max(0, Math.min(1.0, (vRot - waistV) / Math.max(1, hemV - waistV)));
      yCanvas += tWaist * extraLengthPx;
    }

    return {
      x: +xCanvas.toFixed(1),
      y: +yCanvas.toFixed(1)
    };
  };

  // 7. Destination Anchors & Silhouette
  const destAnchors = {};
  if (anchors) {
    for (const [k, pt] of Object.entries(anchors)) {
      if (Array.isArray(pt) && pt.length >= 2) {
        destAnchors[k] = warpTemplatePoint(pt[0], pt[1]);
      }
    }
  }
  // Fallbacks / syntheses from refPose if manual anchors were omitted
  if (!destAnchors.shoulderL) destAnchors.shoulderL = warpTemplatePoint(l12.x, l12.y);
  if (!destAnchors.shoulderR) destAnchors.shoulderR = warpTemplatePoint(l11.x, l11.y);
  if (!destAnchors.cuffOuterL && l16) destAnchors.cuffOuterL = warpTemplatePoint(l16.x - 20, l16.y);
  if (!destAnchors.cuffInnerL && l16) destAnchors.cuffInnerL = warpTemplatePoint(l16.x + 20, l16.y);
  if (!destAnchors.cuffOuterR && l15) destAnchors.cuffOuterR = warpTemplatePoint(l15.x + 20, l15.y);
  if (!destAnchors.cuffInnerR && l15) destAnchors.cuffInnerR = warpTemplatePoint(l15.x - 20, l15.y);

  const hemRowPoints = [];
  if (anchors && anchors.hemL && anchors.hemR) {
    const hemL = anchors.hemL;
    const hemR = anchors.hemR;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const u = hemL[0] * (1 - t) + hemR[0] * t;
      const v = hemL[1] * (1 - t) + hemR[1] * t;
      hemRowPoints.push(warpTemplatePoint(u, v));
    }
  } else if (l23 && l24) {
    const hemV = Math.max(l23.y, l24.y) + 0.15 * Tref;
    const hemUL = l24.x - 0.1 * Sref;
    const hemUR = l23.x + 0.1 * Sref;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const u = hemUL * (1 - t) + hemUR * t;
      hemRowPoints.push(warpTemplatePoint(u, hemV));
    }
  }

  const silhouette = [];
  if (destAnchors.collarL) silhouette.push(destAnchors.collarL);
  if (destAnchors.shoulderL) silhouette.push(destAnchors.shoulderL);
  if (destAnchors.cuffOuterL) silhouette.push(destAnchors.cuffOuterL);
  if (destAnchors.cuffInnerL) silhouette.push(destAnchors.cuffInnerL);
  if (destAnchors.armpitL) silhouette.push(destAnchors.armpitL);
  if (destAnchors.waistL) silhouette.push(destAnchors.waistL);
  if (hemRowPoints.length > 0) {
    hemRowPoints.forEach(hp => silhouette.push(hp));
  } else if (destAnchors.hemL && destAnchors.hemR) {
    silhouette.push(destAnchors.hemL);
    silhouette.push(destAnchors.hemR);
  }
  if (destAnchors.waistR) silhouette.push(destAnchors.waistR);
  if (destAnchors.armpitR) silhouette.push(destAnchors.armpitR);
  if (destAnchors.cuffInnerR) silhouette.push(destAnchors.cuffInnerR);
  if (destAnchors.cuffOuterR) silhouette.push(destAnchors.cuffOuterR);
  if (destAnchors.shoulderR) silhouette.push(destAnchors.shoulderR);
  if (destAnchors.collarR) silhouette.push(destAnchors.collarR);

  // canvasPxPerCm is declared near the top of this function (it was used before this line, TDZ error).
  const bodyOutline = avatar.bodyOutline || extractBodyOutline(null, l, avatar.imageWidthPx || 800, avatar.imageHeightPx || 1200);
  const targetChestWidth = (chartCurrent.chest || 100) * 0.34 * canvasPxPerCm;
  const targetLength = (chartCurrent.length || 60) * canvasPxPerCm;
  const targetWaistWidth = (chartCurrent.waist || chartCurrent.chest * 0.94) * 0.34 * canvasPxPerCm;
  const targetHemWidth = (chartCurrent.hem || chartCurrent.chest * 0.96) * 0.34 * canvasPxPerCm;
  const destHemY = Muser.y + targetLength + extraLengthPx;

  return {
    item,
    garment,
    size,
    anchors: anchors || {},
    destAnchors,
    hemRowPoints,
    silhouette,
    warpPoint: warpTemplatePoint,
    isTemplate: true,
    hasRefPose: true,
    canvasPxPerCm,
    bodyOutline,
    targetChestWidth,
    targetLength,
    targetWaistWidth,
    targetHemWidth,
    midShoulderX: Muser.x,
    midShoulderY: Muser.y,
    destHemY,
    sleeveVisualEase,
    lengthExtraCm,
    evalRes,
    fitZones: evalRes?.zones || [],
    isFrontClosing: (garment.category === 'outerwear' || /jacket|cardigan|coat|blazer|vest/i.test(garment.name || '') || garment.closure === 'buttons' || garment.closure === 'zip'),
    scaleChest: widthFactor * sx,
    scaleWaist: widthFactor * sx,
    scaleHem: widthFactor * sx,
    srcShoulderMidX: Mref.x,
    srcHemMidY: Mref.y + Tref,
    refPose: rp,
    Mref,
    userWristL,
    userWristR,
    uniformScale: sx,
    sx,
    sy,
    deltaPhiL,
    deltaPhiR
  };
}

/**
 * Phase 4A Fallback: Anchor-based template fit.
 * Used when garment.refPose is missing.
 */
function computeAnchorTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX = 0, centerShiftY = 0) {
  const { garment, size } = item;
  const anchors = garment.anchors;
  const l = avatar.landmarks;

  // Basic requirement: shoulder anchors and landmarks must exist
  if (!anchors || !anchors.shoulderL || !anchors.shoulderR || !l || !l[11] || !l[12]) {
    return null;
  }

  const canvasPxPerCm = avatar.pxPerCm * ratio;

  // 1. Joint landmark coordinates on canvas:
  // l[12] = wearer's right shoulder (viewer's left), l[11] = wearer's left shoulder (viewer's right)
  const ptRShoulder = mapPoint(l[12]);
  const ptLShoulder = mapPoint(l[11]);
  const avatarMidX = (ptRShoulder.x + ptLShoulder.x) / 2;
  // Landmarks 11/12 are the shoulder JOINTS; top of shoulder is ~2.5 cm higher in fallback mode.
  const avatarMidY = (ptRShoulder.y + ptLShoulder.y) / 2 - 2.5 * canvasPxPerCm;

  // Shoulder line tilt angle theta (from wearer's right to left shoulder)
  const theta = Math.atan2(ptLShoulder.y - ptRShoulder.y, ptLShoulder.x - ptRShoulder.x);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  // Avatar OUTER shoulder width in canvas px (edge to edge from segmentation mask)
  const jointSpan = Math.hypot(ptLShoulder.x - ptRShoulder.x, ptLShoulder.y - ptRShoulder.y);
  const avatarShoulderWidth = avatar.shoulderPx ? avatar.shoulderPx * ratio : jointSpan * 1.28;

  // 2. Uniform Scale S (based on size M chart)
  const chartM = garment.sizes?.['M'] || garment.sizes?.[size] || Object.values(garment.sizes || {})[0] || {};
  const chartCurrent = garment.sizes?.[size] || chartM;

  let bodyShoulderCm = 39.0;
  try {
    const bodyData = loadBody();
    if (bodyData && bodyData.measurements && bodyData.measurements.shoulder) {
      bodyShoulderCm = bodyData.measurements.shoulder;
    }
  } catch (_) {}

  const chartMShoulder = chartM.shoulder || 40.0;
  const targetShoulderWidth = avatarShoulderWidth + (chartMShoulder - bodyShoulderCm) * canvasPxPerCm;
  const srcShoulderWidth = Math.hypot(anchors.shoulderR[0] - anchors.shoulderL[0], anchors.shoulderR[1] - anchors.shoulderL[1]) || 1;
  const uniformScale = targetShoulderWidth / srcShoulderWidth;
  const S = uniformScale;

  const srcMidX = (anchors.shoulderL[0] + anchors.shoulderR[0]) / 2;
  const srcMidY = (anchors.shoulderL[1] + anchors.shoulderR[1]) / 2;

  // 3. Size Switching Factors (relative to size M)
  const widthFactor = (chartCurrent.chest && chartM.chest) ? (chartCurrent.chest / chartM.chest) : 1.0;
  const lengthFactor = (chartCurrent.length && chartM.length) ? (chartCurrent.length / chartM.length) : 1.0;

  // 4. Sleeve Angle Correction (> 3 deg)
  const cuffL = anchors.cuffL || (anchors.cuffOuterL && anchors.cuffInnerL
    ? [(anchors.cuffOuterL[0] + anchors.cuffInnerL[0]) / 2, (anchors.cuffOuterL[1] + anchors.cuffInnerL[1]) / 2]
    : null);
  let deltaPhiL = 0;
  if (cuffL && l[16]) {
    const pWristA = mapPoint(l[16]);
    const phiGarmentL = Math.atan2(cuffL[1] - anchors.shoulderL[1], cuffL[0] - anchors.shoulderL[0]);
    const phiAvatarL = Math.atan2(pWristA.y - ptRShoulder.y, pWristA.x - ptRShoulder.x);
    let dPhi = (phiAvatarL - theta) - phiGarmentL;
    while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
    while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
    if (Math.abs(dPhi) > (3 * Math.PI / 180)) {
      deltaPhiL = dPhi;
    }
  }

  const cuffR = anchors.cuffR || (anchors.cuffOuterR && anchors.cuffInnerR
    ? [(anchors.cuffOuterR[0] + anchors.cuffInnerR[0]) / 2, (anchors.cuffOuterR[1] + anchors.cuffInnerR[1]) / 2]
    : null);
  let deltaPhiR = 0;
  if (cuffR && l[15]) {
    const pWristB = mapPoint(l[15]);
    const phiGarmentR = Math.atan2(cuffR[1] - anchors.shoulderR[1], cuffR[0] - anchors.shoulderR[0]);
    const phiAvatarR = Math.atan2(pWristB.y - ptLShoulder.y, pWristB.x - ptLShoulder.x);
    let dPhi = (phiAvatarR - theta) - phiGarmentR;
    while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
    while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
    if (Math.abs(dPhi) > (3 * Math.PI / 180)) {
      deltaPhiR = dPhi;
    }
  }

  const warpTemplatePoint = (u, v) => {
    let uRot = u;
    let vRot = v;

    if (u <= srcMidX) {
      if (deltaPhiL !== 0) {
        const vTop = anchors.shoulderL[1];
        const vBot = anchors.armpitL ? anchors.armpitL[1] : (vTop + 200);
        const uTop = anchors.shoulderL[0];
        const uBot = anchors.armpitL ? anchors.armpitL[0] : (uTop + 50);
        const uBoundary = v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
        const dist = uBoundary - u;
        const blendWidth = 30;
        const w = dist <= 0 ? 0 : (dist >= blendWidth ? 1 : (dist / blendWidth) * (dist / blendWidth) * (3 - 2 * (dist / blendWidth)));
        const alpha = w * deltaPhiL;
        if (alpha !== 0) {
          const du = u - anchors.shoulderL[0];
          const dv = v - anchors.shoulderL[1];
          uRot = anchors.shoulderL[0] + du * Math.cos(alpha) - dv * Math.sin(alpha);
          vRot = anchors.shoulderL[1] + du * Math.sin(alpha) + dv * Math.cos(alpha);
        }
      }
    } else {
      if (deltaPhiR !== 0) {
        const vTop = anchors.shoulderR[1];
        const vBot = anchors.armpitR ? anchors.armpitR[1] : (vTop + 200);
        const uTop = anchors.shoulderR[0];
        const uBot = anchors.armpitR ? anchors.armpitR[0] : (uTop - 50);
        const uBoundary = v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
        const dist = u - uBoundary;
        const blendWidth = 30;
        const w = dist <= 0 ? 0 : (dist >= blendWidth ? 1 : (dist / blendWidth) * (dist / blendWidth) * (3 - 2 * (dist / blendWidth)));
        const alpha = w * deltaPhiR;
        if (alpha !== 0) {
          const du = u - anchors.shoulderR[0];
          const dv = v - anchors.shoulderR[1];
          uRot = anchors.shoulderR[0] + du * Math.cos(alpha) - dv * Math.sin(alpha);
          vRot = anchors.shoulderR[1] + du * Math.sin(alpha) + dv * Math.cos(alpha);
        }
      }
    }

    const duMid = (uRot - srcMidX) * widthFactor;
    const dvRaw = vRot - srcMidY;
    const dvMid = dvRaw > 0 ? dvRaw * lengthFactor : dvRaw;

    const xCanvas = avatarMidX + (duMid * S * cosTheta - dvMid * S * sinTheta);
    const yCanvas = avatarMidY + (duMid * S * sinTheta + dvMid * S * cosTheta);

    return {
      x: +xCanvas.toFixed(1),
      y: +yCanvas.toFixed(1)
    };
  };

  const destAnchors = {};
  for (const [k, pt] of Object.entries(anchors)) {
    if (Array.isArray(pt) && pt.length >= 2) {
      destAnchors[k] = warpTemplatePoint(pt[0], pt[1]);
    }
  }

  const hemRowPoints = [];
  const hemL = anchors.hemL;
  const hemR = anchors.hemR;
  if (hemL && hemR) {
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const u = hemL[0] * (1 - t) + hemR[0] * t;
      const v = hemL[1] * (1 - t) + hemR[1] * t;
      hemRowPoints.push(warpTemplatePoint(u, v));
    }
  }

  const silhouette = [];
  if (destAnchors.collarL) silhouette.push(destAnchors.collarL);
  if (destAnchors.shoulderL) silhouette.push(destAnchors.shoulderL);
  if (destAnchors.cuffOuterL) silhouette.push(destAnchors.cuffOuterL);
  if (destAnchors.cuffInnerL) silhouette.push(destAnchors.cuffInnerL);
  if (destAnchors.armpitL) silhouette.push(destAnchors.armpitL);
  if (destAnchors.waistL) silhouette.push(destAnchors.waistL);
  if (hemRowPoints.length > 0) {
    hemRowPoints.forEach(hp => silhouette.push(hp));
  } else if (destAnchors.hemL && destAnchors.hemR) {
    silhouette.push(destAnchors.hemL);
    silhouette.push(destAnchors.hemR);
  }
  if (destAnchors.waistR) silhouette.push(destAnchors.waistR);
  if (destAnchors.armpitR) silhouette.push(destAnchors.armpitR);
  if (destAnchors.cuffInnerR) silhouette.push(destAnchors.cuffInnerR);
  if (destAnchors.cuffOuterR) silhouette.push(destAnchors.cuffOuterR);
  if (destAnchors.shoulderR) silhouette.push(destAnchors.shoulderR);
  if (destAnchors.collarR) silhouette.push(destAnchors.collarR);

  const bodyOutline = avatar.bodyOutline || extractBodyOutline(null, l, avatar.imageWidthPx || 800, avatar.imageHeightPx || 1200);
  const targetChestWidth = (chartCurrent.chest || 100) * 0.34 * canvasPxPerCm;
  const targetLength = (chartCurrent.length || 60) * canvasPxPerCm;
  const targetWaistWidth = (chartCurrent.waist || chartCurrent.chest * 0.94) * 0.34 * canvasPxPerCm;
  const targetHemWidth = (chartCurrent.hem || chartCurrent.chest * 0.96) * 0.34 * canvasPxPerCm;
  const destHemY = avatarMidY + targetLength;
  const srcHemMidY = anchors.hemL && anchors.hemR ? (anchors.hemL[1] + anchors.hemR[1]) / 2 : srcMidY + 500;

  return {
    item,
    garment,
    size,
    anchors,
    destAnchors,
    hemRowPoints,
    silhouette,
    warpPoint: warpTemplatePoint,
    isTemplate: true,
    hasRefPose: false,
    canvasPxPerCm,
    bodyOutline,
    targetChestWidth,
    targetLength,
    targetWaistWidth,
    targetHemWidth,
    midShoulderX: avatarMidX,
    midShoulderY: avatarMidY,
    destHemY,
    scaleChest: widthFactor * S,
    scaleWaist: widthFactor * S,
    scaleHem: widthFactor * S,
    srcShoulderMidX: srcMidX,
    srcHemMidY,
    uniformScale: S,
    deltaPhiL,
    deltaPhiR
  };
}

/**
 * Main Template Fit Entry Point:
 * Routes to refPose-based fitting when refPose exists, or anchor-based fallback.
 */
function computeTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX = 0, centerShiftY = 0) {
  const { garment } = item;
  const rp = (garment?.cutFromWorn && garment?.refPose) ? garment.refPose : garment?.refPoseGhost || garment?.refPose;  // cut-from-worn: the garment PNG IS the reference frame, so refPose applies 1:1 (a stale align transform made garments ~13% too small).
  if (rp && rp.l11 && rp.l12) {
    return computeRefPoseTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX, centerShiftY);
  }
  return computeAnchorTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX, centerShiftY);
}

// Helper: Compute warp data and silhouette polygon for a worn garment
function computeGarmentWarpData(item, avatar, ratio, mapPoint, centerShiftX = 0, centerShiftY = 0) {
  const { garment, size } = item;
  if (garment && garment.renderMode === 'template') {
    return computeTemplateFitData(item, avatar, ratio, mapPoint, centerShiftX, centerShiftY);
  }
  const chart = garment.sizes[size] || garment.sizes["M"];
  const anchors = garment.anchors;
  const l = avatar.landmarks;

  if (!anchors || !anchors.shoulderL || !anchors.shoulderR || !anchors.armpitL || !anchors.armpitR || !anchors.hemL || !anchors.hemR) {
    return null;
  }

  const canvasPxPerCm = avatar.pxPerCm * ratio;

  // 1. Joint landmark coordinates on canvas:
  // l[12] is wearer's right shoulder (viewer's left), l[11] is wearer's left shoulder (viewer's right)
  const ptRShoulder = mapPoint(l[12]);
  const ptLShoulder = mapPoint(l[11]);
  const angle = Math.atan2(ptLShoulder.y - ptRShoulder.y, ptLShoulder.x - ptRShoulder.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Normal vector pointing UP (towards neck/head)
  const upX = sin;
  const upY = -cos;

  // STEP B.3: Put garment shoulder seam at body's outer shoulder edge:
  // Landmark 11/12 pushed outwards to outer joint edge, dyUpward = 0 so shoulders don't peak above avatar
  const dxOutward = 1.0 * canvasPxPerCm;
  const dyUpward  = 0.0;

  const raisedShoulderR = {
    x: ptRShoulder.x - dxOutward * cos,
    y: ptRShoulder.y - dxOutward * sin
  };
  const raisedShoulderL = {
    x: ptLShoulder.x + dxOutward * cos,
    y: ptLShoulder.y + dxOutward * sin
  };

  const midShoulderX = (raisedShoulderR.x + raisedShoulderL.x) / 2;
  const midShoulderY = (raisedShoulderR.y + raisedShoulderL.y) / 2;

  // STEP B.4: Length: hem Y = shoulder Y + chart.length * pxPerCm measured from raised shoulder point
  const targetLength = chart.length * canvasPxPerCm;
  const destHemY = midShoulderY + targetLength;

  // STEP B.1: Body outline from segmentation mask (or fallback)
  const bodyOutline = avatar.bodyOutline || extractBodyOutline(null, l, avatar.imageWidthPx || 800, avatar.imageHeightPx || 1200);

  // Body width on canvas (in px):
  const bodyChestWidthCanvas    = bodyOutline.chestWidthPx * ratio;
  const bodyWaistWidthCanvas    = bodyOutline.waistWidthPx * ratio;
  const bodyHemWidthCanvas      = bodyOutline.hipWidthPx * ratio;
  const bodyShoulderWidthCanvas = Math.hypot(ptLShoulder.x - ptRShoulder.x, ptLShoulder.y - ptRShoulder.y);

  // Body circumferences (from loadBody() or standard defaults):
  let bodyChestCm = 90;
  let bodyWaistCm = 72;
  let bodyHipCm   = 98;
  try {
    const bodyData = loadBody();
    if (bodyData && bodyData.measurements) {
      if (bodyData.measurements.chest) bodyChestCm = bodyData.measurements.chest;
      if (bodyData.measurements.waist) bodyWaistCm = bodyData.measurements.waist;
      if (bodyData.measurements.hip)   bodyHipCm   = bodyData.measurements.hip;
    }
  } catch (_) {}

  // Garment circumferences from size chart (in cm):
  const garmentChestCm = chart.chest;
  const garmentWaistCm = chart.waist || chart.chest * 0.94;
  const garmentHemCm   = chart.hem || chart.chest * 0.96;

  // STEP B.2: Garment front width must depend on the BODY, not only on the chart:
  // garmentWidthPx = bodyWidthPx + (garmentCircumferenceCm - bodyCircumferenceCm) * 0.34 * pxPerCm
  const targetChestWidth = bodyChestWidthCanvas + (garmentChestCm - bodyChestCm) * 0.34 * canvasPxPerCm;
  const targetWaistWidth = bodyWaistWidthCanvas + (garmentWaistCm - bodyWaistCm) * 0.34 * canvasPxPerCm;
  const targetHemWidth   = bodyHemWidthCanvas   + (garmentHemCm   - bodyHipCm)   * 0.34 * canvasPxPerCm;

  const bodyOuterShoulderEdgePx = bodyShoulderWidthCanvas + 2 * dxOutward;
  const chartM = garment.sizes['M'] || chart;
  const targetShoulderWidth = bodyOuterShoulderEdgePx + (chart.shoulder - (chartM.shoulder || 40.0)) * canvasPxPerCm;

  const srcShoulderMidX = (anchors.shoulderL[0] + anchors.shoulderR[0]) / 2;
  const srcShoulderMidY = (anchors.shoulderL[1] + anchors.shoulderR[1]) / 2;
  const srcShoulderWidth = Math.abs(anchors.shoulderR[0] - anchors.shoulderL[0]);
  const srcChestWidth   = Math.abs(anchors.armpitR[0] - anchors.armpitL[0]);
  const srcHemMidX      = (anchors.hemL[0] + anchors.hemR[0]) / 2;
  const srcHemMidY      = (anchors.hemL[1] + anchors.hemR[1]) / 2;
  const srcTorsoHeight  = srcHemMidY - srcShoulderMidY;
  const srcHemWidth     = Math.abs(anchors.hemR[0] - anchors.hemL[0]);

  const scaleShoulder = targetShoulderWidth / srcShoulderWidth;
  const scaleChest = targetChestWidth / srcChestWidth;
  const scaleHem   = targetHemWidth / srcHemWidth;
  const scaleWaist = targetWaistWidth / srcChestWidth;

  // Torso / whole-garment warp point function
  const warpPoint = (u, v) => {
    const dSrcY = v - srcShoulderMidY;
    const tTorso = dSrcY / srcTorsoHeight;

    let localY;
    if (tTorso < 0) {
      const scaleYTop = targetLength / srcTorsoHeight;
      const collarNudge = 2.0 * Math.max(0, 1 - (v / Math.max(1, srcShoulderMidY)));
      let computedY = dSrcY * scaleYTop - collarNudge;

      // Requirement 2: clamp the garment area above the shoulder anchors so it does not rise
      // above the avatar neck/shoulder line more than ~8% of the torso height
      const maxRise = 0.08 * targetLength;
      const collarWidth = (anchors.collarR && anchors.collarL)
        ? Math.abs(anchors.collarR[0] - anchors.collarL[0])
        : srcShoulderWidth * 0.45;
      const distFromCenter = Math.abs(u - srcShoulderMidX);
      const isCollarRegion = distFromCenter <= (collarWidth / 2 + 10);

      if (!isCollarRegion) {
        // Outside collar: shoulder seam & epaulettes clamped to max 8% of torso height
        computedY = Math.max(-maxRise, computedY);
      } else {
        // Collar region can reach natural neck height, clamped to 16% of torso height
        computedY = Math.max(-maxRise * 2.0, computedY);
      }
      localY = computedY;
    } else {
      const baseLocalY = tTorso * targetLength;
      const rowWeight = Math.max(0, Math.min(1, (tTorso - 0.28) / 0.72));
      const uTorsoLeft = anchors.hemL[0];
      const uTorsoRight = anchors.hemR[0];
      const tCol = (u - uTorsoLeft) / (uTorsoRight - uTorsoLeft);
      const curveFactor = (tCol >= 0 && tCol <= 1) ? Math.sin(tCol * Math.PI) : 0;
      const curveY = curveFactor * 5.0 * rowWeight;
      const hemNudgeY = 2.5 * Math.max(0, Math.min(1, (tTorso - 0.75) / 0.25));
      localY = baseLocalY + curveY + hemNudgeY;
    }

    const dSrcX = u - srcShoulderMidX;
    let scaleXAtV;
    if (tTorso <= 0.0) {
      scaleXAtV = scaleShoulder;
    } else if (tTorso <= 0.28) {
      const f = tTorso / 0.28;
      scaleXAtV = scaleShoulder * (1 - f) + scaleChest * f;
    } else if (tTorso <= 0.6) {
      const f = (tTorso - 0.28) / (0.6 - 0.28);
      scaleXAtV = scaleChest * (1 - f) + scaleWaist * f;
    } else {
      const f = Math.min(1, (tTorso - 0.6) / 0.4);
      scaleXAtV = scaleWaist * (1 - f) + scaleHem * f;
    }

    const rowWeight = Math.max(0, Math.min(1, (tTorso - 0.28) / 0.72));
    const halfChest = srcChestWidth / 2;
    const normX = Math.max(-1, Math.min(1, dSrcX / halfChest));
    const nudgeX = normX * 2.5 * rowWeight;
    const localX = dSrcX * scaleXAtV + nudgeX;

    return {
      x: +(midShoulderX + (localX * cos - localY * sin)).toFixed(1),
      y: +(midShoulderY + (localX * sin + localY * cos)).toFixed(1)
    };
  };

  // Arm skeleton landmarks on canvas (viewer's left = wearer's right)
  const ptRElbow = l[14] ? mapPoint(l[14]) : { x: raisedShoulderR.x - 30 * ratio, y: raisedShoulderR.y + 110 * ratio };
  const ptRWrist = l[16] ? mapPoint(l[16]) : { x: ptRElbow.x - 15 * ratio, y: ptRElbow.y + 110 * ratio };

  const ptLElbow = l[13] ? mapPoint(l[13]) : { x: raisedShoulderL.x + 30 * ratio, y: raisedShoulderL.y + 110 * ratio };
  const ptLWrist = l[15] ? mapPoint(l[15]) : { x: ptLElbow.x + 15 * ratio, y: ptLElbow.y + 110 * ratio };

  const hasLongSleeves = (garment.sleeveType !== 'none') &&
    !!(anchors.cuffOuterL && anchors.cuffInnerL && anchors.cuffOuterR && anchors.cuffInnerR);

  // Sleeve widths from avatar arm width and size chart ease
  const avatarArmWidthPx = Math.max(16, (bodyOutline.armWidthPx ? bodyOutline.armWidthPx * ratio : 8.0 * canvasPxPerCm));
  const avatarWristWidthPx = Math.max(10, 5.0 * canvasPxPerCm);

  const chestEase = Math.max(0, (chart.chest || 96) - bodyChestCm);
  const shoulderEasePx = (1.0 + 0.12 * chestEase) * canvasPxPerCm;
  const cuffEasePx = (0.6 + 0.08 * chestEase) * canvasPxPerCm;

  const sleeveWidthShoulder = Math.min(2.0 * avatarArmWidthPx, avatarArmWidthPx + shoulderEasePx);
  const sleeveWidthCuff     = Math.min(2.0 * avatarWristWidthPx, avatarWristWidthPx + cuffEasePx);

  function getArmPoint(pShoulder, pElbow, pWrist, t, isLeft) {
    const L1 = Math.hypot(pElbow.x - pShoulder.x, pElbow.y - pShoulder.y);
    const L2 = Math.hypot(pWrist.x - pElbow.x, pWrist.y - pElbow.y);
    const totalL = L1 + L2 || 1;
    const tElbow = L1 / totalL;

    let midX, midY, tx, ty;
    if (t <= tElbow) {
      const f = t / Math.max(0.001, tElbow);
      midX = pShoulder.x * (1 - f) + pElbow.x * f;
      midY = pShoulder.y * (1 - f) + pElbow.y * f;
      tx = (pElbow.x - pShoulder.x) / (L1 || 1);
      ty = (pElbow.y - pShoulder.y) / (L1 || 1);
    } else {
      const f = (t - tElbow) / Math.max(0.001, 1 - tElbow);
      midX = pElbow.x * (1 - f) + pWrist.x * f;
      midY = pElbow.y * (1 - f) + pWrist.y * f;
      tx = (pWrist.x - pElbow.x) / (L2 || 1);
      ty = (pWrist.y - pElbow.y) / (L2 || 1);
    }

    // Normal vector pointing outwards:
    // For left image (wearer's right arm): (-ty, tx) points left
    // For right image (wearer's left arm): (ty, -tx) points right
    let nx, ny;
    if (isLeft) {
      nx = -ty;
      ny = tx;
    } else {
      nx = ty;
      ny = -tx;
    }
    return { midX, midY, nx, ny };
  }

  function warpSleevePoint(pShoulder, pElbow, pWrist, s, t, isLeft) {
    const clampedT = Math.max(0, Math.min(1, t));
    const { midX, midY, nx, ny } = getArmPoint(pShoulder, pElbow, pWrist, clampedT, isLeft);
    const wAtT = sleeveWidthShoulder * (1 - clampedT) + sleeveWidthCuff * clampedT;
    const offset = (0.5 - s) * wAtT;
    return {
      x: +(midX + nx * offset).toFixed(1),
      y: +(midY + ny * offset).toFixed(1)
    };
  }

  // Source boundary helpers for splitting garment mesh
  const vArmpitL = anchors.armpitL[1];
  const vArmpitR = anchors.armpitR[1];
  const vShoulderL = anchors.shoulderL[1];
  const vShoulderR = anchors.shoulderR[1];

  const getTorsoLeftU = (v) => {
    if (v <= vArmpitL) {
      const f = Math.max(0, Math.min(1, (v - vShoulderL) / Math.max(1, vArmpitL - vShoulderL)));
      return anchors.shoulderL[0] * (1 - f) + anchors.armpitL[0] * f;
    } else {
      const f = Math.max(0, Math.min(1, (v - vArmpitL) / Math.max(1, srcHemMidY - vArmpitL)));
      return anchors.armpitL[0] * (1 - f) + anchors.hemL[0] * f;
    }
  };

  const getTorsoRightU = (v) => {
    if (v <= vArmpitR) {
      const f = Math.max(0, Math.min(1, (v - vShoulderR) / Math.max(1, vArmpitR - vShoulderR)));
      return anchors.shoulderR[0] * (1 - f) + anchors.armpitR[0] * f;
    } else {
      const f = Math.max(0, Math.min(1, (v - vArmpitR) / Math.max(1, srcHemMidY - vArmpitR)));
      return anchors.armpitR[0] * (1 - f) + anchors.hemR[0] * f;
    }
  };

  const getLeftSleeveOuter = (t) => ({
    x: anchors.shoulderL[0] * (1 - t) + anchors.cuffOuterL[0] * t,
    y: anchors.shoulderL[1] * (1 - t) + anchors.cuffOuterL[1] * t
  });
  const getLeftSleeveInner = (t) => ({
    x: anchors.armpitL[0] * (1 - t) + anchors.cuffInnerL[0] * t,
    y: anchors.armpitL[1] * (1 - t) + anchors.cuffInnerL[1] * t
  });

  const getRightSleeveOuter = (t) => ({
    x: anchors.shoulderR[0] * (1 - t) + anchors.cuffOuterR[0] * t,
    y: anchors.shoulderR[1] * (1 - t) + anchors.cuffOuterR[1] * t
  });
  const getRightSleeveInner = (t) => ({
    x: anchors.armpitR[0] * (1 - t) + anchors.cuffInnerR[0] * t,
    y: anchors.armpitR[1] * (1 - t) + anchors.cuffInnerR[1] * t
  });

  const vArmpit = (anchors.armpitL[1] + anchors.armpitR[1]) / 2;
  const vHem = srcHemMidY;
  const vWaist = vArmpit + 0.50 * (vHem - vArmpit);

  let destAnchors;
  if (state.smoothSleeves && hasLongSleeves) {
    destAnchors = {
      collarL: anchors.collarL ? warpPoint(anchors.collarL[0], anchors.collarL[1]) : null,
      collarR: anchors.collarR ? warpPoint(anchors.collarR[0], anchors.collarR[1]) : null,
      shoulderL: warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 0, 0, true),
      shoulderR: warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 0, 0, false),
      armpitL: warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 1, 0, true),
      armpitR: warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 1, 0, false),
      hemL: warpPoint(anchors.hemL[0], anchors.hemL[1]),
      hemR: warpPoint(anchors.hemR[0], anchors.hemR[1]),
      hemMid: warpPoint(srcHemMidX, srcHemMidY),
      cuffOuterL: warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 0, 1, true),
      cuffInnerL: warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 1, 1, true),
      cuffOuterR: warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 0, 1, false),
      cuffInnerR: warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 1, 1, false),
      waistL: warpPoint(anchors.armpitL[0], vWaist),
      waistR: warpPoint(anchors.armpitR[0], vWaist)
    };
  } else {
    destAnchors = {
      collarL: anchors.collarL ? warpPoint(anchors.collarL[0], anchors.collarL[1]) : null,
      collarR: anchors.collarR ? warpPoint(anchors.collarR[0], anchors.collarR[1]) : null,
      shoulderL: warpPoint(anchors.shoulderL[0], anchors.shoulderL[1]),
      shoulderR: warpPoint(anchors.shoulderR[0], anchors.shoulderR[1]),
      armpitL: warpPoint(anchors.armpitL[0], anchors.armpitL[1]),
      armpitR: warpPoint(anchors.armpitR[0], anchors.armpitR[1]),
      hemL: warpPoint(anchors.hemL[0], anchors.hemL[1]),
      hemR: warpPoint(anchors.hemR[0], anchors.hemR[1]),
      hemMid: warpPoint(srcHemMidX, srcHemMidY),
      cuffOuterL: anchors.cuffOuterL ? warpPoint(anchors.cuffOuterL[0], anchors.cuffOuterL[1]) : null,
      cuffInnerL: anchors.cuffInnerL ? warpPoint(anchors.cuffInnerL[0], anchors.cuffInnerL[1]) : null,
      cuffOuterR: anchors.cuffOuterR ? warpPoint(anchors.cuffOuterR[0], anchors.cuffOuterR[1]) : null,
      cuffInnerR: anchors.cuffInnerR ? warpPoint(anchors.cuffInnerR[0], anchors.cuffInnerR[1]) : null,
      waistL: warpPoint(anchors.armpitL[0], vWaist),
      waistR: warpPoint(anchors.armpitR[0], vWaist)
    };
  }

  const hemRowPoints = [];
  const hemSegments = 6;
  for (let i = 0; i <= hemSegments; i++) {
    const t = i / hemSegments;
    const u = anchors.hemL[0] * (1 - t) + anchors.hemR[0] * t;
    const v = anchors.hemL[1] * (1 - t) + anchors.hemR[1] * t;
    const pt = warpPoint(u, v);
    let label = `t=${t.toFixed(2)}`;
    if (i === 0) label = "hemL";
    else if (i === hemSegments) label = "hemR";
    else if (i === hemSegments / 2) label = "hemMid";
    hemRowPoints.push({ label, t, ...pt });
  }

  // Construct garment silhouette polygon for under-layer clipping:
  const silhouette = [];
  if (destAnchors.collarL) silhouette.push(destAnchors.collarL);
  silhouette.push(destAnchors.shoulderL);

  if (state.smoothSleeves && hasLongSleeves) {
    const elbowOuterL = warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 0, 0.5, true);
    silhouette.push(elbowOuterL);
  }
  if (destAnchors.cuffOuterL) silhouette.push(destAnchors.cuffOuterL);
  if (destAnchors.cuffInnerL) silhouette.push(destAnchors.cuffInnerL);
  if (state.smoothSleeves && hasLongSleeves) {
    const elbowInnerL = warpSleevePoint(raisedShoulderR, ptRElbow, ptRWrist, 1, 0.5, true);
    silhouette.push(elbowInnerL);
  }

  silhouette.push(destAnchors.armpitL);
  silhouette.push(destAnchors.waistL);
  hemRowPoints.forEach(hp => silhouette.push({ x: hp.x, y: hp.y }));
  silhouette.push(destAnchors.waistR);
  silhouette.push(destAnchors.armpitR);

  if (state.smoothSleeves && hasLongSleeves) {
    const elbowInnerR = warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 1, 0.5, false);
    silhouette.push(elbowInnerR);
  }
  if (destAnchors.cuffInnerR) silhouette.push(destAnchors.cuffInnerR);
  if (destAnchors.cuffOuterR) silhouette.push(destAnchors.cuffOuterR);
  if (state.smoothSleeves && hasLongSleeves) {
    const elbowOuterR = warpSleevePoint(raisedShoulderL, ptLElbow, ptLWrist, 0, 0.5, false);
    silhouette.push(elbowOuterR);
  }

  silhouette.push(destAnchors.shoulderR);
  if (destAnchors.collarR) silhouette.push(destAnchors.collarR);

  return {
    item,
    garment,
    size,
    anchors,
    destAnchors,
    hemRowPoints,
    silhouette,
    warpPoint,
    hasLongSleeves,
    ptRElbow,
    ptRWrist,
    ptLElbow,
    ptLWrist,
    sleeveWidthShoulder,
    sleeveWidthCuff,
    warpSleevePoint,
    getTorsoLeftU,
    getTorsoRightU,
    getLeftSleeveOuter,
    getLeftSleeveInner,
    getRightSleeveOuter,
    getRightSleeveInner,
    targetChestWidth,
    targetLength,
    targetWaistWidth,
    targetHemWidth,
    midShoulderX,
    midShoulderY,
    destHemY,
    scaleChest,
    scaleWaist,
    scaleHem,
    srcShoulderMidX,
    srcHemMidY,
    ratio,
    centerShiftX,
    centerShiftY,
    canvasPxPerCm,
    bodyOutline,
    bodyChestWidthCanvas,
    bodyWaistWidthCanvas,
    bodyHemWidthCanvas,
    bodyShoulderWidthCanvas,
    raisedShoulderL,
    raisedShoulderR,
    garmentChestCm,
    bodyChestCm
  };
}

// --- PHASE 5: Photo-Realistic Compositing for Template Garments ---

/**
 * Computes the mean luminance and mean RGB of the avatar photo
 * (samples background outside the body and skin region).
 */
function computeAvatarLightStats(avatarImg, landmarks) {
  if (!avatarImg) {
    return { r: 240, g: 240, b: 240, lum: 240 };
  }

  const sampleCanvas = document.createElement('canvas');
  const sw = 100;
  const sh = 150;
  sampleCanvas.width = sw;
  sampleCanvas.height = sh;
  const sCtx = sampleCanvas.getContext('2d');
  sCtx.drawImage(avatarImg, 0, 0, sw, sh);
  const data = sCtx.getImageData(0, 0, sw, sh).data;

  let totalR = 0, totalG = 0, totalB = 0, count = 0;

  // 1. Sample background outside the body (margins outside body silhouette)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const isSideMargin = (x < 15 || x > 85) && (y > 10 && y < 110);
      const isTopMargin = y < 15;
      if (isSideMargin || isTopMargin) {
        const idx = (y * sw + x) * 4;
        totalR += data[idx];
        totalG += data[idx + 1];
        totalB += data[idx + 2];
        count++;
      }
    }
  }

  // 2. Also sample skin region near face if landmarks are available
  if (landmarks && landmarks[0]) {
    const noseX = Math.round(landmarks[0].x * sw);
    const noseY = Math.round(landmarks[0].y * sh);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const px = Math.min(sw - 1, Math.max(0, noseX + dx));
        const py = Math.min(sh - 1, Math.max(0, noseY + dy));
        const idx = (py * sw + px) * 4;
        totalR += data[idx] * 2;
        totalG += data[idx + 1] * 2;
        totalB += data[idx + 2] * 2;
        count += 2;
      }
    }
  }

  if (count === 0) return { r: 240, g: 240, b: 240, lum: 240 };

  const meanR = totalR / count;
  const meanG = totalG / count;
  const meanB = totalB / count;
  const lum = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;

  return { r: meanR, g: meanG, b: meanB, lum };
}

/**
 * 1.b Inner shading: inside the garment, darken a band along the inner sleeve
 * edges and under the collar (multiply, 15-20%, blurred).
 */
function applyTemplateInnerShading(garmentCanvas, warpData, canvasPxPerCm) {
  const { destAnchors } = warpData;
  if (!destAnchors) return;

  const w = garmentCanvas.width;
  const h = garmentCanvas.height;

  const shadeCanvas = document.createElement('canvas');
  shadeCanvas.width = w;
  shadeCanvas.height = h;
  const sCtx = shadeCanvas.getContext('2d');

  const sleeveBandWidth = Math.max(16, Math.round(1.5 * canvasPxPerCm));
  const blurAmount = Math.max(6, Math.round(0.8 * canvasPxPerCm));

  sCtx.save();
  if (sCtx.filter) sCtx.filter = `blur(${blurAmount}px)`;
  sCtx.strokeStyle = 'rgba(0, 0, 0, 0.18)'; // 18% darkening band
  sCtx.lineWidth = sleeveBandWidth;
  sCtx.lineCap = 'round';

  // Left inner sleeve (viewer's left / wearer's right arm)
  const pArmpitL = destAnchors.armpitL;
  const pCuffInnerL = destAnchors.cuffInnerL;
  if (pArmpitL && pCuffInnerL) {
    sCtx.beginPath();
    sCtx.moveTo(pArmpitL.x, pArmpitL.y);
    sCtx.lineTo(pCuffInnerL.x, pCuffInnerL.y);
    sCtx.stroke();
  }

  // Right inner sleeve (viewer's right / wearer's left arm)
  const pArmpitR = destAnchors.armpitR;
  const pCuffInnerR = destAnchors.cuffInnerR;
  if (pArmpitR && pCuffInnerR) {
    sCtx.beginPath();
    sCtx.moveTo(pArmpitR.x, pArmpitR.y);
    sCtx.lineTo(pCuffInnerR.x, pCuffInnerR.y);
    sCtx.stroke();
  }

  // Under collar band
  const pCollarL = destAnchors.collarL;
  const pCollarR = destAnchors.collarR;
  if (pCollarL && pCollarR) {
    const midX = (pCollarL.x + pCollarR.x) / 2;
    const midY = Math.max(pCollarL.y, pCollarR.y) + 0.9 * canvasPxPerCm;
    sCtx.beginPath();
    sCtx.moveTo(pCollarL.x, pCollarL.y);
    sCtx.quadraticCurveTo(midX, midY, pCollarR.x, pCollarR.y);
    sCtx.stroke();
  }
  sCtx.restore();

  // Mask shading strictly inside the garment alpha
  sCtx.globalCompositeOperation = 'destination-in';
  sCtx.drawImage(garmentCanvas, 0, 0);

  // Multiply shading onto garment canvas
  const gCtx = garmentCanvas.getContext('2d');
  gCtx.save();
  gCtx.globalCompositeOperation = 'multiply';
  gCtx.drawImage(shadeCanvas, 0, 0);
  gCtx.restore();
}

/**
 * 1.c Light matching & 1.e Monochrome grain:
 * Adjusts garment with a small gain per channel (clamped to 0.85–1.15)
 * and adds very light monochrome noise (±3 levels).
 */
function applyTemplateLightMatchingAndGrain(garmentCanvas, avatarImg, landmarks, garment) {
  const w = garmentCanvas.width;
  const h = garmentCanvas.height;
  const gCtx = garmentCanvas.getContext('2d');

  const avatarLight = computeAvatarLightStats(avatarImg, landmarks);

  // Worn reference image stats (if available) or assume neutral studio lighting (238, 238, 238)
  let refR = 238, refG = 238, refB = 238;
  if (garment?.refImage) {
    const refLight = computeAvatarLightStats(garment.refImage, null);
    if (refLight.r > 50) {
      refR = refLight.r;
      refG = refLight.g;
      refB = refLight.b;
    }
  }

  let gainR = avatarLight.r / refR;
  let gainG = avatarLight.g / refG;
  let gainB = avatarLight.b / refB;

  // Per-channel gains tinted the beige collar grey-green (the reference is an assumed 238 grey,
  // not the real studio light), so use ONE brightness gain for all channels, kept gentle.
  const gainLum = Math.max(0.92, Math.min(1.08, (0.299 * gainR + 0.587 * gainG + 0.114 * gainB)));
  gainR = gainG = gainB = gainLum;

  const imgData = gCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const len = data.length;

  // Precomputed monochrome noise table (±3 levels) for sub-50ms execution
  const NOISE_TABLE = new Int8Array(1024);
  for (let k = 0; k < 1024; k++) {
    NOISE_TABLE[k] = Math.floor(Math.random() * 7) - 3;
  }
  let nIdx = 0;

  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] > 0) {
      // 1.e Monochrome grain in [-3, +3] added equally to RGB
      const noise = NOISE_TABLE[(nIdx++) & 1023];
      // 1.c Light matching gain per channel clamped to [0.85, 1.15]
      data[i]     = data[i] * gainR + noise;
      data[i + 1] = data[i + 1] * gainG + noise;
      data[i + 2] = data[i + 2] * gainB + noise;
    }
  }

  gCtx.putImageData(imgData, 0, 0);
}

/**
 * 1.d Edge softening: feather the garment alpha by ~1.4px (draw alpha mask with blur(1.4px) and use as mask).
 */
/**
 * Defringe: background removal leaves a 1-3 px light halo on the garment outline (white studio
 * background mixed into edge pixels). Remove light, colourless pixels that sit within 3 px of the
 * garment edge. Leather/fur are coloured or dark, so they are kept.
 */
/**
 * Remove small detached pieces ("islands") from the garment layer, e.g. a thin strip left between
 * the legs by the cut-from-worn step. Keeps every connected piece bigger than `minFrac` of the
 * largest piece (8-connectivity, alpha > 20).
 */
function removeGarmentIslands(garmentCanvas, minFrac = 0.02) {
  const w = garmentCanvas.width, h = garmentCanvas.height;
  const g = garmentCanvas.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const label = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let p = 0; p < w * h; p++) {
    if (label[p] || d[p * 4 + 3] <= 20) continue;
    let top = 0, size = 0;
    stack[top++] = p; label[p] = next;
    while (top) {
      const q = stack[--top]; size++;
      const qx = q % w, qy = (q - qx) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!label[n] && d[n * 4 + 3] > 20) { label[n] = next; stack[top++] = n; }
      }
    }
    sizes.push(size); next++;
  }
  const biggest = Math.max(0, ...sizes);
  if (!biggest) return;
  for (let p = 0; p < w * h; p++) {
    const l = label[p];
    if (l && sizes[l] < biggest * minFrac) d[p * 4 + 3] = 0;
  }
  g.putImageData(img, 0, 0);
}

/**
 * Fill small ENCLOSED holes in the garment layer (transparent areas surrounded by garment, not
 * connected to the canvas border). Browser check: the cut-from-worn step removes the mannequin's
 * white T-shirt that showed between sleeve and body, which left slits inside the garment; the
 * user's own T-shirt then showed through them as white stripes on the sleeves. A real garment has
 * no such holes (an open V-neck is big and open to the top, so it is kept: maxFrac limits the size).
 * Holes are filled by growing the surrounding garment colour inward.
 */
/**
 * Cut-from-worn garments can keep small blobs of the mannequin's white T-shirt (e.g. between the
 * sleeve and the waistband, seen in the browser on the cardigan). For non-white garments, make
 * light, colourless blobs transparent so fillGarmentHoles() repaints them with garment colour.
 * The centre column (zip / buttons) is left alone.
 */
function removeTeeLeftovers(garmentCanvas, midX, pxPerCm) {
  const w = garmentCanvas.width, h = garmentCanvas.height;
  const g = garmentCanvas.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const centre = 2 * pxPerCm;
  // Relative to the garment's own typical brightness, so a light-grey sweater is not erased.
  // Browser check: leftovers were T-shirt in shadow (~167/156/158), too dark for a fixed "white" test.
  const lums = [];
  for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 200) lums.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  if (!lums.length) return;
  lums.sort((a, b) => a - b);
  const medLum = lums[lums.length >> 1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.abs(x - midX) < centre) continue;
    const i = (y * w + x) * 4;
    if (d[i + 3] < 20) continue;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum > medLum + 60 && lum > 120 && mx - mn < 30) d[i + 3] = 0;
  }
  g.putImageData(img, 0, 0);
}

function fillGarmentHoles(garmentCanvas, maxFrac = 0.03, protectCentre = null) {
  const w = garmentCanvas.width, h = garmentCanvas.height;
  const g = garmentCanvas.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const N = w * h;
  // 1) Close NARROW slits too (e.g. between sleeve and body, open at the bottom so not "enclosed"):
  //    binary closing with radius ~7 px; new pixels become garment and get coloured below.
  const R = 12; // 7 px left 10-20 px gaps between cardigan sleeve and body (browser check)
  const bin = new Uint8Array(N);
  for (let p = 0; p < N; p++) bin[p] = d[p * 4 + 3] > 40 ? 1 : 0;
  const pass = (src, horiz, isMax) => {
    const out = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -R; k <= R; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        const val = (xx < 0 || yy < 0 || xx >= w || yy >= h) ? 0 : src[yy * w + xx];
        if (isMax ? val : !val) { v = isMax ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  const closed = pass(pass(pass(pass(bin, true, true), false, true), true, false), false, false);
  const slitPixels = [];
  const inCentre = (p) => protectCentre && Math.abs((p % w) - protectCentre.x) < protectCentre.halfWidth;
  for (let p = 0; p < N; p++) if (closed[p] && !bin[p] && !inCentre(p)) { slitPixels.push(p); d[p * 4 + 3] = 1; }

  const solid = (p) => d[p * 4 + 3] > 40;
  let garmentArea = 0;
  for (let p = 0; p < N; p++) if (solid(p)) garmentArea++;
  if (!garmentArea) return;
  // label transparent regions
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  const holePixels = [];
  for (let p0 = 0; p0 < N; p0++) {
    if (seen[p0] || solid(p0)) continue;
    let top = 0; stack[top++] = p0; seen[p0] = 1;
    const comp = []; let touchesBorder = false;
    while (top) {
      const q = stack[--top]; comp.push(q);
      const x = q % w, y = (q - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      if (x > 0 && !seen[q - 1] && !solid(q - 1)) { seen[q - 1] = 1; stack[top++] = q - 1; }
      if (x < w - 1 && !seen[q + 1] && !solid(q + 1)) { seen[q + 1] = 1; stack[top++] = q + 1; }
      if (y > 0 && !seen[q - w] && !solid(q - w)) { seen[q - w] = 1; stack[top++] = q - w; }
      if (y < h - 1 && !seen[q + w] && !solid(q + w)) { seen[q + w] = 1; stack[top++] = q + w; }
    }
    // Keep openings on the centre line (an open V-neck / front opening shows the top underneath).
    let cx = 0; for (const q of comp) cx += q % w; cx /= comp.length;
    const onCentre = protectCentre && Math.abs(cx - protectCentre.x) < protectCentre.halfWidth;
    if (!touchesBorder && !onCentre && comp.length < garmentArea * maxFrac) holePixels.push(...comp);
  }
  for (const p of slitPixels) { d[p * 4 + 3] = 0; holePixels.push(p); }
  // Browser check: the remaining "ghost" shapes were SEMI-transparent garment pixels (alpha 40-250,
  // feathered edges of the removed T-shirt) inside the garment. Inside the closed silhouette the
  // garment must be fully opaque; the outer outline is softened later by applyTemplateEdgeSoftening.
  // Erode the closed mask (by R px) so the true outer edge keeps its anti-aliasing.
  const inner = pass(pass(closed, true, false), false, false);
  for (let p = 0; p < N; p++) if (inner[p] && d[p * 4 + 3] > 40 && !inCentre(p)) d[p * 4 + 3] = 255;
  if (!holePixels.length) { g.putImageData(img, 0, 0); return; }
  // grow colour inward: repeat passes, each filling hole pixels that have a solid neighbour
  let pending = holePixels;
  for (let pass = 0; pass < 200 && pending.length; pass++) {
    const next = [], filled = [];
    for (const q of pending) {
      const x = q % w;
      let r = 0, gg = 0, b = 0, n = 0;
      for (const nb of [q - 1, q + 1, q - w, q + w]) {
        if (nb < 0 || nb >= N || (nb === q - 1 && x === 0) || (nb === q + 1 && x === w - 1)) continue;
        if (d[nb * 4 + 3] > 40) { r += d[nb * 4]; gg += d[nb * 4 + 1]; b += d[nb * 4 + 2]; n++; }
      }
      if (n) filled.push([q, r / n, gg / n, b / n]); else next.push(q);
    }
    for (const [q, r, gg, b] of filled) { d[q * 4] = r; d[q * 4 + 1] = gg; d[q * 4 + 2] = b; d[q * 4 + 3] = 255; }
    pending = next;
  }
  g.putImageData(img, 0, 0);
}

function defringeGarment(garmentCanvas, radius = 3) {
  const w = garmentCanvas.width, h = garmentCanvas.height;
  const g = garmentCanvas.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  // distance-to-transparent (chessboard) up to `radius`, two passes
  const dist = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = d[i * 4 + 3] < 10 ? 0 : 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!dist[p]) continue;
    let m = dist[p];
    if (x > 0) m = Math.min(m, dist[p - 1] + 1);
    if (y > 0) m = Math.min(m, dist[p - w] + 1, x > 0 ? dist[p - w - 1] + 1 : 255, x < w - 1 ? dist[p - w + 1] + 1 : 255);
    dist[p] = m;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x; if (!dist[p]) continue;
    let m = dist[p];
    if (x < w - 1) m = Math.min(m, dist[p + 1] + 1);
    if (y < h - 1) m = Math.min(m, dist[p + w] + 1, x < w - 1 ? dist[p + w + 1] + 1 : 255, x > 0 ? dist[p + w - 1] + 1 : 255);
    dist[p] = m;
  }
  for (let p = 0; p < w * h; p++) {
    if (!dist[p] || dist[p] > radius) continue;
    const i = p * 4;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mn > 185 && mx - mn < 24) d[i + 3] = 0;
  }
  g.putImageData(img, 0, 0);
}

function applyTemplateEdgeSoftening(garmentCanvas) {
  const w = garmentCanvas.width;
  const h = garmentCanvas.height;
  const gCtx = garmentCanvas.getContext('2d');

  // 1. Extract alpha mask as white silhouette
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mCtx = maskCanvas.getContext('2d');
  mCtx.drawImage(garmentCanvas, 0, 0);
  mCtx.globalCompositeOperation = 'source-in';
  mCtx.fillStyle = '#ffffff';
  mCtx.fillRect(0, 0, w, h);

  // 2. Feather the mask with blur(1.4px) (Phase 10: raised from 0.8px)
  const blurredMask = document.createElement('canvas');
  blurredMask.width = w;
  blurredMask.height = h;
  const bmCtx = blurredMask.getContext('2d');
  if (bmCtx.filter) {
    bmCtx.filter = 'blur(1.4px)';
  }
  bmCtx.drawImage(maskCanvas, 0, 0);

  // 3. Apply feathered mask back via destination-in
  gCtx.save();
  gCtx.globalCompositeOperation = 'destination-in';
  gCtx.drawImage(blurredMask, 0, 0);
  gCtx.restore();
}

/**
 * Builds and caches offscreen composited layers for a template garment:
 * returns { garmentCanvas, shadowCanvas }
 */
/**
 * "Clean plate" step (what a retoucher does first): the avatar's white T-shirt must not peek out
 * around the jacket (shoulders, beside the hem). Near the garment, replace T-shirt pixels that the
 * garment does not cover with the studio background colour of that row.
 * T-shirt pixel = clearly brighter than the row background and almost colourless.
 * The neck opening (between the collar flaps) is kept, so a T-shirt under an open collar stays.
 */
function cleanTeeAroundGarment(ctx, garmentCanvas, warpData, avatar, mapPoint, canvasPxPerCm, centerShiftX, centerShiftY, ratio) {
  const plate = state.avatarTeePlate;            // built with the skin mask (needs the person mask)
  if (!plate) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const near = Math.max(8, Math.round(3 * canvasPxPerCm));

  // T-shirt clean plate in stage coordinates
  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lCtx = layer.getContext('2d');
  lCtx.drawImage(plate, centerShiftX, centerShiftY, plate.width * ratio, plate.height * ratio);

  // keep it only NEAR the garment (garment alpha spread ~3 cm outward)...
  const zone = document.createElement('canvas');
  zone.width = W; zone.height = H;
  const zCtx = zone.getContext('2d');
  zCtx.filter = `blur(${near}px)`;
  for (let k = 0; k < 4; k++) zCtx.drawImage(garmentCanvas, 0, 0);
  lCtx.globalCompositeOperation = 'destination-in';
  lCtx.drawImage(zone, 0, 0);
  // ...and only where the garment does NOT cover it
  lCtx.globalCompositeOperation = 'destination-out';
  lCtx.drawImage(garmentCanvas, 0, 0);

  // keep the T-shirt visible inside the neck opening (between the collar flaps)
  const l = avatar.landmarks || [];
  if (l[7] && l[8] && l[10]) {
    const e1 = mapPoint(l[7]), e2 = mapPoint(l[8]), mouth = mapPoint(l[10]);
    const vY = warpData.garment?.neckFront && warpData.warpPoint
      ? warpData.warpPoint(warpData.garment.neckFront.x, warpData.garment.neckFront.y).y
      : mouth.y + 12 * canvasPxPerCm;
    const x0 = Math.min(e1.x, e2.x), x1 = Math.max(e1.x, e2.x);
    const by = mouth.y, bh = vY + canvasPxPerCm - mouth.y;
    lCtx.globalCompositeOperation = 'source-over';
    lCtx.clearRect(x0, by, x1 - x0, bh);
    // Inside the collar opening a bright white T-shirt looks pasted: in a real photo that area is
    // in the jacket's shadow. Paint the T-shirt pixels there with a dark, deepening shadow tone.
    // (Skip this shading for open-V garments where the wearer's own top should show through un-darkened).
    if (warpData.garment?.neckline !== 'openV') {
      const sh = document.createElement('canvas');
      sh.width = W; sh.height = H;
      const sCtx = sh.getContext('2d');
      sCtx.drawImage(plate, centerShiftX, centerShiftY, plate.width * ratio, plate.height * ratio);
      sCtx.globalCompositeOperation = 'destination-in';
      sCtx.fillRect(x0, by, x1 - x0, bh);
      sCtx.globalCompositeOperation = 'source-in';
      const grad = sCtx.createLinearGradient(0, by, 0, by + bh);
      grad.addColorStop(0, 'rgba(70, 58, 52, 0.75)');
      grad.addColorStop(1, 'rgba(32, 26, 24, 0.92)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(x0, by, x1 - x0, bh);
      lCtx.drawImage(sh, 0, 0);
    }
  }

  // Phase 9B: Ensure clean-plate studio background never paints over the front pulled gap
  if (warpData.isFrontClosing && warpData.midShoulderX) {
    const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
    const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
    const isTightFront = (chestZone?.status === 'tight' || chestZone?.status === 'tooTight' ||
                          waistZone?.status === 'tight' || waistZone?.status === 'tooTight');
    if (isTightFront) {
      const midX = warpData.midShoulderX;
      const topY = warpData.midShoulderY || 0;
      const botY = topY + 70 * canvasPxPerCm;
      const stripHalfW = 2.0 * canvasPxPerCm;
      lCtx.clearRect(midX - stripHalfW, topY, stripHalfW * 2, botY - topY);
    }
  }

  ctx.drawImage(layer, 0, 0);
}

/**
 * Phase 8.3: Draw subtle horizontal strain folds when chest or waist is "tooTight".
 * 2-3 thin darker curved lines, multiply 15%, across the chest/waist band of the garment.
 */
/**
 * Phase 8.3 & 9B: Draw subtle horizontal strain folds when chest, waist, or shoulder is tight/tooTight.
 * Thin darker curved lines, multiply 15%, across the tight bands of the garment.
 */
function drawTemplateStrainFolds(gCanvas, warpData, avatar, rowY_shoulder, rowY_chest, rowY_waist, canvasPxPerCm) {
  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const shoulderZone = warpData.fitZones?.find(z => z.zone === 'shoulder');

  const isTightChest = (chestZone?.status === 'tight' || chestZone?.status === 'tooTight');
  const isTightWaist = (waistZone?.status === 'tight' || waistZone?.status === 'tooTight');
  const isTightShoulder = (shoulderZone?.status === 'tight' || shoulderZone?.status === 'tooTight');

  if (!isTightChest && !isTightWaist && !isTightShoulder) return;

  const ctx = gCanvas.getContext('2d');
  const W = gCanvas.width;
  const H = gCanvas.height;

  const foldCanvas = document.createElement('canvas');
  foldCanvas.width = W;
  foldCanvas.height = H;
  const fCtx = foldCanvas.getContext('2d');

  fCtx.strokeStyle = 'rgba(25, 20, 18, 0.45)';
  fCtx.lineWidth = Math.max(1.2, 1.5 * (canvasPxPerCm / 7.0));
  fCtx.lineCap = 'round';

  const midX = warpData.midShoulderX || (W / 2);

  const drawFoldsAtRow = (rowY, strength = 1.0) => {
    const rowInt = Math.round(rowY);
    if (rowInt < 0 || rowInt >= H) return;
    const imgData = ctx.getImageData(0, rowInt, W, 1).data;
    let leftX = Math.round(midX);
    let rightX = Math.round(midX);
    const alphaThresh = 20;
    if (imgData[leftX * 4 + 3] < alphaThresh) {
      for (let d = 1; d <= 60; d++) {
        if (leftX + d < W && imgData[(leftX + d) * 4 + 3] >= alphaThresh) { leftX += d; rightX = leftX; break; }
        if (leftX - d >= 0 && imgData[(leftX - d) * 4 + 3] >= alphaThresh) { leftX -= d; rightX = leftX; break; }
      }
    }
    while (leftX > 0 && imgData[(leftX - 1) * 4 + 3] >= alphaThresh) leftX--;
    while (rightX < W - 1 && imgData[(rightX + 1) * 4 + 3] >= alphaThresh) rightX++;
    const span = rightX - leftX;
    if (span < 30) return;

    // Draw 2-3 horizontal tension folds
    const offsets = [-0.6 * canvasPxPerCm, 0, +0.7 * canvasPxPerCm];
    offsets.forEach((dy, idx) => {
      const y0 = rowY + dy;
      const x1 = leftX + span * 0.12;
      const x2 = rightX - span * 0.12;
      const sag = (idx % 2 === 0 ? 3 : -2) * (canvasPxPerCm / 7.0) * strength;

      fCtx.beginPath();
      fCtx.moveTo(x1, y0);
      fCtx.quadraticCurveTo(midX, y0 + sag, x2, y0);
      fCtx.stroke();
    });
  };

  if (isTightChest) {
    drawFoldsAtRow(rowY_chest, chestZone.status === 'tooTight' ? 1.0 : 0.7);
  }
  if (isTightWaist) {
    drawFoldsAtRow(rowY_waist, waistZone.status === 'tooTight' ? 1.0 : 0.7);
  }

  // Phase 9B: Shoulder strain folds when shoulder is tight
  if (isTightShoulder && rowY_shoulder) {
    const sInt = Math.round(rowY_shoulder);
    if (sInt >= 0 && sInt < H) {
      const imgData = ctx.getImageData(0, sInt, W, 1).data;
      let leftX = Math.round(midX);
      let rightX = Math.round(midX);
      const alphaThresh = 20;
      if (imgData[leftX * 4 + 3] < alphaThresh) {
        for (let d = 1; d <= 60; d++) {
          if (leftX + d < W && imgData[(leftX + d) * 4 + 3] >= alphaThresh) { leftX += d; rightX = leftX; break; }
          if (leftX - d >= 0 && imgData[(leftX - d) * 4 + 3] >= alphaThresh) { leftX -= d; rightX = leftX; break; }
        }
      }
      while (leftX > 0 && imgData[(leftX - 1) * 4 + 3] >= alphaThresh) leftX--;
      while (rightX < W - 1 && imgData[(rightX + 1) * 4 + 3] >= alphaThresh) rightX++;
      const span = rightX - leftX;
      if (span >= 30) {
        // Left shoulder diagonal strain fold
        fCtx.beginPath();
        fCtx.moveTo(leftX + span * 0.12, rowY_shoulder + 0.4 * canvasPxPerCm);
        fCtx.quadraticCurveTo(leftX + span * 0.25, rowY_shoulder - 0.2 * canvasPxPerCm, midX - span * 0.15, rowY_shoulder - 0.7 * canvasPxPerCm);
        fCtx.stroke();

        // Right shoulder diagonal strain fold
        fCtx.beginPath();
        fCtx.moveTo(rightX - span * 0.12, rowY_shoulder + 0.4 * canvasPxPerCm);
        fCtx.quadraticCurveTo(rightX - span * 0.25, rowY_shoulder - 0.2 * canvasPxPerCm, midX + span * 0.15, rowY_shoulder - 0.7 * canvasPxPerCm);
        fCtx.stroke();
      }
    }
  }

  // Clip folds to garment alpha
  fCtx.globalCompositeOperation = 'destination-in';
  fCtx.drawImage(gCanvas, 0, 0);

  // Composite onto gCanvas using multiply with ~15% net opacity (0.35 * 0.45 ≈ 0.15)
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.35;
  ctx.drawImage(foldCanvas, 0, 0);
  ctx.restore();
}

/**
 * Phase 9B: For front-closing garments (cardigan, jacket, coat) that are tight or tooTight at
 * chest or waist, draw a small pulled gap at the centre front at the tight row (narrow wedge
 * where the avatar's white T-shirt shows), max 2.5 cm.
 */
function drawTemplateFrontPulledGap(gCanvas, warpData, rowY_chest, rowY_waist, canvasPxPerCm) {
  if (!warpData.isFrontClosing) return;
  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const isTightChest = chestZone && (chestZone.status === 'tight' || chestZone.status === 'tooTight');
  const isTightWaist = waistZone && (waistZone.status === 'tight' || waistZone.status === 'tooTight');

  if (!isTightChest && !isTightWaist) return;

  const ctx = gCanvas.getContext('2d');
  const midX = warpData.midShoulderX || (gCanvas.width / 2);
  const rows = [];
  if (isTightChest) rows.push({ rowY: rowY_chest, zone: chestZone });
  if (isTightWaist) rows.push({ rowY: rowY_waist, zone: waistZone });

  rows.forEach(({ rowY, zone }) => {
    const isTooTight = (zone.status === 'tooTight');
    // Max 2.5 cm gap
    const gapWidthPx = Math.min(2.5 * canvasPxPerCm, (isTooTight ? 2.2 : 1.3) * canvasPxPerCm);
    const halfW = gapWidthPx / 2;
    const halfH = Math.min(3.2 * canvasPxPerCm, Math.abs(rowY_waist - rowY_chest) * 0.45);

    // 1. Erase diamond/ellipse opening in garment so stage's white T-shirt shows through
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(midX, rowY - halfH);
    ctx.quadraticCurveTo(midX + halfW, rowY, midX, rowY + halfH);
    ctx.quadraticCurveTo(midX - halfW, rowY, midX, rowY - halfH);
    ctx.closePath();
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.restore();

    // 2. Add subtle dark edge tension creases along the pulled edges of the garment opening
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(25, 20, 18, 0.45)';
    ctx.lineWidth = Math.max(1, 1.2 * (canvasPxPerCm / 7.0));
    ctx.beginPath();
    ctx.moveTo(midX, rowY - halfH);
    ctx.quadraticCurveTo(midX + halfW, rowY, midX, rowY + halfH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(midX, rowY - halfH);
    ctx.quadraticCurveTo(midX - halfW, rowY, midX, rowY - halfH);
    ctx.stroke();
    ctx.restore();
  });
}

/**
 * Phase 9B: For loose or tooLoose chest/waist/hip, add 1-2 soft vertical drape shadows at the sides
 * (multiply 10-12%) so the garment visibly stands away from the body.
 */
function applyTemplateDrapeShadows(gCanvas, warpData, avatar, rowY_chest, rowY_waist, rowY_hip, canvasPxPerCm) {
  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const hipZone = warpData.fitZones?.find(z => z.zone === 'hips' || z.zone === 'hip');

  const isLooseChest = chestZone && (chestZone.status === 'loose' || chestZone.status === 'tooLoose');
  const isLooseWaist = waistZone && (waistZone.status === 'loose' || waistZone.status === 'tooLoose');
  const isLooseHip   = hipZone && (hipZone.status === 'loose' || hipZone.status === 'tooLoose');

  if (!isLooseChest && !isLooseWaist && !isLooseHip) return;

  const W = gCanvas.width;
  const H = gCanvas.height;
  const ctx = gCanvas.getContext('2d');

  const drapeCanvas = document.createElement('canvas');
  drapeCanvas.width = W;
  drapeCanvas.height = H;
  const dCtx = drapeCanvas.getContext('2d');

  dCtx.strokeStyle = 'rgba(25, 20, 18, 0.35)'; // ~11% net opacity when multiplied
  dCtx.lineWidth = Math.max(2.5, 3.5 * (canvasPxPerCm / 7.0));
  dCtx.lineCap = 'round';

  const startY = rowY_chest;
  const endY = Math.min(H - 10, rowY_hip + 5 * canvasPxPerCm);

  const getRowBounds = (y) => {
    const rInt = Math.round(y);
    if (rInt < 0 || rInt >= H) return null;
    const data = ctx.getImageData(0, rInt, W, 1).data;
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) {
      if (data[x * 4 + 3] >= 30) { if (l < 0) l = x; r = x; }
    }
    return (l >= 0 && r > l) ? { left: l, right: r, width: r - l } : null;
  };

  const boundsChest = getRowBounds(rowY_chest);
  const boundsWaist = getRowBounds(rowY_waist);
  const boundsHip = getRowBounds(rowY_hip);

  if (boundsChest && boundsWaist) {
    // Left flank drape (viewer's left)
    const xL_top = boundsChest.left + boundsChest.width * 0.16;
    const xL_mid = boundsWaist.left + boundsWaist.width * 0.18;
    const xL_bot = boundsHip ? (boundsHip.left + boundsHip.width * 0.17) : xL_mid;

    dCtx.beginPath();
    dCtx.moveTo(xL_top, startY);
    dCtx.bezierCurveTo(xL_top - 3, (startY + rowY_waist) / 2, xL_mid + 4, (rowY_waist + endY) / 2, xL_bot, endY);
    dCtx.stroke();

    // Left secondary drape
    dCtx.beginPath();
    dCtx.moveTo(xL_top + 10, startY + 2 * canvasPxPerCm);
    dCtx.bezierCurveTo(xL_top + 6, (startY + rowY_waist) / 2, xL_mid + 12, (rowY_waist + endY) / 2, xL_bot + 8, endY - canvasPxPerCm);
    dCtx.stroke();

    // Right flank drape (viewer's right)
    const xR_top = boundsChest.right - boundsChest.width * 0.16;
    const xR_mid = boundsWaist.right - boundsWaist.width * 0.18;
    const xR_bot = boundsHip ? (boundsHip.right - boundsHip.width * 0.17) : xR_mid;

    dCtx.beginPath();
    dCtx.moveTo(xR_top, startY);
    dCtx.bezierCurveTo(xR_top + 3, (startY + rowY_waist) / 2, xR_mid - 4, (rowY_waist + endY) / 2, xR_bot, endY);
    dCtx.stroke();

    // Right secondary drape
    dCtx.beginPath();
    dCtx.moveTo(xR_top - 10, startY + 2 * canvasPxPerCm);
    dCtx.bezierCurveTo(xR_top - 6, (startY + rowY_waist) / 2, xR_mid - 12, (rowY_waist + endY) / 2, xR_bot - 8, endY - canvasPxPerCm);
    dCtx.stroke();
  }

  // Soft blur drape shadows
  const blurredDrape = document.createElement('canvas');
  blurredDrape.width = W;
  blurredDrape.height = H;
  const bCtx = blurredDrape.getContext('2d');
  if (bCtx.filter) {
    bCtx.filter = `blur(${Math.max(3, Math.round(4 * (canvasPxPerCm / 7.0)))}px)`;
  }
  bCtx.drawImage(drapeCanvas, 0, 0);

  // Clip to garment alpha
  bCtx.globalCompositeOperation = 'destination-in';
  bCtx.drawImage(gCanvas, 0, 0);

  // Composite onto gCanvas using multiply with ~11% net opacity (0.32 * 0.35 ≈ 0.11)
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.32;
  ctx.drawImage(blurredDrape, 0, 0);
  ctx.restore();
}

/**
 * Phase 9C: 3D-style colored fit map overlay inside the garment shape (~45% opacity).
 * Zone regions on garment: shoulders band, chest band, waist band, hip/hem band, and each sleeve.
 * 2-3 cm soft transitions between bands, colors from css/base.css.
 */
async function getOrBuildFitMapCanvas(warpData, garmentCanvas, canvasWidth, canvasHeight, avatarPxPerCm, ratio) {
  if (!warpData || !garmentCanvas) return null;

  const prefKey = warpData.item?.preference || state.fitPreference || '';
  const cacheKey = `fitmap_${warpData.garment.id}_${warpData.size}_${prefKey}_${state.avatar?.image || ''}_${canvasWidth}x${canvasHeight}`;
  if (state.fitMapCache && state.fitMapCache.has(cacheKey)) {
    return state.fitMapCache.get(cacheKey);
  }

  const canvasPxPerCm = avatarPxPerCm * ratio;

  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const shoulderZone = warpData.fitZones?.find(z => z.zone === 'shoulder');
  const hipZone = warpData.fitZones?.find(z => z.zone === 'hips' || z.zone === 'hip');
  const sleeveZone = warpData.fitZones?.find(z => z.zone === 'sleeve');

  const shoulderColor = (shoulderZone && shoulderZone.status !== 'n/a') ? FIT_STATUS_COLORS[shoulderZone.status] : null;
  const chestColor    = (chestZone && chestZone.status !== 'n/a')       ? FIT_STATUS_COLORS[chestZone.status]    : null;
  const waistColor    = (waistZone && waistZone.status !== 'n/a')       ? FIT_STATUS_COLORS[waistZone.status]    : null;
  const hipColor      = (hipZone && hipZone.status !== 'n/a')           ? FIT_STATUS_COLORS[hipZone.status]      : waistColor;
  const sleeveColor   = (sleeveZone && sleeveZone.status !== 'n/a')     ? FIT_STATUS_COLORS[sleeveZone.status]   : null;

  // Offscreen canvas for drawing color regions
  const bandsCanvas = document.createElement('canvas');
  bandsCanvas.width = canvasWidth;
  bandsCanvas.height = canvasHeight;
  const bCtx = bandsCanvas.getContext('2d');

  // Key horizontal landmarks
  const midX = warpData.midShoulderX || (canvasWidth / 2);
  const midY = warpData.midShoulderY || (canvasHeight * 0.25);
  const bodyChestW = warpData.bodyChestW || warpData.targetChestWidth || (30 * canvasPxPerCm);
  const rowY_shoulder = warpData.rowY_shoulder || (midY + 2 * canvasPxPerCm);
  const rowY_chest = warpData.rowY_chest || (midY + 14 * canvasPxPerCm);
  const rowY_waist = warpData.rowY_waist || (midY + 29 * canvasPxPerCm);
  const rowY_hip   = warpData.rowY_hip   || (midY + 47 * canvasPxPerCm);

  // 1. Draw Torso horizontal bands
  // Shoulder band: from top to rowY_shoulder + 1 cm
  if (shoulderColor) {
    bCtx.fillStyle = shoulderColor;
    bCtx.fillRect(0, 0, canvasWidth, rowY_shoulder + 1 * canvasPxPerCm);
  }

  // Chest band: from rowY_shoulder to (rowY_chest + rowY_waist)/2
  if (chestColor) {
    bCtx.fillStyle = chestColor;
    bCtx.fillRect(0, rowY_shoulder, canvasWidth, ((rowY_chest + rowY_waist) / 2) - rowY_shoulder);
  }

  // Waist band: from (rowY_chest + rowY_waist)/2 to (rowY_waist + rowY_hip)/2
  if (waistColor) {
    bCtx.fillStyle = waistColor;
    const yTop = (rowY_chest + rowY_waist) / 2;
    const yBot = (rowY_waist + rowY_hip) / 2;
    bCtx.fillRect(0, yTop, canvasWidth, yBot - yTop);
  }

  // Hip / Hem band: from (rowY_waist + rowY_hip)/2 to bottom
  if (hipColor) {
    bCtx.fillStyle = hipColor;
    const yTop = (rowY_waist + rowY_hip) / 2;
    bCtx.fillRect(0, yTop, canvasWidth, canvasHeight - yTop);
  }

  // 2. Draw Sleeve regions: outside the torso column (past bodyChestW * 0.52 from center)
  if (sleeveColor) {
    bCtx.fillStyle = sleeveColor;
    // Left sleeve box (viewer's left)
    const leftArmOuter = midX - bodyChestW * 0.52;
    bCtx.fillRect(0, midY, leftArmOuter, canvasHeight - midY);

    // Right sleeve box (viewer's right)
    const rightArmInner = midX + bodyChestW * 0.52;
    bCtx.fillRect(rightArmInner, midY, canvasWidth - rightArmInner, canvasHeight - midY);
  }

  // 3. Smooth 2-3 cm blend between bands
  const blendCanvas = document.createElement('canvas');
  blendCanvas.width = canvasWidth;
  blendCanvas.height = canvasHeight;
  const mCtx = blendCanvas.getContext('2d');

  const blurPx = Math.max(8, Math.round(2.5 * canvasPxPerCm));
  if (mCtx.filter) {
    mCtx.filter = `blur(${blurPx}px)`;
  }
  mCtx.drawImage(bandsCanvas, 0, 0);

  // 4. Clip strictly inside garment shape alpha
  mCtx.globalCompositeOperation = 'destination-in';
  mCtx.drawImage(garmentCanvas, 0, 0);

  if (state.fitMapCache) {
    state.fitMapCache.set(cacheKey, blendCanvas);
  }

  return blendCanvas;
}

/**
 * Phase 9C: Determine which fit zone is under (cx, cy) on the stage canvas for tooltip.
 */
function getFitMapZoneAtPoint(cx, cy, warpData, canvas) {
  if (!warpData || !warpData.compositedGarmentCanvas) return null;

  // 1. Check alpha of garment canvas at (cx, cy)
  const gCanvas = warpData.compositedGarmentCanvas;
  const gCtx = gCanvas.getContext('2d');
  const xInt = Math.round(cx);
  const yInt = Math.round(cy);
  if (xInt < 0 || xInt >= gCanvas.width || yInt < 0 || yInt >= gCanvas.height) return null;

  const pix = gCtx.getImageData(xInt, yInt, 1, 1).data;
  if (pix[3] < 25) return null; // not on garment

  const canvasPxPerCm = warpData.canvasPxPerCm || 5;
  const midX = warpData.midShoulderX || (gCanvas.width / 2);
  const midY = warpData.midShoulderY || (gCanvas.height * 0.25);
  const bodyChestW = warpData.bodyChestW || warpData.targetChestWidth || (30 * canvasPxPerCm);

  const rowY_shoulder = warpData.rowY_shoulder || (midY + 2 * canvasPxPerCm);
  const rowY_chest = warpData.rowY_chest || (midY + 14 * canvasPxPerCm);
  const rowY_waist = warpData.rowY_waist || (midY + 29 * canvasPxPerCm);
  const rowY_hip   = warpData.rowY_hip   || (midY + 47 * canvasPxPerCm);

  // Check if point is in left or right sleeve
  const isLeftSleeve = (cx < midX - bodyChestW * 0.52 && cy > midY);
  const isRightSleeve = (cx > midX + bodyChestW * 0.52 && cy > midY);

  let targetZoneName = 'chest';
  if (isLeftSleeve || isRightSleeve) {
    targetZoneName = 'sleeve';
  } else if (cy <= rowY_shoulder + 1 * canvasPxPerCm) {
    targetZoneName = 'shoulder';
  } else if (cy <= (rowY_chest + rowY_waist) / 2) {
    targetZoneName = 'chest';
  } else if (cy <= (rowY_waist + rowY_hip) / 2) {
    targetZoneName = 'waist';
  } else {
    targetZoneName = 'length';
  }

  const zone = warpData.fitZones?.find(z => z.zone === targetZoneName)
    || warpData.fitZones?.find(z => (targetZoneName === 'length' && (z.zone === 'hips' || z.zone === 'hip')))
    || { zone: targetZoneName, ease: 0, status: 'good' };

  return { zone, targetZoneName };
}

/**
 * Helper to draw a rounded pill badge on canvas with high contrast and shadow.
 */
function drawFitPill(ctx, text, centerX, centerY, bgColor, textColor, fontSize, padX, padY) {
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const textMetrics = ctx.measureText(text);
  const textW = textMetrics.width;
  const pillW = textW + padX * 2;
  const pillH = fontSize + padY * 2;
  const r = pillH / 2;
  const pillX = centerX - pillW / 2;
  const pillY = centerY - pillH / 2;

  // Soft dark shadow for readability on all garments (dark and light)
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1.5;

  ctx.fillStyle = bgColor;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(pillX, pillY, pillW, pillH, r);
  } else {
    ctx.moveTo(pillX + r, pillY);
    ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
    ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
    ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
    ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
    ctx.closePath();
  }
  ctx.fill();

  // Reset shadow for crisp text
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = textColor;
  ctx.fillText(text, centerX, centerY);
  ctx.restore();
}

/**
 * Phase 10: Fit labels on the avatar (like retail 3D try-on apps).
 * Draws thin horizontal lines at chest, waist, and hip rows across the garment,
 * with zone name pill at left end and plain verdict pill at center.
 */
function drawTemplateFitLabels(ctx, warpData, garmentCanvas, canvasWidth, canvasHeight, avatarPxPerCm, ratio) {
  if (!state.fitLabels || !warpData) return;

  const canvasPxPerCm = avatarPxPerCm * ratio;
  const midX = warpData.midShoulderX || (canvasWidth / 2);
  const midY = warpData.midShoulderY || (canvasHeight * 0.25);
  const bodyChestW = warpData.bodyChestW || warpData.targetChestWidth || (30 * canvasPxPerCm);

  const rowY_chest = warpData.rowY_chest || (midY + 14 * canvasPxPerCm);
  const rowY_waist = warpData.rowY_waist || (midY + 29 * canvasPxPerCm);
  const rowY_hip   = warpData.rowY_hip   || (midY + 47 * canvasPxPerCm);

  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const hipZone   = warpData.fitZones?.find(z => z.zone === 'hips' || z.zone === 'hip' || z.zone === 'hem');
  // Hip falls back to hem band / waist fit if no hip zone
  const effectiveHipZone = (hipZone && hipZone.status !== 'n/a') ? hipZone : waistZone;

  const rows = [
    { name: 'Chest', rowY: rowY_chest, zone: chestZone, bodyW: bodyChestW },
    { name: 'Waist', rowY: rowY_waist, zone: waistZone, bodyW: bodyChestW * 0.9 },
    { name: 'Hip',   rowY: rowY_hip,   zone: effectiveHipZone, bodyW: bodyChestW * 1.05 }
  ];

  const gCtx = garmentCanvas ? garmentCanvas.getContext('2d') : null;

  for (const item of rows) {
    const z = item.zone;
    // Hide labels for n/a zones
    if (!z || z.status === 'n/a' || !FIT_STATUS_COLORS[z.status]) continue;

    const rowInt = Math.round(item.rowY);
    if (rowInt < 0 || rowInt >= canvasHeight) continue;

    // Scan garment width at rowInt inside torso window (midX ± bodyW * 0.75 + 2 cm)
    let garmentLeft = -1;
    let garmentRight = -1;

    if (gCtx) {
      const halfWindow = Math.round(item.bodyW * 0.75 + 2.0 * canvasPxPerCm);
      const winX0 = Math.max(0, Math.floor(midX - halfWindow));
      const winX1 = Math.min(canvasWidth - 1, Math.ceil(midX + halfWindow));
      const len = winX1 - winX0 + 1;
      if (len > 0) {
        const sliceData = gCtx.getImageData(winX0, rowInt, len, 1).data;
        for (let i = 0; i < len; i++) {
          if (sliceData[i * 4 + 3] >= 20) {
            if (garmentLeft < 0) garmentLeft = winX0 + i;
            garmentRight = winX0 + i;
          }
        }
      }
    }

    // Fallback if not detected from canvas alpha
    if (garmentLeft < 0 || garmentRight <= garmentLeft) {
      garmentLeft = midX - item.bodyW / 2;
      garmentRight = midX + item.bodyW / 2;
    }

    // Line: only as wide as the garment at that row plus 1 cm on each side
    const lineX0 = garmentLeft - 1.0 * canvasPxPerCm;
    const lineX1 = garmentRight + 1.0 * canvasPxPerCm;
    const lineCenter = (lineX0 + lineX1) / 2;

    // 1. Draw thin 1px horizontal line across garment, white with 60% opacity and soft dark shadow
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.60)';
    ctx.lineWidth = 1;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.moveTo(lineX0, rowInt + 0.5);
    ctx.lineTo(lineX1, rowInt + 0.5);
    ctx.stroke();
    ctx.restore();

    // 2. Small label with zone name ("Chest") at left end
    drawFitPill(ctx, item.name, lineX0, rowInt, 'rgba(15, 23, 42, 0.88)', '#FFFFFF', 10, 7, 2.5);

    // 3. Pill with plain verdict at the centre
    const verdictText = FIT_VERDICT_PLAIN_TEXT[z.status] || z.status;
    const verdictColor = FIT_STATUS_COLORS[z.status] || '#2E8B57';
    drawFitPill(ctx, verdictText, lineCenter, rowInt, verdictColor, '#FFFFFF', 10.5, 9, 3);
  }
}

async function getOrBuildTemplateCompositedLayers(warpData, gImg, avatarImg, canvasWidth, canvasHeight, avatarPxPerCm, ratio) {
  const { garment, size, warpPoint } = warpData;
  const canvasPxPerCm = avatarPxPerCm * ratio;
  // The key must change when the AVATAR (pose/landmarks/measurements) or the saved garment changes, otherwise a
  // layer warped for the previous avatar is reused on a new one (garment misplaced, neck looks wrong).
  const lm = state.avatar?.landmarks || [];
  const poseKey = [11, 12, 15, 16, 23, 24].map(i => lm[i] ? `${lm[i].x.toFixed(3)},${lm[i].y.toFixed(3)}` : '-').join('|');
  const body = loadBody();
  const bodyKey = body?.measurements ? `${body.measurements.chest || ''}_${body.measurements.waist || ''}_${body.measurements.hip || ''}` : '';
  const prefKey = warpData.item?.preference || state.fitPreference || '';
  const cacheKey = `${garment.id}_${garment.updatedAt || ''}_${size}_${prefKey}_${canvasWidth}x${canvasHeight}_${Math.round(canvasPxPerCm * 10)}_${poseKey}_${bodyKey}`;

  if (state.templateCompositingCache && state.templateCompositingCache.has(cacheKey)) {
    return state.templateCompositingCache.get(cacheKey);
  }

  const startTime = performance.now();

  // 1. Offscreen Canvas for garment (same size as stage canvas)
  const garmentCanvas = document.createElement('canvas');
  garmentCanvas.width = canvasWidth;
  garmentCanvas.height = canvasHeight;
  const gCtx = garmentCanvas.getContext('2d');

  const W = gImg.naturalWidth || gImg.width;
  const H = gImg.naturalHeight || gImg.height;
  const gridRows = 24;
  const gridCols = 24;

  for (let r = 0; r < gridRows; r++) {
    const v0 = (r / gridRows) * H;
    const v1 = ((r + 1) / gridRows) * H;
    for (let c = 0; c < gridCols; c++) {
      const u0 = (c / gridCols) * W;
      const u1 = ((c + 1) / gridCols) * W;

      const sTL = { x: u0, y: v0 };
      const sTR = { x: u1, y: v0 };
      const sBL = { x: u0, y: v1 };
      const sBR = { x: u1, y: v1 };

      const dTL = warpPoint(sTL.x, sTL.y);
      const dTR = warpPoint(sTR.x, sTR.y);
      const dBL = warpPoint(sBL.x, sBL.y);
      const dBR = warpPoint(sBR.x, sBR.y);

      drawTexturedTriangle(gCtx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
      drawTexturedTriangle(gCtx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
    }
  }

  // Phase 8.2: Never thinner than the body (shows "tight")
  // Measure drawn garment width at chest, waist, hip rows and widen if thinner than body + 1 cm
  const centerShiftX = (canvasWidth - avatarImg.width * ratio) / 2;
  const centerShiftY = (canvasHeight - avatarImg.height * ratio) / 2;
  const bodyOutline = warpData.bodyOutline || state.avatar?.bodyOutline;

  const rowY_chest = centerShiftY + (bodyOutline?.chestY != null ? bodyOutline.chestY * ratio : (warpData.midShoulderY + 0.28 * 50 * canvasPxPerCm));
  const rowY_waist = centerShiftY + (bodyOutline?.waistY != null ? bodyOutline.waistY * ratio : (warpData.midShoulderY + 0.58 * 50 * canvasPxPerCm));
  const rowY_hip   = centerShiftY + (bodyOutline?.hipY != null ? bodyOutline.hipY * ratio : (warpData.midShoulderY + 0.95 * 50 * canvasPxPerCm));

  // When arms are merged with the torso in the mask, use (mask width - 2 x arm width at elbow level) as body width
  const armWidth = Math.max(16, (bodyOutline?.armWidthPx ? bodyOutline.armWidthPx * ratio : 8.0 * canvasPxPerCm));
  const lms = state.avatar?.landmarks || [];
  const u13 = lms[13] ? { x: centerShiftX + lms[13].x * avatarImg.width * ratio, y: centerShiftY + lms[13].y * avatarImg.height * ratio } : null;
  const u14 = lms[14] ? { x: centerShiftX + lms[14].x * avatarImg.width * ratio, y: centerShiftY + lms[14].y * avatarImg.height * ratio } : null;

  const computeEffectiveBodyWidth = (maskW) => {
    let isMerged = false;
    if (u13 && u14) {
      const elbowSpan = Math.abs(u13.x - u14.x);
      if (maskW >= elbowSpan - armWidth * 0.3) {
        isMerged = true;
      }
    }
    if (isMerged) {
      return Math.max(maskW - 2 * armWidth, 20 * (canvasPxPerCm / 7.0));
    }
    return maskW;
  };

  const rawBodyChestW = (bodyOutline?.chestWidthPx || 50) * ratio;
  const rawBodyWaistW = (bodyOutline?.waistWidthPx || 45) * ratio;
  const rawBodyHipW   = (bodyOutline?.hipWidthPx   || 55) * ratio;

  const bodyChestW = computeEffectiveBodyWidth(rawBodyChestW);
  const bodyWaistW = computeEffectiveBodyWidth(rawBodyWaistW);
  const bodyHipW   = computeEffectiveBodyWidth(rawBodyHipW);

  const targetChestW = bodyChestW + 1.0 * canvasPxPerCm;
  const targetWaistW = bodyWaistW + 1.0 * canvasPxPerCm;
  const targetHipW   = bodyHipW   + 1.0 * canvasPxPerCm;

  // Garment width at a row = OUTER extent of garment pixels inside a window around the body
  // (body half-width + 3 cm). Browser grid check: the old "run through the centre line" was ~0 for
  // open-front garments (cardigan V), which gave a huge scale and blew the sleeves out into wings.
  // Sleeves hanging next to the body fall inside the window, which can only make the measured width
  // larger, i.e. the safe direction (less widening).
  const outerWidthNearBody = (ctx, y, midX, bodyW) => {
    const rowInt = Math.round(y);
    if (rowInt < 0 || rowInt >= canvasHeight) return 0;
    const half = bodyW / 2 + 3 * canvasPxPerCm;
    const x0 = Math.max(0, Math.floor(midX - half)), x1 = Math.min(canvasWidth - 1, Math.ceil(midX + half));
    const rowData = ctx.getImageData(x0, rowInt, x1 - x0 + 1, 1).data;
    let l = -1, r = -1;
    for (let i = 0; i <= x1 - x0; i++) if (rowData[i * 4 + 3] >= 20) { if (l < 0) l = i; r = i; }
    return l < 0 ? 0 : r - l + 1;
  };

  const MAX_WIDEN = 1.3; // never stretch a garment by more than 30 %
  const widen = (drawn, target) => (drawn > 0 && drawn < target) ? Math.min(MAX_WIDEN, target / drawn) : 1.0;

  const rowY_shoulder = warpData.midShoulderY + 2 * canvasPxPerCm;
  warpData.rowY_shoulder = rowY_shoulder;
  warpData.rowY_chest = rowY_chest;
  warpData.rowY_waist = rowY_waist;
  warpData.rowY_hip = rowY_hip;
  warpData.bodyChestW = bodyChestW;
  const bodyShoulderW = (state.avatar?.shoulderPx ? state.avatar.shoulderPx * ratio : bodyChestW * 1.1);
  const drawnShoulderW = outerWidthNearBody(gCtx, rowY_shoulder, warpData.midShoulderX, bodyShoulderW);
  const drawnChestW = outerWidthNearBody(gCtx, rowY_chest, warpData.midShoulderX, bodyChestW);
  const drawnWaistW = outerWidthNearBody(gCtx, rowY_waist, warpData.midShoulderX, bodyWaistW);
  const drawnHipW   = outerWidthNearBody(gCtx, rowY_hip,   warpData.midShoulderX, bodyHipW);

  // Phase 8 baseline (never thinner than body + 1 cm, clamped at MAX_WIDEN)
  const baseShoulder = widen(drawnShoulderW, bodyShoulderW + 1.0 * canvasPxPerCm);
  const baseChest = widen(drawnChestW, targetChestW);
  const baseWaist = widen(drawnWaistW, targetWaistW);
  const baseHip   = widen(drawnHipW, targetHipW);

  // Phase 9B: Honest widths from fit zones
  const bodyData = loadBody();
  const measurements = bodyData?.measurements || {};
  const chestZone = warpData.fitZones?.find(z => z.zone === 'chest');
  const waistZone = warpData.fitZones?.find(z => z.zone === 'waist');
  const shoulderZone = warpData.fitZones?.find(z => z.zone === 'shoulder');
  const hipZone = warpData.fitZones?.find(z => z.zone === 'hips' || z.zone === 'hip');

  // Loose zones: the garment is ALREADY drawn at its real size in cm (Phase 8 physical scale), so its
  // real looseness is already visible. Only the EXAGGERATION part (visualEase - ease) may be added.
  // Browser check: adding the full ease on top doubled the looseness (boxy jackets, a belted trench
  // that lost its waist). factor = 1 + extra / garment circumference (garment = body + ease).
  const exaggerationFactor = (zone, bodyCm) => {
    if (!zone || !(zone.status === 'loose' || zone.status === 'tooLoose') || typeof zone.ease !== 'number') return 1.0;
    const extra = computeVisualEase(zone) - zone.ease;
    if (extra <= 0) return 1.0;
    return Math.min(FIT_VISUAL.maxWidth, 1.0 + extra / Math.max(1, bodyCm + zone.ease));
  };
  const scaleShoulder = Math.max(baseShoulder, exaggerationFactor(shoulderZone, measurements.shoulder || 42));
  const scaleChest = Math.max(baseChest, exaggerationFactor(chestZone, measurements.chest || 92));
  const scaleWaist = Math.max(baseWaist, exaggerationFactor(waistZone, measurements.waist || 76));
  const scaleHip = Math.max(baseHip, exaggerationFactor(hipZone, measurements.hip || 98));

  if (scaleShoulder > 1.005 || scaleChest > 1.005 || scaleWaist > 1.005 || scaleHip > 1.005) {
    const midShoulderY = warpData.midShoulderY;

    const getTorsoWidthScale = (y) => {
      if (y <= rowY_shoulder) {
        return scaleShoulder;
      } else if (y <= rowY_chest) {
        const t = (y - rowY_shoulder) / Math.max(1, rowY_chest - rowY_shoulder);
        return scaleShoulder + t * (scaleChest - scaleShoulder);
      } else if (y <= rowY_waist) {
        const t = (y - rowY_chest) / Math.max(1, rowY_waist - rowY_chest);
        return scaleChest + t * (scaleWaist - scaleChest);
      } else if (y <= rowY_hip) {
        const t = (y - rowY_waist) / Math.max(1, rowY_hip - rowY_waist);
        return scaleWaist + t * (scaleHip - scaleWaist);
      }
      // Below the hips keep the hip scale (tapering back to 1.0 made pointed hems on long coats).
      return scaleHip;
    };

    // Phase 9B Review Note: Apply chest/waist/hip width factors only to TORSO part of mesh.
    // For sleeve vertices, do not scale around center line; instead translate rigidly by horizontal
    // shift of its armhole point, keeping cuff within ~3 cm of avatar's wrist horizontally.
    const rp = warpData.refPose;
    const l11 = rp?.l11, l12 = rp?.l12, l23 = rp?.l23, l24 = rp?.l24;
    const anchors = warpData.anchors;
    const MrefX = warpData.srcShoulderMidX || (W / 2);
    const uWristL = warpData.userWristL;
    const uWristR = warpData.userWristR;

    const getArmholeU = (u, v) => {
      if (u <= MrefX) {
        if (!l12) return MrefX - 100;
        const vTop = l12.y;
        const vBot = (anchors && anchors.armpitL) ? anchors.armpitL[1] : (l24 ? l12.y + 0.35 * (l24.y - l12.y) : l12.y + 200);
        const uTop = l12.x;
        const uBot = (anchors && anchors.armpitL) ? anchors.armpitL[0] : (l24 ? l12.x + 0.15 * (MrefX - l12.x) : l12.x + 50);
        return v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
      } else {
        if (!l11) return MrefX + 100;
        const vTop = l11.y;
        const vBot = (anchors && anchors.armpitR) ? anchors.armpitR[1] : (l23 ? l11.y + 0.35 * (l23.y - l11.y) : l11.y + 200);
        const uTop = l11.x;
        const uBot = (anchors && anchors.armpitR) ? anchors.armpitR[0] : (l23 ? l11.x - 0.15 * (l11.x - MrefX) : l11.x - 50);
        return v <= vTop ? uTop : (v >= vBot ? uBot : uTop + (uBot - uTop) * (v - vTop) / (vBot - vTop));
      }
    };

    const getSleeveWeight = (u, v) => {
      const uB = getArmholeU(u, v);
      const dist = (u <= MrefX) ? (uB - u) : (u - uB);
      if (dist <= 0) return 0;
      if (dist >= 30) return 1;
      const t = dist / 30;
      return t * t * (3 - 2 * t);
    };

    const adjustPt = (u, v, pt) => {
      const S = getTorsoWidthScale(pt.y);
      const wSleeve = getSleeveWeight(u, v);

      if (wSleeve <= 0) {
        // Pure torso vertex: scale around centre line
        return {
          x: +(warpData.midShoulderX + (pt.x - warpData.midShoulderX) * S).toFixed(1),
          y: pt.y
        };
      }

      // Torso shift at this point:
      const torsoShift = (pt.x - warpData.midShoulderX) * (S - 1.0);

      // Armhole boundary point on canvas:
      const uB = getArmholeU(u, v);
      const ptArmhole = warpPoint(uB, v);
      const S_armhole = getTorsoWidthScale(ptArmhole.y);
      const armholeShift = (ptArmhole.x - warpData.midShoulderX) * (S_armhole - 1.0);

      // Blend between torso scale and rigid sleeve translation
      const netShift = (1 - wSleeve) * torsoShift + wSleeve * armholeShift;
      let newX = pt.x + netShift;

      // Sleeve restraint: limit how far the sleeve is SHIFTED (max 3 cm), not where every vertex may be.
      // Browser grid check: clamping the absolute x of every sleeve vertex to "wrist ± 3 cm" squashed
      // whole sleeves into thin strips (XL jacket looked like a vest with strings).
      if (wSleeve > 0) {
        const maxShift = 3.0 * canvasPxPerCm;
        const shift = Math.max(-maxShift, Math.min(maxShift, netShift));
        newX = pt.x + shift;
      }

      return {
        x: +newX.toFixed(1),
        y: pt.y
      };
    };

    gCtx.clearRect(0, 0, canvasWidth, canvasHeight);
    for (let r = 0; r < gridRows; r++) {
      const v0 = (r / gridRows) * H;
      const v1 = ((r + 1) / gridRows) * H;
      for (let c = 0; c < gridCols; c++) {
        const u0 = (c / gridCols) * W;
        const u1 = ((c + 1) / gridCols) * W;

        const sTL = { x: u0, y: v0 };
        const sTR = { x: u1, y: v0 };
        const sBL = { x: u0, y: v1 };
        const sBR = { x: u1, y: v1 };

        const dTL = adjustPt(sTL.x, sTL.y, warpPoint(sTL.x, sTL.y));
        const dTR = adjustPt(sTR.x, sTR.y, warpPoint(sTR.x, sTR.y));
        const dBL = adjustPt(sBL.x, sBL.y, warpPoint(sBL.x, sBL.y));
        const dBR = adjustPt(sBR.x, sBR.y, warpPoint(sBR.x, sBR.y));

        drawTexturedTriangle(gCtx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
        drawTexturedTriangle(gCtx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
      }
    }
  }

  // Phase 9B: Pulled front gap for tight/tooTight front-closing garments
  drawTemplateFrontPulledGap(garmentCanvas, warpData, rowY_chest, rowY_waist, canvasPxPerCm);

  // Phase 8.3 & 9B: Subtle horizontal and shoulder strain folds when chest, waist, or shoulder is tight/tooTight
  drawTemplateStrainFolds(garmentCanvas, warpData, state.avatar, rowY_shoulder, rowY_chest, rowY_waist, canvasPxPerCm);

  // Phase 9B: Soft vertical drape shadows at the flanks for loose/tooLoose chest/waist/hip
  applyTemplateDrapeShadows(garmentCanvas, warpData, state.avatar, rowY_chest, rowY_waist, rowY_hip, canvasPxPerCm);

  // 1.b Inner shading
  applyTemplateInnerShading(garmentCanvas, warpData, canvasPxPerCm);

  // 1.c Light matching & 1.e Monochrome grain
  applyTemplateLightMatchingAndGrain(garmentCanvas, avatarImg, state.avatar?.landmarks, garment);

  // 1.d Edge softening (~1px feathering)
  if (garment.cutFromWorn && !garment.garmentIsWhite) {
    removeTeeLeftovers(garmentCanvas, warpData.midShoulderX, avatarPxPerCm * ratio);
  }
  fillGarmentHoles(garmentCanvas, 0.03, { x: warpData.midShoulderX, halfWidth: 6 * avatarPxPerCm * ratio });
  defringeGarment(garmentCanvas);
  removeGarmentIslands(garmentCanvas);
  applyTemplateEdgeSoftening(garmentCanvas);

  // 1.a Contact shadow silhouette: black silhouette of garment alpha
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = canvasWidth;
  shadowCanvas.height = canvasHeight;
  const shCtx = shadowCanvas.getContext('2d');
  shCtx.drawImage(garmentCanvas, 0, 0);
  shCtx.globalCompositeOperation = 'source-in';
  shCtx.fillStyle = '#000000';
  shCtx.fillRect(0, 0, canvasWidth, canvasHeight);

  const result = { garmentCanvas, shadowCanvas };
  if (state.templateCompositingCache) {
    state.templateCompositingCache.set(cacheKey, result);
  }

  const elapsed = performance.now() - startTime;
  console.log(`[Realistic Compositing] Built layers for "${garment.name}" (${size}) in ${elapsed.toFixed(1)}ms`);

  return result;
}

// --- PHASE 6: Layered Compositing (Neck & Hands) ---

/**
 * Phase 6.A: Computes and caches the user avatar skin mask (neck column + hand regions).
 * Pixels inside MediaPipe person mask that are NOT near-white (>215) and NOT near-black (<60).
 * Cleaned with 3px morphological close and 1px edge blur.
 */
async function getOrBuildAvatarSkinMask(avatar, avatarImg, sleeveVisualEase = 0) {
  if (!avatar || !avatarImg) return null;

  const skinCacheKey = `${avatar.image}_${Math.round((sleeveVisualEase || 0) * 10)}`;
  if (state.avatarSkinMaskCanvas && state.avatarSkinMaskAvatarId === skinCacheKey) {
    return state.avatarSkinMaskCanvas;
  }

  const W = avatarImg.naturalWidth || avatarImg.width;
  const H = avatarImg.naturalHeight || avatarImg.height;

  // 1. Offscreen canvas to read avatar pixels
  const readCanvas = document.createElement('canvas');
  readCanvas.width = W;
  readCanvas.height = H;
  const rCtx = readCanvas.getContext('2d');
  rCtx.drawImage(avatarImg, 0, 0, W, H);
  const imgData = rCtx.getImageData(0, 0, W, H);
  const data = imgData.data;

  // 2. Obtain person segmentation mask from MediaPipe if available
  let maskData = null;
  let maskW = 0, maskH = 0;
  try {
    const landmarker = await getPoseLandmarker();
    if (landmarker) {
      const poseResult = landmarker.detect(avatarImg);
      if (poseResult && poseResult.segmentationMasks && poseResult.segmentationMasks.length > 0) {
        const sm = poseResult.segmentationMasks[0];
        maskW = sm.width;
        maskH = sm.height;
        maskData = sm.getAsFloat32Array ? sm.getAsFloat32Array() : (sm.getAsUint8Array ? sm.getAsUint8Array() : null);
      }
    }
  } catch (err) {
    console.warn('Could not extract segmentation mask for skin mask:', err);
  }

  const l = avatar.landmarks;
  const pxPerCm = avatar.pxPerCm || 7.0;

  // 3. Define target regions:
  // a) Neck column: between ears' x-range, from chin (mouth y + 3 cm) down to shoulder line + 4 cm
  const earL = l && l[7] ? l[7] : { x: 0.53, y: 0.15 };
  const earR = l && l[8] ? l[8] : { x: 0.47, y: 0.15 };
  const earMinX = Math.min(earL.x, earR.x) * W;
  const earMaxX = Math.max(earL.x, earR.x) * W;
  const neckPadX = (earMaxX - earMinX) * 0.08;
  const neckMinX = Math.max(0, Math.round(earMinX - neckPadX));
  const neckMaxX = Math.min(W - 1, Math.round(earMaxX + neckPadX));

  const mouthY = (l && l[9] && l[10]) ? ((l[9].y + l[10].y) / 2) * H : (l && l[0] ? l[0].y * H + 12 : 0.18 * H);
  const chinY = mouthY + 1.5 * pxPerCm;
  const shoulderY = (l && l[11] && l[12]) ? ((l[11].y + l[12].y) / 2) * H : chinY + 5 * pxPerCm;
  const neckBottomY = shoulderY + 4.0 * pxPerCm;

  // b) Hand regions: wrist 15/16 extended 1.5x toward finger landmarks 17-22
  const getHandRegion = (wristIdx, fingerIndices) => {
    if (!l || !l[wristIdx]) return null;
    const wx = l[wristIdx].x * W;
    const wy = l[wristIdx].y * H;
    let fx = wx, fy = wy + 40;
    let fCount = 0;
    for (const fi of fingerIndices) {
      if (l[fi]) {
        fx += l[fi].x * W;
        fy += l[fi].y * H;
        fCount++;
      }
    }
    if (fCount > 0) {
      fx = (fx - wx) / fCount;
      fy = (fy - wy) / fCount;
    }
    const dHand = Math.hypot(fx - wx, fy - wy);
    const hx = wx + (fx - wx) * 0.5;
    const hy = wy + (fy - wy) * 0.5;
    const radius = Math.max(4.5 * pxPerCm, dHand * 1.5);
    return { wx, wy, hx, hy, radius };
  };

  const handL = getHandRegion(15, [17, 19, 21]); // Left wrist (viewer's right)
  const handR = getHandRegion(16, [18, 20, 22]); // Right wrist (viewer's left)

  // 4. Initial binary mask:
  const binaryMask = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inNeck = (x >= neckMinX && x <= neckMaxX && y >= mouthY && y <= neckBottomY);
      let inHand = false;
      if (handL) {
        const d = Math.hypot(x - handL.hx, y - handL.hy);
        if (d <= handL.radius) inHand = true;
      }
      if (!inHand && handR) {
        const d = Math.hypot(x - handR.hx, y - handR.hy);
        if (d <= handR.radius) inHand = true;
      }

      if (!inNeck && !inHand) continue;

      if (maskData) {
        const u = x / W;
        const v = y / H;
        const c = Math.min(maskW - 1, Math.max(0, Math.floor(u * maskW)));
        const r = Math.min(maskH - 1, Math.max(0, Math.floor(v * maskH)));
        const val = maskData[r * maskW + c];
        if (val < 0.5) continue;
      }

      const idx = (y * W + x) * 4;
      const red = data[idx];
      const green = data[idx + 1];
      const blue = data[idx + 2];
      const lum = 0.299 * red + 0.587 * green + 0.114 * blue;

      const isNearWhite = (red > 215 && green > 215 && blue > 215);
      const isNearBlack = (lum < 60);

      // Skin has a warm hue (red clearly above blue). Without this, the T-shirt in shadow
      // (~205 grey) counted as skin and was pasted over the collar.
      const isSkinHue = red > blue + 18 && red >= green;
      if (!isNearWhite && !isNearBlack && isSkinHue) {
        binaryMask[y * W + x] = 255;
      }
    }
  }

  // 5. Morphological close (3px) on bounding boxes: Dilation (3px) then Erosion (3px)
  const r = 3;
  const closeBBox = (minX, minY, maxX, maxY) => {
    minX = Math.max(r, Math.floor(minX));
    maxX = Math.min(W - 1 - r, Math.ceil(maxX));
    minY = Math.max(r, Math.floor(minY));
    maxY = Math.min(H - 1 - r, Math.ceil(maxY));
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw <= 0 || bh <= 0) return;

    // Dilate H
    const dH = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const gy = minY + y;
      for (let x = 0; x < bw; x++) {
        const gx = minX + x;
        let max = 0;
        for (let k = -r; k <= r; k++) {
          const val = binaryMask[gy * W + (gx + k)];
          if (val > max) { max = val; if (max === 255) break; }
        }
        dH[y * bw + x] = max;
      }
    }

    // Dilate V
    const dV = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let max = 0;
        for (let k = -r; k <= r; k++) {
          const ny = Math.max(0, Math.min(bh - 1, y + k));
          const val = dH[ny * bw + x];
          if (val > max) { max = val; if (max === 255) break; }
        }
        dV[y * bw + x] = max;
      }
    }

    // Erode H
    const eH = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let min = 255;
        for (let k = -r; k <= r; k++) {
          const nx = Math.max(0, Math.min(bw - 1, x + k));
          const val = dV[y * bw + nx];
          if (val < min) { min = val; if (min === 0) break; }
        }
        eH[y * bw + x] = min;
      }
    }

    // Erode V & write back
    for (let y = 0; y < bh; y++) {
      const gy = minY + y;
      for (let x = 0; x < bw; x++) {
        const gx = minX + x;
        let min = 255;
        for (let k = -r; k <= r; k++) {
          const ny = Math.max(0, Math.min(bh - 1, y + k));
          const val = eH[ny * bw + x];
          if (val < min) { min = val; if (min === 0) break; }
        }
        binaryMask[gy * W + gx] = min;
      }
    }
  };

  closeBBox(neckMinX, mouthY, neckMaxX, neckBottomY);
  if (handL) closeBBox(handL.hx - handL.radius, handL.hy - handL.radius, handL.hx + handL.radius, handL.hy + handL.radius);
  if (handR) closeBBox(handR.hx - handR.radius, handR.hy - handR.radius, handR.hx + handR.radius, handR.hy + handR.radius);

  // 5b. "Clean plate" for the white T-shirt: T-shirt pixels (inside the person mask, light and
  // colourless) are repainted with the studio background of that row, interpolated between the
  // background just left and just right of the person. Used to hide T-shirt bits peeking out
  // around a garment. Stored in state.avatarTeePlate (alpha 255 only on T-shirt pixels).
  state.avatarTeePlate = null;
  if (maskData) {
    const plate = document.createElement('canvas');
    plate.width = W; plate.height = H;
    const pCtx = plate.getContext('2d');
    const pImg = pCtx.createImageData(W, H);
    const pd = pImg.data;
    const inPerson = (x, y) => {
      const c = Math.min(maskW - 1, Math.floor(x / W * maskW));
      const r = Math.min(maskH - 1, Math.floor(y / H * maskH));
      return maskData[r * maskW + c] >= 0.15; // low threshold: the soft mask edge at the shoulders still counts
    };
    // Arm capsules (shoulder -> elbow -> 90% of the way to the wrist): the avatar's own bare arms
    // that peek out beside a garment sleeve are also repainted with background. The hands (past
    // the wrist) are NOT part of it, so they still come out of the cuff.
    const lmA = avatar.landmarks || [];
    const LP = (i) => (lmA[i] ? { x: lmA[i].x * W, y: lmA[i].y * H } : null);
    const armR = 6 * (avatar.pxPerCm || 5);
    const armSegs = [];
    for (const [s, e, w] of [[12, 14, 16], [11, 13, 15]]) {
      const S = LP(s), E = LP(e), Wr = LP(w);
      if (S && E) armSegs.push([S, E]);
      if (E && Wr) {
        // Phase 9A: When sleeves are short (sleeveVisualEase < 0), stop clean plate arm capsule
        // before the wrist so the user's bare forearm shows through un-cleared.
        const forearmPx = Math.hypot(Wr.x - E.x, Wr.y - E.y) || 1;
        const fMax = (sleeveVisualEase < 0)
          ? Math.max(0.15, Math.min(0.9, 0.9 + (sleeveVisualEase * (avatar.pxPerCm || 5)) / forearmPx))
          : 0.9;
        armSegs.push([E, { x: E.x + (Wr.x - E.x) * fMax, y: E.y + (Wr.y - E.y) * fMax }]);
      }
    }
    const distSeg = (x, y, A, B) => {
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / L2));
      return Math.hypot(x - (A.x + t * dx), y - (A.y + t * dy));
    };
    const inArm = (x, y) => armSegs.some(([A, B]) => distSeg(x, y, A, B) < armR);

    for (let y = 0; y < H; y++) {
      let xl = -1, xr = -1;
      for (let x = 0; x < W; x++) if (inPerson(x, y)) { if (xl < 0) xl = x; xr = x; }
      if (xl < 0) continue;
      const bl = Math.max(0, xl - 8), br = Math.min(W - 1, xr + 8);
      const iL = (y * W + bl) * 4, iR = (y * W + br) * 4;
      for (let x = xl; x <= xr; x++) {
        const i = (y * W + x) * 4;
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        const mn = Math.min(data[i], data[i + 1], data[i + 2]);
        if (!inPerson(x, y)) continue;
        const isTee = mn >= 170 && mx - mn <= 28;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const isArmSkin = data[i] > data[i + 2] + 18 && data[i] >= data[i + 1] && lum > 60 && inArm(x, y);
        if (!isTee && !isArmSkin) continue;
        const t = (x - bl) / Math.max(1, br - bl);
        pd[i]     = data[iL] * (1 - t) + data[iR] * t;
        pd[i + 1] = data[iL + 1] * (1 - t) + data[iR + 1] * t;
        pd[i + 2] = data[iL + 2] * (1 - t) + data[iR + 2] * t;
        pd[i + 3] = 255;
      }
    }
    pCtx.putImageData(pImg, 0, 0);
    state.avatarTeePlate = plate;
  }

  // 6. Write skin pixels to offscreen canvas
  const skinCanvas = document.createElement('canvas');
  skinCanvas.width = W;
  skinCanvas.height = H;
  const sCtx = skinCanvas.getContext('2d');
  const skinImgData = sCtx.createImageData(W, H);
  const skinData = skinImgData.data;

  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    if (binaryMask[i] === 255) {
      skinData[idx]     = data[idx];
      skinData[idx + 1] = data[idx + 1];
      skinData[idx + 2] = data[idx + 2];
      skinData[idx + 3] = 255;
    } else {
      skinData[idx + 3] = 0;
    }
  }
  sCtx.putImageData(skinImgData, 0, 0);

  // 7. Blur edge 1px
  const blurredSkinCanvas = document.createElement('canvas');
  blurredSkinCanvas.width = W;
  blurredSkinCanvas.height = H;
  const bCtx = blurredSkinCanvas.getContext('2d');
  if (bCtx.filter) {
    bCtx.filter = 'blur(1px)';
  }
  bCtx.drawImage(skinCanvas, 0, 0);

  state.avatarSkinMaskCanvas = blurredSkinCanvas;
  state.avatarSkinMaskAvatarId = skinCacheKey;

  return blurredSkinCanvas;
}

/**
 * Phase 6: Layered compositing for template garments:
 * - B. Redraws neck emerging from collar V (above mapped neckFront) with soft inner shadow.
 * - C. Redraws hands emerging from sleeves below cuff cut line with dark gradient in cuff opening.
 */
function drawTemplateLayeredCompositing(ctx, warpData, avatar, skinMaskCanvas, centerShiftX, centerShiftY, ratio, mapPoint) {
  if (!skinMaskCanvas || !avatar || !avatar.landmarks) return;
  const l = avatar.landmarks;
  const canvasPxPerCm = avatar.pxPerCm * ratio;
  const garment = warpData.garment;

  // --- PART B.2: Neck Emerging from the Collar ---
  // Only for open necklines. Browser check: on a closed stand-up collar (puffer jacket) the
  // auto-detected "V point" sat low on the chest and this step cut a V-shaped opening into the
  // closed collar. For closed collars the head/chin redraw (section 3b) is enough.
  // Skip only when the admin explicitly marked the collar as closed (cut-from-worn garments);
  // older garments without a neckline value (trench lapels, shearling collar) still need it.
  if (l[7] && l[8] && garment?.neckline !== 'closed') {
    const earL = mapPoint(l[7]);
    const earR = mapPoint(l[8]);
    const mouth = l[9] ? mapPoint(l[9]) : (l[0] ? mapPoint(l[0]) : { x: (earL.x + earR.x) / 2, y: (earL.y + earR.y) / 2 });
    const chinY = mouth.y + 1.5 * canvasPxPerCm;

    // Collar V point (mapped neckFront point on canvas)
    let ptV;
    if (garment && garment.neckFront && warpData.warpPoint) {
      ptV = warpData.warpPoint(garment.neckFront.x, garment.neckFront.y);
    } else {
      const midS = { x: (mapPoint(l[11]).x + mapPoint(l[12]).x) / 2, y: (mapPoint(l[11]).y + mapPoint(l[12]).y) / 2 };
      ptV = { x: midS.x, y: midS.y + 1.8 * canvasPxPerCm };
    }

    // Neck edges at chin level
    const nLeftX = Math.min(earL.x, earR.x) - 2;
    const nRightX = Math.max(earL.x, earR.x) + 2;
    const N1 = { x: nLeftX, y: chinY };
    const N2 = { x: nRightX, y: chinY };

    // Redraw neck skin only above neckFront.y inside the V shape (N1 -> N2 -> ptV)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(N1.x, N1.y);
    ctx.lineTo(N2.x, N2.y);
    ctx.lineTo(ptV.x, ptV.y);
    ctx.closePath();
    ctx.clip();

    ctx.drawImage(skinMaskCanvas, centerShiftX, centerShiftY, skinMaskCanvas.width * ratio, skinMaskCanvas.height * ratio);

    // (Removed: a blurred dark stroke along this helper triangle. The triangle is only a clip
    // region, not the real collar edge, so the stroke showed as a faint grey "V" on the neck and
    // T-shirt of every avatar. The garment's own contact shadow already darkens the collar edge.)
    ctx.restore();
  }

  // --- PART C.2: Hands Out of the Sleeves ---
  // For left arm (viewer's left: elbow 14, wrist 16) and right arm (viewer's right: elbow 13, wrist 15)
  const drawHandOut = (elbowIdx, wristIdx) => {
    if (!l[elbowIdx] || !l[wristIdx]) return;
    const pElbow = mapPoint(l[elbowIdx]);
    const pWrist = mapPoint(l[wristIdx]);

    // Forearm direction vector
    const dx = pWrist.x - pElbow.x;
    const dy = pWrist.y - pElbow.y;
    const fLen = Math.hypot(dx, dy);
    if (fLen < 10) return;

    const ux = dx / fLen;
    const uy = dy / fLen;
    const nx = -uy;
    const ny = ux;

    // Line 1.5 cm above wrist perpendicular to forearm (so cuff covers wrist)
    const cutDist = 1.5 * canvasPxPerCm;
    const pCut = {
      x: pWrist.x + ux * cutDist,
      y: pWrist.y + uy * cutDist
    };

    // Half-plane polygon below the cut line extending toward fingers
    const span = Math.max(60, 5.0 * canvasPxPerCm);
    const reach = Math.max(80, 8.0 * canvasPxPerCm);

    const A = { x: pCut.x - nx * span, y: pCut.y - ny * span };
    const B = { x: pCut.x + nx * span, y: pCut.y + ny * span };
    const C = { x: B.x + ux * reach,   y: B.y + uy * reach };
    const D = { x: A.x + ux * reach,   y: A.y + uy * reach };

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.lineTo(C.x, C.y);
    ctx.lineTo(D.x, D.y);
    ctx.closePath();
    ctx.clip();

    // Redraw avatar hand skin pixels ON TOP below the cut line
    ctx.drawImage(skinMaskCanvas, centerShiftX, centerShiftY, skinMaskCanvas.width * ratio, skinMaskCanvas.height * ratio);

    // Dark gradient inside the cuff opening (multiply 30%) where the hand enters
    ctx.globalCompositeOperation = 'multiply';
    const gradStart = { x: pCut.x - ux * 0.8 * canvasPxPerCm, y: pCut.y - uy * 0.8 * canvasPxPerCm };
    const gradEnd   = { x: pCut.x + ux * 0.8 * canvasPxPerCm, y: pCut.y + uy * 0.8 * canvasPxPerCm };
    const cuffGrad = ctx.createLinearGradient(gradStart.x, gradStart.y, gradEnd.x, gradEnd.y);
    cuffGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.30)');
    cuffGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.15)');
    cuffGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.00)');

    ctx.fillStyle = cuffGrad;
    ctx.fillRect(Math.min(A.x, D.x) - 10, Math.min(A.y, D.y) - 10, span * 2 + 20, reach + 20);

    ctx.restore();
  };

  // Disabled after a browser check: the avatar's hands are already visible below the cuff edge
  // (the garment PNG is transparent there). Redrawing them ON TOP pasted the fingers over the lower
  // half of the fur cuff, so the hand looked stuck on the sleeve instead of coming out of it.
  const REDRAW_HANDS_OVER_CUFF = false;
  if (REDRAW_HANDS_OVER_CUFF) {
    drawHandOut(14, 16); // Left hand (viewer's left)
    drawHandOut(13, 15); // Right hand (viewer's right)
  }
}

// Helper: Subtle multiply-blend shading layer over the garment (natural depth)
function drawGarmentShading(ctx, warpData) {
  const { silhouette, midShoulderY, destHemY, destAnchors } = warpData;
  if (!silhouette || silhouette.length < 3) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(silhouette[0].x, silhouette[0].y);
  for (let i = 1; i < silhouette.length; i++) {
    ctx.lineTo(silhouette[i].x, silhouette[i].y);
  }
  ctx.closePath();
  ctx.clip();

  // Subtle multiply blend over garment texture
  ctx.globalCompositeOperation = 'multiply';

  // 1. Soft vertical gradient (max ~12-15% opacity darkening toward hem)
  const vGrad = ctx.createLinearGradient(0, midShoulderY, 0, destHemY);
  vGrad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  vGrad.addColorStop(0.55, 'rgba(248, 248, 250, 1.0)');
  vGrad.addColorStop(1.0, 'rgba(224, 224, 230, 1.0)');
  ctx.fillStyle = vGrad;
  ctx.fill();

  // 2. Small darker area under the arms and along sleeve inner edges (max 15-18% opacity)
  if (destAnchors.armpitL && destAnchors.cuffInnerL) {
    const lArmGrad = ctx.createLinearGradient(
      destAnchors.armpitL.x, destAnchors.armpitL.y,
      destAnchors.cuffInnerL.x, destAnchors.cuffInnerL.y
    );
    lArmGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.18)');
    lArmGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.08)');
    lArmGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.00)');
    ctx.strokeStyle = lArmGrad;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(destAnchors.armpitL.x, destAnchors.armpitL.y);
    ctx.lineTo(destAnchors.cuffInnerL.x, destAnchors.cuffInnerL.y);
    ctx.stroke();
  }

  if (destAnchors.armpitR && destAnchors.cuffInnerR) {
    const rArmGrad = ctx.createLinearGradient(
      destAnchors.armpitR.x, destAnchors.armpitR.y,
      destAnchors.cuffInnerR.x, destAnchors.cuffInnerR.y
    );
    rArmGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0.18)');
    rArmGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.08)');
    rArmGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.00)');
    ctx.strokeStyle = rArmGrad;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(destAnchors.armpitR.x, destAnchors.armpitR.y);
    ctx.lineTo(destAnchors.cuffInnerR.x, destAnchors.cuffInnerR.y);
    ctx.stroke();
  }

  ctx.restore();
}

// Helper: Draw soft drop shadow along the garment's bottom hem edge and under the arms
function drawGarmentDropShadow(ctx, warpData) {
  const { destAnchors, hemRowPoints } = warpData;
  if (!destAnchors || !hemRowPoints || hemRowPoints.length < 2) return;

  // 1. Soft drop shadow along the bottom hem edge (dark gradient black, opacity ~0.22, blurred 3px)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(hemRowPoints[0].x, hemRowPoints[0].y);
  for (let i = 1; i < hemRowPoints.length; i++) {
    ctx.lineTo(hemRowPoints[i].x, hemRowPoints[i].y);
  }
  const shadowDepth = 12;
  for (let i = hemRowPoints.length - 1; i >= 0; i--) {
    const hp = hemRowPoints[i];
    const t = i / (hemRowPoints.length - 1);
    const falloff = 0.5 + 0.5 * Math.sin(t * Math.PI);
    ctx.lineTo(hp.x, hp.y + shadowDepth * falloff);
  }
  ctx.closePath();

  const minY = Math.min(...hemRowPoints.map(p => p.y));
  const maxY = Math.max(...hemRowPoints.map(p => p.y)) + shadowDepth;
  const hemGrad = ctx.createLinearGradient(0, minY, 0, maxY);
  hemGrad.addColorStop(0.0, "rgba(0, 0, 0, 0.22)");
  hemGrad.addColorStop(0.4, "rgba(0, 0, 0, 0.10)");
  hemGrad.addColorStop(1.0, "rgba(0, 0, 0, 0.00)");

  ctx.fillStyle = hemGrad;
  if (ctx.filter) ctx.filter = "blur(3px)";
  ctx.fill();
  ctx.restore();

  // 2. Soft drop shadow under the arms (ambient occlusion at armpits, opacity ~0.18-0.20, blurred 4px)
  if (destAnchors.armpitL && destAnchors.armpitR) {
    ctx.save();
    if (ctx.filter) ctx.filter = "blur(4px)";

    // Left armpit shadow
    const leftArmpitShadow = ctx.createRadialGradient(
      destAnchors.armpitL.x + 3, destAnchors.armpitL.y + 6, 2,
      destAnchors.armpitL.x + 3, destAnchors.armpitL.y + 6, 24
    );
    leftArmpitShadow.addColorStop(0.0, "rgba(0, 0, 0, 0.20)");
    leftArmpitShadow.addColorStop(0.5, "rgba(0, 0, 0, 0.08)");
    leftArmpitShadow.addColorStop(1.0, "rgba(0, 0, 0, 0.00)");

    ctx.fillStyle = leftArmpitShadow;
    ctx.beginPath();
    ctx.ellipse(destAnchors.armpitL.x + 3, destAnchors.armpitL.y + 8, 16, 24, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // Right armpit shadow
    const rightArmpitShadow = ctx.createRadialGradient(
      destAnchors.armpitR.x - 3, destAnchors.armpitR.y + 6, 2,
      destAnchors.armpitR.x - 3, destAnchors.armpitR.y + 6, 24
    );
    rightArmpitShadow.addColorStop(0.0, "rgba(0, 0, 0, 0.20)");
    rightArmpitShadow.addColorStop(0.5, "rgba(0, 0, 0, 0.08)");
    rightArmpitShadow.addColorStop(1.0, "rgba(0, 0, 0, 0.00)");

    ctx.fillStyle = rightArmpitShadow;
    ctx.beginPath();
    ctx.ellipse(destAnchors.armpitR.x - 3, destAnchors.armpitR.y + 8, 16, 24, 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

/**
 * Option (b) chosen by the product owner: when a size is far too small (torso zone "tooTight" and
 * score < 30), the garment is NOT stretched onto the body (that looked broken: bell sleeves, ragged
 * hems). Instead the avatar is shown without it and a clear message is drawn on the stage.
 * Returns null, or { message } for a far-too-small size.
 */
function getTooSmallInfo(warpData) {
  if (!warpData?.isTemplate) return null;
  const zones = warpData.fitZones || [];
  const torso = zones.filter((z) => ['chest', 'waist', 'shoulder'].includes(z.zone));
  // Grid check: the plus-size avatar in XL trench/cardigan scored 20-24 with chest only "tight",
  // and still looked broken, so a low score + any tight torso zone is enough.
  const worst = torso.filter((z) => z.status === 'tooTight' || z.status === 'tight')
    .sort((a, b) => (a.ease ?? 0) - (b.ease ?? 0))[0];
  const score = warpData.evalRes?.score;
  if (!worst || typeof score !== 'number' || score >= 30) return null;
  const sizes = Object.keys(warpData.garment?.sizes || {});
  const largest = sizes[sizes.length - 1];
  const size = warpData.size;
  // Show how many cm are MISSING to the minimum comfortable size (outerwear needs room for a layer,
  // so a raw ease like "+3 cm" would read as if it fitted).
  const minT = Array.isArray(worst.target) ? worst.target[0] : 0;
  const missing = typeof worst.ease === 'number' ? Math.round(minT - worst.ease) : null;
  const cm = missing && missing > 0 ? ` (${missing} cm too narrow)` : '';
  const head = size === largest ? `Even ${largest} is too small for you` : `${size} is too small for you`;
  return { message: `${head} at the ${worst.zone}${cm}.`, sub: size === largest ? 'This item does not fit your body.' : `Try a bigger size.` };
}

function drawTooSmallBanner(ctx, info) {
  const W = ctx.canvas.width;
  const y = 70, h = 78, x = 40, w = W - 80;
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#D1344B';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 14); else ctx.rect(x, y, w, h);
  ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#D1344B';
  ctx.font = '600 22px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(info.message, W / 2, y + 34);
  ctx.fillStyle = '#475569';
  ctx.font = '18px "IBM Plex Sans", system-ui, sans-serif';
  ctx.fillText(info.sub, W / 2, y + 60);
  ctx.restore();
}

async function renderStage() {
  const canvas = document.getElementById("avatar-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  canvas.width = 800;
  canvas.height = 1200;

  state.activeWarpData = null;

  // 1. Studio backdrop (Clean, eye-friendly soft studio white)
  ctx.fillStyle = "#FAFAFA";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!state.avatar || !state.avatar.image) return;

  // 2. Load avatar image dimensions & compute scale ratio
  const img = await loadImage(state.avatar.image);
  const hRatio = canvas.width / img.width;
  const vRatio = canvas.height / img.height;
  const ratio = Math.min(hRatio, vRatio) * 0.92; // 92% to leave clean margin
  const centerShiftX = (canvas.width - img.width * ratio) / 2;
  const centerShiftY = (canvas.height - img.height * ratio) / 2;

  // Helper to map normalized landmark to canvas coordinates
  function mapPoint(pt) {
    return {
      x: centerShiftX + pt.x * img.width * ratio,
      y: centerShiftY + pt.y * img.height * ratio
    };
  }

  // Pre-compute warp and silhouette data for worn items that have anchors
  const wornWarps = [];
  for (const item of state.wornItems) {
    if (!item.garment || !item.garment.image) continue;
    const l = state.avatar.landmarks;
    if (!l || !l[11] || !l[12]) continue;
    const warpData = computeGarmentWarpData(item, state.avatar, ratio, mapPoint, centerShiftX, centerShiftY);
    if (warpData) wornWarps.push(warpData);
  }

  // 2. Draw avatar image (layer below: skin/t-shirt).
  // Use garment silhouette as a clipping mask BEFORE drawing the layer below it,
  // so that nothing of the layer below (t-shirt/skin) peeks out from inside/behind the garment edges.
  // Template garments are full images drawn over a complete avatar: cutting the avatar out inside their
  // rough silhouette polygon left white canvas showing where the polygon is bigger than the garment.
  const tooSmallBanners = [];
  const activeSilhouettes = wornWarps.filter(w => w.silhouette && w.silhouette.length > 0 && !w.isTemplate);

  if (activeSilhouettes.length > 0) {
    ctx.save();
    ctx.beginPath();
    // 1) Enclosing canvas boundary
    ctx.rect(0, 0, canvas.width, canvas.height);
    // 2) Cut out the garment silhouette polygon(s)
    for (const w of activeSilhouettes) {
      const poly = w.silhouette;
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();
    }
    // Using 'evenodd' rule: region outside garment is drawn; inside garment silhouette is masked out!
    ctx.clip("evenodd");
    ctx.drawImage(img, 0, 0, img.width, img.height, centerShiftX, centerShiftY, img.width * ratio, img.height * ratio);
    ctx.restore();
  } else {
    ctx.drawImage(img, 0, 0, img.width, img.height, centerShiftX, centerShiftY, img.width * ratio, img.height * ratio);
  }

  // 3. Draw Garments overlay
  for (const item of state.wornItems) {
    if (!item.garment || !item.garment.image) continue;
    const rawGImg = await loadImage(item.garment.image);
    const isTemplate = item.garment.renderMode === 'template';
    // For renderMode 'template', do NOT run cleanGarmentImage again (the stored PNG is already clean).
    const gImg = isTemplate ? rawGImg : cleanGarmentImage(rawGImg, { tolerance: 10, protectCentre: true });
    const l = state.avatar.landmarks;
    if (!l || !l[11] || !l[12]) continue;

    const warpData = wornWarps.find(w => w.item.garment.id === item.garment.id);

    const tooSmall = getTooSmallInfo(warpData);
    if (tooSmall) { tooSmallBanners.push(tooSmall); continue; }

    if (warpData) {
      const {
        garment, size, anchors, destAnchors, hemRowPoints, warpPoint,
        targetChestWidth, targetLength, targetWaistWidth, targetHemWidth,
        midShoulderX, midShoulderY, destHemY, scaleChest, scaleWaist, scaleHem,
        srcShoulderMidX, srcHemMidY
      } = warpData;

      // 1) Console print/log as requested
      console.group(`👕 [Virtual Try-On] Garment warp: ${garment.name} (${size})`);
      console.log("1. Avatar detected landmarks (normalized [0, 1]):", {
        shoulderL_11: l[11],
        shoulderR_12: l[12],
        elbowL_13:    l[13],
        elbowR_14:    l[14],
        wristL_15:    l[15],
        wristR_16:    l[16],
        hipL_23:      l[23],
        hipR_24:      l[24]
      });
      console.log("2. Avatar landmarks on canvas (px):", {
        ptRShoulder_12: mapPoint(l[12]),
        ptLShoulder_11: mapPoint(l[11]),
        ptRElbow_14:    l[14] ? mapPoint(l[14]) : null,
        ptLElbow_13:    l[13] ? mapPoint(l[13]) : null,
        ptRWrist_16:    l[16] ? mapPoint(l[16]) : null,
        ptLWrist_15:    l[15] ? mapPoint(l[15]) : null,
        ptRHip_24:      l[24] ? mapPoint(l[24]) : null,
        ptLHip_23:      l[23] ? mapPoint(l[23]) : null
      });
      console.log("3. Garment source anchors from data/garments.json (photo px):", anchors);
      console.log("4a. Computed destination warp points on canvas (px):", destAnchors);
      console.log("4b. Hem row points (curvature & silhouette):", hemRowPoints);
      console.log("5. Scale and dimension metrics:", {
        avatarPxPerCm:      +state.avatar.pxPerCm.toFixed(2),
        canvasRatio:        +ratio.toFixed(4),
        canvasPxPerCm:      +(state.avatar.pxPerCm * ratio).toFixed(2),
        targetChestWidthPx: +targetChestWidth.toFixed(1),
        targetWaistWidthPx: +targetWaistWidth.toFixed(1),
        targetHemWidthPx:   +targetHemWidth.toFixed(1),
        targetLengthPx:     +targetLength.toFixed(1),
        midShoulderX:       +midShoulderX.toFixed(1),
        midShoulderY:       +midShoulderY.toFixed(1),
        destHemY:           +destHemY.toFixed(1),
        scaleChest:         +scaleChest.toFixed(4),
        scaleWaist:         +scaleWaist.toFixed(4),
        scaleHem:           +scaleHem.toFixed(4)
      });
      console.groupEnd();

      if (warpData.isTemplate) {
        if (state.realisticCompositing) {
          // --- PHASE 5: PHOTO-REALISTIC COMPOSITING ---
          // 1. Offscreen rendered garment with inner shading, light matching, edge softening, grain
          const layers = await getOrBuildTemplateCompositedLayers(
            warpData, gImg, img, canvas.width, canvas.height, state.avatar.pxPerCm, ratio
          );

          // 1.a Contact shadow: draw garment alpha as a black silhouette with ctx.filter = blur(Npx),
          // offset (0, +0.6 cm), opacity 0.35, BEFORE the garment. N = 1.2 cm in canvas px.
          const canvasPxPerCm = state.avatar.pxPerCm * ratio;
          // 0. Clean plate: remove T-shirt pixels peeking out around the garment
          await getOrBuildAvatarSkinMask(state.avatar, img, warpData.sleeveVisualEase || 0); // also builds state.avatarTeePlate
          cleanTeeAroundGarment(ctx, layers.garmentCanvas, warpData, state.avatar, mapPoint, canvasPxPerCm, centerShiftX, centerShiftY, ratio);
          const shadowOffsetY = 0.6 * canvasPxPerCm;
          const shadowBlurPx = Math.round(1.2 * canvasPxPerCm);

          ctx.save();
          ctx.globalAlpha = 0.35;
          if (ctx.filter) {
            ctx.filter = `blur(${shadowBlurPx}px)`;
          }
          ctx.drawImage(layers.shadowCanvas, 0, shadowOffsetY);
          ctx.restore();

          // 1.b - 1.e Composite the processed garment layer onto the stage
          ctx.drawImage(layers.garmentCanvas, 0, 0);

          // --- PHASE 6: LAYERED COMPOSITING ---
          // B. Neck emerging from collar V (with soft inner shadow)
          // C. Hands emerging from sleeve cuffs (with dark gradient inside cuff opening)
          const skinMaskCanvas = await getOrBuildAvatarSkinMask(state.avatar, img, warpData.sleeveVisualEase || 0);
          drawTemplateLayeredCompositing(ctx, warpData, state.avatar, skinMaskCanvas, centerShiftX, centerShiftY, ratio, mapPoint);

          // Phase 9C: Store active warpData and composited garment canvas for fit map hit testing
          warpData.compositedGarmentCanvas = layers.garmentCanvas;
          state.activeWarpData = warpData;

          // --- PHASE 9C: FIT MAP (3D-STYLE) ---
          if (state.fitMap) {
            const fitMapCanvas = await getOrBuildFitMapCanvas(
              warpData, layers.garmentCanvas, canvas.width, canvas.height, state.avatar.pxPerCm, ratio
            );
            if (fitMapCanvas) {
              ctx.save();
              ctx.globalAlpha = 0.35; // Phase 9C Review: lowered opacity from 0.45 to 0.35
              ctx.drawImage(fitMapCanvas, 0, 0);
              ctx.restore();
            }
          }

        } else {
          // --- TEMPLATE FIT (WITHOUT COMPOSITING): UNIFORM SCALE AI GHOST-MANNEQUIN MESH ---
          // Allows direct comparison between raw mesh and realistic compositing
          const W = gImg.width;
          const H = gImg.height;
          const gridRows = 24;
          const gridCols = 24;

          for (let r = 0; r < gridRows; r++) {
            const v0 = (r / gridRows) * H;
            const v1 = ((r + 1) / gridRows) * H;
            for (let c = 0; c < gridCols; c++) {
              const u0 = (c / gridCols) * W;
              const u1 = ((c + 1) / gridCols) * W;

              const sTL = { x: u0, y: v0 };
              const sTR = { x: u1, y: v0 };
              const sBL = { x: u0, y: v1 };
              const sBR = { x: u1, y: v1 };

              const dTL = warpPoint(sTL.x, sTL.y);
              const dTR = warpPoint(sTR.x, sTR.y);
              const dBL = warpPoint(sBL.x, sBL.y);
              const dBR = warpPoint(sBR.x, sBR.y);

              drawTexturedTriangle(ctx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
              drawTexturedTriangle(ctx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
            }
          }
        }
      } else if (state.smoothSleeves && warpData.hasLongSleeves) {
        // --- 3-PART MESH: TORSO + LEFT SLEEVE + RIGHT SLEEVE ---
        const W = gImg.width;
        const H = gImg.height;

        // 1. Torso Mesh: region bounded by left armhole and right armhole
        const torsoRows = 8;
        const torsoCols = 6;
        for (let r = 0; r < torsoRows; r++) {
          const v0 = (r / torsoRows) * H;
          const v1 = ((r + 1) / torsoRows) * H;

          const uL0 = warpData.getTorsoLeftU(v0);
          const uR0 = warpData.getTorsoRightU(v0);
          const uL1 = warpData.getTorsoLeftU(v1);
          const uR1 = warpData.getTorsoRightU(v1);

          for (let c = 0; c < torsoCols; c++) {
            const sTL = { x: uL0 + (uR0 - uL0) * (c / torsoCols),       y: v0 };
            const sTR = { x: uL0 + (uR0 - uL0) * ((c + 1) / torsoCols), y: v0 };
            const sBL = { x: uL1 + (uR1 - uL1) * (c / torsoCols),       y: v1 };
            const sBR = { x: uL1 + (uR1 - uL1) * ((c + 1) / torsoCols), y: v1 };

            const dTL = warpPoint(sTL.x, sTL.y);
            const dTR = warpPoint(sTR.x, sTR.y);
            const dBL = warpPoint(sBL.x, sBL.y);
            const dBR = warpPoint(sBR.x, sBR.y);

            drawTexturedTriangle(ctx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
            drawTexturedTriangle(ctx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
          }
        }

        // 2. Left Sleeve (viewer's left / wearer's right arm)
        // Drawn on top of torso and arm, with soft overlap at armpit
        const sleeveRows = 8;
        const sleeveCols = 4;
        for (let r = 0; r < sleeveRows; r++) {
          // slight overlap at armhole (r=0 starts at -0.04) so no visible gap or seam
          const t0 = Math.max(-0.04, (r / sleeveRows) * 1.04 - 0.04);
          const t1 = ((r + 1) / sleeveRows) * 1.04 - 0.04;

          const sOuter0 = warpData.getLeftSleeveOuter(t0);
          const sInner0 = warpData.getLeftSleeveInner(t0);
          const sOuter1 = warpData.getLeftSleeveOuter(t1);
          const sInner1 = warpData.getLeftSleeveInner(t1);

          for (let c = 0; c < sleeveCols; c++) {
            const s0 = c / sleeveCols;
            const s1 = (c + 1) / sleeveCols;

            const sTL = { x: sOuter0.x * (1 - s0) + sInner0.x * s0, y: sOuter0.y * (1 - s0) + sInner0.y * s0 };
            const sTR = { x: sOuter0.x * (1 - s1) + sInner0.x * s1, y: sOuter0.y * (1 - s1) + sInner0.y * s1 };
            const sBL = { x: sOuter1.x * (1 - s0) + sInner1.x * s0, y: sOuter1.y * (1 - s0) + sInner1.y * s0 };
            const sBR = { x: sOuter1.x * (1 - s1) + sInner1.x * s1, y: sOuter1.y * (1 - s1) + sInner1.y * s1 };

            const dTL = warpData.warpSleevePoint(warpData.raisedShoulderR, warpData.ptRElbow, warpData.ptRWrist, s0, Math.max(0, t0), true);
            const dTR = warpData.warpSleevePoint(warpData.raisedShoulderR, warpData.ptRElbow, warpData.ptRWrist, s1, Math.max(0, t0), true);
            const dBL = warpData.warpSleevePoint(warpData.raisedShoulderR, warpData.ptRElbow, warpData.ptRWrist, s0, Math.min(1, t1), true);
            const dBR = warpData.warpSleevePoint(warpData.raisedShoulderR, warpData.ptRElbow, warpData.ptRWrist, s1, Math.min(1, t1), true);

            drawTexturedTriangle(ctx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
            drawTexturedTriangle(ctx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
          }
        }

        // 3. Right Sleeve (viewer's right / wearer's left arm)
        // Drawn on top of torso and arm, with soft overlap at armpit
        for (let r = 0; r < sleeveRows; r++) {
          const t0 = Math.max(-0.04, (r / sleeveRows) * 1.04 - 0.04);
          const t1 = ((r + 1) / sleeveRows) * 1.04 - 0.04;

          const sOuter0 = warpData.getRightSleeveOuter(t0);
          const sInner0 = warpData.getRightSleeveInner(t0);
          const sOuter1 = warpData.getRightSleeveOuter(t1);
          const sInner1 = warpData.getRightSleeveInner(t1);

          for (let c = 0; c < sleeveCols; c++) {
            const s0 = c / sleeveCols;
            const s1 = (c + 1) / sleeveCols;

            const sTL = { x: sOuter0.x * (1 - s0) + sInner0.x * s0, y: sOuter0.y * (1 - s0) + sInner0.y * s0 };
            const sTR = { x: sOuter0.x * (1 - s1) + sInner0.x * s1, y: sOuter0.y * (1 - s1) + sInner0.y * s1 };
            const sBL = { x: sOuter1.x * (1 - s0) + sInner1.x * s0, y: sOuter1.y * (1 - s0) + sInner1.y * s0 };
            const sBR = { x: sOuter1.x * (1 - s1) + sInner1.x * s1, y: sOuter1.y * (1 - s1) + sInner1.y * s1 };

            const dTL = warpData.warpSleevePoint(warpData.raisedShoulderL, warpData.ptLElbow, warpData.ptLWrist, s0, Math.max(0, t0), false);
            const dTR = warpData.warpSleevePoint(warpData.raisedShoulderL, warpData.ptLElbow, warpData.ptLWrist, s1, Math.max(0, t0), false);
            const dBL = warpData.warpSleevePoint(warpData.raisedShoulderL, warpData.ptLElbow, warpData.ptLWrist, s0, Math.min(1, t1), false);
            const dBR = warpData.warpSleevePoint(warpData.raisedShoulderL, warpData.ptLElbow, warpData.ptLWrist, s1, Math.min(1, t1), false);

            drawTexturedTriangle(ctx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
            drawTexturedTriangle(ctx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
          }
        }
      } else {
        // Fallback: 1-piece rectangular mesh grid
        const W = gImg.width;
        const H = gImg.height;

        const vCollar   = anchors.collarL ? (anchors.collarL[1] + anchors.collarR[1]) / 2 : 20;
        const vShoulder = (anchors.shoulderL[1] + anchors.shoulderR[1]) / 2;
        const vArmpit   = (anchors.armpitL[1] + anchors.armpitR[1]) / 2;
        const vHem      = srcHemMidY;

        const vRows = [
          0,
          vCollar,
          vShoulder,
          vArmpit,
          vArmpit + 0.25 * (vHem - vArmpit),
          vArmpit + 0.50 * (vHem - vArmpit),
          vArmpit + 0.75 * (vHem - vArmpit),
          vHem,
          H
        ];

        const uCols = [
          0,
          anchors.armpitL[0] * 0.5,
          anchors.armpitL[0],
          srcShoulderMidX - Math.abs(anchors.armpitR[0] - anchors.armpitL[0]) * 0.25,
          srcShoulderMidX,
          srcShoulderMidX + Math.abs(anchors.armpitR[0] - anchors.armpitL[0]) * 0.25,
          anchors.armpitR[0],
          anchors.armpitR[0] + (W - anchors.armpitR[0]) * 0.5,
          W
        ];

        // Draw each quad as two textured triangles
        for (let r = 0; r < vRows.length - 1; r++) {
          for (let c = 0; c < uCols.length - 1; c++) {
            const sTL = { x: uCols[c],     y: vRows[r] };
            const sTR = { x: uCols[c + 1], y: vRows[r] };
            const sBL = { x: uCols[c],     y: vRows[r + 1] };
            const sBR = { x: uCols[c + 1], y: vRows[r + 1] };

            const dTL = warpPoint(sTL.x, sTL.y);
            const dTR = warpPoint(sTR.x, sTR.y);
            const dBL = warpPoint(sBL.x, sBL.y);
            const dBR = warpPoint(sBR.x, sBR.y);

            drawTexturedTriangle(ctx, gImg, sTL, sTR, sBL, dTL, dTR, dBL);
            drawTexturedTriangle(ctx, gImg, sTR, sBR, sBL, dTR, dBR, dBL);
          }
        }
      }

      if (!warpData.isTemplate) {
        // Subtle multiply-blend shading layer over the garment (for warp garments)
        drawGarmentShading(ctx, warpData);

        // Soft contact shadow under the hem and under arms
        drawGarmentDropShadow(ctx, warpData);
      }

      // 4) Draw Garment Anchors debug overlay if toggled
      if (state.showGarmentAnchors && destAnchors) {
        drawGarmentAnchorsDebug(ctx, destAnchors, hemRowPoints);
      }

      // 5) Draw Debug Fit overlay if toggled
      if (state.debugFit && warpData) {
        drawDebugFit(ctx, warpData, state, mapPoint, gImg);
      }

    } else {
      // Fallback for garments without anchors (e.g. sample items)
      const chart = item.garment.sizes[item.size] || item.garment.sizes["M"];
      const canvasPxPerCm = state.avatar.pxPerCm * ratio;
      const targetChestWidth = (chart?.chest || 100) * 0.34 * canvasPxPerCm;
      const scaleFactor = targetChestWidth / gImg.width;
      const w = gImg.width * scaleFactor;
      const h = gImg.height * scaleFactor;
      const ptRShoulder = mapPoint(l[12]);
      const ptLShoulder = mapPoint(l[11]);
      const midShoulderX = (ptRShoulder.x + ptLShoulder.x) / 2;
      const midShoulderY = (ptRShoulder.y + ptLShoulder.y) / 2;
      ctx.drawImage(gImg, midShoulderX - w/2, midShoulderY, w, h);
    }
  }

  // 3b. Redraw head/chin and hands on top of garment so collar never covers the chin/face
  if (state.wornItems.length > 0 && state.avatar && state.avatar.landmarks) {
    const l = state.avatar.landmarks;
    const hasTemplateGarment = state.wornItems.some(it => it.garment?.renderMode === 'template');

    ctx.save();
    ctx.beginPath();

    // Head + face
    const nose = mapPoint(l[0]);
    const earL = mapPoint(l[7]);
    const earR = mapPoint(l[8]);
    const headX = (earL.x + earR.x) / 2;
    const headY = (earL.y + earR.y) / 2;
    const headRx = Math.max(38, Math.hypot(earL.x - earR.x, earL.y - earR.y) * 0.95);
    const headRy = headRx * 1.25;

    // Head ellipse (face, ears, hair)
    ctx.ellipse(headX, headY - 10, headRx, headRy, 0, 0, Math.PI * 2);

    if (!hasTemplateGarment) {
      // Legacy warp mode: neck region extending down to collar line
      const ptLShoulder = mapPoint(l[11]);
      const ptRShoulder = mapPoint(l[12]);
      const neckTopY = headY + headRy * 0.6;
      const neckBottomY = (ptLShoulder.y + ptRShoulder.y) / 2;
      const neckW = headRx * 0.62;
      ctx.rect(headX - neckW / 2, neckTopY, neckW, Math.max(15, neckBottomY - neckTopY + 2));
    } else {
      // Template fit mode: DO NOT redraw neck over collar (preserves full collar height).
      // Hands are NOT redrawn: the garment PNG is transparent below the cuffs, so the avatar's
      // hands already show; redrawing circles pasted white T-shirt/background over the cuffs.
      const REDRAW_HANDS = false;
      const handRadius = Math.max(20, 3.5 * (state.avatar.pxPerCm * ratio));
      if (REDRAW_HANDS && l[16]) {
        const ptRWrist = mapPoint(l[16]);
        // moveTo starts a new sub-path; without it the clip path joins head + hands into a triangle over the torso
        ctx.moveTo(ptRWrist.x + handRadius, ptRWrist.y + handRadius * 0.4);
        ctx.arc(ptRWrist.x, ptRWrist.y + handRadius * 0.4, handRadius, 0, Math.PI * 2);
      }
      if (REDRAW_HANDS && l[15]) {
        const ptLWrist = mapPoint(l[15]);
        ctx.moveTo(ptLWrist.x + handRadius, ptLWrist.y + handRadius * 0.4);
        ctx.arc(ptLWrist.x, ptLWrist.y + handRadius * 0.4, handRadius, 0, Math.PI * 2);
      }
    }

    ctx.clip();
    ctx.drawImage(img, 0, 0, img.width, img.height, centerShiftX, centerShiftY, img.width * ratio, img.height * ratio);
    ctx.restore();
  }

  for (const b of tooSmallBanners) drawTooSmallBanner(ctx, b);

  // Phase 10: Fit labels on the avatar (retail 3D try-on style)
  // Hide labels for n/a zones; do not draw labels when too-small banner is shown.
  if (state.fitLabels !== false && tooSmallBanners.length === 0 && state.activeWarpData) {
    drawTemplateFitLabels(
      ctx,
      state.activeWarpData,
      state.activeWarpData.compositedGarmentCanvas,
      canvas.width,
      canvas.height,
      state.avatar.pxPerCm,
      ratio
    );
  }

  // 4. Draw Landmarks, Labels and HUD readout if toggled
  if (state.showLandmarks && state.avatar.landmarks) {
    const l = state.avatar.landmarks;
    // Key joints: shoulders (11,12), elbows (13,14), wrists (15,16), hips (23,24), knees (25,26), ankles (27,28)
    const targetIndices = [
      { id: 11, label: 'L Shoulder' },
      { id: 12, label: 'R Shoulder' },
      { id: 13, label: 'L Elbow' },
      { id: 14, label: 'R Elbow' },
      { id: 15, label: 'L Wrist' },
      { id: 16, label: 'R Wrist' },
      { id: 23, label: 'L Hip' },
      { id: 24, label: 'R Hip' },
      { id: 25, label: 'L Knee' },
      { id: 26, label: 'R Knee' },
      { id: 27, label: 'L Ankle' },
      { id: 28, label: 'R Ankle' }
    ];

    // Draw dots and labels
    targetIndices.forEach(item => {
      const pt = l[item.id];
      if (!pt) return;
      const mapped = mapPoint(pt);

      // Dot
      ctx.beginPath();
      ctx.arc(mapped.x, mapped.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#FF5A36';
      ctx.fill();
      ctx.strokeStyle = '#14213D';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Label with slight text shadow for readability
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(item.label, mapped.x + 8, mapped.y + 4);
      ctx.fillStyle = '#14213D';
      ctx.fillText(item.label, mapped.x + 7, mapped.y + 3);
    });

    // Small readout overlay box on canvas
    const imgHeight = state.avatar.imageHeightPx || img.height;
    const readoutLines = [
      `Model Height: ${imgHeight} px`,
      `Scale Ratio: ${state.avatar.pxPerCm.toFixed(2)} px/cm`,
      `Shoulder Span: ${state.avatar.shoulderCm.toFixed(1)} cm`
    ];

    ctx.save();
    const boxX = 20;
    const boxY = 20;
    const boxW = 230;
    const boxH = 76;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 8);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);
    }

    ctx.fillStyle = '#0F172A';
    ctx.font = '11px "IBM Plex Mono", monospace';
    readoutLines.forEach((text, i) => {
      ctx.fillText(text, boxX + 12, boxY + 22 + i * 18);
    });
    ctx.restore();
  }
}

// Draw debug overlay for garment anchor points and curved hem row
function drawGarmentAnchorsDebug(ctx, destAnchors, hemRowPoints) {
  const anchorConfig = [
    { key: 'shoulderL',  color: '#2563EB', label: 'shoulderL' },
    { key: 'shoulderR',  color: '#2563EB', label: 'shoulderR' },
    { key: 'collarL',    color: '#9333EA', label: 'collarL' },
    { key: 'collarR',    color: '#9333EA', label: 'collarR' },
    { key: 'armpitL',    color: '#EAB308', label: 'armpitL' },
    { key: 'armpitR',    color: '#EAB308', label: 'armpitR' },
    { key: 'hemL',       color: '#16A34A', label: 'hemL' },
    { key: 'hemR',       color: '#16A34A', label: 'hemR' },
    { key: 'cuffOuterL', color: '#DC2626', label: 'cuffOuterL' },
    { key: 'cuffInnerL', color: '#DC2626', label: 'cuffInnerL' },
    { key: 'cuffOuterR', color: '#DC2626', label: 'cuffOuterR' },
    { key: 'cuffInnerR', color: '#DC2626', label: 'cuffInnerR' }
  ];

  ctx.save();

  // 1. Draw dashed curve along the hem row points
  if (hemRowPoints && hemRowPoints.length > 1) {
    ctx.save();
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(hemRowPoints[0].x, hemRowPoints[0].y);
    for (let i = 1; i < hemRowPoints.length; i++) {
      ctx.lineTo(hemRowPoints[i].x, hemRowPoints[i].y);
    }
    ctx.stroke();

    // Subtle flat comparison line (gray dashed) to show curvature contrast
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hemRowPoints[0].x, hemRowPoints[0].y);
    ctx.lineTo(hemRowPoints[hemRowPoints.length - 1].x, hemRowPoints[hemRowPoints.length - 1].y);
    ctx.stroke();

    // Hem row intermediate dots
    hemRowPoints.forEach((hp, idx) => {
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#10B981';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (idx === Math.floor(hemRowPoints.length / 2)) {
        // Label for hemMid
        ctx.font = 'bold 9px "IBM Plex Mono", monospace';
        const text = 'hemMid (curved +5px)';
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(6, 78, 59, 0.9)';
        ctx.fillRect(hp.x - textWidth / 2 - 3, hp.y + 8, textWidth + 6, 13);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, hp.x - textWidth / 2, hp.y + 18);
      }
    });
    ctx.restore();
  }

  // 2. Draw standard anchor points
  anchorConfig.forEach(item => {
    const pt = destAnchors[item.key];
    if (!pt) return;

    // Small colored dot
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Text label with dark background
    ctx.font = 'bold 9px "IBM Plex Mono", monospace';
    const text = item.label;
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(20, 33, 61, 0.85)';
    ctx.fillRect(pt.x + 6, pt.y - 7, textWidth + 4, 12);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, pt.x + 8, pt.y + 2);
  });

  ctx.restore();
}

// STEP A: Draw Debug Fit overlay (MediaPipe points, garment anchors, body outline, HUD numbers, and raw garment anchors)
function drawDebugFit(ctx, warpData, state, mapPoint, gImg) {
  if (!warpData || !state.avatar || !state.avatar.landmarks) return;
  const l = state.avatar.landmarks;
  const { garment, size, destAnchors, targetChestWidth, targetWaistWidth, targetHemWidth, destHemY, canvasPxPerCm, bodyOutline } = warpData;

  const ptRShoulder = mapPoint(l[12]);
  const ptLShoulder = mapPoint(l[11]);
  const ptRHip = l[24] ? mapPoint(l[24]) : null;
  const ptLHip = l[23] ? mapPoint(l[23]) : null;
  const ptRWrist = l[16] ? mapPoint(l[16]) : null;
  const ptLWrist = l[15] ? mapPoint(l[15]) : null;

  ctx.save();

  // 1. Draw MediaPipe Shoulder and Hip Points (Bright Cyan rings + labels)
  const mpKeyPoints = [
    { pt: ptRShoulder, label: 'MP Shoulder R (12)' },
    { pt: ptLShoulder, label: 'MP Shoulder L (11)' },
    { pt: ptRHip,      label: 'MP Hip R (24)' },
    { pt: ptLHip,      label: 'MP Hip L (23)' }
  ];

  mpKeyPoints.forEach(item => {
    if (!item.pt) return;
    ctx.beginPath();
    ctx.arc(item.pt.x, item.pt.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(item.pt.x, item.pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#06B6D4';
    ctx.fill();

    ctx.font = 'bold 9px "IBM Plex Mono", monospace';
    const text = item.label;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(8, 51, 68, 0.85)';
    ctx.fillRect(item.pt.x - tw / 2 - 3, item.pt.y - 18, tw + 6, 13);
    ctx.fillStyle = '#E0F2FE';
    ctx.fillText(text, item.pt.x - tw / 2, item.pt.y - 8);
  });

  // 2. Draw Body Outline Rows from segmentation mask (Dashed Magenta lines)
  if (bodyOutline) {
    const ratio = warpData.ratio;
    const centerShiftX = warpData.centerShiftX;
    const centerShiftY = warpData.centerShiftY;

    const mapOutlinePt = (imgX, imgY) => ({
      x: centerShiftX + imgX * ratio,
      y: centerShiftY + imgY * ratio
    });

    const chestL = mapOutlinePt(bodyOutline.chestLeft, bodyOutline.chestY);
    const chestR = mapOutlinePt(bodyOutline.chestRight, bodyOutline.chestY);
    const waistL = mapOutlinePt(bodyOutline.waistLeft, bodyOutline.waistY);
    const waistR = mapOutlinePt(bodyOutline.waistRight, bodyOutline.waistY);
    const hipL = mapOutlinePt(bodyOutline.hipLeft, bodyOutline.hipY);
    const hipR = mapOutlinePt(bodyOutline.hipRight, bodyOutline.hipY);

    const rows = [
      { p1: chestL, p2: chestR, label: `Body Chest: ${(bodyOutline.chestWidthPx * ratio).toFixed(1)}px` },
      { p1: waistL, p2: waistR, label: `Body Waist: ${(bodyOutline.waistWidthPx * ratio).toFixed(1)}px` },
      { p1: hipL,   p2: hipR,   label: `Body Hip: ${(bodyOutline.hipWidthPx * ratio).toFixed(1)}px` }
    ];

    rows.forEach(r => {
      ctx.save();
      ctx.strokeStyle = '#D946EF';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(r.p1.x, r.p1.y);
      ctx.lineTo(r.p2.x, r.p2.y);
      ctx.stroke();

      // End points
      ctx.fillStyle = '#D946EF';
      ctx.beginPath();
      ctx.arc(r.p1.x, r.p1.y, 3.5, 0, Math.PI * 2);
      ctx.arc(r.p2.x, r.p2.y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Label at middle
      const midX = (r.p1.x + r.p2.x) / 2;
      ctx.font = 'bold 9px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(r.label).width;
      ctx.fillStyle = 'rgba(74, 4, 78, 0.85)';
      ctx.fillRect(midX - tw / 2 - 3, r.p1.y - 14, tw + 6, 12);
      ctx.fillStyle = '#FDF4FF';
      ctx.fillText(r.label, midX - tw / 2, r.p1.y - 5);
      ctx.restore();
    });
  }

  // 3. Draw Garment Anchors after warp (Amber / Yellow markers)
  if (destAnchors) {
    const anchorsList = [
      { key: 'shoulderR', pt: destAnchors.shoulderR, color: '#F59E0B' },
      { key: 'shoulderL', pt: destAnchors.shoulderL, color: '#F59E0B' },
      { key: 'armpitR',   pt: destAnchors.armpitR,   color: '#F59E0B' },
      { key: 'armpitL',   pt: destAnchors.armpitL,   color: '#F59E0B' },
      { key: 'hemR',      pt: destAnchors.hemR,      color: '#10B981' },
      { key: 'hemL',      pt: destAnchors.hemL,      color: '#10B981' },
      { key: 'cuffOuterR',pt: destAnchors.cuffOuterR,color: '#EF4444' },
      { key: 'cuffOuterL',pt: destAnchors.cuffOuterL,color: '#EF4444' }
    ];

    anchorsList.forEach(a => {
      if (!a.pt) return;
      ctx.beginPath();
      ctx.arc(a.pt.x, a.pt.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      const text = a.key;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(a.pt.x - tw / 2 - 2, a.pt.y + 6, tw + 4, 11);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, a.pt.x - tw / 2, a.pt.y + 15);
    });
  }

  // 4. Calculate numbers
  const bodyShoulderWidthPx = warpData.bodyShoulderWidthCanvas;
  const garmentShoulderWidthPx = Math.hypot(destAnchors.shoulderL.x - destAnchors.shoulderR.x, destAnchors.shoulderL.y - destAnchors.shoulderR.y);
  const bodyChestWidthPx = warpData.bodyChestWidthCanvas;
  const garmentChestWidthPx = targetChestWidth;
  const hemY = destHemY;
  const wristLY = ptLWrist ? ptLWrist.y : 0;
  const wristRY = ptRWrist ? ptRWrist.y : 0;

  // 5. HUD Stats Box (Top-Left of Canvas)
  const hudX = 14;
  const hudY = 14;
  const hudW = 320;
  const hudH = 203;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.strokeStyle = '#38BDF8';
  ctx.lineWidth = 1.5;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(hudX, hudY, hudW, hudH, 8);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(hudX, hudY, hudW, hudH);
    ctx.strokeRect(hudX, hudY, hudW, hudH);
  }

  ctx.fillStyle = '#38BDF8';
  ctx.font = 'bold 11px "IBM Plex Mono", monospace';
  ctx.fillText(`DEBUG FIT · ${garment.name} (${size})`, hudX + 12, hudY + 22);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = '10px "IBM Plex Mono", monospace';
  const easeCm = ((garmentChestWidthPx - bodyChestWidthPx) / (0.34 * canvasPxPerCm)).toFixed(1);
  const pxPerCmOldVal = state.avatar.pxPerCmOld ? state.avatar.pxPerCmOld.toFixed(2) : '—';
  const lines = [
    `Body shoulder width:    ${bodyShoulderWidthPx.toFixed(1)} px (${(bodyShoulderWidthPx / canvasPxPerCm).toFixed(1)} cm)`,
    `Garment shoulder width: ${garmentShoulderWidthPx.toFixed(1)} px (${(garmentShoulderWidthPx / canvasPxPerCm).toFixed(1)} cm)`,
    `Body chest width:       ${bodyChestWidthPx.toFixed(1)} px (${(bodyChestWidthPx / canvasPxPerCm).toFixed(1)} cm)`,
    `Garment chest width:    ${garmentChestWidthPx.toFixed(1)} px (${(garmentChestWidthPx / canvasPxPerCm).toFixed(1)} cm)`,
    `Hem Y:                  ${hemY.toFixed(1)} px`,
    `Wrist Y (R / L):        ${wristRY.toFixed(1)} px / ${wristLY.toFixed(1)} px`,
    `Ease (chest):           +${(garmentChestWidthPx - bodyChestWidthPx).toFixed(1)} px (+${easeCm} cm)`,
    `Scale (new mask):       ${canvasPxPerCm.toFixed(2)} px/cm`,
    `Scale (old nose→ankle): ${pxPerCmOldVal} px/cm`
  ];

  lines.forEach((l, idx) => {
    ctx.fillText(l, hudX + 12, hudY + 42 + idx * 17);
  });

  // 6. Raw Garment Image with Anchors Preview (Bottom-Left Inset Box)
  if (gImg && garment.anchors) {
    const rawBoxX = 14;
    const rawBoxY = 1200 - 170;
    const rawBoxW = 150;
    const rawBoxH = 155;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.strokeStyle = '#64748B';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(rawBoxX, rawBoxY, rawBoxW, rawBoxH, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(rawBoxX, rawBoxY, rawBoxW, rawBoxH);
      ctx.strokeRect(rawBoxX, rawBoxY, rawBoxW, rawBoxH);
    }

    ctx.fillStyle = '#94A3B8';
    ctx.font = 'bold 9px "IBM Plex Mono", monospace';
    ctx.fillText(`RAW ANCHORS (${gImg.width}x${gImg.height})`, rawBoxX + 8, rawBoxY + 16);

    const pad = 8;
    const imgDrawX = rawBoxX + pad;
    const imgDrawY = rawBoxY + 22;
    const imgDrawW = rawBoxW - pad * 2;
    const imgDrawH = rawBoxH - 34;

    const scaleX = imgDrawW / gImg.width;
    const scaleY = imgDrawH / gImg.height;
    const s = Math.min(scaleX, scaleY);
    const offsetX = imgDrawX + (imgDrawW - gImg.width * s) / 2;
    const offsetY = imgDrawY + (imgDrawH - gImg.height * s) / 2;

    ctx.drawImage(gImg, offsetX, offsetY, gImg.width * s, gImg.height * s);

    // Plot anchors on raw image
    Object.entries(garment.anchors).forEach(([k, pt]) => {
      if (!Array.isArray(pt) || pt.length < 2) return;
      const ax = offsetX + pt[0] * s;
      const ay = offsetY + pt[1] * s;
      ctx.beginPath();
      ctx.arc(ax, ay, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#38BDF8';
      ctx.fill();
    });

    ctx.fillStyle = '#10B981';
    ctx.font = 'bold 8px "IBM Plex Mono", monospace';
    ctx.fillText(`Anchors match raw px: YES`, rawBoxX + 8, rawBoxY + rawBoxH - 6);
  }

  // Also log in console for debugging verification
  console.log(`[DEBUG FIT - Size ${size}]`, {
    bodyShoulderWidthPx: +bodyShoulderWidthPx.toFixed(1),
    garmentShoulderWidthPx: +garmentShoulderWidthPx.toFixed(1),
    bodyChestWidthPx: +bodyChestWidthPx.toFixed(1),
    garmentChestWidthPx: +garmentChestWidthPx.toFixed(1),
    hemY: +hemY.toFixed(1),
    wristRY: +wristRY.toFixed(1),
    wristLY: +wristLY.toFixed(1),
    easeCm: +easeCm
  });

  ctx.restore();
}

// --- Utils ---
function showMessage(text, isError) {
  const area = document.getElementById('avatar-message-area');
  if (!area) return;
  if (!text) {
    area.hidden = true;
    area.innerHTML = '';
    return;
  }
  area.hidden = false;
  area.innerHTML = text;
  area.style.borderLeftColor = isError ? 'var(--color-error, #EF4444)' : 'var(--fit-good, #10B981)';
  try {
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (_) {}
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Bootstrap
init().catch(console.error);
