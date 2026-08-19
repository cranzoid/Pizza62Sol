# ---------------------------------------------------------------------------
# Key Vault
#
# Replaces `wrangler secret`. The Container App references secrets by their
# Key Vault URI and resolves them with the workload identity at revision start,
# so no secret value is ever written into Terraform state as a container env
# var, nor visible in `az containerapp show`.
#
# Values that Terraform generates (the database URL, the owner bootstrap secret)
# are written here by Terraform. Values that come from a third party - Clover,
# Twilio, SendGrid - are created as placeholders and filled in out of band:
#
#   az keyvault secret set --vault-name <vault> --name clover-api-token --value '...'
#
# `ignore_changes = [value]` on those keeps the next apply from reverting them.
# ---------------------------------------------------------------------------

resource "azurerm_key_vault" "main" {
  name                = "kv-${var.project}-${local.env_short}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # RBAC rather than access policies: the same role assignments that govern
  # every other resource, and revocable centrally.
  rbac_authorization_enabled = true

  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  tags = local.tags
}

# Terraform needs data-plane rights to write the secrets below.
resource "azurerm_role_assignment" "terraform_keyvault_admin" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "time_sleep" "keyvault_rbac_propagation" {
  depends_on      = [azurerm_role_assignment.terraform_keyvault_admin]
  create_duration = "30s"
}

# --- Secrets Terraform owns -------------------------------------------------

resource "random_password" "owner_setup_secret" {
  length  = 40
  special = false
}

locals {
  # sslmode=require is what the driver expects in Azure; db/pg-driver.ts only
  # disables TLS when PGSSLMODE=disable, which is a local-only setting.
  database_url = format(
    "postgres://%s:%s@%s:5432/%s?sslmode=require",
    azurerm_postgresql_flexible_server.main.administrator_login,
    urlencode(random_password.postgres_admin.result),
    azurerm_postgresql_flexible_server.main.fqdn,
    azurerm_postgresql_flexible_server_database.main.name,
  )
}

resource "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  value        = local.database_url
  key_vault_id = azurerm_key_vault.main.id
  content_type = "postgres connection string"

  depends_on = [time_sleep.keyvault_rbac_propagation]
}

resource "azurerm_key_vault_secret" "owner_setup_secret" {
  name         = "owner-setup-secret"
  value        = random_password.owner_setup_secret.result
  key_vault_id = azurerm_key_vault.main.id
  content_type = "one-time owner bootstrap"

  depends_on = [time_sleep.keyvault_rbac_propagation]
}

# --- Secrets filled in out of band -----------------------------------------

locals {
  # Created empty so the Container App can reference them from day one. A
  # revision will not start if it references a secret that does not exist, so
  # these must be present even while Clover and Twilio are still pending.
  placeholder_secrets = [
    "clover-merchant-id",
    "clover-api-token",
    "clover-webhook-secret",
    "email-api-key",
    "twilio-account-sid",
    "twilio-auth-token",
  ]
}

resource "azurerm_key_vault_secret" "placeholders" {
  for_each = toset(local.placeholder_secrets)

  name         = each.value
  value        = "pending"
  key_vault_id = azurerm_key_vault.main.id
  content_type = "set out of band - see infra/README.md"

  depends_on = [time_sleep.keyvault_rbac_propagation]

  lifecycle {
    # The real value is set with `az keyvault secret set`. Without this, every
    # apply would reset live credentials back to "pending" and take the site
    # down at the next revision.
    ignore_changes = [value]
  }
}
