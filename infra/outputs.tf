output "resource_group" {
  description = "Resource group holding everything in this workspace."
  value       = azurerm_resource_group.main.name
}

output "app_url" {
  description = "Public URL of the web app. This is the base for Clover and Twilio webhooks until a custom domain exists."
  value       = var.enable_front_door ? "https://${var.custom_domain}" : "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "container_registry" {
  description = "ACR login server. `docker push` targets this."
  value       = azurerm_container_registry.main.login_server
}

output "image_repository" {
  description = "Fully-qualified image name the Container App pulls."
  value       = "${azurerm_container_registry.main.login_server}/${var.project}-web"
}

output "key_vault" {
  description = "Key Vault name. Third-party credentials are set here with `az keyvault secret set`."
  value       = azurerm_key_vault.main.name
}

output "migrate_job" {
  description = "Job to run before a new revision takes traffic: az containerapp job start -n <this> -g <resource_group>"
  value       = azurerm_container_app_job.migrate.name
}

output "postgres_fqdn" {
  description = "Private FQDN of the database. Resolvable only from inside the VNet."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_connection_budget" {
  description = "Worst-case concurrent connections versus what the SKU allows."
  value = {
    worst_case = local.postgres_connection_budget
    sku_limit  = local.postgres_max_connections
    headroom   = local.postgres_max_connections - local.postgres_connection_budget
  }
}

output "owner_setup_secret_command" {
  description = "How to read the generated owner bootstrap secret. Not printed here, so it stays out of CI logs."
  value       = "az keyvault secret show --vault-name ${azurerm_key_vault.main.name} --name owner-setup-secret --query value -o tsv"
}

output "pending_secrets" {
  description = "Secrets still holding the placeholder value. Each must be set before the feature that reads it will work."
  value       = local.placeholder_secrets
}

output "front_door_dns_records" {
  description = "DNS records to create at the registrar. Empty until enable_front_door is true."
  value = var.enable_front_door ? {
    cname = {
      name  = var.custom_domain
      value = azurerm_cdn_frontdoor_endpoint.main[0].host_name
    }
    txt = {
      name  = "_dnsauth.${var.custom_domain}"
      value = azurerm_cdn_frontdoor_custom_domain.main[0].validation_token
    }
  } : null
}
