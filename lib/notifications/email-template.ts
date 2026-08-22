/**
 * The house style for every email this system sends.
 *
 * Until now every message left as plain text. That was fine while the only
 * question was "did it arrive", but the confirmation is the first thing a
 * customer sees with the restaurant's name on it and the only artefact of the
 * order they keep — a wall of monospace text reads like a system log, not like
 * Pizza 62.
 *
 * ## Why the markup looks like it is from 2004
 *
 * Because email clients are. Outlook renders with Word's HTML engine, Gmail
 * strips `<style>` blocks on some clients, and nothing supports flexbox or grid
 * reliably. So:
 *
 * - **Tables for layout, not divs.** A `<table>` is the only box model every
 *   client agrees on.
 * - **Every style is inline.** There is no stylesheet to strip.
 * - **No external CSS, no web fonts, no background images.** Georgia and Arial
 *   are on every machine that will open this; a font that has to load is a font
 *   that will not.
 * - **Images carry their meaning in `alt`.** Most clients block remote images by
 *   default, so nothing that matters may live only in a picture.
 *
 * ## Palette
 *
 * The same tokens as `app/globals.css`, hard-coded because an email cannot read
 * a CSS custom property. If the site's palette moves, these move with it.
 */

export const BRAND = {
  ink: "#17140f",
  cream: "#f5ebd7",
  paper: "#fffaf0",
  red: "#d33b27",
  redDark: "#a72518",
  green: "#244b39",
  yellow: "#f2b83b",
  muted: "#766e61",
  line: "#e2d8c4",
  white: "#ffffff",
} as const;

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Arial, Helvetica, sans-serif";

export const RESTAURANT = {
  name: "Pizza 62",
  address: "55 Parkdale Ave N, Hamilton, ON L8H 5W7",
  phone: "(905) 547-5777",
  phoneHref: "tel:+19055475777",
} as const;

/**
 * HTML-escapes a value for interpolation into markup.
 *
 * Everything that reaches these templates is customer input at one remove — a
 * name, an order note, a topping label the owner typed into the admin screen. An
 * apostrophe in "Rob's usual" must not be able to close an attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type EmailTone = "confirmation" | "alert" | "status" | "feedback";

/**
 * Two colours per tone, not one.
 *
 * `text` sits on the pale paper of the body, so it has to be dark enough to read
 * as type. `bar` sits directly under the dark-green masthead, so it has to be
 * light enough to be seen at all — green-on-green is a rule nobody can see, and
 * an accent that disappears on the most common message is not an accent.
 */
function toneColours(tone: EmailTone): { text: string; bar: string } {
  switch (tone) {
    case "alert":
      return { text: BRAND.red, bar: BRAND.red };
    case "feedback":
      return { text: BRAND.redDark, bar: BRAND.yellow };
    case "status":
    case "confirmation":
      return { text: BRAND.green, bar: BRAND.yellow };
  }
}

export type Section =
  /** A short run of prose. */
  | { type: "paragraph"; text: string }
  /** A boxed headline figure — the order number, the new status. */
  | { type: "callout"; label: string; value: string; note?: string; tone?: "neutral" | "good" | "warn" }
  /** Label/value pairs, e.g. when the order is due and how it is being paid. */
  | { type: "facts"; rows: Array<{ label: string; value: string }> }
  /** The itemised order. Each line may carry its own detail rows. */
  | { type: "items"; items: EmailItem[] }
  /** The money. The last row is emphasised. */
  | { type: "totals"; rows: Array<{ label: string; value: string; strong?: boolean }> }
  /** A single, unmissable action. */
  | { type: "button"; label: string; href: string }
  /** A quiet aside — the delivery address, a note to the kitchen. */
  | { type: "note"; title?: string; lines: string[] }
  | { type: "divider" };

