/**
 * 457 [EL1], unit 1: how many contacts each plan can really keep, and what
 * keeping them costs, measured with the code. Nothing changes a limit, a page
 * or MAX_LEADS (the owner decides; "never cut the 100,000").
 *
 *   - every contact is taken from the plan's data room (lib/contacts.ts,
 *     needContacts; an order's through lib/order-data.ts), at contactBytes;
 *   - the smallest contact there can be, a yes from a form with nothing else,
 *     and the largest (every title, name, label and mark at its longest);
 *   - the most that fit in an empty room (DATA_ROOM_BYTES), against MAX_LEADS;
 *   - the room is already priced full every day (tests/plan-cost-registry.ts
 *     "database-storage"), so keeping contacts adds no storage line of its own;
 *   - docs/contacts-cost.md is exactly what the renderer writes.
 */
import { readFileSync, existsSync } from "node:fs";
import { MAX_LEADS } from "@/lib/contact-rules";
import { contactBytes } from "@/lib/contacts";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { TIERS } from "@/lib/plan";
import { COST_LINES } from "./plan-cost-registry";
import { contactRows, largestContact, orderContactBytes, smallestContact, renderContactsCost } from "./contacts-cost-table";
import { done, is, part } from "./check";

const rows = contactRows();

part("Contacts are measured with the code's own size");
is("the smallest contact is smaller than the largest", contactBytes(smallestContact()) < contactBytes(largestContact()), true);
is("each row uses the smallest contact", rows.every((row) => row.smallestBytes === contactBytes(smallestContact())), true);

// Codex X6 (7059427028), first LOW: a bounded text written in wide or JSON-escaped characters
// takes more bytes than the same length in "x"; the largest contact must hold for all of them.
part("The largest contact bounds wide and escaped text");
const wide = (ch: string) => {
  const base = largestContact();
  const fill = (length: number) => ch.repeat(length).slice(0, length);
  return { ...base, titles: base.titles.map((t) => fill(t.length)), name: fill(base.name.length), tags: base.tags.map((t, i) => (`${i}` + fill(t.length)).slice(0, t.length)) };
};
for (const [what, ch] of [["a three-byte character", "€"], ["a quote", '"'], ["a control character", "\u0001"], ["a lone surrogate", "\ud800"], ["an emoji", "😀"]] as const) {
  is(`no contact written with ${what} takes more than the largest`, contactBytes(wide(ch)) <= rows[0].largestBytes, true);
}
// Codex X6 (7059427028), second LOW: a contact an order writes is counted in the orders' part
// (lib/order-data.ts: the field, the value and an entry, a quarter more, rounded up), not at contactBytes.
part("A contact an order writes");
is("the largest counts the order's charge too", rows[0].largestBytes >= orderContactBytes(largestContact()), true);
// A stored contact carries where its room is counted (r, lib/contacts.ts placed()): "o" when an order wrote it, "c"
// otherwise. The largest is measured as stored, with it (Claude 5 icEJ's LEVE on #3864, 7074425508).
is("the largest covers a contact stored with its r, either way", [
  rows[0].largestBytes >= contactBytes({ ...largestContact(), r: "c" }),
  rows[0].largestBytes >= orderContactBytes({ ...largestContact(), r: "o" }),
], [true, true]);
is("the order's charge of the largest is above its contacts' charge", orderContactBytes(largestContact()) > contactBytes(largestContact()), true);
is("the record names the order's charge", renderContactsCost().includes("orderGrowth"), true);

part("What fits in each plan's empty room");
for (const row of rows) {
  is(`${row.tier}: the room's bytes`, row.roomBytes, DATA_ROOM_BYTES[row.tier]);
  is(`${row.tier}: the most smallest contacts that fit`, row.fitSmallest, Math.floor(DATA_ROOM_BYTES[row.tier] / contactBytes(smallestContact())));
  is(`${row.tier}: the most largest contacts that fit`, row.fitLargest, Math.floor(DATA_ROOM_BYTES[row.tier] / row.largestBytes));
  is(`${row.tier}: the real ceiling is the lower of the room and MAX_LEADS`, row.realCeiling, Math.min(MAX_LEADS, row.fitSmallest));
}
is("one row per plan", rows.map((row) => row.tier), [...TIERS]);

part("The room is already priced");
is("the database line prices each plan's room", COST_LINES.some((line) => line.id === "database-storage"), true);

part("The record");
const doc = renderContactsCost();
is("it says where the published 100,000 cannot be reached", doc.includes("cannot be reached"), rows.some((row) => row.realCeiling < MAX_LEADS));
is("it never calls the list unlimited", /unlimited contacts/i.test(doc.replace(/"Unlimited contacts"/g, "")), false);
is("it has an Acessibilidade section", doc.includes("## Acessibilidade"), true);
is("docs/contacts-cost.md is current (node scripts/contacts-cost.mjs)", existsSync("docs/contacts-cost.md") ? readFileSync("docs/contacts-cost.md", "utf8") : "", doc);

done();
