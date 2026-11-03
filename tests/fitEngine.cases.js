// fitEngine.cases.js — test cases for the fit engine.
// Each test is { name, run(ctx) }. run() throws an Error if something is wrong
// (like a pytest function with "assert"). ctx = { rules, garments }.
// Kept separate from the HTML so the same cases can run anywhere.

import {
  recommendSize, evaluateSize, computeEase, getTargetRange, getZoneRules, STATUS,
} from '../js/core/fitEngine.js';

// Average adult male body used by most tests (cm).
const AVG_MALE = { height: 176, chest: 98, waist: 84, hip: 98, shoulder: 45, armLength: 61, torsoLength: 56 };

// --- tiny assert helpers (like Python's assert) ---
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(condition, label) {
  if (!condition) throw new Error(label);
}

// Synthetic garment: a size M that fits AVG_MALE well in every zone,
// with overrides for the zone under test. "...x" merges objects (like {**a, **b}).
function testGarment({ stretch = 0, designFit = 'regular', size = {} } = {}) {
  return {
    id: 'test', category: 'outerwear', type: 'jacket', designFit, stretch,
    sizes: { M: { chest: 110, waist: 104, shoulder: 46, sleeve: 62.5, length: 60, hem: 96, ...size } },
  };
}
// Find one zone result by name
const zoneOf = (result, name) => result.zones.find((z) => z.zone === name);
const byId = (garments, id) => garments.find((g) => g.id === id);

