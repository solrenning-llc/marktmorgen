/**
 * A sequence that starts with a call (548 [TR1]; added 2 November 2026). A
 * paid call already starts the sequences of its product: the page after
 * paying and the five-minute job put the order on the list and start them
 * (lib/buyer-list.ts, listOrder; lib/checkout-sweep.ts). The studio says so
 * in the creator's words: a sequence on a call "starts when someone books"
 * it, and the trigger's choice says it covers booking a call. Checked in the
 * sources: the email studio is handed the store's calls and uses them only
 * for these words; the trigger and what starts it are unchanged.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The words");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is(
  "a sequence on a call starts when someone books it; any other product, when someone gets it",
  studio.includes('${f.productId && calls.includes(f.productId) ? "books" : "gets"} ${products.find((p) => p.id === f.productId)?.title ?? "a product"}'),
  true,
);
is("the trigger's choice says it covers booking a call, only when the store has one", studio.includes('{calls.length ? "Someone who agreed to hear from you gets a product or books a call" : "Someone who agreed to hear from you gets a product"}'), true);
is("the store's calls are handed to the studio", readFileSync("app/studio/email/page.tsx", "utf8").includes('calls={idsOfKind(store, "call")}'), true);

part("Nothing else changes");
is("the trigger is still the product's", studio.includes('<option value="product">'), true);
const list = readFileSync("lib/buyer-list.ts", "utf8");
is("a paid order, a call included, starts the sequences of its product", list.includes("await enroll(store, order.email, { joined: added.joined, productId: first.id });"), true);

done();
