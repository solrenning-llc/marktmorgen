/**
 * 639 [GL7](34), unit 2: the buyer's library across stores (app/library)
 * says, on each store's card, what waits on them there: payment requests
 * to pay and proposals or agreements to sign (lib/buyer-waiting.ts), only
 * where that store's orders page opens to act on them. Upcoming sessions
 * stay on each store's orders page, which already lists them, so the
 * library makes no extra Stripe reading per store.
 */
import { readFileSync } from "node:fs";
import { waitingLine } from "@/lib/buyer-waiting";
import { done, is, part } from "./check";

const request = (id: string) => ({ id, total: 100, dueDate: "", expiresAt: 0 });
const agreement = (id: string) => ({ id, kind: "proposal" as const, title: "T", expiresAt: 0 });

part("In words");
is("nothing waiting, nothing said", waitingLine({ requests: [], agreements: [] }), "");
is("one of each", waitingLine({ requests: [request("a")], agreements: [agreement("b")] }), "Waiting for you: 1 payment request to pay and 1 proposal or agreement to sign.");
is("several", waitingLine({ requests: [request("a"), request("c")], agreements: [] }), "Waiting for you: 2 payment requests to pay.");
is("only to sign", waitingLine({ requests: [], agreements: [agreement("a"), agreement("b"), agreement("c")] }), "Waiting for you: 3 proposals or agreements to sign.");

part("On the library");
const page = readFileSync("app/library/page.tsx", "utf8");
is("read only for a store whose orders page opens", page.includes("const found = open ? await waitingFor(store, email).catch(() => null) : null;"), true);
is("payment requests only where they take payment", page.includes("requests: requestsOpen(store) ? found.requests : []"), true);
is("said on the store's card, beside the way to open it", page.includes("{waiting ? <p className=\"mt-4 text-sm font-semibold text-ink\">{waiting}</p> : null}"), true);
is("no extra reading of the creator's Stripe account per store", !page.includes("callsFor("), true);

done();
