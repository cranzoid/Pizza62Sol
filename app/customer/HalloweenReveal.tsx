"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Product } from "@/lib/catalog-types";
import { formatMoney } from "@/lib/domain";

type Stage = "teaser" | "opening" | "revealed";

// How long the pumpkin takes to burst before the offer replaces it. Matches the
// hw-burst and hw-pumpkin-pop keyframes in globals.css.
const OPENING_MS = 950;

// Fixed, not random: the server and client render the same pieces.
const CANDY = [
  [6, 0, -40, "#ffb467"], [14, 120, 25, "#c58cff"], [23, 40, 70, "#8fd16a"], [31, 200, -15, "#fff4df"],
  [40, 80, 50, "#ff7a3d"], [48, 260, -60, "#ffb467"], [57, 20, 35, "#c58cff"], [65, 170, -30, "#8fd16a"],
  [73, 60, 80, "#ff7a3d"], [81, 230, -45, "#fff4df"], [89, 110, 20, "#ffb467"], [95, 300, -70, "#c58cff"],
] as const;

function Pumpkin({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 160 140" aria-hidden="true" focusable="false">
    <path d="M78 30q-3-18 10-26l9 7q-11 7-9 19" fill="#88a465" stroke="#171321" strokeWidth="4" strokeLinejoin="round" />
    <ellipse cx="52" cy="82" rx="40" ry="50" fill="#e0661a" stroke="#171321" strokeWidth="4" />
    <ellipse cx="108" cy="82" rx="40" ry="50" fill="#e0661a" stroke="#171321" strokeWidth="4" />
    <ellipse cx="80" cy="82" rx="38" ry="54" fill="#ff8f2e" stroke="#171321" strokeWidth="4" />
    <g className="hw-pumpkin__face" fill="#ffd36b" stroke="#171321" strokeWidth="3" strokeLinejoin="round">
      <path d="m42 70 20-18 7 24z" />
      <path d="m118 70-20-18-7 24z" />
      <path d="m74 86 6-11 6 11z" />
      <path d="M40 98q40 12 80 0-6 28-40 28T40 98zm16 8 6 8 6-6m24 0 6 6 6-8" />
    </g>
  </svg>;
}

function Ghost({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 120 130" aria-hidden="true" focusable="false">
    <path d="M14 122V56a46 46 0 0 1 92 0v66l-15-11-15 11-15-11-16 11-15-11z" fill="#fff8ec" stroke="#171321" strokeWidth="4" strokeLinejoin="round" />
    <ellipse cx="45" cy="58" rx="8" ry="11" fill="#171321" />
    <ellipse cx="75" cy="58" rx="8" ry="11" fill="#171321" />
    <ellipse cx="60" cy="84" rx="9" ry="11" fill="#171321" />
    <path d="M14 76q-12 4-12-10M106 76q12 4 12-10" fill="none" stroke="#171321" strokeWidth="4" strokeLinecap="round" />
  </svg>;
}

function Bat({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 60 28" aria-hidden="true" focusable="false">
    <path d="M30 9c-2-4-4-4-5 0-7-8-17-9-25-4 6 2 9 7 8 12 5-3 10-2 13 3 2-3 5-5 9-5s7 2 9 5c3-5 8-6 13-3-1-5 2-10 8-12-8-5-18-4-25 4-1-4-3-4-5 0z" fill="#171321" />
  </svg>;
}

/**
 * The Halloween special as a two-step reveal: a pumpkin and a ghost tease the
 * offer, and the customer chooses to open it. The surrounding dialog — focus
 * trap, Escape, close button — still belongs to CustomerApp.
 */
export function HalloweenReveal({ offer, otherSpecials, businessName, pickupEnabled, deliveryEnabled, onChoose }: {
  offer: Product;
  otherSpecials: Product[];
  businessName: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  onChoose: (product: Product, method?: "pickup" | "delivery") => void;
}) {
  const [stage, setStage] = useState<Stage>("teaser");
  const timer = useRef<number | undefined>(undefined);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The reveal button disappears with the teaser, so focus follows the offer.
  useEffect(() => { if (stage === "revealed") firstAction.current?.focus(); }, [stage]);

  const reveal = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage("revealed");
      return;
    }
    setStage("opening");
    timer.current = window.setTimeout(() => setStage("revealed"), OPENING_MS);
  };

  const price = formatMoney(offer.base_price_cents).replace(".00", "");
  const maxQuantity = Number(offer.configuration.maxQuantity ?? 0);
  const canPickup = pickupEnabled && offer.pickup_eligible;
  const canDeliver = deliveryEnabled && offer.delivery_eligible;
  const how = canPickup && canDeliver ? "pickup or delivery" : canPickup ? "pickup only" : "delivery only";

  if (stage !== "revealed") {
    return <div className={`hw-teaser${stage === "opening" ? " hw-teaser--opening" : ""}`}>
      <div className="hw-scene" aria-hidden="true">
        <span className="hw-moon" />
        <Bat className="hw-bat hw-bat--one" />
        <Bat className="hw-bat hw-bat--two" />
        <Bat className="hw-bat hw-bat--three" />
        <Ghost className="hw-ghost" />
        <Pumpkin className="hw-pumpkin" />
        <span className="hw-burst" />
      </div>
      <p className="hw-kicker">Halloween at {businessName}</p>
      <h2 id="special-title">Something&apos;s hiding<br /><em>in our pumpkin.</em></h2>
      <p className="hw-teaser__lede">A Halloween treat, today only. Dare to take a peek?</p>
      <button type="button" className="hw-reveal-button" onClick={reveal} disabled={stage === "opening"}>
        {stage === "opening" ? "Opening…" : "Reveal the offer"}
      </button>
    </div>;
  }

  return <div className="hw-offer">
    <div className="hw-candy" aria-hidden="true">
      {CANDY.map(([left, delay, spin, colour], index) => <span key={index} style={{
        "--left": `${left}%`, "--delay": `${delay}ms`, "--spin": `${spin}deg`, "--colour": colour,
      } as CSSProperties} />)}
    </div>
    <div className="hw-offer__ticket" aria-hidden="true">
      <strong>{price}</strong>
      <span>per<br />wing</span>
    </div>
    <p className="hw-kicker">October 31 only · {how}</p>
    <h2 id="special-title">All treats.<br /><em>{price} wings.</em></h2>
    <p className="hw-offer__lede">Classic or breaded, tossed in your favourite sauce or dry rub. Your Halloween feast is sorted.</p>
    <ul className="hw-offer__facts">
      {maxQuantity ? <li>Up to {maxQuantity} wings</li> : null}
      <li>Classic or breaded</li>
      <li>Any sauce or dry rub</li>
    </ul>
    <div className="hw-offer__actions">
      {canPickup ? <button type="button" ref={firstAction} onClick={() => onChoose(offer, "pickup")}>Pickup wings <span aria-hidden="true">↗</span></button> : null}
      {canDeliver ? <button type="button" ref={canPickup ? undefined : firstAction} onClick={() => onChoose(offer, "delivery")}>Deliver wings <span aria-hidden="true">↗</span></button> : null}
    </div>
    <small className="hw-offer__fine">Plus tax · usual delivery minimum &amp; fee apply</small>
    {otherSpecials.length ? <div className="hw-offer__also">
      <b>Also on today</b>
      {otherSpecials.map((product) => <button type="button" key={product.id} onClick={() => onChoose(product)}>
        {product.name} · {formatMoney(product.base_price_cents)} <span aria-hidden="true">↗</span>
      </button>)}
    </div> : null}
  </div>;
}
