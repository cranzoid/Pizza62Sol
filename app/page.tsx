import type { Metadata } from "next";
import CustomerApp from "./customer/CustomerApp";
import { loadPublicCatalog } from "@/lib/public-catalog";
import { restaurantStructuredData, serializeJsonLd } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

// The title and description still come from the owner's website editor through
// the root layout. This page adds only its self-referencing canonical URL.
export default async function Home() {
  const catalog = await loadPublicCatalog().catch(() => null);
  const structuredData = restaurantStructuredData(catalog ?? {}, process.env.PUBLIC_BASE_URL);
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }} />
    <CustomerApp initialCatalog={catalog} />
  </>;
}
