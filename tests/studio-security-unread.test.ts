/**
 * The studio's Account section never shows a false "two-step login off" or a
 * false "no recovery address" (CX-123 rule 24, app/studio/page.tsx). When
 * twoStepStatus or recoveryAddress cannot be read, that read is unknown
 * (null), not off or none. Each is judged on its own (review of #2913):
 * - an unread recovery address puts a notice in the recovery section, which
 *   keeps its heading and its #account-recovery anchor, and offers no "Add";
 * - an unread two-step login is main's TwoStepManager `unread` (#2900): the
 *   section keeps its heading and its #two-step anchor, and offers no "Turn on";
 * - a two-step login that was read is drawn whole, so the reset notice's
 *   "press Cancel under Two-step login" always has its Cancel button, and it
 *   never says "There is no recovery address" when the address was unread.
 * The page still renders; with an address and nothing kept, they read as off
 * and none as before.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import * as twoStepModule from "@/components/two-step-manager";
import * as recoveryModule from "@/components/recovery-address-manager";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/page.tsx", "utf8");
const AGAIN = "Nothing was changed; reload the page in a moment.";

function render(element: ReturnType<typeof createElement> | null): string {
  if (!element) return "";
  try {
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, element));
  } catch (error) {
    return `render failed: ${(error as Error).message}`;
  }
}
const parts = twoStepModule as unknown as Record<string, unknown>;
const recoveryParts = recoveryModule as unknown as Record<string, unknown>;
const RecoveryAddressUnread = typeof recoveryParts.RecoveryAddressUnread === "function" ? (recoveryParts.RecoveryAddressUnread as () => null) : null;

part("a failed read is unknown, never off or none");
is("twoStepStatus is not caught as off", /twoStepStatus\(email\)\.catch\(\(\) => \(\{ on: false/.test(page), false);
is("recoveryAddress is not caught as none", /recoveryAddress\(email\)[^\n]*\.catch\(\(\) => ""\)/.test(page), false);
is("both are caught as unknown", [/twoStepStatus\(email\)\.catch\(\(\) => null\)/.test(page), /recoveryAddress\(email\)[^\n]*\.catch\(\(\) => null\)/.test(page)], [true, true]);
is("an unread two-step login holds no reset date, so the top notice is never drawn from a guess", page.includes('const twoStep = twoStepRead ?? { on: false, since: 0, codesLeft: 0, reset: 0, backup: "" };'), true);

part("each read decides its own section, never both together");
is("no single flag hides both managers", /twoStepRead === null \|\| recoveryRead === null/.test(page), false);
is("the notice never says both were unread", page.includes("Your two-step login and recovery address could not be read just now."), false);
is("two places show the managers", [...page.matchAll(/<RecoveryAddressManager /g)].length, 2);
is("each recovery manager gives way only to its own unread read", page.split("{recoveryRead === null ? <RecoveryAddressUnread /> : <RecoveryAddressManager shown={recoveryShown} />}").length - 1, 2);
is(
  "each two-step manager is unread only on its own read, and is told when the address was unread",
  page.split("<TwoStepManager on={twoStep.on} codesLeft={twoStep.codesLeft} reset={lockedTill > 0 ? 0 : twoStep.reset} backup={twoStep.backup || recoveryShown} recoveryUnknown={recoveryRead === null} fresh={freshLogin} locked={lockedTill > 0} unread={twoStepRead === null} />").length - 1,
  2,
);
is("one way only to say two-step login is unread (main's `unread`, no second component)", [page.includes("TwoStepUnread"), "TwoStepUnread" in parts, "TWO_STEP_UNREAD" in parts], [false, false, false]);

part("an unread section keeps its heading and the anchor the links point to");
const twoStepUnread = render(createElement(twoStepModule.TwoStepManager as unknown as (props: Record<string, unknown>) => null, { on: false, codesLeft: 0, reset: 0, backup: "", fresh: true, locked: false, unread: true, recoveryUnknown: true }));
const recoveryUnread = render(RecoveryAddressUnread ? createElement(RecoveryAddressUnread) : null);
is("two-step: anchor, heading, notice", [twoStepUnread.includes('id="two-step"'), twoStepUnread.includes(">Two-step login</h3>"), twoStepUnread.includes("Two-step login could not be read just now")], [true, true, true]);
is("two-step: nothing offered on a guess", /Turn on|Cancel/.test(twoStepUnread), false);
is("recovery: anchor, heading, notice", [recoveryUnread.includes('id="account-recovery"'), recoveryUnread.includes(">Recovery address</h3>"), recoveryUnread.includes(`Your recovery address could not be read just now. ${AGAIN}`)], [true, true, true]);
is("recovery: nothing offered on a guess", /Add|Send|<input/.test(recoveryUnread), false);

part("a two-step login that was read is drawn whole, whatever the address read");
const Manager = twoStepModule.TwoStepManager as unknown as (props: Record<string, unknown>) => null;
const base = { codesLeft: 8, backup: "", fresh: true, locked: false };
const onReset = render(createElement(Manager, { ...base, on: true, reset: Date.UTC(2026, 10, 20), recoveryUnknown: true }));
is("the Cancel the reset notice asks for is there", onReset.includes("Cancel: keep two-step login on"), true);
is("on, address unread: never 'There is no recovery address'", [onReset.includes("There is no recovery address"), onReset.includes("Your recovery address could not be read just now.")], [false, true]);
const offUnknown = render(createElement(Manager, { ...base, on: false, reset: 0, recoveryUnknown: true }));
is("off, address unread: no turn-on that asks for an address that may exist", [offUnknown.includes("Turn on two-step login"), offUnknown.includes('id="two-step-backup"'), offUnknown.includes("could not be read just now")], [false, false, true]);
const onKnown = render(createElement(Manager, { ...base, on: true, reset: 0, recoveryUnknown: false }));
const offKnown = render(createElement(Manager, { ...base, on: false, reset: 0, recoveryUnknown: false }));
is("control, address read as none: said, and the turn-on asks for one", [onKnown.includes("There is no recovery address"), offKnown.includes("Turn on two-step login"), offKnown.includes('id="two-step-backup"')], [true, true, true]);

part("with no email, they still read as off and none");
is("no email still reads as off and none", [page.includes('Promise.resolve({ on: false, since: 0, codesLeft: 0, reset: 0, backup: "" })'), page.includes(': Promise.resolve(""),')], [true, true]);
done();
