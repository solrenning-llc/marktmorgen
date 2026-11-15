/**
 * The email-platform box (components/email-sync-editor.tsx) reads the
 * account's lists when the page opens, after connecting and on "Refresh list".
 * A read that failed or answered without the lists must say so (CX-123 rule
 * 24): before, a failed opening read left "Reading your account…" in the list
 * box for good, with no word of the failure, and a connect answer without
 * lists was drawn as "Your account has no list yet. Make one there", which
 * sends the creator off to make a list that may already exist.
 *
 * The list box's own words come from the lists read alone, never from the
 * error line: a refusal with the platform's words (400), a per-minute limit
 * with its reason (429), a Refresh that fails, or a Test or Save that clears
 * the error must not bring "Reading your account…" back once the read ended.
 *
 * The handlers and the box's words run as written in the component, with a
 * stubbed fetch and a stubbed screen.
 */
import { readFileSync } from "node:fs";
import { compile, cutBlock, fetchAnswering, settle } from "./client-handler";
import { done, is, part } from "./check";

const FILE = "components/email-sync-editor.tsx";
const SOURCE = readFileSync(FILE, "utf8");
type Target = { id: string; name: string };
type Screen = { targets: Target[] | null; error: string | null; listsRead: string };
type Ref = { current: number };
// The component's own words for lists not read, passed to its handlers as they read them.
const LISTS_UNREAD = /const LISTS_UNREAD = "([^"]+)";/.exec(SOURCE)?.[1];
const READING = "Reading your account…";
const MESSAGES = { server_error: "Something went wrong on our side. Try again in a moment." };
const KIT = { name: "Kit", target: "form" };

/** A screen with the component's starting state, and setters that take a value or an update, as React's do. */
function screen() {
  const now: Screen = { targets: null, error: null, listsRead: "reading" };
  const setter =
    <K extends keyof Screen>(name: K) =>
    (value: Screen[K] | ((was: Screen[K]) => Screen[K])) => {
      now[name] = typeof value === "function" ? (value as (was: Screen[K]) => Screen[K])(now[name]) : value;
    };
  // The component's count of list reads (a ref), one per screen, as React keeps one per mounted box.
  const readNo: Ref = { current: 0 };
  return { now, readNo, setTargets: setter("targets"), setError: setter("error"), setListsRead: setter("listsRead") };
}
type Live = ReturnType<typeof screen>;

// The list box's first line, as the component writes it between <option value="" disabled> and </option>.
const optionAt = SOURCE.indexOf('<option value="" disabled>');
const optionText = SOURCE.slice(optionAt + '<option value="" disabled>'.length, SOURCE.indexOf("</option>", optionAt)).trim();
if (optionAt < 0 || !optionText.startsWith("{") || !optionText.endsWith("}")) throw new Error(`${FILE}: the list box's first line was not found`);
const BOX_NAMES = ["targets", "connected", "error", "info", "LISTS_UNREAD", "listsRead"];
const firstLine = compile<string>("", BOX_NAMES, optionText.slice(1, -1));
// The status line under the box when the lists were not read: `const listsNote = …;` in the component.
const noteAt = SOURCE.indexOf("const listsNote = ");
const noteLine = noteAt < 0 ? null : compile<string | null>("", BOX_NAMES, SOURCE.slice(noteAt + "const listsNote = ".length, SOURCE.indexOf(";\n", noteAt)));

/** What the list box says, for a connected account with no list saved yet. */
function box(live: Live) {
  const scope = { ...live.now, connected: { provider: "kit", target: null }, info: KIT, LISTS_UNREAD };
  return { first: firstLine(scope), note: noteLine ? noteLine(scope) : null };
}
/** Whether the creator is told the lists could not be read: in the error line or under the box. */
const told = (live: Live) => [live.now.error, box(live).note].some((w) => typeof w === "string" && w.includes("could not be read"));

const opening = compile<() => (() => void) | undefined>(
  `const effect = ${cutBlock(FILE, "useEffect(() => {\n    if (!connectedProvider) return;").slice("useEffect(".length)};`,
  ["fetch", "connectedProvider", "setTargets", "setError", "setListsRead", "LISTS_UNREAD", "readNo"],
  "effect",
);

async function open(answer: typeof fetch, live = screen()) {
  opening({ fetch: answer, connectedProvider: "kit", ...live, LISTS_UNREAD })();
  await settle();
  await settle();
  return live;
}

const posting = compile<(body: Record<string, unknown>, tag: string | null) => Promise<Record<string, unknown> | null>>(
  `${cutBlock(FILE, "const post = useCallback(async (body: Record<string, unknown>, tag: string | null) => {")}, []);`,
  ["useCallback", "setBusy", "setError", "fetch", "setView", "MESSAGES"],
  "post",
);
const post = (live: Live, answer: typeof fetch) =>
  posting({ useCallback: (f: unknown) => f, setBusy: () => {}, setError: live.setError, fetch: answer, setView: () => {}, MESSAGES });
