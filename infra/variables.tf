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
  description = "Point-in-time restore window, in days. 35 is the maximum and costs a few cents a month at this data volume."
  type        = number
  default     = 35

  validation {
    condition     = var.postgres_backup_retention_days >= 7
    error_message = "Keep at least 7 days of PITR: an order lost to a bad migration may not be noticed for days."
  }
}

variable "pg_pool_max" {
  description = "node-postgres pool size per web replica."
  type        = number
  default     = 8
}

# ---------------------------------------------------------------------------
# Application image
# ---------------------------------------------------------------------------


variable "custom_domain" {
  description = <<-DESC
    The primary hostname, e.g. "pizza62.ca".

    Leave empty until DNS is ready to move: Azure verifies the records at binding
    time and refuses the apply if they do not resolve, so setting this early
    fails every apply until the DNS is in place.
  DESC
  type        = string
  # Empty by default and set in terraform.tfvars, so a first apply succeeds
  # before DNS has moved off Wix.
  default = ""
}

variable "custom_domain_aliases" {
  description = <<-DESC
    Other hostnames to bind, e.g. ["www.pizza62.ca"].

    Bound rather than redirected, because a TLS certificate covers exactly the
    names it was issued for — a customer who types www and lands on a name the
    certificate does not cover sees a browser warning, whatever redirect waits
    behind it.
  DESC
  type        = list(string)
  default     = ["www.pizza62.ca"]
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
  description = <<-DESC
    The From address on order confirmations.

    Must be on a domain verified with the email provider (SPF and DKIM). That is
    why it is orders@pizza62.ca and not one of the Gmail addresses on this
    project: only Google can prove ownership of gmail.com, so mail claiming to be
    from one is rejected or filed as spam. The Gmail addresses are recipients.

    Until pizza62.ca is verified with the provider, override this with their
    sandbox sender so confirmations at least go somewhere.
  DESC
  type        = string
  default     = "orders@pizza62.ca"
}

variable "google_site_verification" {
  description = "Public Google Search Console HTML verification token. Blank omits the tag."
  type        = string
  default     = ""
}

variable "meta_pixel_id" {
  description = "Public Meta Pixel numeric ID. Blank keeps Meta measurement disabled."
  type        = string
  default     = ""

  validation {
    condition     = var.meta_pixel_id == "" || can(regex("^[0-9]{5,30}$", var.meta_pixel_id))
    error_message = "meta_pixel_id must be blank or a numeric Meta Pixel ID."
  }
}

variable "ga4_measurement_id" {
  description = "Public GA4 measurement ID (G-...). Blank keeps GA4 disabled."
  type        = string
  default     = ""

  validation {
    condition     = var.ga4_measurement_id == "" || can(regex("^G-[A-Za-z0-9]+$", var.ga4_measurement_id))
    error_message = "ga4_measurement_id must be blank or start with G-."
  }
}

variable "google_ads_id" {
  description = "Public Google Ads tag ID (AW-...). Blank keeps direct Ads tracking disabled."
  type        = string
  default     = ""

  validation {
    condition     = var.google_ads_id == "" || can(regex("^AW-[0-9]+$", var.google_ads_id))
    error_message = "google_ads_id must be blank or use the AW-123456789 format."
  }
}

