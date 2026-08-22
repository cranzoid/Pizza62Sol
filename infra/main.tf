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

# App Service regional VNet integration. Delegated to Microsoft.Web/serverFarms
# and sized /26: a Container Apps environment demanded a /23, but App Service
# integration only needs one address per instance plus Azure's five reserved,
# and an over-large subnet is address space that cannot be reused.
resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.0.0/26"]

  delegation {
    name = "app-service"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.2.0/24"]
  # Flexible Server adds this endpoint while provisioning its delegated
  # subnet. Declare it so later applies preserve the database's Azure Storage
  # dependency instead of treating it as drift to remove.
  service_endpoints = ["Microsoft.Storage"]

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
  # Application stdout/stderr is the only real source of debugging once the
  # database is private, and it is what the alert rules query. 30 days is the
  # free-tier retention.
  retention_in_days = 30
  tags              = local.tags
}

# ---------------------------------------------------------------------------
# Workload identity
#
# One user-assigned identity shared by the web app and its staging slot. It is
# user-assigned rather than system-assigned so the role assignments below can be
# created in the same apply as the resources that use it - a system-assigned
# identity does not exist until its parent does, which would force a second
# apply before the app could read its own secrets. It is also what makes the
# staging slot and production share one set of grants rather than two.
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
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
# GitHub Actions deploy identity
#
# Federated credentials rather than a service principal secret: GitHub presents
# a short-lived token whose subject claim Azure checks against the trust below.
# There is no credential to leak, rotate, or find in a screenshot, and one that
# was somehow captured is useless outside a workflow run on this repository.
#
# Scoped to the resource group, not the subscription, and to Website Contributor
# rather than Contributor — the pipeline publishes code and swaps slots. It has
# no business creating infrastructure, and Terraform is what does that.
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "github_actions" {
  count               = var.github_repository == "" ? 0 : 1
  name                = "id-${local.name}-github"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_main" {
  count               = var.github_repository == "" ? 0 : 1
  name                = "github-main"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.github_actions[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  # Pinned to the default branch. A pull request from a fork gets a different
  # subject claim and is refused, so a stranger's PR cannot deploy.
  subject = "repo:${var.github_repository}:ref:refs/heads/main"
}

# The workflow's `environment: production` produces its own subject claim, which
# is what makes a manual approval gate meaningful — without this the run would
# fail the moment someone enabled the gate.
resource "azurerm_federated_identity_credential" "github_environment" {
  count               = var.github_repository == "" ? 0 : 1
  name                = "github-production"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.github_actions[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_repository}:environment:production"
}

resource "azurerm_role_assignment" "github_website_contributor" {
  count                = var.github_repository == "" ? 0 : 1
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Website Contributor"
  principal_id         = azurerm_user_assigned_identity.github_actions[0].principal_id
}
