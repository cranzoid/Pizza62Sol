/**
 * What an uploaded file actually is, rather than what it claims to be (H-26).
 *
 * The upload route trusted `file.type` — a string the browser sends and any
 * client can set to anything. So `evil.html` renamed and declared as
 * `image/png` was stored and then served back from the site's own origin, where
 * it inherits the session cookie of whoever opens it.
 *
 * Two defences, because either alone is insufficient:
 *
 * 1. **The bytes are inspected.** A real PNG starts with a fixed eight-byte
 *    signature; a JPEG with `FF D8 FF`. Nothing about the filename or the
 *    declared type is consulted, and the content type actually served is derived
 *    from what was found rather than from what was claimed.
 * 2. **The dimensions are read** from the header. A file can carry a valid
 *    signature and still be malformed or a decompression bomb — a 60,000 ×
 *    60,000 PNG is 3.6 billion pixels from a few kilobytes of input, and it is
 *    the browser resizing it for the menu that falls over.
 *
 * This is header parsing, not decoding, and deliberately so: the alternative is
 * a native image library in the dependency tree and in the container, to defend
 * an owner-only upload form. Full decode-and-re-encode is the stronger answer if
 * uploads are ever opened to customers.
 */

/**
 * The largest file the upload route accepts.
 *
 * Exported because the browser needs the same number. A file rejected here has
 * already crossed the wire, which on a phone is a slow upload that ends in an
 * error, so the editors check the size before opening the connection.
 *
 * It must also stay below the framework's multipart body limit — see
 * `experimental.serverActions.bodySizeLimit` in `next.config.ts`. That limit is
 * applied before this route is matched, so if it were the smaller of the two it
 * would be the one doing the rejecting, in a plain-text 413 this route never
 * sees and cannot phrase.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageKind = "jpg" | "png" | "webp" | "gif";

export type InspectedImage = {
  kind: ImageKind;
  /** Derived from the bytes, never from the upload's declared type. */
  contentType: string;
  width: number;
  height: number;
};

export class ImageRejected extends Error {}

/** Beyond this, resizing it in a browser is the thing that breaks. */
const MAX_DIMENSION = 12_000;
/** A 1×1 tracking pixel is not a menu photo; a 0-dimension file is malformed. */
const MIN_DIMENSION = 8;

const CONTENT_TYPES: Record<ImageKind, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * Identifies the format and reads its dimensions, or throws.
 *
 * Every path throws `ImageRejected` with a message safe to show a person: this
 * runs behind an owner-authenticated form, and "that file is not an image" is
 * more useful than a generic failure.
 */
export function inspectImage(buffer: ArrayBuffer): InspectedImage {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 24) throw new ImageRejected("That file is too small to be an image.");

  // PNG: 8-byte signature, then an IHDR chunk carrying dimensions big-endian.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const view = new DataView(buffer);
    if (ascii(bytes, 12, 4) !== "IHDR") throw new ImageRejected("That PNG file is damaged.");
    return finish("png", view.getUint32(16, false), view.getUint32(20, false));
  }

  // GIF: "GIF87a" or "GIF89a", then width and height little-endian.
  if (ascii(bytes, 0, 3) === "GIF") {
    const version = ascii(bytes, 3, 3);
    if (version !== "87a" && version !== "89a") throw new ImageRejected("That GIF file is damaged.");
    const view = new DataView(buffer);
    return finish("gif", view.getUint16(6, true), view.getUint16(8, true));
  }

  // WebP: RIFF container with a "WEBP" tag. Three sub-formats, each storing its
  // dimensions somewhere different, which is why this is not one branch.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const view = new DataView(buffer);
    const format = ascii(bytes, 12, 4);
    if (format === "VP8X") {
      // 24-bit little-endian, stored as "value minus one".
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return finish("webp", width, height);
    }
    if (format === "VP8L") {
      const bits = view.getUint32(21, true);
      return finish("webp", 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
    }
    if (format === "VP8 ") {
      return finish("webp", view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    throw new ImageRejected("That WebP file is damaged.");
  }

  // JPEG: walk the segment markers to the start-of-frame, which is the only
  // place the dimensions live. Anything else is metadata of unknown length.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) throw new ImageRejected("That JPEG file is damaged.");
      const marker = bytes[offset + 1];
      // SOF0..SOF15, excluding the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const view = new DataView(buffer);
        return finish("jpg", view.getUint16(offset + 7, false), view.getUint16(offset + 5, false));
      }
      const length = new DataView(buffer).getUint16(offset + 2, false);
      // A zero or negative segment length would loop forever on a hostile file.
      if (length < 2) throw new ImageRejected("That JPEG file is damaged.");
      offset += 2 + length;
    }
    throw new ImageRejected("That JPEG file is damaged.");
  }

  throw new ImageRejected("That file is not a JPG, PNG, WebP or GIF image.");
}

function finish(kind: ImageKind, width: number, height: number): InspectedImage {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new ImageRejected("That image is too small to use.");
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ImageRejected(`That image is larger than ${MAX_DIMENSION}px on a side. Resize it and try again.`);
  }
  return { kind, contentType: CONTENT_TYPES[kind], width, height };
}