const toast = () => {};

const refreshing = compile<() => Promise<void>>(
  cutBlock(FILE, "async function refresh() {"),
  ["post", "setTargets", "setError", "setListsRead", "toast", "LISTS_UNREAD", "readNo"],
  "refresh",
);
const testing = compile<() => Promise<void>>(cutBlock(FILE, "async function test() {"), ["post", "setError", "toast"], "test");
const saving = compile<(event: { preventDefault: () => void }) => Promise<void>>(
  cutBlock(FILE, "async function save(event: React.FormEvent) {"),
  ["post", "tags", "target", "free", "buyers", "some", "MAX_TAGS", "toast"],
  "save",
);
const refresh = (live: Live, answer: typeof fetch) => refreshing({ post: post(live, answer), ...live, toast, LISTS_UNREAD })();
const test = (live: Live, answer: typeof fetch) => testing({ post: post(live, answer), setError: live.setError, toast })();
const save = (live: Live, answer: typeof fetch) =>
  saving({ post: post(live, answer), tags: {}, target: "t1", free: true, buyers: "all", some: [], MAX_TAGS: 3, toast })({ preventDefault: () => {} });

const connecting = compile<(event: { preventDefault: () => void }) => Promise<void>>(
  cutBlock(FILE, "async function connect(event: React.FormEvent) {"),
  ["post", "provider", "key", "setKey", "setReplacing", "setTargets", "setTarget", "setListsRead", "toast", "byKey", "setError", "LISTS_UNREAD", "readNo"],
  "connect",
);

async function connect(data: Record<string, unknown>) {
  const live = screen();
  await connecting({
    post: async () => data,
    provider: "kit",
    key: "synthetic-key",
    setKey: () => {},
    setReplacing: () => {},
    setTarget: () => {},
    toast: () => {},
    byKey: () => ({ name: "Kit" }),
    ...live,
    LISTS_UNREAD,
  })({ preventDefault: () => {} });
  return live;
}

