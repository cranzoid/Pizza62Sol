import { DRINK_OPTIONS, type ModifierSection, type ToppingPlacement } from "@/lib/domain";

type Value = { value: string; label: string; placement?: ToppingPlacement };
type Selection = { id: string; values: Value[] };

/** Only identical, free, one-can slots can share a quantity picker. */
export function includedDrinkPools(sections: ModifierSection[]): ModifierSection[][] {
  const groups = new Map<string, ModifierSection[]>();
  for (const section of sections) {
    if (section.source !== "drinks" || section.min !== 1 || section.max !== 1 ||
      (section.included ?? 1) < 1 || section.extraPriceCents || Object.values(section.optionPrices ?? {}).some(Boolean)) continue;
    const signature = JSON.stringify([section.group ?? "", section.options?.length ? section.options : [...DRINK_OPTIONS]]);
    const group = groups.get(signature) ?? [];
    group.push(section);
    groups.set(signature, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Keep each existing slot id: the kitchen and legacy API still receive one can per slot. */
export function changeDrinkQuantity(
  slots: ModifierSection[],
  selected: Record<string, Value[]>,
  flavour: string,
  delta: -1 | 1,
): Record<string, Value[]> {
  const choices = slots.flatMap((slot) => selected[slot.id] ?? []);
  const allowed = slots[0]?.options?.length ? slots[0].options : [...DRINK_OPTIONS];
  if (!allowed.includes(flavour)) return selected;
  if (delta === 1) {
    if (choices.length >= slots.length) return selected;
    choices.push({ value: flavour, label: flavour });
  } else {
    const index = choices.findIndex((choice) => choice.value === flavour);
    if (index < 0) return selected;
    choices.splice(index, 1);
  }
  return { ...selected, ...Object.fromEntries(slots.map((slot, index) => [slot.id, choices[index] ? [choices[index]] : []])) };
}

/** Compact order display; underlying selections remain complete for preparation. */
export function drinkSummary(selections: Selection[], sections: ModifierSection[]): { ids: Set<string>; text: string }[] {
  return includedDrinkPools(sections).map((slots) => {
    const ids = new Set(slots.map((slot) => slot.id));
    const counts = new Map<string, number>();
    for (const selection of selections.filter((entry) => ids.has(entry.id))) {
      for (const value of selection.values) counts.set(value.label || value.value, (counts.get(value.label || value.value) ?? 0) + 1);
    }
    return { ids, text: [...counts].map(([label, count]) => `${label} ×${count}`).join(", ") };
  });
}
