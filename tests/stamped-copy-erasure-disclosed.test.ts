/**
 * A stamped PDF or EPUB copy carries the buyer's email inside the file (lib/pdf-stamp.ts, stampLine), and an erasure
 * does not delete it: it goes with the creator's file (dropStamped). The erasure confirmation and the person's own
 * page read lib/person-data.ts, so the copy must be said there as kept, with why and for how long, or the
 * confirmation tells the person their address is gone while a file still holds it (#4119, Claude 1 cloud).
 *
 * What is checked:
 *   - lib/pdf-stamp.ts has a "kept" line in PERSON_DATA naming the stamped copy and the address in it;
 *   - its reason says how long: until the creator's file is removed, as the privacy policy says;
 *   - the privacy policy's stamping paragraph still says the copy is deleted with that file.
 */
import { readFileSync } from "node:fs";
import { PERSON_DATA } from "@/lib/person-data";
import { done, is, part } from "./check";

part("The stamped copy is said as kept, with the address in it");
const lines = PERSON_DATA.filter((line) => line.file === "lib/pdf-stamp.ts");
const kept = lines.find((line) => line.how === "kept");
is("lib/pdf-stamp.ts has a kept line", Boolean(kept), true);
is("it names the stamped copy", /stamped/i.test(kept?.what ?? ""), true);
is("it names the email address in it", /email address/i.test(kept?.what ?? ""), true);
is("no line says the copy is erased", lines.some((line) => line.how === "erased"), false);

part("And why, and for how long");
const why = kept && kept.how === "kept" ? kept.why : "";
is("it is deleted with the creator's file", /deleted with (?:that|the creator's|your) file/i.test(`${kept?.what ?? ""} ${why}`), true);

part("The privacy policy says the same");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
const stamping = privacy.slice(privacy.indexOf('id="stamping"'), privacy.indexOf("</p>", privacy.indexOf('id="stamping"')));
is("the stamping paragraph says the copy is deleted with that file", /is deleted with that\s+file/.test(stamping), true);

done();
