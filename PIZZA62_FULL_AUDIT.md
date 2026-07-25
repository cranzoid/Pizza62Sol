# Pizza 62 Full Platform Audit

**Audit date:** 2026-07-23  
**Repository:** `/Users/cranzoid/Pizza62Sol`  
**Revision audited:** `c2480b7` (`Align menu with flyer and expand owner controls`)  
**Audit mode:** read-only application audit plus isolated local database/API exercises  
**Source of truth:** `information.md`, supplemented by the exact flyer values reproduced in the audit brief  
**Verdict:** **NOT READY**

## Audit conventions

| Status | Meaning |
|---|---|
| PASS | Implemented and supported by source, automated, API, persistence, or runtime evidence. |
| PARTIAL | A meaningful portion works, but the requirement is incomplete or has a material limitation. |
| FAIL | Missing, incorrect, disconnected, insecure, or contradicted by evidence. |
| NOT TESTABLE | The necessary runtime, credential, service, or artifact was unavailable. |
| NOT APPLICABLE | Explicitly outside the enabled launch scope. |

Severity is assessed as **Critical**, **High**, **Medium**, or **Low**. Critical and High IDs are unique and form the count used in the terminal summary. Counts of PASS/PARTIAL/FAIL are counts of the major controls in section 17, not counts of individual assertions in the prose.

---

# 1. Executive summary

Pizza 62 has a credible technical foundation, but it cannot safely accept real customer orders in its current form. The application builds, type-checks, lints, and passes its existing tests. Guest pickup orders persist with immutable item and price snapshots; server-side totals use integer cents; authenticated admin writes use version checks; payment-provider failure does not produce a false success page; and public order tracking requires a high-entropy token.

Those strengths are outweighed by launch blockers:

- Delivery eligibility is not actually enforced. A clearly non-Hamilton postal code reached the payment-provider boundary when the submitted city string said `Hamilton`.
- Current pizza prices conflict with the required source-of-truth prices, and promotion logic applies an active coded coupon even when the customer supplies no code.
- Kitchen cards omit the items, modifiers, delivery address, payment state, and customer instructions needed to make and hand off an order.
- A staff member with `view_orders` can read customer phone numbers without `view_customer_contact`, and a staff member with `manage_employees` can elevate their own role/permissions.
- Concurrent time-clock requests can create two `clock_in` events and make the employee clock unreadable.
- The browser generates a new idempotency key on every checkout submission; a retry can therefore create a second order/payment attempt.
- A menu seed-version change overwrites owner-edited product prices/configuration instead of acting as initial data only.
- There is no working refund workflow, no owner promotion/coupon UI, no feedback/email delivery worker, and no real analytics reporting surface.

Readiness by area:

| Area | Readiness | Summary |
|---|---|---|
| Customer frontend | PARTIAL | Real catalog/cart/guest checkout exist; half toppings, cart revalidation, complete totals, custom tips, and safe retries do not. |
| Menu accuracy | FAIL | Required base prices are wrong, an advertised pickup offer is absent, several source categories/items are renamed, missing, duplicated, or unverified. |
| Backend | PARTIAL | Persistent D1 APIs and snapshot pricing are real; schema drift, weak relational integrity, promotion defects, and concurrency issues remain. |
| Admin | FAIL | Some settings/menu/team writes are real, but owner-critical promotions, refunds, order details/history, feedback, analytics, closures, and reporting are absent. |
| Kitchen | FAIL | Status transitions work, but staff cannot see what to prepare or the delivery/payment details. |
| Employee tools | FAIL | Login and basic clocking work; permissions and clock concurrency are unsafe, and approvals/exports are absent. |
| Feedback | FAIL | Public form persists responses, but it accepts immediate/invalid feedback and has no delivery/escalation workflow. |
| Analytics | FAIL | Events are collected, but no decision-grade reports exist and dashboard sales can include unpaid orders. |
| Security | FAIL | Strong session/token primitives exist, but there are two Critical authorization defects and sensitive tokens are exposed in URLs/logs. |

**Overall recommendation: NOT READY.** Keep real customer ordering disabled until Phase 1 in section 19 passes in a production-like staging environment.

---

# 2. Audit environment

## Revision and runtime

| Item | Evidence |
|---|---|
| Git revision | `c2480b7` |
| Working tree before audit | Clean |
| Host | Local macOS workspace; audit timezone `Asia/Kolkata`; application business timezone `America/Toronto` |
| Node | `v26.3.1` |
| npm | `11.16.0` |
| Application | Next-compatible vinext/Vite worker application |
| Persistence | Local Cloudflare D1/SQLite binding |
| Object storage | R2 binding declared; upload flow reviewed statically |
| Hosting metadata | Sites project and D1/R2 bindings present in `.openai/hosting.json`; no deployment performed |

## Services and test identities

- Local D1 was used for isolated API and persistence exercises.
- Temporary audit-only owner and employee identities were created in the local database. No production account was used.
- Temporary orders `P62-1003` through `P62-1009` exercised pickup, configuration snapshots, promotions, delivery failure, status transitions, feedback, and idempotency.
- Temporary settings/menu changes were restored after each assertion.
- A temporary invalid Stripe test credential was used only to prove that a geographically invalid delivery reached the provider boundary and failed safely. It was removed after the test.
- No passwords, session cookies, tracking tokens, webhook secrets, or provider keys are included in this report.

## Available integrations

| Integration | State | Audit disposition |
|---|---|---|
| D1/SQLite | Available locally | Tested |
| Stripe hosted checkout | Code present; valid credential unavailable | Failure boundary tested; real session, webhook, settlement, and refund NOT TESTABLE |
| Email | No provider/dispatcher implementation configured | FAIL as an operational workflow |
| R2 uploads | Binding/configuration present; no production object store exercised | Static review only |
| Browser runtime | No in-app browser was available | Click, keyboard, focus, visual, and viewport tests NOT TESTABLE |
| Flyer image/PDF | Not present in repository or supplied attachment directory | Exact textual values in the brief tested; purely visual flyer claims NOT TESTABLE |
| npm advisory service | Sandbox network denied; external metadata disclosure was not authorized | Dependency advisory lookup NOT TESTABLE |

## Commands and methods

Commands were run without exposing secrets:

```text
git status --short
git log --oneline
rg / sed source and requirement inspection
npm test
npx tsc --noEmit
npm run lint
npm run build
sqlite3 <fresh database> < drizzle/0000_quiet_epoch.sql
npm run dev -- --port <local audit port>
curl local API routes and response headers
sqlite3 local D1 state queries
npm audit --omit=dev --audit-level=moderate  # attempted; network unavailable
```

Browser control initialization returned no available browser. The audit did not substitute a separate automation stack, so browser-only assertions are explicitly classified rather than guessed.

---

# 3. Scorecard

| Area | Score / 10 | Rationale |
|---|---:|---|
| Customer frontend operations | 4.0 | Real catalog/cart/checkout, but key customization, validation, totals, and retry behavior are incomplete. |
| Flyer/menu accuracy | 3.0 | Broad menu coverage exists, but exact base prices and multiple required category/item details are wrong. |
| Pricing | 3.0 | Integer-cent arithmetic and HST work; source prices, shared-pool cases, and coded promotion behavior do not. |
| Delivery and scheduling | 2.0 | Postal syntax and hours are checked; radius/geography, closures, minimums, and separate schedules are not. |
| Checkout and payment | 4.0 | Pay-at-store pickup and fail-safe provider errors work; idempotent retries, full review, refunds, and verified online payment do not. |
| Backend integrity | 4.5 | Real APIs, D1 persistence, and snapshots; schema drift, missing constraints, and concurrency defects reduce confidence. |
| Orders and kitchen | 2.0 | Lifecycle writes work, but the kitchen surface lacks fulfillment-critical order content. |
| Admin owner control | 2.5 | Some real settings/menu/team controls; most daily operational controls are absent or disconnected. |
| Employee tools | 3.0 | Auth, basic permissions, time clock, and time-off submission exist; escalation, concurrency, approvals, and exports fail. |
| Feedback | 2.0 | Form and storage exist; timing, validation, wing logic, sending, and owner workflow fail. |
| Analytics | 2.0 | Events persist, but no useful analytics reporting or reconciliation exists. |
| Security | 3.0 | Good password/session/token primitives, undermined by Critical authorization and privacy defects. |
| Reliability | 3.0 | Build/test baseline is healthy, but retry, seed overwrite, clock race, and notification gaps are severe. |
| Accessibility | 5.0 | Static labels/focus styles/skip link are positive; modal focus and runtime keyboard/viewport evidence are absent. |
| **Overall production readiness** | **3.4** | **Not safe for real orders.** |

---

# 4. Critical and High launch blockers

**Issue totals:** 8 Critical, 26 High.

## Critical

