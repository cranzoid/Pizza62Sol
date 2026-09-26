import type { Metadata } from "next";
import Link from "next/link";
import PolicyPage from "@/app/policy/PolicyPage";
import { lastEntryDayLabel, minimumLabel } from "@/lib/giveaway";
import { loadGiveawayNow } from "@/lib/giveaway-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thanksgiving Giveaway · Pizza 62 turns one",
  description: "Pizza 62 is one year old. Every order of $10 or more before tax is an entry to win a brand-new 55-inch TV.",
  alternates: { canonical: "/giveaway" },
};

/**
 * How the giveaway works, in full.
 *
 * Every email and the storefront strip link here, so this is where "why is
 * this happening and what do I have to do" is answered once, properly. It is
 * read from the same setting the checkout enforces, so the minimum, the
 * closing day and the prize here are always the ones actually in force.
 *
 * Says "giveaway" and never "draw" — the owner's wording, and a deliberate one.
 */
export default async function GiveawayPage() {
  const { giveaway, status } = await loadGiveawayNow().catch(() => ({ giveaway: null, status: "off" as const }));

  if (!giveaway || status === "off") {
    return (
      <PolicyPage eyebrow="Pizza 62" title="No giveaway right now." intro="Keep an eye on our emails and the menu for the next one.">
        <p>
          <Link href="/">Back to the menu</Link>
        </p>
      </PolicyPage>
    );
  }

  const minimum = minimumLabel(giveaway);
  const lastDay = lastEntryDayLabel(giveaway);
  const started = new Date(giveaway.startsAt).toLocaleDateString("en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Toronto",
  });

  return (
    <PolicyPage
      eyebrow="Pizza 62 turns one"
      title={status === "closed" ? "Entries are closed." : `Win ${giveaway.prize}.`}
      intro={
        status === "closed"
          ? `Thank you to everyone who entered our ${giveaway.title}. The winner is announced ${giveaway.winnerAnnouncedOn}.`
          : `Pizza 62 is one year old, and this Thanksgiving we're saying thank you with ${giveaway.prize}.`
      }
    >
      <h2>Why we&apos;re doing this</h2>
      <p>
        Pizza 62 turned one this year. Thank you for every order, every phone call and every visit to the counter
        on Parkdale Avenue — our {giveaway.title} is our way of celebrating the first year with the people who made it.
      </p>

      <h2>How to enter</h2>
      <ul>
        <li>
          Place an order of <strong>{minimum} or more before tax</strong> between {started} and closing time on{" "}
          <strong>{lastDay}</strong>.
        </li>
        <li>Online, by phone or at the counter — pickup and delivery both count.</li>
        <li>
          <strong>Every qualifying order is one entry</strong>, with its own entry number. Order again, and you have
          another entry.
        </li>
        <li>
          The {minimum} is measured on your food after any promo code, before HST, the delivery fee and the tip.
          Paying with a Pizza 62 gift card counts.
        </li>
      </ul>

      <h2>Your entry number</h2>
      <p>
        It is on your order confirmation email, and we send a separate &ldquo;You&apos;re in&rdquo; email with it
        too. Ordering at the counter without an email? Ask us for your entry number — it is printed on your ticket.
      </p>

      <h2>The winner</h2>
      <ul>
        <li>The winning entry is chosen at random from every eligible entry, {giveaway.winnerAnnouncedOn}.</li>
        <li>We&apos;ll contact the winner using the phone number or email on their order.</li>
        <li>Orders that are cancelled or refunded are not eligible.</li>
      </ul>

      <h2>Questions?</h2>
      <p>
        Call us at{" "}
        <a href="tel:+19055475777">
          <strong>(905) 547-5777</strong>
        </a>
        .
      </p>

      {status === "open" ? (
        <p>
          <Link className="primary-button" href="/#menu">
            Order now
          </Link>
        </p>
      ) : null}
    </PolicyPage>
  );
}
