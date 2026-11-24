/**
 * garmentStore.js - IndexedDB storage for custom garments
 * Database: "vto-garments", Object Store: "garments", Key: "id"
 *
 * Keeps user-added garments persistently in the browser without requiring a backend.
 */

const DB_NAME = 'vto-garments';
const DB_VERSION = 1;
const STORE_NAME = 'garments';

/**
 * Open (or initialize) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * List all custom garments from IndexedDB.
 * Each item has garment metadata and an attached object URL for its image.
 * @returns {Promise<Array<Object>>}
 */
export async function listCustomGarments() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = request.result || [];
      const garments = records.map((record) => {
        const item = { ...record };
        if (record.imageBlob) {
          item.image = URL.createObjectURL(record.imageBlob);
          item.isCustom = true;
        }
        return item;
      });
      resolve(garments);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieve a single custom garment record by ID.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getCustomGarment(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save or update a custom garment.
 * @param {Object} garment - Garment metadata (id, name, category, etc.)
 * @param {Blob} [imageBlob] - Garment image blob (PNG/WebP)
 * @returns {Promise<void>}
 */
export async function saveCustomGarment(garment, imageBlob) {
  if (!garment || !garment.id) {
    throw new Error('Garment must have an id.');
  }

  const db = await openDB();

  // If no new imageBlob passed, retain existing blob if record exists
  let blobToSave = imageBlob;
  if (!blobToSave) {
    const existing = await getCustomGarment(garment.id);
    if (existing && existing.imageBlob) {
      blobToSave = existing.imageBlob;
    }
  }

  const record = {
    ...garment,
    imageBlob: blobToSave,
    updatedAt: new Date().toISOString()
  };

  // Remove temporary object URL property from database record
  if (record.image && record.image.startsWith('blob:')) {
    delete record.image;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a custom garment by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteCustomGarment(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get an Object URL for a custom garment's image blob.
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function getCustomGarmentImageUrl(id) {
  const record = await getCustomGarment(id);
  if (record && record.imageBlob) {
    return URL.createObjectURL(record.imageBlob);
  }
  return null;
}