| ID | Blocker | Evidence | Consequence |
|---|---|---|---|
| C-01 | Delivery geography is not enforced | `lib/order-service.ts` accepts address strings and does not call radius/distance validation. A local order using postal code `K1A 0B1` reached Stripe setup. | Out-of-area orders can be accepted and paid. |
| C-02 | Coded promotions auto-apply without a code | A temporary active `$1` promotion with code `AUDIT100` discounted `P62-1008` although the order API had no coupon input. | Unauthorized discounts and incorrect tax/totals. |
| C-03 | Customer phone privacy permission bypass | An employee with only order viewing/status permissions received customer phones for every dashboard order despite lacking `view_customer_contact`. | Unauthorized PII disclosure. |
| C-04 | Staff can elevate their own privileges | `staff.update` permits a user with `manage_employees` to change their own role and permission list. | Account takeover of owner-sensitive functions. |
| C-05 | Kitchen view cannot show what to make | `/api/admin/dashboard` and rendered kitchen cards omit item names, quantities, toppings, halves, crust, cheese, halal, wing flavours, instructions, address, and payment state. | Wrong food, allergen/halal mistakes, and unfulfillable delivery orders. |
| C-06 | Concurrent clock-in corrupts time-clock state | Two simultaneous clock-ins both returned 200 and created two events; the next time-clock read returned 500. | Incorrect payroll records and unusable employee clock. |
| C-07 | Checkout retry idempotency is not durable | `app/customer/CustomerApp.tsx` generates a fresh key for each submit rather than persisting one for the checkout attempt. | Double order/payment attempts on retry, refresh, or uncertain network failure. |
| C-08 | Seed updates overwrite owner operational data | `lib/menu.ts` upserts seed product fields, prices, and configuration whenever the seed version changes. | A deployment can silently undo live owner menu edits and prices. |

## High

| ID | Blocker | Evidence | Consequence |
|---|---|---|---|
| H-01 | Required pizza prices are incorrect | Current M/L/XL/Jumbo/Slab one-topping prices are `$8.99/$11.99/$12.99/$20.49/$21.99`; required values are `$8.40/$11.49/$12.49/$19.99/$21.49`. Extra toppings are also wrong for Medium and Large. | Systematic overcharge and flyer mismatch. |
| H-02 | Shared two-pizza pool fails valid allocations and totals | `5+3` charged `$4.20`, not required `$4.60`; `6+0` was rejected because each pizza requires at least one topping. | Advertised bundle cannot be configured accurately. |
| H-03 | Specialty recipes are mutable and untrusted | Client allows recipe toppings to be removed; server accepts submitted toppings and does not enforce `fixedRecipe`. | Product no longer matches its named recipe. |
| H-04 | Half toppings are not operational end-to-end | API accepts left/right placements, but customer UI offers only whole toppings and kitchen view omits placements. | Customers cannot reliably order or staff prepare halves. |
| H-05 | Halal deal configuration is missing | Deal products are marked halal-capable, but the generic deal customizer offers no halal control. | Advertised preference cannot be ordered correctly. |
| H-06 | Owner delivery controls are disconnected | Radius and fee settings persist, but checkout uses neither geographic distance nor delivery minimum. | Owner changes create false confidence and do not control risk/cost. |
| H-07 | Online payment/refund operations are incomplete | No valid Stripe transaction was available; there is no refund endpoint/UI or owner settlement workflow. | Owner cannot safely resolve paid-order cancellations or disputes. |
| H-08 | Scheduling lacks operational exceptions | No holiday, temporary closure, separate pickup/delivery hours, capacity slots, or owner schedule view. | Orders can be promised when the store cannot fulfill them. |
| H-09 | Feedback timing and answer validation fail | Feedback was accepted before fulfillment/scheduled time; rating `99` and unknown answers were persisted. | Invalid metrics and premature review solicitation. |
| H-10 | Feedback/email notifications are not dispatched | Outbox entries remain `pending_provider_setup`; no worker/cron/provider processor exists. | Customers and owner do not receive promised messages or low-rating alerts. |
| H-11 | Promotion and financial administration is absent | Backend promotion upsert exists, but no owner UI for codes, schedules, rules, stacking, usage, refunds, or reconciliation. | Daily pricing and financial operations require developer/API access. |
| H-12 | Midnight closing time cannot be saved | Minute `1440` renders as `00:00`; form conversion returns `0` and rejects open ≥ close. | Owner cannot safely edit/re-save required midnight hours. |
| H-13 | Runtime schema and migration schema drift | Fresh migration creates 25 app tables; runtime auto-init omits `customers` and `refunds` and creates 23 app tables. | Environment-dependent behavior and unsafe future migrations. |
| H-14 | Relational integrity is not enforced | Core tables have no foreign-key constraints/check constraints. | Orphaned orders/items/events and invalid states can persist. |
| H-15 | Tracking/feedback tokens leak through URLs and logs | Public tokens are query parameters; local request logs printed full tokenized URLs. | Tokens can enter history, referrers, proxies, screenshots, and support logs. |
| H-16 | Standard browser security headers are absent | Runtime response lacked CSP, HSTS, `X-Content-Type-Options`, and frame protections; `next.config.ts` defines none. | Increased XSS/content-sniffing/clickjacking exposure. |
| H-17 | Failed payment attempts lock the idempotency record | Provider failure cancels the order after the reservation is completed; retrying the same key resolves to the cancelled order. | Customer cannot safely resume a failed checkout. |
| H-18 | Concurrent order status changes can produce false events | Conditional status update and event insert are batched without proving the update affected a row. | Audit trail can claim transitions that did not occur. |
| H-19 | Dashboard financial metrics can be misleading | “Today” is rolling 24 hours and includes every non-cancelled order regardless of paid/settled state. | Owner may make decisions from inflated sales. |
| H-20 | No scheduled-order/history operational queue | Admin/kitchen has a capped live list only, with no dedicated upcoming schedule, searchable history, or export. | Orders can be missed and cannot be reconciled. |
| H-21 | Unconfirmed public product claims are enabled | `halalPreparationClaim` and `dryRubLabel` are true although `information.md` says these claims are unconfirmed/hidden. | Customer expectation, allergen, and consumer-protection risk. |
| H-22 | Required flyer/menu content is missing or invented | `$15.99` XL pickup special is absent; wings sizes are incomplete; categories/names diverge; duplicate pickup wings and unverified brownie/review URL are seeded. | Public menu is not a faithful source-of-truth implementation. |
| H-23 | Cart is not revalidated when fulfillment/catalog changes | Fulfillment switch leaves ineligible items in cart; stale price/availability is only rejected by the server. | Checkout failure late in the funnel and confusing totals. |
| H-24 | Checkout review is incomplete | No complete subtotal/discount/HST/delivery/tip/final breakdown, no coupon input, no custom tip, and no terms acknowledgement. | Customers cannot give informed price/terms consent. |
| H-25 | Cancellation/refund lifecycle is incomplete | Status actions exist, but no customer cancellation workflow, refund transaction, refund state, or reconciliation UI. | Paid-order exceptions require unsafe manual handling. |
| H-26 | Upload content is trusted by declared MIME only | Upload validates browser MIME/size, but not magic bytes/decoding; served response lacks `nosniff`. | Malicious or malformed owner-uploaded content can be served. |

---

# 5. Flyer and menu discrepancy table

The flyer asset itself was unavailable. “Expected” below is limited to the exact values and claims reproduced in the audit brief or `information.md`; purely visual placement/copy/imagery remains NOT TESTABLE.

## Base pizza pricing

| Size | Required 1-topping | Actual 1-topping | Difference | Required extra | Actual extra | Status |
|---|---:|---:|---:|---:|---:|---|
| Medium | $8.40 | $8.99 | +$0.59 | $2.10 | $1.60 | FAIL |
| Large | $11.49 | $11.99 | +$0.50 | $2.30 | $2.10 | FAIL |
| X-Large | $12.49 | $12.99 | +$0.50 | $2.60 | $2.60 | FAIL |
| Jumbo | $19.99 | $20.49 | +$0.50 | $2.90 | $2.90 | FAIL |
| Slab | $21.49 | $21.99 | +$0.50 | $2.90 | $2.90 | FAIL |

The public hero also hard-codes “`$8.99 medium · 1 topping`”; this is both incorrect and disconnected from owner-edited menu data.

## Categories, items, and offers

| Source-of-truth expectation | Actual seeded/catalog result | Status | Severity | Notes |
|---|---|---|---|---|
| Regular pizzas | Renamed `Pizza by Size` | PARTIAL | Medium | Function is present; public wording differs. |
| Gourmet pizzas | Renamed `Specialty Pizzas`; 13 recipes exist | PARTIAL | Medium | Recipes can be altered by customer and are not enforced server-side. |
| Pizza and wing deals / Hot Deals | Split into `Deals` and `Combos`; no explicit Hot Deals category | PARTIAL | Medium | Exact flyer grouping cannot be verified without flyer asset. |
| 2 for 1 pizzas | Category and five products exist | PASS | — | Shared-pool pricing/configuration remains defective. |
| Wings | 1 lb, 24, 30, 40, 50, 60 wings | FAIL | High | Missing 2 lb, 3 lb, and 12-wing variants described by source. |
| Side orders | Broad set exists | PARTIAL | Medium | `Jalapeños` masks the seeded stuffed-jalapeño identity/quantity. |
| Dipping sauce category | Dip exists inside Side Orders | PARTIAL | Low | Category structure differs. |
| Drinks | Only Water is a standalone item | PARTIAL | Medium | Canned flavours exist only inside deal modifiers; several labels differ. |
| Desserts | `Chocolate Brownie $2.99` | NOT TESTABLE | Medium | No flyer artifact supports this exact seeded item/price. |
| Pickup: 3-topping medium $12.99 | Present | PASS | — | — |
| Pickup: 2 large, 3 toppings each, $27.99 | Present | PASS | — | Shared-pool cases and extra charge are wrong. |
| Pickup: X-Large, 3 toppings, $15.99 | Missing from menu seed | FAIL | High | Offer is present only in launch configuration metadata. |
| Pickup: pizza/wings/pops $25.99 | Present | PARTIAL | Medium | Veggie sticks, blue cheese, and dip are description text, not structured selections/inclusions. |
| Hamilton Hero $16.98, weekday window | Present | NOT TESTABLE | Medium | Exact flyer support unavailable; enforcement is product-level metadata, not a verified public campaign rule. |
| Pickup-only one-pound wings | Duplicates the standard one-pound wings product | FAIL | Medium | No source support found. |
| Halal/dry-rub claims hidden until confirmed | Claims are enabled and visible | FAIL | High | Conflicts with explicit source guidance. |
| Google review URL supplied by owner | A concrete URL is seeded although source says none supplied | FAIL | Medium | Must be owner-verified before customer use. |

