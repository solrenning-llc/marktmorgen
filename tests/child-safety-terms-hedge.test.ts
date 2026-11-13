/**
 * Claude 1 on #3587 (6799433516), LOW: the Terms promised more than the code does. The automatic hold takes a
 * reported product off the store only for a `/@handle/p/<id>` address and at most 3 products a store a day
 * (lib/child-safety.ts); the /report page and the form already say it "usually comes off the store at once" and is
 * otherwise acted on by hand. The Terms say the same, never an unconditional "at once".
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const terms = readFileSync("app/terms/page.tsx", "utf8");
const start = terms.indexOf('id="child-safety"');
const section = start === -1 ? "" : terms.slice(start, terms.indexOf("</p>", start)).replace(/\s+/g, " ");

part("The Terms' child-safety section says what the code does");
is("the section is there", start !== -1, true);
is("no unconditional promise to take it off at once", section.includes("we take it off the store at once"), false);
is("as the form says: usually at once, otherwise by hand", [section.includes("usually at once"), section.includes("by hand")], [true, true]);
is("it still says it is reported to NCMEC, as the law requires", [section.includes("(NCMEC)"), section.includes("2258A")], [true, true]);

done();
