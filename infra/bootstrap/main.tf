# ---------------------------------------------------------------------------
# Remote state bootstrap
#
# Chicken-and-egg: the main configuration keeps its state in Azure, but the
# storage account that holds that state has to exist first. This tiny
# configuration creates it, and keeps its own state in a local file that is
# committed to nothing and needed almost never.
#
#   cd infra/bootstrap
#   terraform init && terraform apply
#   terraform output -raw backend_hcl > ../backend.hcl
#
# Then, in infra/:  terraform init -backend-config=backend.hcl
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.14"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

variable "subscription_id" {
  type    = string
  default = "7e12a986-4373-4371-814c-95542713a50f"
}

variable "location" {
  type    = string
  default = "canadacentral"
}

locals {
  suffix = substr(sha1("pizza62-tfstate-${var.subscription_id}"), 0, 8)
}

resource "azurerm_resource_group" "state" {
  name     = "rg-pizza62-tfstate"
  location = var.location
}

resource "azurerm_storage_account" "state" {
  name                     = "sttfstate${local.suffix}"
  resource_group_name      = azurerm_resource_group.state.name
  location                 = azurerm_resource_group.state.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  https_traffic_only_enabled = true
  min_tls_version            = "TLS1_2"

  # State holds the Postgres admin password. Versioning gives a way back from a
  # corrupted or truncated write; the delete retention covers an accidental
  # `terraform destroy` of this account itself.
  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

output "backend_hcl" {
  description = "Write this to infra/backend.hcl."
  value       = <<-HCL
    resource_group_name  = "${azurerm_resource_group.state.name}"
    storage_account_name = "${azurerm_storage_account.state.name}"
    container_name       = "${azurerm_storage_container.state.name}"
    key                  = "pizza62.tfstate"
    use_azuread_auth     = true
  HCL
}