---

# 6. Customer frontend findings

## Working behavior

- The customer application loads `/api/catalog`; no placeholder product array is used at runtime.
- Fulfillment mode and cart persist in local storage.
- Pickup guest checkout with pay-at-store persisted a real order.
- Product cards expose sold-out state and server-side order validation rejects sold-out/ineligible items.
- Cart items preserve a product/configuration snapshot at order time.
- Tracking and feedback links are returned only after successful order creation.
- The service worker does not cache or replay API, checkout, admin, kitchen, tracking, or feedback traffic.

## Material defects

1. **Delivery gate — C-01/H-06.** The initial modal checks Canadian postal syntax only. The server accepts the literal city `Hamilton`, province `ON`, and a syntactically valid postal code. It performs no postal-to-coordinate lookup, address validation, straight-line distance, route distance, or radius comparison. Free-delivery products do not fix this: the server has no geographic radius path to preserve.

2. **Fulfillment switching — H-23.** Switching pickup/delivery filters future browsing but leaves ineligible cart items intact. There is no cart banner, automatic removal, or owner-price/availability refresh. The eventual API rejection is technically safe but operationally late.

3. **Pizza halves — H-04.** The domain/API supports `whole`, `left`, and `right`, and a direct API test preserved placements. The UI exposes only whole toppings and tells users to type half requests in special instructions. Kitchen cannot render the structured placement anyway.

4. **Specialty recipes — H-03.** The customer can remove recipe toppings. `fixedRecipe` is descriptive configuration rather than an enforced invariant; the server prices/accepts the submitted selections.

5. **Halal and cheese — H-05.** Standard pizza exposes halal and cheese choices. `none`/`light` cheese are flattened into free text while `extra` is structured, creating inconsistent fulfillment data. Deal products marked halal-capable expose no halal toggle.

6. **Bundle configuration — H-02.** The two-pizza shared pool rejects `6+0` and uses the wrong Large extra-topping amount. Generic bundle sections impose a topping maximum of 12, contrary to the no-fixed-maximum requirement.

7. **Wings.** Active sizes are incomplete. Multiple flavour values can be selected, but there is no explicit split allocation model. Blue cheese, veggie sticks, and dip are correctly not silently added to standalone wings; however, deal inclusions are only prose.

8. **Checkout — C-07/H-24.** The review surface does not provide the required full financial breakdown, custom tip, coupon entry, or terms acknowledgement. A new idempotency key is generated per submission rather than per durable checkout attempt.

9. **Scheduling — H-08.** A generic `datetime-local` input is validated against regular hours and a 14-day horizon. There are no owner-managed exceptions, separate fulfillment schedules, capacity slots, lead-time display, or current wait estimate updates.

10. **Confirmation/tracking.** Pay-at-store receives a confirmation. Tracking fetches once and does not auto-refresh or show payment state. Feedback is offered immediately rather than after the configured delay/completion.

11. **Upsells and accounts.** No contextual upsell engine exists. Customer accounts/reorder are disabled; guest checkout works, so reorder is treated as not applicable to the explicitly disabled launch feature rather than a launch blocker.

---

# 7. Pricing and promotion findings

## Arithmetic that passed

`lib/domain.ts` uses integer cents and basis points. Direct calculations and persisted orders supported:

- `$20.00` subtotal − `$5.00` discount = `$15.00` taxable base.
- HST at 13% = `$1.95`.
- Non-taxable delivery fee = `$3.50`.
- 15% tip on the post-discount food base = `$2.25`.
- Final total = `$22.70`.

A two-large `4+2` allocation produced:

```text
Base bundle                 $27.99
Extra toppings                  $0
HST (13%)                    $3.64
Final                         $31.63
```

Order/item totals, HST, delivery fee, tip, and final total were persisted as cents. Historical order snapshots remained unchanged after a variation price was edited and restored.

## Expected-versus-actual defects

### Required Large shared-pool example: 5+3 toppings

The two pizzas include six toppings total, so `5+3` has two paid extras. Required Large extras are `$2.30`:

```text
Expected base               $27.99
Expected extras   2 × $2.30  $4.60
Expected subtotal            $32.59
Expected HST (13%)            $4.24
Expected final               $36.83

Actual base                 $27.99
Actual extras     2 × $2.10  $4.20
Actual subtotal              $32.19
Actual HST (13%)              $4.18
Actual final                 $36.37

Customer undercharge          $0.46
```

`6+0`, another explicitly required allocation, returned HTTP 400 because both pizza sections have `min: 1`. `4+2` passes; `3+3` is structurally allowed.

### Promotion/coupon behavior

An isolated temporary rule demonstrated C-02:

```text
Water subtotal               $1.60
Coupon supplied by customer     no
Unexpected fixed discount    $1.00
Taxable remainder            $0.60
HST                          $0.08
Actual final                 $0.68
```

The promotion query filters active dates, but the rule engine ignores the promotion `code`. There is no coupon field in the public order contract. Any active coded promotion whose product/fulfillment rule matches therefore behaves as an automatic promotion.

Promotion support is limited to percentage, fixed, and free-delivery outcomes. It does not implement robust coupon validation, usage limits, day/time windows, customer limits, stacking policy, fixed bundle composition, free items, or included-quantity semantics. Discount allocation is proportional across taxable and non-taxable items rather than applying line-specific eligibility, which can calculate the wrong HST in mixed-tax carts.

---

# 8. Backend and API findings

## Positive evidence

- Public catalog, order creation, tracking, feedback, analytics, auth, time-clock, admin configuration/actions, uploads, and Stripe webhook routes are real.
- Validation failures return non-success responses and no false customer success.
- Same-key order submission is idempotent on the server: a repeated request returned the original order and the database contained one row.
- Admin configuration writes use an expected version; stale updates returned 409.
- D1 batching is used for order plus item/event/outbox persistence.
- Passwords use PBKDF2-SHA256 with per-user salts and 100,000 iterations.
- Sessions and public tokens are random, stored as hashes, and constrained by expiry/status checks.
- Stripe webhook logic verifies signature/timestamp and validates amount/payment state before marking paid.

## Defects

- **C-01/C-02/C-08** are core server defects, not presentation issues.
- **H-13:** `db/runtime.ts` creates a different schema from `drizzle/0000_quiet_epoch.sql`; runtime omits `customers` and `refunds`. Runtime executes `CREATE TABLE IF NOT EXISTS` rather than a tracked migration sequence.
- **H-14:** IDs are copied between tables without database-enforced foreign keys or check constraints.
- **H-17:** order idempotency is marked completed before the external Stripe session succeeds. A provider failure leaves a cancelled order bound to the key.
- **H-18:** status transition batches conditionally update the order but also insert an event; affected-row success is not verified before recording the event.
- Delivery minimum, radius, and geospatial settings are never consulted by order creation.
- The public analytics write API is allowlisted/rate-limited but unauthenticated; events can be spoofed and are not reconciled to orders.
- Admin configuration error handling can return raw exception messages, which may expose implementation detail.
- APIs use practical limits in places, but admin lists are capped rather than paginated/searchable and owner workflows cannot reach several backend capabilities.

Fresh migration smoke test succeeded and created 25 application tables. Runtime local initialization produced 23 application tables, confirming the drift rather than a migration syntax failure.

---

# 9. Order and kitchen findings

## Persistence and lifecycle evidence

Local audit orders proved that the system persists:

- unique display order number and internal ID;
- fulfillment and scheduled time;
- customer and address data;
- item quantity, unit price, line total, product snapshot, variation/configuration snapshot;
- whole/left/right selections submitted through the API;
- extra cheese, crust/base, halal, wing/pop choices;
- subtotal, discount, tax, delivery, tip, total, payment and order status;
- hashed tracking/feedback tokens;
- order events and notification-outbox records.

After an audited Large pizza price changed from `$11.99 + $2.10` to `$12.99 + $2.30`, the next order used the new price while the earlier order retained its original `$16.19` unit snapshot. The value was then restored. This is the desired historical behavior.

Status rules also rejected invalid transitions:

- duplicate acknowledge: 409;
- received → completed: 409;
- pickup preparing → out-for-delivery: 409;
- missing cancellation permission: 403;
- received → preparing → ready → completed: accepted.

## Kitchen and owner-operation failures

The kitchen page polls every 10 seconds and provides a visible/audio alert for unacknowledged orders after sound is enabled. Acknowledgement and allowed status actions write audit events.

However, C-05 makes the page unusable for production. The dashboard response and cards show essentially order number, customer name, fulfillment, requested time, total, and status. They do not show:

- ordered products and quantities;
- pizza size, crust/base, cheese, halal, whole/left/right toppings;
- fixed recipe and additions;
- deal component allocations;
- wing size/count/flavours;
- special instructions;
- delivery address/contact permission-aware view;
- payment method/payment state;
- cancellation/refund state.

