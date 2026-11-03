// sizePanel.js — size pills with status dots + fit preference.
import { escapeHtml } from './catalogPanel.js';
import { PREFERENCES } from '../core/fitEngine.js';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * renderSizePanel(container, {
 *   garment, results, bestSize, size, preference, onSize(size), onPreference(pref)
 * })
 */
export function renderSizePanel(container, { garment, results, bestSize, size, preference, onSize, onPreference }) {
  const stretch = garment.stretch ? ` · ${Math.round(garment.stretch * 100)}% stretch` : '';

  container.innerHTML = `
    <div style="margin-top: var(--space-4);">
      <div class="label-row">
        <h3 class="panel-title">${escapeHtml(garment.name)}</h3>
      </div>
      <p class="panel-note">Designed as ${garment.designFit} fit${stretch}</p>

      <div class="label-row"><span class="section-label">Select Size</span></div>
      <div class="size-row" role="group" aria-label="Size">
        ${results.map((r) => `
          <button type="button" class="size-pill ${r.size === bestSize ? 'is-best' : ''}" data-size="${r.size}"
                  aria-pressed="${r.size === size}">
            <strong>${r.size}</strong>
            <div class="size-dots">
              ${r.zones.map(z => `<span class="size-dot ${z.status}"></span>`).join('')}
            </div>
          </button>`).join('')}
      </div>

      <div class="label-row"><span class="section-label">Fit Preference</span></div>
      <div class="segmented compact" role="radiogroup" aria-label="Fit preference">
        ${PREFERENCES.map((p) => `
          <label><input type="radio" name="fit-pref" value="${p}" ${p === preference ? 'checked' : ''}>${capitalize(p)}</label>`).join('')}
      </div>
    </div>`;

  container.onclick = (event) => {
    const pill = event.target.closest('.size-pill');
    if (pill) onSize(pill.dataset.size);
  };
  container.onchange = (event) => {
    if (event.target.name === 'fit-pref') onPreference(event.target.value);
  };
}
