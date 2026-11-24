# Virtual Try-On (FitCheck Studio): loyiha qaydlari

> Notion uchun to'liq qaydlar: loyiha qanday ishlaydi, qanday yo'llarni sinab ko'rdim, nega shu usulni tanladim, har bir fayl nima qiladi, keyingi ishlar va mentor savollariga tayyorgarlik.

---

## 1. Loyiha bir gapda

Brauzerda ishlaydigan **2D virtual try-on**. Foydalanuvchi o'z fotosini yuklaydi va **avatar** oladi. Katalogdagi ustki kiyimlarni shu avatarga "kiyadi". Ilova esa:
- **qaysi o'lcham mos kelishini** (S/M/L/XL) santimetr hisobi bilan aytadi;
- kiyimni avatar ustida **haqiqiy o'lchamida** ko'rsatadi: tor o'lcham tor, katta o'lcham katta ko'rinadi;
- zonalar bo'yicha natijani ko'rsatadi: ko'krak, bel, yelka, yeng, uzunlik.

**Asosiy g'oya:** AI har bir kiyib ko'rish uchun emas, faqat **bir marta** ishlatiladi: har foydalanuvchiga 1 ta so'rov (avatar) va har kiyimga 1 ta so'rov. Kiyib ko'rish va o'lcham almashtirish **brauzerda, bepul va bir zumda** ishlaydi.

**Mentorning talablari:** brauzerda ishlashi, kiyim odam ustida real turgandek ko'rinishi. 2D yoki 3D bo'lishi mumkin. Hisob (matematika) qismi mentor tomonidan ma'qullangan.

---

## 2. Rivojlanish tarixi: nimalarni sinab ko'rdim va nega voz kechdim

### 2.1. Birinchi versiya: 3D (Three.js)
- **Nima qilingan:** Three.js bilan 3D sahna yaratildi. Tayyor `.glb` avatar modellari (ayol va erkak) o'lchamlarga qarab cho'zildi. Kiyim esa mahsulot fotosidan "teksturali qobiq" qilib avatar ustiga kiygizildi.
- **Natija:** avatar ham, kiyim ham **real ko'rinmadi**. Avatar "o'yin qahramoni"ga o'xshardi, kiyim esa tanaga yopishtirilgan rasmdek turardi.
- **Asosiy sabab:** real 3D kiyim uchun kiyimning **3D fayli** (lekalosi, CLO3D yoki Browzwear) va mato simulyatsiyasi kerak. Oddiy do'kon fotosidan haqiqiy 3D kiyim chiqmaydi.
- **Xulosa:** Style.me, Bods kabi 3D try-on ilovalari faqat 3D fayli bor **yirik brendlar** bilan ishlaydi. Kichik do'konlar va marketplace'larda (Uzum va boshqalar) faqat foto va o'lcham jadvali bo'ladi. Shuning uchun 3D bu loyihaga mos kelmaydi.

### 2.2. Ikkinchi versiya: 2D, tekis rasmni cho'zish (warp)
- **Nima qilingan:** foydalanuvchi fotosidan avatar yaratildi, MediaPipe bilan tana nuqtalari topildi. Kiyim fotosiga admin qo'lda 10 ta nuqta (yoqa, yelka, qo'ltiq, etak, manjet) qo'ydi, keyin rasm shu nuqtalar bo'yicha avatarga cho'zildi (mesh warp).
- **Muammolar:**
  - tekis mahsulot fotosi "stolda yotgan kiyim" bo'lib qoldi, "kiyib turgandek" ko'rinmadi;
  - yenglar qo'llarga mos kelmadi, kiyim "plash" yoki "qop"ga o'xshab qoldi;
  - har bir kiyimga qo'lda nuqta qo'yish kerak edi, bu ko'p vaqt va xato.

### 2.3. AI try-on (har kiyib ko'rishda AI rasm chizadi): muhokama qilindi, voz kechildi
- **Afzalligi:** juda real natija (FASHN, Google Vertex Try-On, Gemini).
- **Muammolari:**
  - **narx:** har foydalanuvchi × kiyim × o'lcham uchun yangi rasm kerak. Masalan, 1000 foydalanuvchi × 20 kiyim × 4 o'lcham = 80 000 rasm;
  - **tezlik:** har rasm 5–20 soniya;
  - **o'lchamni ko'rsatmaydi:** AI kiyimni doim "chiroyli o'tiradigan" qilib chizadi, M va L orasidagi farq rasmda ko'rinmaydi.
