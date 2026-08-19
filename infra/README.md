# Pizza 62 — Azure infrastructure

Terraform for the target architecture in
`~/.claude/plans/ancient-wishing-wadler.md`. Replaces the Cloudflare Workers
deployment that R1.1 ported away from.

```
Container Apps environment (VNet-injected, canadacentral)
├── ca-pizza62-<env>-web        Node 22 / vinext, 1..3 replicas, public ingress
├── caj-…-migrate               manual   — schema + seed, runs before each deploy
├── caj-…-outbox                */1      — R1.4, off until the script exists
└── caj-…-reaper                */5      — R1.3, off until the script exists

psql-pizza62-<env>   Postgres 16 Flexible Server, private (VNet-integrated), 7-day PITR
st…                  Blob Storage — uploads
kv-pizza62-<env>     Key Vault — every secret, read via managed identity
acr…                 Container Registry (Basic)
maps-pizza62-<env>   Azure Maps — delivery-address geocoding (H-06b)
afd-pizza62-<env>    Front Door Standard — optional, off by default
```

## Decisions worth knowing before you change something

**Postgres has no public endpoint.** It is VNet-integrated through a delegated
subnet, so it is unreachable from a laptop by design. Schema work goes through
the `db-migrate` job. For a genuine break-glass `psql`, put a temporary jumpbox
in `snet-apps` and delete it afterwards.

**The connection budget is a real limit.** `B_Standard_B1ms` allows 50
connections. `postgres.tf` computes worst-case demand as
`web_max_replicas × pg_pool_max + jobs × job_pg_pool_max` and a `check` block
fails `plan` if it gets within 5 of the cap. Raising `web_max_replicas` without
raising the SKU is how you turn a busy Friday into failed checkouts.

**Front Door is off.** Standard is ~$35/month flat and does nothing while the
app is served on its generated `*.azurecontainerapps.io` hostname, which already
has TLS. Turn it on with the domain (below).

**Both cron jobs are off.** They are gated behind `enable_outbox_dispatcher` and
`enable_payment_reaper` because `scripts/dispatch-outbox.ts` and
`scripts/reap-payments.ts` do not exist yet. Turn each on with the release that
writes it — R1.4 and R1.3 respectively.

**No storage account key exists.** `shared_access_key_enabled = false`; the app
uses its managed identity. This also means whoever runs `terraform apply` needs
`Storage Blob Data Contributor`, which Terraform grants itself.

## First-time setup

```bash
# 1. State backend (once per subscription)
cd infra/bootstrap
terraform init && terraform apply
terraform output -raw backend_hcl > ../backend.hcl

# 2. Main configuration
cd ..
terraform init -backend-config=backend.hcl
terraform workspace new dev

# 3. The registry must exist before an image can be pushed to it, and the
#    Container App cannot start without an image to pull. So: registry first.
terraform apply -target=azurerm_container_registry.main

# 4. Build and push an initial image
az acr login --name "$(terraform output -raw container_registry | cut -d. -f1)"
docker build --platform linux/amd64 -t "$(terraform output -raw image_repository):latest" ..
docker push "$(terraform output -raw image_repository):latest"

# 5. Everything else
terraform apply

# 6. Schema + seed
az containerapp job start \
  --name "$(terraform output -raw migrate_job)" \
  --resource-group "$(terraform output -raw resource_group)"

# 7. Bootstrap the owner account
terraform output -raw app_url
az keyvault secret show --vault-name "$(terraform output -raw key_vault)" \
  --name owner-setup-secret --query value -o tsv
```

`--platform linux/amd64` is not optional on an Apple Silicon machine. Without
it the image is arm64, and it fails with an exec-format error only once it is
in Azure.

## Routine deploys

```bash
cd infra && ./deploy.sh
```

Builds the current git SHA, pushes, runs migrations, waits for them to succeed,
then rolls the revision. It stops before deploying if the migration fails —
new code against an old schema is worse than not deploying.

## Third-party secrets

Terraform creates these holding the literal value `pending`, with
`ignore_changes = [value]` so an apply never reverts a real credential. Set each
one as it arrives:

```bash
VAULT="$(terraform output -raw key_vault)"
az keyvault secret set --vault-name "$VAULT" --name clover-merchant-id    --value '...'
az keyvault secret set --vault-name "$VAULT" --name clover-api-token      --value '...'
az keyvault secret set --vault-name "$VAULT" --name clover-webhook-secret --value '...'
az keyvault secret set --vault-name "$VAULT" --name email-api-key         --value '...'
az keyvault secret set --vault-name "$VAULT" --name twilio-account-sid    --value '...'
az keyvault secret set --vault-name "$VAULT" --name twilio-auth-token     --value '...'
```

The Container App resolves secrets when a revision starts, so a new value needs
a restart to take effect:

```bash
az containerapp revision restart --name ca-pizza62-dev-web \
  --resource-group "$(terraform output -raw resource_group)" \
  --revision "$(az containerapp show -n ca-pizza62-dev-web \
      -g "$(terraform output -raw resource_group)" \
      --query properties.latestRevisionName -o tsv)"
```

`terraform output pending_secrets` lists which are still placeholders.

## Adding the custom domain

```hcl
enable_front_door = true
custom_domain     = "order.pizza62.ca"
```

`terraform apply`, then read `terraform output front_door_dns_records` and add
the CNAME and the `_dnsauth` TXT record at the registrar. Managed-certificate
validation completes on its own once the TXT record resolves.

## Environments

`dev` and `prod` are Terraform workspaces over one backend; every resource name
carries the workspace, so the two never collide.

```bash
terraform workspace select prod
terraform apply -var="image_tag=$(git rev-parse --short HEAD)"
```

Pin `image_tag` to a SHA in prod. `latest` makes it impossible to tell what is
actually running.

## Rough monthly cost (lean defaults, canadacentral)

| Item | ~USD/mo |
|---|---|
| Postgres B1ms, 32 GB, 7-day PITR | 18 |
| Container Apps, 1 always-on 0.5 vCPU / 1 GiB replica | 15 |
| Container Registry Basic | 5 |
| Blob Storage + Log Analytics + Key Vault + private DNS + Maps | 5 |
| **Total** | **~43** |
| *Front Door Standard, when enabled* | *+35* |
