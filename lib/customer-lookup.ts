/**
 * Finding a returning customer at the till by their phone number.
 *
 * Owner's request, 2026-11-28: when someone calls, the person on the phone
 * types the number and should see, as they type, whether that customer has
 * ordered before. Picking them shows what they ordered and where it went, and
 * "the same as last time" is one tap instead of a whole order rung in again
 * from memory.
 *
 * There is no populated `customers` table (see app/api/admin/customers), so the
 * people come from where they actually are: `orders`, grouped by the 10-digit
 * number, and `customer_contacts` — the old POS list and the birthdays taken at
 * the till — for regulars who have not ordered through this system yet.
 *
 * Every phone comparison goes through `phone10Sql`, the same reduction the
 * customer directory and the SMS audience use, so "905-555-1234", "9055551234"
 * and "+1 905 555 1234" are one person here as they are everywhere else.
 *
 * All of this is contact information, so the route that serves it is gated on
 * `view_customer_contact`, the same permission as the customer directory.
 */
import { getD1, safeJson } from "@/db/runtime";
import { phone10Sql } from "@/lib/customer-contacts";

export type CustomerSuggestion = {
  phone: string;
  name: string;
  email: string;
  orderCount: number;
  lastOrderAt: number | null;
  /** "123 King St E" from their latest delivery, to tell two people apart. */
  lastAddress: string | null;
  /** From the old POS list or a till birthday, with no order here yet. */
  contactOnly: boolean;
};

export type SavedAddress = {
  line1: string;
  unit: string;
  postalCode: string;
  /** The buzzer or directions given with that delivery. */
  instructions: string;
  lastUsedAt: number;
};

export type PastOrder = {
  id: string;
  order_number: string;
  created_at: number;
  fulfilment: string;
  channel: string;
  status: string;
  total_cents: number;
  customer_name: string;
  address: Record<string, string> | null;
  instructions: string | null;
  items: Array<Record<string, unknown>>;
};

export type CustomerHistory = {
  phone: string;
  name: string;
  email: string;
  orderCount: number;
  firstOrderAt: number | null;
  lastOrderAt: number | null;
  birthday: { month: number; day: number } | null;
  addresses: SavedAddress[];
  orders: PastOrder[];
};

const MAX_SUGGESTIONS = 8;
const RECENT_ORDERS = 6;
const MAX_ADDRESSES = 4;
const COUNTER_NAME = "Counter";

/**
 * An abandoned online checkout is not an order the customer received, so it
 * is not history; a cancelled one is, and shows as cancelled.
 */
const REAL_ORDER = `status <> 'awaiting_payment'`;

const usableName = (name: string | null | undefined) => {
  const trimmed = String(name ?? "").trim();
  return trimmed === COUNTER_NAME ? "" : trimmed;
};

/**
 * People whose number contains what has been typed so far, numbers that start
 * with it first, then the most recent customer. Three digits is the minimum:
 * fewer matches most of the city.
 */
/** Digits only, without a leading country code. Empty unless exactly ten. */
function tenDigits(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? digits : "";
}

