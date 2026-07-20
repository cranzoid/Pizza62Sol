import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp|gif)$/.test(key)) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.UPLOADS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(object.size),
    },
  });
}
