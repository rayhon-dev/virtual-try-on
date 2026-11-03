// garmentRenderer.js — dresses the 3D avatar in a garment built from its SIZE CHART.
//
// Shape (from numbers, no 3D modelling needed):
//   - Torso: for many heights between the collar and the hem we take the real body
//     slice (from avatar3d.js) and grow it outwards so that its circumference equals
//     the garment's circumference at that height (chest / waist / hem from the chart,
//     interpolated in between). A too-small size cannot go inside the body, so it is
//     drawn hugging the body — and the fit table / fit map shows it in red.
//   - Sleeves: tubes along each arm. Length = sleeve length from the chart
//     (+ drop-shoulder correction, the same formula as the fit engine), width =
//     arm + ease.
//   - Length: hem = shoulder point − garment length.
//
// Look (from ONE product photo):
//   The photo is cut out (tools/prepare_garment.py) and a few anchor points are noted
//   in data/garments.json (collar, shoulders, armpits, hem corners, cuffs). The front of
//   the shell is mapped onto the photo between those anchors; the back uses a plain
//   patch of the same material. Garments without a photo get a plain coloured shell.

import * as THREE from 'three';
import { hullPerimeter } from './avatar3d.js';

const CM = 0.01;          // cm -> m
const GAP = 0.006;        // the shell never comes closer than 6 mm to the body (over the T-shirt)
const ROWS = 48;          // horizontal rings of the torso
const HALF_COLS = 36;     // columns on the front (and again on the back)
const RINGS = 30;         // rings along each sleeve
const HALF_SEGS = 16;     // segments around half a sleeve

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Fit-map colours per status (match the CSS tokens). */
const STATUS_COLORS = {
  tooTight: '#d64545', tight: '#e7807a', good: '#3f9b5f', loose: '#6d9be0', tooLoose: '#3f7bd6',
  low: '#e0a030', 'n/a': '#a8a29a', neutral: '#c9c3b9',
};

// ---------------------------------------------------------------------------
// Body contour of one slice
// ---------------------------------------------------------------------------

/**
 * Radial outline of a body slice: for 2·HALF_COLS directions around the centre,
 * the furthest body point. Angle θ = 0 faces the camera (+z), θ = +90° is +x.
 */
function bodyContour(points, bins) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, z] of points) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  const cz = points.length ? (lo + hi) / 2 : 0;
  const r = new Float64Array(bins).fill(-1);
  for (const [x, z] of points) {
    const th = Math.atan2(x, z - cz); // -π..π
    const b = ((Math.round(((th + Math.PI) / (2 * Math.PI)) * bins) % bins) + bins) % bins;
    r[b] = Math.max(r[b], Math.hypot(x, z - cz));
  }
  // Fill empty directions from their neighbours
  for (let pass = 0; pass < bins; pass++) {
    let missing = false;
    for (let i = 0; i < bins; i++) {
      if (r[i] >= 0) continue;
      const a = r[(i - 1 + bins) % bins];
      const c = r[(i + 1) % bins];
      if (a >= 0 || c >= 0) r[i] = Math.max(a, c); else missing = true;
    }
    if (!missing) break;
  }
  // Smooth small dents (a garment bridges them)
  const out = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    const a = r[(i - 1 + bins) % bins];
    const c = r[(i + 1) % bins];
    out[i] = Math.max(r[i], (a + c) / 2, 0.02);
  }
  return { cz, r: out };
}

/** Contour radius at an angle θ (linear between bins). */
function radiusAt(contour, th) {
  const bins = contour.r.length;
  const f = (((th + Math.PI) / (2 * Math.PI)) * bins + bins) % bins;
  const i = Math.floor(f);
  return lerp(contour.r[i % bins], contour.r[(i + 1) % bins], f - i);
}

// ---------------------------------------------------------------------------
// Photo mapping helpers
// ---------------------------------------------------------------------------

