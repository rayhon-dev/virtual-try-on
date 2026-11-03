// avatar.js — logic for index.html ("Create your avatar").
// Flow: load saved body (or defaults) -> build the form -> validate live ->
// reshape the 3D avatar -> on submit save to localStorage and open the studio.
import {
  MEASUREMENT_FIELDS, getDefaultBody, getFieldLabel, loadBody, saveBody,
  validateField, validateMeasurements,
} from '../core/storage.js';
import { createAvatarStage } from '../ui/avatarStage.js';

// --- "How to measure" icons -------------------------------------------------
const MEASURE_LINES = {
  height:      '<path d="M21 1.5v21.5M19.5 1.5h3M19.5 23h3"/>',
  chest:       '<path d="M7.6 9.5h8.8"/>',
  waist:       '<path d="M8.4 12.3h7.2"/>',
  hip:         '<path d="M8.4 15h7.2"/>',
  shoulder:    '<path d="M8 6.2h8"/>',
  armLength:   '<path d="M16.4 7l2.1 8"/>',
  torsoLength: '<path d="M12 7v8"/>',
  thigh:       '<path d="M8.6 17.3h2.6"/>',
  inseam:      '<path d="M12.8 15.6v7.4"/>',
};

function hintIcon(key) {
  return `
    <svg class="hint-icon" viewBox="0 0 24 24" aria-hidden="true">
      <g class="hint-figure">
        <circle cx="12" cy="3.4" r="2"/>
        <path d="M8 7h8l-1 8H9z M8 7l-2 8 M16 7l2 8 M9.5 15L9 23 M14.5 15L15 23"/>
      </g>
      <g class="hint-measure">${MEASURE_LINES[key] ?? ''}</g>
    </svg>`;
}

// --- Page state ---------------------------------------------------------------
const state = {
  gender: 'male',
  touched: new Set(),
  showAllErrors: false,
};

const form = document.getElementById('avatar-form');
const groupBoxes = {
  body: document.getElementById('fields-body'),
  upper: document.getElementById('fields-upper'),
  lower: document.getElementById('fields-lower'),
};
const formError = document.getElementById('form-error');
const preview = document.getElementById('preview-area');
const scaleCaption = document.getElementById('scale-caption');
const stage = createAvatarStage(preview, {
  loadingEl: document.getElementById('stage-loading'),
  onError: () => { scaleCaption.textContent = 'Showing the 2D preview (3D could not load).'; },
});
const resetBtn = document.getElementById('reset-btn');
const genderRadios = document.querySelectorAll('input[name="gender"]');

const inputOf = (key) => document.getElementById(`f-${key}`);
const sliderOf = (key) => document.getElementById(`r-${key}`);
const errorOf = (key) => document.getElementById(`e-${key}`);
const fieldOf = (key) => MEASUREMENT_FIELDS.find((f) => f.key === key);

// --- Build the form from MEASUREMENT_FIELDS -----------------------------------

function renderFields() {
  for (const field of MEASUREMENT_FIELDS) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `
      <div class="field-head">
        <div class="mono-label">${field.key.replace(/([A-Z])/g, ' $1')}</div>
        <label class="field-label" for="f-${field.key}"></label>
        <button type="button" class="hint-btn" data-hint="${field.key}"
                aria-expanded="false" aria-controls="h-${field.key}" title="How to measure">?</button>
        <div class="value-box">
          <input id="f-${field.key}" name="${field.key}" type="text" inputmode="decimal"
                 autocomplete="off" placeholder="${field.required ? '' : '—'}" aria-describedby="e-${field.key}">
          <span>CM</span>
        </div>
      </div>
      ${field.required
        ? `<div class="slider-wrap">
             <input type="range" class="slider" id="r-${field.key}" data-key="${field.key}"
                    min="${field.min}" max="${field.max}" step="0.5" aria-label="${field.label} slider">
             <div class="slider-avg" id="avg-${field.key}" title="Reset to average" data-key="${field.key}"></div>
           </div>`
        : ''}
      <p class="field-error" id="e-${field.key}"></p>
      <div class="hint" id="h-${field.key}" hidden>${hintIcon(field.key)}<p>${field.hint}</p></div>`;
    groupBoxes[field.group].appendChild(row);
  }
}

function updateLabels() {
  const avgs = getDefaultBody(state.gender).measurements;
  for (const field of MEASUREMENT_FIELDS) {
    const label = form.querySelector(`label[for="f-${field.key}"]`);
    label.textContent = getFieldLabel(field, state.gender) + (field.required ? '' : ' (optional)');

    // Update the average marker position on the slider
    const avgMarker = document.getElementById(`avg-${field.key}`);
    if (avgMarker && avgs[field.key]) {
      const pct = ((avgs[field.key] - field.min) / (field.max - field.min)) * 100;
      avgMarker.style.left = `${pct}%`;
    }
  }
}

function setSlider(key, value) {
  const slider = sliderOf(key);
  if (!slider || value == null) return;
  slider.value = value;
  const field = fieldOf(key);
  slider.style.setProperty('--fill', `${((value - field.min) / (field.max - field.min)) * 100}%`);
}

