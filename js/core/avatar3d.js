// avatar3d.js — loads the realistic 3D avatar (GLB from Blender + MPFB2) and
// reshapes it to the user's real measurements.
//
// How the reshaping works (no bones are animated — the avatar stands still):
//   1. Every vertex of every part (skin, hair, T-shirt, trousers, shoes) is read
//      in its rest position, together with "which body part it belongs to"
//      (taken from the skin weights: arm / head / rest of the body).
//   2. The base model is MEASURED like a tailor would: height, shoulder width,
//      torso length, arm length, and chest / waist / hip circumferences
//      (the convex hull of a horizontal slice = what a tape measure reads).
//   3. deform(measurements) moves every vertex:
//        - the body is stretched vertically per segment (legs / torso / head),
//        - each horizontal slice is scaled so its circumference matches yours,
//        - arms are lengthened along their own axis and moved with the shoulders,
//        - the head keeps its shape and only moves.
//      Clothes are skinned to the same skeleton, so they follow automatically.
//
// Units: Three.js works in METRES (the GLB is in metres); measurements come in cm.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CONFIG_URL = new URL('../../data/avatars.json', import.meta.url);
const ROOT_URL = new URL('../../', import.meta.url);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Perimeter of the convex hull of 2D points [[x, z], ...] — a tape measure around them. */
export function hullPerimeter(points) {
  if (points.length < 3) return 0;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let per = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return per;
}

// Bone names of the MPFB "GameEngine" rig, grouped by body part.
const ARM_BONE = /^(upperarm|lowerarm|wrist|finger|metacarpal)|_(finger\d?_grip|master_grip)$/;
const SHOULDER_BONE = /^shoulder01/;
const HEAD_BONE = /^(head|jaw|eye|oris|tongue|levator|special|orbicularis|temporalis|oculi|risorius|neck03)/;

/**
 * Which side a bone belongs to: +1 = character's left (+x), -1 = right (−x), 0 = centre.
 * Note: GLTFLoader removes dots from names, so "upperarm01.L" arrives as "upperarm01L".
 */
function boneSide(name) {
  if (/L$|^left_/.test(name)) return 1;
  if (/R$|^right_/.test(name)) return -1;
  return 0;
}

/** Names as GLTFLoader stores them (dots and some other characters removed). */
const clean = (name) => THREE.PropertyBinding.sanitizeNodeName(name);
/** GLTFLoader adds "_1", "_2" to repeated names (e.g. a second rig in the file): remove it. */
const baseName = (name) => name.replace(/_\d+$/, '');

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let configPromise = null;
/** data/avatars.json (cached). */
export function loadAvatarConfig() {
  configPromise ??= fetch(CONFIG_URL).then((r) => {
    if (!r.ok) throw new Error(`Could not load avatars.json (HTTP ${r.status})`);
    return r.json();
  });
  return configPromise;
}

/**
 * Fix the exported materials so they render cleanly in a browser:
 * Blender exports almost everything as "BLEND" (semi-transparent), which makes
 * clothes flicker. Here everything becomes opaque; hair / eyebrows / eyelashes use
 * an alpha cut-out (alphaTest), which needs no sorting.
 */
function fixMaterial(source, meshName) {
  const m = source.clone();
  const name = `${meshName} ${m.name}`.toLowerCase();
  const isCutout = /hair|short0|eyebrow|eyelash|brow|lash|side_do|journalist/.test(name);
  const isClothes = /shirt|trouser|jean|shoe|suit|flat|dress|sweater|pant/.test(name);
  m.transparent = false;
  m.depthWrite = true;
  m.alphaTest = isCutout ? 0.45 : 0.5;
  m.side = THREE.DoubleSide;
  if (isClothes) {
    // Push clothes slightly towards the camera so skin never shows through them.
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -2;
  }
  if ('roughness' in m) m.roughness = isCutout ? 0.7 : Math.max(m.roughness ?? 0.8, 0.55);
  if ('metalness' in m) m.metalness = 0;
  return m;
}

/**
 * Load the avatar for a gender. Returns an Avatar object:
 *   { group, base, parts, deform(measurements), landmarks, ... }
 */
