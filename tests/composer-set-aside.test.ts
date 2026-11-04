/**
 * Undo in place of "Are you sure?" when another email is opened over
 * unsaved changes (485 [IT2], unit 1, lib/set-aside.ts and
 * components/email-studio.tsx; added 1 November 2026). Checked:
 *
 *   - the steps, walked as a creator walks them (lib/set-aside.ts): changes
 *     set aside; a switch from a clean composer keeps them; a second dirty
 *     switch keeps both; brought back newest first, setting aside what is
 *     unsaved then; a draft deleted since comes back as a new email;
 *   - each step has its own sentence for the live region;
 *   - the composer is wired to them: no browser confirmation, the list
 *     cleared of nothing on send but the restored email not shown again,
 *     the uncertain draft save kept blocked, focus to the email brought
 *     back, leaving the page guarded.
 */
import { readFileSync } from "node:fs";
import { afterSwitch, emailName, setAsideCount, setAsideNote, takeNewest, type SetAsideItem, type SetAsideSnapshot } from "@/lib/set-aside";
import { done, is, part } from "./check";

type Snap = SetAsideSnapshot & { body: string };
type Draft = { id: string };
const snap = (subject: string, draftId = "", body = "text"): Snap => ({ subject, body, draftId, draftSavedAt: draftId ? "2026-11-01T12:00:00Z" : "", savedContent: draftId ? "saved" : "" });
const A = { id: "draft-a" };
const B = { id: "draft-b" };

part("Walked as a creator walks it");
let list: SetAsideItem<Snap, Draft>[] = [];
list = afterSwitch(list, snap("Spring sale", A.id), A);
is("editing A then opening B: A's changes are set aside, with A", list.map((i) => [i.snapshot.subject, i.from?.id]), [["Spring sale", "draft-a"]]);
list = afterSwitch(list, null, B);
is("opening C from an untouched B: A is still set aside", list.length, 1);
list = afterSwitch(list, snap("New course"), null);
is("opening D over changes to a new email: both are kept, newest last", list.map((i) => i.snapshot.subject), ["Spring sale", "New course"]);
const first = takeNewest(list, [A, B])!;
is("bringing back takes the newest", [first.snapshot.subject, first.from, first.rest.length], ["New course", null, 1]);
list = afterSwitch(first.rest, snap("Third one"), B);
is("and sets aside what was unsaved then", list.map((i) => i.snapshot.subject), ["Spring sale", "Third one"]);
const again = takeNewest(list.slice(0, 1), [A]);
is("a draft still there comes back as itself", [again?.from?.id, again?.snapshot.draftId, again?.snapshot.savedContent], ["draft-a", "draft-a", "saved"]);
const gone = takeNewest(list.slice(0, 1), [B]);
is("a draft deleted since comes back as a new email, still unsaved", [gone?.from, gone?.snapshot.draftId, gone?.snapshot.draftSavedAt, gone?.snapshot.savedContent, gone?.snapshot.body], [null, "", "", "", "text"]);
is("nothing set aside: nothing to bring back", takeNewest([], [A]), null);

part("A sentence for each step");
is("set aside", setAsideNote(snap("Spring sale"), null), 'Your unsaved changes to "Spring sale" were set aside.');
is("brought back, with another set aside in turn", setAsideNote(snap("Third one"), snap("Spring sale")), 'Brought back your changes to "Spring sale". Your changes to "Third one" were set aside.');
is("brought back alone", setAsideNote(null, snap("Spring sale")), 'Brought back your changes to "Spring sale".');
is("an email with no subject is named for what it is", emailName(snap("  ")), "the email with no subject yet");
is("a clean switch says nothing new", setAsideNote(null, null), "");
is("the count, singular and plural", [setAsideCount(1), setAsideCount(3)], ["Changes to 1 other email are set aside.", "Changes to 3 other emails are set aside."]);

part("The composer, wired to them");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("no browser question when opening another email", studio.includes("Discard them and open another email?"), false);
is("a switch adds to the list, never replaces it", studio.includes("setSetAside(afterSwitch(rest, kept, open));") && studio.includes("const kept = current?.dirty ? current.snapshot() : null;"), true);
is("bringing back takes the newest, and an email being sent or saved is not switched away from", studio.includes("const newest = takeNewest(setAside, props.drafts);") && /if \(composerState\.current\?\.busy\) return;\s*\/\/ The newest/.test(studio), true);
is("after sending, the email brought back is not shown again", /onDone=\{\(\) => \{[^}]*setRestore\(undefined\);/.test(studio), true);
const content = /const content = JSON\.stringify\(\[([^\]]+)\]\);/.exec(studio)?.[1].split(",").map((x) => x.trim()) ?? [];
const kept = /const snapshot = \(\): ComposerSnapshot => \(\{ ([^}]+) \}\);/.exec(studio)?.[1].split(",").map((x) => x.trim().split(":")[0]) ?? [];
const counted = [...content.filter((x) => x !== "draftSubjectTest"), "testing", "subjectB", "share", "hours", "by", "later", "at", "draftId", "draftSavedAt", "savedContent"];
is("everything that makes the composer unsaved is kept", counted.filter((x) => !kept.includes(x)), []);
is("an uncertain draft save stays blocked when brought back", kept.includes("uncertain") && studio.includes("useState<DraftRow[] | null>(props.restore?.uncertain ? props.savedDrafts : null)"), true);
is("each step's sentence in a polite live region always on the page, with a real button naming the email", studio.includes('<div aria-live="polite" className="mb-4">') && studio.includes("{asideNote || setAsideCount(setAside.length)}") && studio.includes("onClick={bringBack}>{`Bring back ${emailName(setAside.at(-1)!.snapshot)}`}</button>"), true);
is("brought back, the focus goes to the email's subject", studio.includes("if (restored) subjectBox.current?.focus();"), true);
is("leaving the page with something set aside asks first", studio.includes("useLeaveGuard(setAside.length > 0);"), true);
const lib = readFileSync("lib/set-aside.ts", "utf8");
is("the rules store and send nothing", /localStorage|sessionStorage|fetch\(|import /.test(lib.replace(/^\s*\*.*$/gm, "")), false);
done();
