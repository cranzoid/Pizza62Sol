# Pizza 62 — Audit Remediation Worklog

Tracks implementation of the fixes called for in [PIZZA62_FULL_AUDIT.md](PIZZA62_FULL_AUDIT.md).

**Started:** 2026-07-24
**Baseline revision:** `c2480b7`
**Scope of this pass:** All 8 Critical launch blockers (C-01…C-08) plus the code-tractable High blockers that do not require an external service (Stripe test account, email provider, geocoder subscription, browser a11y lab). Highs that require those dependencies are listed as **Deferred** with the reason.

> Source-of-truth note: base pizza prices are corrected to the values in the audit's §5 / H-01 table (Medium $8.40, Large $11.49, XL $12.49, Jumbo $19.99, Slab $21.49 and the matching extra-topping rates). If the real flyer differs, update `lib/launch-config.ts` `PIZZA_SIZES` and re-run tests.

## Status legend
- ✅ Done — implemented and covered by test/typecheck/lint/build
- 🟡 Partial — meaningful fix landed, residual work noted
- ⏸ Deferred — needs an external dependency or a larger operational redesign (documented)

---

## Critical blockers

| ID | Title | Status | Notes |
|---|---|---|---|
| C-01 | Delivery geography not enforced | ✅ | `lib/delivery-area.ts` FSA→centroid resolver + `validateDelivery` wired into `createOrder` before order/payment; out-of-area → 422 `DELIVERY_ADDRESS_INELIGIBLE` |
| C-02 | Coded promotions auto-apply without a code | ✅ | `couponCode` added to order contract; coded promos apply only on exact match, unmatched code rejected, no-code = no coded discount |
| C-03 | Customer phone privacy bypass | ✅ | Dashboard gates `customer_phone`/`customer_email` behind `view_customer_contact`; sends `contactRedacted` flag |
| C-04 | Staff can elevate own role/permissions | ✅ | `staff.update` returns 403 + audit `staff.self_elevation_blocked` on self role/permission change |
| C-05 | Kitchen view lacks fulfilment data | ✅ | Dashboard returns item snapshots (size, toppings w/ half placement, cheese, halal, modifiers, notes) + address + payment; `KitchenTicket` renders them |
| C-06 | Concurrent clock-in corrupts state | ✅ | `time_clock_state` CAS row: only one of N racing transitions succeeds, others get 409. CAS + event insert commit as one `batch()` keyed by a per-request `transition_id` |
| C-07 | Checkout retry not idempotent (client) | ✅ | Durable per-attempt key in `localStorage`; cleared on success **and** on a terminal duplicate; concurrent in-flight submissions get 409 `CHECKOUT_IN_PROGRESS` and keep their key |
| C-08 | Seed overwrites owner data | ✅ | Products, variations, categories and toppings are all `ON CONFLICT DO NOTHING`; settings are seeded once; every correction and retirement runs through gated one-time `DATA_MIGRATIONS` |

## High blockers addressed this pass

| ID | Title | Status | Notes |
|---|---|---|---|
| H-01 | Incorrect pizza prices | ✅ | `PIZZA_SIZES` + bundle/deal/two-for-one/specialty extra rates corrected; hero `$8.99`→`$8.40`; test updated |
| H-02 | Shared two-pizza pool allocation/total | ✅ | Shared-group sections `min:0` (6+0 allowed); Large extra rate 210→230¢ |
| H-12 | Midnight closing time not saveable | ✅ | Close-time `<select>` with explicit `1440 = 12:00 AM (midnight)` option |
| H-13 | Runtime/migration schema drift | ✅ | Runtime + migration + Drizzle schema converge on 26 tables (incl. `customers`, `refunds`, `time_clock_state`) — verified **column by column**, not just by table count |
| H-16 | Missing security headers | ✅ | CSP/HSTS/nosniff/`X-Frame-Options`/Referrer-Policy/COOP added at worker edge |
| H-17 | Failed payment locks idempotency key | ✅ | Failed Stripe start now deletes the idempotency key so the same attempt can retry to a fresh order |
| H-19 | Dashboard sales metric misleading | ✅ | Metric uses Toronto calendar-day start and counts only paid (`pay_at_store` or `payment_status='paid'`) orders |
| H-21 | Unconfirmed halal/dry-rub claims enabled | ✅ | `halalPreparationClaim` + `dryRubLabel` set to `false`; test asserts it |

## Deferred (external dependency / operational redesign)

