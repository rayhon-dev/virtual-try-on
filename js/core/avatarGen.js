/**
 * avatarGen.js — Gemini API integration for avatar generation.
 * Redraws user photo as a catalog mannequin in white t-shirt and black leggings.
 */

export const MODEL_NAME = 'gemini-3.1-flash-lite-image'; // AI Studio'dagi nom bilan solishtiring

// Same standard as the reference mannequin the garments are made on (see tests/fixtures/avatars):
// white crew-neck T-shirt, black leggings, barefoot, hair off the neck, light-grey background, 3:4.
export const PROMPT =
  'Redraw the SAME person from the input photo as a full-length catalog photograph. ' +
  'Keep the face, hair colour, skin tone, body shape, height, width and limb lengths exactly as in the photo. ' +
  'Do not slim, reshape or retouch the body. ' +
  'The body width must stay exactly as in the photo: same shoulder width, bust, belly, waist, hip and thigh width, ' +
  'same arm thickness. If the person is plus-size, the result must be equally plus-size (this image is used for clothing sizes). ' +
  'Pose: standing straight, facing the camera, front view; arms straight down and held about 15 degrees away from the body, ' +
  'with a clear gap of background visible between each arm and the torso all the way from the armpit to the hand ' +
  '(the arms must NOT touch the body or the hips); palms facing the thighs; feet hip-width apart, barefoot. ' +
  'Clothing ONLY: a plain fitted white crew-neck short-sleeve T-shirt and plain matte black full-length leggings. ' +
  'No accessories, no jewellery, no bag, no glasses. ' +
  'Hair tied back so it does not cover the neck or shoulders. ' +
  'Plain light-grey seamless studio background, soft even front lighting, no strong shadows. ' +
  'Portrait 3:4, whole body from head to feet, centred, small margin above the head and below the feet. ' +
  'Remove any text, watermark, logo or caption from the image. ' +
  'Photorealistic.';

const RATE_LIMIT_KEY = 'fitcheck.gemini_rate_limit';
const MAX_PER_HOUR = 5;

/**
 * Strips any API key from an error message so it is NEVER logged or displayed.
 * Python analogy: re.sub(r'key=[A-Za-z0-9_-]+', 'key=***', text)
 */
export function sanitizeError(text, apiKey) {
  if (!text) return text;
  let clean = String(text);
  if (apiKey && apiKey.length > 4) {
    clean = clean.replaceAll(apiKey, '***');
  }
  // Strip any sequence resembling Google API key (AIzaSy...) or long tokens
  clean = clean.replace(/AIzaSy[A-Za-z0-9_-]{33}/g, '***');
  clean = clean.replace(/key=[A-Za-z0-9_-]{20,}/gi, 'key=***');
  clean = clean.replace(/key:\s*["']?[A-Za-z0-9_-]{20,}["']?/gi, 'key: "***"');
  return clean;
}

/**
 * Enforces rate limit of max 5 generations per hour per browser.
 * Python analogy: tracking timestamps in a sliding window deque.
 */
export function checkRateLimit() {
  try {
    const now = Date.now();
    const oneHourAgo = now - 3600 * 1000;
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    const timestamps = raw ? JSON.parse(raw).filter(t => t > oneHourAgo) : [];

    if (timestamps.length >= MAX_PER_HOUR) {
      const oldest = timestamps[0];
      const minutesLeft = Math.ceil((oldest + 3600 * 1000 - now) / 60000);
      throw new Error(`Hourly limit reached (maximum ${MAX_PER_HOUR} generations per hour). Please wait ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''} or continue with your photo directly.`);
    }
  } catch (err) {
    if (err.message && err.message.includes('Hourly limit')) throw err;
  }
}

/**
 * Records a successful generation to rate limit store.
 */
export function recordGeneration() {
  try {
    const now = Date.now();
    const oneHourAgo = now - 3600 * 1000;
    const raw = localStorage.getItem(RATE_LIMIT_KEY);
    const timestamps = raw ? JSON.parse(raw).filter(t => t > oneHourAgo) : [];
    timestamps.push(now);
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(timestamps));
  } catch (_) {}
}

/**
 * Dynamically loads API key from js/local-config.js.
 * Returns null if file not found or placeholder key.
 */
export async function loadGeminiApiKey() {
  try {
    const cfg = await import('../local-config.js');
    if (cfg && cfg.GEMINI_API_KEY && cfg.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE') {
      return cfg.GEMINI_API_KEY;
    }
  } catch (_) {}
  return null;
}

/**
 * Generates an avatar using Gemini API.
 * @param {string} imageBase64 - Raw base64 or dataUrl of person photo
 * @param {string} mimeType - e.g. 'image/jpeg' or 'image/png'
 * @param {string} apiKey - Gemini API Key
 * @param {AbortSignal} [externalSignal] - Optional caller AbortSignal
 * @returns {Promise<string>} Base64 image data
 */
export async function generateAvatar(imageBase64, mimeType = 'image/jpeg', apiKey, externalSignal = null) {
  if (!apiKey) {
    throw new Error('AI is not configured. Please add your Gemini API key to js/local-config.js');
  }

  // Enforce sliding hourly limit
  checkRateLimit();

  const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

  // Timeout controller (60 seconds)
  const timeoutMs = 60000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error('TIMEOUT'));
  }, timeoutMs);

  // Link external signal if provided
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw new Error('Request was cancelled.');
    }
    externalSignal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }

  try {
    // Retry once if no image returned (max 2 attempts per click)
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestBody = {
        contents: [{
          parts: [
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: cleanBase64 } },
            { text: PROMPT }
          ]
        }]
      };

      // On second attempt, explicitly request response modalities
      if (attempt === 1) {
        requestBody.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
        console.log('[avatarGen] Retry attempt #2 with responseModalities: [TEXT, IMAGE]');
      }

      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(requestBody),
          signal: timeoutController.signal
        });
      } catch (netErr) {
        if (timeoutController.signal.aborted) {
          if (externalSignal && externalSignal.aborted) {
            throw new Error('Request was cancelled.');
          }
          throw new Error('Request timed out after 60 seconds. Please try again.');
        }
        throw new Error('Network error connecting to Gemini API. Please check your internet connection.');
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Gemini API quota exceeded. Please wait a few minutes or try again later.');
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error('Invalid Gemini API key. Please check js/local-config.js.');
        }
        const rawText = await response.text();
        const safeText = sanitizeError(rawText, apiKey);
        throw new Error(`Gemini API error (${response.status}): ${safeText}`);
      }

      const data = await response.json();
      if (data?.promptFeedback?.blockReason) {
        throw new Error('Request blocked by AI safety filters. Please try a different photo.');
      }

      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) {
          // Record successful call towards hourly limit
          recordGeneration();
          return inline.data;
        }
      }

      // No image found on first attempt → retry
      if (attempt === 0) {
        console.warn('[avatarGen] No image in response 1, retrying with generationConfig...');
        continue;
      }
    }

    throw new Error('No image was returned in the Gemini response after 2 attempts.');

  } finally {
    clearTimeout(timeoutId);
  }
}
