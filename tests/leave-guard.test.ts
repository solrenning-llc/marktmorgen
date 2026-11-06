/**
 * Unsaved work is asked about before it is left (components/leave-guard.ts):
 * the editors whose changes wait for a Save use it, only while there are
 * changes. Page-order drafts stay protected until their save is confirmed;
 * the legacy page/funnel wiring is recorded separately below.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Where it is used");
  for (const [file, line] of [
    ["components/page-editor.tsx", "useLeaveGuard(dirty && !busy);"],
    ["components/funnel-editor.tsx", "useLeaveGuard(dirty && !busy);"],
    ["components/page-order-editor.tsx", "useLeaveGuard(changed);"],
  ]) {
    is(file, readFileSync(file, "utf8").includes(line), true);
  }
  part("What it asks about");
  const guard = readFileSync("components/leave-guard.ts", "utf8");
  is("closing or reloading the tab", guard.includes('addEventListener("beforeunload"'), true);
  is("a link inside the site, before the router acts on it", guard.includes('document.addEventListener("click", onClick, true)'), true);
  is("never a new tab, another site or the same page", [guard.includes('link.target === "_blank"'), guard.includes("to.origin !== window.location.origin"), guard.includes("to.pathname === window.location.pathname")], [true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
