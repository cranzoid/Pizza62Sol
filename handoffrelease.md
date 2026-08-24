# Pizza 62 — Release Handoff

> Paste this into a new chat to continue the work. It carries the decisions, the
> state of the code, the traps already discovered, and the list of things you
> need to ask me for before you can finish Release 1.
>
> **Start at §10.** §3 is what is already done, §10 is what to do next.
>
> Last updated 2026-08-20, after R1.3, R1.4 and R1.6 landed and the Docker image
> was built and booted for the first time. **Every piece of Release 1 is now
> written.** What remains is credentials, a sandbox run, and the first deploy.

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

Gates *as they stood when R1.1 landed*: `npm test` 43/43 · `tsc` clean · `lint`
clean · `build` 31 routes. Current numbers are in §4.

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
- **All three jobs now exist and are on.** Both cron jobs were originally gated
  behind `count` because their entrypoints did not exist; R1.3 added
  `scripts/reap-payments.ts` and R1.4 `scripts/dispatch-outbox.ts`, so
  `enable_payment_reaper` and `enable_outbox_dispatcher` both default to `true`.
  The connection budget went from 28 to **36 of 45** as a result — 9 of headroom,
  so the next thing added there needs the arithmetic re-checked, not assumed.
- **No storage key exists** (`shared_access_key_enabled = false`); one
  user-assigned managed identity holds AcrPull, Key Vault Secrets User, Storage
  Blob Data Contributor and Azure Maps Data Reader.
- Third-party secrets are created holding `"pending"` with `ignore_changes` on the
  value, so an apply never reverts a credential set out of band.

`infra/deploy.sh` builds `--platform linux/amd64`, pushes, runs migrations, waits,
and refuses to roll the revision if they fail. `infra/README.md` has the
first-time bring-up order (ACR must exist before an image can be pushed).

**Rough cost: ~$43/mo** (+$35 when Front Door is enabled).

### ✅ R1.3 — Clover replaces Stripe — **DONE, pending the sandbox run**

Stripe is deleted, not left dormant. `lib/clover.ts` holds both halves of the
contract — creating a hosted session and verifying the webhook — so the order
service and the webhook route cannot drift apart on it.

**Created:** `lib/clover.ts`, `app/api/payments/clover/webhook/route.ts`,
`scripts/reap-payments.ts`, `app/order/return/` (page + client).
**Deleted:** `app/api/payments/stripe/`, `createStripeCheckout()`, every
`STRIPE_*` read, the payment-provider origins in the CSP, and Stripe naming
across the customer and staff UIs. `createOrder` lost its `origin` parameter with
them — it existed only to build Stripe's per-session `success_url`.

**Three design responses that are not renames.** They are explained at length in
`lib/clover.ts` and `AUDIT_WORKLOG.md`; the short version:

1. **The cart goes to Clover as one line item for `total_cents`, tips disabled,
   no tax rate.** Itemising it with a tax rate would let Clover recompute tax and
   charge its own figure rather than the amount this app priced, stored, and will
   reconcile against; the tip is already inside the total, so Clover's tip screen
   would collect a second one no order row knows about.
2. **No metadata passthrough** → `payments.provider_reference` holds the session
   id and is the webhook's only route back to the order.
3. **No expiry event, 15-minute sessions** → `scripts/reap-payments.ts` cancels
   `awaiting_payment` after 20 minutes, and `enable_payment_reaper` now defaults
   to **true**.

**Two guards could not be carried over as written — know about these:**

- **The amount cross-check is gone.** The Stripe event carried `amount_total`;
  the Clover event carries no amount, so it is not reproducible from the payload.
  What protects the amount instead is that it is never sent from the browser.
- **A `DECLINED` event does not cancel the order.** The session stays valid and
  the customer may retry on it, so cancelling would destroy an order about to be
  paid for; the reaper decides. It writes status `declined`, not `failed` —
  `failed` is what releases the checkout key via the H-17b partial index.

