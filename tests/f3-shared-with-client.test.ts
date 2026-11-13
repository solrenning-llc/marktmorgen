/**
 * 34 [F3], unit 1: what a creator shares with a client from calls, notes and
 * tasks (lib/client-shared.ts). Pure rules, no page and no AI yet. A note or
 * a task is private unless the creator marked it shared with the client in
 * so many words (exactly `sharedWithClient: true`); an absent or unreadable
 * mark never shows it (rule 24). A client sees only their own bookings and
 * what belongs to them, and nothing of another client's ever comes out.
 */
import { CLIENT_SHARED_SECTIONS, shareState, sharedWithClient, type ShareableNote, type ShareableTask, type SharedCallIn } from "@/lib/client-shared";
import { done, is, part } from "./check";

const ANA = "ana@example.com";
const BEN = "ben@example.com";
const S1 = "cs_test_ana0000001";
const S2 = "cs_test_ana0000002";
const S3 = "cs_test_ben0000001";

const call = (session: string, email: string | null, start: number, extra: Record<string, unknown> = {}): SharedCallIn =>
  ({ session, email, start, end: start + 1_800_000, title: `Call ${session.slice(-1)}`, ...extra }) as SharedCallIn;
const CALLS: SharedCallIn[] = [call(S2, ANA, 2_000), call(S1, "  Ana@Example.com ", 1_000), call(S3, BEN, 1_500)];

const note = (id: string, about: unknown, session: unknown, shared: unknown, at = 10, text = `note ${id}`): ShareableNote =>
  ({ id, at, by: "owner@example.com", text, about, session, sharedWithClient: shared }) as ShareableNote;
const task = (id: string, about: unknown, session: unknown, shared: unknown, extra: Record<string, unknown> = {}): ShareableTask =>
  ({ id, text: `task ${id}`, due: "", assignee: "sam@example.com", done: false, createdAt: 5, doneAt: 0, about, session, sharedWithClient: shared, ...extra }) as ShareableTask;

const view = (input: Parameters<typeof sharedWithClient>[0]) => {
  const out = sharedWithClient(input);
  return out.ok ? { calls: out.calls.map((c) => c.session), notes: out.notes.map((n) => n.id), tasks: out.tasks.map((t) => t.id) } : out;
};

part("The share mark: only an exact true shares");
is("true is shared", shareState(true), "shared");
is("false is private", shareState(false), "private");
is("absent is unknown, not private and not shared", shareState(undefined), "unknown");
is("null is unknown", shareState(null), "unknown");
is('"true" (a string) is unknown', shareState("true"), "unknown");
is("1 is unknown", shareState(1), "unknown");
is('"shared" is unknown', shareState("shared"), "unknown");
is("an object is unknown", shareState({ shared: true }), "unknown");

part("A note is private unless the creator marked it shared");
is(
  "only the marked note shows; unmarked, false and odd marks never do",
  view({
    client: ANA,
    calls: CALLS,
    notes: [
      note("aaaa0001", ANA, S1, true),
      note("aaaa0002", ANA, S1, undefined),
      note("aaaa0003", ANA, S1, false),
      note("aaaa0004", ANA, S1, "true"),
      note("aaaa0005", ANA, S1, 1),
      note("aaaa0006", ANA, S1, null),
    ],
    tasks: [],
  }),
  { calls: [S1, S2], notes: ["aaaa0001"], tasks: [] },
);
{
  const bare = { id: "aaaa0007", at: 1, by: "owner@example.com", text: "kept as notes are kept today" } as ShareableNote;
  is("a note as kept today (no mark, no booking) never shows", view({ client: ANA, calls: CALLS, notes: [bare], tasks: [] }), { calls: [S1, S2], notes: [], tasks: [] });
}

