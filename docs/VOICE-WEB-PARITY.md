# Voice ↔ Website Functional Parity

**Date:** 17 October 2026 · **Branch:** `release/r1-runway` · **Status:** implemented and tested locally; not deployed; ElevenLabs workspace unchanged.

The rule this pass followed: anything a customer can do in the public website's ordering flow, a caller can do by voice, through the same backend contract, unless there is a stated reason not to. Parity means functional parity. The website's localStorage, modals and animations have no voice equivalent and need none.

The architecture rule did not change: **the model interprets; the server decides.** The voice layer turns words into the same `OrderRequest` the website sends, and `quoteOrder` / `createOrder` decide every price, discount, tax, fee, tip, time and eligibility. No second pricing, promotion or scheduling implementation was written.

Companion documents: [ELEVENLABS-VOICE-TOOLS.md](ELEVENLABS-VOICE-TOOLS.md) (the tool contract), [VOICE-AGENT-PROMPT.md](VOICE-AGENT-PROMPT.md) (the production prompt), [AI-RECEPTIONIST-ARCHITECTURE.md](AI-RECEPTIONIST-ARCHITECTURE.md) (call routing and phases).

---

## 1. What the website lets a customer do

Traced from the current code, not from older docs: `app/customer/CustomerApp.tsx` (menu, cart, `Checkout`), `app/menu/ItemCustomizer.tsx`, `app/menu/useServerQuote.ts`, `POST /api/orders/quote`, `POST /api/orders`, `GET /api/orders/track`, `lib/order-service.ts`, `lib/domain.ts`, `lib/public-catalog.ts`, `lib/clover.ts`, `lib/payment-completion.ts`, `lib/gift-cards.ts`, `lib/notifications/*`.

| Area | What the customer can do | Where it is decided |
|---|---|---|
| Store info | See open/closed, a countdown to last orders, closures, pause message, hours, address, phone | `storeStatus`, `closures`, `business`/`hours`/`ordering` settings |
| Menu | Browse categories and products with prices, descriptions, sold-out state, offer-hours labels; pickup/delivery-specific products; daily specials | `loadPublicCatalog` (drops `staffOnly`, inactive), `isWithinWeeklyAvailability` |
| Pizza | Size; cheese None / Light / Regular / Extra; crust; sauce (some paid); bake & sauce (up to 2); toppings whole/left/right; recipe omissions on specialties; extras; quantity; special instructions | `PizzaCustomizer`, then `validateItems` → `pricePizza`, `priceModifierSelections` |
| Other items | Required/optional sections with min/max (wing style, sauces, drinks, deal pizzas with shared topping pools), quantity, instructions | `GenericCustomizer`, `validateModifiers` |
| Cart | Add, remove lines; a server quote on every change | `quoteOrder` |
| Fulfilment | Pickup or delivery | settings + per-product eligibility |
| Contact | Full name, phone, **email (required)** | `normalizeCustomer` (`full` policy) |
| Delivery | Street, unit, postal code (Hamilton only), delivery instructions (≤ 500); radius, minimum, fee, free-delivery products | `checkDeliveryEligibility`, `validateDelivery`, Azure Maps / FSA centroid |
| When | ASAP (only while taking orders); **Schedule later** from a dropdown of the next 48 slots (15-minute grid, opening hours, lead time; `nextOrderSlots` defaults, so about one day ahead) — available while the store is closed | `nextOrderSlots`, `validateSchedule`, `closureFor`, last-order cutoff (ASAP only) |
| Promo code | One code; told whether it applied and why not | `activePromotions`, `describeCouponMiss` |
| Gift card | One code; balance, applied amount, remaining; partial or full payment | `resolveGiftCard`, hold/capture in `createOrder` |
| Tip | None, 10/15/18 %, or a custom dollar amount; % of food after discount | `priceCart`, `taxAndTips` settings |
| Payment | Pickup: pay at store or online. Delivery: online only (`cashOnDeliveryEnabled: false`). Online = inline Clover card iframe, or Clover Hosted Checkout redirect | `paymentMethodRefusal`, `createCloverCharge`, `createCloverCheckout`, webhook → `applyPaymentApproved` |
| Review | Full server-priced breakdown; destination, time, payment restated; terms checkbox; `expectedAmountDueCents` consent check | `quoteOrder`, `createOrder` |
| After ordering | Confirmation screen; confirmation email with tracking link; tracking page (order number **and** secret token); status emails | `customer_order_confirmation`, `/api/orders/track`, `customer_status_update` |

