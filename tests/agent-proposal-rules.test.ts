/**
 * 631 [AA1] step (c), unit 2: nothing an agent prepares is carried out
 * without the creator's confirmation, a stale preview is never applied,
 * execute changes go one at a time, and undo puts back exactly what was there
 * without erasing a later change (lib/agent-proposal-rules.ts). Pure rules,
 * synthetic values only.
 */
import {
  BATCH_MAX,
  HISTORY_DAYS,
  HISTORY_MAX,
  PROPOSAL_MAX_BYTES,
  UNDO_DAYS,
  WAITING_DAYS,
  WAITING_MAX,
  type Book,
  type Json,
  type ProposalKind,
  canonical,
  decline,
  emptyBook,
  planConfirm,
  planUndo,
  propose,
  recordDone,
  recordUndone,
  sameValue,
  tidy,
} from "@/lib/agent-proposal-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 17, 0, 0);
const faq: ProposalKind = { name: "page.faq", scope: "draft", undo: true, maxBytes: 10_000 };
const look: ProposalKind = { name: "page.look", scope: "draft", undo: true, maxBytes: 10_000 };
const send: ProposalKind = { name: "email.send", scope: "execute", undo: false, maxBytes: 10_000 };
const kinds = new Map([faq, look, send].map((k) => [k.name, k]));
const asked = { by: "mcp" as const, who: "key_synthetic01" };

/** A store held in memory: what each kind and target holds now. */
const world = new Map<string, Json>();
const at = (kind: string, target: string) => world.get(`${kind}|${target}`) ?? null;
const set = (kind: string, target: string, value: Json) => world.set(`${kind}|${target}`, value);
const now = (p: { kind: string; target: string }) => at(p.kind, p.target);

/** Carries out a confirmation the way the store layer will: plan, apply, record. */
function confirm(book: Book, ids: string[], when: number) {
  const plan = planConfirm(book, ids, kinds, now, when);
  let next = book;
  for (const p of plan.apply) {
    set(p.kind, p.target, p.after);
    next = recordDone(next, p, kinds.get(p.kind)!, "owner@example.com", when);
  }
  return { plan, book: next };
}

function must<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(`expected ok, got ${JSON.stringify(value)}`);
  return value as Extract<T, { ok: true }>;
}

