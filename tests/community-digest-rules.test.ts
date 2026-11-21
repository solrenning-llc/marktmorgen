/**
 * The weekly community digest's rules (lib/community-digest-rules.ts, 264
 * [CI2] unit 1; added 12 November 2026). Checked, with synthetic posts and
 * events only:
 *
 *   - only a member who asked, is let in and has an address, and only while
 *     the creator offers it;
 *   - only what this member's gate lets them see: false and unread verdicts
 *     both leave the item out; hidden posts never appear;
 *   - the week's most answered posts of others, the creator's announcements,
 *     the next 7 days' events (not cancelled), each capped and in a fixed order;
 *   - an empty week is "skip", an unread list is "unknown", never an empty email;
 *   - the send key is the ISO week, the same for every moment of that week;
 *   - previews keep whole words, and the text has no names of other members
 *     and no urgency words.
 */
import { DIGEST_DAYS, MAX_DISCUSSIONS, MAX_EVENTS, PREVIEW_CHARS, type DigestEvent, type DigestPost, type DigestReader, buildDigest, digestWeek, eventWhen, getsDigest, previewLine } from "@/lib/community-digest-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 15, 0, 0); // Thursday 12 November 2026, 15:00 UTC
const S = NOW / 1000;
const HOUR = 3600;
const base = "https://marktmorgen.com/ana/community";
const reader: DigestReader = { key: "m1", email: "reader@example.com", digest: true, removed: false };

let n = 0;
const post = (over: Partial<DigestPost> = {}): DigestPost => ({
  id: `p${(n += 1)}`,
  title: `Post ${n}`,
  text: "words",
  at: S - 2 * 24 * HOUR,
  kind: "post",
  hid: false,
  a: "m2",
  comments: 1,
  likes: 0,
  canSee: true,
  ...over,
});
const event = (over: Partial<DigestEvent> = {}): DigestEvent => ({
  id: `e${(n += 1)}`,
  title: `Event ${n}`,
  start: NOW + 2 * 86_400_000,
  minutes: 60,
  tz: "America/New_York",
  cancelled: false,
  canSee: true,
  ...over,
});
const build = (posts: DigestPost[] | null, events: DigestEvent[] | null, who = reader) => buildDigest({ communityName: "Ana's Studio", base, reader: who, posts, events, now: NOW });
const ids = (d: ReturnType<typeof build>, k: "discussions" | "announcements" | "events") => (d.kind === "send" ? d[k].map((i) => i.id) : d.kind);

part("Only for those who asked, while the creator offers it");
is("asked and offered", getsDigest(true, reader), true);
is("not offered", getsDigest(false, reader), false);
is("did not check the box", getsDigest(true, { ...reader, digest: false }), false);
is("taken out by the creator", getsDigest(true, { ...reader, removed: true }), false);
is("no address", getsDigest(true, { ...reader, email: "" }), false);

part("What this member may see");
{
  const shown = post({ id: "shown" });
  const hidden = post({ id: "hidden", hid: true });
  const notMine = post({ id: "gated", canSee: false });
  const unread = post({ id: "unread", canSee: null });
  const d = build([shown, hidden, notMine, unread], []);
  is("only the post the gate let through", ids(d, "discussions"), ["shown"]);
  const e = build([], [event({ id: "open" }), event({ id: "closed", canSee: false }), event({ id: "unknown", canSee: null })]);
  is("only the event the gate let through", ids(e, "events"), ["open"]);
}

