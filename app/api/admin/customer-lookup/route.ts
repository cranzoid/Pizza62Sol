/**
 * The till's returning-customer lookup. See lib/customer-lookup.ts.
 *
 * `?phone=905555` while the number is being typed returns suggestions;
 * `?customer=9055551234` once one is picked returns their history. Gated on
 * `view_customer_contact` like the customer directory: both answers are
 * names, numbers and addresses and nothing else.
 */
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase } from "@/db/runtime";
import { loadCustomerHistory, suggestCustomers } from "@/lib/customer-lookup";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await requireStaff(request, "view_customer_contact");
    const url = new URL(request.url);
    const customer = url.searchParams.get("customer");
    if (customer !== null) {
      const history = await loadCustomerHistory(customer);
      if (!history) return Response.json({ error: "No orders or details are saved for that number." }, { status: 404, headers: NO_STORE });
      return Response.json({ customer: history }, { headers: NO_STORE });
    }
    const suggestions = await suggestCustomers(url.searchParams.get("phone") ?? "");
    return Response.json({ suggestions }, { headers: NO_STORE });
  } catch (error) {
    return authErrorResponse(error);
  }
}
