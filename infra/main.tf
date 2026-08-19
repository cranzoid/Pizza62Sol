# ---------------------------------------------------------------------------
# Naming, tagging and shared lookups
# ---------------------------------------------------------------------------

locals {
  env = terraform.workspace

  # Globally-unique names (storage, ACR, Key Vault) need a stable suffix that is
  # not guessable from the project name alone.
  suffix = substr(sha1("${var.project}-${local.env}-${var.subscription_id}"), 0, 6)

  name = "${var.project}-${local.env}"

  # Key Vault names are capped at 24 characters, which "kv-<project>-<env>-<suffix>"
  # can exceed for a long workspace name - "default" already produces 25 and fails
  # the apply with a message that names no resource. Truncating the environment
  # token keeps the name inside the limit for any workspace.
  env_short = substr(local.env, 0, 6)

  tags = merge({
    project     = var.project
    environment = local.env
    managed_by  = "terraform"
  }, var.tags)
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

# ---------------------------------------------------------------------------
# Network
#
# Postgres is reached over VNet integration rather than a public endpoint, so
# the database has no internet-facing address at all. Both the Container Apps
# environment and the database server need their own delegated subnet, and the
# Container Apps consumption environment requires at least a /23.
#
# Operational note: with no public endpoint you cannot reach Postgres from a
# laptop. Use the db-migrate job (`az containerapp job start`) for schema work,
# or stand up a temporary jumpbox in snet-apps for a break-glass psql session.
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.20.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.0.0/23"]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.2.0/24"]

  # A delegated subnet may hold nothing but Flexible Servers.
  delegation {
    name = "postgres-flexible-server"
    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }
}

# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  # Container Apps console and system logs are the only real source of debugging
  # once the database is private. 30 days is the free-tier retention.
  retention_in_days = 30
  tags              = local.tags
}

# ---------------------------------------------------------------------------
# Container registry
#
# Basic is $5/month and enough for one image with a handful of tags. The admin
# account stays off: the Container App and the jobs pull with a managed identity
# holding AcrPull, so there is no registry password anywhere.
# ---------------------------------------------------------------------------

resource "azurerm_container_registry" "main" {
  name                = "acr${var.project}${local.env}${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

# ---------------------------------------------------------------------------
# Workload identity
#
# One user-assigned identity shared by the web app and all three jobs. It is
# user-assigned rather than system-assigned so the role assignments below can be
# created in the same apply as the resources that use it - a system-assigned
# identity does not exist until its parent is created, which would force a
# second apply before the app could pull its own image.
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "blob_contributor" {
  scope                = azurerm_storage_account.uploads.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "keyvault_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------------------------------------------------------------------------
# Container Apps environment
#
# internal_load_balancer_enabled = false keeps the generated
# *.azurecontainerapps.io hostname publicly resolvable while outbound traffic
# still routes through the VNet and can reach the private database.
# ---------------------------------------------------------------------------

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.name}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  infrastructure_subnet_id       = azurerm_subnet.apps.id
  internal_load_balancer_enabled = false

  tags = local.tags
}
