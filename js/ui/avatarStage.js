// avatarStage.js — shows the user's avatar on a page's stage.
// 3D (viewer3d + avatar3d) when the browser supports WebGL and the GLB files load;
// otherwise the 2D SVG mannequin (mannequin.js) as a fallback, so the page never breaks.
//
// Both pages use it:
//   const stage = createAvatarStage(container, { loadingEl });
//   await stage.show(body);       // body = { gender, measurements }
//   stage.setGarment(mesh);       // 3D only

import { createViewer, hasWebGL } from '../core/viewer3d.js';
import { loadAvatar } from '../core/avatar3d.js';
import { buildMannequinSvg, computeBodyGeometry } from '../core/mannequin.js';

export function createAvatarStage(container, { loadingEl = null, onError = null } = {}) {
  let mode = hasWebGL() ? '3d' : '2d';
  let viewer = null;
  let current = null;          // the avatar on screen
  let shownHeight = null;      // re-frame the camera only when the height changes
  const avatars = {};          // gender -> Promise<avatar>  (each GLB is loaded once)
  let latest = null;           // the most recent body asked for
  let rafId = 0;

  const setLoading = (on) => { if (loadingEl) loadingEl.hidden = !on; };

  function draw2d(body) {
    container.querySelector('.viewer-canvas')?.remove();
    container.innerHTML = buildMannequinSvg(computeBodyGeometry(body), { showRuler: true });
  }

  async function render(body) {
    if (mode === '2d') { draw2d(body); return null; }
    try {
      viewer ??= createViewer(container);
      avatars[body.gender] ??= loadAvatar(body.gender);
      if (!current || current.gender !== body.gender) setLoading(true);
      const avatar = await avatars[body.gender];
      setLoading(false);
      if (latest !== body) return current; // a newer body arrived while loading
      avatar.deform(body.measurements);
      const reframe = current !== avatar || shownHeight !== body.measurements.height;
      if (current && current !== avatar) viewer.setGarment(null); // garments were built for the other body
      viewer.setAvatar(avatar, { reframe });
      current = avatar;
      shownHeight = body.measurements.height;
      return avatar;
    } catch (err) {
      console.error(err);
      setLoading(false);
      mode = '2d';
      viewer?.dispose();
      viewer = null;
      onError?.(err);
      draw2d(body);
      return null;
    }
  }

  return {
    get mode() { return mode; },
    get avatar() { return current; },
    get viewer() { return viewer; },
    /** Show a body now (awaitable). */
    show(body) {
      latest = body;
      return render(body);
    },
    /** Show a body on the next animation frame (for sliders: many calls -> one redraw). */
    schedule(body) {
      latest = body;
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; render(latest); });
    },
    setGarment(mesh) { viewer?.setGarment(mesh); },
  };
}