**Still open: refunds (H-07/H-25).** Now blocked on information, not effort — see
§9. The researched contract documents checkout creation and the payment webhook
and no refund endpoint.

**Remaining:** plug in the merchant ID and webhook secret (§9 items 1–3) and run
the sandbox end-to-end. Everything else is written and verified.

### ✅ R1.4 — Notifications (Twilio) — **DONE, pending credentials**

The audit's central finding, closed. `notification_outbox` was already a complete
job queue and nothing read it, so nobody was ever told an order existed.

**Created:** `lib/notifications/{config,channels,messages,dispatcher}.ts`,
`scripts/dispatch-outbox.ts`, `app/api/notifications/voice/ack/route.ts`.
**Producers added:** `restaurant_new_order` (the alert that tells the restaurant
an order exists at all — the finding itself) and `feedback_request` (closing
**H-09**). `enable_outbox_dispatcher` now defaults to **true**.

**The things that are not obvious, and that you should not undo:**

- **Rows are claimed, not selected.** `FOR UPDATE SKIP LOCKED` in a transaction,
  flipping to `sending` before commit. Inline dispatch fires on every order while
  the cron sweeper runs every minute, so two workers racing for one row is the
  *normal* case; two that merely selected it would both send it.
- **There are two trigger points, not the one the roadmap assumed.** A
  pay-at-store order is live when it commits. An online order's notifications stay
  parked in `waiting_payment` until Clover approves, so the webhook is the second
  trigger. Confirming an unpaid order and phoning the kitchen about it are both
  worse than silence.
- **Dispatch is inline and not awaited.** Node can do the work in-process, so
  nobody waits on the one-minute cron floor. The outbox row is already durable, so
  a crash between commit and send loses nothing — the sweeper picks it up. A
  failed inline dispatch must never turn a placed order into an error response.
- **Missing credentials *park* a row without spending an attempt** rather than
  failing it. During the window where Twilio exists and SendGrid does not, a
  confirmation should wait, not land in `failed` where nobody looks.
- **A 4xx fails immediately; 429 and 5xx retry.** A malformed address retried six
  times is six guaranteed failures delaying everything behind it.
- **Rows orphaned in `sending` are reclaimed after five minutes.** Found by live
  verification, not by a test: a replica dying mid-delivery stranded a customer's
  confirmation permanently, which is precisely the failure this release exists to
  eliminate. Reclaiming too early costs a duplicate; never reclaiming costs silence.

**Outbox status vocabulary** — anything touching the queue has to respect it:

| Status | Meaning |
|---|---|
| `waiting_payment` | online order, not yet paid. Released by the Clover webhook, cancelled by the reaper |
| `waiting_completion` | feedback request, released when staff complete the order |
| `pending` / `retrying` | claimable by a dispatcher |
| `pending_provider_setup` | parked: no channel can deliver yet. **Attempt count untouched** |
| `sending` | claimed by a worker; reclaimed after 5 minutes |
| `sent` / `failed` / `cancelled` | terminal |

**Tokens in the payload are a deliberate, bounded trade.** Tracking and feedback
tokens live in `orders` only as hashes, so a dispatcher running minutes later
cannot reconstruct them — and per **H-15** the email is exactly the private
channel that makes a tracking link safe to hand out at all. Everything else is
read from the database at send time, so a message describes the order as it is
when sent. The payload is scrubbed on send, bounding exposure to the queue window.

**Customer SMS is built and off**, behind `CUSTOMER_SMS_ENABLED`. See §9: an
unregistered local long code delivers unpredictably *and silently*. Email is the
durable copy; SMS never fails a row on its own. Only the restaurant is called.

