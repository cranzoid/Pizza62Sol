# Pizza 62 Platform — Comprehensive Product and Build Requirements

## 1. Purpose of this document

This document is the single source of truth for building the Pizza 62 digital platform.

The platform is not only a restaurant website. It must support the complete online-ordering and restaurant-management experience described below:

1. Customer-facing ordering website
2. Restaurant administration dashboard
3. Kitchen and live order-management interface
4. Employee time clock and time-off system
5. Customer feedback and review workflow
6. Owner-facing analytics and configuration tools

The platform must be built so that the restaurant owner can manage normal operations without needing a developer.

Any business rule described as configurable must be stored and controlled through the administration interface rather than being permanently hard-coded.

---

# 2. Business identity

## 2.1 Business

- Business name: Pizza 62
- Location: Hamilton, Ontario, Canada
- Public phone number currently used: (905) 547-5777
- Current website reference: pizza62.ca
- Currency: Canadian dollars
- Default currency display: C$
- Default locale: English, Canada
- Default time zone: the restaurant's Hamilton, Ontario time zone

The restaurant address, coordinates, email addresses, social links, Google review link, and other contact information must be editable from the admin panel.

---

# 3. Platform principles

## 3.1 Admin-driven operation

The following must be editable without developer involvement:

- Products
- Categories
- Product descriptions
- Images
- Prices
- Sizes
- Toppings
- Modifier groups
- Included modifiers
- Extra modifier prices
- Halal availability
- Product availability
- Pickup and delivery eligibility
- Promotions
- Coupons
- Bundles
- Combos
- Included-item quantities
- Included-topping limits
- Cross-product topping allocation
- Promotion schedules
- Upsells
- Store hours
- Holiday hours
- Temporary closures
- Preparation estimates
- Delivery radius
- Delivery fee
- Tax rules
- Tip options
- Cancellation-window settings
- Order-pausing controls
- Employee permissions
- Time-clock rules
- Feedback questions
- Feedback delay
- Low-rating alerts
- Google review link
- Homepage content
- Banners
- Popular products
- Contact content
- Policy pages

## 3.2 No developer dependency for promotions

The owner must be able to create and manage promotions with no code change.

The promotion system must support:

- Fixed-price offers
- Percentage discounts
- Fixed-dollar discounts
- Free items
- Free delivery
- Bundles
- Multi-product deals
- Two-for-one offers
- Day-specific specials
- Time-specific specials
- Pickup-only promotions
- Delivery-only promotions
- Promotions valid for both
- Included toppings
- Shared topping allowances between pizzas
- Included drinks
- Included sides
- Included sauces
- Discounted cart upsells
- Coupons
- Promotion stacking
- Non-combinable promotions
- Start and end dates
- Days of week
- Times of day
- Optional usage limits
- Active and inactive status
- Display images
- Homepage or banner placement
- Display order

## 3.3 Data integrity

Pricing, taxes, discounts, delivery rules, payment state, order state, time-clock records, refunds, and permission-controlled actions must be calculated and validated by trusted application logic.

The customer interface must never be treated as the only authority for:

- Product price
- Topping price
- Included quantity
- Discount eligibility
- Delivery eligibility
- Tax
- Tip
- Payment status
- Order total
- Permission checks
- Time worked

---

# 4. Main user groups

## 4.1 Customer

A customer may:

- Browse the menu
- Select pickup or delivery
- Check delivery eligibility
- Customize eligible products
- Add products and offers to the cart
- Schedule an order or choose ASAP
- Pay online
- Choose pay at store for pickup
- Track an order securely
- Check out as a guest
- Create an optional account
- View order history when logged in
- Reorder a previous order when the feature is enabled
- Submit feedback
- Access the Google review option

## 4.2 Owner

The owner has full access to all restaurant and system functions.

## 4.3 Employee

Employees sign in individually.

Employee access is permission-based. The owner must be able to grant or remove individual permissions.

Potential permissions include:

- View orders
- Acknowledge new orders
- Change order status
- View customer contact details
- View delivery address
- Change preparation time
- Pause online ordering
- Mark products unavailable
- Cancel orders
- Issue refunds
- Manage menu
- Manage promotions
- Manage content
- Manage employees
- Edit time records
- Approve correction requests
- Approve time-off requests
- View analytics
- Export payroll
- Manage settings

Sensitive capabilities such as refunds, cancellations, employee management, financial reports, and time-record editing must be independently restrictable.

---

# 5. Customer ordering journey

## 5.1 Entry choice

The first meaningful ordering decision should be:

- Delivery
- Pickup

The chosen fulfilment method should remain selected while the customer shops, unless the customer changes it.

## 5.2 Delivery entry flow

For delivery:

1. Ask the customer for a postal code or address information sufficient for an initial eligibility check.
2. Perform an initial delivery-area screening.
3. Do not show the delivery fee on this first eligibility screen.
4. Allow the customer to enter the menu only when the address appears potentially serviceable.
5. Perform final full-address validation before order submission.
6. Calculate the actual distance from the configured restaurant origin.
7. Confirm that the address is inside the configured radius.
8. If outside the radius, do not permit normal delivery checkout.
9. Show a clear message asking the customer to call the restaurant to determine whether an exception can be arranged.

The default launch radius is 10 kilometres.

The owner must be able to change the radius.

The restaurant origin must be based on an admin-configured address and coordinates.

## 5.3 Pickup entry flow

Pickup customers proceed directly to the menu after selecting pickup.

## 5.4 Remembering fulfilment

The selected fulfilment method should be remembered during the session and, where appropriate, between visits.

Changing fulfilment may affect:

- Available products
- Available promotions
- Delivery fee
- Free-delivery eligibility
- Payment methods
- Available scheduled times
- Order estimate

The cart must be revalidated when fulfilment changes.

---

# 6. Homepage and public website

## 6.1 Homepage purpose

The homepage should prioritize starting or continuing an order.

## 6.2 Homepage sections

The owner should be able to manage:

- Hero section
- Main call to action
- Active offers
- Promotional banners
- Popular products
- Menu preview
- Reviews or testimonials
- Delivery-area information
- Contact information
- Store hours
- Footer
- Social links
- Policy links

