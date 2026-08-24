# ---------------------------------------------------------------------------
# The application: App Service Linux, running Node from source.
#
# This replaces a Container Apps deployment, and the reason is not cost — the
# two are within a few dollars of each other at this size. It is that every
# deploy previously required building a linux/amd64 image on an arm64 laptop
# (~5 minutes, emulated), pushing it to a registry, and rolling a revision. Here
# a deploy is a zip of an already-built tree.
#
# It also matches the stack already running in this subscription for the CRM
# (rg-ptcd-prod), down to the Key Vault references and the Logic App timer — one
# operational shape to learn instead of two.
#
# What goes away with the containers: the registry, the Dockerfile deploy path,
# and Front Door. App Service terminates TLS on a custom domain with a free
# managed certificate, so the ~$35/month Front Door was buying a WAF this
# business does not need at this size.
# ---------------------------------------------------------------------------

resource "azurerm_service_plan" "main" {
  name                = "plan-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = var.app_service_sku
  tags                = local.tags
}

# ---------------------------------------------------------------------------
# Application settings
#
# Secrets are Key Vault *references*, not values: App Service resolves them at
# start-up through the managed identity, so no credential is stored in app
# configuration, in Terraform state, or visible in the portal. Everything else
# is plain configuration and is readable on purpose.
# ---------------------------------------------------------------------------

locals {
  keyvault_reference = {
    for name, id in local.secret_ids :
    name => "@Microsoft.KeyVault(SecretUri=${id})"
  }

  app_settings = merge(
    {
      # Build from source on deploy. The GitHub Actions workflow builds and
      # ships a ready tree, so this is off — Oryx re-running `npm ci` on a
      # single-core instance is several slow minutes during which the site is
      # already swapping.
      SCM_DO_BUILD_DURING_DEPLOYMENT = "false"
      ENABLE_ORYX_BUILD              = "false"
      WEBSITE_NODE_DEFAULT_VERSION   = "~22"

      NODE_ENV = "production"
      PORT     = "8080"

      # Postgres is private, so TLS is mandatory and the certificate is Azure's.
      PGSSLMODE  = "require"
      PGPOOL_MAX = tostring(var.pg_pool_max)

      AZURE_STORAGE_ACCOUNT   = azurerm_storage_account.uploads.name
      AZURE_STORAGE_CONTAINER = azurerm_storage_container.uploads.name
      # Maps requires the account's client ID in x-ms-client-id, not its ARM
      # resource ID. The managed identity itself is selected separately below.
      AZURE_MAPS_CLIENT_ID = azurerm_maps_account.main.x_ms_client_id

      # Which identity to use. An App Service with a user-assigned identity has
      # to be told which one, or DefaultAzureCredential picks arbitrarily.
      AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id

      # The rate limiter refuses to guess when it cannot identify a caller.
      # Behind App Service the forwarded chain is trustworthy on the last hop.
      TRUST_PROXY_HEADERS = "true"

      # Azure terminates TLS before forwarding the request to Vinext. Trust its
      # X-Forwarded-Proto header so request.url keeps the public https scheme;
      # Twilio signs the exact public callback URL and rejects an http mismatch.
      VINEXT_TRUST_PROXY = "1"

      # The dispatcher runs on a timer with no request to derive an origin from,
      # and Twilio needs a URL it can reach for the keypress callback. Points at
      # the default hostname until a custom domain is configured.
      PUBLIC_BASE_URL = var.custom_domain != "" ? "https://${var.custom_domain}" : "https://${local.default_hostname}"
      SEO_INDEXABLE   = var.custom_domain != "" ? "true" : "false"

      # Not secrets, and useful to read at a glance. The API key beside them
      # is a Key Vault reference; these two are just configuration.
      EMAIL_FROM     = var.email_from
      EMAIL_PROVIDER = var.email_provider

      APPLICATIONINSIGHTS_CONNECTION_STRING      = azurerm_application_insights.main.connection_string
      ApplicationInsightsAgent_EXTENSION_VERSION = "~3"

      # Slot warm-up: the swap waits for the app to answer here before sending
      # it traffic, so a deploy that boots slowly does not serve 503s.
      WEBSITE_SWAP_WARMUP_PING_PATH     = "/api/health"
      WEBSITE_SWAP_WARMUP_PING_STATUSES = "200"
      # Migrations run before the server starts, so the container needs longer
      # than the 230-second default to report healthy on a cold start.
      WEBSITES_CONTAINER_START_TIME_LIMIT = "600"
    },
    local.keyvault_reference,
  )
}

