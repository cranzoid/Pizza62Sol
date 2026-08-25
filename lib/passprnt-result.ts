/**
 * What PassPRNT said on its way back, read once and replayed.
 *
 * PassPRNT reports the outcome of a print by appending `passprnt_code` and
 * `passprnt_message` to the callback URL. Both were previously deleted unread,
 * which is why "the printer does not work" was all anyone could report: the one
 * piece of evidence about a failure was discarded on arrival.
 *
 * The codes are stripped once they have been read, so a refresh cannot
 * resurrect a stale failure over a printer that is now fine. That scrub makes
 * reading destructive, and it is exactly the trap `lib/link-credentials.ts`
 * documents: React reads more than once — it re-renders from scratch when the
 * server and browser markups disagree, and double-invokes initialisers and
 * effects under StrictMode — so a second look at an already-cleaned URL finds
 * nothing and reports success for a ticket that never printed. The answer is
 * therefore captured outside React and every later caller is handed exactly
 * what the first one saw.
 *
 * Keyed by path so the till and the kitchen board cannot be served each
 * other's result. Module state resets on every page load, and PassPRNT returns
 * by navigating to `back=`, so each print gets its own reading.
 *
 * Browser only — there is no URL to read on the server. Callers reach it
 * through `useSyncExternalStore`, whose server snapshot is null.
 */
import { readPassPrntResult, type PassPrntResult } from "@/lib/passprnt";

const captured = new Map<string, PassPrntResult | null>();

export function capturePassPrntResult(): PassPrntResult | null {
  const url = new URL(window.location.href);
  const already = captured.get(url.pathname);
  if (already !== undefined) return already;

  const result = readPassPrntResult(url.toString());
  if (result) {
    url.searchParams.delete("passprnt_code");
    url.searchParams.delete("passprnt_message");
    window.history.replaceState({}, "", url.toString());
  }
  captured.set(url.pathname, result);
  return result;
}