export async function loadAvatar(gender) {
  const config = (await loadAvatarConfig())[gender];
  if (!config) throw new Error(`No avatar configured for "${gender}"`);
  const gltf = await new GLTFLoader().loadAsync(new URL(config.file, ROOT_URL).href);
  gltf.scene.updateMatrixWorld(true);

  const root = gltf.scene.getObjectByName(clean(config.root));
  if (!root) throw new Error(`Node "${config.root}" not found in ${config.file}`);
  const hidden = new Set(config.hide.map(clean));
  const bodyName = clean(config.body);

  // Bone world positions (rest pose) by name
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[baseName(o.name)] = o.getWorldPosition(new THREE.Vector3()); });
  bones.get = (name) => bones[clean(name)];

  const parts = [];
  const v = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  root.traverse((obj) => {
    if (!obj.isMesh || hidden.has(obj.name)) return;
    const geo = obj.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const count = pos.count;
    const basePos = new Float32Array(count * 3);
    const baseNor = new Float32Array(count * 3);
    const wArm = new Float32Array(count);   // 0..1 how much the vertex belongs to an arm
    const side = new Int8Array(count);      // which arm (+1 / −1)
    const wHead = new Float32Array(count);  // 0..1 how much it belongs to the head
    normalMatrix.getNormalMatrix(obj.matrixWorld);

    const skinned = obj.isSkinnedMesh;
    const boneNames = skinned ? obj.skeleton.bones.map((b) => baseName(b.name)) : [];
    const si = geo.attributes.skinIndex;
    const sw = geo.attributes.skinWeight;

    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i);
      if (skinned) obj.applyBoneTransform(i, v);
      v.applyMatrix4(obj.matrixWorld);
      basePos.set([v.x, v.y, v.z], i * 3);
      if (nor) {
        v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        baseNor.set([v.x, v.y, v.z], i * 3);
      }
      if (skinned) {
        let arm = 0;
        let head = 0;
        let armSide = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (!w) continue;
          const bn = boneNames[si.getComponent(i, k)];
          if (ARM_BONE.test(bn)) { arm += w; armSide += boneSide(bn) * w; }
          else if (SHOULDER_BONE.test(bn)) { arm += w * 0.5; armSide += boneSide(bn) * w; }
          else if (HEAD_BONE.test(bn)) head += w;
        }
        wArm[i] = clamp(arm, 0, 1);
        wHead[i] = clamp(head, 0, 1 - wArm[i]);
        side[i] = armSide > 0 ? 1 : armSide < 0 ? -1 : 0;
      }
    }

    // A plain (non-skinned) mesh that we move ourselves
    const staticGeo = new THREE.BufferGeometry();
    staticGeo.setAttribute('position', new THREE.BufferAttribute(basePos.slice(), 3));
    if (nor) staticGeo.setAttribute('normal', new THREE.BufferAttribute(baseNor.slice(), 3));
    if (geo.attributes.uv) staticGeo.setAttribute('uv', geo.attributes.uv);
    if (geo.index) staticGeo.setIndex(geo.index);
    const material = Array.isArray(obj.material)
      ? obj.material.map((mat) => fixMaterial(mat, obj.name))
      : fixMaterial(obj.material, obj.name);
    const mesh = new THREE.Mesh(staticGeo, material);
    mesh.name = obj.name;
    mesh.frustumCulled = false;
    const isBody = obj.name === bodyName;
    // Skin under the clothes is deleted on export, so we measure skin + clothes together
    // (like a tape measure over a T-shirt).
    const measured = isBody || /shirt|trouser|jean|suit|pant|dress|sweater/i.test(`${obj.name} ${material.name ?? ''}`);
    parts.push({ name: obj.name, mesh, basePos, baseNor, wArm, side, wHead, isBody, measured });
  });

  if (!parts.some((p) => p.isBody)) throw new Error(`Body mesh "${config.body}" not found in ${config.file}`);

  const group = new THREE.Group();
  group.name = `avatar-${gender}`;
  for (const p of parts) group.add(p.mesh);

  const avatar = { gender, group, parts, bones };
  avatar.base = measureBase(avatar);
  avatar.deform = (measurements) => deformAvatar(avatar, measurements);
  return avatar;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/**
 * Points [x, z] of a horizontal slice through the measured parts at height y (arms and
 * head excluded). useBase = true reads the rest pose, false the reshaped body.
 */
function slicePoints(parts, y, band, useBase, maxArm = 0.25, maxHead = 0.5) {
  const pts = [];
  for (const part of parts) {
    const P = useBase ? part.basePos : part.mesh.geometry.attributes.position.array;
    for (let i = 0; i < part.wArm.length; i++) {
      const py = P[i * 3 + 1];
      if (Math.abs(py - y) > band || part.wArm[i] > maxArm || part.wHead[i] > maxHead) continue;
      pts.push([P[i * 3], P[i * 3 + 2]]);
    }
  }
  return pts;
}

