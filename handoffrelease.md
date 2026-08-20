# Pizza 62 — Release Handoff

> Paste this into a new chat to continue the work. It carries the decisions, the
> state of the code, the traps already discovered, and the list of things you
> need to ask me for before you can finish Release 1.
>
> **Start at §10.** §3 is what is already done, §10 is what to do next.
>
> Last updated 2026-08-19, after R1.1, R1.2 and R1.5 landed on `release/r1-runway`.

---

## 1. What this project is

A restaurant ordering platform for **Pizza 62**, 55 Parkdale Ave N, Hamilton, ON.
Customer ordering, kitchen operations, admin, employee timekeeping, order
tracking, feedback, analytics. Next.js on Vite (`vinext`), React 19, raw SQL.

An audit on 2026-08-18 found the application code sound — it typechecks, lints,
builds, and passes its domain tests — but **undeployable**: it shipped as
`wrangler dev` (a development server) with a placeholder database id and SQLite
in `/tmp`, so a container restart lost every order. Nothing drained the
notification outbox, so no customer or staff member was ever told an order
existed. Delivery orders hung on a single unreconciled Stripe webhook.

We are moving it to **Azure**, replacing **Stripe with Clover**, adding
**Twilio** for email/SMS/voice, and retiring **Loyverse** in favour of in-house
order entry.

**Full roadmap:** `/Users/cranzoid/.claude/plans/ancient-wishing-wadler.md`
(read this — it has the per-release detail this summary compresses).

⚠️ **Where this file and the roadmap disagree, this file wins.** The roadmap was
written before the hardware was identified and before the toll-free decision. Its
R2.2 section recommends a cloud-polling printer and an ESC/POS serializer; the
printer the owner actually has supports neither. See §11.

Existing audit issue IDs (`C-01`…`H-26`) live in `PIZZA62_FULL_AUDIT.md` and
`AUDIT_WORKLOG.md`. Keep using that vocabulary; append to the worklog as items land.

---

## 2. Locked decisions — do not relitigate

| Decision | Choice |
|---|---|
| Host | Azure Container Apps + Azure Database for PostgreSQL Flexible Server, via Terraform |
| Payments | **Clover Hosted Checkout** replaces Stripe entirely — delete Stripe, don't leave it dormant |
| Notifications | Twilio: SendGrid (email), Programmable Messaging (SMS), Programmable Voice (call) |
| Order call | **Restaurant only.** `<Say>` the order + `<Gather>` "press 1 to acknowledge", re-calling until acknowledged. No calls to customers (avoids CRTC/CASL consent burden) |
| Twilio number | **Local Canadian number, not toll-free** (owner decision, 2026-08-19). Only the restaurant is called, and voice needs no toll-free verification — this removes what was the biggest schedule risk in the plan. See §9 for the SMS caveat this creates |
| POS | **Replace Loyverse.** This app is the system of record. Clover is online card payments only — no Clover Orders API push |
| Printing | Hardware confirmed from the labels (2026-08-20): **Star TSP143IIILAN** (Ethernet) driving a **Tera 350R** cash drawer over 24V RJ12. Still a `print_jobs` queue + pluggable adapters; the printer's real command set and the drawer both shape the design — see §11 |
| Release 1 | Make it deployable and safe. No new customer-facing features until orders are durable |

---

## 3. Release 1 status

### ✅ R1.1 — Runtime port (Cloudflare → Node/Azure) — **DONE AND VERIFIED**

The port turned out far smaller than feared: **Drizzle was dead code** (`getDb()`
had zero call sites) and the D1 interface was hand-declared in the repo as just
six methods. So instead of rewriting 169 SQL statements, the interface was
reimplemented over Postgres and ~120 call sites never changed.

**Created**

| File | Purpose |
|---|---|
| `db/pg-driver.ts` | Postgres behind the `D1Database`/`D1PreparedStatement` shape. Rewrites `?`→`$n`, runs `batch()` as a real `BEGIN/COMMIT`, maps `meta.changes`→`rowCount` |
| `tests/pg-driver.test.ts` | 11-test conformance suite pinning every semantic the app's correctness guards depend on |
| `lib/runtime-env.ts` | `env` object over `process.env` with lazy `DB`/`UPLOADS`, replacing `cloudflare:workers` |
| `lib/blob-store.ts` | Azure Blob behind the `R2Bucket` shape |
| `middleware.ts` | Security headers (CSP/HSTS/nosniff/frame-options), moved off the Worker edge |
| `scripts/migrate.ts` | Schema migrations + seed + gated data migrations, under a `pg_advisory_lock` |
| `app/api/health/route.ts` | Cheap liveness/readiness probe for Container Apps |
| `alias-hooks.mjs`, `register-alias.mjs` | `@/` path alias for plain Node processes (moved out of `tests/`) |
| `Dockerfile` | Real multi-stage build → `node node_modules/vinext/dist/cli.js start` |