## 6.3 Content controls

Homepage elements should support:

- Active or inactive
- Start and end dates
- Display order
- Pickup or delivery context
- Image
- Heading
- Supporting text
- Call-to-action label
- Call-to-action destination

## 6.4 Public pages

The platform should support editable pages for:

- Menu
- Contact
- About
- Delivery information
- Privacy policy
- Terms
- Cancellation and refund policy
- Accessibility statement
- Any required legal or restaurant information

---

# 7. Menu structure

## 7.1 Categories

The menu must support categories such as:

- Regular pizzas
- Gourmet pizzas
- Pickup specials
- Two-for-one offers
- Pizza and wing combos
- Hot deals
- Hamilton Heroes
- Wings
- Side orders
- Drinks
- Dipping sauces
- Desserts
- Other owner-created categories

Category names and structure must not be hard-coded.

## 7.2 Product model

A product may contain:

- Name
- Description
- Image
- Category
- Base price
- Size or variation choices
- Modifier groups
- Included modifiers
- Maximum or minimum selections where applicable
- Additional-selection price
- Pickup availability
- Delivery availability
- Day and time availability
- Sold-out state
- Active state
- Taxable state
- Upsell eligibility
- Promotion eligibility
- Halal capability
- Preparation notes
- Kitchen label
- Display order

## 7.3 Availability

Products and variations may be:

- Active
- Inactive
- Temporarily unavailable
- Available for pickup only
- Available for delivery only
- Available for both
- Available only during configured days or times

Employees with permission must be able to mark products unavailable quickly.

---

# 8. Pizza sizes and base pricing

The confirmed current standalone pizza prices are:

| Size | Base price | Extra topping price |
|---|---:|---:|
| Medium | C$8.40 | C$2.10 |
| Large | C$11.49 | C$2.30 |
| X-Large | C$12.49 | C$2.60 |
| Jumbo | C$19.99 | C$2.90 |
| Slab | C$21.49 | C$2.90 |

These values are initial data only.

Every base price and extra-topping price must be editable from the admin panel.

Jumbo and Slab currently include no toppings by default unless the selected offer says otherwise.

Pizza dimensions are not required at launch.

---

# 9. Pizza customization

## 9.1 General options

Eligible pizzas should support:

- Size
- Crust
- Sauce
- Cheese level
- Whole-pizza toppings
- Left-half toppings
- Right-half toppings
- Halal option
- Special instructions

The actual available crusts, sauces, toppings, and other options must come from admin-managed data.

## 9.2 Topping quantity

Customers cannot select light, regular, or extra quantities for each individual topping.

## 9.3 Maximum toppings

There is no fixed maximum number of toppings.

A customer may add paid toppings beyond the included quantity.

The interface should remain usable even with many toppings.

## 9.4 Half toppings

The current rule is:

- A topping placed on one half counts as one full topping.
- Pepperoni on the left and jalapeños on the right count as two toppings.
- The half-topping counting rule must be configurable.

Recommended normalization:

- If the same topping is selected on both halves, treat it as a whole-pizza topping and count it once.
- Prevent the same topping from being charged simultaneously as whole, left, and right.
- Store the actual placement for kitchen display.

The system should be designed so the owner could later change half-topping counting, for example to half of a topping unit, without rewriting the product engine.

## 9.5 Cheese options

The website should allow:

- No cheese
- Light cheese
- Regular cheese
- Extra cheese

Rules:

- No cheese: no extra charge
- Light cheese: no extra charge
- Regular cheese: no extra charge
- Extra cheese: counts as one regular topping and uses the applicable extra-topping price for the selected size

The system should not charge for extra cheese when the selected product or promotion explicitly includes it as part of its included topping allowance.

## 9.6 Included topping allowance

Products and promotions may include a topping allowance.

The pricing engine must:

1. Count chargeable topping units according to placement rules.
2. Include extra cheese in the count when selected.
3. Apply the product's included allowance.
4. Charge the applicable size-based topping price for selections beyond the allowance.
5. Respect shared topping pools in multi-pizza offers.
6. Display included and paid selections clearly.

---

# 10. Shared topping allocation in offers

## 10.1 Two-large pickup special

The pickup special with two large pizzas and six toppings combined allows the customer to divide the six topping units in any combination.

Examples:

- 3 toppings on pizza one and 3 on pizza two
- 4 toppings on pizza one and 2 on pizza two
- 6 toppings on pizza one and none on pizza two

The combined allowance belongs to the offer, not separately to each pizza.

Any topping units beyond the shared allowance are charged using the applicable extra-topping price for the pizza on which they are selected.

The offer builder must support this type of shared allowance generically.

## 10.2 Validation

The cart and server must calculate:

- Topping units used on every included pizza
- Total shared units used
- Remaining included units
- Paid extra units by pizza
- Extra topping cost by pizza

The customer interface should make the shared allowance understandable.

---

# 11. Halal functionality

## 11.1 Customer selection

Halal is selected once for the entire pizza, Pizza Sub, or Panzerotti.

When selected, the system should use the halal version of each selected meat topping when a halal version is available.

## 11.2 Topping configuration

Every topping must support separate fields for:

- Is meat
- Has halal version
- Halal display name if different
- Halal availability
- Optional halal cost impact
- Kitchen label

The exact final list of halal toppings must be confirmed before launch.

Expected examples include:

- Pepperoni
- Chicken
- Beef
- Bacon
- Italian sausage
- Hot sausage
- Meatballs

This expected list must not be treated as final until verified.

## 11.3 Pricing

There is no halal surcharge at launch.

The admin panel must allow the owner to add a halal surcharge later.

The surcharge design should support:

- No surcharge
- Fixed surcharge per product
- Fixed surcharge per halal topping
- Percentage surcharge if needed later

Only the configured active rule should apply.

## 11.4 Public wording

Do not publish a claim about:

- Separate utensils
- Separate cooking surfaces
- Separate fryers
- No cross-contamination
- Guaranteed separation
- Certification

until the restaurant approves the exact wording.

