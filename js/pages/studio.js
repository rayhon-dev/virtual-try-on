// studio.js — logic for studio.html.
import { getDefaultBody, loadBody } from '../core/storage.js';
import { loadFitRules, loadGarments } from '../core/data.js';
import { PREFERENCES, recommendSize } from '../core/fitEngine.js';
import { buildGarment, loadGarmentTexture } from '../core/garmentRenderer.js';
import { tuckUnder } from '../core/avatar3d.js';
import { createAvatarStage } from '../ui/avatarStage.js';
import { renderCatalog } from '../ui/catalogPanel.js';
import { renderSizePanel } from '../ui/sizePanel.js';
import { renderResults } from '../ui/resultsPanel.js';

const $ = (id) => document.getElementById(id);
const catalogPanel = $('catalog-panel');
const sizePanel = $('size-panel');
const resultsPanel = $('results-panel');
const drawer = $('catalog-drawer');
const fitMapBtn = $('fitmap-btn');
const legend = $('fit-legend');
const caption = $('stage-caption');
const tabs = $('tabs');

const saved = loadBody();
const body = saved ?? getDefaultBody('male');
const state = {
  tab: 'outerwear',
  garmentId: null,
  size: null,
  preference: null,
  fitMap: false,
};
let garments = [];
let rules = null;
let dressToken = 0;

const stage = createAvatarStage($('stage-figure'), {
  loadingEl: $('stage-loading'),
  onError: () => { caption.textContent = '3D not available — fit results still work.'; },
});

function writeUrl() {
  const params = new URLSearchParams();
  if (state.garmentId) {
    params.set('id', state.garmentId);
    if (state.size) params.set('size', state.size);
    if (state.preference) params.set('fit', state.preference);
  }
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  const g = garments.find((x) => x.id === params.get('id'));
  if (!g) return;
  state.tab = g.category;
  state.garmentId = g.id;
  if (g.sizes[params.get('size')]) state.size = params.get('size');
  if (PREFERENCES.includes(params.get('fit'))) state.preference = params.get('fit');
}

function render() {
  for (const tab of tabs.querySelectorAll('.tab'))
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));

  if (state.tab !== 'outerwear') {
    catalogPanel.innerHTML = `<p class="empty-state">${state.tab} are coming soon.</p>`;
    sizePanel.innerHTML = '';
    resultsPanel.innerHTML = '';
    return;
  }

  const items = garments.filter((g) => g.category === state.tab && (g.gender === body.gender || g.gender === 'unisex'));
  const badges = Object.fromEntries(items.map((g) => [g.id, recommendSize(body.measurements, g, g.designFit, rules).bestSize]));
  renderCatalog(catalogPanel, { garments: items, selectedId: state.garmentId, badges, onSelect: selectGarment });

  const garment = garments.find((g) => g.id === state.garmentId);
  fitMapBtn.disabled = !garment || stage.mode !== '3d';
  legend.hidden = !(garment && state.fitMap && stage.mode === '3d');

  if (!garment) {
    sizePanel.innerHTML = '<p class="empty-state">Pick a garment to see fit results.</p>';
    resultsPanel.innerHTML = '';
    stage.setGarment(null);
    stage.avatar?.deform(body.measurements);
    writeUrl();
    return;
  }

  const preference = state.preference ?? garment.designFit;
  const rec = recommendSize(body.measurements, garment, preference, rules);
  const size = state.size ?? rec.bestSize;
  const evaluation = rec.results.find((r) => r.size === size);

  renderSizePanel(sizePanel, {
    garment, results: rec.results, bestSize: rec.bestSize, size, preference,
    onSize: (s) => { state.size = s; render(); },
    onPreference: (p) => { state.preference = p; state.size = null; render(); },
  });
  renderResults(resultsPanel, {
    evaluation, verdict: rec.verdict, hint: rec.hint,
    zoneRules: rules.categories[garment.category].zones,
  });
  writeUrl();
  dress(garment, size, evaluation);
}

async function dress(garment, size, evaluation) {
  const token = ++dressToken;
  if (!stage.avatar || stage.mode !== '3d') return;
  try {
    const texture = await loadGarmentTexture(garment, stage.viewer?.renderer);
    if (token !== dressToken) return;
    const zoneResults = Object.fromEntries(evaluation.zones.map((z) => [z.zone, z]));
    stage.avatar.deform(body.measurements);
    const mesh = buildGarment(stage.avatar, garment, size, { texture, fitMap: state.fitMap, zoneResults });
    tuckUnder(stage.avatar, mesh.userData);
    stage.setGarment(mesh);
  } catch (err) {
    console.error(err);
    caption.textContent = `Could not draw ${garment.name}.`;
  }
}

function selectGarment(id) {
  state.garmentId = id;
  state.size = null;
  state.preference = null;
  drawer.hidden = true;
  render();
}

tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  render();
});
fitMapBtn.addEventListener('click', () => {
  state.fitMap = !state.fitMap;
  fitMapBtn.setAttribute('aria-pressed', String(state.fitMap));
  render();
});
$('open-catalog-btn').addEventListener('click', () => drawer.hidden = false);
$('close-catalog-btn').addEventListener('click', () => drawer.hidden = true);

async function init() {
  caption.textContent = `Your avatar · ${body.measurements.height} CM`;
  try {
    [garments, rules] = await Promise.all([loadGarments(), loadFitRules()]);
  } catch (err) {
    catalogPanel.innerHTML = `<p class="empty-state">Could not load catalog.</p>`;
    return;
  }
  readUrl();
  render();
  await stage.show(body);
  render();
}

init();
