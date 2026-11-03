// viewer3d.js — the 3D "photo studio": renderer, camera, lights, floor shadow
// and mouse/touch rotation. Pages create one viewer and put an avatar
// (and optionally a garment) into it.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Soft round shadow texture for the floor (drawn once on a 2D canvas). */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(40,30,20,0.42)');
  g.addColorStop(0.5, 'rgba(40,30,20,0.16)');
  g.addColorStop(1, 'rgba(40,30,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * createViewer(container) -> {
 *   setAvatar(avatar), setGarment(mesh | null), frame(), resetView(), dispose()
 * }
 * options.maxAzimuth = how far the user may turn the avatar (radians, each side)
 */
export function createViewer(container, { maxAzimuth = 0.95 } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = 'viewer-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Soft image-based light (like a photo studio with big soft boxes)
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const key = new THREE.DirectionalLight(0xfff4e8, 1.5);
  key.position.set(-1.6, 3, 2.6);
  const fill = new THREE.DirectionalLight(0xe8eeff, 0.45);
  fill.position.set(2, 1.4, 2);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(0.5, 2.6, -3);
  scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xd9d0c4, 0.35));

  const floorShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.7),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
  );
  floorShadow.rotation.x = -Math.PI / 2;
  scene.add(floorShadow);

  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minAzimuthAngle = -maxAzimuth;
  controls.maxAzimuthAngle = maxAzimuth;
  controls.minPolarAngle = Math.PI * 0.38;
  controls.maxPolarAngle = Math.PI * 0.56;
  controls.rotateSpeed = 0.6;

  let avatarGroup = null;
  let garment = null;
  let height = 1.75;

  /** Put the camera so the whole figure fits, with a little room around it. */
  function frame() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    camera.aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const needH = height * 1.12;
    const needW = 1.25; // arms (A-pose) + a little air
    const distH = needH / 2 / Math.tan(vfov / 2);
    const distW = needW / 2 / (Math.tan(vfov / 2) * camera.aspect);
    const dist = Math.max(distH, distW);
    controls.target.set(0, height * 0.5, 0);
    camera.position.set(0, height * 0.52, dist);
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 1.15;
    camera.near = dist / 20;
    camera.far = dist * 4;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(() => { resize(); });
  observer.observe(container);
  resize();

  let running = true;
  function loop() {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    renderer,
    scene,
    camera,
    /** Show an avatar (from avatar3d.js). Re-frames the camera on the first call or when asked. */
    setAvatar(avatar, { reframe = true } = {}) {
      if (avatarGroup && avatarGroup !== avatar.group) scene.remove(avatarGroup);
      avatarGroup = avatar.group;
      scene.add(avatarGroup);
      height = (avatar.landmarks?.top ?? 1.75) - (avatar.landmarks?.floor ?? 0);
      floorShadow.position.y = (avatar.landmarks?.floor ?? 0) + 0.002;
      if (reframe) frame();
    },
    /** Show a garment mesh (or null to take it off). */
    setGarment(mesh) {
      if (garment) {
        scene.remove(garment);
        garment.traverse((o) => { o.geometry?.dispose(); });
      }
      garment = mesh;
      if (garment) scene.add(garment);
    },
    frame,
    resetView() { frame(); },
    dispose() {
      running = false;
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** True if this browser can draw WebGL (otherwise the pages fall back to the 2D drawing). */
export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
