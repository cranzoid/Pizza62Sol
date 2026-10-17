/**
 * The voice cart: what a tool call may say about a line, and how the session's
 * draft becomes an `OrderRequest`.
 *
 * **Input is whitelisted, not filtered.** A tool's arguments are checked field
 * by field against the list of what it accepts, and anything else is refused
 * by name — a price, a subtotal, a fee, `freeDelivery`, a discount, a channel,
 * an idempotency key. Silently dropping them would hide a misconfigured tool or
 * a prompt injection that got as far as the arguments; refusing says so.
 *
 * **The request is built here, by the server.** Fulfilment, customer, address,
 * schedule (ASAP), payment (pay at store) and tip (none) come from the session
 * and the voice policy. Nothing the model sends reaches `OrderRequest` except
 * menu ids and choices, and those are validated and priced by `quoteOrder` /
 * `createOrder` like any website order.
 */
import type { ToppingPlacement } from "@/lib/domain";
import { containsPaymentDetails } from "@/lib/voice/redact";
import type { OrderRequest } from "@/lib/order-service";
import { VOICE_MAX_NOTE_LENGTH } from "@/lib/voice/config";
import type { VoiceCartLine, VoiceSession } from "@/lib/voice/session";

export type ToolIssue = { code: string; message: string; lineId?: string | null; field?: string };

/** Fields no voice tool ever accepts, named so the refusal says exactly what was refused. */
const FORBIDDEN_FIELDS = new Set([
  "price", "priceCents", "unitPrice", "unitPriceCents", "lineTotalCents", "subtotal", "subtotalCents",
  "menuSubtotalCents", "total", "totalCents", "amountDueCents", "expectedAmountDueCents", "tax", "taxCents",
  "fee", "deliveryFee", "deliveryFeeCents", "freeDelivery", "discount", "discountCents", "couponCode",
  "giftCardCode", "promotion", "promotionId", "tip", "channel", "policy", "staffEntry", "staffUserId",
  "context", "actorId", "idempotencyKey", "paymentMethod", "paymentToken", "card", "cardNumber",
]);

export class ToolInputError extends Error {
  readonly issues: ToolIssue[];
  constructor(issues: ToolIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.issues = issues;
  }
}

/** Refuses any field outside `allowed`, naming money and trust fields specifically. */
export function assertOnlyFields(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError([{ code: "INVALID_INPUT", message: "The tool arguments must be a JSON object." }]);
  }
  const record = input as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const issues: ToolIssue[] = [];
  for (const field of Object.keys(record)) {
    if (allowedSet.has(field)) continue;
    issues.push(
      FORBIDDEN_FIELDS.has(field)
        ? { code: "FIELD_NOT_ACCEPTED", field, message: `${field} is set by the restaurant's system, never by the caller or the agent.` }
        : { code: "UNKNOWN_FIELD", field, message: `${field} is not an argument of this tool.` },
    );
  }
  if (issues.length) throw new ToolInputError(issues);
  return record;
}

const PLACEMENTS = new Set<ToppingPlacement>(["whole", "left", "right"]);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function text(value: unknown, field: string, issues: ToolIssue[], options: { required?: boolean; max?: number } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    if (options.required) issues.push({ code: "INVALID_INPUT", field, message: `${field} is required.` });
    return null;
  }
  if (typeof value !== "string") {
    issues.push({ code: "INVALID_INPUT", field, message: `${field} must be text.` });
    return null;
  }
  const trimmed = value.trim();
  if (options.max && trimmed.length > options.max) {
    issues.push({ code: "INVALID_INPUT", field, message: `${field} must be at most ${options.max} characters.` });
    return null;
  }
  return trimmed || null;
}

export function readId(value: unknown, field: string, issues: ToolIssue[], required = true): string | null {
  const id = text(value, field, issues, { required, max: 80 });
  if (id !== null && !ID.test(id)) {
    issues.push({ code: "INVALID_INPUT", field, message: `${field} must be a menu id from search_menu or get_menu_item.` });
    return null;
  }
  return id;
}

export function readText(value: unknown, field: string, issues: ToolIssue[], options: { required?: boolean; max?: number } = {}): string | null {
  return text(value, field, issues, options);
}

/** The parts of a line a caller can choose. Every field optional, so the same reader serves add and update. */
export type LineChoices = Partial<Pick<VoiceCartLine, "productId" | "variationId" | "quantity" | "toppings" | "omitToppings" | "extraCheese" | "modifiers" | "notes">>;

export const LINE_FIELDS = ["productId", "variationId", "quantity", "toppings", "omitToppings", "extraCheese", "modifiers", "notes"] as const;