The system may internally label an order as halal for kitchen handling.

---

# 12. Gourmet pizzas

Gourmet pizzas are fixed recipes.

The normal interface must not allow:

- Removing included toppings
- Replacing included toppings
- Substituting included toppings
- Half-and-half recipe changes

The customer may:

- Select the available size
- Add paid extra toppings
- Select halal when supported
- Add special instructions
- Change quantity

Extra toppings use the normal size-based extra-topping price.

The original recipe should remain visible in the cart and kitchen view, with added extras shown separately.

---

# 13. Pizza Subs and Panzerottis

Pizza Subs and Panzerottis may use any three toppings from the normal pizza-topping list.

Rules:

- Three toppings are included.
- Additional toppings are charged separately.
- Halal selection is available.
- Halal versions are used when available.
- Special instructions are allowed.
- Pricing and included quantity are admin-editable.

---

# 14. Wings

## 14.1 Product identity

Pound-based and count-based wings are separate products.

Do not convert one pound into a fixed number of wings.

Examples of distinct products include:

- 1 lb wings
- 2 lb wings
- 3 lb wings
- 12 wings
- 24 wings
- 30 wings
- 40 wings
- 50 wings
- 60 wings

## 14.2 Flavours and sauces

Initial options:

- Mild
- Medium
- Hot
- Suicide
- Honey Garlic
- BBQ
- Cajun
- Lemon Pepper
- None

Cajun and Lemon Pepper may be dry-style options, but the public wording must remain neutral until the restaurant confirms whether they should be called dry rubs.

## 14.3 Flavour limits

Initial intended rules:

| Wing quantity | Initial flavour limit |
|---|---:|
| 1 lb | 1 |
| 2 lb | 2 |
| 3 lb | 2 |
| 12 wings | 1 |
| 24 wings | 2 |
| 30 wings | 2 |
| 40 wings | 2 |
| 50 wings | 2 |
| 60 wings | 2 |

The owner must be able to change the permitted flavour count for every wing product.

There is no charge for a second flavour at launch.

The system should support an optional split-flavour charge later.

## 14.4 Split representation

When multiple flavours are selected, the customer and kitchen must see how the order is split.

The initial maximum is two flavours.

If exact piece allocation is not required by the product, an even split may be indicated. The data model should allow explicit allocation later.

## 14.5 Standalone inclusions

Standalone wing products initially include only the wings and selected sauce choices.

They do not automatically include:

- Blue cheese
- Veggie sticks
- Dipping sauce

unless the owner changes the product configuration.

## 14.6 Add-ons

Extra wing sauce and blue cheese are not active paid add-ons at launch.

The owner must be able to create them later as products, modifiers, or upsells.

## 14.7 Unconfirmed wing description

Do not publicly describe wings as breaded or non-breaded until confirmed.

---

# 15. Dipping sauce and drinks

## 15.1 Dipping sauce

The initial menu should include one standard dipping sauce.

- No flavour selector is required.
- Additional dipping sauce price: C$1.20
- Price must be editable.
- A combo that includes one dipping sauce should add one standard dipping sauce automatically.
- The owner may later create multiple sauce flavours.

## 15.2 Canned drinks

Initial canned-pop choices:

- Pepsi
- Diet Pepsi
- Coke
- Diet Coke
- Coke Zero
- Ginger Ale
- Crush Orange
- Brisk Iced Tea
- Sprite
- Dr Pepper
- Fanta Grape

Water bottle:

- Initial known price: C$1.60
- Bottle size is not confirmed

The can size is not confirmed and should not be shown unless verified.

## 15.3 Included drinks

When a deal includes multiple pops, the customer selects each included can individually.

For example, four included pops require four flavour selections.

## 15.4 Bottle upgrades

Do not offer a 591 mL or 2-litre upgrade at launch.

The system should be able to support future upgrade options with:

- Size
- Flavour
- Upgrade price
- Product eligibility
- Promotion eligibility

---

# 16. Confirmed offers and initial menu data

All offers must be represented through the generic promotion and bundle system.

## 16.1 Pickup special

C$25.99:

- One large pizza
- Three toppings
- One pound of wings
- Three canned pops
- Pickup only

C$27.99:

- Two large pizzas
- Six toppings combined
- Pickup only

Other known pickup offers:

- Medium pizza with five toppings: C$12.99
- X-Large pizza with three toppings: C$15.99

All offer content, prices, included items, and eligibility must remain editable.

## 16.2 Pizza and wings deals

C$43.99 deal:

- Two medium pizzas
- Up to three toppings on each pizza
- Two pounds of wings
- Four pops
- Veggie sticks
- Blue cheese
- One standard dipping sauce

C$53.99 deal:

- Two large pizzas
- Up to three toppings on each pizza
- Three pounds of wings
- Four pops
- Veggie sticks
- Blue cheese
- One standard dipping sauce

C$56.99 deal:

- Two X-Large pizzas
- Up to three toppings on each pizza
- Three pounds of wings
- Four pops
- Veggie sticks
- Blue cheese
- One standard dipping sauce

These deals are available for pickup and delivery unless changed in admin.

## 16.3 Hamilton Heroes

Hamilton Heroes offers are available for pickup and delivery.

For an eligible delivery order within the normal delivery area:

- Remove the entire delivery fee.
- Do not extend the delivery radius.
- Do not apply free delivery outside the configured delivery area.
- The owner must be able to enable or disable the free-delivery benefit.

## 16.4 Other offer groups

The platform must support:

- Two-for-one offers
- Hot deals
- Day-specific specials
- Other pickup specials
- Other owner-created bundles

Do not hard-code assumptions about their contents. They must use the generic offer builder.

---

# 17. Delivery rules

## 17.1 Default delivery configuration

- Delivery radius: 10 km
- Delivery fee: C$3.50
- Delivery minimum: C$0.00
- Delivery fee is the same throughout the standard delivery radius
- Delivery fee must not appear on the initial postal-code eligibility screen
- Delivery fee appears in the cart or checkout
- Delivery fee is editable
- Delivery radius is editable
- Delivery minimum is editable even though it is zero at launch

## 17.2 Tax treatment

