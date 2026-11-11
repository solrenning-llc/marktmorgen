/**
 * An unsent inbox answer kept per conversation on this device (complement WG
 * of 487 [IT4], part (a); added 10 November 2026): typed, left and opened
 * again, the words come back; sending removes them; logging out removes all
 * of them; none is older than DRAFT_DAYS or beyond MAX_DRAFTS; nothing ever
 * goes to the server; and with storage blocked or broken, the inbox works as
 * before.
 */
import { readFileSync } from "node:fs";
import { DRAFTS_KEY, DRAFT_DAYS, MAX_DRAFTS, type DraftStorage, type ListedStorage, clearDraft, draftIds, draftScope, forgetDrafts, oldDraftsStuck, forgetEveryonesDrafts, personDrafts, readDraft, saveDraft } from "@/lib/inbox-drafts";
import { MAX_MESSAGE } from "@/lib/inbox-rules";
import { done, is, part } from "./check";

/** A browser's storage, in memory. */
function memory(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}
/** Storage that refuses everything, as in some private windows. */
const blocked: DraftStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const a = "aaaaaaaaaaaa", b = "bbbbbbbbbbbb";
const t0 = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;

part("Typed, left and opened again");
const s = memory();
is("a draft is kept for its conversation", [saveDraft(s, a, "Thanks for writing, I will", t0), readDraft(s, a, t0)], [true, "Thanks for writing, I will"]);
is("another conversation has its own, and none of the first", [saveDraft(s, b, "Hello", t0), readDraft(s, b, t0), readDraft(s, a, t0)], [true, "Hello", "Thanks for writing, I will"]);
is("the list knows which conversations have one", [...draftIds(s, t0)].sort(), [a, b]);
is("typing more replaces it", [saveDraft(s, a, "Thanks for writing, I will look today.", t0 + 1), readDraft(s, a, t0 + 1)], [true, "Thanks for writing, I will look today."]);
is("emptying the box removes it", [saveDraft(s, b, "   ", t0 + 2), draftIds(s, t0 + 2).has(b)], [true, false]);

part("Sent, logged out, or old");
is("sending removes that conversation's draft only", [clearDraft(s, a, t0 + 3), readDraft(s, a, t0 + 3)], [true, ""]);
saveDraft(s, a, "One", t0);
saveDraft(s, b, "Two", t0);
is("logging out removes every draft on the device, at once", [forgetDrafts(s), s.map.has(DRAFTS_KEY), draftIds(s, t0).size], [true, false, 0]);
saveDraft(s, a, "Old", t0);
is(`kept ${DRAFT_DAYS} days after it was last typed, and gone after`, [readDraft(s, a, t0 + DRAFT_DAYS * DAY), readDraft(s, a, t0 + DRAFT_DAYS * DAY + 1)], ["Old", ""]);
saveDraft(s, b, "New", t0 + DRAFT_DAYS * DAY + 1);
is("and an old one is dropped from storage the next time anything is kept", Object.keys(JSON.parse(s.map.get(DRAFTS_KEY) ?? "{}")), [b]);
const many = memory();
for (let n = 0; n <= MAX_DRAFTS; n++) saveDraft(many, String(n).padStart(12, "c"), `Draft ${n}`, t0 + n);
is(`no more than ${MAX_DRAFTS} kept, the oldest going first`, [draftIds(many, t0 + MAX_DRAFTS).size, readDraft(many, "c".repeat(12), t0 + MAX_DRAFTS), readDraft(many, String(MAX_DRAFTS).padStart(12, "c"), t0 + MAX_DRAFTS)], [MAX_DRAFTS, "", `Draft ${MAX_DRAFTS}`]);
const long = memory();
saveDraft(long, a, "x".repeat(MAX_MESSAGE + 500), t0);
is("never longer than an answer may be", readDraft(long, a, t0).length, MAX_MESSAGE);

