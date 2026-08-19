# Pizza 62 — Release Handoff

> Paste this into a new chat to continue the work. It carries the decisions, the
> state of the code, the traps already discovered, and the list of things you
> need to ask me for before you can finish Release 1.

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
| POS | **Replace Loyverse.** This app is the system of record. Clover is online card payments only — no Clover Orders API push |
| Printing | Owner already owns printers, **make/model still unknown**. Build hardware-agnostic: a `print_jobs` queue + pluggable adapters |
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

### ⬜ R1.3 — Clover replaces Stripe — **NEXT** (blocked on §9 items 1–5)
### ⬜ R1.4 — Notifications (Twilio) — blocked on §9 items 6–10
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

**Three consequences that change the design:**
1. **Sessions expire in 15 minutes** (Stripe was 24h) → the payment-reaper job cancels `awaiting_payment` orders after ~20 min.
2. **No metadata passthrough** → we must persist `checkoutSessionId → orderId` ourselves. `payments.provider_reference` already exists and is already written for this.
3. **Return URLs are configured in the Clover Merchant Dashboard, not per session** → the current `/track?order=X&token=Y` redirect is impossible. Stash `{orderNumber, trackingToken}` in `localStorage` before redirecting and recover it on a `/order/return` page; the confirmation email becomes the durable copy.

---

## 9. 🙋 What to ask me for

Ask for these up front — several have real lead time and gate Release 1.

**Blocking R1.3 (Clover)**
1. `CLOVER_MERCHANT_ID`
2. `CLOVER_API_TOKEN` (private ecommerce token)
3. `CLOVER_WEBHOOK_SECRET` — generated under *Settings → Ecommerce → Hosted Checkout* in the Clover Merchant Dashboard
4. Sandbox or production first?
5. Confirm the success/failure/cancel return URLs are set in that same dashboard

**Blocking R1.4 (Twilio)**
6. Twilio Account SID + Auth Token
7. The Twilio phone number to send from
8. **Toll-free verification status** — since 17 Feb 2026 this needs the restaurant's CRA Business Number (format `123456789RC0001`). Takes days-to-weeks; **the most likely thing to slip the schedule**
9. SendGrid API key + a verified sender domain (SPF/DKIM DNS records)
10. **The restaurant phone number to call** on a new order, and how many retries before giving up

**~~Blocking R1.2 (Azure)~~ — answered 2026-08-19, R1.2 is built**
11. ~~Azure region~~ → `canadacentral`
12. ~~Resource-group convention~~ → `rg-pizza62-{env}`
13. ~~Custom domain~~ → default `*.azurecontainerapps.io` hostname for now.
    **Still needed eventually** — Clover and Twilio webhooks want a stable
    hostname, and the generated one changes if the environment is rebuilt.
14. ~~Budget~~ → lean; Postgres B1ms, Front Door off (saves ~$35/mo)

**Blocking R2.2 (printing)**
15. **Printer make and model.** If cloud-capable (Star CloudPRNT / Epson Server Direct Print) they poll our HTTPS endpoint and need no local software. If LAN-only, a small local print agent is required

**Nice to have**
16. Should staff orders use a separate order-number series from web orders?
17. Confirm Ontario HST 13% and the delivery radius/fee are still correct

---

## 10. Suggested first moves in the new chat

R1.1, R1.2 and R1.5 are done and committed on `release/r1-runway` (§4). What is
left in Release 1 is R1.3, R1.4 and R1.6.

1. **Ask me for §9 items 1–5 (Clover)** and build **R1.3**. It is the critical
   path: the site cannot take money without it. Everything needed is in §8 —
   don't re-research the API.
2. While waiting on those credentials, **R1.6 route-level integration tests** need
   nothing external and cover the riskiest untested code (order creation, auth,
   webhooks, idempotency). `tests/rate-limit.test.ts` and
   `tests/delivery-area.test.ts` are the pattern to copy — the first probes for a
   real Postgres and skips cleanly, the second stubs `fetch`.
3. **Ask me for §9 items 6–10 (Twilio)** early even though R1.4 comes later —
   toll-free verification takes days-to-weeks and is the most likely thing to
   slip the schedule.
4. **Apply the infrastructure** when ready: `infra/README.md` has the bring-up
   order. Nothing has been applied yet, so the first `terraform apply` is still
   ahead. Note ACR has to exist before an image can be pushed to it.
5. Two flags flip as their code lands: `enable_payment_reaper` with R1.3,
   `enable_outbox_dispatcher` with R1.4.
