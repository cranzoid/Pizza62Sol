/**
 * Star PassPRNT bridge for the restaurant's Android till.
 *
 * The live app runs in Azure while the TSP143IIILAN is reachable only from the
 * restaurant LAN. PassPRNT is the local bridge: Chrome launches its URL scheme,
 * PassPRNT rasterizes this self-contained HTML, sends it to the configured Star
 * printer, optionally kicks the cash drawer, and returns to the kitchen board.
 *
 * Keep this module browser-independent. The URI and its ticket can be verified
 * without a DOM, and the React click handler remains a direct user gesture — an
 * important Android requirement for launching another application.
 */
import { formatMoney } from "@/lib/domain";
import { snapshotDetails, snapshotFlags, totalRows, type ItemSnapshot } from "@/lib/order-presentation";

type UnknownRecord = Record<string, unknown>;

export type PassPrntTicketInput = {
  order: UnknownRecord;
  toppingNames: Map<string, string>;
  printedAt: number;
  callbackUrl: string;
};

export type PassPrntDrawerInput = {
  callbackUrl: string;
};

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;

/** User/customer text is data, never markup. */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** encodeURIComponent plus the five characters RFC 3986 also reserves. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function ticketTime(value: number): string {
  return new Date(value).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
  });
}

/**
 * A complete 576-dot receipt. Styles are inline in the document because
 * PassPRNT receives this HTML through an Android Intent; it cannot reuse the
 * authenticated browser page's CSS bundle.
 */
