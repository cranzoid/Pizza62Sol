# Counter menu release — September 18, 2026

The counter opens on category tiles. Selecting a category opens its item grid;
search finds items across categories. Customer details are collapsed for walk-ins
and expanded for phone/delivery orders. Pricing, tax, customization, order creation,
payment, and kitchen processing continue through the existing shared paths.

## Loyverse reconciliation

Source: export_items.csv supplied by the owner. Existing menu prices and product
configuration remain authoritative; CSV prices do not replace public prices.
Fourteen missing items were added as active, staff-only products: Buffalo Chicken
Wrap, Chicken Burger, Chicken Fingers with Fries, Fried Chicken Dumplings,
Shawarma Style Wrap, Free Garlic Bread, 12 Wings, large Nachos with Salsa Sauce,
$1 Medium Pizza, the Monday/Tuesday/Wednesday specials, and both Game Night Deals.
The one-time restore migration reactivates legacy retired IDs as staff-only; subsequent deploys preserve owner edits. Weekday specials retain their weekday limits. These items can be disabled or
published deliberately using Active and Staff only in Menu setup.

Existing pizza sizes, specialty recipes/price options, combos, deals, drinks,
sides, pickup specials, and slices reuse the current products. Cheese/pepperoni
slices use the existing slice topping selector. Dipping reuses Dipping Sauce.
Delivery and Extra Toppings remain part of shared fee/topping pricing; importing
standalone fee buttons would duplicate or bypass those calculations.

## Wings

Every standalone wing item and wing combo asks for one explicit style: Classic
(non-breaded) or Breaded. Neither is preselected; neither changes the price.
The additive migration preserves all other configuration and owner edits.
Existing order snapshots and printed historic orders remain unchanged.

Monday Wings is a new recurring public offer: $1 per wing, 1–40 wings per order,
pickup only, Toronto Mondays. It reuses the earlier dollar-wing customizer and
promotion popup. Expired Labor Day/Game Day products retain their original dates.
The 40-wing cap counts across all sauce/style lines in an order.

## Drawer and printing architecture

No changes to lib/passprnt.ts, lib/passprnt-result.ts, StaffPortal printing,
order ticket presentation, or the till's print/drawer handlers.
On Android, printing uses the existing PassPRNT URI, explicitly drawer=off.
The dedicated drawer button launches a separate URI with drawer=ahead and a
200 ms pulse, without receipt HTML/data. Each launch remains inside a staff tap.
The authenticated staff endpoint still returns the committed printable order,
printing occurs before dashboard refresh, and duplicate submissions do not print
again. Browser printing on the live order board remains available.
