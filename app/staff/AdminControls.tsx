"use client";

import { FormEvent, useState } from "react";
import { formatMoney } from "@/lib/domain";
import type { Dashboard } from "@/app/staff/StaffPortal";

type Product = Dashboard["products"][number];
type Topping = Dashboard["toppings"][number];
type Category = Dashboard["categories"][number];
type Variation = Dashboard["variations"][number];
type StaffMember = Dashboard["staff"][number];
type ModifierSection = {
  id: string;
  label: string;
  source?: "toppings" | "wing_flavours" | "drinks" | "pizza_base";
  options?: string[];
  min: number;
  max: number;
  included?: number;
  extraPriceCents?: number;
  sharedGroup?: string;
  sharedIncluded?: number;
};

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
  const initialContent = settings.content?.value ?? {};
  const initialHours = (settings.hours.value as unknown as Array<{ weekday: number; label: string; openMinute: number; closeMinute: number }>).map((row) => ({ ...row }));
  const [message, setMessage] = useState("");
  const [deliveryForm, setDeliveryForm] = useState({ radius: String(delivery.radiusKm), fee: String(Number(delivery.feeCents) / 100), minimum: String(Number(delivery.minimumCents) / 100), feeTaxable: Boolean(delivery.feeTaxable), outsideAreaMessage: String(delivery.outsideAreaMessage ?? "") });
  const [orderingForm, setOrderingForm] = useState({ enabled: Boolean(ordering.enabled), pickupEnabled: Boolean(ordering.pickupEnabled), deliveryEnabled: Boolean(ordering.deliveryEnabled), payAtStorePickupEnabled: Boolean(ordering.payAtStorePickupEnabled), pickupEstimate: String(ordering.pickupEstimateMinutes), deliveryEstimate: String(ordering.deliveryEstimateMinutes), pauseMessage: String(ordering.pauseMessage ?? "") });
  const [businessForm, setBusinessForm] = useState({ name: String(business.name), phone: String(business.phone), address: String(business.address), latitude: String(business.latitude), longitude: String(business.longitude), reviewUrl: String(business.googleReviewUrl ?? ""), timeZone: String(business.timeZone ?? "America/Toronto") });
  const [taxForm, setTaxForm] = useState({ rate: String(Number(tax.taxRateBps) / 100), tippingEnabled: Boolean(tax.tippingEnabled), presets: (tax.tipPresetBps as number[]).map((entry) => entry / 100).join(", "), customTipEnabled: Boolean(tax.customTipEnabled) });
  const [operationsForm, setOperationsForm] = useState({ cancellation: String(operations.cancellationRequestWindowMinutes), feedbackDelay: String(operations.feedbackDelayMinutes), halalNotice: String(operations.halalNotice ?? "") });
  const [content, setContent] = useState({ heroEyebrow: String(initialContent.heroEyebrow ?? ""), heroHeadline: String(initialContent.heroHeadline ?? ""), heroAccent: String(initialContent.heroAccent ?? ""), heroDescription: String(initialContent.heroDescription ?? ""), dealEyebrow: String(initialContent.dealEyebrow ?? ""), dealHeadline: String(initialContent.dealHeadline ?? ""), dealDescription: String(initialContent.dealDescription ?? ""), footerTagline: String(initialContent.footerTagline ?? "") });
  const [hours, setHours] = useState(initialHours);
  const save = async (key: string, value: Record<string, unknown> | typeof hours) => {
    setMessage("");
    try {
      await configRequest({ action: "settings.update", key, value, expectedVersion: settings[key].version, reason: "Updated by owner in admin" });
      setMessage("Saved. The customer website now uses these settings.");
      await onSaved();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); }
  };
  return <div className="admin-stack admin-controls">
    <div className="staff-grid">
      <SettingsCard title="Ordering methods" onSave={() => save("ordering", { ...ordering, enabled: orderingForm.enabled, pickupEnabled: orderingForm.pickupEnabled, deliveryEnabled: orderingForm.deliveryEnabled, payAtStorePickupEnabled: orderingForm.payAtStorePickupEnabled, pickupEstimateMinutes: Number(orderingForm.pickupEstimate), deliveryEstimateMinutes: Number(orderingForm.deliveryEstimate), pauseMessage: orderingForm.pauseMessage })}>
        <Check label="Online ordering enabled" checked={orderingForm.enabled} onChange={(enabled) => setOrderingForm({ ...orderingForm, enabled })} />
        <Check label="Pickup orders" checked={orderingForm.pickupEnabled} onChange={(pickupEnabled) => setOrderingForm({ ...orderingForm, pickupEnabled })} />
        <Check label="Delivery orders" checked={orderingForm.deliveryEnabled} onChange={(deliveryEnabled) => setOrderingForm({ ...orderingForm, deliveryEnabled })} />
        <Check label="Pay at store for pickup" checked={orderingForm.payAtStorePickupEnabled} onChange={(payAtStorePickupEnabled) => setOrderingForm({ ...orderingForm, payAtStorePickupEnabled })} />
        <Field label="Pickup estimate · minutes" type="number" value={orderingForm.pickupEstimate} onChange={(pickupEstimate) => setOrderingForm({ ...orderingForm, pickupEstimate })} />
        <Field label="Delivery estimate · minutes" type="number" value={orderingForm.deliveryEstimate} onChange={(deliveryEstimate) => setOrderingForm({ ...orderingForm, deliveryEstimate })} />
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
      <SettingsCard title="Restaurant details" onSave={() => save("business", { ...business, name: businessForm.name, phone: businessForm.phone, address: businessForm.address, latitude: Number(businessForm.latitude), longitude: Number(businessForm.longitude), googleReviewUrl: businessForm.reviewUrl, timeZone: businessForm.timeZone })}>
        <Field label="Restaurant name" value={businessForm.name} onChange={(name) => setBusinessForm({ ...businessForm, name })} />
        <Field label="Phone" value={businessForm.phone} onChange={(phone) => setBusinessForm({ ...businessForm, phone })} />
        <Field label="Address" wide value={businessForm.address} onChange={(address) => setBusinessForm({ ...businessForm, address })} />
        <Field label="Latitude" type="number" value={businessForm.latitude} onChange={(latitude) => setBusinessForm({ ...businessForm, latitude })} />
        <Field label="Longitude" type="number" value={businessForm.longitude} onChange={(longitude) => setBusinessForm({ ...businessForm, longitude })} />
        <Field label="Google review URL" wide value={businessForm.reviewUrl} onChange={(reviewUrl) => setBusinessForm({ ...businessForm, reviewUrl })} />
        <Field label="Time zone" wide value={businessForm.timeZone} onChange={(timeZone) => setBusinessForm({ ...businessForm, timeZone })} />
      </SettingsCard>
      <SettingsCard title="Tax, tips & policies" onSave={async () => { await save("taxAndTips", { ...tax, taxRateBps: Math.round(Number(taxForm.rate) * 100), tippingEnabled: taxForm.tippingEnabled, tipPresetBps: taxForm.presets.split(",").map((entry) => Math.round(Number(entry.trim()) * 100)).filter(Number.isFinite), customTipEnabled: taxForm.customTipEnabled }); await save("operations", { ...operations, cancellationRequestWindowMinutes: Number(operationsForm.cancellation), feedbackDelayMinutes: Number(operationsForm.feedbackDelay), halalNotice: operationsForm.halalNotice }); }}>
        <Field label="HST · %" type="number" value={taxForm.rate} onChange={(rate) => setTaxForm({ ...taxForm, rate })} />
        <Field label="Tip buttons · % comma separated" value={taxForm.presets} onChange={(presets) => setTaxForm({ ...taxForm, presets })} />
        <Check label="Show tipping" checked={taxForm.tippingEnabled} onChange={(tippingEnabled) => setTaxForm({ ...taxForm, tippingEnabled })} />
        <Check label="Allow custom tips" checked={taxForm.customTipEnabled} onChange={(customTipEnabled) => setTaxForm({ ...taxForm, customTipEnabled })} />
        <Field label="Cancellation window · min" type="number" value={operationsForm.cancellation} onChange={(cancellation) => setOperationsForm({ ...operationsForm, cancellation })} />
        <Field label="Feedback delay · min" type="number" value={operationsForm.feedbackDelay} onChange={(feedbackDelay) => setOperationsForm({ ...operationsForm, feedbackDelay })} />
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
    <SettingsCard title="Regular opening hours" onSave={() => save("hours", hours)}>
      <div className="hours-admin">{hours.map((row, index) => <div key={row.weekday}><strong>{row.label}</strong><input aria-label={`${row.label} opening time`} type="time" value={minuteToTime(row.openMinute)} onChange={(event) => setHours((current) => current.map((entry, currentIndex) => currentIndex === index ? { ...entry, openMinute: timeToMinute(event.target.value) } : entry))} /><span>to</span><select aria-label={`${row.label} closing time`} value={String(row.closeMinute)} onChange={(event) => setHours((current) => current.map((entry, currentIndex) => currentIndex === index ? { ...entry, closeMinute: Number(event.target.value) } : entry))}>{[...new Set([row.closeMinute, ...CLOSE_MINUTE_OPTIONS])].sort((a, b) => a - b).map((minute) => <option key={minute} value={minute}>{closeMinuteLabel(minute)}</option>)}</select></div>)}</div>
    </SettingsCard>
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </div>;
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

