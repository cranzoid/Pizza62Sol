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
    Every DNS record to create before setting custom_domain, ready to read out.

    Azure verifies these at binding time and refuses the apply if they do not
    resolve, so this is a two-pass job: create the records, wait for propagation,
    then apply.

    The apex and the www record are different *kinds* of record. DNS forbids a
    CNAME at a zone apex, so pizza62.ca has to be an A record while
    www.pizza62.ca can be a CNAME to the app's hostname.

    The apex A record needs the app's **inbound** IP, which the azurerm provider
    does not expose on the web app resource — `apex_a_record_command` prints the
    az command that reads it. Guessing it from the outbound addresses would be
    wrong: they are a different set.
  DESC
  # Azure marks the verification ID as sensitive in the provider schema even
  # though its purpose is to be published in a public DNS TXT record.
  sensitive = true
  value = var.custom_domain == "" ? [] : concat(
    [
      "A      ${var.custom_domain}          <inbound IP — see apex_a_record_command>",
      "TXT    asuid.${var.custom_domain}    ${azurerm_linux_web_app.main.custom_domain_verification_id}",
    ],
    flatten([
      for alias in var.custom_domain_aliases : [
        "CNAME  ${alias}          ${azurerm_linux_web_app.main.default_hostname}",
        "TXT    asuid.${alias}    ${azurerm_linux_web_app.main.custom_domain_verification_id}",
      ]
    ]),
  )
}

output "apex_a_record_command" {
  description = <<-DESC
    Reads the inbound IP the apex A record must point at.

    This is the one record that breaks if the app is ever rebuilt or moved, so it
    is worth knowing it exists. If DNS ends up in Azure DNS, prefer an ALIAS
    record targeting the App Service instead — it tracks the address itself and
    removes this failure mode entirely.
  DESC
  value       = "az webapp config hostname get-external-ip -g ${azurerm_resource_group.main.name} --webapp-name ${azurerm_linux_web_app.main.name} -o tsv"
}

output "github_actions_variables" {
  description = <<-DESC
    The repository variables `.github/workflows/deploy.yml` reads.

    Every one of them is an identifier, not a secret — the trust is the subject
    claim on the federated credential, which is why these are Actions
    *variables* and there is no service principal password anywhere.

    Set them with:

      terraform output -json github_actions_variables \
        | jq -r 'to_entries[] | "\\(.key)=\\(.value)"' \
        | while IFS='=' read -r name value; do gh variable set "$name" -b "$value"; done
  DESC
  value = var.github_repository == "" ? {} : {
    AZURE_CLIENT_ID       = azurerm_user_assigned_identity.github_actions[0].client_id
    AZURE_TENANT_ID       = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID = data.azurerm_client_config.current.subscription_id
    AZURE_RESOURCE_GROUP  = azurerm_resource_group.main.name
    AZURE_APP_NAME        = azurerm_linux_web_app.main.name
  }
}
