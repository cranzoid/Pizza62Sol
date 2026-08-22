# Pizza 62 UI/UX consistency audit

**Audit date:** 2026-08-22  
**Scope:** customer storefront, ordering states, tracking, feedback, payment return,
policies, staff login, employee clock, kiosk, kitchen, admin operations, analytics,
records, integrations, menu/settings/team editors, and Azure staging/production flow.  
**Design constraint:** retain the existing Pizza 62 palette, typography character,
illustration style, cards, borders, shadows, and information architecture.

## Method and evidence

- Inventoried every UI route and all 5,496 lines of React/CSS UI source.
- Enumerated the live production catalog and operational settings through the
  public API (11 categories, 63 products, 53 variations, 23 toppings).
- Traced customer states: open/closed, pickup/delivery, simple/configurable/pizza/
  bundle items, cart revalidation, checkout, confirmation, tracking, feedback,
  and payment return.
- Traced authenticated states from source: owner/staff login, admin sections,
  kitchen queue/tickets, employee clock, schedule/timesheet/requests, manager
  scheduling, and shared kiosk.
- Ran TypeScript, ESLint, automated tests, production build, and Azure health
  checks as recorded in the final verification section.
- Rendered viewport validation requires the connected browser session. The
  browser was unavailable during the initial pass, so production must not be
  swapped until the staging matrix below has been exercised.

## Route and state inventory

| Surface | Routes / states audited |
|---|---|
| Storefront | `/`; announcement, closed banner/dialog, hero, pickup/delivery gate, promises, 11-category menu, deal, hours, footer |
| Ordering | Pizza, bundle, configurable and simple-item customizers; half toppings; halal; fixed recipes; cart; pickup and delivery checkout; scheduled ordering; promo/tip/payment/terms; confirmation |
| Customer follow-up | `/track`, `/feedback`, `/order/return` including loading, error, paid, pending, timeout, cancelled and duplicate states |
| Policies | `/terms`, `/privacy`, `/accessibility`, `/cancellation` |
| Staff access | `/admin`, `/kitchen`, `/employee`; checking, normal login and first-owner setup states |
| Operations | Overview, live orders, take an order, analytics, history/offers, website, settings, integrations, menu, team, time clock |
| Employee / kiosk | Clock, schedule, hours, requests and `/kiosk` roster/PIN/action/result states |

## Findings and disposition

