/**
 * A deterministic voice-order simulator for developers. Not an AI agent.
 *
 * It does what a phone agent would do with the tools, in a fixed order and
 * with no language model: mint a test voice session, start an order, resolve
 * each spoken item with `search_menu`, add the match with the hints the
 * resolver detected (or an explicit line), take a name and number, ask for the
 * read-back — and, only with `--place`, confirm and place it through
 * `createOrder`. Every tool response is printed, cart version and quote
 * included, so a change to the tools or the menu can be checked end to end
 * without Twilio or ElevenLabs.
 *
 *   node --experimental-strip-types --import ./register-alias.mjs scripts/voice-sim.ts \
 *     --fulfilment pickup --name "Jordan" --phone 9055550177 \
 *     --item "large pepperoni" \
 *     --line '{"productId":"24-wings","modifiers":[{"id":"wing-style","values":["Breaded"]},{"id":"wing-flavours","values":["Hot"]}]}' \
 *     [--schedule "tomorrow 17:45"] [--coupon THANKS62] [--tip 15%|5.00|none] \
 *     [--place] [--at 2026-10-14T18:00:00-04:00]
 *
 * It is a script, reachable only from a shell with database access — there is
 * no route to it. Because `--place` creates a real order (and a real kitchen
 * alert, if notifications are configured), it refuses to run against anything
 * but a local database unless `VOICE_SIM_ALLOW_REMOTE=1` says otherwise.
 */
import type { MenuCandidate } from "@/lib/voice/menu-index";
import { runVoiceTool, type ToolEnvelope } from "@/lib/voice/tools";
import { createVoiceSession } from "@/lib/voice/session";

export type SimulationScript = {
  fulfilment: "pickup" | "delivery";
  /** Spoken item phrases, resolved with search_menu. */
  items: string[];
  /** Explicit add_item arguments, for choices the resolver does not detect (wing style, combo sections). */
  lines?: Array<Record<string, unknown>>;
  customer: { name: string; phone: string };
  address?: { line1: string; unit?: string; postalCode: string; instructions?: string };
  /** A day and time for set_schedule, as a caller would say them; omitted is ASAP. */
  schedule?: { day: string; time: string };
  coupon?: string;
  tip?: { type: "none" } | { type: "percentage"; percent: number } | { type: "custom"; amount: string };
  place?: boolean;
};

export type SimulationStep = { tool: string; args: unknown; status: number; response: ToolEnvelope };

export type SimulationResult = {
  sessionId: string;
  steps: SimulationStep[];
  readback: string | null;
  orderNumber: string | null;
  ok: boolean;
};

export async function runSimulation(script: SimulationScript, log: (step: SimulationStep) => void = () => undefined): Promise<SimulationResult> {
  const { session, sessionSecret } = await createVoiceSession({ provider: "simulator", mode: "test" });
  const steps: SimulationStep[] = [];
  const step = async (tool: string, args: Record<string, unknown> = {}) => {
    const { status, body } = await runVoiceTool(tool, sessionSecret, args);
    const entry = { tool, args, status, response: body };
    steps.push(entry);
    log(entry);
    return body as ToolEnvelope & {
      data?: { status?: string; candidates: MenuCandidate[]; readback?: string; cartVersion?: number; orderNumber?: string };
    };
  };
  const fail = (): SimulationResult => ({ sessionId: session.id, steps, readback: null, orderNumber: null, ok: false });

  await step("get_store_status");
  if (!(await step("start_order", { fulfilment: script.fulfilment })).ok) return fail();
  if (script.address && !(await step("check_delivery_address", script.address)).ok) return fail();
  for (const phrase of script.items) {
    const search = await step("search_menu", { query: phrase });
    if (search.data?.status !== "match") return fail();
    const [candidate] = search.data.candidates;
    const options = candidate.detected.options;
    const modifiers = [...new Set(options.map((option) => option.sectionId))].map((id) => ({
      id,
      values: options.filter((option) => option.sectionId === id).map((option) => option.value),
    }));
    const added = await step("add_item", {
      productId: candidate.productId,
      ...(candidate.variationId ? { variationId: candidate.variationId } : {}),
      ...(candidate.suggestedQuantity ? { quantity: candidate.suggestedQuantity } : {}),
      ...(candidate.detected.toppings.length ? { toppings: candidate.detected.toppings.map((topping) => ({ toppingId: topping.toppingId, placement: topping.placement })) } : {}),
      ...(candidate.detected.omitToppings.length ? { omitToppings: candidate.detected.omitToppings.map((topping) => topping.toppingId) } : {}),
      ...(candidate.detected.cheese ? { cheese: candidate.detected.cheese } : candidate.detected.extraCheese ? { extraCheese: true } : {}),
      ...(modifiers.length ? { modifiers } : {}),
    });
    if (!added.ok) return fail();
  }
  for (const line of script.lines ?? []) if (!(await step("add_item", line)).ok) return fail();
  if (script.schedule && !(await step("set_schedule", { when: "scheduled", ...script.schedule })).ok) return fail();
  if (script.coupon && !(await step("apply_coupon", { code: script.coupon })).ok) return fail();
  if (script.tip && !(await step("set_tip", script.tip)).ok) return fail();
  if (!(await step("set_customer", script.customer)).ok) return fail();
  const review = await step("review_order");
  if (!review.ok) return fail();
  const readback = String(review.data?.readback ?? "");
  if (!script.place) return { sessionId: session.id, steps, readback, orderNumber: null, ok: true };
  const cartVersion = review.data?.cartVersion;
  if (!(await step("confirm_order", { cartVersion, utterance: "yes (simulated)" })).ok) return { ...fail(), readback };
  const placed = await step("place_order", { cartVersion });
  return { sessionId: session.id, steps, readback, orderNumber: placed.ok ? String(placed.data?.orderNumber) : null, ok: placed.ok };
}