Confirmed launch tax rule:

- Taxable menu items: 13% HST
- Delivery fee: non-taxable
- Tips: not included in the taxable menu-item subtotal
- Product taxability must remain configurable

The delivery fee must not be included in the HST calculation at launch.

## 17.3 Eligibility

Final delivery eligibility must use the customer's full validated address.

The system should:

1. Validate the address.
2. Determine coordinates.
3. Calculate distance from the configured restaurant origin.
4. Compare it with the configured radius.
5. Reject normal delivery checkout when outside the radius.
6. Show the restaurant phone number and ask the customer to call.

The implementation must handle geocoding or distance-service failures gracefully and must not silently accept an unverified address.

## 17.4 Product fulfilment rules

Initial rules:

- Pickup Specials: pickup only
- Hamilton Heroes: pickup and delivery
- Regular menu: pickup and delivery
- Two-for-one offers: pickup and delivery
- Combos: pickup and delivery
- Gourmet pizzas: pickup and delivery
- Hot deals: pickup and delivery
- Side orders: pickup and delivery

Every product and promotion must have:

- Pickup only
- Delivery only
- Both

as an admin-managed setting.

---

# 18. Pickup and payment methods

## 18.1 Pickup payment

Pickup orders may use:

- Online payment
- Pay at store

## 18.2 Store payment methods

The store accepts:

- Cash
- Debit card
- Credit card

The checkout should display these as the expected methods for pay-at-store pickup orders.

## 18.3 Delivery payment

Delivery orders must be paid online before submission.

Pay at store is not available for delivery.

Cash on delivery is disabled at launch.

The system may support cash on delivery later through a configuration setting, but it must not be active initially.

## 18.4 Payment security

- Do not store raw card details.
- Use the selected payment processor's secure hosted or tokenized flow.
- Verify payment completion through trusted server-side confirmation.
- Prevent duplicate order creation from repeated payment callbacks or repeated checkout submissions.
- Record payment state separately from order state.
- Refunds must be recorded with status, amount, reason, actor, and timestamp.

---

# 19. Store hours and closures

## 19.1 Regular hours

Initial hours:

| Day | Hours |
|---|---|
| Monday | 11:00 AM–10:00 PM |
| Tuesday | 11:00 AM–10:00 PM |
| Wednesday | 11:00 AM–10:00 PM |
| Thursday | 11:00 AM–11:00 PM |
| Friday | 11:00 AM–12:00 AM |
| Saturday | 11:00 AM–12:00 AM |
| Sunday | 12:00 PM–10:00 PM |

Midnight closing must be represented correctly as the end of the business day.

## 19.2 Administration

The owner must be able to manage:

- Regular weekly hours
- Pickup hours
- Delivery hours
- Holiday hours
- One-time special hours
- Temporary closure
- Manual online-order pause
- Reopening time or manual resume
- Closure message

Pickup and delivery initially use the same regular hours, but separate schedules must be supported.

## 19.3 Closing-time rule

Online orders are accepted until the exact closing time.

There is no required early cutoff at launch.

The owner can manually pause ordering.

---

# 20. ASAP and scheduled orders

## 20.1 Customer choices

Customers may choose:

- ASAP
- Schedule for later

## 20.2 Preparation estimates

Initial pickup preparation time:

- 15 minutes

Pickup and delivery must have separate configurable estimates.

The delivery estimate value must be configured before launch and must not be permanently assumed.

Authorized staff can temporarily increase the current estimate during busy periods.

The updated estimate must be visible to customers before checkout and apply to new orders.

## 20.3 Scheduling rules

Scheduled times must respect:

- Store hours
- Fulfilment-specific hours
- Current preparation lead time
- Product or promotion availability windows
- Temporary closures
- Paused ordering

No maximum number of orders per time slot is active at launch.

Do not create an active capacity limit unless the owner enables one later.

The scheduling system may support a future optional capacity feature, but it must default to disabled.

## 20.4 Schedule changes

If hours, availability, or preparation times change while the customer is checking out, the scheduled time must be revalidated before order creation.

---

# 21. Cart behaviour

## 21.1 Cart contents

Each cart line must preserve a clear snapshot of:

- Product
- Variation or size
- Quantity
- Base price
- Selected modifiers
- Topping placement
- Halal selection
- Included selections
- Paid extra selections
- Applied offer
- Discount
- Special instructions
- Current taxability

The final order must preserve the purchased configuration even when the live menu changes later.

## 21.2 Revalidation

Before checkout and before final order creation, revalidate:

- Product active state
- Product availability
- Fulfilment eligibility
- Current price
- Modifier validity
- Topping price
- Included allowance
- Promotion validity
- Coupon validity
- Store open state
- Scheduled time
- Delivery address
- Delivery radius
- Delivery fee
- Tax
- Tip
- Final total

If something changed, explain it clearly and require the customer to review the updated cart.

## 21.3 Upsells

Default possible cart upsells:

- Garlic bread
- Wings
- Pops
- Mozzarella sticks
- Brownies
- Dipping sauce when relevant

The owner can:

- Select products
- Reorder them
- Set context rules
- Set a discounted upsell price
- Set start and end dates
- Restrict by fulfilment
- Restrict by cart contents

Do not show an irrelevant dipping-sauce upsell when a sauce is already included unless the owner explicitly configures extra sauce as an upsell.

---

# 22. Pricing engine

## 22.1 Required components

The pricing engine must calculate:

1. Product base price
2. Variation price impact
3. Modifier price impact
4. Included topping allowance
5. Paid extra toppings
6. Extra cheese
7. Halal surcharge if enabled
8. Bundle or promotion pricing
9. Coupons
10. Upsell pricing
11. Delivery fee
12. Free-delivery benefit
13. Taxable subtotal
14. HST
15. Tip
16. Final total

## 22.2 Money handling

- Use exact currency-safe arithmetic.
- Do not use floating-point calculations for money.
- Round only at defined currency calculation boundaries.
- Store a clear breakdown for order history, receipts, refunds, and audit.

## 22.3 Default total calculation

Recommended launch order:

