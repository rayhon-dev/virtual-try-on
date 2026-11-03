// mannequin.js — the parametric 2D SVG mannequin (front view) + base outfit.
//
// Two separate steps:
//   1. computeBodyGeometry(body)   PURE: measurements (cm) -> key points (cm)
//   2. buildMannequinSvg(geometry) geometry -> SVG markup (a string)
// The garment renderer (Phase 5) reuses the same geometry, so a garment is
// drawn on exactly the same body that the fit engine measured.
//
// Coordinates are in CENTIMETRES: x = 0 is the body's centre line (right = +x),
// y = 0 is the top of the head, y = height is the floor. A single scale factor
// (pxPerCm, derived from the height) turns cm into SVG pixels.
//
// Realism comes from three things: anatomical outlines (smooth curves through
// landmark points), one light source (upper left) in every gradient, and soft
// blurred shadows clipped inside each shape.

// ---------------------------------------------------------------------------
// The conversion constant (the ONLY place it is defined)
// ---------------------------------------------------------------------------

/**
 * Circumference -> visible front width.
 * A torso cross-section is roughly an ellipse about 1.35× wider than deep;
 * for such an ellipse the front width ≈ 0.34 × circumference.
 * Used for body chest/waist/hip AND for garment chest/waist/hem, so a garment
 * with 0 cm ease is drawn exactly as wide as the body.
 */
export const CIRC_TO_FRONT_WIDTH = 0.34;
export const frontWidth = (circumference) => circumference * CIRC_TO_FRONT_WIDTH;

const VIEW_HEIGHT = 800;    // SVG height in px — every mannequin is scaled to fit it
const MIN_VIEW_WIDTH = 440; // SVG width in px (grows if the figure is wider)
const PAD_CM = 5;           // empty space around the figure
const ELBOW_T = 0.55;       // elbow position along the arm (0 = shoulder, 1 = wrist)

/** Skin, hair and base outfit colours (kept here, next to the drawing code). */
const COLORS = {
  skinLight: '#f1e2d3', skinMid: '#e2c9b3', skinDark: '#c9a88e', skinShadow: '#b38f75',
  hairLight: '#5a4334', hairDark: '#231a15',
  trouserLight: '#4a4a4e', trouserMid: '#333336', trouserDark: '#1c1c1f', trouserSheen: '#8a8a90',
  shoeLight: '#4a4542', shoeDark: '#121110',
  belt: '#151413', buckle: '#a39d93',
  shadow: '#2b2118',
};

/** Neutral base T-shirt colours per gender: [light, mid, dark]. */
const TEE = {
  male: ['#ece5da', '#ddd4c6', '#c4b9a8'],   // oat
  female: ['#fbf9f5', '#efebe4', '#d9d3c9'], // ivory
};

/**
 * Gender base curves. Every number is a ratio:
 *   *Y / *T -> vertical position (fraction of height H, or of torso length T)
 *   arm*    -> arm thickness as a fraction of chest circumference
 */
const SHAPES = {
  male: {
    headH: 0.13, headW: 0.084, jaw: 0.8, chin: 0.34, shoulderY: 0.182, shoulderSlope: 4.6, neck: 0.135,
    armpitT: 0.26, chestT: 0.3, waistT: 0.62,
    armUpper: 0.105, armElbow: 0.07, armForearm: 0.082, armWrist: 0.058, carryDeg: 5,
    handLen: 0.106, armAngle: 6,
    rise: 0.35, legScale: 1, hair: 'short',
    // Base outfit: crew-neck tee tucked into straight trousers with a belt
    tee: { neck: 'crew', neckDip: 2.4, sleeveEnd: 0.36, ease: 1.2, tucked: true },
    trousers: { knee: 0.043, calf: 0.042, shin: 0.041, hem: 0.04, hemY: 0.966 },
    shoeHalf: 0.033,
  },
  female: {
    headH: 0.128, headW: 0.082, jaw: 0.7, chin: 0.26, shoulderY: 0.18, shoulderSlope: 4.2, neck: 0.125,
    armpitT: 0.26, chestT: 0.3, waistT: 0.58,
    armUpper: 0.1, armElbow: 0.066, armForearm: 0.076, armWrist: 0.054, carryDeg: 9,
    handLen: 0.102, armAngle: 5,
    rise: 0.3, legScale: 0.93, hair: 'long',
    // Base outfit: fitted V-neck tee over wide-leg trousers
    tee: { neck: 'v', neckDip: 7, sleeveEnd: 0.27, ease: 0.6, tucked: false },
    trousers: { knee: 0.045, calf: 0.05, shin: 0.056, hem: 0.062, hemY: 0.976 },
    shoeHalf: 0.029,
  },
};

// --- small math helpers ---
const lerp = (a, b, t) => a + (b - a) * t; // linear interpolation
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const smoothstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Step 1 — geometry (pure)
// ---------------------------------------------------------------------------

/**
 * body = { gender, measurements: { height, chest, waist, hip, shoulder, armLength, torsoLength, thigh?, inseam? } }
 * Returns an object with every key point (cm) the drawing and the garments need.
 */