export async function suggestCustomers(typed: string): Promise<CustomerSuggestion[]> {
  const digits = typed.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").slice(0, 10);
  if (digits.length < 3) return [];
  const contains = `%${digits}%`;
  const prefix = `${digits}%`;
  const phone = phone10Sql("customer_phone");
  const [fromOrders, fromContacts] = await Promise.all([
    getD1()
      .prepare(
        `SELECT phone10, COUNT(*) AS order_count, MAX(created_at) AS last_order_at,
                -- The latest real name: a till order left as "Counter" does not
                -- hide the name they gave last time.
                (array_agg(customer_name ORDER BY created_at DESC) FILTER (WHERE btrim(customer_name) NOT IN ('', '${COUNTER_NAME}')))[1] AS name,
                (array_agg(customer_email ORDER BY created_at DESC) FILTER (WHERE customer_email <> ''))[1] AS email,
                (array_agg(address_json ORDER BY created_at DESC) FILTER (WHERE address_json IS NOT NULL))[1] AS last_address
         FROM (SELECT ${phone} AS phone10, customer_name, customer_email, created_at, address_json
               FROM orders WHERE customer_phone <> '' AND ${REAL_ORDER}) o
         WHERE length(phone10) = 10 AND phone10 LIKE ?
         GROUP BY phone10
         ORDER BY (phone10 LIKE ?) DESC, MAX(created_at) DESC
         LIMIT ${MAX_SUGGESTIONS}`,
      )
      .bind(contains, prefix)
      .all<{ phone10: string; order_count: number; last_order_at: number; name: string; email: string; last_address: string | null }>(),
    getD1()
      .prepare(
        `SELECT phone10, name, email FROM (
           SELECT ${phone10Sql("phone")} AS phone10, name, email, COALESCE(last_visit_at, updated_at) AS seen
           FROM customer_contacts WHERE phone IS NOT NULL AND phone <> '') c
         WHERE length(phone10) = 10 AND phone10 LIKE ?
         ORDER BY (phone10 LIKE ?) DESC, seen DESC NULLS LAST
         LIMIT ${MAX_SUGGESTIONS}`,
      )
      .bind(contains, prefix)
      .all<{ phone10: string; name: string | null; email: string | null }>(),
  ]);
  const suggestions: CustomerSuggestion[] = fromOrders.results.map((row) => {
    const address = row.last_address ? safeJson<Record<string, string> | null>(row.last_address, null) : null;
    return {
      phone: row.phone10,
      name: usableName(row.name),
      email: String(row.email ?? ""),
      orderCount: Number(row.order_count),
      lastOrderAt: Number(row.last_order_at),
      lastAddress: address?.line1 ? address.line1 : null,
      contactOnly: false,
    };
  });
  const known = new Set(suggestions.map((entry) => entry.phone));
  for (const row of fromContacts.results) {
    if (known.has(row.phone10)) {
      // An order with no name, and a regular the old POS knew by name.
      const entry = suggestions.find((candidate) => candidate.phone === row.phone10);
      if (entry && !entry.name && row.name) entry.name = row.name.trim();
      continue;
    }
    known.add(row.phone10);
    suggestions.push({
      phone: row.phone10,
      name: usableName(row.name),
      email: String(row.email ?? ""),
      orderCount: 0,
      lastOrderAt: null,
      lastAddress: null,
      contactOnly: true,
    });
  }
  // Starts-with beats contains, whichever list it came from.
  return suggestions
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => Number(right.entry.phone.startsWith(digits)) - Number(left.entry.phone.startsWith(digits)) || left.index - right.index)
    .map(({ entry }) => entry)
    .slice(0, MAX_SUGGESTIONS);
}

/** Distinct delivery addresses, most recently used first. Pure; exported for tests. */
export function savedAddresses(rows: Array<{ address_json: string | null; instructions: string | null; created_at: number }>): SavedAddress[] {
  const seen = new Set<string>();
  const addresses: SavedAddress[] = [];
  for (const row of rows) {
    const address = row.address_json ? safeJson<Record<string, string> | null>(row.address_json, null) : null;
    if (!address?.line1) continue;
    const key = `${address.line1}|${address.unit ?? ""}|${address.postalCode ?? ""}`.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({
      line1: address.line1,
      unit: address.unit ?? "",
      postalCode: address.postalCode ?? "",
      instructions: row.instructions ?? "",
      lastUsedAt: Number(row.created_at),
    });
    if (addresses.length >= MAX_ADDRESSES) break;
  }
  return addresses;
}

