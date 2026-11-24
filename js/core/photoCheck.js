/**
 * photoCheck.js — Pre-flight validation for user full-body photos before Gemini.
 * Evaluates dimensions, orientation, person detection, body landmarks, and pose.
 * Returns { ok, errors[], warnings[], details }
 */

/**
 * Validates a photo before sending to Gemini API.
 * @param {HTMLImageElement|HTMLCanvasElement} img - Loaded image or canvas element
 * @param {object} poseLandmarker - MediaPipe PoseLandmarker instance
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], details: object}>}
 */
export async function checkPhoto(img, poseLandmarker) {
  const errors = [];
  const warnings = [];

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  // 1. Shorter side must be >= 600 px
  const shorterSide = Math.min(w, h);
  if (shorterSide < 600) {
    errors.push(`Image resolution is too low (${shorterSide}px on shorter side, minimum is 600px). Please upload a higher resolution photo.`);
  }

  // 2. Must be portrait orientation (height/width >= 1.3)
  const aspect = h / w;
  if (aspect < 1.3) {
    errors.push(`Photo must be vertical (portrait orientation). Height is only ${(aspect).toFixed(2)}x width, but at least 1.3x is required.`);
  }

  // 3. Luminance check (canvas sampling: 40 - 220)
  let meanLuminance = 128;
  if (typeof document !== 'undefined') {
    try {
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = 160;
      sampleCanvas.height = Math.round(h * (160 / w));
      const sCtx = sampleCanvas.getContext('2d');
      sCtx.drawImage(img, 0, 0, sampleCanvas.width, sampleCanvas.height);
      const idata = sCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
      let sumLum = 0;
      const numPixels = idata.length / 4;
      for (let i = 0; i < idata.length; i += 4) {
        sumLum += 0.299 * idata[i] + 0.587 * idata[i + 1] + 0.114 * idata[i + 2];
      }
      meanLuminance = sumLum / numPixels;
      if (meanLuminance < 40) {
        warnings.push(`Photo is very dark (average brightness: ${Math.round(meanLuminance)}/255). A brighter photo produces a much better avatar.`);
      } else if (meanLuminance > 220) {
        warnings.push(`Photo is very bright or overexposed (average brightness: ${Math.round(meanLuminance)}/255). Even, diffused lighting works best.`);
      }
    } catch (lumErr) {
      console.warn('Luminance check failed:', lumErr);
    }
  }

  // If basic dimension checks failed catastrophically, we can still run MediaPipe or return early
  if (!poseLandmarker) {
    return { ok: errors.length === 0, errors, warnings, details: { w, h, aspect, meanLuminance } };
  }

  // 4. MediaPipe PoseLandmarker detection
  let poseResult = null;
  try {
    poseResult = poseLandmarker.detect(img);
  } catch (detectErr) {
    errors.push(`Pose detection failed: ${detectErr.message || detectErr}`);
    return { ok: false, errors, warnings, details: { w, h, aspect, meanLuminance } };
  }

  if (!poseResult || !poseResult.landmarks || poseResult.landmarks.length === 0) {
    errors.push("No person detected in the photo. Please ensure you are standing in clear view from head to toe.");
    return { ok: false, errors, warnings, details: { w, h, aspect, meanLuminance } };
  }

  // Check for multiple people
  if (poseResult.landmarks.length >= 2) {
    errors.push("Multiple people detected. Please upload a photo with only one person in the frame.");
  }

  const l = poseResult.landmarks[0];
  if (!l || l.length < 33) {
    errors.push("Body landmarks are incomplete. Please ensure your entire body is clearly visible.");
    return { ok: false, errors, warnings, details: { w, h, aspect, meanLuminance } };
  }

  // 5. Landmark presence and visibility check (>= 0.5)
  // Nose (0), Shoulders (11, 12), Hips (23, 24), Knees (25, 26), Ankles (27, 28)
  const keyPoints = [
    { idx: 0, name: 'head/face' },
    { idx: 11, name: 'left shoulder' },
    { idx: 12, name: 'right shoulder' },
    { idx: 23, name: 'left hip' },
    { idx: 24, name: 'right hip' },
    { idx: 25, name: 'left knee' },
    { idx: 26, name: 'right knee' },
    { idx: 27, name: 'left ankle' },
    { idx: 28, name: 'right ankle' }
  ];

  const missingPoints = [];
  for (const kp of keyPoints) {
    const pt = l[kp.idx];
    if (!pt || (typeof pt.visibility === 'number' && pt.visibility < 0.5)) {
      missingPoints.push(kp.name);
    }
  }

  if (missingPoints.length > 0) {
    errors.push(`Body landmarks are unclear or obscured (${missingPoints.slice(0, 3).join(', ')}). Make sure your full body is visible and well-lit.`);
  }

  // 6. Ankles below 97% of image height or head touching the top
  const leftAnkle = l[27];
  const rightAnkle = l[28];
  const nose = l[0];

  const ankleYNorm = Math.max(leftAnkle?.y || 0, rightAnkle?.y || 0);
  if (ankleYNorm > 0.97 || (leftAnkle && leftAnkle.y < 0) || (rightAnkle && rightAnkle.y < 0)) {
    errors.push("Your feet are cut off. Step back and include your shoes.");
  }

  // Check top of head cutoff using segmentation mask or nose landmark
  let headTopRowNorm = null;
  let maskObj = poseResult.segmentationMasks?.[0] || null;
  if (maskObj) {
    try {
      const maskW = maskObj.width;
      const maskH = maskObj.height;
      const data = typeof maskObj.getAsFloat32Array === 'function' ? maskObj.getAsFloat32Array() : maskObj.getAsUint8Array();
      const thresh = (data instanceof Float32Array) ? 0.5 : 128;
      for (let r = 0; r < maskH; r++) {
        const offset = r * maskW;
        for (let c = 0; c < maskW; c++) {
          if (data[offset + c] >= thresh) {
            headTopRowNorm = r / maskH;
            break;
          }
        }
        if (headTopRowNorm !== null) break;
      }
    } catch (_) {}
  }

  if (headTopRowNorm !== null) {
    if (headTopRowNorm <= 0.015) {
      errors.push("Your head touches the top of the frame. Step back so there is space above your head.");
    }
  } else if (nose && nose.y <= 0.06) {
    errors.push("Your head touches the top of the frame. Step back so there is space above your head.");
  }

  // 7. Person height < 60% of image height
  const topEst = headTopRowNorm !== null ? headTopRowNorm : Math.max(0, (nose?.y || 0.1) - 0.10);
  const bottomEst = Math.max(ankleYNorm, l[31]?.y || 0, l[32]?.y || 0);
  const personHeightRatio = bottomEst - topEst;

  if (personHeightRatio < 0.60) {
    errors.push(`You are too far from the camera (${Math.round(personHeightRatio * 100)}% of frame height, minimum is 60%). Please step closer to the camera.`);
  }

  // --- WARNINGS ---

  // 1. Not frontal check:
  // Shoulder z-difference or nose offset from shoulder midpoint
  const midShoulderX = (l[11].x + l[12].x) / 2;
  const shoulderSpan = Math.abs(l[11].x - l[12].x);
  const noseDev = Math.abs(l[0].x - midShoulderX) / (shoulderSpan || 0.2);
  const shoulderZDiff = Math.abs((l[11].z || 0) - (l[12].z || 0));

  if (noseDev > 0.22 || shoulderZDiff > 0.16) {
    warnings.push("You do not appear to be facing the camera straight on. Stand facing the camera squarely for the best fit result.");
  }

  // 2. Arms close to or crossing torso
  // Torso x bounds roughly between shoulders and hips
  const torsoLeft = Math.min(l[12].x, l[24].x);  // viewer's left
  const torsoRight = Math.max(l[11].x, l[23].x); // viewer's right
  const lWrist = l[15];
  const rWrist = l[16];

  let armsCrossing = false;
  if (lWrist && lWrist.x > torsoLeft + 0.02 && lWrist.x < torsoRight - 0.02 && lWrist.y < l[23].y + 0.1) {
    armsCrossing = true;
  }
  if (rWrist && rWrist.x > torsoLeft + 0.02 && rWrist.x < torsoRight - 0.02 && rWrist.y < l[24].y + 0.1) {
    armsCrossing = true;
  }

  if (armsCrossing) {
    warnings.push("Arms appear to be crossing over your torso. Stand with arms relaxed slightly away from the body.");
  } else {
    // Check if wrists are glued to hips
    const distL = Math.hypot(l[15].x - l[23].x, l[15].y - l[23].y);
    const distR = Math.hypot(l[16].x - l[24].x, l[16].y - l[24].y);
    if (distL < 0.035 || distR < 0.035) {
      warnings.push("Arms are very close to your body. Holding arms a few centimeters away improves garment draping accuracy.");
    }
  }

  // 3. Silhouette at hip level much wider than hip landmarks (baggy clothes)
  if (maskObj) {
    try {
      const maskW = maskObj.width;
      const maskH = maskObj.height;
      const data = typeof maskObj.getAsFloat32Array === 'function' ? maskObj.getAsFloat32Array() : maskObj.getAsUint8Array();
      const thresh = (data instanceof Float32Array) ? 0.5 : 128;
      const hipRow = Math.min(maskH - 1, Math.max(0, Math.round(((l[23].y + l[24].y) / 2) * maskH)));

      let hipRowWidth = 0;
      const rowOffset = hipRow * maskW;
      for (let c = 0; c < maskW; c++) {
        if (data[rowOffset + c] >= thresh) hipRowWidth++;
      }
      const lmHipSpanPx = Math.abs(l[23].x - l[24].x) * maskW;
      if (lmHipSpanPx > 10 && hipRowWidth > 1.70 * lmHipSpanPx) {
        warnings.push("Clothes appear loose or baggy around the hips. Fitted clothes (like leggings) provide the most accurate measurements.");
      }
    } catch (_) {}
  }

  // Clean up segmentation masks if needed
  try {
    if (poseResult.segmentationMasks) {
      for (const m of poseResult.segmentationMasks) {
        if (typeof m.close === 'function') m.close();
      }
    }
  } catch (_) {}

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: {
      w,
      h,
      aspect: +aspect.toFixed(2),
      personHeightRatio: +personHeightRatio.toFixed(2),
      meanLuminance: Math.round(meanLuminance)
    }
  };
}
