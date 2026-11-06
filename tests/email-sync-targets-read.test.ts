/**
 * The email-platform box (components/email-sync-editor.tsx) reads the
 * account's lists when the page opens and after connecting. A read that failed
 * or answered without the lists must say so (CX-123 rule 24): before, a failed
 * opening read left "Reading your account…" in the list box for good, with no
 * word of the failure, and a connect answer without lists was drawn as
 * "Your account has no list yet. Make one there", which sends the creator off
 * to make a list that may already exist.
 *
 * The handlers run as written in the component, with a stubbed fetch.
 */
import { readFileSync } from "node:fs";
import { compile, cutBlock, fetchAnswering, recorder, settle } from "./client-handler";
import { done, is, part } from "./check";

const FILE = "components/email-sync-editor.tsx";
type Target = { id: string; name: string };
// The component's own words for lists not read, passed to its handlers as they read them.
const LISTS_UNREAD = /const LISTS_UNREAD = "([^"]+)";/.exec(readFileSync(FILE, "utf8"))?.[1];

const opening = compile<() => (() => void) | undefined>(
  `const effect = ${cutBlock(FILE, "useEffect(() => {\n    if (!connectedProvider) return;").slice("useEffect(".length)};`,
  ["fetch", "connectedProvider", "setTargets", "setError", "LISTS_UNREAD"],
  "effect",
);

async function open(answer: typeof fetch) {
  const targets = recorder<Target[] | null>();
  const errors = recorder<string | null>();
  opening({ fetch: answer, connectedProvider: "kit", setTargets: targets.set, setError: errors.set, LISTS_UNREAD })();
  await settle();
  await settle();
  return { targets: targets.seen, error: errors.last ?? null };
}

const connecting = compile<(event: { preventDefault: () => void }) => Promise<void>>(
  cutBlock(FILE, "async function connect(event: React.FormEvent) {"),
  ["post", "provider", "key", "setKey", "setReplacing", "setTargets", "setTarget", "toast", "byKey", "setError", "LISTS_UNREAD"],
  "connect",
);

async function connect(data: Record<string, unknown>) {
  const targets = recorder<Target[] | null>();
  const errors = recorder<string | null>();
  await connecting({
    post: async () => data,
    provider: "kit",
    key: "synthetic-key",
    setKey: () => {},
    setReplacing: () => {},
    setTargets: targets.set,
    setTarget: () => {},
    toast: () => {},
    byKey: () => ({ name: "Kit" }),
    setError: errors.set,
    LISTS_UNREAD,
  })({ preventDefault: () => {} });
  return { targets: targets.seen, error: errors.last ?? null };
}

async function main() {
  const lists = [{ id: "t1", name: "Newsletter" }];

  part("Opening read: answers that are what they say");
  const read = await open(fetchAnswering({ ok: true, targets: lists }));
  is("the lists are shown", read.targets, [lists]);
  is("with no error", read.error, null);
  const none = await open(fetchAnswering({ ok: true, targets: [] }));
  is("an account with no list is shown as one", none.targets, [[]]);
  const refused = await open(fetchAnswering({ ok: false, error: "refused", message: "Kit did not accept the key." }, 400));
  is("a refusal shows the platform's words", refused.error, "Kit did not accept the key.");

  part("Opening read: a failure is said, never left as 'Reading your account…'");
  for (const [what, answer] of [
    ["no connection", fetchAnswering(new TypeError("Failed to fetch"))],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
    ["a refusal without words", fetchAnswering({ ok: false, error: "server_error" }, 500)],
    ["an answer without the lists", fetchAnswering({ ok: true })],
  ] as const) {
    const failed = await open(answer);
    is(`${what}: the lists are not shown as empty`, failed.targets.some((t) => Array.isArray(t) && t.length === 0), false);
    is(`${what}: the creator is told they could not be read`, typeof failed.error === "string" && failed.error.includes("could not be read"), true);
  }

  part("Connecting: an answer without the lists is not 'no list yet'");
  const view = { connected: { provider: "kit", target: null } };
  const withLists = await connect({ ok: true, view, targets: lists });
  is("lists that came back are shown (control)", withLists.targets, [lists]);
  const without = await connect({ ok: true, view });
  is("lists that did not come back are not shown as none", without.targets.some((t) => Array.isArray(t) && t.length === 0), false);
  is("and the creator is told they could not be read", typeof without.error === "string" && without.error.includes("could not be read"), true);

  part("The list box does not keep saying it is reading once the read failed");
  is("its placeholder leaves 'Reading your account…' when the lists were not read", readFileSync(FILE, "utf8").includes('targets === null && !connected.target && error !== LISTS_UNREAD ? "Reading your account…"'), true);

  done();
}

void main();
