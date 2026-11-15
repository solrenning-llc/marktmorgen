/**
 * The addresses a webhook message names, for the deletion check before each try and in the recent events
 * (lib/webhooks.ts, addressesIn; Claude 4 on #4555, LEVE): an address inside a sentence or in "Name <address>" form is
 * one the message names too, never passed over because the text around it is not only an address. Synthetic only.
 */
import { addressesIn } from "@/lib/webhooks";
import { done, is, part } from "./check";

const of = (data: unknown) => addressesIn(JSON.stringify({ id: "evt_x", type: "sale.completed", data })).sort();

part("A text that is only an address");
is("a buyer's email field", of({ buyer: { email: "Pat@Example.com" } }), ["pat@example.com"]);

part("An address inside a text");
is("Name <address>", of({ note: "Pat Doe <pat@example.com>" }), ["pat@example.com"]);
is("inside a sentence", of({ note: "Write to pat@example.com, or to sam@example.org." }), ["pat@example.com", "sam@example.org"]);
is("in a list, each once", of({ to: ["a@example.com", "A@example.com", "b@example.com"] }), ["a@example.com", "b@example.com"]);
is("as an object key", of({ "kim@example.com": 1 }), ["kim@example.com"]);

part("RED (Claude 2 on #4562): an address glued to other characters is still found whole");
const has = (note: string, address: string) => of({ note }).includes(address);
is("RED: between emoji", has("📧ana@example.com🙂", "ana@example.com"), true);
is("RED: in a link's query", has("https://shop.example/?email=ana@example.com", "ana@example.com"), true);
is("RED: after a slash", has("contact/ana@example.com", "ana@example.com"), true);
is("RED: a non-ASCII domain", has("ana@münchen.de", "ana@münchen.de"), true);

part("Not an address");
is("an @ handle or a bare domain", of({ note: "@pat on example.com" }), []);
is("no message, no address", addressesIn("not json"), []);
done();
