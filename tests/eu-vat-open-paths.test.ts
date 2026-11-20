/**
 * EU VAT art. 9a, 789 [IV1] unit 1 (D, E): two paths of REFUSE_CONSUMERS_OPEN shown not to need a gate of their own.
 *
 * (D) The sales blocks of a page and the card a creator embeds on their own site take no payment themselves: every form
 *     they draw that can charge posts to /api/store/checkout, which asks consumerGate before Stripe (held by
 *     tests/eu-vat-checkout-routes.test.ts); the others sign up or send a form, and charge nothing.
 * (E) A call and a package of calls are a service a person gives live, outside art. 9a (Implementing Regulation
 *     282/2011 art. 7(1); TX point 13): consumerGate lets them go on wherever the buyer is, by its reviewed design, and
 *     the call checkout (lib/calls.ts) carries the call alone, so nothing electronic rides on it. A bundle that holds a
 *     download beside a call is still refused.
 *
 * Synthetic only: nothing real is reached.
 */
import { readFileSync } from "node:fs";
import { consumerGate } from "@/lib/eu-vat-gate";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";
import { REFUSE_CONSUMERS_DRAFTS, REFUSE_CONSUMERS_OPEN } from "@/lib/deemed-supplier-drafts";
import { done, is, part } from "./check";

/** The routes a form may post to without asking the gate: none of them charges. */
const NO_CHARGE = new Set(["/api/store/form", "/api/store/join"]);
/** The routes that charge, each asking consumerGate before Stripe. */
const GATED = new Set(["/api/store/checkout"]);

const actions = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/action="(\/api\/[^"?]+)/g)].map((m) => m[1]);

const blank: EuSupplyFields = { priceCents: 5000, file: null, link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const eu = () => {
  const headers = new Headers({ "x-vercel-ip-country": "DE" });
  const form = new URLSearchParams({ billing_country: "DE" });
  return { headers, form };
};

function main(): void {
  part("(D) Sales blocks and the embedded card: every paying form posts to a gated route");
  for (const file of ["components/sales-blocks.tsx", "app/embed/[handle]/[product]/page.tsx"]) {
    const found = actions(file);
    is(`${file}: draws forms`, found.length > 0, true);
    const loose = found.filter((action) => !GATED.has(action) && !NO_CHARGE.has(action));
    is(`${file}: every form posts to a gated route or charges nothing`, loose, []);
    is(`${file}: its buy form posts to the card checkout`, found.includes("/api/store/checkout"), true);
  }

  part("(E) A live call and a package of calls go on; a download beside a call does not");
  const call: EuSupplyFields = { ...blank, call: { minutes: 30 } };
  const pack: EuSupplyFields = { ...blank, callPackage: { sessions: 4 } };
  const download: EuSupplyFields = { ...blank, file: { name: "guide.pdf" } };
  is("a call, from the EU: goes on", consumerGate({ product: call, ...eu() }).ok, true);
  is("a package of calls, from the EU: goes on", consumerGate({ product: pack, ...eu() }).ok, true);
  const bundle: EuSupplyFields = { ...blank, bundle: ["c", "d"] };
  const members = new Map<string, EuSupplyFields>([["c", call], ["d", download]]);
  is("a bundle of a call and a download, from the EU: refused", consumerGate({ product: bundle, members, ...eu() }).ok, false);
  is("a call with a download ticked beside it, from the EU: refused", consumerGate({ product: call, boxes: [{ product: download }], ...eu() }).ok, false);
  const calls = readFileSync("lib/calls.ts", "utf8");
  is("the call checkout carries one line, the call itself", [calls.includes('"line_items[0][price_data][unit_amount]"'), /line_items\[[1-9]\]/.test(calls)], [true, false]);

  part("The refuse-consumers drafts");
  is("sales blocks and the embedded card are no longer listed as open", REFUSE_CONSUMERS_OPEN.some((line) => line.startsWith("sales blocks")), false);
  is("calls are no longer listed as open", REFUSE_CONSUMERS_OPEN.some((line) => line.startsWith("call bookings")), false);
  // Unit C entered with #4921 (offerGate) and 790 [IV2] unit 2 with #4943 (the address and the card's country): the
  // one-click offer asks the gate on the offered product before anything is charged, so no path is left open.
  is("RED: the one-click offer is no longer listed as open", REFUSE_CONSUMERS_OPEN.some((line) => line.startsWith("the one-click offer")), false);
  is("RED: no path is left open", REFUSE_CONSUMERS_OPEN, []);
  const upsell = readFileSync("lib/upsell.ts", "utf8");
  is("the offer asks the gate before it charges (takeUpsell, funnelView)", (upsell.match(/offerGate\(target, /g) ?? []).length, 2);
  for (const draft of REFUSE_CONSUMERS_DRAFTS) is(`${draft.jurisdiction}: this test is named`, draft.evidence.includes("tests/eu-vat-open-paths.test.ts"), true);

  done();
}

main();
