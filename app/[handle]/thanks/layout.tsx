import { GiftTypedSweeper } from "@/components/gift-typed-sweeper";

/**
 * Around the thank-you page, whichever way it is drawn (an order paid with
 * Stripe or PayPal, a trial, a free order): back from paying, what a gift form
 * kept in this browser tab is not needed any more, so it is cleared
 * (components/gift-typed-sweeper.tsx; Privacy #gift-typed).
 */
export default function ThanksLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <GiftTypedSweeper all />
    </>
  );
}
