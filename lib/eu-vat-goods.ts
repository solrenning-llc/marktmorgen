/**
 * EU VAT, part 2 of the build, unit 9a: goods shipped to an EU address (docs/eu-vat-article-9a.md, "The code that
 * would be needed", point 8; question 27); since 789 [IV1] unit 1, goods shipped to the UK VAT area too. Pure and
 * browser-safe.
 *
 * Directive 2006/112/EC art. 14a deems an electronic interface that facilitates a supply of goods within the EU by a
 * seller not established there (or an import in consignments up to EUR 150) to have received and supplied them. The
 * United Kingdom's rules make an online marketplace liable in the same way for goods an overseas seller sells to a UK
 * consumer (imports up to GBP 135, and goods already in the UK; AGENTS.md IV (b)). Neither treatment is built. So,
 * until each is, a physical product is not shipped to any place where the checkout refuses a consumer
 * (REFUSED_PLACES, lib/eu-vat-supply.ts: the Member States, the EU's outermost regions and Åland, Monaco, GB and IM),
 * nor to a territory whose VAT treatment the code cannot settle by its code (TERRITORY_UNSETTLED). It is the same set
 * as lib/eu-vat-gate.ts consumerGate refuses, whatever the creator's own account: a buyer billed in the US cannot
 * have the goods sent to Germany or Great Britain instead. lib/physical-legal-ship.ts (shippingNow) applies it, so the
 * product page, the cart, the store's answers and both checkouts read it from one place.
 */
import { REFUSED_PLACES, TERRITORY_UNSETTLED } from "@/lib/eu-vat-supply";

/** Whether a physical product is kept from shipping to this country until the opening. */
export function vatShipCloses(code: string): boolean {
  return REFUSED_PLACES.has(code) || TERRITORY_UNSETTLED.has(code);
}
