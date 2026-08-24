import PolicyPage from "@/app/policy/PolicyPage";

export const metadata = { title: "Cancellation & Refund Policy" };

/**
 * The policy the checkout acknowledgement links to.
 *
 * Written to match what the software actually does, which is the only way a
 * policy is useful: it promises a five-minute window because
 * `operations.cancellationRequestWindowMinutes` is five, it says refunds go back
 * to the original card because that is what happens in the Clover dashboard, and
 * it does not promise a self-serve cancel button because there is not one.
 *
 * A policy that describes a system nobody built is worse than none — it is the
 * document a customer quotes back when the thing it promised does not happen.
 */
export default function CancellationPage() {
  return (
    <PolicyPage
      eyebrow="Cancellation & refunds"
      title="Call us right away."
      intro="Food starts being made within minutes, so the sooner you call, the more we can do."
    >
      <h2>Cancelling an order</h2>
      <p>
        Call Pizza 62 at{" "}
        <a href="tel:+19055475777">
          <strong>(905) 547-5777</strong>
        </a>{" "}
        as soon as possible, and have your order number ready. If preparation has not started — usually within
        about five minutes of ordering — we can cancel it and refund you in full.
      </p>
      <p>
        Once your food is being made we cannot cancel it, because the ingredients have been used. This is also
        why the website has no cancel button: whether an order can still be stopped is something only the
        kitchen knows, and a button that sometimes worked would be worse than a phone call that always gets you
        an answer.
      </p>

      <h2>Something wrong with your order</h2>
      <p>
        Call us the same day with your order number. If an item is missing, incorrect, or not what it should
        be, we will put it right — a replacement, a credit against a future order, or a refund, whichever suits
        you. We would rather hear about it than have you not come back.
      </p>

      <h2>Refunds</h2>
      <p>
        A refund goes back to the card you paid with. We issue it the same day we agree it; how long it takes
        to appear is up to your bank, and is usually three to five business days. We cannot refund to a
        different card or send it by any other route — that is a rule of the card networks, not ours.
      </p>
      <p>Orders paid at the store are refunded at the store, in the same way you paid.</p>

      <h2>If we cannot fulfil your order</h2>
      <p>
        Occasionally something sells out, an address turns out to be beyond our delivery area, or we have to
        close unexpectedly. If that happens after you have paid, we will call you and refund you in full. You
        are never charged for food we cannot make.
      </p>

      <h2>Delivery</h2>
      <p>
        Delivery orders have a minimum of $20 before tax, and we deliver within about 10 km of the restaurant.
        Both are checked before you pay, so you will not be charged for an order we cannot deliver.
      </p>
      <p>
        If nobody is there when the driver arrives, we will call the number on the order. If we cannot reach
        you, the food is brought back to the restaurant and can be collected — we cannot refund an order that
        was made and delivered as asked.
      </p>

      <h2>Scheduled orders</h2>
      <p>
        An order placed for a later time can be cancelled free of charge up to an hour before the time you
        chose. Call us, and have your order number ready.
      </p>

      <h2>Talking to us</h2>
      <p>
        Everything above is handled by phone on{" "}
        <a href="tel:+19055475777">
          <strong>(905) 547-5777</strong>
        </a>
        , during opening hours. We would always rather sort a problem out than have you leave unhappy, so if
        something is not covered here, call and ask.
      </p>
    </PolicyPage>
  );
}
