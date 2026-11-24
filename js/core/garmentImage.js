/**
 * garmentImage.js — Shared garment image background cleaning and transparency checks.
 * Python analogy: PIL.Image / numpy array pixel processing.
 */

// In-memory cache for cleaned garment canvases
export const garmentCleanCache = new Map();

/**
 * Checks if an HTMLImageElement has transparent pixels in its corners.
 * Returns true if the image already has transparent background.
 */
export function hasTransparentBackground(img) {
  if (typeof document === 'undefined') return true;
  const canvas = document.createElement('canvas');
  const w = img.naturalWidth || img.width || 800;
  const h = img.naturalHeight || img.height || 1000;
  canvas.width = Math.min(w, 200);
  canvas.height = Math.min(h, 200);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Sample corners
    const offsets = [
      0,
      (canvas.width - 1) * 4,
      ((canvas.height - 1) * canvas.width) * 4,
      ((canvas.height - 1) * canvas.width + (canvas.width - 1)) * 4
    ];
    for (const off of offsets) {
      if (data[off + 3] < 30) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Clean garment image background.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} img - Source garment image or canvas
 * @param {Object} [options]
 * @param {number} [options.tolerance=22] - Color distance tolerance (Euclidean RGB)
 * @param {boolean} [options.protectCentre=false] - If true, protects central 60% with rollback (dressing room mode)
 * @returns {HTMLCanvasElement|HTMLImageElement} Cleaned canvas or original image
 */
export function cleanGarmentImage(img, { tolerance = 22, protectCentre = false } = {}) {
  if (!img) return img;

  const w = img.naturalWidth || img.width || 800;
  const h = img.naturalHeight || img.height || 1000;
  const cacheKey = (img.src || (w + 'x' + h)) + `_t${tolerance}_p${protectCentre}`;

  if (garmentCleanCache.has(cacheKey)) {
    return garmentCleanCache.get(cacheKey);
  }

  if (typeof document === 'undefined') return img;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (_) {
    return img; // Cross-origin fallback
  }
  const data = imgData.data;

  // 1. Sample 4 corners to detect background color
  const cornerOffsets = [0, (w - 1) * 4, ((h - 1) * w) * 4, ((h - 1) * w + (w - 1)) * 4];
  let bgR = 0, bgG = 0, bgB = 0, bgA = 0;
  for (const off of cornerOffsets) {
    bgR += data[off];
    bgG += data[off + 1];
    bgB += data[off + 2];
    bgA += data[off + 3];
  }
  bgR = Math.round(bgR / 4);
  bgG = Math.round(bgG / 4);
  bgB = Math.round(bgB / 4);
  bgA = Math.round(bgA / 4);

  // If corners are already transparent, skip flood fill
  if (bgA < 20) {
    garmentCleanCache.set(cacheKey, img);
    return img;
  }

  const tolSq = tolerance * tolerance;

  // Euclidean RGB distance check
  const isMatchBg = (idx) => {
    const a = data[idx + 3];
    if (a < 20) return true;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const dSq = (r - bgR) * (r - bgR) + (g - bgG) * (g - bgG) + (b - bgB) * (b - bgB);
    return dSq <= tolSq;
  };

  // Boundaries for protected centre mode
  const c60X0 = Math.round(w * 0.20);
  const c60X1 = Math.round(w * 0.80);
  const c60Y0 = Math.round(h * 0.20);
  const c60Y1 = Math.round(h * 0.80);

  const c40X0 = Math.round(w * 0.30);
  const c40X1 = Math.round(w * 0.70);
  const c40Y0 = Math.round(h * 0.30);
  const c40Y1 = Math.round(h * 0.70);
  const totalCenterPx = (c40X1 - c40X0) * (c40Y1 - c40Y0);

  let origCenterTransparent = 0;
  if (protectCentre) {
    for (let y = c40Y0; y < c40Y1; y++) {
      for (let x = c40X0; x < c40X1; x++) {
        if (data[(y * w + x) * 4 + 3] < 30) origCenterTransparent++;
      }
    }
  }

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qHead = 0;
  let qTail = 0;

  const pushPixel = (x, y) => {
    if (protectCentre) {
      // Stop at central 60% boundary in strict mode
      if (x >= c60X0 && x <= c60X1 && y >= c60Y0 && y <= c60Y1) return;
    }
    const pIdx = y * w + x;
    if (visited[pIdx]) return;
    visited[pIdx] = 1;
    if (isMatchBg(pIdx * 4)) {
      queue[qTail++] = pIdx;
    }
  };

  // Flood fill starts from all 4 borders
  for (let x = 0; x < w; x++) {
    pushPixel(x, 0);
    pushPixel(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushPixel(0, y);
    pushPixel(w - 1, y);
  }

  while (qHead < qTail) {
    const curr = queue[qHead++];
    const cx = curr % w;
    const cy = (curr / w) | 0;
    data[curr * 4 + 3] = 0; // Set transparent

    if (cx > 0) pushPixel(cx - 1, cy);
    if (cx < w - 1) pushPixel(cx + 1, cy);
    if (cy > 0) pushPixel(cx, cy - 1);
    if (cy < h - 1) pushPixel(cx, cy + 1);
  }

  // 1 px alpha erosion on transparent boundary pixels
  const eroded = [];
  for (let y = 1; y < h - 1; y++) {
    if (protectCentre && (y >= c60Y0 && y <= c60Y1)) continue;
    for (let x = 1; x < w - 1; x++) {
      if (protectCentre && (x >= c60X0 && x <= c60X1)) continue;
      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 0) {
        if (
          data[((y - 1) * w + x) * 4 + 3] === 0 ||
          data[((y + 1) * w + x) * 4 + 3] === 0 ||
          data[(y * w + (x - 1)) * 4 + 3] === 0 ||
          data[(y * w + (x + 1)) * 4 + 3] === 0
        ) {
          eroded.push(idx + 3);
        }
      }
    }
  }
  for (let i = 0; i < eroded.length; i++) {
    data[eroded[i]] = 0;
  }

  // If not in protected centre mode, remove tiny isolated white specks (< 40 px)
  if (!protectCentre) {
    removeIsolatedWhiteSpecks(data, w, h, 40);
  }

  // Strict centre check (only when protectCentre is true)
  if (protectCentre) {
    let newCenterTransparent = 0;
    for (let y = c40Y0; y < c40Y1; y++) {
      for (let x = c40X0; x < c40X1; x++) {
        if (data[(y * w + x) * 4 + 3] < 30) newCenterTransparent++;
      }
    }
    const percentRemoved = ((newCenterTransparent - origCenterTransparent) / totalCenterPx) * 100;
    if (percentRemoved > 2.0) {
      garmentCleanCache.set(cacheKey, img);
      return img;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  garmentCleanCache.set(cacheKey, canvas);
  return canvas;
}

/**
 * Remove small isolated connected components (< maxCount pixels) of near-white pixels.
 * @param {Uint8ClampedArray} data - RGBA image data
 * @param {number} w - Width
 * @param {number} h - Height
 * @param {number} maxCount - Max component pixel size to remove (default 40)
 */
function removeIsolatedWhiteSpecks(data, w, h, maxCount = 40) {
  const speckVisited = new Uint8Array(w * h);
  const q = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (speckVisited[idx]) continue;
      const p = idx * 4;

      // Only check near-white opaque pixels (all RGB > 235, alpha > 0)
      if (data[p + 3] > 0 && data[p] > 235 && data[p + 1] > 235 && data[p + 2] > 235) {
        let qHead = 0;
        let qTail = 0;
        q[qTail++] = idx;
        speckVisited[idx] = 1;
        const component = [idx];

        while (qHead < qTail) {
          const c = q[qHead++];
          const cx = c % w;
          const cy = (c / w) | 0;

          const neighbors = [
            cx > 0 ? cy * w + (cx - 1) : -1,
            cx < w - 1 ? cy * w + (cx + 1) : -1,
            cy > 0 ? (cy - 1) * w + cx : -1,
            cy < h - 1 ? (cy + 1) * w + cx : -1
          ];

          for (const n of neighbors) {
            if (n >= 0 && !speckVisited[n]) {
              const np = n * 4;
              if (data[np + 3] > 0 && data[np] > 235 && data[np + 1] > 235 && data[np + 2] > 235) {
                speckVisited[n] = 1;
                component.push(n);
                q[qTail++] = n;
              }
            }
          }
        }

        if (component.length < maxCount) {
          for (let i = 0; i < component.length; i++) {
            data[component[i] * 4 + 3] = 0;
          }
        }
      }
    }
  }
}

/**
 * Magic Eraser: removes connected region matching color at (startX, startY) within tolerance.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} startX - Clicked X in canvas pixels
 * @param {number} startY - Clicked Y in canvas pixels
 * @param {number} [tolerance=22] - Color distance tolerance
 * @returns {boolean} True if pixels were modified
 */
export function magicEraseRegion(canvas, startX, startY, tolerance = 22) {
  if (!canvas) return false;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  if (startX < 0 || startX >= w || startY < 0 || startY >= h) return false;

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  const startIdx = (startY * w + startX) * 4;
  const targetA = data[startIdx + 3];
  if (targetA < 20) return false; // Already transparent

  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];
  const tolSq = tolerance * tolerance;

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qHead = 0;
  let qTail = 0;

  const initial = startY * w + startX;
  visited[initial] = 1;
  queue[qTail++] = initial;

  const modified = [];

  while (qHead < qTail) {
    const curr = queue[qHead++];
    const cx = curr % w;
    const cy = (curr / w) | 0;

    data[curr * 4 + 3] = 0;
    modified.push(curr);

    const neighbors = [
      cx > 0 ? cy * w + (cx - 1) : -1,
      cx < w - 1 ? cy * w + (cx + 1) : -1,
      cy > 0 ? (cy - 1) * w + cx : -1,
      cy < h - 1 ? (cy + 1) * w + cx : -1
    ];

    for (const n of neighbors) {
      if (n >= 0 && !visited[n]) {
        visited[n] = 1;
        const np = n * 4;
        if (data[np + 3] > 0) {
          const r = data[np];
          const g = data[np + 1];
          const b = data[np + 2];
          const dSq = (r - targetR) * (r - targetR) + (g - targetG) * (g - targetG) + (b - targetB) * (b - targetB);
          if (dSq <= tolSq) {
            queue[qTail++] = n;
          }
        }
      }
    }
  }

  // 1 px alpha erosion on boundary
  for (let i = 0; i < modified.length; i++) {
    const curr = modified[i];
    const cx = curr % w;
    const cy = (curr / w) | 0;
    const neighbors = [
      cx > 0 ? cy * w + (cx - 1) : -1,
      cx < w - 1 ? cy * w + (cx + 1) : -1,
      cy > 0 ? (cy - 1) * w + cx : -1,
      cy < h - 1 ? (cy + 1) * w + cx : -1
    ];
    for (const n of neighbors) {
      if (n >= 0 && data[n * 4 + 3] > 0) {
        data[n * 4 + 3] = 0;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return true;
}