resource "azurerm_linux_web_app" "main" {
  name                = "app-${local.name}-${local.suffix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.main.id
  https_only          = true
  tags                = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  key_vault_reference_identity_id = azurerm_user_assigned_identity.app.id

  # Regional VNet integration is what gives the app a route to the private
  # database. `vnet_route_all_enabled` sends *all* outbound traffic through it,
  # which is deliberate: without it, only RFC1918 destinations are routed and
  # the private DNS zone for Postgres is not consulted.
  virtual_network_subnet_id = azurerm_subnet.apps.id

  site_config {
    always_on              = true
    vnet_route_all_enabled = true
    http2_enabled          = true
    minimum_tls_version    = "1.2"
    ftps_state             = "Disabled"
    # App Service restarts an instance that stops answering here. It is a
    # genuine readiness check — /api/health touches the database.
    health_check_path                 = "/api/health"
    health_check_eviction_time_in_min = 5

    application_stack {
      node_version = "22-lts"
    }

    # Migrations, then the server. See startup.sh for why that order matters.
    app_command_line = "sh startup.sh"
  }

  app_settings = local.app_settings

  # These values describe the hostname's role, not the code revision. Keep them
  # with each slot during a swap so staging can never inherit production SEO or
  # callback URLs (and production cannot inherit staging's no-index setting).
  sticky_settings {
    app_setting_names = ["PUBLIC_BASE_URL", "SEO_INDEXABLE"]
  }

  logs {
    detailed_error_messages = false
    failed_request_tracing  = false
    application_logs {
      file_system_level = "Information"
    }
    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # The deploy pipeline sets this; Terraform must not roll it back to
      # whatever was current when infrastructure was last applied.
      site_config[0].application_stack[0].node_version,
      tags["hidden-link: /app-insights-resource-id"],
    ]

    # A precondition rather than a `check`: a check emits a warning, and a
    # warning does not stop someone raising pg_pool_max straight into connection
    # exhaustion, where every route starts throwing "too many clients" — a failed
    # checkout, not a tidy error page. This fails the plan.
    precondition {
      condition     = local.postgres_connection_budget <= local.postgres_max_connections - 5
      error_message = "Postgres connection budget (${local.postgres_connection_budget}) is within 5 of the ${local.postgres_max_connections}-connection cap for ${var.postgres_sku}. Lower pg_pool_max or raise postgres_sku."
    }
  }
}

# ---------------------------------------------------------------------------
# Staging slot
#
# The reason this tier was chosen. A deploy publishes here, waits for the app to
# answer /api/health, and then swaps — so the customer-facing hostname never
# serves a starting instance. On Basic there are no slots and every deploy is
# 30-60 seconds of downtime, which for a restaurant means during dinner.
#
# The slot shares the plan, so it costs nothing extra.
# ---------------------------------------------------------------------------

resource "azurerm_linux_web_app_slot" "staging" {
  name           = "staging"
  app_service_id = azurerm_linux_web_app.main.id
  https_only     = true
  tags           = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
  key_vault_reference_identity_id = azurerm_user_assigned_identity.app.id

  virtual_network_subnet_id = azurerm_subnet.apps.id

  site_config {
    always_on              = true
    vnet_route_all_enabled = true
    http2_enabled          = true
    minimum_tls_version    = "1.2"
    ftps_state             = "Disabled"
    # Azure requires the eviction window whenever a health check path is set.
    health_check_path                 = "/api/health"
    health_check_eviction_time_in_min = 5

    application_stack {
      node_version = "22-lts"
    }

    app_command_line = "sh startup.sh"
  }

  # The same settings as production, including the same database. A staging slot
  # pointed at a different database would swap into production with a warm cache
  # of the wrong data — and the swap is the point, not the isolation.
  app_settings = merge(local.app_settings, {
    # Except this: a slot that is about to become production must not be
    # indexed, and must not be the URL in a customer's notification email.
    PUBLIC_BASE_URL = "https://${azurerm_linux_web_app.main.name}-staging.azurewebsites.net"
    SEO_INDEXABLE   = "false"
  })

  lifecycle {
    ignore_changes = [
      site_config[0].application_stack[0].node_version,
      tags["hidden-link: /app-insights-resource-id"],
    ]
  }
}

# ---------------------------------------------------------------------------
# Custom domain
#
# Both `pizza62.ca` and `www.pizza62.ca` are bound, because a customer types
# whichever they remember and a certificate covers exactly the names it was
# issued for. Each gets its own free managed certificate.
#
# **The apex and the www record are not the same kind of record**, and this is
# the part that catches people:
#
# - `www.pizza62.ca` is a **CNAME** to the App Service hostname. If the app's
#   inbound IP ever changes — a tier change, a regional move — this keeps working.
# - `pizza62.ca` cannot be a CNAME. DNS forbids one at a zone apex alongside the
#   SOA and NS records, so it has to be an **A record** to the inbound IP. That
#   address is stable in practice but is not contractually pinned, so it is worth
#   knowing this is the record that would need updating if the app were rebuilt.
#
# Both also need an `asuid.<host>` TXT record proving ownership, and all of it
# must resolve *before* this applies — Azure verifies at binding time and refuses
# otherwise. `terraform output custom_domain_dns_records` prints exactly what to
# create.
# ---------------------------------------------------------------------------

locals {
  # The apex plus any aliases, as one set. Empty disables the whole block, so the
  # infrastructure can be applied and running before DNS is ready to move.
  custom_hostnames = var.custom_domain == "" ? toset([]) : toset(concat([var.custom_domain], var.custom_domain_aliases))
}

resource "azurerm_app_service_custom_hostname_binding" "main" {
  for_each            = local.custom_hostnames
  hostname            = each.value
  app_service_name    = azurerm_linux_web_app.main.name
  resource_group_name = azurerm_resource_group.main.name

  # The certificate binding below owns these two fields once it exists. Without
  # ignoring them here the two resources fight, and every plan shows a diff.
  lifecycle {
    ignore_changes = [ssl_state, thumbprint]
  }
}

resource "azurerm_app_service_managed_certificate" "main" {
  for_each                   = local.custom_hostnames
  custom_hostname_binding_id = azurerm_app_service_custom_hostname_binding.main[each.value].id
}

resource "azurerm_app_service_certificate_binding" "main" {
  for_each            = local.custom_hostnames
  hostname_binding_id = azurerm_app_service_custom_hostname_binding.main[each.value].id
  certificate_id      = azurerm_app_service_managed_certificate.main[each.value].id
  ssl_state           = "SniEnabled"
}

locals {
  default_hostname = "app-${local.name}-${local.suffix}.azurewebsites.net"
}