There is also no dedicated scheduled queue, late-order/ETA workflow, searchable history, receipt reprint, item-level problem handling, cancellation/refund workflow, or offline printable fallback. New-order sound is per browser client and does not provide push/email backup. Notification-outbox rows remained pending because no sender exists.

---

# 10. Admin findings

## Owner/admin scorecard

| Admin capability | Score / 10 | Evidence |
|---|---:|---|
| Order operations | 2.0 | Status/acknowledge work; items, address, payment, history, scheduled queue, cancel/refund are absent. |
| Menu control | 6.0 | Category/product/variation/config/status writes are real; shared pools, duplication, bulk/scheduled state, safe seed ownership are not. |
| Promotion control | 1.0 | Backend upsert exists, but no owner UI or safe coupon/rule lifecycle. |
| Delivery and timing | 2.0 | Settings persist; radius/minimum are disconnected, closures absent, midnight form broken. |
| Employee management | 4.0 | Create/update/disable and permissions exist; self-elevation and missing approvals make it unsafe. |
| Financial controls | 2.0 | Tax/tip/delivery settings persist; no payment reconciliation, refunds, voids, exports, or reliable sales metric. |
| Feedback management | 1.0 | Low-rating count exists; no response list, notes, escalation, send state, or trends. |
| Analytics/reporting | 1.0 | Three rolling metrics only; no channel/menu/promo/funnel/report/export. |
| Content control | 4.0 | Hero/content/review URL settings exist; prominent prices/deal claims and policy content remain hard-coded. |
| Permissions/security | 2.0 | Route auth exists; C-03 and C-04 are Critical. |
| **Overall owner readiness** | **2.5** | **The owner cannot run the platform without developer/API/database support.** |

## Controls that are genuinely connected

Local transient edits demonstrated:

- delivery fee, ordering estimate, tax/tip presets, operations delay, and hero content persist through the configuration API;
- current-version writes succeed and stale-version writes return 409;
- variation price changes affect subsequent orders but not historical snapshots;
- sold-out state removes orderability server-side;
- pickup eligibility is enforced server-side;
- employee disable immediately invalidates existing sessions;
- authorized status transitions and audit-log actor IDs persist.

All transient values were restored.

## Missing, misleading, or unsafe controls

- Radius and delivery minimum look operational but do not affect checkout (H-06).
- Menu `sharedGroup`/`sharedIncluded` behavior is not editable in the rendered modifier editor, so the two-pizza pool requires code/API knowledge.
- “Card price” and variation prices are separate; editing the former does not change a pizza variation charged at checkout.
- No promotion/coupon, upsell, holiday/closure, scheduled-order, history, cancellation/refund, settlement, feedback, analytics, audit-log, customer, or reporting UI exists.
- No menu duplication, preview/publish schedule, bulk sold-out, unsaved-change guard, or destructive confirmation exists.
- Pause/sold-out actions are immediate without a clear confirmation.
- Existing dead `LegacySettingsPanel`, `LegacyMenuPanel`, and `LegacyTeamPanel` exports remain in `app/staff/StaffPortal.tsx`, increasing maintenance ambiguity.
- Dashboard “today” is rolling 24 hours, includes non-cancelled but potentially unpaid orders, and is not a trustworthy sales report.
- The regular-hours editor cannot safely preserve the required midnight close (H-12).
- Owner-configured feedback delay and Google review URL are not part of a real sending workflow.

---

# 11. Employee and time-clock findings

## Authentication and permissions

PASS evidence:

- unauthenticated admin dashboard/config/actions requests were denied;
- menu write and pause actions were denied without their specific permissions;
- employee disable invalidated both an existing session and a fresh login;
- login/bootstrap and public-token endpoints are rate-limited;
- session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, and expire;
- employee creation/update events are audit-logged.

Critical failures:

- **C-03:** `view_orders` effectively grants phone visibility because dashboard serialization does not apply `view_customer_contact`.
- **C-04:** a user holding `manage_employees` can update their own role and permissions. The route prevents self-disable, but not self-promotion or adding owner-sensitive permissions.

There is no password reset/recovery workflow. Owner bootstrap depends on an environment setup secret and safely refuses setup once a user exists.

## Time clock

The ordinary event sequence works:

```text
clock_in → break_start → break_end → clock_out
```

Duplicate and illegal sequential transitions returned 409. A second authenticated device saw the current state. Millisecond timestamps were retained and a controlled interval produced the exact expected paid duration. Time-off and correction-request records can be submitted and remain pending.

**C-06:** two simultaneous `clock_in` requests both returned 200 and inserted events with the same timestamp. The next read replayed `working → clock_in`, threw an invalid-transition error, and returned 500. The audit-only duplicate fixture was removed to continue testing; application code was not changed.

Operational gaps:

- employee UI provides time-off submission but not a correction-request form;
- partial-day support exists in the API model but is not exposed by the UI;
- no admin queue can approve/reject correction or time-off requests;
- an attempted `correction.approve` action returned “Unsupported action”;
- no payroll-period summary, biweekly approval, PDF/CSV/Excel export, locked period, or manager note workflow exists;
- no database constraint or serializable transition protects time-clock concurrency.

---

# 12. Feedback and analytics findings

## Feedback

The public feedback route correctly requires order number plus feedback token, rejects cancelled orders, prevents a second submission, stores responses, conditionally returns a Google review link, and avoids exposing customer contact data.

It is nevertheless not launch-ready:

- **H-09:** an order still in `received` state with a future scheduled time could load and submit feedback immediately.
- Rating `99` and an unexpected question key were accepted and stored. Only the overall answer is effectively required/normalized.
- The pizza conditional question depends on a join to the current product row rather than solely on the historical item snapshot.
- Wing products are seeded with product type `configurable`, but question logic looks for type `wings`; the wing question is therefore not selected.
- The configured feedback delay is not enforced.
- Every valid respondent can see the review link; there is no tested staged solicitation workflow.
- **H-10:** low-rating outbox entries are hard-coded to `pending_provider_setup`; no email/provider dispatcher sends owner alerts or customer feedback requests.
- Admin has no response list, filters, reply/note/escalation state, question editor, trends, or send-failure view.

## Analytics

The frontend sends allowlisted event names to a real `/api/analytics` endpoint and D1 stores them. This is not fake random data.

The collected data is not operational analytics:

- no admin API/UI reads the analytics-event table;
- no active visitor, menu funnel, cart abandonment, checkout failure, payment success, promotion, fulfillment, or item-performance report exists;
- events are public-client claims and can be spoofed;
- pay-at-store can emit purchase completion, while hosted-checkout return/reconciliation is incomplete;
- **H-19:** overview sales are a rolling 24-hour sum of non-cancelled orders, not settled “today” revenue;
- there is no GDPR-consent-aware analytics governance, retention policy, deletion workflow, or reconciliation to order/payment facts.

---

# 13. Security and privacy findings

## Positive controls

- PBKDF2 password hashing, random salt, timing-safe comparisons, hashed sessions, and hashed public tokens are appropriate primitives.
- Active employee status is checked on authenticated requests.
- Session cookies are hardened and no raw session/track/feedback token is stored in D1.
- Tracking requires number plus token; number-only and altered-token attempts returned 404.
- Fifteen invalid tracking probes were answered before subsequent probes were rate-limited at 429.
- Tracking response masks delivery location to city/province and omits customer contact.
- Stripe webhook code validates HMAC signature, timestamp age, payment state, and expected amount.
- Upload write/delete access requires menu-management permission.
- A repository scan found no committed Stripe, Google API, or private-key patterns.

## Security/privacy defects

1. **C-03 — object/field authorization:** customer phone is serialized based on order access rather than contact permission.
2. **C-04 — privilege escalation:** employee-management capability includes self-role/self-permission mutation.
3. **H-15 — bearer token exposure:** tracking and feedback bearer tokens are placed in query strings. Runtime access logs demonstrated full URL logging. Query tokens also risk browser history/referrer/support-copy leakage.
4. **H-16 — browser headers:** local runtime response included no CSP, HSTS, `X-Content-Type-Options`, or frame policy. Production proxy behavior was not available, but the repository defines none.
5. **H-26 — uploads:** trust is based on client-declared MIME and size, not file signatures or image decode. Upload responses do not force `nosniff`.
6. Public analytics identity/rate limiting is not a security boundary. In non-Cloudflare/local contexts, client-controlled forwarding headers may influence IP identity.
7. Core relational authorization assumptions are not backed by foreign keys.
8. Admin configuration error responses may include raw exception messages.
9. No account recovery, forced password reset, MFA, session viewer/revocation UI, or security-event owner view exists.
10. No documented data retention/deletion/export process exists for customer PII, analytics, feedback, or employee time records.

The application uses a Strict same-site cookie and JSON writes, which reduces CSRF exposure, but there is no explicit CSRF token/origin check. This is Medium rather than High given the current cookie policy.

---

# 14. Reliability findings

## Passed reliability behavior

- Test, typecheck, lint, build, and fresh migration completed.
- Invalid product state, fulfillment eligibility, option, schedule, and status transitions fail closed.
- With no Stripe configuration, delivery/online checkout returned 503 before order creation.
- With an invalid Stripe credential, the application returned 502, cancelled the newly persisted order, marked payment failed, and did not display false success.
- Order persistence does not depend on email success; the outbox preserves notification intent.
- Historical price/configuration snapshots survived later menu edits.
- Server same-key order idempotency prevents a duplicate row.
- Service worker caching excludes sensitive and financial routes.