/** Find the y (in [y0, y1]) where the slice circumference is largest (or smallest). */
function searchSlice(parts, y0, y1, band, pick) {
  let best = null;
  for (let y = y0; y <= y1; y += 0.005) {
    const per = hullPerimeter(slicePoints(parts, y, band, true));
    if (per === 0) continue;
    if (!best || (pick === 'max' ? per > best.per : per < best.per)) best = { y, per };
  }
  return best;
}

/**
 * Length proportions of an average adult (tape measured), as a fraction of height.
 * Bone joints sit inside the body, so joint distances are shorter than a tape
 * measurement; we assume the base model has average proportions and calibrate with these.
 */
const AVERAGE_RATIOS = {
  male: { shoulder: 45 / 176, arm: 61 / 176, torso: 56 / 176 },
  female: { shoulder: 39 / 164, arm: 56 / 164, torso: 52 / 164 },
};

function measureBase(avatar) {
  const body = avatar.parts.find((p) => p.isBody);
  const measured = avatar.parts.filter((p) => p.measured);
  const P = body.basePos;
  const b = avatar.bones;
  const band = body.basePos.length / 3 < 5000 ? 0.018 : 0.008; // low-poly bodies need a thicker slice
  const ratios = AVERAGE_RATIOS[avatar.gender] ?? AVERAGE_RATIOS.male;

  let floor = Infinity;
  for (const part of avatar.parts) for (let i = 1; i < part.basePos.length; i += 3) floor = Math.min(floor, part.basePos[i]);
  let top = -Infinity;
  for (let i = 1; i < P.length; i += 3) top = Math.max(top, P[i]);

  const shL = b.get('upperarm01.L');
  const shR = b.get('upperarm01.R');
  const elL = b.get('lowerarm01.L');
  const wrL = b.get('wrist.L');
  const shoulderY = (shL.y + shR.y) / 2;
  const shoulderHalf = (Math.abs(shL.x) + Math.abs(shR.x)) / 2;
  const hipJointY = (b.get('upperleg01.L').y + b.get('upperleg01.R').y) / 2;
  const kneeY = (b.get('lowerleg01.L').y + b.get('lowerleg01.R').y) / 2;

  const chest = searchSlice(measured, shoulderY - 0.2, shoulderY - 0.08, band, 'max');
  const hip = searchSlice(measured, hipJointY - 0.06, hipJointY + 0.1, band, 'max');
  const waist = searchSlice(measured, hip.y + 0.08, chest.y - 0.06, band, 'min');
  if (!chest || !hip || !waist) throw new Error('Could not measure the 3D body (no slices found)');

  // Centre (z) of the body at each height, so slices scale around their own middle
  const centreZ = [];
  for (let y = floor; y <= top; y += 0.02) {
    const pts = slicePoints(measured, y, 0.012, true);
    if (!pts.length) { centreZ.push(centreZ.at(-1) ?? 0); continue; }
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, z] of pts) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
    centreZ.push((lo + hi) / 2);
  }

  const height = top - floor;
  return {
    floor, top, height,
    shoulderY, shoulderHalf,
    // Tape-measured lengths of the base model (calibrated, see AVERAGE_RATIOS)
    shoulderWidth: height * ratios.shoulder,
    armTape: height * ratios.arm,
    torsoTape: height * ratios.torso,
    shoulderJoint: { L: shL.clone(), R: shR.clone() },
    elbowJoint: { L: elL.clone(), R: b.get('lowerarm01.R').clone() },
    wristJoint: { L: wrL.clone(), R: b.get('wrist.R').clone() },
    armLength: shL.distanceTo(elL) + elL.distanceTo(wrL), // joint to joint (m)
    armAxis: { L: wrL.clone().sub(shL).normalize(), R: b.get('wrist.R').clone().sub(shR).normalize() },
    headPivot: b.get('head').clone(),
    chestY: chest.y, chest: chest.per,
    waistY: waist.y, waist: waist.per,
    hipY: hip.y, hip: hip.per,
    torsoLength: shoulderY - hip.y,
    kneeY, centreZ, band,
  };
}

/** Body-centre z at base height y (interpolated table). */
function centreZAt(base, y) {
  const f = (y - base.floor) / 0.02;
  const i = clamp(Math.floor(f), 0, base.centreZ.length - 1);
  const j = Math.min(i + 1, base.centreZ.length - 1);
  return lerp(base.centreZ[i], base.centreZ[j], clamp(f - i, 0, 1));
}

