/**
 * The first finding of the review of #3029 (head aaba5bd4), taken over while
 * Claude 5 is out: the outermost regions with their own country code and the
 * Aland Islands are part of the Union, so a product whose EU safety
 * information is not filled must not ship there either. Source, read on
 * EUR-Lex on 7 November 2026: Treaty on the Functioning of the European
 * Union, consolidated version, OJ C 202 of 7.6.2016, art. 355(1) (Guadeloupe,
 * French Guiana, Martinique, Mayotte, Reunion and Saint-Martin, in
 * accordance with art. 349) and art. 355(4) (the Aland Islands, in
 * accordance with Protocol 2). The Azores, Madeira and the Canary Islands
 * ship as PT and ES, already in the area.
 */
import { parseProduct } from "@/lib/catalog";
import { GPSR_AREA } from "@/lib/physical-legal";
import { shippingNow } from "@/lib/physical-legal-ship";
import { SHIP_COUNTRIES } from "@/lib/shipping";
import { done, is, part } from "./check";

const TERRITORIES = ["AX", "GF", "GP", "MF", "MQ", "RE", "YT"];

part("The Union's own territories with a country code of their own");
is("each is a country Stripe can ship to", TERRITORIES.filter((code) => !SHIP_COUNTRIES.includes(code)), []);
is("each is in the area the EU safety information is asked for", TERRITORIES.filter((code) => !GPSR_AREA.includes(code)), []);

part("An unfilled product shipped there is not sold there");
{
  const raw = { id: "book1", title: "The Supper Book", priceCents: 3500, shipping: { cents: 600, region: "custom", countries: ["US", "RE", "GP", "AX"], note: "" } };
  is("only the United States stays open", shippingNow(parseProduct(raw)!)?.countries, ["US"]);
  const world = shippingNow(parseProduct({ ...raw, shipping: { cents: 600, region: "world", note: "" } })!)!;
  is("everywhere: none of them stays open", TERRITORIES.filter((code) => world.countries.includes(code)), []);
}

done();
