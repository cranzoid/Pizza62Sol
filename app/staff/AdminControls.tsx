"use client";

import { FormEvent, useState } from "react";
import { formatMoney, type ModifierSection as DomainModifierSection } from "@/lib/domain";
import { MAX_UPLOAD_BYTES } from "@/lib/image-validation";
import type { Dashboard } from "@/app/staff/StaffPortal";

type Product = Dashboard["products"][number];
type Topping = Dashboard["toppings"][number];
type Category = Dashboard["categories"][number];
type Variation = Dashboard["variations"][number];
type StaffMember = Dashboard["staff"][number];
type ModifierSection = DomainModifierSection;

const allPermissions = [
  ["view_orders", "View orders"], ["acknowledge_orders", "Acknowledge orders"],
  ["change_order_status", "Change order status"], ["view_customer_contact", "Customer contact"],
  ["change_preparation_time", "Preparation time"], ["pause_online_ordering", "Pause ordering"],
  ["mark_products_unavailable", "Product availability"], ["cancel_orders", "Cancel orders"],
  ["issue_refunds", "Issue refunds"], ["manage_menu", "Manage menu"],
  ["manage_promotions", "Manage promotions"], ["manage_employees", "Manage employees"],
  ["edit_time_records", "Edit time records"], ["approve_correction_requests", "Approve corrections"],
  ["approve_time_off_requests", "Approve time off"], ["view_analytics", "View analytics"],
  ["export_payroll", "Export payroll"], ["manage_settings", "Manage settings"],
] as const;

async function configRequest(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { error?: string; [key: string]: unknown };
  if (!response.ok) throw new Error(result.error ?? "The change could not be saved.");
  return result;
}

type UploadedImage = { url: string; width?: number; height?: number };

const OVERSIZE_MESSAGE = `That picture is still over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB after resizing. Export a smaller JPG and try again.`;

/**
 * The long edge we keep. Menu cards render at 1200 × 675 and the hero goes
 * full-bleed, so 1600 stays sharp on a dense screen without paying for pixels
 * nobody sees.
 */
const MAX_STORED_EDGE = 1600;

/**
 * Below this, re-encoding gives back less than it costs — and a logo with sharp
 * edges comes out of a lossy encoder looking worse than it went in.
 */
const ALREADY_SMALL_BYTES = 400 * 1024;

/**
 * Shrinks a chosen picture before it is uploaded.
 *
 * The upload route stores the bytes it is given and serves them back unchanged,
 * so whatever comes off a phone is what every customer downloads. That is not
 * hypothetical: the first product photo on the live menu was a 2.4 MB, 1672-wide
 * PNG that took about nine seconds to arrive, and there is no CDN in front of it
 * to soften the second visit. The same picture at 1200 × 675 in WebP is about
 * 116 KB — the same thing to look at, a twentieth of the wait.
 *
 * Doing it here rather than on the server is deliberate. The canvas is already
 * in the browser, so it costs no dependency, and `lib/image-validation.ts`
 * explains why a native image library in the container was worth avoiding. It
 * also makes the upload itself small, which is the other half of the wait.
 *
 * Every failure path returns the original file. A picture that uploads slowly is
 * a worse menu; a picture that will not upload at all is a broken one.
 */
async function prepareImage(file: File): Promise<File> {
  // A canvas round-trip flattens an animated GIF to its first frame, and a file
  // this small has nothing to gain. Both are sent exactly as chosen.
  if (file.type === "image/gif" || file.size <= ALREADY_SMALL_BYTES) return file;
  try {
    // `from-image` because a canvas ignores EXIF orientation otherwise, and a
    // photo shot in portrait on a phone would be stored on its side.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_STORED_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    // A browser that cannot export WebP hands back a PNG under that name, which
    // is larger than what the owner chose. So the result has to earn its place.
    if (!encoded || encoded.type !== "image/webp" || encoded.size >= file.size) return file;
    return new File([encoded], `${file.name.replace(/\.[^.]+$/, "")}.webp`, { type: "image/webp" });
  } catch {
    return file;
  }
}

/**
 * Sends one image to `/api/uploads` and reads the answer without assuming it is
 * JSON.
 *
 * A refused upload does not always come back from our own handler. A body over
 * the framework's multipart limit is turned away before the route is matched,
 * and an ingress in front of the app can answer in plain text or with nothing at
 * all — a 413 sent while the browser is still writing the body arrives with its
 * own body truncated. `response.json()` on any of those threw "Unexpected end of
 * JSON input", which is what the owner saw instead of anything about the picture
 * they had chosen.
 *
 * The size is checked here too, before the connection is opened, and after
 * `prepareImage` has had its go: a file rejected server-side has still been
 * carried across the wire first, and on a phone that is a long upload that ends
 * in an error.
 */
async function uploadImage(file: File): Promise<UploadedImage> {
  // Shrunk first, then measured: the point of resizing is that a photo straight
  // off a phone, which no cap here would have accepted, becomes one that fits.
  const prepared = await prepareImage(file);
  if (prepared.size > MAX_UPLOAD_BYTES) throw new Error(OVERSIZE_MESSAGE);
  const data = new FormData();
  data.set("file", prepared);
  const response = await fetch("/api/uploads", { method: "POST", body: data });
  let result: Partial<UploadedImage> & { error?: string } = {};
  try {
    result = JSON.parse(await response.text()) as typeof result;
  } catch {
    // Not our handler answering. Fall through to a message keyed on the status.
  }
  if (response.ok && result.url) return result as UploadedImage;
  throw new Error(result.error ?? uploadFailureMessage(response.status));
}

function uploadFailureMessage(status: number): string {
  if (status === 413) return OVERSIZE_MESSAGE;
  if (status === 401 || status === 403) return "Your sign-in has expired. Sign in again, then retry the upload.";
  return "That image could not be uploaded. Check your connection and try again.";
}

const moneyToCents = (value: string) => Math.round(Number(value || 0) * 100);
const minuteToTime = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const timeToMinute = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };
// H-12: a native <input type="time"> cannot represent midnight-as-close (minute 1440,
// which would round-trip to 00:00 and be rejected as close <= open). The closing time
// therefore uses a <select> whose 1440 option is an explicit "midnight (next day)".
const CLOSE_MINUTE_OPTIONS = Array.from({ length: 48 }, (_, index) => (index + 1) * 30); // 30 … 1440
const closeMinuteLabel = (value: number) => {
  if (value >= 1440) return "12:00 AM (midnight)";
  const hour24 = Math.floor(value / 60);
  const minute = value % 60;
  const period = hour24 < 12 ? "AM" : "PM";
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
};

