// Fetches article images and makes them fit the reader.
//
// Each image goes through Cloudflare's image transformation (cf.image): a
// grayscale baseline JPEG that fits in 800 x 800, the longest side of any
// supported panel. The reader decodes progressive JPEG only at 1/8 detail,
// so baseline matters. When the transformation does not run (local dev,
// transformations not enabled, monthly quota used up), the original is kept
// if the reader can decode it and it is small enough; otherwise the image is
// dropped and the text stays.

export const TRANSFORM = {
  width: 800,
  height: 800,
  fit: 'scale-down',
  format: 'baseline-jpeg',
  saturation: 0,
  quality: 70,
  sharpen: 1,
  metadata: 'none',
  anim: false,
  background: '#FFFFFF',
};

// Free plan: 50 subrequests per request, and one goes to Instapaper.
const MAX_SUBREQUESTS = 48;
const MAX_IMAGES = 30;
const CONCURRENCY = 6;
const TIMEOUT_MS = 10000;
// Limits for originals kept without transformation. The CRC over every byte
// is the Worker's main CPU cost, and large images decode slowly on the reader.
const MAX_ORIGINAL_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
// Reader decoder limits (platformio.ini: MAX_WIDTH, PNG_MAX_BUFFERED_PIXELS).
const MAX_GIF_WIDTH = 3072;
const MAX_PNG_WIDTH = 4096;
// Smaller images are icons and avatars.
const MIN_SIDE = 120;

const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b, i) => b[i] | (b[i + 1] << 8);

// Format and size from the file header, or null for anything the reader
// cannot decode (WebP, AVIF, SVG, ...).
export function imageInfo(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          type: 'jpeg',
          ext: 'jpg',
          mime: 'image/jpeg',
          height: be16(b, i + 5),
          width: be16(b, i + 7),
          progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce,
        };
      }
      if (marker === 0xda) break;
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: 'png', ext: 'png', mime: 'image/png', width: be32(b, 16), height: be32(b, 20) };
  }
  if (b.length > 13 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const info = { type: 'gif', ext: 'gif', mime: 'image/gif', width: le16(b, 6), height: le16(b, 8), interlaced: false };
    // Find the first image descriptor for its interlace flag.
    let i = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
    while (i < b.length) {
      if (b[i] === 0x2c) {
        info.interlaced = (b[i + 9] & 0x40) !== 0;
        break;
      }
      if (b[i] !== 0x21) break;
      i += 2;
      while (i < b.length && b[i] !== 0) i += b[i] + 1;
      i++;
    }
    return info;
  }
  return null;
}

// Whether the reader can show these bytes as they are.
export function readerCanShow(info, size) {
  if (!info || Math.max(info.width, info.height) < MIN_SIDE) return false;
  if (info.type === 'gif') return !info.interlaced && info.width <= MAX_GIF_WIDTH && size <= MAX_ORIGINAL_BYTES;
  if (info.type === 'png') return info.width <= MAX_PNG_WIDTH && size <= MAX_ORIGINAL_BYTES;
  // Transformed images are baseline JPEG within 800 px; let them through
  // whatever their byte size.
  if (!info.progressive && Math.max(info.width, info.height) <= TRANSFORM.width) return true;
  return size <= MAX_ORIGINAL_BYTES;
}

async function download(fetchImpl, url, referer, transform) {
  const headers = { Accept: 'image/jpeg,image/png,image/gif;q=0.9,image/*;q=0.5' };
  if (referer) headers.Referer = referer;
  const init = { headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (transform) init.cf = { image: TRANSFORM };
  try {
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const length = Number(response.headers.get('Content-Length') || 0);
    if (!transform && length > MAX_ORIGINAL_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const data = new Uint8Array(await response.arrayBuffer());
    return { data, resized: response.headers.has('cf-resized') };
  } catch (e) {
    return null;
  }
}

// `images` is content.images ([{url, alt}]). Returns {files, stats}, where
// files[i] is {data, mime, ext} or null, as placeImages() expects.
export async function fetchImages(images, referer, fetchImpl = fetch) {
  const files = new Array(images.length).fill(null);
  const stats = { found: images.length, kept: 0, converted: 0 };
  let subrequests = 0;
  let total = 0;

  const fetchOne = async (index) => {
    subrequests++;
    let got = await download(fetchImpl, images[index].url, referer, true);
    let info = got && imageInfo(got.data);
    // No usable result from the transformation: try the original once.
    if (!(info && readerCanShow(info, got.data.length)) && subrequests < MAX_SUBREQUESTS) {
      subrequests++;
      got = await download(fetchImpl, images[index].url, referer, false);
      info = got && imageInfo(got.data);
    }
    if (!(info && readerCanShow(info, got.data.length))) return;
    if (total + got.data.length > MAX_TOTAL_BYTES) return;
    total += got.data.length;
    files[index] = { data: got.data, mime: info.mime, ext: info.ext };
    stats.kept++;
    if (got.resized) stats.converted++;
  };

  const queue = images.slice(0, MAX_IMAGES).map((_, i) => i);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && subrequests < MAX_SUBREQUESTS) await fetchOne(queue.shift());
  });
  await Promise.all(workers);
  return { files, stats };
}