1. Calculate eligible menu line prices.
2. Apply bundle and promotion pricing.
3. Apply eligible coupons and account discounts.
4. Calculate the discounted taxable menu subtotal.
5. Calculate 13% HST on taxable menu items only.
6. Calculate the non-taxable delivery fee.
7. Remove the delivery fee when an active free-delivery rule applies.
8. Calculate tip.
9. Produce the final total.

Default tip percentages should be calculated on the discounted food and menu-item subtotal before HST and excluding the delivery fee.

This tip basis should be configurable.

## 22.4 Discount tax treatment

Discounts should reduce the corresponding taxable menu-item amount before HST is calculated.

Do not tax the original pre-discount amount when a valid discount reduces the taxable selling price.

---

# 23. Tips

Checkout options:

- 10%
- 15%
- 18%
- Custom amount
- No tip

Tipping is available for:

- Pickup
- Delivery

The interface must show:

- Tip basis
- Tip amount
- Final total

The owner should be able to:

- Enable or disable tipping
- Change preset percentages
- Enable or disable custom amount
- Configure the percentage basis

Custom tips must be validated to prevent invalid or abusive amounts.

---

# 24. Promotions, coupons, and stacking

## 24.1 Stacking

Multiple promotions may apply to one order.

Coupons may apply to already-discounted offers unless the relevant coupon or offer is configured as non-combinable.

Every promotion should have:

- Combinable or non-combinable
- Priority
- Applicable products
- Applicable categories
- Applicable fulfilment methods
- Applicable customer groups
- Date and time rules
- Optional minimum order
- Optional usage limits

## 24.2 Conflict handling

The promotion engine must use deterministic rules.

It must never apply two incompatible promotions merely because both appear eligible.

Recommended controls:

- Promotion priority
- Stack group
- Exclusive flag
- Maximum applications
- Best-price or explicit-priority mode
- Clear admin preview of the resulting discount

## 24.3 Usage limits

No usage limits are required at launch.

Optional settings should support:

- Maximum uses per customer
- Maximum total uses
- One use per order
- Start date
- End date

## 24.4 Promotion auditability

The order should store:

- Promotion identifier
- Promotion name at purchase time
- Rule version or snapshot
- Discount amount
- Affected lines
- Reason for eligibility
- Coupon code if used

---

# 25. Checkout

## 25.1 Guest checkout

Guest checkout is the default.

Required customer information should be limited to what is necessary for:

- Contact
- Fulfilment
- Payment
- Order updates
- Receipt
- Feedback

## 25.2 Account option

A customer may create an account during or after checkout.

Account creation must not be required.

## 25.3 Pickup checkout

Pickup checkout should include:

- Customer name
- Phone
- Email
- Pickup time
- ASAP or scheduled
- Payment choice
- Order summary
- Tip
- Terms acknowledgement when required

## 25.4 Delivery checkout

Delivery checkout should include:

- Customer name
- Phone
- Email
- Full validated address
- Unit or apartment
- Delivery instructions
- Delivery time
- ASAP or scheduled
- Online payment
- Order summary
- Delivery fee
- Tip
- Terms acknowledgement when required

## 25.5 Submission

Orders are accepted automatically after all required validation and successful payment authorization or confirmed pay-at-store selection.

The restaurant receives:

- Dashboard notification
- Audible alert
- Email notification

The system must prevent duplicate orders caused by refreshes, retries, or payment callbacks.

---

# 26. Order numbering and secure tracking

## 26.1 Public order number

Orders may have a human-readable sequential reference such as:

- P62-1048

## 26.2 Security requirement

The order number alone must never reveal an order.

Public order tracking must require:

- Order number
- Secure, random, high-entropy tracking token

Changing P62-1048 to P62-1049 must not expose another customer's order.

## 26.3 Tracking page

The customer tracking page may show:

- Order number
- Fulfilment method
- Order status
- Estimated completion time
- Ordered items
- Store contact information
- Pickup instructions or masked delivery information
- Cancellation request instructions
- Receipt

Avoid exposing unnecessary personal information.

## 26.4 Token controls

Tracking tokens must be:

- Unpredictable
- Stored securely
- Unique
- Rate-limit protected
- Regenerable by authorized staff when needed

Authenticated restaurant users do not use public tracking tokens to manage orders.

---

# 27. Order lifecycle

## 27.1 Common statuses

- Received
- Preparing
- Completed
- Cancelled

## 27.2 Pickup statuses

- Received
- Preparing
- Ready for Pickup
- Completed
- Cancelled

## 27.3 Delivery statuses

- Received
- Preparing
- Out for Delivery
- Completed
- Cancelled

Only relevant statuses should appear for the selected fulfilment method.

## 27.4 Status transitions

The system should prevent nonsensical transitions unless an authorized override is explicitly used.

Every status change should record:

- Previous status
- New status
- Actor
- Timestamp
- Optional note

## 27.5 Customer updates

Status changes should update the tracking page.

Customer email or message notifications should be configurable.

---

# 28. Kitchen and live order dashboard

## 28.1 Device support

The primary device is a laptop.

The interface must also work on:

- Desktop
- Tablet
- Mobile

## 28.2 New-order alert

A new order should play an audible alert until an employee:

- Opens it
- Acknowledges it

Sound and volume settings should be configurable where the browser and device allow.

The interface must also provide a clear visual alert because browser sound can be blocked.

## 28.3 Order card

An order card should show:

- Order number
- Pickup or delivery
- ASAP or scheduled time
- Time received
- Current estimate
- Customer name
- Phone
- Delivery address when authorized
- Products
- Sizes
- Toppings and placement
- Halal labels
- Wing flavours
- Included items
- Special instructions
- Payment status
- Tip if appropriate for staff
- Current status

## 28.4 Actions

Authorized staff may:

- Acknowledge
- Change status
- Change preparation estimate
- View contact details
- Mark product unavailable
- Pause ordering
- Cancel
- Refund

Permission checks must apply to every action.

## 28.5 Printing

Kitchen-ticket printing is not required for launch.

The system may support printing later.

---

# 29. Cancellations and refunds

## 29.1 Provisional cancellation rule

