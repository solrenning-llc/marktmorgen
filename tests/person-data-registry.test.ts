/**
 * The registry of what each module keeps about a store's people
 * (lib/person-data.ts) cannot fall behind the code (added 17 October 2026),
 * the way the cost registry cannot (tests/plan-cost-registry.test.ts):
 *
 *   - every file the scan finds keeping something per person
 *     (tests/person-data-scan.ts) has a line saying what becomes of it;
 *   - every line that says "erased" names a module lib/person-erasure.ts runs,
 *     and every module it runs has such a line;
 *   - each eraser it runs is a function its module exports;
 *   - every file named exists, and every "kept" line says why;
 *   - the privacy policy and the help say what the registry says, and send a
 *     deletion to the page that does it, not to an email address.
 *
 * So a module that begins to keep an address, a person's key or anything
 * made from them fails here until it says how that is deleted, or why not.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PERSON_DATA, keptLines, linesOf } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { personFiles } from "./person-data-scan";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

part("Every file that keeps something per person is in the registry");
const listed = new Set(PERSON_DATA.map((d) => d.file));
const found = personFiles(root);
is("the scan finds the files it should", ["lib/contacts.ts", "lib/learn.ts", "lib/community.ts", "lib/crm.ts", "lib/flows.ts"].every((f) => found.some((x) => x.file === f)), true);
// A file written with a person's address in its content (a stamped copy, lib/pdf-stamp.ts) is found too, so a copy kept
// in the file store with somebody's address on it cannot go unlisted again (Claude 7 on main 4865799f53).
is("and a file that writes a stored file with a person's address in it", found.some((x) => x.file === "lib/pdf-stamp.ts"), true);
is(
  "each is in lib/person-data.ts (add a line saying what deleting a person does to it)",
  found.filter((f) => !listed.has(f.file)).map((f) => `${f.file}${f.keys.length ? ` (keys ${f.keys.join(", ")})` : ""}`),
  [],
);
is("each file named exists", [...listed].filter((f) => !existsSync(join(root, f))), []);

part("Erased means erased by the erasure itself");
const run = new Set(ERASERS.map((e) => e.module));
const erasedBy = PERSON_DATA.flatMap((d) => (d.how === "erased" ? [d.via ?? d.file] : []));
is("every erased line names a module the erasure runs", [...new Set(erasedBy)].filter((m) => !run.has(m)), []);
is("every module the erasure runs has an erased line", [...run].filter((m) => !erasedBy.includes(m)), []);
is("no module runs twice", ERASERS.length, run.size);
const source = read("lib/person-erasure.ts");
const called = [...source.matchAll(/import \{ ([^}]+) \} from "@\/lib\/([a-z0-9-]+)";/g)].flatMap((m) => m[1].split(",").map((name) => ({ name: name.trim(), file: `lib/${m[2]}.ts` })));
const forgetters = called.filter((c) => /^forget[A-Z]/.test(c.name));
is("each forget function the erasure imports is exported by its module", forgetters.filter((c) => !new RegExp(`export async function ${c.name}\\(`).test(read(c.file))).map((c) => `${c.file}: ${c.name}`), []);
is("and each is one of the modules it runs", forgetters.filter((c) => !run.has(c.file)).map((c) => c.file), []);
is("the list's own row is the last thing forgotten, after the modules that read it", ERASERS.at(-1)?.module, "lib/contacts.ts");
is("the fingerprint is written before any eraser runs", source.indexOf("suppressCommand(scope.listId") < source.indexOf("for (const eraser of ERASERS)"), true);
const community = read("lib/community-erasure.ts");
const viaCommunity = PERSON_DATA.filter((d) => d.how === "erased" && d.via === "lib/community-erasure.ts").map((d) => d.file);
is(
  "each community module said to be erased through lib/community-erasure.ts is called from it",
  // The search's member index and the course answers are forgotten through their neighbors (lib/community-index.ts, lib/community-access.ts).
  viaCommunity.filter((file) => !["lib/community-search.ts", "lib/community-found.ts"].includes(file) && !community.includes(`from "@/lib/${file.slice(4, -3)}"`)),
  [],
);

part("What the confirmation reads");
is("there is something deleted, a fingerprint and kept lines", [linesOf("erased").length > 20, linesOf("suppression").length > 0, keptLines().length > 3], [true, true, true]);
is("every kept line says why", PERSON_DATA.filter((d) => d.how === "kept" && !d.why).map((d) => d.file), []);
is("every expiring line says within how many days", PERSON_DATA.filter((d) => d.how === "expires" && !(d.days > 0 && d.days <= 400)).map((d) => d.file), []);
const words = PERSON_DATA.map((d) => d.what).join(" ");
is("in US English, and never the word the owner forbids", [/\bcolour|cancelled|centre|organis|tick\b/i.test(words), /unlimited/i.test(words)], [false, false]);

part("The pages say so, and send a deletion to the page that does it");
const privacy = read("app/privacy/page.tsx");
is("the privacy policy has the deletion section", privacy.includes('id="delete"') && privacy.includes("/privacy/delete"), true);
is("and no longer sends a deletion to an email address", /(deletion|delete)[^.]{0,120}(support@|email(ing)? us)/i.test(privacy.replace(/\s+/g, " ")), false);
const page = read("app/privacy/delete/page.tsx");
is("the person's page posts to the route that deletes", page.includes('action="/api/privacy/erase"'), true);
is("every store's page links to it", read("app/[handle]/page.tsx").includes("/privacy/delete?store="), true);
is("the help says how", read("lib/help-content.ts").includes("Delete this person"), true);

done();
