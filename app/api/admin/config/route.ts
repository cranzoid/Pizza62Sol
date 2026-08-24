import { authErrorResponse, createPasswordHash, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";

// H-11b: the closed vocabulary of promotion types. `applyPromotions` in
// lib/domain.ts matches on exactly these three and now ignores anything else;
// the two lists must stay in step, or an offer saved here would never apply.
const PROMOTION_TYPES = new Set(["percentage", "fixed", "free_delivery"]);

const PERMISSIONS = new Set([
  "view_orders",
  "acknowledge_orders",
  "change_order_status",
  "view_customer_contact",
  "view_delivery_address",
  "change_preparation_time",
  "pause_online_ordering",
  "mark_products_unavailable",
  "cancel_orders",
  "issue_refunds",
  "manage_menu",
  "manage_promotions",
  "manage_content",
  "manage_employees",
  "edit_time_records",
  "approve_correction_requests",
  "approve_time_off_requests",
  "view_analytics",
  "export_payroll",
  "manage_settings",
  "manual_order_override",
]);

type Body =
  | { action: "settings.update"; key?: string; value?: Record<string, unknown>; reason?: string; expectedVersion?: number }
  | {
      action: "topping.upsert";
      id?: string;
      name?: string;
      kitchenLabel?: string;
      isMeat?: boolean;
      hasHalalVersion?: boolean;
      halalDisplayName?: string;
      halalAvailable?: boolean;
      halalCostCents?: number;
      active?: boolean;
    }
  | {
      action: "product.update";
      productId?: string;
      categoryId?: string;
      name?: string;
      description?: string;
      productType?: "pizza" | "simple" | "bundle" | "configurable";
      basePriceCents?: number;
      imageUrl?: string | null;
      active?: boolean;
      soldOut?: boolean;
      pickupEligible?: boolean;
      deliveryEligible?: boolean;
      taxable?: boolean;
      halalCapable?: boolean;
      setupRequired?: boolean;
      kitchenLabel?: string;
      displayOrder?: number;
      configuration?: Record<string, unknown>;
    }
  | {
      action: "product.create";
      categoryId?: string;
      name?: string;
      description?: string;
      productType?: "pizza" | "simple" | "bundle" | "configurable";
      basePriceCents?: number;
      imageUrl?: string | null;
      active?: boolean;
    }
  | {
      action: "variation.upsert";
      id?: string;
      productId?: string;
      name?: string;
      basePriceCents?: number;
      extraToppingPriceCents?: number;
      includedToppingUnitsBps?: number;
      active?: boolean;
      displayOrder?: number;
    }
  | {
      action: "category.upsert";
      id?: string;
      name?: string;
      slug?: string;
      description?: string;
      active?: boolean;
      displayOrder?: number;
    }
  | {
      action: "staff.create";
      name?: string;
      email?: string;
      password?: string;
      role?: "manager" | "employee";
      permissions?: string[];
    }
  | {
      action: "staff.update";
      staffId?: string;
      name?: string;
      email?: string;
      role?: "manager" | "employee";
      permissions?: string[];
      active?: boolean;
    }
  | {
      action: "promotion.upsert";
      startsAt?: number | null;
      endsAt?: number | null;
      minSubtotalCents?: number;
      fulfilment?: string;
      usageLimit?: number | null;
      perCustomerLimit?: number | null;
      id?: string;
      name?: string;
      code?: string | null;
      type?: "percentage" | "fixed" | "free_delivery";
      amount?: number;
      priority?: number;
      combinable?: boolean;
      exclusive?: boolean;
      active?: boolean;
      rule?: Record<string, unknown>;
    };

function settingValidation(key: string, value: Record<string, unknown>) {
  if (key === "delivery") {
    const radius = Number(value.radiusKm);
    const fee = Number(value.feeCents);
    const minimum = Number(value.minimumCents);
    if (!(radius > 0 && radius <= 100) || !Number.isSafeInteger(fee) || fee < 0 || fee > 10_000 || !Number.isSafeInteger(minimum) || minimum < 0) {
      throw new Error("Delivery radius, fee, or minimum is outside the safe range.");
    }
  } else if (key === "taxAndTips") {
    const taxRate = Number(value.taxRateBps);
    const presets = value.tipPresetBps;
    if (!Number.isInteger(taxRate) || taxRate < 0 || taxRate > 3000 || !Array.isArray(presets) || presets.some((entry) => !Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > 10_000)) {
      throw new Error("Tax or tip settings are outside the safe range.");
    }
  } else if (key === "ordering") {
    const pickup = Number(value.pickupEstimateMinutes);
    const delivery = value.deliveryEstimateMinutes;
    if (!Number.isInteger(pickup) || pickup < 5 || pickup > 240 || (delivery !== null && (!Number.isInteger(delivery) || Number(delivery) < 5 || Number(delivery) > 360))) {
      throw new Error("Preparation estimates are outside the safe range.");
    }
  } else if (key === "business") {
    if (String(value.name ?? "").trim().length < 2 || String(value.phone ?? "").trim().length < 7) {
      throw new Error("Business name and phone are required.");
    }
    // Optional — an owner may deliberately not want order alerts by mail — but a
    // typo here is silent: the address is never replied to, so nothing bounces
    // back to anyone who would notice. Checked when it is given.
    const alertEmail = String(value.email ?? "").trim();
    if (alertEmail && (!/^\S+@\S+\.\S+$/.test(alertEmail) || alertEmail.length > 254)) {
      throw new Error("That order-alert email address does not look right.");
    }
  } else if (key === "operations") {
    const feedbackDelay = Number(value.feedbackDelayMinutes);
    if (!Number.isInteger(feedbackDelay) || feedbackDelay < 1 || feedbackDelay > 1440) {
      throw new Error("Feedback delay must be between 1 minute and 24 hours.");
    }
    // A half topping can be charged as anything from free up to a whole topping.
    const halfTopping = Number(value.halfToppingUnitsBps ?? 10_000);
    if (!Number.isInteger(halfTopping) || halfTopping < 0 || halfTopping > 10_000) {
      throw new Error("A half topping must count as between zero and one whole topping.");
    }
  } else if (key === "rewards") {
    // The code is checked against exactly the pattern `normalizeCouponCode`
    // accepts at checkout. A code this screen allows and the order path rejects
    // would be emailed to every customer who leaves feedback before anyone
    // noticed it does nothing.
    const code = String(value.feedbackRewardCode ?? "").trim().toUpperCase();
    if (value.feedbackRewardEnabled && !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(code)) {
      throw new Error("A reward code must be 1–40 letters, digits or hyphens, and cannot start with a hyphen.");
    }
    if (String(value.feedbackRewardOffer ?? "").length > 120) {
      throw new Error("Describe the reward in 120 characters or fewer.");
    }
  } else if (key === "hours") {
    if (!Array.isArray(value) || value.length !== 7 || value.some((row) => {
      if (!row || typeof row !== "object") return true;
      const item = row as Record<string, unknown>;
      return !Number.isInteger(item.weekday) || Number(item.weekday) < 0 || Number(item.weekday) > 6 ||
        !Number.isInteger(item.openMinute) || !Number.isInteger(item.closeMinute) ||
        Number(item.openMinute) < 0 || Number(item.closeMinute) > 1440 ||
        Number(item.openMinute) >= Number(item.closeMinute);
    })) throw new Error("Enter a valid opening and closing time for all seven days.");
  } else if (key === "content") {
    // The website editor stores words, switches, colours, a section order and the
    // promise rows, so the shape is checked rather than assumed to be flat text.
    const scalar = (entry: unknown) =>
      (typeof entry === "string" && entry.length <= 600) || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry));
    const shallow = (entry: unknown) =>
      scalar(entry) ||
      (Array.isArray(entry) && entry.length <= 24 && entry.every((item) => scalar(item) || (item && typeof item === "object" && Object.values(item).every(scalar))));
    if (Object.values(value).some((entry) => !shallow(entry))) {
      throw new Error("Website content must be text under 600 characters, switches, numbers or simple lists.");
    }
    for (const [field, entry] of Object.entries(value)) {
      if (field.startsWith("theme") && typeof entry === "string" && entry && !/^#[0-9a-fA-F]{6}$/.test(entry)) {
        throw new Error("Colours must be six-digit hex values such as #d33b27.");
      }
      if ((field === "logoUrl" || field === "heroImageUrl") && typeof entry === "string" && entry && !entry.startsWith("/api/uploads/") && !/^https:\/\//.test(entry)) {
        throw new Error("Images must be uploaded here or use an https address.");
      }
    }
    if (JSON.stringify(value).length > 20_000) throw new Error("Website content is too large.");
  } else if (key === "featureFlags") {
    // Feature switches are constrained by the owner interface.
  } else {
    throw new Error("That settings group cannot be changed through this endpoint.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Body;
    if (body.action === "settings.update") {
      const user = await requireStaff(request, "manage_settings");
      const key = body.key ?? "";
      const value = body.value ?? {};
      settingValidation(key, value);
      const current = await getD1()
        .prepare("SELECT value_json, version FROM settings WHERE key = ?")
        .bind(key)
        .first<{ value_json: string; version: number }>();
      if (!current) return Response.json({ error: "Settings group not found." }, { status: 404 });
      if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) {
        return Response.json({ error: "These settings changed in another session. Refresh before saving." }, { status: 409 });
      }
      const result = await getD1()
        .prepare(
          "UPDATE settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = ? AND version = ?",
        )
        .bind(JSON.stringify(value), user.id, Date.now(), key, current.version)
        .run();
      if (!result.meta.changes) return Response.json({ error: "Settings could not be saved safely." }, { status: 409 });
      await writeAudit({
        actorId: user.id,
        action: "settings.update",
        targetType: "setting",
        targetId: key,
        previous: JSON.parse(current.value_json),
        next: value,
        reason: body.reason,
      });
      return Response.json({ ok: true, version: current.version + 1 });
    }
    if (body.action === "topping.upsert") {
      const user = await requireStaff(request, "manage_menu");
      const name = body.name?.trim() ?? "";
      const kitchenLabel = body.kitchenLabel?.trim() ?? "";
      const halalCost = body.halalCostCents ?? 0;
      if (name.length < 2 || name.length > 80 || kitchenLabel.length < 1 || kitchenLabel.length > 40 || !Number.isSafeInteger(halalCost) || halalCost < 0 || halalCost > 10_000) {
        return Response.json({ error: "Enter a valid topping name, kitchen label, and halal cost." }, { status: 400 });
      }
      const id = body.id?.trim() || crypto.randomUUID();
      const previous = await getD1().prepare("SELECT * FROM toppings WHERE id = ?").bind(id).first();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO toppings
           (id, name, kitchen_label, is_meat, has_halal_version, halal_display_name,
            halal_available, halal_cost_cents, active, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, kitchen_label = excluded.kitchen_label,
             is_meat = excluded.is_meat, has_halal_version = excluded.has_halal_version,
             halal_display_name = excluded.halal_display_name, halal_available = excluded.halal_available,
             halal_cost_cents = excluded.halal_cost_cents, active = excluded.active,
             updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          name,
          kitchenLabel,
          body.isMeat ? 1 : 0,
          body.hasHalalVersion ? 1 : 0,
          body.halalDisplayName?.trim() || null,
          body.halalAvailable ? 1 : 0,
          halalCost,
          body.active === false ? 0 : 1,
          now,
          now,
        )
        .run();
      await writeAudit({ actorId: user.id, action: previous ? "topping.update" : "topping.create", targetType: "topping", targetId: id, previous, next: body });
      return Response.json({ ok: true, id });
    }
    if (body.action === "product.update") {
      const user = await requireStaff(request, "manage_menu");
      const id = body.productId ?? "";
      const previous = await getD1().prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (!previous) return Response.json({ error: "Product not found." }, { status: 404 });
      const basePrice = body.basePriceCents ?? Number(previous.base_price_cents);
      const name = body.name?.trim() || String(previous.name);
      const description = body.description?.trim() ?? String(previous.description);
      const categoryId = body.categoryId ?? String(previous.category_id);
      const productType = body.productType ?? String(previous.product_type);
      const imageUrl = body.imageUrl === undefined ? previous.image_url : body.imageUrl?.trim() || null;
      const configuration = body.configuration ?? JSON.parse(String(previous.configuration_json ?? "{}"));
      const displayOrder = body.displayOrder ?? Number(previous.display_order);
      const category = await getD1().prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId).first();
      if (
        !category ||
        !["pizza", "simple", "bundle", "configurable"].includes(productType) ||
        !Number.isSafeInteger(basePrice) || basePrice < 0 || basePrice > 100_000 ||
        !Number.isSafeInteger(displayOrder) || displayOrder < 0 || displayOrder > 100_000 ||
        name.length < 2 || name.length > 120 || description.length > 1000 ||
        (imageUrl !== null && !String(imageUrl).startsWith("/api/uploads/") && !/^https:\/\//.test(String(imageUrl))) ||
        JSON.stringify(configuration).length > 30_000
      ) {
        return Response.json({ error: "Product details, category, image, or pricing are invalid." }, { status: 400 });
      }
      await getD1()
        .prepare(
          `UPDATE products SET category_id = ?, name = ?, description = ?, product_type = ?,
             image_url = ?, base_price_cents = ?, active = ?, sold_out = ?, pickup_eligible = ?,
             delivery_eligible = ?, taxable = ?, halal_capable = ?, setup_required = ?,
             kitchen_label = ?, configuration_json = ?, display_order = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          categoryId,
          name,
          description,
          productType,
          imageUrl,
          basePrice,
          body.active ?? Boolean(previous.active) ? 1 : 0,
          body.soldOut ?? Boolean(previous.sold_out) ? 1 : 0,
          body.pickupEligible ?? Boolean(previous.pickup_eligible) ? 1 : 0,
          body.deliveryEligible ?? Boolean(previous.delivery_eligible) ? 1 : 0,
          body.taxable ?? Boolean(previous.taxable) ? 1 : 0,
          body.halalCapable ?? Boolean(previous.halal_capable) ? 1 : 0,
          body.setupRequired ?? Boolean(previous.setup_required) ? 1 : 0,
          body.kitchenLabel?.trim() || String(previous.kitchen_label ?? name.toUpperCase()).slice(0, 40),
          JSON.stringify(configuration),
          displayOrder,
          Date.now(),
          id,
        )
        .run();
      await writeAudit({ actorId: user.id, action: "product.update", targetType: "product", targetId: id, previous, next: body });
      return Response.json({ ok: true });
    }
    if (body.action === "product.create") {
      const user = await requireStaff(request, "manage_menu");
      const name = body.name?.trim() ?? "";
      const description = body.description?.trim() ?? "";
      const categoryId = body.categoryId ?? "";
      const productType = body.productType ?? "simple";
      const basePrice = body.basePriceCents ?? 0;
      const imageUrl = body.imageUrl?.trim() || null;
      const category = await getD1().prepare("SELECT id FROM categories WHERE id = ? AND active = 1").bind(categoryId).first();
      if (!category || name.length < 2 || name.length > 120 || description.length > 1000 || !["pizza", "simple", "bundle", "configurable"].includes(productType) || !Number.isSafeInteger(basePrice) || basePrice < 0 || basePrice > 100_000 || (imageUrl !== null && !imageUrl.startsWith("/api/uploads/") && !/^https:\/\//.test(imageUrl))) {
        return Response.json({ error: "Enter a valid product name, category, type, and price." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await getD1().prepare(
        `INSERT INTO products
         (id, category_id, name, slug, description, product_type, image_url, base_price_cents, taxable,
          pickup_eligible, delivery_eligible, halal_capable, promotion_eligible, active, sold_out,
          setup_required, kitchen_label, configuration_json, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 0, 1, ?, 0, ?, ?, '{}', 10000, ?, ?)`,
      ).bind(id, categoryId, name, id, description, productType, imageUrl, basePrice, body.active === false ? 0 : 1, productType === "pizza" ? 1 : 0, name.toUpperCase().slice(0, 40), now, now).run();
      await writeAudit({ actorId: user.id, action: "product.create", targetType: "product", targetId: id, next: body });
      return Response.json({ ok: true, id }, { status: 201 });
    }
    if (body.action === "variation.upsert") {
      const user = await requireStaff(request, "manage_menu");
      const productId = body.productId ?? "";
      const product = await getD1().prepare("SELECT id FROM products WHERE id = ? AND product_type = 'pizza'").bind(productId).first();
      const name = body.name?.trim() ?? "";
      const basePrice = body.basePriceCents ?? 0;
      const extraPrice = body.extraToppingPriceCents ?? 0;
      const includedUnits = body.includedToppingUnitsBps ?? 0;
      const displayOrder = body.displayOrder ?? 0;
      if (!product || name.length < 1 || name.length > 80 || ![basePrice, extraPrice, includedUnits, displayOrder].every(Number.isSafeInteger) || basePrice < 0 || basePrice > 100_000 || extraPrice < 0 || extraPrice > 20_000 || includedUnits < 0 || includedUnits > 200_000 || displayOrder < 0) {
        return Response.json({ error: "Variation name, prices, or included topping count are invalid." }, { status: 400 });
      }
      const id = body.id?.trim() || crypto.randomUUID();
      const previous = await getD1().prepare("SELECT * FROM product_variations WHERE id = ?").bind(id).first();
      const now = Date.now();
      await getD1().prepare(
        `INSERT INTO product_variations
         (id, product_id, name, base_price_cents, extra_topping_price_cents, included_topping_units_bps, active, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_price_cents = excluded.base_price_cents,
           extra_topping_price_cents = excluded.extra_topping_price_cents,
           included_topping_units_bps = excluded.included_topping_units_bps,
           active = excluded.active, display_order = excluded.display_order, updated_at = excluded.updated_at`,
      ).bind(id, productId, name, basePrice, extraPrice, includedUnits, body.active === false ? 0 : 1, displayOrder, now, now).run();
      await getD1().prepare("UPDATE products SET setup_required = 0, updated_at = ? WHERE id = ?").bind(now, productId).run();
      await writeAudit({ actorId: user.id, action: previous ? "variation.update" : "variation.create", targetType: "product_variation", targetId: id, previous, next: body });
      return Response.json({ ok: true, id });
    }
    if (body.action === "category.upsert") {
      const user = await requireStaff(request, "manage_menu");
      const name = body.name?.trim() ?? "";
      const slug = (body.slug?.trim() || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const description = body.description?.trim() ?? "";
      const displayOrder = body.displayOrder ?? 0;
      if (name.length < 2 || name.length > 80 || slug.length < 2 || slug.length > 100 || description.length > 500 || !Number.isSafeInteger(displayOrder) || displayOrder < 0) {
        return Response.json({ error: "Category name, description, or order is invalid." }, { status: 400 });
      }
      const id = body.id?.trim() || crypto.randomUUID();
      const previous = await getD1().prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
      const now = Date.now();
      await getD1().prepare(
        `INSERT INTO categories (id, name, slug, description, active, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug,
           description = excluded.description, active = excluded.active,
           display_order = excluded.display_order, updated_at = excluded.updated_at`,
      ).bind(id, name, slug, description || null, body.active === false ? 0 : 1, displayOrder, now, now).run();
      await writeAudit({ actorId: user.id, action: previous ? "category.update" : "category.create", targetType: "category", targetId: id, previous, next: body });
      return Response.json({ ok: true, id });
    }
    if (body.action === "staff.create") {
      const user = await requireStaff(request, "manage_employees");
      const email = body.email?.trim().toLowerCase() ?? "";
      const name = body.name?.trim() ?? "";
      const permissions = [...new Set(body.permissions ?? [])];
      if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || name.length > 80 || permissions.some((permission) => !PERMISSIONS.has(permission))) {
        return Response.json({ error: "Employee name, email, or permissions are invalid." }, { status: 400 });
      }
      const password = await createPasswordHash(body.password ?? "");
      const id = crypto.randomUUID();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO staff_users
           (id, email, name, role, password_hash, password_salt, password_iterations,
            permissions_json, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(id, email, name, body.role === "manager" ? "manager" : "employee", password.hash, password.salt, password.iterations, JSON.stringify(permissions), now, now)
        .run();
      await writeAudit({ actorId: user.id, action: "staff.create", targetType: "staff_user", targetId: id, next: { email, name, role: body.role, permissions } });
      return Response.json({ ok: true, id }, { status: 201 });
    }
    if (body.action === "staff.update") {
      const user = await requireStaff(request, "manage_employees");
      const id = body.staffId ?? "";
      const previous = await getD1().prepare("SELECT id, email, name, role, permissions_json, active FROM staff_users WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (!previous) return Response.json({ error: "Team member not found." }, { status: 404 });
      const email = body.email?.trim().toLowerCase() ?? String(previous.email);
      const name = body.name?.trim() ?? String(previous.name);
      const role = body.role ?? String(previous.role);
      const permissions = [...new Set(body.permissions ?? JSON.parse(String(previous.permissions_json ?? "[]")) as string[])];
      const active = body.active ?? Boolean(previous.active);
      if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2 || name.length > 80 || !["manager", "employee"].includes(role) || permissions.some((permission) => !PERMISSIONS.has(permission))) {
        return Response.json({ error: "Team member details or permissions are invalid." }, { status: 400 });
      }
      if (id === user.id && !active) {
        return Response.json({ error: "You cannot disable your own active account." }, { status: 400 });
      }
      // C-04: a user with manage_employees must not be able to elevate themselves.
      // Changing your own role or permission set is refused and audited.
      if (id === user.id) {
        const previousPermissions = [...new Set(JSON.parse(String(previous.permissions_json ?? "[]")) as string[])].sort();
        const requestedPermissions = [...permissions].sort();
        const roleChanged = role !== String(previous.role);
        const permissionsChanged =
          previousPermissions.length !== requestedPermissions.length ||
          previousPermissions.some((value, index) => value !== requestedPermissions[index]);
        if (roleChanged || permissionsChanged) {
          await writeAudit({
            actorId: user.id,
            action: "staff.self_elevation_blocked",
            targetType: "staff_user",
            targetId: id,
            previous: { role: previous.role, permissions: previousPermissions },
            next: { role, permissions: requestedPermissions },
          });
          return Response.json(
            { error: "You cannot change your own role or permissions. Ask another owner to make this change." },
            { status: 403 },
          );
        }
      }
      await getD1().prepare(
        "UPDATE staff_users SET email = ?, name = ?, role = ?, permissions_json = ?, active = ?, updated_at = ? WHERE id = ?",
      ).bind(email, name, role, JSON.stringify(permissions), active ? 1 : 0, Date.now(), id).run();
      if (!active) {
        await getD1().prepare("UPDATE staff_sessions SET revoked_at = ? WHERE staff_user_id = ? AND revoked_at IS NULL").bind(Date.now(), id).run();
      }
      await writeAudit({ actorId: user.id, action: "staff.update", targetType: "staff_user", targetId: id, previous, next: { email, name, role, permissions, active } });
      return Response.json({ ok: true });
    }
    if (body.action === "promotion.upsert") {
      const user = await requireStaff(request, "manage_promotions");
      const name = body.name?.trim() ?? "";
      const type = body.type;
      const amount = body.amount ?? 0;
      // H-11b: the check used to be `!type`, which accepted any non-empty
      // string. `applyPromotions` then fell through to its `else` arm and
      // granted free delivery, so a single typo here gave away every delivery
      // fee on the site. The vocabulary is now closed on both sides.
      if (!PROMOTION_TYPES.has(String(type))) {
        return Response.json({ error: "Promotion type must be percentage, fixed, or free_delivery." }, { status: 400 });
      }
      if (name.length < 2 || name.length > 120 || !Number.isSafeInteger(amount) || amount < 0 || (type === "percentage" && amount > 10_000) || (type === "fixed" && amount > 100_000)) {
        return Response.json({ error: "Promotion name, type, or amount is invalid." }, { status: 400 });
      }
      const id = body.id?.trim() || crypto.randomUUID();
      const previous = await getD1()
        .prepare("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      const now = Date.now();

      // H-11a: patch-merge rather than overwrite. The admin editor does not send
      // `exclusive` or `rule`, and the previous version wrote both
      // unconditionally — so every save from that screen silently reset
      // `exclusive` to false and replaced `rule_json` with `{}`, discarding the
      // product and category targeting that decides which lines an offer even
      // applies to. Nothing in the UI showed the loss.
      //
      // Only fields the caller actually supplied are written. `undefined` means
      // "leave alone"; an explicit `null` still clears, so removing a coupon code
      // continues to work.
      const keep = <T,>(supplied: T | undefined, existing: unknown, fallback: T): T =>
        supplied !== undefined ? supplied : previous ? (existing as T) : fallback;

      const code = body.code !== undefined ? body.code?.trim().toUpperCase() || null : previous ? (previous.code as string | null) : null;
      const priority = keep(body.priority, previous?.priority, 0);
      const combinable = body.combinable !== undefined ? (body.combinable === false ? 0 : 1) : previous ? Number(previous.combinable ?? 1) : 1;
      const exclusive = body.exclusive !== undefined ? (body.exclusive ? 1 : 0) : previous ? Number(previous.exclusive ?? 0) : 0;
      const active = body.active !== undefined ? (body.active ? 1 : 0) : previous ? Number(previous.active ?? 0) : 0;
      const ruleJson = body.rule !== undefined ? JSON.stringify(body.rule) : previous ? String(previous.rule_json ?? "{}") : "{}";

      // Eligibility the owner can set without a developer. Same patch-merge rule
      // as everything above: `undefined` leaves the stored value alone, so a
      // screen that does not send a field cannot blank it.
      const startsAt = body.startsAt !== undefined ? (body.startsAt ?? null) : previous ? (previous.starts_at as number | null) : null;
      const endsAt = body.endsAt !== undefined ? (body.endsAt ?? null) : previous ? (previous.ends_at as number | null) : null;
      if (startsAt !== null && endsAt !== null && Number(endsAt) <= Number(startsAt)) {
        return Response.json({ error: "The offer must end after it starts." }, { status: 400 });
      }
      const minSubtotal = keep(body.minSubtotalCents, previous?.min_subtotal_cents, 0);
      if (!Number.isSafeInteger(minSubtotal) || minSubtotal < 0 || minSubtotal > 100_000) {
        return Response.json({ error: "The minimum spend is outside the safe range." }, { status: 400 });
      }
      const promotionFulfilment = body.fulfilment !== undefined
        ? (["any", "pickup", "delivery"].includes(String(body.fulfilment)) ? String(body.fulfilment) : "any")
        : previous ? String(previous.fulfilment ?? "any") : "any";
      // Null is unlimited. Zero would mean an offer nobody can ever use, which is
      // never what someone means by typing it — so it is refused rather than saved.
      const limit = (value: unknown, label: string): number | null => {
        if (value === undefined) return null;
        if (value === null || value === "") return null;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a whole number of at least 1, or blank for unlimited.`);
        return parsed;
      };
      let usageLimit: number | null;
      let perCustomerLimit: number | null;
      try {
        usageLimit = body.usageLimit !== undefined ? limit(body.usageLimit, "Total uses") : previous ? (previous.usage_limit as number | null) : null;
        perCustomerLimit = body.perCustomerLimit !== undefined ? limit(body.perCustomerLimit, "Uses per customer") : previous ? (previous.per_customer_limit as number | null) : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      await getD1()
        .prepare(
          `INSERT INTO promotions
           (id, name, code, type, amount, priority, combinable, exclusive, active, rule_json,
            starts_at, ends_at, min_subtotal_cents, fulfilment, usage_limit, per_customer_limit,
            display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code,
             type = excluded.type, amount = excluded.amount, priority = excluded.priority,
             combinable = excluded.combinable, exclusive = excluded.exclusive,
             active = excluded.active, rule_json = excluded.rule_json,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             min_subtotal_cents = excluded.min_subtotal_cents, fulfilment = excluded.fulfilment,
             usage_limit = excluded.usage_limit, per_customer_limit = excluded.per_customer_limit,
             updated_at = excluded.updated_at`,
        )
        .bind(id, name, code, type, amount, priority, combinable, exclusive, active, ruleJson,
              startsAt, endsAt, minSubtotal, promotionFulfilment, usageLimit, perCustomerLimit, now, now)
        .run();
      await writeAudit({ actorId: user.id, action: previous ? "promotion.update" : "promotion.create", targetType: "promotion", targetId: id, previous, next: body });
      return Response.json({ ok: true, id });
    }
    return Response.json({ error: "Unsupported configuration action." }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      return Response.json({ error: "That email or code is already in use." }, { status: 409 });
    }
    try {
      return authErrorResponse(error);
    } catch {
      return Response.json({ error: error instanceof Error ? error.message : "Configuration could not be saved." }, { status: 400 });
    }
  }
}