// ---------------------------------------------------------------------------
// Deforming to measurements
// ---------------------------------------------------------------------------

/**
 * Builds the mapping functions from base model -> user's body.
 * m = measurements in cm: { height, chest, waist, hip, shoulder, armLength, torsoLength }
 */
export function buildMapping(base, m) {
  const t = {
    height: m.height / 100, chest: m.chest / 100, waist: m.waist / 100, hip: m.hip / 100,
    shoulder: m.shoulder / 100, arm: m.armLength / 100, torso: m.torsoLength / 100,
  };
  const headScale = clamp(t.height / base.height, 0.94, 1.06);
  const headNeckBase = base.top - base.shoulderY;
  const headNeck = headNeckBase * headScale;
  const torsoK = t.torso / base.torsoTape;
  const legsBase = base.hipY - base.floor;
  const torsoJoint = base.torsoLength * torsoK; // the joint-to-hip span after scaling
  const legs = Math.max(0.4, t.height - torsoJoint - headNeck);
  const legsK = legs / legsBase;

  const hipY = base.floor + legs;
  const shoulderY = hipY + torsoJoint;

  /** New height for a base height y (body segments). */
  const mapY = (y) => {
    if (y <= base.hipY) return base.floor + (y - base.floor) * legsK;
    if (y <= base.shoulderY) return hipY + (y - base.hipY) * torsoK;
    return shoulderY + (y - base.shoulderY) * headScale;
  };

  const kChest = t.chest / base.chest;
  const kWaist = t.waist / base.waist;
  const kHip = t.hip / base.hip;
  const kShoulder = t.shoulder / base.shoulderWidth;

  /** Horizontal scale [sx, sz] for a base height y. */
  const scaleAt = (y) => {
    if (y >= base.shoulderY + 0.05) return [1, 1];
    if (y >= base.shoulderY) {
      const k = smooth((y - base.shoulderY) / 0.05);
      return [lerp(kShoulder, 1, k), lerp(kChest, 1, k)];
    }
    if (y >= base.chestY) {
      const k = smooth((y - base.chestY) / (base.shoulderY - base.chestY));
      return [lerp(kChest, kShoulder, k), kChest];
    }
    if (y >= base.waistY) {
      const k = smooth((y - base.waistY) / (base.chestY - base.waistY));
      const s = lerp(kWaist, kChest, k);
      return [s, s];
    }
    if (y >= base.hipY) {
      const k = smooth((y - base.hipY) / (base.waistY - base.hipY));
      const s = lerp(kHip, kWaist, k);
      return [s, s];
    }
    // Legs: thighs follow the hips, lower legs only a little
    const legK = 1 + (kHip - 1) * 0.35;
    const k = smooth((base.hipY - y) / (base.hipY - base.kneeY));
    const s = lerp(kHip, legK, k);
    return [s, s];
  };

  const armK = t.arm / base.armTape;
  const armThick = Math.sqrt(kChest);
  const shoulderTarget = {};
  for (const [s, key] of [[1, 'L'], [-1, 'R']]) {
    const j = base.shoulderJoint[key];
    shoulderTarget[key] = new THREE.Vector3(j.x * kShoulder, mapY(j.y), j.z);
  }

  return {
    mapY, scaleAt, kChest, kWaist, kHip, kShoulder, armK, armThick, headScale, torsoK, legsK,
    hipY, shoulderY, shoulderTarget,
    chestY: mapY(base.chestY), waistY: mapY(base.waistY),
    top: shoulderY + headNeck, floor: base.floor,
  };
}