## 2. What a caller can do by voice now

| Area | Voice tool(s) | Change in this pass |
|---|---|---|
| Store info | `get_store_status` | Adds `acceptingScheduledOrders`, earliest scheduled times, spoken `nextOpenAt` |
| Business facts | **`get_business_info`** (new) | Address, phone, website, weekly hours, next 7 days with closures and last-order times, pickup/delivery/payment rules — from live settings |
| Menu | `search_menu`, `get_menu_item`, `get_deals` | Resolver detects the cheese step and more spoken option forms; `get_menu_item` lists cheese choices |
| Pizza | `add_item` / `update_item` | **`cheese`** field: none / light / regular / extra, encoded exactly as the website does |
| Other items, cart | `add_item`, `update_item`, `remove_item`, `get_cart`, `reset_order`, `start_order` | Cart view shows time, code, tip and promotions |
| Fulfilment, contact, delivery | `set_fulfilment`, `set_customer`, `check_delivery_address` | Delivery instructions now read back |
| When | **`get_order_slots`**, **`set_schedule`** (new) | Orders for later, including while closed |
| Promo code | **`apply_coupon`**, **`remove_coupon`** (new) | Through the website's coupon rules |
| Tip | **`set_tip`** (new) | Presets or a dollar amount, caller-initiated |
| Review / confirm / place | `review_order`, `confirm_order`, `place_order` | Read-back states time, promotions by name, code outcome, tip, free delivery, delivery instructions |

## 3. Parity matrix

Website capability → shared backend → voice before → gap → change → test (`tests/voice-parity.test.ts` unless noted).

| # | Capability | Shared backend | Voice before | Gap | Change | Test |
|---|---|---|---|---|---|---|
| 1 | Open now / cutoff / closure / pause | `storeStatus`, closures | ✅ | ASAP only | earliest scheduled slot, `acceptingScheduledOrders` | "past the last-order cutoff…", "a caller can order for later while the store is closed…" |
| 1b | Address, phone, website, hours | settings | ❌ ("I don't have our street address handy") | whole capability | `get_business_info` | "the agent answers address, phone, website and hours from the live settings" |
| 2 | Menu discovery, sold out, offer hours | public catalogue | ✅ | none | — | `voice-tools.test.ts` (sold-out, offer hours) |
| 3 | Cheese step | customizer note prefix + `extraCheese` | extra only; light/none via free text | structured choice | `cheese` field; resolver detection | "the cheese step…", golden phrases in `voice-menu-resolver.test.ts` |
| 3b | Halves, crust, sauce, bake, omissions, allowances, paid extras | `pricePizza`, `validateModifiers` | ✅ | spoken forms ("light sauce", "only on the left") | aliases; `only` ignored for placement | "spoken pizza choices…", resolver goldens (267, zero wrong) |
| 4 | Wings, drinks, deals, shared pools, required sections | `validateModifiers` | ✅ | none | — | `voice-tools.test.ts` wings/combo/pool tests; parity case 4 |
| 5 | Cart edits | — | ✅ versioned | new choices must version | options in the versioned draft | "a changed time, code or tip after the yes…" |
| 6 | Item notes; delivery instructions | `specialInstructions`, `address.instructions` | ✅ stored | not read back | read-back line | "a delivery's instructions reach the order and the read-back" |
| 7 | Pickup, pay at store | `paymentMethodRefusal` | ✅ | none | — | `voice-tools.test.ts` |
| 8 | Scheduled orders, incl. while closed | `nextOrderSlots`, `validateSchedule`, `closureFor` | ❌ ASAP hard-coded | whole capability | `get_order_slots`, `set_schedule` | §B tests incl. DST both ways |
| 9 | Delivery | `checkCartDeliveryEligibility` | ✅ behind `VOICE_PILOT_FULFILMENTS` | payment (see §4) | — | `voice-tools.test.ts` delivery tests; parity case 4 |
| 10 | Promo codes | `activePromotions`, `describeCouponMiss` | ❌ forbidden | whole capability | `apply_coupon`, `remove_coupon`; policy split | §F tests |
| 11 | Automatic promotions | `priceCart` | priced, unnamed | not named | named in read-back | "an automatic promotion applies…" |
| 12 | Gift cards | hold/capture | ❌ | **deliberate exception** (§4.1) | refused by policy and validator | §G test |
| 13 | Tips | `priceCart` | ❌ forced none | whole capability | `set_tip` | §H tests |
| 14 | Email | `normalizeCustomer` | not asked | **owner decision** (§4.3) | — | `ai-phone-channel.test.ts` |
| 15 | Online card payment | Clover | ❌ | **owner decision + blocker** (§4.2, §7) | — | §I tests (no card data anywhere) |
| 16 | Server totals | `quoteOrder` | ✅ | tip, code, time missing | in quote, cart view and read-back | §A parity cases |
| 17 | Sold out | `products.sold_out`, `toppings.active` | ✅ | none; option values cannot be sold out on either channel | — | `voice-tools.test.ts` |
| 18 | Review → consent → place | `expectedAmountDueCents` | ✅ strict | new choices | all in read-back and version | §J tests |
| 19 | Tracking / status | token-protected | ❌ | **privacy exception** (§4.4) | — | — |