export function AdminMenuPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const complete = async (work: () => Promise<unknown>, success: string) => {
    setMessage("");
    try { await work(); setMessage(success); await onSaved(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); }
  };
  return <div className="admin-stack admin-controls">
    <section className="staff-panel"><div className="staff-panel-head"><h2>Menu categories</h2><span className="live-chip">Names · order · visibility</span></div><div className="category-admin-list">{dashboard.categories.map((category) => <CategoryEditor key={category.id} category={category} onSave={(body) => complete(() => configRequest(body), `${category.name} category saved.`)} />)}</div><NewCategory onSave={(body) => complete(() => configRequest(body), "Category created.")} /></section>
    <section className="staff-panel"><div className="staff-panel-head"><h2>Products · {dashboard.products.length}</h2><span className="live-chip"><i /> Full owner control</span></div><div className="product-admin-cards">{dashboard.products.map((product) => <ProductEditor key={product.id} product={product} categories={dashboard.categories} variations={dashboard.variations.filter((variation) => variation.product_id === product.id)} toppings={dashboard.toppings} onSave={(body, success) => complete(() => configRequest(body), success)} />)}</div><NewProduct categories={dashboard.categories} onSave={(body) => complete(() => configRequest(body), "Product created. Open it above to add options or sizes.")} /></section>
    <section className="staff-panel"><div className="staff-panel-head"><h2>Toppings & halal options</h2><span className="live-chip">Names · kitchen labels · visibility</span></div><div className="product-admin-cards">{dashboard.toppings.map((topping) => <ToppingEditor key={topping.id} topping={topping} onSave={(body) => complete(() => configRequest(body), `${topping.name} saved.`)} />)}</div><NewTopping onSave={(body) => complete(() => configRequest(body), "Topping created.")} /></section>
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