function parseArgs(argv: string[]) {
  const script: SimulationScript = { fulfilment: "pickup", items: [], lines: [], customer: { name: "Simulated Caller", phone: "9055550100" } };
  let at: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--fulfilment") script.fulfilment = value() === "delivery" ? "delivery" : "pickup";
    else if (flag === "--item") script.items.push(value());
    else if (flag === "--line") script.lines!.push(JSON.parse(value()));
    else if (flag === "--name") script.customer.name = value();
    else if (flag === "--phone") script.customer.phone = value();
    else if (flag === "--address") script.address = JSON.parse(value());
    else if (flag === "--schedule") {
      const match = /^(\S+)\s+(.+)$/.exec(value().trim());
      if (!match) throw new Error('--schedule needs "<day> <time>", e.g. "tomorrow 17:45"');
      script.schedule = { day: match[1], time: match[2] };
    } else if (flag === "--coupon") script.coupon = value();
    else if (flag === "--tip") {
      const tip = value().trim().toLowerCase();
      script.tip = tip === "none" ? { type: "none" } : tip.endsWith("%") ? { type: "percentage", percent: Number(tip.slice(0, -1)) } : { type: "custom", amount: tip };
    } else if (flag === "--place") script.place = true;
    else if (flag === "--at") at = value();
    else throw new Error(`unknown flag ${flag}`);
  }
  return { script, at };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) && process.env.VOICE_SIM_ALLOW_REMOTE !== "1") {
    console.error("voice-sim only runs against a local database (DATABASE_URL on localhost). Set VOICE_SIM_ALLOW_REMOTE=1 to override.");
    process.exitCode = 2;
    return;
  }
  const { script, at } = parseArgs(process.argv.slice(2));
  if (at) {
    const fixed = Date.parse(at);
    if (!Number.isFinite(fixed)) throw new Error(`--at ${at} is not a date`);
    // A simulator clock: every tool and the order engine see this instant,
    // including the offer-hours checks that read `new Date()`.
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [fixed]) as [number]));
      }
      static now() {
        return fixed;
      }
    } as DateConstructor;
  }
  const { closePool } = await import("@/db/pg-driver");
  try {
    const result = await runSimulation(script, (entry) => {
      console.log(`\n▶ ${entry.tool} ${JSON.stringify(entry.args)}  [HTTP ${entry.status}, cartVersion ${entry.response.cartVersion ?? "-"}, stage ${entry.response.stage ?? "-"}]`);
      console.log(JSON.stringify({ ok: entry.response.ok, say: entry.response.say, issues: entry.response.issues, data: entry.response.data }, null, 2));
    });
    console.log(`\nsession ${result.sessionId}: ${result.ok ? "ok" : "stopped"}${result.orderNumber ? `, order ${result.orderNumber}` : script.place ? "" : " (review only; pass --place to place it)"}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
