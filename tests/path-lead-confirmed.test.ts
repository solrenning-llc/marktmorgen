/**
 * Marktmorgen Path counts a lead only when the address uses its confirmation
 * link, never because the email asking for it was sent (13 [D10]).
 *
 *   - the counts Path reads its leads from are the confirmed ones on the
 *     store's all-time record (lc), never the addresses asked for (fs:<channel>),
 *     which the store's numbers keep as they are;
 *   - an address is one lead for a store, however it confirms: a waitlist
 *     spot, a sign-up that makes it newly mailable, a free product's emailed
 *     link; again, twice at once, another product or another way of writing
 *     the address count nothing more (review 6748073377 of #3431, M1 and L3);
 *   - the count has its own field outside the record's capped count, so a
 *     full record never hides it under "~", and an answer in another shape is
 *     logged by the route (L4);
 *   - the mark that keeps an address to one lead holds a one-way fingerprint,
 *     never the address, and goes with the person (lib/erasure-index.ts);
 *   - sending the confirmation email counts nothing for Path.
 *
 * Every confirmation goes through the real route handlers with synthetic
 * POSTs (L5). Synthetic stores and addresses, against the in-memory Redis;
 * no email is sent.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { setSoon } from "@/lib/waitlist";
import { newWaitlistToken, waitlistTokenKey } from "@/lib/waitlist-tokens";
import { LIFE_WRITE_MAX, readLifeRecord } from "@/lib/stats";
import { countsFrom } from "@/lib/path-facts";
import { forgetNoted } from "@/lib/erasure-index";
import { PATH_LEAD_COMMANDS, countConfirmedLead } from "@/lib/path-lead";
import { POST as joinConfirm } from "@/app/api/store/join/confirm/route";
import { POST as waitConfirm } from "@/app/api/store/waitlist/confirm/route";
import { POST as freeDownload } from "@/app/api/store/free/download/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const press = (path: string, token: string) => {
  const form = new FormData();
  form.set("token", token);
  return new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form });
};
const statusOf = async (response: Promise<Response>) => (await response).status;
/**
 * Two presses at once, as a double click sends them: every trip to the database waits a turn first, so the two
 * requests go step by step side by side, each read landing before the other's write, as on a real server.
 */
async function atOnce<T>(a: () => Promise<T>, b: () => Promise<T>, meet?: (commands: (string | number)[][]) => boolean): Promise<T[]> {
  const pipe = redis.pipeline.bind(redis);
  // `meet`: the read each request decides on, held until both have reached it, so neither has written yet.
  let waiting: (() => void) | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (meet?.(commands)) {
      if (waiting) {
        waiting();
        waiting = null;
      } else {
        await new Promise<void>((resolve) => {
          waiting = resolve;
          setTimeout(() => (waiting === resolve ? (waiting = null, resolve()) : undefined), 200);
        });
      }
    }
    return pipe(commands);
  }) as typeof redis.pipeline;
  try {
    return await Promise.all([a(), b()]);
  } finally {
    redis.pipeline = pipe;
  }
}

/** A waitlist spot as joinWaitlist leaves it (lib/waitlist.ts): asked, not yet confirmed; set here so no email has to go. */
function waitSpot(store: Store, productId: string, email: string): string {
  const token = newWaitlistToken();
  redis.run(["HSET", `nl:wl:${store.statsId}:${productId}`, email, JSON.stringify({ at: Date.now(), ok: 0, c: false, t: newWaitlistToken() })]);
  redis.run(["SET", waitlistTokenKey(token), JSON.stringify({ s: store.statsId, h: store.handle, p: productId, e: email, k: "confirm" }), "EX", 3_600]);
  return token;
}
/** A sign-up link as askToJoin leaves it (lib/store-join.ts). */
function joinLink(store: Store, email: string): string {
  const token = randomBytes(24).toString("hex");
  redis.run(["SET", `nl:join:t:${sha(`nimbus-join:${token}`)}`, JSON.stringify({ s: store.statsId, h: store.handle, e: email, at: new Date().toISOString() }), "EX", 3_600]);
  return token;
}
/** A free copy's link as requestCopy leaves it (lib/free.ts). */
function freeLink(store: Store, productId: string, email: string): string {
  const token = randomBytes(32).toString("hex");
  redis.run(["SET", `nl:free:claim:${sha(`nimbus-free-claim:${token}`).slice(0, 40)}`, JSON.stringify({ h: store.handle, p: productId, e: email, c: true, at: new Date().toISOString() }), "EX", 3_600]);
  return token;
}