| ID | Title | Reason deferred |
|---|---|---|
| H-07 / H-25 | Online payment + refund lifecycle | Needs a real Stripe test account and refund-policy sign-off |
| H-10 | Notification/email dispatcher | Needs an email provider + domain |
| H-11 | Promotion/coupon owner UI | Large owner-UI build (Phase 2); engine hardened here |
| H-08 | Scheduling exceptions/closures/capacity | Phase 2 operational redesign |
| H-20 | Scheduled/history order queues + export | Phase 2 operational redesign |
| H-15 | Token-in-URL exposure | Needs hosting/referrer + one-time-exchange design |
| H-26 | Upload magic-byte/decoding validation | Needs an image-decode/re-encode pipeline choice |
| H-03/H-04/H-05 | Recipe enforcement, half toppings UI, halal on deals | Customer-UI build (partially server-guarded here) |
| H-09/H-18/H-14/H-22/H-23/H-24 | Feedback timing, event-race, FKs, menu content, cart revalidation, checkout review | Phase 2/3 scope |

---

## Change log
(chronological — newest at bottom)

### 2026-07-24 — Phase 1 code-tractable pass
Implemented all 8 Critical blockers and 8 code-tractable High blockers. Files touched:

- `lib/launch-config.ts` — H-01 pizza base/extra prices; H-21 claim flags off.
- `lib/menu.ts` — H-01/H-02 extra-topping rates across specialty/deals/combos/two-for-one/pickup/heroes; H-02 shared-pool `min:0`.
- `lib/order-service.ts` — C-02 coupon enforcement; C-01 delivery eligibility gate; H-17 idempotency-key release on Stripe failure.
- `lib/delivery-area.ts` (new) — C-01 FSA→centroid resolver.
- `db/runtime.ts` — H-13 `customers`/`refunds`/`time_clock_state` tables; C-08 insert-only product/variation seed + gated `DATA_MIGRATIONS` price correction.
- `db/schema.ts`, `drizzle/0000_quiet_epoch.sql` — H-13/C-06 `time_clock_state` in Drizzle schema + migration.
- `app/api/admin/dashboard/route.ts` — C-03 contact gate; C-05 item/address/payment detail; H-19 Toronto-day paid-only sales.
- `app/api/admin/config/route.ts` — C-04 self-elevation block.
- `app/api/timeclock/route.ts` — C-06 compare-and-swap transition guard.
- `app/customer/CustomerApp.tsx` — C-07 durable idempotency key; H-01 hero price.
- `app/staff/StaffPortal.tsx` + `app/globals.css` — C-05 `KitchenTicket`; H-19 labels.
- `app/staff/AdminControls.tsx` — H-12 midnight close-time select.
- `worker/index.ts` — H-16 security headers.
- `tests/domain.test.ts` — updated price expectations; added C-01 + H-21 tests.

**Verification:** `npm test` 20/20 pass · `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` complete · fresh-migration smoke test creates 26 app tables with runtime/migration parity (0 tables diverge).

**Assumptions / follow-ups for owner sign-off:**
1. Base pizza prices use the audit §5 values; 3-topping prices derived as `base + 2×extra`. Confirm against the physical flyer. **See follow-up review below — this one is not settled.**
2. C-01 uses Hamilton FSA centroids as an approximate geocoder. Swap `resolveDeliveryPoint` for a real geocoder before relying on edge-of-radius decisions.
3. The one-time price-correction migration overwrites variation prices to canonical on first run (safe pre-launch). Post-launch corrections must be added as new `DATA_MIGRATIONS` entries.
4. CSP allows `'unsafe-inline'` scripts/styles (framework requirement). A nonce-based CSP is future hardening.

### 2026-07-26 — Follow-up review of the Phase 1 pass

Re-verified every claim above against the code. C-01…C-06, H-01, H-12, H-16, H-17, H-19 and H-21 held up. Three items were marked ✅ but were not actually complete, plus one residual. All are now fixed.

**C-07 — the fix wedged the browser permanently.** `clearIdempotencyKey()` sat *after* the `result.duplicate` throw, so it was never reached on the duplicate path. Sequence: order is created, the response is lost, the customer retries, the server correctly answers `duplicate` — and the key stayed in `localStorage` forever, resolving every later checkout from that browser to the same duplicate. That browser could never order again.

- `lib/order-service.ts` — the duplicate branch now separates the two cases it was conflating. A key reserved but not yet resolved (`resource_id IS NULL`) means a concurrent submission of the same attempt is still running: that returns 409 `CHECKOUT_IN_PROGRESS`, thrown before the `try` so it does not release the key the in-flight request still owns. A resolved key returns the existing order's number, status, payment status, estimate and total. Tracking/feedback tokens are stored only as hashes and are deliberately **not** re-issued here.
- `app/customer/CustomerApp.tsx` — clears the key on a terminal duplicate and renders the confirmation instead of an error; `purchase_completed` no longer fires for duplicates.
- `Confirmation` handles a token-less result: the tracking/feedback links are omitted rather than rendered with an `undefined` token, replaced by the order number and a call-the-store line.