export function readLineChoices(record: Record<string, unknown>, issues: ToolIssue[]): LineChoices {
  const choices: LineChoices = {};
  if ("productId" in record) choices.productId = readId(record.productId, "productId", issues) ?? undefined;
  if ("variationId" in record) choices.variationId = record.variationId === null ? null : readId(record.variationId, "variationId", issues);
  if ("quantity" in record) {
    const quantity = Number(record.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      issues.push({ code: "INVALID_INPUT", field: "quantity", message: "quantity must be a whole number from 1 to 100." });
    } else choices.quantity = quantity;
  }
  if ("toppings" in record) {
    if (!Array.isArray(record.toppings) || record.toppings.length > 30) {
      issues.push({ code: "INVALID_INPUT", field: "toppings", message: "toppings must be a list of {toppingId, placement}." });
    } else {
      choices.toppings = [];
      for (const entry of record.toppings) {
        const topping = typeof entry === "string" ? { toppingId: entry, placement: "whole" } : (entry as Record<string, unknown>);
        const toppingId = readId(topping?.toppingId, "toppings.toppingId", issues);
        const placement = (topping?.placement ?? "whole") as ToppingPlacement;
        if (!PLACEMENTS.has(placement)) issues.push({ code: "INVALID_INPUT", field: "toppings.placement", message: "placement must be whole, left or right." });
        else if (toppingId) choices.toppings.push({ toppingId, placement });
      }
    }
  }
  if ("omitToppings" in record) {
    if (!Array.isArray(record.omitToppings) || record.omitToppings.length > 20) {
      issues.push({ code: "INVALID_INPUT", field: "omitToppings", message: "omitToppings must be a list of topping ids." });
    } else choices.omitToppings = record.omitToppings.map((id) => readId(id, "omitToppings", issues)).filter((id): id is string => Boolean(id));
  }
  if ("extraCheese" in record) {
    if (typeof record.extraCheese !== "boolean") issues.push({ code: "INVALID_INPUT", field: "extraCheese", message: "extraCheese must be true or false." });
    else choices.extraCheese = record.extraCheese;
  }
  if ("modifiers" in record) {
    if (!Array.isArray(record.modifiers) || record.modifiers.length > 60) {
      issues.push({ code: "INVALID_INPUT", field: "modifiers", message: "modifiers must be a list of {id, values}." });
    } else {
      choices.modifiers = [];
      for (const entry of record.modifiers as Array<Record<string, unknown>>) {
        const id = text(entry?.id, "modifiers.id", issues, { required: true, max: 80 });
        const values = Array.isArray(entry?.values) ? entry.values : null;
        if (!id || !values || values.length > 20) {
          issues.push({ code: "INVALID_INPUT", field: "modifiers", message: "Each modifier needs an id and a list of values." });
          continue;
        }
        const parsed: VoiceCartLine["modifiers"][number]["values"] = [];
        for (const value of values) {
          if (typeof value === "string" && value.length <= 80) parsed.push(value);
          else if (value && typeof value === "object" && typeof (value as Record<string, unknown>).value === "string") {
            const placement = ((value as Record<string, unknown>).placement ?? "whole") as ToppingPlacement;
            if (!PLACEMENTS.has(placement)) issues.push({ code: "INVALID_INPUT", field: "modifiers.placement", message: "placement must be whole, left or right." });
            else parsed.push({ value: String((value as Record<string, unknown>).value).slice(0, 80), placement });
          } else issues.push({ code: "INVALID_INPUT", field: "modifiers.values", message: "A modifier value must be an option name." });
        }
        choices.modifiers.push({ id, values: parsed });
      }
    }
  }
  if ("notes" in record) {
    const notes = text(record.notes, "notes", issues, { max: VOICE_MAX_NOTE_LENGTH });
    // A note goes onto the order and the kitchen ticket. Card details never do.
    if (notes && containsPaymentDetails(notes)) {
      issues.push({ code: "PAYMENT_DETAILS_NOT_ACCEPTED", field: "notes", message: "Please don't share card details. Payment is at the store." });
    } else choices.notes = notes;
  }
  return choices;
}

/** What `createOrder` needs to know about a product to build its item: its recipe, if it has one. */
export type RecipeLookup = (productId: string) => string[] | null;

/**
 * A voice line as an `OrderRequest` item.
 *
 * A specialty pizza's recipe toppings are supplied here, so the caller only
 * names additions and omissions ("a Hawaiian, no ham"), and `validateItems`
 * still sees the full recipe it checks.
 */
export function toOrderItem(line: VoiceCartLine, recipeFor: RecipeLookup): NonNullable<OrderRequest["items"]>[number] {
  const recipe = recipeFor(line.productId);
  const toppings = recipe
    ? [
        ...recipe.filter((toppingId) => !line.omitToppings.includes(toppingId)).map((toppingId) => ({ toppingId, placement: "whole" as const })),
        ...line.toppings.filter((topping) => !(recipe.includes(topping.toppingId) && topping.placement === "whole")),
      ]
    : line.toppings;
  return {
    productId: line.productId,
    ...(line.variationId ? { variationId: line.variationId } : {}),
    quantity: line.quantity,
    ...(toppings.length ? { toppings } : {}),
    ...(recipe && line.omitToppings.length ? { omitToppings: line.omitToppings } : {}),
    ...(line.extraCheese ? { extraCheese: true } : {}),
    ...(line.modifiers.length ? { modifiers: line.modifiers } : {}),
    ...(line.notes ? { specialInstructions: line.notes } : {}),
  };
}

/**
 * The session's draft as an order request — every field the server's to set.
 * `idempotencyKey` and `expectedAmountDueCents` are added by `place_order` only.
 */
export function toOrderRequest(session: VoiceSession, recipeFor: RecipeLookup, cart: VoiceCartLine[] = session.cart): OrderRequest {
  return {
    fulfilment: session.fulfilment ?? "pickup",
    items: cart.map((line) => toOrderItem(line, recipeFor)),
    customer: { name: session.customerName ?? "", phone: session.customerPhone ?? "" },
    schedule: { type: "asap" },
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
    ...(session.fulfilment === "delivery" && session.deliveryAddress ? { address: session.deliveryAddress } : {}),
  };
}
