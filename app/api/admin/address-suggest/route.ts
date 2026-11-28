/**
 * Delivery-address suggestions for the till, as the address is typed.
 *
 * Two sources, in this order:
 *
 * 1. Addresses this store has delivered to before — only for staff who may
 *    see customer contact details, because a list of where customers live is
 *    exactly that.
 * 2. Azure Maps typeahead near the store (lib/delivery-area.ts), for any
 *    staff member taking an order.
 *
 * A suggestion only fills the form. The order still goes through the full
 * address check, so picking one cannot make an address deliverable.
 */
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getSetting } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { suggestDeliveryAddresses } from "@/lib/delivery-area";
import { previousDeliveryAddresses } from "@/lib/customer-lookup";

type Suggestion = { line1: string; unit: string; postalCode: string; postalPrefix: string; area: string; source: "previous" | "maps" };

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 120);
    if (query.length < 3) return Response.json({ suggestions: [] });
    const canSeeAddresses = hasPermission(user.role, user.permissions, "view_customer_contact");
    const [business, delivery] = await Promise.all([
      getSetting<{ latitude: number | null; longitude: number | null }>("business"),
      getSetting<{ radiusKm: number }>("delivery"),
    ]);
    const near = business?.latitude != null && business?.longitude != null
      ? { latitude: business.latitude, longitude: business.longitude, radiusKm: Number(delivery?.radiusKm ?? 10) }
      : null;
    const [previous, maps] = await Promise.all([
      canSeeAddresses ? previousDeliveryAddresses(query) : Promise.resolve([]),
      suggestDeliveryAddresses(query, near),
    ]);
    const suggestions: Suggestion[] = previous.map((entry) => ({
      ...entry,
      postalPrefix: entry.postalCode.slice(0, 3),
      area: "",
      source: "previous" as const,
    }));
    // Maps' version of an address already offered from history adds nothing.
    const offered = new Set(suggestions.map((entry) => entry.line1.toLowerCase().replace(/\s+/g, " ")));
    for (const entry of maps) {
      if (offered.has(entry.line1.toLowerCase())) continue;
      suggestions.push({ ...entry, unit: "", source: "maps" });
    }
    return Response.json({ suggestions: suggestions.slice(0, 8) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