export function AdminSettingsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const settings = dashboard.settings;
  const delivery = settings.delivery.value;
  const ordering = settings.ordering.value;
  const tax = settings.taxAndTips.value;
  const business = settings.business.value;
  const operations = settings.operations.value;
  const rewards = settings.rewards?.value ?? {};
  const initialContent = settings.content?.value ?? {};
  const initialHours = (settings.hours.value as unknown as Array<{ weekday: number; label: string; openMinute: number; closeMinute: number }>).map((row) => ({ ...row }));
  const [message, setMessage] = useState("");
  const [deliveryForm, setDeliveryForm] = useState({ radius: String(delivery.radiusKm), fee: String(Number(delivery.feeCents) / 100), minimum: String(Number(delivery.minimumCents) / 100), feeTaxable: Boolean(delivery.feeTaxable), outsideAreaMessage: String(delivery.outsideAreaMessage ?? "") });
  const [orderingForm, setOrderingForm] = useState({ enabled: Boolean(ordering.enabled), pickupEnabled: Boolean(ordering.pickupEnabled), deliveryEnabled: Boolean(ordering.deliveryEnabled), payAtStorePickupEnabled: Boolean(ordering.payAtStorePickupEnabled), pickupEstimate: String(ordering.pickupEstimateMinutes), deliveryEstimate: String(ordering.deliveryEstimateMinutes), lastOrderCutoff: String(ordering.lastOrderCutoffMinutes ?? 0), pauseMessage: String(ordering.pauseMessage ?? "") });
  const [businessForm, setBusinessForm] = useState({ name: String(business.name), phone: String(business.phone), email: String(business.email ?? ""), address: String(business.address), latitude: String(business.latitude), longitude: String(business.longitude), reviewUrl: String(business.googleReviewUrl ?? ""), timeZone: String(business.timeZone ?? "America/Toronto") });
  const [taxForm, setTaxForm] = useState({ rate: String(Number(tax.taxRateBps) / 100), tippingEnabled: Boolean(tax.tippingEnabled), presets: (tax.tipPresetBps as number[]).map((entry) => entry / 100).join(", "), customTipEnabled: Boolean(tax.customTipEnabled) });
  const [operationsForm, setOperationsForm] = useState({ cancellation: String(operations.cancellationRequestWindowMinutes), feedbackDelay: String(operations.feedbackDelayMinutes), halalNotice: String(operations.halalNotice ?? ""), halfToppingUnitsBps: String(operations.halfToppingUnitsBps ?? 10_000) });
  const [content, setContent] = useState({ heroEyebrow: String(initialContent.heroEyebrow ?? ""), heroHeadline: String(initialContent.heroHeadline ?? ""), heroAccent: String(initialContent.heroAccent ?? ""), heroDescription: String(initialContent.heroDescription ?? ""), dealEyebrow: String(initialContent.dealEyebrow ?? ""), dealHeadline: String(initialContent.dealHeadline ?? ""), dealDescription: String(initialContent.dealDescription ?? ""), footerTagline: String(initialContent.footerTagline ?? "") });
  const [rewardForm, setRewardForm] = useState({ enabled: Boolean(rewards.feedbackRewardEnabled), code: String(rewards.feedbackRewardCode ?? ""), offer: String(rewards.feedbackRewardOffer ?? "") });
  const [hours, setHours] = useState(initialHours);
  const save = async (key: string, value: Record<string, unknown> | typeof hours) => {
    setMessage("");
    try {
      await configRequest({ action: "settings.update", key, value, expectedVersion: settings[key]?.version, reason: "Updated by owner in admin" });
      setMessage("Saved. The customer website now uses these settings.");
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); }
  };
  return <div className="admin-stack admin-controls">
    <div className="staff-grid">
      <SettingsCard title="Ordering methods" onSave={() => save("ordering", { ...ordering, enabled: orderingForm.enabled, pickupEnabled: orderingForm.pickupEnabled, deliveryEnabled: orderingForm.deliveryEnabled, payAtStorePickupEnabled: orderingForm.payAtStorePickupEnabled, pickupEstimateMinutes: Number(orderingForm.pickupEstimate), deliveryEstimateMinutes: Number(orderingForm.deliveryEstimate), lastOrderCutoffMinutes: Number(orderingForm.lastOrderCutoff), pauseMessage: orderingForm.pauseMessage })}>
        <Check label="Online ordering enabled" checked={orderingForm.enabled} onChange={(enabled) => setOrderingForm({ ...orderingForm, enabled })} />
        <Check label="Pickup orders" checked={orderingForm.pickupEnabled} onChange={(pickupEnabled) => setOrderingForm({ ...orderingForm, pickupEnabled })} />
        <Check label="Delivery orders" checked={orderingForm.deliveryEnabled} onChange={(deliveryEnabled) => setOrderingForm({ ...orderingForm, deliveryEnabled })} />
        <Check label="Pay at store for pickup" checked={orderingForm.payAtStorePickupEnabled} onChange={(payAtStorePickupEnabled) => setOrderingForm({ ...orderingForm, payAtStorePickupEnabled })} />
        <Field label="Pickup estimate · minutes" type="number" value={orderingForm.pickupEstimate} onChange={(pickupEstimate) => setOrderingForm({ ...orderingForm, pickupEstimate })} />
        <Field label="Delivery estimate · minutes" type="number" value={orderingForm.deliveryEstimate} onChange={(deliveryEstimate) => setOrderingForm({ ...orderingForm, deliveryEstimate })} />
        <Field label="Stop taking orders · minutes before closing" type="number" value={orderingForm.lastOrderCutoff} onChange={(lastOrderCutoff) => setOrderingForm({ ...orderingForm, lastOrderCutoff })} />
        <Field label="Paused-ordering message" wide value={orderingForm.pauseMessage} onChange={(pauseMessage) => setOrderingForm({ ...orderingForm, pauseMessage })} />
      </SettingsCard>
      <SettingsCard title="Delivery rules" onSave={() => save("delivery", { ...delivery, radiusKm: Number(deliveryForm.radius), feeCents: moneyToCents(deliveryForm.fee), minimumCents: moneyToCents(deliveryForm.minimum), feeTaxable: deliveryForm.feeTaxable, outsideAreaMessage: deliveryForm.outsideAreaMessage })}>
        <Field label="Delivery radius · km" type="number" value={deliveryForm.radius} onChange={(radius) => setDeliveryForm({ ...deliveryForm, radius })} />
        <Field label="Delivery fee · C$" type="number" value={deliveryForm.fee} onChange={(fee) => setDeliveryForm({ ...deliveryForm, fee })} />
        <Field label="Minimum order · C$" type="number" value={deliveryForm.minimum} onChange={(minimum) => setDeliveryForm({ ...deliveryForm, minimum })} />
        <Check label="Charge HST on delivery fee" checked={deliveryForm.feeTaxable} onChange={(feeTaxable) => setDeliveryForm({ ...deliveryForm, feeTaxable })} />
        <Field label="Outside-area message" wide multiline value={deliveryForm.outsideAreaMessage} onChange={(outsideAreaMessage) => setDeliveryForm({ ...deliveryForm, outsideAreaMessage })} />
      </SettingsCard>
    </div>
    <div className="staff-grid">
      <SettingsCard title="Restaurant details" onSave={() => save("business", { ...business, name: businessForm.name, phone: businessForm.phone, email: businessForm.email.trim(), address: businessForm.address, latitude: Number(businessForm.latitude), longitude: Number(businessForm.longitude), googleReviewUrl: businessForm.reviewUrl, timeZone: businessForm.timeZone })}>
        <Field label="Restaurant name" value={businessForm.name} onChange={(name) => setBusinessForm({ ...businessForm, name })} />
        <Field label="Phone" value={businessForm.phone} onChange={(phone) => setBusinessForm({ ...businessForm, phone })} />
        {/* The inbox every new order and every low rating lands in. It is a
            *recipient*, and deliberately not the sender: mail is sent from the
            provider's verified address (EMAIL_FROM), which has to be on a domain
            with SPF and DKIM, and a gmail.com address can never be that. Left
            empty, the restaurant simply is not emailed about new orders. */}
        <Field label="Order alerts go to · email" wide value={businessForm.email} onChange={(email) => setBusinessForm({ ...businessForm, email })} />
        <Field label="Address" wide value={businessForm.address} onChange={(address) => setBusinessForm({ ...businessForm, address })} />
        <Field label="Latitude" type="number" value={businessForm.latitude} onChange={(latitude) => setBusinessForm({ ...businessForm, latitude })} />
        <Field label="Longitude" type="number" value={businessForm.longitude} onChange={(longitude) => setBusinessForm({ ...businessForm, longitude })} />
        <Field label="Google review URL" wide value={businessForm.reviewUrl} onChange={(reviewUrl) => setBusinessForm({ ...businessForm, reviewUrl })} />
        <Field label="Time zone" wide value={businessForm.timeZone} onChange={(timeZone) => setBusinessForm({ ...businessForm, timeZone })} />
      </SettingsCard>
      <SettingsCard title="Tax, tips & policies" onSave={async () => { await save("taxAndTips", { ...tax, taxRateBps: Math.round(Number(taxForm.rate) * 100), tippingEnabled: taxForm.tippingEnabled, tipPresetBps: taxForm.presets.split(",").map((entry) => Math.round(Number(entry.trim()) * 100)).filter(Number.isFinite), customTipEnabled: taxForm.customTipEnabled }); await save("operations", { ...operations, cancellationRequestWindowMinutes: Number(operationsForm.cancellation), feedbackDelayMinutes: Number(operationsForm.feedbackDelay), halalNotice: operationsForm.halalNotice, halfToppingUnitsBps: Number(operationsForm.halfToppingUnitsBps) }); }}>
        <Field label="HST · %" type="number" value={taxForm.rate} onChange={(rate) => setTaxForm({ ...taxForm, rate })} />
        <Field label="Tip buttons · % comma separated" value={taxForm.presets} onChange={(presets) => setTaxForm({ ...taxForm, presets })} />
        <Check label="Show tipping" checked={taxForm.tippingEnabled} onChange={(tippingEnabled) => setTaxForm({ ...taxForm, tippingEnabled })} />
        <Check label="Allow custom tips" checked={taxForm.customTipEnabled} onChange={(customTipEnabled) => setTaxForm({ ...taxForm, customTipEnabled })} />
        <Field label="Cancellation window · min" type="number" value={operationsForm.cancellation} onChange={(cancellation) => setOperationsForm({ ...operationsForm, cancellation })} />
        <Field label="Feedback delay · min" type="number" value={operationsForm.feedbackDelay} onChange={(feedbackDelay) => setOperationsForm({ ...operationsForm, feedbackDelay })} />
        <label>A topping on half the pizza counts as<select value={operationsForm.halfToppingUnitsBps} onChange={(event) => setOperationsForm({ ...operationsForm, halfToppingUnitsBps: event.target.value })}><option value="10000">A full topping</option><option value="7500">Three quarters of a topping</option><option value="5000">Half a topping</option><option value="0">Free — no charge for halves</option></select></label>
        <Field label="Halal notice" wide multiline value={operationsForm.halalNotice} onChange={(halalNotice) => setOperationsForm({ ...operationsForm, halalNotice })} />
      </SettingsCard>
    </div>
    <SettingsCard title="Website wording" onSave={() => save("content", content)}>
      <Field label="Hero eyebrow" value={content.heroEyebrow} onChange={(heroEyebrow) => setContent({ ...content, heroEyebrow })} />
      <Field label="Hero headline" value={content.heroHeadline} onChange={(heroHeadline) => setContent({ ...content, heroHeadline })} />
      <Field label="Hero accent line" value={content.heroAccent} onChange={(heroAccent) => setContent({ ...content, heroAccent })} />
      <Field label="Hero description" wide multiline value={content.heroDescription} onChange={(heroDescription) => setContent({ ...content, heroDescription })} />
      <Field label="Deal eyebrow" value={content.dealEyebrow} onChange={(dealEyebrow) => setContent({ ...content, dealEyebrow })} />
      <Field label="Deal headline" value={content.dealHeadline} onChange={(dealHeadline) => setContent({ ...content, dealHeadline })} />
      <Field label="Deal description" wide multiline value={content.dealDescription} onChange={(dealDescription) => setContent({ ...content, dealDescription })} />
      <Field label="Footer tagline" wide value={content.footerTagline} onChange={(footerTagline) => setContent({ ...content, footerTagline })} />
    </SettingsCard>
    {/* The coupon that goes out after someone fills in the feedback form.
        What it is *worth* is not here on purpose: the code names a promotion in
        History & offers, and that promotion is the single place the amount, the
        minimum spend and the expiry live — so the email and the till can never
        quote different terms. Everyone who answers gets it, whatever they rated
        us; rewarding only the good scores buys stars and learns nothing, and
        Google's review policy forbids it. */}
    <SettingsCard title="Feedback thank-you" onSave={() => save("rewards", { ...rewards, feedbackRewardEnabled: rewardForm.enabled, feedbackRewardCode: rewardForm.code.trim().toUpperCase(), feedbackRewardOffer: rewardForm.offer.trim() })}>
      <Check label="Email a coupon after feedback" checked={rewardForm.enabled} onChange={(enabled) => setRewardForm({ ...rewardForm, enabled })} />
      <Field label="Coupon code" value={rewardForm.code} onChange={(code) => setRewardForm({ ...rewardForm, code })} />
      <Field label="What they get · e.g. a free garlic bread or four pops" wide value={rewardForm.offer} onChange={(offer) => setRewardForm({ ...rewardForm, offer })} />
      <p className="editor-hint field-wide">Sent to everyone who answers, whatever they rated us. The code has to match a live offer under <strong>History &amp; offers</strong> — that offer decides what it is worth, the minimum spend and when it stops working, and the email quotes it. No matching offer, no email.</p>
    </SettingsCard>
    <SettingsCard title="Regular opening hours" onSave={() => save("hours", hours)}>
      <div className="hours-admin">{hours.map((row, index) => <div key={row.weekday}><strong>{row.label}</strong><input aria-label={`${row.label} opening time`} type="time" value={minuteToTime(row.openMinute)} onChange={(event) => setHours((current) => current.map((entry, currentIndex) => currentIndex === index ? { ...entry, openMinute: timeToMinute(event.target.value) } : entry))} /><span>to</span><select aria-label={`${row.label} closing time`} value={String(row.closeMinute)} onChange={(event) => setHours((current) => current.map((entry, currentIndex) => currentIndex === index ? { ...entry, closeMinute: Number(event.target.value) } : entry))}>{[...new Set([row.closeMinute, ...CLOSE_MINUTE_OPTIONS])].sort((a, b) => a - b).map((minute) => <option key={minute} value={minute}>{closeMinuteLabel(minute)}</option>)}</select></div>)}</div>
    </SettingsCard>
    <ClosuresCard closures={dashboard.closures ?? []} onChanged={onSaved} />
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </div>;
}