**Deleted:** `worker/`, `.openai/`, `build/`, `db/index.ts`, the SQLite migration,
`.dev.vars`, and the `wrangler` + `@cloudflare/vite-plugin` dependencies.

**Changed:** `db/schema.ts` → `pg-core` (now the single source of truth, closing
H-13); `drizzle.config.ts` → `postgresql`; imports in 8 route/lib files;
`types/cloudflare.d.ts` → `types/bindings.d.ts`.

**Type mapping (deliberate — keeps app code untouched):** timestamps are
`bigint` epoch-ms, booleans are `integer` 0/1 (never `boolean` — that would break
19 `= 1`/`= 0` comparison sites), money is `integer` cents. `db/pg-driver.ts`
registers `int8`/`numeric` type parsers so values arrive as JS numbers.

**Proof it works.** Against local Postgres 14: security headers present → owner
bootstrap (PBKDF2 + session cookie) → dashboard (12 parallel queries, dynamic
`IN` list) → order **P62-1001** created → replaying the idempotency key returned
`duplicate: true` with the same order → tracking by opaque token → staff
transition to `preparing`. All side effects landed (order_items, payments, 2
order_events, outbox row, audit entries). **Then the server was restarted and the
order was still there** — the assertion the old build fails.

`npm test` 43/43 · `tsc` clean · `lint` clean · `build` 31 routes.

### ✅ R1.2 — Azure infrastructure (Terraform) — **DONE, PLAN-VERIFIED**

`infra/` — 37 resources, `terraform plan` clean against subscription `7e12a986`
in `canadacentral` on the `default`, `dev` and `prod` workspaces (48 with every
optional resource on). Nothing has been applied yet.

Container Apps environment (VNet-injected) with the web app plus three jobs;
Postgres 16 Flexible Server (private), Blob Storage, Key Vault, ACR, Azure Maps,
Log Analytics, and an optional Front Door.

**Decisions taken** (answers given 2026-08-19: `canadacentral`, lean budget,
default Azure hostname, `rg-pizza62-{env}`):

- **Postgres has no public endpoint.** VNet-integrated via a delegated subnet, so
  it is unreachable from a laptop *by design*. Schema work goes through the
  `db-migrate` job; a break-glass `psql` needs a temporary jumpbox in `snet-apps`.
- **The connection budget is enforced.** B1ms serves 50 connections; worst case is
  `web_max_replicas × pg_pool_max + jobs × job_pg_pool_max` (28 with defaults). A
  `lifecycle precondition` on the web app **fails the plan** within 5 of the cap.
  A `check` block was tried first and rejected — it only warns.
- **Front Door is off** (`enable_front_door = false`). Standard is ~$35/mo flat and
  buys nothing while the app serves on its `*.azurecontainerapps.io` hostname,
  which already has TLS. The whole path is written and plan-verified.
- **Both cron jobs are off**, gated behind `count`, because their entrypoints do
  not exist yet. R1.3 sets `enable_payment_reaper`, R1.4 `enable_outbox_dispatcher`.
- **No storage key exists** (`shared_access_key_enabled = false`); one
  user-assigned managed identity holds AcrPull, Key Vault Secrets User, Storage
  Blob Data Contributor and Azure Maps Data Reader.
- Third-party secrets are created holding `"pending"` with `ignore_changes` on the
  value, so an apply never reverts a credential set out of band.

`infra/deploy.sh` builds `--platform linux/amd64`, pushes, runs migrations, waits,
and refuses to roll the revision if they fail. `infra/README.md` has the
first-time bring-up order (ACR must exist before an image can be pushed).

**Rough cost: ~$43/mo** (+$35 when Front Door is enabled).

### ⬜ R1.3 — Clover replaces Stripe — **NEXT, and mostly unblocked**

The owner has the **private token**; that plus the **merchant ID** is everything
Hosted Checkout needs to make a call. Both remaining items (merchant ID, webhook
signing secret) are **self-serve from the Clover Merchant Dashboard** — no need to
go back to Clover support. See §8.

Build order that does not stall: write `createCloverCheckout()`, the webhook route
and the signature verification against the §8 contract first — none of it needs a
live credential — then plug the values in and run the sandbox end-to-end.

