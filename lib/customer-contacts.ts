/**
 * The customer list beyond order history: POS imports, birthdays, opt-outs.
 *
 * The customer directory is built from `orders`, which is the right source for
 * "who has ordered here" and cannot know about anyone who never has. Three
 * things need more than that, and all three land in `customer_contacts`:
 *
 * - **The old POS list.** Pizza 62 has a year of counter customers in its POS
 *   who have never touched this system. Importing its CSV export puts them in
 *   reach of the giveaway nudge.
 * - **Birthdays**, month and day only, from the till — so the counter can offer
 *   a regular something on their birthday. The year is never asked for and
 *   never stored.
 * - **Opt-outs**, written by `lib/marketing-consent.ts`.
 *
 * The CSV parsing is pure and tested without a database. It deliberately
 * accepts whatever column names the POS uses (Loyverse says "Customer name",
 * Clover says "First Name" and "Last Name", a spreadsheet says "Mobile"),
 * because the alternative is asking the owner to rename columns before an
 * import, which is how an import does not happen.
 */
import { getD1 } from "@/db/runtime";
import { ELIGIBLE_ORDER_SQL } from "@/lib/giveaway-store";

// --- CSV ---------------------------------------------------------------------

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside
 * quotes, CRLF or LF, and the byte-order mark Excel writes at the front.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "customer name", "customer", "full name", "client name", "contact name"],
  firstName: ["first name", "firstname", "given name"],
  lastName: ["last name", "lastname", "surname", "family name"],
  email: ["email", "e-mail", "email address", "e-mail address", "customer email"],
  phone: ["phone", "phone number", "mobile", "mobile number", "cell", "cell phone", "telephone", "tel", "customer phone"],
  birthday: ["birthday", "birth date", "birthdate", "date of birth", "dob"],
  notes: ["note", "notes", "comment", "comments"],
  lastVisit: ["last visit", "last visit date", "last order", "last order date", "last purchase", "last seen"],
};

function headerKey(header: string): string | null {
  const clean = header.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(clean)) return key;
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function validBirthday(month: number, day: number): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1];
}

/**
 * A birthday as month and day, whatever shape the POS wrote it in. The year,
 * if there is one, is read past and thrown away.
 *
 * Slashed dates are read month-first (`03/04` is March 4), the North American
 * convention and what Canadian POS exports use — unless the first number
 * cannot be a month, in which case it is plainly the day.
 */
export function parseBirthday(value: string): { month: number; day: number } | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  let month = 0;
  let day = 0;
  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = text.match(/^-{0,2}(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/))) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    [month, day] = first > 12 && second <= 12 ? [second, first] : [first, second];
  } else if ((match = text.match(/^([a-z]{3,})\.?\s+(\d{1,2})/))) {
    month = MONTHS.indexOf(match[1].slice(0, 3)) + 1;
    day = Number(match[2]);
  } else if ((match = text.match(/^(\d{1,2})\s+([a-z]{3,})/))) {
    day = Number(match[1]);
    month = MONTHS.indexOf(match[2].slice(0, 3)) + 1;
  }
  return validBirthday(month, day) ? { month, day } : null;
}

