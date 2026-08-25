/**
 * The customer directory.
 *
 * There is no populated `customers` table — `orders.customer_id` is never
 * written by `createOrder`, so it is null on every row, and building this from
 * an empty table would show nothing for the account's entire order history.
 * What every order *does* carry is `customer_name` / `customer_phone` /
 * `customer_email`, so the directory is derived straight from `orders`,
 * grouped by identity: a normalised email when one was given, otherwise a
 * digits-only phone number. A counter order with neither (the till's "Counter"
 * default) has no identity to group by and is excluded — it belongs to no
 * customer, so it cannot appear as one.
 *
 * Gated on `view_customer_contact` rather than `view_orders`: unlike order
 * history, which redacts phone/email per row, a directory whose entire reason
 * to exist is contact information has nothing left to show once that is
 * redacted, so access is gated at the door instead of field by field.
 */
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { ISO_DATE_RE, nextCalendarDate, torontoDayStart } from "@/lib/report-dates";

const PAGE_SIZE = 50;
const EXPORT_LIMIT = 10_000;

/** Every customer's group identity, computed once so no query can disagree with another about it. */
const CUSTOMER_KEY_EXPR = `CASE
  WHEN customer_email <> '' THEN 'email:' || lower(customer_email)
  WHEN customer_phone <> '' THEN 'phone:' || regexp_replace(customer_phone, '\\D', '', 'g')
  ELSE NULL
END`;

/** Counted as revenue: a completed sale, not a cart that never paid. */
const PAID_CASE = `CASE WHEN status <> 'cancelled' AND (payment_method = 'pay_at_store' OR payment_status = 'paid') THEN 1 ELSE 0 END`;

const SORTS: Record<string, string> = {
  recent: "last_order_at DESC",
  orders: "order_count DESC, last_order_at DESC",
  spend: "lifetime_cents DESC, last_order_at DESC",
};

/** The date range and search term, shared by every query in this route so the list, the totals and the export can never disagree about "the current view". */
function scope(url: URL) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromMs = from && ISO_DATE_RE.test(from) ? torontoDayStart(from) : 0;
  const toMs = to && ISO_DATE_RE.test(to) ? torontoDayStart(nextCalendarDate(to)) : Date.now() + 24 * 60 * 60 * 1000;
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 60);
  return { fromMs, toMs, like: `%${query}%` };
}

/**
 * `key` identifies one customer as `email:<address>` or `phone:<digits>` —
 * the same value `CUSTOMER_KEY_EXPR` produces, so a row from the list can be
 * clicked straight into this without re-deriving anything.
 */
function parseCustomerKey(key: string): { column: string; value: string } | null {
  if (key.startsWith("email:")) {
    const value = key.slice("email:".length);
    return value ? { column: "lower(customer_email)", value } : null;
  }
  if (key.startsWith("phone:")) {
    const value = key.slice("phone:".length);
    return value ? { column: "regexp_replace(customer_phone, '\\D', '', 'g')", value } : null;
  }
  return null;
}

