/**
 * geminiValidate.js — Validates Gemini-generated avatar output against the original photo.
 * Compares body proportions (shoulder, hip, leg, arm ratios to body height) and background.
 */

/**
 * Checks if the corners of an image are mostly white studio background.
 * @param {HTMLImageElement|HTMLCanvasElement} img
 * @returns {boolean}
 */
export function checkWhiteBackground(img) {
  if (typeof document === 'undefined') return true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 150;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const corners = [
      [5, 5],
      [95, 5],
      [5, 145],
      [95, 145]
    ];

    let whiteCorners = 0;
    for (const [x, y] of corners) {
      const px = ctx.getImageData(x, y, 1, 1).data;
      const r = px[0], g = px[1], b = px[2];
      const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
      const isNeutral = Math.abs(r - g) < 25 && Math.abs(g - b) < 25;
      if (brightness > 210 && isNeutral) {
        whiteCorners++;
      }
    }
    return whiteCorners >= 3;
  } catch (_) {
    return true;
  }
}

/**
 * Compares proportion ratios between original photo landmarks and Gemini output landmarks.
 * @param {Array} oL - Original 33 MediaPipe landmarks
 * @param {Array} gL - Gemini 33 MediaPipe landmarks
 * @returns {{maxDiff: number, status: 'pass'|'warn'|'reject', message: string, diffs: object}}
 */
export function compareProportions(oL, gL) {
  if (!oL || oL.length < 33 || !gL || gL.length < 33) {
    return {
      maxDiff: 1.0,
      status: 'reject',
      message: 'Incomplete pose landmarks for comparison.',
      diffs: { shoulder: 1.0, hip: 1.0, leg: 1.0, arm: 1.0 }
    };
  }

  // Body heights (nose to ankles midpoint)
  const hOrig = Math.abs(((oL[27].y + oL[28].y) / 2) - oL[0].y);
  const hGem  = Math.abs(((gL[27].y + gL[28].y) / 2) - gL[0].y);

  if (hOrig < 0.1 || hGem < 0.1) {
    return {
      maxDiff: 1.0,
      status: 'reject',
      message: 'Body height too small to validate.',
      diffs: { shoulder: 1.0, hip: 1.0, leg: 1.0, arm: 1.0 }
    };
  }

  // 1. Shoulder width / height
  const shOrig = Math.hypot(oL[11].x - oL[12].x, oL[11].y - oL[12].y) / hOrig;
  const shGem  = Math.hypot(gL[11].x - gL[12].x, gL[11].y - gL[12].y) / hGem;
  const diffSh = Math.abs(shOrig - shGem) / (shOrig || 1);

  // 2. Hip width / height
  const hipOrig = Math.hypot(oL[23].x - oL[24].x, oL[23].y - oL[24].y) / hOrig;
  const hipGem  = Math.hypot(gL[23].x - gL[24].x, gL[23].y - gL[24].y) / hGem;
  const diffHip = Math.abs(hipOrig - hipGem) / (hipOrig || 1);

  // 3. Leg length / height (average of left & right legs: hip -> knee -> ankle)
  const legLenOrig = (
    (Math.hypot(oL[23].x - oL[25].x, oL[23].y - oL[25].y) + Math.hypot(oL[25].x - oL[27].x, oL[25].y - oL[27].y)) +
    (Math.hypot(oL[24].x - oL[26].x, oL[24].y - oL[26].y) + Math.hypot(oL[24].x - oL[28].x, oL[24].y - oL[28].y))
  ) / 2 / hOrig;

  const legLenGem = (
    (Math.hypot(gL[23].x - gL[25].x, gL[23].y - gL[25].y) + Math.hypot(gL[25].x - gL[27].x, gL[25].y - gL[27].y)) +
    (Math.hypot(gL[24].x - gL[26].x, gL[24].y - gL[26].y) + Math.hypot(gL[24].x - gL[28].x, gL[24].y - gL[28].y))
  ) / 2 / hGem;
  const diffLeg = Math.abs(legLenOrig - legLenGem) / (legLenOrig || 1);

  // 4. Arm length / height (average of left & right arms: shoulder -> elbow -> wrist)
  const armLenOrig = (
    (Math.hypot(oL[11].x - oL[13].x, oL[11].y - oL[13].y) + Math.hypot(oL[13].x - oL[15].x, oL[13].y - oL[15].y)) +
    (Math.hypot(oL[12].x - oL[14].x, oL[12].y - oL[14].y) + Math.hypot(oL[14].x - oL[16].x, oL[14].y - oL[16].y))
  ) / 2 / hOrig;

  const armLenGem = (
    (Math.hypot(gL[11].x - gL[13].x, gL[11].y - gL[13].y) + Math.hypot(gL[13].x - gL[15].x, gL[13].y - gL[15].y)) +
    (Math.hypot(gL[12].x - gL[14].x, gL[12].y - gL[14].y) + Math.hypot(gL[14].x - gL[16].x, gL[14].y - gL[16].y))
  ) / 2 / hGem;
  const diffArm = Math.abs(armLenOrig - armLenGem) / (armLenOrig || 1);

  const maxDiff = Math.max(diffSh, diffHip, diffLeg, diffArm);

  let status = 'pass';
  let message = 'Proportions match closely (difference ≤ 6%).';

  if (maxDiff > 0.10) {
    status = 'reject';
    message = `AI altered your proportions significantly (${Math.round(maxDiff * 100)}% difference in ${
      maxDiff === diffSh ? 'shoulders' : maxDiff === diffHip ? 'hips' : maxDiff === diffLeg ? 'legs' : 'arms'
    }). Result rejected for accuracy.`;
  } else if (maxDiff > 0.06) {
    status = 'warn';
    message = `AI changed your proportions slightly (~${Math.round(maxDiff * 100)}% difference in ${
      maxDiff === diffSh ? 'shoulders' : maxDiff === diffHip ? 'hips' : maxDiff === diffLeg ? 'legs' : 'arms'
    }).`;
  }

  return {
    maxDiff: +maxDiff.toFixed(3),
    status,
    message,
    diffs: {
      shoulder: +diffSh.toFixed(3),
      hip: +diffHip.toFixed(3),
      leg: +diffLeg.toFixed(3),
      arm: +diffArm.toFixed(3)
    }
  };
}