function ProductEditor({ product, categories, variations, toppings, onSave }: { product: Product; categories: Category[]; variations: Variation[]; toppings: Topping[]; onSave: (body: Record<string, unknown>, success: string) => void }) {
  const [name, setName] = useState(product.name); const [description, setDescription] = useState(product.description); const [categoryId, setCategoryId] = useState(product.category_id); const [productType, setProductType] = useState(product.product_type); const [price, setPrice] = useState(String(product.base_price_cents / 100)); const [imageUrl, setImageUrl] = useState(product.image_url ?? ""); const [active, setActive] = useState(Boolean(product.active)); const [soldOut, setSoldOut] = useState(Boolean(product.sold_out)); const [pickup, setPickup] = useState(Boolean(product.pickup_eligible)); const [delivery, setDelivery] = useState(Boolean(product.delivery_eligible)); const [taxable, setTaxable] = useState(Boolean(product.taxable)); const [halal, setHalal] = useState(Boolean(product.halal_capable)); const [order, setOrder] = useState(String(product.display_order)); const [configuration, setConfiguration] = useState<Record<string, unknown>>({ ...product.configuration }); const [uploading, setUploading] = useState(false);
  const sections = (Array.isArray(configuration.sections) ? configuration.sections : []) as ModifierSection[];
  const availability = (configuration.availability as { weekdays?: number[]; startMinute?: number; endMinute?: number; timeZone?: string; label?: string } | undefined);
  const upload = async (file: File) => { setUploading(true); try { const data = new FormData(); data.set("file", file); const response = await fetch("/api/uploads", { method: "POST", body: data }); const result = await response.json() as { url?: string; error?: string }; if (!response.ok || !result.url) throw new Error(result.error ?? "Upload failed."); setImageUrl(result.url); } finally { setUploading(false); } };
  const updateSection = (index: number, next: ModifierSection) => setConfiguration({ ...configuration, sections: sections.map((section, current) => current === index ? next : section) });
  const setAvailability = (next?: typeof availability) => { const copy = { ...configuration }; if (next) copy.availability = next; else delete copy.availability; setConfiguration(copy); };
  return <details className="product-admin-card"><summary><span><strong>{product.name}</strong><small>{categories.find((category) => category.id === product.category_id)?.name} · {product.product_type} · {formatMoney(product.base_price_cents)}</small></span><span>{product.active ? product.sold_out ? "Sold out" : "Live" : "Hidden"}</span></summary><div className="product-editor">
    <div className="settings-form"><Field label="Product name" value={name} onChange={setName} /><label>Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label><label>Product type<select value={productType} onChange={(event) => setProductType(event.target.value as Product["product_type"])}><option value="simple">Simple item</option><option value="pizza">Pizza with price options</option><option value="bundle">Deal / bundle</option><option value="configurable">Configurable item</option></select></label><Field label="Card price · C$" type="number" value={price} onChange={setPrice} /><Field label="Display order" type="number" value={order} onChange={setOrder} /><Field label="Description" wide multiline value={description} onChange={setDescription} /></div>
    <div className="admin-switch-grid"><Check label="Visible" checked={active} onChange={setActive} /><Check label="Sold out" checked={soldOut} onChange={setSoldOut} /><Check label="Pickup" checked={pickup} onChange={setPickup} /><Check label="Delivery" checked={delivery} onChange={setDelivery} /><Check label="Taxable" checked={taxable} onChange={setTaxable} /><Check label="Halal choices" checked={halal} onChange={setHalal} /></div>
    <div className="image-admin"><div className="image-admin-preview">{imageUrl ? <span className="image-admin-thumb" style={{ backgroundImage: `url(${imageUrl})` }} /> : <span>No product image</span>}</div><label className="staff-button">{uploading ? "Uploading…" : "Upload image"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label><input aria-label="Product image URL" placeholder="Or paste an https image URL" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} /><button className="text-button" onClick={() => setImageUrl("")}>Remove image</button></div>
    {productType === "pizza" ? <div className="config-editor"><h3>Pizza setup</h3><div className="settings-form"><Field label="Price-option label" value={String(configuration.variationLabel ?? "Choose your size")} onChange={(variationLabel) => setConfiguration({ ...configuration, variationLabel })} /><Field label="Crust / bake / sauce choices · comma separated" wide value={(Array.isArray(configuration.pizzaBaseOptions) ? configuration.pizzaBaseOptions : []).join(", ")} onChange={(value) => setConfiguration({ ...configuration, pizzaBaseOptions: value.split(",").map((entry) => entry.trim()).filter(Boolean) })} /><Check label="Fixed specialty recipe" checked={Boolean(configuration.fixedRecipe)} onChange={(fixedRecipe) => setConfiguration({ ...configuration, fixedRecipe })} /><Check label="Recipe includes extra cheese" checked={Boolean(configuration.presetExtraCheese)} onChange={(presetExtraCheese) => setConfiguration({ ...configuration, presetExtraCheese })} /></div>{configuration.fixedRecipe ? <div className="recipe-toppings"><strong>Preselected recipe toppings</strong>{toppings.map((topping) => { const selected = (Array.isArray(configuration.recipeToppingIds) ? configuration.recipeToppingIds : []).includes(topping.id); return <Check key={topping.id} label={topping.name} checked={selected} onChange={(checked) => { const current = Array.isArray(configuration.recipeToppingIds) ? configuration.recipeToppingIds.map(String) : []; setConfiguration({ ...configuration, recipeToppingIds: checked ? [...current, topping.id] : current.filter((id) => id !== topping.id) }); }} />; })}</div> : null}</div> : <ModifierEditor sections={sections} onUpdate={updateSection} onRemove={(index) => setConfiguration({ ...configuration, sections: sections.filter((_, current) => current !== index) })} onAdd={() => setConfiguration({ ...configuration, sections: [...sections, { id: crypto.randomUUID(), label: "New choice", options: ["Option 1"], min: 0, max: 1, included: 1, extraPriceCents: 0 }] })} />}
    <div className="availability-editor"><Check label="Limit this product to advertised days and times" checked={Boolean(availability)} onChange={(checked) => setAvailability(checked ? { weekdays: [1, 2, 3, 4, 5], startMinute: 1020, endMinute: 1260, timeZone: "America/Toronto", label: "Mon–Fri · 5–9 PM" } : undefined)} />{availability ? <><div className="weekday-pills">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => <label key={day}><input type="checkbox" checked={(availability.weekdays ?? []).includes(index)} onChange={(event) => setAvailability({ ...availability, weekdays: event.target.checked ? [...(availability.weekdays ?? []), index] : (availability.weekdays ?? []).filter((entry) => entry !== index) })} />{day}</label>)}</div><div className="settings-form"><Field label="Starts" type="time" value={minuteToTime(availability.startMinute ?? 0)} onChange={(value) => setAvailability({ ...availability, startMinute: timeToMinute(value) })} /><Field label="Ends" type="time" value={minuteToTime(availability.endMinute ?? 0)} onChange={(value) => setAvailability({ ...availability, endMinute: timeToMinute(value) })} /><Field label="Customer label" value={availability.label ?? ""} onChange={(label) => setAvailability({ ...availability, label })} /></div></> : null}</div>
    {productType === "pizza" ? <div className="variation-admin"><div className="subhead"><h3>Price options / sizes</h3><small>Included toppings are part of the flyer price. Extras begin only after this allowance.</small></div>{variations.map((variation) => <VariationEditor key={variation.id} variation={variation} onSave={(body) => onSave(body, `${variation.name} pricing saved.`)} />)}<NewVariation productId={product.id} onSave={(body) => onSave(body, "Price option created.")} /></div> : null}
    <button className="staff-button save-product" onClick={() => onSave({ action: "product.update", productId: product.id, categoryId, name, description, productType, basePriceCents: moneyToCents(price), imageUrl: imageUrl || null, active, soldOut, pickupEligible: pickup, deliveryEligible: delivery, taxable, halalCapable: halal, displayOrder: Number(order), configuration }, `${name} saved.`)}>Save entire product</button>
  </div></details>;
}

