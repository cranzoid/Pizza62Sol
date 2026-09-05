import type { CustomizerProduct, CustomizerTopping, CustomizerVariation } from "@/app/menu/ItemCustomizer";
import type { StoreClosure } from "@/lib/domain";

export type Category = { id: string; name: string; slug: string; description?: string | null };
export type Product = CustomizerProduct & {
  image_url?: string | null;
  pickup_eligible: number;
  delivery_eligible: number;
};
export type Variation = CustomizerVariation;
export type Topping = CustomizerTopping;

export type PublicCatalog = {
  categories: Category[];
  products: Product[];
  variations: Variation[];
  toppings: Topping[];
  settings: Record<string, { value: Record<string, unknown>; version: number }>;
  closures: StoreClosure[];
  integrations: {
    clover: boolean;
    email: boolean;
    cloverIframe?: { enabled: boolean; publicToken?: string; merchantId?: string; sandbox?: boolean };
  };
};