- **Xulosa:** AI'ni har kiyib ko'rish uchun emas, **tayyorgarlik bosqichida bir marta** ishlatish kerak.

### 2.4. Tanlangan usul: "Template fit" (standart poza va bir martalik AI)
Bu yo'lga bosqichma-bosqich keldim:
1. **Standart poza:** hamma avatarlar va hamma kiyimlar bir xil pozada bo'ladi (old tomon, qo'llar pastda va biroz ochiq). Shunda kiyim avatarga deyarli o'z-o'zidan mos tushadi.
2. **Kiyim AI bilan manekenga kiygiziladi (A bosqich):** Gemini kiyimni standart manekenga kiygizadi, natijada kiyim hajmi, burmalari va yorug'ligi bilan "kiyilgan" holatda chiqadi.
3. **B bosqichdan voz kechildi:** dastlab Gemini'dan "odamni o'chir" (ghost mannequin) deb so'ralgan edi. Lekin Gemini har safar yenglarni yon tomonga yoyib, kiyimni "do'kon fotosi"ga aylantirib qo'ydi. Natijada yenglar qo'llarga mos kelmadi. Shuning uchun kiyimni A rasmdan **brauzerda, AI'siz kesib olish** ("Cut garment") qilindi.
4. **Avtomatik joylashtirish:** manekenning tana nuqtalari (refPose) MediaPipe bilan topiladi va kiyim shu nuqtalar bo'yicha foydalanuvchi avatariga o'tkaziladi. Qo'lda nuqta qo'yish kerak emas.
5. **Haqiqiy o'lcham (Phase 8):** dastlab kiyim har tanaga "moslashib", hammaga chiroyli o'tirardi va o'lcham farqi ko'rinmasdi. Endi kiyim **santimetrda** chiziladi.
6. **Halol vizual (Phase 9):** tor o'lchamda yenglar kalta va kiyim tarang, keng o'lchamda yenglar uzun va kiyim keng. Juda kichik o'lchamda kiyim cho'zilmaydi, o'rniga "This size is too small" xabari chiqadi.

**Nega aynan shu usul:**
- har qanday do'kon **fotosi va o'lcham jadvali** yetarli, 3D fayl kerak emas;
- AI faqat bir marta ishlaydi, shuning uchun **arzon**;
- avatar foydalanuvchining **o'z fotosi** asosida, shuning uchun 3D avatardan realroq;
- o'lcham farqi rasmda ham, raqamda ham **ko'rinadi**.

---

## 3. Ilova qanday ishlaydi (yakuniy oqim)

