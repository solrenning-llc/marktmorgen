import { readFileSync } from "node:fs";
import { givingWords } from "@/lib/buyer-words/giving";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("An expired review link does not invent an inbox-delivery deadline");
for (const language of LANGUAGE_CODES) {
  const expired = givingWords(language).expiredRecover;
  const orderStatus = ordersWords(language).sentBody("Sample Store");
  is(`${language}: recovery guidance has no minute-based delivery promise`, /minut|minuut/i.test(expired), false);
  is(`${language}: both buyer messages remain complete`, /undefined|NaN|\$\{|\[object/.test(`${expired} ${orderStatus}`), false);
}

const page = readFileSync("app/[handle]/review/page.tsx", "utf8");
const source = readFileSync("lib/buyer-orders.ts", "utf8");
const permanent = readFileSync("tests/orders-link-copy.test.ts", "utf8");
is("an expired review link displays expiredRecover when order recovery is available", page.includes("canRecover(store) ? g.expiredRecover : g.expiredReply(store.name)"), true);
is("that guidance sends the buyer to the orders-link request page", page.includes('<Link href={`/@${store.handle}/orders`}'), true);
is("the orders request answers before the deferred read and sender attempt", source.includes('afterAnswer(() => sendLink(store, raw, email, origin));\n  return "sent";'), true);
is("sender refusal after that answer is only logged", source.includes('if (!sent) console.error("a purchases link could not be emailed")'), true);
is("the permanent orders-copy contract already forbids an inbox deadline", permanent.includes('is(`${code}: has no inbox deadline`, /minut|minuut/i.test(text), false);'), true);
done();
