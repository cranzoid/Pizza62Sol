# Halloween wings — October 31, 2026

The Halloween campaign runs from midnight at the start of October 31 until
midnight at the start of November 1, in `America/Toronto`. It does not recur.

- `halloween-dollar-wings-2026`: C$1 per wing, Classic or Breaded, with a sauce
  or dry rub; maximum 40 wings across all lines of this item in one cart.
- Both pickup and delivery. Normal HST, delivery minimum, delivery fee, opening
  hours, last-order cutoff and payment rules apply.
- A Halloween popup offers explicit pickup and delivery buttons. Its dismissal
  is scoped to the local date and the set of offers, so an older dismissal in
  the same tab cannot suppress the Halloween offer.
- A pumpkin-and-bat illustration, orange-and-plum banner, and seasonal hero and
  popup styling are scoped to the campaign date. The illustration is local SVG.
- The new product opts into `hideOutsideAvailability` and
  `availabilityAppliesToSchedule`. It disappears from the public catalog and
  storefront after the campaign, and both quotes and order creation refuse a
  scheduled fulfilment outside its offer window. An open tab updates its clock
  every 30 seconds and its catalog every minute.
- Monday's recurring pickup-only offer keeps its own product and configuration.

## Database and deployment

The menu seed version adds the new product using the existing `ON CONFLICT DO
NOTHING` inserts. There is no schema migration, bulk price update, or change to
existing orders, customers or owner-edited menu rows. Staging shares production's
database, so the new menu row can exist before the slot swap; its date restriction
is already understood by the previous release.

Deploy through `.github/workflows/deploy.yml` on main: database-backed tests,
typecheck, lint, build and standalone smoke test; publish to staging; wait for
database health; swap; verify production. Do not upload a laptop-built archive.

## Validation

Local verification used a disposable PostgreSQL database on port 55462:
944 tests passed, zero skipped, including real server quotes for both methods,
delivery rules, the shared wing cap, Toronto midnight boundaries, public catalog
expiry and rejection of a November scheduled order. Typecheck, lint and the
production build passed.