async function main() {
  const lists = [{ id: "t1", name: "Newsletter" }];
  const offline = () => fetchAnswering(new TypeError("Failed to fetch"));

  part("Opening read: answers that are what they say");
  const before = screen();
  is("while the read is going, the box says it is reading (control)", box(before).first, READING);
  const read = await open(fetchAnswering({ ok: true, targets: lists }));
  is("the lists are shown", read.now.targets, lists);
  is("with no error", read.now.error, null);
  is("and the box asks for a form, with no note under it", box(read), { first: "Choose a form", note: null });
  const none = await open(fetchAnswering({ ok: true, targets: [] }));
  is("an account with no list is shown as one", none.now.targets, []);
  const refused = await open(fetchAnswering({ ok: false, error: "refused", message: "Kit did not accept the key." }, 400));
  is("a refusal shows the platform's words", refused.now.error, "Kit did not accept the key.");

  part("Opening read: a failure is said, never left as 'Reading your account…'");
  for (const [what, answer] of [
    ["no connection", offline()],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
    ["a refusal without words", fetchAnswering({ ok: false, error: "server_error" }, 500)],
    ["an answer without the lists", fetchAnswering({ ok: true })],
    ["the platform down, with its words (400)", fetchAnswering({ ok: false, message: "The platform could not be contacted just now. Try again in a moment." }, 400)],
    ["the per-minute limit, with its reason (429)", fetchAnswering({ ok: false, error: "rate_limited", message: "Too many platform calls this minute. Try again in a minute." }, 429)],
  ] as const) {
    const failed = await open(answer);
    is(`${what}: the lists are not shown as empty`, Array.isArray(failed.now.targets) && failed.now.targets.length === 0, false);
    is(`${what}: the creator is told they could not be read`, told(failed), true);
    is(`${what}: the box no longer says it is reading`, box(failed).first !== READING, true);
  }
  const worded = await open(fetchAnswering({ ok: false, message: "The platform could not be contacted just now. Try again in a moment." }, 400));
  is("the platform's words are the error line", worded.now.error, "The platform could not be contacted just now. Try again in a moment.");
  is("and the note under the box says how to try again", box(worded).note, LISTS_UNREAD);

  part("Later actions do not bring 'Reading your account…' back");
  const refreshFailed = await open(offline());
  await refresh(refreshFailed, fetchAnswering({ ok: false, error: "server_error" }, 500));
  is("a Refresh that fails: the box does not say it is reading", box(refreshFailed).first !== READING, true);
  is("a Refresh that fails: the creator is told", told(refreshFailed), true);
  const tested = await open(offline());
  await test(tested, fetchAnswering({ ok: true, working: true, message: "Kit accepted the key." }));
  is("Test connection clears the error line", tested.now.error, null);
  is("Test connection: the box does not say it is reading", box(tested).first !== READING, true);
  is("Test connection: the note that the lists were not read stays", box(tested).note, LISTS_UNREAD);
  const saved = await open(offline());
  await save(saved, fetchAnswering({ ok: true }));
  is("Save: the box does not say it is reading", box(saved).first !== READING, true);
  is("Save: the note that the lists were not read stays", box(saved).note, LISTS_UNREAD);

  part("Refresh list reads the lists in their exact shape");
  const recovered = await open(offline());
  await refresh(recovered, fetchAnswering({ ok: true, targets: lists }));
  is("a Refresh that reads them shows them, with no note (control)", [recovered.now.targets, box(recovered)], [lists, { first: "Choose a form", note: null }]);
  for (const [what, body] of [
    ["an answer without the lists", { ok: true }],
    ["lists that are not a list", { ok: true, targets: { t1: "Newsletter" } }],
  ] as const) {
    const shown = await open(fetchAnswering({ ok: true, targets: lists }));
    await refresh(shown, fetchAnswering(body));
    is(`${what}: the lists already shown stay`, shown.now.targets, lists);
    is(`${what}: the creator is told they could not be read`, told(shown), true);
  }

  part("Connecting: an answer without the lists is not 'no list yet'");
  const view = { connected: { provider: "kit", target: null } };
  const withLists = await connect({ ok: true, view, targets: lists });
  is("lists that came back are shown (control)", [withLists.now.targets, box(withLists)], [lists, { first: "Choose a form", note: null }]);
  const without = await connect({ ok: true, view });
  is("lists that did not come back are not shown as none", Array.isArray(without.now.targets) && without.now.targets.length === 0, false);
  is("and the creator is told they could not be read", told(without), true);
  is("and the box does not say it is reading", box(without).first !== READING, true);

  part("A late opening read never takes back lists read since (Claude 5's focal return on #2972)");
  // The opening read is still under way when Refresh is pressed (its button is not held by it); Refresh reads the
  // lists; then the opening read comes back with a failure. The lists just read are what is true now.
  const late = screen();
  let answerOpening: (response: Response) => void = () => {};
  const waiting = (() => new Promise<Response>((resolve) => { answerOpening = resolve; })) as typeof fetch;
  opening({ fetch: waiting, connectedProvider: "kit", ...late, LISTS_UNREAD })();
  await refresh(late, fetchAnswering({ ok: true, targets: lists }));
  answerOpening(new Response(JSON.stringify({ ok: false, message: "The platform could not be contacted just now. Try again in a moment." }), { status: 400, headers: { "Content-Type": "application/json" } }));
  await settle();
  await settle();
  is("the lists the Refresh read stay", late.now.targets, lists);
  is("with no note that they could not be read", box(late).note, null);
  is("and no error line from the late read", late.now.error, null);
  const lateGood = screen();
  let answerGood: (response: Response) => void = () => {};
  const waitingGood = (() => new Promise<Response>((resolve) => { answerGood = resolve; })) as typeof fetch;
  opening({ fetch: waitingGood, connectedProvider: "kit", ...lateGood, LISTS_UNREAD })();
  await refresh(lateGood, fetchAnswering({ ok: false, error: "server_error" }, 500));
  answerGood(new Response(JSON.stringify({ ok: true, targets: [{ id: "t0", name: "Old" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await settle();
  await settle();
  is("a late opening read that succeeds after a failed Refresh: the failure the creator was told stays", told(lateGood), true);

  // A connect refused while the opening read is under way is not a read of the lists: the opening read's answer
  // still lands, never leaving "Reading your account…" with no read left to end it (Claude 5, focal return 2).
  const refusedConnect = screen();
  let answerFirst: (response: Response) => void = () => {};
  const waitingFirst = (() => new Promise<Response>((resolve) => { answerFirst = resolve; })) as typeof fetch;
  opening({ fetch: waitingFirst, connectedProvider: "kit", ...refusedConnect, LISTS_UNREAD })();
  await connecting({
    post: async () => null,
    provider: "kit",
    key: "wrong-key",
    setKey: () => {},
    setReplacing: () => {},
    setTarget: () => {},
    toast: () => {},
    byKey: () => ({ name: "Kit" }),
    ...refusedConnect,
    LISTS_UNREAD,
  })({ preventDefault: () => {} });
  answerFirst(new Response(JSON.stringify({ ok: true, targets: lists }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await settle();
  await settle();
  is("a refused connect during the opening read: the opening read's lists are shown", refusedConnect.now.targets, lists);
  is("and the box no longer says it is reading", box(refusedConnect).first !== READING, true);

  part("The note under the box");
  is("the component has a status line for lists not read", noteLine !== null, true);
  is("drawn as a status message", /role="status"[^>]*>\s*\{listsNote\}/.test(SOURCE), true);
  // A live region a screen reader announces is on the page before its words change (4.1.3; the way
  // components/email-studio.tsx keeps its own): never mounted only together with the words.
  is("the status line is always on the page, not mounted with its words", /\{listsNote \? \(/.test(SOURCE), false);

  done();
}

void main();
