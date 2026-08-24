/**
 * Order history and the feedback inbox — the two things an owner looks back at.
 *
 * H-20: history was a hard-capped 100 rows with a text search and a status
 * filter, and no export. So "how did last month go", "how many were delivery",
 * and "reconcile this against the bank" were all unanswerable, and the answer to
 * "where did that order go" was a scroll.
 *
 * What that turns into here: a date range, a channel filter, pagination with a
 * true total, and a CSV export of the whole filtered set rather than the page.
 *
 * Two rules the export follows, both because a spreadsheet is where this data
 * goes next:
 *
 * - **Money is exported as decimal dollars**, not cents. The alternative is
 *   every column needing a division before it means anything.
 * - **Every field is escaped and formula-guarded.** A customer name beginning
 *   `=` is executed by Excel on open, which turns an order note into code
 *   running on the owner's machine.
 */
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, safeJson, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { ORDER_CHANNELS } from "@/db/schema";

const CHANNELS = new Set<string>(ORDER_CHANNELS);
const PAGE_SIZE = 100;
/** Bounded so one export cannot pull the whole table into memory at once. */
const EXPORT_LIMIT = 10_000;

type Filters = {
  where: string;
  bindings: unknown[];
};

/**
 * Builds the filter once, so the page query, the count and the export can never
 * disagree about what "the current view" means.
 */
function buildFilters(url: URL): Filters {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 60);
  if (query) {
    // Order number, name, phone or email — whichever the owner has to hand.
    conditions.push("(order_number ILIKE ? OR customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ?)");
    const like = `%${query}%`;
    bindings.push(like, like, like, like);
  }

  const status = url.searchParams.get("status") ?? "";
  if (status && status !== "all") {
    conditions.push("status = ?");
    bindings.push(status);
  }

  const channel = url.searchParams.get("channel") ?? "";
  if (channel && channel !== "all" && CHANNELS.has(channel)) {
    conditions.push("channel = ?");
    bindings.push(channel);
  }

  const fulfilment = url.searchParams.get("fulfilment") ?? "";
  if (fulfilment === "pickup" || fulfilment === "delivery") {
    conditions.push("fulfilment = ?");
    bindings.push(fulfilment);
  }

  // Dates arrive as YYYY-MM-DD and are interpreted in the restaurant's own time
  // zone, not the viewer's and not UTC. An owner asking for "the 21st" means the
  // day they worked, and a UTC boundary would put the evening's orders on the
  // wrong day — which is exactly when a restaurant is busiest.
  const from = url.searchParams.get("from");
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conditions.push("created_at >= ?");
    bindings.push(torontoDayStart(from));
  }
  const to = url.searchParams.get("to");
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    // Inclusive of the whole end day: "to the 21st" includes the 21st.
    conditions.push("created_at < ?");
    bindings.push(torontoDayStart(nextCalendarDate(to)));
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", bindings };
}

/** Midnight on a YYYY-MM-DD date, in America/Toronto, as epoch ms. */
function torontoDayStart(date: string): number {
  // Probing both standard and daylight offsets and keeping whichever round-trips
  // to the requested date avoids hardcoding a DST rule that changes.
  for (const offset of ["-05:00", "-04:00"]) {
    const candidate = new Date(`${date}T00:00:00${offset}`).getTime();
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const rendered = `${values.year}-${values.month}-${values.day}`;
    if (rendered === date && values.hour === "00" && values.minute === "00" && values.second === "00") {
      return candidate;
    }
  }
  return new Date(`${date}T00:00:00-05:00`).getTime();
}

/** The next YYYY-MM-DD date without allowing the host time zone to interfere. */
function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