**Voice acknowledgement writes `orders.acknowledged_at`** — the same field the
Acknowledge button on the kitchen screen writes. One piece of state, two ways to
set it: tapping the screen stops the phone ringing, pressing 1 clears the banner.
Re-calling is a *sweep* (`requeueUnacknowledgedOrders`), not something a delivery
schedules for itself — "still unacknowledged" is only knowable later, and the call
that would have scheduled the retry may itself have failed. The callback verifies
Twilio's `X-Twilio-Signature`; without it anyone who guessed the URL could silence
the escalation for an order the kitchen has never seen.

**Remaining:** wire §9 items 4–7 and send a real message. Nothing else.
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

### ✅ R1.6 — Route-level integration tests — **DONE**

Four suites calling the exported route handlers with real `Request` objects, so
the rate limiter, validation, database writes and error mapping are the ones
production runs. `tests/clover.test.ts` stubs `fetch` and runs offline; the three
database-backed suites probe at module load and skip cleanly.

| Suite | Covers |
|---|---|
| `tests/clover.test.ts` | the payment contract — the amount, the absent tax rate, tips off; signature verification, mostly negatively |
| `tests/order-create.test.ts` | C-07 end to end, concurrent same-key submissions, server-side pricing, hours, per-caller throttling |
| `tests/clover-webhook.test.ts` | the transition that takes the money, and the reaper. Orders built through the real `POST /api/orders`, so the session id under test is the one the order service stored |
| `tests/auth.test.ts` | the staff session cookie — revocation and deactivation taking effect on live sessions, 401 vs 403, bootstrap closed both ways |
| `tests/notifications.test.ts` | added by R1.4: queue mechanics above all — two dispatchers racing one row, the stale-`sending` reclaim and its inverse, retry vs permanent failure, parking without spending an attempt, token scrubbing, and the unacknowledged-order sweep |

**154/154, 0 skipped** with Postgres; **73 pass / 81 skipped / 0 failed** without,
so the suite stays hermetic and the skip count is still a reliable signal.

---

## 4. Branch & commits

Everything is on **`release/r1-runway`** (branched from `main`, not merged):

```
1f073eb R1.4: drain the notification outbox
c264076 R1.6: route-level integration tests for orders, payments and auth
2891cae R1.3: replace Stripe with Clover Hosted Checkout
fbb20fe R1.5: H-06b — geocode delivery addresses instead of postal-district centroids
d7ac716 R1.5: fix six audit findings (H-17b, C-09, H-11a/b, H-20a, rate limit)
3ecefc7 R1.2: Azure infrastructure as Terraform
c7718da R1.1: port runtime from Cloudflare Workers to Node/Postgres
```

89 files changed, 13335 insertions(+), 1934 deletions(-) versus `main`. Gates at the tip:
**154/154 tests (0 skipped)** with Postgres, and **73 pass / 81 skipped / 0 failed**
without one, so the suite stays hermetic and the skip count remains a reliable
signal · `tsc` clean · `lint` clean · `build` 34 routes · `terraform validate`
+ `plan` clean (39 resources, connection budget 36 of 45) ·
**Docker image builds, boots and serves `/api/health`** (§12).

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
No `wrangler.json` is emitted any more. Two expected, harmless pieces of build
noise:

- `"Some routes could not be classified"` — vinext's static analysis can't see
  `headers()`/`cookies()` usage. Not an error.
