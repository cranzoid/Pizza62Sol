output "resource_group" {
  description = "Resource group holding everything in this environment."
  value       = azurerm_resource_group.main.name
}

output "app_url" {
  description = "Where customers reach the site."
  value       = var.custom_domain != "" ? "https://${var.custom_domain}" : "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "app_name" {
  description = "App Service name. The deploy workflow needs this."
  value       = azurerm_linux_web_app.main.name
}

output "staging_slot_url" {
  description = "Where a deploy lands before it is swapped into production."
  value       = "https://${azurerm_linux_web_app_slot.staging.default_hostname}"
}

output "key_vault" {
  description = "Key Vault holding the database URL, the owner bootstrap secret and the third-party credentials."
  value       = azurerm_key_vault.main.name
}

output "postgres_fqdn" {
  description = "Private FQDN of the database. Not reachable from outside the VNet, by design."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_connection_budget" {
  description = <<-DESC
    Worst-case concurrent connections against the server's cap.

    Worst case is both slots warm at once, which is what happens for the length
    of a swap. If this approaches the cap the plan fails rather than warning —
    exhausting it turns every route into "too many clients".
  DESC
  value       = "${local.postgres_connection_budget} of ${local.postgres_max_connections} (${var.postgres_sku})"
}

output "owner_setup_secret_command" {
  description = "Reads the generated one-time owner bootstrap secret. Run this, use it at /admin, then it is spent."
  value       = "az keyvault secret show --vault-name ${azurerm_key_vault.main.name} --name owner-setup-secret --query value -o tsv"
}

output "cron_secret_command" {
  description = "Reads the shared secret the Logic App presents to /api/cron/tick. Only needed to reconfigure the timer by hand."
  value       = "az keyvault secret show --vault-name ${azurerm_key_vault.main.name} --name cron-secret --query value -o tsv"
}

output "pending_secrets" {
  description = "Third-party credentials still holding 'pending'. Set them in the admin Integrations screen, or in Key Vault directly."
  value       = local.placeholder_secret_names
}

output "custom_domain_dns_records" {
  description = <<-DESC
    What to create at the registrar before setting custom_domain.

    Azure refuses the hostname binding until both records resolve, so this is a
    two-pass apply: create these, wait for propagation, then set custom_domain
    and apply again.
  DESC
  value = var.custom_domain == "" ? {} : {
    cname = "${var.custom_domain} CNAME ${azurerm_linux_web_app.main.default_hostname}"
    txt   = "asuid.${var.custom_domain} TXT ${azurerm_linux_web_app.main.custom_domain_verification_id}"
  }
}

output "deploy_command" {
  description = "Publish a built tree to the staging slot and swap it in. The GitHub Actions workflow does this; this is the manual equivalent."
  value       = "az webapp deploy --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_linux_web_app.main.name} --slot staging --type zip --src-path build.zip && az webapp deployment slot swap --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_linux_web_app.main.name} --slot staging --target-slot production"
}

output "github_actions_variables" {
  description = "Repository variables the deploy workflow needs. None of these is a secret — the trust is the federated credential, not a value."
  value = var.github_repository == "" ? {} : {
    AZURE_CLIENT_ID       = azurerm_user_assigned_identity.github_actions[0].client_id
    AZURE_TENANT_ID       = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = var.subscription_id
    AZURE_RESOURCE_GROUP  = azurerm_resource_group.main.name
    AZURE_APP_NAME        = azurerm_linux_web_app.main.name
  }
}
