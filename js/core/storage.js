// storage.js — the "body" model: measurement fields, defaults, validation,
// and saving/loading the body in localStorage.
//
// Saved body format (in localStorage, as JSON text):
//   { version: 1, gender: "male" | "female", measurements: { height, chest, ... }, savedAt }
//
// localStorage = a small key -> string store inside the browser (like a tiny
// persistent Python dict). It survives page reloads but only on this device.

const STORAGE_KEY = 'fitcheck.body.v1';

export const GENDERS = ['male', 'female'];

/**
 * Every measurement the form asks for (all in cm).
 * min/max = realistic adult range; values outside it are rejected.
 * group = which section of the form it appears in (body / upper / lower).
 * This list drives the form, so adding a field here adds it to the page.
 */
export const MEASUREMENT_FIELDS = [
  { key: 'height', group: 'body', label: 'Height', min: 140, max: 210, required: true,
    hint: 'Stand straight against a wall without shoes. Measure from the floor to the top of your head.' },
  { key: 'chest', group: 'upper', label: 'Chest', labelFemale: 'Bust', min: 70, max: 150, required: true,
    hint: 'Measure around the fullest part of the chest, under the arms. Keep the tape level and relaxed.' },
  { key: 'waist', group: 'upper', label: 'Waist', min: 55, max: 150, required: true,
    hint: 'Measure around your natural waist — the narrowest part, a little above the belly button.' },
  { key: 'hip', group: 'lower', label: 'Hip', min: 70, max: 160, required: true,
    hint: 'Feet together, measure around the widest part of your hips and seat.' },
  { key: 'shoulder', group: 'upper', label: 'Shoulder width', min: 30, max: 60, required: true,
    hint: 'Across the back, from one shoulder point (the bony tip) to the other.' },
  { key: 'armLength', group: 'upper', label: 'Arm length', min: 45, max: 75, required: true,
    hint: 'From the shoulder point down the outside of a slightly bent arm to the wrist bone.' },
  { key: 'torsoLength', group: 'upper', label: 'Torso length', min: 40, max: 80, required: true,
    hint: 'From the shoulder point straight down the front to your hip line (widest part of the hips).' },
  { key: 'thigh', group: 'lower', label: 'Thigh', min: 35, max: 90, required: false,
    hint: 'Around the fullest part of one thigh, just below the crotch.' },
  { key: 'inseam', group: 'lower', label: 'Inseam', min: 60, max: 100, required: false,
    hint: 'From the crotch down the inside of the leg to the floor, without shoes.' },
];

/** Average adult measurements used to pre-fill the form. Optional fields stay empty. */
export const DEFAULT_MEASUREMENTS = {
  male:   { height: 176, chest: 98, waist: 84, hip: 98, shoulder: 45, armLength: 61, torsoLength: 56 },
  female: { height: 164, chest: 90, waist: 72, hip: 98, shoulder: 39, armLength: 56, torsoLength: 52 },
};

/** Label for a field, e.g. "Bust" instead of "Chest" for female. */
export function getFieldLabel(field, gender) {
  return gender === 'female' && field.labelFemale ? field.labelFemale : field.label;
}

/** A fresh default body for a gender (a copy, so the defaults are never changed). */
export function getDefaultBody(gender) {
  return { gender, measurements: { ...DEFAULT_MEASUREMENTS[gender] } };
}

// ---------------------------------------------------------------------------
// Validation (pure functions — no DOM)
// ---------------------------------------------------------------------------

/** "98", "98.5" or "98,5" -> number. Anything else -> null. */
export function parseNumber(text) {
  const clean = text.trim().replace(',', '.');
  // Regex: digits, optionally followed by "." and more digits (same as Python's re)
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  return Number(clean); // like float(clean)
}

/**
 * Validate one field's raw text.
 * Returns { value, error } — value is a number (or null if empty optional),
 * error is a message string or null.
 */
export function validateField(field, rawText, gender) {
  const text = rawText == null ? '' : String(rawText).trim();
  const label = getFieldLabel(field, gender);

  if (text === '') {
    return field.required
      ? { value: null, error: `${label} is required.` }
      : { value: null, error: null };
  }

  const value = parseNumber(text);
  if (value === null) {
    return { value: null, error: 'Please enter a number in cm, e.g. 98 or 98.5.' };
  }
  if (value < field.min || value > field.max) {
    return { value: null, error: `${label} must be between ${field.min} and ${field.max} cm.` };
  }
  return { value, error: null };
}

/**
 * Validate all fields at once.
 * rawValues = { height: "176", chest: "98", ... } (strings from the form, or numbers)
 * Returns { measurements, errors, isValid }
 */
export function validateMeasurements(rawValues, gender) {
  const measurements = {};
  const errors = {};
  for (const field of MEASUREMENT_FIELDS) {
    const { value, error } = validateField(field, rawValues[field.key], gender);
    if (error) errors[field.key] = error;
    else if (value !== null) measurements[field.key] = value;
  }
  return { measurements, errors, isValid: Object.keys(errors).length === 0 };
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

/** Save the body. Returns true on success, false if the browser blocks storage. */
export function saveBody({ gender, measurements }) {
  try {
    const data = { version: 1, gender, measurements, savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); // JSON.stringify = json.dumps
    return true;
  } catch {
    return false; // e.g. private mode or storage disabled
  }
}

/** Load the saved body, or null if there is none or it is broken/invalid. */
export function loadBody() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw); // JSON.parse = json.loads
    if (!GENDERS.includes(data.gender) || typeof data.measurements !== 'object') return null;

    // Re-validate, so old or hand-edited data can never break the app.
    const { measurements, isValid } = validateMeasurements(data.measurements, data.gender);
    return isValid ? { gender: data.gender, measurements } : null;
  } catch {
    return null;
  }
}
