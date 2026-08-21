# Pizza 62 Platform

Pizza 62 is a production-oriented restaurant platform for customer ordering, kitchen operations, administration, employee timekeeping, secure order tracking, feedback, and owner analytics. The launch seed follows the current Pizza 62 menu, while pricing, availability, toppings, delivery settings, and preparation estimates remain owner-controlled.

## Local development

1. Install Node.js 22.13 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env.local`. Set a high-entropy `OWNER_SETUP_SECRET`, and a
   `SETTINGS_ENCRYPTION_KEY` (`openssl rand -base64 32`) if you want to store
   integration credentials from the admin screen rather than in the environment.
4. Run `npm run dev`.
5. Open `/admin`, select first-time owner setup, and create the owner account.

Run `npm run db:migrate` against a local Postgres first — it applies the schema,
seeds the menu, and is safe to re-run. Migrations live under `drizzle/` and are
generated from `db/schema.ts`.

## Production environment

- `OWNER_SETUP_SECRET` — one-time owner bootstrap credential, at least 24 characters
- `CLOVER_MERCHANT_ID`, `CLOVER_API_TOKEN` — Clover Hosted Checkout credentials, used to create checkout sessions
- `CLOVER_WEBHOOK_SECRET` — signing secret for `/api/payments/clover/webhook`
- `CLOVER_ENVIRONMENT` — `sandbox` (default) or `production`
- `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` — provider-neutral email settings to add after a provider is selected

Point a Clover webhook at `/api/payments/clover/webhook` for `PAYMENT` events. Clover sends no expiry event and its sessions last 15 minutes, so abandoned checkouts are cancelled by the `payment-reaper` job (`scripts/reap-payments.ts`) rather than by a webhook. Clover's return URL is set once in the Clover dashboard and should point at `/order/return`. Pickup can use pay-at-store without Clover; delivery requires hosted online payment. Card numbers never touch this application.

Deployed to Azure App Service. See `infra/README.md` for the architecture and
`GOING_LIVE.md` for everything that happens outside the code.

## Validation

- `npm test` — pricing, topping allocation, promotions, delivery boundaries, tax, tips, hours, order status, permissions, timekeeping, refunds, and secure tokens
- `npx tsc --noEmit` — strict TypeScript validation
- `npm run lint` — React, accessibility-oriented, and Next.js lint checks
- `npm run build` — production build

## Launch behaviour

- Pickup estimate: 15 minutes; delivery estimate: 30 minutes. Both are editable in Admin → Settings.
- Address: 55 Parkdale Ave N, Hamilton, ON L8H 5W7.
- Delivery addresses are manually entered and restaurant-confirmed; no third-party address-validation provider is used.
- Pop is selectable only for products that include it. Water Bottle is a standalone C$1.60 item.
- Pizza toppings are selected normally for the full pizza. Placement requests can be written in special instructions.
- Sauce and dry-rub choices appear together under “Sauces & dry rubs.”
- Email credentials, Clover and Twilio are all set from **Admin → Integrations**,
  encrypted at rest. Until they are, orders still work: notifications park
  without spending a retry and go out the moment credentials arrive.
- HST is 13% on food **and** the delivery fee. Delivery is $3.50 with a $20
  minimum, within 10 km. All editable in Admin → Settings.
- Ordering stops 20 minutes before closing, and the customer sees a countdown.
- Holidays and short closures are set in Admin → Settings, scoped to pickup,
  delivery or both, and end by themselves.