export type EmailItem = {
  quantity: number;
  name: string;
  variation?: string | null;
  price?: string | null;
  /** Preparation-critical flags: HALAL, EXTRA CHEESE, NO MUSHROOMS. */
  flags?: string[];
  /** Everything the customer chose, already grouped and labelled. */
  details?: Array<{ label: string; value: string }>;
  note?: string | null;
};

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.6;color:${BRAND.ink};">${escapeHtml(text)}</p>`;
}

function callout(section: Extract<Section, { type: "callout" }>): string {
  const accent =
    section.tone === "good" ? BRAND.green : section.tone === "warn" ? BRAND.red : BRAND.ink;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">
  <tr><td style="background-color:${BRAND.cream};border-left:4px solid ${accent};padding:16px 20px;">
    <div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(section.label)}</div>
    <div style="font-family:${SERIF};font-size:26px;line-height:1.2;font-weight:bold;color:${accent};padding-top:4px;">${escapeHtml(section.value)}</div>
    ${section.note ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.muted};padding-top:6px;">${escapeHtml(section.note)}</div>` : ""}
  </td></tr>
</table>`;
}

function facts(rows: Array<{ label: string; value: string }>): string {
  if (!rows.length) return "";
  const cells = rows
    .map(
      (row) => `<tr>
    <td style="padding:7px 0;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color:${BRAND.muted};white-space:nowrap;vertical-align:top;width:40%;">${escapeHtml(row.label)}</td>
    <td style="padding:7px 0;font-family:${SANS};font-size:14px;line-height:1.5;color:${BRAND.ink};vertical-align:top;">${escapeHtml(row.value)}</td>
  </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">${cells}</table>`;
}

/**
 * One order line, with everything chosen on it underneath.
 *
 * The detail rows are the point of this whole file: a confirmation that says
 * "1 x Large Pizza" and stops is the thing the customer cannot check, and the
 * thing that turns a wrong order into an argument. Placement, omissions and
 * every modifier group are printed.
 */
function items(list: EmailItem[]): string {
  if (!list.length) return "";
  const rows = list
    .map((item, index) => {
      const flags = (item.flags ?? []).length
        ? `<div style="padding-top:6px;">${(item.flags ?? [])
            .map(
              (flag) =>
                `<span style="display:inline-block;background-color:${BRAND.yellow};color:${BRAND.ink};font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;margin:0 6px 4px 0;">${escapeHtml(flag)}</span>`,
            )
            .join("")}</div>`
        : "";
      const details = (item.details ?? []).length
        ? `<div style="padding-top:8px;">${(item.details ?? [])
            .map(
              (detail) =>
                `<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${BRAND.ink};padding:1px 0;"><span style="color:${BRAND.muted};">${escapeHtml(detail.label)}:</span> ${escapeHtml(detail.value)}</div>`,
            )
            .join("")}</div>`
        : "";
      const note = item.note
        ? `<div style="margin-top:8px;padding:8px 10px;background-color:${BRAND.cream};font-family:${SANS};font-size:13px;line-height:1.5;color:${BRAND.ink};"><strong>Note:</strong> ${escapeHtml(item.note)}</div>`
        : "";
      return `<tr>
    <td style="padding:14px 0;border-top:${index === 0 ? "0" : `1px solid ${BRAND.line}`};vertical-align:top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:top;font-family:${SERIF};font-size:17px;font-weight:bold;color:${BRAND.ink};">
            ${escapeHtml(String(item.quantity))} &times; ${escapeHtml(item.name)}${item.variation ? `<span style="font-family:${SANS};font-size:13px;font-weight:normal;color:${BRAND.muted};"> &middot; ${escapeHtml(item.variation)}</span>` : ""}
          </td>
          ${item.price ? `<td align="right" style="vertical-align:top;font-family:${SANS};font-size:15px;font-weight:bold;color:${BRAND.ink};white-space:nowrap;padding-left:12px;">${escapeHtml(item.price)}</td>` : ""}
        </tr>
      </table>
      ${flags}${details}${note}
    </td>
  </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;border-collapse:collapse;">${rows}</table>`;
}