export function computeBodyGeometry(body) {
  const s = SHAPES[body.gender] ?? SHAPES.male;
  const m = body.measurements;
  const H = m.height;
  const T = m.torsoLength;

  // --- vertical landmarks (y, cm from the top of the head) ---
  const headH = H * s.headH;
  const shoulderY = Math.max(H * s.shoulderY, headH + s.shoulderSlope + 3);
  const neckBaseY = shoulderY - s.shoulderSlope;
  const armpitY = shoulderY + T * s.armpitT;
  const chestY = shoulderY + T * s.chestT;
  const waistY = shoulderY + T * s.waistT;
  const hipY = shoulderY + T; // torso length = shoulder point -> hip line
  const crotchY = clamp(H - (m.inseam ?? H * 0.46), hipY + 5, H * 0.6);

  // --- half widths (x, cm from the centre line) ---
  const shoulderHalf = m.shoulder / 2; // shoulder is a straight width, no conversion
  const chestHalf = frontWidth(m.chest) / 2;
  const waistHalf = frontWidth(m.waist) / 2;
  const hipHalf = frontWidth(m.hip) / 2;
  const neckHalf = m.shoulder * s.neck;

  // Right-side torso outline from armpit to hip ({ y, half }); the left side is a mirror.
  const torsoProfile = body.gender === 'female'
    ? [
      { y: armpitY, half: chestHalf * 0.97 },
      { y: chestY, half: chestHalf },
      { y: chestY + T * 0.12, half: lerp(chestHalf, waistHalf, 0.45) }, // under-bust
      { y: waistY, half: waistHalf },
      { y: lerp(waistY, hipY, 0.45), half: lerp(waistHalf, hipHalf, 0.8) }, // high hip
      { y: hipY, half: hipHalf },
    ]
    : [
      { y: armpitY, half: chestHalf * 0.98 },
      { y: chestY, half: chestHalf },
      { y: lerp(chestY, waistY, 0.5), half: lerp(chestHalf, waistHalf, 0.55) },
      { y: waistY, half: waistHalf },
      { y: lerp(waistY, hipY, 0.5), half: lerp(waistHalf, hipHalf, 0.55) },
      { y: hipY, half: hipHalf },
    ];

  // --- arms: hang from the shoulder points, angled just enough to clear the body ---
  const arm = {
    length: m.armLength,
    upper: m.chest * s.armUpper,
    elbow: m.chest * s.armElbow,
    forearm: m.chest * s.armForearm,
    wrist: m.chest * s.armWrist,
    handLen: H * s.handLen,
    carryDeg: s.carryDeg, // forearm turns slightly outward at the elbow (natural "carrying angle")
  };
  // Two checks: the wrist must clear the widest part of the torso, and the arm just
  // below the T-shirt sleeve (t ≈ 0.36) must clear the chest.
  const widestTorso = Math.max(chestHalf, waistHalf, hipHalf + 0.6);
  const sinForWrist = (widestTorso + 2 + arm.wrist / 2 - shoulderHalf) / arm.length;
  const sinForChest = (chestHalf + 1.2 + lerp(arm.upper, arm.elbow, 0.5) / 2 - shoulderHalf) / (0.36 * arm.length);
  const neededSin = clamp(Math.max(sinForWrist, sinForChest), 0, 0.42);
  arm.angleDeg = clamp(Math.max(s.armAngle, deg(Math.asin(neededSin))), 0, 25);

  // Arm thickness along the arm: t = 0 shoulder point, t = 1 wrist.
  // out = half width on the outer side (deltoid, triceps), in = inner side (biceps).
  const u = arm.upper;
  arm.samples = [
    { t: 0.05, out: u * 0.44, in: u * 0.36 },
    { t: 0.14, out: u * 0.53, in: u * 0.46 }, // deltoid
    { t: 0.3, out: u * 0.48, in: u * 0.5 },
    { t: 0.42, out: u * 0.44, in: u * 0.5 },  // biceps
    { t: ELBOW_T, out: arm.elbow * 0.5, in: arm.elbow * 0.46 },
    { t: 0.65, out: arm.forearm * 0.54, in: arm.forearm * 0.5 }, // forearm muscle
    { t: 0.82, out: lerp(arm.forearm, arm.wrist, 0.6) * 0.5, in: lerp(arm.forearm, arm.wrist, 0.6) * 0.47 },
    { t: 1, out: arm.wrist * 0.5, in: arm.wrist * 0.5 },
  ];

  // --- legs: centre x of each trouser leg + half widths at knee / calf / shin / hem ---
  const tr = s.trousers;
  const legs = {
    kneeY: H * 0.715,
    calfY: H * 0.8,
    shinY: H * 0.885,
    hemY: H * tr.hemY,
    kneeHalf: H * tr.knee,
    calfHalf: H * tr.calf,
    shinHalf: H * tr.shin,
    hemHalf: H * tr.hem,
  };
  legs.kneeX = Math.max(hipHalf * 0.48, legs.kneeHalf + 0.5);
  legs.calfX = Math.max(hipHalf * 0.49, legs.calfHalf + 0.5);
  legs.shinX = Math.max(hipHalf * 0.5, legs.shinHalf + 0.45);
  legs.ankleX = Math.max(hipHalf * 0.5, legs.hemHalf + 0.4);
  legs.footX = hipHalf * 0.5 + 0.6; // the feet stay hip-width apart, even under wide trousers
  legs.outerThighX = m.thigh
    ? clamp(0.6 + m.thigh * 0.3, hipHalf * 0.85, hipHalf * 1.1)
    : hipHalf * 0.97;
  // "jeansTop" = top of the trousers (waistband); the name is kept for the garment renderer
  legs.jeansTopY = lerp(waistY, hipY, s.rise);
  legs.jeansTopHalf = lerp(waistHalf, hipHalf, s.rise * 0.9) + 0.4;
  legs.shoeHalf = H * s.shoeHalf * s.legScale;
  legs.shoeH = H * 0.05;

  const geometry = {
    gender: body.gender, height: H, shape: s,
    headH, headHalf: (H * s.headW) / 2, neckHalf, neckBaseY,
    shoulderY, shoulderHalf, armpitY, chestY, chestHalf, waistY, waistHalf, hipY, hipHalf, crotchY,
    torsoProfile, arm, legs,
  };

  // --- scale: px per cm comes from the height, so every mannequin fills the view ---
  const pxPerCm = VIEW_HEIGHT / (H + 2 * PAD_CM);
  const handEnd = armAxis(geometry, 1).at(1 + arm.handLen / arm.length);
  const halfExtentCm = Math.max(handEnd.x + arm.wrist, shoulderHalf + arm.upper, hipHalf) + PAD_CM + 4;
  geometry.view = {
    pxPerCm,
    height: VIEW_HEIGHT,
    width: Math.max(MIN_VIEW_WIDTH, 2 * halfExtentCm * pxPerCm),
  };
  return geometry;
}

/**
 * Arm axis for one side (side = 1 right, -1 left). The axis bends slightly
 * outward at the elbow. Returns:
 *   origin     shoulder point
 *   dir        unit vector of the upper arm
 *   at(t)      point on the axis (t = 0 shoulder, 1 wrist, > 1 into the hand)
 *   dirAt(t)   unit vector along the axis at t
 *   outAt(t)   unit vector pointing away from the body at t
 */
export function armAxis(geo, side) {
  const a1 = rad(geo.arm.angleDeg);
  const a2 = rad(geo.arm.angleDeg + geo.arm.carryDeg);
  const L = geo.arm.length;
  const origin = { x: side * geo.shoulderHalf, y: geo.shoulderY };
  const d1 = { x: side * Math.sin(a1), y: Math.cos(a1) };
  const d2 = { x: side * Math.sin(a2), y: Math.cos(a2) };
  const elbow = offset(origin, d1, ELBOW_T * L);

  const at = (t) => (t <= ELBOW_T ? offset(origin, d1, t * L) : offset(elbow, d2, (t - ELBOW_T) * L));
  // Blend the angle around the elbow so outlines bend smoothly
  const angleAt = (t) => lerp(a1, a2, smoothstep((t - (ELBOW_T - 0.07)) / 0.14));
  const dirAt = (t) => ({ x: side * Math.sin(angleAt(t)), y: Math.cos(angleAt(t)) });
  const outAt = (t) => ({ x: side * Math.cos(angleAt(t)), y: -Math.sin(angleAt(t)) });
  return { origin, dir: d1, at, dirAt, outAt };
}

/** Arm half width at t on the 'out' or 'in' side, interpolated from the samples. */
export function armHalfAt(geo, t, which = 'out') {
  const s = geo.arm.samples;
  if (t <= s[0].t) return s[0][which];
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i].t) return lerp(s[i - 1][which], s[i][which], (t - s[i - 1].t) / (s[i].t - s[i - 1].t));
  }
  return s[s.length - 1][which];
}

// ---------------------------------------------------------------------------
// Path helpers (also used by the garment renderer)
// ---------------------------------------------------------------------------

const f = (n) => n.toFixed(2);                    // number -> short string
export const pt = (p) => `${f(p.x)},${f(p.y)}`;   // {x, y} -> "x,y"
export const mirror = (p) => ({ x: -p.x, y: p.y });
function offset(p, dir, d) { return { x: p.x + dir.x * d, y: p.y + dir.y * d }; }

/**
 * Smooth curve through points (Catmull-Rom spline -> cubic Bézier "C" commands).
 * Assumes the pen is already at points[0].
 */
export function smoothThrough(points) {
  let d = '';
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d;
}