**C-08 — only products and variations were protected.** On a `menuSeedVersion` bump `seedLaunchData` still force-`UPDATE`d the `business`, `ordering`, `operations` and `featureFlags` settings back to launch defaults, upserted `categories` and `toppings`, and re-ran hard-coded `active = 0` retirement lists. The `business` overwrite reset the store coordinates that C-01's radius check depends on; the retirement lists silently switched off anything the owner had re-enabled.

- Settings are seeded once (`INSERT OR IGNORE`) and thereafter belong to the owner. Categories and toppings are now `ON CONFLICT DO NOTHING`.
- Removing the force-update also removed how existing databases received the H-21 flag correction, so that became its own gated migration: `json_set` patches `halalPreparationClaim` and `dryRubLabel` alone, preserving every other flag the owner has changed.
- The retirement lists became the gated `2026-07-24-retire-off-flyer-items` migration — applied once, not on every deployment.

**H-13 — parity was verified by table count, which missed a column difference.** Runtime declared `TEXT PRIMARY KEY` where the migration declares `TEXT PRIMARY KEY NOT NULL`. SQLite permits NULL in a non-INTEGER primary key, so all 26 runtime-created tables were genuinely weaker than migrated ones. Runtime now declares `NOT NULL` on every primary key. Note this only affects newly created tables — `CREATE TABLE IF NOT EXISTS` will not tighten a table that already exists, so a database initialised by the old runtime keeps the looser constraint until it is rebuilt or explicitly migrated.

**C-06 residual — CAS and event insert could diverge.** They were two separate statements: a successful CAS followed by a failed event insert would leave the guard row ahead of the event log, and since the CAS predicate is derived from event replay, every later transition would 409 — a permanent lockout. They now commit as one `batch()` (a single D1 transaction). A new `transition_id` column holds a per-request UUID; the event insert is `INSERT … SELECT … WHERE transition_id = ?`, so it fires only for the request that won the CAS. A losing racer writes nothing. `transition_id` was added to `db/runtime.ts`, `drizzle/0000_quiet_epoch.sql` and `db/schema.ts` together.

**Not fixed — needs the owner, not code.** The three-topping prices are *derived* (`base + 2×extra`), and the audit never supplied them; only the 1-topping and extra-topping rates came from source. All five changed as a side effect, and two landed on values that look wrong: X-Large went `$15.99 → $17.69`, and `$15.99` is exactly what the audit's own H-22/R-019 says the flyer advertises for the XL 3-topping pickup offer. Medium went `$12.49 → $12.60`. These are live customer prices and guessing a second time would not be better than guessing the first time — check `PIZZA_SIZES` in `lib/launch-config.ts` against the physical flyer before launch.

**Verification:** `npm test` 20/20 · `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` complete · migration-vs-runtime schema compared column by column (name, type, nullability) across all 26 tables — zero differences.

**Test coverage note:** every fix in this follow-up lives in D1-backed route/service code, and the suite is pure-domain only, so none of it is covered by an automated regression test. The duplicate-checkout path, the seed-idempotency guarantee and the clock-in race all still need the API/concurrency suite in the audit's Phase 3.

### 2026-08-20 — R1.3 Clover replaces Stripe, and R1.6 route-level tests

**Stripe is gone, not dormant.** `lib/clover.ts` now holds both halves of the
payment contract — creating a hosted checkout session and verifying the webhook
that reports its outcome — so the order service and the webhook route cannot
drift apart on it. The Stripe route, the `createStripeCheckout` helper, the
`STRIPE_*` reads, the payment-provider origins in the CSP, and the Stripe naming
across the customer and staff UIs are all deleted. `createOrder` lost its
`origin` parameter with them: it existed only to build Stripe's per-session
`success_url`.

Three properties of Clover forced design responses rather than renames.

1. **The charge must equal `total_cents`.** The cart goes to Clover as a single
   line item for the order's final total, with tips disabled and no tax rate.
   Itemising it and declaring a tax rate would let Clover recompute tax and
   charge whatever it arrived at, rather than the amount this application priced,
   stored, and will reconcile and refund against; the tip is already inside that
   total, so Clover's own tip screen would collect a second one no order row
   knows about. The itemisation the customer needs goes in the line item's note,
   where it cannot affect arithmetic.