function parseVisit(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Digits only, the same identity the customer directory groups phones by. */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

export type ImportedContact = {
  name: string;
  email: string | null;
  phone: string | null;
  birthday: { month: number; day: number } | null;
  notes: string | null;
  lastVisitAt: number | null;
};

export type ImportPlan = {
  contacts: ImportedContact[];
  /** Rows left out, with why — shown on the preview so nothing vanishes silently. */
  skipped: Array<{ row: number; reason: string }>;
  columns: Record<string, string>;
};

/**
 * Turns a CSV export into contacts, or explains why it cannot.
 *
 * A row needs an email or a phone number — something to reach the person by.
 * An email that does not look like one is dropped rather than imported,
 * because an address the provider will bounce counts against the sender.
 * Duplicate emails inside one file collapse to the first.
 */
export function planContactImport(text: string, limit = 20_000): ImportPlan {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("That file is empty.");
  const header = rows[0];
  const columnIndex: Record<string, number> = {};
  const columns: Record<string, string> = {};
  header.forEach((title, index) => {
    const key = headerKey(title);
    if (key && !(key in columnIndex)) {
      columnIndex[key] = index;
      columns[key] = title.trim();
    }
  });
  if (!("email" in columnIndex) && !("phone" in columnIndex)) {
    throw new Error("No email or phone column was found. The first row of the file should be its column names.");
  }
  if (rows.length - 1 > limit) throw new Error(`That file has more than ${limit.toLocaleString("en-CA")} customers. Split it and import each part.`);

  const cell = (row: string[], key: string) => (key in columnIndex ? (row[columnIndex[key]] ?? "").trim() : "");
  const contacts: ImportedContact[] = [];
  const skipped: ImportPlan["skipped"] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    const rawEmail = cell(row, "email").toLowerCase();
    const email = rawEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) && rawEmail.length <= 254 ? rawEmail : null;
    const phoneDigits = normalizePhone(cell(row, "phone"));
    const phone = phoneDigits.length >= 10 && phoneDigits.length <= 15 ? phoneDigits : null;
    if (!email && !phone) {
      skipped.push({ row: rowNumber, reason: rawEmail ? `"${rawEmail}" is not a valid email and there is no phone number` : "No email or phone number" });
      return;
    }
    if (email ? seenEmails.has(email) : phone && seenPhones.has(phone)) {
      skipped.push({ row: rowNumber, reason: `Duplicate of an earlier row (${email ?? phone})` });
      return;
    }
    if (email) seenEmails.add(email);
    else if (phone) seenPhones.add(phone);
    const name =
      cell(row, "name") || [cell(row, "firstName"), cell(row, "lastName")].filter(Boolean).join(" ");
    contacts.push({
      name: name.slice(0, 100),
      email,
      phone,
      birthday: parseBirthday(cell(row, "birthday")),
      notes: cell(row, "notes").slice(0, 500) || null,
      lastVisitAt: parseVisit(cell(row, "lastVisit")),
    });
  });
  return { contacts, skipped, columns };
}

// --- database ----------------------------------------------------------------

/**
 * Writes an import. What is already known wins over what the file says: a
 * name, phone or birthday someone gave the counter is newer than a POS export.
 * An opt-out is never touched — importing a list must not re-subscribe anyone.
 */
export async function importContacts(contacts: ImportedContact[], now: number = Date.now()): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (let start = 0; start < contacts.length; start += 200) {
    const statements = contacts.slice(start, start + 200).map((contact) => {
      if (contact.email) {
        return getD1()
          .prepare(
            `INSERT INTO customer_contacts
             (id, email, phone, name, birth_month, birth_day, source, notes, last_visit_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
             ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
               phone = COALESCE(customer_contacts.phone, EXCLUDED.phone),
               name = CASE WHEN customer_contacts.name = '' THEN EXCLUDED.name ELSE customer_contacts.name END,
               birth_day = CASE WHEN customer_contacts.birth_month IS NULL THEN EXCLUDED.birth_day ELSE customer_contacts.birth_day END,
               birth_month = COALESCE(customer_contacts.birth_month, EXCLUDED.birth_month),
               notes = COALESCE(customer_contacts.notes, EXCLUDED.notes),
               last_visit_at = GREATEST(customer_contacts.last_visit_at, EXCLUDED.last_visit_at),
               updated_at = EXCLUDED.updated_at
             RETURNING (xmax = 0) AS inserted`,
          )
          .bind(
            crypto.randomUUID(),
            contact.email,
            contact.phone,
            contact.name,
            contact.birthday?.month ?? null,
            contact.birthday?.day ?? null,
            contact.notes,
            contact.lastVisitAt,
            now,
            now,
          );
      }
      // Phone only: there is no unique key to conflict on, so "insert unless a
      // phone-only row already exists" and a companion update are one statement.
      return getD1()
        .prepare(
          `WITH existing AS (
             UPDATE customer_contacts SET
               name = CASE WHEN name = '' THEN ? ELSE name END,
               birth_day = CASE WHEN birth_month IS NULL THEN ? ELSE birth_day END,
               birth_month = COALESCE(birth_month, ?),
               notes = COALESCE(notes, ?),
               last_visit_at = GREATEST(last_visit_at, ?),
               updated_at = ?
             WHERE phone = ? AND email IS NULL
             RETURNING id
           )
           INSERT INTO customer_contacts
           (id, email, phone, name, birth_month, birth_day, source, notes, last_visit_at, created_at, updated_at)
           SELECT ?, NULL, ?, ?, ?, ?, 'import', ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING true AS inserted`,
        )
        .bind(
          contact.name,
          contact.birthday?.day ?? null,
          contact.birthday?.month ?? null,
          contact.notes,
          contact.lastVisitAt,
          now,
          contact.phone,
          crypto.randomUUID(),
          contact.phone,
          contact.name,
          contact.birthday?.month ?? null,
          contact.birthday?.day ?? null,
          contact.notes,
          contact.lastVisitAt,
          now,
          now,
        );
    });
    const results = await getD1().batch<{ inserted: boolean }>(statements);
    for (const result of results) {
      if (result.results[0]?.inserted) created += 1;
      else updated += 1;
    }
  }
  return { created, updated };
}