/** Apply measurements to every part of the avatar (fast enough to run on every slider move). */
export function deformAvatar(avatar, measurements) {
  const base = avatar.base;
  const map = buildMapping(base, measurements);
  const pivotT = new THREE.Vector3(base.headPivot.x, map.mapY(base.headPivot.y), base.headPivot.z);

  for (const part of avatar.parts) {
    const pos = part.mesh.geometry.attributes.position;
    const nor = part.mesh.geometry.attributes.normal;
    const P = part.basePos;
    const N = part.baseNor;
    const out = pos.array;
    for (let i = 0; i < part.wArm.length; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];

      // 1) Body mapping: scale the slice around its centre, then move it vertically
      const [sx, sz] = map.scaleAt(y);
      const cz = centreZAt(base, y);
      let bx = x * sx;
      let by = map.mapY(y);
      let bz = cz + (z - cz) * sz;

      // 2) Arm mapping: stretch along the arm axis from the (moved) shoulder joint
      const wa = part.wArm[i];
      if (wa > 0 && part.side[i] !== 0) {
        const key = part.side[i] > 0 ? 'L' : 'R';
        const J = base.shoulderJoint[key];
        const A = base.armAxis[key];
        const rx = x - J.x;
        const ry = y - J.y;
        const rz = z - J.z;
        const along = rx * A.x + ry * A.y + rz * A.z;
        const px = rx - A.x * along;
        const py = ry - A.y * along;
        const pz = rz - A.z * along;
        const T = map.shoulderTarget[key];
        const ax = T.x + A.x * along * map.armK + px * map.armThick;
        const ay = T.y + A.y * along * map.armK + py * map.armThick;
        const az = T.z + A.z * along * map.armK + pz * map.armThick;
        bx = lerp(bx, ax, wa);
        by = lerp(by, ay, wa);
        bz = lerp(bz, az, wa);
      }

      // 3) Head mapping: keep the shape, move with the neck
      const wh = part.wHead[i];
      if (wh > 0) {
        const hx = pivotT.x + (x - base.headPivot.x) * map.headScale;
        const hy = pivotT.y + (y - base.headPivot.y) * map.headScale;
        const hz = pivotT.z + (z - base.headPivot.z) * map.headScale;
        bx = lerp(bx, hx, wh);
        by = lerp(by, hy, wh);
        bz = lerp(bz, hz, wh);
      }

      out[i * 3] = bx;
      out[i * 3 + 1] = by;
      out[i * 3 + 2] = bz;

      if (nor) {
        // Normals change with the inverse of the scale (approximation, good enough for lighting)
        const nx = N[i * 3] / sx;
        const ny = N[i * 3 + 1] / (y <= base.hipY ? map.legsK : map.torsoK);
        const nz = N[i * 3 + 2] / sz;
        const len = Math.hypot(nx, ny, nz) || 1;
        nor.array[i * 3] = nx / len;
        nor.array[i * 3 + 1] = ny / len;
        nor.array[i * 3 + 2] = nz / len;
      }
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    part.mesh.geometry.computeBoundingSphere();
  }

  avatar.mapping = map;
  avatar.measurements = { ...measurements };
  avatar.landmarks = computeLandmarks(avatar, map);
  return avatar.landmarks;
}

/**
 * Pull the T-shirt (and skin) under a jacket a few millimetres inwards, between
 * the jacket's hem and collar, so the under-layer can never poke through it —
 * in real life the jacket presses it down too. Call deform() again to undo.
 */