/** Closed smooth shape through all points (the last point connects back to the first). */
export function smoothClosed(points) {
  const n = points.length;
  let d = `M ${pt(points[0])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return `${d} Z`;
}

/**
 * A straight tube along an axis as a closed path (kept for simple garment parts).
 * samples = [{ t, half }]: t = 0..1 along `length`, half = half width at t.
 */
export function tubePath(origin, dir, length, samples, { capTop = false, capBottom = false } = {}) {
  const n = { x: dir.y, y: -dir.x };
  const center = (t) => offset(origin, dir, t * length);
  const sideA = samples.map(({ t, half }) => offset(center(t), n, half));
  const sideB = samples.map(({ t, half }) => offset(center(t), n, -half));
  const k = 4 / 3; // Bézier handle length for a round cap
  const first = samples[0].half;
  const last = samples[samples.length - 1].half;
  const aEnd = sideA[sideA.length - 1];
  const bEnd = sideB[sideB.length - 1];

  let d = `M ${pt(sideA[0])}${smoothThrough(sideA)}`;
  d += capBottom
    ? ` C ${pt(offset(aEnd, dir, last * k))} ${pt(offset(bEnd, dir, last * k))} ${pt(bEnd)}`
    : ` L ${pt(bEnd)}`;
  d += smoothThrough([...sideB].reverse());
  if (capTop) {
    d += ` C ${pt(offset(sideB[0], dir, -first * k))} ${pt(offset(sideA[0], dir, -first * k))} ${pt(sideA[0])}`;
  }
  return `${d} Z`;
}

/**
 * A set-in sleeve: starts at the shoulder seam, follows the arm down to `end`
 * (fraction of arm length), and comes back up the inside to the armpit.
 *   ease      extra half width around the arm (cm)
 *   seamX/Y   shoulder seam point (wider than the body for drop shoulders)
 *   cuffHalf  if given, the sleeve tapers straight to this half width (jackets);
 *             otherwise it follows the arm's muscles (fitted T-shirt)
 * Returns { d, hem: [outerPoint, innerPoint], dir }. Also used by the garment renderer.
 */
export function sleevePath(geo, side, {
  end, ease, seamX = geo.shoulderHalf + 0.6, seamY = geo.shoulderY - 0.2,
  cuffHalf, armpitX, armpitY = geo.armpitY,
}) {
  const ax = armAxis(geo, side);
  const P = (t, h) => offset(ax.at(t), ax.outAt(t), h);
  const tSeam = clamp((seamX - geo.shoulderHalf - 0.6) / geo.arm.length, 0, 0.3);
  const t1 = Math.max(0.12, tSeam + 0.06);
  const outTop = armHalfAt(geo, t1, 'out') + ease + 0.2;
  const inTop = armHalfAt(geo, 0.3, 'in') + ease;
  const k = (t) => (t - t1) / (end - t1);
  const outH = (t) => (cuffHalf != null ? lerp(outTop, cuffHalf, k(t)) : armHalfAt(geo, t, 'out') + ease);
  const inH = (t) => (cuffHalf != null ? lerp(inTop, cuffHalf, clamp((t - 0.3) / (end - 0.3), 0, 1)) : armHalfAt(geo, t, 'in') + ease);

  const steps = end > 0.45 ? 4 : 2;
  const ts = Array.from({ length: steps + 1 }, (_, i) => lerp(t1, end, i / steps)); // like [t1 ... end]
  const seam = { x: side * seamX, y: seamY };
  const outer = [seam, ...ts.map((t, i) => P(t, i === 0 ? outTop : outH(t)))];
  const innerTs = ts.filter((t) => t >= 0.26).reverse();
  const inner = innerTs.map((t) => P(t, -inH(t)));
  const armpit = { x: side * (armpitX ?? geo.chestHalf * 0.97 + ease), y: armpitY };
  // Back up along the armhole (inside the torso) so no gap is left under the arm
  const armhole = { x: side * (lerp(Math.abs(armpit.x), seamX, 0.5) - 1.8), y: lerp(armpitY, seamY, 0.55) };

  const innerEnd = inner[0];
  const d = `M ${pt(seam)}${smoothThrough(outer)} L ${pt(innerEnd)}${smoothThrough([...inner, armpit, armhole, seam])} Z`;
  return { d, hem: [outer[outer.length - 1], innerEnd], dir: ax.dirAt(end) };
}

// ---------------------------------------------------------------------------
// Step 2 — drawing
// ---------------------------------------------------------------------------

/** Gradients, blur filters and the fabric texture. */
function defs(id, gender) {
  const stops = (list) => list.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
  const C = COLORS;
  const [teeLight, teeMid, teeDark] = TEE[gender] ?? TEE.male;
  const blur = (name, sd) =>
    `<filter id="${id}-${name}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
  return `
    <defs>
      <linearGradient id="${id}-skin" x1="0" x2="1" y1="0" y2="0">
        ${stops([[0, C.skinDark], [0.14, C.skinMid], [0.38, C.skinLight], [0.7, C.skinMid], [1, C.skinShadow]])}
      </linearGradient>
      <radialGradient id="${id}-head" cx="0.38" cy="0.36" r="0.72">
        ${stops([[0, C.skinLight], [0.55, C.skinMid], [0.85, C.skinDark], [1, C.skinShadow]])}
      </radialGradient>
      <linearGradient id="${id}-hair" x1="0" x2="0.6" y1="0" y2="1">
        ${stops([[0, C.hairLight], [0.45, C.hairDark], [1, C.hairDark]])}
      </linearGradient>
      <linearGradient id="${id}-shirt" x1="0" x2="1" y1="0" y2="0">
        ${stops([[0, teeMid], [0.3, teeLight], [0.55, teeLight], [0.85, teeMid], [1, teeDark]])}
      </linearGradient>
      <linearGradient id="${id}-trousers" x1="0" x2="1" y1="0" y2="0">
        ${stops([[0, C.trouserDark], [0.14, C.trouserLight], [0.33, C.trouserMid], [0.48, C.trouserDark],
                 [0.6, C.trouserLight], [0.8, C.trouserMid], [1, C.trouserDark]])}
      </linearGradient>
      <linearGradient id="${id}-shoe" x1="0" x2="0.4" y1="0" y2="1">
        ${stops([[0, C.shoeLight], [0.55, '#24211f'], [1, C.shoeDark]])}
      </linearGradient>
      <radialGradient id="${id}-floor">
        ${stops([[0, C.shadow, 0.28], [0.6, C.shadow, 0.1], [1, C.shadow, 0]])}
      </radialGradient>
      ${blur('blurS', 0.35)}${blur('blurM', 0.9)}${blur('blurL', 2.2)}
      <filter id="${id}-noise" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.1 0.35" numOctaves="2" seed="7"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.1 0 0 0 -0.5"/>
      </filter>
    </defs>`;
}

// --- tiny SVG element helpers (return strings) ---
const shade = (id, d, { color = COLORS.shadow, opacity = 0.15, blur = 'blurM', width } = {}) =>
  width
    ? `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" filter="url(#${id}-${blur})"/>`
    : `<path d="${d}" fill="${color}" fill-opacity="${opacity}" filter="url(#${id}-${blur})"/>`;
const blob = (id, cx, cy, rx, ry, { color = COLORS.shadow, opacity = 0.15, blur = 'blurL' } = {}) =>
  `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${color}" fill-opacity="${opacity}" filter="url(#${id}-${blur})"/>`;
const clipped = (clipId, content) => `<g clip-path="url(#${clipId})">${content}</g>`;
const clipDef = (clipId, d) => `<clipPath id="${clipId}"><path d="${d}"/></clipPath>`;

