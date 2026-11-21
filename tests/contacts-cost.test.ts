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
import { contactRows, largestContact, smallestContact, renderContactsCost } from "./contacts-cost-table";
import { done, is, part } from "./check";

const rows = contactRows();

part("Contacts are measured with the code's own size");
is("the smallest contact is smaller than the largest", contactBytes(smallestContact()) < contactBytes(largestContact()), true);
is("each row uses the smallest contact", rows.every((row) => row.smallestBytes === contactBytes(smallestContact())), true);

part("What fits in each plan's empty room");
for (const row of rows) {
  is(`${row.tier}: the room's bytes`, row.roomBytes, DATA_ROOM_BYTES[row.tier]);
  is(`${row.tier}: the most smallest contacts that fit`, row.fitSmallest, Math.floor(DATA_ROOM_BYTES[row.tier] / contactBytes(smallestContact())));
  is(`${row.tier}: the most largest contacts that fit`, row.fitLargest, Math.floor(DATA_ROOM_BYTES[row.tier] / contactBytes(largestContact())));
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