### ⬜ R1.4 — Notifications (Twilio) — **architecture can be built now**

Owner is provisioning Twilio. Decided: a **local Canadian number, not toll-free**,
because only the restaurant is called. Build the dispatcher, the three channel
adapters and the voice `<Say>`/`<Gather>` flow against the Twilio docs now, and
wire the credentials when they land. Read the SMS caveat in §9 before promising
customer SMS.
### ✅ R1.5 — Bug fixes — **ALL SEVEN DONE**

| ID | State |
|---|---|
| **rate limit** | Prefers Front Door's `X-Azure-ClientIP`, else the **last** `X-Forwarded-For` hop (the leftmost is caller-supplied). Missing header → behaviour declared by `TRUST_PROXY_HEADERS`, which Terraform sets; on = refuse, off = fixed local identity. Counter is now one atomic `ON CONFLICT … RETURNING` — the old read-then-write raced across replicas. |
| **H-17b** | `drizzle/0001` scopes `payments_idempotency_uq` to `status <> 'failed'`. Verified in psql both ways: retry-after-failure inserts, real duplicates still rejected. |
| **C-09** | Kiosk lists names (`GET /api/timeclock/kiosk`), punch names its employee → one PBKDF2. PIN uniqueness enforced at set time. ⚠️ Adds a public roster endpoint exposing staff first names — may warrant device auth. |
| **H-11a** | `promotion.upsert` patch-merges; `undefined` leaves alone, explicit `null` still clears. |
| **H-11b** | Closed type vocabulary on both sides; the bare `else` that granted free delivery is gone. |
| **H-20a** | Distinct read-only "Awaiting payment" queue on the dashboard, deliberately **not** on the kitchen board, plus a history filter option. |
| **H-06b** | Azure Maps geocoding. Maps unreachable → fall back to FSA centroid; Maps found-nothing/low-confidence → **block**. |

Also removed the last two TypeScript parameter properties (`lib/auth.ts`,
`lib/order-service.ts`) — Node's strip-only loader cannot compile them, so both
modules were unimportable from `scripts/*.ts`. That was a latent blocker for the
R1.3 reaper and R1.4 dispatcher, found when a script importing `lib/auth` crashed.

### ⬜ R1.6 — Route-level integration tests

---

## 4. Branch & commits

Everything is on **`release/r1-runway`** (branched from `main`, not merged):

```
fbb20fe  R1.5: H-06b — geocode delivery addresses instead of postal-district centroids
d7ac716  R1.5: fix six audit findings (H-17b, C-09, H-11a/b, H-20a, rate limit)
3ecefc7  R1.2: Azure infrastructure as Terraform
c7718da  R1.1: port runtime from Cloudflare Workers to Node/Postgres
```

67 files, +9176/−1750 versus `main`. Gates at the tip: **62/62 tests (0 skipped)**
· `tsc` clean · `lint` clean · `build` 34 routes · `terraform validate` + `plan`
clean.

## 5. Build, toolchain & environment

### Toolchain
- **Node** `>=22.13.0` (package.json `engines`); local machine is v26.3.1; Docker image is `node:22-bookworm-slim`
- **ESM only** — `"type": "module"`. Relative imports need explicit extensions
- **Bundler** — `vinext` 0.0.50 on Vite 8. `vite.config.ts` is now just `plugins: [vinext()]` plus the externals list
- **TypeScript** 5.9.3, `strict`, `noEmit` — the build does not typecheck; run `tsc` separately
- Path alias `@/*` → repo root (tsconfig `paths`; mirrored for plain Node by `alias-hooks.mjs`)

### npm scripts
```
npm run dev          vinext dev
npm run build        vinext build          → dist/
npm start            vinext start          → Node HTTP server, binds 0.0.0.0, honours PORT
npm test             node --test, strip-types + @/ alias hook, tests/*.test.ts
npm run lint         eslint (ignores dist, .next)
npm run db:generate  drizzle-kit generate  → new drizzle/*.sql from db/schema.ts
npm run db:migrate   scripts/migrate.ts    → schema + seed + data migrations (idempotent)
```

### Dependency changes made in R1.1
**Added (production):** `pg` ^8.13.1, `@azure/storage-blob` ^12.26.0, `@azure/identity` ^4.5.0
**Added (dev):** `@types/pg` ^8.11.10
**Removed:** `wrangler`, `@cloudflare/vite-plugin`
**Note:** `drizzle-orm` stays a dependency but is **build-time only** — `db/schema.ts` imports it so `drizzle-kit` can generate SQL. Nothing imports it at runtime.

