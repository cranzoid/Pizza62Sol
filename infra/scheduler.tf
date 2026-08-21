# ---------------------------------------------------------------------------
# The timer that drives background work.
#
# Container Apps had scheduled Jobs. App Service has no equivalent — Linux App
# Service does not support WebJobs — so the outbox sweeper, the payment reaper
# and the unacknowledged-order re-call all run behind one authenticated endpoint
# that a Logic App calls on a recurrence.
#
# This is the pattern already in production in this subscription for the CRM
# (`logic-ptcd-hourly`), so it is one thing to understand rather than two.
#
# **Every minute, not hourly.** The CRM's timer is hourly because its work is
# reporting. This one carries a customer's order confirmation and the call that
# tells the kitchen an order exists: an hour of latency there is the failure this
# whole release was written to eliminate. Consumption Logic Apps bill per action,
# so ~43,000 runs a month is a couple of dollars.
# ---------------------------------------------------------------------------

resource "random_password" "cron_secret" {
  length  = 48
  special = false
}

resource "azurerm_key_vault_secret" "cron_secret" {
  name         = "cron-secret"
  value        = random_password.cron_secret.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [
    azurerm_role_assignment.terraform_keyvault_admin,
    time_sleep.keyvault_rbac_propagation,
  ]
}

resource "azurerm_logic_app_workflow" "cron" {
  name                = "logic-${local.name}-cron"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_logic_app_trigger_recurrence" "cron" {
  name         = "every-minute"
  logic_app_id = azurerm_logic_app_workflow.cron.id
  frequency    = "Minute"
  interval     = var.cron_interval_minutes
}

resource "azurerm_logic_app_action_http" "cron" {
  name         = "run-application-cron"
  logic_app_id = azurerm_logic_app_workflow.cron.id
  method       = "POST"
  uri          = "https://${local.default_hostname}/api/cron/tick"

  headers = {
    Authorization = "Bearer ${random_password.cron_secret.result}"
  }

  depends_on = [azurerm_logic_app_trigger_recurrence.cron]
}

# ---------------------------------------------------------------------------
# Application Insights
#
# Workspace-based, so traces land in the same Log Analytics workspace the alert
# rules query. The app writes to stdout and the App Service extension forwards
# it, so nothing has to be instrumented in code.
# ---------------------------------------------------------------------------

resource "azurerm_application_insights" "main" {
  name                = "appi-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = local.tags
}