/**
 * A birthday given at the till, filed against whoever the order was for.
 *
 * By email when one was given, otherwise by phone. With neither there is no
 * one to file it against, so the till asks for one before it offers the
 * field. Unlike an import, this overwrites: the customer just said it.
 */
export async function saveBirthday(
  input: { name: string; email: string; phone: string; month: number; day: number },
  now: number = Date.now(),
): Promise<boolean> {
  if (!validBirthday(input.month, input.day)) return false;
  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const name = input.name.trim() === "Counter" ? "" : input.name.trim().slice(0, 100);
  if (email) {
    await getD1()
      .prepare(
        `INSERT INTO customer_contacts (id, email, phone, name, birth_month, birth_day, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'till', ?, ?)
         ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
           birth_month = EXCLUDED.birth_month, birth_day = EXCLUDED.birth_day,
           phone = COALESCE(EXCLUDED.phone, customer_contacts.phone),
           name = CASE WHEN EXCLUDED.name = '' THEN customer_contacts.name ELSE EXCLUDED.name END,
           updated_at = EXCLUDED.updated_at`,
      )
      .bind(crypto.randomUUID(), email, phone || null, name, input.month, input.day, now, now)
      .run();
    return true;
  }
  if (phone.length < 10) return false;
  await getD1()
    .prepare(
      `WITH existing AS (
         UPDATE customer_contacts SET birth_month = ?, birth_day = ?,
           name = CASE WHEN ? = '' THEN name ELSE ? END, updated_at = ?
         WHERE phone = ? AND email IS NULL
         RETURNING id
       )
       INSERT INTO customer_contacts (id, email, phone, name, birth_month, birth_day, source, created_at, updated_at)
       SELECT ?, NULL, ?, ?, ?, ?, 'till', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM existing)`,
    )
    .bind(input.month, input.day, name, name, now, phone, crypto.randomUUID(), phone, name, input.month, input.day, now, now)
    .run();
  return true;
}

export type BirthdayRow = { name: string; email: string | null; phone: string | null; month: number; day: number; daysAway: number };

/**
 * Birthdays in the next `days` days, soonest first, counted in Toronto dates.
 * Read whole and filtered here: a birthday list is small, and "within the next
 * month" wraps around the new year in a way SQL makes harder than it is.
 */
export async function upcomingBirthdays(now: number = Date.now(), days = 31): Promise<BirthdayRow[]> {
  const rows = await getD1()
    .prepare("SELECT name, email, phone, birth_month, birth_day FROM customer_contacts WHERE birth_month IS NOT NULL")
    .all<{ name: string; email: string | null; phone: string | null; birth_month: number; birth_day: number }>();
  const [year, month, day] = new Date(now)
    .toLocaleDateString("en-CA", { timeZone: "America/Toronto" })
    .split("-")
    .map(Number);
  const today = Date.UTC(year, month - 1, day);
  return rows.results
    .map((row) => {
      let next = Date.UTC(year, row.birth_month - 1, row.birth_day);
      if (next < today) next = Date.UTC(year + 1, row.birth_month - 1, row.birth_day);
      return {
        name: row.name,
        email: row.email,
        phone: row.phone,
        month: Number(row.birth_month),
        day: Number(row.birth_day),
        daysAway: Math.round((next - today) / 86_400_000),
      };
    })
    .filter((row) => row.daysAway <= days)
    .sort((left, right) => left.daysAway - right.daysAway || left.name.localeCompare(right.name));
}

