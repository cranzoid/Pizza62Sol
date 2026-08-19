# ---------------------------------------------------------------------------
# Front Door Standard - optional
#
# Off by default. Standard is a ~$35/month flat charge, which is most of a lean
# budget, and it buys nothing while the app is served on its generated
# *.azurecontainerapps.io hostname - Container Apps already terminates TLS there.
#
# Turn it on when there is a real domain to serve:
#
#   enable_front_door = true
#   custom_domain     = "order.pizza62.ca"
#
# Then apply, read `front_door_dns_records` from the outputs, and add the CNAME
# and TXT records at the registrar. Validation completes on its own once the TXT
# record resolves.
#
# One behaviour changes when this is on: requests reach the app through Front
# Door, which sets X-Azure-ClientIP. lib/security.ts prefers that header over
# X-Forwarded-For, so rate limiting keeps working either way.
# ---------------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_profile" "main" {
  count = var.enable_front_door ? 1 : 0

  name                = "afd-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "Standard_AzureFrontDoor"
  tags                = local.tags

  lifecycle {
    precondition {
      condition     = trimspace(var.custom_domain) != ""
      error_message = "enable_front_door requires custom_domain to be set - Front Door with no domain to terminate is a $35/month no-op."
    }
  }
}

resource "azurerm_cdn_frontdoor_endpoint" "main" {
  count = var.enable_front_door ? 1 : 0

  name                     = "fde-${local.name}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "main" {
  count = var.enable_front_door ? 1 : 0

  name                     = "og-${local.name}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }

  health_probe {
    path                = "/api/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 60
  }
}

resource "azurerm_cdn_frontdoor_origin" "web" {
  count = var.enable_front_door ? 1 : 0

  name                          = "origin-web"
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.main[0].id
  enabled                       = true

  host_name = azurerm_container_app.web.ingress[0].fqdn
  # Container Apps routes by Host header, so the original host must be
  # rewritten to the app's own FQDN or ingress returns 404.
  origin_host_header             = azurerm_container_app.web.ingress[0].fqdn
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
  certificate_name_check_enabled = true
}

resource "azurerm_cdn_frontdoor_custom_domain" "main" {
  count = var.enable_front_door ? 1 : 0

  name                     = replace(var.custom_domain, ".", "-")
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  host_name                = var.custom_domain

  tls {
    certificate_type = "ManagedCertificate"
    minimum_version  = "TLS12"
  }
}

resource "azurerm_cdn_frontdoor_route" "main" {
  count = var.enable_front_door ? 1 : 0

  name                          = "route-web"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.main[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.main[0].id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.web[0].id]

  supported_protocols    = ["Http", "Https"]
  patterns_to_match      = ["/*"]
  forwarding_protocol    = "HttpsOnly"
  https_redirect_enabled = true
  link_to_default_domain = true

  cdn_frontdoor_custom_domain_ids = [azurerm_cdn_frontdoor_custom_domain.main[0].id]

  # Ordering pages are per-customer and price-sensitive; a shared cache would
  # serve one customer's cart state to another. Static assets are already
  # content-hashed and cached by the browser.
  cache {
    query_string_caching_behavior = "UseQueryString"
    compression_enabled           = true
    content_types_to_compress = [
      "text/html",
      "text/css",
      "text/javascript",
      "application/javascript",
      "application/json",
      "image/svg+xml",
    ]
  }
}

resource "azurerm_cdn_frontdoor_custom_domain_association" "main" {
  count = var.enable_front_door ? 1 : 0

  cdn_frontdoor_custom_domain_id = azurerm_cdn_frontdoor_custom_domain.main[0].id
  cdn_frontdoor_route_ids        = [azurerm_cdn_frontdoor_route.main[0].id]
}

# --- WAF --------------------------------------------------------------------

resource "azurerm_cdn_frontdoor_firewall_policy" "main" {
  count = var.enable_front_door ? 1 : 0

  name                = replace("waf${local.name}", "-", "")
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = azurerm_cdn_frontdoor_profile.main[0].sku_name
  enabled             = true
  mode                = "Prevention"
  tags                = local.tags

  # Standard supports rate limiting and custom rules. Managed rule sets are a
  # Premium feature; the app's own lib/security.ts rate limits per route on top
  # of this, and this bucket is a coarse volumetric backstop.
  custom_rule {
    name     = "burstlimit"
    enabled  = true
    priority = 1
    type     = "RateLimitRule"
    action   = "Block"

    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 600

    # A blanket match: every request URI contains a slash. The bucket is keyed
    # per client IP by Front Door, so this counts each caller separately.
    match_condition {
      match_variable = "RequestUri"
      operator       = "Contains"
      match_values   = ["/"]
    }
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "main" {
  count = var.enable_front_door ? 1 : 0

  name                     = "sp-${local.name}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.main[0].id

      association {
        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_custom_domain.main[0].id
        }
        patterns_to_match = ["/*"]
      }
    }
  }
}