async function makeStore(owner: string, handle: string): Promise<{ store: Store; free: string[]; soon: string }> {
  await claimHandle(owner, handle, "Path Leads", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const free: string[] = [];
  for (const title of ["Starter Guide", "Second Guide"]) {
    const made = await addProduct(owner, title, "", "0", null);
    if (!made.ok) throw new Error(`no product: ${made.reason}`);
    await setProductLink(owner, made.product.id, "https://example.com/guide.pdf");
    free.push(made.product.id);
  }
  const paid = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!paid.ok) throw new Error("no product");
  let store = (await storeForEmail(owner))!;
  await setSoon(store, paid.product.id, true);
  store = (await storeForEmail(owner))!;
  for (const id of free) if (!(await readListing(store, id))?.link) throw new Error("no link on the free product");
  return { store, free, soon: paid.product.id };
}

async function main(): Promise<void> {
  redis.clear();
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));

  part("Path reads confirmed leads only, never the addresses asked for");
  is("asked for, never confirmed: no lead", countsFrom(new Map([["fs:instagram", 4], ["fs:direct", 2]]), 0, 0).leads, 0);
  is("confirmed: each one a lead", countsFrom(new Map([["fs:instagram", 4], ["lc", 3]]), 0, 0).leads, 3);
  is("a count of another shape is no lead", countsFrom(new Map([["lc", Number.NaN]]), 0, 0).leads, 0);

  const { store, free, soon } = await makeStore("owner@example.com", "pathleads");
  const leads = async (s: Store = store) => (await readLifeRecord(s.statsId)).get("lc") ?? 0;

  part("A waitlist spot: one lead for two presses at once, none for a later press (M1)");
  const wait = waitSpot(store, soon, "dana@example.com");
  is("asking counted no lead", await leads(), 0);
  const both = await atOnce(() => statusOf(waitConfirm(press("/api/store/waitlist/confirm", wait))), () => statusOf(waitConfirm(press("/api/store/waitlist/confirm", wait))), (cs) => cs.some((c) => c[0] === "HGET" && c[1] === `nl:wl:${store.statsId}:${soon}`));
  is("both presses confirm it", both, [303, 303]);
  is("one lead, not two", await leads(), 1);
  await waitConfirm(press("/api/store/waitlist/confirm", wait));
  is("a later press counts nothing", await leads(), 1);

  part("Joining the list: one lead for two presses at once (M1)");
  const join = joinLink(store, "erin@example.com");
  const joined = await atOnce(() => statusOf(joinConfirm(press("/api/store/join/confirm", join))), () => statusOf(joinConfirm(press("/api/store/join/confirm", join))));
  is("both presses answer", joined, [303, 303]);
  is("one lead, not two", await leads(), 2);

  part("A free product's emailed link: one lead for two uses at once (M1)");
  const copy = freeLink(store, free[0], "gil@example.com");
  const used = await atOnce(() => statusOf(freeDownload(press("/api/store/free/download", copy))), () => statusOf(freeDownload(press("/api/store/free/download", copy))));
  is("both uses hand the product over", used.every((s) => s < 400), true);
  is("one lead, not two", await leads(), 3);
  await freeDownload(press("/api/store/free/download", copy));
  is("a later use counts nothing", await leads(), 3);

  part("An address is one lead for the store, however it confirms (L3)");
  await freeDownload(press("/api/store/free/download", freeLink(store, free[1], "gil@example.com")));
  is("a second free product, the same address: no second lead", await leads(), 3);
  await freeDownload(press("/api/store/free/download", freeLink(store, free[1], "Gil@Example.com")));
  is("the address written another way: none either", await leads(), 3);
  await joinConfirm(press("/api/store/join/confirm", joinLink(store, "dana@example.com")));
  is("an address confirmed on a waitlist, joining the list after: none either", await leads(), 3);
  await waitConfirm(press("/api/store/waitlist/confirm", waitSpot(store, soon, "erin@example.com")));
  is("an address that joined the list, confirming a waitlist after: none either", await leads(), 3);

  part("A lead is kept by a one-way mark, never the address, and the mark goes with the person");
  const marks = () => (redis.run(["SCAN", "0", "MATCH", `nl:pathlead:${store.statsId}:*`, "COUNT", 1_000]) as [string, string[]])[1];
  is("one mark for each of the three addresses", marks().length, 3);
  is("no mark names an address", marks().some((key) => key.includes("@") || key.includes("dana") || key.includes("gil")), false);
  await forgetNoted(store.statsId, "dana@example.com");
  is("deleting the person deletes their mark", marks().length, 2);

  part("The count is never hidden under \"~\" when the all-time record is full (L4)");
  const { store: full } = await makeStore("full@example.com", "pathfull");
  const life = `nl:stats:${full.statsId}:life`;
  redis.run(["HSET", life, ...Array.from({ length: LIFE_WRITE_MAX }, (_, i) => [`r:s${i}`, "1"]).flat()]);
  await joinConfirm(press("/api/store/join/confirm", joinLink(full, "hal@example.com")));
  const record = await readLifeRecord(full.statsId);
  is("the lead is counted as a lead, not under \"~\"", [record.get("lc"), record.get("~")], [1, undefined]);

  part("A count whose answer is in another shape is logged by the route, never silent (L4)");
  const pipe = redis.pipeline.bind(redis);
  const lifeOf = `nl:stats:${store.statsId}:life`;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipe(commands);
    return commands.map((c, i) => (c.includes(lifeOf) && (c[0] === "EVAL" || (c[0] === "HINCRBY" && c[2] === "lc")) ? "garbage" : replies[i]));
  }) as typeof redis.pipeline;
  logged.length = 0;
  await joinConfirm(press("/api/store/join/confirm", joinLink(store, "ivy@example.com")));
  redis.pipeline = pipe;
  is("said in the server's log", logged.some((line) => line.includes("counting a confirmed lead failed")), true);

  part("What a lead costs is held: never more commands than PATH_LEAD_COMMANDS, the line's figure (M2)");
  {
    const pipe = redis.pipeline.bind(redis);
    const sent: (string | number)[][] = [];
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return pipe(commands);
    }) as typeof redis.pipeline;
    const first = await countConfirmedLead(store.statsId, "kim@example.com");
    const firstCommands = sent.length;
    sent.length = 0;
    const again = await countConfirmedLead(store.statsId, "kim@example.com");
    redis.pipeline = pipe;
    is("the counting call: the note, the mark and the count", [first, firstCommands], ["counted", PATH_LEAD_COMMANDS]);
    is("a call for an address already counted: the note and the mark only", [again, sent.length], ["already", PATH_LEAD_COMMANDS - 1]);
    is("and neither takes a public request or touches a capped count", sent.some((c) => c[0] === "EVAL"), false);
  }

  part("Asking counts nothing for Path");
  for (const path of ["app/api/store/join/route.ts", "app/api/store/waitlist/join/route.ts", "app/api/store/free/route.ts"]) {
    is(`${path}: asking counts no lead`, /countConfirmedLead|path-lead/.test(readFileSync(path, "utf8")), false);
  }

  console.error = realError;
  done();
}

main();