**Parity proven, not asserted.** Section A of `tests/voice-parity.test.ts` builds the same four carts twice — once through the voice tools, once in the website's own request encoding to `POST /api/orders/quote` — and requires identical line totals, subtotal, discount, delivery fee, tax, tip, total, amount due and applied promotions. The cases cover a half-and-half pizza with extra cheese, crust and bake; a specialty with an omission, light cheese, a note and wings with a 15 % tip; a promo code on its eligible item with a custom tip, scheduled for tomorrow; and a free-delivery deal with required sections on a delivery order. A fifth test does the same with a temporary automatic promotion.

## 4. Intentional differences, and why

### 4.1 Gift cards — not by voice (security)

Website: a 16-character bearer code typed into a box; the database stores only a hash ("a dump of the database contains no spendable money").

Why not by voice:

1. **It would put spendable money into transcripts.** A spoken code goes into the ElevenLabs conversation transcript and recording (third-party retention), into our post-call transcript event (`voice_call_events`, whose redaction catches digit runs, not a spelled alphanumeric code) and into the tool request log. That breaks the one invariant gift cards were designed around.
2. **Speech-to-text cannot carry it reliably.** The alphabet drops 0/O/1/I/L for reading, but spoken it keeps the letter groups that sound alike (B/D/E/G/P/T/V/Z, M/N, S/F). A wrong character gets the deliberately uninformative "We could not find that gift card", and the caller loops.
3. **The policy now enforces it.** `allowCodes` was split into `allowCouponCodes` and `allowGiftCards`; `AI_PHONE_ORDER_POLICY` has `allowGiftCards: false`, so `quoteOrder`/`createOrder` refuse a gift card for `ai_phone` even if one were sent. Every voice tool also refuses `giftCardCode`, `giftCard`, `balanceCents` and `appliedCents` by name.

What the caller is told: gift cards can be used on the website. **OWNER DECISION REQUIRED** only if the owner wants in-store redemption at pickup: today staff can only `adjust` a card's balance in Admin, not attach it to an existing order.

### 4.2 Online card payment — not by voice yet (owner decision + infrastructure blocker)

- **Current website behavior:** inline Clover card iframe, or a Hosted Checkout redirect. The order sits in `awaiting_payment` with its notifications parked until Clover confirms. The reaper cancels it after 20 minutes. Clover sessions expire after 15 minutes.
- **Proposed voice behavior:** never take card details by voice. Instead the backend creates the existing Hosted Checkout session and the link goes to the caller. Full design in §7.
- **Blocker:** customer SMS is off (`CUSTOMER_SMS_ENABLED`). The Twilio number is an unregistered Canadian long code that carriers filter (`lib/notifications/config.ts`). Voice collects no email, and spelling an email aloud is error-prone. A mistyped address would send the order details and payment link to a stranger.
- **Risk if built now:** the caller hears "your order is in", but the kitchen is not told until payment. A link that never arrives means the order is silently reaped 20 minutes later and the customer shows up for nothing.
- **Recommended default:** keep pickup pay-at-store (unchanged). Build the payment link only after the SMS sender is registered (toll-free verification or A2P 10DLC) and the owner chooses it.