### Build output
```
dist/client/          static assets, hashed JS/CSS, fonts
dist/server/index.js  RSC/route entry (~836 KB), imported by vinext's prod server
dist/server/ssr/      SSR entry
```
No `wrangler.json` is emitted any more. Expected, harmless build noise:
`"Some routes could not be classified"` — vinext's static analysis can't see
`headers()`/`cookies()` usage. Not an error.

### Server externals — important
`vite.config.ts` externalises `pg`, `pg-native`, `@azure/storage-blob`,
`@azure/identity` so they are `require`d at runtime instead of bundled. They are
CommonJS and reach for `__dirname`/dynamic `require`, which do not survive being
rolled into an ES module. **Any new native dependency must be added to that list**
or the server crashes on boot (see trap 2 in §6).

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection. Alternative to the discrete `PG*` vars below |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | Discrete connection settings |
| `PGSSLMODE` | Set to `disable` for local only; Azure requires TLS |
| `PGSSL_REJECT_UNAUTHORIZED` | `false` for self-signed certs (local Docker/Azurite) |
| `PGPOOL_MAX` | Pool size per replica, default 10. **replicas × this must stay under the server's connection limit** |
| `AZURE_STORAGE_ACCOUNT` | Storage account name (managed-identity path) |
| `AZURE_STORAGE_CONTAINER` | Blob container, default `uploads` |
| `AZURE_STORAGE_CONNECTION_STRING` | Local/CI alternative to managed identity |
| `OWNER_SETUP_SECRET` | One-time owner bootstrap, ≥24 chars |
| `EMAIL_PROVIDER` `EMAIL_API_KEY` `EMAIL_FROM` | Notification provider (wired in R1.4) |
| `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` | **Still read by the code today** — replaced by `CLOVER_*` in R1.3 |
| `PORT` | Server port, default 3000 |

⚠️ **`.env.example` is ahead of the code**: it already lists `CLOVER_MERCHANT_ID`,
`CLOVER_API_TOKEN`, `CLOVER_WEBHOOK_SECRET`, `CLOVER_ENVIRONMENT`, but
`lib/order-service.ts` and the webhook route still read `STRIPE_*`. R1.3 closes
that gap. Don't be confused by the mismatch.

### Database & migrations
- Schema source of truth: **`db/schema.ts`** (drizzle `pg-core`). Edit it, then `npm run db:generate`
- Current migration: `drizzle/0000_baseline.sql` — **29 tables**, 67 `bigint` (epoch-ms), 65 `integer` (0/1 booleans + cents), **zero `boolean` columns** (deliberate — see §3 type mapping)
- `scripts/migrate.ts` tracks applied files in a `schema_migrations` table, splits on drizzle's `--> statement-breakpoint` marker, and holds a `pg_advisory_lock` so concurrent job runs queue instead of racing
- Seed produces: 13 settings rows, 61 products, 52 variations, 23 toppings, 11 categories, 5 feedback questions, order sequence at 1000, and 4 gated data-migration markers

### Docker
Multi-stage. The runtime stage copies `dist/`, `node_modules/`, `package.json`,
and additionally `drizzle/`, `scripts/`, `db/`, `lib/`, `alias-hooks.mjs`,
`register-alias.mjs` — because the migration job runs `scripts/migrate.ts` **from
source** through Node's type-stripping loader, so it needs the schema SQL and the
seed modules it imports, not just the bundled server. Runs as `USER node`.
`CMD ["node", "node_modules/vinext/dist/cli.js", "start"]` — invoked directly so
the container never hits the network to start.

### Verified on this machine
- **Azure CLI authenticated** — subscription `7e12a986-4373-4371-814c-95542713a50f`
  ("Azure subscription 1"), tenant `7f915c40-6d85-490b-a0ae-0fbf34fabf72`,
  user `vishesh@thelearningartistry.com`
- **Terraform** 1.5.7 · **Docker** installed but *daemon not running* (so the
  Dockerfile is written but has never been built) · **Node** v26.3.1
- **Postgres 14 running locally on :5432** (Homebrew). Test DB `pizza62_test`
  exists, is migrated and seeded, and holds smoke-test order `P62-1001`