### 3.1. Admin kiyim qo'shadi (`admin.html`), har kiyimga bir marta
1. **Gemini Pro'da A bosqich:** mahsulot fotosi va standart maneken avatar yuklanadi, kiyim manekenga kiygiziladi. Promptda kiyimning "pasporti" yoziladi (rang, yoqa, zamok, cho'ntaklar va h.k.), aks holda AI detallarni o'zgartiradi. 3–4 variant yaratilib, eng o'xshashi tanlanadi.
2. **Reference yuklash:** A rasm "Worn reference image" ga yuklanadi. MediaPipe manekenning yelka, tirsak, bilak va son nuqtalarini topadi.
3. **Cut garment:** kod fon, bosh, teri, oq futbolka va leggings'ni olib tashlab, faqat kiyimni qoldiradi. Sozlamalar:
   - *Mannequin legs:* Black (oddiy) yoki Green (to'q rangli kiyimlar uchun yashil leggingsli maneken);
   - *Neckline:* Closed collar yoki Open V (kardigan);
   - *Garment is white / very light:* och rangli kiyimlar uchun (aks holda kiyim futbolka deb o'chirib yuboriladi).
4. **Tozalash vositalari:** Magic Eraser (bir xil rangli hududni o'chiradi), 🧽 Brush Eraser (cho'tka bilan o'chirish), 🖌️ Restore Brush (kesilib ketgan joyni asl rasmdan tiklash). Keyin **Use Cleaned Image** bosiladi.
5. **Ma'lumotlar:** Category, Type, Gender, **Design Fit** (Fitted/Regular/Relaxed/Oversized), Sleeve type, **Length style** (Regular / Long coat), Stretch, **AI image looks like size**, **Mannequin torso (cm)** (standart ayol manekeni uchun 46).
6. **O'lcham jadvali:** S/M/L/XL uchun chest, waist, hem (aylana, ya'ni yoyilgan o'lchov × 2), shoulder, sleeve, length (sm). Official (haqiqiy) yoki Estimated (taxminiy).
7. **Save:** kiyim brauzerning IndexedDB xotirasiga saqlanadi.

### 3.2. Foydalanuvchi avatar yaratadi (`dressing.html`), har foydalanuvchiga bir marta
1. To'liq bo'yli foto yuklanadi. `photoCheck.js` sifatni tekshiradi (bitta odam, butun tana).
2. **Gemini (1 ta so'rov):** foto standart avatarga aylantiriladi: oq futbolka, qora leggings, yalangoyoq, qo'llar biroz ochiq, soch yig'ilgan, kulrang fon, 3:4. Tana kengligi saqlanadi, odam ozdirilmaydi. Prompt `js/core/avatarGen.js` da.
3. `geminiValidate.js` natijani tekshiradi (fon, tana nisbatlari asl fotoga mosmi).
4. **MediaPipe** tana nuqtalari (33 ta landmark) va odam maskasini topadi, bo'y piksellarda o'lchanadi.
5. **O'lchamlar:** foydalanuvchi bo'yini kiritadi, qolgan o'lchamlar fotodan **taxmin** qilinadi. Foydalanuvchi tekshirib, "I checked these measurements" belgisini qo'ymaguncha saqlab bo'lmaydi.

### 3.3. Kiyinish xonasi: har bosishda, AI'siz
1. **fitEngine** tana va kiyim o'lchamlarini solishtiradi: har zona uchun ease (farq, sm), holat (tooTight/tight/good/loose/tooLoose) va ball, keyin eng mos o'lcham (BEST).
2. **Joylashtirish:** maneken nuqtalari foydalanuvchi nuqtalariga moslanadi, kiyim **haqiqiy santimetr masshtabida** chiziladi. Yenglar qo'l burchagiga buriladi.
3. **O'lcham farqi:** S/M/L/XL rasmdagi o'lchamga ("AI image looks like size") nisbatan torayadi yoki kengayadi, yenglar va uzunlik o'zgaradi. Biroz bo'rttiriladi, chegarasi bor.
4. **Real ko'rinish (compositing):** kiyim atrofidagi futbolka va qo'llar fon bilan almashtiriladi (clean plate), kiyimdagi teshiklar to'ldiriladi, chetlar tozalanadi va yumshatiladi, kiyim tagiga soya qo'shiladi, bosh kiyim ustidan qayta chiziladi.
5. **Natija:**
   - tavsiya yorlig'i: Great fit, Good fit, Slightly tight, Too small, Slightly loose, Too big;
   - oddiy tilda tavsiya, kiyimning dizayn uslubiga qarab ("Designed as an oversized fit. M fits you well…");
   - **Fit labels:** avatar ustida "Chest · Just right" kabi yozuvlar;
   - **Fit map:** kiyim ustida rangli xarita (qizil tor, yashil yaxshi, ko'k keng);
   - o'lcham tugmalari baho rangida;
   - juda kichik o'lchamda kiyim chizilmaydi, xabar chiqadi.

---

## 4. Papka va fayllar

```
virtual-try-on/
├── index.html            → dressing.html ga yo'naltiradi (kirish sahifasi)
├── dressing.html         → asosiy ilova: avatar yaratish + kiyinish xonasi
├── admin.html            → admin: kiyim qo'shish (kesish, o'lchamlar, saqlash)
├── README.md             → loyiha haqida qisqa ma'lumot
├── .gitignore            → repoga tushmaydigan fayllar (API kaliti va h.k.)
├── css/
│   ├── base.css          → ranglar, shriftlar, tugmalar (umumiy dizayn)
│   ├── pages.css         → sahifa tuzilishi (umumiy layout)
│   ├── dressing.css      → kiyinish xonasi dizayni (fit map, yorliqlar, tugmalar)
│   └── admin.css         → admin sahifa dizayni
├── js/
│   ├── pages/
│   │   ├── dressing.js   → kiyinish xonasining butun mantig'i (eng katta fayl)
│   │   └── admin.js      → admin sahifa mantig'i
│   ├── core/
│   │   ├── fitEngine.js     → o'lcham hisobi (ease, holat, ball, eng mos o'lcham)
│   │   ├── avatarGen.js     → Gemini API: avatar yaratish, prompt
│   │   ├── geminiValidate.js→ Gemini natijasini tekshirish
│   │   ├── photoCheck.js    → yuklangan foto sifatini tekshirish
│   │   ├── garmentImage.js  → fonni olib tashlash, Magic Eraser
│   │   ├── garmentStore.js  → kiyimlarni IndexedDB'ga saqlash/o'qish
│   │   ├── storage.js       → tana o'lchamlari (maydonlar, tekshiruv, localStorage)
│   │   └── data.js          → JSON fayllarni yuklash
│   ├── ui/
│   │   └── catalogPanel.js  → katalog uchun yordamchi funksiyalar
│   ├── local-config.js         → Gemini API kaliti (repoga TUSHMAYDI, .gitignore'da)
│   └── local-config.example.js → kalit faylining namunasi
├── data/
│   ├── fitRules.json     → o'lcham qoidalari (zonalar, maqsadli ease, jarimalar)
│   ├── garments.json     → standart katalog kiyimlari
│   └── defaultCharts.json→ admin uchun tayyor o'lcham shablonlari
├── lib/mediapipe/        → MediaPipe kutubxonasi va poza modeli (lokal, internetsiz)
├── assets/garments/      → standart katalog kiyim rasmlari
├── docs/                 → shu qaydlar
└── tests/
    ├── fitEngine.cases.js   → fitEngine uchun 32 ta test
    ├── fitEngine.test.html  → testlarni brauzerda ishga tushirish
    ├── photoCheck.test.html → foto tekshiruvi testi
    ├── tryon-grid.html      → vizual test panjarasi (barcha avatar × barcha kiyim)
    └── fixtures/            → test avatarlari (7 xil tana) va ro'yxati (avatars.json)
```

**Ma'lumot qayerda saqlanadi:**
- **IndexedDB `vto-garments`:** admin qo'shgan kiyimlar (rasm, o'lchamlar, refPose).
- **IndexedDB `FitCheckDressingDB`:** foydalanuvchi avatari va tana nuqtalari.
- **localStorage `fitcheck.body.v1`:** tana o'lchamlari.
- Hammasi **faqat shu brauzerda** saqlanadi, server yo'q.

---

## 5. Asosiy funksiyalar (nima qiladi)

### `js/core/fitEngine.js`: o'lcham hisobi
- `computeEase`: kiyim − tana (sm). Masalan, ko'krak: 113 − 87 = +26 sm.
- `getTargetRange`: uslub (fitted/regular/relaxed/oversized) bo'yicha maqsadli ease oralig'i, ustki kiyimga qatlam uchun qo'shimcha (allowance).
- `classifyEase`: tooTight / tight / good / loose / tooLoose. Stretch (cho'zilish) hisobga olinadi.
- `scoreZone`, `evaluateSize`: zonalarning og'irlikli o'rtacha bali. Eng yomon zona umumiy ballni cheklaydi (`min(o'rtacha, eng yomon + 20)`).
- `recommendSize`: barcha o'lchamlarni baholab, eng mosini tanlaydi.
- Maxsus holatlar: qisqa yengli kiyimda yeng baholanmaydi; uzun paltoda (lengthStyle = long) uzunlik baholanmaydi.

### `js/pages/dressing.js`: kiyinish xonasi
- **Avatar:** `processAndStoreAvatar` (MediaPipe, masshtab, siluet), `extractBodyOutline` (ko'krak, bel, son kengligi), `estimateMeasurementsFromPhoto` (fotodan o'lcham taxmini).
- **Joylashtirish:** `computeRefPoseTemplateFitData` (maneken → foydalanuvchi, santimetr masshtabi, yeng burish va uzunligi), `computeVisualEase` (biroz bo'rttirish), `drawTexturedTriangle` (rasmni to'r bo'yicha cho'zib chizish).
- **Compositing:** `getOrBuildTemplateCompositedLayers` (kiyim qatlamini yasash va keshlash), `cleanTeeAroundGarment` (futbolkani fon bilan almashtirish), `fillGarmentHoles`, `removeTeeLeftovers`, `removeGarmentIslands`, `defringeGarment` (chetdagi oq hoshiya), `applyTemplateEdgeSoftening`, `applyTemplateInnerShading`, `applyTemplateLightMatchingAndGrain`, `drawTemplateStrainFolds` (taranglik burmalari), `applyTemplateDrapeShadows`, `drawTemplateLayeredCompositing` (bo'yin va qo'l qatlamlari), `getOrBuildAvatarSkinMask` (teri maskasi).
- **Natija:** `getFitVerdictAndRecommendation` (yorliq va tavsiya matni), `getOrBuildFitMapCanvas` (fit map), `drawTemplateFitLabels` ("Just right" yozuvlari), `getTooSmallInfo` va `drawTooSmallBanner` (juda kichik o'lcham xabari), `updateSizePills`, `updateFitResultUI`.
- **Test:** `runGridMode` (`?grid=1`: panjara uchun rasm chizadi, hech narsa saqlamaydi).

### `js/pages/admin.js`: admin
- `handleRefImageSelected` (MediaPipe bilan maneken nuqtalari), `cutGarmentFromWornImage` va `handleCutGarmentFromWorn` (kiyimni kesish), `detectCollarFrontPoint` (yoqa nuqtasi), `validateSizeChart`, `handleSaveGarment`, `loadGarmentIntoForm`, cho'tka va Magic Eraser handler'lari.

---

## 6. Ishlatilgan texnologiya va vositalar

| Vosita | Nima uchun |
|---|---|
| **HTML / CSS / JavaScript (ES modules)** | Ilovaning o'zi. Build bosqichi yo'q, server talab qilinmaydi |
| **Canvas 2D API** | Kiyimni chizish, cho'zish (mesh warp), maskalar, soyalar, piksel bilan ishlash |
| **MediaPipe Tasks Vision: PoseLandmarker** | 33 ta tana nuqtasi va odam maskasi (segmentatsiya). Lokal fayl, brauzerda ishlaydi |
| **Google Gemini API** (`gemini-3.1-flash-lite-image`) | Ilova ichida avatar yaratish (har foydalanuvchiga 1 marta) |
| **Gemini ilovasi (Pro rejim)** | Kiyimni manekenga kiygizish (A bosqich), test avatarlarini yaratish |
| **IndexedDB** | Kiyimlar va avatarni brauzerda saqlash |
| **localStorage** | Tana o'lchamlari |
| **Node.js** | fitEngine testlarini va sintaksis tekshiruvini ishga tushirish |
| **Python `http.server`** | Lokal server (`localhost:8000`) |
| **Chrome DevTools** | Konsol, keshni o'chirish (Network → Disable cache) |
| **Antigravity (AI agent)** | Katta bosqichlarni (Phase 3–10) kodlash |
| **Claude Code + Claude in Chrome** | Kod ko'rib chiqish, xatolarni brauzerda topib tuzatish, vizual panjara orqali tekshirish |
| **Three.js** | *(1-versiyada, 3D. Endi o'chirildi)* |

---

## 7. Sinov (testlar)

- **fitEngine: 32 ta avtomatik test** (`tests/fitEngine.cases.js`). O'lcham hisobi to'g'riligini tekshiradi: tor/keng holatlar, uslublar, stretch, qisqa yeng, uzun palto va h.k.
- **Vizual test panjarasi** (`tests/tryon-grid.html`): 7 xil tana (maneken, to'la ayol, past bo'yli, baland, nok shaklli, o'rtacha erkak, to'la erkak) × barcha kiyimlar bitta jadvalda. Har o'zgarishdan keyin hamma holat bir qarashda tekshiriladi. Shu panjara bir necha jiddiy xatoni ushlab qoldi ("qanot" yenglar, ikki baravar kenglik, brauzerda umuman ishlamaydigan kod).
- **Real sinov:** o'zimning avatarim, lentada o'lchangan o'lchamlarim va o'zimning qishki kurtkam (o'lchamlari lentada o'lchangan, yorlig'ida M). Ilova **M** ni tavsiya qildi va rasmda ham kurtka menda qanday tursa, shunday oversized turdi.
- **Avatar prompti sinovi:** 4 xil foto (oynadagi selfi, ko'cha foni, chalishtirilgan qo'llar, to'la tana). Pro rejim ishonchliroq. Oddiy rejim tana kengligini saqlash qatori qo'shilgandan keyin to'g'ri ishladi.

---

## 8. Narx (taxminiy, ulashdan oldin rasmiy sahifadan tekshirish kerak)

- **Avatar:** foydalanuvchiga 1 ta rasm so'rovi, ~$0.02–0.04.
- **Kiyim:** har kiyimga 1–4 ta so'rov (Pro, bir nechta variant), bir martalik.
- **Kiyib ko'rish va o'lcham almashtirish:** $0.
- **Taqqoslash:** har kiyib ko'rishda AI ishlatilsa, 1000 foydalanuvchi uchun ~80 000 rasm (yuzlab–minglab dollar) ketadi. Bizda ~1000–2000 rasm.
- **Hosting:** statik sayt, bepul (Netlify, Vercel, GitHub Pages).

---

## 9. Cheklovlar (halol)

- 2D usul **to'liq fotorealizm** bermaydi: burmalar foydalanuvchi tanasiga qarab qayta hisoblanmaydi.
- Natija Gemini avatari **standart pozada** chiqishiga bog'liq. Xom internet fotolarda sifat pastroq.
- Gemini ba'zan kiyim detallarini o'zgartiradi, shuning uchun admin natijani tekshirishi kerak.
- Qo'llar ko'pincha tanaga yaqin chiqadi, kod buni hisobga oladi.
- Katalogdagi demo kiyimlarning o'lcham jadvallari **taxminiy**. Faqat qishki kurtkaniki haqiqiy.
- Hozircha faqat **ayollar ustki kiyimi** (jacket, palto, kardigan, xudi). Erkaklar manekeni, shim va yubkalar yo'q.
- Ma'lumotlar faqat bitta brauzerda saqlanadi, server yo'q.
- **Gemini API kaliti brauzerda** turibdi. Bu faqat demo uchun mos, ommaga chiqarishdan oldin serverga ko'chirilishi shart.
- Foydalanuvchi fotosi Google'ga yuboriladi. Rozilik va o'chirish imkoniyati kerak.

---

## 10. Keyingi ishlar (reja)

**1-navbat (ishga tushirish uchun majburiy):**
1. Server (masalan, Supabase yoki Firebase): kiyimlar katalogi umumiy bo'lsin, faqat admin brauzerida emas.
2. **API kalitini serverga ko'chirish** (proxy), so'rovlar chegarasi va byudjet ogohlantirishi.
3. Maxfiylik: rozilik oynasi, "ma'lumotlarimni o'chirish" tugmasi.

**2-navbat (sifat va qamrov):**
4. Erkaklar manekeni va erkak kiyimlari.
5. Admin'da "Generate with AI" tugmasi: A bosqich va kesishni avtomatlashtirish. Admin faqat tasdiqlaydi.
6. "AI image looks like size" ni avtomatik aniqlash (maneken o'lchamlari va fitEngine).
7. Avatarni avtomatik tekshirish: tana kengligi ozdirilgan bo'lsa, Pro bilan qayta yaratish.
8. Bir nechta kiyimni birga kiyish (kardigan ustidan palto).
9. Telefon uchun interfeys.

**3-navbat (kengaytirish):**
10. Shim va yubkalar (pastki tana).
11. Do'konlar uchun vidjet, Shopify yoki marketplace bilan integratsiya (mahsulot fotosi va jadval avtomatik olinadi).
12. Qaytarishlar statistikasi bilan natijani o'lchash (pilot: 1 ta sotuvchi, 100–500 mahsulot).

---

## 11. Mentor savollariga tayyorgarlik

**Nega 3D emas?**
3D'ni sinab ko'rdim, real chiqmadi. Real 3D kiyim uchun brendning 3D fayli (lekalosi) kerak, u faqat yirik brendlarda bo'ladi. Mening usulim har qanday do'kondagi oddiy foto va o'lcham jadvali bilan ishlaydi.

**Nega har kiyib ko'rishda AI ishlatilmaydi?**
Qimmat va sekin, bundan tashqari o'lchamni ko'rsatmaydi (AI kiyimni doim chiroyli qilib chizadi). Bizda AI faqat tayyorgarlik bosqichida, bir marta ishlaydi.

**O'lcham qanday hisoblanadi?**
fitEngine har zona uchun "kiyim − tana" (ease) ni sm'da hisoblaydi va uni kiyim uslubiga (fitted/regular/relaxed/oversized) qarab maqsadli oraliq bilan solishtiradi. Har zona baholanadi, og'irlikli ball chiqadi, eng yomon zona umumiy ballni cheklaydi. 32 ta test bilan tekshirilgan.

**Rasmda o'lcham farqi qanday ko'rsatiladi?**
Kiyim haqiqiy santimetr masshtabida chiziladi. Tanlangan o'lcham rasmdagi o'lchamga nisbatan torayadi yoki kengayadi, yenglar va uzunlik ease bo'yicha o'zgaradi (biroz bo'rttirib). Juda kichik o'lchamda kiyim chizilmaydi, xabar chiqadi.

**Avatar o'lchamlari qayerdan olinadi?**
Bo'yni foydalanuvchi kiritadi, qolganlari fotodan (MediaPipe maskasi va nuqtalari) taxmin qilinadi. Foydalanuvchi ularni tasdiqlashi yoki lentada o'lchab tuzatishi shart.

**Qanchalik aniq?**
O'z kurtkamda sinadim: ilova men kiyadigan o'lchamni (M) topdi. 7 xil tana bo'yicha vizual panjarada natijalar mantiqiy chiqdi. Demo kiyimlarning jadvallari taxminiy, haqiqiy do'kon jadvali bilan aniqlik oshadi.

**Qancha turadi?**
Foydalanuvchiga ~2–4 sent (bir marta), kiyimga bir necha sent (bir marta), kiyib ko'rish bepul.

**Yangi kiyim qo'shish qancha vaqt oladi?**
Hozir ~5 daqiqa: Gemini'da 1 so'rov, kesish, o'lcham jadvali. Keyingi qadamda avtomatlashtiriladi.

**Xavfsizlik va maxfiylik?**
Hozir demo, API kaliti brauzerda. Ommaga chiqarishdan oldin kalit serverga ko'chiriladi, foydalanuvchidan rozilik olinadi va ma'lumotlarni o'chirish imkoniyati qo'shiladi.

**Qanday kiyimlar ishlaydi?**
Ayollar ustki kiyimi: jacket, palto, kardigan, xudi. Ochiq va yopiq yoqa, uzun palto. Erkaklar va pastki kiyimlar keyingi bosqichda.

**Raqobatchilardan farqi?**
True Fit va Fit Analytics faqat o'lchamni aytadi, rasm yo'q. 3D try-on'lar 3D fayl talab qiladi. AI try-on'lar qimmat va o'lchamni ko'rsatmaydi. Bizda **o'lcham hisobi va vizual birga**, arzon, oddiy foto bilan.

**Qanday biznes bo'lishi mumkin?**
Do'konlar uchun vidjet. Qiymati: o'lcham sababli qaytarishlar kamayadi, xaridor ishonchi oshadi. Model: oylik obuna yoki foydalanishga qarab to'lov. Pilot: bitta sotuvchi, 300 mahsulot, AI xarajati ~$50.

---

## 12. Tozalangan fayllar (eski 3D versiya, o'chirildi)

Endi ishlatilmaydigan 3D versiya fayllari o'chirildi (git tarixida qolgan):
`studio.html`, `js/pages/studio.js`, `js/pages/avatar.js`, `js/core/avatar3d.js`, `viewer3d.js`, `garmentRenderer.js`, `mannequin.js`, `materials.js`, `js/ui/avatarStage.js`, `sizePanel.js`, `resultsPanel.js`, `tests/avatar3d.test.html`, `tests/garment3d.test.html`, `lib/three/` (Three.js), `assets/avatars/` (.glb 3D modellar, ~103 MB), `data/avatars.json`, `tools/prepare_garment.py`. `index.html` qisqa yo'naltiruvchi sahifaga aylantirildi.
