# ---------------------------------------------------------------------------
# Alerts.
#
# The point of these is narrow: the developer finds out before the owner phones.
# A restaurant discovers its ordering site is down when a customer mentions it,
# which is usually the busiest hour of the week and always too late.
#
# Every rule below is something a person should act on immediately. Anything that
# is merely interesting belongs in a dashboard — an alert that fires often enough
# to be ignored is worse than no alert, because it teaches the reader to dismiss
# the next one.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_action_group" "developer" {
  name                = "ag-${local.name}-developer"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = substr("p62${local.env_short}", 0, 12)
  tags                = local.tags

  dynamic "email_receiver" {
    for_each = var.alert_emails
    content {
      name          = "dev-${email_receiver.key}"
      email_address = email_receiver.value
      # The plain email. Azure's "common alert schema" is more machine-readable
      # and much harder to read on a phone at 9pm, which is when these arrive.
      use_common_alert_schema = false
    }
  }
}

# ---------------------------------------------------------------------------
# The site is not answering
#
# The single most important one. `HealthCheckStatus` is the percentage of
# instances passing /api/health, which touches the database — so this covers the
# app being down, the database being unreachable, and a bad migration, without
# needing three separate rules.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "health" {
  name                = "alert-${local.name}-health"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.main.id]
  description         = "Pizza 62 is failing its health check — customers cannot order."
  severity            = 0
  frequency           = "PT1M"
  window_size         = "PT5M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "HealthCheckStatus"
    aggregation      = "Average"
    operator         = "LessThan"
    threshold        = 100
  }

  action {
    action_group_id = azurerm_monitor_action_group.developer.id
  }
}

# ---------------------------------------------------------------------------
# The app is erroring
#
# Thresholded rather than fired on any 5xx: a single error is noise, a sustained
# rate is an outage. Five in five minutes on a site this size is not normal.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "server_errors" {
  name                = "alert-${local.name}-5xx"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.main.id]
  description         = "Sustained 5xx responses from Pizza 62."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "Http5xx"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 5
  }

  action {
    action_group_id = azurerm_monitor_action_group.developer.id
  }
}

# ---------------------------------------------------------------------------
# The database is running out of room
#
# Storage on a Flexible Server cannot be shrunk and auto-grow has a ceiling.
# Hitting 100% makes the server read-only, which stops orders — and the warning
# signs are visible days ahead, so this is worth knowing about early.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "postgres_storage" {
  name                = "alert-${local.name}-db-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Postgres storage is above 80% — a full disk makes the database read-only."
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT30M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.developer.id
  }
}

# ---------------------------------------------------------------------------
# The database is out of connections
#
# The connection budget is arithmetic done at plan time (see postgres.tf), but
# arithmetic is only as good as its assumptions. This catches the case where
# something new opens connections nobody counted.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "postgres_connections" {
  name                = "alert-${local.name}-db-connections"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Postgres is refusing connections — something is opening more than the budget allows."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "connections_failed"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0
  }

  action {
    action_group_id = azurerm_monitor_action_group.developer.id
  }
}

# ---------------------------------------------------------------------------
# A notification gave up
#
# This is the one that maps directly onto the audit's central finding. A row that
# exhausts its retries is a customer who was never told their order was accepted,
# or a kitchen that was never told an order existed — and it is silent by nature:
# nobody is watching a database table.
#
# The application logs `[cron.*]` and `[orders.*]` failures to stdout, which App
# Service ships to this workspace. Querying the log rather than the table avoids
# giving Azure Monitor a database credential.
# ---------------------------------------------------------------------------

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "notification_failures" {
  name                 = "alert-${local.name}-notifications"
  location             = azurerm_resource_group.main.location
  resource_group_name  = azurerm_resource_group.main.name
  description          = "A Pizza 62 notification could not be delivered. Somebody was not told about an order."
  severity             = 1
  scopes               = [azurerm_log_analytics_workspace.main.id]
  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      AppServiceConsoleLogs
      | where ResultDescription has "[cron." or ResultDescription has "[integrations.test."
      | where ResultDescription has "failed" or ResultDescription has "Error"
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.developer.id]
  }
}
