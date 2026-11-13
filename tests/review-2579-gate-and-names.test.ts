/**
 * Claude 5's review of #2579 (second review, head 1ca7c957): two holes in the
 * look-alike reading of the store assistant's deal-word check
 * (lib/store-assistant-rules.ts, heldToFacts).
 *
 * MEDIUM 1: the gate MAY_LOOK_ALIKE opened the look-alike reading only from
 * U+0250 on, plus eight hand-listed letters, so 51 letters of the table itself
 * below U+0250 were never read ("Raƀatt." passed, while "Raƀatt ɑ."
 * was refused because the ɑ opened the gate).
 *
 * MEDIUM 2: sister letters of ø/đ/ł (a Latin letter with a stroke or
 * a hook and no decomposition) were outside the table: ħ Ħ ŧ Ŧ, the
 * small eth ð, kra ĸ, eng ŋ, and some 130 more found by Unicode name.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAY_LOOK_ALIKE, foldedText, heldToFacts } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

const facts = "Pottery course.";

part("Claude 5 on #2579, MEDIUM 1: every letter of the table is read, whatever its code point");
is("a deal word spelled with a letter of the table below U+0250 is refused", [
  "Raƀatt.", "A disȼount.", "A vouchɇr.", "ƌiscount", "kortinǥ", "couƥon", "discounƭ", "hurrɏ", "saƚe prices", "ƒive stars",
].filter((reply) => heldToFacts(reply, facts)), []);
is("as it already was with a later letter beside it (the control)", heldToFacts("Raƀatt ɑ.", facts), false);

part("Claude 5 on #2579, MEDIUM 2: the sister letters with a stroke or a hook");
is("each is read as its base letter, in both cases", [
  "A voucħer.", "A VOUCĦER.", "A discounŧ.", "A DISCOUNŦ.", "A ðiscount.", "ĸorting", "A discouŋt.", "A DISCOUŊT.",
  "A Ɗiscount.", "A ƈoupon.", "ƤROMO", "A ꝑromo.", "A ᵭiscount.", "A ɕoupon.", "A DISȻOUNT.", "kortinꞡ", "ƲOUCHER",
].filter((reply) => heldToFacts(reply, facts)), []);
is("while honest Maltese, Danish, Polish and Hausa words still pass", [
  heldToFacts("Il-ħobż huwa tajjeb. Ħamrun.", facts), heldToFacts("Krøner og łódź.", facts), heldToFacts("Ɓaki ɗan ƙasa.", facts),
], [true, true, true]);

part("Claude 5 on #2579: the rule, for every letter");
// Every "LATIN SMALL|CAPITAL LETTER X WITH ..." of Unicode 18.0.0 with no decomposition, and eth, kra and eng: read as a Latin letter.
const unicodeData = readFileSync("tooling/unicode/UnicodeData-18.0.0.txt", "utf8");
const named = unicodeData.split("\n").map((line) => line.split(";")).filter((f) => f.length > 5 && /^L[lu]$/.test(f[2]) && f[5] === "" && /^LATIN (?:SMALL|CAPITAL) LETTER (?:[A-Z] WITH |ETH$|KRA$|ENG$)/.test(f[1]));
is("the copy of UnicodeData.txt is the one read on 7 November 2026", createHash("sha256").update(unicodeData).digest("hex"), "0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950");
is("there are such letters", named.length > 200, true);
is("each is read as one Latin letter", named.filter((f) => !/^[a-z]$/.test(foldedText(String.fromCodePoint(parseInt(f[0], 16)), "l"))).map((f) => `${f[0]} ${f[1]}`), []);
// The gate only saves work: a sign it leaves out must read the same with and without the look-alike table.
const missed: string[] = [];
for (let code = 0; code <= 0xffff; code += 1) {
  if (code >= 0xd800 && code <= 0xdfff) continue;
  const sign = String.fromCodePoint(code);
  if (MAY_LOOK_ALIKE.test(sign)) continue;
  const plain = foldedText(sign);
  if (foldedText(sign, "l") !== plain || foldedText(sign, "i") !== plain) missed.push(code.toString(16));
}
is("the gate lets through every sign the look-alike reading changes", missed, []);

done();