- `"middleware.ts is deprecated in Next.js 16. Rename to proxy.ts…"` — the
  security headers still apply, verified in the running container (§12). A future
  break, not a current one; see §10.

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
| `EMAIL_PROVIDER` `EMAIL_API_KEY` `EMAIL_FROM` | SendGrid. Email is the durable notification channel — it carries the customer's tracking link |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` | Twilio API credentials |
| `TWILIO_FROM_NUMBER` | E.164 number SMS and calls originate from. Local Canadian, not toll-free |
| `RESTAURANT_ALERT_PHONE` | E.164 number the restaurant is called and texted on. **Deliberately separate from the public `business.phone` setting** — the number customers call and the one that should ring in the kitchen are not necessarily the same |
| `CUSTOMER_SMS_ENABLED` | Customer confirmation SMS. **Leave off** until a registered A2P number exists (§9) |
| `VOICE_RETRY_LIMIT` `VOICE_RETRY_MINUTES` | Re-call budget for an unacknowledged order. Default 3 attempts, 2 min apart |
| `PUBLIC_BASE_URL` | Absolute origin for notification links and Twilio's `<Gather>` callback. **The dispatcher is a cron job with no request to derive an origin from.** Terraform composes it from the Container Apps environment's default domain rather than the app's own FQDN, which would be a dependency cycle |
| `CLOVER_MERCHANT_ID` `CLOVER_API_TOKEN` | Hosted Checkout credentials |
| `CLOVER_WEBHOOK_SECRET` | Signing secret for `/api/payments/clover/webhook` |
| `CLOVER_ENVIRONMENT` | `sandbox` (default) or `production`. Defaults the safe way round — anything but `production` is sandbox |
| `PORT` | Server port, default 3000 |

`.env.example` and the code now agree on `CLOVER_*` — the mismatch noted here
before R1.3 is closed. No `STRIPE_*` variable is read anywhere.

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
- **Terraform** 1.5.7 · **Node** v26.3.1
- **Docker image built and booted, 2026-08-20** — see §12. `pizza62-web:test`,
  810 MB, `linux/amd64`. Note the host is arm64, so the build is emulated and
  `npm ci` takes ~4.5 minutes; that is expected, not a fault.
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
7. **Test state outlives the test run, and `pizza62_test` is never reset.** Two
   separate bugs came from the same mistake — a counter that restarts at the same
   value every run. Rate-limit budgets live in the database and are *long*
   (owner-bootstrap is 5 per **hour**), so reused client identities share one
   budget across runs and start failing on the second or third `npm test` of the
   hour. And `orders.order_number` is `UNIQUE`, so a reused test order number
   collides outright. **Seed anything that must be unique with a per-run token**
   (`crypto.randomUUID().slice(0, 8)`), not with a bare counter. Both bugs look
   like flaky tests and are not.
8. **A dispatch claims rows across the whole database, not just yours.** Anything
   calling `dispatchOutbox()` in a test will pick up rows left by other suites and
   earlier runs. Assert on your own row by id; never on aggregate counts.

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
| 3b | **Set the Clover return URL to `/order/return`** | R1.3 customer experience | Same dashboard screen as item 2, so do it in the same visit. Clover's return URL is per-merchant, not per session, so this one static path is where every paying customer lands |
| 3c | **The Clover refund API contract** | H-07/H-25 refunds | **New.** §8 covers checkout creation and the payment webhook and documents no refund endpoint. Writing one would mean guessing at an API, and a refund path that records a refund without moving money is worse than none. Needs either the contract from Clover's docs or a decision to handle refunds in the Clover dashboard by hand for now |
| 4 | **Twilio Account SID + Auth Token** | R1.4 wiring | `twilio_account_sid` / `twilio_auth_token` in Key Vault. The code is written and tested |
| 5 | **The Twilio number**, in E.164 | R1.4 wiring | `twilio_from_number`. Local Canadian, not toll-free |
| 6 | **The restaurant's alert number**, in E.164 | R1.4 voice + SMS | `restaurant_alert_phone`. **Not necessarily the public number** — this is the one that should ring in the kitchen at 9pm. Retries default to 3 attempts, 2 minutes apart (`voice_retry_limit` / `voice_retry_minutes`); say if you want different |
| 7 | **SendGrid API key + a domain to authenticate** | Customer email — **and the restaurant's** | See the email/domain note below. Email is now the *durable* channel for both sides, so this is the single most load-bearing credential in R1.4 |
| 7b | **The restaurant's own email address** | Restaurant alerts, low-rating alerts | **New.** The dispatcher sends the new-order alert and the low-rating alert to `business.email` in settings, which is not currently populated. Without it those alerts fall back to voice and SMS only |
| 8 | **The printer's IP address** | R2.2 | Self-serve: hold the FEED button while powering the printer on and it prints a self-test showing its IP. The only printing question left |

