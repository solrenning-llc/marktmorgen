import type { IconName } from "@/components/icons";
import type { VisualKey } from "@/components/feature-visuals";

export const HOME_REASONS: {
  icon: IconName;
  title: string;
  body: string;
  example: string;
  visual: VisualKey;
  href: string;
  link: string;
}[] = [
  {
    icon: "bank",
    title: "The money lands in your Stripe",
    body: "Every sale is a direct charge on your own Stripe account. Payouts follow your schedule, and refunds and disputes live in your own dashboard.",
    example:
      "If you ever leave us, nothing moves: the account, the customers and the payout history were yours the whole time.",
    visual: "stripe",
    href: "/platform/your-stripe",
    link: "How the money moves",
  },
  {
    icon: "tag",
    title: "Several prices for one product",
    body: "One week for $27, five weeks for $39. Up to 50 options on any product, compared side by side, and each option delivers its own file.",
    example:
      "A week at one price, five weeks at another, the season at a third. The buyer picks; each one hands over its own file.",
    visual: "options",
    href: "/platform/price-options",
    link: "See price options",
  },
  {
    icon: "bolt",
    title: "Reliable access after payment",
    body: "A file downloads, a course opens, a booked call lands on both calendars — but only after we ask Stripe's own record whether the payment settled, and we ask again on every download. A link somebody guesses or forwards opens nothing. The confirmation email links back to the purchase when the buyer leaves checkout.",
    example:
      "A buyer on a new phone types the email address they paid with, and every purchase from that store comes back to them. That holds a month or a year later, for as long as the store is open and the product is still there.",
    visual: "delivery",
    href: "/platform/instant-delivery",
    link: "How delivery works",
  },
];


export const HOME_NOT_YET = [
  "Automatic replies on Instagram",
  "An iPhone app from the App Store",
  "Paying affiliates without a PayPal account of your own",
];
