# ---------------------------------------------------------------------------
# Azure Maps
#
# H-06b: delivery eligibility used to be decided from a table of 17 Forward
# Sortation Area centroids, so every address in an FSA collapsed to a single
# point kilometres wide. A customer who mistyped one character into a
# neighbouring FSA passed the radius check; a genuine address near the edge
# could be refused. lib/delivery-area.ts now geocodes the full street address
# through this account and keeps the centroid table only as an outage fallback.
#
# Volume is one lookup per delivery checkout, so this is among the cheapest
# things in the resource group.
# ---------------------------------------------------------------------------

resource "azurerm_maps_account" "main" {
  name                = "maps-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  # Azure Maps is a global service. Azure currently rejects new accounts in
  # canadacentral with LocationNotAvailableForResourceType.
  location = "global"
  sku_name = var.maps_sku
  tags     = local.tags

  # Managed identity only, consistent with storage and Key Vault. The account
  # keys are never read into Terraform state or handed to the app.
  local_authentication_enabled = false
}

resource "azurerm_role_assignment" "maps_reader" {
  scope                = azurerm_maps_account.main.id
  role_definition_name = "Azure Maps Data Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
