/**
 * Members with interests in common, the rules (lib/member-match-rules.ts, 424
 * [MN1] unit 1; added 12 November 2026). Checked, with synthetic members only:
 *
 *   - the list of interests is closed and has nothing sensitive in it;
 *   - interests are refused, never cut or guessed, when not from the list or
 *     too many;
 *   - asked for on both sides: the creator's offer and each member's own
 *     joining; the directory is not joining;
 *   - only joined members with access now, not removed or muted; a block
 *     either way removes the pair; unread verdicts leave the member out and
 *     make an otherwise empty answer "unknown";
 *   - only the shared interests are given back; most shared first, ties in a
 *     stable order of each reader's own; at most MAX_SUGGESTIONS;
 *   - the direct message is offered only where it is allowed now.
 */
import { INTERESTS, MAX_CANDIDATES, MAX_INTERESTS, MAX_SUGGESTIONS, type MatchMember, cleanInterests, interestLabel, sharedWords, suggestFor } from "@/lib/member-match-rules";
import { done, is, part } from "./check";

const member = (key: string, interests: string[], over: Partial<MatchMember> = {}): MatchMember => ({ key, joined: true, interests, removed: false, muted: false, access: true, ...over });
const me = member("me", ["video", "podcasting", "writing"]);
const open = () => false;
const yes = () => true;
const run = (others: MatchMember[], over: Partial<Parameters<typeof suggestFor>[0]> = {}) => suggestFor({ offered: true, me, others, blocked: open, mayMessage: yes, ...over });
const keys = (r: ReturnType<typeof suggestFor>) => (r.kind === "list" ? r.items.map((i) => i.key) : r.kind);

part("A closed list, nothing sensitive");
{
  const words = INTERESTS.map((i) => `${i.id} ${i.label}`).join(" | ").toLowerCase();
  const sensitive = /relig|faith|church|god|pray|spiritual|health|medic|therap|mental|diet|weight|fitness|pregnan|politic|vote|party|activis|sex|gender|lgbt|queer|dating|race|ethnic|nation|immigra|union|disab|age\b|senior|teen|kids|parent|money|invest|crypto|gambl/;
  is("no interest names a sensitive matter", sensitive.test(words) ? words.match(sensitive)?.[0] : null, null);
  is("ids are unique", new Set(INTERESTS.map((i) => i.id)).size, INTERESTS.length);
  is("an id has its words; an unknown id has none", [interestLabel("video"), interestLabel("religion")], ["Video", null]);
}

part("Interests are picked from the list, never typed or cut");
is("from the list, stored in the list's order, each once", cleanInterests(["podcasting", "video", "video"]), { ok: true, interests: ["video", "podcasting"] });
is("a typed word is refused", cleanInterests(["video", "my faith"]), { ok: false, reason: "unknown" });
is("not a list: refused", cleanInterests("video"), { ok: false, reason: "shape" });
is(`more than ${MAX_INTERESTS}: refused, not cut`, cleanInterests(INTERESTS.slice(0, MAX_INTERESTS + 1).map((i) => i.id)), { ok: false, reason: "many" });
is("none is allowed (they can join later)", cleanInterests([]), { ok: true, interests: [] });

part("Asked for on both sides");
is("the creator does not offer it", keys(run([member("a", ["video"])], { offered: false })), "off");
is("the reader has not joined", keys(suggestFor({ offered: true, me: { ...me, joined: false }, others: [member("a", ["video"])], blocked: open, mayMessage: yes })), "not-joined");
is("joined with no interests", keys(suggestFor({ offered: true, me: { ...me, interests: [] }, others: [member("a", ["video"])], blocked: open, mayMessage: yes })), "not-joined");
is("the reader's own access unread: unknown, not 'not joined'", keys(suggestFor({ offered: true, me: { ...me, access: null }, others: [member("a", ["video"])], blocked: open, mayMessage: yes })), "unknown");
is("another member who did not join is never suggested", keys(run([member("a", ["video"], { joined: false })])), "empty");

part("Only who may be suggested");
{
  const r = run([
    member("ok", ["video"]),
    member("gone", ["video"], { removed: true }),
    member("quiet", ["video"], { muted: true }),
    member("lapsed", ["video"], { access: false }),
    member("self", ["video"], { key: "me" }),
    member("none", ["music"]),
  ]);
  is("removed, muted, without access, the reader and those sharing nothing are left out", keys(r), ["ok"]);
  const blocks = (a: string, b: string) => (a === "me" && b === "they-blocked") || (a === "me" && b === "i-blocked");
  is("a block either way removes the pair", keys(run([member("they-blocked", ["video"]), member("i-blocked", ["video"]), member("free", ["video"])], { blocked: blocks })), ["free"]);
  const unread = run([member("unread", ["video"], { access: null }), member("ok", ["video"])]);
  is("an unread verdict leaves that member out and says the list is partial", [keys(unread), unread.kind === "list" && unread.partial], [["ok"], true]);
  is("when that leaves nobody: unknown, not empty", keys(run([member("unread", ["video"], { access: null })])), "unknown");
  is("an unread block too", keys(run([member("x", ["video"])], { blocked: () => null })), "unknown");
  is("nobody shares an interest: empty", keys(run([member("x", ["music"])])), "empty");
}

part("What is said, and in what order");
{
  const r = run([member("one", ["video", "music"]), member("three", ["video", "podcasting", "writing", "music"]), member("two", ["podcasting", "writing"])]);
  is("most shared first", keys(r), ["three", "two", "one"]);
  is("only the shared interests are given back, never the other's others", r.kind === "list" ? r.items[0].shared.map((s) => s.id) : null, ["writing", "video", "podcasting"]);
  is("the words under it", sharedWords([{ label: "Video" }, { label: "Podcasting" }, { label: "Writing" }]), "You both picked Video, Podcasting and Writing.");
  is("two interests", sharedWords([{ label: "Video" }, { label: "Music" }]), "You both picked Video and Music.");
  const many = Array.from({ length: 12 }, (_, i) => member(`m${i}`, ["video"]));
  const first = run(many);
  is(`at most ${MAX_SUGGESTIONS}`, first.kind === "list" ? first.items.length : 0, MAX_SUGGESTIONS);
  is("the same reader gets the same order every time", keys(run(many)), keys(first));
  const other = suggestFor({ offered: true, me: { ...me, key: "someone-else" }, others: many, blocked: open, mayMessage: yes });
  is("another reader gets ties in an order of their own", JSON.stringify(keys(other)) !== JSON.stringify(keys(first)), true);
  const notAlpha = keys(first) as string[];
  is("ties are not simply alphabetical", JSON.stringify(notAlpha) !== JSON.stringify([...notAlpha].sort()), true);
  const dm = run([member("can", ["video"]), member("cannot", ["video"])], { mayMessage: (k) => k === "can" });
  is("a message is offered only where the direct messages allow it now", dm.kind === "list" ? dm.items.map((i) => `${i.key}:${i.canMessage}`).sort() : null, ["can:true", "cannot:false"]);
  const big = run(Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => member(`b${i}`, ["video"])));
  is(`at most ${MAX_CANDIDATES} looked at, and the list says it is partial`, big.kind === "list" && big.partial, true);
}

done();
