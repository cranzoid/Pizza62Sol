# ---------------------------------------------------------------------------
# Container Apps jobs
#
# Three background workers, all running the same image as the web app:
#
#   db-migrate         manual  - run before a new revision takes traffic
#   outbox-dispatcher  */1     - drains notification_outbox (built in R1.4)
#   payment-reaper     */5     - cancels stale awaiting_payment orders (R1.3)
#
# The two cron jobs are written now but their entrypoints do not exist yet, so
# both are gated behind a `count` and default to not being created. Scheduling a
# job whose script is missing would put a crash in the alert stream every minute.
# R1.3 sets enable_payment_reaper; R1.4 sets enable_outbox_dispatcher.
#
# Cron expressions are evaluated in UTC.
# ---------------------------------------------------------------------------

locals {
  # Jobs need the same secrets as the web app, minus nothing - the dispatcher
  # needs Twilio, the reaper needs Clover, the migration needs the database.
  job_env = merge(local.common_env, {
    PGPOOL_MAX = tostring(var.job_pg_pool_max)
  })
}

# --- db-migrate -------------------------------------------------------------

resource "azurerm_container_app_job" "migrate" {
  name                         = "caj-${local.name}-migrate"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  tags                         = local.tags

  # Seeding 61 products and 52 variations on a burstable tier is not instant.
  replica_timeout_in_seconds = 600
  replica_retry_limit        = 1

  # Triggered by the deploy script, not on a schedule: it must complete before
  # the new revision takes traffic.
  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

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

  template {
    container {
      name   = "migrate"
      image  = local.image
      cpu    = 0.5
      memory = "1Gi"

      # scripts/migrate.ts runs from source through Node's type-stripping
      # loader, which is why the Dockerfile's runtime stage keeps drizzle/,
      # scripts/, db/, lib/ and the alias hooks alongside dist/.
      command = ["node"]
      args    = ["--import", "./register-alias.mjs", "--experimental-strip-types", "scripts/migrate.ts"]

      dynamic "env" {
        for_each = local.job_env
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
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull, azurerm_role_assignment.keyvault_secrets]
}

# --- outbox-dispatcher (R1.4) ----------------------------------------------

resource "azurerm_container_app_job" "outbox_dispatcher" {
  # Created only once scripts/dispatch-outbox.ts exists (R1.4).
  count = var.enable_outbox_dispatcher ? 1 : 0

  name                         = "caj-${local.name}-outbox"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  tags                         = local.tags

  # A minute's cadence with a timeout under the interval, so a stuck run cannot
  # pile up behind the next trigger.
  replica_timeout_in_seconds = 50
  replica_retry_limit        = 0

  schedule_trigger_config {
    cron_expression          = "*/1 * * * *"
    parallelism              = 1
    replica_completion_count = 1
  }

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

  template {
    container {
      name   = "outbox"
      image  = local.image
      cpu    = 0.25
      memory = "0.5Gi"

      command = ["node"]
      args    = ["--import", "./register-alias.mjs", "--experimental-strip-types", "scripts/dispatch-outbox.ts"]

      dynamic "env" {
        for_each = local.job_env
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
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull, azurerm_role_assignment.keyvault_secrets]
}

# --- payment-reaper (R1.3) --------------------------------------------------

resource "azurerm_container_app_job" "payment_reaper" {
  # Created only once scripts/reap-payments.ts exists (R1.3).
  count = var.enable_payment_reaper ? 1 : 0

  name                         = "caj-${local.name}-reaper"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  tags                         = local.tags

  replica_timeout_in_seconds = 120
  replica_retry_limit        = 0

  # Clover checkout sessions expire after 15 minutes; the reaper cancels orders
  # left in awaiting_payment past ~20. Every 5 minutes is fine-grained enough.
  schedule_trigger_config {
    cron_expression          = "*/5 * * * *"
    parallelism              = 1
    replica_completion_count = 1
  }

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

  template {
    container {
      name   = "reaper"
      image  = local.image
      cpu    = 0.25
      memory = "0.5Gi"

      command = ["node"]
      args    = ["--import", "./register-alias.mjs", "--experimental-strip-types", "scripts/reap-payments.ts"]

      dynamic "env" {
        for_each = local.job_env
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
    }
  }

  depends_on = [azurerm_role_assignment.acr_pull, azurerm_role_assignment.keyvault_secrets]
}
