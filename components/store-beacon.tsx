"use client";

import { useEffect } from "react";
import { startBrowserCheck } from "@/lib/browser-check-client";
import { countsAtPause } from "@/lib/quiet-moment";
import { sourceTag } from "@/lib/source-rules";

// One count per page load, however many times React runs the effect, each at the buyer's first pause
// (lib/quiet-moment.ts). One still waiting when the buyer moves inside the store goes at the next pause, never dropped.
const countOnce = countsAtPause();

// The host's browser check answers for every count this page sends but a link's (lib/bot-check.ts, browserProof). It
// is set up once for the whole window, with the sign-in form's route too (lib/browser-check-client.ts): a second
// initBotId in one window never gets the host's challenge, and its requests never settle.
function beacon(payload: Record<string, string>) {
  const body = JSON.stringify(payload);
  if (payload.k === "l") {
    // A link's count needs no check (app/api/store/hit), so it goes by sendBeacon, which outlives the page being
    // left, and never waits on the challenge; with no sendBeacon, by the fetch from before the check wrapped it.
    const queued = typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/store/hit", new Blob([body], { type: "text/plain" }));
    if (!queued) (startBrowserCheck() ?? fetch)("/api/store/hit", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
    return;
  }
  startBrowserCheck();
  const send = (via: typeof fetch) => via("/api/store/hit", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } });
  // A visit, a page or a funnel step goes by fetch, which the check signs. Without the check it counts as nothing
  // (app/api/store/hit), so it is never sent again unsigned: that would only cost a request.
  send(fetch).catch(() => {});
}

/**
 * Tells the store it was opened, and which of its links are followed.
 *
 * No cookie and nothing kept in the browser: the page sends where the visitor
 * came from — the referring site, or the utm_source, utm_medium and
 * utm_campaign tags on the creator's own link — and the server does the rest.
 *
 * On a page of the store other than its front one (`front` false), it says
 * only that the page was opened, so that somebody who arrives by a link
 * straight to a product is a visit too.
 *
 * The count goes at the buyer's first pause (lib/quiet-moment.ts): the page
 * loaded and two seconds without a tap or a key, or the page hidden. Its check
 * runs the host's script in one long block, which on a slow phone used to
 * hold the buyer's first tap past 200 ms.
 */
export function StoreBeacon({ handle, front = true, product = "" }: { handle: string; front?: boolean; product?: string }) {
  useEffect(() => {
    const key = `${handle}|${location.href}`;
    // Where the visitor came from is read as the page opens, not when the count goes: a move inside the store before
    // then (its next page, say) changes the address, never the visit's source.
    const query = new URLSearchParams(location.search);
    const tag = (name: string) => (query.get(name) ?? "").slice(0, 60);
    const payload: Record<string, string> = front
      ? { h: handle, k: "v", r: document.referrer.slice(0, 500), u: sourceTag(query), m: tag("utm_medium"), g: tag("utm_campaign") }
      : // Any other page of the store: only that somebody came (lib/traffic.ts),
        // and on a product's own page, which product: what its sales are measured against.
        product
        ? { h: handle, k: "p", p: product }
        : { h: handle, k: "p" };
    // The count goes through the host's check, whose script is one long block of work: it waits for a pause in what
    // the buyer is doing (lib/quiet-moment.ts), so it never lands on a tap. Leaving this page for another of the
    // store's (a next/link card, the pager) does not drop it: it goes at the next pause, with the source read here.
    countOnce(key, () => beacon(payload));
    // Which links are followed is counted on the front page, where they are.
    if (!front) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[data-link]") : null;
      const id = target?.getAttribute("data-link");
      if (id) beacon({ h: handle, k: "l", id });
    };
    // Middle clicks open links too.
    document.addEventListener("click", onClick);
    document.addEventListener("auxclick", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("auxclick", onClick);
    };
  }, [handle, front, product]);
  return null;
}

/**
 * Tells a funnel of pages that one of its steps was opened (lib/page-funnel.ts):
 * which funnel, from the mark in the address, and which page or product this
 * is. The server works out the step, counts each person once, and never the
 * store's own people.
 */
export function FunnelBeacon({ handle, funnel, kind, id }: { handle: string; funnel: string; kind: "page" | "product"; id: string }) {
  useEffect(() => {
    // Checked like a visit, so it waits for the same pause (lib/quiet-moment.ts), and a move to the funnel's next
    // step before it does not drop it.
    countOnce(`${handle}|${location.href}|funnel`, () =>
      beacon({ h: handle, k: "f", f: funnel, t: kind === "page" ? "g" : "p", id }),
    );
  }, [handle, funnel, kind, id]);
  return null;
}
