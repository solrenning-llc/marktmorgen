/**
 * 485 [IT2], unit 2 (added 10 November 2026): the confirmations unit 0 kept,
 * because what they do cannot be undone, ask on the page itself, never in the
 * browser's own dialog, with what happens written on the buttons: deleting
 * the Path answers, removing the recovery address and removing a passkey.
 * Their questions, their effect on the server and the first button are as
 * before; only the second press acts, and the safe choice takes the focus.
 *
 * What fails here: one of the three going back to window.confirm or acting on
 * its first press; a question that no longer says what it costs; a browser
 * confirmation added anywhere else in the studio's components beyond the ones
 * unit 0 left for their own units.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathOnboarding, FORGET_PATH_QUESTION } from "@/components/path-onboarding";
import { RecoveryAddressManager, REMOVE_RECOVERY_QUESTION } from "@/components/recovery-address-manager";
import { PasskeyManager } from "@/components/passkey-manager";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");

part("The Path");
const path = flat("components/path-onboarding.tsx");
is("asked on the page, through the shared ConfirmAction, never the browser's dialog", [path.includes("window.confirm"), path.includes("<ConfirmAction"), path.includes('yes="Yes, delete my Path"'), path.includes("question={FORGET_PATH_QUESTION}")], [false, true, true, true]);
is("the same question as before: what goes and what stays", FORGET_PATH_QUESTION, "Delete your Path answers, check-in days and saved level? Your store and orders stay as they are.");
is("the same request on the second press, never while one is already going", path.includes("onConfirm={()=>locked.current?undefined:request({action:\"forget\"})}"), true);
const answers = { goalCents: 0, goalCurrency: "USD", skills: "Baking", subject: "Bread", minutes: 30, audience: "none" } as never;
const drawn = renderToStaticMarkup(createElement(PathOnboarding, { currency: "USD", answers }));
is("first, only its button, as before; the question is not shown yet", [drawn.includes(">Delete your Path</button>"), drawn.includes(FORGET_PATH_QUESTION), drawn.includes("Yes, delete my Path")], [true, false, false]);
is("and no Path to delete, no button", renderToStaticMarkup(createElement(PathOnboarding, { currency: "USD" })).includes("Delete your Path"), false);

part("The recovery address");
const recovery = flat("components/recovery-address-manager.tsx");
is("asked on the page, never the browser's dialog", [recovery.includes("window.confirm"), recovery.includes("onClick={() => setAsking(true)}"), recovery.includes('data-recovery-remove-ask=""')], [false, true, true]);
is("the same question as before: what removing it costs", REMOVE_RECOVERY_QUESTION, "Remove your recovery address? Losing the inbox you log in with would then need a passkey to get back in.");
is(
  "the buttons say what happens; the safe one takes the focus; the question names the group",
  [recovery.includes("Remove recovery address </button>"), recovery.includes('autoFocus onClick={keepAsking}> Keep it </button>'), recovery.includes('aria-labelledby="account-recovery-remove-ask"'), recovery.includes('<span id="account-recovery-remove-ask" className="w-full font-semibold text-ink"> {REMOVE_RECOVERY_QUESTION} </span>')],
  [true, true, true, true],
);
is("only the second press removes it, as the server always did", recovery.includes('void run({ action: "remove" }, () => { removed = true; setShown(""); toast("Recovery address removed."); })'), true);
is(
  "the focus is never dropped to the page (2.4.3): Keep and Escape give it back to Remove; after the request, to the heading once the address is gone, else to Remove",
  [
    recovery.includes("const keepAsking = () => { setAsking(false); requestAnimationFrame(() => removeButton.current?.focus()); };"),
    recovery.includes('onKeyDown={(e) => { if (e.key === "Escape") keepAsking(); }}'),
    recovery.includes("requestAnimationFrame(() => (removed ? heading.current : removeButton.current)?.focus());"),
    recovery.includes('<h3 ref={heading} tabIndex={-1} id="account-recovery-title"'),
    recovery.includes("<button ref={removeButton} type=\"button\""),
  ],
  [true, true, true, true, true],
);
const withAddress = renderToStaticMarkup(createElement(RecoveryAddressManager, { shown: "m•••@e•••.com" }));
is("first, only its Remove, as before; the question is not shown yet", [/>\s*Remove\s*<\/button>/.test(withAddress), withAddress.includes(REMOVE_RECOVERY_QUESTION)], [true, false]);
is("and without an address, no Remove", /Remove\s*<\/button>/.test(renderToStaticMarkup(createElement(RecoveryAddressManager, { shown: "" }))), false);

part("A passkey");
const passkeys = flat("components/passkey-manager.tsx");
is("asked in its own row, never the browser's dialog", [passkeys.includes("window.confirm"), passkeys.includes("onClick={() => setAsking(row.id)}"), passkeys.includes('data-passkey-remove-ask=""')], [false, true, true]);
is(
  "the same two questions as before, chosen the same way",
  [passkeys.includes("const removalQuestion = (row: PasskeyRow) => blocked ? `Remove “${row.name}”? You did not log in with a passkey or an app code"), passkeys.includes(": `Remove “${row.name}”? You will no longer be able to log in with it.`;"), passkeys.includes("{removalQuestion(row)}")],
  [true, true, true],
);
is(
  "the buttons say what happens; the safe one takes the focus; the question names the group",
  [passkeys.includes("onClick={() => void remove(row)}> Remove passkey </button>"), passkeys.includes('autoFocus onClick={() => keepAsking(row.id)}> Keep passkey </button>'), passkeys.includes("aria-labelledby={`passkey-remove-${row.id}`}")],
  [true, true, true],
);
is("only the second press sends the removal; the question stays open, busy, until the answer", [passkeys.includes("async function remove(row: PasskeyRow) { setBusy(row.id);"), passkeys.includes('const done = await call({ action: "remove", id: row.id }); setBusy(null); setAsking(null);')], [true, true]);
is(
  "the focus is never dropped to the page (2.4.3): Keep and Escape give it back to the row's Remove; a refusal too; a removal to the heading",
  [
    passkeys.includes("const keepAsking = (id: string) => { setAsking(null); focusLater(() => removeButtons.current[id]); };"),
    passkeys.includes('onKeyDown={(e) => { if (e.key === "Escape") keepAsking(row.id); }}'),
    passkeys.includes("setError(MESSAGES[done.error ?? \"\"] ?? MESSAGES.server_error); focusLater(() => removeButtons.current[row.id]); return; } focusLater(() => heading.current);"),
    passkeys.includes('<h3 ref={heading} tabIndex={-1} id="passkeys-title"'),
    passkeys.includes("ref={(el) => { removeButtons.current[row.id] = el; }}"),
  ],
  [true, true, true, true, true],
);
const rows = [{ id: "pk1", name: "Phone", createdAt: "2026-10-12T00:00:00Z", lastUsedAt: "2026-10-30T00:00:00Z", synced: true }];
const list = renderToStaticMarkup(createElement(PasskeyManager, { initial: rows, fresh: true }));
is("first, only its Remove, as before; the question is not shown yet", [/>\s*Remove\s*<\/button>/.test(list), list.includes("You will no longer be able to log in with it."), list.includes("Remove passkey")], [true, false, false]);

part("The shared ConfirmAction (the Path, and every other caller)");
const confirmAction = flat("components/confirm-action.tsx");
is(
  "when its question closes, by Keep it, Escape or done, the focus goes back to its own button (2.4.3)",
  [
    confirmAction.includes("if (wasAsking.current && !asking) trigger.current?.focus();"),
    confirmAction.includes("<button ref={trigger} type=\"button\""),
    confirmAction.includes('onKeyDown={(e) => { if (e.key === "Escape") setAsking(false); }}'),
  ],
  [true, true, true],
);

part("No browser confirmation comes back elsewhere");
// Left by unit 0 for their own units: routine ones waiting on an undo or the bin (417 [CC1]), and the
// access ones in files other open PRs hold. Each line a file and how many it has today.
const LEFT: Record<string, number> = {
  "components/community-composer.tsx": 1,
  "components/community-events-studio.tsx": 3,
  "components/community-studio.tsx": 3,
  "components/email-studio.tsx": 2,
  // Leaving the page with unsaved changes: once left, nothing is there to undo (unit 0, item 15).
  "components/leave-guard.ts": 1,
  "components/team-manager.tsx": 2,
};
const found: Record<string, number> = {};
for (const name of readdirSync("components")) {
  if (!/\.tsx?$/.test(name)) continue;
  const count = (read(`components/${name}`).match(/window\.confirm\(/g) ?? []).length;
  if (count) found[`components/${name}`] = count;
}
is("the browser's dialog is only where unit 0 left it, no more of it", found, LEFT);

done();
