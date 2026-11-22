/**
 * Issue #5125, the copy in pages with more than one paged part (lib/person-copy.ts PAGED_MODULES; Claude 1 coord a6e9,
 * Claude 4 AC 1a26). On the first page the paged parts share one request's budget: the first that runs out sets the
 * cursor, and every one after it is read whole on the later pages. That only holds when PAGED_MODULES lists them in
 * the order the first page reaches them, which this test keeps: COPY_PLAN's order, then COPY_ALSO's.
 */
import { COPY_ALSO, COPY_PLAN, PAGED_MODULES, morePagesLine } from "@/lib/person-copy";
import { done, is, part } from "./check";

part("PAGED_MODULES in the order the first page reaches them");
const reached = [...Object.keys(COPY_PLAN).filter((m) => COPY_PLAN[m]!.how === "copied"), ...Object.keys(COPY_ALSO).filter((m) => COPY_ALSO[m]!.how === "copied")];
const paged = Object.keys(PAGED_MODULES);
is("each paged part is a module the copy reads", paged.filter((m) => !reached.includes(m)), []);
is("in the same order", paged, reached.filter((m) => paged.includes(m)));

part("The line a page with more says names each part still to read");
const community = "lib/community-erasure.ts#c1";
is("one part", morePagesLine(2, [community]), 'This copy continues on page 2. Ask for it with the cursor in "next" to read the rest: your community activity (1 part still to read).');
for (const module of paged) is(`${module} says what it is in words`, PAGED_MODULES[module]!.what.length > 0 && !PAGED_MODULES[module]!.what.includes("lib/"), true);

done();