2. **No metadata passthrough.** Stripe carried our order id on the session and
   handed it back; Clover does not. `payments.provider_reference` is written with
   the checkout session id immediately after creation and is the only link the
   webhook has back to the order.
3. **No expiry event, and 15-minute sessions.** `scripts/reap-payments.ts`
   cancels orders still in `awaiting_payment` after 20 minutes — the extra 5
   covering clock skew and a webhook in flight — and `enable_payment_reaper` now
   defaults to `true`. Without that job an abandoned checkout sits in the staff
   queue looking live forever. This is the reconciliation the audit found
   missing, moved from "a webhook we hope arrives" to "a timer we control".

**Two guards could not be carried over as written.** The Clover event carries no
amount, so the Stripe amount cross-check is not reproducible from the payload;
what protects the amount instead is that it is never sent from the browser. And a
`DECLINED` event records the decline but deliberately does not cancel the order —
the session is still valid and the customer may retry on it — so the reaper
decides, on the same timer as an abandonment. That decline writes status
`declined`, not `failed`: `failed` is what drops a row out of the partial
`payments_idempotency_uq` index and releases the checkout key (**H-17b**), which
is right when no session could be created and wrong when the order exists and
holds it.

**Return URLs are configured per merchant, not per session**, so the success URL
cannot carry `?order=&token=`. The browser stashes the tracking credentials
before redirecting and `/order/return` recovers them, polling until the order
leaves `awaiting_payment` so the customer is not told "no record of your payment"
during the webhook's flight time. Same-device recovery only; the confirmation
email stays the durable copy.

**H-07 / H-25 (refunds) are still open, and are now blocked on information
rather than on effort.** `computeRefund` validates the amount and the
`issue_refunds` permission is declared and now test-covered as enforceable, but
the researched Clover contract covers only checkout creation and the payment
webhook — it documents no refund endpoint. Building one would mean guessing at an
API, and a refund path that records a refund without moving money is worse than
no path at all. It needs the Clover refund contract before it can be written.

**R1.6 closes the Phase 3 gap this worklog flagged on 2026-07-26.** That note
ended by observing that the duplicate-checkout path, the seed-idempotency
guarantee and the clock-in race had no automated coverage because the suite was
pure-domain only. Four new suites now exercise the routes themselves, with real
`Request` objects through the exported handlers, so the rate limiter, the
validation, the database writes and the error mapping are all the ones production
runs:

- `tests/clover.test.ts` — the payment contract, offline with `fetch` stubbed.
  The checkout assertions are about the amount, the absent tax rate and tips
  being off, not JSON shape. The signature assertions are mostly negative.
- `tests/order-create.test.ts` — **C-07** end to end: a replayed key returns the
  same order rather than a second one and does not re-issue the tracking token;
  four concurrent submissions of one key create exactly one order; a rejected
  order leaves its key free to retry. Plus server-side pricing, hours, and
  per-caller throttling.
- `tests/clover-webhook.test.ts` — the transition that takes the money, and the
  reaper that covers the event Clover never sends. Orders are built through the
  real `POST /api/orders` with `fetch` stubbed, so the session id under test is
  the one the order service actually stored.
- `tests/auth.test.ts` — the cookie guarding every staff surface: revocation and
  deactivation taking effect on already-issued sessions, 401 kept distinct from
  403, identical messages for a wrong password and an unknown account, and
  bootstrap closed both once staff exist and when no setup secret is configured.

**Verification.** Behaviour was checked against a running server on local
Postgres, not only typechecked: pay-at-store unaffected; an online order with a
rejected token cancels and releases its idempotency key, so the same key retried
creates a fresh order rather than locking the customer out; a signed `APPROVED`
event moves `awaiting_payment` → `received`/`paid`, captures the payment, writes
one order event and releases the parked confirmation, and redelivering it is a
no-op; bad signature, stale timestamp, absent header, a body tampered under a
valid signature, and a foreign `merchantId` are all refused; the reaper cancels a
25-minute-old unpaid order while leaving a 5-minute-old one and an already-paid
one alone, and a second run does nothing.

Gates: `npm test` 129/129 with 0 skipped against local Postgres, and 66 pass /
63 skipped / 0 failed with no database reachable, so the suite stays hermetic and
the skip count remains a reliable signal · `tsc` clean · `lint` clean · `build`
carries `/api/payments/clover/webhook` and `/order/return` · `terraform validate`
and `plan` clean at 38 resources, connection budget 32 against a 45 ceiling.

**Still not done: the Docker image has never been built.** The daemon was not
running during this session either. Everything in R1.2 — and now the payment
reaper job added to it — still rests on an image that has never existed.
