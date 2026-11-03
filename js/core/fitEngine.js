// fitEngine.js — the fit calculation "brain" of FitCheck.
//
// PURE functions only: data in -> new data out. No DOM, no fetch, no localStorage,
// and inputs are never modified. This makes every function easy to test,
// exactly like plain Python functions without side effects.
//
// Units: everything is in cm. Circumferences (chest, waist) are FULL circumferences.
//
// Inputs used everywhere:
//   body    = { chest, waist, hip, shoulder, armLength, torsoLength, ... }   (a JS object = Python dict)
//   garment = one item from garments.json (has .category, .stretch, .designFit, .sizes)
//   rules   = the whole fitRules.json object

/** Size order for sorting and "one size up/down" logic. */
export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

/** Fit preferences from tightest to loosest. */
export const PREFERENCES = ['fitted', 'regular', 'relaxed', 'oversized'];

/** Possible zone statuses (an object used like a Python Enum). */
export const STATUS = {
  TOO_TIGHT: 'tooTight',
  TIGHT: 'tight',
  GOOD: 'good',
  LOOSE: 'loose',
  TOO_LOOSE: 'tooLoose',
  NA: 'n/a', // measurement missing -> zone skipped
};

// Arrow function = Python lambda:  round1 = lambda x: round(x * 10) / 10
// Rounding to 0.1 cm hides float noise like 0.30000000000000004.
const round1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------

/** Zone rules for a garment category, e.g. rules.categories.outerwear.zones */
export function getZoneRules(rules, category) {
  const cat = rules.categories[category];
  if (!cat) throw new Error(`No fit rules for category "${category}"`);
  return cat.zones;
}

/**
 * Target ease range [min, max] for a zone and preference.
 * Zones with an "any" range ignore the preference (e.g. sleeve, length).
 * The layer allowance (extra room for the T-shirt underneath) is added on top.
 */
export function getTargetRange(zoneRule, preference) {
  // "??" = "use the right side if the left is null/undefined" (like Python's "x if x is not None else y")
  const base = zoneRule.ranges.any ?? zoneRule.ranges[preference];
  if (!base) throw new Error(`No range for preference "${preference}"`);
  const allowance = zoneRule.allowance ?? 0;
  return [base[0] + allowance, base[1] + allowance];
}

// ---------------------------------------------------------------------------
// Step 1: ease per zone
// ---------------------------------------------------------------------------

/**
 * ease = garment measurement - body measurement.
 * Returns { bodyValue, garmentValue, ease } or null if a measurement is missing.
 *
 * Drop-shoulder correction (sleeve only): if the shoulder seam sits further out
 * than the body's shoulder point, part of the arm is already covered by the body
 * of the jacket. Each side gains (garmentShoulder - bodyShoulder) / 2.
 */
export function computeEase(zoneRule, body, size) {
  const bodyValue = body[zoneRule.bodyKey];
  let garmentValue = size[zoneRule.garmentKey];
  // "== null" is true for both null and undefined (≈ Python "is None")
  if (bodyValue == null || garmentValue == null) return null;

  if (zoneRule.dropShoulderCorrection && size.shoulder != null && body.shoulder != null) {
    garmentValue += (size.shoulder - body.shoulder) / 2;
  }

  return {
    bodyValue,
    garmentValue: round1(garmentValue),
    ease: round1(garmentValue - bodyValue),
  };
}

// ---------------------------------------------------------------------------
// Step 2: status per zone
// ---------------------------------------------------------------------------

/**
 * Classify one zone.
 *   above max + tolerance        -> tooLoose
 *   above max                    -> loose
 *   inside [min, max]            -> good
 *   below min, but still wearable -> tight
 *   below that                   -> tooTight
 *
 * "Wearable" uses stretch: the garment can grow to garment * (1 + stretch),
 * so the reachable ease is ease + garment * stretch (only for stretchable zones).
 * For width zones it must also leave room for the base layer (allowance),
 * so a negative ease is only OK if stretch covers it.
 */
export function classifyEase({ ease, garmentValue, target, zoneRule, stretch }) {
  const [min, max] = target; // destructuring = Python tuple unpacking
  const tol = zoneRule.tolerance;

  if (ease > max + tol) return STATUS.TOO_LOOSE;
  if (ease > max) return STATUS.LOOSE;
  if (ease >= min) return STATUS.GOOD;

  const stretchGain = zoneRule.stretchable ? garmentValue * stretch : 0;
  const reachableEase = ease + stretchGain;
  const floor = zoneRule.kind === 'width'
    ? Math.max(min - tol, zoneRule.allowance ?? 0)
    : min - tol;

  return reachableEase >= floor ? STATUS.TIGHT : STATUS.TOO_TIGHT;
}

