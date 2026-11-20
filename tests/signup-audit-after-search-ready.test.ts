/**
 * The signup matrix (tests/e2e/accessibility-signup-actions.mjs) audits the created studio only once its search
 * box has hydrated.
 *
 * The first-store claim reloads the whole page (components/handle-form.tsx, window.location.assign). The server
 * draws the studio search inert and invisible until the page's script runs (components/studio-search.tsx), while
 * the heading "Your store" and the network going idle are already true on the server's HTML. In the merge queue,
 * WebKit failed 1 case of 30 in five runs (17 and 18 November 2026: 44018264574, 44018996241, 44031103933,
 * 44104921080, 44227830302), always reduced-motion, always created-first-store-studio, always axe's
 * label-title-only on that box's field, at 390, 1280 and 1920 px. Each failing audit started 2.87 to 2.99 s after
 * the previous state; the 145 passing ones in that state started 3.05 to 3.86 s after it. Reduced motion makes
 * the scroll back to the top instant (app/globals.css), so the audit started sooner, before the box was ready.
 *
 * The audit now waits until no studio search is still inert, with Playwright's default timeout: a box that never
 * becomes ready fails the case, as before. No axe rule is turned off and no audit is skipped. Each audit line also
 * records the box's state when axe started and ended, so a later failure says whether it was ready.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";

const harness = readFileSync("tests/e2e/accessibility-signup-actions.mjs", "utf8");
const start = harness.indexOf("async function audit(state){");
const end = harness.indexOf('console.log("SIGNUP_MATRIX_AUDIT:"', start);
const audit = start >= 0 && end > start ? harness.slice(start, end) : "";
const GATE = `page.waitForFunction(()=>!document.querySelector('[role="search"][inert]'))`;

part("The created studio is audited only once its search box has hydrated");
is("the harness has its audit function", audit.length > 0, true);
is("the audit waits until no studio search is still inert", audit.includes(GATE), true);
is("that wait comes before axe runs", audit.indexOf(GATE) >= 0 && audit.indexOf(GATE) < audit.indexOf("window.axe.run("), true);
is("the wait keeps Playwright's default timeout (no longer wait was added)", /waitForFunction\(\(\)=>!document\.querySelector\('\[role="search"\]\[inert\]'\)\s*,/.test(audit), false);

part("Each audit line says the box's state when axe started and ended");
is("the state is read before axe runs", /searchGate\s*=\s*\(\)\s*=>/.test(audit) && audit.indexOf("searchGate()") < audit.indexOf("window.axe.run("), true);
is("the line carries both readings", audit.includes("searchGateAtStart") && audit.includes("searchGateAtEnd"), true);

part("Nothing the audit checks is loosened");
is("axe still runs with the enhanced contrast rule on and no rule turned off", audit.includes('window.axe.run(document,{rules:{"color-contrast-enhanced":{enabled:true}}})') && !/enabled\s*:\s*false/.test(audit), true);
is("an overflow or any violation still fails the case", harness.includes('if(result.scroll>result.client||result.violations.length)throw Error("Accessibility/overflow failure at "+state);'), true);
is("the created studio is still audited", harness.includes('await audit("created-first-store-studio");'), true);

done();
