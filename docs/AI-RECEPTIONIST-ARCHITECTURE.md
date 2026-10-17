# AI Phone Receptionist — Architecture Discovery and Plan

**Date:** 17 October 2026 · **Branch inspected:** `release/r1-runway` @ `8b82e0e`
**Status of this original discovery:** planning snapshot at `8b82e0e`. Subsequent implementation through Phase 4 is described in [ELEVENLABS-VOICE-TOOLS.md](ELEVENLABS-VOICE-TOOLS.md#11-phase-4-staging-bridge), which takes precedence for current routes and configuration. Phase 4 is being released with voice mode off; forwarding, transfer and provider configuration remain deferred.

**Revision 2 (17 October 2026, after review).** No implementation was done for this revision.

1. Corrected the WebSocket finding (§1, §2, §7, §16): App Service can host WebSockets; what the app lacks is a tested WebSocket server. Provider scores were re-evaluated.
2. Corrected the scope of the Twilio Fallback URL (§11): it does not cover a Twilio outage.
3. Documented the AI-to-human transfer mechanism, separating what Twilio's documentation confirms from what needs a test spike (new §11.5).
4. Made caller-ID preservation an explicit must-test item, with a design that works without it (new §11.6).
5. Marked all vendor pricing and concurrency as provisional and to be verified at deployment.
6. Added a telephony spike to the phases (§20).

Throughout this document:

- **file references** are repository-relative paths, with the function or symbol named;
- **UNKNOWN** marks something the code cannot answer and that has to be checked outside the repository;
- **Decision** marks a business choice the owner has to make before the related phase starts.

---

## 1. Executive Summary

**The existing ordering engine can take AI phone orders with small, targeted changes. A second ordering system is not needed.** `createOrder()` in `lib/order-service.ts` is already a channel-aware, server-authoritative ordering service. It recalculates every price from the database, validates every modifier, enforces delivery radius, hours and closures, de-duplicates retries with an idempotency key, and writes the order, its items, payment row, audit event and notifications in one transaction. The counter till already reuses it for phone orders (`POST /api/admin/orders` with `channel: "phone"`). An AI receptionist should be a third caller of the same function, and should never write an order row itself.

**What already exists and should be reused:**

- the order engine (`quoteOrder` and `createOrder`);
- pricing (`priceCart`, `pricePizza`, `priceModifierSelections` in `lib/domain.ts`);
- delivery geocoding (`resolveDeliveryPoint` with Azure Maps, plus `validateDelivery`);
- the notification outbox and dispatcher, which already email, text and phone the restaurant and re-call until someone presses 1;
- the Twilio REST client and Twilio signature verification;
- the encrypted integration-secret store;
- the kitchen board and PassPRNT ticket printing;
- the order-presentation helpers that already turn an order into readable text.

**What is missing:**

1. **Inbound voice.** The application receives no inbound calls today. Twilio is used only *outbound*: it calls and texts the restaurant about new orders, and it sends giveaway SMS. There is no inbound voice webhook, no call routing and no transfer logic.
2. **A voice-facing layer between natural language and the order engine.** Today's clients (the website customizer and the till) send exact product, variation, topping and modifier IDs. A voice agent hears "large half pepperoni half chicken, well done". Something has to resolve that into IDs deterministically, keep a server-side working cart, and gate order placement on explicit confirmation. That layer is the bulk of the new work.
3. **No persistent WebSocket server.** The Pizza 62 application does not implement or test one. Azure App Service Linux supports WebSockets on our plan, and vinext's `startProdServer()` returns the underlying `node:http` server, to which an `upgrade` handler could be attached. Twilio ConversationRelay or an OpenAI Realtime bridge would therefore need additional application and runtime engineering and production testing:
   - a custom server entrypoint;
   - a WebSocket library;
   - per-call state held in the app process;
   - behaviour across deploys, slot swaps and restarts.

   They would not necessarily need a separate hosting service. Architectures where the voice vendor holds the live connection and calls *our* HTTPS tools (ElevenLabs Agents) need none of that, and keep our app stateless per request.

**Recommended stack (details in §17):**

- Twilio stays the telephony layer.
- The restaurant's existing number keeps ringing first. On no answer or busy, it forwards at the carrier to a dedicated Twilio number.
- That number's voice webhook points at **our** backend (`/api/voice/inbound`, new). The backend applies a kill switch, store hours and logging, then hands the call to an **ElevenLabs Agent** using ElevenLabs' *register-call* flow.
- The agent uses HTTPS server tools on our backend (`/api/voice/tools/*`, new). Those tools wrap `quoteOrder` and `createOrder` and hold the working cart in Postgres.
- Transfers and callback requests are performed by our backend through the Twilio REST API. The exact redirect behaviour is to be proven in a spike (§11.5).
- Failure handling has three parts:
  - if ElevenLabs is unavailable at call start, our webhook returns local fallback TwiML;
  - if our backend is unavailable, the number's Fallback URL (a Twilio-hosted TwiML Bin) answers instead;
  - **neither protects against a Twilio platform outage** (§11.4).

This choice favours reliability and debuggability, our top two priorities, over the marginal latency gains of speech-to-speech models.

**What to build first (§23):** Phase 1 changes no voice code. It hardens the shared order engine for a third channel:

- enforce the last-order cutoff on the server;
- extract a dry-run delivery-eligibility check;
- split the overloaded `staffEntry` flag into explicit policies;
- add an `ai_phone` channel;
- make restaurant alerts channel-aware.

Each of these is independently useful and testable with the existing `node:test` + Postgres suite.

---

## 2. Current Pizza 62 Architecture

| Layer | What it is | Where |
|---|---|---|
| Frontend | React 19.2, Next.js 16 App Router API surface, built and served by **vinext 0.0.50** (a Vite 8–based Next.js implementation) | `app/**`, `vite.config.ts`, `next.config.ts` (`output: "standalone"`) |
| Backend | Next-style route handlers (`app/api/**/route.ts`) over plain TypeScript domain modules | `app/api/**`, `lib/**` |
| Runtime | Node ≥ 22.13, started by `startup.sh`, which runs migrations, then `node server.js` | `package.json`, `startup.sh` |
| Database | Azure Database for PostgreSQL Flexible Server (B1ms), private VNet only | `infra/postgres.tf` |
| ORM / SQL | Drizzle for **schema and migrations only** (`db/schema.ts` → `drizzle/*.sql`). Runtime queries are raw SQL through a D1-compatible shim (`getD1().prepare().bind()`, `batch()` as one transaction) | `db/schema.ts`, `db/runtime.ts`, `db/pg-driver.ts`, `scripts/migrate.ts` |
| Auth | Staff only: password or PIN, an HttpOnly session cookie, role + permission checks (`requireStaff`, `hasPermission`). There are no customer accounts; the `customers` table exists but is unused | `lib/auth.ts`, `lib/domain.ts#hasPermission` |
| Public API protection | Postgres-backed per-IP rate limiting (`enforceRateLimit`) | `lib/security.ts` |
| Hosting | Azure App Service Linux P0v3, staging slot + swap, Key Vault references, App Insights → Log Analytics alerts, Terraform | `infra/*.tf`, `infra/README.md` |
| Deploy | Push to `main` → GitHub Actions (tests against real Postgres) → staging slot → `/api/health` → swap | `.github/workflows/*.yml` |
| Background work | No queue service. The `notification_outbox` table is the queue. Dispatch runs inline (`dispatchSoon()`) plus a Logic App calling `POST /api/cron/tick` every minute (`CRON_SECRET`) | `lib/notifications/dispatcher.ts`, `app/api/cron/tick/route.ts` |
| Webhooks in | Clover (`/api/payments/clover/webhook`); Twilio (`/api/notifications/voice/ack`, `/api/notifications/sms/inbound`, `/api/notifications/sms/status`) | `app/api/**` |
| Third parties | Clover (Hosted Checkout + iframe charge), Twilio (SMS, outbound voice), Resend or SendGrid (email), Azure Maps (geocoding), Azure Blob (uploads), GA4 / Meta / Google Ads tags, Star PassPRNT (Android printing) | `lib/clover.ts`, `lib/notifications/channels.ts`, `lib/delivery-area.ts`, `lib/blob-store.ts`, `lib/marketing.ts`, `lib/passprnt.ts` |
| Real-time UI | None. The kitchen board polls `/api/admin/dashboard` every 10 s (admin every 30 s) and beeps for unacknowledged orders | `app/staff/StaffPortal.tsx` |
| WebSockets | **The application implements no persistent WebSocket server**: no `upgrade` handler, no `ws` dependency. Azure App Service Linux supports WebSockets on paid plans (P0v3 qualifies). `infra/app_service.tf` does not set `websockets_enabled`, so read the effective value on both slots before any WebSocket work. `dist/standalone/server.js` calls vinext's `startProdServer()`, which returns the `node:http` server, so an `upgrade` handler could be attached in a custom entrypoint | `dist/standalone/server.js`, `node_modules/vinext/dist/server/prod-server.d.ts` |

### Configuration and secrets (names only, no values)

Credentials resolve through `lib/integration-secrets.ts`. It reads AES-256-GCM-encrypted rows in `integration_secrets` first, falls back to the environment (Key Vault references in Azure), and caches for 30 s. The keys in `INTEGRATION_SECRET_KEYS` are:

`CLOVER_MERCHANT_ID`, `CLOVER_API_TOKEN`, `CLOVER_PUBLIC_TOKEN`, `CLOVER_WEBHOOK_SECRET`, `CLOVER_ENVIRONMENT`, `CLOVER_IFRAME_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `RESTAURANT_ALERT_PHONE`, `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `CUSTOMER_SMS_ENABLED`, `MARKETING_SMS_ENABLED`, `VOICE_RETRY_LIMIT`, `VOICE_RETRY_MINUTES`, `PUBLIC_BASE_URL`, `CRON_SECRET`.

These are environment-only (`.env.example`, `infra/app_service.tf`): `DATABASE_URL`/`PG*`, `PGPOOL_MAX`, `AZURE_STORAGE_*`, `AZURE_MAPS_CLIENT_ID`/`AZURE_MAPS_SUBSCRIPTION_KEY`, `AZURE_CLIENT_ID`, `TRUST_PROXY_HEADERS`, `VINEXT_TRUST_PROXY`, `OWNER_SETUP_SECRET`, `SETTINGS_ENCRYPTION_KEY`, and the public marketing IDs.

Business settings (hours, ordering switches, delivery radius, fee and minimum, tax, estimates) live in the `settings` table, seeded from `lib/launch-config.ts#LAUNCH_SETTINGS` and editable in Admin → Settings.

### Architecture map

```
Customer browser ──► app/page.tsx (SSR menu via loadPublicCatalog)
   │                 app/customer/CustomerApp.tsx + app/menu/ItemCustomizer.tsx
   │  POST /api/orders/quote ─┐
   │  POST /api/orders ───────┤
Staff till (StaffOrderEntry)  │   POST /api/admin/orders {channel, quoteOnly}
   └──────────────────────────┴──► lib/order-service.ts  quoteOrder() / createOrder()
                                       │  lib/domain.ts (pricing, delivery, hours)
                                       │  lib/delivery-area.ts (Azure Maps)
                                       │  lib/clover.ts (online payment)
                                       ▼
                                 Postgres: orders, order_items, payments, order_events,
                                           notification_outbox, idempotency_keys, …
                                       │
            dispatchSoon() + Logic App ─► POST /api/cron/tick
                                       ▼
                    lib/notifications/dispatcher.ts ──► Resend/SendGrid (email)
                                                    └─► Twilio REST: Messages + Calls
                                                          │ (TwiML <Gather> "press 1")
                    /api/notifications/voice/ack ◄────────┘  sets orders.acknowledged_at
Kitchen tablet ──► /kitchen (StaffPortal, polls /api/admin/dashboard) ──► PassPRNT printer
```

---

## 3. Existing Order Flow

### 3.1 Website order, end to end

| Step | What happens | Code |
|---|---|---|
| Menu load | Server-renders the live menu. The browser refreshes it from `GET /api/catalog` (no-store) | `app/page.tsx`, `lib/public-catalog.ts#loadPublicCatalog`, `app/api/catalog/route.ts` |
| Categories / products | `categories`, `products` (+ `configuration_json`), `product_variations`, `toppings`, all `active = 1`. `staffOnly` products are filtered out of the public catalogue | `lib/public-catalog.ts` |
| Store status | Hours, closures and the 20-min last-order cutoff are computed in the browser with `storeStatus()` | `app/customer/CustomerApp.tsx` (~line 423), `lib/domain.ts#storeStatus` |
| Customize | Pizza customizer: size, cheese, crust, sauce, bake, toppings with whole/left/right placement, extras. Generic customizer for deals, wings and drinks: modifier sections | `app/menu/ItemCustomizer.tsx` (`PizzaCustomizer`, `GenericCustomizer`) |
| Cart | `BuiltItem[]` in React state, persisted to `localStorage` (`p62_cart_draft`) | `app/customer/CustomerApp.tsx` |
| Cart → API shape | `toOrderItems()` strips client prices and sends only IDs and choices | `app/menu/ItemCustomizer.tsx#toOrderItems` |
| Live pricing | Debounced `POST /api/orders/quote` → `quoteOrder()`. Read-only; reports every problem in `issues[]` | `app/menu/useServerQuote.ts`, `app/api/orders/quote/route.ts` |
| Checkout | `POST /api/orders` with `idempotencyKey` and `expectedAmountDueCents` (consent ceiling), rate-limited 12 per 15 min per IP | `app/customer/CustomerApp.tsx` (~line 1405), `app/api/orders/route.ts` |
| Validation | Contact details; ordering enabled or paused; fulfilment enabled; payment-method rules; address normalization; per-item `validateItems()`; coupon; delivery radius; closures; schedule; gift card; total-changed guard | `lib/order-service.ts#createOrder` |
| Pricing | Unit prices from DB rows → `priceCart()` for promotions, HST, delivery fee and tip | `lib/domain.ts#priceCart` |
| Taxes | `taxAndTips.taxRateBps` (1300 = 13% HST) on taxable food **and** the delivery fee (`delivery.feeTaxable`) | `lib/domain.ts#priceCart`, `lib/launch-config.ts` |
| Delivery info | `normalizeDeliveryAddress()` (Hamilton ON only, valid postal code) → `resolveDeliveryPoint()` → `validateDelivery()` (10 km straight line, $20 minimum) | `lib/order-service.ts`, `lib/delivery-area.ts`, `lib/domain.ts` |
| Payment | `pay_at_store` (pickup only for the public web). `online`: Clover iframe token charged inline (`createCloverCharge`) or Clover Hosted Checkout redirect (`createCloverCheckout`) confirmed by webhook | `lib/order-service.ts`, `lib/clover.ts`, `lib/payment-completion.ts`, `app/api/payments/clover/webhook/route.ts` |
| Database | One `batch()` transaction writes `orders`, `payments`, `order_events`, `order_items`, `notification_outbox` rows, promotion usage, gift-card hold or capture, and resolves `idempotency_keys` | `lib/order-service.ts#createOrder` |
| Order IDs | `orders.id` is a UUID. `order_number` is `P62-<n>` from `order_sequences` (`public_order`). Tracking and feedback tokens are stored only as hashes | `lib/order-service.ts` |
| Order status | `awaiting_payment` → `received` → `preparing` → `ready_for_pickup` / `out_for_delivery` → `completed`, or `cancelled`. Transitions are guarded by `canTransitionOrderStatus` | `db/schema.ts#ORDER_STATUSES`, `app/api/admin/actions/route.ts` |
| Restaurant notification | Outbox `restaurant_new_order` → email to `business.email`, SMS to `RESTAURANT_ALERT_PHONE`, phone call with "press 1". Re-calls until acknowledged | `lib/notifications/dispatcher.ts` |
| Kitchen | Board polls every 10 s, highlights unacknowledged orders, staff print with PassPRNT | `app/staff/StaffPortal.tsx`, `lib/passprnt.ts` |
| Customer notification | `customer_order_confirmation` email with tracking link (SMS only if `CUSTOMER_SMS_ENABLED`). `customer_status_update` on status changes. `feedback_request` after completion | `lib/notifications/dispatcher.ts`, `lib/notifications/messages.ts` |

### 3.2 Staff phone and counter order (the till) — the closest existing analogue

`app/staff/StaffOrderEntry.tsx` mounts the **same customizer** and posts to `POST /api/admin/orders` (`app/api/admin/orders/route.ts`):

- the body carries `channel: "phone" | "walk_in"`; `quoteOnly: true` prices without creating;
- the route requires a staff session with `manual_order_override`, then calls `createOrder(body, { channel, staffEntry: true, staffUserId })`;
- the till always sends `paymentMethod: "pay_at_store"`;
- with `staffEntry`, email is optional, a phone number is still required for delivery, pay-at-store is allowed for delivery (the driver collects), and `staffOnly` products are allowed;
- `walk_in` orders are auto-acknowledged and do not ring the restaurant; **`phone` orders still trigger the restaurant alert call**;
- the response includes a print-ready order (`loadOrderCore`) so Android prints immediately.

This is exactly the trusted-context pattern the AI receptionist needs. `CreateOrderContext` is a second argument that the public route can never set.

### 3.3 Which parts become the source of truth for phone orders

| Concern | Source of truth (reuse as-is) |
|---|---|
| Menu, prices, availability | `products`, `product_variations`, `toppings`, `promotions` tables + option lists in `lib/domain.ts` |
| Item validation and unit pricing | `lib/order-service.ts#validateItems` (private; reached through `quoteOrder` / `createOrder`) |
| Cart pricing, tax, fees, promotions | `lib/domain.ts#priceCart` via `quoteOrder` |
| Delivery eligibility | `lib/delivery-area.ts#resolveDeliveryPoint` + `lib/domain.ts#validateDelivery` |
| Hours, closures, pause | `settings.hours`, `store_closures`, `settings.ordering` via `quoteOrder` / `createOrder` (cutoff gap: §7) |
| Order creation and idempotency | `lib/order-service.ts#createOrder` |
| Restaurant notification | `notification_outbox` → `lib/notifications/dispatcher.ts` |
| Human-readable order text | `lib/order-presentation.ts`, `lib/notifications/order-details.ts` |

---

## 4. Existing Twilio Architecture

| # | Question | Finding |
|---|---|---|
| 1 | Where Twilio is initialized | No SDK. `lib/notifications/channels.ts#postToTwilio` makes raw `fetch` calls to `https://api.twilio.com/2010-04-01/Accounts/{sid}/{Messages\|Calls}.json` with HTTP Basic auth. Credentials come from `lib/notifications/config.ts#twilioConfig()` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) |
| 2 | Twilio APIs used | **Programmable Messaging** (`sendSms`) and **Programmable Voice** outbound calls (`placeAcknowledgementCall`) with **inline TwiML** (`<Say voice="alice" language="en-CA">`, `<Gather numDigits="1">`). No Studio, no Media Streams, no ConversationRelay, no SIP, no recordings |
| 3 | Endpoints Twilio calls | `POST /api/notifications/voice/ack?order=<id>` (Gather action; Digits=1 → `orders.acknowledged_at`). `POST /api/notifications/sms/inbound` (number's messaging webhook; STOP / START / HELP → `customer_contacts.sms_opt_out_at`). `POST /api/notifications/sms/status?id=<outbox id>` (delivery receipts, **giveaway SMS only**). All three verify `X-Twilio-Signature` with `verifyTwilioSignature()` (exported from the ack route) |
| 4 | What initiates outbound calls | `placeAcknowledgementCall()` from `dispatcher.ts#deliver`, case `restaurant_new_order`. Also the Admin → Integrations "Test call" (`app/api/admin/integrations/route.ts`) |
| 5 | What happens when an online order is placed | `createOrder` inserts an outbox row `restaurant_new_order`. For pay-at-store orders it is `pending` immediately; for online orders it is `waiting_payment`, released by `applyPaymentApproved()`. `dispatchSoon()` then delivers the alert: email + SMS + call |
| 6 | How the store is called | `TWILIO_FROM_NUMBER` calls `RESTAURANT_ALERT_PHONE`. TwiML reads `renderRestaurantNewOrder().voiceSay` ("New order from the Pizza 62 website. Pickup order, number 1234, 3 items…") and asks for 1. `requeueUnacknowledgedOrders()` (cron) re-queues every `VOICE_RETRY_MINUTES` (default 2), up to `VOICE_RETRY_LIMIT` (default 3), within 6 h, while `acknowledged_at IS NULL`. The kitchen-board Acknowledge button writes the same field |
| 7 | Inbound calls | **Not handled.** No route returns TwiML for an incoming call. What currently happens when someone dials the Twilio number depends on its console configuration: **UNKNOWN** |
| 8 | Number ownership | The app holds a Twilio account's credentials and one sending number, described as "an unregistered local Canadian long code" (`lib/notifications/config.ts`, `GOING_LIVE.md` §5, `infra/variables.tf#twilio_from_number`). The public restaurant number **(905) 547-5777** (`LAUNCH_SETTINGS.business.phone`) shows no sign of being on Twilio, so it is presumably a carrier line: **UNKNOWN**. Whether `RESTAURANT_ALERT_PHONE` equals the public number: **UNKNOWN** |
| 9 | Failures, no-answer, busy, status callbacks | Outbound calls set **no `StatusCallback`**, so busy, no-answer and failed outcomes are never observed. A REST 429 or 5xx is retryable (`ChannelError`, backoff 1→32 min, max 6 attempts); other 4xx fail permanently. Re-calls are driven only by "still unacknowledged". **Side effect:** each re-call re-runs the whole `restaurant_new_order` case, so the restaurant also gets the email and SMS again every 2 minutes |
| 10 | Reusable SMS | Yes. `sendSms({to, body, statusCallback?})`. The restaurant already gets an SMS per order. **Customer** SMS is off by default (`CUSTOMER_SMS_ENABLED`) because Canadian carriers silently filter A2P traffic from unregistered long codes. Marketing SMS has its own switch (`MARKETING_SMS_ENABLED`) |

Other Twilio-related details:

- **Canonical host.** `middleware.ts` 308-redirects non-canonical hosts. Twilio signs the exact URL it calls, so every Twilio webhook must use the canonical `PUBLIC_BASE_URL` host. Infra already sets `VINEXT_TRUST_PROXY=1` so `request.url` keeps `https`.
- **Wording.** `renderRestaurantNewOrder()` labels channels in the email (`WEBSITE` / `PHONE` / `WALK IN`), but `voiceSay` always says "New order from the Pizza 62 website", even for till phone orders.

---

## 5. Menu and Cart Data Model

### 5.1 Where the menu comes from

The **database is authoritative at runtime**:

- tables `categories`, `products`, `product_variations`, `toppings`, `promotions` (`db/schema.ts`);
- seeded from `lib/menu.ts` (`MENU_CATEGORIES`, `TOPPING_SEEDS`, `MENU_PRODUCTS`, `MENU_SEED_VERSION = "2026-10-06-sauces-extras-breadsticks"`) and `lib/launch-config.ts#PIZZA_SIZES` by `scripts/migrate.ts` and `lib/ordering-release.ts`;
- edited by the owner in Admin → Menu setup.

Some **option vocabularies are code constants** in `lib/domain.ts`, resolved live on both client and server:

- `DRINK_OPTIONS` (15 cans), `TWO_LITRE_DRINK_OPTIONS`;
- `WING_FLAVOURS`;
- `SAUCE_OPTIONS` + `SAUCE_PRICES_CENTS`;
- `PIZZA_EXTRA_OPTIONS` + `PIZZA_EXTRA_PRICES_CENTS`;
- `CRUST_OPTIONS`, `BAKE_SAUCE_OPTIONS`, `CHEESE_OPTIONS`.

There is no CMS and no third-party menu service.

### 5.2 Model

```
categories(id, name, slug, display_order, active)
products(id, category_id, name, product_type ∈ {pizza, simple, bundle, configurable},
         base_price_cents, taxable, pickup_eligible, delivery_eligible, promotion_eligible,
         active, sold_out, setup_required, configuration_json, display_order)
product_variations(id, product_id, name, base_price_cents,
                   extra_topping_price_cents, included_topping_units_bps, active)
toppings(id, name, kitchen_label, is_meat, active)
promotions(id, name, code, type ∈ {percentage, fixed, free_delivery}, amount, priority,
           combinable, exclusive, stack_group, rule_json{productIds, categoryIds},
           min_subtotal_cents, fulfilment, usage_limit, usage_count, starts_at, ends_at)
```

`configuration_json` keys used by validation:

| Key | Meaning |
|---|---|
| `sections[]` | `ModifierSection`: `id, label, group, source, options, min, max, included, extraPriceCents, optionPrices, sharedGroup, sharedIncluded` |
| `fixedRecipe`, `recipeToppingIds`, `presetExtraCheese` | Specialty-pizza recipes |
| `crustOptions`, `bakeSauceOptions`, `sauceEnabled`, `includedSauce`, `extrasEnabled`, `cheeseEnabled` | Pizza option groups |
| `requireIncludedToppings` | Pizza must use its full included allowance |
| `freeDelivery` | Item waives the delivery fee |
| `availability` | `{weekdays, startMinute, endMinute, timeZone, startDate?, endDate?, label}` |
| `staffOnly`, `dailySpecial`, `featured` | Visibility and merchandising |
| `maxQuantity`, `quantitySelectable`, `unitLabel` | Quantity rules |
| `specialInstructionsEnabled` | Item accepts a note |

### 5.3 Concept by concept

| Concept | How it is represented | Clean? |
|---|---|---|
| Pizza sizes | `product_variations` rows. Specialty pizzas have Medium / Large / X-Large variations. **Build-your-own pizzas are separate products per size *and per fulfilment*:** delivery uses `{medium,large,x-large,jumbo,slab}-pizza` (one variation `…-four-toppings`, up to 4 toppings, delivery only); pickup uses `pickup-{size}-{one,three}` (1 or 3 required toppings, pickup only) | ⚠ Same spoken item, different product per fulfilment |
| Topping limits | `included_topping_units_bps` (10 000 = 1 topping) on the variation; `section.included` / `max` (max 12) in deals; `requireIncludedToppings` forces the minimum | ✅ |
| Included toppings | As above. Recipe toppings are reserved via `recipeToppingIds` | ✅ |
| Additional topping pricing | `extra_topping_price_cents` per variation, or `extraPriceCents` per section. Medium $2.10, Large $2.30, XL $2.60, Jumbo/Slab $2.90 | ✅ |
| Premium toppings | No per-topping price. Only `real-chicken` counts double (`toppingWeight()`). Non-tomato sauces $1.49; olive oil and homemade seasoning $1.29 | ✅ (by design) |
| Whole / left / right toppings | `ToppingSelection {toppingId, placement: "whole" \| "left" \| "right"}`. A half counts `operations.halfToppingUnitsBps` (5 000 = ½). Left + right of the same topping normalizes to whole (`normalizeToppings`) | ✅ (README's "placement goes in special instructions" is outdated; the customizer and server both support halves) |
| Cheese amount | Standalone pizzas: `extraCheese: boolean` (priced as one topping unit). **"Light" or "No cheese" is stored as a free-text prefix in `specialInstructions` ("Light Cheese · …")** (`ItemCustomizer.tsx` ~line 323). Inside deals: a real `cheese` section (`CHEESE_OPTIONS`) | ⚠ Free-text convention for pizzas |
| Sauce | `sauce` section (`SAUCE_OPTIONS`; tomato free, others $1.49; `includedSauce` free on signature pizzas). "Easy on the Sauce" and "Extra Sauce" live in the `bake_sauce` section | ✅ |
| Crust | `crust` section (`CRUST_OPTIONS`: Regular / Thin / Thick) | ✅ |
| Bake | `bake_sauce` section (Lightly Done / Well Done / …, max 2) | ✅ |
| Wing quantity | One product per size (`1-lb-wings`, `24-wings` … `60-wings`; `12-wings` staff-only), times `quantity` | ✅ |
| Wing flavours | `wing_flavours` section, `max` 1 or 2 (a set, no duplicates). **No proportion** ("half medium, half honey garlic" equals choosing both) | ⚠ Split ratio implicit |
| Wing style | `wing-style` section: Classic (non-breaded) / Breaded | ✅ |
| Dipping sauces | `standard-dip` "Dipping Sauce" is a **simple product with no flavour choice**. Combo `included-dip` has one option, "Dipping Sauce" | ❌ Dip flavour not modelled |
| Beverages | `drinks` sections, one per included can (`drink-1…n`); products `one-pop`, `four-pops`, `water-bottle`; 2 L uses `two_litre_drinks` | ✅ |
| Combos / deals | `product_type: "bundle"` with grouped sections ("Pizza 1", "Pizza 2", "Included with your combo"). Shared topping pools use `sharedGroup` / `sharedIncluded` (e.g. `pickup-two-large-six`) | ✅ (rich but complex) |
| Substitutions | `omitToppings[]` (must be recipe toppings; no price reduction). Swaps = omit + add as extra | ✅ |
| Add-ons | Sauce and extras sections; side products | ✅ |
| Sold-out | `products.sold_out`, `products.active`, `toppings.active`. **Option-list values (a drink flavour, a wing sauce) cannot be marked sold out without a code change** | ⚠ |
| Special instructions | Per item `specialInstructions` (≤ 500 chars). Order-level `orders.instructions` is filled from `address.instructions`, so a pickup order note only works by sending `address.instructions` without an address | ⚠ Quirk |
| Time-limited items | `availability` re-checked server-side (`isWithinWeeklyAvailability`) | ✅ |
| Automatic promotions | `promotions` rows without `code` apply automatically. Coded ones need `couponCode` | ✅ |
| Allergens | Not represented anywhere | ❌ |

### 5.4 Can the cart represent complicated phone orders?

**Yes, for almost everything a caller will say**:

- multiple pizzas;
- different sizes;
- halves;
- extra and removed toppings;
- crust, sauce and bake preferences;
- multi-pizza deals with per-pizza options;
- two-flavour wings;
- per-can drink choices;
- notes.

The gaps are dip flavour, explicit wing split ratios, light or no cheese on standalone pizzas (free text), and allergens (§7).

---

## 6. Relevant Code Map

| Area | File | Key symbols |
|---|---|---|
| Order engine | `lib/order-service.ts` | `OrderRequest`, `CreateOrderContext`, `quoteOrder`, `createOrder`, `validateItems` (private), `validateModifiers` (private), `validateSchedule` (private), `normalizeCustomer` (private), `normalizeDeliveryAddress` (private), `OrderValidationError`, `OrderQuote`, `QuoteIssue` |
| Pricing and rules | `lib/domain.ts` | `priceCart`, `pricePizza`, `priceModifierSelections`, `normalizeToppings`, `toppingWeight`, `applyPromotions`, `explainPromotionMiss`, `validateDelivery`, `haversineKm`, `storeStatus`, `nextOrderSlots`, `isWithinWeeklyAvailability`, option lists, `hasPermission`, `generateOpaqueToken`, `hashOpaqueToken` |
| Menu seed | `lib/menu.ts`, `lib/launch-config.ts` | `MENU_PRODUCTS`, `TOPPING_SEEDS`, `PIZZA_SIZES`, `LAUNCH_SETTINGS`, `REGULAR_HOURS` |
| Public catalogue | `lib/public-catalog.ts` | `loadPublicCatalog`, `publicSettings` |
| Specials | `lib/daily-specials.ts`, `lib/upsells.ts` | `todaysSpecials`, `recommendUpsells` |
| Delivery | `lib/delivery-area.ts` | `resolveDeliveryPoint`, `resolveFsaCentroid` |
| Closures | `lib/closures.ts` | `loadActiveClosures`, `closureFor`, `closureMessage` |
| Routes | `app/api/orders/route.ts`, `app/api/orders/quote/route.ts`, `app/api/admin/orders/route.ts`, `app/api/orders/track/route.ts`, `app/api/catalog/route.ts` | `POST`, `GET` |
| Notifications | `lib/notifications/{config,channels,dispatcher,messages,order-details,email-template}.ts` | `twilioConfig`, `restaurantAlertNumber`, `sendSms`, `placeAcknowledgementCall`, `acknowledgementTwiml`, `escapeXml`, `dispatchOutbox`, `dispatchSoon`, `requeueUnacknowledgedOrders`, `renderRestaurantNewOrder` |
| Twilio webhooks | `app/api/notifications/voice/ack/route.ts`, `…/sms/inbound/route.ts`, `…/sms/status/route.ts` | `verifyTwilioSignature`, `twilioSignature` |
| Presentation | `lib/order-presentation.ts`, `lib/order-detail.ts` | `snapshotDetails`, `summariseItems`, `totalRows`, `loadOrderCore`, `loadOrderDetail` |
| Payments | `lib/clover.ts`, `lib/payment-completion.ts`, `scripts/reap-payments.ts` | `createCloverCheckout`, `createCloverCharge`, `applyPaymentApproved`, `reapStalePayments` |
| Security | `lib/security.ts`, `lib/auth.ts`, `lib/integration-secrets.ts` | `enforceRateLimit` (IP-keyed), `requireStaff`, `readIntegrationSecret`, `INTEGRATION_SECRET_KEYS` |
| Cron | `app/api/cron/tick/route.ts` | outbox, payments reaper, unacknowledged re-call, giveaway sweep |
| Staff UI | `app/staff/StaffPortal.tsx`, `app/staff/StaffOrderEntry.tsx`, `app/staff/OrderDetail.tsx` | kitchen board, till, `CHANNEL_LABELS` |
| Customers | `app/api/admin/customers/route.ts`, `lib/customer-contacts.ts` | directory derived from `orders` by email or phone digits; `normalizePhone`, `toE164`, `canonicalPhone10` |
| Logging | `lib/log.ts` | `logFailure` (stdout → App Insights / Log Analytics) |
| Schema | `db/schema.ts` | `orders`, `order_items`, `payments`, `order_events`, `notification_outbox`, `idempotency_keys`, `rate_limits`, `audit_log`, `customer_contacts`, `ORDER_CHANNELS` |
| Tests | `tests/order-create.test.ts`, `tests/order-quote.test.ts`, `tests/staff-orders.test.ts`, `tests/notifications.test.ts`, `tests/ordering-pricing.test.ts`, `tests/delivery-area.test.ts`, … | `node:test` against real Postgres |

---

## 7. Gaps / Risks Found

### Ordering-engine gaps that matter for AI orders

1. **The last-order cutoff is enforced only in the browser.** `ordering.lastOrderCutoffMinutes` (20) is applied only by `CustomerApp.tsx`; `AdminControls.tsx` merely edits it, and nothing on the server reads it. `createOrder` → `validateSchedule()` checks ASAP orders against *now* inside opening hours, not "now + prep time" or the cutoff. An API caller (and therefore an AI tool) could place an ASAP order at 21:59 for a 22:00 close. **This must be fixed server-side before any non-browser channel takes orders.**
2. **There is no dry-run delivery check.** The radius and geocode check runs only inside `createOrder`, and `quoteOrder` checks the minimum but not the address. A voice agent must be able to say "yes, we deliver there" *before* building the cart.
3. **Delivery city must literally be "Hamilton".** `normalizeDeliveryAddress` rejects "Stoney Creek", "Dundas", "Ancaster" and "Hamilton Mountain" spellings, even though those are in the city and possibly within the radius. Radius is straight-line from `business.latitude/longitude`.
4. **Build-your-own pizzas are different products for pickup and delivery** (`large-pizza` vs `pickup-large-one/three`). "Actually make that delivery" means re-mapping products and toppings, not flipping a flag. `validateItems` rejects pickup-only products on delivery.
5. **`staffEntry` conflates four policies:** relaxed contact rules, staff-only items, pay-at-store for delivery, and no attribution. An AI channel needs some of these, not all.
6. **Cheese level is free text on standalone pizzas** ("Light Cheese · " prefix in `specialInstructions`). This is unvalidated and the kitchen reads it as a note.
7. **Dip flavour and wing split ratio are not modelled.**
8. **Option values (a drink flavour, a wing sauce) cannot be sold out without a deploy.**
9. **No allergen data.** The AI must never claim something is allergen-safe.
10. **Order-level notes for pickup** ride on `address.instructions`. This works, but is a quirk worth formalizing.

### Notification and telephony gaps

11. **No inbound voice handling at all.** The behaviour of the existing Twilio number on inbound calls is UNKNOWN.
12. **Outbound call outcomes are not observed** (no `StatusCallback`), so the app cannot tell busy, no-answer or failed apart.
13. **Re-call duplicates the email and SMS** every cycle (`dispatcher.ts`, `restaurant_new_order` re-runs entirely).
14. **The restaurant alert's spoken text always says "website".**
15. **Customer SMS is unreliable** on the current unregistered local long code. This blocks SMS order confirmations and SMS payment links until a registered or verified sender exists.
16. **Twilio webhooks must use the canonical host** or the middleware redirect breaks signatures.

### Platform gaps

17. **No persistent WebSocket server is implemented or tested** in the app. The platform supports one; the app does not have one. Adding one means:
    - a custom server entrypoint replacing the generated `server.js` in the release assembly step;
    - a new WebSocket dependency;
    - per-call state living in a single process, where any deploy, slot swap or restart can drop live calls.

    This is not needed for the recommended stack.
18. **The rate limiter is IP-keyed.** All tool calls from a voice vendor arrive from shared vendor IPs, so a per-call key is needed.
19. **No customer accounts.** Caller history must be derived from `orders` by phone digits. **Caller ID can be spoofed**, so reading back a stored address to whoever presents a number is a privacy leak.
20. **Website orders are printed manually** (Print ticket). Only till orders auto-print. AI orders will behave like website orders unless that changes.

### Biggest delivery risks for this project

- Mis-resolution of spoken items to the wrong product. The pickup and delivery pizza split, deals with 20+ sections, and similar names make this the highest correctness risk.
- An order placed without genuine customer confirmation.
- Call-routing loops: transferring to the main number, which forwards back to the AI.
- Store phone or carrier forwarding behaviour (caller ID, ring count) not supporting the design. UNKNOWN until tested.
- Concurrency limits of the voice vendor plan during the Friday rush.
- Privacy and consent obligations for recording and transcripts (PIPEDA notice; vendor data residency).

---

## 8. Proposed AI Receptionist Architecture

```
                         ┌───────────── Pizza 62 public number (carrier line) ─────────────┐
 Caller ── dials ───────►│ rings in store; on NO-ANSWER (N rings) or BUSY → carrier forward  │
                         └───────────────────────────────┬──────────────────────────────────┘
                                                         ▼
                                        Twilio number "AI line" (new)
                                Voice URL → POST /api/voice/inbound (ours)
                              Fallback URL → TwiML Bin (Twilio-hosted, static)
                                                         │
             ┌─── kill switch / hours / loop guard / log (voice_calls row) ───┐
             │                                                                 │
             ▼ mode=off or vendor error                                        ▼ mode=on
   <Say> + <Dial> backup number or                     ElevenLabs register-call → TwiML
   <Record> message + SMS restaurant                   <Connect><Stream> to ElevenLabs Agent
                                                         │
                         ElevenLabs Agent (STT + LLM + TTS, barge-in)
                                                         │ HTTPS server tools
                                                         │ (bearer + per-call secret token)
                                                         ▼
                           /api/voice/tools/* (ours) ── lib/voice/*  (new)
                             │  menu resolver · voice cart session · confirmation gate
                             ▼
                  lib/order-service.ts  quoteOrder() / createOrder(ctx: ai_phone)
                             │
              orders + notification_outbox  ──► existing dispatcher
                                                  email + SMS "AI PHONE ORDER" + call w/ press 1
                                                  kitchen board + PassPRNT
   transfer_to_store tool ─► Twilio REST: update live call → <Dial> store line (action → result)
   post-call webhook ◄── ElevenLabs (HMAC) → transcript, summary → voice_calls
```

Principles:

- **The model interprets; the backend decides.** The LLM turns speech into tool calls. Every product, option, price, tax, fee, eligibility, hour and order write is decided in our code.
- **One ordering engine.** `createOrder` is called directly as a library function, not through `/api/orders`, with a trusted context. Nothing writes `orders` except `createOrder`.
- **A server-side working cart.** The cart lives in Postgres, keyed to the call, with a version number. Every mutation re-quotes. Confirmation is bound to a version.
- **Our backend owns the call path.** The kill switch, logging, fallback and transfer are ours. The vendor can be swapped without touching ordering.
- **Fail closed toward a human.** Any doubt leads to transfer or a callback request, never a guessed order.

---

## 9. Proposed Voice Ordering API

All tools are `POST /api/voice/tools/<name>` with JSON in and JSON out. Each response carries `ok`, the data, an optional `say` hint (a server-authored sentence the agent may read), and `issues[]` reusing `QuoteIssue {code, message}`.

**Authentication on every tool call (§12.5):**

- `Authorization: Bearer <VOICE_TOOL_SECRET>`;
- `X-Voice-Session: <per-call token>`, delivered as an ElevenLabs `secret__` dynamic variable, so the LLM never sees it.

| Tool | Purpose | Inputs | Outputs | Reuses | New code? | Validation | Failure cases |
|---|---|---|---|---|---|---|---|
| `get_store_status` | Open now? Taking orders? Pickup and delivery on? Closures, hours, estimates | — | `{open, acceptingUntil, closesAt, nextOpenAt, pickupEnabled, deliveryEnabled, paused, closureMessage, pickupEstimateMinutes, deliveryEstimateMinutes, hoursToday}` | `storeStatus`, `loadActiveClosures`, `getSetting("ordering"/"hours")` | Thin wrapper | Server time in America/Toronto; includes the cutoff | Settings unreadable → `ok:false` → agent offers callback |
| `search_menu` | Resolve spoken words to menu candidates | `{query, fulfilment?, category?}` | `[{productId, name, category, sizes:[{variationId,name,priceCents}], priceCents, confidence, pickupOnly, deliveryOnly}]` (top 5) | `loadPublicCatalog` | **Yes**: deterministic matcher + alias table ("XL" → X-Large, "pep" → pepperoni, "honey garlic", "slab", "panzo") | Public catalogue only (no `staffOnly`); respects `availability`, `sold_out` | No match → `issues:[NO_MATCH]` → agent asks again or reads the category list |
| `get_menu_item` | Everything needed to configure one item, in speakable form | `{productId, fulfilment}` | Sizes, included toppings, recipe, extra-topping price, sections `{id,label,min,max,options,optionPrices}`, notes allowed | `loadPublicCatalog`, `pizzaOptionSections` logic, `orderModifierSections` | Yes: a "voice schema" projection | Same data `validateItems` checks | Unknown or unavailable product |
| `get_deals` | "What deals do you have?" | `{fulfilment?}` | Live bundles and specials (`deals`, `combos`, `two-for-one`, `pickup-specials`, `hamilton-heroes`, today's `dailySpecial`), automatic promotions, plain-language descriptions | `loadPublicCatalog`, `todaysSpecials`, `promotions` | Wrapper | `availability` window now; fulfilment eligibility | — |
| `start_order` | Create or reset the voice cart for this call | `{fulfilment?}` | `{cartVersion, cart, quote}` | — | Yes (`voice_calls.cart_json`) | One active cart per call | — |
| `add_item` | Add one configured line | `{productId, variationId?, quantity, toppings[{toppingId,placement}], omitToppings[], extraCheese?, modifiers[{id,values}], notes?}` | `{cartVersion, lineId, line, quote, issues}` | `quoteOrder` (runs `validateItems`) | Yes (session + per-line validation) | Full `validateItems` via quote; line-level issues returned with index | Invalid option → `issues` with the exact section label and allowed values so the agent can ask |
| `update_item` | Change size, toppings, halves, quantity, options | `{lineId, patch}` | Same as `add_item` | `quoteOrder` | Yes | Same; version bump | Stale `cartVersion` → `409 CART_CHANGED` |
| `remove_item` | Remove a line | `{lineId}` | `{cartVersion, quote}` | `quoteOrder` | Yes | — | — |
| `set_fulfilment` | Pickup ↔ delivery | `{fulfilment}` | `{cartVersion, quote, remapped[], blocked[]}` | `quoteOrder` | **Yes**: remap build-your-own pizza products between `pickup-*` and `*-pizza` where an equivalent exists; otherwise report blocked lines | Eligibility per product | Item not available for the new fulfilment → agent explains and offers alternatives |
| `check_delivery_address` | Is this address deliverable, and what does it cost? | `{sessionId, line1, unit?, city?, postalCode}`, address fields only. **Never** a subtotal or `freeDelivery`: the server derives both from the session's validated cart (subtotal 0 before there is one) | `{addressDeliverable, eligible, reason ∈ {eligible, outside_radius, address_unverified, below_minimum, …}, normalized, feeCents, minimumCents, shortfallCents, distanceKm (internal only)}`. The agent says "we deliver there" only on `addressDeliverable: true` and never infers it from `reason` | `checkDeliveryEligibility` (built in Phase 1B) | Done in Phase 1B: `checkDeliveryEligibility()`, which `createOrder` now calls | Server-side geocode; city normalization (accept Hamilton-area community names → "Hamilton") | Maps down → FSA fallback (existing behaviour); unverified → ask to repeat or spell, then transfer |
| `set_customer` | Name, callback phone, optional email | `{name, phone?}` | `{customer}` | `normalizeCustomer` rules | Small | Name 2–100 chars; phone defaults to the caller ID **only when `caller_id_status = presented`** (§11.6), and the agent reads it back for confirmation | Withheld, forwarded-as-store or unknown caller ID → must collect a phone number (required for delivery) |
| `lookup_caller` | Recognise a returning caller | — (uses the call's caller ID server-side) | `{known, firstName, lastOrderSummary, lastOrderAt, hasSavedDeliveryAddress, addressHint: "street ending …"}` | `orders` by phone digits (`canonicalPhone10`), `customer_contacts` | Yes | **Never return a full address.** The address is only used after the caller states the street number and the server matches it (`confirm_saved_address`) | Spoofed or withheld ID → treat as unknown |
| `reorder_last` | "The usual" | `{orderNumber?}` (defaults to the caller's most recent) | Cart replaced with the last order's lines (re-validated at today's prices) + `issues` for items no longer available | `order_items.snapshot_json` → `OrderRequest.items` | Yes | Re-runs `quoteOrder`; price is today's, not then | Product retired → reported per line |
| `review_order` | Server-authored read-back | `{cartVersion}` | `{readback: "…", totals, amountDueCents, etaText, quoteOk, blockingIssues}` | `quoteOrder`, `lib/order-presentation.ts` (`snapshotDetails`, `summariseItems`, `totalRows`) | Yes | Fails if `quote.ok === false` or required fields are missing | Blocking issues → agent resolves them first |
| `confirm_order` | Record the caller's explicit "yes" | `{cartVersion, customerUtterance}` | `{confirmedVersion, confirmedAt}` | — | Yes | Must follow `review_order` **at the same version**; logs the utterance | Version mismatch → `409` → re-review |
| `place_order` | Create the real order | `{cartVersion}` | `{orderNumber, estimateAt, etaText, amountDueCents, duplicate}` | **`createOrder(body, {channel: "ai_phone", policy: "voice", …})`** | Wrapper + new context | Requires `confirmed_version == cart_version`, confirmation < 5 min old, `quote.ok`; sends `expectedAmountDueCents = confirmed amount`; idempotency key = `voice:<voiceCallId>:<cartVersion>` | `TOTAL_CHANGED` / `STORE_CLOSED` / `DELIVERY_ADDRESS_INELIGIBLE` → re-review; timeout → retry with the same key returns `duplicate:true` and the same order number |
| `get_order_status` | "Where's my order?" | `{orderNumber?}` | `{status, etaText}` (no PII) | `orders` lookup | Yes | Only orders whose `customer_phone` matches the presented caller ID (`caller_id_status = presented`; never "verified", because caller ID can be spoofed), last 24 h, status and ETA only | No match → transfer |
| `transfer_to_store` | Hand the caller to a human | `{reason, summary}` | `{transferring:true}` (the call leaves the agent) | Twilio REST `POST /Calls/{CallSid}.json` with new TwiML | Yes (`lib/voice/twilio-voice.ts`) | Allowed reasons enum; loop guard; store must be within hours | Transfer not answered → `/api/voice/transfer-result` → callback request + apology |
| `request_callback` | Leave a message when transfer is impossible or the caller prefers it | `{reason, summary, callbackPhone?}` | `{queued:true}` | Outbox + `sendSms` + email to `business.email` | Yes (new outbox kind `voice_callback_request`) | Rate-limited per call | Twilio down → outbox retries (existing backoff) |
| *(post-call)* `POST /api/voice/events` | ElevenLabs post-call webhook: transcript, summary, data collection | ElevenLabs payload | `200` | — | Yes | HMAC-SHA256 signature + timestamp tolerance | Redelivery → idempotent upsert by conversation ID |

**Deliberately not tools:**

- arbitrary price calculation;
- setting a discount;
- free-text "add anything";
- choosing payment by card;
- changing an order after placement (that goes to a transfer);
- cancelling an order (transfer).

---

## 10. Conversation State Machine

The server tracks `voice_calls.stage` and refuses tool calls that are illegal for the stage. The prompt describes the same flow, but **the server enforces it**.

```mermaid
stateDiagram-v2
    [*] --> GREETING
    GREETING --> CLOSED_MODE: store not accepting orders
    GREETING --> INTENT
    INTENT --> TRANSFER: complaint / refund / manager / catering / allergy
    INTENT --> INFO: hours, menu, prices, deals, order status
    INFO --> INTENT
    INTENT --> FULFILMENT: wants to order
    FULFILMENT --> IDENTIFY
    IDENTIFY --> BUILD_CART
    BUILD_CART --> BUILD_CART: add / update / remove / clarify
    BUILD_CART --> ADDRESS: delivery & address not yet eligible
    ADDRESS --> BUILD_CART
    BUILD_CART --> REVIEW: caller is done
    REVIEW --> BUILD_CART: correction (version++ invalidates review)
    REVIEW --> CONFIRMED: explicit yes at same cartVersion
    CONFIRMED --> PLACED: place_order ok
    CONFIRMED --> REVIEW: TOTAL_CHANGED / STORE_CLOSED / address refused
    PLACED --> WRAP_UP: read order number + ETA + "pay at pickup"
    WRAP_UP --> [*]
    CLOSED_MODE --> [*]: hours + website + optional message
    TRANSFER --> [*]
```

| Stage | Server guard |
|---|---|
| `IDENTIFY` | Caller ID is captured server-side from the call, never from the LLM |
| `BUILD_CART` | Every mutation returns a fresh `quoteOrder` result. The agent must resolve `issues` before `REVIEW` |
| `ADDRESS` | `place_order` refuses delivery unless `check_delivery_address` returned `eligible` for the address currently in the cart |
| `REVIEW` | Only `review_order` can move here; it requires `quote.ok` |
| `CONFIRMED` | Only `confirm_order` with the reviewed `cartVersion`. Any later mutation drops back to `BUILD_CART` |
| `PLACED` | Further mutation is refused; changes go through `transfer_to_store` |

### Corrections, mapped to tools

| Caller says | Agent does | Backend effect |
|---|---|---|
| "Actually make that XL." | `update_item {lineId, patch:{variationId: …-x-large}}` (or product remap for build-your-own) | Re-prices extra toppings at the XL rate; returns the new line price |
| "Remove the mushrooms." | `update_item` removing `mushrooms` from `toppings`, or adding it to `omitToppings` if it is a recipe topping | Recipe pizza: price unchanged, ticket prints NO MUSHROOMS |
| "Make half pepperoni and half chicken." | `update_item {toppings:[{pepperoni,left},{real-chicken,right}]}` | Units 0.5 + 1.0 (chicken is weighted). `requireIncludedToppings` may raise `TOPPINGS_INCOMPLETE`, and the agent asks for another topping or confirms the extra charge |
| "Three pounds of wings, half medium and half honey garlic." | `search_menu` finds no plain "3 lb" product (sizes are 1 lb, 24 … 60 wings). Agent offers 30 wings with two flavours, **or** 3 × 1 lb lines | Decision for the owner: what "3 lb" means outside combos (§22) |
| "Use my previous address." | `lookup_caller` → agent asks "what's the street number?" → `confirm_saved_address {streetNumber}` → server matches → `check_delivery_address` | Full address is never spoken first by the agent |
| "Actually make that pickup." | `set_fulfilment {pickup}` | Remaps delivery-only pizzas to pickup equivalents, removes the fee, re-quotes; reports anything that cannot move |
| "What deals do you have?" | `get_deals {fulfilment}` | Today's live list only |
| "How much would that cost?" | Read `quote.totals` from the last mutation, or `review_order` | Always the server number, formatted by the server |
| "Can I get two different sauces?" | Wings: `wing_flavours` max 2 → allowed on 24+ wings and in combos, not on 1 lb. Dip: not modelled → note or transfer | `Choose valid options for Sauces & dry rubs` issue explains the limit |
| "The usual." | `reorder_last` | Today's prices; reports retired items |

---

## 11. Call Routing Architecture

### 11.1 Recommended routing (Phase 4–7): carrier forwarding + our webhook first

1. **The store gets first chance.** At the carrier, enable *call forward no answer* (CFNA, ring count N) and *call forward busy* (CFB) on the public number to the new Twilio AI-line number. This is a carrier setting, not code. Ring duration and availability: UNKNOWN (carrier dependent).
2. The Twilio number's **Voice URL** points to `POST /api/voice/inbound`. That handler:
   - verifies the Twilio signature (reuse `verifyTwilioSignature`, moved to `lib/`);
   - creates a `voice_calls` row (CallSid, From, To, `ForwardedFrom` if the carrier sends it). The CallSid is stored here, from Twilio's signed request, and is never taken from the LLM;
   - classifies `caller_id_status ∈ {presented, forwarded_as_store, withheld, unknown}` (§11.6);
   - **loop guard**: if this call or caller has a transfer in progress in the last 120 s, does not enter the AI; plays a message instead. The guard keys on the `voice_calls` session, and on caller ID only when `caller_id_status = presented`;
   - **kill switch** `VOICE_AI_MODE ∈ {off, internal, pilot, live}`. In `internal`, only allow-listed staff numbers reach the AI;
   - store status: if not accepting orders, the agent starts in **closed mode** (information and message only);
   - calls ElevenLabs *register-call* (`agent_id`, `from_number`, `to_number`, `conversation_initiation_client_data.dynamic_variables` including `secret__voice_session`, `call_sid`, `mode`, `store_open`) with a ~3 s timeout;
   - returns the TwiML it receives, with one addition: a `<Redirect method="POST">{base}/api/voice/after-agent?vc={id}</Redirect>` appended after ElevenLabs' `<Connect>`. Twilio documents that after a `<Connect><Stream>` socket closes, it "executes the remaining TwiML instructions". This gives us a documented hook whenever the agent's stream ends: a normal goodbye, an ElevenLabs drop, or the alternative transfer path T2 in §11.5. *To verify in the spike:* that ElevenLabs' returned TwiML is a single `<Connect><Stream>` that tolerates appended verbs.
3. On vendor error or timeout, it returns **local fallback TwiML**: an apology, then `<Dial>` to the transfer line with `timeout`, or `<Record>` a short message → outbox `voice_callback_request` (SMS + email to the restaurant).
4. The Twilio number's **Fallback URL** points to a static **TwiML Bin** hosted by Twilio (same apology + `<Dial>` / voicemail).
   - **Scope:** Twilio requests the Fallback URL only when *our primary webhook* fails (error, timeout, invalid TwiML). It protects against our App Service, our deploys or our code being down.
   - **It does not protect against a Twilio platform outage.** If Twilio cannot take the call, neither the Voice URL nor the Fallback URL runs (§11.4).
5. A per-number **status callback** URL (`/api/voice/status`) records the final call status and duration in `voice_calls`. A `statusCallback` on the stream (if ElevenLabs' TwiML allows it, or via our appended hook) records when the agent's stream stopped.

### 11.2 Why our webhook first, not ElevenLabs' native number import

| | ElevenLabs native integration (number imported into ElevenLabs) | **register-call via our webhook (recommended)** |
|---|---|---|
| Kill switch, pilot allow-list, hours branching before the AI answers | In the agent prompt only | **In our code** |
| Every inbound call logged even when the vendor fails | No | **Yes** |
| Custom fallback when the vendor is down | Twilio fallback URL, if ElevenLabs leaves it alone (UNKNOWN) | **Ours + TwiML Bin** |
| Transfer | Native `transfer_to_number` (conference / blind; warm message) | **Not supported by ElevenLabs on register-call.** We transfer via the Twilio Call REST API (§11.5). The general redirect is documented; behaviour with an active `<Connect><Stream>` is to be proven in a spike |
| Setup effort | Lowest | Moderate (one route + audio format μ-law 8 kHz on the agent) |

### 11.3 Optional later (Phase 9+): number on Twilio, ring-first in TwiML

Port the public number to Twilio, or point it at Twilio. Then:

`<Dial timeout="{VOICE_RING_SECONDS}" action="/api/voice/dial-result">store phone(s)</Dial>`

and on `DialCallStatus ∈ {no-answer, busy, failed}`, hand the call to the AI.

This gives an exact ring duration, missed-call analytics and time-of-day rules. It is a **high-risk change to the restaurant's main line**, so it is not for the pilot.

### 11.4 Specific behaviours

| Situation | Behaviour |
|---|---|
| **Caller ID** | **Requires a real carrier test; not assumed.** Whether the carrier's conditional forwarding delivers the *customer's* number to Twilio as `From` (rather than the store's own number, a carrier forwarding number, or nothing) is UNKNOWN for the Pizza 62 carrier. It is tested before any voice build (§20, Phase 0.5). The design works either way (§11.6) |
| **Transfer AI → restaurant** | `transfer_to_store` → our backend redirects the live call through the Twilio Call REST API to `<Say>` + `<Dial>` (exact mechanism and verification in §11.5). **The transfer target must not be the forwarded public number**, or CFNA bounces it back to the AI. Use a direct kitchen line or cell (possibly `RESTAURANT_ALERT_PHONE`; UNKNOWN whether it differs from the public number). The loop guard is a second defence |
| **Restaurant doesn't answer the transfer** | `/api/voice/transfer-result` sees `no-answer`/`busy` → TwiML: "Sorry, nobody could get to the phone. I've sent your details to the restaurant and someone will call you back shortly." → outbox `voice_callback_request` (SMS + email with summary and callback number) → hang up. Note: if the AI answered because the line was *busy*, a transfer will likely hit busy again, so **the callback request is the primary escalation and transfer is secondary** |
| **After hours** | Carrier forwarding still sends the call to the AI. `get_store_status` puts the agent in closed mode: today's or next opening hours, the website for scheduled orders (pilot: the AI takes no scheduled orders), optional message → callback request flagged "next business day" |
| **AI vendor fails at call start** | Our webhook catches the register-call error → local fallback TwiML (§11.1 step 3) |
| **AI vendor fails mid-call** | If ElevenLabs' socket closes, Twilio continues to our appended `<Redirect>` (§11.1). `/api/voice/after-agent` sees no order and no transfer, apologizes, and offers a callback (or dials the transfer line during hours). If the stream hangs open without audio, the caller hears silence until they hang up. A `voice_calls` row with no post-call webhook within 10 min raises a staff alert (SMS) with the caller number, if `caller_id_status = presented` |
| **Our backend fails at call start** | Twilio requests the number's **Fallback URL** (TwiML Bin), so the call never reaches the AI unguarded. This covers our failure only |
| **Our backend fails before the agent's stream ends** | The appended `<Redirect>` to `/api/voice/after-agent` also fails, so Twilio applies the Fallback URL to that request too. *Verify in the spike* that Twilio uses the number's fallback for `<Redirect>` failures; otherwise the call ends |
| **Our backend fails mid-call** | Tools return errors or time out. The agent is instructed to apologize and attempt `transfer_to_store`. If that also fails (backend down), it gives the store's hours and asks the caller to try again shortly. The post-call webhook (retried by ElevenLabs) later surfaces the caller for a manual callback |
| **Twilio platform outage** | **Not covered by the Fallback URL or TwiML Bin.** Both run on Twilio. While forwarding is active, the carrier sends unanswered calls to a Twilio number that cannot take them. What the caller hears (error tone, endless ringing, or a carrier voicemail fallback) is carrier-dependent and UNKNOWN. **Mitigation is operational:** watch Twilio's status page and our `voice_calls` volume (an alert when forwarded calls drop to zero during open hours), and keep a **runbook to switch off carrier forwarding** (star code or carrier portal) so calls only ring the store, as before the AI. Ask the carrier whether conditional forwarding can fail over when the destination is unreachable. The existing outbound restaurant alerts (SMS and call) also stop; email to `business.email` (Resend/SendGrid) still goes, and the outbox retries Twilio when it recovers |
| **Order already placed when something fails** | `place_order` is idempotent. The order exists, the kitchen is alerted by the existing outbox, and the AI reads the number again if the caller is still there |

### 11.5 AI → human transfer mechanism (register-call has no ElevenLabs-managed transfer)

#### What Twilio documents (checked 17 Oct 2026)

| Behaviour | Status |
|---|---|
| An **in-progress call can be redirected** through the Call resource's *Update* operation with `Url` or `Twiml` (mutually exclusive). This is described as a way to "interrupt an in-progress call" and "make an immediate change [to] the TwiML document that Twilio is using in a phone call" | ✅ Documented |
| Inside `<Dial>`, the **default caller ID is the inbound caller's number** ("the dialed party sees the inbound caller's number as the caller ID"). Explicitly setting `callerId` to the `From` or `To` of the TwiML request is allowed with `<Number>`, but **not for inbound SIP calls** | ✅ Documented |
| `<Dial action>` is requested when the dialed leg ends, with `DialCallStatus ∈ {completed, busy, no-answer, failed, canceled}`. `timeout` defaults to 30 s (range 5–600), and Twilio adds about 5 s | ✅ Documented |
| For `<Connect><Stream>`, "Twilio executes the remaining TwiML instructions only after your server closes the WebSocket connection". A bidirectional stream "stops when the call ends or when your WebSocket server closes the connection", and Twilio sends a `stop` message "when the Stream has stopped or the call has ended" | ✅ Documented |
| **What happens to an active bidirectional `<Connect><Stream>` when the call is redirected by REST.** Twilio's docs do not state explicitly that the redirect tears the stream down and sends `stop` / closes the socket to ElevenLabs. Third-party voice bridges use exactly this pattern (`calls(sid).update({ twiml: '<Dial>…' })`) and treat stream stop as the end of the AI leg, so it is the expected behaviour, but it is **not confirmed by Twilio's documentation** | ⚠ To prove in the spike |

#### Mechanism T1 (primary): REST redirect of the live call

1. The agent decides to transfer. The prompt has it say one short line ("One moment, I'll connect you to the restaurant.") and then call `transfer_to_store {reason, summary}`.
2. Our tool handler:
   - authenticates the session and resolves `CallSid` from `voice_calls` (stored at `/api/voice/inbound`);
   - checks that transfer is allowed (store hours, loop guard, not already transferring);
   - writes `transfer_requested_at` / `transfer_reason`;
   - calls `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json` with:

   ```xml
   <Response>
     <Say voice="alice" language="en-CA">Connecting you to the restaurant now.</Say>
     <Dial timeout="20" action="{base}/api/voice/transfer-result?vc={id}" method="POST">
       <Number>{RESTAURANT_TRANSFER_PHONE}</Number>
     </Dial>
   </Response>
   ```

   No explicit `callerId` is set, so Twilio's documented default presents the inbound caller's number to the store. The same `postToTwilio` helper as today is used (`lib/notifications/channels.ts`), extended for `Calls/{sid}`.

   *Optional:* `<Number url="{base}/api/voice/transfer-whisper?vc={id}">` plays a short summary to the store before the legs connect ("AI phone transfer: customer wants to change order 1234; callback 905…"). Twilio documents `<Number url>` as TwiML run for the called party before connection; include it in the spike.
3. The tool returns `{ok: true}` immediately. The agent may not get to speak afterwards; that is expected.
4. **Expected Twilio behaviour (to verify):**
   - the redirect replaces the executing TwiML;
   - the `<Connect><Stream>` verb ends;
   - Twilio sends `stop` and closes the media socket to ElevenLabs;
   - ElevenLabs ends the conversation and sends the post-call webhook;
   - the caller hears our `<Say>`, then ringback.

   Our appended `<Redirect>` after `<Connect>` is **not** executed, because the whole document was replaced.
5. `/api/voice/transfer-result`:
   - on `completed`, returns `<Hangup/>` and sets disposition `transferred`;
   - on `busy`, `no-answer` or `failed`, returns `<Say>` "Sorry, nobody could get to the phone; someone will call you back shortly." plus `<Hangup/>`, and queues `voice_callback_request` (disposition `transfer_failed_callback`).
6. **Failure handling:**
   - if the Twilio REST call itself errors, the tool returns `ok:false` and the agent offers a callback (`request_callback`);
   - if the call is no longer in progress (the caller hung up), the transfer is recorded as abandoned.

#### Mechanism T2 (alternative, built only on documented continuation semantics)

1. The tool records `transfer_requested`.
2. The agent ends its session with ElevenLabs' end-call system tool. With register-call, ElevenLabs has no Twilio credentials, so ending means closing the media socket.
3. Twilio continues to our appended `<Redirect>`.
4. `/api/voice/after-agent` sees `transfer_requested` and returns the same `<Say>` + `<Dial>` TwiML.

This is slower: the agent must finish speaking first. It depends on verifying that ElevenLabs closes the socket when the agent ends a register-call conversation.

#### Spike (Phase 0.5, before any app code; test Twilio number + test agent + TwiML Bins and a throwaway script)

Verify each of the following:

- T1 redirect mid-sentence and mid-silence:
  - the caller hears the `<Say>` and ringback within 1–2 s;
  - **no agent audio continues after the redirect**;
  - ElevenLabs shows the conversation ended, with no lingering billed minutes;
  - the post-call webhook arrives;
  - the stream status callback (if configured) reports stopped.
- `DialCallStatus` reported correctly for answer, decline/busy, no-answer and an invalid number.
- T2 works end to end, which tells us whether appended verbs after ElevenLabs' TwiML are honoured.
- The store phone shows the customer's number on the transferred leg (depends on §11.6).

If T1 fails its checks and T2 passes, use T2. **If both fail, A2's transfer story fails.** In that case, reconsider ElevenLabs native integration (with its native transfer), accepting the loss of our webhook-first controls (§11.2), before building further.

### 11.6 Caller ID: must be tested on the real carrier; design must not depend on it

**Not assumed.** It is UNKNOWN whether Pizza 62's carrier, when conditionally forwarding an unanswered call, presents the **customer's** number to Twilio as `From`. It may instead present the store's own number, a carrier forwarding number, or "anonymous".

It also matters what `ForwardedFrom` contains, and what STIR/SHAKEN attestation (`StirVerstat`) Twilio reports.

**Test (Phase 0.5):** forward the store line to a test Twilio number whose Voice URL is a TwiML Bin that just says "test". Then, from two different mobile carriers and one landline, call the store and let it ring out. In the Twilio console's call logs, record `From`, `ForwardedFrom`, `CallerName` (if any) and `StirVerstat`. Repeat with the store line busy.

The inbound handler classifies every call:

| `caller_id_status` | When | Effect |
|---|---|---|
| `presented` | `From` is a valid E.164 number that is not one of our numbers or the store's public number | Default callback number (read back for confirmation); `lookup_caller`, `reorder_last`, `get_order_status` allowed; loop guard may key on it |
| `forwarded_as_store` | `From` equals the public store number or a known forwarding number | Ask for a callback number; history features off; loop guard keys on the session only |
| `withheld` | Anonymous, restricted or empty | Same as above |
| `unknown` | Anything else | Same as above |

On transfer, the store sees whatever Twilio received as `From`. If that is the store's own number, the agent's `<Say>` / summary (and the callback SMS) must carry the customer's spoken number instead.

---

## 12. Order Confirmation and Safety Design

These are enforced in **backend code**, not only in the prompt.

1. **Explicit confirmation.** `voice_calls` holds `cart_version`, `reviewed_version`, `confirmed_version`, `confirmed_at`, `confirmed_amount_cents` and `confirmation_utterance`. `place_order` requires `confirmed_version = reviewed_version = cart_version`, a confirmation less than 5 min old, and `quote.ok`. Any mutation increments `cart_version`, which silently invalidates confirmation. The read-back text comes from the server (`review_order`), so what the caller agrees to is what the server will charge. *Limitation:* the server cannot hear audio, so it trusts the LLM's report that the caller said yes. Mitigations: the stage machine, the logged utterance, a post-call transcript audit (Phase 6 manual review of every AI order), and a prompt rule that confirmation needs an affirmative reply to the full read-back.
2. **Idempotency.** `place_order` uses `idempotencyKey = "voice:" + voiceCallId + ":" + cartVersion` (meets `createOrder`'s 20–200 char rule). The existing `idempotency_keys` table returns `duplicate: true` with the same `orderNumber` on retry, and `409 CHECKOUT_IN_PROGRESS` while the first attempt is in flight. `voice_calls.order_id` is set once; a second `place_order` on the same call returns the existing order.
3. **Pricing.** No tool accepts a price, total, discount or tax. `place_order` passes `expectedAmountDueCents = confirmed_amount_cents`, reusing the existing `TOTAL_CHANGED` refusal if the price rose (for example a promotion expired mid-call).
4. **Menu validation.** Tools accept only IDs returned by `search_menu` / `get_menu_item`, and `validateItems` rejects anything else. Public catalogue only (`staffOnly` excluded) unless the owner decides otherwise. Free-text notes are capped (≤ 200 chars for voice) and must not carry items: the prompt forbids it, and the review shows notes verbatim to the caller.
5. **Authentication** between the voice provider and our backend:
   - **Tool calls:** `Authorization: Bearer VOICE_TOOL_SECRET` (an ElevenLabs workspace secret) **plus** `X-Voice-Session`, a per-call random token minted by `/api/voice/inbound`, stored hashed in `voice_calls`, and handed to ElevenLabs as a `secret__` dynamic variable (redacted from the LLM and from logs). A tool call is valid only for a live call (status in-progress, under 30 min). A leaked static secret alone cannot place orders.
   - **Post-call webhook:** ElevenLabs HMAC-SHA256 signature with timestamp tolerance (±5 min) over the raw body.
   - **Twilio webhooks:** existing `X-Twilio-Signature` verification on the canonical URL.
   - **Admin pages:** existing `requireStaff` with a new permission `view_voice_calls`.
6. **Rate limiting.** Add a key-based variant of `enforceRateLimit` (the internal `applyRateLimit` already takes a key):
   - per voice session: ≤ 150 tool calls and ≤ 1 placed order;
   - per caller number: ≤ 3 AI orders per day and ≤ 10 calls per hour;
   - global: ≤ N AI orders per 15 min (owner-set) as a circuit breaker;
   - the existing IP limiter stays on public routes.
7. **Delivery validation.** Only `check_delivery_address` / `createOrder` decide eligibility. The agent may only repeat the reason the server gave.
8. **Store hours.** `createOrder` enforces closures and hours, and (Phase 1) the last-order cutoff. `get_store_status` drives closed mode.
9. **Order value and size caps** (`VOICE_MAX_ORDER_CENTS`, e.g. $150; or more than 6 pizzas) → transfer as catering.
10. **Human escalation**, enforced by the prompt *and* backed by tool behaviour:

| Trigger | Action |
|---|---|
| Complaint, refund, payment dispute, "manager" | `transfer_to_store` (reason enum) → callback if unanswered. `place_order` is disabled for that call once a complaint reason is logged |
| Allergy or dietary-safety question | The agent never asserts safety: "We can't guarantee any item is free of allergens; let me connect you." → transfer. (No allergen data exists.) |
| Catering or very large order | Caps above → transfer |
| Repeated misunderstanding | The server counts consecutive `NO_MATCH` / validation failures per call. After 3, the tool response sets `escalate: true` |
| Unsupported request (dip flavour, custom items) | Note it if harmless; otherwise transfer |
| Backend failure | Tool `5xx` / timeout twice → transfer, or callback |
| Changing or cancelling an existing order | Transfer (no tool exists) |

---

## 13. Notification Flow

**Reuse, don't duplicate.** An AI order created through `createOrder` automatically gets the existing `restaurant_new_order` outbox row:

- email to `business.email`;
- SMS to `RESTAURANT_ALERT_PHONE`;
- phone call with press-1 acknowledgement;
- re-calls every 2 minutes until acknowledged;
- the kitchen-board banner and beep.

The "AI order" SMS is therefore **a channel-aware change to the existing restaurant SMS**, not a second message pipeline. In `lib/notifications/messages.ts#renderRestaurantNewOrder`, when `order.channel === "ai_phone"`:

- **SMS:**

  ```
  AI PHONE ORDER P62-1234 · PICKUP · Jordan (905) 555-0123 · 3 item(s) · $43.21 COLLECT · ready ~6:45 PM. Check the kitchen board.
  ```
- **Voice:** "New order taken by the AI phone line. Pickup order, number 1234…" (also fix "website" for staff `phone` orders).
- **Email:** callout label `PICKUP · AI PHONE`, plus a link to the call record once the admin page exists.
- **Kitchen ticket:** `app/staff/StaffPortal.tsx` already prints the channel. Add the `AI PHONE` label and print the caller's callback number prominently.

Additional notifications (new outbox kinds, same dispatcher):

| Kind | When | Channels |
|---|---|---|
| `voice_callback_request` | Transfer unanswered, caller asked for a callback, after-hours message, mid-call failure detected | SMS to `RESTAURANT_ALERT_PHONE` ("CALLBACK: (905) 555-0123 — wants to change order P62-1234 — 6:12 PM") + email to `business.email` |
| (optional) `voice_ops_alert` | Vendor failure rate spike, webhook signature failures | Email to `alerts.developerEmails` |

**Customer-side notifications:**

- AI orders normally have **no email**, so no confirmation email or feedback request. This matches staff phone orders today.
- The agent reads the order number and ETA aloud, twice.
- An SMS confirmation to the customer should wait until the sender is registered or verified (`CUSTOMER_SMS_ENABLED` exists for exactly this; §15).

Recommended small fix in the same phase: stop re-sending the email and SMS on every re-call cycle. Re-call should place only the call.

---

## 14. Observability / Call Logging

### What to record (`voice_calls` + `voice_call_events`, §19)

**Per call:**

- `call_sid`, `provider`, `provider_conversation_id`, `agent_id`;
- `caller_phone` (E.164), `forwarded_from`;
- `mode` (internal / pilot / live);
- `started_at`, `answered_by_ai_at`, `ended_at`, `duration_s`;
- `disposition ∈ {order_placed, info_only, transferred, transfer_failed_callback, callback_requested, abandoned, closed_mode, vendor_failed, backend_failed, rejected_mode_off}`;
- `order_id`, `transfer_status`, `failure_reason`;
- `cart_json`, `cart_version`, `confirmed_*`, `final_quote_json`;
- `escalation_reason`;
- `transcript_json` (from the post-call webhook), `summary`;
- `latency_stats_json` (if the vendor provides it);
- `tool_call_count`, `validation_error_count`.

**Per event** (append-only):

- tool name, redacted request, redacted response, `ok`, `issue_codes`, `latency_ms`, `cart_version_before/after`;
- transfer and status events.

**Privacy:**

- **Never store card data.** The agent is instructed never to ask for card numbers. The server redacts any 13–19 digit run, CVV-like 3–4 digits after "security code", and expiry patterns from transcripts and events before writing.
- Retain transcripts for `VOICE_TRANSCRIPT_RETENTION_DAYS` (suggest 60), then null them by a cron step; keep metadata longer.
- Configure ElevenLabs retention to the minimum that still supports debugging.
- **Disclose automation and recording in the greeting** ("You've reached Pizza 62's automated assistant; this call may be recorded to take your order.") and update `app/privacy/page.tsx`. Ontario and Canada are one-party-consent for recording, but PIPEDA requires notice of collection and of cross-border processing (vendor data residency: UNKNOWN).
- Logs (`lib/log.ts`) take identifiers only, as today.

### Admin page — "AI Phone"

This fits the existing architecture: `/admin` is a single `StaffPortal` with sections, backed by `/api/admin/*` routes guarded by `requireStaff` and permissions. Add:

- a section **AI phone** (permission `view_voice_calls`, owner by default) listing call time, caller (redacted per `view_customer_contact`, as `redactOrderContact` does), duration, disposition, order link (opens the existing `OrderDetail`), transfer outcome, and an expandable transcript with tool events;
- a top strip with today's counts: calls, orders, transfers, failures;
- a kill-switch toggle (`VOICE_AI_MODE`) on the Integrations screen, consistent with `CLOVER_IFRAME_ENABLED` ("turn it off mid-dinner without a deploy").

Build it in Phase 6. Until then, the ElevenLabs conversation history plus a SQL view is enough for the internal and supervised phases.

**Alerts:** add Log Analytics alert rules (`infra/alerts.tf` pattern) on `[voice.` log lines:

- vendor errors > 3 in 10 min;
- signature failures;
- `place_order` 5xx;
- calls with no post-call webhook.

---

## 15. Payment Strategy

**Today:**

- `pay_at_store`: pickup on the web; the till also uses it for phone deliveries, with the driver collecting.
- `online` via Clover: the iframe token is charged inline, or the Hosted Checkout link is confirmed by webhook. Unpaid orders are reaped after 20 min.
- Card numbers never touch the application.
- `ordering.cashOnDeliveryEnabled` is `false` for the public web.

| Phase | Strategy | Why |
|---|---|---|
| **Pilot (Phases 6–7)** | **A. Pickup only, pay at pickup** (`paymentMethod: "pay_at_store"`) | Zero new payment surface. `createOrder` already supports it for non-staff contexts when `payAtStorePickupEnabled`. The restaurant alert already says "COLLECT PAYMENT AT THE STORE" |
| **Phase 8** | **Delivery, pay at the door** (cash or the card machine the driver carries), exactly as staff phone deliveries work today | **Decision:** the owner must accept pay-on-delivery for AI-taken orders. The web refuses it for strangers on purpose (`createOrder` comment). Mitigations: verified callback number required, value cap, per-number daily cap, and returning-caller history |
| **Phase 9 (optional)** | **B. SMS payment link** using the existing `createCloverCheckout` (Hosted Checkout `href`) | Blocked until customer SMS is reliable (registered or verified sender). The order sits in `awaiting_payment` with notifications parked until Clover's webhook, and is reaped after 20 min, which makes the voice "your order is in" promise conditional. Better suited to pre-paid scheduled orders |
| **Not recommended** | **C. Card numbers over the phone** to the LLM, or a DTMF capture flow | PCI DSS scope; Twilio `<Pay>` needs a supported payment connector, and Clover support is UNKNOWN. Never let the LLM hear, transcribe or store PANs |

---

## 16. Provider Comparison

Options evaluated:

- **A1** — Twilio → ElevenLabs Agents, native number import.
- **A2** — Twilio → **our webhook** → ElevenLabs *register-call*.
- **B** — Twilio **ConversationRelay** + LLM. Twilio does STT and TTS (including ElevenLabs Flash voices); **a WebSocket endpoint we would add to our app** receives text turns and runs the LLM and tools.
- **C** — Twilio + **OpenAI Realtime**. Two variants:
  - **C-SIP:** Twilio `<Dial><Sip>` or Elastic SIP Trunking to OpenAI, plus an HTTP accept webhook and an outbound *sideband* WebSocket client held by our process for tool calls;
  - **C-Bridge:** a Media Streams audio bridge inside our app.
- **D** — Non-AI missed-call capture: Twilio IVR / `<Record>` + callback request. Hosted peers of A (Vapi, Retell) were considered and have the same profile as A, with no material advantage for this codebase.

Scores are 1–10, higher is better, and are our assessment for Pizza 62's constraints, not vendor benchmarks. Revision 2 re-scored B and C after the WebSocket correction; changed cells show the old value as *was N*.

> **All vendor pricing and concurrency figures in this document are provisional.** They come from third-party 2026 summaries and are not implementation assumptions. Exact Twilio, ElevenLabs and LLM pricing, plan concurrency limits and burst rules must be **verified at deployment** from the vendors' own pricing pages and account settings. The Cost row ranks options only relative to each other.

| Criterion | A1 ElevenLabs native | **A2 ElevenLabs via our webhook** | B ConversationRelay + LLM | C OpenAI Realtime | D IVR / callback |
|---|---|---|---|---|---|
| Natural voice | 9 | 9 | 8 | 8 | 3 |
| Conversational ability | 8 | 8 | 8 | 8 | 1 |
| Latency | 8 | 8 | 7 | 9 | 9 |
| Interruptions / barge-in | 8 | 8 | 7 | 9 | 5 |
| Complicated order handling *(mostly decided by our tools, the same for all)* | 8 | 8 | 8 | 7 | 1 |
| Tool / function calling | 8 | 8 | 9 | 8 | 2 |
| Twilio integration | 9 | 8 | 10 | 6 | 10 |
| Implementation speed *(the app has no WebSocket server today)* | 9 | 8 | 5 *(was 4)* | 5 *(was 4)* | 9 |
| Observability | 7 | 9 | 7 | 6 | 8 |
| Flexibility | 6 | 7 | 9 | 6 | 3 |
| Cost *(provisional, relative only)* | 7 | 7 | 7 | 8 | 10 |
| Maintenance | 8 | 8 | 5 | 5 | 9 |
| Production reliability *(in-process call state vs stateless tools)* | 7 | 8 | 6 *(was 7)* | 6 | 9 |
| Vendor lock-in *(10 = least)* | 5 | 7 | 8 | 5 | 9 |

### Notes behind the scores

- **WebSockets (corrected in revision 2).** App Service Linux can host WebSockets, so B and C do **not** necessarily need a separate service. What they need is engineering the app has never had:
  - **B:** an inbound WebSocket endpoint for ConversationRelay. Its traffic is text, so bandwidth is low, but it needs a custom server entrypoint around vinext's `startProdServer()` (a pre-1.0 framework), a `ws`-style dependency, and our own turn loop: streaming LLM tokens, interruption handling, tool loop, conversation state.
  - **C-Bridge:** carries audio both ways through our single P0v3 process.
  - **C-SIP:** needs no inbound socket server, but holds an outbound sideband socket per call inside our process.

  In every B and C variant, **the live call's state lives inside our Node process for the whole call**. A deploy (we deploy during the day via slot swap), a restart, a health-check eviction or a crash mid-call can drop or orphan live calls. Draining and resumption would have to be built and tested. With A1/A2, our app serves only short, idempotent HTTPS tool calls, so a deploy mid-call costs at most a retried tool call.

  **Effect on the recommendation:** B's implementation-speed gap narrows (4 → 5), but its reliability falls (7 → 6) once the in-process-state risk is stated plainly. Net: A2 still leads on reliability, maintenance and voice quality. B remains the exit route if vendor cost or lock-in becomes a problem.
- **A2 vs A1.** A2 costs one extra route plus our own transfer. In return we get kill switch, allow-list, logging of every call, and fallback control. Transfers in A2 are ours by necessity, because ElevenLabs does not support its transfer tool on register-call.
- **Tools are plain HTTPS in A1, A2 and C**, which limits lock-in. The tool layer (§9) is the same regardless of vendor, so a later move to B or C replaces only the voice front-end.
- **Indicative cost — provisional, verify at deployment.** These figures are for orientation only and are not inputs to any design decision:
  - A: an ElevenLabs per-minute platform rate (third-party reports ≈ US$0.08/min), plus LLM usage, plus Twilio inbound minutes, plus the plan fee. Concurrency is plan-limited, and burst pricing is reported.
  - B: ConversationRelay per-minute rate (≈ US$0.07/min reported on Twilio's pricing page at the time of research), plus Twilio voice, plus LLM tokens.
  - C: OpenAI Realtime audio-token pricing (varies by model tier), plus Twilio / SIP.
  - Actual missed-call volume, and therefore monthly cost, is UNKNOWN.
- **Verify at deployment:** Twilio voice and number pricing for Canada; ElevenLabs plan price, per-minute rate, **concurrent-call limit** and burst rules; LLM rates inside ElevenLabs; data-retention options.
- **Carrier forwarding costs** at the restaurant's carrier: UNKNOWN.

---

## 17. Recommended Provider / Stack

**Recommendation: A2 (unchanged after the WebSocket correction).**

```
Twilio
  → Pizza 62 /api/voice/inbound          (signature, kill switch, hours, caller-ID status, logging)
  → ElevenLabs register-call             (agent: STT + LLM + TTS, barge-in)
  → Pizza 62 HTTPS voice tools           (/api/voice/tools/*: resolver, cart, confirmation gate)
  → existing quoteOrder / createOrder    (lib/order-service.ts)
  → existing notifications               (notification_outbox → dispatcher → email / SMS / press-1 call)
```

Transfers go through the Twilio Call REST API (§11.5, spike-gated).

Why, against our priorities:

1. **Reliability.**
   - **No live call state in our process.** Our app serves only short, idempotent HTTPS requests, so the daytime slot-swap deploys, restarts and health-check evictions cannot drop a live call. This remains the decisive difference after the WebSocket correction.
   - Our webhook gives a kill switch and fallback before the AI answers.
   - A Twilio-hosted TwiML Bin covers **our** outage (not Twilio's; §11.4).
   - Order placement is idempotent and runs through the proven engine.
2. **Correct orders.** Correctness lives in our backend: menu resolver, server cart, `quoteOrder`, confirmation gate and `createOrder`. That is independent of the vendor.
3. **Natural conversation.** ElevenLabs voices and turn-taking are the strongest of the options, with barge-in built in.
4. **Low latency.** The vendor co-locates STT, LLM and TTS. Our tools must answer quickly (target < 600 ms p95; `quoteOrder` is a handful of indexed queries; cache the catalogue for 30 s like integration secrets).
5. **Complex modifications.** Choose a strong tool-calling LLM inside ElevenLabs (configurable) and keep tools granular (`update_item` with patches).
6. **Easy integration.** HTTPS route handlers in the existing app, existing auth patterns, existing outbox.
7. **Cost.** Expected to be modest at a single restaurant's missed-call volume, but **provisional**: pricing and concurrency are verified at deployment, and volume is UNKNOWN.
8. **Debugging.** ElevenLabs conversation history and transcripts, plus our `voice_calls` / `voice_call_events`, plus App Insights.

**LLM inside the agent:** pick the model with the best tool-calling reliability on our scenario suite (Phase 3 compares 2–3 models on the same transcripts). Do not choose on voice demos.

**Conditions that would change this recommendation:**

- The Phase 0.5 transfer spike fails both T1 and T2 (§11.5).
- ElevenLabs' verified concurrency limits or pricing are unacceptable at deployment.
- ElevenLabs' TwiML cannot coexist with our appended hook **and** the hook is judged essential.

**Revisit trigger:** if per-minute cost, concurrency limits or ElevenLabs reliability become a problem after Phase 8, move the voice front-end to B (ConversationRelay) behind the same tool layer. That is the planned exit route. It then needs the WebSocket entrypoint work in §16, including deploy draining.

---

## 18. Required Services and Environment Variables

### 18.1 Services checklist

| Service | Item | Status |
|---|---|---|
| **Twilio** | Account + Auth Token (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) | ✅ Exists |
| | Sending number for alerts and SMS (`TWILIO_FROM_NUMBER`) | ✅ Exists |
| | **New local number for the AI line** (recommended, so the alert and marketing number's inbound behaviour and reputation stay separate) | 🆕 Create |
| | Voice URL / Fallback URL / Status Callback on the AI number | 🆕 Configure |
| | TwiML Bin for static fallback | 🆕 Create |
| | Current inbound voice config of `TWILIO_FROM_NUMBER` | ❓ UNKNOWN |
| | Customer SMS sender registration or verification (needed only for SMS confirmations or links) | ❓ Later |
| | Twilio voice and number pricing for Canada | ❓ Verify at deployment |
| **Carrier** (public number (905) 547-5777) | Conditional forwarding: no-answer (ring count) and busy → AI number | ❓ UNKNOWN: carrier, line type, whether CFNA/CFB is available |
| | **Caller-ID preservation on forwarded calls** | ❓ **Must be tested on the real line (Phase 0.5)**, never assumed (§11.6) |
| | Behaviour when the forwarding destination (Twilio) is unreachable; how staff disable forwarding quickly | ❓ Ask carrier; write runbook |
| | Direct transfer target that does **not** forward back | ❓ UNKNOWN (possibly `RESTAURANT_ALERT_PHONE`) |
| **ElevenLabs** | Account on a plan with enough **concurrent calls** for peak | 🆕 Create. Price, per-minute rate, concurrency and burst rules: **verify at deployment** |
| | Agent (prompt, voice, LLM, μ-law 8 kHz I/O, server tools, `secret__` header variable, post-call webhook + HMAC secret, data-collection fields) | 🆕 Create (separate staging and production agents) |
| | API key (for register-call) | 🆕 Create |
| | Data residency / retention settings | ❓ Verify |
| **LLM** | Billed through ElevenLabs (no separate OpenAI or Anthropic account required for A2) | 🆕 With ElevenLabs |
| **Maps** | Azure Maps (`AZURE_MAPS_CLIENT_ID`, managed identity) | ✅ Exists |
| **Redis** | Not needed. The voice cart lives in Postgres (low volume; survives slot swaps and multiple instances) | — |
| **Database** | Migration for the `ai_phone` channel + voice tables (§19) | 🆕 Phase 1–2 |
| **Azure** | Key Vault placeholders for the new secrets; Log Analytics alert rules | 🆕 Phase 4 (Terraform) |
| | App Service WebSocket setting | Not needed for A2. Only if B or C is ever adopted: read the effective setting on both slots, then plan the entrypoint and deploy-draining work (§16) |

### 18.2 Environment variables / integration secrets

Reuse without duplication: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `RESTAURANT_ALERT_PHONE`, `CRON_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `AZURE_MAPS_CLIENT_ID`.

New, added to `INTEGRATION_SECRET_KEYS` so the owner can set them from Admin → Integrations, with Key Vault fallback:

```
ELEVENLABS_API_KEY=            # secret; register-call
ELEVENLABS_AGENT_ID=           # not secret (readable in full)
ELEVENLABS_WEBHOOK_SECRET=     # secret; post-call webhook HMAC
VOICE_TOOL_SECRET=             # secret; bearer for /api/voice/tools/* (also stored in ElevenLabs)
VOICE_AI_NUMBER=               # E.164 of the Twilio AI-line number
VOICE_AI_MODE=                 # off | internal | pilot | live   (default off)
VOICE_AI_ALLOWLIST=            # comma-separated E.164 staff numbers for internal mode
RESTAURANT_TRANSFER_PHONE=     # E.164 direct line that does NOT forward to the AI; falls back to RESTAURANT_ALERT_PHONE
VOICE_TRANSFER_RING_SECONDS=   # e.g. 20
VOICE_MAX_ORDER_CENTS=         # e.g. 15000
VOICE_PILOT_FULFILMENTS=       # pickup | pickup,delivery
VOICE_TRANSCRIPT_RETENTION_DAYS=  # e.g. 60
```

---

## 19. Database Changes

Minimum required, all additive. Existing website and till behaviour is unchanged.

1. **`orders.channel` gains `ai_phone`** (Phase 1, migration `drizzle/0011_…`): update `ORDER_CHANNELS` in `db/schema.ts` and the `orders_channel` check constraint.
   - *Why not reuse `phone`?* The kitchen ticket, restaurant alert, reporting (`app/api/admin/records/route.ts`, `app/api/admin/customers/route.ts` counts) and `orderSourceLabel` all key on `channel`. AI orders must be distinguishable everywhere without a join, and staff phone orders must stay "staff phone".
   - Code touching channel: `lib/order-service.ts`, `lib/attribution.ts#orderSourceLabel`, `lib/notifications/messages.ts`, `app/staff/OrderDetail.tsx#CHANNEL_LABELS`, `app/staff/StaffPortal.tsx` (ticket label), `app/api/admin/customers/route.ts` (per-channel counts), `app/api/admin/records/route.ts` (filter via `ORDER_CHANNELS`), `app/staff/AdminRecords.tsx`.
2. **`voice_calls`** (Phase 2): one row per inbound call. It is also the voice cart session (cart, version, stage, confirmation fields). Fields are listed in §14. Unique on `call_sid` and on `provider_conversation_id`; FK `order_id → orders` (set null); index on `(created_at)` and `(caller_phone, created_at)`.
3. **`voice_call_events`** (Phase 2): append-only tool, cart and transfer log; FK cascade from `voice_calls`.
4. **`notification_outbox.kind`**: new kinds `voice_callback_request` (no schema change; `kind` is free text).
5. **`order_events.actor_type = 'ai_receptionist'`** for the creation event (no constraint on `actor_type`; no schema change).

**Not needed:**

- a separate voice orders table;
- changes to `order_items`, `payments` or `promotions`;
- Redis;
- a new customer table (history comes from `orders` by phone).

**Possible later**, only if justified:

- an expression index on phone digits for `lookup_caller` at higher volume;
- a structured `cheese_level` modifier, replacing the free-text prefix;
- a `dip_flavours` option source;
- option-level sold-out.

---

## 20. Implementation Phases

### Phase 0 — Architecture discovery *(this document)*

| | |
|---|---|
| Objective | Shared understanding; resolve the open questions in §22 |
| Success | Owner decisions recorded; restaurant and phone-provider checklist answered (§23) |

### Phase 0.5 — Telephony spike *(new in revision 2; no application code, no production configuration)*

| | |
|---|---|
| Objective | Prove the three telephony assumptions A2 depends on before building on them |
| Setup | A **separate test Twilio number** (not `TWILIO_FROM_NUMBER`); TwiML Bins; a throwaway local script for the REST redirect; an ElevenLabs **test** agent called through register-call from the script. Nothing in the Pizza 62 repository, database or production Twilio configuration changes |
| Tests | (1) **Carrier caller-ID test** (§11.6): forward the store line on no-answer and busy to the test number, and record `From`, `ForwardedFrom` and `StirVerstat` from at least three caller carriers. (2) **Transfer T1** (§11.5): REST-redirect a live register-call conversation to `<Say>` + `<Dial>`, checking stream teardown, no lingering agent audio, post-call webhook, `DialCallStatus` outcomes and the caller ID shown to the store. (3) **Transfer T2**: an appended `<Redirect>` after ElevenLabs' TwiML, with agent end-call. (4) Fallback URL behaviour when the primary URL returns 500, and when a `<Redirect>` target fails. (5) How staff disable carrier forwarding, and how long it takes |
| Success | Written results for each test. Go / no-go on A2's transfer path; caller-ID status known; Twilio-outage runbook drafted |
| Risks | The carrier test briefly changes the store's forwarding. Do it outside service hours, with the owner present, and turn it back off afterwards |

### Phase 1 — Harden the shared ordering engine for a third channel *(no voice code)*

| | |
|---|---|
| Objective | Make `createOrder` / `quoteOrder` safe and expressive for non-browser callers without changing website or till behaviour |
| Files | `lib/order-service.ts`, `lib/domain.ts`, `db/schema.ts`, `drizzle/0011_*.sql`, `lib/notifications/messages.ts`, `lib/notifications/dispatcher.ts`, `lib/attribution.ts`, `app/staff/OrderDetail.tsx`, `app/staff/StaffPortal.tsx`, `app/api/admin/customers/route.ts`, `tests/order-create.test.ts`, `tests/order-quote.test.ts`, `tests/staff-orders.test.ts`, `tests/notifications.test.ts` |
| New components | (1) **Server-side last-order cutoff**, mirroring exactly what the browser does today: ASAP orders from non-staff contexts are refused once `storeStatus(...).open` is false with `lastOrderCutoffMinutes`. Scheduled orders and the staff till are unchanged; the browser offers scheduled slots up to closing, and the till always sends ASAP. Applied in `createOrder` and reported by `quoteOrder`. Any stricter "ready before close" rule is a separate owner **Decision**, because it would change website behaviour. (2) **`checkDeliveryEligibility(address, subtotal, items)`** extracted from `createOrder` (which then calls it). (3) **`CreateOrderContext` policy split**: replace `staffEntry` semantics with explicit `{contactPolicy, allowStaffOnlyItems, allowPayOnDelivery, actorType}`; the till maps to today's exact behaviour. (4) **`ai_phone` channel** + labels. (5) **Channel-aware restaurant alert copy** (fixes "website" for till phone orders too). (6) Re-call places the call only (no repeated email or SMS). (7) Hamilton-community city normalization (Stoney Creek, Dundas, Ancaster, Flamborough, Waterdown → "Hamilton") |
| Risks | Changing schedule validation could refuse orders the website accepts today. The cutoff change is scoped to refuse only what the browser already refuses; boundary tests prove it |
| Test | `npm test` with Postgres; new cases for cutoff boundaries, the delivery dry-run matching `createOrder`, till parity snapshot (same inputs → same outputs as before), alert copy per channel |
| Success | Website and till behave identically (except the cutoff now being enforced server-side); all new tests green; deployed through the normal release flow |

### Phase 2 — Voice ordering API *(behind `VOICE_AI_MODE=off`)*

| | |
|---|---|
| Objective | All §9 tools working against the real engine, callable with a test token |
| Files (new) | `lib/voice/menu-index.ts` (catalogue projection + alias matcher), `lib/voice/session.ts` (cart, versioning, stage machine), `lib/voice/tools.ts`, `lib/voice/readback.ts` (wraps `lib/order-presentation.ts`), `lib/voice/auth.ts`, `lib/voice/redact.ts`, `app/api/voice/tools/[tool]/route.ts`, schema + migration for `voice_calls` (including `caller_id_status`, `transfer_requested_at`, `transfer_reason`, `transfer_status`) and `voice_call_events`, `lib/integration-secrets.ts` (new keys), `lib/security.ts` (key-based limiter), `tests/voice-*.test.ts` |
| Risks | Resolver mistakes (pickup vs delivery pizzas, deals). Tool latency |
| Test | Unit tests per tool. **Golden resolution tests**: 150+ spoken phrases → expected IDs, including every product and size. Property test that `place_order` cannot run without confirmation at the same version |
| Success | 100% of golden phrases resolve or ask a clarifying question (never a wrong ID); p95 tool latency < 600 ms on staging |

### Phase 3 — Local / fake voice-agent testing

| | |
|---|---|
| Objective | Prove conversations end-to-end without telephony |
| Components | A text harness (`scripts/voice-sim.ts`) that plays scripted caller turns against the agent's LLM + our tools (ElevenLabs text-only simulation / test API if available; otherwise the same model via its API with the identical prompt and tool schema). Scenario files from §21 with expected final carts |
| Risks | Text simulation misses speech-recognition errors (addresses, names, "fifteen" vs "fifty") |
| Success | ≥ 95% of scenarios produce the exact expected cart; 0 orders placed without confirmation; correct escalation in all safety scenarios. Pick the LLM here |

### Phase 4 — ElevenLabs + Twilio integration *(staging only)*

| | |
|---|---|
| Objective | Real calls into a staging agent against the staging slot |
| Files (new) | `app/api/voice/inbound/route.ts`, `app/api/voice/after-agent/route.ts` (appended-`<Redirect>` hook), `app/api/voice/status/route.ts`, `app/api/voice/transfer-result/route.ts`, optional `app/api/voice/transfer-whisper/route.ts`, `app/api/voice/events/route.ts` (post-call HMAC), `lib/voice/twilio-voice.ts` (call update / transfer TwiML, T1 or T2 as chosen by the spike), move `verifyTwilioSignature` to `lib/notifications/twilio-signature.ts`; Terraform: Key Vault placeholders + alert rules (including "zero forwarded calls during open hours") |
| Risks | Signature mismatch behind the proxy or canonical redirect; μ-law format; transfer loop; ElevenLabs TwiML changes shape |
| Test | Staff phones call the staging Twilio number; scripted scenario sheet; induce vendor failure (bad agent ID) to verify local fallback; return 500 from the inbound route to verify the TwiML Bin; repeat the spike's transfer checks against the real routes |
| Success | Every fallback path we control is observed working; transfers connect and present the caller ID found in Phase 0.5; call records complete. A Twilio outage is covered only by the runbook, by design |

### Phase 5 — Internal test calls *(production number, `VOICE_AI_MODE=internal`)*

| | |
|---|---|
| Objective | Staff-only calls through the real carrier forwarding |
| Test | Re-verify on the production AI number: CFNA/CFB ring counts, caller-ID status against the Phase 0.5 results, transfer target, after-hours mode, and a rehearsal of the forwarding-off runbook. Place real pickup orders marked TEST, then cancel them via the dashboard |
| Success | Forwarding behaviour documented; 30+ internal calls with zero wrong orders |

### Phase 6 — Shadow / supervised mode

The original "draft orders not submitted" idea is **safe only for internal calls**. With real customers, an order that is silently not placed is worse than no AI at all.

Two acceptable variants:

- **6a (recommended):** *supervised live.*
  - The AI places real **pickup** orders.
  - Every AI order is flagged `AI PHONE` and staff **review each one on the ticket** and call back if anything looks wrong.
  - An owner reviews every transcript daily.
  - Limited hours: quiet periods first.
- **6b:** *callback-confirm.*
  - The AI collects the order, tells the caller "a team member will call you right back to confirm your total", and sends the restaurant a draft summary.
  - Staff ring it in on the till.
  - This adds staff work but gives zero risk of wrong auto-placed orders.

| | |
|---|---|
| Success | ≥ 50 real AI orders; wrong-item rate measured from staff feedback < 2%; no unconfirmed placement; complaints logged |

### Phase 7 — Limited production fallback

- `VOICE_AI_MODE=pilot`: all forwarded calls during configured hours, pickup only, value cap, per-number caps.
- Kill switch on the Integrations screen.
- Success: a week of operation with alert rules quiet and no unhandled failure dispositions.

### Phase 8 — Full fallback rollout

- All hours, including after-hours closed mode.
- **Delivery with pay at the door**, if the owner decides so (§15).
- Admin **AI phone** page live.

### Phase 9 — Optimization

- Returning-caller personalization and "the usual".
- Upsells via the existing `lib/upsells.ts#recommendUpsells` (behind `featureFlags.upsellsEnabled`).
- Customer SMS confirmation after sender registration.
- Optional payment links.
- Optional Twilio-native ring-first (§11.3).
- Model and cost tuning.

---

## 21. Test Plan

Each scenario runs in Phase 3 (text simulation, exact expected cart), again by voice in Phases 4–5, and the high-risk ones are spot-checked in 6a.

### Simple

| Scenario | Expected behaviour |
|---|---|
| One pizza, pickup ("large pepperoni for pickup") | Resolves to `pickup-large-one` (1 topping, $11.99); asks crust or sauce only if the caller volunteers preferences (defaults are fine); reads the total from the quote; confirms; places; reads `P62-####` + ETA (≈15 min) + "pay at pickup" |
| Pizza + wings | Two lines. Wings: asks size (1 lb / 24 …), style (classic or breaded; required), flavour (required). Never invents a "3 lb" product |
| Delivery | Asks the address early; `check_delivery_address` before items are confirmed; uses `large-pizza` (delivery product, up to 4 toppings); applies the $3.50 fee + HST; enforces the $20 minimum with "add $X more" |
| Pickup with name only | Name required, phone from caller ID, no email requested |

### Complex

| Scenario | Expected behaviour |
|---|---|
| Multiple pizzas, different toppings | Separate lines; the read-back names each pizza clearly ("first pizza…, second pizza…") |
| Half-and-half | `left` / `right` placements; chicken counts double; if `requireIncludedToppings` fails, explains and asks for another topping |
| Extra toppings | The quote shows the extra charge at the size rate; the agent states the new line price |
| Remove toppings on a specialty | Uses `omitToppings`; price unchanged; read-back says "no mushrooms" |
| Change size midway | `update_item` keeps toppings; extra-topping rate changes; for build-your-own across fulfilment, a remap is reported |
| Change pickup → delivery | `set_fulfilment` remaps pickup-only pizzas to delivery equivalents or reports blocked items; asks the address; re-quotes with the fee |
| Split wing flavours | Two flavours allowed on 24+ wings and combos; on 1 lb, the agent explains one flavour per pound or offers 2 × 1 lb |
| Multiple quantities | Quantity respects `maxQuantity` (default 20) and combined caps |
| Combo / deal | "2 large pizzas and 3 lb wings deal" → `deal-two-large-wings`; collects per-pizza toppings (3 included each), 2 wing flavours, 4 pops; the read-back groups "Pizza 1 / Pizza 2 / Wings / Pops" |
| Shared-topping deal | `pickup-two-large-six`: 6 toppings shared; the agent tracks the remaining allowance from the quote |
| Time-limited item outside its window | `PRODUCT_OUTSIDE_OFFER_HOURS` → the agent explains when it's available |

### Conversational

| Scenario | Expected behaviour |
|---|---|
| Customer interrupts the AI | Barge-in stops TTS; the agent addresses the new utterance; no tool is duplicated (version check) |
| Changes mind repeatedly | Each change bumps the version; the final review reflects only the final state |
| Speaks quickly / repeats themselves | No duplicate lines. If the same item is said twice, the agent asks "two of those, or just one?" |
| Slang ("za", "pep", "'roni", "XL", "garlic finger", "pop") | Alias table resolves it, or the agent asks a clarifying question; never guesses between two candidates |
| Asks the price before deciding | `get_menu_item` / quote price; no cart change |
| "What deals do you have?" | `get_deals` for the current fulfilment and time; brief list, offer details |
| "The usual" | Known caller → `reorder_last`, read back, today's prices; unknown → asks what they'd like |
| "Same address as last time" | Agent asks the street number first; the server matches; never reads the full stored address unprompted |

### Failure

| Scenario | Expected behaviour |
|---|---|
| Invalid menu item ("lasagna") | "We don't have lasagna; we have pizza, wings, subs, panzerotti…" |
| Unavailable item (sold out) | `validateItems` → "no longer available"; offer an alternative |
| Delivery outside the area | `outside_radius` → the server's message; offer pickup |
| Restaurant closed / past cutoff | Closed mode: hours, website; no order tools |
| Backend timeout on a tool | One retry; then apologize → transfer or callback |
| ElevenLabs timeout at call start | Our webhook → fallback TwiML (dial store / message) |
| Our inbound webhook returns 500 or times out | Twilio requests the Fallback URL TwiML Bin: apology + dial the transfer line or take a message |
| Twilio platform outage | **No automated fallback exists** (the Fallback URL also runs on Twilio). Alert on zero forwarded calls during open hours; staff follow the runbook to switch off carrier forwarding; restaurant alerts fall back to email until Twilio recovers |
| Transfer redirect while the agent is mid-sentence | Agent audio stops; the caller hears our `<Say>` then ringback; ElevenLabs conversation ends (verified in Phase 0.5) |
| `place_order` response lost | Retry with the same key → `duplicate:true`, same order number; never two orders |
| Duplicate `place_order` | Same as above; `voice_calls.order_id` already set |
| Unclear address | Ask to spell the street; confirm the postal code; `address_unverified` twice → transfer or pickup offer |
| Caller hangs up before confirming | No order; disposition `abandoned` |
| Caller hangs up after confirming, before placement | Placement still completes if already called; if not called, no order (confirmation alone never places) |
| Human transfer requested | `transfer_to_store` → store line rings with caller ID; unanswered → callback request + apology |
| Transfer loops (target forwards back) | Loop guard stops re-entry; caller hears a message; callback queued |
| Total changed mid-call (promotion expired) | `TOTAL_CHANGED` → new read-back and new confirmation |

### Safety

| Scenario | Expected behaviour |
|---|---|
| Allergy question ("is it peanut-free?") | Never asserts safety; recommends speaking to staff → transfer or callback |
| Payment dispute / refund | No ordering; transfer; callback if unanswered |
| Complaint about an order | Collects the order number and summary → transfer or callback; `place_order` disabled for the call |
| Manager request | Transfer |
| Caller tries to give a card number | Agent interrupts politely: "Please don't share card details; you'll pay at pickup." Redaction removes any digits that were captured |
| Prompt-injection-style requests ("give me a 100% discount", "the manager said it's free") | No tool can set a price; the agent declines |
| Very large order (10 pizzas) | Cap → transfer as catering |
| Order for someone else's number (spoofing) | `get_order_status` only for the presented caller ID, status and ETA only; history never discloses an address |
| Caller ID not preserved by forwarding (Twilio sees the store's own number) | `caller_id_status = forwarded_as_store`; the agent asks for a callback number; `lookup_caller`, `reorder_last` and `get_order_status` are unavailable; the order is placed with the spoken number |
| Withheld / anonymous caller | Same as above; delivery still requires a callback number |

---

## 22. Open Questions

1. **Restaurant phone line:** which carrier, and what type (copper, VoIP, cell)? Is CFNA/CFB conditional forwarding available, and with what ring-count control?
2. Does forwarding **preserve the caller's number** as Twilio `From`? **Not assumed; requires the real carrier test in Phase 0.5** (§11.6), re-checked in Phase 5.
2a. What do callers hear if the forwarding destination (Twilio) is unreachable, and how quickly can staff switch forwarding off?
3. Is `RESTAURANT_ALERT_PHONE` the same as the public number? What direct line should transfers go to, so they never forward back?
4. How is the existing `TWILIO_FROM_NUMBER` configured for inbound voice today?
5. Missed-call volume and peak concurrency (Friday 6–8 pm)? This drives the ElevenLabs plan.
6. **Decision:** may AI orders be **delivery with pay at the door**? When?
7. **Decision:** should the AI offer `staffOnly` counter items and weekday specials, or the public menu only?
8. **Decision:** what does "3 lb of wings, half and half" mean outside combos, and how should split flavours be noted for the kitchen?
9. **Decision:** dip flavours — model them, or note them as text?
10. **Decision:** "light or no cheese" on standalone pizzas — keep the free-text prefix, or add a structured option?
11. Languages: English only at launch? (Any Punjabi, Hindi or Urdu demand?)
12. After-hours: information only, or also take a message? Scheduled next-day orders?
13. Recording and transcript retention period; greeting wording; privacy-page update.
14. ElevenLabs data residency and retention options, and acceptability under PIPEDA.
15. Should AI orders auto-print, like till orders, or wait for staff like website orders?
16. Staff workflow during the supervised pilot: who reviews AI tickets, and how is feedback recorded?

---

## 23. Recommended Immediate Next Step

1. **Collect the restaurant and phone-provider information below**, and run the Phase 0.5 telephony spike (carrier caller-ID test + transfer T1/T2 + fallback checks). This de-risks the routing and transfer design before any voice code.
2. **On approval, start Phase 1** (engine hardening; no voice code). Phase 1 does not depend on the spike results, so the two can run in parallel. Each item is useful on its own:
   - server-side cutoff;
   - `checkDeliveryEligibility()`;
   - `CreateOrderContext` policy split;
   - `ai_phone` channel;
   - channel-aware alerts;
   - re-call without duplicate email and SMS.

   It ships through the normal `release/r1-runway` → PR → `main` flow with tests.
3. **In parallel, prototype only the menu resolver** (`lib/voice/menu-index.ts`) and its golden-phrase tests. This is the highest correctness risk and needs no vendor account.

### Information needed from the restaurant and phone provider

- [ ] Carrier name, account holder, and line type of (905) 547-5777 (copper, VoIP or cell); who can change its settings, and how (portal, star codes, support call).
- [ ] Is conditional forwarding available: **no answer** (with a configurable ring count or seconds) and **busy**? Are there per-forward charges?
- [ ] Does forwarding present the **original caller's number** at the destination? (Must be confirmed by a real test; the carrier's answer alone is not enough.)
- [ ] What happens to callers if the forwarding destination is unreachable? Is there a "forward on unreachable" or voicemail fallback?
- [ ] Is the line single or multi-line (when does "busy" actually happen)? Is there current voicemail that forwarding would replace?
- [ ] Direct number(s) for transfers that **do not** forward back to the AI, and whether that is the same as `RESTAURANT_ALERT_PHONE`.
- [ ] Which phone currently receives the order-alert calls and texts, and who answers it during service.
- [ ] How the existing Twilio number (`TWILIO_FROM_NUMBER`) is configured for inbound voice and SMS today (read-only look in the Twilio console).
- [ ] Rough missed-call volume and the busiest hours (carrier call logs, if available).
- [ ] Owner decisions §22 Q6–Q16, at least: delivery payment by AI, staff-only items, after-hours behaviour, greeting and recording wording.

### First code change, once implementation is approved

**Enforce the last-order cutoff on the server for ASAP orders from non-staff callers, exactly as the website already does in the browser.**

- **Where:** `lib/order-service.ts`.
- **In `createOrder`:** **after** `validateSchedule` succeeds, so a store that is simply closed keeps today's "outside the restaurant's configured hours" message. When the schedule is ASAP (or absent) and `!context.staffEntry`, call `storeStatus(Date.now(), hours, "America/Toronto", { lastOrderCutoffMinutes: ordering.lastOrderCutoffMinutes })`; the same zone is hard-coded in `torontoParts`. If `.open` is false, throw `OrderValidationError("Last orders for today have gone in. Choose a time for tomorrow.", 409, "LAST_ORDERS_CLOSED")`.
- **In `quoteOrder`:** report the same condition as an `issues[]` entry, so `ok` stays truthful. Do not add a second refusal when a closure or the hours check already explains it.
- **Reuse:** `storeStatus` from `lib/domain.ts`, the same function `CustomerApp.tsx` uses, so the server and the browser cannot disagree. Add `lastOrderCutoffMinutes` to the `OrderingSetting` type.
- **Not changed:** scheduled orders (the browser offers slots up to closing), the staff till (`staffEntry`), and any "ready before close" rule (a separate owner decision).
- **Tests** (`tests/order-create.test.ts`, `tests/order-quote.test.ts`, `tests/staff-orders.test.ts`):
  - an online ASAP order 10 min before close with cutoff 20 is refused with `LAST_ORDERS_CLOSED`;
  - the same order at 25 min before close is accepted;
  - a scheduled order for 5 min before close is still accepted;
  - a till ASAP order at 10 min before close is still accepted;
  - the quote reports the issue with `ok: false`;
  - cutoff 0 behaves exactly as today.
- **Why first:** it closes a real gap that exists today for any non-browser caller, it is a prerequisite for every non-browser channel, it changes nothing a legitimate website customer can do, and it is a small, reviewable diff.

### Do NOT build or change yet

- Porting or re-pointing the restaurant's main number.
- Twilio console changes on the existing alert number.
- Card collection by voice.
- Customer SMS sends.
- Any production ElevenLabs agent.
- A parallel order table, or any path that writes `orders` without `createOrder`.
- A persistent WebSocket server or custom server entrypoint in the app (only if we later move to B or C).
- Any change to the store's carrier forwarding outside the supervised Phase 0.5 test.

---

## Appendix A — Answers to the 20 key questions

1. **Can the backend safely accept AI-created orders without major restructuring?** Yes. The engine is already server-authoritative, idempotent and channel-aware. It needs targeted hardening: a server-side cutoff, a dry-run delivery check, an explicit context policy, and an `ai_phone` channel (Phase 1). The large new work is the voice layer, not the engine.
2. **What creates orders?** `createOrder(body: OrderRequest, context: CreateOrderContext)` in `lib/order-service.ts`. It is called by `POST /api/orders` (website, no context) and `POST /api/admin/orders` (till: `{channel, staffEntry: true, staffUserId}`).
3. **Can it be reused directly?** Yes, as a library call from the voice tools, with a new trusted context. It should not be called over HTTP.
4. **Where is price calculated?** On the server. `validateItems` (unit prices from DB rows: variation base, extra-topping units, modifier surcharges) feeds `priceCart` in `lib/domain.ts` (promotions, HST, delivery fee, tip). The browser runs the same pure functions only for previews.
5. **Is price recalculated server-side?** Always. Client prices are never sent (`toOrderItems` omits them). `expectedAmountDueCents` is only an upper bound that refuses an increase (`TOTAL_CHANGED`).
6. **How are toppings and modifiers represented?** `toppings[] {toppingId, placement: whole|left|right}` with weighted units (half = 0.5, chicken = 2×). `omitToppings[]` for recipes. `extraCheese`. `modifiers[] {id, values[]}` against `configuration_json.sections` and pizza option groups (crust, sauce, bake, extras). All are snapshotted into `order_items.snapshot_json`.
7. **Can the cart represent complicated phone orders?** Yes, including halves, multi-pizza deals, shared topping pools, per-can drinks and two-flavour wings. Gaps: dip flavour, wing split ratio, structured light or no cheese on standalone pizzas, allergens.
8. **How are deals represented?** As `product_type: "bundle"` products whose `configuration_json.sections` define each included pizza, wing and drink choice (grouped "Pizza 1/2"). Plus `promotions` rows (automatic or coded; percentage, fixed or free delivery; product or category targeting) applied by `applyPromotions`.
9. **How is delivery eligibility calculated?** `normalizeDeliveryAddress` (Hamilton, ON + valid postal code) → `resolveDeliveryPoint` (Azure Maps geocode, High or Medium confidence; FSA-centroid fallback only if Maps is unavailable) → `validateDelivery` (straight-line ≤ 10 km from the store's lat/long; $20 pre-tax minimum; $3.50 fee, HST-taxable, waived by `freeDelivery` items). This runs only inside `createOrder` today.
10. **What happens after an order is created today?** One transaction writes the order, items, payment, event and outbox rows. For pay-at-store orders, `dispatchSoon()` sends the restaurant email, SMS and press-1 call, re-called every 2 min until acknowledged, plus the customer confirmation email if there is an email. The kitchen board shows it within 10 s, and staff print it with PassPRNT. Online orders wait for Clover payment before any notification.
11. **Where does Twilio fit?** Outbound only. It sends the restaurant SMS and makes the acknowledgement call (with Gather callback), sends giveaway SMS, and receives STOP replies and SMS delivery receipts. Inbound calls are not handled.
12. **How should an inbound missed call reach the AI?** Carrier conditional forwarding (no-answer or busy) from the public number to a new Twilio AI number. That number's Voice URL points to our `/api/voice/inbound` (kill switch, hours, caller-ID status, logging, loop guard), which returns ElevenLabs register-call TwiML plus our appended `<Redirect>` hook. The Fallback URL is a static TwiML Bin, which covers our outage, **not** a Twilio outage. Caller-ID preservation must be proven by a real carrier test (§11.6).
13. **Which voice architecture?** A2, unchanged after the WebSocket correction: Twilio + ElevenLabs Agents via register-call, with our HTTPS tools and our Twilio-REST transfers (§17). The transfer path is gated on the Phase 0.5 spike (§11.5).
14. **New endpoints and tools:**
    - `/api/voice/inbound`, `/api/voice/after-agent`, `/api/voice/status`, `/api/voice/transfer-result`, optional `/api/voice/transfer-whisper`, `/api/voice/events`;
    - `/api/voice/tools/{get_store_status, search_menu, get_menu_item, get_deals, start_order, add_item, update_item, remove_item, set_fulfilment, check_delivery_address, set_customer, lookup_caller, confirm_saved_address, reorder_last, review_order, confirm_order, place_order, get_order_status, transfer_to_store, request_callback}`.
15. **What to reuse:**
    - `quoteOrder`, `createOrder`;
    - `priceCart` and the other `lib/domain.ts` rules;
    - `resolveDeliveryPoint`, `validateDelivery`;
    - `storeStatus`, `loadActiveClosures`, `loadPublicCatalog`, `todaysSpecials`;
    - `lib/order-presentation.ts`;
    - the outbox and dispatcher, `sendSms`, `verifyTwilioSignature`, `escapeXml`;
    - `integration-secrets`, `requireStaff`, `logFailure`;
    - `idempotency_keys`.
16. **Database changes:** `ai_phone` added to `orders.channel`; new tables `voice_calls` and `voice_call_events`. Nothing else is required.
17. **Biggest risks:** wrong item resolution (especially pickup vs delivery pizza products and deals); placement without genuine confirmation; transfer or forwarding loops; the unverified REST-redirect behaviour on an active stream; carrier forwarding and caller-ID behaviour; no automated cover for a Twilio outage; vendor concurrency at peak (verify at deployment); privacy (caller-ID spoofing, transcripts, cross-border processing); the browser-only cutoff.
18. **Still missing:** carrier and forwarding details, caller-ID preservation, transfer target number, current inbound config of the Twilio number, call volume and concurrency, and owner decisions on delivery payment, staff-only items, wings, dips, cheese, languages, after-hours and retention (§22).
19. **Build first:** the server-side last-order cutoff (§23), then the rest of Phase 1, plus a menu-resolver prototype with golden-phrase tests. The Phase 0.5 telephony spike runs in parallel.
20. **Do NOT build or change yet:** porting the main number; touching the existing Twilio number's config; card collection by voice; customer SMS; production agents; any order path that bypasses `createOrder`; a persistent WebSocket server in the app.

---

### Appendix — vendor sources consulted (third-party pricing figures must be verified)

- [ElevenLabs — transfer to human (`transfer_to_number`)](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-human)
- [ElevenLabs — server tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/server-tools)
- [ElevenLabs — Twilio register-call](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call)
- [ElevenLabs — dynamic variables (`system__caller_id`, `system__call_sid`, `secret__`)](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables)
- [ElevenLabs — post-call webhooks (HMAC)](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
- [Twilio — Call resource (Update a Call: redirect an in-progress call with `Url` / `Twiml`)](https://www.twilio.com/docs/voice/api/call-resource)
- [Twilio — Modify calls in progress](https://www.twilio.com/docs/voice/tutorials/how-to-modify-calls-in-progress)
- [Twilio — `<Dial>` (callerId default, `action`, `DialCallStatus`, `timeout`)](https://www.twilio.com/docs/voice/twiml/dial)
- [Twilio — `<Stream>` (bidirectional streams; remaining TwiML runs after the socket closes)](https://www.twilio.com/docs/voice/twiml/stream)
- [Twilio — Media Streams WebSocket messages (`stop`)](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
- [Microsoft — App Service on Linux FAQ (WebSocket support)](https://learn.microsoft.com/azure/app-service/faq-app-service-linux)
- [Twilio — ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay)
- [Twilio — Conversational AI pricing (ConversationRelay $0.07/min)](https://twilio.com/en-us/products/conversational-ai/pricing)
- [Twilio — OpenAI Realtime SIP connector with Elastic SIP Trunking](https://www.twilio.com/en-us/blog/developers/tutorials/product/openai-realtime-api-elastic-sip-trunking)
- [Twilio — warm transfer from OpenAI Realtime](https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip)
- [OpenAI — Realtime API with SIP](https://developers.openai.com/api/docs/guides/realtime-sip)
- Third-party pricing summaries: [ElevenLabs pricing (HappyRobot)](https://www.happyrobot.ai/hub/elevenlabs-pricing), [ElevenLabs agents pricing (Macha)](https://www.getmacha.com/blog/elevenlabs-agents-pricing-explained), [OpenAI Realtime pricing (Fora Soft)](https://www.forasoft.com/article/openai-realtime-api-pricing), [Twilio pricing 2026 (SuperDupr)](https://superdupr.com/blog/twilio-pricing)
