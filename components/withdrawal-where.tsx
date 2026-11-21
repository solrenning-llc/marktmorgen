import { withdrawalWords } from "@/lib/buyer-words/withdrawal";

/**
 * One plain line at checkout saying that the online withdrawal function
 * exists and where it is: the pre-contract information of Directive
 * 2011/83/EU art. 6(1)(h) and Annex I as amended by Directive (EU) 2023/2673
 * (queue item 588 [KB9], unit 2; Claude 5's review of #2953). It names the
 * function by the label the buyer's purchases page shows (withdrawLink) and
 * holds its condition ("while you have that right"), so it never promises the
 * right where it does not exist.
 *
 * Drawn by the consent box (components/digital-consent-box.tsx), outside the
 * sentence the buyer checks, so it is not in that sentence's length, version
 * or fingerprint; and, where no box is drawn (a shipped item, a cart of
 * shipped items only), by the checkout form itself, in the box's place.
 * No hooks: it can be drawn on the server or in the browser.
 */
export function WithdrawalWhere({ lang, className = "" }: { lang: string; className?: string }) {
  return (
    <p className={`st-muted text-sm ${className}`} data-withdrawal-where="">
      {withdrawalWords(lang).checkoutWhere}
    </p>
  );
}
