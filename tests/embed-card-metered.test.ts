/**
 * The embedded product card counts as one of the store's public requests before it reads anything (#4634).
 *
 * app/embed/[handle]/[product]/page.tsx is dynamic, so the CDN never answers it, and every render read the store's
 * stock (with up to five Stripe reads for lapsed holds), its licence keys, its bumps' listings and its reviews
 * summary, with no public request taken and isResting never called; an opened card from a site the creator did not
 * list skipped even the script's own limit (lib/embed-open.ts). A loop of requests from anywhere cost the store's
 * Redis and the company's function time with no ceiling. The store's own pages call isResting before their reads
 * (app/[handle]/p/[product]/page.tsx); the card now does the same, on every path, and a resting store's card is the
 * card's own "could not be loaded just now" line with a link to the store, reading nothing else.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
const at = (text: string) => card.indexOf(text);

part("Counted before anything is read");
is("the card asks isResting", /isResting\(store\)/.test(card), true);
is("before the script's open is read", at("isResting(store)") > 0 && at("isResting(store)") < at("await readScriptOpen("), true);
is("before stock, keys, bumps and the summary are read", at("isResting(store)") > 0 && at("isResting(store)") < at("stockLeft(store, product)"), true);

part("A resting store's card reads nothing more");
is("it says the product could not be loaded just now, with a way to the store", /if \(resting\)[\s\S]{0,400}cardUnread[\s\S]{0,400}seeStore/.test(card), true);

done();
