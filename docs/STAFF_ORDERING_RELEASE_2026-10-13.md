# Staff ordering and shared pricing release — 13 October 2026

The release uses one weighted pricing calculation in customer builds, staff builds, quotes and committed order snapshots. A normal whole topping consumes one unit, a half consumes 0.5, Real Chicken consumes two whole units or one half unit. Opposite halves of the same topping normalize to a whole before pricing. Extra units are charged proportionally at the existing size rate. Recipe ingredients, including preset cheese, reserve their allowance even when omitted; recipe prices and historical orders remain unchanged.

Staff can edit pizzas, deals and simple products, including burgers, with quantities and preparation notes. Saving replaces the original cart line; cancelling keeps it. Compatible free one-can slots share a flavour quantity picker, but the API still receives the original slot ids. Differently configured slots and bottles stay separate. Stored kitchen snapshots retain every can; order displays summarize quantities.

Only a successful quote for the current input and catalog revision enables placement. Quote failures/timeouts offer retry, previous totals are invalidated immediately, and line prices come from the server. Catalog data refreshes on entry, focus and every minute; quote data also refreshes on focus/every minute. The existing expected-amount-due guard prevents a higher price being silently collected at placement. Staff submission uses an immediate lock and retains the same idempotency key for retries of an unchanged order.

Cash received and change sit immediately before the payment action. Tender accepts plain dollars with at most two decimal places; malformed input is rejected. Change uses the gift-card remainder and existing nickel rounding. Committed amount due and tender remain after placement, and tender clears when the next order is started. The till remains mounted while changing admin sections, with an in-memory draft. Refresh/leave, discard and logout warn about unfinished work. Successful placement or logout clears the draft. Print and drawer handoffs remain separate; printing never automatically opens the drawer.

## Delivery products and targeted migration

| Product id | Variation id | Menu price | Extra unit rate |
| --- | --- | ---: | ---: |
| medium-pizza | medium-pizza-four-toppings | $16.99 | $2.10 |
| large-pizza | large-pizza-four-toppings | $17.99 | $2.30 |
| x-large-pizza | x-large-pizza-four-toppings | $18.99 | $2.60 |
| jumbo-pizza | jumbo-pizza-four-toppings | $23.99 | $2.90 |
| slab-pizza | slab-pizza-four-toppings | $27.99 | $2.90 |

All five have four included units and appear in **Delivery pizzas** only for delivery. Prices exclude tax and delivery. Existing delivery fees, minimums, radius and address checks remain in force.

The explicit `ordering:release` command does not reseed the menu. Inspection captures full operations/category/product/variation rows. Applying changes only the half-topping field (plus setting version/timestamp), the delivery category name/visibility, the five products' intended pricing/visibility/fulfilment fields, their `staffOnly` flag and their designated variations. Names, images, descriptions, display order, sold-out status and other configuration remain owner-owned. Missing records are created with their existing stable ids. Unexpected active variations stop inspection for review; they are never deactivated automatically.

Application is transactional, protected by the same advisory lock as the schema migration job and a release marker. A changed snapshot fails before any writes. Repeat apply is a no-op. Rollback restores only affected fields and refuses later owner edits. A newly created product with subsequent orders cannot be removed through rollback because its foreign keys protect history.

## Staging and production runbook

1. Record the deployed application revision and obtain a verified, restorable database backup. Restore it into an isolated staging database and test that restore. Keep snapshots and credentials outside Git.
2. Build the new revision. Apply normal schema migrations only if needed; do not bump the menu seed version or reseed production as a repair mechanism.
3. Point `DATABASE_URL` to staging using the deployment's normal secret configuration. Capture a new snapshot in a private path:
   ```sh
   npm run ordering:release -- --inspect /private/tmp/pizza62-staging-ordering-before.json
   ```
   Read the exact `observed` records and every `changes[].before/after` field. Investigate missing rows, sold-out flags, unexpected variations, absent topping/recipe configuration or owner-specific availability. This source checkout does not establish the live records' stored status.
4. Apply the reviewed staging snapshot:
   ```sh
   npm run ordering:release -- --apply /private/tmp/pizza62-staging-ordering-before.json
   ```
   Re-run once to verify repeat safety. Run the staged walkthrough below, including the actual restaurant tablet, printer and drawer. Test rollback using `--rollback` on that same snapshot, then capture a fresh snapshot before reapplying.
