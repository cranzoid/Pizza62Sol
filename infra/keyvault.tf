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
  # Created holding "pending" so the app can reference them from day one. App
  # Service fails to start an instance whose Key Vault reference cannot resolve,
  # so these must exist even while Clover and Twilio are still unknown.
  #
  # Note that the *application* no longer depends on these being the source of
  # truth: lib/integration-secrets.ts reads the encrypted database store first
  # and falls back to the environment. They remain here so the credentials can
  # be set either way — from the admin Integrations screen, or in Key Vault by
  # someone who would rather not type a payment token into a web form.
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

# ---------------------------------------------------------------------------
# What the app sees
#
# Maps each Key Vault secret to the environment variable it populates. App
# Service resolves these at start-up through the managed identity, so the value
# never enters app configuration, Terraform state, or the portal.
#
# Versionless URIs (no trailing version segment) so rotating a secret takes
# effect on the next restart without a Terraform apply — which is the whole point
# of being able to rotate one at 9pm.
# ---------------------------------------------------------------------------

locals {
  secret_ids = {
    DATABASE_URL            = azurerm_key_vault_secret.database_url.versionless_id
    OWNER_SETUP_SECRET      = azurerm_key_vault_secret.owner_setup_secret.versionless_id
    SETTINGS_ENCRYPTION_KEY = azurerm_key_vault_secret.settings_encryption_key.versionless_id
    CRON_SECRET             = azurerm_key_vault_secret.cron_secret.versionless_id
    CLOVER_MERCHANT_ID      = azurerm_key_vault_secret.placeholders["clover-merchant-id"].versionless_id
    CLOVER_API_TOKEN        = azurerm_key_vault_secret.placeholders["clover-api-token"].versionless_id
    CLOVER_WEBHOOK_SECRET   = azurerm_key_vault_secret.placeholders["clover-webhook-secret"].versionless_id
    EMAIL_API_KEY           = azurerm_key_vault_secret.placeholders["email-api-key"].versionless_id
    TWILIO_ACCOUNT_SID      = azurerm_key_vault_secret.placeholders["twilio-account-sid"].versionless_id
    TWILIO_AUTH_TOKEN       = azurerm_key_vault_secret.placeholders["twilio-auth-token"].versionless_id
  }

  # Reported by `terraform output pending_secrets` so it is obvious what still
  # needs a real value before the site can take a payment.
  placeholder_secret_names = local.placeholder_secrets
}

# ---------------------------------------------------------------------------
# The key that encrypts owner-set credentials
#
# lib/integration-secrets.ts stores the Clover and Twilio credentials the owner
# types into the admin screen as AES-256-GCM ciphertext under this key. It lives
# here and never in the database, so a database dump on its own yields nothing —
# an attacker needs both the dump and the app's identity.
#
# Generated rather than supplied: there is no reason for a human ever to see it,
# and one that has been pasted into a terminal is one that is in a shell history.
# ---------------------------------------------------------------------------

resource "random_password" "settings_encryption_key" {
  length  = 32
  special = false
}

resource "azurerm_key_vault_secret" "settings_encryption_key" {
  name = "settings-encryption-key"
  # base64 of 32 bytes, which is what lib/integration-secrets.ts expects.
  value        = base64encode(random_password.settings_encryption_key.result)
  key_vault_id = azurerm_key_vault.main.id
  content_type = "AES-256 key for owner-set integration credentials"

  depends_on = [time_sleep.keyvault_rbac_propagation]

  lifecycle {
    # Rotating this makes every already-stored credential undecryptable, and the
    # app treats an undecryptable secret as unset — so a rotation silently turns
    # off payments until every credential is re-entered. If it must be rotated,
    # re-enter the credentials in the same visit.
    ignore_changes = [value]
  }
}