/**
 * H-08: holidays, one-off closures, and "back in an hour".
 *
 * Deliberately a window with an end rather than another toggle. The existing
 * pause has no end, so it relies on somebody remembering to switch it back —
 * and the two ways that goes wrong are the store staying shut the day after the
 * holiday, or taking orders during it.
 *
 * The quick buttons exist because the common case is someone reaching for their
 * phone mid-shift, not planning a holiday: closing for an hour should take one
 * tap, not a date picker.
 */
function ClosuresCard({ closures, onChanged }: { closures: Dashboard["closures"]; onChanged: () => Promise<void> }) {
  const [scope, setScope] = useState<"both" | "pickup" | "delivery">("both");
  const [reason, setReason] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [message, setMessage] = useState("");

  const send = async (body: Record<string, unknown>, success: string) => {
    setMessage("");
    const response = await fetch("/api/admin/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) { setMessage(result.error ?? "That could not be saved."); return; }
    setMessage(success);
    setReason(""); setCustomerMessage(""); setStartsAt(""); setEndsAt("");
    await onChanged();
  };

  /** "Closed for the next N hours", from right now. */
  const pauseFor = (hours: number) => send({
    action: "closure.create",
    startsAt: Date.now(),
    endsAt: Date.now() + hours * 3_600_000,
    scope,
    reason: reason.trim() || `Closed for ${hours} hour${hours === 1 ? "" : "s"}`,
    customerMessage: customerMessage.trim() || undefined,
  }, `Ordering stops for the next ${hours} hour${hours === 1 ? "" : "s"}.`);

  /** A whole day, midnight to midnight in the restaurant's own time zone. */
  const closeDay = () => {
    if (!startsAt) { setMessage("Choose the date to close."); return; }
    const from = new Date(`${startsAt}T00:00:00`);
    const to = new Date(`${(endsAt || startsAt)}T00:00:00`);
    to.setDate(to.getDate() + 1);
    return send({
      action: "closure.create",
      startsAt: from.getTime(),
      endsAt: to.getTime(),
      scope,
      reason: reason.trim() || "Holiday",
      customerMessage: customerMessage.trim() || undefined,
    }, "Closure saved. The website will show it automatically.");
  };

  const when = (value: number) =>
    new Date(value).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });

  return <section className="staff-panel">
    <div className="staff-panel-head"><h2>Holidays &amp; closures</h2><span className="live-chip">{closures.length} upcoming</span></div>
    <p className="editor-hint">Closing here stops new orders for the period you choose and puts a message on the website. Unlike pausing, it ends by itself — you do not have to remember to switch it back on.</p>

    <div className="settings-form">
      <label>What is closed<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
        <option value="both">Everything</option>
        <option value="delivery">Delivery only — the counter stays open</option>
        <option value="pickup">Pickup only</option>
      </select></label>
      <Field label="Reason · for your records" value={reason} onChange={setReason} />
      <Field label="Message for customers · optional" wide value={customerMessage} onChange={setCustomerMessage} />
    </div>

    <div className="closure-quick">
      <strong>Stop taking orders now</strong>
      <button className="staff-button" onClick={() => void pauseFor(1)}>For 1 hour</button>
      <button className="staff-button" onClick={() => void pauseFor(2)}>For 2 hours</button>
      <button className="staff-button" onClick={() => void pauseFor(4)}>For the rest of today</button>
    </div>

    <div className="settings-form">
      <Field label="Closed from · date" type="date" value={startsAt} onChange={setStartsAt} />
      <Field label="Closed until · date, leave blank for one day" type="date" value={endsAt} onChange={setEndsAt} />
    </div>
    <button className="staff-button" disabled={!startsAt} onClick={() => void closeDay()}>Close these dates</button>

    <div className="setup-list">
      {closures.map((closure) => <div className="setup-item" key={closure.id}>
        <b aria-hidden>✕</b>
        <div>
          <strong>{closure.reason}{closure.scope !== "both" ? ` · ${closure.scope} only` : ""}</strong>
          <p>{when(closure.startsAt)} → {when(closure.endsAt)}</p>
          <button className="text-button danger-text" onClick={() => void send({ action: "closure.remove", id: closure.id }, "Closure removed — ordering is open again.")}>Remove</button>
        </div>
      </div>)}
      {!closures.length ? <div className="staff-empty">No closures scheduled.</div> : null}
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </section>;
}

function SettingsCard({ title, onSave, children }: { title: string; onSave: () => void | Promise<void>; children: React.ReactNode }) {
  return <section className="staff-panel settings-card"><div className="staff-panel-head"><h2>{title}</h2><button className="staff-button" onClick={() => void onSave()}>Save changes</button></div><div className="settings-form">{children}</div></section>;
}

function Field({ label, value, onChange, type = "text", wide = false, multiline = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; wide?: boolean; multiline?: boolean }) {
  return <label className={wide ? "field-wide" : ""}>{label}{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} /> : <input type={type} step={type === "number" ? "any" : undefined} value={value} onChange={(event) => onChange(event.target.value)} />}</label>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="admin-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

// Everything the owner can change about the public website without a developer:
// the logo, the colours, the words, which sections appear and in what order.
export const SITE_SECTIONS = [
  ["promises", "Four promises strip"],
  ["menu", "Menu"],
  ["deal", "Featured deal banner"],
  ["hours", "Hours & address"],
] as const;