part("Equal values read the same whatever the key order");
is("canonical sorts keys", canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
is("same value, other order", sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
is("different values differ", sameValue({ a: 1 }, { a: "1" }), false);

part("Proposing changes nothing in the store");
set("page.faq", "", [{ q: "Old?", a: "Old." }]);
let book = emptyBook();
const first = must(propose(book, faq, { id: "p1", target: "", before: at("page.faq", ""), after: [{ q: "New?", a: "New." }], asked }, T0));
book = first.book;
is("the store still holds the old value", at("page.faq", ""), [{ q: "Old?", a: "Old." }]);
is("one proposal waits", book.waiting.map((p) => p.id), ["p1"]);
is("a change to nothing is refused", propose(book, faq, { id: "x", target: "", before: 1, after: 1, asked }, T0), { ok: false, error: "no_change" });
is("a change past its kind's size is refused", propose(book, { ...faq, maxBytes: 20 }, { id: "x", target: "a", before: "", after: "x".repeat(30), asked }, T0), { ok: false, error: "too_big" });
is("a kind above the ceiling is refused", propose(book, { ...faq, maxBytes: PROPOSAL_MAX_BYTES + 1 }, { id: "x", target: "a", before: 0, after: 1, asked }, T0), { ok: false, error: "bad_kind" });

const second = must(propose(book, faq, { id: "p2", target: "", before: at("page.faq", ""), after: [{ q: "Newer?", a: "Newer." }], asked }, T0 + 1000));
is("a newer proposal for the same thing replaces the waiting one", [second.replaced, second.book.waiting.map((p) => p.id)], ["p1", ["p2"]]);
book = second.book;

part("Confirmation carries out only what is waiting and still matches");
is("an unknown id is refused", planConfirm(book, ["nope"], kinds, now, T0).refused, [{ id: "nope", why: "unknown" }]);
is("the replaced proposal cannot be confirmed", planConfirm(book, ["p1"], kinds, now, T0).refused, [{ id: "p1", why: "unknown" }]);
let step = confirm(book, ["p2"], T0 + 2000);
book = step.book;
is("confirmed: the store holds the new value", at("page.faq", ""), [{ q: "Newer?", a: "Newer." }]);
is("it left the waiting list", book.waiting.length, 0);
is("the history says who asked, who confirmed and when", [book.history[0].id, book.history[0].asked, book.history[0].confirmed], ["p2", asked, { who: "owner@example.com", at: T0 + 2000 }]);
is("confirming twice does nothing", confirm(book, ["p2"], T0 + 3000).plan.refused, [{ id: "p2", why: "unknown" }]);

set("page.look", "", { theme: "light" });
book = must(propose(book, look, { id: "p3", target: "", before: at("page.look", ""), after: { theme: "dark" }, asked }, T0)).book;
set("page.look", "", { theme: "sepia" }); // the creator changed it meanwhile
step = confirm(book, ["p3"], T0 + 4000);
is("a preview the store no longer matches is refused", step.plan.refused, [{ id: "p3", why: "changed_since" }]);
is("and the creator's own change stays", at("page.look", ""), { theme: "sepia" });

part("Waiting proposals expire");
book = must(propose(emptyBook(), look, { id: "old", target: "x", before: null, after: 1, asked }, T0)).book;
is("still waiting just before WAITING_DAYS", planConfirm(book, ["old"], kinds, now, T0 + WAITING_DAYS * DAY - 1).apply.map((p) => p.id), ["old"]);
is("gone at WAITING_DAYS", planConfirm(book, ["old"], kinds, now, T0 + WAITING_DAYS * DAY).refused, [{ id: "old", why: "unknown" }]);

part("Batches: drafts together, execute one at a time");
book = emptyBook();
for (let i = 0; i < 3; i += 1) book = must(propose(book, look, { id: `d${i}`, target: `t${i}`, before: null, after: i + 1, asked }, T0)).book;
book = must(propose(book, send, { id: "e1", target: "email1", before: null, after: { send: true }, asked }, T0)).book;
let plan = planConfirm(book, ["d0", "d1", "d2", "e1"], kinds, now, T0 + 1);
is("drafts in a batch are carried out", plan.apply.map((p) => p.id), ["d0", "d1", "d2"]);
is("an execute change in a batch is refused", plan.refused, [{ id: "e1", why: "one_at_a_time" }]);
is("alone, the execute change goes", planConfirm(book, ["e1"], kinds, now, T0 + 1).apply.map((p) => p.id), ["e1"]);
const many = Array.from({ length: BATCH_MAX + 1 }, (_, i) => `m${i}`);
plan = planConfirm(book, many, kinds, now, T0);
is("a batch past BATCH_MAX is refused whole", [plan.apply.length, plan.refused.every((r) => r.why === "batch_too_large")], [0, true]);
is("an unknown kind is never carried out", planConfirm(must(propose(emptyBook(), { ...look, name: "gone.kind" }, { id: "g", target: "", before: 0, after: 1, asked }, T0)).book, ["g"], kinds, now, T0).refused, [{ id: "g", why: "unknown_kind" }]);

part("At most WAITING_MAX waiting");
book = emptyBook();
for (let i = 0; i < WAITING_MAX; i += 1) book = must(propose(book, look, { id: `w${i}`, target: `w${i}`, before: null, after: i, asked }, T0)).book;
is("one more is refused", propose(book, look, { id: "over", target: "over", before: null, after: 1, asked }, T0), { ok: false, error: "too_many" });
is("replacing a waiting one still works", propose(book, look, { id: "w0b", target: "w0", before: null, after: 99, asked }, T0).ok, true);
is("declined, there is room again", propose(must(decline(book, "w1", T0)).book, look, { id: "over", target: "over", before: null, after: 1, asked }, T0).ok, true);
is("declining an unknown id says so", decline(book, "nope", T0), { ok: false, error: "unknown" });

part("Undo puts back exactly what was there, once");
world.clear();
set("page.faq", "", ["A"]);
book = must(propose(emptyBook(), faq, { id: "u1", target: "", before: ["A"], after: ["B"], asked }, T0)).book;
book = confirm(book, ["u1"], T0).book;
const current = (d: { kind: string; target: string }) => at(d.kind, d.target);
const undo = must(planUndo(book, "u1", current, T0 + DAY));
set("page.faq", "", undo.restore);
book = recordUndone(book, "u1", "owner@example.com", T0 + DAY);
is("the store holds the old value again", at("page.faq", ""), ["A"]);
is("the history shows the undo", book.history[0].undone, { who: "owner@example.com", at: T0 + DAY });
is("it cannot be undone twice", planUndo(book, "u1", current, T0 + DAY), { ok: false, error: "already_undone" });

set("page.faq", "", ["A"]);
book = must(propose(emptyBook(), faq, { id: "u2", target: "", before: ["A"], after: ["B"], asked }, T0)).book;
book = confirm(book, ["u2"], T0).book;
set("page.faq", "", ["C"]); // a later change
is("undo never erases a later change", planUndo(book, "u2", current, T0 + DAY), { ok: false, error: "changed_since" });
set("page.faq", "", ["B"]);
is("past UNDO_DAYS it cannot be undone", planUndo(book, "u2", current, T0 + UNDO_DAYS * DAY), { ok: false, error: "too_old" });

book = must(propose(emptyBook(), send, { id: "u3", target: "e", before: null, after: { send: true }, asked }, T0)).book;
book = confirm(book, ["u3"], T0).book;
is("a kind without undo says so", planUndo(book, "u3", current, T0), { ok: false, error: "cannot_undo" });
is("an unknown entry says so", planUndo(book, "zzz", current, T0), { ok: false, error: "unknown" });

part("The history is bounded");
book = emptyBook();
for (let i = 0; i < HISTORY_MAX + 5; i += 1) {
  const p = must(propose(book, look, { id: `h${i}`, target: `h${i}`, before: null, after: i, asked }, T0 + i)).proposal;
  book = recordDone(book, p, look, "owner@example.com", T0 + i);
}
is("at most HISTORY_MAX entries, newest first", [book.history.length, book.history[0].id], [HISTORY_MAX, `h${HISTORY_MAX + 4}`]);
is("entries past HISTORY_DAYS go", tidy(book, T0 + HISTORY_DAYS * DAY + HISTORY_MAX + 10).history.length, 0);

done();
