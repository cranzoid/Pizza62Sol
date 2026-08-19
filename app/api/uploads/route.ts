import { env } from "@/lib/runtime-env";
import { requireStaff, authErrorResponse } from "@/lib/auth";

const ALLOWED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export async function POST(request: Request) {
  try {
    await requireStaff(request, "manage_menu");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose an image to upload." }, { status: 400 });
    }
    const extension = ALLOWED_TYPES.get(file.type);
    if (!extension || file.size <= 0 || file.size > 5 * 1024 * 1024) {
      return Response.json({ error: "Use a JPG, PNG, WebP, or GIF image under 5 MB." }, { status: 400 });
    }
    const key = `${crypto.randomUUID()}.${extension}`;
    await env.UPLOADS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    return Response.json({ ok: true, url: `/api/uploads/${key}` }, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