part("A task with an unknown or absent mark never shows (rule 24)");
is(
  "only the marked task shows",
  view({
    client: ANA,
    calls: CALLS,
    notes: [],
    tasks: [task("t000000001", ANA, S2, true), task("t000000002", ANA, S2, undefined), task("t000000003", ANA, S2, "yes"), task("t000000004", ANA, S2, false)],
  }),
  { calls: [S1, S2], notes: [], tasks: ["t000000001"] },
);
is(
  "a malformed task (bad id, no words) never shows even when marked",
  view({ client: ANA, calls: CALLS, notes: [], tasks: [task("BAD", ANA, S2, true), task("t000000005", ANA, S2, true, { text: "   " })] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "a malformed note (bad id, no words, not an object) never shows even when marked",
  view({ client: ANA, calls: CALLS, notes: [note("zz", ANA, S1, true), note("aaaa0008", ANA, S1, true, 10, "  "), null as unknown as ShareableNote], tasks: [] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);

part("A client sees only items of their own bookings");
is(
  "Ana's view: her two calls, never Ben's",
  view({ client: ANA, calls: CALLS, notes: [], tasks: [] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "Ben's view: his one call",
  view({ client: BEN, calls: CALLS, notes: [], tasks: [] }),
  { calls: [S3], notes: [], tasks: [] },
);
is(
  "a shared note on Ben's booking is not Ana's, even if it says it is about her",
  view({ client: ANA, calls: CALLS, notes: [note("aaaa0009", ANA, S3, true)], tasks: [task("t000000006", ANA, S3, true)] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "a shared note on Ana's booking but about Ben is not shown to Ana",
  view({ client: ANA, calls: CALLS, notes: [note("aaaa0010", BEN, S1, true)], tasks: [task("t000000007", BEN, S1, true)] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "a shared item with no booking, or a booking that is not hers, never shows",
  view({
    client: ANA,
    calls: CALLS,
    notes: [note("aaaa0011", ANA, undefined, true), note("aaaa0012", ANA, "cs_test_nobody00001", true), note("aaaa0013", ANA, "", true)],
    tasks: [task("t000000008", ANA, null, true), task("t000000009", ANA, 42, true)],
  }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "an item with no person it is about never shows",
  view({ client: ANA, calls: CALLS, notes: [note("aaaa0014", undefined, S1, true)], tasks: [task("t000000010", null, S1, true)] }),
  { calls: [S1, S2], notes: [], tasks: [] },
);
is(
  "a booking with no address is nobody's",
  view({ client: ANA, calls: [call("cs_test_noaddr00001", null, 1)], notes: [note("aaaa0015", ANA, "cs_test_noaddr00001", true)], tasks: [] }),
  { calls: [], notes: [], tasks: [] },
);
is(
  "a booking read twice under two addresses is nobody's (no guess which)",
  view({ client: ANA, calls: [call(S1, ANA, 1), call(S1, BEN, 1)], notes: [note("aaaa0016", ANA, S1, true)], tasks: [] }),
  { calls: [], notes: [], tasks: [] },
);
is(
  "a booking read twice under the same address shows once",
  view({ client: ANA, calls: [call(S1, ANA, 1), call(S1, "ANA@example.com", 1)], notes: [], tasks: [] }),
  { calls: [S1], notes: [], tasks: [] },
);
is(
  "a session that is not a checkout reference is not a booking",
  view({ client: ANA, calls: [call("pi_123", ANA, 1)], notes: [note("aaaa0017", ANA, "pi_123", true)], tasks: [] }),
  { calls: [], notes: [], tasks: [] },
);

part("The output never carries another client's data, nor the team's");
{
  const out = sharedWithClient({
    client: ANA,
    calls: [
      call(S1, ANA, 1_000, { name: "Ana", answers: [{ q: "x", a: "y" }], amount: 9_900, hosts: ["h1"], claim: "c", lead: "aff", pi: "pi_1", due: null, cancel: null, buyerTz: "UTC", moves: 0, currency: "usd" }),
      call(S3, BEN, 1_500, { name: "Ben" }),
    ],
    notes: [note("aaaa0018", ANA, S1, true, 20, "Bring the workbook"), note("aaaa0019", BEN, S3, true, 30, "Ben's secret")],
    tasks: [task("t000000011", ANA, S1, true, { due: "2026-12-01" }), task("t000000012", BEN, S3, true)],
  });
  is("ok", out.ok, true);
  if (out.ok) {
    is("calls carry only session, start, end and title", out.calls, [{ session: S1, start: 1_000, end: 1_000 + 1_800_000, title: "Call 1" }]);
    is("notes carry only id, booking, time and words (not who on the team wrote it)", out.notes, [{ id: "aaaa0018", session: S1, at: 20, text: "Bring the workbook" }]);
    is("tasks carry only id, booking, words, date and done (not the teammate)", out.tasks, [{ id: "t000000011", session: S1, text: "task t000000011", due: "2026-12-01", done: false }]);
    const flat = JSON.stringify(out);
    is("nothing of Ben anywhere", [/ben/i.test(flat), flat.includes(S3)], [false, false]);
    is("no address at all, not even the client's own", flat.includes("@"), false);
  }
  is("the sections the portal may show, in order", CLIENT_SHARED_SECTIONS, ["calls", "notes", "tasks"]);
}

part("Order: calls by time, notes newest first, tasks open before done");
is(
  "ordered",
  view({
    client: ANA,
    calls: CALLS,
    notes: [note("aaaa0020", ANA, S1, true, 5), note("aaaa0021", ANA, S2, true, 50)],
    tasks: [task("t000000013", ANA, S1, true, { done: true, doneAt: 9 }), task("t000000014", ANA, S2, true)],
  }),
  { calls: [S1, S2], notes: ["aaaa0021", "aaaa0020"], tasks: ["t000000014", "t000000013"] },
);
is("a task taken away is gone: the view reads the tasks as they are now", view({ client: ANA, calls: CALLS, notes: [], tasks: [] }), { calls: [S1, S2], notes: [], tasks: [] });

part("An unknown client or an unreadable list shows nothing, and says so (rule 24)");
is("no client address", sharedWithClient({ client: "", calls: CALLS, notes: [], tasks: [] }), { ok: false, reason: "client" });
is("a client that is not an address", sharedWithClient({ client: "ana", calls: CALLS, notes: [], tasks: [] }), { ok: false, reason: "client" });
is("a client that is not text", sharedWithClient({ client: null as unknown as string, calls: CALLS, notes: [], tasks: [] }), { ok: false, reason: "client" });
is("calls not a list", sharedWithClient({ client: ANA, calls: null as unknown as SharedCallIn[], notes: [], tasks: [] }), { ok: false, reason: "unreadable" });
is("notes not a list", sharedWithClient({ client: ANA, calls: CALLS, notes: "x" as unknown as ShareableNote[], tasks: [] }), { ok: false, reason: "unreadable" });
is("tasks not a list", sharedWithClient({ client: ANA, calls: CALLS, notes: [], tasks: undefined as unknown as ShareableTask[] }), { ok: false, reason: "unreadable" });
is(
  "a call that cannot be read (no session, odd address) makes the bookings unknown, never fewer",
  sharedWithClient({ client: ANA, calls: [...CALLS, { start: 1 } as unknown as SharedCallIn], notes: [], tasks: [] }),
  { ok: false, reason: "unreadable" },
);
is(
  "a call whose address is not text is unreadable",
  sharedWithClient({ client: ANA, calls: [call(S1, 7 as unknown as string, 1)], notes: [], tasks: [] }),
  { ok: false, reason: "unreadable" },
);
is(
  "a call with no real time is unreadable",
  sharedWithClient({ client: ANA, calls: [call(S1, ANA, Number.NaN)], notes: [], tasks: [] }),
  { ok: false, reason: "unreadable" },
);
is("a client with no bookings sees nothing", view({ client: "cara@example.com", calls: CALLS, notes: [note("aaaa0022", "cara@example.com", S1, true)], tasks: [] }), { calls: [], notes: [], tasks: [] });

done();
