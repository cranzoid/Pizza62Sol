import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRedirectUrl } from "@/lib/canonical-host";

test("redirects the www alias to the configured apex and preserves the request", () => {
  assert.equal(
    canonicalRedirectUrl({
      requestUrl: "https://www.pizza62.ca/order/return?payment=approved",
      forwardedHost: "www.pizza62.ca",
      publicBaseUrl: "https://pizza62.ca",
    }),
    "https://pizza62.ca/order/return?payment=approved",
  );
});

test("leaves the apex and Azure health-check hostname alone", () => {
  assert.equal(
    canonicalRedirectUrl({
      requestUrl: "https://pizza62.ca/api/health",
      forwardedHost: "pizza62.ca",
      publicBaseUrl: "https://pizza62.ca",
    }),
    null,
  );
  assert.equal(
    canonicalRedirectUrl({
      requestUrl: "https://app-pizza62-prod-638134.azurewebsites.net/api/health",
      forwardedHost: "app-pizza62-prod-638134.azurewebsites.net",
      publicBaseUrl: "https://pizza62.ca",
    }),
    null,
  );
});

test("does not redirect an arbitrary forwarded host", () => {
  assert.equal(
    canonicalRedirectUrl({
      requestUrl: "https://pizza62.ca/",
      forwardedHost: "www.pizza62.ca.example.test",
      publicBaseUrl: "https://pizza62.ca",
    }),
    null,
  );
});