/**
 * Validates the Gemini output image: checks person count, frontal pose, white background,
 * and proportion accuracy relative to the original photo.
 * @param {HTMLImageElement|HTMLCanvasElement} geminiImg
 * @param {object} geminiPoseResult
 * @param {Array} origLandmarks
 * @returns {{ok: boolean, status: 'pass'|'warn'|'reject', reason: string, details: object}}
 */
export function validateGeminiOutput(geminiImg, geminiPoseResult, origLandmarks) {
  // 1. Exactly one person
  if (!geminiPoseResult || !geminiPoseResult.landmarks || geminiPoseResult.landmarks.length === 0) {
    return { ok: false, status: 'reject', reason: 'No person detected in the AI output.', details: {} };
  }
  if (geminiPoseResult.landmarks.length > 1) {
    return { ok: false, status: 'reject', reason: 'Multiple figures generated by AI. Only one person is allowed.', details: {} };
  }

  const gL = geminiPoseResult.landmarks[0];

  // 2. Full body visibility (feet and head not cut off)
  const leftAnkle = gL[27];
  const rightAnkle = gL[28];
  if (!leftAnkle || !rightAnkle || leftAnkle.y > 0.98 || rightAnkle.y > 0.98) {
    return { ok: false, status: 'reject', reason: 'AI generated avatar with feet or shoes cut off at the bottom.', details: {} };
  }
  if (gL[0] && gL[0].y <= 0.04) {
    return { ok: false, status: 'reject', reason: 'AI generated avatar with head touching or cut off at top of frame.', details: {} };
  }

  // 3. Frontal check
  const midShX = (gL[11].x + gL[12].x) / 2;
  const shSpan = Math.abs(gL[11].x - gL[12].x);
  const noseDev = Math.abs(gL[0].x - midShX) / (shSpan || 0.2);
  const shZDiff = Math.abs((gL[11].z || 0) - (gL[12].z || 0));
  if (noseDev > 0.25 || shZDiff > 0.20) {
    return { ok: false, status: 'reject', reason: 'AI generated a pose that is not standing squarely facing the camera.', details: {} };
  }

  // 4. Mostly white background
  const hasWhiteBg = checkWhiteBackground(geminiImg);
  if (!hasWhiteBg) {
    return { ok: false, status: 'reject', reason: 'AI generated background is not clean studio white.', details: {} };
  }

  // 5. Compare proportions with original
  const prop = compareProportions(origLandmarks, gL);

  return {
    ok: prop.status !== 'reject',
    status: prop.status,
    reason: prop.message,
    details: prop
  };
}