// --- head, hair, neck -------------------------------------------------------

function headPoints(g) {
  const w = g.headHalf;
  const h = g.headH;
  const s = g.shape;
  // Right half from crown to chin; the left half is mirrored.
  const right = [
    { x: w * 0.55, y: h * 0.03 },
    { x: w * 0.92, y: h * 0.2 },
    { x: w, y: h * 0.38 },          // widest part of the skull
    { x: w * 0.95, y: h * 0.52 },   // temple / cheekbone
    { x: w * 0.9, y: h * 0.64 },
    { x: w * s.jaw, y: h * 0.8 },   // jaw angle
    { x: w * (s.chin + 0.14), y: h * 0.94 },
    { x: w * s.chin * 0.5, y: h },  // chin
  ];
  return [{ x: 0, y: 0 }, ...right, { x: 0, y: h * 1.005 }, ...right.map(mirror).reverse()];
}

/** Head shape (skull, cheekbones, jaw, chin) with soft shading. */
function drawHead(g, id) {
  const w = g.headHalf;
  const h = g.headH;
  const d = smoothClosed(headPoints(g));
  // Soft face planes (volume); the features are drawn by drawFace().
  const face = clipped(`${id}-clip-head`, [
    blob(id, w * 0.75, h * 0.58, w * 0.42, h * 0.42, { opacity: 0.16 }),                       // shadow side
    blob(id, -w * 0.4, h * 0.5, w * 0.26, h * 0.07, { opacity: 0.06, blur: 'blurM' }),         // eye sockets
    blob(id, w * 0.4, h * 0.5, w * 0.26, h * 0.07, { opacity: 0.08, blur: 'blurM' }),
    blob(id, -w * 0.06, h * 0.6, w * 0.07, h * 0.12, { color: '#fff', opacity: 0.35, blur: 'blurM' }), // nose ridge
    blob(id, w * 0.05, h * 0.715, w * 0.13, h * 0.025, { opacity: 0.13, blur: 'blurS' }),      // under the nose
    blob(id, -w * 0.48, h * 0.66, w * 0.22, h * 0.1, { color: '#fff', opacity: 0.22 }),        // cheek light
    blob(id, 0, h * 1.02, w * 0.6, h * 0.08, { opacity: 0.2, blur: 'blurM' }),                 // under chin
  ].join(''));
  return `${clipDef(`${id}-clip-head`, d)}<path d="${d}" fill="url(#${id}-head)"/>${face}`;
}

/** Face colours per gender. */
const FACE = {
  male:   { brow: '#2f231c', browW: 0.5, lash: '#2a1f19', iris: '#5b3f2c', lipTop: '#b57f70', lipBottom: '#c48d7e', blush: 0 },
  female: { brow: '#3a2b22', browW: 0.34, lash: '#1d1512', iris: '#4a3324', lipTop: '#b86d66', lipBottom: '#c97f76', blush: 0.16 },
};

/**
 * An original illustrated face (not a real person). Classic proportions:
 * eyes at half the head height, one eye width apart; brows above; nose tip at ~0.69,
 * mouth at ~0.8 of the head height.
 */
function drawFace(g, id) {
  const w = g.headHalf;
  const h = g.headH;
  const c = FACE[g.gender] ?? FACE.male;
  const female = g.gender === 'female';
  const P = (x, y) => ({ x: x * w, y: y * h });
  const out = [];

  for (const side of [1, -1]) {
    const S = (x, y) => P(side * x, y);
    const ex = 0.4;                  // eye centre (× head half width)
    const ey = 0.5;                  // eye centre (× head height)
    const ew = 0.19;                 // half eye width
    const eh = female ? 0.052 : 0.042; // eye opening (× head height)
    // Almond-shaped eye: inner corner -> upper lid -> outer corner -> lower lid
    const inner = S(ex - ew, ey + 0.004);
    const outerC = S(ex + ew, ey - (female ? 0.012 : 0.004));
    const eye = `M ${pt(inner)} C ${pt(S(ex - ew * 0.5, ey - eh))} ${pt(S(ex + ew * 0.55, ey - eh * 1.05))} ${pt(outerC)}
                 C ${pt(S(ex + ew * 0.5, ey + eh * 0.75))} ${pt(S(ex - ew * 0.5, ey + eh * 0.8))} ${pt(inner)} Z`;
    const clipId = `${id}-clip-eye${side}`;
    const iris = S(ex - 0.01, ey - 0.003);
    out.push(clipDef(clipId, eye));
    out.push(`<path d="${eye}" fill="#eee6de"/>`);
    out.push(clipped(clipId, `
      <circle cx="${f(iris.x)}" cy="${f(iris.y)}" r="${f(w * 0.085)}" fill="${c.iris}"/>
      <circle cx="${f(iris.x)}" cy="${f(iris.y)}" r="${f(w * 0.042)}" fill="#140e0b"/>
      <circle cx="${f(iris.x - w * 0.03)}" cy="${f(iris.y - h * 0.012)}" r="${f(w * 0.02)}" fill="#fff" fill-opacity="0.9"/>
      ${blob(id, side * ex * w, (ey - eh * 0.9) * h, ew * w * 1.2, eh * h * 0.6, { opacity: 0.35, blur: 'blurS' })}`));
    // Upper lash line (thicker for female, with a tiny wing), soft lower lid, lid crease
    out.push(`<path d="M ${pt(inner)} C ${pt(S(ex - ew * 0.5, ey - eh))} ${pt(S(ex + ew * 0.55, ey - eh * 1.05))} ${pt(outerC)}${female ? ` L ${pt(S(ex + ew * 1.12, ey - 0.026))}` : ''}"
                 fill="none" stroke="${c.lash}" stroke-width="${female ? 0.32 : 0.24}" stroke-linecap="round" stroke-linejoin="round"/>`);
    out.push(`<path d="M ${pt(S(ex - ew * 0.6, ey + eh * 0.62))} Q ${pt(S(ex, ey + eh * 1.1))} ${pt(S(ex + ew * 0.8, ey + eh * 0.4))}"
                 fill="none" stroke="${c.lash}" stroke-opacity="0.25" stroke-width="0.12" stroke-linecap="round"/>`);
    out.push(shade(id, `M ${pt(S(ex - ew * 0.7, ey - eh * 1.5))} Q ${pt(S(ex, ey - eh * 2.6))} ${pt(S(ex + ew * 0.9, ey - eh * 1.4))}`,
      { opacity: 0.22, width: 0.2, blur: 'blurS' }));
    // Eyebrow: straighter and fuller for male, thinner and arched for female
    const by = female ? 0.415 : 0.425;
    const brow = `M ${pt(S(ex - ew * 1.05, by + 0.012))} Q ${pt(S(ex + (female ? 0.02 : 0), by - (female ? 0.04 : 0.022)))} ${pt(S(ex + ew * 1.15, by + (female ? 0.012 : 0.004)))}`;
    out.push(`<path d="${brow}" fill="none" stroke="${c.brow}" stroke-width="${c.browW}" stroke-linecap="round" stroke-opacity="0.92"/>`);
    // Nose wings and cheek colour
    out.push(shade(id, `M ${pt(S(0.06, 0.665))} Q ${pt(S(0.17, 0.675))} ${pt(S(0.13, 0.705))}`, { opacity: 0.4, width: 0.25, blur: 'blurS' }));
    if (c.blush) out.push(blob(id, side * 0.5 * w, 0.66 * h, w * 0.2, h * 0.05, { color: '#e07a6a', opacity: c.blush, blur: 'blurL' }));
  }

  // Nose: side shadow along the bridge, soft tip highlight, nostril line
  out.push(shade(id, `M ${pt(P(0.06, 0.5))} Q ${pt(P(0.1, 0.62))} ${pt(P(0.1, 0.68))}`, { opacity: 0.16, width: 0.45, blur: 'blurS' }));
  out.push(blob(id, -0.02 * w, 0.675 * h, w * 0.07, h * 0.02, { color: '#fff', opacity: 0.4, blur: 'blurS' }));
  out.push(shade(id, `M ${pt(P(-0.07, 0.712))} Q ${pt(P(0, 0.725))} ${pt(P(0.07, 0.712))}`, { opacity: 0.35, width: 0.22, blur: 'blurS' }));

  // Lips: cupid's bow on top, fuller bottom lip, a darker line between them
  const mw = female ? 0.24 : 0.26; // half mouth width
  const my = 0.8;
  const top = `M ${pt(P(-mw, my))} C ${pt(P(-mw * 0.6, my - 0.03))} ${pt(P(-mw * 0.25, my - 0.04))} ${pt(P(0, my - 0.025))}
               C ${pt(P(mw * 0.25, my - 0.04))} ${pt(P(mw * 0.6, my - 0.03))} ${pt(P(mw, my))}
               Q ${pt(P(0, my + 0.008))} ${pt(P(-mw, my))} Z`;
  const bottom = `M ${pt(P(-mw * 0.92, my + 0.002))} Q ${pt(P(0, my + (female ? 0.07 : 0.055)))} ${pt(P(mw * 0.92, my + 0.002))}
                  Q ${pt(P(0, my + 0.012))} ${pt(P(-mw * 0.92, my + 0.002))} Z`;
  out.push(`<path d="${top}" fill="${c.lipTop}" fill-opacity="${female ? 0.95 : 0.6}"/>`);
  out.push(`<path d="${bottom}" fill="${c.lipBottom}" fill-opacity="${female ? 0.95 : 0.55}"/>`);
  out.push(`<path d="M ${pt(P(-mw, my))} Q ${pt(P(0, my + 0.012))} ${pt(P(mw, my))}" fill="none" stroke="#6e423a" stroke-opacity="0.7" stroke-width="0.16" stroke-linecap="round"/>`);
  out.push(blob(id, -0.06 * w, (my + 0.03) * h, w * 0.08, h * 0.012, { color: '#fff', opacity: 0.35, blur: 'blurS' })); // lip shine
  out.push(blob(id, 0, (my + 0.085) * h, w * 0.12, h * 0.018, { opacity: 0.12, blur: 'blurS' }));                    // under the lip
  return out.join('');
}