variable "google_ads_conversion_label" {
  description = "Public purchase conversion label paired with google_ads_id."
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

variable "maps_sku" {
  description = "Azure Maps account SKU. G2 is the current generation; volume here is one geocode per delivery checkout."
  type        = string
  default     = "G2"
}

# --- R1.4 notifications -----------------------------------------------------

variable "email_provider" {
  description = "Email provider name. SendGrid is the only adapter implemented."
  type        = string
  default     = "sendgrid"
}

variable "twilio_from_number" {
  description = "The Twilio number SMS and calls originate from, in E.164 (e.g. +19055550142). A local Canadian number, not toll-free — only the restaurant is called, and outbound voice needs no toll-free verification."
  type        = string
  default     = ""
}

variable "restaurant_alert_phone" {
  description = "The number the restaurant is called and texted on for new orders, in E.164. Deliberately separate from the public business.phone setting: the number customers call and the one that should ring in the kitchen are not necessarily the same."
  type        = string
  default     = ""
}

variable "customer_sms_enabled" {
  description = "Send order confirmations to customers by SMS as well as email. Leave false until a registered A2P/toll-free number exists — Canadian carriers filter application-to-person SMS from unregistered local long codes, so delivery would be unpredictable and silent."
  type        = bool
  default     = false
}

variable "voice_retry_limit" {
  description = "How many times the restaurant is called about one unacknowledged order before giving up."
  type        = number
  default     = 3

  validation {
    condition     = var.voice_retry_limit >= 1 && var.voice_retry_limit <= 10
    error_message = "voice_retry_limit must be between 1 and 10."
  }
}

variable "voice_retry_minutes" {
  description = "Minutes between re-calls while an order is still unacknowledged."
  type        = number
  default     = 2

  validation {
    condition     = var.voice_retry_minutes >= 1 && var.voice_retry_minutes <= 60
    error_message = "voice_retry_minutes must be between 1 and 60."
  }
}

# ---------------------------------------------------------------------------
# App Service
# ---------------------------------------------------------------------------

variable "app_service_sku" {
  description = <<-DESC
    App Service plan tier.

    P0v3 (1 vCPU / 4 GB, ~US$61/month) is the default because it is the cheapest
    tier with deployment slots, and slots are what make a deploy zero-downtime.
    Without them every deploy is 30-60 seconds of unavailability, which for a
    restaurant means during dinner.

    B1 (~US$13/month) is the same application with no slot: viable if deploys
    only ever happen when the store is shut. Changing this is a one-line apply
    and needs no code change, but dropping to Basic also drops the staging slot,
    so remove the slot resources first or the apply fails.
  DESC
  type        = string
  default     = "P0v3"
}

variable "cron_interval_minutes" {
  description = <<-DESC
    How often the Logic App calls /api/cron/tick.

    One minute. This timer carries the customer's order confirmation and the call
    that tells the kitchen an order exists — latency here is the failure this
    release exists to eliminate. Consumption Logic Apps bill per action, so
    ~43,000 runs a month is a couple of dollars.
  DESC
  type        = number
  default     = 1
}

variable "alert_emails" {
  description = "Who is told when the site is down. The developer, not the restaurant — the owner cannot act on a failed health check."
  type        = list(string)
  default     = ["deskofvisheshvaibhav@gmail.com", "visheshvaibhav10@gmail.com"]
}

variable "blob_retention_days" {
  description = "How long a deleted or overwritten menu photo can be recovered."
  type        = number
  default     = 30
}

variable "github_owner_id" {
  description = <<-DESC
    Numeric account id of the repository owner, e.g. "93286005".

    GitHub's OIDC subject claim now names the repository by id as well as by
    name, so Entra needs a federated credential in that form or every deploy
    fails on AADSTS700213. Read it with:

      gh api users/<owner> --jq .id

    Empty leaves the id-qualified credentials uncreated, which is correct for an
    environment that has not hit the new format yet.
  DESC
  type        = string
  default     = ""
}

variable "github_repository_id" {
  description = <<-DESC
    Numeric id of the repository itself, e.g. "1306206852". See
    `github_owner_id`. Read it with:

      gh api repos/<owner>/<repo> --jq .id
  DESC
  type        = string
  default     = ""
}

variable "github_repository" {
  description = <<-DESC
    "owner/repo" for the deploy pipeline, e.g. "cranzoid/Pizza62Sol".

    Empty disables the federated identity entirely, so the infrastructure can be
    applied before the repository exists. Set it, apply, and
    `terraform output github_actions_variables` prints what to paste into the
    repository's Actions variables.
  DESC
  type        = string
  default     = ""
}
