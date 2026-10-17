# ElevenLabs Voice Tools — Contract for the Pizza 62 AI Receptionist

**Website parity (17 October 2026, later):** six tools were added and three changed so a caller can do by voice what the website's ordering flow does: business facts (`get_business_info`), orders for later (`get_order_slots`, `set_schedule`), promo codes (`apply_coupon`, `remove_coupon`), tips (`set_tip`), and the website's cheese step (`cheese` on `add_item`/`update_item`). Gift cards and card payment remain deliberately unavailable by voice. The full audit, the reasons and the rollout checklist are in [VOICE-WEB-PARITY.md](VOICE-WEB-PARITY.md). This code is local and not yet deployed; the ElevenLabs workspace still has the earlier 16 tools.

**Status (17 October 2026):** the tool API and Phase 4 staging telephony routes are implemented. The build has passed staging deployment and smoke checks; production promotion is pending the normal GitHub Actions flow. Provider configuration remains untouched. `VOICE_AI_MODE` remains `off` by default, so tool calls return `503` and signed inbound calls receive a spoken fallback until internal testing is explicitly configured. This document describes the API as implemented in `lib/voice/tools.ts` and `app/api/voice/tools/[tool]/route.ts`. Every example below is a real response captured from those functions against the test database. The examples use a Wednesday at 6:00 PM, when the store is open.

Read it with `docs/AI-RECEPTIONIST-ARCHITECTURE.md`. That file covers the call routing, the transfer design and the rollout phases. This one covers what the agent's tools are and how to configure them.

---

## 1. The rule that matters most

**The model interprets; the server decides.** The agent turns speech into tool calls. Every product id, option, price, tax, fee, free delivery, eligibility decision, opening hour and order write is decided by server code: `quoteOrder` and `createOrder` in `lib/order-service.ts`, with the `ai_phone` order policy.

The ElevenLabs tool configuration must **never** give the model a parameter for any of the following. The server refuses each of them by name (`FIELD_NOT_ACCEPTED`) if one ever arrives:

| Never a parameter | Why it is server-controlled |
|---|---|
| prices (`price`, `priceCents`, `unitPriceCents`, `lineTotalCents`) | Prices come from the database through `validateItems` |
| subtotal (`subtotal`, `subtotalCents`, `menuSubtotalCents`) | Calculated by `priceCart` |
| tax (`tax`, `taxCents`) | HST is calculated by `priceCart` |
| total (`total`, `totalCents`, `amountDueCents`, `expectedAmountDueCents`) | Set by `place_order` from the confirmed review |
| delivery fee (`fee`, `deliveryFee`, `deliveryFeeCents`) | Comes from the delivery settings and the cart |
| `freeDelivery` | Comes from the products in the validated cart |
| discounts (`discount`, `discountCents`, `couponCode`, `giftCardCode`, `promotion`, `promotionId`) | Automatic promotions apply on the server. A promo code is given only as `apply_coupon`'s `code` string; the server decides whether it is valid and what it takes off |
| gift cards (`giftCardCode`, `giftCard`, `balanceCents`, `appliedCents`) | Never taken by voice: a gift card code is spendable money that must not enter a transcript (VOICE-WEB-PARITY.md §4) |
| tip (`tip`, `tipCents`, `tipAmountCents`, `amountCents`) | Given only through `set_tip`: none, a preset percentage, or a dollar amount the caller names. The server prices it |
| times (`schedule`, `scheduledFor`, `estimatedFor`) | Given only through `set_schedule` as a day and a clock time. The server matches them to the website's own slots |
| channel (`channel`) | Always `ai_phone`, from the trusted server context |
| staff privileges (`policy`, `staffEntry`, `staffUserId`, `context`, `actorId`) | The AI context is fixed server-side and is never a staff context |
| idempotency keys (`idempotencyKey`) | Always `voice:<session id>:<cart version>`, built by `place_order` |
| payment (`paymentMethod`, `paymentToken`, `card`, `cardNumber`, `cvv`, `expiry`) | Voice orders are pay at the store (or the driver). No card data is ever taken |

Unknown argument names are also refused (`UNKNOWN_FIELD`). The server never drops them silently.

---

## 2. Connecting a tool

Every tool is an ElevenLabs **webhook (server) tool**:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `{PUBLIC_BASE_URL}/api/voice/tools/<tool_name>`, for example `https://order.pizza62.ca/api/voice/tools/add_item`. Use the canonical host: the middleware redirects other hosts |
| Content type | `application/json` |
| Body | The tool's parameters only (see each tool). Every value is model-supplied. **None is session-derived**: session state lives on the server |
| Header `Authorization` | `Bearer <VOICE_TOOL_SECRET>`. Store the value as an ElevenLabs workspace secret. It is the same for every call |
| Header `X-Voice-Session` | The **per-call session secret**. It is minted by our backend for each call and handed to ElevenLabs as a secret dynamic variable (`secret__voice_session`). Configure the header as a dynamic-variable reference, `{ "variable_name": "secret__voice_session" }`, **not** the template string `{{secret__voice_session}}`, which is sent unexpanded and opens nothing (`401`) |

### How the two credentials work together

- **`VOICE_TOOL_SECRET`** proves the request comes from our ElevenLabs workspace. It is compared in constant time. If it is unset, or shorter than 32 characters, nothing authenticates.
- **`X-Voice-Session`** names one call's session and opens only that one. It is returned once when the session is minted and is stored only as a SHA-256 hash (`voice_calls.session_secret_hash`). A leaked bearer token alone cannot read or change any call. Session A's secret cannot affect session B. No request parameter can name another session, and a `sessionId` field is refused as unknown.
- A session expires 30 minutes after it starts. Expired or closed sessions return `401`.

**Who mints sessions.** `/api/voice/inbound` verifies Twilio's signature, checks internal mode, the staff allowlist and destination number, creates the `voice_calls` row through `createVoiceSession()`, and passes the secret to register-call as `conversation_initiation_client_data.dynamic_variables.secret__voice_session`. Only this signed inbound route may mint sessions over HTTP.

**Verified vendor behavior.** Secret dynamic variables use the `secret__` prefix, are usable only in webhook tool headers, and are excluded from the LLM prompt/first message. ElevenLabs returns their values as `<REDACTED>` in post-call webhooks and conversation APIs. `voice_session_id` is therefore sent separately as a non-secret identifier for post-call association. Never put the session secret into a prompt, ordinary variable or tool argument. See [ElevenLabs dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables).

### HTTP status codes

| Status | Meaning | Agent behaviour |
|---|---|---|
| `200` | The tool ran. Read `ok`, `issues`, `say` and `data`. **Business refusals are `200` with `ok: false`** | Act on the issues |
| `400` | The body was not JSON | Treat as a tool failure |
| `401` | Bad or missing bearer token, or a missing, invalid or expired session | Apologize and transfer. Do not retry |
| `404` | No such tool | Configuration error |
| `413` | Body over 16 KB | Configuration error |
| `500` | A fault on our side | Retry once. If it fails again, apologize and transfer |
| `503` | `VOICE_AI_MODE` is `off` (`VOICE_DISABLED`) or no tool secret is set (`VOICE_NOT_CONFIGURED`) | Apologize and transfer |

### The response envelope

Every response, success or refusal, has this shape:

```json
{
  "ok": true,
  "data": { "...": "tool-specific" },
  "issues": [{ "code": "SIZE_REQUIRED", "message": "Which size: Medium, Large, X-Large?", "lineId": "L2", "field": "variationId" }],
  "say": "A sentence written by the server, safe to read to the caller as it is.",
  "escalate": false,
  "cartVersion": 4,
  "stage": "building"
}
```

- **`say`** is written by the server. Prefer it to composing text, especially for prices, totals, the read-back and the order number.
- **`escalate: true`** means hand the caller to a person. It is set after **three consecutive failed tool calls**, for an order over `VOICE_MAX_ORDER_CENTS`, and when a session reaches its tool-call limit (150). A successful call resets the failure count.
- **`cartVersion`** is the version of the working order after the call. `confirm_order` and `place_order` require it, and every mutation accepts it as `expectedCartVersion`.
- **`stage`** is one of `new`, `fulfilment`, `building`, `address`, `review`, `confirmed`, `placing`, `placed`, `closed` (see §4).

---

## 3. What the agent should do overall

