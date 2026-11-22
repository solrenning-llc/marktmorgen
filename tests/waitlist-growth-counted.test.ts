/**
 * Claude 6's two MEDIUMs on #2576 @87908f7e89 (6957115837), real code with the
 * stand-in Redis and synthetic data; no provider is called.
 *
 * 1. A place written before #2576 was counted only at its join, over
 *    {at, ok: 0, c, t}; main's confirmation rewrote it with ok: now() and
 *    counted none of it. Given back at its place as it now stands, it gave
 *    back more than the slot ever held for it. Such a place (no WaitEntry.w)
 *    now stays counted: it gives back nothing, as a community member without
 *    its room's origin does (lib/community.ts).
 * 2. A confirmation's growth was counted after the place was written, with
 *    noteData, which never says whether it counted: a lost count left the
 *    growth stored and never counted, and every later give-back returned it.
 *    The growth is now counted before the write, and the place is written only
 *    once that count is confirmed (as lib/contacts.ts countOrderWrite).
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail, addProduct } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, forgetWaitlistPerson, joinWaitlist, setSoon } from "@/lib/waitlist";
import { parseEntry, CONFIRM_SECONDS } from "@/lib/waitlist-rules";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { dataKey, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") return Response.json({ data: (JSON.parse(String(init?.body ?? "[]")) as unknown[]).map((_, i) => ({ id: `synthetic_${i}` })) });
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const countsRoom = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"));
const OTHERS = 1000;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@growth.example", "ana", "Ana Books", "");
  await ensureStatsId("owner@growth.example");
  await ensureListId("owner@growth.example");
  const made = await addProduct("owner@growth.example", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  let store = (await storeForEmail("owner@growth.example"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  store = (await storeForEmail("owner@growth.example"))!;
  const sid = String(store.statsId);
  const listKey = `nl:wl:${sid}:${product.id}`;
  const slot = `wl:${product.id}`;
  const held = () => Number(redis.run(["HGET", String(dataKey(store)), slot]) ?? 0);
  await noteData(store, [{ slot, bytes: OTHERS }]);

  part("An older place confirmed without its growth counted gives back no more than the slot held for it");
  const email = "pxxxxx@example.com";
  const token = "c".repeat(48);
  const leave = "1f62bf245c362849cfe2d6e66cd6af3e1f62bf245c362849";
  // As main wrote and counted it: the place at ok 0, its link to leave at the real handle.
  const place = JSON.stringify({ at: 1_793_990_000, ok: 0, c: false, t: leave });
  const leaveGrant = JSON.stringify({ s: sid, h: store.handle, p: product.id, e: email, k: "leave" });
  redis.run(["HSET", listKey, email, place]);
  redis.run(["SET", waitlistTokenKey(leave), leaveGrant]);
  redis.run(["SET", waitlistTokenKey(token), JSON.stringify({ s: sid, h: store.handle, p: product.id, e: email, k: "confirm" }), "EX", CONFIRM_SECONDS]);
  const took = dataBytes([email, place], 1) + dataBytes([waitlistTokenKey(leave), leaveGrant], 1);
  await noteData(store, [{ slot, bytes: took }]);
  // Main's confirmation, which counted nothing: ok rewritten to a time.
  redis.run(["HSET", listKey, email, JSON.stringify({ at: 1_793_990_000, ok: 1_794_000_000, c: false, t: leave })]);
  await forgetWaitlistPerson(sid, [product.id], email, store);
  is("the place is gone", redis.run(["HGET", listKey, email]), null);
  is("the slot never drops below the other places", held() >= OTHERS, true);
  is("the confirm link (control) still reads as main's", parseEntry(place)?.ok, 0);

  part("A confirmation whose count is lost never stores growth that is not counted");
  const base = held();
  // Joined as this PR writes a place (w: 1), its room taken; the confirmation email is not this test's subject, so its
  // link is written here as joinWaitlist writes it.
  await joinWaitlist({ store, product, email: "bo@example.com", consent: false, clicks: false, ip: "10.0.0.9", origin: "https://marktmorgen.com" });
  is("Bo's place is written with its mark", parseEntry(redis.run(["HGET", listKey, "bo@example.com"]))?.w, 1);
  const confirm = "e".repeat(48);
  redis.run(["SET", waitlistTokenKey(confirm), JSON.stringify({ s: sid, h: store.handle, p: product.id, e: "bo@example.com", k: "confirm" }), "EX", CONFIRM_SECONDS]);
  const joined = held() - base;
  const real = redis.pipeline.bind(redis);
  let lost = true;
  redis.pipeline = (async (commands: Commands) => {
    if (lost && countsRoom(commands)) {
      lost = false;
      return [undefined];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const pressed = await confirmSpot(confirm, store).catch(() => ({ ok: false as const }));
  redis.pipeline = real;
  const after = parseEntry(redis.run(["HGET", listKey, "bo@example.com"]));
  const confirmed = Boolean(after?.ok);
  const grownNow = held() - base - joined;
  is("a confirmed place has its growth counted", !confirmed || grownNow > 0, true);
  is("not confirmed, the press says so", [pressed.ok, confirmed], [false, false]);
  is("the next press confirms it and counts it", [(await confirmSpot(confirm, store)).ok, held() - base - joined > 0], [true, true]);

  done();
}

void main();
