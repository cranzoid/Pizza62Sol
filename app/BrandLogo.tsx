// The supplied Pizza 62 artwork, keyed to transparency in public/logo.png. It is
// drawn as a background image (not <img>) so the owner can swap the file or point
// `content.logoUrl` at an uploaded logo without any layout change, and so the dark
// staff surfaces can sit it on a light chip — the wordmark's green would otherwise
// disappear against the sidebar.
export const DEFAULT_LOGO_URL = "/logo.png";
export const DEFAULT_LOGO_MARK_URL = "/logo-mark.png";

export function BrandLogo({
  src,
  name = "Pizza 62",
  variant = "full",
  chip = false,
  className = "",
}: {
  src?: string | null;
  name?: string;
  variant?: "full" | "mark";
  chip?: boolean;
  className?: string;
}) {
  const url = src?.trim() || (variant === "mark" ? DEFAULT_LOGO_MARK_URL : DEFAULT_LOGO_URL);
  return (
    <span
      className={`brand-logo brand-logo--${variant} ${chip ? "brand-logo--chip" : ""} ${className}`.trim()}
      role="img"
      aria-label={name}
      style={{ backgroundImage: `url(${url})` }}
    />
  );
}