function ModifierEditor({ sections, onUpdate, onRemove, onAdd }: { sections: ModifierSection[]; onUpdate: (index: number, section: ModifierSection) => void; onRemove: (index: number) => void; onAdd: () => void }) {
  return <div className="config-editor"><div className="subhead"><h3>Customer choices / modifiers</h3><button className="staff-button" onClick={onAdd}>Add choice group</button></div>{sections.map((section, index) => <div className="modifier-admin" key={section.id}><div className="settings-form"><Field label="Group label" value={section.label} onChange={(label) => onUpdate(index, { ...section, label })} /><label>Choice source<select value={section.source ?? "custom"} onChange={(event) => { const source = event.target.value; onUpdate(index, { ...section, source: source === "custom" ? undefined : source as ModifierSection["source"] }); }}><option value="custom">Custom options</option><option value="toppings">Toppings</option><option value="wing_flavours">Wing sauces & rubs</option><option value="drinks">Canned pop</option><option value="pizza_base">Crust, bake & sauce</option></select></label><Field label="Minimum choices" type="number" value={String(section.min)} onChange={(value) => onUpdate(index, { ...section, min: Number(value) })} /><Field label="Maximum choices" type="number" value={String(section.max)} onChange={(value) => onUpdate(index, { ...section, max: Number(value) })} /><Field label="Included choices" type="number" value={String(section.included ?? 0)} onChange={(value) => onUpdate(index, { ...section, included: Number(value) })} /><Field label="Each extra · C$" type="number" value={String((section.extraPriceCents ?? 0) / 100)} onChange={(value) => onUpdate(index, { ...section, extraPriceCents: moneyToCents(value) })} />{!section.source ? <Field label="Options · comma separated" wide value={(section.options ?? []).join(", ")} onChange={(value) => onUpdate(index, { ...section, options: value.split(",").map((entry) => entry.trim()).filter(Boolean) })} /> : null}</div><button className="text-button danger-text" onClick={() => onRemove(index)}>Remove this choice group</button></div>)}</div>;
}