### Answered — do not re-ask

| Item | Answer |
|---|---|
| Azure region | `canadacentral` |
| Resource-group convention | `rg-pizza62-{env}` |
| Budget | Lean — Postgres B1ms, Front Door off |
| Custom domain | **Later.** Default `*.azurecontainerapps.io` hostname for now |
| Toll-free verification | **Not required.** Local number; restaurant-only calls |
| Printer variant | **Star TSP143IIILAN** — Ethernet. The good case: output is not tied to a USB-cabled machine |
| Cash drawer | **Tera 350R**, 24V RJ12, into the printer's DK port |
| Store device | **Samsung Android tablet** running Loyverse. There is a PC but it is "not in good condition" — treat it as unavailable |
| How printing reaches it | **Star PassPRNT** app on the tablet, triggered by URL scheme from the kitchen board. No hardware purchase, no custom Android app — see §11 |
| Clover public/private token | Owner has both |

### Correction: "Tera" is the cash drawer, not the till

An earlier version of this file called the Tera a till and asked what OS it runs.
It has no OS — the **Tera 350R is the cash drawer**, and it is wired to the printer,
not to a computer.

**Loyverse — Android/iOS only — is currently the thing driving this printer**, on a
Samsung tablet, and it explicitly supports the TSP143IIILAN over Ethernet. So today
the chain is tablet → LAN → printer → drawer, and it works. Replacing Loyverse means
that job becomes ours; §11 explains how, and the answer turned out not to need any
new hardware.

### Two consequences that shaped R1.4 — they are already implemented

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

**Every piece of Release 1 is written.** R1.1, R1.2, R1.3, R1.4, R1.5 and R1.6
are done and committed on `release/r1-runway`. The Docker image builds and boots
(§12). Nothing has been deployed to Azure yet.

What is left is not engineering. It is credentials, one sandbox run, and the
first apply — in that order.

### 1. Collect the credentials (§9 items 1–7b)

None of this is code. All of it is self-serve except the Twilio/SendGrid signup
the owner is already doing.

- **Clover** (items 1, 2, 3, 3b): merchant ID from the dashboard URL, generate the
  webhook signing secret, choose sandbox, and set the return URL to
  **`/order/return`**. All one dashboard visit.
- **Twilio** (4, 5, 6): SID, auth token, the number, and the restaurant's alert
  number.
- **SendGrid** (7, 7b): API key, an authenticated sender domain, and the
  restaurant's own email address in the `business` setting.

Put them in Key Vault — the secrets already exist holding `"pending"` with
`ignore_changes` on the value, so setting them out of band is safe and an apply
will not revert them.

### 2. Run the Clover sandbox end-to-end

Place a real sandbox order and confirm: the checkout session is created, the
customer lands on `/order/return` and sees the order once the webhook arrives,
`payments.provider_reference` matches the session, and the reaper cancels an
abandoned one after 20 minutes. The webhook signature path is already verified
against a running server and in tests, so what this is really testing is the
credentials and the dashboard configuration.

### 3. Send one real notification

Confirm a confirmation email arrives and is not in spam (this is what §9 item 7's
domain authentication is for), and that the restaurant call places and that
pressing 1 clears the banner on the kitchen screen. `orders.acknowledged_at` is
the single field to watch.

### 4. Deploy

`infra/README.md` has the bring-up order. The one non-obvious step: ACR must
exist before an image can be pushed, so the first apply is `-target`ed at the
registry. Both cron jobs are now on by default, so nothing has to be flipped.

### Then, and only then: Release 2

`ancient-wishing-wadler.md` has the detail. Two things there are worth starting
early because they need nothing from anyone:

