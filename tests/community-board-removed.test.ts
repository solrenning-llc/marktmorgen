/**
 * The community leaderboard never shows a member the creator removed (Claude 7, 13 November 2026).
 *
 * app/[handle]/community/leaderboard/page.tsx listed the board's top as it was, reading each member's name with
 * readMembers, which returns removed members too: a removed member stayed on the board, by name, for every member to
 * see. The page now lists only boardShown(top, members), which leaves removed members out and numbers the rest.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import * as points from "@/lib/community-points";

type Shown = (top: { key: string; points: number }[], members: Map<string, { removed: boolean }>) => { key: string; points: number }[];
const boardShown = (points as unknown as { boardShown?: Shown }).boardShown;

part("boardShown leaves removed members out");
is("there is a boardShown rule", typeof boardShown, "function");
if (boardShown) {
  const top = [{ key: "a", points: 9 }, { key: "b", points: 7 }, { key: "c", points: 5 }];
  const members = new Map([["a", { removed: false }], ["b", { removed: true }], ["c", { removed: false }]]);
  is("the removed member is not shown, the others keep their order", boardShown(top, members).map((s) => s.key), ["a", "c"]);
  is("a member whose record was not found is still shown, unnamed", boardShown([{ key: "d", points: 1 }], new Map()).map((s) => s.key), ["d"]);
}

part("The leaderboard page lists only what boardShown keeps");
const page = readFileSync("app/[handle]/community/leaderboard/page.tsx", "utf8");
is("the page reads boardShown", /boardShown\(standing\.top, members\)/.test(page), true);
is("and never maps the board's raw top into the list", /standing\.top\.map\(\(s, i\)/.test(page), false);

done();
