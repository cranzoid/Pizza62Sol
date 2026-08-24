/**
 * Serving an uploaded image (H-26).
 *
 * The upload side now proves a file is an image before storing it. This side
 * assumes it might be wrong anyway, because the two halves fail independently:
 * an object could predate the validation, or be written by something else that
 * reaches the same container.
 *
 * So the response headers are built so that a file which is *not* what it claims
 * cannot do anything useful. `nosniff` stops the browser second-guessing the
 * declared type and executing an HTML or script payload; the content type is
 * taken from a fixed allow-list keyed on the extension rather than from stored
 * metadata; `Content-Disposition: inline` with a generated filename stops a
 * crafted name driving a download; and the CSP sandbox neutralises anything that
 * does somehow get parsed as a document.
 */
import { env } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

/** The only types this route will ever claim, whatever is stored. */
const SERVED_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const match = /^([a-f0-9-]{36})\.(jpg|png|webp|gif)$/.exec(key);
  if (!match) return new Response("Not found", { status: 404 });

  const object = await env.UPLOADS.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      // From the key's extension, not from `object.httpMetadata` — stored
      // metadata is data, and this header decides how a browser treats the body.
      "content-type": SERVED_TYPES[match[2]],
      "content-length": String(object.size),
      // Without this a browser may ignore the declared type and sniff the body,
      // which is exactly how a file that is not an image gets executed.
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="${match[1]}.${match[2]}"`,
      // Defence in depth: if something is nonetheless parsed as a document, it
      // gets no origin, no scripts and no ability to navigate anything.
      "content-security-policy": "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'",
      // Content-addressed by a UUID that is never reused, so this is safe.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