- **The `@media print` fallback** for kitchen tickets (§11). No hardware, works
  day one, and there is still no `@media print` rule anywhere in the codebase.
- **`print_jobs` and the poll/ack endpoints** (§11). Pure server work, identical
  under all three output options, so it does not block on the printer's IP.

### Known open items, none blocking

- **Refunds (H-07/H-25)** — blocked on §9 item 3c, a contract we do not have.
- **`middleware.ts` → `proxy.ts`.** The build warns it is deprecated in Next.js
  16. The security headers still apply (verified in the container, §12), so this
  is a future break, not a current one.
- **C-09's public roster endpoint.** `GET /api/timeclock/kiosk` exposes staff
  first names to the internet. Rate limited, nothing else returned, but if that
  matters the fix is a kiosk device token — deliberately not built, because it
  needs a settings surface and a decision that is the owner's.
- **`resolveFsaCentroid`** is still the delivery fallback when Azure Maps cannot
  answer at all. Its 17 centroids are approximate.

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

### How output reaches the printer — PassPRNT on the tablet (revised 2026-08-20)

**Why anything is needed at all.** The app runs in Azure. The printer sits on the
restaurant's own network behind their router with no public address, so Azure
cannot reach it. Something *inside the restaurant* has to bridge the two. Today
that bridge is Loyverse; replacing Loyverse is a locked decision, so the job
becomes ours.

**What the store actually has** (owner, 2026-08-20): Loyverse runs on a **Samsung
Android tablet**. There is a PC but it is "not in good condition". So there is no
reliable computer, and the tablet is the only always-present device.

**The answer is Star's own PassPRNT app, and it is much cheaper than an agent.**
PassPRNT is a free Star app for iOS/Android that "receives print data from native
and web-based applications using a URL scheme and sends it to the printer". Star's
compatible-model list names the **TSP143IIILAN** explicitly, it works over
Ethernet, and its settings screen has a **drawer ON/OFF** control.

```
Container App ──► kitchen board in Chrome on the Samsung tablet
                            │  starpassprnt:// URL with the ticket
                            ▼
                       PassPRNT app
                            │  over the store LAN
                            ▼
              TSP143IIILAN ──RJ12──► Tera 350R
```

**This deletes the two riskiest parts of R2.2.** PassPRNT does the rasterizing and
drives the drawer from its own settings, so we write **neither** the Graphic Mode
raster pipeline **nor** the `ESC * r D` drawer command — and the buzzer-command
damage trap below stops being reachable at all. The remaining work is building the
ticket as HTML and handing it to a URL.

**Verify these three things early — they decide whether this holds:**

1. **Does Chrome fire the URL scheme without a user gesture?** Browsers commonly
   block programmatic navigation to a custom scheme unless a tap triggered it. If it
   does need a tap, printing becomes one tap per order — which is fine, and matches
   what staff do in Loyverse today. Fold it into the existing acknowledge button as
   a single "Acknowledge &amp; print".
2. **The app-switch is visible.** PassPRNT foregrounds itself, prints, and returns
   via a `back=` callback URL. Confirm the return trip lands back on the kitchen
   board and does not lose scroll position or state.
3. **Android will likely prompt** the first time, and possibly per-launch. Find the
   "always open" setting during setup.

**Fallback if it does not hold: a dedicated box.** A mini PC or Raspberry Pi
(~$60–100) on the LAN, long-polling our API and pushing raster to port 9100. Fully
automatic and independent of whether the tablet is awake — but then the raster
pipeline and the drawer command below *are* ours to write. Do not start here; start
with PassPRNT, and keep this in reserve.

**Do not put the agent on the tablet as a custom app.** It is possible — Loyverse
proves it — but it means a whole Android codebase outside this stack, APK
distribution, and fighting Android's background-process killing. PassPRNT is the
supported path to the same place.

