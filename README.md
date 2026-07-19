# Pizza 62 Platform

Pizza 62 is a production-oriented restaurant platform for customer ordering, kitchen operations, administration, employee timekeeping, secure order tracking, feedback, and owner analytics. The launch seed follows the current Pizza 62 menu, while pricing, availability, toppings, delivery settings, and preparation estimates remain owner-controlled.

## Local development

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env.local` and set a high-entropy `OWNER_SETUP_SECRET`.
4. Run `npm run dev`.
5. Open `/admin`, select first-time owner setup, and create the owner account.

The local server initializes a development D1 database with the versioned menu seed. The generated production migration is under `drizzle/`.

## Production environment

- `OWNER_SETUP_SECRET` — one-time owner bootstrap credential, at least 24 characters
- `STRIPE_SECRET_KEY` — Stripe secret key used to create hosted Checkout sessions
- `STRIPE_WEBHOOK_SECRET` — signing secret for `/api/payments/stripe/webhook`
- `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` — provider-neutral email settings to add after a provider is selected

Create a Stripe webhook for `checkout.session.completed` and `checkout.session.expired`. Pickup can use pay-at-store without Stripe; delivery requires hosted online payment. Card numbers never touch this application.

For Azure, run the production build in a Node 22.13+ environment and provide a Cloudflare-compatible D1 binding named `DB`, or adapt the persistence binding before deployment. The included Sites setup supplies that binding for its preview environment.

## Validation

- `npm test` — pricing, topping allocation, promotions, delivery boundaries, tax, tips, hours, order status, permissions, timekeeping, refunds, and secure tokens
- `npx tsc --noEmit` — strict TypeScript validation
- `npm run lint` — React, accessibility-oriented, and Next.js lint checks
- `npm run build` — Cloudflare Worker-compatible production build

## Launch behaviour

- Pickup estimate: 15 minutes; delivery estimate: 30 minutes. Both are editable in Admin → Settings.
- Address: 55 Parkdale Ave N, Hamilton, ON L8H 5W7.
- Delivery addresses are manually entered and restaurant-confirmed; no third-party address-validation provider is used.
- Pop is selectable only for products that include it. Water Bottle is a standalone C$1.60 item.
- Pizza toppings are selected normally for the full pizza. Placement requests can be written in special instructions.
- Sauce and dry-rub choices appear together under “Sauces & dry rubs.”
- Email credentials can be added later without choosing a provider now.
