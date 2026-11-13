/**
 * docs/backup-costs-2026-11-08.md, section 5a (Codex R1 on #3271, LEVE): the headline said "A copy spans at most the
 * day's two runs", while the same document's 0.25 s request model gives a full copy in 5 runs, more than one UTC
 * day holds. The page now says there are two scheduled runs a day and that finishing depends on request time, so no
 * reader takes the daily window for enough. Reads the document only.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const doc = readFileSync("docs/backup-costs-2026-11-08.md", "utf8");
const section = doc.slice(doc.indexOf("### 5a."), doc.indexOf("| Line (code id) |"));

part("Section 5a never promises a copy inside one day");
is("no headline that a copy spans at most the day's two runs", /copy spans at most the day's two runs/i.test(section), false);
is("it names the two scheduled runs a day", /two scheduled runs a day/i.test(section), true);
is("and that finishing depends on request time, with the documented model's 5 runs", /depends on (the )?request (latency|time)/i.test(section) && /5 runs/.test(section), true);
is("control: the latency model still says 5 runs", /a full copy takes \*\*5 runs\*\*/.test(doc), true);

done();
