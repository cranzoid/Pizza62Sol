# ---------------------------------------------------------------------------
# Web application
# ---------------------------------------------------------------------------

locals {
  image = "${azurerm_container_registry.main.login_server}/${var.project}-web:${var.image_tag}"

  # Non-secret configuration, identical for the web app and every job. Secrets
  # are attached separately via secret_name so their values never appear here.
  common_env = {
    NODE_ENV                = "production"
    AZURE_STORAGE_ACCOUNT   = azurerm_storage_account.uploads.name
    AZURE_STORAGE_CONTAINER = azurerm_storage_container.uploads.name
    CLOVER_ENVIRONMENT      = var.clover_environment
    EMAIL_FROM              = var.email_from
    # lib/blob-store.ts uses DefaultAzureCredential, which tries several sources
    # in order. Naming the client id makes it pick this user-assigned identity
    # immediately instead of probing and timing out on the others.
    AZURE_CLIENT_ID = azurerm_user_assigned_identity.app.client_id

    # Asserts to lib/security.ts that an ingress always stamps the caller's
    # address, so a request arriving without one bypassed it and must be
    # refused rather than rate limited on a key shared with every other
    # visitor. True for both paths here: Container Apps ingress sets
    # X-Forwarded-For, and Front Door additionally sets X-Azure-ClientIP.
    TRUST_PROXY_HEADERS = "true"
  }

  # Every secret the app reads, mapped to its Key Vault name.
  secret_refs = {
    database-url          = azurerm_key_vault_secret.database_url.versionless_id
    owner-setup-secret    = azurerm_key_vault_secret.owner_setup_secret.versionless_id
    clover-merchant-id    = azurerm_key_vault_secret.placeholders["clover-merchant-id"].versionless_id
    clover-api-token      = azurerm_key_vault_secret.placeholders["clover-api-token"].versionless_id
    clover-webhook-secret = azurerm_key_vault_secret.placeholders["clover-webhook-secret"].versionless_id
    email-api-key         = azurerm_key_vault_secret.placeholders["email-api-key"].versionless_id
    twilio-account-sid    = azurerm_key_vault_secret.placeholders["twilio-account-sid"].versionless_id
    twilio-auth-token     = azurerm_key_vault_secret.placeholders["twilio-auth-token"].versionless_id
  }

  # Secret env vars, in the process.env names lib/runtime-env.ts looks up.
  secret_env = {
    DATABASE_URL          = "database-url"
    OWNER_SETUP_SECRET    = "owner-setup-secret"
    CLOVER_MERCHANT_ID    = "clover-merchant-id"
    CLOVER_API_TOKEN      = "clover-api-token"
    CLOVER_WEBHOOK_SECRET = "clover-webhook-secret"
    EMAIL_API_KEY         = "email-api-key"
    TWILIO_ACCOUNT_SID    = "twilio-account-sid"
    TWILIO_AUTH_TOKEN     = "twilio-auth-token"
  }
}

resource "azurerm_container_app" "web" {
  name                         = "ca-${local.name}-web"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.secret_refs
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"

    # Container Apps terminates TLS on the generated hostname and redirects
    # plain HTTP. middleware.ts adds HSTS on top.
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.web_min_replicas
    max_replicas = var.web_max_replicas

    container {
      name   = "web"
      image  = local.image
      cpu    = var.web_cpu
      memory = var.web_memory

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      env {
        name  = "PGPOOL_MAX"
        value = tostring(var.pg_pool_max)
      }

      env {
        name  = "PORT"
        value = "3000"
      }

      # /api/health round-trips a pooled connection. A replica that cannot reach
      # Postgres must fail readiness and be pulled from rotation rather than
      # accept a checkout it cannot persist.
      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }

      # Liveness is deliberately more forgiving than readiness: a brief database
      # blip should drain traffic, not kill and restart the process.
      liveness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        initial_delay           = 15
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 5
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        interval_seconds        = 5
        timeout                 = 5
        failure_count_threshold = 12
      }
    }

    # Scale on concurrent requests. The database connection budget, not CPU, is
    # the binding constraint - see local.postgres_connection_budget.
    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = "50"
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull, azurerm_role_assignment.keyvault_secrets]

  lifecycle {
    # Terraform 1.5 cannot cross-reference variables from a validation block, so
    # the Postgres connection budget is enforced here, where it fails the plan.
    # See local.postgres_connection_budget in postgres.tf for the arithmetic.
    precondition {
      condition = local.postgres_connection_budget <= local.postgres_max_connections - 5
      error_message = format(
        "Connection budget %d exceeds what %s can serve (%d, less 5 reserved for Azure). Lower web_max_replicas (%d) or pg_pool_max (%d), or move to a larger postgres_sku.",
        local.postgres_connection_budget,
        var.postgres_sku,
        local.postgres_max_connections,
        var.web_max_replicas,
        var.pg_pool_max,
      )
    }
  }
}
