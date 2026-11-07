/**
 * 510 [CK2] unit 1: a short link that changes where it goes on a date the
 * creator picks (lib/short-link-rules.ts, lib/short-links.ts,
 * app/l/[code]/route.ts, app/api/store/short-links/route.ts). Checked:
 *
 *   - the date is at least ten minutes and at most two years away, and the
 *     page it goes to after is the store or one of the store's own products,
 *     never the page it already opens and never an error page;
 *   - before the date the link opens its page, from the date on the other one,
 *     still tagged with the post's name, so its visits and sales stay on the
 *     post's line;
 *   - the CDN never keeps the answer past the date: five minutes and a minute
 *     stale at most, less as the date comes near, and an answer it kept before
 *     the date was set runs out before the soonest date one may set (the
 *     ten-minute floor is longer than five minutes and a minute);
 *   - the change can be taken back, only by the store that owns the link;
 *     before the date a change of where the link goes keeps it, after the date
 *     "Goes to" changes the page the link opens, and taking the date back
 *     keeps the page it opens now;
 *   - every change carries what the panel saw (`seen`: the date it showed and
 *     whether it had passed there); when the server sees otherwise, nothing
 *     is written and it answers "changed" with the links as they are and its
 *     own clock, so the panel shows them and says why;
 *   - every write is a compare-and-swap of the whole record: a record changed
 *     since it was read is never written over, and an unknown reply is never
 *     taken for a write;
 *   - opening a link still reads one record, as before;
 *   - third pre-review: what the panel saw includes where its date goes; the
 *     route reads its clock after the record; a refusal for a change keeps the
 *     date form and what was typed unless the page chosen no longer fits; the
 *     panel starts on the server's clock, says when "Goes to" cancels a date,
 *     says a date that came while it was open, and keeps the focus.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { CACHE_SECONDS, MAX_THEN_MS, MIN_THEN_MS, linkCache, readSeen, readThen, seenAt, targetNow } from "@/lib/short-link-rules";
import * as rules from "@/lib/short-link-rules";
import { addLink, findLink, linkKey, readLinks, retarget, setThen, swapLink } from "@/lib/short-links";
import { GET } from "@/app/l/[code]/route";
import { POST } from "@/app/api/store/short-links/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

/** Opens a link as a visitor does, counting the commands it sends. */
const open = async (code: string) => {
  const real = redis.pipeline;
  const sent: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent.push(...commands.map((c) => String(c[0])));
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    const answer = await GET(new Request(`https://marktmorgen.com/l/${code}`) as never, { params: Promise.resolve({ code }) });
    return { status: answer.status, to: answer.headers.get("location") ?? "", cache: answer.headers.get("cache-control") ?? "", sent };
  } finally {
    redis.pipeline = real;
  }
};

const NOW = 1_800_000_000_000;
const STANDARD = `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`;