function drawEars(g, id) {
  const w = g.headHalf;
  const h = g.headH;
  return [1, -1].map((side) => {
    const P = (x, y) => ({ x: side * x * w, y: y * h });
    const ear = smoothClosed([P(0.9, 0.42), P(1.08, 0.44), P(1.12, 0.53), P(1.06, 0.66), P(0.94, 0.7), P(0.88, 0.56)]);
    const inner = `M ${pt(P(1.0, 0.47))} Q ${pt(P(1.07, 0.55))} ${pt(P(1.0, 0.64))}`;
    return `<path d="${ear}" fill="${COLORS.skinDark}"/>${shade(id, inner, { opacity: 0.25, width: 0.35, blur: 'blurS' })}`;
  }).join('');
}

/** Hair in front of the head: short wavy crop (male) or long straight hair with a middle part (female). */
function drawHair(g, id) {
  const w = g.headHalf;
  const h = g.headH;
  const P = (x, y) => ({ x: x * w, y: y * h });
  const male = g.shape.hair === 'short';
  // Right half: outer silhouette from the crown down, then the inner edge (hairline) back up.
  const outer = male
    ? [P(0.34, -0.1), P(0.72, -0.07), P(0.98, 0.1), P(1.06, 0.29), P(1.02, 0.44), P(0.98, 0.54)]
    : [P(0.6, -0.02), P(1.02, 0.15), P(1.18, 0.42), P(1.24, 0.8), P(1.28, 1.15),
       { x: w * 1.32, y: g.neckBaseY + 1.5 }, { x: w * 1.18, y: g.neckBaseY + 4.2 }];   // tapered ends
  const inner = male
    ? [P(0.91, 0.53), P(0.88, 0.36), P(0.7, 0.24), P(0.42, 0.17), P(0.14, 0.2)]
    : [{ x: w * 1.02, y: g.neckBaseY + 1.2 }, { x: w * 0.88, y: g.neckBaseY - 0.8 }, P(0.8, 0.98), P(0.86, 0.68), P(0.85, 0.42), P(0.6, 0.16), P(0.16, 0.09)];
  const top = male ? P(0, -0.11) : P(0, -0.03);
  const parting = male ? P(0, 0.19) : P(0, 0.12);
  const d = smoothClosed([top, ...outer, ...inner, parting, ...inner.map(mirror).reverse(), ...outer.map(mirror).reverse()]);

  // Texture strands: short waves on top (male), long straight strands (female)
  const strands = male
    ? [[P(-0.6, 0.22), P(-0.35, -0.04), P(0.15, -0.08)], [P(-0.1, 0.19), P(0.15, 0.0), P(0.6, -0.04)],
       [P(0.25, 0.18), P(0.55, 0.06), P(0.9, 0.12)], [P(-0.9, 0.36), P(-0.85, 0.12), P(-0.5, -0.04)],
       [P(0.75, 0.25), P(0.95, 0.2), P(1.0, 0.36)]]
    : [-1, 1].flatMap((sd) => [0.92, 1.04, 1.16].map((x) => [P(sd * 0.1, 0.04), P(sd * x, 0.4), { x: sd * x * w * 1.06, y: g.neckBaseY + 1 }]));
  const lines = strands.map((s) =>
    `<path d="M ${pt(s[0])} Q ${pt(s[1])} ${pt(s[2])}" fill="none" stroke="${COLORS.hairLight}" stroke-opacity="${male ? 0.5 : 0.28}" stroke-width="${male ? 0.22 : 0.16}" stroke-linecap="round"/>`).join('');
  const shine = blob(id, -w * 0.35, male ? -h * 0.02 : h * 0.06, w * 0.35, h * 0.06, { color: '#fff', opacity: 0.12, blur: 'blurM' });
  const part = male ? '' : `<path d="M 0,${f(-0.02 * h)} L 0,${f(0.11 * h)}" stroke="${COLORS.skinDark}" stroke-width="0.28" stroke-opacity="0.7"/>`;
  return `${clipDef(`${id}-clip-hair`, d)}<path d="${d}" fill="url(#${id}-hair)"/>${clipped(`${id}-clip-hair`, lines + shine)}${part}`;
}

/** Long hair falls behind the neck and shoulders (female only). */
function drawBackHair(g, id) {
  if (g.shape.hair !== 'long') return '';
  const w = g.headHalf;
  const h = g.headH;
  const bottom = g.chestY - 2;
  const right = [{ x: w * 1.1, y: h * 0.35 }, { x: w * 1.25, y: h * 0.9 }, { x: w * 1.35, y: g.neckBaseY + 2 },
                 { x: w * 1.4, y: bottom - 3 }, { x: w * 1.1, y: bottom }];
  const d = smoothClosed([{ x: 0, y: h * 0.1 }, ...right, { x: 0, y: bottom - 1 }, ...right.map(mirror).reverse()]);
  return `<path d="${d}" fill="${COLORS.hairDark}"/>`;
}

