"use client";

/**
 * Building one item — a pizza, a deal, a pound of wings — wherever it is built.
 *
 * This was inside the customer app, which meant the counter could not offer any
 * product that needed a choice made about it. The till's own comment said so:
 * items with required choices were "deliberately not offered here", because the
 * alternative on the table was a second, simpler customizer written for the till
 * screen — and a half-built one produces orders the kitchen cannot read.
 *
 * That was the wrong pair of options. The customizer is not a customer feature;
 * it is the definition of what a pizza with three toppings *is*, and the counter
 * needs exactly that definition. So it lives here and both screens mount it.
 * A pizza rung in at the till is now built from the same steps, in the same
 * order, priced by the same `pricePizza`, and reaches the kitchen in the same
 * shape as one ordered from a phone on the bus. There is no second answer to
 * "what is on it" for the two to disagree about.
 *
 * Nothing here talks to the network or knows what a cart is. It hands a built
 * item to `onAdd` and closes; where that item goes is the caller's business,
 * which is why the same component can feed a shopping bag and a till receipt.
 */

import { useMemo, useState } from "react";
import { changeDrinkQuantity, includedDrinkPools } from "@/lib/drink-slots";
import { useDialogBehavior } from "@/app/useDialogBehavior";
import {
  BAKE_SAUCE_OPTIONS,
  CHEESE_OPTIONS,
  CRUST_OPTIONS,
  DEFAULT_CHEESE_OPTION,
  DEFAULT_CRUST_OPTION,
  DRINK_OPTIONS,
  EXTRA_CHEESE_OPTION,
  NEW_OPTIONS,
  PIZZA_EXTRA_OPTIONS,
  SAUCE_OPTIONS,
  TWO_LITRE_DRINK_OPTIONS,
  WING_FLAVOURS,
  defaultSectionValues,
  formatMoney,
  modifierUnitsBps,
  normalizeModifierValues,
  isRetiredSection,
  orderModifierSections,
  pizzaExtrasSection,
  pizzaSauceSection,
  pricePizza,
  priceModifierSelections,
  toppingWeight,
  normalizeToppings,
  sectionOptionPrices,
  type ModifierSection,
  type ToppingPlacement,
} from "@/lib/domain";

/**
 * The three catalogue shapes a customizer reads.
 *
 * Structural, not nominal, and deliberately minimal: the storefront's catalogue
 * rows and the staff dashboard's carry different extra columns, and both satisfy
 * these without either side converting anything.
 */
export type CustomizerProduct = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  product_type: "pizza" | "simple" | "bundle" | "configurable";
  base_price_cents: number;
  taxable: number;
  sold_out: number;
  setup_required: number;
  configuration: Record<string, unknown>;
};

export type CustomizerVariation = {
  id: string;
  product_id: string;
  name: string;
  base_price_cents: number;
  extra_topping_price_cents: number;
  included_topping_units_bps: number;
};

export type CustomizerTopping = {
  id: string;
  name: string;
  is_meat: number;
};

export type ModifierSelection = {
  id: string;
  label: string;
  values: Array<{ value: string; label: string; placement?: ToppingPlacement }>;
};

export type SelectedTopping = { toppingId: string; placement: ToppingPlacement; name: string };

/**
 * One finished item, priced and described.
 *
 * The customer app's cart line and a line on the till receipt are the same
 * thing, so they are the same type. `quantity` starts at 1 and is the caller's
 * to adjust; `key` is a client-side identity for React and for "remove this
 * line", and never reaches the server.
 */
export type BuiltItem = {
  key: string;
  productId: string;
  name: string;
  categoryId: string;
  variationId?: string;
  variationName?: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  toppings?: SelectedTopping[];
  /** H-03: recipe toppings the customer asked us to leave off. */
  omitToppings?: string[];
  modifiers?: ModifierSelection[];
  /** Presentation metadata only; never sent to the orders API. */
  modifierSections?: ModifierSection[];
  extraCheese?: boolean;
  specialInstructions?: string;
  freeDelivery?: boolean;
  /** Why this line was suggested, retained for aggregate merchandising analytics. */
  merchandising?: {
    source: "upsell";
    placement: "cart";
    ruleId: string;
    sourceProductIds: string[];
  };
};

/**
 * Built items in the shape the orders API expects, for quoting and for placing.
 *
 * Shared with the till for the same reason the customizer is: a counter order
 * encoded by a second copy of this mapping is how "extra cheese" reaches the
 * kitchen from the website and not from the phone.
 */
export function toOrderItems(items: BuiltItem[]) {
  return items.map((line) => ({
    productId: line.productId,
    variationId: line.variationId,
    quantity: line.quantity,
    toppings: line.toppings?.map(({ toppingId, placement }) => ({ toppingId, placement })),
    omitToppings: line.omitToppings,
    modifiers: line.modifiers?.map((modifier) => ({
      id: modifier.id,
      values: modifier.values.map((value) => (value.placement ? { value: value.value, placement: value.placement } : value.value)),
    })),
    extraCheese: line.extraCheese,
    specialInstructions: line.specialInstructions,
    merchandising: line.merchandising,
  }));
}