const ORDER_COLUMNS = `id, order_number, customer_name, customer_phone, customer_email, fulfilment, channel,
   status, payment_status, payment_method, schedule_type, scheduled_for, created_at,
   subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents`;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const url = new URL(request.url);
    const tab = url.searchParams.get("tab") === "feedback" ? "feedback" : "orders";
    const canViewContact = user.role === "owner" || user.permissions.includes("view_customer_contact");

    if (tab === "feedback") {
      const rows = await getD1()
        .prepare(
          `SELECT f.id, f.overall_rating, f.written_feedback, f.answers_json, f.submitted_at,
                  f.reviewed_at, f.internal_note, o.order_number, o.fulfilment
           FROM feedback_responses f LEFT JOIN orders o ON o.id = f.order_id
           ORDER BY f.submitted_at DESC LIMIT 100`,
        )
        .all<Record<string, unknown>>();
      return Response.json({
        feedback: rows.results.map((row) => ({
          ...row,
          answers: safeJson(String(row.answers_json ?? "{}"), {}),
          answers_json: undefined,
        })),
      });
    }

    const { where, bindings } = buildFilters(url);

    // --- CSV export ---------------------------------------------------------
    if (url.searchParams.get("format") === "csv") {
      if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "view_analytics")) {
        return Response.json({ error: "You do not have permission to export orders." }, { status: 403 });
      }
      const rows = await getD1()
        .prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY created_at DESC LIMIT ${EXPORT_LIMIT}`)
        .bind(...bindings)
        .all<Record<string, unknown>>();

      // An export is a copy of customer contact details leaving the building, so
      // it is audited like one — who, when, and how many rows.
      await writeAudit({
        actorId: user.id,
        action: "orders.export",
        targetType: "orders",
        targetId: "csv",
        next: { rows: rows.results.length, filters: Object.fromEntries(url.searchParams) },
      });

      const csv = toCsv(rows.results, canViewContact);
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="pizza62-orders-${stamp}.csv"`,
          // Never let a proxy or the browser keep a file full of customer data.
          "cache-control": "no-store",
        },
      });
    }

    // --- page ---------------------------------------------------------------
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    const offset = page * PAGE_SIZE;

    const [rows, totals, breakdown] = await Promise.all([
      getD1()
        .prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`)
        .bind(...bindings)
        .all<Record<string, unknown>>(),
      // A real total, so the owner knows whether they are looking at everything.
      // Also the money for the whole filtered range, which is the actual question
      // behind "how did last month go" — a page sum would answer a different one.
      getD1()
        .prepare(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(total_cents), 0) AS total_cents,
                  COALESCE(SUM(CASE WHEN status <> 'cancelled' AND (payment_method = 'pay_at_store' OR payment_status = 'paid')
                                    THEN total_cents ELSE 0 END), 0) AS paid_cents
           FROM orders ${where}`,
        )
        .bind(...bindings)
        .first<{ count: number; total_cents: number; paid_cents: number }>(),
      // "How many were in store" — the owner's question, answered directly.
      getD1()
        .prepare(
          `SELECT channel, fulfilment, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents
           FROM orders ${where} GROUP BY channel, fulfilment`,
        )
        .bind(...bindings)
        .all<{ channel: string; fulfilment: string; count: number; total_cents: number }>(),
    ]);

    return Response.json({
      orders: rows.results.map((order) => ({
        ...order,
        customer_phone: canViewContact ? order.customer_phone : undefined,
        customer_email: canViewContact ? order.customer_email : undefined,
        contactRedacted: !canViewContact,
      })),
      page,
      pageSize: PAGE_SIZE,
      total: Number(totals?.count ?? 0),
      totalCents: Number(totals?.total_cents ?? 0),
      paidCents: Number(totals?.paid_cents ?? 0),
      breakdown: breakdown.results.map((row) => ({
        channel: row.channel,
        fulfilment: row.fulfilment,
        count: Number(row.count),
        totalCents: Number(row.total_cents),
      })),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

const CSV_HEADERS = [
  "Order",
  "Placed",
  "Scheduled for",
  "Channel",
  "Fulfilment",
  "Status",
  "Payment method",
  "Payment status",
  "Customer",
  "Phone",
  "Email",
  "Subtotal",
  "Discount",
  "Delivery fee",
  "HST",
  "Tip",
  "Total",
];

/**
 * Escapes one CSV field.
 *
 * The leading-apostrophe guard is not decoration. Excel and Sheets evaluate a
 * cell beginning `=`, `+`, `-` or `@` as a formula on open, so a customer who
 * types `=HYPERLINK(...)` into a delivery note gets it executed on the owner's
 * machine when they open the export. Quoting alone does not prevent that.
 */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** Cents to plain decimal dollars — the export lands in a spreadsheet. */
const money = (cents: unknown) => (Number(cents ?? 0) / 100).toFixed(2);

const stamp = (value: unknown) =>
  value ? new Date(Number(value)).toLocaleString("en-CA", { timeZone: "America/Toronto", hour12: false }) : "";

function toCsv(rows: Array<Record<string, unknown>>, canViewContact: boolean): string {
  const lines = [CSV_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.order_number,
        stamp(row.created_at),
        stamp(row.scheduled_for),
        row.channel,
        row.fulfilment,
        row.status,
        row.payment_method,
        row.payment_status,
        row.customer_name,
        // The redaction that applies on screen applies to the file too —
        // otherwise the export is the way around the permission.
        canViewContact ? row.customer_phone : "redacted",
        canViewContact ? row.customer_email : "redacted",
        money(row.subtotal_cents),
        money(row.discount_cents),
        money(row.delivery_fee_cents),
        money(row.tax_cents),
        money(row.tip_cents),
        money(row.total_cents),
      ]
        .map(csvField)
        .join(","),
    );
  }
  // CRLF and a UTF-8 BOM: Excel opens a plain LF UTF-8 file with the accents
  // mangled, and this data has French item names in it.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const body = (await request.json()) as { action?: string; id?: string; note?: string };
    if (body.action === "feedback.review") {
      if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "view_analytics")) {
        return Response.json({ error: "You do not have permission to handle feedback." }, { status: 403 });
      }
      const now = Date.now();
      const result = await getD1()
        .prepare("UPDATE feedback_responses SET reviewed_at = ?, internal_note = ? WHERE id = ?")
        .bind(now, body.note ? String(body.note).slice(0, 500) : null, body.id ?? "")
        .run();
      if (!result.meta.changes) return Response.json({ error: "That feedback no longer exists." }, { status: 404 });
      await writeAudit({ actorId: user.id, action: "feedback.review", targetType: "feedback", targetId: String(body.id) });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
