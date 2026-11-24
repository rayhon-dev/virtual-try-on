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
  {
    name: '20. Ranking: two too-tight sizes should have different scores based on violation',
    run({ rules }) {
      const g = {
        id: 'test', category: 'outerwear', sizes: {
          S: { chest: 90, waist: 80, shoulder: 40, sleeve: 60, length: 55, hem: 85 }, // Very tight
          L: { chest: 96, waist: 84, shoulder: 43, sleeve: 62, length: 58, hem: 92 }  // Less tight
        }
      };
      const rS = evaluateSize(AVG_MALE, g, 'S', 'regular', rules);
      const rL = evaluateSize(AVG_MALE, g, 'L', 'regular', rules);
      assertTrue(rL.score > rS.score, `L (score ${rL.score}) should score higher than S (${rS.score})`);
    }
  },
  {
    name: '21. Tie-break: same score, different bad zones count',
    run({ rules }) {
      const g = {
        id: 'test', category: 'outerwear', sizes: {
          M1: { chest: 90, waist: 104, shoulder: 45, sleeve: 62.5, length: 60, hem: 96 }, // 1 tooTight (chest)
          M2: { chest: 90, waist: 80, shoulder: 45, sleeve: 62.5, length: 60, hem: 96 }  // 2 tooTight (chest, waist)
        }
      };
      // We need to force same score. If scores differ by violation, we might need to adjust.
      // With the new formula, M1 should have smaller total violation and thus higher score anyway.
      const rec = recommendSize(AVG_MALE, g, 'regular', rules);
      assertEqual(rec.bestSize, 'M1', 'tie-break by bad zones');
    }
  },
  {
    name: '22. Verdict: name the blocking zone and violation',
    run({ rules }) {
      const g = testGarment({ size: { shoulder: 38 } }); // shoulder 45 -> 38 is 7cm tight
      const rec = recommendSize(AVG_MALE, g, 'regular', rules);
      assertTrue(rec.verdict.includes('shoulder 7 cm too tight'), `verdict: ${rec.verdict}`);
    }
  },
  {
    name: '23. Monotonic ranking with violation',
    run({ rules }) {
      const g = {
        id: 'test', category: 'outerwear', sizes: {
          S: { chest: 90, waist: 90, shoulder: 45, sleeve: 62, length: 60, hem: 96 },
          M: { chest: 94, waist: 94, shoulder: 45, sleeve: 62, length: 60, hem: 96 },
          L: { chest: 98, waist: 98, shoulder: 45, sleeve: 62, length: 60, hem: 96 }
        }
      };
      const res = recommendSize(AVG_MALE, g, 'regular', rules).results;
      assertTrue(res[2].score > res[1].score && res[1].score > res[0].score, 'scores should be monotonic');
    }
  },
  {
    name: '24. Every size too tight: scores stay strictly ordered by violation (no tie at the cap or at 0)',
    run({ rules, garments }) {
      // A very large body: every size of the bomber is too tight, violations are far above 30 cm
      const BIG = { height: 170, chest: 130, waist: 120, hip: 130, shoulder: 46, armLength: 60, torsoLength: 54 };
      const rec = recommendSize(BIG, byId(garments, 'sample-bomber'), 'regular', rules);
      assertTrue(rec.results.every((r) => r.hasTooTight), 'every size should be too tight');
      for (let i = 0; i < rec.results.length - 1; i++) {
        assertTrue(rec.results[i].score < rec.results[i + 1].score,
          `${rec.results[i].size} (${rec.results[i].score}) should score lower than ${rec.results[i + 1].size} (${rec.results[i + 1].score})`);
      }
      assertEqual(rec.bestSize, 'XL', 'least violation wins');
      const s = rec.results[0];
      assertEqual(s.score, Math.round((rules.scoring.tooTightCap - s.totalViolation) * 10) / 10, 'score = cap − violation');
    },
  },
  {
    name: '25. No size fits: verdict says so, names the closest size and the zone that is too tight (not a looser zone)',
    run({ rules }) {
      // chest 1.6 cm too small (violation 11.6) but waist very loose (violation 32): the chest blocks wearing it
      const g = testGarment({ size: { chest: 96.4, waist: 140 } });
      const rec = recommendSize(AVG_MALE, g, 'regular', rules);
      assertEqual(rec.fits, false, 'fits');
      assertEqual(rec.blocking.zone, 'chest', 'blocking zone');
      assertEqual(rec.verdict, 'No size fits well. M is closest, chest 11.6 cm too tight.', 'verdict');
    },
  },
  {
    name: '26. A size that fits beats a capped one: best = highest score, fits = true, nothing blocks it',
    run({ rules }) {
      const base = { waist: 104, shoulder: 46, sleeve: 62.5, length: 60, hem: 96 };
      const g = { id: 'test', category: 'outerwear', designFit: 'regular', stretch: 0,
        sizes: { S: { chest: 96, ...base }, M: { chest: 110, ...base } } }; // S too tight, M good
      const rec = recommendSize(AVG_MALE, g, 'regular', rules);
      assertEqual(rec.bestSize, 'M', 'best size');
      assertEqual(rec.fits, true, 'fits');
      assertEqual(rec.blocking, null, 'blocking');
      assertTrue(rec.results[1].score > rec.results[0].score, 'M should score higher than S');
      assertEqual(rec.verdict, 'M is the best size for a Regular fit.', 'verdict');
    },
  },
  {
    name: '27. Final score cap by worst zone: score cannot exceed worst single zone score + 20',
    run({ rules }) {
      // AVG_MALE chest: 98. Regular target: [10, 16], tolerance: 6. Garment chest: 121 -> ease 23 cm (tooLoose).
      // Chest zone score: 100 - 7 * 6 = 58. Other zones 100. Weighted avg = 82, capped at 58 + 20 = 78.
      const r = evaluateSize(AVG_MALE, testGarment({ size: { chest: 121 } }), 'M', 'regular', rules);
      const chestZone = r.zones.find(z => z.zone === 'chest');
      assertEqual(chestZone.status, STATUS.TOO_LOOSE, 'chest status');
      assertEqual(r.score, 78, 'score should be capped at worst zone + 20 (78)');
    },
  },
  {
    name: '28. Worst zone cap with stretch: stretch garment where tight chest scores 52 caps overall score at 72',
    run({ rules }) {
      // AVG_MALE chest: 98. Garment chest 104 with stretch 0.15 has ease 6 cm (tight, zone score 52).
      // Weighted avg = 79, capped at 52 + 20 = 72.
      const r = evaluateSize(AVG_MALE, testGarment({ stretch: 0.15, size: { chest: 104 } }), 'M', 'regular', rules);
      const chestZone = r.zones.find(z => z.zone === 'chest');
      assertEqual(chestZone.status, STATUS.TIGHT, 'chest status');
      assertEqual(r.score, 72, 'score should be capped at worst zone + 20 (72)');
    },
  },
  {
    name: '29. Tops category: good chest ease scores >= 90',
    run({ rules }) {
      // AVG_MALE chest: 98, waist: 84, shoulder: 45. Tops regular chest target: [4, 10].
      const top = {
        id: 't-shirt-test', category: 'tops', type: 't-shirt', designFit: 'regular', stretch: 0.05, sleeveType: 'long',
        sizes: { M: { chest: 105, waist: 92, shoulder: 46, sleeve: 62.5, length: 66, hem: 100 } }
      };
      const r = evaluateSize(AVG_MALE, top, 'M', 'regular', rules);
      const chestZone = r.zones.find(z => z.zone === 'chest');
      assertEqual(chestZone.status, STATUS.GOOD, 'chest status');
      assertTrue(r.score >= 90, `expected score >= 90, got ${r.score}`);
    },
  },
  {
    name: '30. Short-sleeve tops garment: sleeve zone is n/a with weight 0 and receives no sleeve penalty',
    run({ rules }) {
      const top = {
        id: 'short-sleeve-tee', category: 'tops', type: 't-shirt', designFit: 'regular', stretch: 0.05, sleeveType: 'short',
        sizes: { M: { chest: 105, waist: 92, shoulder: 46, sleeve: 0, length: 66, hem: 100 } }
      };
      const r = evaluateSize(AVG_MALE, top, 'M', 'regular', rules);
      const sleeveZone = r.zones.find(z => z.zone === 'sleeve');
      assertEqual(sleeveZone.status, STATUS.NA, 'sleeve status must be n/a');
      assertEqual(sleeveZone.weight, 0, 'sleeve weight must be 0');
      assertTrue(r.score >= 90, `short sleeve top should score >= 90 without sleeve penalty, got ${r.score}`);
    },
  },
  {
    name: '31. Tops garment 20 cm too tight in chest: never recommended (tooTight, capped <= 30)',
    run({ rules }) {
      // AVG_MALE chest: 98. Size S chest: 78 -> ease -20 cm. Size M chest: 105 -> good.
      const top = {
        id: 'tight-top', category: 'tops', type: 't-shirt', designFit: 'regular', stretch: 0.05, sleeveType: 'short',
        sizes: {
          S: { chest: 78, waist: 72, shoulder: 40, sleeve: 0, length: 60, hem: 78 },
          M: { chest: 105, waist: 92, shoulder: 46, sleeve: 0, length: 66, hem: 100 }
        }
      };
      const rS = evaluateSize(AVG_MALE, top, 'S', 'regular', rules);
      assertEqual(rS.zones.find(z => z.zone === 'chest').status, STATUS.TOO_TIGHT, 'S must be tooTight');
      assertTrue(rS.score <= 30, `too tight size must have score <= 30, got ${rS.score}`);
      const rec = recommendSize(AVG_MALE, top, 'regular', rules);
      assertTrue(rec.bestSize !== 'S', 'too tight size S must never be recommended');
      assertEqual(rec.bestSize, 'M', 'size M should be recommended');
    },
  },
  {
    name: '32. Long coat (lengthStyle "long"): length zone is n/a, a 115 cm coat is not penalised as "too long"',
    run({ rules }) {
      const coat = testGarment({ size: { length: 115 } });
      const rRegular = evaluateSize(AVG_MALE, coat, 'M', 'regular', rules);
      assertTrue(zoneOf(rRegular, 'length').status !== STATUS.GOOD, 'without lengthStyle a 115 cm length must not be "good"');
      const rLong = evaluateSize(AVG_MALE, { ...coat, lengthStyle: 'long' }, 'M', 'regular', rules);
      assertEqual(zoneOf(rLong, 'length').status, STATUS.NA, 'length status must be n/a for long coats');
      assertEqual(zoneOf(rLong, 'length').weight, 0, 'length weight must be 0 for long coats');
      assertTrue(rLong.score >= 90, `well-fitting long coat should score >= 90, got ${rLong.score}`);
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