part("Storage that cannot be trusted");
is("blocked storage: nothing kept, nothing thrown, the box works as before", [saveDraft(blocked, a, "Hi", t0), readDraft(blocked, a, t0), draftIds(blocked, t0).size, forgetDrafts(blocked), clearDraft(blocked, a, t0)], [false, "", 0, false, false]);
is("no storage at all reads as none", [saveDraft(null, a, "Hi", t0), readDraft(null, a, t0), forgetDrafts(null)], [false, "", false]);
const broken = memory();
broken.map.set(DRAFTS_KEY, "{not json");
is("an unreadable entry reads as none, and the next draft replaces it", [readDraft(broken, a, t0), saveDraft(broken, a, "Hi", t0), readDraft(broken, a, t0)], ["", true, "Hi"]);
broken.map.set(DRAFTS_KEY, JSON.stringify({ [a]: { text: 5, at: t0 }, "../evil": { text: "x", at: t0 }, [b]: { text: "Ok", at: t0 + 30 * DAY } }));
is("entries of the wrong shape, an id that is not a conversation's and a time in the future are ignored", [draftIds(broken, t0).size, saveDraft(broken, "../evil", "x", t0)], [0, false]);

part("One person's drafts are theirs alone (review of #3521)");
/** A browser's storage, in memory, with its keys listed. */
function listed(): ListedStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k), get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null };
}
const shared = listed();
const pia = personDrafts(shared, "pia@example.com"), ned = personDrafts(shared, "ned@example.com");
saveDraft(pia, a, "Pia's answer, unsent", t0);
is("a teammate on the same computer sees no draft of another, and gets none in the box", [draftIds(ned, t0).size, readDraft(ned, a, t0), readDraft(pia, a, t0)], [0, "", "Pia's answer, unsent"]);
is("each person's entry is scoped, never named by the address", [[...shared.map.keys()].some((k) => k.includes("pia") || k.includes("@")), [...shared.map.keys()][0] === `${DRAFTS_KEY}:${draftScope("pia@example.com")}`, draftScope(" PIA@example.com") === draftScope("pia@example.com")], [false, true, true]);
is("no person, no drafts", personDrafts(shared, " "), null);
saveDraft(ned, b, "Ned's answer", t0);
shared.setItem("other-app-key", "kept");
is("the sign-in page forgets every person's drafts, and nothing else", [forgetEveryonesDrafts(shared), [...shared.map.keys()]], [true, ["other-app-key"]]);
is("and a storage that refuses is said so, nothing thrown", forgetEveryonesDrafts({ ...blocked, length: 1, key: () => DRAFTS_KEY }), false);

