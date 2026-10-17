/**
 * Settings for the AI phone receptionist, all of them defaulting to safe.
 *
 * Read through the integration-secret store (database first, Key Vault /
 * environment second), like every other credential, so the owner can change
 * them without a deploy once there is a screen for it. Until then, nothing is
 * set, and nothing being set means: voice is off, the tool API refuses every
 * call, and a voice order can only ever be a pickup paid at the store.
 */
import { readIntegrationSecret } from "@/lib/integration-secrets";
import type { Fulfilment } from "@/lib/domain";

/**
 * `off` — the tool API answers nothing (the default, and the answer to any
 * unrecognised value). `internal`, `pilot` and `live` are the rollout stages
 * of docs/AI-RECEPTIONIST-ARCHITECTURE.md §20; the tool API treats them alike,
 * and the inbound call route (not built yet) is what will tell them apart.
 */
export type VoiceAiMode = "off" | "internal" | "pilot" | "live";
const MODES = new Set<VoiceAiMode>(["off", "internal", "pilot", "live"]);

export async function voiceAiMode(): Promise<VoiceAiMode> {
  const raw = (await readIntegrationSecret("VOICE_AI_MODE"))?.trim().toLowerCase() ?? "off";
  return MODES.has(raw as VoiceAiMode) ? (raw as VoiceAiMode) : "off";
}

/**
 * The bearer token the voice provider presents on every tool call, or null
 * when none is configured — in which case no tool call can authenticate at all.
 * A configured value shorter than 32 characters is treated as unset: a guessable
 * bearer is worse than none, because it looks like protection.
 */
export async function voiceToolSecret(): Promise<string | null> {
  const value = (await readIntegrationSecret("VOICE_TOOL_SECRET"))?.trim() ?? "";
  return value.length >= 32 ? value : null;
}

/**
 * Which fulfilments a voice order may use. Pickup only unless explicitly
 * `pickup,delivery`, and enabling delivery is also what turns on pay-at-the-door
 * for voice orders — the only way a voice delivery could be paid. That is the
 * owner's decision in the architecture's §22 Q6; until it is made, delivery is
 * simply not offered by phone.
 */
export async function voicePilotFulfilments(): Promise<ReadonlySet<Fulfilment>> {
  const raw = (await readIntegrationSecret("VOICE_PILOT_FULFILMENTS"))?.toLowerCase() ?? "";
  const named = new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
  return named.has("delivery") ? new Set<Fulfilment>(["pickup", "delivery"]) : new Set<Fulfilment>(["pickup"]);
}

/** The largest order (amount due, in cents) the AI may place. Above it, the caller is handed to staff. */
export async function voiceMaxOrderCents(): Promise<number> {
  const parsed = Number(await readIntegrationSecret("VOICE_MAX_ORDER_CENTS"));
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 100_000 ? parsed : DEFAULT_VOICE_MAX_ORDER_CENTS;
}

export const DEFAULT_VOICE_MAX_ORDER_CENTS = 15_000;

/** A session is good for one phone call. */
export const VOICE_SESSION_TTL_MS = 30 * 60_000;
/** How long a caller's "yes" stays good for placing the order. */
export const VOICE_CONFIRMATION_TTL_MS = 5 * 60_000;
/** Tool calls one session may make; a runaway loop stops here rather than at the bill. */
export const VOICE_MAX_TOOL_CALLS = 150;
/** Consecutive failed tool calls after which the agent is told to hand the caller to staff. */
export const VOICE_ESCALATE_AFTER_FAILURES = 3;
/** The longest note a voice line may carry. Shorter than the website's: it is read back aloud. */
export const VOICE_MAX_NOTE_LENGTH = 200;
