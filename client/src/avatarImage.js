// Profile-avatar compression (client-side, zero dependencies — native canvas).
//
// Canvas re-encode strips EXIF/GPS metadata (security property): the uploaded
// bytes are freshly-encoded JPEG pixels derived from the decoded bitmap, so
// location tags and other headers from the original file never leave the
// browser. Callers own the returned previewUrl and must release it with
// URL.revokeObjectURL when it is replaced or no longer shown.
export const AVATAR_LIMITS = {
  MAX_RAW_BYTES: 10 * 1024 * 1024,
  MAX_DIMENSION: 512,
  TARGET_BYTES: 512 * 1024,
  QUALITY: 0.82,
  FALLBACK_QUALITY: 0.6
};

function imageDimensions(sourceWidth, sourceHeight) {
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest > AVATAR_LIMITS.MAX_DIMENSION ? AVATAR_LIMITS.MAX_DIMENSION / longest : 1;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function decodeViaImageElement(file) {
  // Fallback path when createImageBitmap is unavailable: decode through an
  // <img> backed by a short-lived object URL (revoked after decode).
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanupUrl = () => {
      try { URL.revokeObjectURL(objectUrl); } catch { /* revoke is best-effort */ }
    };
    image.onload = () => {
      const width = Number(image.naturalWidth || image.width || 0);
      const height = Number(image.naturalHeight || image.height || 0);
      cleanupUrl();
      if (!width || !height) {
        reject(new Error('Could not read that image. Please try another photo.'));
        return;
      }
      resolve({ source: image, width, height, close: () => {} });
    };
    image.onerror = () => {
      cleanupUrl();
      reject(new Error('Could not read that image. Please try another photo.'));
    };
    image.src = objectUrl;
  });
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // imageOrientation applies EXIF rotation at decode time (iPhone
      // portrait photos); the <img> fallback below honors it natively.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const width = Number(bitmap?.width || 0);
      const height = Number(bitmap?.height || 0);
      if (!width || !height) {
        try { bitmap.close?.(); } catch { /* close is best-effort */ }
        throw new Error('Could not read that image. Please try another photo.');
      }
      return {
        source: bitmap,
        width,
        height,
        close: () => { try { bitmap.close?.(); } catch { /* close is best-effort */ } }
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Could not read that image. Please try another photo.') throw error;
      // A decode failure here falls through to the <img> path below, which
      // succeeds on platforms where createImageBitmap rejects valid files.
    }
  }
  return decodeViaImageElement(file);
}

function encodeToBlob(source, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not process that image on this device. Please try again.');
  // Opaque matte: output is always JPEG (no alpha), so transparent PNGs
  // flatten onto white instead of black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Could not process that image on this device. Please try again.'));
        },
        'image/jpeg',
        quality
      );
    } catch {
      reject(new Error('Could not process that image on this device. Please try again.'));
    }
  });
}

// Still-image inputs only. Animated GIFs are rejected outright (canvas
// would silently freeze frame 0 while charging a full multi-frame decode),
// and anything outside the still-image set never reaches the decoder.
const ALLOWED_AVATAR_INPUT_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export async function compressAvatarImage(file) {
  if (!file || typeof file !== 'object' || typeof file.type !== 'string' || !ALLOWED_AVATAR_INPUT_TYPES.includes(file.type)) {
    throw new Error(
      file?.type === 'image/gif'
        ? 'Animated photos are not supported. Please choose a JPEG, PNG, or WebP still image.'
        : 'Please choose an image file (JPEG, PNG, or WebP).'
    );
  }
  if (typeof file.size === 'number' && file.size > AVATAR_LIMITS.MAX_RAW_BYTES) {
    throw new Error('That photo is too large. Please choose an image under 10 MB.');
  }
  const decoded = await decodeImage(file);
  try {
    const { width, height } = imageDimensions(decoded.width, decoded.height);
    let blob = await encodeToBlob(decoded.source, width, height, AVATAR_LIMITS.QUALITY);
    // ONE retry at the fallback quality when the first pass misses the byte
    // budget — never a quality loop (bounded work, predictable output).
    if (blob.size > AVATAR_LIMITS.TARGET_BYTES) {
      blob = await encodeToBlob(decoded.source, width, height, AVATAR_LIMITS.FALLBACK_QUALITY);
    }
    return { blob, width, height, previewUrl: URL.createObjectURL(blob) };
  } finally {
    try { decoded.close(); } catch { /* close is best-effort */ }
  }
}