5. After staging passes and the production backup is verified, capture a **fresh production snapshot**, review it, apply it transactionally and switch traffic to the tested application revision. Never apply a staging snapshot to production. The script rejects changed rows.
6. Verify `/api/catalog` returns all five products and the 5000 setting; reload staff dashboards and customer tabs and re-quote old carts. Confirm an old cart's stored browser line price does not control totals or submission.
7. If rollback is required, return traffic to the recorded application revision and run `npm run ordering:release -- --rollback <the-production-snapshot.json>`. Any later owner edit stops rollback for explicit reconciliation. Restore the verified backup only under the normal recovery procedure; do not erase orders placed since backup.

## Staged tablet/mobile acceptance walkthrough

| Task | Acceptance criteria |
| --- | --- |
| Split pizza and chicken | Opposite distinct halves use one unit; duplicate halves normalize; half chicken uses one unit. Selected/included units and extra charges update together. Specialty recipes stay at listed prices, and omissions do not fund replacements. |
| Delivery menu | All five sizes show correct pre-tax prices for staff and customers; pickup excludes them; fifth units and half-unit excess charge correctly. Delivery minimum, tax and radius still apply. |
| Edit and cancel | Reopen a pizza/deal with its toppings, sides, sauce, omissions, drinks, notes and quantity. Save replaces that line. Cancel leaves it byte-for-byte unchanged. Burger/simple edit offers only existing choices, notes and quantity. |
| Canned drinks | Four Pepsi shows “4 of 4 drinks selected” and “Pepsi ×4”. Mix flavours, decrement and reassign. A fifth can cannot be added. Bottles and incompatible slots stay separate. Old slot payloads still quote and print. |
| Tender | $20 against $16.55 gives $3.45. Verify short payment, `-20`, `$20`, `20.001` and `1e2`; malformed amounts stay invalid. Check cash rounding and gift-card remainder. Amount due, tender and change survive printing. Start another order and verify tender clears. |
| Draft | Switch through Live orders, History, Menu setup and back; cart and customer/address fields remain. Refresh/leave, discard and logout warn. Cancel warning keeps the draft; successful order/logout clears it. |
| Quote freshness | Throttle requests; change quantity, fulfilment, coupon and gift card while an older quote is pending. Previous totals cannot authorize payment. Fail/offline the quote request, retry and recover without losing the cart. Verify catalog changes trigger a re-quote. |
| Submission | Double tap the payment action; only one order is created. Simulate a lost placement response and retry the unchanged draft; it resolves to the same order. Verify a higher changed amount is refused for review. |
| Hardware | Print on PassPRNT with immediate and delayed response; reprint from the last ticket/Live orders. Printing does not kick the drawer; only the explicit drawer button does. Verify the callback error and browser-print fallback. |
| Layout and access | Use 768×1024 and 390×844 layouts, landscape and an open keyboard. Labels remain readable, touch targets are at least 44px, selected halves are visible and keyboard focus is obvious. Scroll to all controls; payment remains reachable. |

## Local validation evidence

Validated on 13 October 2026 against a temporary PostgreSQL database at localhost port 55462, initialized with the repository schema and seed migrations. No production records were inspected or changed. The full suite passed **544 tests, with zero failures or skips**. TypeScript (`npx tsc --noEmit`), ESLint (`npm run lint`), the production build (`npm run build`) and `git diff --check` passed on the final source.

Regression coverage includes weighted halves/chicken and duplicate normalization, shared allowances, every specialty recipe and omissions, strict tender, repeated/mixed drink quantities, delivery parity for all five sizes, committed item/receipt data, original drink-slot payloads, migration repeat/rollback safety, concurrent owner edits and quoted line indexes. Existing integration tests exercise gift cards, idempotency, payment, receipt and drawer protections.

Chrome device emulation used the iPad Mini preset (768×1024) and iPhone 16 preset (393×852), with the local development server and synthetic staff/order data. Observed results:

- A burger reopened with its saved quantity and preparation note. Saving replaced its line; cancelling an unsaved edit preserved the prior choices.
- Switching to Overview and returning to the till retained the cart, note and total. Refresh displayed the browser's unfinished-order warning.
- Four Pepsi filled the allowance, disabled further additions, enabled Add and summarized as `Pepsi ×4` in the cart. The mobile editor remained readable and scrollable with its footer reachable.
- An offline quote cleared authoritative line/totals display, disabled payment and exposed Retry pricing. Restoring the connection recovered the current quote without losing the cart. This walkthrough also exposed and fixed an uncaught dashboard-refresh failure.
- Negative and short cash input blocked payment. A synthetic order committed at $25.94 retained $50 tender, the $25.95 rounded cash due and $24.05 change after placement. Beginning another order cleared tender.

These checks validate local software behavior and emulated layouts. Actual tablet keyboard/landscape use, physical receipt printing and drawer callbacks remain staging acceptance tasks. Live delivery-record inspection, the verified production backup, migration application and deployment remain release steps in the runbook above.