async function main(): Promise<void> {
  redis.clear();

  part("The rules: when, and where to after");
  const guide = (id: string) => id === "guide";
  is("the soonest date is ten minutes away", MIN_THEN_MS, 600_000);
  is("a date at least ten minutes away and a page of the store", readThen({ at: NOW + MIN_THEN_MS, target: { kind: "product", id: "guide" } }, guide, NOW), { at: NOW + MIN_THEN_MS, target: { kind: "product", id: "guide" } });
  is("the store itself", readThen({ at: NOW + 86_400_000, target: { kind: "store" } }, guide, NOW), { at: NOW + 86_400_000, target: { kind: "store" } });
  is(
    "refused: past, too soon, too far, not a whole number of milliseconds, not a number",
    [NOW - 1, NOW + MIN_THEN_MS - 1, NOW + MAX_THEN_MS + 1, NOW + 120_000.5, "tomorrow", null].map((at) => readThen({ at, target: { kind: "store" } }, guide, NOW)),
    [null, null, null, null, null, null],
  );
  is(
    "refused: a product of another store, a ready cart, nothing",
    [
      readThen({ at: NOW + 120_000, target: { kind: "product", id: "theirs" } }, guide, NOW),
      readThen({ at: NOW + 120_000, target: { kind: "cart", ids: ["guide", "guide2"] } }, () => true, NOW),
      readThen({ at: NOW + 120_000 }, guide, NOW),
      readThen("store", guide, NOW),
    ],
    [null, null, null, null],
  );
  const link = { name: "spring-sale", place: "instagram", target: { kind: "product", id: "sale" } as const, then: { at: NOW + 600_000, target: { kind: "store" } as const } };
  is("before the date it opens its page; from the date on, the other", [targetNow(link, NOW), targetNow(link, NOW + 599_999), targetNow(link, NOW + 600_000), targetNow({ ...link, then: undefined }, NOW + 9e9)], [
    { kind: "product", id: "sale" },
    { kind: "product", id: "sale" },
    { kind: "store" },
    { kind: "product", id: "sale" },
  ]);
  is("no date: kept five minutes and a minute stale, as before", [linkCache(null, NOW), linkCache({ then: undefined }, NOW)], [STANDARD, STANDARD]);
  is(
    "the CDN never keeps it past the date, with a second of margin for the time the answer takes to leave",
    [linkCache(link, NOW), linkCache(link, NOW + 270_000), linkCache(link, NOW + 400_000), linkCache(link, NOW + 599_000), linkCache(link, NOW + 599_500), linkCache(link, NOW + 600_000)],
    // Rule 23 (second pre-review of 510 [CK2]): each window is a second shorter than before, the margin asked for.
    [
      STANDARD,
      "public, max-age=0, s-maxage=300, stale-while-revalidate=29",
      "public, max-age=0, s-maxage=199",
      "public, max-age=0, s-maxage=0",
      "public, max-age=0, s-maxage=0",
      STANDARD,
    ],
  );
  is(
    "what the panel saw, read: the date it showed (or none), whether it had passed there, and where it goes",
    // Rule 23 (third pre-review of 510 [CK2]): what the panel saw now carries the page its date goes to (`to`);
    // the first two were read without it and are now sent with it; the two new ones are refused for lacking it.
    [
      readSeen({ at: NOW, passed: true, to: { kind: "store" } }),
      readSeen({ at: null, passed: false, to: null }),
      readSeen({ at: "x", passed: true, to: null }),
      readSeen({ at: NOW }),
      readSeen(undefined),
      readSeen({ at: 1.5, passed: false, to: null }),
      readSeen({ at: NOW, passed: true }),
      readSeen({ at: NOW, passed: false, to: null }),
      readSeen({ at: null, passed: false, to: { kind: "store" } }),
    ],
    [{ at: NOW, passed: true, to: { kind: "store" } }, { at: null, passed: false, to: null }, null, null, null, null, null, null, null],
  );
  is(
    "what a panel sees of a link includes where its date goes",
    [seenAt(link, NOW), seenAt(link, NOW + 600_000), seenAt({ then: undefined }, NOW)],
    [{ at: NOW + 600_000, passed: false, to: { kind: "store" } }, { at: NOW + 600_000, passed: true, to: { kind: "store" } }, { at: null, passed: false, to: null }],
  );

  part("Setting it, opening it, taking it back");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const mine = { sid: store.sid, statsId: store.statsId! };
  const made = await addLink(mine, { name: "Spring sale", place: "instagram", target: { kind: "product", id: "guide" } }, guide, 1000);
  if (!made.ok) throw new Error("no link");
  const code = made.link.code;
  const product = (id: string) => `https://marktmorgen.com/@harbor/p/${id}?utm_source=instagram&utm_medium=post&utm_campaign=spring-sale`;
  const storePage = "https://marktmorgen.com/@harbor?utm_source=instagram&utm_medium=post&utm_campaign=spring-sale";
  const thenOf = (result: Awaited<ReturnType<typeof setThen>>) => (result.ok ? result.links.find((l) => l.code === code)?.then ?? "none" : result.reason);
  const targetOf = (result: Awaited<ReturnType<typeof setThen>>) => (result.ok ? result.links.find((l) => l.code === code)?.target : result.reason);

  // An answer the CDN kept before any date was set: how long it may still be served, fresh and stale.
  const keptAt = Date.now();
  const plain = await open(code);
  const lifetime = [...plain.cache.matchAll(/(?:s-maxage|stale-while-revalidate)=(\d+)/g)].reduce((sum, m) => sum + Number(m[1]) * 1000, 0);
  is("an answer kept before the date was set runs out before the soonest date one may set", [lifetime, keptAt + lifetime < keptAt + MIN_THEN_MS], [360_000, true]);

  // Rule 23 (third pre-review): every view now names where its date goes, `to`; null with no date.
  const none = { at: null, passed: false, to: null };
  const toStore = { kind: "store" } as const;
  const saw = (at: number, passed: boolean, to: { kind: "store" } | { kind: "product"; id: string } = toStore) => ({ at, passed, to });
  const now = Date.now();
  const set = await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "store" } }, guide, now, none);
  is("set: the list shows when and where to", thenOf(set), { at: now + 3_600_000, target: { kind: "store" } });
  const future = saw(now + 3_600_000, false);
  const before = await open(code);
  is("before the date it still opens the product, kept no longer than five minutes", [before.to, before.cache], [product("guide"), STANDARD]);
  is("opening a link with a date sends exactly what it sent without one: the same reads, nothing written", before.sent, plain.sent);
  // Rule 23: these four said only "not ok" (a tautology on the reason); each now reads the exact reason the studio words.
  is("refused: the page it already opens", thenOf(await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "product", id: "guide" } }, guide, now, future)), "same");
  is("refused: a date sooner than ten minutes, said as the date", thenOf(await setThen(mine.statsId, code, { at: now + MIN_THEN_MS - 1, target: { kind: "store" } }, guide, now, future)), "when");
  is("refused: a date in the past, said as the date", thenOf(await setThen(mine.statsId, code, { at: now - 5, target: { kind: "store" } }, guide, now, future)), "when");
  is("refused: a page the store does not have, said as the page", thenOf(await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "product", id: "theirs" } }, guide, now, future)), "target");
  is("refused: another store's link", thenOf(await setThen("someoneelse0000", code, { at: now + 3_600_000, target: { kind: "store" } }, guide, now, future)), "gone");
  is("refused: a code that is not one", thenOf(await setThen(mine.statsId, "bad", null, guide, now, none)), "gone");

  part("What the panel saw, against what the server sees");
  const record = async () => String((await redisPipeline([["GET", linkKey(code)]]))[0]);
  const untouched = await record();
  const overNoView = await setThen(mine.statsId, code, { at: now + 7_200_000, target: { kind: "store" } }, guide, now);
  is("a new date over a saved one, from a request that does not show it saw that date: changed, nothing written", [thenOf(overNoView), await record()], ["changed", untouched]);
  is("the refusal carries the links as they are, for the panel to show", !overNoView.ok && overNoView.reason === "changed" ? overNoView.links?.find((l) => l.code === code)?.then : "no links", { at: now + 3_600_000, target: { kind: "store" } });
  is("a date the panel did not see (another one): changed", thenOf(await setThen(mine.statsId, code, null, guide, now, saw(now + 1, false))), "changed");
  is("no date seen where one is saved: changed", thenOf(await retarget(mine.statsId, code, { kind: "product", id: "extra" }, () => true, now, none)), "changed");
  // Scenario 2: the creator's clock runs ahead, so the panel took the date for past while the server has not reached it.
  is("the panel took the date for past, the server has not reached it: changed", thenOf(await retarget(mine.statsId, code, { kind: "product", id: "extra" }, () => true, now, saw(now + 3_600_000, true))), "changed");
  // Scenario 1: the panel stayed open past the date and still showed it as coming.
  is("the panel showed the date as coming, the server is past it: changed", thenOf(await setThen(mine.statsId, code, null, guide, now + 3_600_000, future)), "changed");
  is("none of these wrote anything", await record(), untouched);
  const overSeen = await setThen(mine.statsId, code, { at: now + 7_200_000, target: { kind: "store" } }, guide, now, future);
  is("a new date over the one the panel saw is saved", thenOf(overSeen), { at: now + 7_200_000, target: { kind: "store" } });
  const later = saw(now + 7_200_000, false);

  const moved = await retarget(mine.statsId, code, { kind: "product", id: "extra" }, () => true, now, later);
  is("before the date, changing where it goes keeps the date", [targetOf(moved), thenOf(moved), (await open(code)).to], [{ kind: "product", id: "extra" }, { at: now + 7_200_000, target: { kind: "store" } }, product("extra")]);
  const ontoThen = await retarget(mine.statsId, code, { kind: "store" }, () => true, now, later);
  is("before the date, going now where the date would send it takes the date back", [targetOf(ontoThen), thenOf(ontoThen), (await open(code)).to], [{ kind: "store" }, "none", storePage]);
  await retarget(mine.statsId, code, { kind: "product", id: "guide" }, () => true, now, none);
  await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "store" } }, guide, now, none);
  is("another store still cannot change where it goes", (await retarget("someoneelse0000", code, { kind: "store" }, () => true, now, future)).ok, false);
  const back = await setThen(mine.statsId, code, null, guide, Date.now(), future);
  is("taken back before the date: no date, and it opens its page again", [thenOf(back), (await open(code)).to], ["none", product("guide")]);

  // Set as if eleven minutes ago, so its date is a minute behind the real clock the route reads.
  const past = () => Date.now() - MIN_THEN_MS - 60_000;
  const lapsed = past();
  await setThen(mine.statsId, code, { at: lapsed + MIN_THEN_MS, target: { kind: "store" } }, guide, lapsed, none);
  const after = await open(code);
  is("from the date on it opens the other page, tagged with the same post", [after.status, after.to, after.cache], [302, storePage, STANDARD]);
  const settled = await setThen(mine.statsId, code, null, guide, Date.now(), saw(lapsed + MIN_THEN_MS, true));
  is("after the date, taking the date back keeps the page it opens now", [thenOf(settled), targetOf(settled), (await open(code)).to], ["none", { kind: "store" }, storePage]);

  const again = past();
  const setAgain = await setThen(mine.statsId, code, { at: again + MIN_THEN_MS, target: { kind: "product", id: "guide" } }, guide, again, none);
  is("past its date again, it opens the product", [thenOf(setAgain), (await open(code)).to], [{ at: again + MIN_THEN_MS, target: { kind: "product", id: "guide" } }, product("guide")]);
  const changedAfter = await retarget(mine.statsId, code, { kind: "product", id: "extra" }, () => true, Date.now(), saw(again + MIN_THEN_MS, true, { kind: "product", id: "guide" }));
  is("after the date, \"Goes to\" changes the page it opens, and the date is spent", [targetOf(changedAfter), thenOf(changedAfter), (await open(code)).to], [{ kind: "product", id: "extra" }, "none", product("extra")]);
  await retarget(mine.statsId, code, { kind: "product", id: "guide" }, () => true, Date.now(), none);

  part("Compare-and-swap, and unknown replies");
  const kept = await record();
  const changed = JSON.stringify({ ...JSON.parse(kept), place: "tiktok" });
  is("a record that is not what was read is never written over", await swapLink(mine.statsId, code, kept.replace("instagram", "x"), changed), "changed");
  is("and nothing moved", JSON.stringify((await findLink(code))?.place), JSON.stringify("instagram"));
  is("the record as read is swapped, both copies", [await swapLink(mine.statsId, code, kept, changed), (await findLink(code))?.place, (await readLinks(mine.statsId)).find((l) => l.code === code)?.place], ["done", "tiktok", "tiktok"]);
  const realPipeline = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (String(commands[0]?.[0]) === "EVAL" ? ["QUEUED"] : realPipeline(commands))) as typeof redis.pipeline;
  try {
    is("a reply that is neither 1 nor 0 is unknown, never a write", await swapLink(mine.statsId, code, changed, kept), "unknown");
    const unknown = await setThen(mine.statsId, code, { at: Date.now() + 3_600_000, target: { kind: "store" } }, guide, Date.now(), none);
    is("and setting a date on it says so", unknown.ok ? "" : unknown.reason, "unavailable");
  } finally {
    redis.pipeline = realPipeline;
  }

  part("A record with a date it cannot read opens nothing");
  await redisPipeline([["SET", linkKey(code), JSON.stringify({ ...JSON.parse(changed), then: { at: "soon", target: { kind: "store" } } })]]);
  is("never the old page past a date it cannot read", (await open(code)).to, "https://marktmorgen.com/l/ended");

  part("The studio's request");
  await setSubscription("owner@example.com", { customerId: "cus_ck2", subscriptionId: "sub_ck2", active: true, tier: "pro", period: paidPeriod() });
  const fresh = await addLink(mine, { name: "May reel", place: "tiktok", target: { kind: "store" } }, guide, 5000);
  if (!fresh.ok) throw new Error("no second link");
  const cookie = `${SESSION_COOKIE}=${await openSession("owner@example.com")}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/short-links", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; now?: unknown; links?: { code: string; then?: unknown }[] } };
  };
  const when = Date.now() + 86_400_000;
  const seenNone = { at: null, passed: false, to: null };
  const soon = await post({ action: "then", code: fresh.link.code, then: { at: Date.now() + 120_000, target: { kind: "store" } }, seen: seenNone });
  is("a date two minutes away is refused as the date", [soon.status, soon.body.error], [400, "when"]);
  const saved = await post({ action: "then", code: fresh.link.code, then: { at: when, target: { kind: "store" } }, seen: seenNone });
  is("the same page it opens is refused in words the studio has", [saved.status, saved.body.error], [400, "same"]);
  const good = await post({ action: "then", code: fresh.link.code, then: { at: when, target: { kind: "product", id: "nothing-here" } }, seen: seenNone });
  is("a product the store does not have is refused", [good.status, good.body.error], [400, "target"]);
  const cleared = await post({ action: "then", code: fresh.link.code, then: null, seen: seenNone });
  is("no date, sent as none, answers the list and the server's clock", [cleared.status, cleared.body.ok, cleared.body.links?.some((l) => l.code === fresh.link.code), typeof cleared.body.now], [200, true, true, "number"]);
  await setThen(mine.statsId, fresh.link.code, { at: when, target: { kind: "product", id: "guide" } }, guide, Date.now(), seenNone);
  const stale = await post({ action: "target", code: fresh.link.code, target: { kind: "store" }, seen: seenNone });
  is("a change from a panel that did not see the date: 409 changed, with the links and the server's clock", [stale.status, stale.body.error, stale.body.links?.find((l) => l.code === fresh.link.code)?.then, typeof stale.body.now], [409, "changed", { at: when, target: { kind: "product", id: "guide" } }, "number"]);

  part("Third pre-review: the date's page, seen; the route's clock");
  const dated = await addLink(mine, { name: "June drop", place: "instagram", target: { kind: "store" } }, guide, 7000);
  if (!dated.ok) throw new Error("no third link");
  const at3 = Date.now() + 86_400_000;
  await setThen(mine.statsId, dated.link.code, { at: at3, target: { kind: "product", id: "guide" } }, guide, Date.now(), none);
  const record3 = async () => String((await redisPipeline([["GET", linkKey(dated.link.code)]]))[0]);
  const kept3 = await record3();
  const otherPage = await setThen(mine.statsId, dated.link.code, null, guide, Date.now(), { at: at3, passed: false, to: { kind: "store" } });
  is("the same date going to another page than the panel showed: changed, nothing written", [otherPage.ok ? "ok" : otherPage.reason, await record3()], ["changed", kept3]);
  const otherPage2 = await retarget(mine.statsId, dated.link.code, { kind: "product", id: "guide" }, guide, Date.now(), { at: at3, passed: false, to: { kind: "product", id: "other" } });
  is("\"Goes to\" on the same date with another page shown: changed", otherPage2.ok ? "ok" : otherPage2.reason, "changed");
  const samePage = await setThen(mine.statsId, dated.link.code, null, guide, Date.now(), { at: at3, passed: false, to: { kind: "product", id: "guide" } });
  is("the date and its page as the panel showed them: taken back", samePage.ok ? samePage.links.find((l) => l.code === dated.link.code)?.then ?? "none" : samePage.reason, "none");

  // The record is read, then the date comes while the store is read: the page is chosen on the clock after both.
  const due = Date.now() + 3_600_000;
  await setThen(mine.statsId, dated.link.code, { at: due, target: { kind: "product", id: "guide" } }, guide, Date.now(), none);
  const realNow = Date.now;
  const realPipe = redis.pipeline;
  let clockAt = due - 1;
  Date.now = () => clockAt;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await realPipe(commands);
    if (String(commands[0]?.[0]) === "GET" && String(commands[0]?.[1]) === linkKey(dated.link.code)) clockAt = due + 1;
    return reply;
  }) as typeof redis.pipeline;
  let late: Response | undefined;
  try {
    late = await GET(new Request(`https://marktmorgen.com/l/${dated.link.code}`) as never, { params: Promise.resolve({ code: dated.link.code }) });
  } finally {
    Date.now = realNow;
    redis.pipeline = realPipe;
  }
  is(
    "the route reads its clock after the record and the store: the date that came meanwhile is honored",
    [late?.headers.get("location"), late?.headers.get("cache-control")],
    ["https://marktmorgen.com/@harbor/p/guide?utm_source=instagram&utm_medium=post&utm_campaign=june-drop", STANDARD],
  );

  part("Third pre-review: the panel's rules");
  const r = rules as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  const day = 86_400_000;
  const plainLink = { code: "abcdef", name: "june-drop", place: "instagram", target: { kind: "store" }, made: 1 };
  const fits = (fresh: unknown, chosen: unknown, at: number) => (r.dateFormFits ? r.dateFormFits(fresh, chosen, at) : "missing");
  is(
    "after a refusal for a change, the date form stays while the page chosen still fits",
    [
      fits(plainLink, { kind: "product", id: "guide" }, NOW),
      fits({ ...plainLink, target: { kind: "product", id: "guide" } }, { kind: "product", id: "guide" }, NOW),
      fits({ ...plainLink, then: { at: NOW + day, target: { kind: "product", id: "guide" } } }, { kind: "product", id: "extra" }, NOW),
      fits({ ...plainLink, then: { at: NOW - day, target: { kind: "product", id: "guide" } } }, { kind: "product", id: "guide" }, NOW),
      fits({ ...plainLink, then: { at: NOW - day, target: { kind: "product", id: "guide" } } }, { kind: "store" }, NOW),
      fits(undefined, { kind: "store" }, NOW),
    ],
    // Fits; the link now opens the page chosen; a date of its own is set (no form then); past its date it opens the page chosen; past its date, another page fits; the link is gone.
    [true, false, false, false, true, false],
  );
  const coming = { ...plainLink, then: { at: NOW + 1000, target: { kind: "product", id: "guide" } } };
  const reached = (list: unknown, from: number, to: number) => (r.datesReached ? (r.datesReached(list, from, to) as { code: string }[]).map((l) => l.code) : "missing");
  is(
    "the dates a panel's clock passed between two moments: said when they come",
    [reached([coming, plainLink], NOW, NOW + 999), reached([coming, plainLink], NOW, NOW + 1000), reached([coming], NOW + 1000, NOW + 2000)],
    [[], ["abcdef"], []],
  );
  const canceled = (before: unknown, after: unknown, at: number) => (r.dateCanceledBy ? r.dateCanceledBy(before, after, at) : "missing");
  is(
    "\"Goes to\" the page of a coming date cancels it, and the panel can tell",
    [canceled(coming, { ...plainLink, target: { kind: "product", id: "guide" } }, NOW), canceled(coming, coming, NOW), canceled(plainLink, plainLink, NOW), canceled(coming, undefined, NOW)],
    [true, false, false, false],
  );

  part("Words and wiring");
  const panel = readFileSync("components/short-links.tsx", "utf8");
  is("the panel says what happens and when, in the creator's own time", [/Change on a date/.test(panel), /type="datetime-local"/.test(panel), /Then it goes to/.test(panel), /Cancel the change/.test(panel), /At least ten minutes from now/.test(panel)], [true, true, true, true, true]);
  is(
    "a refusal of the date form is said beside its fields, focused, the field marked, never only in a passing toast",
    [/setProblem\(REASONS\[/.test(panel), /aria-invalid=\{problemOn === "when"/.test(panel), /aria-invalid=\{problemOn === "same"/.test(panel), /problemRef\.current\?\.focus\(\)/.test(panel), /quiet: true/.test(panel)],
    [true, true, true, true, true],
  );
  is("focus goes back to the link's date line when the form closes", /focusDate\.current/.test(panel), true);
  is("the line \"to X\" and \"Goes to\" read the page the link opens now", [/where\(targetNow\(link, now\)\)/.test(panel), /targetValue\(targetNow\(link, now\)\)/.test(panel)], [true, true]);
  is(
    "every change sends what the panel saw, and a refusal for it shows the links as they are",
    [/action: "target", code: link\.code, target: targetFrom\(e\.target\.value\), seen: seenOf\(link\)/.test(panel), /action: "then", code: link\.code, then: null, seen: seenOf\(link\)/.test(panel), /action: "then", code: link\.code, then, seen: seenOf\(link\)/.test(panel), /answer\.error === "changed" && answer\.links/.test(panel)],
    [true, true, true, true],
  );
  is("the panel's clock follows the server's and moves on its own: at the next date and when the tab comes back", [/answer\.now/.test(panel), /setTimeout\(/.test(panel), /visibilitychange/.test(panel)], [true, true, true]);
  is("a success is said from the answer, not from what the panel had", [/link\.target\)\}\.`\)\}/.test(panel), /done: \(links: ShortLink\[\]\)/.test(panel) || /\(links\) =>/.test(panel)], [false, true]);
  is("refusals of \"Goes to\" and \"Cancel the change\" are said beside the link, focused", [/rowProblem/.test(panel), /rowRef\.current\?\.focus\(\)/.test(panel)], [true, true]);
  is("an alert is not read twice: a focused message carries no role=alert", /role="alert"/.test(panel), false);
  is("a field's mark clears when it changes", /setProblemOn\(""\)/.test(panel), true);
  is("the panel explains each refusal", ["same", "when", "changed", "gone"].map((reason) => new RegExp(`\\b${reason}: "`).test(panel)), [true, true, true, true]);
  is(
    "third pre-review: a refusal for a date keeps the form and what was typed, closing it only when the page chosen no longer fits",
    [/if \(refused === "changed"\) \{\s*\/\/[^\n]*\n\s*setDating\(""\)/.test(panel), /dateFormFits\(/.test(panel)],
    [false, true],
  );
  is("third pre-review: a refusal that brings no links does not say they are shown", [/answer\.error === "changed" && !answer\.links/.test(panel), /\bstale: "[^"]*Reload the page/.test(panel)], [true, true]);
  is("third pre-review: \"Goes to\" says when it cancels a date", [/dateCanceledBy\(/.test(panel), /change you set for a date is canceled/i.test(panel)], [true, true]);
  is("third pre-review: a date that comes while the panel is open is said in a live region, the focus kept", [/aria-live="polite"/.test(panel), /datesReached\(/.test(panel), /document\.activeElement/.test(panel)], [true, true, true]);
  is("third pre-review: any saved change clears a refusal beside a link", /if \(answer\.ok && answer\.links\) \{[^}]*setRowProblem\(null\)/.test(panel), true);
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is(
    "third pre-review: the panel starts on the server's clock",
    // Rule 23 (fourth pre-review of 510 [CK2]): main's block reads the links and titles first, so `now` is no longer the first prop;
    // that it is read after them is checked below (P2).
    [/<ShortLinks\s[^>]*now=\{todayNow\(\)\}/.test(studio), /now: serverStart/.test(panel)],
    [true, true],
  );
  const route = readFileSync("app/l/[code]/route.ts", "utf8");
  is("the route reads the time once and keeps the CDN inside the date", [/targetNow\(/.test(route), /linkCache\(/.test(route), /never keeps it past the date/.test(route)], [true, true, false]);

  part("Fourth pre-review: an old panel's view, the panel's clock, a date said, a link gone");
  // P1: a panel drawn before `to` was sent says "no date" as { at: null, passed: false }: read as no date, like a request with no view.
  is(
    "a view of no date without `to` reads as no date (a panel opened before `to` was sent)",
    [readSeen({ at: null, passed: false }), readSeen({ at: null, passed: true }), readSeen({ at: null, passed: false, to: { kind: "store" } })],
    [{ at: null, passed: false, to: null }, { at: null, passed: true, to: null }, null],
  );
  const undated = (await readLinks(mine.statsId)).find((l) => l.code === fresh.link.code);
  if (!undated) throw new Error("no second link");
  await setThen(mine.statsId, fresh.link.code, null, guide, Date.now(), seenAt(undated, Date.now()));
  const oldPanel = await post({ action: "target", code: fresh.link.code, target: { kind: "product", id: "guide" }, seen: { at: null, passed: false } });
  is("a change from such a panel, on a link with no date, is saved", [oldPanel.status, oldPanel.body.ok], [200, true]);

  // P2: the panel's clock is read after the page's reads, so it does not start behind by their time.
  const block = studio.slice(studio.lastIndexOf("(async () => {", studio.indexOf("<ShortLinks")), studio.indexOf("})()", studio.indexOf("<ShortLinks")));
  is(
    "the panel's clock is the server's, read after the links and the titles",
    [/now=\{todayNow\(\)\}/.test(block), block.indexOf("await readLinks") >= 0 && block.indexOf("await readLinks") < block.indexOf("todayNow()"), block.indexOf("await titles") >= 0 && block.indexOf("await titles") < block.indexOf("todayNow()")],
    [true, true, true],
  );

  // P3: a date passed while a change was being sent is said, from what the panel showed, if the answer still has it come.
  const came = (shown: unknown, freshList: unknown, from: number, to: number) => (r.datesCame ? (r.datesCame(shown, freshList, from, to) as { code: string }[]).map((l) => l.code) : "missing");
  const b = { ...plainLink, code: "bbbbbb", then: { at: NOW + 500, target: { kind: "product", id: "guide" } } };
  is(
    "a date passed during a request is said when the answer comes, unless the answer took it back or the link is gone",
    [
      came([b], [b], NOW, NOW + 1_000),
      came([b], [{ ...b, then: undefined, target: { kind: "product", id: "guide" } }], NOW, NOW + 1_000),
      came([b], [{ ...b, then: undefined }], NOW, NOW + 1_000),
      came([b], [], NOW, NOW + 1_000),
      came([b], [b], NOW + 1_000, NOW + 2_000),
    ],
    // Came; came, the date settled into the page; taken back meanwhile; gone; said already.
    [["bbbbbb"], ["bbbbbb"], [], [], []],
  );
  is(
    "an answer moves the panel's clock by the tick's own path, and the same words are said again",
    [/setNow\(clock\(\)\)/.test(panel), (panel.match(/advance\(answer\.links\)/g) ?? []).length, /const tick = \(\) => advance\(/.test(panel), /datesCame\(/.test(panel), /setSaid\(""\)/.test(panel)],
    [false, 2, true, true, true],
  );

  // P4: a link gone when a change is refused is said in the panel's own place, focused, without asking to reload what is already shown.
  is(
    "a link gone after a refusal is said in a lasting place in the panel, focused, not in a toast",
    [/toast\(REASONS\.gone\)/.test(panel), /statusRef\.current\?\.focus\(\)/.test(panel), /\bended: "(?![^"]*Reload)[^"]*"/.test(panel), /refuseRow\(/.test(panel)],
    [false, true, true, true],
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