function drawNeck(g, id) {
  const nh = g.neckHalf;
  const y0 = g.headH * 0.72;
  const y1 = Math.max(g.neckBaseY + 3.6, g.neckBaseY + g.shape.tee.neckDip + 1.5); // also fills a V-neck
  const mid = (y0 + y1) / 2;
  const d = `M ${f(-nh)},${f(y0)} L ${f(nh)},${f(y0)}
    C ${f(nh * 0.92)},${f(g.neckBaseY - 1)} ${f(nh * 1.1)},${f(g.neckBaseY + 1)} ${f(nh * 1.9)},${f(y1)}
    L ${f(-nh * 1.9)},${f(y1)}
    C ${f(-nh * 1.1)},${f(g.neckBaseY + 1)} ${f(-nh * 0.92)},${f(g.neckBaseY - 1)} ${f(-nh)},${f(y0)} Z`;
  const shading = clipped(`${id}-clip-neck`, [
    blob(id, 0, g.headH - 0.2, nh * 0.9, 1.6, { opacity: 0.16, blur: 'blurM' }),   // head casts a shadow
    blob(id, nh * 0.85, mid, nh * 0.45, (y1 - y0) * 0.7, { opacity: 0.14 }),        // shadow side
    shade(id, `M ${f(-nh * 0.75)},${f(y0 + 1)} L ${f(-nh * 0.15)},${f(y1 - 1)}`, { opacity: 0.08, width: 0.6 }), // neck muscles
    shade(id, `M ${f(nh * 0.75)},${f(y0 + 1)} L ${f(nh * 0.15)},${f(y1 - 1)}`, { opacity: 0.1, width: 0.6 }),
  ].join(''));
  return `${clipDef(`${id}-clip-neck`, d)}<path d="${d}" fill="url(#${id}-skin)"/>${shading}`;
}

// --- arms & hands ------------------------------------------------------------

/** One arm including the hand, as one seamless skin shape. */
function drawArm(g, id, side) {
  const ax = armAxis(g, side);
  const A = g.arm;
  const P = (t, h) => offset(ax.at(t), ax.outAt(t), h);
  const arm = A.samples.filter((s) => s.t >= 0.2); // the top is always under a sleeve
  const outer = arm.map((s) => P(s.t, s.out));
  const inner = arm.map((s) => P(s.t, -s.in));

  // Relaxed hand seen from the front (palm faces the thigh, thumb towards us).
  // Local coordinates: u = across (× wrist half width, + = outward), v = along (× hand length).
  const hw = A.wrist * 0.5;
  const wrist = ax.at(1);
  const dir = ax.dirAt(1);
  const out = ax.outAt(1);
  const H = (u, v) => offset(offset(wrist, out, u * hw), dir, v * A.handLen);
  const handOuter = [H(1.02, 0.12), H(1.06, 0.36), H(0.95, 0.6), H(0.72, 0.82), H(0.4, 0.96), H(0.08, 1.0)];
  const handInner = [H(-0.25, 0.95), H(-0.62, 0.82), H(-0.92, 0.62), H(-1.08, 0.4), H(-1.02, 0.14)];

  const d = `M ${pt(outer[0])}${smoothThrough([...outer, ...handOuter])}${smoothThrough([handOuter.at(-1), ...handInner, ...inner.reverse()])} Z`;
  const thumb = `M ${pt(H(-0.3, 0.14))} Q ${pt(H(-0.55, 0.5))} ${pt(H(-0.82, 0.5))}`;
  const inElbow = P(ELBOW_T, -A.elbow * 0.25);

  const shading = clipped(`${id}-clip-arm${side}`, [
    blob(id, inElbow.x, inElbow.y, 1.6, 2.6, { opacity: 0.16, blur: 'blurM' }),       // elbow crease
    shade(id, `M ${pt(H(-0.2, 0.62))} Q ${pt(H(-0.05, 0.75))} ${pt(H(0.2, 0.86))}`, { opacity: 0.18, width: 0.3, blur: 'blurS' }), // finger line
  ].join(''));
  return `${clipDef(`${id}-clip-arm${side}`, d)}
    <path d="${d}" fill="url(#${id}-skin)"/>${shading}
    ${shade(id, thumb, { opacity: 0.2, width: 0.3, blur: 'blurS' })}`;
}

// --- base outfit ----------------------------------------------------------------

/** Plain dark leather shoes (front view). */
function drawShoes(g, id) {
  const { legs, height: H } = g;
  return [1, -1].map((side) => {
    const cx = side * legs.footX;
    const hw = legs.shoeHalf;
    const sh = legs.shoeH;
    const P = (u, v) => ({ x: cx + side * u * hw, y: H - v * sh });
    const upper = smoothClosed([P(-1, 0.2), P(-0.95, 0.52), P(-0.62, 0.88), P(0, 1), P(0.62, 0.88), P(1.0, 0.52), P(1.04, 0.2), P(0, 0.14)]);
    const sole = `M ${pt(P(-1.04, 0.2))} L ${pt(P(1.08, 0.2))} Q ${pt(P(1.1, 0))} ${pt(P(0.9, 0))} L ${pt(P(-0.86, 0))} Q ${pt(P(-1.06, 0))} ${pt(P(-1.04, 0.2))} Z`;
    return `
      ${blob(id, cx, H - 0.2, hw * 1.3, 0.9, { opacity: 0.4, blur: 'blurM' })}
      <path d="${upper}" fill="url(#${id}-shoe)"/>
      ${blob(id, cx - side * hw * 0.25, H - sh * 0.62, hw * 0.4, sh * 0.16, { color: '#fff', opacity: 0.28, blur: 'blurS' })}
      <path d="${sole}" fill="${COLORS.shoeDark}"/>
      <path d="M ${pt(P(-0.95, 0.21))} L ${pt(P(1.0, 0.21))}" stroke="${COLORS.shoeLight}" stroke-width="0.12" stroke-opacity="0.8"/>`;
  }).join('');
}

/** Outline of the trousers (both legs as one shape). Reused for the waistband overlay. */
function trousersPath(g) {
  const L = g.legs;
  const midThighY = lerp(g.crotchY, L.kneeY, 0.5);
  const midThighX = lerp(L.outerThighX, L.kneeX + L.kneeHalf, 0.5);
  const outerR = [
    { x: L.jeansTopHalf, y: L.jeansTopY },
    { x: g.hipHalf + 0.6, y: g.hipY },
    { x: L.outerThighX + 0.8, y: g.crotchY + 3 },
    { x: midThighX + 0.6, y: midThighY },
    { x: L.kneeX + L.kneeHalf, y: L.kneeY },
    { x: L.calfX + L.calfHalf, y: L.calfY },
    { x: L.shinX + L.shinHalf, y: L.shinY },
    { x: L.ankleX + L.hemHalf, y: L.hemY },
  ];
  const innerR = [
    { x: L.ankleX - L.hemHalf, y: L.hemY },
    { x: L.shinX - L.shinHalf, y: L.shinY },
    { x: L.calfX - L.calfHalf, y: L.calfY },
    { x: L.kneeX - L.kneeHalf, y: L.kneeY },
    { x: Math.max(0.5, lerp(0.7, L.kneeX - L.kneeHalf, 0.5)), y: midThighY },
    { x: 0.7, y: g.crotchY + 3 },
    { x: 0, y: g.crotchY },
  ];
  const outerL = outerR.map(mirror).reverse(); // hem -> top
  const innerL = innerR.map(mirror).reverse(); // crotch -> hem
  const d = `M ${pt(outerR[0])}${smoothThrough(outerR)} L ${pt(innerR[0])}${smoothThrough(innerR)}${smoothThrough(innerL)} L ${pt(outerL[0])}${smoothThrough(outerL)} Z`;
  return { d, outerR, innerR };
}