/** True when the product cannot be added without the customer choosing something. */
export function needsCustomizing(product: CustomizerProduct): boolean {
  if (product.product_type === "pizza") return true;
  const sections = product.configuration?.sections;
  return Array.isArray(sections) && sections.length > 0;
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
/** "1", "1.5", "2" — half toppings show as fractions of the included allowance. */
const formatUnits = (units: number) => (Number.isInteger(units) ? String(units) : units.toFixed(1));

function ArrowIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

export function ToppingPicker({
  toppings,
  selected,
  allowPlacement = true,
  wholeOnly,
  onToggle,
  onPlacement,
}: {
  toppings: CustomizerTopping[];
  selected: SelectedTopping[];
  allowPlacement?: boolean;
  /** Toppings that only go on the whole pizza — a specialty's recipe. */
  wholeOnly?: ReadonlySet<string>;
  onToggle: (topping: CustomizerTopping) => void;
  onPlacement: (toppingId: string, placement: ToppingPlacement) => void;
}) {
  return <div className="topping-groups">{[false, true].map((meat) => <div key={String(meat)}><h4>{meat ? "Meat & fish" : "Veggies & cheese"}</h4><div className="topping-grid">{toppings.filter((topping) => Boolean(topping.is_meat || topping.id === "anchovies") === meat).map((topping) => {
    const entry = selected.find((item) => item.toppingId === topping.id);
    return <div className={`topping-chip ${entry ? "topping-chip--active" : ""}`} key={topping.id}>
      <button className={entry ? "active" : ""} type="button" aria-pressed={Boolean(entry)} onClick={() => onToggle(topping)}>
        <span>{entry ? "✓" : "+"}</span>{topping.name}{toppingWeight(topping.id) === 2 ? <small>Counts as 2 toppings</small> : null}
      </button>
      {entry && allowPlacement && !wholeOnly?.has(topping.id) ? <div className="placement-switch" role="group" aria-label={`${topping.name} placement`}>
        {PLACEMENTS.map(([placement, symbol, label]) => <button
          key={placement}
          type="button"
          className={entry.placement === placement ? "active" : ""}
          aria-pressed={entry.placement === placement}
          onClick={() => onPlacement(topping.id, placement)}
        ><i aria-hidden="true">{symbol}</i>{label}</button>)}
      </div> : null}
    </div>;
  })}</div></div>)}</div>;
}

const PLACEMENTS: Array<[ToppingPlacement, string, string]> = [
  ["left", "◐", "Left"],
  ["whole", "●", "Whole"],
  ["right", "◑", "Right"],
];

export function placementSuffix(placement: ToppingPlacement) {
  return placement === "left" ? " · left half" : placement === "right" ? " · right half" : "";
}

/** What the chosen sauce or extras add to the price, by the section's own rule. */
function optionTotal(section: ModifierSection, values: string[]): number {
  const prices = sectionOptionPrices(section);
  return values.reduce((sum, value) => sum + (prices[value] ?? 0), 0);
}

/** A sauce is one choice: tapping the chosen one leaves it chosen. Extras toggle. */
function nextFinishValues(section: ModifierSection, values: string[], option: string): string[] {
  if (section.source === "sauce") return [option];
  return values.includes(option) ? values.filter((value) => value !== option) : [...values, option];
}

/**
 * The sauce and extras steps, shared by a pizza on its own and the pizzas in a
 * deal so the two cannot drift apart.
 *
 * Every option shows its price or says it is free, because "+ Olive Oil" alone
 * does not tell anyone whether ticking it costs money. The new sauces get one
 * callout rather than a badge each — five badges in a row is wallpaper — while
 * the one new extra gets its badge, in its own colour, beside its name.
 */
function FinishChoices({
  section,
  values,
  onToggle,
  includedSauce,
  showCallout = true,
}: {
  section: ModifierSection;
  values: string[];
  onToggle: (option: string) => void;
  includedSauce?: string;
  showCallout?: boolean;
}) {
  const prices = sectionOptionPrices(section);
  const isSauce = section.source === "sauce";
  const options: readonly string[] = isSauce ? SAUCE_OPTIONS : PIZZA_EXTRA_OPTIONS;
  const paid = Object.values(prices).filter((cents) => cents > 0);
  const swapPrice = paid.length ? formatMoney(Math.min(...paid)) : null;
  const newExtras = options.filter((option) => NEW_OPTIONS.has(option));
  return <>
    {showCallout && isSauce ? <div className="new-callout"><em className="new-badge">New</em><div><strong>Try our new sauces</strong><p>BBQ, butter chicken, creamy garlic, honey garlic or shawarma{swapPrice ? ` for ${swapPrice} each` : ""}.{includedSauce ? ` ${includedSauce} sauce comes with this pizza at no charge.` : ""} Tomato is the classic and always free.</p></div></div> : null}
    {showCallout && !isSauce && newExtras.length ? <div className="new-callout"><em className="new-badge">New</em><div><strong>Try our new homemade seasoning</strong><p>Fresh from our kitchen, made to go on pizza. Oregano and chili flakes are free — tick them if you&apos;d like some.</p></div></div> : null}
    <div className="topping-grid finish-grid">{options.map((option) => {
      const active = values.includes(option);
      const price = prices[option] ?? 0;
      return <button className={active ? "active" : ""} type="button" key={option} aria-pressed={active} onClick={() => onToggle(option)}>
        <span>{active ? "✓" : "+"}</span>{option}{NEW_OPTIONS.has(option) ? <em className="new-badge">New</em> : null}<small>{price ? `+${formatMoney(price)}` : "Free"}</small>
      </button>;
    })}</div>
  </>;
}

export function PizzaCustomizer({
  product,
  variations,
  toppings,
  halfToppingUnitsBps,
  onClose,
  onAdd,
  initialItem,
  onSave,
}: {
  product: CustomizerProduct;
  variations: CustomizerVariation[];
  toppings: CustomizerTopping[];
  halfToppingUnitsBps: number;
  onClose: () => void;
  onAdd: (line: BuiltItem) => void;
  initialItem?: BuiltItem;
  onSave?: (line: BuiltItem) => void;
}) {
  const dialogRef = useDialogBehavior<HTMLElement>(true, onClose);
  const configuration = product.configuration;
  const recipeToppingIds = Array.isArray(configuration.recipeToppingIds)
    ? configuration.recipeToppingIds.map(String)
    : [];
  const [variationId, setVariationId] = useState(initialItem?.variationId ?? variations[0]?.id ?? "");
  const [selected, setSelected] = useState<SelectedTopping[]>(() =>
    normalizeToppings([...(initialItem?.toppings ?? []), ...recipeToppingIds.map((toppingId) => ({ toppingId, placement: "whole" as const }))]).map(({ toppingId, placement }) => ({
      toppingId,
      placement,
      name: toppings.find((topping) => topping.id === toppingId)?.name ?? toppingId,
    })),
  );
  // H-03: a specialty pizza is its recipe, and "hold the mushrooms" is a normal
  // request. The recipe toppings are shown ticked at the top of the ordinary
  // picker; unticking one asks for it to be left off (owner, 2026-10-06 — a list
  // of "Leave it off" buttons read badly). Underneath, the topping stays in the
  // build and is named in `omitted`, which is the shape the server checks the
  // recipe against and the ticket prints NO MUSHROOMS from. Leaving something
  // off never changes the price: it is not a discount, and treating it as one
  // would let the same named product be bought cheaper by swapping ingredients.
  const fixedRecipe = Boolean(configuration.fixedRecipe);
  const [omitted, setOmitted] = useState<string[]>(initialItem?.omitToppings ?? []);
  const cheeseEnabled = configuration.cheeseEnabled !== false;
  const crustOptions = stringList(configuration.crustOptions);
  const bakeSauceOptions = stringList(configuration.bakeSauceOptions);
  // Pizzas configured before crust and bake/sauce were split keep one combined group.
  const legacyBaseOptions = !crustOptions.length && !bakeSauceOptions.length ? stringList(configuration.pizzaBaseOptions) : [];
  const initialValues = (id: string) => initialItem?.modifiers?.find((modifier) => modifier.id === id)?.values.map((entry) => entry.value);
  const initialNote = initialItem?.specialInstructions ?? "";
  const noteCheese = CHEESE_OPTIONS.find((option) => initialNote === option || initialNote.startsWith(`${option} · `));
  const [cheese, setCheese] = useState(initialItem ? (initialItem.extraCheese ? EXTRA_CHEESE_OPTION : noteCheese ?? DEFAULT_CHEESE_OPTION) : configuration.presetExtraCheese ? EXTRA_CHEESE_OPTION : DEFAULT_CHEESE_OPTION);
  const [crust, setCrust] = useState(() => initialValues("pizza-crust")?.[0] ?? (crustOptions.includes(DEFAULT_CRUST_OPTION) ? DEFAULT_CRUST_OPTION : crustOptions[0] ?? ""));
  const [bakeSauce, setBakeSauce] = useState<string[]>(initialValues("pizza-bake-sauce") ?? []);
  const [legacyBase, setLegacyBase] = useState<string[]>(initialValues("pizza-base") ?? []);
  // The same groups, ids and prices the server builds in `pizzaOptionSections`.
  const includedSauce = typeof configuration.includedSauce === "string" ? configuration.includedSauce : undefined;
  const sauceSection = configuration.sauceEnabled ? pizzaSauceSection("pizza-sauce", { includedSauce }) : null;
  const extrasSection = configuration.extrasEnabled ? pizzaExtrasSection("pizza-extras") : null;
  const [sauce, setSauce] = useState<string[]>(() => (initialValues("pizza-sauce") ?? (sauceSection ? defaultSectionValues(sauceSection, includedSauce) : [])));
  const [extras, setExtras] = useState<string[]>(() => (initialValues("pizza-extras") ?? (extrasSection ? defaultSectionValues(extrasSection) : [])));
  const finishCents = (sauceSection ? optionTotal(sauceSection, sauce) : 0) + (extrasSection ? optionTotal(extrasSection, extras) : 0);
  const [instructions, setInstructions] = useState(noteCheese ? initialNote.slice(noteCheese.length).replace(/^ · /, "") : initialNote);
  const [quantity, setQuantity] = useState(initialItem?.quantity ?? 1);
  const variation = variations.find((entry) => entry.id === variationId) ?? variations[0];
  const extraCheese = cheeseEnabled && cheese === EXTRA_CHEESE_OPTION;
  const price = variation
    ? pricePizza({
        basePriceCents: variation.base_price_cents,
        extraToppingPriceCents: variation.extra_topping_price_cents,
        includedToppingUnitsBps: variation.included_topping_units_bps,
        halfToppingUnitsBps,
        toppings: selected,
        extraCheese,
        recipeToppingIds: fixedRecipe ? recipeToppingIds : undefined,
        recipeExtraCheese: fixedRecipe && Boolean(configuration.presetExtraCheese),
      })
    : null;
  const includedCount = (variation?.included_topping_units_bps ?? 0) / 10_000 + (fixedRecipe ? recipeToppingIds.reduce((sum, id) => sum + toppingWeight(id) - 1, 0) : 0);
  const selectedUnits = (price?.toppingUnitsBps ?? 0) / 10_000;
  const selectedToppingUnits = modifierUnitsBps(
    selected.map((entry) => ({ value: entry.toppingId, placement: entry.placement })),
    halfToppingUnitsBps,
  ) / 10_000;
  const requiredToppingUnits = configuration.requireIncludedToppings ? includedCount : includedCount > 0 ? 1 : 0;
  const selectionValid = Boolean(
    variation && (configuration.fixedRecipe || (configuration.requireIncludedToppings ? selectedToppingUnits >= requiredToppingUnits : includedCount <= 0 || selected.length > 0)),
  );
  const recipeIds: ReadonlySet<string> = new Set(fixedRecipe ? recipeToppingIds : []);
  // What the customer sees ticked: the build, less anything they asked us to leave off.
  const shownSelected = selected.filter((entry) => !omitted.includes(entry.toppingId));
  const toggleTopping = (topping: CustomizerTopping) => {
    if (recipeIds.has(topping.id)) {
      setOmitted((current) => current.includes(topping.id) ? current.filter((id) => id !== topping.id) : [...current, topping.id]);
      return;
    }
    setSelected((current) => current.some((entry) => entry.toppingId === topping.id)
      ? current.filter((entry) => entry.toppingId !== topping.id)
      : [...current, { toppingId: topping.id, placement: "whole", name: topping.name }]);
  };
  const setPlacement = (toppingId: string, placement: ToppingPlacement) =>
    setSelected((current) => current.map((entry) => entry.toppingId === toppingId ? { ...entry, placement } : entry));
  // The customer is always asked in the same order: what it is made of, how it is
  // baked, then what goes on it, and last what comes in the box with it. Steps
  // that are switched off are skipped and the numbering closes up behind them.
  // The owner can put toppings before the crust.
  const baseSteps = [crustOptions.length ? "crust" : "", sauceSection ? "sauce" : "", bakeSauceOptions.length ? "bake" : "", legacyBaseOptions.length ? "legacy" : ""];
  const steps = [
    "size",
    cheeseEnabled ? "cheese" : "",
    ...(configuration.toppingsFirst ? ["toppings", ...baseSteps] : [...baseSteps, "toppings"]),
    extrasSection ? "extras" : "",
  ].filter(Boolean);
  const stepNumber = (name: string) => String(steps.indexOf(name) + 1);
  const sizePanel = <><fieldset><legend><span>{stepNumber("size")}</span> {String(configuration.variationLabel ?? "Choose your size")}</legend><div className="size-options">{variations.map((item) => <label key={item.id} className={item.id === variationId ? "selected" : ""}><input type="radio" name="size" value={item.id} checked={item.id === variationId} onChange={() => setVariationId(item.id)} /><span><b>{item.name}</b><small>{formatMoney(item.base_price_cents)}</small></span></label>)}</div></fieldset></>;
  const cheesePanel = <>{cheeseEnabled ? <fieldset><legend><span>{stepNumber("cheese")}</span> Cheese</legend>
            {cheeseEnabled ? <div className="size-options cheese-options">{CHEESE_OPTIONS.map((option) => <label key={option} className={cheese === option ? "selected" : ""}><input type="radio" name="cheese" checked={cheese === option} onChange={() => setCheese(option)} /><span><b>{option.replace(" Cheese", "")}</b><small>{option === EXTRA_CHEESE_OPTION ? `Counts as one topping${variation ? ` · ${formatMoney(variation.extra_topping_price_cents)}` : ""}` : "No extra charge"}</small></span></label>)}</div> : null}
          </fieldset> : null}</>;
  const crustPanel = <>{crustOptions.length ? <fieldset><legend><span>{stepNumber("crust")}</span> Crust</legend><div className="topping-grid">{crustOptions.map((option) => <button className={crust === option ? "active" : ""} type="button" key={option} aria-pressed={crust === option} onClick={() => setCrust(option)}><span>{crust === option ? "✓" : "+"}</span>{option}</button>)}</div></fieldset> : null}</>;
  const saucePanel = <>{sauceSection ? <fieldset><legend><span>{stepNumber("sauce")}</span> Sauce <em className="new-badge">New sauces</em></legend><FinishChoices section={sauceSection} values={sauce} includedSauce={includedSauce} onToggle={(option) => setSauce((current) => nextFinishValues(sauceSection, current, option))} /></fieldset> : null}</>;
  const extrasPanel = <>{extrasSection ? <fieldset><legend><span>{stepNumber("extras")}</span> Extras</legend><FinishChoices section={extrasSection} values={extras} onToggle={(option) => setExtras((current) => nextFinishValues(extrasSection, current, option))} /><div className="allowance-meter"><span>{extras.length} selected</span><b>{extrasSection && optionTotal(extrasSection, extras) ? `${formatMoney(optionTotal(extrasSection, extras))} in extras` : "Optional"}</b></div></fieldset> : null}</>;
  const bakePanel = <>{bakeSauceOptions.length ? <fieldset><legend><span>{stepNumber("bake")}</span> Bake &amp; sauce</legend><div className="topping-grid">{bakeSauceOptions.map((option) => { const active = bakeSauce.includes(option); return <button className={active ? "active" : ""} type="button" key={option} onClick={() => setBakeSauce((current) => active ? current.filter((entry) => entry !== option) : current.length < 2 ? [...current, option] : current)}><span>{active ? "✓" : "+"}</span>{option}</button>; })}</div><div className="allowance-meter"><span>Optional</span><b>Choose up to 2</b></div></fieldset> : null}</>;
  const legacyPanel = <>{legacyBaseOptions.length ? <fieldset><legend><span>{stepNumber("legacy")}</span> Crust, bake &amp; sauce</legend><div className="topping-grid">{legacyBaseOptions.map((option) => { const active = legacyBase.includes(option); return <button className={active ? "active" : ""} type="button" key={option} onClick={() => setLegacyBase((current) => active ? current.filter((entry) => entry !== option) : current.length < 2 ? [...current, option] : current)}><span>{active ? "✓" : "+"}</span>{option}</button>; })}</div></fieldset> : null}</>;
  const toppingsPanel = <><fieldset><legend><span>{stepNumber("toppings")}</span> Choose toppings</legend>
            {fixedRecipe
              ? <div className="setup-alert"><strong>Made to our recipe</strong><p>Its toppings are already ticked. Untick any you&apos;d like left off — the price stays the same and their recipe units stay reserved. Anything else you add is {variation ? `${formatMoney(variation.extra_topping_price_cents)} each` : "charged at the extra-topping rate"}.</p></div>
              : <div className="setup-alert"><strong>{configuration.requireIncludedToppings ? `Choose at least ${includedCount} topping${includedCount === 1 ? "" : "s"}` : includedCount === 1 ? "Your first topping is included" : `Choose up to ${includedCount} included toppings`}</strong><p>Additional toppings are {variation ? `${formatMoney(variation.extra_topping_price_cents)} each` : "priced by size"}. Put a topping on half the pizza and it counts as {halfToppingUnitsBps === 10_000 ? "a full topping" : `${halfToppingUnitsBps / 10_000} of a topping`}.</p></div>}
            <ToppingPicker toppings={toppings} selected={shownSelected} wholeOnly={recipeIds} onToggle={toggleTopping} onPlacement={setPlacement} />
            <div className="allowance-meter"><span>{formatUnits(selectedUnits)} units selected · {includedCount} included</span><b>{price?.extraToppingTotalCents ? `${formatMoney(price.extraToppingTotalCents)} in extras` : selectedToppingUnits >= requiredToppingUnits ? "Included in the price" : `Choose at least ${formatUnits(requiredToppingUnits)}`}</b></div>
          </fieldset></>;
  const modifiers: ModifierSelection[] = [];
  if (crust) modifiers.push({ id: "pizza-crust", label: "Crust", values: [{ value: crust, label: crust }] });
  if (sauceSection && sauce.length) modifiers.push({ id: sauceSection.id, label: sauceSection.label, values: sauce.map((value) => ({ value, label: value })) });
  if (bakeSauce.length) modifiers.push({ id: "pizza-bake-sauce", label: "Bake & sauce", values: bakeSauce.map((value) => ({ value, label: value })) });
  if (legacyBase.length) modifiers.push({ id: "pizza-base", label: "Crust, bake & sauce", values: legacyBase.map((value) => ({ value, label: value })) });
  if (extrasSection && extras.length) modifiers.push({ id: extrasSection.id, label: extrasSection.label, values: extras.map((value) => ({ value, label: value })) });
  return (
    <div className="modal-backdrop modal-backdrop--right" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="customizer" role="dialog" aria-modal="true" aria-labelledby="customizer-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <div className="customizer-head"><div><p className="eyebrow dark"><span /> Customize your order</p><h2 id="customizer-title">{product.name}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="customizer-body">
          {sizePanel}{cheesePanel}
          {configuration.toppingsFirst
            ? <>{toppingsPanel}{crustPanel}{saucePanel}{bakePanel}{legacyPanel}</>
            : <>{crustPanel}{saucePanel}{bakePanel}{legacyPanel}{toppingsPanel}</>}
          {extrasPanel}
          <QuantityEditor quantity={quantity} maximum={99} onChange={setQuantity} />
          <label className="instructions-label">Special instructions <small>Call the restaurant about serious allergies.</small><textarea value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} placeholder="Example: cut into squares" /></label>
        </div>
        <div className="customizer-footer"><div><small>Your pizza</small><strong>{price ? formatMoney((price.totalCents + finishCents) * quantity) : "—"}</strong></div><button className="primary-button" disabled={!selectionValid} onClick={() => variation && price && (onSave ?? onAdd)({ ...initialItem, key: initialItem?.key ?? crypto.randomUUID(), productId: product.id, name: product.name, categoryId: product.category_id, variationId: variation.id, variationName: variation.name, quantity, unitPriceCents: price.totalCents + finishCents, taxable: Boolean(product.taxable), toppings: selected, omitToppings: omitted.length ? omitted : undefined, modifiers, extraCheese, freeDelivery: Boolean(configuration.freeDelivery), specialInstructions: [cheeseEnabled && cheese !== DEFAULT_CHEESE_OPTION ? cheese : "", instructions.trim()].filter(Boolean).join(" · ") })}>{initialItem ? "Save changes" : "Add to order"} <ArrowIcon /></button>{initialItem ? <button className="staff-button" onClick={onClose}>Cancel</button> : null}</div>
      </section>
    </div>
  );
}

