// data.js — load local JSON files (garments.json, fitRules.json).
// Only local files from our own folder are fetched — no external requests.

// import.meta.url = the URL of THIS file (like Python's __file__).
// Building paths from it means it works from any page (index, studio, tests/).
const DATA_DIR = new URL('../../data/', import.meta.url);

// "async function" + "await" work like Python's asyncio:
// fetch() is like requests.get(), but it does not block the page.
async function loadJson(fileName) {
  const response = await fetch(new URL(fileName, DATA_DIR));
  if (!response.ok) {
    throw new Error(`Could not load ${fileName} (HTTP ${response.status})`);
  }
  return response.json(); // parse JSON text -> JS object (= json.loads)
}

/** Returns the list (array) of all garments. */
export async function loadGarments() {
  const data = await loadJson('garments.json');
  return data.garments;
}

/** Returns one garment by id, or null if not found. */
export async function loadGarmentById(id) {
  const garments = await loadGarments();
  // .find() = next((g for g in garments if g.id == id), None)
  return garments.find((g) => g.id === id) ?? null;
}

/** Returns the whole fitRules object. */
export async function loadFitRules() {
  return loadJson('fitRules.json');
}
