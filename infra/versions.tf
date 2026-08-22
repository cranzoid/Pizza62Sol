terraform {
  required_version = ">= 1.5.7"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.14"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # Remote state lives in the storage account created by ./bootstrap.
  # Partial configuration: the values come from backend.hcl, which is not
  # committed because it names a specific subscription's storage account.
  #
  #   terraform init -backend-config=backend.hcl
  #
  # Workspaces `dev` and `prod` share this container; Terraform suffixes the
  # state key per workspace automatically.
  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id = var.subscription_id

  # Storage account keys are disabled below. Make the provider use the same
  # Entra ID/RBAC path as the application when it reads Blob and Queue service
  # properties; otherwise refresh fails with KeyBasedAuthenticationNotPermitted.
  storage_use_azuread = true

  features {
    key_vault {
      # Soft-delete is mandatory on Key Vault and cannot be turned off. Purging
      # on destroy keeps `terraform destroy` from poisoning the next apply with
      # a name that is still soft-deleted and therefore unavailable.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      # Fail loudly if something outside Terraform put a resource in the group,
      # rather than silently deleting it.
      prevent_deletion_if_contains_resources = true
    }
  }
}
