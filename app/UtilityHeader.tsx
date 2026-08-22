import { BrandLogo } from "@/app/BrandLogo";
import Link from "next/link";

/**
 * Shared public header for tracking, feedback, payment-return and policy pages.
 * Keeping this in one place prevents the secondary pages from drifting away
 * from the storefront's real wordmark and mobile spacing.
 */
export function UtilityHeader({ backLabel = "Back to menu" }: { backLabel?: string }) {
  return (
    <header className="utility-header">
      <Link className="brand" href="/" aria-label="Pizza 62 home">
        <BrandLogo name="Pizza 62" />
        <span className="brand-copy"><small>Hamilton, Ontario</small></span>
      </Link>
      <Link href="/">{backLabel} <span aria-hidden="true">↗</span></Link>
    </header>
  );
}
