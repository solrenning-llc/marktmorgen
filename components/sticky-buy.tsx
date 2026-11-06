"use client";

import { useEffect, useState } from "react";

/**
 * The price and one button, held at the bottom of a phone's screen while a
 * product's page is read (app/[handle]/p/[product]/page.tsx).
 *
 * Measured before it was built (7 October 2026): Shopify's own themes,
 * Gumroad's product page and most course platforms keep a buy bar in view on
 * a phone; a Stan product page does not. On a long sales page the buy box is
 * a dozen screens down, and a reader who has decided should not have to go
 * and find it.
 *
 * It does nothing a page's own buttons do not: it is a link to the page's
 * own buy box (#buy, or #get for something free), where the buyer still
 * picks an option, a plan or a box at checkout. It steps out of the way while
 * that box is on screen, so the two are never shown at once, and it is not
 * drawn on a wide screen at all (app/globals.css, .st-sticky-buy). Without
 * JavaScript it simply stays, which is still a link to the right place.
 */
export function StickyBuy({ target, label, price }: { target: "buy" | "get"; label: string; price: React.ReactNode }) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const box = document.getElementById(target);
    if (!box || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver((entries) => setAway(entries.some((entry) => entry.isIntersecting)), {
      rootMargin: "0px 0px -20% 0px",
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, [target]);

  return (
    <div role="region" aria-label={label} className="st-sticky-buy" data-away={away ? "" : undefined} aria-hidden={away || undefined}>
      <div className="st-sticky-price">{price}</div>
      <a href={`#${target}`} className="btn st-btn st-sticky-go" tabIndex={away ? -1 : undefined}>
        {label}
      </a>
    </div>
  );
}