export const TEST_CASES = [
  {
    name: '1. ease = garment − body',
    run({ rules }) {
      const chestRule = getZoneRules(rules, 'outerwear').chest;
      const r = computeEase(chestRule, AVG_MALE, { chest: 110 });
      assertEqual(r.ease, 12, 'chest ease');
    },
  },
  {
    name: '2. Good fit: average male in SAMPLE Bomber M (Regular) → all zones good, score 100',
    run({ rules, garments }) {
      const r = evaluateSize(AVG_MALE, byId(garments, 'sample-bomber'), 'M', 'regular', rules);
      for (const z of r.zones) assertEqual(z.status, STATUS.GOOD, `${z.zone} status`);
      assertEqual(r.score, 100, 'score');
    },
  },
  {
    name: '3. Tight: chest ease 7 cm (Regular target 10–16) → tight',
    run({ rules }) {
      const r = evaluateSize(AVG_MALE, testGarment({ size: { chest: 105 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.TIGHT, 'chest status');
    },
  },
  {
    name: '4. Too tight: chest ease −2 cm, no stretch → tooTight, score capped at 30',
    run({ rules }) {
      const r = evaluateSize(AVG_MALE, testGarment({ size: { chest: 96 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.TOO_TIGHT, 'chest status');
      assertTrue(r.hasTooTight, 'hasTooTight should be true');
      assertTrue(r.score <= 30, `score should be ≤ 30, got ${r.score}`);
    },
  },
  {
    name: '5. Stretch: same −2 cm chest with 15% stretch → only tight (wearable)',
    run({ rules }) {
      // reachable ease = −2 + 96 × 0.15 = 12.4 cm ≥ floor 4 cm
      const r = evaluateSize(AVG_MALE, testGarment({ stretch: 0.15, size: { chest: 96 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.TIGHT, 'chest status');
    },
  },
  {
    name: '6. Small stretch is not enough: −2 cm chest with 3% stretch → still tooTight',
    run({ rules }) {
      // reachable ease = −2 + 96 × 0.03 = 0.88 cm < floor 4 cm (no room for the T-shirt)
      const r = evaluateSize(AVG_MALE, testGarment({ stretch: 0.03, size: { chest: 96 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.TOO_TIGHT, 'chest status');
    },
  },
  {
    name: '7. Loose: chest ease 19 cm (Regular max 16, tolerance 6) → loose',
    run({ rules }) {
      const r = evaluateSize(AVG_MALE, testGarment({ size: { chest: 117 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.LOOSE, 'chest status');
    },
  },
  {
    name: '8. Too loose: chest ease 25 cm (> 16 + 6) → tooLoose',
    run({ rules }) {
      const r = evaluateSize(AVG_MALE, testGarment({ size: { chest: 123 } }), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'chest').status, STATUS.TOO_LOOSE, 'chest status');
    },
  },
  {
    name: '9. Borderline: ease 10.5 (0.5 cm from min 10) → good + LOW confidence; ease 13 → HIGH',
    run({ rules }) {
      const edge = zoneOf(evaluateSize(AVG_MALE, testGarment({ size: { chest: 108.5 } }), 'M', 'regular', rules), 'chest');
      assertEqual(edge.status, STATUS.GOOD, 'edge status');
      assertEqual(edge.confidence, 'low', 'edge confidence');
      const mid = zoneOf(evaluateSize(AVG_MALE, testGarment({ size: { chest: 111 } }), 'M', 'regular', rules), 'chest');
      assertEqual(mid.confidence, 'high', 'middle confidence');
    },
  },
  {
    name: '10. Oversized design + Regular preference → recommends S with "one size down" hint',
    run({ rules, garments }) {
      const rec = recommendSize(AVG_MALE, byId(garments, 'sample-oversized'), 'regular', rules);
      assertEqual(rec.bestSize, 'S', 'best size');
      assertTrue(rec.hint && rec.hint.includes('one size down'), `hint was: ${rec.hint}`);
    },
  },
  {
    name: '11. Oversized design + Oversized preference → M, score 100, no hint',
    run({ rules, garments }) {
      const rec = recommendSize(AVG_MALE, byId(garments, 'sample-oversized'), 'oversized', rules);
      assertEqual(rec.bestSize, 'M', 'best size');
      assertEqual(rec.best.score, 100, 'score');
      assertEqual(rec.hint, null, 'hint');
    },
  },
  {
    name: '12. Fitted design (denim) + Regular preference → L with "one size up" hint; Fitted → M',
    run({ rules, garments }) {
      const denim = byId(garments, 'sample-denim');
      const regular = recommendSize(AVG_MALE, denim, 'regular', rules);
      assertEqual(regular.bestSize, 'L', 'regular best size');
      assertTrue(regular.hint && regular.hint.includes('one size up'), `hint was: ${regular.hint}`);
      assertEqual(recommendSize(AVG_MALE, denim, 'fitted', rules).bestSize, 'M', 'fitted best size');
    },
  },
  {
    name: '13. "any" zones ignore preference: sleeve target is the same for Fitted and Oversized',
    run({ rules }) {
      const sleeveRule = getZoneRules(rules, 'outerwear').sleeve;
      assertEqual(
        JSON.stringify(getTargetRange(sleeveRule, 'fitted')),
        JSON.stringify(getTargetRange(sleeveRule, 'oversized')),
        'sleeve target',
      );
    },
  },
  {
    name: '14. Drop shoulder: sleeve 57 + (54 − 45) / 2 = 61.5 effective → sleeve ease 0.5',
    run({ rules }) {
      const sleeveRule = getZoneRules(rules, 'outerwear').sleeve;
      const r = computeEase(sleeveRule, AVG_MALE, { sleeve: 57, shoulder: 54 });
      assertEqual(r.ease, 0.5, 'sleeve ease');
    },
  },
  {
    name: '15. Missing measurement → zone marked n/a and ignored in score',
    run({ rules }) {
      const body = { ...AVG_MALE, waist: undefined };
      const r = evaluateSize(body, testGarment(), 'M', 'regular', rules);
      assertEqual(zoneOf(r, 'waist').status, STATUS.NA, 'waist status');
      assertEqual(r.score, 100, 'score');
    },
  },
  {
    name: '16. Pure functions: inputs are not modified',
    run({ rules, garments }) {
      const garment = byId(garments, 'sample-oversized');
      const before = JSON.stringify([AVG_MALE, garment, rules]);
      recommendSize(AVG_MALE, garment, 'regular', rules);
      assertEqual(JSON.stringify([AVG_MALE, garment, rules]), before, 'inputs unchanged');
    },
  },
  {
    name: '17. Catalog is complete: every garment has S/M/L/XL with all 6 measurements',
    run({ garments }) {
      assertTrue(garments.length >= 4, 'at least 4 garments');
      for (const g of garments) {
        for (const s of ['S', 'M', 'L', 'XL']) {
          for (const key of ['chest', 'waist', 'shoulder', 'sleeve', 'length', 'hem']) {
            assertTrue(typeof g.sizes[s]?.[key] === 'number', `${g.id} ${s}.${key} missing`);
          }
        }
      }
    },
  },
  {
    name: '18. Photo garments have all 13 anchor points (needed to place the photo on the 3D shell)',
    run({ garments }) {
      const keys = ['collarL', 'collarR', 'shoulderL', 'shoulderR', 'armpitL', 'armpitR', 'hemL', 'hemR',
        'cuffOuterL', 'cuffInnerL', 'cuffOuterR', 'cuffInnerR', 'backPatch'];
      for (const g of garments.filter((x) => x.image)) {
        for (const k of keys) assertTrue(Array.isArray(g.anchors?.[k]), `${g.id} anchor ${k} missing`);
      }
    },
  },
  {
    name: '19. Real jackets: average male -> M in the leather jacket, average female -> M in the biker jacket',
    run({ rules, garments }) {
      const AVG_FEMALE = { height: 164, chest: 90, waist: 72, hip: 98, shoulder: 39, armLength: 56, torsoLength: 52 };
      assertEqual(recommendSize(AVG_MALE, byId(garments, 'leather-jacket-men'), 'regular', rules).bestSize, 'M', 'male');
      assertEqual(recommendSize(AVG_FEMALE, byId(garments, 'biker-jacket-women'), 'regular', rules).bestSize, 'M', 'female');
    },
  },
];

/** Run all cases; returns [{ name, passed, error }]. */
export function runAll(ctx) {
  return TEST_CASES.map((t) => {
    try {
      t.run(ctx);
      return { name: t.name, passed: true };
    } catch (err) {
      return { name: t.name, passed: false, error: err.message };
    }
  });
}
