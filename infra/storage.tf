# ---------------------------------------------------------------------------
# Blob storage for uploads
#
# Replaces the R2 bucket. lib/blob-store.ts authenticates with the workload
# managed identity in Azure and only falls back to a connection string locally,
# so no storage key is stored anywhere.
# ---------------------------------------------------------------------------

resource "azurerm_storage_account" "uploads" {
  name                = "st${var.project}${local.env_short}${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"

  https_traffic_only_enabled = true
  min_tls_version            = "TLS1_2"

  # The app reads and writes through the SDK with a bearer token. Nothing needs
  # anonymous access, and menu photos served publicly would bypass the CDN and
  # the app's own access rules.
  allow_nested_items_to_be_public = false

  # Managed identity only - a leaked account key would otherwise be a permanent
  # backdoor that no RBAC change can revoke.
  shared_access_key_enabled = false

  # Recovering a menu photo. Postgres point-in-time restore covers the database
  # and nothing else, and there is no other copy of these files — the machine
  # they came from is the owner's phone.
  #
  # `versioning_enabled` is the one that matters: soft delete recovers a
  # *deleted* blob, but the common accident is overwriting a good photo with a
  # bad one, which is a write rather than a delete and leaves nothing to undelete.
  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = var.blob_retention_days
    }
    container_delete_retention_policy {
      days = var.blob_retention_days
    }
  }

  tags = local.tags
}

resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.uploads.id
  container_access_type = "private"

  # Creating a container is a data-plane call, which is authorized by the
  # caller's own RBAC rather than the account key. Propagation is not instant.
  depends_on = [azurerm_role_assignment.terraform_blob_contributor]
}

# The identity running `terraform apply` needs data-plane rights to create the
# container above, because shared_access_key_enabled is false.
resource "azurerm_role_assignment" "terraform_blob_contributor" {
  scope                = azurerm_storage_account.uploads.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
