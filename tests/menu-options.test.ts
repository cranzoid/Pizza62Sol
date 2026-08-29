/**
 * The pop list, and the products that promise pops.
 *
 * Two properties, both of which had already failed once.
 *
 * **One list.** The canned-pop flavours existed in four places — the menu seed,
 * the launch config, the customizer's fallback and the server's validator — and
 * they had drifted. That is not a tidiness complaint: the customizer's copy is
 * what the customer picks from and the validator's copy is what the server will
 * accept, so a flavour in one and not the other is a customer choosing a drink
 * and being told their order is invalid. The lists are now one constant, and
 * this proves every consumer reaches the same object.
 *
 * **A promise of pops implies a way to choose them.** A deal whose description
 * says "4 pops" and whose configuration has three pop selectors sends the
 * kitchen a ticket one can short, and nobody finds out until the bag is opened.
 * The description is the source of truth here because it is what the customer
 * read before paying.
 *
 * Pure — no database needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { DRINK_OPTIONS, TWO_LITRE_DRINK_OPTIONS, WING_FLAVOURS } = await import("@/lib/domain");
const menu = await import("@/lib/menu");
const { MENU_PRODUCTS } = menu;

/** Owner's list, 2026-08-24 — the cans actually in the fridge. */
const OWNER_POPS = [
  "Pepsi",
  "Diet Pepsi",
  "Coke",
  "Diet Coke",
  "Coke Zero",
  "Brisk",
  "Root Beer",
  "Fanta Orange",
  "Fanta Pineapple",
  "Sprite",
  "Canada Dry",
  "Crush Grape",
  "Crush Cream Soda",
  "Mountain Dew",
  "Dr Pepper",
];

test("the pop list is the one the owner gave us, in order", () => {
  assert.deepEqual([...DRINK_OPTIONS], OWNER_POPS);
});

test("the menu seed and the browser read the same list object", () => {
  // Not `deepEqual` on purpose. Two arrays with equal contents is exactly the
  // state this is meant to rule out: it is what four copies looked like the day
  // before they drifted.
  assert.equal(menu.DRINK_OPTIONS, DRINK_OPTIONS, "lib/menu must re-export the list, not restate it");
  assert.equal(menu.WING_FLAVOURS, WING_FLAVOURS, "lib/menu must re-export the wing sauces, not restate them");
  assert.equal(menu.TWO_LITRE_DRINK_OPTIONS, TWO_LITRE_DRINK_OPTIONS, "lib/menu must re-export the bottles, not restate them");
});

test("a 2 L bottle is offered in the two flavours that exist, not the fifteen that do not", () => {
  assert.deepEqual([...TWO_LITRE_DRINK_OPTIONS], ["Coke", "Pepsi"]);
  // The whole point of a separate list. If the bottles ever become the cans,
  // that is a decision someone makes here, not a drift nobody notices.
  assert.notDeepEqual([...TWO_LITRE_DRINK_OPTIONS], [...DRINK_OPTIONS]);
});

test("a retired flavour is gone rather than quietly still accepted", () => {
  for (const retired of ["Gingerale", "Crush Orange", "Brisk Ice Tea", "Dr. Peppers", "Fanta Grape"]) {
    assert.ok(!DRINK_OPTIONS.includes(retired as never), `${retired} was replaced and must not still be orderable`);
  }
});

test("every product that promises pops can have them chosen, one drink at a time", () => {
  // A bottle is matched before the can pattern, and deliberately: "2 L pop" is
  // one bottle in one flavour, and reading its size as a quantity would demand
  // two choosers for a single drink.
  const bottled = /(\d+(?:\.\d+)?)\s*L\s+pop\b/i;
  const written = /(\d+)\s+(?:canned\s+)?pops?\b/i;
  let checked = 0;
  for (const product of MENU_PRODUCTS) {
    const bottle = product.description.match(bottled);
    const promised = bottle ? null : product.description.match(written);
    const sections = (product.configuration?.sections ?? []) as Array<{ source?: string; min?: number; max?: number }>;
    const choosers = sections.filter((section) => section.source === "drinks" || section.source === "two_litre_drinks");
    if (!bottle && !promised && !choosers.length) continue;
    checked += 1;
    assert.ok(bottle ?? promised, `${product.id} offers a pop chooser but never says so in its description`);
    const expected = bottle ? 1 : Number(promised![1]);
    assert.equal(
      choosers.length,
      expected,
      `${product.id} promises "${(bottle ?? promised)![0]}" but offers ${choosers.length} to choose`,
    );
    // One selector per can, so four pops are four separate flavours rather than
    // one choice quietly multiplied by four.
    for (const chooser of choosers) {
      assert.equal(chooser.min, 1, `${product.id} must require every included can to be chosen`);
      assert.equal(chooser.max, 1, `${product.id} must take one flavour per can`);
    }
  }
  assert.ok(checked >= 4, "expected the deals and the pickup special to be covered");
});

test("pop groups carry no options of their own, so the list stays live", () => {
  // A section that stored its own copy of the flavours would freeze them at seed
  // time: changing the fridge would need a data migration per product rather
  // than an edit to one constant.
  for (const product of MENU_PRODUCTS) {
    const sections = (product.configuration?.sections ?? []) as Array<{ source?: string; options?: string[] }>;
    for (const section of sections.filter((entry) => entry.source === "drinks" || entry.source === "two_litre_drinks")) {
      assert.equal(section.options, undefined, `${product.id} pins its own pop list instead of using the live one`);
    }
  }
});
