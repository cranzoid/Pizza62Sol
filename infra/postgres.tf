# ---------------------------------------------------------------------------
# Postgres Flexible Server
#
# This is what replaces D1. Everything the restaurant cannot afford to lose -
# orders, accounts, timesheets - lives here, so PITR and TLS are non-negotiable
# and the connection budget below is a real constraint, not a formality.
# ---------------------------------------------------------------------------

locals {
  # Azure derives max_connections from the SKU's memory. B_Standard_B1ms (2 GiB)
  # allows 50. Azure reserves a handful for its own monitoring and for the
  # superuser, so treat ~45 as spendable.
  #
  # Worst-case concurrent demand:
  #   web  : web_max_replicas * pg_pool_max
  #   jobs : (db-migrate, plus whichever cron jobs are enabled) * job_pg_pool_max
  #
  # With the defaults - 3 replicas, no cron jobs yet - that is 3*8 + 1*4 = 28.
  # With both cron jobs on it becomes 36. Raising web_max_replicas or
  # pg_pool_max without raising the SKU exhausts the server, and every route
  # starts throwing "too many clients": a failed checkout, not a tidy error page.
  job_count = 1 + (var.enable_outbox_dispatcher ? 1 : 0) + (var.enable_payment_reaper ? 1 : 0)

  postgres_connection_budget = (var.web_max_replicas * var.pg_pool_max) + (local.job_count * var.job_pg_pool_max)

  postgres_connection_cap = {
    "B_Standard_B1ms"     = 50
    "B_Standard_B2s"      = 100
    "B_Standard_B2ms"     = 171
    "GP_Standard_D2ds_v4" = 771
  }

  postgres_max_connections = lookup(local.postgres_connection_cap, var.postgres_sku, 50)
}

# The budget is enforced as a precondition on the web app (container_app.tf)
# rather than a `check` block: a check only emits a warning, and a warning does
# not stop someone raising web_max_replicas straight into a connection
# exhaustion. A precondition fails the plan.

resource "random_password" "postgres_admin" {
  length = 32
  # Azure rejects several punctuation characters in the admin password and the
  # value also has to survive being embedded in a URL.
  special          = true
  override_special = "-_.~"
}

# VNet-integrated Flexible Servers resolve through a private zone rather than
# the public DNS name. The zone must exist and be linked before the server is
# created, or the server comes up unreachable.
resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "link-${local.name}-postgres"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                = "psql-${local.name}-${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  version                = "16"
  sku_name               = var.postgres_sku
  storage_mb             = var.postgres_storage_mb
  administrator_login    = "pizza62admin"
  administrator_password = random_password.postgres_admin.result

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = false

  delegated_subnet_id = azurerm_subnet.postgres.id
  private_dns_zone_id = azurerm_private_dns_zone.postgres.id

  # Burstable SKUs do not support zone redundancy or HA.
  zone = "1"

  tags = local.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    # Changing the admin password out of band (or regenerating the random value)
    # must not silently recreate the server.
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "pizza62"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    # Dropping the database drops every order in it. Terraform should never do
    # that as a side effect of a rename.
    prevent_destroy = true
  }
}

# The app connects with sslmode=require; this makes the server refuse anything
# less rather than trusting the client to ask.
resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "ON"
}

# Postgres 16 defaults to a 30-second idle timeout of nothing; long-idle pooled
# connections from a scaled-to-zero job would otherwise sit open until the
# server's own limit. 10 minutes reclaims them without churning the web pool.
resource "azurerm_postgresql_flexible_server_configuration" "idle_timeout" {
  name      = "idle_in_transaction_session_timeout"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "600000"
}
