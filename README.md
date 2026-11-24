# Virtual Try-On (FitCheck Studio)

A browser-only **2D virtual try-on** for outerwear. A user uploads a full-body photo and gets a
standard-pose avatar. They try on catalog garments, and the app:

- recommends the **best size** (S/M/L/XL) from body vs. garment measurements in cm;
- draws the garment on the avatar at its **real physical size**, so a size that is too small
  *looks* too small and a size that is too big *looks* too big;
- explains the fit per zone (chest, waist, shoulders, sleeve, length) with a verdict, a plain-language
  recommendation, on-body fit labels and a colour fit map.

**Key idea:** AI is used **once per user** (avatar) and **once per garment** (catalog preparation),
never per try-on. Trying on and switching sizes run locally in the browser, instantly and for free.


---

## Run

```bash
python3 -m http.server 8000
```

Open http://localhost:8000 (redirects to `dressing.html`). ES modules and MediaPipe do not load from
`file://`, so a local server is required. While developing, keep DevTools → Network → **Disable
cache** on (or run `npx http-server -p 8000 -c-1`), otherwise the browser may keep running old JS.

### Gemini API key (avatar generation)

Copy `js/local-config.example.js` to `js/local-config.js` and put your Google AI Studio key there.
`js/local-config.js` is git-ignored. **Demo only:** the key is used from the browser; before any public
deployment it must move to a server-side proxy.

---

## How it works

### 1. Admin adds a garment (`admin.html`, once per garment)
1. In Gemini (Pro), the shop photo is put on the **standard mannequin** ("step A", worn reference).
2. The worn reference is uploaded; MediaPipe Pose finds the mannequin's joints (`refPose`).
3. **Cut garment**: the garment is cut out of the worn reference in the browser (background, head,
   skin, the mannequin's white T-shirt and leggings are removed). Options: mannequin legs
   black/green, neckline closed/open V, light garment. It keeps the mannequin's frame, so no manual
   anchors or alignment are needed.
4. Clean-up tools: Magic Eraser, Brush Eraser, Restore Brush.
5. Garment data: category, type, design fit (fitted/regular/relaxed/oversized), sleeve type,
   length style (regular / long coat), stretch, "AI image looks like size", size chart (cm).
6. Saved in the browser's IndexedDB.

### 2. User creates an avatar (`dressing.html`, once per user)
1. Photo check (`photoCheck.js`) → Gemini redraws the person in a standard pose: white T-shirt,
   black leggings, arms slightly away from the body, hair tied back, grey background, 3:4, body width
   preserved (prompt in `js/core/avatarGen.js`) → output check (`geminiValidate.js`).
2. MediaPipe Pose: 33 landmarks + person mask, height in pixels.
3. Measurements: the user enters height; the others are **estimated from the photo** and must be
   confirmed or corrected by the user.

### 3. Dressing room (every try-on, no AI)
1. **Fit engine** (`js/core/fitEngine.js`): per zone `ease = garment − body` (cm) is compared with the
   target range of the fit preference → tooTight / tight / good / loose / tooLoose → weighted score
   (the worst zone caps the score) → best size.
2. **Placement**: mannequin landmarks → user landmarks at real cm scale; sleeves rotated to the user's
   arms; sleeve length, hem and width change relative to the reference size (mild exaggeration).
3. **Compositing**: clean plate (T-shirt/arms around the garment), hole filling, defringe, edge
   softening, contact shadow, head redraw.
4. **Output**: verdict badge, recommendation relative to the garment's design fit, fit labels,
   fit map, size pills coloured by verdict. A far-too-small size is not stretched onto the body; a
   "too small" message is shown instead.

---

## Project structure

```
index.html            redirect to dressing.html
dressing.html         avatar creation + dressing room
admin.html            add garments (cut, size chart, save)
css/                  base.css (tokens), pages.css (layout), dressing.css, admin.css
js/pages/dressing.js  dressing room logic (placement, compositing, fit UI, grid mode)
js/pages/admin.js     admin logic (reference pose, cut garment, brushes, save)
js/core/fitEngine.js  size/fit calculation
js/core/avatarGen.js  Gemini avatar generation + prompt
js/core/geminiValidate.js, photoCheck.js   input/output checks
js/core/garmentImage.js   background removal, Magic Eraser
js/core/garmentStore.js   garments in IndexedDB
js/core/storage.js        body measurements (fields, validation, localStorage)
js/core/data.js           JSON loading
js/ui/catalogPanel.js     catalog helpers
data/fitRules.json        fit rules (zones, target ranges, penalties)
data/garments.json        built-in catalog
data/defaultCharts.json   size chart templates for the admin
lib/mediapipe/            MediaPipe Tasks Vision + pose model (local)
assets/garments/          built-in garment images
docs/                     project notes
tests/                    fitEngine tests, photo check test, visual try-on grid
```

Storage: garments → IndexedDB `vto-garments`; avatar → IndexedDB `FitCheckDressingDB`;
measurements → localStorage `fitcheck.body.v1`. Everything stays in the current browser.

---

## Tests

- `tests/fitEngine.test.html`: 32 fit engine cases (also runnable with Node via `runAll`).
- `tests/photoCheck.test.html`: photo validation.
- `tests/tryon-grid.html`: **visual test grid**. It renders every test avatar (7 body types in
  `tests/fixtures/avatars/`) × every garment in one table, in Best/S/M/L/XL, with optional fit map.
  It is read-only (`dressing.html?grid=1` never saves). Use it after every visual change.

---

## Why 2D "template fit" (and not 3D or per-try-on AI)

- **3D (tried first, Three.js):** looked unrealistic; real 3D garments need the brand's 3D pattern
  files, which most shops do not have.
- **2D warping of flat product photos (tried second):** looked pasted on, sleeves did not follow the
  arms, every garment needed manual anchor points.
- **AI image per try-on:** realistic but expensive and slow, and it does not show size differences.
- **Template fit (current):** works with any shop photo + size chart, AI only once per user/garment,
  realistic photo-based avatar, size differences visible in the picture and in the numbers.

## Limitations

2D does not re-simulate folds for each body; results depend on a standard-pose avatar; demo size
charts are estimated (except one real garment); women's outerwear only for now; data is per browser
(no server); the API key is client-side (demo only); user photos are sent to Google.

## Roadmap

Server catalog + API proxy + privacy controls → men's mannequin → automated garment preparation in
the admin → multiple garments at once → mobile UI → bottoms → shop widget / marketplace integration.