The provisional customer cancellation-request window is five minutes after order submission, provided preparation has not begun.

This value must be configurable.

The final public policy is not yet confirmed.

## 29.2 Customer process

Customers must call the restaurant.

The website should not automatically cancel or refund an accepted order.

## 29.3 Restaurant approval

Cancellation and refund decisions require an authorized restaurant user.

## 29.4 Refund controls

The system should support:

- Full refund
- Partial refund
- Refund reason
- Internal note
- Customer-facing note
- Payment-provider reference
- Refund status
- Actor
- Timestamp

Refunds must not be marked complete merely because a request was initiated.

## 29.5 Policy page

A separate cancellation and refund policy page will be added.

The final policy still needs owner-approved wording for:

- Cancelled orders
- Incorrect orders
- Missing items
- Late delivery
- Food-quality complaints

---

# 30. Customer accounts

## 30.1 Launch behaviour

- Guest checkout remains available.
- Account creation is optional.
- No account-creation discount is active at launch.
- Saved payment cards are not required at launch.

## 30.2 Saved information

An account may store:

- Name
- Phone
- Email
- Delivery addresses
- Order history
- Preferences where appropriate

## 30.3 Reorder

The architecture must support reordering.

The customer-facing reorder feature should be controlled by a feature setting because final launch inclusion has not been confirmed.

When enabled, reorder must revalidate:

- Current product availability
- Current price
- Current modifiers
- Current toppings
- Current promotion eligibility
- Current fulfilment rules
- Delivery eligibility
- Store hours

Unavailable or changed items must be identified clearly.

A previous order must never be recreated using stale prices without review.

## 30.4 Future saved cards

Future saved-card support must use secure payment-processor tokenization.

No raw card information may be stored.

---

# 31. Account and signup discounts

No signup discount is active at launch.

The admin must later be able to create:

- Percentage discount
- Fixed-dollar discount
- Free item
- No discount

Configurable eligibility should include:

- First order only
- Next order
- Pickup only
- Delivery only
- Both
- Regular menu only
- Offers and combos
- Minimum order
- Expiry
- Combinable or non-combinable

Account discounts may combine with existing offers unless configured otherwise.

---

# 32. Administration dashboard

## 32.1 Dashboard overview

The owner-facing dashboard should show useful current information such as:

- New orders
- Orders in progress
- Scheduled orders
- Paused ordering status
- Current preparation estimates
- Sales today
- Order count
- Average order value
- Pickup versus delivery
- Important low-rating feedback
- Product availability warnings
- Employee clock status

## 32.2 Main administration areas

- Orders
- Menu
- Categories
- Products
- Sizes and variations
- Modifier groups
- Toppings
- Halal configuration
- Wings
- Offers
- Coupons
- Upsells
- Homepage content
- Store hours
- Closures
- Delivery settings
- Tax and fee settings
- Tip settings
- Payment settings
- Customer accounts
- Employees
- Permissions
- Time clock
- Time-off requests
- Payroll exports
- Feedback
- Google review settings
- Analytics
- Notifications
- Policy pages
- General business settings
- Audit log

## 32.3 Dangerous-action safeguards

Sensitive actions should require clear confirmation.

Examples:

- Refund
- Cancel paid order
- Delete or deactivate promotion
- Change tax rules
- Change delivery radius
- Edit employee hours
- Remove employee access
- Pause ordering

---

# 33. Employee time clock

## 33.1 Authentication

Employees clock in using:

- Individual email address
- Password

A PIN is not required at launch.

## 33.2 Device access

Employees may clock in from any authorized device.

The system is not restricted to one restaurant device.

## 33.3 Location verification

Location verification is disabled at launch.

An optional location-verification setting may be added if it does not create unnecessary complexity.

## 33.4 Clock events

The system must support:

- Clock in
- Start unpaid break
- End unpaid break
- Clock out

Only valid transitions should be allowed.

Examples:

- An employee cannot clock in twice.
- An employee cannot end a break that was never started.
- An employee cannot clock out while an open break remains without handling it explicitly.

## 33.5 Time calculation

Use exact timestamps.

No rounding is applied by default.

Paid working time equals:

- Clocked session duration
- Minus unpaid break duration

Store all original events and corrections.

## 33.6 Break configuration

Unpaid break tracking is supported and configurable.

Breaks are manual.

No break is automatically deducted by default.

## 33.7 Corrections

Only the owner or authorized administrator can directly edit time records.

Employees may submit a correction request containing:

- Incorrect entry
- Requested corrected time
- Reason

The owner may:

- Approve
- Reject
- Add a note

Original values must remain in an audit history.

## 33.8 Payroll periods

Default payroll period:

- Every two weeks

The payroll period must be configurable.

## 33.9 Exports

Required export formats:

- PDF
- CSV
- Excel

Exports should show:

- Employee
- Payroll period
- Clock-in and clock-out records
- Breaks
- Paid hours
- Corrections
- Approval status
- Totals

Do not invent overtime or payroll-law calculations unless the owner configures them.

## 33.10 Time off

Employees may submit holiday or time-off requests.

A request should contain:

- Dates
- Partial-day or full-day information
- Reason or note
- Submission date
- Status

The owner may approve or reject.

The employee must be able to see the decision.

---

# 34. Customer feedback

## 34.1 Timing

Send the feedback email approximately 60 to 90 minutes after the order's expected completion time.

The exact delay must be configurable.

Feedback should not be sent for a cancelled order.

## 34.2 Feedback access

Use a secure, order-linked feedback token.

Do not expose customer or order data through a guessable identifier.

Prevent abusive repeated submissions while allowing an authorized correction flow if desired.

## 34.3 Questions

Possible questions:

- Overall experience
- Pizza quality
- Crust
- Sauce
- Toppings
- Temperature
- Wings
- Pickup speed
- Delivery speed
- Packaging
- Value for money
- Written feedback

Questions should be conditional.

Examples:

- Hide wings questions when no wings were ordered.
- Show pickup-speed wording for pickup.
- Show delivery-speed wording for delivery.
- Hide pizza-specific questions when no pizza was ordered.