Note the server side — `print_jobs`, the poll/ack endpoints, the neutral document
model — is **identical under all three**, so none of this blocks starting R2.2.

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
4. **The output path**, once §9 item 10 is decided. Under option A, a small agent
   that long-polls, pushes raster to 9100 and acks — keep it dumb, all formatting
   stays server-side. Under option B, none of this exists: the Windows driver
   rasterizes and kicks the drawer, and step 3 collapses into the print stylesheet.

The CSP still blocks a browser→LAN `fetch`, so a browser-side bridge remains
non-viable.

**Sources:**
[STAR Graphic Mode command spec, Rev 2.32](https://starmicronics.com/support/Mannualfolder/star_graphic_cm_en.pdf) (model list p.5, drive drawer p.27, buzzer warnings pp.12–14) ·
[TSP100III series (Star EMEA)](https://star-emea.com/products/tsp100/) ·
[CloudPRNT compatibility (Star EMEA)](https://star-emea.com/products/cloudprnt/) ·
[Star cash drawer cables & connectivity guide](https://starmicronics.com/cash-drawer-cables-connectivity-guide/)

---

## 12. The Docker image — built and verified, 2026-08-20

The claim this file carried for two revisions — that the Dockerfile had never
been built — is now closed. What follows is what was actually checked, so nobody
has to redo it.

**Getting there took one detour worth recording.** The first build died with
`error committing …: write /var/lib/docker/buildkit/metadata_v2.db:
input/output error`. That was not the Dockerfile: the host disk was at **100%
(175 MiB free of 228 GiB)**. Clearing the npm cache freed enough, but the failed
write had left BuildKit wedged — the daemon stopped answering `docker info`
entirely — and it took a Docker Desktop restart to recover. If the build ever
fails on a metadata or I/O error, check `df -h` before suspecting the image.

**Build:** `docker build --platform linux/amd64 -t pizza62-web:test .` →
**810 MB**, exit 0. The host is arm64, so amd64 is emulated: `npm ci` takes
~4.5 minutes and the whole build ~5. That is the right platform — Container Apps
is amd64 — so the slowness is inherent to building it here, not a fault.

**Verified in the container, not just built:**

| Check | Result |
|---|---|
| Migration from an **empty** database | both migrations applied, seed complete, exit 0 |
| What it created | 30 tables (29 + `schema_migrations`), 61 products, 52 variations, 13 settings, **0 boolean columns** — the deliberate type mapping holds |
| Migration run a second time | `schema already current`, exit 0 — idempotent |
| `vinext start` | boots, `/api/health` → `{"status":"ok"}` HTTP 200 |
| Binds `0.0.0.0` | confirmed via `/proc/net/tcp`: `00000000:0BB8` |
| Runs unprivileged | `uid=1000(node) gid=1000(node)` |
| Externalised native deps resolve | `/api/catalog` returns the seeded menu, so `pg` loaded at runtime |
| Security headers | CSP, HSTS, `X-Frame-Options`, `nosniff` all present |
| **Payment-reaper entrypoint** | run with the exact `command`/`args` from `jobs.tf`: cancelled the 25-minute-old unpaid order, left the 5-minute-old and the already-paid one alone |
| **Outbox-dispatcher entrypoint** | rebuilt with R1.4 and run the same way. With no provider configured it claims nothing and leaves the row `pending` rather than burning its retries; with a (bogus) SendGrid key it claims the row, gets a 401, and fails it in **one** attempt because a 4xx is not retryable |

**One deviation from the command this file used to recommend.** §10 previously
suggested pointing the container at `host.docker.internal`. That cannot work
here: the local Homebrew Postgres listens on `localhost` only, so the container
is refused at the socket. The test used a throwaway `postgres:16-alpine` on a
shared Docker network instead — which needs no change to the developer's Postgres
config and is a **stronger** test, because the migration runs against an empty
database and proves it works from zero rather than against one already migrated
by hand.
