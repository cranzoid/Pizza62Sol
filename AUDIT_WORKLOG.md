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
| H-07 / H-25 | Online payment + refund lifecycle | ✅ Closed 2026-08-21 — recorded-refund path; Clover publishes no refund API |
| H-10 | Notification/email dispatcher | ✅ Closed by R1.4 |
| H-11 | Promotion/coupon owner UI | ✅ Closed 2026-08-21 |
| H-08 | Scheduling exceptions/closures/capacity | ✅ Closed 2026-08-21 — closures + last-order cutoff |
| H-20 | Scheduled/history order queues + export | ✅ Closed 2026-08-21 |
| H-15 | Token-in-URL exposure | ✅ Closed 2026-08-21 |
| H-26 | Upload magic-byte/decoding validation | ✅ Closed 2026-08-21 — header inspection, not full decode |
| H-03/H-04/H-05 | Recipe enforcement, half toppings UI, halal on deals | ✅ Closed — H-04 by R1.5, H-03/H-05 on 2026-08-21 |
| H-14 | Relational integrity | ✅ Closed 2026-08-21 — 23 FKs, 51 checks |
| H-23 / H-24 | Cart revalidation, checkout review | ✅ Closed 2026-08-21 |
| H-09 | Feedback timing | ✅ Closed by R1.4 |
| H-18 / H-22 | Event race, menu content | Open — see the note at the end of this file |

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

### 2026-08-20 — R1.4: the notification outbox finally has a consumer

This closes the audit's central finding. `notification_outbox` was already a
complete job queue — `kind`, `recipient`, `payload_json`, `status`,
`attempt_count`, `scheduled_for`, `sent_at`, `last_error` — and **nothing read
it**, so no customer or staff member was ever told an order existed. Two of the
producers were missing as well: nothing ever wrote a `restaurant_new_order` row
at all, which is the finding in its most literal form.

**Created:** `lib/notifications/{config,channels,messages,dispatcher}.ts`,
`scripts/dispatch-outbox.ts`, `app/api/notifications/voice/ack/route.ts`.
`enable_outbox_dispatcher` now defaults to `true`.

**Rows are claimed, not selected.** `FOR UPDATE SKIP LOCKED` inside a
transaction, flipping the row to `sending` before the transaction commits. This is
not defensive programming for a rare case: the routes dispatch inline on every
order while the cron sweeper runs every minute, so two workers contending for one
row is the *normal* path. Two that merely `SELECT`ed it would both send, and the
customer would get two confirmations.

**There are two trigger points, not the one the roadmap assumed.** A pay-at-store
order is real when it commits and is dispatched then. An online order's
notifications stay parked in `waiting_payment` until Clover approves the payment,
so the webhook is the second trigger. Confirming an order nobody paid for, and
telephoning the kitchen about it, are both worse than saying nothing. The reaper
and the staff cancel path both cancel parked rows for the same reason — and all
three scope by *status* rather than by kind, so a kind added later is released or
cancelled by them too instead of silently staying parked forever.

**Failure handling distinguishes "could work later" from "never will."** A 4xx is
the provider saying the request itself is wrong, so repeating it verbatim is six
guaranteed failures delaying everything queued behind it; 429 is the exception,
because "not now" is not "not ever". Separately, a channel with no credentials
**parks** the row *without incrementing `attempt_count`* rather than failing it —
during the window where Twilio is provisioned and SendGrid is not, a confirmation
should wait, not burn its retry budget and land in `failed` where nobody looks.

**H-09 closed.** `feedback_request` is queued at order creation in a new
`waiting_completion` state and released when staff complete the order, delayed by
`operations.feedbackDelayMinutes` (75). Verified end to end against a running
server: `waiting_completion` → `pending`, scheduled 75 minutes out.

**H-15's trade, made explicit.** Tracking and feedback tokens are stored in
`orders` only as hashes, so a dispatcher running minutes later cannot reconstruct
them; they have to be handed to the outbox at write time. Everything else — status,
total, items, schedule — is read from the database at send time instead, which
keeps the payload minimal and keeps the message accurate if the order changed
while queued. The dispatcher **scrubs the payload on send**, so a plaintext token
lives in the queue for the length of the queue window rather than forever. The
alternative was a confirmation email with no tracking link, and per H-15 the email
is precisely the private channel that makes such a link safe to hand out at all.

**Customer SMS is built and off** behind `CUSTOMER_SMS_ENABLED`. The Twilio number
is an unregistered local long code and Canadian carriers filter A2P traffic from
those, so it would deliver unpredictably *and silently*. Email is the durable copy
for both the customer and the restaurant; SMS is additive and is never allowed to
fail a row on its own. Only the restaurant is ever called — calling customers
would pull the project into CRTC/CASL consent obligations it has not met.

