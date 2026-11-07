/**
 * The second finding of the review of #3029 (head aaba5bd4), taken over while
 * Claude 5 is out: a physical product that ships "everywhere Stripe can ship
 * to" and whose EU/EEA safety information is not filled loses the EU/EEA
 * countries (lib/physical-legal-ship.ts, shippingNow). That is right, but the
 * place was then said as a list of the ~200 countries left: on the buy box
 * "Andorra, … and 200 more", which never tells an EU buyer they are left
 * out, and in deliveryWords a first-tier fact of about 1,000 characters that
 * eats the answers', the assistant's and the reminder's input caps. Now it
 * is said as the region it came from, without the EU and the EEA.
 */
import * as ship from "@/lib/physical-legal-ship";
import { parseProduct } from "@/lib/catalog";
import { deliveryWords } from "@/lib/answers";
import { SHIP_REGIONS, shipsToWords } from "@/lib/shipping";
import { GPSR_AREA } from "@/lib/physical-legal";
import { SHIPPING_WORDS } from "@/lib/buyer-words/shipping";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const RAW = { id: "book1", title: "The Supper Book", priceCents: 3500, shipping: { cents: 600, region: "world", note: "" } };

part("A worldwide product with its EU/EEA countries closed");
{
  const world = parseProduct(RAW)!;
  const now = ship.shippingNow(world)!;
  is("the EU/EEA countries are still left out, the rest kept", [now.countries.some((code) => GPSR_AREA.includes(code)), now.countries.length > 100], [false, true]);
  const fact = deliveryWords(world);
  is("the delivery fact is short, as the region's own is", fact.length < 400, true);
  is("it says the EU and the EEA are left out, never a list of country codes", [/EU/.test(fact) && /EEA/.test(fact), /\bAD, AE\b/.test(fact)], [true, false]);
  const en = SHIPPING_WORDS.en as Record<string, unknown>;
  const buyBox = shipsToWords(now, "en", SHIPPING_WORDS.en);
  is("the buy box says the countries outside the EU and the EEA, not \"and 200 more\"", [buyBox === en.outsideEu, /more countries/.test(buyBox)], [true, false]);
}

part("The same words in every language a store speaks");
for (const code of LANGUAGE_CODES) {
  const words = SHIPPING_WORDS[code] as Record<string, unknown>;
  is(`${code}: its own words for it`, typeof words.outsideEu === "string" && (words.outsideEu as string).length > 0 && (code === "en" || words.outsideEu !== (SHIPPING_WORDS.en as Record<string, unknown>).outsideEu), true);
}

part("The cart says it the same way");
{
  const shape = (ship as Record<string, unknown>).shipsToShape as ((countries: readonly string[]) => { region: string; countries: readonly string[]; before?: string }) | undefined;
  is("there is one place that tells a country list's shape", typeof shape, "function");
  if (shape) {
    const outside = SHIP_REGIONS.world.countries.filter((code) => !GPSR_AREA.includes(code));
    is("everywhere: the world", shape(SHIP_REGIONS.world.countries).region, "world");
    is("everywhere but the EU/EEA: the world without it", [shape(outside).region, shape(outside).before], ["custom", "world"]);
    is("a creator's own list stays a list", [shape(["US", "CA"]).region, shape(["US", "CA"]).before], ["custom", undefined]);
  }
}

done();