function totals(rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  if (!rows.length) return "";
  const cells = rows
    .map(
      (row) => `<tr>
    <td style="padding:${row.strong ? "12px 0 0" : "5px 0"};border-top:${row.strong ? `2px solid ${BRAND.ink}` : "0"};font-family:${SANS};font-size:${row.strong ? "16px" : "14px"};font-weight:${row.strong ? "bold" : "normal"};color:${row.strong ? BRAND.ink : BRAND.muted};">${escapeHtml(row.label)}</td>
    <td align="right" style="padding:${row.strong ? "12px 0 0" : "5px 0"};border-top:${row.strong ? `2px solid ${BRAND.ink}` : "0"};font-family:${SANS};font-size:${row.strong ? "18px" : "14px"};font-weight:bold;color:${BRAND.ink};white-space:nowrap;">${escapeHtml(row.value)}</td>
  </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;border-collapse:collapse;">${cells}</table>`;
}

/**
 * A button that survives Outlook.
 *
 * Outlook ignores padding on an anchor, so the padding lives on the table cell
 * and the anchor is stretched over it. This is the standard "bulletproof button"
 * shape and the reason it is a table rather than an `<a>` with a border-radius.
 */
function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-collapse:collapse;">
  <tr><td align="center" bgcolor="${BRAND.red}" style="background-color:${BRAND.red};padding:14px 30px;">
    <a href="${escapeHtml(href)}" style="font-family:${SANS};font-size:14px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color:${BRAND.white};text-decoration:none;display:inline-block;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

function note(section: Extract<Section, { type: "note" }>): string {
  const body = section.lines
    .filter(Boolean)
    .map(
      (line) =>
        `<div style="font-family:${SANS};font-size:14px;line-height:1.6;color:${BRAND.ink};">${escapeHtml(line)}</div>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">
  <tr><td style="background-color:${BRAND.cream};padding:14px 18px;">
    ${section.title ? `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:${BRAND.muted};padding-bottom:5px;">${escapeHtml(section.title)}</div>` : ""}
    ${body}
  </td></tr>
</table>`;
}

function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;"><tr><td style="border-top:1px solid ${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

function renderSection(section: Section): string {
  switch (section.type) {
    case "paragraph":
      return paragraph(section.text);
    case "callout":
      return callout(section);
    case "facts":
      return facts(section.rows);
    case "items":
      return items(section.items);
    case "totals":
      return totals(section.rows);
    case "button":
      return button(section.label, section.href);
    case "note":
      return note(section);
    case "divider":
      return divider();
  }
}

export type EmailDocument = {
  /** Sits above the header, in the tone colour. */
  eyebrow: string;
  /** The one line the reader should take away. */
  heading: string;
  tone?: EmailTone;
  sections: Section[];
  /**
   * The line under the sender block, before the address. Left off for staff
   * mail, where "Questions? Call us" is nonsense.
   */
  signoff?: string;
  /** Absolute base URL, so the logo can be linked. Omitted if unknown. */
  baseUrl?: string | null;
  /**
   * Shown in the inbox preview line next to the subject. Hidden in the body
   * itself — without one, clients scrape the first visible text, which is the
   * eyebrow, and every message previews identically.
   */
  preheader?: string;
};

/**
 * Wraps sections in the Pizza 62 shell and returns a complete HTML document.
 */
export function renderEmailHtml(document: EmailDocument): string {
  const { text: accent, bar } = toneColours(document.tone ?? "confirmation");
  const body = document.sections.map(renderSection).join("\n");
  const logo = document.baseUrl
    ? `<img src="${escapeHtml(document.baseUrl)}/logo.png" width="150" height="57" alt="${RESTAURANT.name}" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:150px;" />`
    : `<div style="font-family:${SERIF};font-size:30px;font-weight:bold;letter-spacing:-1px;color:${BRAND.paper};">${RESTAURANT.name}</div>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(document.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${
  document.preheader
    ? `<div style="display:none;font-size:1px;color:${BRAND.cream};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(document.preheader)}</div>`
    : ""
}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.cream};border-collapse:collapse;">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;">

  <!-- Masthead. Dark green so the wordmark reads the way it does on the site's
       footer, and so the message is recognisable before a single word is read. -->
  <tr><td style="background-color:${BRAND.green};padding:26px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td style="vertical-align:middle;">${logo}</td>
        <td align="right" style="vertical-align:middle;font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:${BRAND.yellow};">Hamilton, ON</td>
      </tr>
    </table>
  </td></tr>

  <!-- A rule in the tone colour: the brand yellow for a customer's good news,
       red when the kitchen has to look at something now. -->
  <tr><td style="background-color:${bar};font-size:0;line-height:0;height:5px;">&nbsp;</td></tr>

  <tr><td style="background-color:${BRAND.paper};padding:30px 32px 8px;">
    <div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.8px;text-transform:uppercase;color:${accent};padding-bottom:8px;">${escapeHtml(document.eyebrow)}</div>
    <h1 style="margin:0 0 18px;font-family:${SERIF};font-size:28px;line-height:1.2;font-weight:bold;letter-spacing:-.5px;color:${BRAND.ink};">${escapeHtml(document.heading)}</h1>
  </td></tr>

  <tr><td style="background-color:${BRAND.paper};padding:0 32px 26px;">
${body}
  </td></tr>

  <tr><td style="background-color:${BRAND.ink};padding:24px 32px;">
    ${
      document.signoff
        ? `<div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${BRAND.cream};padding-bottom:12px;">${escapeHtml(document.signoff)}</div>`
        : ""
    }
    <div style="font-family:${SERIF};font-size:17px;font-weight:bold;color:${BRAND.paper};">${RESTAURANT.name}</div>
    <div style="font-family:${SANS};font-size:12px;line-height:1.7;color:#a9a196;padding-top:4px;">
      ${RESTAURANT.address}<br />
      <a href="${RESTAURANT.phoneHref}" style="color:${BRAND.yellow};text-decoration:none;">${RESTAURANT.phone}</a>
    </div>
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}

