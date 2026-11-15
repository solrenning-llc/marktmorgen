/**
 * 457 [EL1], unit 2: every page that says how many contacts a list holds
 * says each plan's real figure, from the code's own constants (the plan's
 * data room over the smallest contact's bytes, never above MAX_LEADS), never
 * a number typed by hand and never one a plan cannot reach.
 */
import { readFileSync } from "node:fs";
import { MAX_LEADS } from "@/lib/contact-rules";
import { contactBytes } from "@/lib/contacts";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { PLAN_TITLES, TIERS } from "@/lib/plan";
import { contactCeiling, contactCeilingWords, smallestContact } from "@/lib/contact-ceiling";
import { PRICING_GROUPS } from "@/lib/pricing-page-data";
import { done, is, part } from "./check";

const n = (value: number) => value.toLocaleString("en-US");

part("Each plan's ceiling, from the code");
for (const tier of TIERS) {
  is(`${PLAN_TITLES[tier]}: the room over the smallest contact, never above MAX_LEADS`, contactCeiling(tier), Math.min(MAX_LEADS, Math.floor(DATA_ROOM_BYTES[tier] / contactBytes(smallestContact()))));
  is(`${PLAN_TITLES[tier]}: a whole number of one or more`, Number.isSafeInteger(contactCeiling(tier)) && contactCeiling(tier) >= 1, true);
}

part("The sentence names every plan once, with its own figure");
const words = contactCeilingWords();
for (const tier of TIERS) is(`it names ${PLAN_TITLES[tier]}`, words.includes(PLAN_TITLES[tier]), true);
const groups = [...new Set(TIERS.map(contactCeiling))];
for (const value of groups) is(`it says ${n(value)}`, words.includes(n(value)), true);
is("it never says a figure no plan holds", [...words.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ""))).every((v) => groups.includes(v)), true);

part("The pricing table shows each plan's own ceiling");
const row = PRICING_GROUPS.flatMap((group) => group.rows).find((r) => r.key === "contacts");
is("the contacts row is there", Boolean(row), true);
for (const tier of TIERS) is(`${PLAN_TITLES[tier]}: its own figure`, row?.values[tier], n(contactCeiling(tier)));

part("The home page and the help say the real figures, never a number typed by hand");
const home = readFileSync("components/home-parts.tsx", "utf8");
const help = readFileSync("lib/help-content.ts", "utf8");
is("the home page's list card reads the sentence from the code", /contactCeilingWords\(/.test(home), true);
is("the help answer reads the sentence from the code", /contactCeilingWords\(/.test(help), true);
for (const [name, text] of [["home", home], ["help", help]] as const) {
  is(`${name}: no contact ceiling typed by hand`, /up to [\d,]+ (people|addresses|contacts)/.test(text), false);
  is(`${name}: never "unlimited contacts"`, /unlimited contacts/i.test(text), false);
}

done();
