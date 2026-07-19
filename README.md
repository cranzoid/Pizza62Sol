# Pizza 62 Platform

Pizza 62 is a database-backed restaurant platform for customer ordering, kitchen operations, administration, employee timekeeping, secure order tracking, feedback, and owner analytics.

`information.md` is the product source of truth. Confirmed launch values are seeded once into D1. Owner-controlled values live in database settings and are never trusted from the browser during checkout.

## Local development

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env.local` and set a high-entropy `OWNER_SETUP_SECRET`.
4. Run `npm run dev`.
5. Open `/admin`, select first-time owner setup, and create the owner account.

The local server initializes a development D1 database with only values confirmed in `information.md`. The generated production migration is under `drizzle/`.

## Validation

- `npm test` — pricing, topping allocation, promotions, delivery boundaries, tax, tips, hours, order status, permissions, timekeeping, refunds, and secure tokens
- `npx tsc --noEmit` — strict TypeScript validation
- `npm run lint` — React, accessibility-oriented, and Next.js lint checks
- `npm run build` — Cloudflare Worker-compatible production build

## Safe launch state

Pickup orders with pay-at-store can run end to end. Delivery checkout and online payment deliberately remain unavailable until the owner provides the restaurant origin, delivery estimate, address-validation provider, and tokenized payment provider. No raw card data is accepted or stored.

Confirmed offers are displayed but marked as requiring owner setup until the owner publishes the final topping and modifier inventory. Unconfirmed halal, wing, bottle-size, cancellation-policy, reorder, Google review, and delivery-origin details remain hidden, disabled, or labelled for setup.
