/**
 * #5285 row #4856 (Claude 3's LOW on #4856 @00d189d300, comment 6988893501): scripts/accessibility-statement-reviews.mjs
 * dates a new or changed record of the /accessibility page "today" by itself, so running it stands in for the review
 * that a person used to make by hand with the date and the digest. Whoever runs it must be told, in the script's own
 * header, that running it is that review: each record it dates has to have been checked against the page first, and
 * a record not checked must not be regenerated (AC (x): never mark a page as reviewed to make a test pass).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const header = (readFileSync(join(process.cwd(), "scripts", "accessibility-statement-reviews.mjs"), "utf8").match(/^\/\*\*[\s\S]*?\*\//) ?? [""])[0]
  .replace(/^\s*\*\s?/gm, "")
  .replace(/\s+/g, " ");

part("The generator's header says that running it is the review of what it dates");
is("it says running it is the review of each new or changed record", /Running it is the review of each new or changed record/.test(header), true);
is("it says to check each such record against the page before running it", /check each such record against what \/accessibility shows before running it/.test(header), true);
is("it says never to run it only to make a test pass (AC \\(x\\))", /Never run it only to make a test pass/.test(header), true);
done();