## Failure-state defects

- **C-06:** time-clock transition check and insert are raceable.
- **C-07:** client retry does not reuse a durable idempotency key.
- **C-08:** deploy/seed version can overwrite owner changes.
- **H-10:** notification outbox has no dispatcher, retry/backoff, dead-letter, or owner failure view.
- **H-13:** migration/runtime schema drift makes environment outcomes inconsistent.
- **H-17:** failed provider checkout cannot be resumed with the same idempotency attempt.
- **H-18:** concurrent order status actions can record misleading events.
- There is no background reconciliation for `awaiting_payment`, timed-out Stripe sessions, abandoned checkouts, or webhook delivery failure.
- There is no automated backup/restore rehearsal, data integrity checker, outbox health monitor, or production readiness probe in the repository.
- Current automated tests cover pure domain calculations only; no API, database, auth, concurrency, payment, or end-to-end regression suite exists.

---

# 15. Accessibility and responsive findings

## Static positives

- A skip link and visible focus styles exist.
- Most form controls have labels and buttons have text.
- Customer selection controls use button/radio semantics and status is usually represented with text, not color alone.
- Mobile/responsive CSS breakpoints are present.
- Policy/accessibility routes exist.

## Static defects and unverified behavior

- Modal/dialog components do not implement a complete focus trap, focus restoration, or consistent Escape-key close.
- Rating radiogroups do not implement expected arrow-key radio navigation.
- Admin data grids use generic `div` structures instead of semantic tables where tabular relationships matter.
- Employee navigation lacks an explicit accessible label.
- Delivery-gate success styling checks whether text starts with `This`, while the success message starts with `Thanks`; a successful result can be styled as an error.
- Repeating audible kitchen alerts depend on a manual sound-enable gesture and have no alternative push notification.
- No evidence of reduced-motion handling or an automated accessibility test suite was found.

Because the required in-app browser runtime was unavailable, the following are **NOT TESTABLE**:

- keyboard-only completion of fulfillment, customization, cart, checkout, tracking, feedback, admin, kitchen, and clock flows;
- focus order/trapping/restoration and screen-reader announcements;
- contrast computed from rendered states;
- touch target size;
- real 320/375/768/1024/desktop viewport layout, overflow, sticky elements, and zoom;
- visual comparison with the flyer.

Static source findings should not be interpreted as a WCAG conformance assessment.

---

# 16. Test results

## Automated repository commands

| Test | Result | Evidence |
|---|---|---|
| `npm test` | PASS: 18, FAIL: 0 | Domain pricing, delivery helper, feedback helper, transition tests |
| `npx tsc --noEmit` | PASS | Exit 0 |
| `npm run lint` | PASS | Exit 0 |
| `npm run build` | PASS | Production build completed; vinext emitted route-classification/deprecation warnings |
| Fresh SQL migration | PASS | Migration applied to empty SQLite; 25 app tables created |
| Runtime schema parity | FAIL | Runtime auto-init contained 23 app tables and omitted `customers`, `refunds` |
| Dependency advisory lookup | NOT TESTABLE | Registry DNS blocked; escalation was rejected because it would disclose dependency metadata externally without user authorization |

The 18 existing tests passing must not be read as flyer correctness. The first test explicitly asserts the current `$8.99/$11.99/...` values that conflict with the audit brief. Delivery tests exercise the isolated `validateDelivery` helper, while production order creation does not call that helper.

## New temporary audit tests

| Area | Result | Evidence |
|---|---|---|
| Catalog seed inventory | PASS/PARTIAL | 11 active categories, 61 active products, 67 active variations, 23 active toppings |
| Guest pickup/pay-store order | PASS | Persisted real order and snapshots |
| Server idempotency, same key | PASS | Second submission returned original; one order row |
| Client retry idempotency | FAIL | New key generated for each submission |
| Valid 4+2 shared pool | PASS | `$27.99 + $3.64 HST = $31.63` |
| Valid 5+3 shared pool | FAIL | `$4.20` extras rather than `$4.60`; final `$36.37` rather than `$36.83` |
| Valid 6+0 shared pool | FAIL | HTTP 400 |
| Price edit/new order/history | PASS | New order changed; old snapshot unchanged; edit restored |
| Sold-out and pickup eligibility | PASS | API rejected unavailable/ineligible products; flags restored |
| Coded promotion without code | FAIL | `$1` code promotion auto-applied; promotion deactivated after evidence |
| Delivery postal outside Hamilton | FAIL | `K1A 0B1` reached provider boundary with delivery fee/order persisted |
| Provider unavailable/invalid | PASS fail-safe | 503/502, no false confirmation; failed-provider order cancelled |
| Tracking token authorization | PASS | valid pair 200; altered/missing pair 404 |
| Tracking rate limit | PASS | Invalid probes eventually 429 |
| Feedback timing/validation | FAIL | Immediate pre-completion submission and rating 99 accepted |
| Admin optimistic versioning | PASS | stale writes 409 |
| Menu price/status connection | PASS | subsequent checkout reflected current variation/status |
| Status transitions | PASS | invalid transitions 409; valid lifecycle persisted |
| Contact permission | FAIL | unauthorized phone values returned |
| Employee disable/session revoke | PASS | existing and new session denied |
| Employee self-elevation guard | FAIL | source route allows self role/permission update |
| Ordinary time-clock sequence | PASS | correct state and paid milliseconds |
| Concurrent time-clock requests | FAIL | two 200 inserts; next read 500 |
| Time-off/correction submission | PARTIAL | pending records created; no approval workflow |
| HTTP security headers | FAIL | no CSP/HSTS/nosniff/frame protection in runtime response |
| Secret-pattern scan | PASS | no committed provider/private-key pattern found |

Temporary audit records and database edits were confined to the local D1 state. The only repository file added is this report.

---

# 17. Requirement coverage matrix

This matrix covers the major operational requirements in `information.md`. Closely related sub-bullets are grouped only where they share one implementation and verdict.

**Coverage totals:** 32 PASS, 32 PARTIAL, 53 FAIL, 3 NOT TESTABLE (120 controls).