part("Never sent anywhere");
const rules = readFileSync("lib/inbox-drafts.ts", "utf8");
const studio = readFileSync("components/inbox-studio.tsx", "utf8").replace(/\s+/g, " ");
is("the rules read and write only the browser's storage", [/\bfetch\(|XMLHttpRequest|sendBeacon|\/api\//.test(rules), rules.includes("window.localStorage")], [false, true]);
is("the inbox posts what it always posted: a draft is never part of a request", [(studio.match(/post\(\{/g) ?? []).length, studio.includes("drafts") && /post\(\{[^}]*draft/i.test(studio)], [5, false]);

part("In the inbox");
is("typing, a saved reply and a suggestion all keep the draft", [studio.includes("onChange={(e) => typed(e.target.value)}"), studio.includes("if (picked) typed("), studio.includes('typed(String(answer.text ?? ""));')], [true, true, true]);
is("opening a conversation brings its own draft back, never another's", [studio.includes("const kept = readDraft(browserDrafts(me), id); const now = draftIds(browserDrafts(me)); setText(kept);"), studio.includes('setText(""); put(next.conversation); const url')], [true, false]);
is("sending removes it", studio.includes('setText(""); clearDraft(browserDrafts(me), next.conversation.id);'), true);
is("the list says Draft beside a conversation that has one, not beside the one open", studio.includes('{drafted.has(x.id) && c?.id !== x.id ? <span className="tag shrink-0" data-inbox-draft="">Draft</span> : null}'), true);
is(
  "the box says where its words are kept, and a kept or returned draft is read out politely",
  [studio.includes('aria-describedby="inbox-draft-help"'), studio.includes("What you type is kept on this device only, for you, as a draft for this conversation, until you send it, you log out or your session ends, or for 7 days. It is never sent to us."), studio.includes('<p className="sr-only" role="status" aria-live="polite" data-inbox-draft-said="">{draftSaid}</p>'), studio.includes("is kept as a draft on this device.")],
  [true, true, true, true],
);

part("An old draft leaves storage when it is next read, not only when another is kept (Codex U, MEDIUM 1)");
{
  const old = memory();
  saveDraft(old, a, "Old words", t0);
  saveDraft(old, b, "Fresh", t0 + DRAFT_DAYS * DAY);
  is("read after DRAFT_DAYS: not shown", readDraft(old, a, t0 + DRAFT_DAYS * DAY + 1), "");
  is("and its words are gone from storage, the valid one kept", Object.keys(JSON.parse(old.map.get(DRAFTS_KEY) ?? "{}")), [b]);
  const listed = memory();
  saveDraft(listed, a, "Old words", t0);
  is("the list read on opening the inbox purges too, and nothing is left", [draftIds(listed, t0 + DRAFT_DAYS * DAY + 1).size, listed.map.has(DRAFTS_KEY)], [0, false]);
  const fresh = memory();
  saveDraft(fresh, a, "Kept", t0);
  const before = fresh.map.get(DRAFTS_KEY);
  readDraft(fresh, a, t0 + 1);
  is("a read with nothing old writes nothing", fresh.map.get(DRAFTS_KEY), before);
}

part("An old draft the device refuses to remove is said, never claimed gone (Codex U, residual of MEDIUM 1)");
{
  const map = new Map<string, string>();
  let refuse = false;
  const stubborn: DraftStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (refuse) throw new Error("SecurityError");
      map.set(k, String(v));
    },
    removeItem: (k) => {
      if (refuse) throw new Error("SecurityError");
      map.delete(k);
    },
  };
  saveDraft(stubborn, a, "Old words", t0);
  refuse = true;
  const later = t0 + DRAFT_DAYS * DAY + 1;
  is("read after DRAFT_DAYS: not shown", [readDraft(stubborn, a, later), draftIds(stubborn, later).size], ["", 0]);
  is("the words are still on the device, because it refused", map.has(DRAFTS_KEY), true);
  is("and that is known: old words are stuck here", oldDraftsStuck(stubborn, later), true);
  refuse = false;
  is("once the device accepts, the next look removes them and says nothing is stuck", [oldDraftsStuck(stubborn, later), map.has(DRAFTS_KEY)], [false, false]);
  const fine = memory();
  saveDraft(fine, a, "Kept", t0);
  is("a device with nothing old has nothing stuck", oldDraftsStuck(fine, t0 + 1), false);
  is("nor does one with no storage at all, which keeps nothing", oldDraftsStuck(null, t0), false);
  is("the inbox looks once the page is drawn", studio.includes("setCleanFailed(oldDraftsStuck(storage));"), true);
  is("and the help under the box then drops the 7-day promise and says what is left", [studio.includes("cleanFailed ? STUCK :"), studio.includes('const STUCK = "What you type is kept on this device only, for you, as a draft for this conversation, until you send it, you log out or your session ends. This device would not let us remove an older draft, so its words are still stored here; clearing this site\'s data in your browser removes them. Nothing is ever sent to us.";')], [true, true]);
}

part("A draft that could not be kept is said, never claimed kept (Codex U, MEDIUM 2)");
{
  const full: DraftStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  is("a full storage refuses the draft", saveDraft(full, a, "Words", t0), false);
  is("the inbox acts on the refusal", studio.includes("const kept = saveDraft(browserDrafts(me), thread.conversation.id, next); setDraftFailed(!kept && next.trim() !== \"\"); if (kept) setDrafted(draftIds(browserDrafts(me)));"), true);
  is("and says so, politely, once", studio.includes("if (!kept && next.trim() && !draftFailed) setDraftSaid(NOT_KEPT);"), true);
  is("the help under the box no longer says the words are kept", studio.includes("{draftFailed ? NOT_KEPT : \"What you type is kept on this device only"), true);
  is("the words said", studio.includes('const NOT_KEPT = "This device could not keep your answer as a draft, so it is only in this box until you send it.";'), true);
}

part("Logging out");
const signin = readFileSync("app/signin/page.tsx", "utf8");
is("the sign-in page forgets the drafts whatever brought the person there (a log-out, an expired or refused session, log in again)", [signin.includes("<ForgetInboxDrafts />"), signin.includes('status.startsWith("out") ? <ForgetInboxDrafts />')], [true, false]);
is("and forgets every person's, not only one", readFileSync("components/forget-inbox-drafts.tsx", "utf8").includes("forgetEveryonesDrafts(browserStorage());"), true);
const landings = ["app/api/auth/signout/route.ts", "app/api/auth/signout-all/route.ts"].flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\/signin\?status=\$\{([^}]*)\}/g)].map((m) => m[1]));
is("and both log-outs land on it with a status that starts with out", [landings.length, landings.every((expr) => [...expr.matchAll(/"([^"]+)"/g)].every((m) => m[1].startsWith("out")))], [2, true]);

done();