**Voice acknowledgement reuses `orders.acknowledged_at`**, the same field the
Acknowledge button on the staff dashboard already wrote. One piece of state with
two ways to set it: tapping the kitchen screen stops the phone ringing, and
pressing 1 clears the banner on the screen. Re-calling is a *sweep*
(`requeueUnacknowledgedOrders`) rather than something a delivery schedules for
itself, because "still unacknowledged" is only knowable later and the call that
would have scheduled the retry may itself have failed. The Twilio callback
verifies `X-Twilio-Signature`; without it anyone who guessed the URL could silence
the escalation for an order the kitchen has never seen.

**Live verification found a bug the tests had not.** Nothing reclaimed rows
orphaned in `sending`. A worker dying mid-delivery — a replica restart, an OOM, a
deploy rolling the revision — stranded that customer's confirmation permanently,
which is the exact class of failure this release exists to eliminate. The claim
query now also takes back rows untouched for five minutes. Reclaiming too early
costs a duplicate message; never reclaiming costs silence, which is worse. Both
halves of the guard are now tested.

It also demonstrated defence in depth working: cancelling an order whose
restaurant alert had *already* been claimed did not un-claim it, because the
status-scoped cancel sweep cannot see `sending` — but the delivery-time guard in
`deliver()` refused to send for a cancelled order anyway, and the row ended
`failed: order was cancelled`. Nothing went out.

**Two latent bugs in the R1.6 tests, both mine, both the same shape.** State that
outlives a run: rate-limit identities restarted from the same values every run, so
repeated `npm test` runs shared one hourly `owner-bootstrap` budget (5 per hour)
and began failing on the second or third run; and test order numbers collided on
`orders_number_uq`. Both now seeded with a per-run token. They presented as flaky
tests and were not — this is recorded as trap 7 in the handoff.

**Verified against a running server**, not only typechecked: an order queues all
three rows with the correct parked states; inline dispatch claims the two live
ones within milliseconds; a bad SendGrid key fails in one attempt rather than six;
a missing channel parks with `attempt_count` still zero; completion releases the
feedback request 75 minutes out; cancellation silences everything; and the voice
callback acknowledges on a valid signature, returns 403 on a forged or absent one,
and is idempotent on replay. The dispatcher entrypoint was then run inside the
container with the exact `command`/`args` from `jobs.tf`.

Gates: `npm test` 154/154 with 0 skipped, and 73 pass / 81 skipped / 0 failed with
no database reachable · `tsc` clean · `lint` clean · `build` 34 routes ·
`terraform validate` and `plan` clean at 39 resources. The connection budget rose
to **36 of 45** with the third job — 9 of headroom, so the next addition needs the
arithmetic re-checked rather than assumed.

**Release 1 is now written in full.** What remains is credentials, one Clover
sandbox run, one real notification, and the first apply.


### 2026-08-21 — R2: the audit list closed out, and the host changed

Everything the audit left open is now closed except H-18 and H-22, both noted at
the end. What follows is why each one was resolved the way it was, because
several were not the obvious answer.

**H-14 — relational integrity.** 29 tables, zero foreign keys, zero check
constraints. Now 23 foreign keys and 51 check constraints, generated from
`db/schema.ts` so drizzle-kit stays the source of truth.

The delete rules encode ownership rather than being uniformly `cascade`: rows
that only exist as part of an order cascade with it; catalog rows an order
*refers* to restrict, so a product that has ever been sold cannot be deleted out
from under its own history; and payroll evidence restricts, because removing an
employee must not remove the record of hours they are owed for.

Two vocabularies were guessed wrong on the first pass and both were caught by
tests rather than by review — which is the argument for having the constraints at
all. Correction and time-off requests resolve to `declined`, not `rejected`. And
`orders.payment_status` is not `orders.status`: an online order has status
`awaiting_payment` while its payment status is `awaiting_checkout`.

**H-24 — the checkout review, and the reason it needed a server endpoint.** The
review screen added the cart up in the browser and called the result "estimated",
because nothing on the server would tell it otherwise until the order was
submitted. Two implementations of discount and tax arithmetic drift, and when
they do a customer consents to one number and is charged another.

`quoteOrder` is now the single pricing path, exported for both
`POST /api/orders/quote` and `createOrder`, and the browser does no pricing at
all. A test places a real order and asserts the quoted total equals the stored
total.

**`ok` has to mean "this will be accepted".** Twice during this work the quote
said yes to an order `createOrder` refuses, and both were found by driving the
real flow rather than by reading the code:

- At 4am, with the store shut, because the schedule check ran only when a
  schedule was supplied — and a quote that omitted one skipped a check
  `createOrder` then applied anyway.
- On a delivery order paying at the store, because the payment-method rules were
  never mirrored into the quote.

Both now have tests asserting the two paths reach the same verdict on identical
input. The general lesson is recorded here because it will recur: every rule
`createOrder` enforces has to exist in `quoteOrder` too, or the review screen
enables a button that cannot work.

**H-03 — set recipes.** The client could drop recipe toppings and the server
priced whatever it was sent, so an "All Meat" could reach the kitchen with no meat
on it, at the All Meat price, under the All Meat name.