### 4.3 Email — not asked by voice (owner decision)

- **Website:** email required, for the confirmation and the tracking link.
- **Voice:** `name_and_phone` policy; email is optional and not asked for.
- **Risk of asking:** misheard addresses, and order details sent to the wrong person.
- **Recommended default:** don't ask. The order number is read out, and the restaurant has the callback number. **OWNER DECISION REQUIRED** if phone customers should get email receipts. If so, the agent spells the address back letter by letter, and it becomes a `set_customer.email` field.

### 4.4 Order tracking / status by phone — not built (privacy)

The website shows an order only to someone holding its order number **and** its secret tracking token (`/api/orders/track`). Order numbers are sequential, and caller ID can be spoofed (architecture §11.6), so "what's the status of P62-10785?" by voice would be weaker than the website. Within the same call, `place_order` already says the number and the ready time. Recommended: hand status questions to staff. If it is wanted later, the minimum design is order number **plus** the order's phone number matching both the spoken number and a `presented` caller ID, with status only (no items, address or amounts). **OWNER DECISION REQUIRED.**

### 4.5 Delivery by phone — built, off until the owner switches it on (owner decision, unchanged)

Delivery is fully implemented (address, unit, instructions, radius, minimum, fee, free-delivery items, estimate) and covered by tests. It stays behind `VOICE_PILOT_FULFILMENTS=pickup,delivery`, because the only way to pay a voice delivery today is **at the door**. The website deliberately refuses that for strangers (`cashOnDeliveryEnabled: false`). Turning it on is the owner accepting pay-at-door for AI-taken orders (architecture §22 Q6). With a payment link (§4.2) it could instead match the website's pay-online rule.

### 4.6 Smaller deliberate differences

| Difference | Why |
|---|---|
| ~~7-day scheduling horizon~~ **resolved: no longer an exception** | Voice now offers exactly the website's visible slots: `orderSlots` calls `nextOrderSlots` with the same four arguments as `CustomerApp` (so the website's own defaults, 15-minute grid and first 48 slots, define the list), less closures. Nothing in the backend defines 7 days as the customer contract: `validateSchedule` allows up to 14 days and the UI shows about one. A time later than the last visible slot is refused (`beyond_horizon`) with that last time. Pinned by `tests/voice-parity.test.ts` ("voice offers exactly the times the website's checkout dropdown lists"). The one remaining difference is deliberate: slots a closure covers are not offered, where the website lists them and the order service refuses them |
| A tip is added only when the caller offers one | The website shows tip buttons to everyone, with None selected. A voice agent asking every caller for a tip is a different experience. **OWNER DECISION** if it should be offered |
| Percentage tips are the website's presets only (10/15/18) | The website offers no other percentage. Any dollar amount is accepted, as on the website |
| `VOICE_MAX_ORDER_CENTS` ($150) cap; three failures escalate; 150 tool calls per session | Voice-specific safety. The new schedule and tip refusals are "soft" and don't count as failures; three invalid promo codes in a row do |
| A promo code is not stored unless it is live | The website keeps an invalid code in its box, and `createOrder` then refuses the order (`PROMO_CODE_INVALID`). Voice refuses it at `apply_coupon` and re-checks at review |
| No pickup order-level note | The website has none; delivery instructions and item notes exist on both |
| Terms checkbox | No voice equivalent; the explicit yes to the server read-back is the consent |

### 4.7 Observations about the website itself (not changed)

- **Existing website/business-rule issue, OWNER REVIEW REQUIRED, deliberately not changed in the parity PR.** `nextOrderSlots` offers a slot at the exact closing minute (10:00 PM on a 10 PM day), and the last-order cutoff applies to ASAP only. So after 9:40 PM (cutoff 20 minutes before a 10 PM close) a website customer can no longer order ASAP, but can still schedule 10:00 PM, and the kitchen would receive an order at closing time. Voice matches the website here by design (parity means the same rule, not a stricter one). If the owner wants scheduled slots to stop at the cutoff too, it is one change in `nextOrderSlots` (or in `validateSchedule`) and both channels pick it up, because voice calls the same function. Pinned by the test "past the last-order cutoff" in `tests/voice-parity.test.ts`, which will need updating if the rule changes.
- `nextOrderSlots` does not skip closures, so a website customer can pick a slot inside a closure and only learn it at the quote. Voice filters them through the same `closureFor`.
- An invalid promo code leaves the website quote `ok: true` while `createOrder` refuses the order. Voice avoids this (§4.6). The website could add a quote issue for it.