1. **`get_store_status`** at the start. If `acceptingOrdersNow` is false but `acceptingScheduledOrders` is true, the order can still be taken **for later**, as on the website: read `say`, which names the earliest time. Take no order only when both are false. For the address, phone number, website or hours, call **`get_business_info`**; never answer them from memory.
2. **`start_order`** with `fulfilment` when the caller says pickup or delivery. **Delivery is not available by phone** until the owner enables it (`VOICE_PILOT_FULFILMENTS=pickup,delivery`). Until then, offer pickup.
2a. If the caller wants it later ("tomorrow at 11:30", "5:45 tonight"), call **`set_schedule`** with the day and time as they said them; `get_order_slots` answers "what times can I get?". The server decides whether a time is possible.
3. For each item: **`search_menu`** → (if needed) **`get_menu_item`** → **`add_item`** with the ids it returned. Ask the caller whenever the result is `ambiguous`, an option section is `required`, or `add_item` reports an issue.
4. **`set_customer`**: a name and a callback number. Never treat caller ID as identity. Read the number back.
4a. Only if the caller brings them up: a promo code with **`apply_coupon`**, a tip with **`set_tip`**. Never suggest a tip amount, never say what a code is worth before the server answers, and never take a gift card or card number.
5. For delivery: **`check_delivery_address`** (stores the address when it is one we serve).
6. **`review_order`**, then **read its `say` (the read-back) to the caller exactly as written**.
7. If the caller says yes to the whole read-back: **`confirm_order`** with the `cartVersion` from the review. If they change anything, make the change and call **`review_order` again**. The old confirmation is void.
8. **`place_order`** with the same `cartVersion`. Read the order number and time from `say`. If the call times out or errors, call `place_order` again with the same `cartVersion`. It returns the same order (`duplicate: true`) and never places a second one.

Hand the caller to a person (when transfer exists) for complaints, refunds, a manager, allergies, catering or large orders, changes to an order already placed, anything the tools refuse twice, or `escalate: true`.

---

## 4. The server-enforced stages

```
new ──start_order──► fulfilment ─set_fulfilment─► building ◄──► address (delivery without an address)
                                                     │  ▲
                                         review_order│  │any change (add/update/remove/fulfilment/customer/address/time/code/tip)
                                                     ▼  │      → cart_version + 1, review and confirmation cleared
                                                  review ──confirm_order(cartVersion)──► confirmed
                                                                                          │
                                                               place_order(cartVersion) ──┤
                                                                                          ▼
                                                                     placing ──createOrder ok──► placed (final)
                                                                        └─refused──► building (needs a new review)
```

What the server refuses, whatever the prompt says:

| Attempt | Result |
|---|---|
| Any change before `start_order` | `ORDER_NOT_STARTED` |
| `add_item` before a fulfilment is set | `FULFILMENT_REQUIRED` |
| `confirm_order` before `review_order` | `NOT_REVIEWED` |
| `confirm_order` for an older `cartVersion` | `CART_CHANGED` |
| `place_order` before review or confirmation | `NOT_REVIEWED` / `NOT_CONFIRMED` |
| `place_order` for a version other than the confirmed one | `CART_CHANGED` |
| `place_order` more than 5 minutes after the yes | `CONFIRMATION_EXPIRED` (the read-back stands; confirm again) |
| `place_order` when the total changed since the yes (up **or** down) | `TOTAL_CHANGED` (review again) |
| `place_order` while another placement is in flight | `PLACEMENT_IN_PROGRESS` (retry in a moment) |
| Any change, or a new order, after placement | `ORDER_ALREADY_PLACED` |
| A change sent with a stale `expectedCartVersion` | `CART_CHANGED` |

The rules live in `lib/voice/session.ts`, where each transition is a single conditional `UPDATE … RETURNING`. Database `CHECK` constraints make the half-states impossible to store: a confirmation of a version other than the reviewed one, or a placed session with no order.

---

## 5. The tools

The **"Description for the LLM"** text under each tool is written to be pasted into the ElevenLabs tool description.

### 5.1 `get_store_status`

**Description for the LLM:** Check whether Pizza 62 is taking orders right now, whether it can take an order for later (even while closed), when last orders are, and whether pickup and delivery are available by phone. Call at the start of every call. If acceptingOrdersNow is false but acceptingScheduledOrders is true, offer to take the order for a later time.

**Parameters:** none.

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

**Success:**

```json
{
  "ok": true,
  "data": {
    "acceptingOrdersNow": true, "open": true, "lastOrdersAt": "9:40 PM", "asapCutoffPassed": false,
    "closesAt": "10:00 PM", "nextOpenAt": null, "paused": false, "pauseMessage": null, "closureMessage": null,
    "pickup": { "enabled": true, "acceptingNow": true, "estimateMinutes": 15 },
    "delivery": { "enabled": true, "availableByPhone": false, "acceptingNow": false, "estimateMinutes": 30 }
  },
  "say": "We're taking orders until 9:40 PM. Pickup takes about 15 minutes. By phone we can take pickup orders only.",
  "escalate": false, "cartVersion": 0, "stage": "new"
}
```

Added for website parity: `acceptingScheduledOrders`, `pickup.earliestScheduled` and `delivery.earliestScheduled` (`{ at, date, time, when }`, for example `"tomorrow at 11:00 AM"`), and `scheduling` (`intervalMinutes: 15`, `latest`: the last time the website's checkout offers, `{ at, date, time, when }`). `nextOpenAt` is now spoken form (`"tomorrow at 11:00 AM"`). When closed, `say` ends with *"I can take a pickup order for later; the earliest time is tomorrow at 11:00 AM."*

**After it:** if `acceptingOrdersNow` is false, read `say`. If `acceptingScheduledOrders` is true, the caller may order for later, exactly as the website lets them; otherwise take no order. The last-order cutoff (20 minutes before close) stops ASAP orders only, as on the website. Closures and pauses come from the same settings the website uses; a pause stops scheduled orders too.

### 5.2 `search_menu`

**Description for the LLM:** Find menu items matching what the caller said, for example "large pepperoni" or "24 honey garlic wings". Returns real menu ids. Never guess an id; always use one from this tool. If the status is `ambiguous`, ask the caller the `clarify` question. Search one item at a time.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string, up to 200 characters | yes | The caller's words for **one** item |
| `fulfilment` | `"pickup"` \| `"delivery"` | no | Defaults to the order's fulfilment. It matters: build-your-own pizzas are different products for pickup and delivery |
| `category` | string (category id) | no | Narrows the search to one menu section |

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "The caller's words for one item." },
    "fulfilment": { "type": "string", "enum": ["pickup", "delivery"] },
    "category": { "type": "string" }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

`data.status` is one of:

- `match`: exactly one product. `candidates[0]` has the ids to pass to `add_item`, plus `detected` hints (toppings with placement, omissions, extra cheese, options such as a wing sauce). Hints are never applied automatically.
- `ambiguous`: two or more plausible products, or a partial match. Ask `clarify`.
- `unavailable`: the item exists but cannot be ordered now. `unavailableReason` is `sold_out`, `outside_offer_hours` (with `availabilityLabel`), `setup_required`, `not_for_fulfilment` or `size_not_offered`.
- `no_match` (`ok: false`, issue `NO_MATCH`): nothing on the menu matches. Words nothing explained are listed in `unrecognized`.

**Example, match** (`{"query":"large pepperoni","fulfilment":"pickup"}`):

```json
{
  "ok": true,
  "data": {
    "status": "match",
    "candidates": [{
      "productId": "pickup-large-one", "name": "Large Pizza · 1 Item", "category": "Pickup Specials",
      "variationId": "pickup-large-one-size", "variationName": "Large", "sizes": [], "priceCents": 1199,
      "fulfilments": ["pickup"], "available": true, "unavailableReason": null, "availabilityLabel": null,
      "suggestedQuantity": null,
      "detected": { "toppings": [{ "toppingId": "pepperoni", "name": "Pepperoni", "placement": "whole" }],
                    "omitToppings": [], "extraCheese": false, "options": [] }
    }],
    "clarify": null, "unrecognized": [], "ambiguousToppings": []
  },
  "say": "That's the Large Pizza · 1 Item, $11.99.",
  "escalate": false, "cartVersion": 0, "stage": "new"
}
```

**Example, ambiguous** (`{"query":"large pizza","fulfilment":"pickup"}`). Pickup large pizzas come as a 1-topping and a 3-topping special:

```json
{
  "ok": true,
  "data": {
    "status": "ambiguous",
    "candidates": [
      { "productId": "pickup-large-one", "name": "Large Pizza · 1 Item", "priceCents": 1199, "...": "..." },
      { "productId": "pickup-large-three", "name": "Large Pizza · 3 Items", "priceCents": 1499, "...": "..." }
    ],
    "clarify": "Did you mean Large Pizza · 1 Item or Large Pizza · 3 Items?"
  },
  "say": "Did you mean Large Pizza · 1 Item or Large Pizza · 3 Items?"
}
```

**Example, no match** (`{"query":"lasagna"}`):

```json
{ "ok": false, "data": { "status": "no_match", "candidates": [], "unrecognized": ["lasagna"] },
  "issues": [{ "code": "NO_MATCH", "message": "Nothing on the menu matches that." }],
  "say": "Sorry, we don't have that on our menu." }
```

**After it:** on `match`, confirm any detail the caller has not given (size, required options) using `get_menu_item`, then `add_item`. On `ambiguous`, ask `clarify`. On `no_match`, say so and offer what we do have; never invent an item. `ambiguousToppings` (for example "olives": Green Olives or Black Olives) must be asked about. The resolver's behaviour is pinned by 254 golden phrases in `tests/voice-menu-resolver.test.ts`, with zero wrong products.