/** One customer, by their 10-digit number: who they are, where they get it, what they had. */
export async function loadCustomerHistory(rawPhone: string): Promise<CustomerHistory | null> {
  // Any ten digits, as `suggestCustomers` matches them — not only numbers
  // that are valid NANP — so a number typed slightly wrong on an old order
  // can still be opened from the suggestion that offered it.
  const phone = tenDigits(rawPhone);
  if (!phone) return null;
  const matches = `${phone10Sql("customer_phone")} = ?`;
  const [summary, recent, deliveries, contact] = await Promise.all([
    getD1()
      .prepare(`SELECT COUNT(*) AS order_count, MIN(created_at) AS first_order_at, MAX(created_at) AS last_order_at FROM orders WHERE ${matches} AND ${REAL_ORDER}`)
      .bind(phone)
      .first<{ order_count: number; first_order_at: number | null; last_order_at: number | null }>(),
    getD1()
      .prepare(
        `SELECT id, order_number, created_at, fulfilment, channel, status, total_cents,
                customer_name, customer_email, address_json, instructions
         FROM orders WHERE ${matches} AND ${REAL_ORDER}
         ORDER BY created_at DESC LIMIT ${RECENT_ORDERS}`,
      )
      .bind(phone)
      .all<Record<string, unknown>>(),
    getD1()
      .prepare(
        `SELECT address_json, instructions, created_at FROM orders
         WHERE ${matches} AND ${REAL_ORDER} AND fulfilment = 'delivery' AND address_json IS NOT NULL
         ORDER BY created_at DESC LIMIT 40`,
      )
      .bind(phone)
      .all<{ address_json: string | null; instructions: string | null; created_at: number }>(),
    getD1()
      .prepare(
        `SELECT name, email, birth_month, birth_day FROM customer_contacts
         WHERE phone IS NOT NULL AND ${phone10Sql("phone")} = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(phone)
      .first<{ name: string | null; email: string | null; birth_month: number | null; birth_day: number | null }>(),
  ]);
  const orderCount = Number(summary?.order_count ?? 0);
  if (!orderCount && !contact) return null;

  const orderIds = recent.results.map((order) => String(order.id));
  const items = orderIds.length
    ? await getD1()
        .prepare(
          `SELECT order_id, product_id, product_name, variation_name, quantity, unit_price_cents,
                  line_total_cents, snapshot_json, instructions
           FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")})
           ORDER BY created_at`,
        )
        .bind(...orderIds)
        .all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  // The same item shape the live board sends the till, so one function turns
  // either back into something the customizer can open.
  const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items.results) {
    const list = itemsByOrder.get(String(item.order_id)) ?? [];
    list.push({
      productId: item.product_id,
      productName: item.product_name,
      variationName: item.variation_name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents,
      instructions: item.instructions,
      snapshot: safeJson(String(item.snapshot_json ?? "{}"), {}),
    });
    itemsByOrder.set(String(item.order_id), list);
  }
  const latest = recent.results[0];
  const name = usableName(latest?.customer_name as string | undefined)
    || recent.results.map((order) => usableName(order.customer_name as string)).find(Boolean)
    || usableName(contact?.name);
  return {
    phone,
    name,
    email: String(recent.results.map((order) => order.customer_email).find(Boolean) ?? contact?.email ?? ""),
    orderCount,
    firstOrderAt: summary?.first_order_at ?? null,
    lastOrderAt: summary?.last_order_at ?? null,
    birthday: contact?.birth_month && contact?.birth_day ? { month: contact.birth_month, day: contact.birth_day } : null,
    addresses: savedAddresses(deliveries.results),
    orders: recent.results.map((order) => ({
      id: String(order.id),
      order_number: String(order.order_number),
      created_at: Number(order.created_at),
      fulfilment: String(order.fulfilment),
      channel: String(order.channel),
      status: String(order.status),
      total_cents: Number(order.total_cents),
      customer_name: String(order.customer_name ?? ""),
      address: order.address_json ? safeJson<Record<string, string> | null>(String(order.address_json), null) : null,
      instructions: order.instructions ? String(order.instructions) : null,
      items: itemsByOrder.get(String(order.id)) ?? [],
    })),
  };
}

/**
 * Delivery addresses this store has sent food to before, matching what is
 * being typed. Postal codes on these were typed by a person and checked by the
 * radius check, which makes them the best suggestion there is for a street the
 * store delivers to every week.
 */
export async function previousDeliveryAddresses(typed: string): Promise<Array<{ line1: string; unit: string; postalCode: string }>> {
  const text = typed.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 120);
  if (text.length < 3) return [];
  const rows = await getD1()
    .prepare(
      `SELECT line1, unit, postal_code, MAX(created_at) AS last_used FROM (
         SELECT address_json::jsonb->>'line1' AS line1,
                COALESCE(address_json::jsonb->>'unit', '') AS unit,
                COALESCE(address_json::jsonb->>'postalCode', '') AS postal_code,
                created_at
         FROM orders WHERE fulfilment = 'delivery' AND address_json IS NOT NULL AND ${REAL_ORDER}) a
       WHERE lower(regexp_replace(line1, '\\s+', ' ', 'g')) LIKE ?
       GROUP BY line1, unit, postal_code
       ORDER BY (lower(regexp_replace(line1, '\\s+', ' ', 'g')) LIKE ?) DESC, MAX(created_at) DESC
       LIMIT 4`,
    )
    .bind(`%${text}%`, `${text}%`)
    .all<{ line1: string; unit: string; postal_code: string }>();
  return rows.results.map((row) => ({ line1: row.line1, unit: row.unit, postalCode: row.postal_code }));
}
