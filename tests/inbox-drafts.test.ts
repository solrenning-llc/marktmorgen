/**
 * An unsent inbox answer kept per conversation on this device (complement WG
 * of 487 [IT4], part (a); added 10 November 2026): typed, left and opened
 * again, the words come back; sending removes them; logging out removes all
 * of them; none is older than DRAFT_DAYS or beyond MAX_DRAFTS; nothing ever
 * goes to the server; and with storage blocked or broken, the inbox works as
 * before.
 */
import { readFileSync } from "node:fs";
import { DRAFTS_KEY, DRAFT_DAYS, MAX_DRAFTS, type DraftStorage, clearDraft, draftIds, forgetDrafts, readDraft, saveDraft } from "@/lib/inbox-drafts";
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

part("Never sent anywhere");
const rules = readFileSync("lib/inbox-drafts.ts", "utf8");
const studio = readFileSync("components/inbox-studio.tsx", "utf8").replace(/\s+/g, " ");
is("the rules read and write only the browser's storage", [/\bfetch\(|XMLHttpRequest|sendBeacon|\/api\//.test(rules), rules.includes("window.localStorage")], [false, true]);
is("the inbox posts what it always posted: a draft is never part of a request", [(studio.match(/post\(\{/g) ?? []).length, studio.includes("drafts") && /post\(\{[^}]*draft/i.test(studio)], [5, false]);

part("In the inbox");
is("typing, a saved reply and a suggestion all keep the draft", [studio.includes("onChange={(e) => typed(e.target.value)}"), studio.includes("if (picked) typed("), studio.includes('typed(String(answer.text ?? ""));')], [true, true, true]);
is("opening a conversation brings its own draft back, never another's", [studio.includes("const kept = readDraft(browserDrafts(), id); const now = draftIds(browserDrafts()); setText(kept);"), studio.includes('setText(""); put(next.conversation); const url')], [true, false]);
is("sending removes it", studio.includes('setText(""); clearDraft(browserDrafts(), next.conversation.id);'), true);
is("the list says Draft beside a conversation that has one, not beside the one open", studio.includes('{drafted.has(x.id) && c?.id !== x.id ? <span className="tag shrink-0" data-inbox-draft="">Draft</span> : null}'), true);
is(
  "the box says where its words are kept, and a kept or returned draft is read out politely",
  [studio.includes('aria-describedby="inbox-draft-help"'), studio.includes("What you type is kept on this device only, as a draft for this conversation, until you send it or log out. It is never sent to us."), studio.includes('<p className="sr-only" role="status" aria-live="polite" data-inbox-draft-said="">{draftSaid}</p>'), studio.includes("is kept as a draft on this device.")],
  [true, true, true, true],
);

part("Logging out");
const signin = readFileSync("app/signin/page.tsx", "utf8");
is("the page every log-out lands on forgets the drafts", signin.includes('{status.startsWith("out") ? <ForgetInboxDrafts /> : null}'), true);
const landings = ["app/api/auth/signout/route.ts", "app/api/auth/signout-all/route.ts"].flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\/signin\?status=\$\{([^}]*)\}/g)].map((m) => m[1]));
is("and both log-outs land on it with a status that starts with out", [landings.length, landings.every((expr) => [...expr.matchAll(/"([^"]+)"/g)].every((m) => m[1].startsWith("out")))], [2, true]);

done();