/** The birthday on file for one customer directory key, if any. */
export async function birthdayForCustomerKey(key: string): Promise<{ month: number; day: number } | null> {
  const [kind, value] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (!value || (kind !== "email" && kind !== "phone")) return null;
  const row = await getD1()
    .prepare(
      kind === "email"
        ? "SELECT birth_month, birth_day FROM customer_contacts WHERE email = ? AND birth_month IS NOT NULL"
        : "SELECT birth_month, birth_day FROM customer_contacts WHERE phone = ? AND birth_month IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(value)
    .first<{ birth_month: number; birth_day: number }>();
  return row ? { month: Number(row.birth_month), day: Number(row.birth_day) } : null;
}

export async function contactSummary(): Promise<{ contacts: number; imported: number; birthdays: number; optedOut: number }> {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS contacts,
              COUNT(*) FILTER (WHERE source = 'import') AS imported,
              COUNT(*) FILTER (WHERE birth_month IS NOT NULL) AS birthdays,
              COUNT(*) FILTER (WHERE marketing_opt_out_at IS NOT NULL) AS opted_out
       FROM customer_contacts`,
    )
    .first<{ contacts: number; imported: number; birthdays: number; opted_out: number }>();
  return {
    contacts: Number(row?.contacts ?? 0),
    imported: Number(row?.imported ?? 0),
    birthdays: Number(row?.birthdays ?? 0),
    optedOut: Number(row?.opted_out ?? 0),
  };
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function birthdayLabel(month: number, day: number): string {
  return `${MONTH_NAMES[month - 1] ?? "?"} ${day}`;
}

/**
 * Everyone, for the "export full list" button: every customer the order
 * history knows plus every imported or till-entered contact, merged on the
 * same email-or-phone identity the directory uses, with birthday and whether
 * they may be emailed.
 */
export async function exportAllContacts(): Promise<Array<Record<string, unknown>>> {
  const rows = await getD1()
    .prepare(
      `WITH ordered AS (
         SELECT CASE WHEN o.customer_email <> '' THEN 'email:' || lower(o.customer_email)
                     ELSE 'phone:' || regexp_replace(o.customer_phone, '\\D', '', 'g') END AS key,
                o.customer_name, o.customer_email, o.customer_phone, o.created_at,
                CASE WHEN ${ELIGIBLE_ORDER_SQL} THEN 1 ELSE 0 END AS bought
         FROM orders o
         WHERE o.customer_email <> '' OR regexp_replace(o.customer_phone, '\\D', '', 'g') <> ''
       ),
       from_orders AS (
         SELECT DISTINCT ON (key) key, customer_name AS name, lower(customer_email) AS email, customer_phone AS phone,
                COUNT(*) OVER (PARTITION BY key) AS orders,
                SUM(bought) OVER (PARTITION BY key) AS bought_orders,
                MAX(created_at) OVER (PARTITION BY key) AS last_order_at
         FROM ordered ORDER BY key, created_at DESC
       ),
       contacts AS (
         SELECT CASE WHEN email IS NOT NULL THEN 'email:' || email ELSE 'phone:' || phone END AS key,
                name, email, phone, birth_month, birth_day, source, notes, last_visit_at, marketing_opt_out_at
         FROM customer_contacts
       )
       SELECT COALESCE(NULLIF(f.name, ''), c.name, '') AS name,
              COALESCE(f.email, c.email, '') AS email,
              COALESCE(NULLIF(f.phone, ''), c.phone, '') AS phone,
              c.birth_month, c.birth_day,
              COALESCE(f.orders, 0) AS orders,
              COALESCE(f.bought_orders, 0) AS bought_orders,
              f.last_order_at, c.last_visit_at,
              CASE WHEN f.key IS NOT NULL AND c.source = 'import' THEN 'orders + POS import'
                   WHEN f.key IS NOT NULL THEN 'orders'
                   WHEN c.source = 'import' THEN 'POS import'
                   WHEN c.source = 'till' THEN 'till'
                   ELSE 'unsubscribe request' END AS source,
              c.notes, c.marketing_opt_out_at
       FROM from_orders f FULL OUTER JOIN contacts c ON c.key = f.key
       ORDER BY COALESCE(f.last_order_at, c.last_visit_at, 0) DESC`,
    )
    .all<Record<string, unknown>>();
  return rows.results;
}