| Requirement | Implemented location | Evidence | Status | Severity | Notes |
|---|---|---|---|---|---|
| R-001: Canadian-dollar integer-cent money model | `lib/domain.ts`, `db/schema.ts` | Calculation and persisted-order checks | PASS | — | No floating-point money path found. |
| R-002: Ontario HST at 13% with explicit taxability | `lib/domain.ts`, admin tax settings | Exact calculation passed | PASS | — | Delivery taxability setting is supported. |
| R-003: Business timezone America/Toronto | `lib/launch-config.ts`, `lib/order-service.ts` | Source inspection | PARTIAL | Medium | Order service hard-codes Toronto rather than consuming the owner setting. |
| R-004: Guest ordering without account | `app/customer/CustomerApp.tsx`, `/api/orders` | Pickup order persisted | PASS | — | — |
| R-005: Optional customer account architecture | schema only | No customer API/UI; runtime table absent | FAIL | Medium | Disabled/reorder launch feature is not blocking guest launch, but architecture is incomplete. |
| R-006: Installable/mobile-friendly PWA | manifest, service worker registration | Static/build inspection | PARTIAL | Low | PWA metadata exists; install/runtime behavior not browser-tested. |
| R-007: Flyer/source values are authoritative | `lib/launch-config.ts`, `lib/menu.ts` | Price/category comparison | FAIL | High | Tests encode conflicting prices rather than the supplied source values. |
| R-008: Medium one-topping $8.40; extra $2.10 | launch config/menu seed | Actual $8.99; extra $1.60 | FAIL | High | H-01. |
| R-009: Large one-topping $11.49; extra $2.30 | launch config/menu seed | Actual $11.99; extra $2.10 | FAIL | High | H-01. |
| R-010: XL one-topping $12.49; extra $2.60 | launch config/menu seed | Actual $12.99; extra $2.60 | FAIL | High | Base wrong. |
| R-011: Jumbo one-topping $19.99; extra $2.90 | launch config/menu seed | Actual $20.49; extra $2.90 | FAIL | High | Base wrong. |
| R-012: Slab one-topping $21.49; extra $2.90 | launch config/menu seed | Actual $21.99; extra $2.90 | FAIL | High | Base wrong. |
| R-013: Regular/gourmet/deal/two-for-one/wings/side/drink/dessert/pickup categories | `lib/menu.ts` | Catalog inventory | PARTIAL | Medium | Broad coverage; names/grouping and several items differ. |
| R-014: Specialty pizza fixed recipes | menu config, customer customizer | Recipe initially displayed | FAIL | High | Recipe can be removed and is not server-enforced. |
| R-015: Full required wing sizes | menu seed | Active size inventory | FAIL | High | 2 lb, 3 lb, and 12-wing options missing. |
| R-016: Wing flavours neutral until dry rub confirmed | feature flags, public copy | Source inspection | FAIL | High | Dry-rub copy is enabled. |
| R-017: Pickup $12.99 medium three-topping offer | menu seed | Catalog/API | PASS | — | — |
| R-018: Pickup $27.99 two-large shared-six offer | menu seed/domain | 4+2 passed | PARTIAL | High | 5+3 wrong price; 6+0 rejected. |
| R-019: Pickup $15.99 XL three-topping offer | launch metadata only | No active product | FAIL | High | H-22. |
| R-020: $25.99 pizza/wings/pops deal and inclusions | menu seed | Order snapshot | PARTIAL | Medium | Main choices work; sides/dip inclusions are prose only. |
| R-021: Only confirmed halal/preparation claims public | feature flags/public copy | Source inspection | FAIL | High | Unconfirmed halal/dry-rub flags enabled. |
| R-022: Flyer imagery/copy fidelity | no flyer artifact | Artifact search | NOT TESTABLE | Medium | Exact visual source was unavailable. |
| R-023: Pickup/delivery choice before browsing | customer app gate | Source/API inspection | PASS | — | Modal gate exists. |
| R-024: Delivery address validated before fee/order | customer/app order service | Far-postal test | FAIL | Critical | Syntax only; C-01. |
| R-025: Distance/radius eligibility from store origin | delivery helper vs order service | Production path inspection | FAIL | Critical | Helper is disconnected. |
| R-026: Outside-area order blocked with call-store message | customer/order service | Far-postal test | FAIL | Critical | Request reached provider boundary. |
| R-027: Delivery fee hidden until eligible | customer gate | Source inspection | PASS | — | Fee is not shown before gate success. |
| R-028: Free delivery does not expand radius | order service | No radius enforcement exists | FAIL | High | Cannot guarantee boundary. |
| R-029: Fulfillment switch revalidates cart | customer cart state | Source inspection | FAIL | High | H-23. |
| R-030: Product availability and sold-out enforcement | catalog/order service | Temporary sold-out test | PASS | — | UI and server both block. |
| R-031: Owner price changes affect new not old orders | menu API/order snapshots | Two-order price test | PASS | — | Historical snapshot retained. |
| R-032: Topping placement whole/left/right | domain/order service/customer UI | Direct API vs UI inspection | PARTIAL | High | Backend only; customer/kitchen incomplete. |
| R-033: Same topping on both halves counts once per pizza | pricing domain | Unit/source inspection | PASS | — | Placement normalization supports this. |
| R-034: No per-topping quantity selector | customer customizer | Source inspection | PASS | — | — |
| R-035: No arbitrary topping maximum | domain/customer bundle config | Source inspection | PARTIAL | Medium | Safety cap 100 and generic bundle max 12 exist. |
| R-036: Cheese none/light/regular/extra | customer/order snapshot | Source/API inspection | PARTIAL | Medium | None/light are free text; extra is structured. |
| R-037: Crust/base choices and pricing | menu config/order service | Configured order test | PASS | — | — |
| R-038: Halal choice where applicable | pizza customizer/order service | Pizza order persisted | PARTIAL | High | Standard pizza works; deals omit control. |
| R-039: Gourmet recipe cannot be accidentally removed | customer/order service | Source inspection | FAIL | High | H-03. |
| R-040: Gourmet half changes and paid extras | customer/order service | Source inspection | FAIL | High | No UI halves; server does not preserve/enforce recipe delta semantics. |
| R-041: Subs/panzerotti use pizza engine with three included | menu/customer/order service | Source inspection | PARTIAL | Medium | Engine reused; extra rates inherit wrong size values; halves absent. |
| R-042: Wing count/pound options remain distinct | menu seed | Catalog inventory | PASS | — | Distinct product rows; required sizes incomplete. |
| R-043: Wing flavour selection/split without surprise fees | modifier config/order service | Source/order test | PARTIAL | Medium | Multi-select exists; explicit allocation split is absent. |
| R-044: Standalone wings do not silently include sides/dip | menu config | Catalog/order snapshot | PASS | — | — |
| R-045: Deal included quantities and paid extras are structured | deal modifier config | Order snapshot | PARTIAL | Medium | Main toppings/flavour/pops structured; several inclusions are description only. |
| R-046: Shared six-topping pool supports 4+2, 5+3, 6+0, 3+3 | bundle modifier/domain | Direct order tests | FAIL | High | H-02. |
| R-047: Cart add/remove/edit/quantity | customer cart | Source/runtime API | PARTIAL | Medium | Add/remove exists; edit and quantity adjustment are incomplete. |
| R-048: Cart persists across refresh | customer local storage | Source inspection | PASS | — | — |
| R-049: Cart snapshots current price/options and revalidates | customer/order service | Price/status tests | PARTIAL | High | Server rejects stale state; client does not reconcile. |
| R-050: Contextual upsells | customer app | Source search | FAIL | Medium | No upsell engine. |
| R-051: Clear subtotal/discount/HST/fee/tip/final checkout | checkout UI/domain | Source inspection | FAIL | High | Server calculates; customer review omits full breakdown. |
| R-052: Tip presets plus no-tip and custom tip | admin settings/customer UI/order API | Source inspection | PARTIAL | Medium | Presets/no-tip work; custom UI absent. |
| R-053: Coupon entry and explicit validation | customer/order service | Promotion test | FAIL | Critical | No input; coded rule auto-applies. |
| R-054: Promotion dates, rules, stacking, limits | order service/admin config | Source inspection | PARTIAL | High | Dates/basic rule exist; codes/limits/stacking/rich rules absent. |
| R-055: Discounts applied before tax with correct allocation | `priceCart` | Exact calculation/source | PARTIAL | Medium | Order is correct; mixed-tax line eligibility allocation is not. |
| R-056: Delivery pay-at-store disallowed | customer/order service | Source inspection | PASS | — | Server rejects. |
| R-057: Pickup pay-at-store works | customer/order service | Local order | PASS | — | — |
| R-058: Online payment securely hosted | Stripe session route | Static review | NOT TESTABLE | High | Valid provider credential unavailable. |
| R-059: Payment failure never shows success | order service/customer | Missing/invalid provider tests | PASS | — | 503/502 and cancelled failed order. |
| R-060: Durable checkout idempotency across retry/refresh | customer/order service | Source and repeat test | FAIL | Critical | Server same-key works; client key is not durable. |
| R-061: Payment webhook trusts signed provider facts | Stripe webhook | Static review | PASS | — | Real webhook NOT TESTABLE but implementation verifies signature/amount/state. |
| R-062: Refund/void/reconciliation lifecycle | schema/admin/API | Source search | FAIL | High | No operational implementation. |
| R-063: Terms/privacy/cancellation acknowledgement | policy routes/customer checkout | Source inspection | PARTIAL | Medium | Pages exist; checkout acknowledgement absent. |
| R-064: ASAP/scheduled within lead time/hours | customer/order service | Source/order test | PASS | — | Regular-hours path works. |
| R-065: Separate pickup/delivery schedules | settings/order service | Source inspection | FAIL | High | One regular-hours map. |
| R-066: Holiday, closure, temporary pause, capacity slots | settings/order service | Source inspection | PARTIAL | High | Global pause exists; exceptions/capacity absent. |
| R-067: Owner wait estimates affect customer display | ordering settings/customer catalog | API transient edit | PASS | — | Current estimates are catalog-driven. |
| R-068: Midnight store closing editable | admin hours editor | Conversion inspection | FAIL | High | 1440 round-trips to invalid 0. |
| R-069: Order and item immutable operational snapshots | order service/schema | DB inspection | PASS | — | Product/config/prices stored. |
| R-070: Order events and audit trail | order events/audit log | Lifecycle test | PARTIAL | High | Normal events work; concurrent status event correctness is unsafe. |
| R-071: Secure public tracking by number plus token | tracking route/security | Positive/negative/rate-limit tests | PASS | — | Token URL leakage remains separate security finding. |
| R-072: Tracking shows current fulfillment status/ETA safely | tracking app/route | Source/API | PARTIAL | Medium | Status/schedule shown; no payment state/auto-refresh/live ETA. |
| R-073: Kitchen receives new-order alert and acknowledgement | staff portal/dashboard/actions | Source/status test | PARTIAL | High | Alert/ack works; no complete order content or backup delivery. |
| R-074: Kitchen sees all item customization/details | dashboard/kitchen cards | Response inspection | FAIL | Critical | C-05. |
| R-075: Kitchen sees permitted delivery/contact/payment details | dashboard/kitchen cards | Response/permission inspection | FAIL | Critical | Address/payment absent; phones overexposed. |
| R-076: Valid fulfillment-specific status transitions | domain/admin actions | Transition tests | PASS | — | — |
| R-077: Scheduled/live/history order queues | dashboard/staff portal | Source/API | FAIL | High | Capped live list only. |
| R-078: Cancellation with reasons and refund state | admin actions/schema | Source search | FAIL | High | No complete workflow. |
| R-079: Notification failure does not lose order | order service/outbox | Provider-unavailable order | PASS | — | Intent persists, but is never dispatched. |
| R-080: Customer confirmation email and feedback request send | notification outbox | DB/source inspection | FAIL | High | No sender/worker. |
| R-081: Owner overview uses real data | dashboard query | API inspection | PARTIAL | High | Real DB, but rolling/unpaid sales semantics are misleading. |
| R-082: Owner order detail/history/search/export | staff portal/dashboard | Source inspection | FAIL | High | — |
| R-083: Owner menu categories/products/variations/toppings editing | admin controls/actions | Transient edits | PASS | — | Core writes are real. |
| R-084: Owner edits survive deployments/seeding | menu seed routine | Upsert inspection | FAIL | Critical | C-08. |
| R-085: Owner can duplicate, schedule, bulk-state, preview menu | admin controls | Source inspection | FAIL | Medium | — |
| R-086: Owner configures shared topping pool without code | modifier editor | Source inspection | FAIL | High | Shared metadata not exposed. |
| R-087: Owner promotions/coupons UI | staff portal/admin controls | Source inspection | FAIL | High | — |
| R-088: Owner delivery radius/fee/minimum controls affect orders | settings/order service | Transient edits/source | FAIL | High | Fee connects; radius/minimum do not. |
| R-089: Owner tax/tip controls affect totals/UI | settings/customer/domain | Transient preset inspection | PARTIAL | Medium | Presets connect; custom tip UI absent. |
| R-090: Owner store hours/closures/timing controls | settings/customer/order service | Source and transient edits | PARTIAL | High | Basic hours/estimates; midnight and exceptions fail. |
| R-091: Owner content/policy/review-link control | settings/customer/policy pages | Source/transient edit | PARTIAL | Medium | Hero content connects; prices/policies remain hard-coded; review URL unverified. |
| R-092: Owner payment/refund/settlement controls | admin UI/API | Source search | FAIL | High | — |
| R-093: Owner feedback management | overview/staff portal | Source inspection | FAIL | High | Count only. |
| R-094: Owner analytics and exports | overview/staff portal | Source inspection | FAIL | High | Three summary metrics only. |
| R-095: Owner audit log view | audit table only | Source inspection | PARTIAL | Medium | Writes exist; no viewer. |
| R-096: Optimistic concurrency/unsaved changes | config API/admin UI | stale-write tests | PARTIAL | Medium | Settings versioned; menu/actions and navigation guards incomplete. |
| R-097: Staff login/session/disable | auth routes/security | API tests | PASS | — | — |
| R-098: Least-privilege order/contact permissions | dashboard/actions | Permission test | FAIL | Critical | C-03. |
| R-099: Employee cannot elevate own role/permissions | admin actions | Source inspection | FAIL | Critical | C-04. |
| R-100: Basic time clock and break sequence | timeclock route/employee UI | Sequential API tests | PASS | — | — |
| R-101: Time-clock concurrency integrity | timeclock route/schema | Simultaneous requests | FAIL | Critical | C-06. |
| R-102: Time correction and time-off submission | timeclock route/employee UI | API/source | PARTIAL | Medium | Correction UI and partial-day UI incomplete. |
| R-103: Manager approvals and payroll exports | admin actions/staff portal | Unsupported action/source | FAIL | High | — |
| R-104: Feedback token, repeat protection, cancellation guard | feedback route | API tests | PASS | — | — |
| R-105: Feedback only after completion/delay | feedback route/operations setting | Immediate submission | FAIL | High | H-09. |
| R-106: Feedback question validation and conditional pizza/wing logic | feedback route | Invalid answer/source | FAIL | High | Wing detection broken. |
| R-107: Low-rating owner email and review-link control | feedback/outbox/settings | DB/source | FAIL | High | No dispatcher; URL unverified. |
| R-108: Analytics events are real, not random | analytics route/table | D1/source | PASS | — | Public client claims still need reconciliation. |
| R-109: Actionable owner analytics/funnel/menu/promo reports | staff portal | Source search | FAIL | High | — |
| R-110: Password/session/token security primitives | `lib/auth.ts`, `lib/security.ts` | Source/API | PASS | — | — |
| R-111: Public token not leaked through logs/referrers | tracking/feedback URLs | Runtime log evidence | FAIL | High | H-15. |
| R-112: Rate limiting for sensitive public routes | auth/track/feedback/security | Probe tests/source | PASS | — | Analytics/order limits also exist. |
| R-113: Standard HTTP security headers | runtime/next config | Header request | FAIL | High | H-16. |
| R-114: Secure image upload validation and serving | uploads routes | Static review | PARTIAL | High | Auth/size/type pass; content sniffing/magic bytes fail. |
| R-115: No committed secrets | repository | Pattern scan | PASS | — | Dependency advisory state not included. |
| R-116: Database referential/state integrity | schema/migration | Source inspection | FAIL | High | No foreign keys/checks. |
| R-117: Schema migrations consistent across environments | runtime/migration | Fresh/runtime comparison | FAIL | High | H-13. |
| R-118: Failure-safe payment and notification boundaries | order service/outbox | Provider tests/source | PARTIAL | High | No false payment success; idempotent recovery/sending absent. |
| R-119: Keyboard, focus, contrast, responsive conformance | customer/staff CSS/components | Browser unavailable | NOT TESTABLE | High | Static partial evidence only. |
| R-120: Accessible labels, focus styles, skip navigation | layout/global CSS/components | Static source inspection | PARTIAL | Medium | Good baseline; dialogs/radiogroups/tables incomplete. |

