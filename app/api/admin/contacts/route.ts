/**
 * Admin → Customers: the parts that are not order history.
 *
 * - **Import** a customer list exported from the old POS. Always previewed
 *   first — the owner sees how many rows will be added, which columns were
 *   recognised and every row that will be skipped and why — and only written
 *   when they confirm.
 * - **Export** the whole list: everyone who has ordered plus everyone
 *   imported or entered at the till, with birthdays and whether each person
 *   may be emailed.
 * - **Upcoming birthdays**, for the counter's birthday treat.
 * - **Unsubscribe someone by hand**, for the customer who asks at the counter
 *   or on the phone rather than clicking the link. CASL treats that request
 *   exactly like a click.
 *
 * Reading follows `view_customer_contact`, like the directory it sits beside.
 * Importing also needs `manage_promotions`, because an import is who the next
 * nudge goes to; exporting needs `view_analytics`, as the directory export does.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { logFailure } from "@/lib/log";
import {
  birthdayLabel,
  contactSummary,
  exportAllContacts,
  importContacts,
  planContactImport,
  upcomingBirthdays,
} from "@/lib/customer-contacts";
import { normalizeEmail, recordOptOut } from "@/lib/marketing-consent";

/** About 2 MB of CSV — tens of thousands of customers, far past a year's POS. */
const MAX_CSV_LENGTH = 2_000_000;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_customer_contact");
    const url = new URL(request.url);

    if (url.searchParams.get("format") === "csv") {
      if (!hasPermission(user.role, user.permissions, "view_analytics")) {
        return Response.json({ error: "You do not have permission to export customers." }, { status: 403 });
      }
      const rows = await exportAllContacts();
      await writeAudit({
        actorId: user.id,
        action: "contacts.export",
        targetType: "customers",
        targetId: "csv",
        next: { rows: rows.length },
      });
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(contactsCsv(rows), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="pizza62-customer-list-${stamp}.csv"`,
          "cache-control": "no-store",
        },
      });
    }

    const [summary, birthdays] = await Promise.all([contactSummary(), upcomingBirthdays()]);
    return Response.json({
      summary,
      birthdays: birthdays.map((row) => ({ ...row, label: birthdayLabel(row.month, row.day) })),
      canImport: hasPermission(user.role, user.permissions, "manage_promotions"),
      canExport: hasPermission(user.role, user.permissions, "view_analytics"),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

type Body =
  | { action: "import.preview" | "import.commit"; csv?: string; fileName?: string }
  | { action: "optOut"; email?: string };

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_customer_contact");
    const body = (await request.json()) as Body;

    if (body.action === "optOut") {
      const email = normalizeEmail(String(body.email ?? ""));
      if (!/^\S+@\S+\.\S+$/.test(email)) return Response.json({ error: "Enter the email address to unsubscribe." }, { status: 422 });
      await recordOptOut(email);
      await writeAudit({ actorId: user.id, action: "contacts.opt_out", targetType: "customer_contact", targetId: email });
      return Response.json({ ok: true });
    }

    if (body.action !== "import.preview" && body.action !== "import.commit") {
      return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    if (!hasPermission(user.role, user.permissions, "manage_promotions")) {
      throw new AuthError(403, "You do not have permission to import customers.");
    }
    const csv = typeof body.csv === "string" ? body.csv : "";
    if (!csv.trim()) return Response.json({ error: "Choose a CSV file to import." }, { status: 422 });
    if (csv.length > MAX_CSV_LENGTH) {
      return Response.json({ error: "That file is too large. Split it and import each part." }, { status: 413 });
    }

    let plan: ReturnType<typeof planContactImport>;
    try {
      plan = planContactImport(csv);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "That file could not be read." }, { status: 422 });
    }

    if (body.action === "import.preview") {
      return Response.json({
        columns: plan.columns,
        ready: plan.contacts.length,
        withEmail: plan.contacts.filter((contact) => contact.email).length,
        withBirthday: plan.contacts.filter((contact) => contact.birthday).length,
        sample: plan.contacts.slice(0, 8).map((contact) => ({
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          birthday: contact.birthday ? birthdayLabel(contact.birthday.month, contact.birthday.day) : null,
        })),
        skipped: plan.skipped.length,
        skippedRows: plan.skipped.slice(0, 25),
      });
    }

    const result = await importContacts(plan.contacts);
    await writeAudit({
      actorId: user.id,
      action: "contacts.import",
      targetType: "customers",
      targetId: typeof body.fileName === "string" ? body.fileName.slice(0, 120) : "csv",
      next: { ...result, skipped: plan.skipped.length },
    });
    return Response.json({ ok: true, ...result, skipped: plan.skipped.length });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("admin.contacts", error);
    return Response.json({ error: "The import did not complete. Nothing was changed.", reference }, { status: 500 });
  }
}

function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function contactsCsv(rows: Array<Record<string, unknown>>): string {
  const day = (value: unknown) =>
    value ? new Date(Number(value)).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) : "";
  const lines = [
    ["Name", "Email", "Phone", "Birthday", "Orders", "Last order", "POS last visit", "Source", "Email marketing", "Notes"]
      .map(csvField)
      .join(","),
  ];
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.email,
        row.phone,
        row.birth_month ? birthdayLabel(Number(row.birth_month), Number(row.birth_day)) : "",
        row.orders,
        day(row.last_order_at),
        day(row.last_visit_at),
        row.source,
        !row.email ? "" : row.marketing_opt_out_at ? `unsubscribed ${day(row.marketing_opt_out_at)}` : "subscribed",
        row.notes,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
