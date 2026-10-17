import { loadPublicCatalog } from "@/lib/public-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await loadPublicCatalog(),
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