## 5. Final tool list (22)

| Tool | Reads/writes | Notes |
|---|---|---|
| `get_store_status` | read | + scheduled availability |
| `get_business_info` | read | **new** |
| `search_menu`, `get_menu_item`, `get_deals`, `get_cart` | read | cheese info, options view |
| `start_order`, `reset_order` | write | reset keeps the chosen time; drops code and tip |
| `add_item`, `update_item`, `remove_item` | write | + `cheese` |
| `set_fulfilment`, `set_customer`, `check_delivery_address` | write | unchanged contracts |
| `get_order_slots` | read | **new** |
| `set_schedule` | write | **new** |
| `apply_coupon`, `remove_coupon` | write | **new** |
| `set_tip` | write | **new** |
| `review_order`, `confirm_order`, `place_order` | write | read-back extended; gate unchanged |

Exact schemas: `docs/elevenlabs-voice-tools.generated.json`, generated from `scripts/elevenlabs-voice-tools.mjs` and checked field-for-field against the server's registry by `tests/elevenlabs-voice-tools.test.mjs`.

## 6. Who owns what

| Data | Source of truth | Voice holds |
|---|---|---|
| Menu, prices, sections, availability | `products`, `product_variations`, `toppings` via `loadPublicCatalog` | nothing (read per call) |
| Prices, discounts, tax, fees, tip, total | `quoteOrder` / `createOrder` (`priceCart`) | nothing; `reviewed_amount_cents` is the server's own quote, kept for the consent check |
| Promotions and codes | `promotions` table | the code string the caller said (normalized) |
| Hours, closures, cutoff, lead times | `hours`, `store_closures`, `ordering` settings | the chosen slot's timestamp, re-checked at review and at placement |
| Business facts | `business` setting, `PUBLIC_BASE_URL` | nothing |
| Delivery eligibility | `checkDeliveryEligibility` | the normalized address and the last decision |
| The draft | `voice_calls` (`cart_json`, `order_options_json`, `cart_version`) | — |
| The order | `orders`, `order_items`, `payments`, `notification_outbox` | `order_id` |

## 7. Payment architecture

**Today (unchanged):** a voice pickup is `pay_at_store`; a voice delivery (when enabled) is `pay_at_store` with the driver collecting. No card data is ever requested. Every tool refuses `paymentMethod`, `paymentToken`, `card`, `cardNumber`, `cvv` and `expiry` by name. Notes and utterances carrying a card-like number are refused or redacted, and every log line goes through `redactForLog` (tested: a 16-digit number said as a "promo code" or a "tip" never reaches `voice_call_events`).

**Proposed secure payment link (not built — §4.2):**

```
review_order → caller confirms (read-back says "pay by the secure link we text you")
→ place_order: createOrder({ paymentMethod: "online", no paymentToken }, aiPhoneOrderContext with paymentMethods ["pay_at_store","online"])
   → existing Hosted Checkout path: order awaiting_payment, notifications parked, payments.provider_reference = session id
→ server sends checkout.href to the confirmed phone (registered SMS sender) — never through the model, never spoken
→ Clover webhook APPROVED → applyPaymentApproved → kitchen alert released (existing)
→ 20-minute reaper cancels if unpaid (existing); the agent says so in advance
```

What it needs, beyond the owner's decision: a registered SMS sender, `online` added to the AI policy's `paymentMethods`, and a `createOrder` return path for `checkoutUrl` that the voice layer never puts in a tool response. The read-back would also need wording that the order is not final until paid. No PCI scope reaches ElevenLabs or our voice code: Clover's page takes the card.

## 8. Schedule architecture

