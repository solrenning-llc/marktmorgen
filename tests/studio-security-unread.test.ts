/**
 * The studio's Account section never shows a false "two-step login off" or a
 * false "no recovery address" (CX-123 rule 24, app/studio/page.tsx). When
 * twoStepStatus or recoveryAddress cannot be read, the read is unknown (null),
 * not off or none: where the managers would be, the studio says the two could
 * not be read just now, and offers neither "Turn on" nor "Add" on a guess.
 * The page still renders; with an address and nothing kept, they read as off
 * and none as before.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/page.tsx", "utf8");
const NOTICE = "Your two-step login and recovery address could not be read just now.";

part("a failed read is unknown, never off or none");
is("twoStepStatus is not caught as off", /twoStepStatus\(email\)\.catch\(\(\) => \(\{ on: false/.test(page), false);
is("recoveryAddress is not caught as none", /recoveryAddress\(email\)[^\n]*\.catch\(\(\) => ""\)/.test(page), false);
is("both are caught as unknown", [/twoStepStatus\(email\)\.catch\(\(\) => null\)/.test(page), /recoveryAddress\(email\)[^\n]*\.catch\(\(\) => null\)/.test(page)], [true, true]);

part("the studio says so where the managers are");
const managers = [...page.matchAll(/<RecoveryAddressManager /g)].map((m) => m.index ?? 0);
is("two places show the managers", managers.length, 2);
is(
  "each is drawn only when both were read, with the notice otherwise",
  managers.map((at) => {
    const before = page.slice(Math.max(0, at - 400), at);
    return /securityUnread \?/.test(before) && before.includes(NOTICE);
  }),
  [true, true],
);
is("the notice says nothing changed and how to try again", page.includes(`${NOTICE} Nothing was changed; reload the page in a moment.`), true);
is("no email still reads as off and none", [page.includes('Promise.resolve({ on: false, since: 0, codesLeft: 0, reset: 0, backup: "" })'), page.includes(': Promise.resolve(""),')], [true, true]);
done();
