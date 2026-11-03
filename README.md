# FitCheck — browser-only virtual try-on

Create an avatar from your real body measurements, then try on
jackets from a catalog. The avatar is a realistic 3D person reshaped to your
measurements; each garment is built from its **size chart** and dressed with its
**product photo**, so you can see — and the app calculates — whether a size fits.

Everything runs in the browser: no backend, no build step, no npm, no requests at
runtime except Google Fonts.

## Design System

The visual identity is modeled after a **Tailor's Atelier / Pattern Drawing**, moving away from generic AI aesthetics towards professional tailoring tools.

### Design Tokens (`css/base.css`)
- **Palette**:
  - `--paper`: `#F2F4F1` (cool off-white background)
  - `--paper-2`: `#E6EAE5` (surfaces / cards)
  - `--ink`: `#14213D` (deep navy-black for primary text and elements)
  - `--ink-soft`: `#4A5670` (muted labels and descriptions)
  - `--line`: `#C9D0CB` (1px hairline borders)
  - `--chalk`: `#FF5A36` (tailor's-chalk coral — the ONE accent for primary actions and focus)
- **Semantic Fit Status Colors**:
  - Too Tight: `#D1344B` | Tight: `#E08A1E` | Good: `#2E8B57` | Loose: `#2F6FDE` | Too Loose: `#6B4FC9`

### Typography
- **Headings & Verdict**: `"Fraunces"` (serif display) with fallback `serif`.
- **Body Text**: `"IBM Plex Sans"` with fallback `sans-serif`.
- **Numbers, CM values, and Tables**: `"IBM Plex Mono"` (tabular numbers) with fallback `monospace`.

### Where to change them
- All tokens, colors, and typography variables are centralized in `css/base.css`. Changing a variable there updates the entire application instantly, including dark mode variants under `@media (prefers-color-scheme: dark)`.

## Run

1. Open the repo folder in VS Code.
2. Right-click `index.html` → **Open with Live Server**
   (or run `python3 -m http.server 8000` and open http://localhost:8000).

ES modules and the 3D model files do not load from `file://`, so a local server is required.

| Page | What it does |
|---|---|
| `index.html` | Choose Female / Male, enter measurements (sliders + validation), live 3D preview, save to localStorage |
| `studio.html` | Catalog → pick a jacket → it is put on your avatar in the recommended size; change size / fit preference; fit table + fit map. State is kept in the URL: `studio.html?id=…&size=…&fit=…` |
| `tests/fitEngine.test.html` | 19 unit tests of the fit engine |
| `tests/avatar3d.test.html` | Reshapes the 3D avatars to test bodies and re-measures them (circumference within 2 %) |
| `tests/garment3d.test.html` | Every jacket in every size; checks the 3D chest circumference and length against the size chart |

## How it works

### 1. Fit engine (`js/core/fitEngine.js`, pure functions)

For every zone: **ease = garment − body** (cm).

| Zone | Garment | Body |
|---|---|---|
| chest, waist | circumference | circumference |
| shoulder | seam to seam | shoulder width |
| sleeve | sleeve + (garment shoulder − body shoulder) / 2 | arm length |
| length | shoulder point → hem | shoulder point → hip line |

* **Target range** = `fitRules.json` range for the fit preference (Fitted / Regular / Relaxed /
  Oversized) **+ outerwear layer allowance** (room for the T-shirt underneath). Sleeve and length
  use one range for every preference (`"any"`).
* **Status**: above max + tolerance → *tooLoose*; above max → *loose*; inside → *good*; below min
  but wearable → *tight*; otherwise *tooTight*. "Wearable" uses stretch: the garment can grow to
  `garment × (1 + stretch)`, and for width zones it must still leave the layer allowance — so a
  negative ease is only OK if stretch covers it.
* **Confidence** is *low* when the ease is within 2 cm (shoulders: 1 cm) of a range boundary.
* **Score 0–100** per size: weighted zone scores (−12 points per cm too tight, −6 per cm too
  loose); any *tooTight* zone caps the size at 30. The best score is recommended.
* **designFit hint**: an oversized model with a Regular preference → "This model runs oversized —
  consider one size down" (and "runs slim — consider one size up" the other way).

### 2. 3D avatar (`js/core/avatar3d.js`)

The avatars (`assets/avatars/*.glb`) were made in **Blender + MPFB2 (MakeHuman, CC0)** — no photos
of real people. To match your measurements every vertex is moved (no animation needed):

1. The base model is **measured like a tailor would**: circumference = convex hull of a horizontal
   slice (= what a tape measure reads), found at the chest / waist / hip.
2. Each slice is scaled so its circumference becomes yours; the body is stretched per segment
   (legs / torso / head) to your height and torso length; arms are lengthened along their own axis.
3. Clothes (T-shirt, trousers, shoes) are skinned to the same skeleton, so they follow.

Lengths that can't be measured on a mesh (bone joints sit inside the body) are calibrated with
average adult proportions (`AVERAGE_RATIOS`). `tests/avatar3d.test.html` re-measures the result.

### 3. Garments (`js/core/garmentRenderer.js`)

**Shape from the size chart** (no 3D modelling per item):

* Torso: for ~50 heights between collar and hem, the real body slice is grown outward by
  `max(6 mm, ease / 2π)` so its circumference equals the garment's (chest / waist / hem from the
  chart, interpolated). A size smaller than the body is drawn hugging it — and shown red.
* Hem = shoulder point − length. Sleeves follow the bent arm (shoulder → elbow → wrist) with the
  effective sleeve length from the fit engine's formula.

**Look from one product photo**: the photo is cut out and 13 anchor points are noted (collar,
shoulders, armpits, hem corners, cuffs, a plain patch for the back). The front of the shell is
mapped between those anchors, the back uses the plain patch. Items without a photo are plain
coloured shells. **Fit map** colours zones: red = tight/short, green = good, amber = borderline,
blue = loose/long.

### Circumference ↔ front width (2D fallback only)

If WebGL or the GLB files are unavailable, pages fall back to the 2D SVG mannequin
(`js/core/mannequin.js`), which converts circumference to front width with one constant:
`CIRC_TO_FRONT_WIDTH = 0.34`.

## Data

* `data/garments.json` — catalog. Sizes in **cm, FULL circumferences**: if a shop gives a
  half-chest / flat measurement, **multiply by 2**. `length` = shoulder point → hem,
  `sleeve` = shoulder seam → cuff, `stretch` = fraction (0.15 = 15 %), `gender` = female / male /
  unisex. The two real jackets use **estimated sample size charts**; the `SAMPLE …` items have no photo.
* `data/fitRules.json` — target ease ranges per category → zone → preference, allowances, scoring.
* `data/avatars.json` — which node of each GLB to show and which mesh is the skin.
* Body (localStorage `fitcheck.body.v1`): `{ gender, measurements }`.

## Adding your own garment

1. Take a front photo on a plain light background.
2. `python tools/prepare_garment.py photo.jpg assets/garments/my-jacket.png`
   (needs `pip install pillow`; writes `my-jacket.png` + `my-jacket-texture.jpg`).
3. Open the PNG in any image viewer, note the 13 anchor pixels (see the existing entries).
4. Add an entry to `data/garments.json` with the shop's size chart (full circumferences!).
5. Check it in `tests/garment3d.test.html?id=my-jacket`.

## Structure

```
index.html, studio.html
css/          base.css (design tokens), pages.css (layouts)
data/         garments.json, fitRules.json, avatars.json
assets/       avatars/*.glb (MakeHuman, CC0), garments/*.png|jpg
lib/three/    Three.js r170 (MIT) — saved locally, loaded with an import map
js/core/      storage, data, fitEngine, avatar3d, viewer3d, garmentRenderer, mannequin (2D fallback)
js/ui/        avatarStage, catalogPanel, sizePanel, resultsPanel
js/pages/     avatar.js, studio.js
tests/        fitEngine / avatar3d / garment3d test pages
tools/        prepare_garment.py (one-time photo preparation)
```

## Limitations

* Garments are smooth shells: no cloth simulation, wrinkles come from the photo.
* One front photo: the back and sides of a garment are a plain patch of the same material.
* The fit engine compares numbers; real fit also depends on fabric, cut and posture.
* The female GLB still contains MakeHuman helper geometry in a hidden mesh (≈65 MB);
  re-exporting with *Export copy* would make it lighter.
* Product photos in `assets/garments/` are for this private demo only.

## Roadmap

* Tops and bottoms (T-shirts, trousers: same shell idea on the legs).
* Several photos per garment (front + back) for 360° looks.
* Real garment 3D models (glTF) for hero items; cloth simulation.
* Camera body measurement with MediaPipe Pose.