export function tuckUnder(avatar, { topY, hemY, tEnd = 1, depth = 0.008 }) {
  const L = avatar.landmarks;
  for (const part of avatar.parts) {
    if (!part.measured) continue;
    const pos = part.mesh.geometry.attributes.position;
    const P = pos.array;
    for (let i = 0; i < part.wArm.length; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      if (part.wHead[i] > 0.3) continue;
      if (part.wArm[i] > 0.5 && part.side[i] !== 0) {
        // Arm (e.g. the T-shirt sleeve): pull towards the arm line, but only under the jacket sleeve
        const path = L.arms[part.side[i] > 0 ? 'L' : 'R'];
        const hit = path.project(x, y, z);
        if (hit.t > tEnd - 0.02 || hit.dist < 0.02) continue;
        const c = path.at(clamp(hit.t, 0, 1.2));
        const k = Math.max(0.6, (hit.dist - depth * 2.5) / hit.dist); // T-shirt sleeves are roomier: pull more
        P[i * 3] = c.x + (x - c.x) * k;
        P[i * 3 + 1] = c.y + (y - c.y) * k;
        P[i * 3 + 2] = c.z + (z - c.z) * k;
        continue;
      }
      // Torso: pull towards the body's centre line, between hem and collar
      if (y > topY || y < hemY) continue;
      const cz = L.centreZ(y);
      const r = Math.hypot(x, z - cz);
      if (r < 0.03) continue;
      const k = (r - depth) / r;
      P[i * 3] = x * k;
      P[i * 3 + 2] = cz + (z - cz) * k;
    }
    pos.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Landmarks of the reshaped body (used to dress it)
// ---------------------------------------------------------------------------

/** Where the arm transform of deformAvatar() moves a base point (used for the elbow / wrist joints). */
function mapArmPoint(base, map, key, p) {
  const J = base.shoulderJoint[key];
  const A = base.armAxis[key];
  const r = p.clone().sub(J);
  const along = r.dot(A);
  const perp = r.clone().addScaledVector(A, -along);
  return map.shoulderTarget[key].clone().addScaledVector(A, along * map.armK).addScaledVector(perp, map.armThick);
}

/**
 * The arm as a bent line shoulder -> elbow -> wrist (the arms hang with the elbow
 * slightly bent forward, so a straight line would miss the upper arm).
 * at(t) / dirAt(t): t = 0 at the shoulder joint, 1 at the wrist, > 1 continues into the hand.
 */
function armPath(base, map, key) {
  const S = map.shoulderTarget[key].clone();
  const E = mapArmPoint(base, map, key, base.elbowJoint[key]);
  const W = mapArmPoint(base, map, key, base.wristJoint[key]);
  const upper = S.distanceTo(E);
  const length = upper + E.distanceTo(W);
  const tE = upper / length;
  const d1 = E.clone().sub(S).normalize();
  const d2 = W.clone().sub(E).normalize();
  const at = (t) => (t <= tE ? S.clone().addScaledVector(d1, t * length) : E.clone().addScaledVector(d2, (t - tE) * length));
  const dirAt = (t) => {
    const k = smooth((t - (tE - 0.06)) / 0.12); // blend the direction around the elbow
    return d1.clone().lerp(d2, k).normalize();
  };
  /** Closest point on the path: returns { t, dist } for a point (x, y, z). */
  const project = (x, y, z) => {
    let best = null;
    for (const [P0, d, t0, segLen] of [[S, d1, 0, upper], [E, d2, tE, length - upper]]) {
      const rx = x - P0.x;
      const ry = y - P0.y;
      const rz = z - P0.z;
      const along = clamp(rx * d.x + ry * d.y + rz * d.z, t0 === 0 ? -0.1 : 0, segLen + (t0 === 0 ? 0 : 0.25));
      const dist = Math.hypot(rx - d.x * along, ry - d.y * along, rz - d.z * along);
      if (!best || dist < best.dist) best = { t: t0 + along / length, dist };
    }
    return best;
  };
  return { S, E, W, length, tE, at, dirAt, project };
}

function computeLandmarks(avatar, map) {
  const base = avatar.base;
  const measured = avatar.parts.filter((p) => p.measured);
  const arms = { L: armPath(base, map, 'L'), R: armPath(base, map, 'R') };

  return {
    floor: map.floor,
    top: map.top,
    shoulderY: map.shoulderY,
    chestY: map.chestY,
    waistY: map.waistY,
    hipY: map.hipY,
    armpitY: map.shoulderY - (base.shoulderY - base.chestY) * map.torsoK * 0.55,
    shoulderJoint: map.shoulderTarget,
    arms,
    armLength: arms.L.length,
    /**
     * Points [x, z] of a body slice at a (reshaped) height y — arms excluded.
     * maxArm: vertices that belong to an arm by more than this are left out
     * (use ~0.6 at shoulder height so the deltoid caps are included).
     * maxHead: the same for the head; 1 includes the neck (only skin and clothes are sliced, never hair).
     */
    slice: (y, band = base.band, maxArm = 0.25, maxHead = 0.5) => slicePoints(measured, y, band, false, maxArm, maxHead),
    /** Distance from the arm line to the arm surface at t (0 = shoulder, 1 = wrist). */
    armRadius: (key, t) => armRadiusAt(measured, arms[key], key === 'L' ? 1 : -1, t),
    centreZ: (y) => centreZAt(base, inverseMapY(map, base, y)),
  };
}

function inverseMapY(map, base, y) {
  // mapY is monotonic: simple bisection
  let lo = base.floor - 0.1;
  let hi = base.top + 0.2;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (map.mapY(mid) < y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function armRadiusAt(parts, path, side, t) {
  // Distances from the arm line to the arm surface around position t. We use the
  // 75th percentile, not the maximum: armpit skin and spread fingers would spoil a max.
  const window = 0.015 / path.length;
  const dists = [];
  for (const part of parts) {
    const P = part.mesh.geometry.attributes.position.array;
    for (let i = 0; i < part.wArm.length; i++) {
      if (part.wArm[i] < 0.6 || part.side[i] !== side) continue;
      const hit = path.project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      if (Math.abs(hit.t - t) <= window) dists.push(hit.dist);
    }
  }
  if (!dists.length) return 0.04;
  dists.sort((a, b) => a - b);
  return dists[Math.floor(dists.length * 0.75)];
}