The fix is not to forbid omissions — "hold the mushrooms" is a normal request —
but to make them explicit: named, checked against the recipe, and printed on the
kitchen ticket as `NO HAM`. A recipe topping going *quietly* missing is what is
now impossible. An omission never changes the price, because otherwise the same
named product could be bought cheaper by removing an ingredient and adding it
straight back as a paid extra.

**H-08 — closures rather than another toggle.** The only control was an
indefinite `paused` flag, which relies on somebody remembering to switch it back;
the two ways that goes wrong are the store staying shut the day after the holiday
and taking orders during it. A closure is a window with an end, scoped to pickup,
delivery or both — closing delivery while the counter keeps selling is the
ordinary case.

Enforced against the time the order is *for*, not the time it is placed:
otherwise a Christmas Day pickup ordered on the Monday is accepted and nothing
objects until Christmas Day. The closure check runs *before* schedule validation,
which is not cosmetic — on a holiday both fail, and the first attempt returned
"that time is outside the restaurant's configured hours", which is true and
useless.

**H-15 / H-26 / C-09's follow-up.** Tokens are stripped from the address bar on
load and travel to the API in a header, so they reach neither browser history nor
an access log; `/track`, `/feedback` and `/order/return` send `no-referrer` and
`no-store`. Uploads are identified by signature and dimension-bounded, and served
under `nosniff` with a sandbox CSP on the assumption the check might one day be
wrong. The kiosk roster — which published every member of staff's first name to
anyone who found the URL — is behind a device token and fails closed when nothing
is paired.

**H-07 / H-25 — refunds, honestly.** The researched Clover contract documents no
refund endpoint. Writing one would mean guessing at an API, and a refund path that
records a refund without moving money is worse than none: the customer is out of
pocket while the books say they were paid back. So the refund is issued in the
Clover dashboard and recorded here, and every screen says so in those words. The
guards are what make the record worth having — never more than was captured,
never on money that was never taken, always attributed, and correctable by
voiding rather than deleting.

**The notification failsafe that was not one.** `pending_provider_setup` parks a
row when no channel can deliver it, correctly. But nothing moved rows back out of
it, so the intended rollout — take sample orders now, add Twilio and email
afterwards — would have left every notification queued before the credentials
arrived parked permanently. That is the exact silence R1.4 was written to
eliminate, reintroduced at the moment it is most likely to happen. The dispatcher
now releases parked rows once a provider exists, without spending an attempt.

**Four un-awaited Promises, all one shape.** Moving credentials into an encrypted
store made every config getter async, and surfaced four places where a Promise was
used as a boolean. `if (!anyProviderConfigured())` negates a Promise, which is
always falsy, so the dispatcher's no-provider guard had stopped guarding; the same
mistake made online payment look configured to both the customer app and the admin
dashboard, and disabled the order service's own Clover check. TypeScript flags
`if (promise)` but not `if (!promise)` — only the tests caught these.

**The host changed.** Container Apps → App Service Linux with a staging slot. Not
for cost, which is within a few dollars: every deploy required building a
linux/amd64 image on an arm64 laptop, and this is a zip of a built tree. The three
Container Apps Jobs became one authenticated `POST /api/cron/tick` driven by a
Logic App every minute, which is the pattern already running in this subscription
for the CRM. The connection budget dropped from 36 of 45 to 16 of 50, because the
sweeps now run in the app's own process rather than in three containers with three
pools.

**Still open, and deliberately so:**

- **H-18 (event race)** — the order-event insert and the status update commit
  together in a `batch()`, so the race the audit described is closed in practice,
  but there is no test for the specific interleaving it named.
- **H-22 (menu content)** — needs the owner and the physical flyer, not code. One
  known discrepancy to settle on the call: the regular X-Large 3-topping price is
  derived as base + 2 × extra = $17.69, while the flyer advertises $15.99 for the
  X-Large 3-topping *pickup special*. Those are two different products and both
  are in the menu; it needs confirming that is intended.
- **Customer SMS** is built and off, pending a registered A2P number.
- **The weekly logical dump** is a runbook step rather than infrastructure. See
  `infra/backups.tf` for why.

**Verification.** 261/261 tests with Postgres and 95 pass / 166 skipped / 0 failed
without one, so the suite stays hermetic and the skip count remains a reliable
signal · `tsc` clean · `lint` clean · `build` 38 routes · `terraform validate` and
`plan` clean at 49 resources · migrations apply from an empty database and are
idempotent · and the whole flow driven against a running server: a set-recipe
pizza with an omission quoted, ordered and charged at exactly the quoted total,
the omission on the kitchen ticket, tracking by header token, a duplicate
submission returning the same order, a delivery-only closure blocking delivery
while pickup stayed open, a counter order stored as `walk_in` while a public
request claiming `walk_in` was stored as `online`, the cron endpoint refusing
unauthenticated callers, a disguised HTML upload refused, and the kiosk roster
returning 403 to an unpaired device.