---

# 18. Hard-coded, mocked, or disconnected functionality

## Hard-coded business data

- Public hero price `$8.99 medium · 1 topping` and featured deal price `$27.99`.
- Required menu seed prices and recipes in `lib/launch-config.ts` / `lib/menu.ts`.
- A concrete Google review URL despite the source stating one was not supplied.
- Toronto timezone inside order service rather than the owner business setting.
- Feedback low-rating outbox state `pending_provider_setup`.
- Public policy page content is code-owned, not owner-editable.
- `halalPreparationClaim` and `dryRubLabel` enabled despite being unconfirmed.

Hard-coding initial launch seed data is acceptable only if it is accurate and never overwrites owner changes. C-08 violates the second condition.

## Placeholder/mock/demo behavior

- No fake menu or random dashboard analytics were found.
- No demo payment success path was found; provider errors fail closed.
- The overview’s limited metrics are real database queries, but their “today”/sales meaning is misleading.
- Legacy admin panels remain in source but are not the rendered owner workflow.

## Settings or controls disconnected from operations

- Delivery radius and geographic origin: saved but never used by checkout.
- Delivery minimum: represented in settings but not enforced.
- Feedback delay: saved but not used to gate/schedule feedback.
- Shared-pool modifier metadata: used by seeded data but not manageable in rendered editor.
- Menu card price: can differ from the variation price actually charged.
- Business timezone: stored but order service uses a constant.
- Review URL: stored and surfaced, but no feedback notification workflow verifies or schedules it.
- `customers` and `refunds`: present in migration/schema but absent from runtime initializer and operational APIs.

## Simulated or absent external behavior

- Email is an outbox intent only; there is no provider send, retry, webhook, or delivery state.
- Stripe checkout/webhook code exists, but real provider success and settlement were not exercised.
- Refund behavior is absent rather than simulated.
- R2 upload binding exists; production storage delivery was not tested.

## Buttons/workflows without the required real action

- Employee correction/time-off requests have no owner approval action/UI.
- No cancellation/refund button completes a financial reversal.
- No owner feedback response/escalation controls exist.
- No promotion management surface exists despite a backend promotion upsert action.
- No analytics drill-down/export controls exist.

---

# 19. Remediation plan

Do not begin these changes until this audit is reviewed and the source-of-truth menu/flyer is confirmed.

## Phase 1 — Launch blockers

| Problem | Required change | Affected areas | Priority | Complexity | Dependencies | Acceptance test |
|---|---|---|---|---|---|---|
| Delivery accepts out-of-area addresses (C-01) | Add server-side address normalization/geocoding, immutable store origin, distance/radius check, explicit indeterminate failure, and boundary tests. Enforce before order/idempotency/payment creation. | Customer gate, order service, settings, DB/audit | P0 | Large | Approved geocoder/distance policy; exact store origin | Hamilton inside address passes; `K1A 0B1`, outside-radius, invalid, and geocoder-timeout requests create no order/payment. Free delivery never changes eligibility. |
| Coded promotions auto-apply (C-02) | Add explicit coupon input, normalized constant-time code lookup, automatic-vs-code distinction, line eligibility, usage/stacking rules, and tax-correct allocation. | Customer checkout, order contract, promotion engine/admin | P0 | Large | Owner promotion policy | No code means no coded discount; valid/expired/wrong-case/usage-limit/stacking/mixed-tax tests pass exactly. |
| Authorization defects (C-03/C-04) | Field-level contact authorization; prohibit self role/permission mutation; define immutable owner boundary and permission matrix. | Dashboard serializers, staff actions, audit logs, tests | P0 | Medium | Approved role matrix | Every role/permission combination is API-tested; unauthorized phone never serializes; self-elevation returns 403 and audit alert. |
| Kitchen lacks fulfillment data (C-05) | Return/render complete immutable order-item snapshots, modifier placement, deal/wing allocation, instructions, address/contact with permissions, and payment/refund state. | Dashboard API, kitchen UI, print/a11y | P0 | Large | Approved kitchen ticket layout | A matrix of pizza halves, gourmet, deal, wings, pickup/delivery, scheduled, halal, and notes can be prepared solely from the ticket. |
| Clock-in race corrupts state (C-06) | Serialize per-employee transitions using transaction/guarded state row/unique active constraint; make replay tolerant and add concurrency tests. | Time-clock service/schema | P0 | Medium | D1 transaction design | 20 simultaneous clock-ins yield one 200 and 19 conflicts; state remains readable and payroll duration exact. |
| Checkout retry can duplicate (C-07/H-17) | Persist one idempotency key with checkout draft; reuse across retries; model resumable payment attempt separately from final order; reconcile abandoned sessions. | Customer checkout, order service, payment model | P0 | Large | Stripe retry/session design | Timeout, refresh, back, double-click, provider 5xx, and webhook retry produce at most one charge/order and a recoverable customer state. |
| Seed overwrites owner data (C-08) | Separate immutable one-time seed/migration from owner-owned live rows; use explicit migration transforms and change previews. | Menu seed, migrations, deployment | P0 | Medium | Canonical menu sign-off | Owner edits price/name/config, deploys next seed version, and all owner values remain unless an explicit reviewed migration changes them. |
| Incorrect menu/prices (H-01/H-02/H-22) | Reconcile every item/category/size/price/offer against approved flyer and `information.md`; correct pool rules and golden totals. | Seed/config/tests/customer/admin | P0 | Medium | Actual flyer asset and owner sign-off | Automated golden catalog and cart fixtures match every approved value; 4+2, 5+3, 6+0, 3+3 totals pass. |
| Payment/refund lifecycle incomplete (H-07/H-25) | Implement verified Stripe staging success/failure/webhooks, owner cancellation/refund with reasons, idempotent provider refund, state/audit/reconciliation. | Payment routes, schema, admin, tracking | P0 | Large | Stripe test account; refund policy | Payment, duplicate webhook, partial/full refund, provider failure, retry, and reconciliation tests pass with no duplicate refund. |
| Schema/integrity drift (H-13/H-14) | Make migrations the single schema path; add migration ledger, foreign keys/constraints where supported, state validators, and staging migration rehearsal. | D1 schema/runtime/deploy | P0 | Large | D1 migration strategy/backups | Empty and prior-version DBs converge to identical schema; integrity violations fail; rollback/restore is rehearsed. |

