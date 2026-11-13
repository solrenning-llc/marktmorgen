/**
 * Giving a place back after losing what an event asks for
 * (app/api/store/community/rsvp/route.ts).
 *
 * An event kept for the buyers of some products, with a limited number of
 * places: a member takes a place while holding the product, then no longer
 * holds it (a refund, an ended membership). Before, every answer of the RSVP
 * route came after mayAttend, so "not going" answered "eventlocked" and the
 * place stayed taken by somebody who can no longer come: the event read
 * "every place taken" to members who could. Giving a place back now never
 * asks whether the member may come; taking one still does.
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { NextRequest } from "next/server";
import { POST as rsvpPost } from "@/app/api/store/community/rsvp/route";
import { freshConfig, memberKey, readConfig, saveConfig, type Member } from "@/lib/community";
import { createEvent, rsvpNumbers } from "@/lib/community-events";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  // lib/community.ts CAS_MEMBER, as Redis runs it (the stand-in runs no unmarked script).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await pipeline([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await pipeline([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const CLUB = "club@rsvplost.example";
  const made = await claimHandle(CLUB, "rsvplostclub", "Rsvp Lost Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_RsvpLost1", subscriptionId: "sub_RsvpLost1", active: true, tier: "creator", period: paidPeriod() });
  const pass = await addProduct(CLUB, "Club pass", "", "0", null);
  const workshop = await addProduct(CLUB, "Workshop", "", "0", null);
  if (!pass.ok || !workshop.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  let club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [pass.product.id, workshop.product.id] });
  const config = (await readConfig(cid))!;
  club = (await storeForEmail(CLUB))!;
  const created = await createEvent(club, { title: "Workshop call", about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [workshop.product.id], start: Date.now() + 3 * 86_400_000, cap: 1 });
  if (!created.ok) throw new Error("no event");
  const event = created.event;

  async function member(email: string, name: string): Promise<string> {
    const key = memberKey(email);
    await redis.pipeline([
      ["SET", `nl:cm:${cid}:ok:${emailKey(email)}`, JSON.stringify({ v: config.v, ok: true })],
      ["HSET", `nl:cm:${cid}:m`, key, JSON.stringify({ k: key, e: email, n: name, h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)],
    ]);
    await holdsWorkshop(email, true);
    return `${passCookieName(club)}=${await mintPass(club, email, "all")}`;
  }
  async function holdsWorkshop(email: string, ok: boolean): Promise<void> {
    await redis.pipeline([["SET", `nl:cm:${cid}:ev:${event.id}:ok:${emailKey(email)}`, JSON.stringify({ v: `${config.v}.${event.v}`, ok })]]);
  }
  const act = async (cookie: string, action: string): Promise<string> => {
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("event", event.id);
    form.set("action", action);
    const response = await rsvpPost(new NextRequest("https://marktmorgen.com/api/store/community/rsvp", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };
  const going = async () => (await rsvpNumbers(cid, [event], null)).get(event.id)?.going ?? -1;

  const ana = await member("ana@rsvplost.example", "Ana");
  const ben = await member("ben@rsvplost.example", "Ben");

  part("The only place is taken");
  is("Ana takes it", (await act(ana, "going")).includes("n=going"), true);
  is("Ben finds every place taken", (await act(ben, "going")).includes("n=eventfull"), true);

  part("Ana no longer holds the workshop, and gives her place back");
  await holdsWorkshop("ana@rsvplost.example", false);
  is("her place is given back, not refused as locked", (await act(ana, "notgoing")).includes("n=notgoing"), true);
  is("nobody holds a place", await going(), 0);
  is("Ben can take it now", (await act(ben, "going")).includes("n=going"), true);

  part("Taking a place still asks for the workshop");
  is("Ana cannot take one back", (await act(ana, "going")).includes("n=eventlocked"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
