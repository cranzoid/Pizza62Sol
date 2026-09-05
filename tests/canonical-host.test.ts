import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRedirectUrl, legacyRedirectUrl } from "@/lib/canonical-host";

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

test("preserves the indexed Wix menu and ordering URLs after the Azure move", () => {
  for (const source of ["/menu?menu=menu", "/online-ordering", "/cart-page"]) {
    assert.equal(
      legacyRedirectUrl({ requestUrl: `https://www.pizza62.ca${source}`, publicBaseUrl: "https://pizza62.ca" }),
      "https://pizza62.ca/#menu",
    );
  }
  assert.equal(
    legacyRedirectUrl({ requestUrl: "https://www.pizza62.ca/my-orders", publicBaseUrl: "https://pizza62.ca" }),
    "https://pizza62.ca/track",
  );
  assert.equal(
    legacyRedirectUrl({ requestUrl: "https://www.pizza62.ca/not-a-legacy-page", publicBaseUrl: "https://pizza62.ca" }),
    null,
  );
});
