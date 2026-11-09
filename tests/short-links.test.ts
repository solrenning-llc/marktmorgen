/**
 * Short links for posts (lib/short-links.ts, lib/short-link-rules.ts,
 * app/l/[code]/route.ts; added 13 October 2026). Checked:
 *
 *   - a code is six letters nobody misreads, and a post's name is counted as
 *     a utm_campaign is;
 *   - the link opens the store or the product, tagged with where it was
 *     posted and the post's name, on the store's own address;
 *   - one link to a name in a store, a hundred links at most, products only
 *     of that store;
 *   - where it goes can be changed, and an ended link opens the page that
 *     says so; the answer is kept by the CDN for five minutes.
 */
import { CODE, MAX_LINKS, landingUrl, linkName, linkPlace, readTarget } from "@/lib/short-link-rules";
import { addLink, findLink, readLinks, removeLink, retarget } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const open = async (code: string) => {
  const answer = await GET(new Request(`https://marktmorgen.com/l/${code}`) as never, { params: Promise.resolve({ code }) });
  return { status: answer.status, to: answer.headers.get("location") ?? "", cache: answer.headers.get("cache-control") ?? "" };
};

async function main(): Promise<void> {
  redis.clear();

  part("Names, places and where a link goes");
  is("a post's name as a utm_campaign is counted", [linkName("October Reel!"), linkName("  café  launch "), linkName("x".repeat(50)).length, linkName("!!!")], ["october-reel", "cafe-launch", 30, ""]);
  is("a place from the list, or somewhere else", [linkPlace("tiktok"), linkPlace("myspace"), linkPlace(3)], ["tiktok", "other", "other"]);
  is("a product only when the store has it", [readTarget({ kind: "store" }, () => false), readTarget({ kind: "product", id: "guide" }, (id) => id === "guide"), readTarget({ kind: "product", id: "other" }, (id) => id === "guide"), readTarget("store", () => true)], [{ kind: "store" }, { kind: "product", id: "guide" }, null, null]);
  is("it opens the page tagged with where it was posted and the post's name", [
    landingUrl("https://marktmorgen.com/@harbor", { name: "october-reel", place: "instagram", target: { kind: "store" } }),
    landingUrl("https://harbor.kitchen", { name: "flyer", place: "other", target: { kind: "product", id: "guide" } }),
  ], [
    "https://marktmorgen.com/@harbor?utm_source=instagram&utm_medium=post&utm_campaign=october-reel",
    "https://harbor.kitchen/p/guide?utm_source=other&utm_medium=post&utm_campaign=flyer",
  ]);

  part("Making links");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const mine = { sid: store.sid, statsId: store.statsId! };
  const isProduct = (id: string) => id === "guide";
  const made = await addLink(mine, { name: "October Reel", place: "instagram", target: { kind: "store" } }, isProduct, 1000);
  if (!made.ok) throw new Error("no link");
  is("six letters nobody misreads", [CODE.test(made.link.code), /[0o1li]/.test(made.link.code)], [true, false]);
  is("one link to a name", (await addLink(mine, { name: "october-reel", place: "tiktok", target: { kind: "store" } }, isProduct)).ok ? "" : "taken", "taken");
  is("a product of another store is refused", (await addLink(mine, { name: "other", place: "x", target: { kind: "product", id: "theirs" } }, isProduct)).ok ? "" : "target", "target");
  const flyer = await addLink(mine, { name: "flyer", place: "other", target: { kind: "product", id: "guide" } }, isProduct, 2000);
  is("the store's links, the newest first", (await readLinks(mine.statsId)).map((l) => l.name), ["flyer", "october-reel"]);

  part("Opening a link");
  const first = await open(made.link.code);
  is("sent to the store, tagged, kept by the CDN for five minutes", [first.status, first.to, /s-maxage=300/.test(first.cache)], [302, "https://marktmorgen.com/@harbor?utm_source=instagram&utm_medium=post&utm_campaign=october-reel", true]);
  is("typed in capitals it still opens", (await open(made.link.code.toUpperCase())).to, first.to);
  is("a code that never was opens the page that says so", [(await open("zzzzzz")).to, (await open("bad")).to], ["https://marktmorgen.com/l/ended", "https://marktmorgen.com/l/ended"]);

  part("Changing where it goes, and ending it");
  if (!flyer.ok) throw new Error("no flyer");
  await retarget(mine.statsId, made.link.code, { kind: "product", id: "guide" }, isProduct);
  is("the same link now opens the product", (await open(made.link.code)).to, "https://marktmorgen.com/@harbor/p/guide?utm_source=instagram&utm_medium=post&utm_campaign=october-reel");
  is("another store cannot change it", await retarget("someoneelse0000", made.link.code, { kind: "store" }, () => true), null);
  await removeLink("someoneelse0000", flyer.link.code);
  is("nor end it", Boolean(await findLink(flyer.link.code)), true);
  await removeLink(mine.statsId, flyer.link.code);
  is("ended, it opens the page that says so and leaves the list", [(await open(flyer.link.code)).to, (await readLinks(mine.statsId)).map((l) => l.name)], ["https://marktmorgen.com/l/ended", ["october-reel"]]);

  part("A hundred links at most");
  for (let i = (await readLinks(mine.statsId)).length; i < MAX_LINKS; i += 1) await addLink(mine, { name: `post-${i}`, place: "x", target: { kind: "store" } }, isProduct);
  is("the hundred and first is refused", (await addLink(mine, { name: "one-more", place: "x", target: { kind: "store" } }, isProduct)).ok ? "" : "full", "full");

  part("A list whose reply is not whole is unknown, never no links (CX-123 rule 24)");
  // The store's list (HVALS) answered in another shape: never [] ("no links made"), so the studio says it could not
  // read them, and adding one is not let past the hundred or a name already taken on a list it could not read.
  const kept = redis.pipeline;
  const garbled = async <T>(reply: unknown, run: () => Promise<T>): Promise<T | "threw"> => {
    redis.pipeline = (async (commands: unknown[][]) => (commands.some((c) => c[0] === "HVALS") ? commands.map(() => reply) : kept.call(redis, commands as never))) as never;
    try {
      return await run();
    } catch {
      return "threw";
    } finally {
      redis.pipeline = kept;
    }
  };
  for (const [what, reply] of [["text", "garbled"], ["a number", 7], ["an object", { a: 1 }], ["a list with a number in it", ["x", 3]]] as const) {
    is(`readLinks on ${what} throws, never []`, await garbled(reply, () => readLinks(mine.statsId)), "threw");
  }
  is("a pipeline of the wrong length is unknown too", await (async () => {
    redis.pipeline = (async () => []) as never;
    try {
      return await readLinks(mine.statsId);
    } catch {
      return "threw";
    } finally {
      redis.pipeline = kept;
    }
  })(), "threw");
  const before = (await readLinks(mine.statsId)).length;
  is("adding on a list that could not be read makes no link past the hundred", [await garbled("garbled", () => addLink(mine, { name: "past-the-cap", place: "x", target: { kind: "store" } }, isProduct)), (await readLinks(mine.statsId)).length], ["threw", before]);
  is("control: an empty list is still no links", await readLinks("f".repeat(18)), []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