/** Tailored charcoal trousers with a pressed crease. */
function drawTrousers(g, id) {
  const L = g.legs;
  const { d, outerR, innerR } = trousersPath(g);
  const line = (pts) => `M ${pt(pts[0])}${smoothThrough(pts)}`;
  const sh = [];
  for (const side of [1, -1]) {
    const S = (p) => ({ x: side * p.x, y: p.y });
    // Inner leg and outer edge shadows (stronger on the right = away from the light)
    sh.push(shade(id, line(innerR.slice(1, -1).map(S)), { opacity: 0.5, width: 2.6 }));
    sh.push(shade(id, line(outerR.slice(1).map(S)), { opacity: side === 1 ? 0.5 : 0.22, width: 2.8 }));
    // Pressed front crease: a thin highlight with a soft shadow next to it
    const crease = [
      { x: side * lerp(L.outerThighX, 0.7, 0.5), y: L.jeansTopY + 4 },
      { x: side * L.kneeX, y: L.kneeY },
      { x: side * L.ankleX, y: L.hemY - 0.6 },
    ];
    sh.push(shade(id, line(crease), { color: COLORS.trouserSheen, opacity: 0.45, width: 0.45, blur: 'blurS' }));
    sh.push(shade(id, line(crease.map((p) => ({ x: p.x + side * 0.7, y: p.y }))), { opacity: 0.35, width: 0.6, blur: 'blurS' }));
    // Soft light on the thigh and knee
    sh.push(blob(id, side * lerp(L.outerThighX, 0.7, 0.55), g.crotchY + 6, 3, 9, { color: COLORS.trouserSheen, opacity: 0.18 }));
    // Pocket opening and pleat
    sh.push(shade(id, `M ${f(side * (L.jeansTopHalf - 3.2))},${f(L.jeansTopY + 1.5)} L ${f(side * (g.hipHalf + 0.1))},${f(L.jeansTopY + 10)}`, { opacity: 0.55, width: 0.35, blur: 'blurS' }));
    sh.push(shade(id, `M ${f(side * (L.jeansTopHalf * 0.45))},${f(L.jeansTopY + 3)} l ${f(side * 0.3)},6`, { opacity: 0.4, width: 0.3, blur: 'blurS' }));
    // A soft break where the hem rests on the shoe
    const a = L.ankleX - L.hemHalf * 0.85;
    const b = L.ankleX + L.hemHalf * 0.85;
    sh.push(shade(id, `M ${f(side * a)},${f(L.hemY - 3)} q ${f(side * (b - a) * 0.5)},1.2 ${f(side * (b - a))},0`, { opacity: 0.35, width: 0.6, blur: 'blurS' }));
  }
  const fly = `M 0.2,${f(L.jeansTopY + 3.5)} C 2.4,${f(L.jeansTopY + 4.5)} 2.4,${f(g.crotchY - 4)} 0.4,${f(g.crotchY - 1.6)}`;
  sh.push(shade(id, fly, { opacity: 0.5, width: 0.3, blur: 'blurS' }));
  return `${clipDef(`${id}-clip-trousers`, d)}
    <path d="${d}" fill="url(#${id}-trousers)"/>
    ${clipped(`${id}-clip-trousers`, `
      <rect x="-60" y="${f(L.jeansTopY)}" width="120" height="${f(g.height)}" filter="url(#${id}-noise)" opacity="0.07"/>
      ${sh.join('')}`)}`;
}

/** Waistband + belt drawn OVER a tucked-in tee. */
function drawWaistband(g, id) {
  if (!g.shape.tee.tucked) return '';
  const L = g.legs;
  const top = L.jeansTopY;
  const w = L.jeansTopHalf + 0.15;
  const band = `M ${f(-w)},${f(top - 0.3)} L ${f(w)},${f(top - 0.3)} L ${f(w + 0.15)},${f(top + 3.6)} L ${f(-w - 0.15)},${f(top + 3.6)} Z`;
  const loops = [-0.62, -0.2, 0.2, 0.62].map((k) =>
    `<rect x="${f(k * w - 0.4)}" y="${f(top - 0.2)}" width="0.8" height="3.6" rx="0.2" fill="${COLORS.trouserMid}"/>`).join('');
  return `
    <path d="${band}" fill="url(#${id}-trousers)"/>
    ${shade(id, `M ${f(-w)},${f(top + 3.6)} L ${f(w)},${f(top + 3.6)}`, { opacity: 0.45, width: 0.6, blur: 'blurS' })}
    <rect x="${f(-w)}" y="${f(top + 0.4)}" width="${f(2 * w)}" height="2.4" fill="${COLORS.belt}"/>
    ${loops}
    <rect x="-1.6" y="${f(top + 0.2)}" width="3.2" height="2.8" rx="0.4" fill="none" stroke="${COLORS.buckle}" stroke-width="0.45"/>`;
}