```
caller words ──► model: set_schedule { when, day: "tomorrow", time: "17:45" }
                     │
lib/voice/schedule.ts: parseDay / parseTime (deterministic; "next week" → ask)
                     │
orderSlots = nextOrderSlots({ now, hours, timeZone: America/Toronto, leadMinutes: website estimate })
             (the checkout dropdown's own call: first 48 slots)  − closureFor(...)
                     │
match by local date + minute ──► store that slot's timestamp in voice_calls.order_options_json
                     │                         (cart_version + 1: review and yes are void)
review_order: still in orderSlots? ASAP still possible? ──► quoteOrder({ schedule })  (validateSchedule, closures)
                     │
place_order ──► createOrder({ schedule: { type: "scheduled", scheduledFor } })  — validated again
```

- The model never sends or computes a timestamp (`scheduledFor`, `schedule`, `estimatedFor` are refused by name).
- Times are spoken in Hamilton time ("tomorrow at 5:45 PM", "Monday, October 19 at noon"). Daylight saving is handled by `nextOrderSlots`' own zone correction and tested both ways (1 November 2026, 14 March 2027).
- Refusals return the nearest real slots and do not count towards escalation.

## 9. Security model

Unchanged and re-tested: workspace bearer (`VOICE_TOOL_SECRET`, constant-time) plus the per-call session secret in `X-Voice-Session`; sessions minted only by the signed inbound route; unknown fields refused (`UNKNOWN_FIELD`); server-controlled fields refused by name (`FIELD_NOT_ACCEPTED`); `ai_phone` channel and policy fixed server-side; idempotent placement (`voice:<session>:<version>`); confirmation bound to version and amount; 5-minute confirmation lifetime.

Changed narrowly:

| Change | Scope |
|---|---|
| `allowCodes` → `allowCouponCodes` + `allowGiftCards` | AI: coupons yes, gift cards no. Website and till: both yes, as before |
| New caller-supplied fields | `code` (≤ 40), `when`/`day`/`time`, `type`/`percent`/`amount`, `cheese`. No existing forbidden field was removed |
| Forbidden-field list grows | `schedule`, `scheduledFor`, `estimatedFor`, `tipCents`, `tipAmountCents`, `amountCents`, `giftCard`, `balanceCents`, `appliedCents`, `cvv`, `expiry` |
| Session header | Must be the dynamic-variable reference `{ "variable_name": "secret__voice_session" }`; the template string is sent unexpanded and gets `401` (tested) |
| Soft refusals | A schedule or tip refusal leaves the failure streak unchanged instead of resetting or growing it |

### 9.1 `WEBSITE_ORDER_POLICY` vs `AI_PHONE_ORDER_POLICY`

| Field | Website | AI phone (now) | Reason for any difference | Still needed? |
|---|---|---|---|---|
| `channel` / `actorType` | `online` / `customer` | `ai_phone` / `ai_receptionist` | Reporting, kitchen ticket, audit trail to the call | Yes |
| `contactPolicy` | `full` (email required) | `name_and_phone` | No email by voice (§4.3) | Yes, pending owner decision |
| `allowStaffOnlyItems` | false | false | — | — |
| `paymentMethods` | pay at store, online | pay at store | No card by voice; payment link blocked (§4.2) | Yes, until §7 is built |
| `payAtStorePickup` | `setting` | `setting` | — | — |
| `allowPayOnDelivery` | false | false; true only with `VOICE_PILOT_FULFILMENTS=pickup,delivery` | Voice delivery can only be paid at the door (§4.5) | Owner decision |
| `bypassLastOrderCutoff` | false | false | — | — |
| `recordAttribution` | true | false | A call has no ad campaign | Yes |
| `alertRestaurant` | true | true | — | — |
| `allowCouponCodes` | true | **true** (was false) | Pilot restriction lifted: the code is a string the server checks | — |
| `allowGiftCards` | true | false | Bearer credential must not be spoken (§4.1) | Yes |
| Schedule | asap / scheduled | **asap / scheduled** (was asap only) | Built from the server's own slots | — |
| Tip | none / preset / custom | **none / preset / custom** (was none) | Caller-initiated only | Owner may choose to offer |

## 10. Test matrix

All in `tests/voice-parity.test.ts` unless noted. Every one drives the real tools against the real engine on the test database, with a frozen clock.