const DEFAULT_SECTION_ORDER = SITE_SECTIONS.map(([id]) => id);

export function AdminWebsitePanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const record = dashboard.settings.content ?? { value: {}, version: 1 };
  const content = record.value as Record<string, unknown>;
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...content });
  const text = (key: string, fallback = "") => String(draft[key] ?? fallback);
  const flag = (key: string, fallback = true) => draft[key] === undefined ? fallback : Boolean(draft[key]);
  const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  const order = Array.isArray(draft.sectionOrder) && draft.sectionOrder.length
    ? (draft.sectionOrder as string[]).filter((id) => DEFAULT_SECTION_ORDER.includes(id as typeof DEFAULT_SECTION_ORDER[number]))
    : [...DEFAULT_SECTION_ORDER];
  const promises = (Array.isArray(draft.promises) ? draft.promises : []) as Array<{ title?: string; text?: string }>;
  const move = (index: number, direction: -1 | 1) => {
    const next = [...order];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    set("sectionOrder", next);
  };
  const upload = async (key: string, file: File) => {
    setUploading(key);
    try {
      const result = await uploadImage(file);
      set(key, result.url);
      setMessage("Image uploaded. Choose Publish to put it on the website.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally { setUploading(""); }
  };
  const publish = async () => {
    setMessage("");
    try {
      await configRequest({ action: "settings.update", key: "content", value: draft, expectedVersion: record.version, reason: "Website updated by owner" });
      setMessage("Published. Reload the website to see it live.");
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not publish."); }
  };
  return <div className="admin-stack admin-controls">
    <div className="publish-bar">
      <div><strong>Website editor</strong><small>Changes are saved only when you publish.</small></div>
      <div><a className="text-button" href="/" target="_blank" rel="noreferrer">Open the website ↗</a><button className="staff-button" onClick={() => void publish()}>Publish changes</button></div>
    </div>
    <div className="staff-grid">
      <SettingsCard title="Logo & colours" onSave={publish}>
        <div className="image-admin field-wide">
          <div className="image-admin-preview">{text("logoUrl") ? <span className="image-admin-thumb" style={{ backgroundImage: `url(${text("logoUrl")})` }} /> : <span>Using the built-in Pizza 62 logo</span>}</div>
          <label className="staff-button">{uploading === "logoUrl" ? "Uploading…" : "Upload a logo"}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload("logoUrl", file); }} /></label>
          <button className="text-button" onClick={() => set("logoUrl", "")}>Use the built-in logo</button>
        </div>
        <Colour label="Main brand colour" value={text("themePrimary", "#d33b27")} onChange={(value) => set("themePrimary", value)} />
        <Colour label="Highlight colour" value={text("themeAccent", "#f2b83b")} onChange={(value) => set("themeAccent", value)} />
        <Colour label="Deep colour (headers, footer)" value={text("themeInk", "#17140f")} onChange={(value) => set("themeInk", value)} />
        <Colour label="Page background" value={text("themeSurface", "#fffaf0")} onChange={(value) => set("themeSurface", value)} />
      </SettingsCard>
      <SettingsCard title="Announcement bar" onSave={publish}>
        <Check label="Show an announcement across the top" checked={flag("announcementEnabled", false)} onChange={(value) => set("announcementEnabled", value)} />
        <Field label="Announcement" wide value={text("announcementText")} onChange={(value) => set("announcementText", value)} />
        <Field label="Link (optional)" wide value={text("announcementHref")} onChange={(value) => set("announcementHref", value)} />
        <p className="editor-hint">The closed-store notice always shows on its own and is not affected by this.</p>
      </SettingsCard>
    </div>
    <SettingsCard title="Front page headline" onSave={publish}>
      <Field label="Small line above the headline" value={text("heroEyebrow")} onChange={(value) => set("heroEyebrow", value)} />
      <Field label="Headline" value={text("heroHeadline")} onChange={(value) => set("heroHeadline", value)} />
      <Field label="Second headline line" value={text("heroAccent")} onChange={(value) => set("heroAccent", value)} />
      <Field label="Paragraph" wide multiline value={text("heroDescription")} onChange={(value) => set("heroDescription", value)} />
      <div className="image-admin field-wide">
        <div className="image-admin-preview">{text("heroImageUrl") ? <span className="image-admin-thumb" style={{ backgroundImage: `url(${text("heroImageUrl")})` }} /> : <span>Using the illustrated pizza</span>}</div>
        <label className="staff-button">{uploading === "heroImageUrl" ? "Uploading…" : "Upload a hero photo"}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload("heroImageUrl", file); }} /></label>
        <button className="text-button" onClick={() => set("heroImageUrl", "")}>Use the illustration</button>
      </div>
    </SettingsCard>
    <SettingsCard title="Page sections" onSave={publish}>
      <div className="section-order field-wide">
        {order.map((id, index) => {
          const label = SITE_SECTIONS.find(([sectionId]) => sectionId === id)?.[1] ?? id;
          return <div className="section-row" key={id}>
            <span className="section-handle">{index + 1}</span>
            <strong>{label}</strong>
            {id === "menu"
              ? <em>Always shown</em>
              : <Check label="Shown" checked={flag(`show_${id}`)} onChange={(value) => set(`show_${id}`, value)} />}
            <div className="section-move">
              <button className="text-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${label} up`}>↑</button>
              <button className="text-button" disabled={index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${label} down`}>↓</button>
            </div>
          </div>;
        })}
      </div>
    </SettingsCard>
    <SettingsCard title="Four promises strip" onSave={publish}>
      <div className="field-wide promise-editor">
        {[0, 1, 2, 3].map((index) => <div key={index}>
          <Field label={`Promise ${index + 1} title`} value={String(promises[index]?.title ?? "")} onChange={(value) => { const next = [0, 1, 2, 3].map((slot) => ({ title: String(promises[slot]?.title ?? ""), text: String(promises[slot]?.text ?? "") })); next[index].title = value; set("promises", next); }} />
          <Field label="Under it" value={String(promises[index]?.text ?? "")} onChange={(value) => { const next = [0, 1, 2, 3].map((slot) => ({ title: String(promises[slot]?.title ?? ""), text: String(promises[slot]?.text ?? "") })); next[index].text = value; set("promises", next); }} />
        </div>)}
      </div>
      <p className="editor-hint">Leave a title empty to fall back to the built-in wording.</p>
    </SettingsCard>
    <SettingsCard title="Featured deal banner" onSave={publish}>
      <Field label="Stamp text" value={text("dealBadge", "PICKUP ONLY")} onChange={(value) => set("dealBadge", value)} />
      <Field label="Small line" value={text("dealEyebrow")} onChange={(value) => set("dealEyebrow", value)} />
      <Field label="Headline" value={text("dealHeadline")} onChange={(value) => set("dealHeadline", value)} />
      <Field label="Price shown" value={text("dealPriceLabel", "$27.99")} onChange={(value) => set("dealPriceLabel", value)} />
      <Field label="Paragraph" wide multiline value={text("dealDescription")} onChange={(value) => set("dealDescription", value)} />
      <label>Button jumps to<select value={text("dealTargetCategoryId", "pickup-specials")} onChange={(event) => set("dealTargetCategoryId", event.target.value)}>{dashboard.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
    </SettingsCard>
    <div className="staff-grid">
      <SettingsCard title="Footer & social" onSave={publish}>
        <Field label="Footer line" wide value={text("footerTagline")} onChange={(value) => set("footerTagline", value)} />
        <Field label="Instagram link" wide value={text("socialInstagram")} onChange={(value) => set("socialInstagram", value)} />
        <Field label="Facebook link" wide value={text("socialFacebook")} onChange={(value) => set("socialFacebook", value)} />
      </SettingsCard>
      <SettingsCard title="Search & sharing" onSave={publish}>
        <Field label="Browser tab / search title" wide value={text("seoTitle")} onChange={(value) => set("seoTitle", value)} />
        <Field label="Search description" wide multiline value={text("seoDescription")} onChange={(value) => set("seoDescription", value)} />
        <p className="editor-hint">Search engines usually show about 60 characters of the title and 155 of the description.</p>
      </SettingsCard>
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </div>;
}

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return <label className="colour-field">{label}
    <span><input type="color" value={valid ? value : "#000000"} onChange={(event) => onChange(event.target.value)} aria-label={`${label} swatch`} /><input value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} /></span>
  </label>;
}

export function AdminMenuPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [section, setSection] = useState<"products" | "categories" | "toppings">("products");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "attention" | "hidden">("all");
  const [addingProduct, setAddingProduct] = useState(false);
  const [newProductId, setNewProductId] = useState("");
  const complete = async (work: () => Promise<unknown>, success: string) => {
    setMessage("");
    try { const result = await work(); setMessage(success); await onSaved(); return result; }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); return undefined; }
  };
  const activeProducts = dashboard.products.filter((product) => product.active);
  const attentionProducts = dashboard.products.filter((product) => product.active && (product.sold_out || product.setup_required));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProducts = dashboard.products.filter((product) => {
    const matchesQuery = !normalizedQuery || `${product.name} ${product.description}`.toLowerCase().includes(normalizedQuery);
    const matchesCategory = categoryFilter === "all" || product.category_id === categoryFilter;
    const matchesStatus = statusFilter === "all" ||
      (statusFilter === "live" && product.active && !product.sold_out && !product.setup_required) ||
      (statusFilter === "attention" && product.active && Boolean(product.sold_out || product.setup_required)) ||
      (statusFilter === "hidden" && !product.active);
    return matchesQuery && matchesCategory && matchesStatus;
  });
  return <div className="admin-stack admin-controls">
    <section className="menu-setup-intro">
      <div className="menu-setup-intro__copy"><span className="menu-setup-eyebrow">Your live ordering menu</span><h2>Make a menu change without guesswork.</h2><p>Add an item, update its price or photo, or hide it from customers. Changes go to the website as soon as you save.</p></div>
      <div className="menu-setup-stats" aria-label="Menu summary"><div><strong>{activeProducts.length}</strong><span>Shown on menu</span></div><div><strong>{attentionProducts.length}</strong><span>Need attention</span></div><div><strong>{dashboard.categories.filter((category) => category.active).length}</strong><span>Visible categories</span></div></div>
      <a className="staff-button menu-preview-link" href="/#menu" target="_blank" rel="noreferrer">View customer menu ↗</a>
    </section>
    <section className="menu-how-it-works" aria-label="How menu changes work">
      <div><b>1</b><span><strong>Add or edit</strong><small>Start with the item basics. Pizza sizes and customer choices are edited inside the item.</small></span></div>
      <div><b>2</b><span><strong>Add a photo</strong><small>Use a landscape 1200 × 675 image. You will see the same centre crop customers see.</small></span></div>
      <div><b>3</b><span><strong>Save or hide</strong><small>Hide removes an item from the live menu but safely keeps past order records.</small></span></div>
    </section>
    <nav className="menu-admin-tabs" aria-label="Menu setup sections">
      <button className={section === "products" ? "active" : ""} aria-pressed={section === "products"} onClick={() => setSection("products")}>Menu items <span>{dashboard.products.length}</span></button>
      <button className={section === "categories" ? "active" : ""} aria-pressed={section === "categories"} onClick={() => setSection("categories")}>Categories <span>{dashboard.categories.length}</span></button>
      <button className={section === "toppings" ? "active" : ""} aria-pressed={section === "toppings"} onClick={() => setSection("toppings")}>Toppings <span>{dashboard.toppings.length}</span></button>
    </nav>
    {section === "products" ? <section className="staff-panel menu-products-panel">
      <div className="staff-panel-head menu-panel-heading"><div><h2>Menu items</h2><p>Search for an item, open it, then save the changes you want customers to see.</p></div><button className="staff-button" onClick={() => setAddingProduct((current) => !current)}>{addingProduct ? "Cancel" : "+ Add menu item"}</button></div>
      {addingProduct ? <NewProduct categories={dashboard.categories} onCreate={async (body) => {
        const result = await complete(() => configRequest(body), "Item created and kept hidden. Review it, then publish when ready.") as { id?: string } | undefined;
        if (result?.id) { setNewProductId(result.id); setAddingProduct(false); setQuery(""); setCategoryFilter("all"); setStatusFilter("all"); }
        return result;
      }} /> : null}
      <div className="menu-product-tools">
        <label className="menu-search"><span>Search items</span><input type="search" placeholder="Try “pepperoni” or “wings”" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label><span>Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{dashboard.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="live">Live and orderable</option><option value="attention">Sold out / setup needed</option><option value="hidden">Hidden from menu</option></select></label>
      </div>
      <p className="menu-results-count">Showing {filteredProducts.length} of {dashboard.products.length} items</p>
      <div className="product-admin-cards">{filteredProducts.map((product) => <ProductEditor key={`${product.id}-${product.id === newProductId ? "new" : "existing"}`} product={product} categories={dashboard.categories} variations={dashboard.variations.filter((variation) => variation.product_id === product.id)} toppings={dashboard.toppings} defaultOpen={product.id === newProductId} onSave={(body, success) => complete(() => configRequest(body), success)} />)}</div>
      {!filteredProducts.length ? <div className="staff-empty">No items match these filters. Clear the search or choose a different status.</div> : null}
    </section> : null}
    {section === "categories" ? <section className="staff-panel"><div className="staff-panel-head menu-panel-heading"><div><h2>Menu categories</h2><p>Categories create the sections customers browse. Hiding a category hides all of its items at once.</p></div><span className="live-chip">Names · order · visibility</span></div><div className="category-admin-list">{dashboard.categories.map((category) => <CategoryEditor key={category.id} category={category} onSave={(body) => complete(() => configRequest(body), `${category.name} category saved.`)} />)}</div><NewCategory onSave={(body) => complete(() => configRequest(body), "Category created.")} /></section> : null}
    {section === "toppings" ? <section className="staff-panel"><div className="staff-panel-head menu-panel-heading"><div><h2>Toppings &amp; halal options</h2><p>These choices are shared by every pizza. Kitchen labels are the short names printed on tickets.</p></div><span className="live-chip">Shared pizza choices</span></div><div className="product-admin-cards">{dashboard.toppings.map((topping) => <ToppingEditor key={topping.id} topping={topping} onSave={(body) => complete(() => configRequest(body), `${topping.name} saved.`)} />)}</div><NewTopping onSave={(body) => complete(() => configRequest(body), "Topping created.")} /></section> : null}
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </div>;
}

function CategoryEditor({ category, onSave }: { category: Category; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(category.name); const [description, setDescription] = useState(category.description ?? ""); const [active, setActive] = useState(Boolean(category.active)); const [order, setOrder] = useState(String(category.display_order));
  return <div className="category-admin-row"><Field label="Category name" value={name} onChange={setName} /><Field label="Description" value={description} onChange={setDescription} /><Field label="Order" type="number" value={order} onChange={setOrder} /><Check label="Visible" checked={active} onChange={setActive} /><button className="staff-button" onClick={() => onSave({ action: "category.upsert", id: category.id, name, description, active, displayOrder: Number(order) })}>Save</button></div>;
}

function NewCategory({ onSave }: { onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  return <div className="admin-create-row"><strong>Add category</strong><input placeholder="Category name" value={name} onChange={(event) => setName(event.target.value)} /><button className="staff-button" disabled={!name.trim()} onClick={() => { onSave({ action: "category.upsert", name, active: true, displayOrder: 10000 }); setName(""); }}>Create</button></div>;
}

function ProductEditor({ product, categories, variations, toppings, defaultOpen, onSave }: { product: Product; categories: Category[]; variations: Variation[]; toppings: Topping[]; defaultOpen?: boolean; onSave: (body: Record<string, unknown>, success: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(Boolean(defaultOpen)); const [name, setName] = useState(product.name); const [description, setDescription] = useState(product.description); const [categoryId, setCategoryId] = useState(product.category_id); const [productType, setProductType] = useState(product.product_type); const [price, setPrice] = useState(String(product.base_price_cents / 100)); const [imageUrl, setImageUrl] = useState(product.image_url ?? ""); const [active, setActive] = useState(Boolean(product.active)); const [soldOut, setSoldOut] = useState(Boolean(product.sold_out)); const [pickup, setPickup] = useState(Boolean(product.pickup_eligible)); const [delivery, setDelivery] = useState(Boolean(product.delivery_eligible)); const [taxable, setTaxable] = useState(Boolean(product.taxable)); const [halal, setHalal] = useState(Boolean(product.halal_capable)); const [order, setOrder] = useState(String(product.display_order)); const [configuration, setConfiguration] = useState<Record<string, unknown>>({ ...product.configuration });
  const sections = (Array.isArray(configuration.sections) ? configuration.sections : []) as ModifierSection[];
  const availability = (configuration.availability as { weekdays?: number[]; startMinute?: number; endMinute?: number; timeZone?: string; label?: string; startDate?: string; endDate?: string } | undefined);
  const updateSection = (index: number, next: ModifierSection) => setConfiguration({ ...configuration, sections: sections.map((section, current) => current === index ? next : section) });
  const setAvailability = (next?: typeof availability) => { const copy = { ...configuration }; if (next) copy.availability = next; else delete copy.availability; setConfiguration(copy); };
  const productBody = (visible = active) => ({ action: "product.update", productId: product.id, categoryId, name, description, productType, basePriceCents: moneyToCents(price), imageUrl: imageUrl || null, active: visible, soldOut, pickupEligible: pickup, deliveryEligible: delivery, taxable, halalCapable: halal, displayOrder: Number(order), configuration });
  const status = !product.active ? "Hidden" : product.setup_required ? "Needs setup" : product.sold_out ? "Sold out" : "Live";
  return <details className="product-admin-card menu-product-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className={`menu-item-thumb${product.image_url ? " has-image" : ""}`} style={product.image_url ? { backgroundImage: `url(${product.image_url})` } : undefined}>{product.image_url ? null : product.name.slice(0, 1).toUpperCase()}</span><span className="menu-item-summary"><strong>{product.name}</strong><small>{categories.find((category) => category.id === product.category_id)?.name} · {productTypeLabel(product.product_type)} · {formatMoney(product.base_price_cents)}</small></span><span className={`menu-status menu-status--${status.toLowerCase().replaceAll(" ", "-")}`}>{status}</span><span className="menu-edit-label">Edit item <b aria-hidden="true">⌄</b></span></summary><div className="product-editor">
    <div className="editor-section-heading"><span>1</span><div><h3>Item details</h3><p>This is the name, description and starting price shown on the menu card.</p></div></div>
    <div className="settings-form"><Field label="Product name" value={name} onChange={setName} /><label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Product type<select value={productType} onChange={(event) => setProductType(event.target.value as Product["product_type"])}><option value="simple">Simple item</option><option value="pizza">Pizza with price options</option><option value="bundle">Deal / bundle</option><option value="configurable">Configurable item</option></select></label><Field label="Card price · C$" type="number" value={price} onChange={setPrice} /><Field label="Display order" type="number" value={order} onChange={setOrder} /><Field label="Description" wide multiline value={description} onChange={setDescription} /></div>
    <p className="editor-hint menu-type-hint"><strong>{productTypeLabel(productType)}:</strong> {productTypeHelp(productType)}</p>
    <div className="editor-section-heading"><span>2</span><div><h3>Where customers can order it</h3><p>“Sold out” keeps the item visible but disables ordering. “Visible” publishes or removes it.</p></div></div>
    <div className="admin-switch-grid"><Check label="Visible" checked={active} onChange={setActive} /><Check label="Sold out" checked={soldOut} onChange={setSoldOut} /><Check label="Pickup" checked={pickup} onChange={setPickup} /><Check label="Delivery" checked={delivery} onChange={setDelivery} /><Check label="Taxable" checked={taxable} onChange={setTaxable} /><Check label="Halal choices" checked={halal} onChange={setHalal} /></div>
    <div className="editor-section-heading"><span>3</span><div><h3>Menu photo</h3><p>Optional. The preview below matches the wide crop used on customer menu cards.</p></div></div>
    <ProductImageField imageUrl={imageUrl} onChange={setImageUrl} />
    {productType === "pizza" ? <div className="config-editor"><h3>Pizza setup</h3><div className="settings-form">
      <Field label="Price-option label" value={String(configuration.variationLabel ?? "Choose your size")} onChange={(variationLabel) => setConfiguration({ ...configuration, variationLabel })} />
      <label>Order of the questions<select value={configuration.toppingsFirst ? "toppings" : "cheese"} onChange={(event) => setConfiguration({ ...configuration, toppingsFirst: event.target.value === "toppings" })}><option value="cheese">Cheese &amp; halal → crust &amp; sauce → toppings</option><option value="toppings">Cheese &amp; halal → toppings → crust &amp; sauce</option></select></label>
      <Field label="Crust choices · comma separated" wide value={(Array.isArray(configuration.crustOptions) ? configuration.crustOptions : []).join(", ")} onChange={(value) => setConfiguration({ ...configuration, crustOptions: splitList(value) })} />
      <Field label="Bake &amp; sauce choices · comma separated" wide value={(Array.isArray(configuration.bakeSauceOptions) ? configuration.bakeSauceOptions : []).join(", ")} onChange={(value) => setConfiguration({ ...configuration, bakeSauceOptions: splitList(value) })} />
      {Array.isArray(configuration.pizzaBaseOptions) && configuration.pizzaBaseOptions.length ? <Field label="Old combined crust list · clear once split above" wide value={(configuration.pizzaBaseOptions as string[]).join(", ")} onChange={(value) => setConfiguration({ ...configuration, pizzaBaseOptions: splitList(value) })} /> : null}
      <Check label="Ask for cheese (none / light / regular / extra)" checked={configuration.cheeseEnabled !== false} onChange={(cheeseEnabled) => setConfiguration({ ...configuration, cheeseEnabled })} />
      <Check label="Fixed specialty recipe" checked={Boolean(configuration.fixedRecipe)} onChange={(fixedRecipe) => setConfiguration({ ...configuration, fixedRecipe })} />
      <Check label="Recipe includes extra cheese" checked={Boolean(configuration.presetExtraCheese)} onChange={(presetExtraCheese) => setConfiguration({ ...configuration, presetExtraCheese })} />
    </div><p className="editor-hint">Halal is switched on with the “Halal choices” toggle above. Whatever is switched on is always asked in the order shown here.</p>{configuration.fixedRecipe ? <div className="recipe-toppings"><strong>Preselected recipe toppings</strong>{toppings.map((topping) => { const selected = (Array.isArray(configuration.recipeToppingIds) ? configuration.recipeToppingIds : []).includes(topping.id); return <Check key={topping.id} label={topping.name} checked={selected} onChange={(checked) => { const current = Array.isArray(configuration.recipeToppingIds) ? configuration.recipeToppingIds.map(String) : []; setConfiguration({ ...configuration, recipeToppingIds: checked ? [...current, topping.id] : current.filter((id) => id !== topping.id) }); }} />; })}</div> : null}</div> : <ModifierEditor sections={sections} toppingsFirst={Boolean(configuration.toppingsFirst)} onOrderChange={(toppingsFirst) => setConfiguration({ ...configuration, toppingsFirst })} onUpdate={updateSection} onRemove={(index) => setConfiguration({ ...configuration, sections: sections.filter((_, current) => current !== index) })} onAdd={() => setConfiguration({ ...configuration, sections: [...sections, { id: crypto.randomUUID(), label: "New choice", options: ["Option 1"], min: 0, max: 1, included: 1, extraPriceCents: 0 }] })} />}
    <div className="availability-editor"><Check label="Limit this product to advertised days and times" checked={Boolean(availability)} onChange={(checked) => setAvailability(checked ? { weekdays: [1, 2, 3, 4, 5], startMinute: 1020, endMinute: 1260, timeZone: "America/Toronto", label: "Mon–Fri · 5–9 PM" } : undefined)} />{availability ? <><div className="weekday-pills">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => <label key={day}><input type="checkbox" checked={(availability.weekdays ?? []).includes(index)} onChange={(event) => setAvailability({ ...availability, weekdays: event.target.checked ? [...(availability.weekdays ?? []), index] : (availability.weekdays ?? []).filter((entry) => entry !== index) })} />{day}</label>)}</div><div className="settings-form"><Field label="Starts" type="time" value={minuteToTime(availability.startMinute ?? 0)} onChange={(value) => setAvailability({ ...availability, startMinute: timeToMinute(value) })} /><Field label="Ends" type="time" value={minuteToTime(availability.endMinute ?? 0)} onChange={(value) => setAvailability({ ...availability, endMinute: timeToMinute(value) })} /><Field label="Customer label" value={availability.label ?? ""} onChange={(label) => setAvailability({ ...availability, label })} /><Field label="First day · optional" type="date" value={availability.startDate ?? ""} onChange={(value) => setAvailability({ ...availability, startDate: value || undefined })} /><Field label="Last day · optional" type="date" value={availability.endDate ?? ""} onChange={(value) => setAvailability({ ...availability, endDate: value || undefined })} /></div><p className="editor-hint">Leave both days empty for an offer that runs every week. Set them for a one-off — a game-day special stops on its last day instead of coming back next weekend.</p></> : null}</div>
    {productType === "pizza" ? <div className="variation-admin"><div className="subhead"><h3>Price options / sizes</h3><small>Included toppings are part of the listed price. Extras begin only after this allowance.</small></div>{variations.map((variation) => <VariationEditor key={variation.id} variation={variation} onSave={(body) => onSave(body, `${variation.name} pricing saved.`)} />)}<NewVariation productId={product.id} onSave={(body) => onSave(body, "Price option created.")} /></div> : null}
    <div className="product-save-bar"><div><strong>{active ? "Currently set to appear on the menu" : "Currently hidden from customers"}</strong><small>Saving updates the live menu immediately.</small></div><div>{active ? <button className="staff-button staff-button--quiet-danger" onClick={() => { setActive(false); void onSave(productBody(false), `${name} hidden from the customer menu.`); }}>Hide from menu</button> : <button className="staff-button staff-button--secondary" onClick={() => { setActive(true); void onSave(productBody(true), `${name} published on the customer menu.`); }}>Publish on menu</button>}<button className="staff-button save-product" onClick={() => void onSave(productBody(), `${name} saved.`)}>Save changes</button></div></div>
  </div></details>;
}

function productTypeLabel(type: Product["product_type"]) {
  if (type === "pizza") return "Pizza";
  if (type === "bundle") return "Deal / bundle";
  if (type === "configurable") return "Item with choices";
  return "Simple item";
}

function productTypeHelp(type: Product["product_type"]) {
  if (type === "pizza") return "Customers choose a size, crust, sauce and toppings. Add at least one price option before publishing.";
  if (type === "bundle") return "Use this for combos or deals with several required selections.";
  if (type === "configurable") return "Use this when an item needs choices such as flavour, drink or quantity.";
  return "Best for drinks, dips and sides that can be added in one tap.";
}

function ProductImageField({ imageUrl, onChange }: { imageUrl: string; onChange: (value: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const upload = async (file: File) => {
    setError(""); setDimensions(null);
    setUploading(true);
    try {
      const result = await uploadImage(file);
      onChange(result.url);
      if (result.width && result.height) setDimensions({ width: result.width, height: result.height });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "That image could not be uploaded."); }
    finally { setUploading(false); }
  };
  const ratioWarning = dimensions && (dimensions.width < 800 || dimensions.height < 450)
    ? "This photo may look soft on larger screens. 1200 × 675 or larger is recommended."
    : dimensions && Math.abs(dimensions.width / dimensions.height - 16 / 9) > .35
      ? "This shape will be centre-cropped. Keep the food near the middle of the image."
      : "";
  return <div className="product-image-editor">
    <div className={`product-image-crop${imageUrl ? " has-image" : ""}`} style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}>
      {!imageUrl ? <span><b>No photo yet</b><small>The menu uses a branded illustration until you add one.</small></span> : <em>Customer card crop</em>}
    </div>
    <div className="product-image-copy"><strong>Best result: 1200 × 675 px</strong><p>Use a landscape photo straight off your phone or camera. It is resized and saved as WebP so the menu loads quickly, then shown with a centred 16:9 crop—keep the food away from the edges.</p>
      {dimensions ? <p className="image-file-status">Uploaded {dimensions.width} × {dimensions.height} px. Save the item to publish this photo.</p> : imageUrl ? <p className="image-file-status">Photo ready. Save the item to publish any change.</p> : null}
      {ratioWarning ? <p className="image-warning">{ratioWarning}</p> : null}
      {error ? <p className="image-error" role="alert">{error}</p> : null}
      <div className="product-image-actions"><label className="staff-button">{uploading ? "Uploading…" : imageUrl ? "Replace photo" : "Choose photo"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file); }} /></label>{imageUrl ? <button type="button" className="text-button danger-text" onClick={() => { onChange(""); setDimensions(null); setError(""); }}>Remove photo</button> : null}<button type="button" className="text-button" onClick={() => setShowUrl((current) => !current)}>{showUrl ? "Hide image URL" : "Use an image URL instead"}</button></div>
      {showUrl ? <label className="image-url-field">Secure image URL<input type="text" inputMode="url" placeholder="https://…" value={imageUrl} onChange={(event) => { onChange(event.target.value); setDimensions(null); }} /><small>Only use a permanent HTTPS address you control. Uploading is more reliable.</small></label> : null}
    </div>
  </div>;
}

function ModifierEditor({ sections, toppingsFirst, onOrderChange, onUpdate, onRemove, onAdd }: { sections: ModifierSection[]; toppingsFirst: boolean; onOrderChange: (toppingsFirst: boolean) => void; onUpdate: (index: number, section: ModifierSection) => void; onRemove: (index: number) => void; onAdd: () => void }) {
  return <div className="config-editor"><div className="subhead"><h3>Customer choices / modifiers</h3><button className="staff-button" onClick={onAdd}>Add choice group</button></div>
    <div className="settings-form"><label>Order of the questions<select value={toppingsFirst ? "toppings" : "cheese"} onChange={(event) => onOrderChange(event.target.value === "toppings")}><option value="cheese">Cheese &amp; halal → crust &amp; sauce → toppings</option><option value="toppings">Cheese &amp; halal → toppings → crust &amp; sauce</option></select></label></div>
    <p className="editor-hint">Groups are shown to the customer in this order regardless of how they are listed here. “Shown under” puts several groups beneath one heading, e.g. all of Pizza 1&apos;s choices.</p>
    {sections.map((section, index) => <div className="modifier-admin" key={section.id}><div className="settings-form"><Field label="Group label" value={section.label} onChange={(label) => onUpdate(index, { ...section, label })} /><Field label="Shown under" value={section.group ?? ""} onChange={(group) => onUpdate(index, { ...section, group: group.trim() || undefined })} /><label>Choice source<select value={section.source ?? "custom"} onChange={(event) => { const source = event.target.value; onUpdate(index, { ...section, source: source === "custom" ? undefined : source as ModifierSection["source"] }); }}><option value="custom">Custom options</option><option value="toppings">Toppings (half &amp; half)</option><option value="cheese">Cheese</option><option value="halal">Halal meat</option><option value="crust">Crust</option><option value="bake_sauce">Bake &amp; sauce</option><option value="wing_flavours">Wing sauces &amp; rubs</option><option value="drinks">Canned pop</option><option value="pizza_base">Crust, bake &amp; sauce (old combined)</option></select></label><Field label="Minimum choices" type="number" value={String(section.min)} onChange={(value) => onUpdate(index, { ...section, min: Number(value) })} /><Field label="Maximum choices" type="number" value={String(section.max)} onChange={(value) => onUpdate(index, { ...section, max: Number(value) })} /><Field label="Included choices" type="number" value={String(section.included ?? 0)} onChange={(value) => onUpdate(index, { ...section, included: Number(value) })} /><Field label="Each extra · C$" type="number" value={String((section.extraPriceCents ?? 0) / 100)} onChange={(value) => onUpdate(index, { ...section, extraPriceCents: moneyToCents(value) })} /><Field label="Surcharge per option · e.g. Extra Cheese=2.30" wide value={formatOptionPrices(section.optionPrices)} onChange={(value) => onUpdate(index, { ...section, optionPrices: parseOptionPrices(value) })} />{!section.source ? <Field label="Options · comma separated" wide value={(section.options ?? []).join(", ")} onChange={(value) => onUpdate(index, { ...section, options: splitList(value) })} /> : null}</div><button className="text-button danger-text" onClick={() => onRemove(index)}>Remove this choice group</button></div>)}</div>;
}

const splitList = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);

const formatOptionPrices = (prices: Record<string, number> | undefined) =>
  Object.entries(prices ?? {}).map(([option, cents]) => `${option}=${(cents / 100).toFixed(2)}`).join(", ");

function parseOptionPrices(value: string): Record<string, number> | undefined {
  const entries = splitList(value)
    .map((entry) => entry.split("="))
    .filter((parts) => parts.length === 2 && parts[0].trim() && Number.isFinite(Number(parts[1])))
    .map(([option, amount]) => [option.trim(), moneyToCents(amount.trim())] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function VariationEditor({ variation, onSave }: { variation: Variation; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(variation.name); const [price, setPrice] = useState(String(variation.base_price_cents / 100)); const [extra, setExtra] = useState(String(variation.extra_topping_price_cents / 100)); const [included, setIncluded] = useState(String(variation.included_topping_units_bps / 10_000)); const [active, setActive] = useState(Boolean(variation.active)); const [order, setOrder] = useState(String(variation.display_order));
  return <div className="variation-row"><input aria-label="Option name" value={name} onChange={(event) => setName(event.target.value)} /><label>Menu price<input type="number" step=".01" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Extra topping<input type="number" step=".01" value={extra} onChange={(event) => setExtra(event.target.value)} /></label><label>Included toppings<input type="number" step="1" value={included} onChange={(event) => setIncluded(event.target.value)} /></label><label>Order<input type="number" value={order} onChange={(event) => setOrder(event.target.value)} /></label><Check label="Active" checked={active} onChange={setActive} /><button className="staff-button" onClick={() => onSave({ action: "variation.upsert", id: variation.id, productId: variation.product_id, name, basePriceCents: moneyToCents(price), extraToppingPriceCents: moneyToCents(extra), includedToppingUnitsBps: Number(included) * 10_000, active, displayOrder: Number(order) })}>Save option</button></div>;
}

function NewVariation({ productId, onSave }: { productId: string; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(""); const [price, setPrice] = useState("0"); const [extra, setExtra] = useState("0"); const [included, setIncluded] = useState("0");
  return <div className="variation-row variation-row--new"><input placeholder="New option name" value={name} onChange={(event) => setName(event.target.value)} /><label>Menu price<input type="number" step=".01" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Extra topping<input type="number" step=".01" value={extra} onChange={(event) => setExtra(event.target.value)} /></label><label>Included toppings<input type="number" value={included} onChange={(event) => setIncluded(event.target.value)} /></label><button className="staff-button" disabled={!name.trim()} onClick={() => onSave({ action: "variation.upsert", productId, name, basePriceCents: moneyToCents(price), extraToppingPriceCents: moneyToCents(extra), includedToppingUnitsBps: Number(included) * 10_000, active: true, displayOrder: 10000 })}>Add option</button></div>;
}

function NewProduct({ categories, onCreate }: { categories: Category[]; onCreate: (body: Record<string, unknown>) => Promise<unknown> }) {
  const activeCategories = categories.filter((category) => category.active);
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [categoryId, setCategoryId] = useState(activeCategories[0]?.id ?? ""); const [type, setType] = useState<Product["product_type"]>("simple"); const [price, setPrice] = useState(""); const [imageUrl, setImageUrl] = useState(""); const [busy, setBusy] = useState(false);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const result = await onCreate({ action: "product.create", name, categoryId, productType: type, basePriceCents: moneyToCents(price), description, imageUrl: imageUrl || null, active: false });
      if (result) { setName(""); setDescription(""); setPrice(""); setImageUrl(""); }
    } finally { setBusy(false); }
  };
  return <form className="menu-new-product" onSubmit={create}>
    <div className="menu-new-product__head"><div><span className="menu-setup-eyebrow">New menu item</span><h3>Start with what customers will see</h3><p>The item is created hidden, so you can review its photo and choices before publishing it.</p></div><span className="menu-draft-chip">Saved as hidden</span></div>
    <div className="settings-form"><Field label="Product name" value={name} onChange={setName} /><label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>{activeCategories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>How customers order it<select value={type} onChange={(event) => setType(event.target.value as Product["product_type"])}><option value="simple">One-tap simple item</option><option value="pizza">Pizza with sizes &amp; toppings</option><option value="bundle">Deal / bundle with choices</option><option value="configurable">Item with choices</option></select></label><Field label="Starting price · C$" type="number" value={price} onChange={setPrice} /><Field label="Menu description · optional" wide multiline value={description} onChange={setDescription} /></div>
    <p className="editor-hint menu-type-hint"><strong>{productTypeLabel(type)}:</strong> {productTypeHelp(type)}</p>
    <ProductImageField imageUrl={imageUrl} onChange={setImageUrl} />
    <div className="menu-new-product__footer"><p>{type === "pizza" ? "After creating it, add at least one size and price before you publish." : "After creating it, the full editor opens so you can check availability and choices."}</p><button className="staff-button" disabled={busy || name.trim().length < 2 || !categoryId || !Number.isFinite(Number(price)) || Number(price) < 0}>{busy ? "Creating…" : "Create hidden item"}</button></div>
  </form>;
}

function ToppingEditor({ topping, onSave }: { topping: Topping; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(topping.name); const [label, setLabel] = useState(topping.kitchen_label); const [meat, setMeat] = useState(Boolean(topping.is_meat)); const [halal, setHalal] = useState(Boolean(topping.halal_available)); const [active, setActive] = useState(Boolean(topping.active));
  return <details className="product-admin-card compact"><summary><span><strong>{topping.name}</strong><small>{topping.is_meat ? "Meat" : "Vegetarian"}{topping.halal_available ? " · halal alternative" : ""}</small></span><span>{topping.active ? "Live" : "Hidden"}</span></summary><div className="product-editor"><div className="settings-form"><Field label="Customer name" value={name} onChange={setName} /><Field label="Kitchen label" value={label} onChange={setLabel} /><Check label="Meat topping" checked={meat} onChange={setMeat} /><Check label="Halal alternative available" checked={halal} onChange={setHalal} /><Check label="Visible" checked={active} onChange={setActive} /></div><button className="staff-button" onClick={() => onSave({ action: "topping.upsert", id: topping.id, name, kitchenLabel: label, isMeat: meat, hasHalalVersion: halal, halalAvailable: halal, halalDisplayName: halal ? `Halal ${name}` : null, halalCostCents: 0, active })}>Save topping</button></div></details>;
}

function NewTopping({ onSave }: { onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  return <div className="admin-create-row"><strong>Add topping</strong><input placeholder="Topping name" value={name} onChange={(event) => setName(event.target.value)} /><button className="staff-button" disabled={!name.trim()} onClick={() => { onSave({ action: "topping.upsert", name, kitchenLabel: name.toUpperCase(), isMeat: false, hasHalalVersion: false, halalAvailable: false, halalCostCents: 0, active: true }); setName(""); }}>Create</button></div>;
}

/**
 * Pairing the time-clock tablet.
 *
 * C-09 gave the kiosk a name picker and, in doing so, published every member of
 * staff's first name to anyone who found the URL. The roster now needs a device
 * token, and this is where one is minted.
 *
 * The link is shown once and never again: only its hash is stored, so there is
 * nothing to show a second time. Pairing again invalidates the previous tablet,
 * which is also how a lost one is revoked.
 */
function KioskPairing() {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pair = async () => {
    setBusy(true);
    setError("");
    const response = await fetch("/api/admin/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "kiosk.pair" }),
    });
    const result = (await response.json()) as { pairingPath?: string; error?: string };
    setBusy(false);
    if (!response.ok || !result.pairingPath) { setError(result.error ?? "Pairing failed."); return; }
    setLink(`${window.location.origin}${result.pairingPath}`);
  };
  return <section className="staff-panel">
    <div className="staff-panel-head"><h2>Time clock tablet</h2></div>
    <p className="editor-hint">
      The staff list on the clock-in screen is only shown to a tablet you have paired. Generate a link, open it
      once on the tablet, and it is set up for good. Generating a new link unpairs the old tablet — do that if
      one is lost.
    </p>
    <button className="staff-button" disabled={busy} onClick={() => void pair()}>
      {busy ? "Generating…" : link ? "Generate a new link" : "Generate pairing link"}
    </button>
    {link ? <div className="manual-punch">
      <input readOnly value={link} aria-label="Kiosk pairing link" onFocus={(event) => event.target.select()} />
      <button className="staff-button" onClick={() => void navigator.clipboard?.writeText(link)}>Copy</button>
    </div> : null}
    {link ? <p className="editor-hint">Open this on the tablet now — it is not shown again.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}

export function AdminTeamPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState<"manager" | "employee">("employee"); const [permissions, setPermissions] = useState<string[]>(["view_orders", "acknowledge_orders", "change_order_status"]);
  const complete = async (body: Record<string, unknown>, success: string) => { setMessage(""); try { await configRequest(body); setMessage(success); await onSaved(); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); } };
  const submit = (event: FormEvent) => { event.preventDefault(); void complete({ action: "staff.create", name, email, password, role, permissions }, "Team access created."); setName(""); setEmail(""); setPassword(""); };
  return <div className="admin-stack admin-controls"><section className="staff-panel"><div className="staff-panel-head"><h2>Current team</h2><span className="live-chip">Individual access</span></div><div className="product-admin-cards">{dashboard.staff.map((member) => <StaffEditor key={member.id} member={member} currentUserId={dashboard.user.id} onSave={(body) => complete(body, `${member.name} access saved.`)} />)}{!dashboard.staff.length ? <p className="staff-empty">You do not have permission to view team access.</p> : null}</div></section><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Create team access</h2></div><div className="settings-form"><Field label="Name" value={name} onChange={setName} /><Field label="Email" type="email" value={email} onChange={setEmail} /><Field label="Temporary password · 12+ characters" type="password" value={password} onChange={setPassword} /><label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="employee">Employee</option><option value="manager">Manager</option></select></label></div><PermissionGrid selected={permissions} onChange={setPermissions} /><button className="staff-button">Create access</button></form><KioskPairing />{message ? <p className="admin-message" role="status">{message}</p> : null}</div>;
}

function StaffEditor({ member, currentUserId, onSave }: { member: StaffMember; currentUserId: string; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(member.name); const [email, setEmail] = useState(member.email); const [role, setRole] = useState<"manager" | "employee">(member.role === "manager" ? "manager" : "employee"); const [active, setActive] = useState(Boolean(member.active)); const [permissions, setPermissions] = useState(member.permissions);
  return <details className="product-admin-card"><summary><span><strong>{member.name}</strong><small>{member.email} · {member.role}{member.last_login_at ? ` · last signed in ${new Date(member.last_login_at).toLocaleDateString("en-CA")}` : ""}</small></span><span>{member.active ? "Active" : "Disabled"}</span></summary><div className="product-editor"><div className="settings-form"><Field label="Name" value={name} onChange={setName} /><Field label="Email" type="email" value={email} onChange={setEmail} /><label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="employee">Employee</option><option value="manager">Manager</option></select></label><Check label="Account active" checked={active} onChange={setActive} /></div><PermissionGrid selected={permissions} onChange={setPermissions} /><button className="staff-button" disabled={member.role === "owner" || (member.id === currentUserId && !active)} onClick={() => onSave({ action: "staff.update", staffId: member.id, name, email, role, permissions, active })}>{member.role === "owner" ? "Owner access is protected" : "Save access"}</button></div></details>;
}

function PermissionGrid({ selected, onChange }: { selected: string[]; onChange: (permissions: string[]) => void }) {
  return <div className="permission-grid">{allPermissions.map(([key, label]) => <Check key={key} label={label} checked={selected.includes(key)} onChange={(checked) => onChange(checked ? [...selected, key] : selected.filter((permission) => permission !== key))} />)}</div>;
}