/**
 * The same document as plain text.
 *
 * Not a fallback nobody reads: it is what every SMS-to-email gateway, screen
 * reader in text mode, and spam filter sees, and a message with no text part
 * scores worse for deliverability than one with both. Generated from the same
 * sections so the two cannot drift.
 */
export function renderEmailText(document: EmailDocument): string {
  const lines: string[] = [document.heading.toUpperCase(), ""];
  for (const section of document.sections) {
    switch (section.type) {
      case "paragraph":
        lines.push(section.text, "");
        break;
      case "callout":
        lines.push(`${section.label.toUpperCase()}: ${section.value}`);
        if (section.note) lines.push(section.note);
        lines.push("");
        break;
      case "facts":
        for (const row of section.rows) lines.push(`${row.label}: ${row.value}`);
        lines.push("");
        break;
      case "items":
        for (const item of section.items) {
          lines.push(
            `${item.quantity} x ${item.name}${item.variation ? ` (${item.variation})` : ""}${item.price ? ` — ${item.price}` : ""}`,
          );
          for (const flag of item.flags ?? []) lines.push(`    ** ${flag} **`);
          for (const detail of item.details ?? []) lines.push(`    ${detail.label}: ${detail.value}`);
          if (item.note) lines.push(`    Note: ${item.note}`);
        }
        lines.push("");
        break;
      case "totals":
        for (const row of section.rows) lines.push(`${row.label}: ${row.value}`);
        lines.push("");
        break;
      case "button":
        lines.push(`${section.label}: ${section.href}`, "");
        break;
      case "note":
        if (section.title) lines.push(section.title.toUpperCase());
        lines.push(...section.lines.filter(Boolean), "");
        break;
      case "divider":
        lines.push("—".repeat(40), "");
        break;
    }
  }
  if (document.signoff) lines.push(document.signoff, "");
  lines.push(`${RESTAURANT.name} · ${RESTAURANT.address} · ${RESTAURANT.phone}`);
  // Collapse the runs of blank lines the section loop leaves behind.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
