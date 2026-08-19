variable "subscription_id" {
  description = "Azure subscription to deploy into."
  type        = string
  default     = "7e12a986-4373-4371-814c-95542713a50f"
}

variable "location" {
  description = "Azure region. canadacentral keeps customer addresses and phone numbers in Canada."
  type        = string
  default     = "canadacentral"
}

variable "project" {
  description = "Short name used to build every resource name."
  type        = string
  default     = "pizza62"
}

# ---------------------------------------------------------------------------
# Sizing
#
# Defaults are the "lean" tier: roughly $40-75/month. The single hard constraint
# is the Postgres connection cap - see `local.max_connections` in postgres.tf.
# ---------------------------------------------------------------------------

variable "postgres_sku" {
  description = "Postgres Flexible Server SKU. B_Standard_B1ms is burstable, 1 vCore / 2 GiB, and caps out at 50 connections."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "Postgres storage. 32768 is the floor; IOPS scale with size on burstable tiers."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time restore window."
  type        = number
  default     = 7

  validation {
    condition     = var.postgres_backup_retention_days >= 7
    error_message = "Keep at least 7 days of PITR: an order lost to a bad migration may not be noticed for days."
  }
}

variable "web_min_replicas" {
  description = "Always-on replicas. Must be >= 1 so the first customer of the day does not pay a cold start."
  type        = number
  default     = 1
}

variable "web_max_replicas" {
  description = "Scale ceiling. web_max_replicas * pg_pool_max must stay under the Postgres connection cap."
  type        = number
  default     = 3
}

variable "web_cpu" {
  description = "vCPU per replica. Container Apps requires memory to be exactly 2 GiB per vCPU."
  type        = number
  default     = 0.5
}

variable "web_memory" {
  description = "Memory per replica, as a Container Apps quantity string."
  type        = string
  default     = "1Gi"
}

variable "pg_pool_max" {
  description = "node-postgres pool size per web replica."
  type        = number
  default     = 8
}

variable "job_pg_pool_max" {
  description = "node-postgres pool size per job replica. Jobs are single-threaded sweepers and need far less."
  type        = number
  default     = 4
}

# ---------------------------------------------------------------------------
# Application image
# ---------------------------------------------------------------------------

variable "image_tag" {
  description = "Tag of the pizza62-web image in ACR. Set per deploy; `latest` is fine for dev but pin a digest or git SHA for prod."
  type        = string
  default     = "latest"
}

# ---------------------------------------------------------------------------
# Front Door
#
# Off by default. Standard costs ~$35/month, which is most of a lean budget, and
# it buys nothing until there is a custom domain to terminate. Container Apps
# ingress already serves TLS on the generated *.azurecontainerapps.io hostname.
#
# When the domain arrives: set enable_front_door = true and custom_domain, apply,
# then add the CNAME and TXT validation records the outputs print.
# ---------------------------------------------------------------------------

variable "enable_front_door" {
  description = "Provision Front Door Standard for WAF and a custom domain."
  type        = bool
  default     = false
}

variable "custom_domain" {
  description = "Custom hostname to serve, e.g. order.pizza62.ca. Required when enable_front_door is true; enforced by a precondition in frontdoor.tf, because Terraform 1.5 cannot reference another variable from a validation block."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Application configuration
# ---------------------------------------------------------------------------

variable "clover_environment" {
  description = "Clover API base to target: sandbox or production."
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "production"], var.clover_environment)
    error_message = "clover_environment must be sandbox or production."
  }
}

variable "email_from" {
  description = "From address on transactional email. Must be on a SendGrid domain-authenticated sender."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Background jobs
#
# Both cron jobs are provisioned only once the script they run exists. Leaving
# them off until then keeps a missing-entrypoint crash out of the logs every
# minute, and keeps the connection budget honest.
# ---------------------------------------------------------------------------

variable "enable_outbox_dispatcher" {
  description = "Create the outbox-dispatcher cron job. Turn on with R1.4, once scripts/dispatch-outbox.ts exists."
  type        = bool
  default     = false
}

variable "enable_payment_reaper" {
  description = "Create the payment-reaper cron job. Turn on with R1.3, once scripts/reap-payments.ts exists."
  type        = bool
  default     = false
}