/** "low" if ease is within `margin` cm of either boundary of the target range. */
export function getConfidence(ease, target, margin) {
  const [min, max] = target;
  const distance = Math.min(Math.abs(ease - min), Math.abs(ease - max));
  return distance < margin ? 'low' : 'high';
}

/** 100 inside the range; loses points per cm outside it (tight costs more than loose). */
export function scoreZone(ease, target, scoring) {
  const [min, max] = target;
  if (ease < min) return clamp(100 - (min - ease) * scoring.tightPenaltyPerCm, 0, 100);
  if (ease > max) return clamp(100 - (ease - max) * scoring.loosePenaltyPerCm, 0, 100);
  return 100;
}

// ---------------------------------------------------------------------------
// Step 3: evaluate one size
// ---------------------------------------------------------------------------

/**
 * Full evaluation of one size.
 * Returns { size, score, zones: [ { zone, bodyValue, garmentValue, ease, target,
 *           status, confidence, score, weight } ], hasTooTight }
 */
export function evaluateSize(body, garment, sizeName, preference, rules) {
  const size = garment.sizes[sizeName];
  if (!size) throw new Error(`Garment "${garment.id}" has no size "${sizeName}"`);

  const zoneRules = getZoneRules(rules, garment.category);
  const zones = [];

  // Object.entries(obj) = dict.items()
  for (const [zoneName, zoneRule] of Object.entries(zoneRules)) {
    const target = getTargetRange(zoneRule, preference);
    const measured = computeEase(zoneRule, body, size);

    if (!measured) {
      zones.push({ zone: zoneName, target, status: STATUS.NA, weight: 0 });
      continue;
    }

    const status = classifyEase({
      ease: measured.ease,
      garmentValue: measured.garmentValue,
      target,
      zoneRule,
      stretch: garment.stretch ?? 0,
    });
    const margin = zoneRule.confidenceMargin ?? rules.confidenceMargin;

    // "...measured" spreads the object's keys in (like {**measured, ...} in Python)
    zones.push({
      zone: zoneName,
      ...measured,
      target,
      status,
      confidence: getConfidence(measured.ease, target, margin),
      score: scoreZone(measured.ease, target, rules.scoring),
      weight: zoneRule.weight,
    });
  }

  // Weighted average of zone scores (skipped zones have weight 0).
  const totalWeight = zones.reduce((sum, z) => sum + z.weight, 0);
  const weighted = zones.reduce((sum, z) => sum + (z.weight ? z.score * z.weight : 0), 0);
  let score = totalWeight ? Math.round(weighted / totalWeight) : 0;

  // A size you physically cannot wear can never be a good recommendation.
  const hasTooTight = zones.some((z) => z.status === STATUS.TOO_TIGHT);
  if (hasTooTight) score = Math.min(score, rules.scoring.tooTightCap);

  return { size: sizeName, score, zones, hasTooTight };
}

// ---------------------------------------------------------------------------
// Step 4: compare all sizes and recommend
// ---------------------------------------------------------------------------

/** Garment size names sorted S, M, L, XL ... */
export function getSizeNames(garment) {
  const index = (s) => (SIZE_ORDER.includes(s) ? SIZE_ORDER.indexOf(s) : 99);
  return Object.keys(garment.sizes).sort((a, b) => index(a) - index(b));
}

/** Hint when the garment's design fit differs from the user's preference. */
export function getDesignFitHint(garment, preference) {
  const diff = PREFERENCES.indexOf(garment.designFit) - PREFERENCES.indexOf(preference);
  if (diff > 0) return `This model runs ${garment.designFit} — consider one size down.`;
  if (diff < 0) {
    const cut = garment.designFit === 'fitted' ? 'slim' : garment.designFit;
    return `This model runs ${cut} — consider one size up.`;
  }
  return null;
}

/**
 * Evaluate every size and pick the best one for the chosen preference.
 * Ties go to the smaller size (first in size order).
 * Returns { bestSize, best, results, verdict, hint }
 */
export function recommendSize(body, garment, preference, rules) {
  // .map() = list comprehension: [evaluate(s) for s in sizes]
  const results = getSizeNames(garment).map((s) => evaluateSize(body, garment, s, preference, rules));

  let best = results[0];
  for (const r of results) {
    if (r.score > best.score) best = r;
  }

  const pref = capitalize(preference);
  const verdict = best.score >= rules.scoring.minGoodScore
    ? `${best.size} is the best size for a ${pref} fit.`
    : `No size fits well for a ${pref} fit — ${best.size} is the closest.`;

  return {
    bestSize: best.size,
    best,
    results,
    verdict,
    hint: getDesignFitHint(garment, preference),
  };
}