The owner should be able to:

- Activate or deactivate questions
- Reorder questions
- Change labels
- Choose rating scale
- Mark questions required or optional

## 34.4 Low-rating alert

When a one-star or two-star rating is submitted, immediately email the owner.

Include, where permitted:

- Order number
- Rating
- Written feedback
- Customer name
- Customer email
- Customer phone
- Order summary
- Link to the feedback record

## 34.5 Google review

After completing internal feedback, every customer should be shown the option to leave a Google review.

Do not hide the Google review option from low-rating customers.

The direct link must be editable in admin.

The final Google Business Profile review link has not yet been supplied.

## 34.6 Feedback administration

The owner should be able to:

- View feedback
- Filter by date, rating, fulfilment, and products
- Search by order
- Mark as reviewed
- Add an internal note
- Export feedback
- View rating trends

---

# 35. Analytics

## 35.1 Customer funnel

Track owner-friendly events such as:

- Website visit
- Active visitor
- Fulfilment selected
- Delivery eligibility checked
- Menu viewed
- Product viewed
- Add to cart
- Remove from cart
- Cart viewed
- Checkout started
- Payment attempted
- Purchase completed
- Promotion used
- Coupon used
- Feedback submitted
- Google review link clicked

## 35.2 Business metrics

The dashboard should support:

- Sales by day, week, month, and custom period
- Order count
- Average order value
- Pickup versus delivery
- Revenue by category
- Revenue by product
- Top products
- Topping popularity
- Promotion performance
- Coupon performance
- Upsell performance
- Tax collected
- Delivery fees
- Tips
- Refunds
- Cancellation rate
- Scheduled versus ASAP
- New versus returning customer
- Conversion rate
- Cart abandonment
- Traffic source
- Feedback ratings
- Low-rating trend

## 35.3 Live visitors

A live-visitors view is desired.

It should be presented as an approximate active-session count, not as an infallible exact number.

Respect privacy and consent requirements.

## 35.4 Financial consistency

Analytics totals must reconcile with order and payment records.

Cancelled and refunded orders should be represented clearly rather than silently removed from history.

---

# 36. Notifications

## 36.1 Restaurant notifications

The system should support:

- New-order dashboard alert
- Audible new-order alert
- New-order email
- Low-rating email
- Time-correction request alert
- Time-off request alert
- Payment or refund failure alert
- Important system warning

## 36.2 Customer notifications

Configurable customer emails may include:

- Order confirmation
- Payment receipt
- Order status updates
- Ready for pickup
- Out for delivery
- Cancellation
- Refund update
- Feedback request

Messages should use editable templates and preserve important transactional information.

---

# 37. Progressive web application behaviour

Installable web-app behaviour is desired for:

- Customer website
- Admin dashboard
- Employee time clock

The experience should:

- Be responsive
- Provide install metadata
- Use appropriate icons and branding
- Handle updates safely
- Clearly show network failures
- Avoid falsely confirming actions while offline

Ordering, payment, refunds, status updates, and time-clock actions require confirmed server success.

Do not silently queue a financial or timekeeping action and display it as completed when it has not reached the server.

---

# 38. Accessibility and usability

The system should be usable with:

- Keyboard navigation
- Screen readers
- Visible focus states
- Adequate contrast
- Clear labels
- Error summaries
- Accessible form validation
- Touch targets suitable for mobile and kitchen use

Important information must not rely only on colour.

Product customization should remain understandable even when many toppings are available.

---

# 39. Performance and reliability

The platform should:

- Load menu content efficiently
- Optimize images
- Avoid blocking the ordering flow with unnecessary scripts
- Handle duplicate submissions safely
- Handle payment retries safely
- Handle notification failures without losing the order
- Recover from temporary external-service failures
- Maintain clear logs for operational errors
- Avoid losing cart contents during normal navigation
- Revalidate server-side before final order creation

---

# 40. Security and privacy

## 40.1 Authentication and authorization

- Use secure authentication.
- Apply role and permission checks server-side.
- Do not rely on hidden buttons as authorization.
- Rate-limit sensitive endpoints.
- Protect login and password-reset flows.
- Invalidate or revoke employee access when disabled.

## 40.2 Customer and employee data

Limit access to:

- Customer phone
- Customer email
- Delivery address
- Employee time records
- Payroll exports
- Feedback contact information

according to role and purpose.

## 40.3 Audit log

Record sensitive actions such as:

- Refund
- Cancellation
- Tax-setting change
- Delivery-setting change
- Price change
- Promotion change
- Employee permission change
- Time-record edit
- Correction approval
- Time-off approval
- Ordering pause
- Manual order-status override

An audit entry should include:

- Actor
- Action
- Target
- Previous value where practical
- New value where practical
- Timestamp
- Relevant reason or note

## 40.4 Public-link security

Secure random tokens are required for:

- Order tracking
- Feedback
- Any other unauthenticated order-specific link

Sequential identifiers alone are insufficient.

---

# 41. Search, discoverability, and structured content

The public website should provide:

- Clear page titles
- Editable metadata
- Product and business information suitable for search engines
- Human-readable URLs
- Sitemap support
- Robots controls
- Social-sharing metadata
- Restaurant contact and hours information

Do not expose admin, employee, private order, or private feedback pages to search engines.

---

# 42. Operational configuration

The admin should provide a consolidated settings area containing:

## 42.1 Business settings

- Business name
- Phone
- Email
- Address
- Coordinates
- Time zone
- Currency
- Website links
- Social links
- Google review link

## 42.2 Ordering settings

- Ordering enabled
- Pickup enabled
- Delivery enabled
- ASAP enabled
- Scheduled ordering enabled
- Current pickup estimate
- Current delivery estimate
- Manual pause
- Pause message

## 42.3 Delivery settings

- Radius
- Fee
- Minimum
- Address validation
- Outside-area message
- Free-delivery rules

## 42.4 Tax and tip settings

- Tax rate
- Product taxability
- Delivery-fee taxability
- Tip enabled
- Preset percentages
- Custom tip
- Tip calculation basis

Launch defaults:

