/**
 * Issue #4120: the registry's line for gifts (lib/person-data.ts) said only "who paid, who it was for, and the
 * payment", while lib/gifts.ts keeps the giver's name and the message they typed for 400 days, untouched by an
 * erasure, and the registry's header says a "kept" line covers only the fields it names. The erasure confirmation
 * reads these lines (keptLines), so a buyer was told less than what is kept. The privacy policy already says it.
 */
import { readFileSync } from "node:fs";
import { PERSON_DATA, keptLines } from "@/lib/person-data";
import { done, is } from "./check";

const gift = PERSON_DATA.find((line) => line.file === "lib/gifts.ts");
is("the gifts line is a kept line", gift?.how, "kept");
const what = gift && gift.how === "kept" ? gift.what : "";
const why = gift && gift.how === "kept" ? gift.why : "";
is("it names the giver's name and the message they typed", [/\bname\b/i.test(what), /\bmessage\b/i.test(what)], [true, true]);
is("and says why those are kept", /\b(name|message)\b/i.test(why), true);
is("the erasure confirmation carries the same words", keptLines().some((line) => line.what === what), true);

// Controls: what lib/gifts.ts keeps, and what the privacy policy already says.
const gifts = readFileSync("lib/gifts.ts", "utf8");
is("control: lib/gifts.ts keeps a name and a message", [/\bfrom\b/.test(gifts), /\bmessage\b/.test(gifts)], [true, true]);
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("control: the privacy policy names the name and the message", /the name and the message you typed/.test(privacy), true);

done();
