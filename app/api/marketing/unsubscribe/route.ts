/**
 * Unsubscribing from marketing email.
 *
 * Two callers, one action:
 *
 * - The button on `/unsubscribe`, which a customer reaches from the link in a
 *   nudge's footer.
 * - A mail client's own "Unsubscribe" button (RFC 8058 one-click), which POSTs
 *   here straight from the `List-Unsubscribe` header without the customer
 *   opening anything.
 *
 * POST only. A GET that unsubscribed would be triggered by every link-scanning
 * mail filter that pre-fetches URLs — see lib/marketing-consent.ts.
 *
 * The address and its signature are in the query string, which is where the
 * `List-Unsubscribe` header puts them. The signature is what makes this safe
 * to leave unauthenticated: it proves the link was one we sent to that address.
 */
import { ensureDatabase } from "@/db/runtime";
import { logFailure } from "@/lib/log";
import { recordOptOut, verifyUnsubscribe } from "@/lib/marketing-consent";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const email = await verifyUnsubscribe(url.searchParams.get("e"), url.searchParams.get("t"));
    if (!email) return Response.json({ error: "This unsubscribe link is not valid." }, { status: 400 });
    await recordOptOut(email);
    return Response.json({ ok: true, email });
  } catch (error) {
    const reference = logFailure("marketing.unsubscribe", error);
    return Response.json(
      { error: "We could not record that just now. Please try again, or call us and we will do it for you.", reference },
      { status: 500 },
    );
  }
}