- Menu HST: 13%
- Delivery-fee taxability: false
- Tip presets: 10%, 15%, 18%

## 42.5 Order settings

- Order-number format
- Cancellation-request window
- Status notifications
- Feedback delay
- Reorder enabled
- Pay-at-store enabled for pickup
- Cash-on-delivery disabled

---

# 43. Initial configuration summary

## 43.1 Confirmed launch values

- Currency: Canadian dollars
- Menu-item HST: 13%
- Delivery fee: C$3.50
- Delivery fee taxable: no
- Delivery minimum: C$0.00
- Delivery radius: 10 km
- Pickup default preparation time: 15 minutes
- No active per-slot order capacity
- Pickup pay-at-store: enabled
- Delivery pay-at-store: disabled
- Guest checkout: enabled
- Account signup discount: disabled
- Saved cards: not required
- Halal surcharge: C$0
- Extra dipping sauce: C$1.20
- Half topping on one side counts as one topping
- No fixed maximum pizza toppings
- Default tip choices: 10%, 15%, 18%, custom, no tip
- Default payroll period: biweekly
- Location verification for clock-in: disabled
- Unpaid manual breaks: supported
- Feedback delay: configurable within the intended 60–90 minute range
- Low-rating alert threshold: one or two stars

## 43.2 Initial feature flags

Recommended feature controls:

- Customer reorder: disabled until final confirmation
- Saved payment cards: disabled
- Cash on delivery: disabled
- Location verification: disabled
- Order-capacity limits: disabled
- Extra wing sauce add-on: disabled
- Blue-cheese add-on: disabled
- Bottled-pop upgrades: disabled
- Halal public preparation claim: hidden
- Breaded/non-breaded wing label: hidden
- Dry-rub label: hidden

---

# 44. Remaining confirmations before launch

The following items are not fully confirmed:

1. Exact halal topping list
2. Approved halal preparation and cross-contamination wording
3. Whether wings are breaded or non-breaded
4. Whether Cajun and Lemon Pepper should be labelled dry rubs
5. Final flavour-splitting rule for every wing quantity
6. Bottled-pop sizes, flavours, availability, and prices
7. Final cancellation and refund policy
8. Direct Google Business Profile review link
9. Whether one-click reorder is enabled in version one
10. Initial default delivery completion estimate
11. Exact restaurant delivery-origin address and coordinates

These items should not block the architecture.

They should be represented through configuration, hidden labels, disabled feature flags, or setup-required fields.

---

# 45. Out of scope for the initial release

Unless already supported and explicitly approved, the following are not required for the first release:

- Full point-of-sale replacement
- Kitchen ticket printer integration
- Saved payment cards
- Cash on delivery
- Automatic order cancellation
- Automatic refunds without restaurant approval
- Public cross-contamination guarantees
- Bottle-size drink upgrades
- One-device-only employee clock-in
- Mandatory location tracking
- Hard order-capacity limits
- Topping light/regular/extra controls
- Half-pizza price splitting
- Converting pounds of wings to wing counts

The design should not make future additions unnecessarily difficult.

---

# 46. Core acceptance criteria

## 46.1 Customer ordering

A customer can:

- Select pickup or delivery
- Pass or fail the correct delivery validation
- Browse only eligible products
- Customize a pizza correctly
- Use whole, left, and right toppings
- See correct included and extra topping charges
- Select halal for the whole eligible product
- Configure wings according to the product's flavour limit
- Select included pops individually
- Add upsells
- Choose ASAP or a valid scheduled time
- Check out as a guest
- Pay online
- Choose pay at store for pickup
- Receive a confirmed order
- Track the order only with a secure token

## 46.2 Pricing

Automated tests must verify:

- Every pizza-size topping price
- Included topping allowances
- Extra cheese counting
- Half-topping counting
- Shared six-topping allocation
- Gourmet extra toppings
- Pizza Sub and Panzerotti included toppings
- Bundle pricing
- Coupon stacking
- Non-combinable promotion handling
- Free delivery
- Delivery fee excluded from HST
- 13% HST on taxable menu items
- Tip percentage basis
- Custom tip
- Refund amount consistency

## 46.3 Delivery

Tests must verify:

- 10 km default radius
- Configurable radius
- Inside-area acceptance
- Outside-area rejection
- Full-address revalidation
- C$3.50 fee
- No minimum
- Fee hidden on first postal-code screen
- Hamilton Heroes removes the full fee
- Free delivery does not expand the radius

## 46.4 Orders and kitchen

The restaurant can:

- Receive a real order
- Hear and see a new-order alert
- Acknowledge it
- View all required customization
- Change only valid statuses
- Update preparation time
- Pause ordering
- Mark a product unavailable
- Cancel or refund only with permission
- See an audit record

## 46.5 Administration

The owner can change without code:

- Product price
- Topping price
- Delivery fee
- Delivery radius
- Hours
- Preparation estimates
- Offer price
- Included products
- Included topping counts
- Shared topping allowance
- Upsells
- Taxability
- Tip options
- Employee permissions
- Feedback delay
- Google review link
- Homepage content

## 46.6 Employee time clock

An employee can:

- Clock in
- Start and end a manual unpaid break
- Clock out
- View own records
- Submit a correction
- Submit time off

The owner can:

- Approve or reject corrections
- Edit records with an audit trail
- Approve or reject time off
- Export PDF, CSV, and Excel payroll reports
- Use a biweekly default period

## 46.7 Feedback

The system can:

- Schedule feedback after expected completion
- Hide irrelevant questions
- Record one- and two-star feedback
- Alert the owner immediately
- Show the Google review option to every respondent
- Keep the review link configurable
- Secure the form with a non-guessable token

---

# 47. Definition of done

A feature is complete only when:

- The customer-facing flow works
- Server-side validation enforces the rule
- Admin configuration exists where required
- Permission checks are applied
- Error states are handled
- Data is persisted correctly
- Important actions are auditable
- Responsive layouts work
- Relevant automated tests pass
- No unconfirmed public claim is displayed
- The implementation does not depend on a developer for routine restaurant changes

The finished product must behave like an operational restaurant platform, not a static menu or visual prototype.
