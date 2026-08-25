/**
 * Menu and site image uploads (H-26).
 *
 * This route used to accept a file on the strength of `file.type` — a string the
 * browser sends and any client can set. So `evil.html`, renamed and declared as
 * `image/png`, was stored and then served back from this site's own origin,
 * where it runs with the session cookie of whoever opens it.
 *
 * The bytes are now inspected, the stored content type comes from what was
 * found rather than what was claimed, and the file name is generated rather than
 * taken from the upload. Serving is hardened separately, in `[key]/route.ts`.
 */
import { env } from "@/lib/runtime-env";
import { requireStaff, authErrorResponse } from "@/lib/auth";
import { ImageRejected, MAX_UPLOAD_BYTES, inspectImage } from "@/lib/image-validation";
import { logFailure } from "@/lib/log";

export async function POST(request: Request) {
  try {
    await requireStaff(request, "manage_menu");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose an image to upload." }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "Use an image under 5 MB." }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    let image;
    try {
      image = inspectImage(buffer);
    } catch (error) {
      if (error instanceof ImageRejected) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    // The extension and the content type both come from the inspected bytes, and
    // the name is a fresh UUID — nothing the uploader supplied reaches the key or
    // the headers it will later be served with.
    const key = `${crypto.randomUUID()}.${image.kind}`;
    await env.UPLOADS.put(key, buffer, { httpMetadata: { contentType: image.contentType } });

    return Response.json(
      { ok: true, url: `/api/uploads/${key}`, width: image.width, height: image.height },
      { status: 201 },
    );
  } catch (error) {
    try {
      return authErrorResponse(error);
    } catch {
      const reference = logFailure("uploads.create", error);
      return Response.json({ error: "That upload could not be saved.", reference }, { status: 500 });
    }
  }
}