### Running it locally
```bash
# migrate (idempotent, safe to re-run)
PGSSLMODE=disable DATABASE_URL="postgres://localhost:5432/pizza62_test" npm run db:migrate

# serve
PGSSLMODE=disable DATABASE_URL="postgres://localhost:5432/pizza62_test" \
  OWNER_SETUP_SECRET="local-smoke-test-secret-value-1234" PORT=3111 \
  npx vinext start
```
Gates: `npm test` · `npx tsc --noEmit` · `npm run lint` · `npm run build`

**Test behaviour:** `tests/pg-driver.test.ts` probes for Postgres at module load
and **skips cleanly** if it is unreachable, defaulting to
`postgres://localhost:5432/pizza62_test`. So `npm test` stays hermetic on a
machine with no database — but you get **33 pass / 10 skipped** instead of 43
pass. Always check the skip count: a green run with 10 skips means the adapter
was never actually exercised.

## 6. Traps already hit — don't rediscover these

1. **Ambiguous column in `DO UPDATE SET`.** `version = version + 1` inside an
   upsert is ambiguous in Postgres (fine in SQLite) — must be `settings.version + 1`.
   A *runtime* error, invisible to typecheck. All 11 upsert sites were swept; one was affected.
2. **Node-native packages must not be bundled.** `@azure/identity` pulls in `open`,
   which uses `__dirname` and crashes the ESM server on boot. `pg`, `pg-native`,
   `@azure/storage-blob`, `@azure/identity` are externalized in `vite.config.ts`.
   **Add any new native dep to that list.**
3. **No TypeScript parameter properties.** Tests run through Node's strip-only
   loader, which cannot handle `constructor(private readonly x: T)`. Use explicit fields.
4. **CommonJS deps need split imports.** `import pg from "pg"` for values,
   `import type { Pool } from "pg"` for types. A named value import fails under the ESM loader.
5. **`node:test` evaluates `skip` at registration time**, not run time — probe for
   a reachable database at module load, not in a `before` hook.
6. **`vinext start` is already a Node server** honouring `PORT` and binding `0.0.0.0`.
   Don't write a custom server entry.

---

## 7. Bug fixes — all landed (see §3 R1.5 for the table)

All seven are done and verified against a running server, not just typechecked.
Two follow-ups were opened by the work rather than closed by it:

- **C-09 added a public roster endpoint.** `GET /api/timeclock/kiosk` returns the
  first names of active staff who have a PIN, so the kiosk can show a picker.
  It is rate limited and returns nothing else, but it is internet-reachable. If
  that matters to the owner, the fix is a kiosk device token — deliberately not
  built, because it needs a settings surface and a decision that is theirs.
- **`resolveFsaCentroid` is still the delivery fallback.** It only runs when
  Azure Maps cannot answer at all. Its 17 centroids remain approximate; refine
  them against an authoritative source if the radius ever needs to be exact.

---

## 8. Clover contract (already researched — don't re-research)

- `POST {base}/invoicingcheckoutservice/v1/checkouts`
  Sandbox `https://apisandbox.dev.clover.com` · Production `https://api.clover.com`
- Headers: `X-Clover-Merchant-Id: <merchantId>`, `Authorization: Bearer <private token>`,
  `accept: application/json`, `content-type: application/json`
- Body: `{ customer: {email, firstName, lastName, phoneNumber}, tips: {enabled}, shoppingCart: { lineItems: [{ name, price, unitQty, note, taxRates:[{name, rate}] }] } }` — **prices in cents**, tax rate as integer (10% = `1000000`)
- Response: `{ href, checkoutSessionId, createdTime, expirationTime }`
- Webhook: header `Clover-Signature: t=<ts>,v1=<hmac>` — HMAC-SHA256 over `` `${t}.${rawBody}` `` with the dashboard-generated signing secret. Payload carries `id` (payment UUID), `merchantId`, `data` (**checkout session UUID**), `status` `APPROVED`/`DECLINED`, `type` `PAYMENT`
- Supported in **Canada/CAD**

### Credentials — what exists, what is missing

The owner has a **public token** and a **private token**. For Hosted Checkout that
is *almost* everything, and the gap does **not** require contacting Clover again:

| Item | State | Where it comes from |
|---|---|---|
| **Private token** | ✅ owner has it | `Authorization: Bearer <private token>` |
| **Merchant ID** | ❓ ask the owner | Visible in the **URL of the Clover Merchant Dashboard** — self-serve, no support ticket. Sent as `X-Clover-Merchant-Id` |
| **Webhook signing secret** | ❌ not yet generated | Merchant Dashboard → *Settings → Ecommerce → Hosted Checkout*. Self-serve |
| **Return URLs** | ❌ not yet set | Same dashboard screen. Must point at the deployed host (see the return-URL consequence below) |
| **Sandbox vs production** | ❓ owner decision | Sandbox `apisandbox.dev.clover.com`, production `api.clover.com`. Do sandbox first |
| **Public token** | ✅ owner has it — **but not needed** | It is the tokenization key for building *your own* card form via the Ecommerce API. Hosted Checkout never uses it. Keep it: it is what a future embedded checkout would need |