function drawShirt(g, id) {
  const tee = g.shape.tee;
  const male = g.gender === 'male';
  const L = g.legs;
  // A tucked tee ends just under the waistband; an untucked one covers it.
  const hemY = tee.tucked ? L.jeansTopY + 2.5 : L.jeansTopY + 4;
  const neckR = { x: g.neckHalf + (tee.neck === 'v' ? 1.4 : 0.9), y: g.neckBaseY };
  const shoulderR = { x: g.shoulderHalf + 0.6, y: g.shoulderY - 0.2 };
  // A tee does not cinch like the body: on men it hangs from the chest.
  const profile = g.torsoProfile.filter((p) => p.y < hemY - 2).map((p) => ({
    x: (male ? Math.max(p.half, lerp(g.chestHalf, p.half, 0.6)) : p.half) + tee.ease,
    y: p.y,
  }));
  const hemHalf = tee.tucked ? L.jeansTopHalf + 0.4 : lerp(g.waistHalf, g.hipHalf, 0.55) + tee.ease + 0.3;
  const sideR = [shoulderR, ...profile, { x: hemHalf, y: hemY }];
  const sideL = sideR.map(mirror).reverse(); // hem -> shoulder
  const neckL = mirror(neckR);
  const dipY = g.neckBaseY + tee.neckDip;
  const seamTo = (a, b) => {
    const c1 = { x: lerp(a.x, b.x, 0.35), y: lerp(a.y, b.y, 0.35) - 0.6 };
    const c2 = { x: lerp(a.x, b.x, 0.7), y: lerp(a.y, b.y, 0.7) - 0.4 };
    return ` C ${pt(c1)} ${pt(c2)} ${pt(b)}`;
  };
  const neckline = tee.neck === 'v'
    ? `Q ${f(neckL.x * 0.45)},${f(dipY - 1.5)} 0,${f(dipY)} Q ${f(neckR.x * 0.45)},${f(dipY - 1.5)} ${pt(neckR)}`
    : `C ${f(neckL.x * 0.8)},${f(dipY)} ${f(neckR.x * 0.8)},${f(dipY)} ${pt(neckR)}`;
  const d = `M ${pt(neckL)} ${neckline}${seamTo(neckR, shoulderR)}${smoothThrough(sideR)}
    Q 0,${f(hemY + 0.6)} ${pt(sideL[0])}${smoothThrough(sideL)}${seamTo(mirror(shoulderR), neckL)} Z`;

  const ch = g.chestHalf;
  const wide = Math.max(...sideR.map((p) => p.x));
  const sh = [
    blob(id, wide * 1.02, (g.armpitY + hemY) / 2, wide * 0.36, (hemY - g.armpitY) * 0.7, { opacity: 0.13 }), // shadow side
    blob(id, -ch * 0.45, g.chestY, ch * 0.38, (hemY - g.shoulderY) * 0.3, { color: '#fff', opacity: 0.3 }), // light side
    blob(id, 0, hemY - 0.8, wide, 1.1, { opacity: 0.08, blur: 'blurM' }),
  ];
  for (const side of [1, -1]) {
    // Drag lines from the armpit
    sh.push(shade(id, `M ${f(side * ch * 0.98)},${f(g.armpitY + 1)} Q ${f(side * ch * 0.7)},${f(g.chestY + 3)} ${f(side * ch * 0.35)},${f(g.chestY + 7)}`, { opacity: 0.08, width: 1.1 }));
    if (tee.tucked) {
      // Fabric blousing just above the belt
      for (const k of [0.25, 0.55, 0.82]) {
        sh.push(shade(id, `M ${f(side * hemHalf * k)},${f(hemY - 1)} q ${f(side * 0.5)},-3 ${f(side * 1.4)},-5`, { opacity: 0.1, width: 0.5, blur: 'blurS' }));
      }
    } else {
      sh.push(shade(id, `M ${f(side * (wide - 0.3))},${f(g.waistY + 1)} q ${f(-side * 3)},0.9 ${f(-side * 5.5)},0.2`, { opacity: 0.08, width: 0.6, blur: 'blurS' }));
    }
    if (male) {
      sh.push(shade(id, `M ${f(side * ch * 0.78)},${f(g.chestY + 2.4)} Q ${f(side * ch * 0.4)},${f(g.chestY + 4.4)} ${f(side * 1)},${f(g.chestY + 2.8)}`, { opacity: 0.05, width: 1.6 }));
    } else {
      sh.push(blob(id, side * ch * 0.45, g.chestY - 1.5, ch * 0.3, 3.5, { color: '#fff', opacity: 0.5, blur: 'blurM' }));
      sh.push(shade(id, `M ${f(side * ch * 0.9)},${f(g.chestY + 3)} Q ${f(side * ch * 0.45)},${f(g.chestY + 6)} ${f(side * 0.8)},${f(g.chestY + 3.6)}`, { opacity: 0.11, width: 1.4 }));
    }
  }
  const [, teeMid, teeDark] = TEE[g.gender] ?? TEE.male;
  const collar = `<path d="M ${pt(neckL)} ${neckline}" fill="none" stroke="${teeDark}" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M ${pt(neckL)} ${neckline}" fill="none" stroke="${teeMid}" stroke-width="0.45" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 0.5)"/>`;
  return `${clipDef(`${id}-clip-shirt`, d)}
    <path d="${d}" fill="url(#${id}-shirt)"/>${clipped(`${id}-clip-shirt`, sh.join(''))}${collar}`;
}

/** Short T-shirt sleeve over the upper arm. */
function drawSleeve(g, id, side) {
  const tee = g.shape.tee;
  const { d, hem, dir } = sleevePath(g, side, { end: tee.sleeveEnd, ease: tee.ease + 0.3 });
  const back = (p, k) => offset(p, dir, -k);
  const clipId = `${id}-clip-sleeve${side}`;
  const shading = clipped(clipId, [
    shade(id, `M ${pt(back(hem[1], 0.2))} L ${pt(back(hem[1], 6))}`, { opacity: 0.16, width: 2.2 }),                 // inner side
    shade(id, `M ${pt(back(hem[0], 0.6))} L ${pt(back(hem[1], 0.6))}`, { opacity: 0.05, width: 0.5, blur: 'blurS' }), // hem stitch
    shade(id, `M ${pt(back(hem[0], 2.6))} Q ${pt(back(hem[0], 4))} ${pt(back(hem[1], 3.6))}`, { opacity: 0.07, width: 0.6, blur: 'blurS' }),
  ].join(''));
  return `${clipDef(clipId, d)}<path d="${d}" fill="url(#${id}-shirt)"/>${shading}`;
}

/** Height ruler on the left (shows that the drawing is to scale). */
function drawRuler(g, halfWidthCm) {
  const x = -halfWidthCm + 2.5;
  let ticks = '';
  for (let y = 0; y <= g.height; y += 10) {
    const len = y % 50 === 0 ? 2 : 1.1;
    ticks += `<path d="M ${f(x)},${f(g.height - y)} h ${len}" />`;
  }
  return `
    <g class="mq-ruler">
      <path d="M ${f(x)},0 V ${f(g.height)}"/>${ticks}
      <path d="M ${f(x)},0 H ${f(-g.headHalf - 3)}" stroke-dasharray="0.8 0.8"/>
      <text x="${f(x + 2.6)}" y="-1.4">${g.height} cm</text>
    </g>`;
}

/**
 * Build the full mannequin SVG.
 *   options.garmentMarkup  SVG (in cm coordinates) drawn above the base outfit (Phase 5)
 *   options.showRuler      draw the height ruler
 *   options.id             unique prefix for gradient/clip ids (if several SVGs on one page)
 */
export function buildMannequinSvg(g, { garmentMarkup = '', showRuler = false, id = 'mq' } = {}) {
  const { pxPerCm, width, height } = g.view;
  const halfWidthCm = width / 2 / pxPerCm;
  // One transform: move the origin to the centre-top, then scale cm -> px.
  const transform = `translate(${f(width / 2)} ${f(PAD_CM * pxPerCm)}) scale(${pxPerCm.toFixed(4)})`;

  return `
    <svg class="mannequin" viewBox="0 0 ${f(width)} ${height}" role="img"
         aria-label="${g.gender} mannequin, ${g.height} cm" xmlns="http://www.w3.org/2000/svg">
      ${defs(id, g.gender)}
      <g transform="${transform}">
        <ellipse cx="0" cy="${f(g.height)}" rx="${f(g.hipHalf * 2.3)}" ry="3" fill="url(#${id}-floor)"/>
        ${drawBackHair(g, id)}
        ${drawNeck(g, id)}
        ${drawShoes(g, id)}
        ${drawTrousers(g, id)}
        ${drawArm(g, id, 1)}${drawArm(g, id, -1)}
        ${drawShirt(g, id)}
        ${drawWaistband(g, id)}
        ${drawSleeve(g, id, 1)}${drawSleeve(g, id, -1)}
        <g class="garment-layer">${garmentMarkup}</g>
        ${drawEars(g, id)}
        ${drawHead(g, id)}
        ${drawFace(g, id)}
        ${drawHair(g, id)}
        ${showRuler ? drawRuler(g, halfWidthCm) : ''}
      </g>
    </svg>`;
}