part("The week's facts, capped and in order");
{
  const many = Array.from({ length: 8 }, (_, i) => post({ id: `d${i}`, comments: i + 1, likes: 0 }));
  const tie = [post({ id: "tie-b", comments: 3, likes: 2, at: S - HOUR }), post({ id: "tie-a", comments: 3, likes: 2, at: S - HOUR })];
  const d = build([...many, ...tie], []);
  is(`at most ${MAX_DISCUSSIONS}, most answered first, ties by likes, newer, then id`, ids(d, "discussions"), ["d7", "d6", "d5", "d4", "d3"]);
  const t = build(tie, []);
  is("an equal tie is broken by id, the same every time", ids(t, "discussions"), ["tie-a", "tie-b"]);
  const mine = build([post({ id: "own", a: "m1" }), post({ id: "quiet", comments: 0 }), post({ id: "unread", comments: null })], []);
  is("not the reader's own post, not one nobody answered, not one whose replies could not be read", mine.kind, "skip");
  const old = build([post({ id: "old", at: S - (DIGEST_DAYS + 1) * 24 * HOUR }), post({ id: "future", at: S + HOUR })], []);
  is(`only posts of the last ${DIGEST_DAYS} days`, old.kind, "skip");
  const a = build([post({ id: "ann", kind: "announcement", a: "CREATOR", comments: 0 })], []);
  is("an announcement of the week is listed, answered or not", ids(a, "announcements"), ["ann"]);
  const events = build([], [
    event({ id: "later", start: NOW + 6 * 86_400_000 }),
    event({ id: "soon", start: NOW + 3_600_000 }),
    event({ id: "next", start: NOW + 86_400_000 }),
    event({ id: "fourth", start: NOW + 5 * 86_400_000 }),
    event({ id: "gone", start: NOW - 3_600_000 }),
    event({ id: "far", start: NOW + 9 * 86_400_000 }),
    event({ id: "off", start: NOW + 7_200_000, cancelled: true }),
  ]);
  is(`at most ${MAX_EVENTS} events of the next ${DIGEST_DAYS} days, soonest first, none canceled or past`, ids(events, "events"), ["soon", "next", "fourth"]);
}

part("Nothing to say, or nothing known");
is("an empty week is skipped, never an empty email", build([], []).kind, "skip");
is("posts that could not be read: unknown", build(null, []).kind, "unknown");
is("events that could not be read: unknown", build([post()], null).kind, "unknown");

part("Once a week");
{
  is("Thursday 12 November 2026 is in week 46", digestWeek(NOW), "2026-W46");
  is("the Monday and the Sunday of that week give the same key", [digestWeek(Date.UTC(2026, 10, 9)), digestWeek(Date.UTC(2026, 10, 15, 23, 59))], ["2026-W46", "2026-W46"]);
  is("1 January 2027, a Friday, is still in 2026's last week", digestWeek(Date.UTC(2027, 0, 1)), "2026-W53");
  is("31 December 2024, a Tuesday, is in 2025's first week", digestWeek(Date.UTC(2024, 11, 31)), "2025-W01");
  const d = build([post()], []);
  is("the digest carries its week", d.week, "2026-W46");
}

part("Words");
{
  const long = "A really long title that goes on and on about the best way to plan a month of content without burning out";
  const line = previewLine(long, "");
  is("a long title is cut at a word, with an ellipsis", [[...line].length <= PREVIEW_CHARS, line.endsWith("…"), long.startsWith(line.slice(0, -1))], [true, true, true]);
  is("a short title is kept whole", previewLine("Hello there", ""), "Hello there");
  is("no title: the first words of the post", previewLine("  ", "First   line\nsecond"), "First line second");
  is("an event's time is said in its own time zone", eventWhen(Date.UTC(2026, 10, 19, 22, 0), "America/New_York"), "Thu, Nov 19, 5:00 PM EST");
  is("a time zone that cannot be read is said as UTC", eventWhen(Date.UTC(2026, 10, 19, 22, 0), "Not/AZone"), "Thu, Nov 19, 10:00 PM UTC");
  const d = build([post({ id: "x", title: "Launch week notes", comments: 2, likes: 1 }), post({ id: "y", title: "One reply", comments: 1, likes: 0 })], [event({ id: "ev", title: "Live Q&A", start: Date.UTC(2026, 10, 13, 18, 0) })]);
  if (d.kind !== "send") is("a week with posts is sent", d.kind, "send");
  else {
    is("subject names the community, nothing more", d.subject, "This week in Ana's Studio");
    is("replies and likes counted as the feed counts them", d.discussions.map((i) => i.line), ["Launch week notes (2 replies, 1 like)", "One reply (1 reply)"]);
    is("links to the post and the event pages", [d.discussions[0].path, d.events[0].path], [`${base}/post/x`, `${base}/events/ev`]);
    is("the text says why it came", d.text.endsWith("You get this because you asked for a weekly summary of Ana's Studio."), true);
    is("no urgency or scarcity words", /\b(hurry|last chance|only \d+ left|don't miss|act now|limited)\b/i.test(d.text), false);
    is("no member key or address in it", /m2|reader@example\.com/.test(d.text), false);
  }
}

done();