So the only true unknowns are the merchant ID (a lookup) and the webhook secret (a
button). Nothing here is blocked on Clover support.

**Three consequences that change the design:**
1. **Sessions expire in 15 minutes** (Stripe was 24h) → the payment-reaper job cancels `awaiting_payment` orders after ~20 min.
2. **No metadata passthrough** → we must persist `checkoutSessionId → orderId` ourselves. `payments.provider_reference` already exists and is already written for this.
3. **Return URLs are configured in the Clover Merchant Dashboard, not per session** → the current `/track?order=X&token=Y` redirect is impossible. Stash `{orderNumber, trackingToken}` in `localStorage` before redirecting and recover it on a `/order/return` page; the confirmation email becomes the durable copy.

---

## 9. 🙋 What is still needed from the owner

Most of the original list is answered. What remains is short — and almost none of
it blocks writing code, because every integration can be built against its
documented contract and wired up afterwards.

### Still genuinely needed

| # | Item | Blocks | Notes |
|---|---|---|---|
| 1 | **Clover merchant ID** | R1.3 end-to-end test | Read it out of the Merchant Dashboard URL — self-serve |
| 2 | **Clover webhook signing secret** | R1.3 webhook | Dashboard → Settings → Ecommerce → Hosted Checkout — self-serve |
| 3 | **Sandbox or production first?** | R1.3 | Recommend sandbox |
| 4 | **Twilio Account SID + Auth Token** | R1.4 wiring | Owner is provisioning now |
| 5 | **The Twilio number** | R1.4 wiring | Local Canadian number, not toll-free |
| 6 | **Restaurant phone number to call**, and how many retries before giving up | R1.4 voice | Recommend 3 attempts, 2 min apart |
| 7 | **SendGrid API key + a domain to authenticate** | Customer email | See the email/domain note below |
| 8 | **What machine will be always-on in the store, and its OS** | R2.2 | The print agent has to live somewhere on the store LAN. This is *not* the Tera — see the correction below |

### Answered — do not re-ask

| Item | Answer |
|---|---|
| Azure region | `canadacentral` |
| Resource-group convention | `rg-pizza62-{env}` |
| Budget | Lean — Postgres B1ms, Front Door off |
| Custom domain | **Later.** Default `*.azurecontainerapps.io` hostname for now |
| Toll-free verification | **Not required.** Local number; restaurant-only calls |
| Printer variant | **Star TSP143IIILAN** — Ethernet. The good case: the agent is not tied to a USB-cabled machine |
| Cash drawer | **Tera 350R**, 24V RJ12, into the printer's DK port |
| Clover public/private token | Owner has both |

### Correction: "Tera" is the cash drawer, not the till

An earlier version of this file called the Tera a till and asked what OS it runs.
It has no OS — the **Tera 350R is the cash drawer**. The POS computer that will run
this system is a separate, still-unidentified machine, and item 8 above is the real
question: what box will be always-on in the store to host the print agent. It does
not have to be a POS terminal; anything on the store LAN that stays awake works.

### Two consequences worth reading before building R1.4

**Customer SMS is not safe to promise on a local long code.** Dropping toll-free
is right for *voice* — outbound calls need no verification, and it removes the
single biggest schedule risk the plan had. But Canadian carriers filter
application-to-person SMS sent from unregistered local long codes. So:

- Restaurant alerts: **voice call + email** are the reliable pair. Treat SMS as
  best-effort and never as the only channel that carries an order.