function fillValues(measurements, { onlyUntouched = false } = {}) {
  for (const field of MEASUREMENT_FIELDS) {
    if (onlyUntouched && state.touched.has(field.key)) continue;
    const value = measurements[field.key];
    inputOf(field.key).value = value == null ? '' : String(value);
    setSlider(field.key, value);
  }
}

function readRawValues() {
  const raw = {};
  for (const field of MEASUREMENT_FIELDS) raw[field.key] = inputOf(field.key).value;
  return raw;
}

// --- Errors -------------------------------------------------------------------

function showFieldError(key, message) {
  const errEl = errorOf(key);
  errEl.textContent = message ?? '';
  inputOf(key).classList.toggle('invalid', Boolean(message));
  inputOf(key).setAttribute('aria-invalid', message ? 'true' : 'false');
}

function checkField(key) {
  const { value, error } = validateField(fieldOf(key), inputOf(key).value, state.gender);
  const visible = state.showAllErrors || state.touched.has(key);
  showFieldError(key, visible ? error : null);
  if (!error) setSlider(key, value);
}

function clearAllErrors() {
  for (const field of MEASUREMENT_FIELDS) showFieldError(field.key, null);
  formError.hidden = true;
}

// --- Preview ------------------------------------------------------------------

const lastValid = {};

function updatePreview() {
  const { measurements } = validateMeasurements(readRawValues(), state.gender);
  for (const field of MEASUREMENT_FIELDS) {
    if (field.key in measurements) lastValid[field.key] = measurements[field.key];
    else if (!field.required) delete lastValid[field.key];
  }
  const body = { gender: state.gender, measurements: { ...getDefaultBody(state.gender).measurements, ...lastValid } };
  stage.schedule(body);
  scaleCaption.textContent = `${state.gender.toUpperCase()} / ${body.measurements.height} CM / SHAPED TO MEASURE`;
}

// --- Event handlers -----------------------------------------------------------

function onGenderChange(event) {
  state.gender = event.target.value;
  fillValues(getDefaultBody(state.gender).measurements, { onlyUntouched: true });
  updateLabels();
  for (const field of MEASUREMENT_FIELDS) checkField(field.key);
  updatePreview();
}

function onInput(event) {
  const el = event.target;
  if (el.classList.contains('slider')) return onSlide(event);
  const key = el.name;
  if (!key || !fieldOf(key)) return;
  state.touched.add(key);
  checkField(key);
  updatePreview();
}

function onSlide(event) {
  const key = event.target.dataset.key;
  state.touched.add(key);
  inputOf(key).value = event.target.value;
  checkField(key);
  updatePreview();
}

function onClick(event) {
  // Hint button
  const hintBtn = event.target.closest('.hint-btn');
  if (hintBtn) {
    const hint = document.getElementById(`h-${hintBtn.dataset.hint}`);
    hint.hidden = !hint.hidden;
    hintBtn.setAttribute('aria-expanded', String(!hint.hidden));
    return;
  }

  // Reset to average marker
  const avgBtn = event.target.closest('.slider-avg');
  if (avgBtn) {
    const key = avgBtn.dataset.key;
    const avg = getDefaultBody(state.gender).measurements[key];
    inputOf(key).value = avg;
    state.touched.add(key);
    checkField(key);
    updatePreview();
  }
}

function onReset() {
  state.touched.clear();
  state.showAllErrors = false;
  fillValues(getDefaultBody(state.gender).measurements);
  clearAllErrors();
  updatePreview();
}

function onSubmit(event) {
  event.preventDefault();
  state.showAllErrors = true;

  const { measurements, errors, isValid } = validateMeasurements(readRawValues(), state.gender);
  for (const field of MEASUREMENT_FIELDS) showFieldError(field.key, errors[field.key]);

  if (!isValid) {
    const count = Object.keys(errors).length;
    formError.textContent = `Please fix ${count} unusual measurement${count > 1 ? 's' : ''}.`;
    formError.hidden = false;
    inputOf(Object.keys(errors)[0]).focus();
    return;
  }

  if (!saveBody({ gender: state.gender, measurements })) {
    formError.textContent = 'Storage blocked.';
    formError.hidden = false;
    return;
  }

  window.location.href = 'studio.html';
}

// --- Start --------------------------------------------------------------------

function init() {
  renderFields();

  const saved = loadBody();
  const body = saved ?? getDefaultBody('male');
  state.gender = body.gender;
  if (saved) Object.keys(saved.measurements).forEach((key) => state.touched.add(key));
  for (const radio of genderRadios) radio.checked = radio.value === body.gender;
  fillValues(body.measurements);
  updateLabels();
  updatePreview();

  form.addEventListener('input', onInput);
  form.addEventListener('click', onClick);
  form.addEventListener('submit', onSubmit);
  for (const radio of genderRadios) radio.addEventListener('change', onGenderChange);
  resetBtn.addEventListener('click', onReset);
}

init();