### 5.3 `get_menu_item`

**Description for the LLM:** Get everything needed to configure one menu item: its sizes and prices, recipe, toppings, and every option section with which ones are required and how many choices each allows. Call it before adding anything that has sizes or required choices.

| Parameter | Type | Required |
|---|---|---|
| `productId` | string (from `search_menu`) | yes |
| `fulfilment` | `"pickup"` \| `"delivery"` | no |

```json
{
  "type": "object",
  "properties": {
    "productId": { "type": "string" },
    "fulfilment": { "type": "string", "enum": ["pickup", "delivery"] }
  },
  "required": ["productId"],
  "additionalProperties": false
}
```

**Returns:** `name`, `description`, `kind`, `fulfilments`, `available`/`unavailableReason`, `priceCents`, `sizes[]` (`variationId`, `name`, `priceCents`, `extraToppingPriceCents`, `includedToppings`), `sizeRequired`, and for pizzas a `pizza` block. That block holds `recipe` (a specialty's toppings, included automatically), `requiresIncludedToppings`, and notes on halves (a half counts as half a topping), chicken (counts as two) and cheese (`extraCheese`; light or no cheese goes in `notes`). It also holds the topping list. `sections[]` gives `id`, `label`, `group` (for example "Pizza 1"), `required`, `min`, `max`, `choosesToppings`, `included`, `extraPriceCents`, `sharedAllowance` and `options[]` (`value` and `priceCents`). Then `maxQuantity` and `notesAllowed`. The sections are exactly the ones `validateItems` checks (`orderableSections`).

**Example** (`{"productId":"24-wings"}`, abridged):

```json
{
  "ok": true,
  "data": {
    "productId": "24-wings", "name": "24 Wings", "kind": "wings", "fulfilments": ["pickup", "delivery"],
    "available": true, "priceCents": 3099, "sizes": [], "sizeRequired": false, "pizza": null,
    "sections": [
      { "id": "wing-flavours", "label": "Sauces & dry rubs", "required": true, "min": 1, "max": 2,
        "options": [{ "value": "Mild", "priceCents": 0 }, { "value": "Honey Garlic", "priceCents": 0 }, "..."] },
      { "id": "wing-style", "label": "Wing style", "required": true, "min": 1, "max": 1,
        "options": [{ "value": "Classic (non-breaded)", "priceCents": 0 }, { "value": "Breaded", "priceCents": 0 }] }
    ],
    "maxQuantity": 20, "notesAllowed": true
  }
}
```

**Failure:** `PRODUCT_NOT_FOUND` for an unknown id, an inactive item or a counter-only (`staffOnly`) item. Counter-only items are not in the public catalogue at all.

**After it:** ask the caller each `required` section in `label` order, then call `add_item` with `modifiers: [{ id, values }]`.

### 5.4 `get_deals`

**Description for the LLM:** List the deals and specials available right now (combos, 2-for-1s, pickup specials, time-limited offers) with their current prices, plus any automatic promotions. Call when the caller asks what deals there are.

| Parameter | Type | Required |
|---|---|---|
| `fulfilment` | `"pickup"` \| `"delivery"` | no (defaults to the order's) |

**Returns:** `deals[]` (`productId`, `name`, `category`, `priceCents`, `description`, `fulfilments`, `availabilityLabel`) and `automaticPromotions[]` (`name`, `description`, `minimumCents`). Only items that are on now, for that fulfilment, at live prices. `say` reads the first four, for example *"Today's deals include 2 Large Pizzas & 3 lb Wings for $53.99; 2 Medium Pizzas & 2 lb Wings for $43.99; …"*.

### 5.5 `start_order` / `reset_order`

**Description for the LLM (`start_order`):** Start the caller's order, with pickup or delivery if they have said. Call once before adding items. Calling it again starts over with an empty order.

**Description for the LLM (`reset_order`):** Empty the order and start again, keeping pickup or delivery and the caller's name and number. Use when the caller wants to start over.

| Tool | Parameter | Type | Required |
|---|---|---|---|
| `start_order` | `fulfilment` | `"pickup"` \| `"delivery"` | no |
| `reset_order` | none | | |

Both work inside the call's existing session; neither creates a session. `VOICE_DELIVERY_UNAVAILABLE` is returned for delivery while voice delivery is off. `ORDER_ALREADY_PLACED` is returned after placement.

### 5.6 `add_item`

**Description for the LLM:** Add one item to the order using ids from `search_menu` or `get_menu_item`. Include the size (`variationId`) when the item has sizes, the toppings with their placement, recipe toppings to leave off (`omitToppings`), the cheese choice (`cheese`: none, light, regular or extra) for pizzas, and the choices for each option section (`modifiers`). Never send prices. The server prices the order and returns the new total.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `productId` | string | yes | From `search_menu` / `get_menu_item` |
| `variationId` | string | when the item has more than one size | Products with a single size get it automatically |
| `quantity` | integer 1–100 | no (1) | Capped by the item's `maxQuantity` |
| `toppings` | array of `{ toppingId, placement }` | no | `placement` is `whole`, `left` or `right`. For a specialty pizza, **additions only**: its recipe is added by the server |
| `omitToppings` | array of topping ids | no | Recipe toppings to leave off a specialty pizza. The price does not change |
| `extraCheese` | boolean | no | Pizzas only. The older form of `cheese: "extra"` |
| `cheese` | `"none"` \| `"light"` \| `"regular"` \| `"extra"` | no | The website's cheese step, only where `get_menu_item` returns `pizza.cheese`. `extra` is the priced `extraCheese` flag; `none` and `light` are written at the front of the item's instructions (`No Cheese · cut into squares`), exactly as the website's customizer writes them. `CHEESE_NOT_OFFERED` for an item without the step; `cheese` and `extraCheese` that disagree are refused |
| `modifiers` | array of `{ id, values }` | no | `id` is a section id from `get_menu_item`. `values` are option values. In topping sections (deal pizzas), use `{ "value": "<toppingId>", "placement": "left" }` |
| `notes` | string, up to 200 characters | no | Kitchen notes. Never items, never payment details: a note containing a card-like number is refused |
| `expectedCartVersion` | integer | no | Refused with `CART_CHANGED` if the order changed since |

```json
{
  "type": "object",
  "properties": {
    "productId": { "type": "string" },
    "variationId": { "type": "string" },
    "quantity": { "type": "integer", "minimum": 1, "maximum": 100 },
    "toppings": { "type": "array", "items": { "type": "object", "properties": {
      "toppingId": { "type": "string" }, "placement": { "type": "string", "enum": ["whole", "left", "right"] } },
      "required": ["toppingId"] } },
    "omitToppings": { "type": "array", "items": { "type": "string" } },
    "extraCheese": { "type": "boolean" },
    "modifiers": { "type": "array", "items": { "type": "object", "properties": {
      "id": { "type": "string" },
      "values": { "type": "array", "items": { "type": "object", "properties": {
        "value": { "type": "string" }, "placement": { "type": "string", "enum": ["whole", "left", "right"] } },
        "required": ["value"] } } },
      "required": ["id", "values"] } },
    "notes": { "type": "string", "maxLength": 200 },
    "expectedCartVersion": { "type": "integer" }
  },
  "required": ["productId"],
  "additionalProperties": false
}
```

(`values` also accepts plain strings. The object form above is what to configure, because it covers both option sections and topping sections. The generated wire schema in `elevenlabs-voice-tools.generated.json` is authoritative and adds `cheese`.)

`search_menu` now also detects the cheese step (`detected.cheese`: `none` for "no cheese" / "hold the cheese", `light` for "light" / "easy on the cheese", `extra` for "extra" / "double cheese"; "feta cheese" stays a topping), and maps "light sauce" to *Easy on the Sauce*, "light bake" to *Lightly Done*, and "thin" / "thick" to the crusts, wherever the product offers those options.

**Success** returns `lineId` (for example `"L1"`) and the whole cart: `cartVersion`, `stage`, `fulfilment`, `customer`, `deliveryAddress`, `lines[]` (each with `lineId`, `quantity`, `name`, `size`, `flags`, `details` and `lineTotalCents`, in the kitchen ticket's wording), `totals` (`subtotalCents`, `discountCents`, `deliveryFeeCents`, `taxCents`, `totalCents`, `amountDueCents`, `spokenTotal`), and the order-level `issues` that do not block the line (for example `DELIVERY_BELOW_MINIMUM`, or `LAST_ORDERS_CLOSED` if the cutoff passes mid-call). `say` is *"Added. Your total so far is $13.55."*

**Validation failures**, where nothing is added:

```json
{ "ok": false, "issues": [{ "code": "SIZE_REQUIRED", "message": "Which size: Medium, Large, X-Large?" }],
  "say": "Which size: Medium, Large, X-Large?" }
```
```json
{ "ok": false, "issues": [{ "code": "ORDER_VALIDATION_FAILED", "message": "Choose valid options for Wing style.", "lineId": "L2" }],
  "say": "Choose valid options for Wing style." }
```
```json
{ "ok": false, "issues": [{ "code": "FIELD_NOT_ACCEPTED", "field": "priceCents",
  "message": "priceCents is set by the restaurant's system, never by the caller or the agent." }] }
```

Other codes include `PRODUCT_NOT_FOUND`, `INVALID_SIZE`, `PRODUCT_OUTSIDE_OFFER_HOURS`, `TOPPINGS_INCOMPLETE` (for example a pickup "3 Items" pizza with two toppings), `RECIPE_INCOMPLETE`, `PAYMENT_DETAILS_NOT_ACCEPTED`, `FULFILMENT_REQUIRED` and `ORDER_NOT_STARTED`.

**After it:** on success, read `say` or the line. On a failure, ask the caller exactly what `say` asks. The message names the section label and the problem.

### 5.7 `update_item`

**Description for the LLM:** Change one line already in the order: its size, quantity, toppings, halves, options or notes. Only the fields you send change. Use the `lineId` from `add_item` or `get_cart`.

Takes `lineId` (required), the same optional fields as `add_item`, and `expectedCartVersion`. A field you send **replaces** that field: send the full new topping list, not just the change. Changing `productId` is how a build-your-own pizza changes size, because pickup sizes are separate products. The toppings are kept and re-priced at the new size's rate. The line is re-validated and re-priced. If the new version is invalid, the line is left as it was. Returns the same shape as `add_item`, with `say` *"Changed. Your total is now $62.12."* `LINE_NOT_FOUND` is returned for an unknown `lineId`.

### 5.8 `remove_item`

**Description for the LLM:** Remove one line from the order by its `lineId`.

`{ "lineId": "L2", "expectedCartVersion": 4 }` (`lineId` required) returns the updated cart, with `say` *"Removed."*

### 5.9 `set_fulfilment`

**Description for the LLM:** Switch the order between pickup and delivery. Items that exist for the new choice stay. A build-your-own pizza moves to its exact equivalent if one exists. Anything else blocks the switch and must be asked about.

`{ "fulfilment": "pickup" | "delivery", "expectedCartVersion"?: integer }` (`fulfilment` required).

Build-your-own pizzas are separate products for pickup (`Large Pizza · 1 Item` / `· 3 Items`) and delivery (`Large Pizza`, up to 4 toppings). A line moves only to the **one** product of the same size whose included toppings fit exactly. For example, pickup 1-item to delivery Large works, and a delivery Large with one or three toppings moves to the pickup 1-item or 3-item. Success returns `remapped[]` (`lineId`, `from`, `to`) and the re-priced cart. If any line has no exact equivalent (a two-topping delivery pizza going to pickup, or a pickup-only slice going to delivery), **nothing changes**:

```json
{ "ok": false, "data": { "blocked": [{ "lineId": "L1", "productId": "large-pizza", "name": "Large Pizza",
    "message": "Large Pizza is not available for pickup, and there is no exact equivalent. Ask the caller what they would like instead." }] },
  "issues": [{ "code": "NEEDS_CLARIFICATION", "message": "…", "lineId": "L1" }] }
```

Going to delivery while voice delivery is off returns `VOICE_DELIVERY_UNAVAILABLE`.

### 5.10 `set_customer`

**Description for the LLM:** Save the caller's name and a callback number for the order. Use the caller ID only if the caller agrees, and always read the number back.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | string, 2–100 characters | yes | |
| `phone` | string | unless `useCallerId` | Any formatting, 10+ digits |
| `useCallerId` | boolean | no | Uses the number the carrier presented, **only** when `caller_id_status` is `presented`. Forwarded, withheld or unknown caller ID is never used |
| `expectedCartVersion` | integer | no | |

There is no email field: voice orders do not require one. Success returns `customerPhoneToConfirm` and `phoneSource` (`spoken` or `caller_id`), with `say` *"I have Jordan at 905-555-0177 — is that the best number to reach you?"* Failures are `PHONE_REQUIRED` and `INVALID_PHONE`. Caller ID is never treated as identity: no history or address is looked up from it.

### 5.11 `check_delivery_address`

**Description for the LLM:** Check whether Pizza 62 delivers to an address, and whether the order meets the delivery minimum. Send only the address the caller gave.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `line1` | string | yes | Street number and name |
| `unit` | string | no | |
| `postalCode` | string | yes | |
| `city` | string | no | Defaults to Hamilton. Delivery is limited to Hamilton, ON |
| `province` | string | no | Defaults to ON |
| `instructions` | string, up to 200 characters | no | For example a buzzer or a side door |

```json
{
  "type": "object",
  "properties": {
    "line1": { "type": "string" }, "unit": { "type": "string" }, "postalCode": { "type": "string" },
    "city": { "type": "string" }, "province": { "type": "string" }, "instructions": { "type": "string", "maxLength": 200 }
  },
  "required": ["line1", "postalCode"],
  "additionalProperties": false
}
```

**Critical input contract:** the request carries **only the address**. The subtotal used for the minimum and the free-delivery decision come from the session's cart, validated and priced by the server (`checkCartDeliveryEligibility` → `checkDeliveryEligibility`). Lines that cannot be delivered do not count. `menuSubtotalCents`, `subtotal`, `freeDelivery`, a fee or a total in the body are refused.

**Returns** `addressDeliverable` *and* `eligible`, so the agent can tell apart:

- `addressDeliverable: true, eligible: true`: "Yes, we deliver there. The delivery fee is $3.50."
- `addressDeliverable: true, eligible: false, reason: "below_minimum"`: "Yes, we deliver there. Delivery orders need $20.00 of food before tax — another $X." (`shortfallCents`)
- `addressDeliverable: false`: `reason` is `outside_radius`, `invalid_address`, `address_unverified` or `delivery_unavailable`. The agent says it is outside the area, or asks the caller to repeat the address.

Also returned: `address` (normalized), `feeCents`, `minimumCents`, `shortfallCents` and `deliveryAvailableByPhone`. When the order is a delivery and the address is deliverable, it is **stored** on the order (`stored: true`, which moves the version). Otherwise it is only answered.

```json
{ "ok": true, "data": { "addressDeliverable": true, "eligible": false, "reason": "below_minimum",
    "message": "Delivery orders must be at least $20.00 before tax.", "address": "55 Parkdale Ave N, Hamilton, L8H 5W7",
    "feeCents": 0, "minimumCents": 2000, "shortfallCents": 2000, "deliveryAvailableByPhone": false },
  "say": "We do deliver there, but by phone we can take pickup orders only. You can order delivery on our website." }
```
```json
{ "ok": false, "data": { "addressDeliverable": false, "eligible": false, "reason": "outside_radius", "...": "..." },
  "issues": [{ "code": "DELIVERY_ADDRESS_INELIGIBLE", "message": "This address is outside our standard delivery area. Please call Pizza 62 to ask about an exception." }] }
```

### 5.12 `get_cart`

**Description for the LLM:** Look at the order as it stands: lines, totals, customer and address. It changes nothing. Use it when unsure what is in the order or which `lineId` to change.

No parameters. Returns the cart shape described under `add_item`.

### 5.13 `review_order`

**Description for the LLM:** When the caller has finished ordering, get the official read-back of the order. Read the returned `say` to the caller word for word. Do not summarize the order yourself.

No parameters. The server checks everything first and refuses with **all** blocking issues: `CART_EMPTY`, `FULFILMENT_REQUIRED`, `CUSTOMER_REQUIRED`, `ADDRESS_REQUIRED`, `DELIVERY_ADDRESS_INELIGIBLE` (re-checked now), `VOICE_DELIVERY_UNAVAILABLE`, every quote issue (sold out, outside hours, `LAST_ORDERS_CLOSED`, `DELIVERY_BELOW_MINIMUM` and so on), and `ORDER_TOO_LARGE` with `escalate: true` above `VOICE_MAX_ORDER_CENTS`. On success it records `reviewed_version = cart_version` and the reviewed amount.

The read-back is generated from the exact cart and quote. Each line is described by the same functions that print the kitchen ticket and write the confirmation email (`snapshotDetails` / `snapshotFlags`), so all three use the same words. It covers fulfilment, every item with quantity and size, toppings by placement (left half / right half), removals ("No Ham"), options (crust, sauce, bake, wing sauce, each pizza in a deal), notes, the delivery address, subtotal, any discount, the delivery fee, tax and total, how payment works, and the estimate.

```json
{
  "ok": true,
  "data": {
    "cartVersion": 6,
    "readback": "Here is your pickup order. 1. two Large Pizza · 1 Item — Toppings: Pepperoni, $23.98. Subtotal $23.98, tax $3.12. Your total is $27.10. Payment is at the store when you pick up. It should be ready in about 15 minutes, around 6:15 PM. Is everything correct?",
    "lines": [{ "lineId": "L1", "quantity": 2, "name": "Large Pizza · 1 Item", "size": null, "flags": [],
                "details": [{ "label": "Toppings", "value": "Pepperoni" }], "notes": null, "lineTotalCents": 2398 }],
    "deliveryAddress": null,
    "totals": { "subtotalCents": 2398, "discountCents": 0, "deliveryFeeCents": 0, "taxCents": 312, "totalCents": 2710, "amountDueCents": 2710 },
    "promotions": [], "payment": "Payment is at the store when you pick up.",
    "estimate": { "minutes": 15, "readyAround": "6:15 PM" },
    "customer": { "name": "Jordan", "phone": "905-555-0177" },
    "amountDueCents": 2710
  },
  "say": "Here is your pickup order. 1. two Large Pizza · 1 Item — …. Is everything correct?",
  "cartVersion": 6, "stage": "review"
}
```

The read-back also states, when they apply: the scheduled time (*"Here is your pickup order, for tomorrow at 5:45 PM. … It will be ready for pickup tomorrow at 5:45 PM."*), each discount with the promotion's name (*"discount $3.99 (Feedback thank-you)"*), a promo code that is not taking anything off and why, the tip, free delivery, and the delivery instructions. `data` adds `coupon`, `tip`, `deliveryInstructions`, `totals.tipCents` and `estimate.scheduledFor` / `estimate.when`. Review now also refuses `SCHEDULE_REQUIRED` (ASAP is not possible now; a time is needed), `TIME_UNAVAILABLE` (the chosen slot has gone) and `PROMO_CODE_INVALID` (a stored code stopped being valid; `createOrder` would refuse it).

**After it:** read `say`. On a clear yes to the whole read-back, call `confirm_order` with `data.cartVersion`. On any correction, change the order and call `review_order` again.

### 5.14 `confirm_order`

**Description for the LLM:** Record that the caller said yes to the read-back just given. Pass the `cartVersion` from `review_order` and the caller's words. Only call it after a clear yes to the whole read-back.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `cartVersion` | integer | yes | Exactly `review_order`'s `data.cartVersion` |
| `utterance` | string, up to 300 characters | no | The caller's words, kept for audit. Card-like numbers are redacted before storage |

Success: `{ "ok": true, "data": { "cartVersion": 6, "confirmedAmountCents": 2710 }, "say": "Great, placing your order now." }`. A stale version returns `CART_CHANGED` (*"The order changed after it was read back. Read it back again with review_order."*). No review returns `NOT_REVIEWED`. The server cannot hear audio: it trusts the agent's report of a yes. This is why the read-back comes from the server, the utterance is logged, and every AI order is reviewed by staff during the supervised pilot.

### 5.15 `place_order`

**Description for the LLM:** Place the confirmed order. Pass the same `cartVersion` the caller confirmed. If this times out or fails, call it again with the same `cartVersion`: it never places a second order. Read the order number and time from the response.

| Parameter | Type | Required |
|---|---|---|
| `cartVersion` | integer | yes |

What it does, in order:

1. If this session already has an order, it returns that order (`duplicate: true`).
2. It requires `reviewed_version = confirmed_version = cart_version = cartVersion`, a confirmation under 5 minutes old, and stage `confirmed` (or a retry while `placing`).
3. It takes the placement lock, which blocks further edits.
4. It re-quotes with the AI policy. Any issue means refuse, release the lock and clear review and confirmation. An amount different from the confirmed amount (up **or** down) gives `TOTAL_CHANGED`. Above the voice cap gives `ORDER_TOO_LARGE`.
5. It calls **`createOrder`** with the `ai_phone` context (`aiPhoneOrderContext`), idempotency key `voice:<session id>:<cart version>`, and `expectedAmountDueCents` set to the confirmed amount. Payment is `pay_at_store`. It sends no coupon, gift card, tip, attribution or card token.
6. It records the order on the session, once.

```json
{
  "ok": true,
  "data": { "orderNumber": "P62-10785", "estimateAt": 1792016100000, "readyAround": "6:15 PM",
            "amountDueCents": 2710, "payment": "pay at the store", "duplicate": false },
  "say": "Your order is in. Your order number is 1 0 7 8 5. It will be ready around 6:15 PM. Please pay at the store when you pick it up: $27.10.",
  "cartVersion": 6, "stage": "placed"
}
```

Failures: `NOT_REVIEWED`, `NOT_CONFIRMED`, `CART_CHANGED`, `CONFIRMATION_EXPIRED`, `TOTAL_CHANGED` (with `previousAmountCents` / `newAmountCents`), `ORDER_TOO_LARGE`, `PLACEMENT_IN_PROGRESS` (retry shortly), `PLACEMENT_UNCERTAIN` (retry; it will not duplicate), and `createOrder`'s own codes (`STORE_CLOSED`, `LAST_ORDERS_CLOSED`, `DELIVERY_ADDRESS_INELIGIBLE`, `ORDERING_PAUSED` and so on). Each of these sends the order back for a new review.

For a scheduled order `say` names the day: *"It will be ready for pickup tomorrow at 5:45 PM."* `data` adds `scheduled` and `when`.

**After it:** read `say`: the order number, the ready time and *pay at the store*. Say goodbye. The order reaches the kitchen through the existing restaurant alert, which arrives as an email and a phone call announced as "New A.I. phone order", plus the kitchen board and ticket labelled `AI PHONE`.

### 5.16 `get_business_info`

**Description for the LLM:** Get Pizza 62's address, phone number, website, opening hours for the week and the next seven days, how pickup and delivery work by phone, payment options and ordering rules, from the restaurant's live settings. Call it whenever the caller asks where we are, how to reach us, when we open or close, or how ordering works. Never answer these from memory.

**Parameters:** none.

**Returns:** `name`, `address` (as stored), `addressSpoken` (*"55 Parkdale Avenue North, Hamilton, Ontario L8H 5W7"*), `phone`, `website` (`pizza62.ca`, from `PUBLIC_BASE_URL`; never an internal host), `weeklyHours[]` (`day`, `open`, `opensAt`, `closesAt`), `upcomingDays[]` (`date`, `label` such as `today` / `tomorrow` / `Friday, October 16`, `weekday`, `opensAt`, `closesAt`, `lastOrdersAt`, `closed`, `closureMessage`), `pickup` and `delivery` (`offered`, `byPhone`, `estimateMinutes`, payment wording; delivery also `area`, `radiusKm`, `feeCents`, `minimumCents`), and `ordering` (`paused`, `pauseMessage`, `lastOrderCutoffMinutes`, `scheduleIntervalMinutes`, `promoCodesByPhone: true`, `giftCardsByPhone: false`, `cardPaymentByPhone: false`, `tipsByPhone`).

`say`: *"Pizza 62 is at 55 Parkdale Avenue North, Hamilton, Ontario L8H 5W7. Our phone number is 905-547-5777 and our website is pizza62.ca. Today we're open from 11:00 AM to 10:00 PM."* Every value comes from the `business`, `hours`, `ordering`, `delivery` and `taxAndTips` settings and the active closures, so a change in Admin is the next caller's answer.

### 5.17 `get_order_slots`

**Description for the LLM:** Find out when an order can be for, without changing the order: whether as-soon-as-possible is available now, the earliest time, and the times on a day the caller names. Use it when the caller asks what times are available or when the earliest is. Times come from the same slots the website's checkout offers.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `fulfilment` | `"pickup"` \| `"delivery"` | no | Defaults to the order's, else pickup. Delivery has a longer lead time |
| `day` | string, up to 40 characters | no | `today`, `tomorrow`, a weekday, or `YYYY-MM-DD` |

**Returns:** `asapAvailable`, `asapEstimateMinutes`, `earliest` (`{ at, date, time, when }`), `day` (`{ date, label, times: ["11:00 AM", "11:15 AM", …] }` when a day was named), `days[]` (`date`, `label`, `first`, `last`, `count` for each day that has slots in the website's window), `intervalMinutes`, `latest` (the last time the website's checkout offers).

The slots are `nextOrderSlots` — the website checkout's own function: inside opening hours, at least the current lead time ahead (pickup 15, delivery 30 minutes), on the 15-minute grid — the first 48 of them, which is exactly what the website's dropdown shows (the same call with the same arguments) — minus any slot a closure covers (`closureFor`, as the order service judges it). Nothing later is offered or accepted by voice (VOICE-WEB-PARITY.md §4.6).

### 5.18 `set_schedule`

**Description for the LLM:** Set when the order is for: as soon as possible, or a later day and time the caller names, such as tomorrow at 11:30 or 5:45 tonight. Pass the day and time as the caller said them; never work out a date or timestamp yourself. If the time is not available the server says why and offers the nearest times.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `when` | `"asap"` \| `"scheduled"` | yes | |
| `day` | string | when scheduled | `today` / `tonight`, `tomorrow`, a weekday (the next one, today included), or `YYYY-MM-DD`. Anything else is refused with a question |
| `time` | string | when scheduled | 24-hour `HH:MM` (`17:45`); `5:45 PM` and `noon` are also read. A bare `5:45` is a quarter to six in the morning, and is refused as outside hours |
| `expectedCartVersion` | integer | no | |

The server matches the day and time against `get_order_slots`'s slots in America/Toronto and stores that slot's own timestamp (`voice_calls.order_options_json`), across daylight saving. A change moves the version, so any read-back and yes are void. Refusals are `ok: false` with `data.reason` and `data.suggestions[]`, and do not count towards escalation:

| `reason` | `say` (example) |
|---|---|
| `off_grid` | "We schedule orders in 15-minute steps. Would tomorrow at 11:30 AM or tomorrow at 11:45 AM work?" |
| `outside_hours` | "Tomorrow we take pickup orders from 11:00 AM to 11:00 PM." |
| `too_soon` / `past` | "That's sooner than we can have a pickup order ready. The earliest pickup time is today at 6:15 PM." |
| `closure` | The closure's own customer message, then the nearest times either side |
| `closed_that_day` | "We're closed Monday. The next pickup time is …" |
| `beyond_horizon` | "We can't schedule that far ahead yet. The latest pickup time we can book right now is …" |
| `invalid_day` / `invalid_time` (`INVALID_INPUT`) | "Which day would you like it: today, tomorrow, or a day of the week?" |

`when: "asap"` is refused with `ASAP_UNAVAILABLE` (and the earliest slot) when the store is closed, past the last-order cutoff, or closed by a closure. `FULFILMENT_REQUIRED` before pickup or delivery is known, because the lead time depends on it; `ORDERING_PAUSED` while ordering is paused. `createOrder` validates the slot again at placement.

### 5.19 `apply_coupon` / `remove_coupon`

**Description for the LLM (`apply_coupon`):** Apply a promo code the caller has. Send only the code, as the caller says or spells it. The server decides whether it is valid and what it takes off; read its answer. Never say what a code is worth before the server answers, and never use this for a gift card.

**Description for the LLM (`remove_coupon`):** Take the promo code off the order, for example when the caller changes their mind or the server says the code is not valid.

`apply_coupon { code, expectedCartVersion? }` prices the cart with the code through `quoteOrder`, the website promo box's own path. The quote's `coupon.status` is one of:

- `applied` — stored; `say` *"THANKS62 is applied. Your total is now $22.59."*
- `not_applied` — a live code this cart does not qualify for. Stored, priced at full price, and explained in the server's words: *"THANKS62 can only be used on Garlic Bread, Garlic Bread with Cheese, … Add one to your order to use it."* It starts to apply if the cart changes to qualify, as on the website.
- `invalid` — refused with `PROMO_CODE_INVALID` (*"That promo code isn't valid right now."*) and **not stored**, because `createOrder` refuses an order carrying it. Expired, not-yet-started, exhausted and malformed codes all land here. Three in a row hand the caller to staff.

`CART_EMPTY` before there is anything to price, as the website's promo box sits in a checkout. `remove_coupon { expectedCartVersion? }` clears it. Both move the version.

### 5.20 `set_tip`

**Description for the LLM:** Add, change or remove a tip, only when the caller offers one. Use type none for no tip, percentage with one of the restaurant's preset percentages (10, 15 or 18), or custom with the dollar amount the caller names. Never suggest an amount and never calculate it; the server prices the tip and returns the new total.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `type` | `"none"` \| `"percentage"` \| `"custom"` | yes | |
| `percent` | integer | for percentage | Must be one of `taxAndTips.tipPresetBps` (10, 15, 18): the website offers these and no others. Otherwise `TIP_NOT_OFFERED`: *"I can add a tip of 10, 15, 18 percent, or a dollar amount."* |
| `amount` | string or number | for custom | Dollars, as said: `"5"`, `"5.50"`, `"$5"`. Never cents |
| `expectedCartVersion` | integer | no | |

The server computes a percentage on the food total after discounts (the website's rule) and enforces the website's custom-tip ceiling (`TIP_INVALID`). `TIPS_UNAVAILABLE` when tipping is switched off; `CART_EMPTY` before there is a cart. `say`: *"Added a $3.00 tip. Your total is now $25.59."* The tip is in the read-back and the total paid at the store.

---

## 6. Issue codes

| Code | From | Meaning |
|---|---|---|
| `FIELD_NOT_ACCEPTED` | any | A server-controlled field (price, fee, channel, key and so on) was sent |
| `UNKNOWN_FIELD` / `INVALID_INPUT` | any | An unknown argument, or a malformed value |
| `NO_MATCH` | `search_menu` | Nothing on the menu matches |
| `PRODUCT_NOT_FOUND` | `get_menu_item`, `add_item`, `update_item` | Not on the public menu (unknown, inactive or counter-only) |
| `SIZE_REQUIRED` / `INVALID_SIZE` | `add_item`, `update_item` | The size is missing or not one of the product's |
| `ORDER_VALIDATION_FAILED` | `add_item`, `update_item`, review | `validateItems` refused the line. The message names the problem |
| `TOPPINGS_INCOMPLETE` / `RECIPE_INCOMPLETE` | `add_item`, `update_item` | The included toppings are not met, or a recipe topping went missing |
| `PRODUCT_OUTSIDE_OFFER_HOURS` | `add_item`, review | A time-limited item outside its window |
| `PAYMENT_DETAILS_NOT_ACCEPTED` | `add_item`, `update_item` | A note contained a card-like number |
| `LINE_NOT_FOUND` | `update_item`, `remove_item` | No such `lineId` |
| `NEEDS_CLARIFICATION` | `set_fulfilment` | A line has no exact equivalent for the other fulfilment |
| `VOICE_DELIVERY_UNAVAILABLE` | `start_order`, `set_fulfilment`, review | Delivery by phone is off |
| `PHONE_REQUIRED` / `INVALID_PHONE` | `set_customer` | |
| `DELIVERY_ADDRESS_INELIGIBLE` | `check_delivery_address`, review, place | |
| `DELIVERY_BELOW_MINIMUM` | quote issue | The cart is short of the delivery minimum |
| `ORDERING_PAUSED`, `STORE_CLOSED`, `LAST_ORDERS_CLOSED`, `FULFILMENT_UNAVAILABLE` | quote issue, place | Store state, from the shared settings |
| `CART_EMPTY`, `FULFILMENT_REQUIRED`, `CUSTOMER_REQUIRED`, `ADDRESS_REQUIRED` | review | Prerequisites not met |
| `ORDER_TOO_LARGE` | review, place | Over `VOICE_MAX_ORDER_CENTS`. Sets `escalate` |
| `ORDER_NOT_STARTED`, `NOT_REVIEWED`, `NOT_CONFIRMED`, `CART_CHANGED`, `CONFIRMATION_EXPIRED`, `TOTAL_CHANGED` | stage machine | See §4 |
| `PLACEMENT_IN_PROGRESS`, `PLACEMENT_UNCERTAIN` | `place_order` | Retry `place_order` with the same `cartVersion` |
| `ORDER_ALREADY_PLACED` | any change | This call's order is done. Changes go to staff |
| `SESSION_LIMIT`, `SESSION_EXPIRED` | any | Sets `escalate` |
| `CHEESE_NOT_OFFERED` | `add_item`, `update_item` | `cheese` on an item without the cheese step |
| `TIME_UNAVAILABLE` | `set_schedule`, review | The time is not one of the slots; `data.suggestions` has the nearest |
| `ASAP_UNAVAILABLE` | `set_schedule` | Not taking orders for right now; schedule instead |
| `SCHEDULE_REQUIRED` | review | ASAP is not possible now; the order needs a time |
| `PROMO_CODE_INVALID` | `apply_coupon`, review | Not a code we honour now; never stored |
| `TIP_NOT_OFFERED`, `TIP_INVALID`, `TIPS_UNAVAILABLE` | `set_tip` | Not a preset; above the ceiling; tipping is off |
| `CART_EMPTY` | `apply_coupon`, `set_tip`, review | Nothing to price yet |
| `TOOL_FAILED` | any (HTTP 500) | A fault on our side |

---

## 7. Configuration

All of these use the integration-secret store (`lib/integration-secrets.ts`): database first, then Key Vault / environment. This change supplies no credential values.

| Key | Default | Meaning |
|---|---|---|
| `VOICE_AI_MODE` | `off` | The kill switch: `off` \| `internal` \| `pilot` \| `live`. Any unrecognized value counts as `off`. While it is `off`, the HTTP API answers only `503` |
| `VOICE_TOOL_SECRET` | unset | The bearer token, at least 32 characters of `[A-Za-z0-9_-]`. Unset means nothing authenticates |
| `VOICE_PILOT_FULFILMENTS` | `pickup` | `pickup` or `pickup,delivery`. Setting delivery is also the owner's explicit acceptance of pay-at-the-door for AI orders (architecture §22 Q6) |
| `VOICE_MAX_ORDER_CENTS` | `15000` | The largest amount due the AI may place (1000–100000). Larger orders escalate to staff |

Phase 4 adds `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `VOICE_AI_NUMBER` and `VOICE_AI_ALLOWLIST` to this same encrypted configuration system. API keys, webhook secrets and tool secrets remain masked; agent ID, AI number and allowlist are readable to the authenticated owner. The owner can enter all seven connection settings in **Admin → Integrations → AI receptionist — ElevenLabs**. Each field uses the existing authenticated `secret.set` API and encrypted store. The mode defaults to off and saving credentials does not enable it.

Fixed in code (`lib/voice/config.ts`): session lifetime 30 minutes, confirmation lifetime 5 minutes, 150 tool calls per session, escalation after 3 consecutive failures, notes up to 200 characters.

---

## 8. A complete call, as tool calls

| # | Caller / agent | Tool call | Server answer (abridged) |
|---|---|---|---|
| 1 | (call starts) | `get_store_status {}` | `acceptingOrdersNow: true`, "We're taking orders until 9:40 PM…" |
| 2 | "Large pepperoni for pickup." | `start_order {"fulfilment":"pickup"}` | `cartVersion: 1`, `stage: building` |
| 3 | | `search_menu {"query":"large pepperoni"}` | `match` `pickup-large-one`, `detected.toppings: [pepperoni whole]` |
| 4 | | `add_item {"productId":"pickup-large-one","toppings":[{"toppingId":"pepperoni","placement":"whole"}]}` | `lineId: L1`, "Added. Your total so far is $13.55." |
| 5 | "And 24 wings, honey garlic, breaded." | `search_menu {"query":"24 wings honey garlic breaded"}` | `match` `24-wings`, `detected.options: [Honey Garlic, Breaded]` |
| 6 | | `add_item {"productId":"24-wings","modifiers":[{"id":"wing-style","values":[{"value":"Breaded"}]},{"id":"wing-flavours","values":[{"value":"Honey Garlic"}]}]}` | `lineId: L2`, new total |
| 7 | "It's Jordan, use this number." | `set_customer {"name":"Jordan","useCallerId":true}` | "I have Jordan at 905-555-0177 — is that the best number to reach you?" |
| 8 | "Yes." | `review_order {}` | the read-back in `say`, `cartVersion: 4` |
| 9 | "Yes, that's right." | `confirm_order {"cartVersion":4,"utterance":"yes that's right"}` | "Great, placing your order now." |
| 10 | | `place_order {"cartVersion":4}` | "Your order is in. Your order number is …" |
| 10b | (timeout, retry) | `place_order {"cartVersion":4}` | the same order, `duplicate: true` |

Steps 1 to 10 are what `tests/voice-tools.test.ts` ("READINESS…") and `tests/voice-sim.test.ts` prove against the real engine. The order is created by `createOrder` with channel `ai_phone`, the existing `restaurant_new_order` outbox row is queued, and a repeated placement creates nothing.

## 9. Testing without ElevenLabs

`scripts/voice-sim.ts` is a deterministic, non-AI driver of these tools, for local databases only:

```sh
PGSSLMODE=disable DATABASE_URL=postgres://localhost:5432/pizza62_test \
node --experimental-strip-types --import ./register-alias.mjs scripts/voice-sim.ts \
  --at 2026-10-14T18:00:00-04:00 --name "Jordan" --phone 9055550177 \
  --item "large hawaiian no ham" \
  --line '{"productId":"24-wings","modifiers":[{"id":"wing-style","values":["Breaded"]},{"id":"wing-flavours","values":["Hot"]}]}' \
  [--place]
```

It prints every tool response, with the cart version and stage. It stops at the read-back unless `--place` is given, and it refuses non-localhost databases unless `VOICE_SIM_ALLOW_REMOTE=1`.

## 10. Not built yet (by design)

- `transfer_to_store` and `request_callback`. Register-call does not provide ElevenLabs-managed transfer. Until a separate transfer implementation exists, configure the staging agent to apologize and end the call when it must escalate.
- `lookup_caller`, "the usual", reordering, saved addresses, order status, changing or cancelling a placed order, card payments and SMS payment links.
- Gift card redemption by voice, and a secure payment link for online payment. Both are deliberate, documented exceptions: see VOICE-WEB-PARITY.md §4 and §7.
- An admin screen for voice call history. The connection settings and mode are available in Admin → Integrations.

## 11. Phase 4 staging bridge

Implemented routes:

| Route | Authentication | Behavior |
|---|---|---|
| `POST /api/voice/inbound` | Existing Twilio HMAC-SHA1 signature implementation, moved to `lib/notifications/twilio-signature.ts` | Signed URL-encoded form only; internal staff admission, session creation, register-call, TwiML response |
| `POST /api/voice/status` | Same Twilio signature | Looks up `voice_calls` by signed `CallSid`; records status, duration and terminal time; rejects stale progress updates and ignores repeated terminal callbacks |
| `POST /api/voice/events` | `ElevenLabs-Signature` HMAC-SHA256 over `timestamp.raw_body_bytes` | Processes `post_call_transcription`; acknowledges unsupported events without persisting their payload |

Twilio verification uses the exact request URL, including query string, as existing notification webhooks do. Configure the canonical HTTPS URL directly, without redirects. Host/path/scheme rewriting at ingress must preserve that external URL; arbitrary forwarded headers are never used to reconstruct it. CallSid, From, To and optional ForwardedFrom come exclusively from the signed form, never the query string or LLM. Duplicate form keys are refused. Existing notification behavior and compatibility exports from the acknowledgement route are preserved.

`VOICE_AI_MODE` defaults to `off`. This phase admits **only `internal`**; `pilot` and `live` are recognized configuration values but also return local fallback. `VOICE_AI_ALLOWLIST` is a comma-separated list of complete E.164 staff/test numbers, with exact matching. Empty or malformed lists admit nobody. `VOICE_AI_NUMBER` must match signed `To`; when unset it falls back to `TWILIO_FROM_NUMBER`. Caller ID is an internal test filter, not proof of a customer's identity.

Required staging configuration:

```dotenv
VOICE_AI_MODE=off
VOICE_AI_NUMBER=+18254626262
VOICE_AI_ALLOWLIST=<comma-separated staff E.164 numbers>
ELEVENLABS_API_KEY=<staging server API key>
ELEVENLABS_AGENT_ID=<existing staging agent ID>
ELEVENLABS_WEBHOOK_SECRET=<post-call HMAC secret>
VOICE_TOOL_SECRET=<random URL-safe token, at least 32 characters>
# Existing Twilio signing credential:
TWILIO_AUTH_TOKEN=<auth token for the account receiving these calls>
```

Keep the existing defaults `VOICE_PILOT_FULFILMENTS=pickup` and `VOICE_MAX_ORDER_CENTS=15000`. Missing provider/tool/webhook credentials cause fallback before session creation. No setting is enabled by this change. Database-first encrypted configuration can be populated through the existing authenticated integrations API or environment/Key Vault; the seven connection fields are available in Admin → Integrations → AI receptionist — ElevenLabs.

### Exact register-call request

`POST https://api.elevenlabs.io/v1/convai/twilio/register-call`, headers `Content-Type: application/json` and `xi-api-key: <ELEVENLABS_API_KEY>`:

```json
{
  "agent_id": "<ELEVENLABS_AGENT_ID>",
  "from_number": "<signed From>",
  "to_number": "<signed To>",
  "direction": "inbound",
  "conversation_initiation_client_data": {
    "dynamic_variables": {
      "secret__voice_session": "<one-time per-call session secret>",
      "voice_session_id": "<voice_calls.id>",
      "call_sid": "<signed CallSid>",
      "voice_mode": "internal"
    }
  }
}
```

These are the **only four dynamic variables sent**. Store opening/order acceptance remains available through the existing `get_store_status` tool, so no duplicated or stale store-state calculation is introduced here. The API key, webhook secret and shared tool bearer are never sent as ordinary dynamic variables.

The [register-call API](https://elevenlabs.io/docs/api-reference/integrations/twilio/register-call) documents a JSON string response containing TwiML. We decode that transport string (or accept direct XML) and return the original XML as `text/xml`, without appending redirects or reconstructing it. An empty, malformed or credential-echoing response fails safely. The five-second abort deadline covers fetching and reading the body.

### Sessions, retries and completion

Migration `0013_voice_telephony.sql` additively extends `voice_calls` with called number, ForwardedFrom, registration state, Twilio status/sequence, duration and post-call receipt time. It changes no ordering tables or rules. `createVoiceSession()` uses the existing unique CallSid index to atomically claim an inbound call. Only the winning insertion receives the session secret and registers with ElevenLabs. Concurrent or later retries receive the spoken fallback; we do not persist plaintext TwiML or recoverable session secrets to replay a response. This deliberately favors one registration over retrying an uncertain external operation. A process crash between insertion and delivery also fails safely on retry; start a new call.

Registration failures/timeouts mark the session `registration_state=failed`, `failure_reason=register_call_failed`, close it and set its end time. The local TwiML says: “Sorry, the automated assistant is temporarily unavailable. Please try again.” It then hangs up. It also covers disabled/unlisted/misconfigured requests and database failures in the inbound handler. Invalid signatures are rejected with `403`. A Twilio-hosted fallback URL is still needed for an app that is unreachable or cannot respond.

Status callbacks need only the signed CallSid, not a caller-selected session ID. Terminal statuses cannot be overwritten by late progress callbacks. Duplicates do not move the end time; callbacks for unknown calls create no records. Status and post-call completion preserve placed orders and an order placement already in flight.

Post-call association uses `conversation_initiation_client_data.dynamic_variables.voice_session_id`. If present, the call SID is cross-checked against the row. Once the provider conversation ID is bound, it can identify redelivery without initiation variables. A different conversation cannot replace that binding. Missing association returns `503` for retry; conflicting association returns `409`. The session secret is never used for post-call association.

HMAC validation runs against untouched request bytes before JSON parsing and uses a constant-time digest comparison. `t=<unix_seconds>,v0=<hex_digest>` is required; signatures older than 30 minutes or over one minute in the future are rejected. Multiple v0 signatures support key rotation; ambiguous timestamps are refused. This follows the [ElevenLabs signing algorithm](https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/webhooks_custom.py), with an added future-timestamp bound. The timestamp is the delivery signature timestamp, not the conversation start or event timestamp.

Post-call data is saved atomically with the conversation binding as one existing `voice_call_events` session event. A conditional update makes concurrent redeliveries idempotent. Persisted fields are conversation ID, agent ID/version when supplied, status, duration, transcript role/message/time, summary, disposition, termination/failure reason. All pass through `redactForLog()`; tool headers/results, dynamic variables, audio and arbitrary metadata are excluded. Duration and end time also populate `voice_calls`. No transcript-specific table or unredacted payload storage is introduced. Callbacks still work with mode off so in-flight calls can finish. No external HTTP calls run during post-call processing.

### Manual staging setup — perform only after review

1. Review and deploy this change to a chosen staging HTTPS host **manually**, including migration `0013`; verify the ingress presents the exact public URL to signature verification. Keep mode off throughout setup.
2. Set the server configuration above; confirm the staging agent ID and staff allowlist. Generate the shared bearer securely and save the same value in ElevenLabs workspace secrets. Do not reuse the Twilio auth token as a tool or webhook secret.
3. In the **existing ElevenLabs staging agent**, set input and output audio to **μ-law 8000 Hz** (`ulaw_8000`). Configure the existing webhook tools using §2–§5, with `Authorization: Bearer <workspace secret>` and the `X-Voice-Session` header as the dynamic-variable reference `{ "variable_name": "secret__voice_session" }` (not the template string). Define the four runtime variables; keep secret__voice_session only in webhook headers. Remove any requirement for unrelated dynamic variables that this bridge does not send.
4. Keep the prompt pickup-only, pay at store, no card collection/history/“the usual”/delivery. Require the existing review → explicit confirmation → placement sequence. Disable unavailable transfer tools; escalation must apologize and end the staging call.
5. In ElevenLabs agent/workspace post-call settings, create/select an HMAC-authenticated webhook to `https://<canonical-staging-host>/api/voice/events`, enable transcription events, and save its signing secret server-side as `ELEVENLABS_WEBHOOK_SECRET`. Enable retries if available. Leave audio delivery disabled. Match the agent's post-call override to this webhook if one exists. No phone-number import is needed. See [post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks).
6. In **Twilio Console → Phone Numbers → Manage → Active numbers → +1 825-462-6262 → Voice configuration**, first record the current settings. Under “A call comes in”, choose Webhook, set `https://<canonical-staging-host>/api/voice/inbound`, method **POST**. Set the call status changes callback to `https://<canonical-staging-host>/api/voice/status`, **POST**. Do not change messaging settings or existing restaurant alert callbacks.
7. Set the Twilio voice fallback URL to an independently hosted static TwiML Bin containing the same apology and `<Hangup/>`, without a transfer destination. This covers app/network outages. Do not point it back at the failing app.
8. Deliberately set **internal** mode only when ready for staff testing, call **+1 825-462-6262 directly from an allowlisted phone**, and check tool execution, one voice row, order/alert behavior, Twilio completion and the redacted transcript event. An allowlisted caller can place a real pickup/pay-at-store order through the existing engine: coordinate the test with staff. Test an unlisted caller and forced register-call failure too. Return mode to off after the test window.

This code is ready for the manual staging setup and first direct-call validation after it. A live test is **not ready to start merely from these local commits**: deployment, secrets, audio/tool/webhook settings and Twilio URLs must be completed and checked first. The staging build has been deployed with mode off; provider configuration and the first real call remain pending.

### Scope differences from the architecture proposal

Phase 4 here is intentionally narrower than the original architecture proposal: no appended `<Redirect>`, after-agent route, transfer endpoints/REST redirects, native transfer, Bell forwarding, production rollout, Terraform deployment or alert rules. Caller-ID classification records the signed direct-call/forwarding fields; carrier forwarding behavior is still untested. There are no store-status dynamic variables, since the existing tool owns that decision. Transcript/debug metadata lives in the existing event JSON rather than a new transcript schema. No ordering business rules were changed.

The [register-call integration guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call) confirms returned TwiML, manual μ-law audio setup, no ElevenLabs-managed call transfer and no phone-number dashboard import for this integration.

### Local verification (17 October 2026)

- Phase 4: 19 focused tests, all passed; external ElevenLabs HTTP requests mocked, no live calls.
- Focused Phase 4 plus all existing voice/channel/alert tests: 344 passed, none skipped.
- Complete `npm test`: 935 tests, 934 passed, one pre-existing failure, none skipped. The same untouched-HEAD baseline failure is `tests/ordering-release.test.ts:102`, “recipe omissions, normalized halves and chicken keep displayed, quoted, committed and printed prices equal”: actual `2229`, expected `2114`. That unrelated test and ordering pricing code were not changed.
- `npx tsc --noEmit`, `npm run lint`, and `npm run build`: passed.
- Initial local verification applied the migration only on `pizza62_test`. Subsequent staging deployment and migration verification are recorded below.


### Production configuration destination

The canonical production origin is **https://pizza62.ca**. Sign in at **https://pizza62.ca/admin**, open **Integrations**, and use the **AI receptionist — ElevenLabs** card. Enter the real values for the seven fields listed in the environment example; save each field individually. Keep **AI receptionist mode = off**. Values use the same `POST /api/admin/integrations` `secret.set` path as Clover/Twilio/email: AES-256-GCM ciphertext in `integration_secrets`, encrypted with the existing `SETTINGS_ENCRYPTION_KEY` Key Vault reference. Password fields remain masked. Do not enter values in Git or a committed env file.

The existing encryption-key reference is in App Service **app-pizza62-prod-638134**, resource group **rg-pizza62-prod**, backed by Key Vault **kv-pizza62-prod-638134**, secret **settings-encryption-key**. Do not replace that key. The new voice credentials do not need new Key Vault entries when entered through Integrations. If using the environment fallback instead, it must be wired as an App Service setting/Key Vault reference; merely creating an unreferenced Key Vault secret does not configure the app. The encrypted database value takes precedence over the environment. Both slots share this database.

Future provider callback URLs (do not configure during this release):

- Twilio incoming voice: `https://pizza62.ca/api/voice/inbound` (POST).
- Twilio call status: `https://pizza62.ca/api/voice/status` (POST).
- ElevenLabs post-call: `https://pizza62.ca/api/voice/events` (POST).
- ElevenLabs tools: `https://pizza62.ca/api/voice/tools/<tool_name>` (POST).


### Staging verification before normal PR/Actions promotion (17 October 2026)

Release `802a522c8772ac54a3f37ce048ecceb20af4045e` was published to the existing staging slot by the manual ZIP path (OneDeploy ID `0a69124e-3847-464b-8578-3b8dc7a41e43`). No slot swap was performed. The release now follows the normal release branch → PR → main → GitHub Actions deployment path for production promotion.

The existing startup migration runner recorded prerequisite migrations `0011_ai_phone_channel.sql`, `0012_voice_sessions.sql` and `0013_voice_telephony.sql` in the shared database. Migration 0013 only adds seven nullable voice-call columns. Migration 0011 widens the existing order-channel constraint without changing existing rows; 0012 adds the voice tables and indexes.

All 23 staging checks passed: exact revision, migration ledger and nullable columns; encrypted settings and effective mode off; health/home/admin/menu (80 public products); authenticated staff dashboard; customer cart and staff quote parity; authentication/order validation; signed disabled inbound fallback; signed status callback; invalid Twilio signature rejection; tool kill switch; unconfigured post-call endpoint; and no synthetic voice session. The read-only customer/staff pickup quotes both totaled 2032 cents. Order count stayed 237 before and after the smoke checks; no real order/payment/provider call was created. The temporary staff session was removed. Real provider secrets remain unset and voice mode was explicitly saved as off through the existing encrypted integrations API.

Pre-deployment verification repeated: TypeScript, lint and production build passed; all 344 voice/channel/alert tests passed; full suite 934/935 passed with no skips and only the unchanged `2229 !== 2114` pricing assertion. No tests or CI gates were weakened.
