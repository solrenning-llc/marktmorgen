/**
 * Two findings of the AX274 audit on /studio/deals and /studio/team (Claude 4, channel 11/11/2026): the chosen
 * pipeline button's " · N open" and " · view only" were drawn at opacity-80, 5.63:1 against 7:1 (1.4.6); and the
 * team page's scrolling table region had the same name as its section (landmark names must be unique).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The chosen pipeline's counts keep the text's own contrast");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("no opacity on the open count or the view-only words", [board.includes('className="tabular-nums opacity-80"'), board.includes('<span className="opacity-80"> · view only</span>')], [false, false]);

part("The team table's scrolling region has a name of its own");
const team = readFileSync("components/team-manager.tsx", "utf8");
is("the region is named as the table, not as the section", [team.includes('role="region" aria-label="What each role can do"'), team.includes('role="region" aria-label="Table of what each role can do"')], [false, true]);
done();