| Priority | Finding | Desktop | Mobile / tablet | Disposition |
|---|---|---:|---:|---|
| P0 | Admin and employee navigation labels were hidden at widths ≤1050px even though the buttons had no icons, creating blank navigation controls. | — | Critical | Fixed: readable 200px tablet rail and labelled horizontal mobile navigation. |
| P0 | Sign out disappeared with the staff sidebar footer on mobile, unsafe on shared devices. | — | Critical | Fixed: explicit mobile sign-out action in operations and employee top bars. |
| P1 | Storefront primary navigation disappeared at ≤1050px without a replacement. | — | High | Fixed: compact Menu/Track shortcuts using the existing header styling. |
| P1 | Many customer and staff controls inherited 7–11px text; form focus could trigger iOS page zoom. | High | High | Fixed: legibility scale raised selectively; mobile form controls are 16px. |
| P1 | Customer dialogs and the shift editor lacked consistent Escape handling, focus containment/restoration and background scroll locking. | High | High | Fixed with shared dialog behaviour; visual styling is unchanged. |
| P1 | Cart drawer was not exposed as a modal dialog and confirmation lacked an accessible name. | High | High | Fixed semantic roles and labels. |
| P1 | Admin/history/timesheet tables overflowed narrow panels without an explicit scroll region. | Medium | High | Fixed with named, keyboard-focusable horizontal scroll regions. |
| P1 | Analytics pairs remained two columns on mobile due to a later CSS override. | — | High | Fixed to one column at tablet/mobile widths. |
| P1 | The closed-store strip forced its timer, long message and CTA into one compressed row. | — | High | Fixed with a two-row mobile grid and full-width CTA. |
| P1 | Long mobile display headings used fixed 55–64px sizes and could overflow at 320px. | — | High | Fixed with viewport-clamped sizes while retaining the same type treatment. |
| P1 | Long staff navigation and page content competed for space on tablets. | — | High | Fixed by retaining readable labels and a practical rail width before switching to horizontal navigation. |
| P1 | Public menu/category navigation was lost during long 63-product browsing sessions. | High | High | Fixed with a sticky, horizontally scrollable category bar in the existing colors. |
| P2 | Secondary public pages used a different hand-built brand mark from the storefront. | Medium | Medium | Fixed with one shared utility header and the actual Pizza 62 wordmark. |
| P2 | Policy, tracking, feedback and return pages had no skip link. | Medium | Medium | Fixed with a consistent Skip to content target. |
| P2 | The staff login flash rendered as a half-width panel, and login had no route back to the customer site. | Medium | Medium | Fixed full-width checking state and added a clear back link. |
| P2 | Product hover elevation had no keyboard equivalent and could remain active on touch devices. | Medium | Medium | Fixed with `:focus-within` and touch-hover suppression. |
| P2 | Sticky headers could cover Menu/Deals/Hours/category anchor targets. | Medium | Medium | Fixed scroll offsets for each destination. |
| P2 | Category tabs were a generic labelled `div`, and selected fulfilment controls did not expose pressed state. | Medium | Medium | Fixed with `nav`, grouped controls and `aria-pressed`. |
| P2 | The cart’s accessible item count used line count while the visible badge used summed quantity. | Medium | Medium | Fixed both to the same quantity and singular/plural label. |
| P2 | Postal-code delivery check did not submit from the keyboard Enter key. | Medium | Medium | Fixed by making the dialog a form. |
| P2 | Checkout time `select` did not share the input styling. | Medium | Medium | Fixed with the existing border, surface and spacing language. |
| P2 | Dynamic mobile viewport and safe-area insets were not used for full-height customizers, carts, checkout or kiosk. | — | Medium | Fixed with `dvh` and safe-area padding. |
| P2 | Tracking status and order rows could collide when the status or item name was long. | Medium | High | Fixed wrapping, gaps and mobile type sizing. |
| P2 | Analytics daily values depended on hover and column charts exposed only the peak value. | Medium | High | Fixed pointer/focus selection, descriptive labels and visible values. |
| P2 | Kitchen-screen ticket details were 7–9px despite being scanned at distance. | High | High | Fixed screen-only ticket type; thermal print CSS remains unchanged. |
| P2 | Till quantity targets were only 30×30px despite being described as thumb controls. | Medium | High | Fixed to 40×40px without changing layout or color. |
| P2 | Kiosk PIN feedback did not announce how many digits had been entered. | — | Medium | Fixed with a non-sensitive live count. |
| P2 | Staging's `SEO_INDEXABLE=false` setting was not reflected in metadata or `robots.txt`, so a preview slot could be crawled. | Medium | Medium | Fixed: non-indexable slots emit noindex metadata and disallow all crawlers. |
| P2 | Admin accepted remote HTTPS product/hero images while the Content Security Policy blocked them from rendering. | Medium | Medium | Fixed by aligning `img-src` with the editor's existing HTTPS-only validation. |
| Data | Two active public products are named `test` (one simple side and one pizza). | High | High | Not mutated in this UI-only pass; deactivate from Admin → Menu setup before production swap. |

## Viewport validation matrix

The staging deployment must be checked at these representative sizes before the
slot swap:

| Viewport | Required coverage | Status |
|---|---|---|
| 1440×900 desktop | Header/hero/menu, each customizer type, cart/checkout, utility pages, admin/kitchen dense layouts | Pending connected browser |
| 1024×768 tablet | Public shortcuts, two-column menu, labelled staff rail, tables and settings grids | Pending connected browser |
| 390×844 phone | Closed strip, sticky menu tabs, all dialogs, checkout, utility pages, staff horizontal nav/sign-out, kiosk | Pending connected browser |
| 320×568 small phone | Heading wrapping, footer, customizer footer, forms, tracking and dense staff controls | Pending connected browser |

## Out-of-scope visual changes deliberately avoided

- No palette, logo, illustration, border, shadow or type-family redesign.
- No menu copy/pricing or business-policy changes.
- No production menu-data deletion.
- No information-architecture rewrite.

## Release gate

Do not swap staging into production until:

1. TypeScript, lint, tests and production build pass.
2. Staging `/api/health` returns `{"status":"ok"}`.
3. The four viewport checks above pass in a connected browser.
4. The two public `test` products are either confirmed intentional or deactivated.