export function buildPassPrntTicketHtml(
  order: UnknownRecord,
  toppingNames: Map<string, string>,
  printedAt: number,
): string {
  const items = Array.isArray(order.items) ? (order.items as UnknownRecord[]) : [];
  const address = asRecord(order.address);
  const scheduled = order.schedule_type === "scheduled" && order.scheduled_for
    ? Number(order.scheduled_for)
    : null;
  const paid = String(order.payment_status ?? "") === "paid";
  const origin = String(order.channel ?? "online") === "online"
    ? "WEBSITE"
    : String(order.channel ?? "").replaceAll("_", " ").toUpperCase();
  const payment = String(order.payment_method ?? "").replaceAll("_", " ").toUpperCase();

  const itemMarkup = items.map((item, index) => {
    const snapshot = (asRecord(item.snapshot) ?? {}) as ItemSnapshot;
    const flags = snapshotFlags(snapshot);
    const details = snapshotDetails(snapshot, toppingNames);
    const name = `${escapeHtml(item.productName)}${item.variationName ? ` &middot; ${escapeHtml(item.variationName)}` : ""}`;
    return `<section class="item" data-line="${index}">
      <div class="item-head"><span>${escapeHtml(item.quantity)}&times;</span><span>${name}</span></div>
      ${flags.map((flag) => `<div class="flag">** ${escapeHtml(flag).toUpperCase()} **</div>`).join("")}
      ${details.map((detail) => `<div class="sub"><b>${escapeHtml(detail.label).toUpperCase()}:</b> ${escapeHtml(detail.value)}</div>`).join("")}
      ${item.instructions ? `<div class="note">NOTE: ${escapeHtml(item.instructions)}</div>` : ""}
    </section>`;
  }).join("");

  const addressMarkup = address
    ? `<section class="address"><strong>DELIVER TO</strong>
        <div>${escapeHtml(address.line1)}${address.unit ? `, Unit ${escapeHtml(address.unit)}` : ""}</div>
        <div>${escapeHtml(address.city)} ${escapeHtml(address.postalCode)}</div>
        ${order.instructions ? `<div class="note">${escapeHtml(order.instructions)}</div>` : ""}
      </section>`
    : order.instructions
      ? `<div class="note">ORDER NOTE: ${escapeHtml(order.instructions)}</div>`
      : "";

  const moneyMarkup = totalRows({
    subtotal_cents: Number(order.subtotal_cents ?? 0),
    discount_cents: Number(order.discount_cents ?? 0),
    tax_cents: Number(order.tax_cents ?? 0),
    delivery_fee_cents: Number(order.delivery_fee_cents ?? 0),
    tip_cents: Number(order.tip_cents ?? 0),
    total_cents: Number(order.total_cents ?? 0),
  })
    .filter((row) => !row.strong)
    .map((row) => `<div class="money-row"><span>${escapeHtml(row.label)}</span><span>${escapeHtml(row.value)}</span></div>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;width:576px;background:#fff;color:#000}
body{font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.28;padding:0 18px;overflow-wrap:anywhere}
.head{text-align:center}.number{font-size:58px;font-weight:900;line-height:1}.type{font-size:28px;font-weight:900;letter-spacing:3px}
.when{text-align:center;font-size:22px;font-weight:700;margin-top:10px}.rule{border-top:2px dashed #000;margin:14px 0}
.customer{font-size:22px}.customer strong{font-size:25px}.origin{font-size:18px;letter-spacing:1px}
.item{margin-bottom:18px}.item-head{display:flex;gap:10px;font-size:27px;font-weight:900}.flag{font-size:25px;font-weight:900;text-align:center;margin:7px 0}
.sub{font-size:20px;margin-left:28px}.note{border:3px solid #000;font-size:22px;font-weight:900;margin:9px 0;padding:8px}
.address{font-size:22px}.money-row,.total{display:flex;justify-content:space-between;gap:16px}.money-row{font-size:20px;margin:4px 0}
.total{font-size:28px;font-weight:900;border-top:4px solid #000;border-bottom:4px solid #000;padding:10px 0;margin-top:10px}
.footer{text-align:center;font-size:16px;margin-top:14px}
</style></head><body>
  <header class="head"><div class="number">${escapeHtml(String(order.order_number ?? "").replace("P62-", "#"))}</div><div class="type">${escapeHtml(String(order.fulfilment ?? "").toUpperCase())}</div></header>
  <div class="when">${scheduled ? `SCHEDULED ${escapeHtml(ticketTime(scheduled))}` : `ASAP &mdash; in by ${escapeHtml(ticketTime(Number(order.created_at)))}`}</div>
  <div class="rule"></div>
  <section class="customer"><strong>${escapeHtml(order.customer_name)}</strong>${order.customer_phone ? `<div>${escapeHtml(order.customer_phone)}</div>` : ""}<div class="origin">${escapeHtml(origin)} &middot; ${escapeHtml(payment)}</div></section>
  <div class="rule"></div>
  ${itemMarkup}
  <div class="rule"></div>
  ${addressMarkup}
  ${addressMarkup ? `<div class="rule"></div>` : ""}
  <section>${moneyMarkup}</section>
  <div class="total"><span>${paid ? "PAID ONLINE" : "COLLECT"}</span><span>${escapeHtml(formatMoney(Number(order.total_cents ?? 0)))}</span></div>
  <footer class="footer">Pizza 62 &middot; printed ${escapeHtml(ticketTime(printedAt))}</footer>
</body></html>`;
}

/**
 * Build the URL Star documents for a no-preview, one-tap Android print.
 * `drawer=off` is explicit: printing a kitchen ticket and opening the cash
 * drawer are separate staff actions. A receipt must never kick the drawer.
 */
export function buildPassPrntUri(input: PassPrntTicketInput): string {
  const html = buildPassPrntTicketHtml(input.order, input.toppingNames, input.printedAt);
  const query = [
    `back=${encodeQueryValue(input.callbackUrl)}`,
    `html=${encodeQueryValue(html)}`,
    "size=576",
    "drawer=off",
    "drawerpulse=200",
    "cut=partial",
    "popup=enable",
  ].join("&");
  return `starpassprnt://v1/print/nopreview?${query}`;
}

/**
 * Open the printer-connected cash drawer without feeding or cutting paper.
 *
 * Star explicitly permits drawer=ahead/after without html, pdf or url data for
 * this scenario. `ahead` opens immediately; there is no print job to wait for.
 */
export function buildPassPrntDrawerUri(input: PassPrntDrawerInput): string {
  const query = [
    `back=${encodeQueryValue(input.callbackUrl)}`,
    "drawer=ahead",
    "drawerpulse=200",
    // `cut` defaults to partial. There is no print job to cut here, but saying
    // so explicitly is what keeps a cash payment from ever spitting paper.
    "cut=nocut",
    "popup=enable",
  ].join("&");
  return `starpassprnt://v1/print/nopreview?${query}`;
}

/** The restaurant print bridge is installed on its Samsung Android tablet. */
export function shouldUsePassPrnt(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}
