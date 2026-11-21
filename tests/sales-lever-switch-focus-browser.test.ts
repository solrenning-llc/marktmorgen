/**
 * 752 [CD3], Codex X6's MEDIUM (coverage) on #3563: the "Grow your sales" card's switch in local Chromium, with the
 * real component and a stand-in for its route kept in the page (tests/e2e/sales-lever-switch-focus.mjs and
 * tests/e2e/sales-lever-switch-harness.tsx; no server, nothing sent). When the button holding the focus goes away,
 * the focus goes on, never to the page's body (WCAG 2.2 SC 2.4.3): a confirmed Undo hands it to the switch, an
 * unconfirmed reply to "Reload the page", and a focus the person moved is kept. A refresh that draws another saved
 * state than the card's own (another tab) is what the card shows, with no Undo of the old one (Codex X6's LOW).
 * Run here, inside npm test, so the check runs on every pull request without a workflow of its own.
 */
import { spawnSync } from "node:child_process";
import { done, is, part } from "./check";

const run = spawnSync(process.execPath, ["tests/e2e/sales-lever-switch-focus.mjs"], {
  encoding: "utf8",
  // CI runs several test files at once, so the bundle, the browser and its nine checks get room (cd3 on #3563: one
  // CI run was stopped at 120 s, mid-check, with nothing on stderr).
  timeout: 300_000,
  maxBuffer: 2_000_000,
  env: { ...process.env, E2E_BROWSER: "chromium" },
});
const lines = `${run.stdout ?? ""}`.split("\n").filter(Boolean);
if (run.status !== 0) console.log(`${run.stdout ?? ""}${run.stderr ?? ""}\nexit ${run.status}, signal ${run.signal}, ${run.error ? String(run.error) : "no spawn error"}`);

part("The switch's focus and its saved state, in a real browser");
const passed = (name: string) => is(name, lines.some((line) => line === `ok    ${name}`), true);
passed("a saved switch offers Undo, and the switch says on");
passed("a confirmed Undo: its button is gone and the focus is on the switch, not the page's body (2.4.3)");
passed("both presses went to the route: on, then the exact reverse");
passed("an unconfirmed reply: the switch is gone, the card asks for a reload, and the focus is on Reload (2.4.3)");
passed("the person moved the focus while it was saved: it stays where they put it");
passed("a refresh with nothing pressed draws the saved state");
passed("a refresh that confirms the card's own save keeps the card's state and its Undo");
passed("a refresh with another tab's saved state: the card shows it, says it, and offers no Undo of the old one");
passed("no page error");
is("the browser check ran to its end with nothing failed", [run.status, lines.some((line) => line.startsWith("FAIL")), lines.at(-1)], [0, false, "9/9 passed"]);
done();