| Plan section | Covered by |
|---|---|
| A. Website ↔ voice parity | 4 cart cases + automatic promotion: line totals, subtotal, discount, fee, tax, tip, total, amount due, promotion names |
| B. Schedule | words parsing; slots = `nextOrderSlots` on the grid; past / too soon / before opening / after closing / off-grid / beyond the website's last visible slot / closure / delivery-only closure; DST fall-back and spring-forward; ASAP vs later today vs tomorrow; closed now + valid future (placed, stored timestamp checked); before opening; past cutoff; closure caught at review; soft refusals; no timestamp field; stale version |
| C. Pizza | cheese none/light/regular/extra (note encoding, pricing, update, refusal on wings, conflicting fields); halves; "light sauce"; "well done"; "thin crust"; "feta cheese" vs cheese step; ambiguous "bacon"; 13 new resolver goldens (`voice-menu-resolver.test.ts`, 267 total, zero wrong) |
| D. Deals / generic modifiers | parity case 4 (required sections, halves in a deal); existing wings/combo/shared-pool tests in `voice-tools.test.ts` |
| E. Delivery | existing deliverable / short / outside / unreadable / fee / HST tests; instructions to order and read-back; free-delivery parity case |
| F. Coupons | valid; invalid; malformed; not applicable (kept, explained, then applies); expired; not started; withdrawn mid-call blocks review; remove; three bad codes escalate; `discountCents` / `couponCode` refused |
| G. Gift cards | every voice route refuses gift-card fields; a gift card code as a "promo code" is refused; AI policy refuses (`ai-phone-channel.test.ts`, `order-policy.test.ts`) |
| H. Tips | none; preset; non-preset refused; dollar string and number; non-amount; above ceiling; tipping off; `tip` / `tipCents` / `amountCents` refused |
| I. Payment / data | pay at store and driver; card number as code or amount never logged; existing card-number tests in `voice-tools.test.ts` |
| J. Confirmation | changed time / code / tip / removed code after the yes → place refused and old version unconfirmable; existing review/confirm/stale/duplicate tests |
| K. Security | template-string session header → 401; expired session on new tools; unknown and forbidden fields on new tools; existing bearer/session/cross-session tests |
| Business info | live address/phone/website/hours; settings change changes the answer; internal hostname never spoken; whole-day closure |
| Generator | `tests/elevenlabs-voice-tools.test.mjs` (12): field coverage, header form, plan/update-in-place/create, conflicts, API allowlist |
| Simulator | `tests/voice-sim.test.ts`: scheduled run with code and tip |
| Session | `tests/voice-session.test.ts`: options parsing, versioning, choices-only storage |

## 11. Rollout checklist

Nothing below has been done. Each step needs your go-ahead.

1. **Review** this diff (code, migration `0014_voice_order_options.sql`, docs).
2. **Commit and PR** `release/r1-runway` → `main`; merging deploys to staging, then swaps to production, with `VOICE_AI_MODE` unchanged. Migration 0014 is additive (one column, default `'{}'`). The deployed backend also accepts every call the current 16 ElevenLabs tools make; none of their fields changed meaning.
3. **Smoke test after deploy** (mode `internal`, allowlisted phone only): `get_business_info`; a scheduled pickup for tomorrow; a promo code; a tip; a no-cheese pizza; confirm the kitchen ticket shows the time and "No Cheese".
4. **ElevenLabs workspace tools**, after deploy: with `ELEVENLABS_API_KEY` in the shell, `node scripts/elevenlabs-voice-tools.mjs --plan` (read-only), review the output, then `--apply-tools-only`. That updates the 16 existing tools **in place** (same IDs, so agent attachments survive), including the session-header form and the new `cheese` field, and creates the 6 new tools. It performs no agent, draft or publish operation.
5. **Agent draft:** attach the 6 new tool IDs; replace the prompt with `docs/VOICE-AGENT-PROMPT.md`; test in the ElevenLabs simulator; then publish **only on your instruction**.
6. **Owner decisions** (each independent): delivery by phone with pay-at-door (§4.5); tip offered vs only when asked (§4.6); email receipts (§4.3); status lookup (§4.4); gift-card redemption at pickup (§4.1); payment link after SMS registration (§4.2); whether scheduled slots should stop at the last-order cutoff (§4.7).
7. Twilio, Bell forwarding and `VOICE_AI_MODE` are not touched by any of the above.
