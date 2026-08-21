# Infrastructure

Azure, as Terraform. **49 resources**, `canadacentral`, roughly **US$84/month**.

## What this is and why

App Service Linux running Node from source, with a staging slot, in front of a
private Postgres Flexible Server.

It replaced a Container Apps deployment, and **the reason was not cost** — the
two are within a few dollars of each other at this size. It was that every deploy
required building a `linux/amd64` image on an arm64 laptop (about five minutes,
emulated), pushing it to a registry, and rolling a revision. Here a deploy is a
zip of an already-built tree.

It also matches the stack already running in this subscription for the CRM
(`rg-ptcd-prod`) down to the Key Vault references and the Logic App timer, so
there is one operational shape to learn rather than two.

Gone with the containers: the registry (~$5/month), the Dockerfile deploy path,
and Front Door (~$35/month). App Service terminates TLS on a custom domain with a
free managed certificate, which is what Front Door was mostly buying.

```
GitHub push → Actions: test, build, zip
                 ↓
       publish to the STAGING slot
                 ↓  wait for /api/health to answer "ok"
            slot swap  ← zero downtime
                 ↓
  App Service P0v3 (NODE|22-lts, Always On)
     ├── VNet integration → Postgres Flexible Server (no public endpoint)
     ├── Key Vault references for every secret
     ├── Blob (uploads) via managed identity
     └── App Insights → Log Analytics → alerts
                 ↑
  Logic App, every minute → POST /api/cron/tick
```

## Monthly cost

| | |
|---|---|
| App Service P0v3 (Linux) | $61.32 |
| Postgres B1ms + 32 GB Premium SSD | ~$18 |
| Logic App (~43,000 runs) | ~$2 |
| Blob, Key Vault, Log Analytics, Maps | ~$3 |
| **Total** | **~$84** |

Dropping to **B1** takes this to about **$36**, and is a one-line change to
`app_service_sku` with no code change. What it costs is the staging slot —
Basic has none, so every deploy becomes 30–60 seconds of downtime, which for a
restaurant means during dinner. Remove the slot resources before switching, or
the apply fails.

## First bring-up

```bash
# 1. Remote state (once per subscription).
cd infra/bootstrap && terraform init && terraform apply
# Copy the printed values into infra/backend.hcl.

# 2. Everything else.
cd .. && terraform init -backend-config=backend.hcl
terraform workspace new prod        # or use `default` for a single environment
terraform apply
```

No `-target` step is needed any more. The container deployment required one,
because a registry had to exist before an image could be pushed into it; there is
no registry now.

## After the first apply

```bash
# The one-time owner bootstrap secret. Use it at /admin, then it is spent.
terraform output -raw owner_setup_secret_command | bash

# What still needs real credentials.
terraform output pending_secrets
```

Credentials can be set **either** in the admin Integrations screen (encrypted in
the database under `SETTINGS_ENCRYPTION_KEY`, which stays in Key Vault) **or**
directly in Key Vault:

```bash
az keyvault secret set --vault-name "$(terraform output -raw key_vault)" \
  --name clover-api-token --value '…'
```

The application reads the database first and falls back to Key Vault, so both
work. The admin screen exists so the owner can do it without an Azure login; Key
Vault exists so a developer can, without typing a payment token into a web form.

The placeholder secrets have `ignore_changes` on their value, so setting one out
of band is safe and a later apply will not revert it.

## Deploying

Normally: push to `main`. To wire that up, set `github_repository`, apply, then
paste `terraform output github_actions_variables` into the repository's Actions
**variables** (not secrets — none of them is one; the trust is the federated
credential).

By hand: `./infra/deploy.sh`. Same steps, same order.

Rolling back is a swap, not a rebuild — the previous build is still in the
staging slot:

```bash
az webapp deployment slot swap -g "$(terraform output -raw resource_group)" \
  -n "$(terraform output -raw app_name)" --slot staging --target-slot production
```

## The custom domain

Two passes, because Azure will not accept the binding until DNS resolves.

1. `terraform output custom_domain_dns_records` — but this is empty until
   `custom_domain` is set, so set it first and read the records from the failed
   plan, or construct them: `CNAME` to the default hostname, and
   `asuid.<domain> TXT <custom_domain_verification_id>`.
2. Create both records at the registrar, wait for propagation, then apply.

The managed certificate is free and renews itself.

Set the custom domain **before** giving Clover and Twilio their callback URLs, or
they will point at `*.azurewebsites.net` and have to be changed again.

## Reaching the database

There is no public endpoint, by design. Schema changes apply themselves from
`startup.sh` on every deploy. For a break-glass `psql`, the shortest route is the
App Service SSH console:

```bash
az webapp ssh -g "$(terraform output -raw resource_group)" -n "$(terraform output -raw app_name)"
# inside: the DATABASE_URL environment variable is already resolved
```

## Backups

Three layers, and they fail differently. See `backups.tf` for the full note.

- **Postgres PITR**, 35 days, on the server itself. Recovers a bad migration to
  any second in the window. Does not survive the server being deleted.
- **Blob versioning and soft delete**, 30 days, on the uploads account. Recovers
  a menu photo the owner overwrote — PITR does not cover blobs at all.
- **A weekly logical dump**, which is manual, and deliberately so. It needs
  `pg_dump` with network access to a private database, which on Container Apps
  was a scheduled job; adding a container platform back for one weekly dump is a
  lot of parts. It is the layer that matters when the other two do not, because a
  dump in a storage account is restorable without Azure's cooperation:

```bash
az webapp ssh -g "$RG" -n "$APP"           # inside the app, which can reach the database
pg_dump "$DATABASE_URL" | gzip > /tmp/pizza62-$(date +%F).sql.gz
# then download it and put it somewhere that is not this subscription
```

## Alerts

`alert_emails` — the developer, not the restaurant. The owner cannot act on a
failed health check, and an alert nobody can act on is one everybody learns to
ignore.

| Alert | Fires when | Why it is worth waking up for |
|---|---|---|
| health | `/api/health` failing for 5 min | Customers cannot order. Covers the app, the database, and a bad migration in one rule |
| 5xx | more than 5 in 5 min | A single error is noise; a rate is an outage |
| db-storage | above 80% | A full disk makes Postgres read-only, and the warning is visible days ahead |
| db-connections | any refused connection | The budget is arithmetic; this catches an assumption being wrong |
| notifications | a sweep logged a failure | Somebody was not told about an order — silent by nature, since nobody watches a table |

## Notes that will save you time

- **`vnet_route_all_enabled` is load-bearing.** Without it only RFC1918
  destinations route through the VNet, the private DNS zone for Postgres is never
  consulted, and the app cannot resolve its own database.
- **The connection budget is a plan-time precondition, not a warning.** Worst
  case is both slots warm during a swap: `2 × pg_pool_max`, currently 16 of 50.
  Raising `pg_pool_max` without raising `postgres_sku` fails the plan on purpose —
  exhausting connections turns every route into "too many clients", which is a
  failed checkout rather than a tidy error page.
- **`SETTINGS_ENCRYPTION_KEY` has `ignore_changes`.** Rotating it makes every
  stored credential undecryptable, and the app treats undecryptable as unset — so
  a rotation silently turns off payments until every credential is re-entered.
- **Key Vault references are versionless**, so rotating a secret takes effect on
  the next restart with no Terraform apply.
