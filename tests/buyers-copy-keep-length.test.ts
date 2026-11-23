/**
 * Board #5427, row #3226 (Claude 1's LOW, 6817864376, still in main): the copy of a store's buyers that segments are
 * read from has been kept an hour since 4 November 2026 (LEDGER_SECONDS, owner C3-80 (b)), but the line a person's
 * copy of their data shows for it (COPY_PLAN in lib/person-copy.ts) still said "a ten-minute copy", and so did the
 * error of its erasure. What a person is told about their data must say how long it is really kept, the same as the
 * erasure's line (PERSON_DATA in lib/person-data.ts) already does. Synthetic: reads the code's own figures only.
 */
import { readFileSync } from "node:fs";
import { COPY_PLAN } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import { LEDGER_SECONDS } from "@/lib/segments";
import { done, is, part } from "./check";

const words = (seconds: number): RegExp =>
  seconds === 3_600 ? /\b(one-hour|an hour'?s?|one hour)\b/i : seconds === 600 ? /\bten-minute\b/i : /^(?!)/;

part("The person's copy of their data says how long the buyers' copy is kept");
is("(setup) the buyers' copy is kept an hour", LEDGER_SECONDS, 3_600);
const copyLine = COPY_PLAN["lib/segments.ts"]?.what ?? "";
is("the copy's line names an hour", words(LEDGER_SECONDS).test(copyLine), true);
is("and never ten minutes", /ten-minute|ten minutes|10 minutes/i.test(copyLine), false);
const erasureLine = PERSON_DATA.find((line) => line.file === "lib/segments.ts")?.what ?? "";
is("the erasure's line names the same length", words(LEDGER_SECONDS).test(erasureLine), true);

part("The erasure's error names the copy it could not delete as it is");
const source = readFileSync("lib/segments.ts", "utf8");
is("no 'ten-minute copy' left in lib/segments.ts", /ten-minute copy/.test(source), false);
done();