- Customer order confirmations: **email is the durable copy** (this is also what
  carries the tracking link, per §8's return-URL consequence). Customer SMS should
  be built behind a flag and left off until a registered number exists.

**SendGrid domain authentication does not need the app's custom domain.** The
sender domain and the hosting hostname are independent, so the restaurant's
existing domain can be authenticated (SPF/DKIM) now, while the app still runs on
the Azure hostname. Without it, confirmation emails land in spam — and with the
custom domain deferred, this is the thing that would quietly break customer
confirmations. Worth doing early.

---

## 10. What to do next — start here

**State:** R1.1, R1.2 and R1.5 are done and committed on `release/r1-runway` (§4).
Nothing has been deployed to Azure yet. Release 1 needs R1.3, R1.4 and R1.6.

### Do this first: R1.3 — Clover replaces Stripe

It is the critical path — the site cannot take money without it — and it is **not
blocked**. The full API contract is in §8; do not re-research it.

Write these before asking for a single credential:

1. `createCloverCheckout()` replacing `createStripeCheckout()` in
   [lib/order-service.ts](lib/order-service.ts) — same call site, same failure
   handling. Note the H-17b comment there: the `status = 'failed'` update is what
   releases the idempotency key, so keep it.
2. `app/api/payments/clover/webhook/` replacing the Stripe route. Verify
   `Clover-Signature: t=<ts>,v1=<hmac>` — HMAC-SHA256 over `` `${t}.${rawBody}` ``.
   The existing constant-time `equalHex` helper is reusable. Look the order up by
   `provider_reference = data`.
3. `scripts/reap-payments.ts` — Clover sessions expire in 15 minutes, so cancel
   `awaiting_payment` orders after ~20. Then set `enable_payment_reaper = true` in
   Terraform, which creates the cron job that is currently gated off.
   **The stuck orders this reaps are already visible** in the staff queue built in
   R1.5 (H-20a), so this is testable the moment it exists.
4. Delete Stripe entirely — it is a locked decision that nothing is left dormant.
   `STRIPE_*` still appears in [lib/order-service.ts](lib/order-service.ts) and the
   old webhook route; `.env.example` is already on `CLOVER_*`.
5. Refunds (H-07/H-25) — the path never existed. `computeRefund` in
   [lib/domain.ts](lib/domain.ts) already validates the amount, and the
   `issue_refunds` permission is already declared but unenforced.

Then ask for §9 items 1–3 and run the sandbox end-to-end.

### In parallel, needing nothing from anyone

- **R1.6 route-level integration tests.** Order creation, auth, webhooks and
  idempotency are the riskiest code and are entirely untested. Copy the patterns in
  [tests/rate-limit.test.ts](tests/rate-limit.test.ts) (probes for a real Postgres,
  skips cleanly if absent) and [tests/delivery-area.test.ts](tests/delivery-area.test.ts)
  (stubs `fetch`, runs offline).
- **R1.4 architecture.** Build the dispatcher, channel adapters and the
  `<Say>`/`<Gather>` voice flow against the Twilio docs; wire credentials later.
  Read the SMS caveat in §9 first — do not make SMS the only channel carrying an
  order.
- **The `@media print` fallback** for kitchen tickets (§11). No hardware needed,
  works day one, and there is no `@media print` rule anywhere in the codebase yet.

### Ask the owner early (long lead time, not engineering work)

- §9 item 7 — **SendGrid domain authentication**. It does *not* need the custom
  domain and is the thing that quietly breaks customer confirmations if skipped.
- §9 item 8 — **which always-on machine in the store will host the print agent**,
  and its OS. The printer being the LAN variant means this can be almost any box on
  the store network, so it is a cheap question to answer — but nothing in R2.2 ships
  without it.

### When ready to deploy

`infra/README.md` has the bring-up order. The one non-obvious step: ACR must exist
before an image can be pushed, so the first apply is `-target`ed at the registry.
Two flags flip as their code lands — `enable_payment_reaper` with R1.3,
`enable_outbox_dispatcher` with R1.4.

---

## 11. Printing hardware (R2.2) — confirmed 2026-08-20, don't re-research

Read off the physical labels, so this is settled:

| Component | Model | Interface |
|---|---|---|
| Receipt printer | **Star Micronics TSP143IIILAN** (TSP100III family) | **Ethernet / LAN** |
| Cash drawer | **Tera 350R**, 13", 4 bill / 6 coin, key lock | **24V RJ12 → the printer's DK port** |

`ancient-wishing-wadler.md` §R2.2 predates this and recommends a cloud-polling
printer and an ESC/POS serializer. **Both are wrong for this hardware.** What
follows replaces it.

### The good news: LAN, so the agent is not tied to one machine

The Ethernet variant means the print agent does **not** have to run on a machine
cabled to the printer. It can live on any always-on box on the store LAN and reach
the printer over **raw TCP on port 9100**.

It does still have to be *on the LAN*: the printer sits behind the store's NAT with
no public address, and the TSP100**III** does not support CloudPRNT (that is the IV
generation, mC-Print, mC-Label3 and TSP650II-with-HI-X). So the shape is:

```
Container App  ──(agent long-polls outbound HTTPS)──►  GET /api/print/poll
     ▲                                                      │
     └──────────── ack / status ◄───────── print agent ──────┘
                                                │
                                   TCP 9100 on the store LAN
                                                ▼
                                 TSP143IIILAN ──RJ12──► Tera 350R
```

Only outbound connections from the store — no inbound firewall rule, no port
forward, no static IP needed. Give the printer a DHCP reservation so its address
does not move.

### The constraint: no onboard fonts, so everything is raster

Confirmed from Star's own spec: **TSP100IIILAN is listed in the STAR Graphic Mode
Command Specifications** (Rev 2.32, §"Name of applicable models"). These printers
carry no font sets — anything sent directly must already be a bitmap, emitted as
Graphic Mode raster commands. The Windows driver emulates Star Line Mode, but that
emulation is unavailable when talking to the printer directly, which is exactly what
an agent does.

Ignore any source claiming the TSP100III speaks ESC/POS — one turned up while
researching this and it is wrong; Star's model list is authoritative.

So the render pipeline is **neutral document model → 1-bit bitmap → Star Graphic
Mode**, not the plan's "→ ESC/POS bytes". Keep the neutral model; it is the seam
that makes a future TSP100IV or an ESC/POS printer a new adapter rather than a
rewrite. For 80mm at 203 dpi the raster width is **576 px**.
[`python-StarTSPImage`](https://github.com/geftactics/python-StarTSPImage) is a
readable reference for the bitmap→Graphic Mode conversion even though this project
is Node.

### The cash drawer is driven *through the printer*

There is no separate cable to a computer — the drawer hangs off the printer's DK
port, so opening it is a command in the print stream and belongs to the same agent.

**Drive drawer (raster mode)** — from the Graphic Mode spec, p.27:

```
ESC * r D n NUL     hex: 1B 2A 72 44 n 00
  n = 0  none
  n = 1  external device drive 1   ← the Tera 350R on the DK port
  n = 2  external device drive 2
  n = 3  both
```

Two traps, both from the spec itself:

1. **Never use the buzzer commands to open the drawer.** `ESC GS BEL` (p.12) and
   `ESC GS EM DC2` (p.14) both carry an explicit warning that using them to drive a
   drawer on models with external device terminals **will damage the system**. This
   is a real trap, not pedantry: on Epson ESC/POS the drawer pulse is `ESC p`, and
   naive ports reach for the nearest-looking Star command. Use `ESC * r D` only.
2. **The drawer command is ignored if raster data is still in the image buffer.**
   Sequencing matters — the kick has to be issued when the buffer is clear, not
   blindly appended to the receipt bytes. Get this wrong and the drawer silently
   never opens while the receipt prints fine, which is a miserable thing to debug.

Also note the drawer only needs to open for **cash** payments. Card and online-paid
orders should not trigger it, so the kick belongs to the payment method on the job,
not to every `customer_receipt`.

### What to build, in order

1. **`@media print` + `window.print()` from the kitchen board.** Needs no hardware,
   works day one, and there is still no `@media print` rule anywhere in the codebase.
   Do this first so the restaurant is never blocked on the agent.
2. **`print_jobs` table and the poll/ack endpoints.** Pure server work, testable
   without a printer. Include a `open_drawer` flag on the job.
3. **The raster renderer.** `KitchenTicket` in
   [app/staff/StaffPortal.tsx](app/staff/StaffPortal.tsx) already assembles the right
   content — toppings with half-placement, extra cheese, halal, modifiers, notes,
   address, payment state. Note `kitchen_label` exists on products and toppings and
   is **never copied into the order snapshot**; add it so tickets do not depend on
   live catalog joins.
4. **The agent**, once the always-on machine is known (§9 item 8). Long-polls,
   pushes to 9100, acks. Keep it small and dumb — all formatting happens server-side.

The CSP still blocks a browser→LAN `fetch`, so a browser-side bridge remains
non-viable.

**Sources:**
[STAR Graphic Mode command spec, Rev 2.32](https://starmicronics.com/support/Mannualfolder/star_graphic_cm_en.pdf) (model list p.5, drive drawer p.27, buzzer warnings pp.12–14) ·
[TSP100III series (Star EMEA)](https://star-emea.com/products/tsp100/) ·
[CloudPRNT compatibility (Star EMEA)](https://star-emea.com/products/cloudprnt/) ·
[Star cash drawer cables & connectivity guide](https://starmicronics.com/cash-drawer-cables-connectivity-guide/)
