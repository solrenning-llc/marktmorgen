/**
 * Board #5285, row #5030: the nit of Claude 4 3Kc, known to Claude 7 (7069341819). The funnel save's store-live guard
 * is funnel-save-live:v3, which answers -5 for a store moved and live under another ref (its room keeps the new
 * funnel's slot) and -4 for one gone or being erased. The note above lib/redis-memory.ts's branch for it still said
 * "v2", and the script's own note in lib/page-funnel-store.ts named v2 and only -4. A note that disagrees with the code
 * it describes misleads the next change. Both now name v3 and the two answers. Source text only.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const memory = readFileSync("lib/redis-memory.ts", "utf8").split("\n");
const branch = memory.findIndex((line) => line.includes('key.startsWith("-- marktmorgen:funnel-save-live:'));
const version = /funnel-save-live:(v\d+)/.exec(memory[branch] ?? "")?.[1] ?? "";
const above = memory[branch - 1] ?? "";
is("control: the branch is found, at the script's version", version, "v3");
is("the note above it names the same version", above.includes(`(${version}:`), true);
is("and the moved store's -5 beside the -4", [above.includes("-5"), above.includes("-4")], [true, true]);

const store = readFileSync("lib/page-funnel-store.ts", "utf8");
const doc = store.slice(store.lastIndexOf("/**", store.indexOf("export const SAVE_STORE_PAGE_FUNNEL")), store.indexOf("export const SAVE_STORE_PAGE_FUNNEL"));
is("the script's own note names v3, not v2", [doc.includes("v3"), /\(v2[,:]/.test(doc)], [true, false]);
is("and says what -5 means", /-5 means/.test(doc), true);
done();
