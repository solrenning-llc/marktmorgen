/**
 * Claude 4's LEVE 1 on #3482, confirmed open by Claude 1's money review at 330820a11a: a come-back link's checkout is
 * opened under a claim of OPENING_SECONDS (lib/winback-send.ts), but the route that opens it
 * (app/api/store/come-back/open/route.ts) set no maxDuration, so a press could run past the claim while Stripe was slow
 * (createCheckout retries at STRIPE_TIMEOUT_MS each). The claim then ran out, a second press opened its own discounted
 * checkout, and the first press's keepCheckout wrote over the second's. The route now ends at OPENING_SECONDS at the
 * most; the claim is taken after the route's first reads, so it always outlives the press that holds it.
 * Read from the sources: a function's time limit is the platform's, not something a test can run.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const send = readFileSync("lib/winback-send.ts", "utf8");
const route = readFileSync("app/api/store/come-back/open/route.ts", "utf8");
const opening = Number(/const OPENING_SECONDS = (\d+);/.exec(send)?.[1] ?? NaN);
const limit = Number(/export const maxDuration = (\d+);/.exec(route)?.[1] ?? NaN);

part("A come-back press never outlives its own claim");
is("the claim's length is read from the code", Number.isSafeInteger(opening) && opening > 0, true);
is("the route that opens the checkout states its own time limit", Number.isSafeInteger(limit) && limit > 0, true);
is("and it is no longer than the claim, so the claim never runs out while the press still works", limit <= opening, true);
is("the claim is taken before the checkout is asked of Stripe, and its own value is checked before it is let go", /claimMark\(openKey\(token\), OPENING_SECONDS, claim\)[\s\S]*createCheckout[\s\S]*releaseMark\(openKey\(token\), claim\)/.test(send), true);
done();
