/**
 * 510 [CK2] unit 1: a short link that changes where it goes on a date the
 * creator picks (lib/short-link-rules.ts, lib/short-links.ts,
 * app/l/[code]/route.ts, app/api/store/short-links/route.ts). Checked:
 *
 *   - the date is at least a minute and at most two years away, and the page
 *     it goes to after is the store or one of the store's own products, never
 *     the page it already opens and never an error page;
 *   - before the date the link opens its page, from the date on the other one,
 *     still tagged with the post's name, so its visits and sales stay on the
 *     post's line;
 *   - the CDN never keeps the answer past the date: five minutes and a minute
 *     stale at most, less as the date comes near;
 *   - the change can be taken back, only by the store that owns the link, and
 *     a change of where the link goes keeps it;
 *   - every write is a compare-and-swap of the whole record: a record changed
 *     since it was read is never written over, and an unknown reply is never
 *     taken for a write;
 *   - opening a link still reads one record, as before.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { CACHE_SECONDS, MAX_THEN_MS, MIN_THEN_MS, linkCache, readThen, targetNow } from "@/lib/short-link-rules";
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
  is("a date at least a minute away and a page of the store", readThen({ at: NOW + MIN_THEN_MS, target: { kind: "product", id: "guide" } }, guide, NOW), { at: NOW + MIN_THEN_MS, target: { kind: "product", id: "guide" } });
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
    "the CDN never keeps it past the date",
    [linkCache(link, NOW), linkCache(link, NOW + 270_000), linkCache(link, NOW + 400_000), linkCache(link, NOW + 599_500), linkCache(link, NOW + 600_000)],
    [
      STANDARD,
      "public, max-age=0, s-maxage=300, stale-while-revalidate=30",
      "public, max-age=0, s-maxage=200",
      "public, max-age=0, s-maxage=0",
      STANDARD,
    ],
  );

  part("Setting it, opening it, taking it back");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const mine = { sid: store.sid, statsId: store.statsId! };
  const made = await addLink(mine, { name: "Spring sale", place: "instagram", target: { kind: "product", id: "guide" } }, guide, 1000);
  if (!made.ok) throw new Error("no link");
  const code = made.link.code;
  const plain = await open(code);
  const now = Date.now();
  const set = await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "store" } }, guide, now);
  is("set: the list shows when and where to", set.ok ? set.links.find((l) => l.code === code)?.then : set.reason, { at: now + 3_600_000, target: { kind: "store" } });
  const before = await open(code);
  is("before the date it still opens the product, kept no longer than five minutes", [before.to, before.cache], [
    "https://marktmorgen.com/@harbor/p/guide?utm_source=instagram&utm_medium=post&utm_campaign=spring-sale",
    STANDARD,
  ]);
  is("opening a link with a date sends exactly what it sent without one: the same reads, nothing written", before.sent, plain.sent);
  is("refused: the page it already opens", (await setThen(mine.statsId, code, { at: now + 3_600_000, target: { kind: "product", id: "guide" } }, guide, now)).ok ? "" : "same", "same");
  is("refused: a date that is not one", (await setThen(mine.statsId, code, { at: now - 5, target: { kind: "store" } }, guide, now)).ok ? "" : "target", "target");
  is("refused: another store's link", (await setThen("someoneelse0000", code, { at: now + 3_600_000, target: { kind: "store" } }, guide, now)).ok ? "" : "gone", "gone");
  is("refused: a code that is not one", (await setThen(mine.statsId, "bad", null, guide, now)).ok ? "" : "gone", "gone");

  // Set as if two minutes ago, so its date is a minute behind the real clock the route reads.
  const past = Date.now() - 120_000;
  await setThen(mine.statsId, code, { at: past + MIN_THEN_MS, target: { kind: "store" } }, guide, past);
  const after = await open(code);
  is("from the date on it opens the other page, tagged with the same post", [after.status, after.to, after.cache], [302, "https://marktmorgen.com/@harbor?utm_source=instagram&utm_medium=post&utm_campaign=spring-sale", STANDARD]);

  const kept = await retarget(mine.statsId, code, { kind: "product", id: "guide" }, () => true);
  is("changing where it goes keeps the date", kept.ok ? kept.links.find((l) => l.code === code)?.then?.target : kept.reason, { kind: "store" });
  is("another store still cannot change where it goes", (await retarget("someoneelse0000", code, { kind: "store" }, () => true)).ok, false);

  const back = await setThen(mine.statsId, code, null, guide, Date.now());
  is("taken back: no date, and it opens its page again", [back.ok ? back.links.find((l) => l.code === code)?.then ?? "none" : back.reason, (await open(code)).to], [
    "none",
    "https://marktmorgen.com/@harbor/p/guide?utm_source=instagram&utm_medium=post&utm_campaign=spring-sale",
  ]);

  part("Compare-and-swap, and unknown replies");
  const [raw] = await redisPipeline([["GET", linkKey(code)]]);
  const record = String(raw);
  const changed = JSON.stringify({ ...JSON.parse(record), place: "tiktok" });
  is("a record that is not what was read is never written over", await swapLink(mine.statsId, code, record.replace("instagram", "x"), changed), "changed");
  is("and nothing moved", JSON.stringify((await findLink(code))?.place), JSON.stringify("instagram"));
  is("the record as read is swapped, both copies", [await swapLink(mine.statsId, code, record, changed), (await findLink(code))?.place, (await readLinks(mine.statsId)).find((l) => l.code === code)?.place], ["done", "tiktok", "tiktok"]);
  const realPipeline = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (String(commands[0]?.[0]) === "EVAL" ? ["QUEUED"] : realPipeline(commands))) as typeof redis.pipeline;
  try {
    is("a reply that is neither 1 nor 0 is unknown, never a write", await swapLink(mine.statsId, code, changed, record), "unknown");
    const unknown = await setThen(mine.statsId, code, { at: Date.now() + 3_600_000, target: { kind: "store" } }, guide, Date.now());
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
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; links?: { code: string; then?: unknown }[] } };
  };
  const when = Date.now() + 86_400_000;
  const saved = await post({ action: "then", code: fresh.link.code, then: { at: when, target: { kind: "store" } } });
  is("the same page it opens is refused in words the studio has", [saved.status, saved.body.error], [400, "same"]);
  const good = await post({ action: "then", code: fresh.link.code, then: { at: when, target: { kind: "product", id: "nothing-here" } } });
  is("a product the store does not have is refused", [good.status, good.body.error], [400, "target"]);
  const cleared = await post({ action: "then", code: fresh.link.code, then: null });
  is("no date, sent as none, answers the list", [cleared.status, cleared.body.ok, cleared.body.links?.some((l) => l.code === fresh.link.code)], [200, true, true]);

  part("Words and wiring");
  const panel = readFileSync("components/short-links.tsx", "utf8");
  is("the panel says what happens and when, in the creator's own time", [/Change on a date/.test(panel), /type="datetime-local"/.test(panel), /Then it goes to/.test(panel), /Cancel the change/.test(panel)], [true, true, true, true]);
  is("the panel explains each refusal", ["same", "when", "changed", "gone"].map((reason) => new RegExp(`\\b${reason}: "`).test(panel)), [true, true, true, true]);
  const route = readFileSync("app/l/[code]/route.ts", "utf8");
  is("the route reads the time once and keeps the CDN inside the date", [/targetNow\(/.test(route), /linkCache\(/.test(route)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
