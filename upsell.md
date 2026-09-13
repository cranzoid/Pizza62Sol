# Upsell system handoff

Last updated: 2026-09-09  
Current milestone: Phase 1 implemented and validated; Phase 2 is next.

## Objective

Increase average order value with useful, low-friction additions to the cart without recommending irrelevant products, repeating items already selected, breaking bundle promises, or reducing checkout completion.

The planned system has four phases:

1. Core recommendations and measurement — implemented.
2. Owner merchandising controls — next.
3. Experimentation and optimization.
4. Responsible personalization and automated ranking.

## Phase 1 status

Phase 1 is implemented in the current worktree but has not been committed or deployed.

### Recommendation engine

`lib/upsells.ts` contains the deterministic recommendation engine. It evaluates the entire cart and returns no more than three diverse recommendations.

The engine uses these merchandising roles:

- `meal`
- `pizza`
- `wings`
- `side`
- `drink`
- `dip`
- `dessert`

Current behavior:

- Pizza orders prefer a dip, garlic bread, drinks, and then dessert.
- Wing orders prefer fries or wedges, drinks, and then dessert.
- Other meals prefer a side, drink, and dessert.
- Side-only carts can receive drink and dessert suggestions.
- Drink-only and dessert-only carts receive no aggressive meal recommendation.
- Larger orders receive the four-pop option before a single pop.
- A maximum of one product is selected for each missing role.
- Products already in the cart are never recommended again.
- A selected modifier can satisfy a role; for example, an included dip suppresses a standalone dip.
- Required modifier sections and legacy bundle descriptions are inspected so included drinks, sides, dips, and desserts are not recommended again.
- Sold-out, setup-required, fulfilment-ineligible, and currently unavailable products are excluded.
- Recommendation logic never calculates or overrides prices. All selected items enter the existing server quote and order-validation path.

The engine works with the current catalog through product/category inference. It also already accepts explicit product metadata at `product.configuration.merchandising`:

```json
{
  "merchandising": {
    "roles": ["meal", "pizza"],
    "includes": ["dip"],
    "serves": 2,
    "preferredUpsellIds": ["four-pops", "chocolate-brownie"],
    "upsellCandidate": true,
    "upsellPriority": 25
  }
}
```

Explicit `roles` replace inferred roles. `includes` describes components already supplied by a product or bundle. Preferred products are considered first but still pass availability, fulfilment, duplicate, and diversity guards. The owner cannot edit these fields through a purpose-built UI yet; that is the main Phase 2 task.

### Customer experience

`app/customer/CustomerApp.tsx` and `app/globals.css` implement the cart experience.

- Recommendations appear inside the cart drawer under “A little something extra?”
- Each card explains why it was selected and shows its current catalog price.
- Simple products add in one tap using the ordinary cart path.
- Products requiring choices close the cart, open the existing product customizer, and return to the cart when added or dismissed.
- Configurable recommendation prices are labelled “from”.
- Adding a recommendation immediately recalculates the authoritative server quote.
- Removing an upsell uses the same cart controls as every other item.
- The layout uses compact cards and 44-pixel action targets for mobile usability.

### Safe rollout

The feature is controlled by `featureFlags.upsellsEnabled`.

- Its launch default is `false` in `lib/launch-config.ts`.
- The owner switch is in Admin → Settings → Cart recommendations.
- Existing settings rows without the new property behave as disabled.
- After deployment, the storefront must be reloaded before a newly saved setting appears.

### Attribution and reporting

An added recommendation receives non-pricing attribution:

```json
{
  "source": "upsell",
  "placement": "cart",
  "ruleId": "pizza-drink",
  "sourceProductIds": ["large-pizza"]
}
```

`app/menu/ItemCustomizer.tsx` carries this value to the orders API. `lib/order-service.ts` sanitizes it and stores it in `order_items.snapshot_json`. It never affects pricing, promotions, eligibility, tax, kitchen instructions, or fulfilment.

The first-party analytics event allowlists now include:

- `upsell_impression`
- `upsell_selected`
- `upsell_added`
- `upsell_removed`

Admin → Analytics contains a Cart recommendations panel showing:

- sessions shown recommendations;
- sessions that selected a recommendation;
- sessions that added a recommendation;
- removals;
- recommendation add rate;
- paid orders containing an attributed add-on;
- paid add-on items and revenue.

Paid upsell revenue is derived from completed order-item snapshots, not from browser event values.

## Files changed in Phase 1

- `lib/upsells.ts` — recommendation engine and metadata interpretation.
- `tests/upsells.test.ts` — recommendation, suppression, and eligibility tests.
- `app/customer/CustomerApp.tsx` — cart UI, customizer handoff, and event tracking.
- `app/globals.css` — recommendation-tray presentation.
- `app/menu/ItemCustomizer.tsx` — cart-line merchandising attribution.
- `lib/order-service.ts` — server-side attribution sanitization and persistence.
- `lib/marketing.ts` — browser event allowlist.
- `app/api/analytics/route.ts` — first-party event allowlist.
- `app/api/admin/analytics/route.ts` — upsell funnel and paid revenue reporting.
- `app/staff/AdminAnalytics.tsx` — owner-facing metrics.
- `app/staff/AdminControls.tsx` — rollout switch.
- `lib/launch-config.ts` — disabled-by-default feature flag.
- `tests/analytics.test.ts` — paid upsell reporting coverage when PostgreSQL is available.
- `tests/domain.test.ts` — disabled-by-default rollout assertion.

Do not discard the current worktree. The Phase 1 changes are intentionally uncommitted.

## Validation already completed

The following checks passed after the final Phase 1 changes:

