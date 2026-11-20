/**
 * The personal-data registry names every field a gift keeps (issue #4120).
 *
 * lib/gifts.ts keeps, for about 13 months, the recipient's address, the
 * giver's name and the message they typed, and the payment. A `kept` line
 * covers only the fields it names (lib/person-data.ts), and the erasure
 * confirmation is read from it, so the name and the message must be named
 * there, as the privacy policy already says (#gifts).
 */
import { readFileSync } from "node:fs";
import { PERSON_DATA } from "@/lib/person-data";
import { done, is, part } from "./check";

part("The gifts line names what a gift keeps");
const line = PERSON_DATA.find((d) => d.file === "lib/gifts.ts");
is("there is a line for lib/gifts.ts, kept", line?.how, "kept");
const what = (line?.what ?? "").toLowerCase();
is("it names the giver's name and the message", [what.includes("name"), what.includes("message")], [true, true]);
is("and still who it was for and the payment", [what.includes("who it was for"), what.includes("payment")], [true, true]);

part("What the writer keeps");
const gifts = readFileSync("lib/gifts.ts", "utf8");
is("the writer keeps a name and a message", [/\bfrom: cleanLine\(/.test(gifts), /\bmessage: cleanText\(/.test(gifts)], [true, true]);

done();
