/**
 * The paused studio screen always leaves a way on, and its browser chrome follows the dark (Codex N1 LOWs on #3561,
 * re-checked NOT FIXED by Codex X6 @618d3c38ca):
 *   - the daily limit stops plan changes, cancellations and downloads, so those are not offered then, but the studio
 *     itself and support still are;
 *   - when the screen's details are not drawn (its own daily count is used), the studio and support are still offered;
 *   - on this dark-ready screen, the browser's theme color is the dark paper when the reader chose dark.
 * Static and pure checks only: the page itself needs a signed-in store.
 */
import { readFileSync } from "node:fs";
import * as darkTokens from "@/lib/dark-tokens";
import * as pausedRules from "@/lib/studio-paused-rules";
import { done, is, part } from "./check";

type Actions = (why: "used" | "pool" | "unknown" | "daily", shown: boolean) => string[];
const actions = (pausedRules as { pausedActions?: Actions }).pausedActions;
const themeColorFor = (darkTokens as { themeColorFor?: (scheme: string | undefined) => string }).themeColorFor;

part("A way on from every pause");
is("the month's figure used: everything that never pauses", actions?.("used", true), ["export", "cancel", "studio", "support"]);
is("the daily limit: not what it limits, but the studio and support", actions?.("daily", true), ["studio", "support"]);
is("the details not drawn: still the studio and support", actions?.("used", false), ["studio", "support"]);
const page = readFileSync("app/studio/paused/page.tsx", "utf8");
is("the page draws its actions from pausedActions, never by hiding the whole block", [page.includes("pausedActions(why, shown)"), page.includes('why === "daily" ? null : (')], [true, false]);
is("support is a real link to the support address", page.includes("href={`mailto:${SUPPORT_EMAIL}`}"), true);

part("The browser chrome in the dark");
is("light, or no choice: white, as the layout says", [themeColorFor?.("light"), themeColorFor?.(undefined)], ["#ffffff", "#ffffff"]);
is("dark: the dark paper", themeColorFor?.("dark"), darkTokens.DARK_TOKENS.paper);
is("the paused screen sets it", page.includes("<DarkThemeColor />"), true);

done();