```sh
npm test
./node_modules/.bin/tsc --noEmit
npm run lint
npm run build
git diff --check
```

Test result: 434 discovered, 202 passed, 0 failed, and 232 skipped because PostgreSQL was not reachable in that test environment. The focused upsell suite passed all seven tests. The production build regenerated `dist/standalone` successfully.

A local production server also started successfully. Its data-backed browser walkthrough could not continue because the configured local PostgreSQL connection requested SSL while that server reported that it does not support SSL. This is an environment/database configuration limitation, not a build failure. Do not run a migration or change database settings merely to work around it without first inspecting the intended local environment.

## Phase 2 — owner merchandising controls

Phase 2 should make the metadata already supported by the engine safe and convenient to manage.

### Recommended scope

Add a “Cart recommendations” section to the existing product editor with:

- Whether the product may appear as a recommendation.
- Product roles, with inferred roles displayed as the default.
- Components already included with this product or bundle.
- Approximate number of people served.
- Preferred recommendation products selected from active catalog products.
- Recommendation priority.
- A preview showing what the engine would recommend for that product under pickup and delivery.

Add global owner controls only where they provide real value:

- Maximum recommendations, constrained to 1–3.
- Optional owner wording for the tray heading.
- A global exclusion list if product-level controls prove too slow for bulk maintenance.

### Phase 2 implementation requirements

- Preserve unrelated keys inside `product.configuration` when saving merchandising fields.
- Validate all roles against the fixed role vocabulary.
- Validate preferred product IDs against real products; never guess IDs.
- Prevent self-references and silently ignore products that later become inactive or unavailable.
- Bound `serves`, priority, list lengths, and text lengths on the server.
- Keep owner configuration out of all price calculations.
- Reuse `recommendUpsells` for the admin preview so preview and storefront cannot drift.
- Make inferred behavior visible rather than forcing every product to be configured manually.
- Add tests for configuration validation, preservation of existing product configuration, and preview/storefront parity.

### Phase 2 acceptance criteria

- An owner can configure a bundle’s included roles without editing JSON.
- An owner can prefer one drink or dessert over another.
- An owner can exclude a product from all recommendations.
- Invalid or deleted preferred products do not break the storefront.
- The preview matches the recommendation tray for the same cart and fulfilment method.
- All existing Phase 1 tests, lint, type-checking, and the production build still pass.

## Phase 3 — optimization

Do this only after Phase 1 has accumulated enough real traffic.

- Add per-product and per-rule reporting, using stored event context and order snapshots.
- Compare recommendation impressions, selections, paid attachments, revenue, and removal rates.
- Add stable session-level experiments for heading copy, ordering, and two-versus-three recommendations.
- Treat overall checkout completion as a guardrail. More clicks or add-on revenue is not a win if completed orders fall materially.
- Promote or demote rules based on paid attachment performance, not clicks alone.
- Keep an explicit fallback ranking so low-data products behave predictably.

Suggested primary metrics:

- Paid attachment rate: paid orders with an upsell divided by eligible paid orders.
- Upsell revenue per eligible order.
- Recommendation add rate: distinct sessions with `upsell_added` divided by distinct sessions with `upsell_impression`.
- Removal rate: sessions with `upsell_removed` divided by sessions with `upsell_added`.
- Checkout conversion guardrail: purchase sessions divided by checkout-start sessions.

## Phase 4 — responsible personalization

Only build this after deterministic rules and experiments demonstrate value.

- Rank by cart composition, party size, fulfilment, time of day, and aggregate paid attachment performance.
- Consider repeat-customer ordering history only when it can be used transparently and consistently with the site’s privacy commitments.
- Prefer aggregate and contextual signals over unnecessary personal profiling.
- Retain every Phase 1 availability, duplication, fulfilment, bundle, and server-pricing guard.
- Provide deterministic fallbacks whenever personalized data is absent.

## Production rollout checklist

1. Review the Phase 1 diff and commit it without discarding unrelated user work.
2. Deploy with `upsellsEnabled` still off.
3. Confirm the production catalog and order quote load normally.
4. Test pickup and delivery on desktop and a narrow mobile viewport.
5. Test at least these carts: pizza, wings, a deal with included drinks/dips, side-only, drink-only, a configurable drink, and a sold-out candidate.
6. Verify a configurable recommendation returns to the cart with its completed choices.
7. Place a controlled test order and confirm its order-item snapshot carries merchandising attribution while its server price remains correct.
8. Turn on Admin → Settings → Cart recommendations.
9. Watch checkout errors and conversion alongside the new upsell panel during the first week.
10. Disable the switch immediately if quote errors or checkout completion regress; no rollback is required to hide the tray.

## Known limits after Phase 1

- Rollout is a global on/off switch, not a percentage rollout.
- Ranking is deterministic rather than learned.
- The engine supports explicit relationships, but there is no owner UI for them yet.
- Reporting is aggregate; it does not yet break performance down by rule or recommended product.
- Recommendations are currently shown in the cart only, not on product pages or after checkout.
- Recommendation copy is built in rather than owner-editable.

## Suggested prompt for the next chat

Copy this into a new chat:

> Read `upsell.md` and inspect the current uncommitted Phase 1 work. Continue with Phase 2: build safe owner-facing merchandising controls in the existing product editor for roles, included components, serving size, preferred upsell products, recommendation eligibility, and priority. Add pickup and delivery previews using the existing `recommendUpsells` engine. Preserve all unrelated product configuration, add server validation and tests, and do not change price calculation. Run the full tests, TypeScript, lint, and production build when finished. Do not discard the existing Phase 1 changes.