function VariationEditor({ variation, onSave }: { variation: Variation; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(variation.name); const [price, setPrice] = useState(String(variation.base_price_cents / 100)); const [extra, setExtra] = useState(String(variation.extra_topping_price_cents / 100)); const [included, setIncluded] = useState(String(variation.included_topping_units_bps / 10_000)); const [active, setActive] = useState(Boolean(variation.active)); const [order, setOrder] = useState(String(variation.display_order));
  return <div className="variation-row"><input aria-label="Option name" value={name} onChange={(event) => setName(event.target.value)} /><label>Flyer price<input type="number" step=".01" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Extra topping<input type="number" step=".01" value={extra} onChange={(event) => setExtra(event.target.value)} /></label><label>Included toppings<input type="number" step="1" value={included} onChange={(event) => setIncluded(event.target.value)} /></label><label>Order<input type="number" value={order} onChange={(event) => setOrder(event.target.value)} /></label><Check label="Active" checked={active} onChange={setActive} /><button className="staff-button" onClick={() => onSave({ action: "variation.upsert", id: variation.id, productId: variation.product_id, name, basePriceCents: moneyToCents(price), extraToppingPriceCents: moneyToCents(extra), includedToppingUnitsBps: Number(included) * 10_000, active, displayOrder: Number(order) })}>Save option</button></div>;
}

function NewVariation({ productId, onSave }: { productId: string; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(""); const [price, setPrice] = useState("0"); const [extra, setExtra] = useState("0"); const [included, setIncluded] = useState("0");
  return <div className="variation-row variation-row--new"><input placeholder="New option name" value={name} onChange={(event) => setName(event.target.value)} /><label>Flyer price<input type="number" step=".01" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label>Extra topping<input type="number" step=".01" value={extra} onChange={(event) => setExtra(event.target.value)} /></label><label>Included toppings<input type="number" value={included} onChange={(event) => setIncluded(event.target.value)} /></label><button className="staff-button" disabled={!name.trim()} onClick={() => onSave({ action: "variation.upsert", productId, name, basePriceCents: moneyToCents(price), extraToppingPriceCents: moneyToCents(extra), includedToppingUnitsBps: Number(included) * 10_000, active: true, displayOrder: 10000 })}>Add option</button></div>;
}

function NewProduct({ categories, onSave }: { categories: Category[]; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(""); const [categoryId, setCategoryId] = useState(categories[0]?.id ?? ""); const [type, setType] = useState("simple"); const [price, setPrice] = useState("0");
  return <div className="admin-create-row"><strong>Add product</strong><input placeholder="Product name" value={name} onChange={(event) => setName(event.target.value)} /><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.filter((category) => category.active).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value)}><option value="simple">Simple item</option><option value="pizza">Pizza</option><option value="bundle">Deal / bundle</option><option value="configurable">Configurable</option></select><input aria-label="Price" type="number" step=".01" value={price} onChange={(event) => setPrice(event.target.value)} /><button className="staff-button" disabled={!name.trim()} onClick={() => { onSave({ action: "product.create", name, categoryId, productType: type, basePriceCents: moneyToCents(price), description: "" }); setName(""); }}>Create</button></div>;
}

function ToppingEditor({ topping, onSave }: { topping: Topping; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(topping.name); const [label, setLabel] = useState(topping.kitchen_label); const [meat, setMeat] = useState(Boolean(topping.is_meat)); const [halal, setHalal] = useState(Boolean(topping.halal_available)); const [active, setActive] = useState(Boolean(topping.active));
  return <details className="product-admin-card compact"><summary><span><strong>{topping.name}</strong><small>{topping.is_meat ? "Meat" : "Vegetarian"}{topping.halal_available ? " · halal alternative" : ""}</small></span><span>{topping.active ? "Live" : "Hidden"}</span></summary><div className="product-editor"><div className="settings-form"><Field label="Customer name" value={name} onChange={setName} /><Field label="Kitchen label" value={label} onChange={setLabel} /><Check label="Meat topping" checked={meat} onChange={setMeat} /><Check label="Halal alternative available" checked={halal} onChange={setHalal} /><Check label="Visible" checked={active} onChange={setActive} /></div><button className="staff-button" onClick={() => onSave({ action: "topping.upsert", id: topping.id, name, kitchenLabel: label, isMeat: meat, hasHalalVersion: halal, halalAvailable: halal, halalDisplayName: halal ? `Halal ${name}` : null, halalCostCents: 0, active })}>Save topping</button></div></details>;
}

function NewTopping({ onSave }: { onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  return <div className="admin-create-row"><strong>Add topping</strong><input placeholder="Topping name" value={name} onChange={(event) => setName(event.target.value)} /><button className="staff-button" disabled={!name.trim()} onClick={() => { onSave({ action: "topping.upsert", name, kitchenLabel: name.toUpperCase(), isMeat: false, hasHalalVersion: false, halalAvailable: false, halalCostCents: 0, active: true }); setName(""); }}>Create</button></div>;
}

export function AdminTeamPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState(""); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState<"manager" | "employee">("employee"); const [permissions, setPermissions] = useState<string[]>(["view_orders", "acknowledge_orders", "change_order_status"]);
  const complete = async (body: Record<string, unknown>, success: string) => { setMessage(""); try { await configRequest(body); setMessage(success); await onSaved(); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save."); } };
  const submit = (event: FormEvent) => { event.preventDefault(); void complete({ action: "staff.create", name, email, password, role, permissions }, "Team access created."); setName(""); setEmail(""); setPassword(""); };
  return <div className="admin-stack admin-controls"><section className="staff-panel"><div className="staff-panel-head"><h2>Current team</h2><span className="live-chip">Individual access</span></div><div className="product-admin-cards">{dashboard.staff.map((member) => <StaffEditor key={member.id} member={member} currentUserId={dashboard.user.id} onSave={(body) => complete(body, `${member.name} access saved.`)} />)}{!dashboard.staff.length ? <p className="staff-empty">You do not have permission to view team access.</p> : null}</div></section><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Create team access</h2></div><div className="settings-form"><Field label="Name" value={name} onChange={setName} /><Field label="Email" type="email" value={email} onChange={setEmail} /><Field label="Temporary password · 12+ characters" type="password" value={password} onChange={setPassword} /><label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="employee">Employee</option><option value="manager">Manager</option></select></label></div><PermissionGrid selected={permissions} onChange={setPermissions} /><button className="staff-button">Create access</button></form>{message ? <p className="admin-message" role="status">{message}</p> : null}</div>;
}

function StaffEditor({ member, currentUserId, onSave }: { member: StaffMember; currentUserId: string; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(member.name); const [email, setEmail] = useState(member.email); const [role, setRole] = useState<"manager" | "employee">(member.role === "manager" ? "manager" : "employee"); const [active, setActive] = useState(Boolean(member.active)); const [permissions, setPermissions] = useState(member.permissions);
  return <details className="product-admin-card"><summary><span><strong>{member.name}</strong><small>{member.email} · {member.role}{member.last_login_at ? ` · last signed in ${new Date(member.last_login_at).toLocaleDateString("en-CA")}` : ""}</small></span><span>{member.active ? "Active" : "Disabled"}</span></summary><div className="product-editor"><div className="settings-form"><Field label="Name" value={name} onChange={setName} /><Field label="Email" type="email" value={email} onChange={setEmail} /><label>Role<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="employee">Employee</option><option value="manager">Manager</option></select></label><Check label="Account active" checked={active} onChange={setActive} /></div><PermissionGrid selected={permissions} onChange={setPermissions} /><button className="staff-button" disabled={member.role === "owner" || (member.id === currentUserId && !active)} onClick={() => onSave({ action: "staff.update", staffId: member.id, name, email, role, permissions, active })}>{member.role === "owner" ? "Owner access is protected" : "Save access"}</button></div></details>;
}

function PermissionGrid({ selected, onChange }: { selected: string[]; onChange: (permissions: string[]) => void }) {
  return <div className="permission-grid">{allPermissions.map(([key, label]) => <Check key={key} label={label} checked={selected.includes(key)} onChange={(checked) => onChange(checked ? [...selected, key] : selected.filter((permission) => permission !== key))} />)}</div>;
}