function QuantityEditor({ quantity, maximum, onChange }: { quantity: number; maximum: number; onChange: (value: number) => void }) {
  return <fieldset className="quantity-choice"><legend>Quantity</legend><div><button type="button" aria-label="Decrease quantity" disabled={quantity <= 1} onClick={() => onChange(quantity - 1)}>−</button><label><span>Quantity</span><input type="number" min="1" max={maximum} value={quantity} onChange={(event) => onChange(Math.max(1, Math.min(maximum, Number(event.target.value) || 1)))} /></label><button type="button" aria-label="Increase quantity" disabled={quantity >= maximum} onClick={() => onChange(quantity + 1)}>+</button></div></fieldset>;
}

const LEGACY_BASE_FALLBACK = ["Thin Crust", "Thick Crust", "Lightly Done", "Well Done", "Easy on the Sauce", "Extra Sauce"];

// Deals build each pizza with the same choices, in the same order, as a pizza
// ordered on its own — cheese, crust, bake & sauce, then toppings — and
// group them under a heading per pizza so a two-pizza deal reads as two pizzas.
export function GenericCustomizer({ product, toppings, halfToppingUnitsBps, onClose, onAdd, initialItem, onSave }: { product: CustomizerProduct; toppings: CustomizerTopping[]; halfToppingUnitsBps: number; onClose: () => void; onAdd: (line: BuiltItem) => void; initialItem?: BuiltItem; onSave?: (line: BuiltItem) => void }) {
  const dialogRef = useDialogBehavior<HTMLElement>(true, onClose);
  // Retired groups are dropped here, so they neither render nor consume a step
  // number. Deals seeded before halal was withdrawn still carry one in their
  // stored configuration; the server discards it on the way back in.
  const sections = useMemo(
    () => orderModifierSections(
      ((Array.isArray(product.configuration.sections) ? product.configuration.sections : []) as ModifierSection[])
        .filter((section) => !isRetiredSection(section)),
      Boolean(product.configuration.toppingsFirst),
    ),
    [product.configuration],
  );
  const [selected, setSelected] = useState<Record<string, ModifierSelection["values"]>>(() => {
    const initial: Record<string, ModifierSelection["values"]> = {};
    for (const section of sections) {
      if (section.source === "cheese") initial[section.id] = [{ value: DEFAULT_CHEESE_OPTION, label: DEFAULT_CHEESE_OPTION }];
      if (section.source === "crust") {
        const options = section.options?.length ? section.options : [...CRUST_OPTIONS];
        const value = options.includes(DEFAULT_CRUST_OPTION) ? DEFAULT_CRUST_OPTION : options[0];
        if (value) initial[section.id] = [{ value, label: value }];
      }
      if (section.source === "sauce" || section.source === "pizza_extras") {
        initial[section.id] = defaultSectionValues(section).map((value) => ({ value, label: value }));
      }
    }
    if (initialItem) {
      for (const section of sections) {
        const values = initialItem.modifiers?.find((modifier) => modifier.id === section.id)?.values ?? [];
        initial[section.id] = section.source === "toppings"
          ? normalizeModifierValues(values).map((entry) => ({ ...entry, label: values.find((value) => value.value === entry.value)?.label ?? entry.value }))
          : values;
      }
    }
    return initial;
  });
  const [instructions, setInstructions] = useState(initialItem?.specialInstructions ?? "");
  const quantitySelectable = Boolean(product.configuration.quantitySelectable) || Boolean(initialItem) || product.product_type === "simple";
  const maximumQuantity = Math.max(1, Math.min(99, Number(product.configuration.maxQuantity) || 99));
  const unitLabel = String(product.configuration.unitLabel ?? "item");
  const [quantity, setQuantity] = useState(initialItem?.quantity ?? 1);
  const optionsFor = (section: ModifierSection): Array<{ value: string; label: string }> => {
    if (section.source === "toppings") return toppings.map((entry) => ({ value: entry.id, label: entry.name }));
    if (section.source === "sauce") return SAUCE_OPTIONS.map((entry) => ({ value: entry, label: entry }));
    if (section.source === "pizza_extras") return PIZZA_EXTRA_OPTIONS.map((entry) => ({ value: entry, label: entry }));
    const configured = section.options?.length ? section.options : (
      section.source === "wing_flavours" ? [...WING_FLAVOURS]
        : section.source === "drinks" ? [...DRINK_OPTIONS]
          : section.source === "two_litre_drinks" ? [...TWO_LITRE_DRINK_OPTIONS]
            : section.source === "cheese" ? [...CHEESE_OPTIONS]
              : section.source === "crust" ? [...CRUST_OPTIONS]
                : section.source === "bake_sauce" ? [...BAKE_SAUCE_OPTIONS]
                  : LEGACY_BASE_FALLBACK
    );
    return configured.map((entry) => ({ value: entry, label: entry }));
  };
  const valuesOf = (sectionId: string) => selected[sectionId] ?? [];
  const toggle = (section: ModifierSection, option: { value: string; label: string }) => setSelected((current) => {
    const values = current[section.id] ?? [];
    // One sauce per pizza, and always one: tapping the chosen sauce keeps it.
    if (section.source === "sauce") return { ...current, [section.id]: [{ value: option.value, label: option.label }] };
    if (values.some((entry) => entry.value === option.value)) {
      return { ...current, [section.id]: values.filter((entry) => entry.value !== option.value) };
    }
    const next = { value: option.value, label: option.label, placement: section.source === "toppings" ? ("whole" as ToppingPlacement) : undefined };
    if (section.max === 1) return { ...current, [section.id]: [next] };
    if (values.length >= section.max) return current;
    return { ...current, [section.id]: [...values, next] };
  });
  const setPlacement = (sectionId: string, value: string, placement: ToppingPlacement) => setSelected((current) => ({
    ...current,
    [sectionId]: (current[sectionId] ?? []).map((entry) => entry.value === value ? { ...entry, placement } : entry),
  }));
  const unitsFor = (section: ModifierSection) =>
    modifierUnitsBps(normalizeModifierValues(valuesOf(section.id).map((entry) => ({ value: entry.value, placement: entry.placement }))), halfToppingUnitsBps);
  const valid = sections.every((section) => valuesOf(section.id).length >= section.min && valuesOf(section.id).length <= section.max);
  const pricing = priceModifierSelections(sections, sections.map((section) => ({ id: section.id, values: valuesOf(section.id) })), halfToppingUnitsBps);
  const extras = pricing.extraCents;
  const drinkPools = includedDrinkPools(sections);
  const pooledIds = new Set(drinkPools.flatMap((slots) => slots.map((slot) => slot.id)));
  const modifiers: ModifierSelection[] = sections
    .map((section) => ({ id: section.id, label: section.group ? `${section.group} · ${section.label}` : section.label, values: valuesOf(section.id) }))
    .filter((section) => section.values.length);
  // Step numbers and per-pizza headings are derived up front so nothing is mutated
  // while rendering.
  const layout = sections.map((section, index) => ({
    section,
    step: index + 1,
    groupHeading: section.group && section.group !== sections[index - 1]?.group ? section.group : null,
    // The "new" callout once per deal, on its first sauce and first extras step.
    // Saying it again for Pizza 2 tells nobody anything.
    firstOfItsKind: !sections.slice(0, index).some((earlier) => earlier.source === section.source),
  }));
  return (
    <div className="modal-backdrop modal-backdrop--right" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="customizer" role="dialog" aria-modal="true" aria-labelledby="bundle-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <div className="customizer-head"><div><p className="eyebrow dark"><span /> Complete your choices</p><h2 id="bundle-title">{product.name}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="customizer-body">
          {quantitySelectable ? <fieldset className="quantity-choice"><legend>How many {unitLabel}s?</legend><p>This item is priced at {formatMoney(product.base_price_cents)} per {unitLabel}.</p><div><button type="button" aria-label={`Remove one ${unitLabel}`} disabled={quantity <= 1} onClick={() => setQuantity((current) => Math.max(1, current - 1))}>−</button><label><span>Quantity</span><input type="number" min="1" max={maximumQuantity} inputMode="numeric" value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(maximumQuantity, Number(event.target.value) || 1)))} /></label><button type="button" aria-label={`Add one ${unitLabel}`} disabled={quantity >= maximumQuantity} onClick={() => setQuantity((current) => Math.min(maximumQuantity, current + 1))}>+</button></div><small>Up to {maximumQuantity} {unitLabel}s per order.</small></fieldset> : null}
          {layout.map(({ section, step, groupHeading, firstOfItsKind }) => {
            if (pooledIds.has(section.id)) {
              const slots = drinkPools.find((pool) => pool[0].id === section.id);
              if (!slots) return null;
              const allValues = slots.flatMap((slot) => valuesOf(slot.id));
              return <fieldset key={section.id} className="drink-quantities"><legend><span>{step}</span> Included canned drinks</legend><p role="status">{allValues.length} of {slots.length} drinks selected</p>{optionsFor(section).map((option) => {
                const count = allValues.filter((value) => value.value === option.value).length;
                return <div className="drink-quantity" key={option.value}><strong>{option.label}</strong><button type="button" disabled={!count} aria-label={`Remove one ${option.label}`} onClick={() => setSelected((current) => changeDrinkQuantity(slots, current, option.value, -1))}>−</button><output aria-label={`${option.label} quantity`}>{count}</output><button type="button" disabled={allValues.length >= slots.length} aria-label={`Add one ${option.label}`} onClick={() => setSelected((current) => changeDrinkQuantity(slots, current, option.value, 1))}>+</button></div>;
              })}</fieldset>;
            }
            const values = valuesOf(section.id);
            const included = section.sharedGroup ? section.sharedIncluded ?? 0 : section.included ?? 0;
            const isToppings = section.source === "toppings";
            const isFinish = section.source === "sauce" || section.source === "pizza_extras";
            const units = isToppings ? unitsFor(section) / 10_000 : values.length;
            const pool = section.sharedGroup ? pricing.pools[section.sharedGroup] : null;
            const sectionExtras = pool?.extraCents ?? pricing.sections.find((entry) => entry.id === section.id)?.extraCents ?? 0;
            const displayedUnits = pool ? pool.unitsBps / 10_000 : units;
            return <div key={section.id}>
              {groupHeading ? <h3 className="section-group">{groupHeading}</h3> : null}
              <fieldset>
                <legend><span>{step}</span> {section.label}{section.source === "sauce" && firstOfItsKind ? <em className="new-badge">New sauces</em> : null}</legend>
                {isToppings ? <div className="setup-alert"><strong>{section.sharedGroup ? `${included} toppings shared across this deal` : `${included} toppings included in this price`}</strong><p>Each additional topping is {formatMoney(section.extraPriceCents ?? 0)}. A topping on half counts as {halfToppingUnitsBps === 10_000 ? "a full topping" : `${halfToppingUnitsBps / 10_000} of a topping`}.</p></div>
                    : section.extraPriceCents ? <div className="setup-alert"><strong>Optional add-on</strong><p>This choice adds {formatMoney(section.extraPriceCents)}.</p></div> : null}
                {isFinish
                  ? <FinishChoices section={section} values={values.map((entry) => entry.value)} showCallout={firstOfItsKind} onToggle={(option) => toggle(section, { value: option, label: option })} />
                  : isToppings
                  ? <ToppingPicker
                      toppings={toppings}
                      selected={values.map((entry) => ({ toppingId: entry.value, placement: entry.placement ?? "whole", name: entry.label }))}
                      allowPlacement={section.max > 1}
                      onToggle={(topping) => toggle(section, { value: topping.id, label: topping.name })}
                      onPlacement={(toppingId, placement) => setPlacement(section.id, toppingId, placement)}
                    />
                  : <div className="topping-grid">{optionsFor(section).map((option) => { const active = values.some((entry) => entry.value === option.value); const price = section.optionPrices?.[option.value]; return <button className={active ? "active" : ""} type="button" key={option.value} aria-pressed={active} onClick={() => toggle(section, option)}><span>{active ? "✓" : "+"}</span>{option.label}{price ? <small>+{formatMoney(price)}</small> : null}</button>; })}</div>}
                <div className="allowance-meter"><span>{isToppings ? `${formatUnits(displayedUnits)} units selected · ${included} included${pool ? " across this deal" : ""}` : `${values.length} selected`}</span><b>{sectionExtras ? `${formatMoney(sectionExtras)} in extras` : isFinish ? (section.source === "sauce" ? "No charge" : "Optional") : section.min && values.length < section.min ? `Choose at least ${section.min}` : included ? `${included} included` : `Up to ${section.max}`}</b></div>
              </fieldset>
            </div>;
          })}
          <label className="instructions-label">Special instructions <small>Use this for requests the selectors do not cover.</small><textarea value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} /></label>
        </div>
        <div className="customizer-footer"><div><small>{quantitySelectable ? `${quantity} ${unitLabel}${quantity === 1 ? "" : "s"} · ${formatMoney(product.base_price_cents)} each` : "Your item"}</small><strong>{formatMoney((product.base_price_cents + extras) * quantity)}</strong></div><button className="primary-button" disabled={!valid} onClick={() => (onSave ?? onAdd)({ ...initialItem, key: initialItem?.key ?? crypto.randomUUID(), productId: product.id, name: product.name, categoryId: product.category_id, quantity, unitPriceCents: product.base_price_cents + extras, taxable: Boolean(product.taxable), modifiers, modifierSections: sections, freeDelivery: Boolean(product.configuration.freeDelivery), specialInstructions: instructions.trim() })}>{initialItem ? "Save changes" : "Add to order"} <ArrowIcon /></button>{initialItem ? <button className="staff-button" onClick={onClose}>Cancel</button> : null}</div>
      </section>
    </div>
  );
}
