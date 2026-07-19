import { authErrorResponse, createPasswordHash, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";

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
      name?: string;
      description?: string;
      basePriceCents?: number;
      active?: boolean;
      soldOut?: boolean;
      pickupEligible?: boolean;
      deliveryEligible?: boolean;
      taxable?: boolean;
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
      action: "promotion.upsert";
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
  } else if (key === "operations") {
    const feedbackDelay = Number(value.feedbackDelayMinutes);
    if (!Number.isInteger(feedbackDelay) || feedbackDelay < 1 || feedbackDelay > 1440) {
      throw new Error("Feedback delay must be between 1 minute and 24 hours.");
    }
  } else if (key === "featureFlags" || key === "hours") {
    // These values are structurally constrained by the admin UI and version check below.
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
      if (!Number.isSafeInteger(basePrice) || basePrice < 0 || basePrice > 100_000 || name.length < 2 || name.length > 120 || description.length > 1000) {
        return Response.json({ error: "Product name, description, or price is invalid." }, { status: 400 });
      }
      await getD1()
        .prepare(
          `UPDATE products SET name = ?, description = ?, base_price_cents = ?,
             active = ?, sold_out = ?, pickup_eligible = ?, delivery_eligible = ?, taxable = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          name,
          description,
          basePrice,
          body.active ?? Boolean(previous.active) ? 1 : 0,
          body.soldOut ?? Boolean(previous.sold_out) ? 1 : 0,
          body.pickupEligible ?? Boolean(previous.pickup_eligible) ? 1 : 0,
          body.deliveryEligible ?? Boolean(previous.delivery_eligible) ? 1 : 0,
          body.taxable ?? Boolean(previous.taxable) ? 1 : 0,
          Date.now(),
          id,
        )
        .run();
      await writeAudit({ actorId: user.id, action: "product.update", targetType: "product", targetId: id, previous, next: body });
      return Response.json({ ok: true });
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
    if (body.action === "promotion.upsert") {
      const user = await requireStaff(request, "manage_promotions");
      const name = body.name?.trim() ?? "";
      const type = body.type;
      const amount = body.amount ?? 0;
      if (name.length < 2 || name.length > 120 || !type || !Number.isSafeInteger(amount) || amount < 0 || (type === "percentage" && amount > 10_000) || (type === "fixed" && amount > 100_000)) {
        return Response.json({ error: "Promotion name, type, or amount is invalid." }, { status: 400 });
      }
      const id = body.id?.trim() || crypto.randomUUID();
      const previous = await getD1().prepare("SELECT * FROM promotions WHERE id = ?").bind(id).first();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO promotions
           (id, name, code, type, amount, priority, combinable, exclusive, active, rule_json, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code,
             type = excluded.type, amount = excluded.amount, priority = excluded.priority,
             combinable = excluded.combinable, exclusive = excluded.exclusive,
             active = excluded.active, rule_json = excluded.rule_json, updated_at = excluded.updated_at`,
        )
        .bind(id, name, body.code?.trim().toUpperCase() || null, type, amount, body.priority ?? 0, body.combinable === false ? 0 : 1, body.exclusive ? 1 : 0, body.active ? 1 : 0, JSON.stringify(body.rule ?? {}), now, now)
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