/** One customer's profile and their full order list. */
async function loadCustomer(key: string) {
  const parsed = parseCustomerKey(key);
  if (!parsed) return null;
  const [latest, agg, orders] = await Promise.all([
    getD1()
      .prepare(`SELECT customer_name, customer_phone, customer_email FROM orders WHERE ${parsed.column} = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(parsed.value)
      .first<{ customer_name: string; customer_phone: string; customer_email: string }>(),
    getD1()
      .prepare(
        `SELECT COUNT(*) AS order_count,
                COALESCE(SUM(${PAID_CASE}), 0) AS paid_count,
                COALESCE(SUM(CASE WHEN ${PAID_CASE} = 1 THEN total_cents ELSE 0 END), 0) AS lifetime_cents,
                MIN(created_at) AS first_seen, MAX(created_at) AS last_order_at
         FROM orders WHERE ${parsed.column} = ?`,
      )
      .bind(parsed.value)
      .first<{ order_count: number; paid_count: number; lifetime_cents: number; first_seen: number; last_order_at: number }>(),
    getD1()
      .prepare(
        `SELECT id, order_number, created_at, channel, fulfilment, status, payment_status, payment_method, total_cents
         FROM orders WHERE ${parsed.column} = ? ORDER BY created_at DESC LIMIT 500`,
      )
      .bind(parsed.value)
      .all<Record<string, unknown>>(),
  ]);
  if (!latest || !agg || !agg.order_count) return null;
  return {
    customerKey: key,
    name: latest.customer_name,
    phone: latest.customer_phone,
    email: latest.customer_email,
    orderCount: Number(agg.order_count),
    paidCount: Number(agg.paid_count),
    lifetimeCents: Number(agg.lifetime_cents),
    firstSeen: Number(agg.first_seen),
    lastOrderAt: Number(agg.last_order_at),
    orders: orders.results,
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_customer_contact");
    const url = new URL(request.url);

    const key = url.searchParams.get("key");
    if (key) {
      const customer = await loadCustomer(key);
      if (!customer) return Response.json({ error: "That customer could not be found." }, { status: 404 });
      return Response.json({ customer });
    }

    const { fromMs, toMs, like } = scope(url);
    const sort = SORTS[url.searchParams.get("sort") ?? "recent"] ?? SORTS.recent;

    // --- CSV export ----------------------------------------------------------
    if (url.searchParams.get("format") === "csv") {
      if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "view_analytics")) {
        return Response.json({ error: "You do not have permission to export customers." }, { status: 403 });
      }
      const rows = await getD1()
        .prepare(
          `WITH keyed AS (
             SELECT customer_name, customer_phone, customer_email, channel, fulfilment, status,
                    payment_status, payment_method, total_cents, created_at, ${CUSTOMER_KEY_EXPR} AS customer_key
             FROM orders WHERE created_at >= ? AND created_at < ?
           ),
           scoped AS (SELECT * FROM keyed WHERE customer_key IS NOT NULL),
           matching AS (
             SELECT DISTINCT customer_key FROM scoped
             WHERE customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ?
           ),
           latest AS (
             SELECT DISTINCT ON (customer_key) customer_key, customer_name, customer_phone, customer_email,
                    created_at AS last_order_at
             FROM scoped WHERE customer_key IN (SELECT customer_key FROM matching)
             ORDER BY customer_key, created_at DESC
           ),
           agg AS (
             SELECT customer_key, COUNT(*) AS order_count,
                    COALESCE(SUM(${PAID_CASE}), 0) AS paid_count,
                    COALESCE(SUM(CASE WHEN ${PAID_CASE} = 1 THEN total_cents ELSE 0 END), 0) AS lifetime_cents,
                    MIN(created_at) AS first_seen
             FROM scoped WHERE customer_key IN (SELECT customer_key FROM matching)
             GROUP BY customer_key
           )
           SELECT latest.customer_name, latest.customer_phone, latest.customer_email, latest.last_order_at,
                  agg.order_count, agg.paid_count, agg.lifetime_cents, agg.first_seen
           FROM latest JOIN agg USING (customer_key)
           ORDER BY ${sort} LIMIT ${EXPORT_LIMIT}`,
        )
        .bind(fromMs, toMs, like, like, like)
        .all<Record<string, unknown>>();

      // A customer export is bulk contact data leaving the building — audited
      // like the order history export, for the same reason.
      await writeAudit({
        actorId: user.id,
        action: "customers.export",
        targetType: "customers",
        targetId: "csv",
        next: { rows: rows.results.length, filters: Object.fromEntries(url.searchParams) },
      });

      const csv = toCsv(rows.results);
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="pizza62-customers-${stamp}.csv"`,
          "cache-control": "no-store",
        },
      });
    }

    // --- summary ---------------------------------------------------------
    const summary = await getD1()
      .prepare(
        `WITH keyed AS (
           SELECT customer_name, customer_phone, customer_email, status, payment_status, payment_method,
                  total_cents, created_at, ${CUSTOMER_KEY_EXPR} AS customer_key
           FROM orders WHERE created_at >= ? AND created_at < ?
         ),
         scoped AS (SELECT * FROM keyed WHERE customer_key IS NOT NULL),
         matching AS (
           SELECT DISTINCT customer_key FROM scoped
           WHERE customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ?
         ),
         per_customer AS (
           SELECT customer_key, COUNT(*) AS order_count,
                  COALESCE(SUM(CASE WHEN ${PAID_CASE} = 1 THEN total_cents ELSE 0 END), 0) AS lifetime_cents
           FROM scoped WHERE customer_key IN (SELECT customer_key FROM matching)
           GROUP BY customer_key
         )
         SELECT COUNT(*) AS customers,
                COALESCE(SUM(CASE WHEN order_count > 1 THEN 1 ELSE 0 END), 0) AS repeat_customers,
                COALESCE(SUM(order_count), 0) AS total_orders,
                COALESCE(SUM(lifetime_cents), 0) AS total_cents
         FROM per_customer`,
      )
      .bind(fromMs, toMs, like, like, like)
      .first<{ customers: number; repeat_customers: number; total_orders: number; total_cents: number }>();

    // --- page ---------------------------------------------------------------
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    const offset = page * PAGE_SIZE;

    const rows = await getD1()
      .prepare(
        `WITH keyed AS (
           SELECT customer_name, customer_phone, customer_email, order_number, status, payment_status,
                  payment_method, channel, fulfilment, total_cents, created_at, ${CUSTOMER_KEY_EXPR} AS customer_key
           FROM orders WHERE created_at >= ? AND created_at < ?
         ),
         scoped AS (SELECT * FROM keyed WHERE customer_key IS NOT NULL),
         matching AS (
           SELECT DISTINCT customer_key FROM scoped
           WHERE customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ?
         ),
         latest AS (
           SELECT DISTINCT ON (customer_key) customer_key, customer_name, customer_phone, customer_email,
                  order_number, status, channel, fulfilment, created_at AS last_order_at
           FROM scoped WHERE customer_key IN (SELECT customer_key FROM matching)
           ORDER BY customer_key, created_at DESC
         ),
         agg AS (
           SELECT customer_key, COUNT(*) AS order_count,
                  COALESCE(SUM(${PAID_CASE}), 0) AS paid_count,
                  COALESCE(SUM(CASE WHEN ${PAID_CASE} = 1 THEN total_cents ELSE 0 END), 0) AS lifetime_cents,
                  MIN(created_at) AS first_seen,
                  SUM(CASE WHEN fulfilment = 'pickup' THEN 1 ELSE 0 END) AS pickup_count,
                  SUM(CASE WHEN fulfilment = 'delivery' THEN 1 ELSE 0 END) AS delivery_count,
                  SUM(CASE WHEN channel = 'online' THEN 1 ELSE 0 END) AS online_count,
                  SUM(CASE WHEN channel = 'phone' THEN 1 ELSE 0 END) AS phone_count,
                  SUM(CASE WHEN channel = 'walk_in' THEN 1 ELSE 0 END) AS walk_in_count
           FROM scoped WHERE customer_key IN (SELECT customer_key FROM matching)
           GROUP BY customer_key
         )
         SELECT latest.customer_key, latest.customer_name, latest.customer_phone, latest.customer_email,
                latest.order_number AS last_order_number, latest.status AS last_status,
                latest.channel AS last_channel, latest.fulfilment AS last_fulfilment, latest.last_order_at,
                agg.order_count, agg.paid_count, agg.lifetime_cents, agg.first_seen, agg.pickup_count,
                agg.delivery_count, agg.online_count, agg.phone_count, agg.walk_in_count,
                COUNT(*) OVER() AS full_count
         FROM latest JOIN agg USING (customer_key)
         ORDER BY ${sort}
         LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      )
      .bind(fromMs, toMs, like, like, like)
      .all<Record<string, unknown>>();

    return Response.json({
      customers: rows.results.map((row) => ({ ...row, full_count: undefined })),
      page,
      pageSize: PAGE_SIZE,
      total: rows.results.length ? Number(rows.results[0].full_count) : 0,
      summary: {
        customers: Number(summary?.customers ?? 0),
        repeatCustomers: Number(summary?.repeat_customers ?? 0),
        totalOrders: Number(summary?.total_orders ?? 0),
        totalCents: Number(summary?.total_cents ?? 0),
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

const CSV_HEADERS = ["Customer", "Phone", "Email", "Orders", "Paid orders", "Lifetime spend", "First seen", "Last order"];

/** Same formula-injection guard as the order history export — see that file. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

const money = (cents: unknown) => (Number(cents ?? 0) / 100).toFixed(2);
const stamp = (value: unknown) =>
  value ? new Date(Number(value)).toLocaleString("en-CA", { timeZone: "America/Toronto", hour12: false }) : "";

function toCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [CSV_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.customer_name,
        row.customer_phone,
        row.customer_email,
        row.order_count,
        row.paid_count,
        money(row.lifetime_cents),
        stamp(row.first_seen),
        stamp(row.last_order_at),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