## Phase 2 — Owner operational readiness

| Problem | Required change | Affected areas | Priority | Complexity | Dependencies | Acceptance test |
|---|---|---|---|---|---|---|
| No complete order operations | Add live/scheduled/history queues, search/filter, full detail, receipt/print, late/ETA, cancel/refund, and audit views. | Admin/kitchen APIs/UI | P1 | Large | Phase 1 kitchen/payment state | Owner processes representative day from new order through completion/refund without database/developer access. |
| Promotion UI absent | Add automatic/coded promotion editor with schedule, eligibility, caps, stacking, preview, deactivate, and usage report. | Admin/promotions/pricing | P1 | Large | Correct Phase 1 engine | Owner creates, previews, activates, tests, and deactivates each supported promotion without code changes. |
| Delivery/time controls misleading | Connect fee/minimum/radius/origin to server; add separate hours, holidays, closures, pause reason, capacity, lead time, and fix midnight round-trip. | Settings/order service/customer | P1 | Large | Delivery provider/policy | Owner changes each control and a boundary test proves customer behavior changes immediately and correctly. |
| Financial control/reporting absent | Add settled sales, tax, tips, fees, discounts, payments, refunds, reconciliation, date boundaries, CSV exports. | Admin/reporting/payment | P1 | Large | Payment/refund lifecycle | Report totals reconcile cent-for-cent to orders, provider settlements, refunds, and Toronto calendar dates. |
| Menu editor incomplete | Expose shared pools/fixed recipes/halal/inclusions; clarify card vs charged price; add duplicate, preview, schedule, bulk state, validation and confirmation. | Admin menu/customer catalog | P1 | Large | Canonical menu model | Owner can recreate all approved flyer offers from a blank staging menu and golden checkout tests pass. |
| Permission management unsafe | Add explicit permission descriptions, protected owner invariants, contact masking, session revocation, and security audit view. | Auth/admin/security | P1 | Medium | Role matrix | Permission matrix and owner-loss/self-escalation regression suite pass. |
| Content remains code-owned | Move hero prices/deals, policy text, verified review URL, contact/hours copy into validated owner content controls. | Admin/content/public pages | P1 | Medium | Legal/owner copy approval | Owner updates content, previews it, and rollback/version history works without deployment. |

## Phase 3 — Completeness and reliability

| Problem | Required change | Affected areas | Priority | Complexity | Dependencies | Acceptance test |
|---|---|---|---|---|---|---|
| Notification intent never sends | Implement provider adapter, outbox worker, retries/backoff, idempotency, dead-letter, templates, delivery status, and owner failure UI. | Outbox/email/ops | P2 | Large | Email provider/domain | Order confirmation and delayed feedback email deliver once; provider outage retries without losing order or duplicating mail. |
| Feedback is premature/unvalidated | Gate by completion plus delay, validate schemas/ranges/required questions, use snapshot types, fix wing detection, add owner inbox/escalation/trends. | Feedback API/UI/admin | P2 | Medium | Notification worker | Early/invalid/repeated submissions fail; pizza/wing questions are correct; low rating creates one delivered owner alert. |
| Analytics not decision-grade | Define consent/retention, server-side fact events, reconciliation, funnel/menu/promo/fulfillment reports, settled-sales semantics and exports. | Analytics/order/admin/privacy | P2 | Large | Metrics definition and consent policy | Reports reconcile to controlled order fixtures and exclude unpaid/cancelled/refunded amounts as specified. |
| Time-off/correction workflow incomplete | Add employee correction UI, partial-day UI, manager approvals/notes, period lock, biweekly summary and payroll exports. | Employee/admin/timeclock | P2 | Large | Clock concurrency fix; payroll policy | Full request/approve/reject/export workflow passes across roles and time zones. |
| Token URLs and headers unsafe | Replace query bearer tokens with fragment-to-POST or one-time exchange; redact logs/referrers; add CSP/HSTS/nosniff/frame/referrer headers. | Tracking/feedback/runtime/security | P2 | Medium | Hosting header support | Access logs contain no token; referrer test leaks none; security-header and CSP integration tests pass. |
| Upload validation incomplete | Decode/re-encode approved images, inspect signatures/dimensions, store safe content type, add `nosniff`, quota and deletion audit. | Upload/R2 | P2 | Medium | Image processing choice | Polyglot/fake MIME/oversize/bomb fixtures are rejected; valid image renders. |
| Weak automated coverage | Add API/database/auth/payment/concurrency/component/e2e/a11y tests and production-like staging smoke suite. | Test infrastructure/CI | P2 | Large | Stable staging bindings/browser | CI blocks each reproduced Critical/High regression and publishes auditable results. |
| Accessibility unverified | Correct dialog focus, keyboard radios/tables/status announcements; run automated and manual keyboard/screen-reader/viewport audit. | Customer/admin/kitchen/employee | P2 | Medium | Browser/a11y test environment | WCAG 2.2 AA target checklist passes for every core flow at required viewports. |

## Phase 4 — Enhancements

| Problem | Required change | Affected areas | Priority | Complexity | Dependencies | Acceptance test |
|---|---|---|---|---|---|---|
| Cart editing/upsells are basic | Add in-place edit/quantity, safe catalog reconciliation, relevant non-deceptive upsells and clear price deltas. | Customer/cart | P3 | Medium | Stable menu engine | Edited cart re-prices correctly; stale/removed items get an actionable explanation. |
| Tracking is static | Add safe polling or push, payment/refund display, ETA history, accessible status announcements. | Tracking/API | P3 | Medium | Complete order/payment state | Status updates without refresh, stops after terminal state, and leaks no contact/token. |
| Customer accounts/reorder absent | If owner elects to enable, implement verified identity, privacy controls, historical snapshot-to-current-cart reconciliation, and guest merge. | Auth/customer/orders/privacy | P3 | Large | Privacy/legal decision | Reorder never silently uses stale price/options and guest checkout remains available. |
| PWA/offline UX incomplete | Validate icons/installability and provide explicit offline read-only state without queuing financial mutations. | Manifest/service worker/UI | P3 | Small | Browser test environment | Lighthouse/install smoke passes; offline checkout clearly blocks rather than pretending to submit. |

---

# 20. Final verdict

## Safe to keep

- The integer-cent/basis-point pricing foundation and 13% HST calculation pattern.
- Immutable order/item/configuration snapshots.
- Guest pickup and pay-at-store path after the surrounding blockers are fixed.
- PBKDF2 password storage, hashed sessions/public tokens, hardened cookies, and active-user checks.
- Server-side same-key idempotency concept.
- Versioned admin settings writes.
- D1 outbox pattern, provided a real dispatcher/retry system is added.
- Fail-closed behavior when Stripe is missing or rejects the session.
- Valid order-status transition model and service-worker exclusion of sensitive routes.

## Must be fixed before launch

All Critical issues C-01 through C-08 and all Phase 1 items: geographic delivery enforcement, exact menu/pricing, promotion code semantics, field/role authorization, complete kitchen tickets, durable checkout retry, time-clock concurrency, owner-safe seeding, schema integrity, and payment/refund lifecycle.

## Needs operational redesign

Owner order operations, promotions, delivery schedules/closures, financial reconciliation, kitchen tickets, notification delivery, feedback administration, analytics, payroll approvals/exports, and role governance are not small UI gaps. They require explicit domain state, permissions, auditability, failure recovery, and acceptance fixtures.

## Can the owner run it without developer support?

**No.** The owner can change a useful subset of settings/menu/team data, but cannot safely operate promotions, delivery boundaries, exceptions, paid cancellations/refunds, scheduled/history queues, feedback escalation, analytics/reconciliation, notifications, or payroll approvals. Some visible controls do not affect the order path.

## Should real customer orders be enabled?

**No.** Keep production ordering disabled. Reassess only after Phase 1 is implemented and all reproduced blocker tests pass in a production-like staging environment with the approved flyer, real geospatial policy, Stripe test account, notification provider, browser accessibility suite, and migration rehearsal.