/** Pixel -> UV for a texture of size (w, h) (three.js flips images: v = 1 − y/h). */
const toUV = (p, w, h) => [p[0] / w, 1 - p[1] / h];
const mix2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** UV of a point in the patch used for the back / inside (plain material, no details). */
function patchUV(anchors, w, h, s, k) {
  const [x0, y0, x1, y1] = anchors.backPatch;
  return toUV([lerp(x0, x1, s), lerp(y0, y1, k)], w, h);
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/** A grid (rows × cols) of vertices -> indexed BufferGeometry. */
function gridGeometry(positions, uvs, zones, rows, cols) {
  const index = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.userData.zones = zones; // zone name per vertex (for the fit map)
  return geo;
}

/** Colour every vertex by the status of its zone. */
function applyZoneColors(geo, zoneResults) {
  const zones = geo.userData.zones;
  const colors = new Float32Array(zones.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < zones.length; i++) {
    const res = zoneResults?.[zones[i]];
    let key = 'neutral';
    if (res) key = res.status === 'good' && res.confidence === 'low' ? 'low' : res.status;
    c.set(STATUS_COLORS[key] ?? STATUS_COLORS.neutral).convertSRGBToLinear();
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Build the garment for one size.
 *   avatar   — reshaped avatar (avatar3d.js), with .landmarks and .measurements
 *   garment  — item from garments.json
 *   sizeName — "S" | "M" | ...
 *   options.texture     — loaded photo texture (or null)
 *   options.fitMap      — true = colour zones by fit status
 *   options.zoneResults — { chest: {status, confidence}, ... } from the fit engine
 * Returns a THREE.Group.
 */
export function buildGarment(avatar, garment, sizeName, { texture = null, fitMap = false, zoneResults = null } = {}) {
  const L = avatar.landmarks;
  const body = avatar.measurements; // cm
  const size = garment.sizes[sizeName];
  if (!size) throw new Error(`Garment "${garment.id}" has no size "${sizeName}"`);
  const anchors = texture ? garment.anchors : null;
  const imgW = texture?.image?.width ?? 1;
  const imgH = texture?.image?.height ?? 1;

  // --- vertical landmarks of the garment ---
  const shoulderPointY = L.shoulderY + 0.025; // the shoulder point sits a little above the joint
  const collarH = { stand: 0.045, point: 0.035, rib: 0.03, 'v-neck': 0.02 }[garment.style?.collar] ?? 0.035;
  // Neck base: going up from the shoulders, the first height where the body is only the neck
  // (much narrower than at the shoulders). The collar starts there and wraps the neck.
  const halfWidth = (y) => {
    let m = 0;
    for (const [x] of L.slice(y, avatarBand(avatar), 1, 1)) m = Math.max(m, Math.abs(x));
    return m;
  };
  const shoulderWidthHalf = halfWidth(L.shoulderY);
  let neckBaseY = L.shoulderY + 0.06;
  for (let y = L.shoulderY + 0.02; y < L.shoulderY + 0.16; y += 0.005) {
    if (halfWidth(y) < shoulderWidthHalf * 0.5) { neckBaseY = y; break; }
  }
  neckBaseY = Math.max(neckBaseY, shoulderPointY + 0.01);
  const topY = neckBaseY + collarH;
  const hemY = Math.max(L.floor + 0.25, shoulderPointY - size.length * CM);
  const armpitY = Math.max(L.armpitY, hemY + 0.05);

  // --- ease (garment − body circumference) at chest / waist / hem, in metres ---
  const perimeterAt = (y) => hullPerimeter(L.slice(y));
  const eChest = size.chest * CM - perimeterAt(L.chestY);
  const eWaist = (size.waist ?? size.chest) * CM - perimeterAt(L.waistY);
  const eHem = (size.hem ?? size.waist ?? size.chest) * CM - perimeterAt(hemY);
  const easeAt = (y) => {
    if (y >= L.chestY) return eChest;
    if (hemY >= L.waistY) return lerp(eHem, eChest, smooth((y - hemY) / (L.chestY - hemY)));
    if (y >= L.waistY) return lerp(eWaist, eChest, smooth((y - L.waistY) / (L.chestY - L.waistY)));
    return lerp(eHem, eWaist, smooth((y - hemY) / (L.waistY - hemY)));
  };

  // Zone of a torso vertex (for the fit map) — names match the fit engine
  const chestBottom = lerp(L.waistY, L.chestY, 0.5);
  const torsoZone = (y, x, rowHalf) => {
    if (y > shoulderPointY - 0.05) return Math.abs(x) > rowHalf * 0.55 ? 'shoulder' : 'collar';
    if (y > chestBottom) return 'chest';
    if (y > hemY + 0.035) return 'waist';
    return 'length';
  };

  // ---------- torso: front and back grids ----------
  const front = { pos: [], uv: [], zones: [] };
  const back = { pos: [], uv: [], zones: [] };
  const cols = HALF_COLS + 1;

  for (let i = 0; i < ROWS; i++) {
    const k = i / (ROWS - 1);                           // 0 at the collar, 1 at the hem
    const y = lerp(topY, hemY, k);
    // Collar rows wrap the neck; between the shoulder row and the collar the shell slopes
    // down from the neck to the shoulders, like a real jacket.
    const sliceY = Math.min(y, neckBaseY + 0.01); // the collar rows reuse the neck slice
    // Above the armpits the shell must also cover the shoulder caps (deltoids)
    // (above the shoulder joint only the top of the shoulder belongs to the arm: include all of it)
    const maxArm = y >= L.shoulderY ? 1 : y > armpitY ? lerp(0.25, 0.55, smooth((y - armpitY) / (L.shoulderY - armpitY))) : 0.25;
    // Near the neck the slice must include the neck itself (its vertices belong to the "head" group)
    const maxHead = y > shoulderPointY - 0.03 ? 1 : 0.5; // include the neck near the top
    const contour = bodyContour(L.slice(sliceY, Math.max(0.01, avatarBand(avatar)), maxArm, maxHead), HALF_COLS * 2);
    let d = Math.max(GAP, easeAt(y) / (2 * Math.PI));
    // Over the shoulders a jacket is padded / stiffer: keep a little more room than GAP
    if (y > armpitY) d = Math.max(d, lerp(GAP, 0.016, smooth((y - armpitY) / (shoulderPointY - armpitY))));
    if (y > shoulderPointY) d = lerp(d, 0.016, smooth((y - shoulderPointY) / (topY - shoulderPointY))); // collar stands close to the neck

    const row = (th) => {
      const r = radiusAt(contour, th) + d;
      return [Math.sin(th) * r, y, contour.cz + Math.cos(th) * r];
    };
    // Row width (for the photo mapping: the photo is a flat front view, so u follows x)
    const xMin = row(-Math.PI / 2)[0];
    const xMax = row(Math.PI / 2)[0];
    const rowHalf = (xMax - xMin) / 2;

    for (const [grid, from, to, isFront] of [[front, -Math.PI / 2, Math.PI / 2, true], [back, Math.PI / 2, Math.PI * 1.5, false]]) {
      for (let j = 0; j < cols; j++) {
        const th = lerp(from, to, j / (cols - 1));
        const p = row(th);
        grid.pos.push(...p);
        grid.zones.push(torsoZone(y, p[0], rowHalf));
        const s = clamp((p[0] - xMin) / (xMax - xMin || 1), 0, 1);
        if (!anchors) { grid.uv.push(s, 1 - k); continue; }
        if (!isFront) { grid.uv.push(...patchUV(anchors, imgW, imgH, 1 - s, k)); continue; }
        // Front: between the photo lines collar -> shoulders -> armpits -> hem
        const line = (a, b) => mix2(a, b, s);
        let uvPx;
        if (y >= shoulderPointY) {
          uvPx = mix2(line(anchors.collarL, anchors.collarR), line(anchors.shoulderL, anchors.shoulderR), (topY - y) / (topY - shoulderPointY));
        } else if (y >= armpitY) {
          uvPx = mix2(line(anchors.shoulderL, anchors.shoulderR), line(anchors.armpitL, anchors.armpitR), (shoulderPointY - y) / (shoulderPointY - armpitY));
        } else {
          uvPx = mix2(line(anchors.armpitL, anchors.armpitR), line(anchors.hemL, anchors.hemR), (armpitY - y) / (armpitY - hemY));
        }
        grid.uv.push(...toUV(uvPx, imgW, imgH));
      }
    }
  }

  // ---------- sleeves ----------
  // Effective sleeve = chart sleeve + drop-shoulder correction (same rule as the fit engine)
  const drop = (size.shoulder - body.shoulder) / 2; // cm, + when the seam sits past the shoulder point
  const effSleeve = size.sleeve + drop;
  const tEnd = clamp(effSleeve / body.armLength, 0.25, 1.25);
  const chestEase = Math.max(0, eChest);
  const sleeves = [];
  for (const key of ['L', 'R']) {
    const side = key === 'L' ? 1 : -1;            // +x = character's left = viewer's right
    const arm = L.arms[key]; // bent line shoulder -> elbow -> wrist
    /** Ring frame at t: out = away from the body, fwd = towards the camera. */
    const frame = (t) => {
      const A = arm.dirAt(t);
      const out = new THREE.Vector3(-A.y, A.x, 0).multiplyScalar(side).normalize();
      const fwd = new THREE.Vector3().crossVectors(A, out).multiplyScalar(side).normalize();
      return { out, fwd };
    };

    const armR = (t) => Math.max(0.025, L.armRadius(key, clamp(t, 0.05, 1)));
    // Upper sleeve = arm + a share of the chest ease (a roomy body has roomy sleeves), within limits
    const upperR = armR(0.3) + 0.004 + clamp((chestEase / (2 * Math.PI)) * 0.45, 0.008, 0.028) + Math.max(0, drop * CM) * 0.3;
    const cuffR = Math.max(armR(Math.min(tEnd, 1)) + 0.008, armR(1) + 0.012);
    const tStart = -0.04; // the sleeve cap starts just above the shoulder joint
    const radius = (t) => {
      if (t < 0.25) return upperR + (0.25 - Math.max(t, 0)) * 0.04 - Math.max(0, -t) * 0.9;
      return Math.max(armR(t) + 0.007, lerp(upperR, cuffR, smooth((t - 0.25) / (tEnd - 0.25))));
    };

    // Photo: this arm appears on the viewer's right for "L", on the left for "R"
    const P = anchors && {
      top0: side > 0 ? anchors.shoulderR : anchors.shoulderL,   // outer top (shoulder seam)
      top1: side > 0 ? anchors.armpitR : anchors.armpitL,       // inner top (armpit)
      bot0: side > 0 ? anchors.cuffOuterR : anchors.cuffOuterL,
      bot1: side > 0 ? anchors.cuffInnerR : anchors.cuffInnerL,
    };

    const segCols = HALF_SEGS + 1;
    const frontS = { pos: [], uv: [], zones: [] };
    const backS = { pos: [], uv: [], zones: [] };
    for (let i = 0; i < RINGS; i++) {
      const k = i / (RINGS - 1);
      const t = lerp(tStart, tEnd, k);
      const c = t < 0 ? arm.at(0).addScaledVector(arm.dirAt(0), t * arm.length) : arm.at(t);
      const { out, fwd } = frame(Math.max(t, 0));
      const r = Math.max(0.01, radius(t));
      for (const [grid, from, to, isFront] of [[frontS, 0, Math.PI, true], [backS, Math.PI, Math.PI * 2, false]]) {
        for (let j = 0; j < segCols; j++) {
          const phi = lerp(from, to, j / (segCols - 1)); // 0 = outer side, π/2 = front, π = inner side
          const p = c.clone()
            .addScaledVector(out, Math.cos(phi) * r)
            .addScaledVector(fwd, Math.sin(phi) * r);
          grid.pos.push(p.x, p.y, p.z);
          grid.zones.push('sleeve');
          const a = j / (segCols - 1);
          if (!P) { grid.uv.push(a, 1 - k); continue; }
          if (!isFront) { grid.uv.push(...patchUV(anchors, imgW, imgH, a, k)); continue; }
          const kk = clamp((t - Math.max(tStart, 0)) / (tEnd - Math.max(tStart, 0)), 0, 1);
          grid.uv.push(...toUV(mix2(mix2(P.top0, P.top1, a), mix2(P.bot0, P.bot1, a), kk), imgW, imgH));
        }
      }
    }
    sleeves.push(frontS, backS);
  }

  // ---------- meshes ----------
  const material = fitMap
    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide })
    : texture
      // The photo already contains the garment's own light and shine: show it mostly as it is
      // (emissive = the photo itself) and let the scene lights add only a little shape.
      ? new THREE.MeshStandardMaterial({
        map: texture, color: 0x9a9a9a, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.55,
        roughness: 0.95, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide,
      })
      : new THREE.MeshStandardMaterial({ color: garment.color ?? '#888888', roughness: 0.85, side: THREE.DoubleSide });

  const group = new THREE.Group();
  group.name = `garment-${garment.id}-${sizeName}`;
  const parts = [
    ['torso-front', gridGeometry(front.pos, front.uv, front.zones, ROWS, cols)],
    ['torso-back', gridGeometry(back.pos, back.uv, back.zones, ROWS, cols)],
    ...sleeves.map((s, i) => [`sleeve-${i}`, gridGeometry(s.pos, s.uv, s.zones, RINGS, HALF_SEGS + 1)]),
  ];
  for (const [name, geo] of parts) {
    if (fitMap) applyZoneColors(geo, zoneResults);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  group.userData = { hemY, topY, tEnd, effSleeve };
  return group;
}

/** Slice thickness: a little thicker for low-poly avatars so every slice has points. */
function avatarBand(avatar) {
  return avatar.base?.band ?? 0.01;
}

/** Load (and cache) a garment photo as a texture. */
const textureCache = new Map();
export function loadGarmentTexture(garment, renderer) {
  const file = garment.texture ?? garment.image; // "-texture.jpg" has no transparency (safer to sample)
  if (!file) return Promise.resolve(null);
  if (!textureCache.has(file)) {
    const url = new URL(`../../${file}`, import.meta.url).href;
    textureCache.set(file, new THREE.TextureLoader().loadAsync(url).then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
      return tex;
    }));
  }
  return textureCache.get(file);
}
