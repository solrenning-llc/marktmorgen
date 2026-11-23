/**
 * The coordinator's 31st triple audit on #4238 @3507d6035a, three MEDIUMs, each held here (synthetic data, Redis
 * stand-in, no provider), and the 36th batch's focal audit on be8e4eb462 (parts 5 and 6):
 *   1. a save refused as stale says what is saved now as read under the store's lock, never the store record the
 *      request read before it waited for the lock (VR 2: "saved now" must be true);
 *   2. a description's room is taken only once the save holds its lock, just before the fenced write, so a save that
 *      fails before it leaves the room as it was (MR: the room never counts less than is kept);
 *   3. every write of the fields the form saves moves the revision on, the agent's too (setProductTitle,
 *      setProductSummary, setProductAbout), so a tab opened before cannot undo an accepted proposal in silence.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, editProduct, ensureStatsId, ensureStoreId, setProductAbout, setProductSummary, setProductTitle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { readAbout } from "@/lib/product-about";
import { PRODUCT_DESCRIPTION } from "@/lib/agent-kinds";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = async () => {
  throw Error("No external provider in this test");
};

type Answer = { status: number; body: { ok?: boolean; error?: string; product?: { rev?: number; title?: string } | null; current?: { rev?: number; title?: string } } };

async function main() {
  redis.clear();
  const owner = "stale-audit@example.test";
  await claimHandle(owner, "stale-audit", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_StaleAudit", true);
  await setSubscription(owner, { customerId: "cus_StaleAudit", subscriptionId: "sub_StaleAudit", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Original title", "One letter a week.", "20", null);
  if (!made.ok) throw Error("Real product fixture failed");
  const id = made.product.id;
  const session = await openSession(owner);
  const save = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await POST(
      new NextRequest("https://marktmorgen.com/api/store/product", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "edit", id, ...body }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Answer["body"] };
  };
  const form = { title: "Original title", summary: "One letter a week.", price: "20", intro: null, yearly: null, about: "" };
  const revNow = async () => (await readListing((await storeForEmail(owner))!, id))!.rev ?? 0;
  const plain = redis.pipeline.bind(redis);

  part("1. A stale refusal says what is saved now, read under the lock");
  const opened = await revNow();
  // Tab B's request has read the store; just before it takes the store's lock, tab A's save goes through.
  let beforeLock: (() => Promise<void>) | null = async () => {
    const a = await save({ ...form, rev: opened, title: "Tab A's title" });
    if (a.status !== 200) throw Error(`tab A's save failed: ${a.status}`);
  };
  redis.pipeline = async (commands) => {
    const lock = commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:store:lock:") && c.includes("NX"));
    if (lock && beforeLock) {
      const run = beforeLock;
      beforeLock = null;
      await run();
    }
    return plain(commands);
  };
  let b: Answer;
  try { b = await save({ ...form, rev: opened, title: "Tab B's title" }); } finally { redis.pipeline = plain; }
  const saved = await revNow();
  is("tab B is refused as stale", [b.status, b.body.error], [409, "stale"]);
  is("the refusal carries tab A's save, as saved now", [b.body.current?.title, b.body.current?.rev], ["Tab A's title", saved]);

  part("2. A save that fails before its fenced write leaves the description's room as it was");
  const room = dataKey((await storeForEmail(owner))!)!;
  const slot = `ab:${id}`;
  const before = (await plain([["HGET", room, slot]]))[0];
  let failTake = true;
  redis.pipeline = async (commands) => {
    // The commit's own room for the product's record: answered with nothing, so the save stops before its writes.
    const take = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:v1") && c.includes(`p:${id}`));
    if (take && failTake) {
      failTake = false;
      return commands.map(() => null);
    }
    return plain(commands);
  };
  let failed: Answer;
  try { failed = await save({ ...form, rev: saved, title: "Tab A's title", about: "x".repeat(4_900) }); } finally { redis.pipeline = plain; }
  is("the save did not go through", failed.body.ok === true, false);
  is("the description's room is as it was", (await plain([["HGET", room, slot]]))[0], before);
  is("and no description was written", (await readListing((await storeForEmail(owner))!, id))!.rev, saved);

  part("3. The agent's writes move the revision on, so a tab opened before is refused");
  const r0 = await revNow();
  is("setProductTitle moves the revision", ((await setProductTitle(owner, id, "Agent title")).ok && (await revNow()) > r0), true);
  const r1 = await revNow();
  is("setProductSummary moves the revision", ((await setProductSummary(owner, id, "Agent summary")).ok && (await revNow()) > r1), true);
  const r2 = await revNow();
  is("setProductAbout moves the revision", ((await setProductAbout(owner, id, false)).ok && (await revNow()) > r2), true);
  const old = await save({ ...form, rev: r0, title: "A tab opened before the agent" });
  is("a tab opened before the agent's proposal is refused, never undoing it", [old.status, old.body.error], [409, "stale"]);
  is("the agent's title stays", (await readListing((await storeForEmail(owner))!, id))!.title, "Agent title");

  part("4. A description that does not fit leaves the product's own room as it was (Claude 4 2Wb's MEDIUM on 249b11f056)");
  // A record made smaller (a long summary shortened) with a description the room has no place for: the save is refused,
  // the old record stays, and so must every slot it counts, the product's own included (MR: never less than is kept).
  const longSummary = "s".repeat(300);
  const summed = await setProductSummary(owner, id, longSummary);
  if (!summed.ok) throw Error("summary fixture failed");
  const recordSlot = `p:${id}`;
  const slotsBefore = await plain([["HGET", room, recordSlot], ["HGET", room, slot]]);
  redis.pipeline = async (commands) => {
    // Every take that names the description's slot is answered full, as a room with no place left answers.
    const full = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:v1") && c.includes(slot));
    return full ? commands.map(() => [0, 1000]) : plain(commands);
  };
  let refused = "";
  try {
    await editProduct(owner, id, "Agent title", "short", "20", null, null, await revNow(), { about: "a long description" });
  } catch (error) {
    refused = error instanceof Error ? error.name : String(error);
  } finally {
    redis.pipeline = plain;
  }
  is("the save is refused", refused !== "", true);
  is("the summary kept is the long one", (await readListing((await storeForEmail(owner))!, id))!.summary, longSummary);
  is("the product's own room and the description's are as they were", await plain([["HGET", room, recordSlot], ["HGET", room, slot]]), slotsBefore);

  part("5. A save whose lock is lost after the room was reserved never counts less than is kept (36th batch, MEDIUM 1)");
  const kept = "k".repeat(4_900);
  const keptSave = await save({ ...form, rev: await revNow(), title: "Agent title", about: kept });
  is("the long description is saved", keptSave.status, 200);
  const keptBytes = dataBytes([kept], 1);
  let dropLock = true;
  redis.pipeline = async (commands) => {
    // The store's lock, made to last before the writes (holdLock), is found lost: the save stops after its room's take.
    const extend = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:extend:v1") && String(c[3]).startsWith("nl:store:lock:"));
    if (extend && dropLock) {
      dropLock = false;
      return commands.map(() => 0);
    }
    return plain(commands);
  };
  let lost: Answer;
  try { lost = await save({ ...form, rev: await revNow(), title: "Agent title", about: "short" }); } finally { redis.pipeline = plain; }
  is("the save did not go through", lost.body.ok === true, false);
  is("the long description is still kept", await readAbout((await storeForEmail(owner))!.statsId, id), kept);
  is("and its room still counts it", Number((await plain([["HGET", room, slot]]))[0]) >= keptBytes, true);

  part("6. An agent's description goes in one step under the lock: a tab saving meanwhile cannot undo it in silence (MEDIUMs 2 and 3)");
  const aboutKeyNow = `nl:product:about:${(await storeForEmail(owner))!.statsId}:${id}`;
  const opened6 = await revNow();
  let tab: Answer | null = null;
  let tabLater = false;
  redis.pipeline = async (commands) => {
    const writesAbout = commands.some((c) => c[0] === "EVAL" && c.includes(aboutKeyNow));
    if (!writesAbout || tab || tabLater) return plain(commands);
    const reply = await plain(commands);
    // A write of the description outside the store's lock: the tab's save lands right after it, before the rest.
    if (String(commands[0]?.[1] ?? "").startsWith("-- marktmorgen:about-write-live")) tab = await save({ ...form, rev: opened6, title: "Agent title", about: "the tab's words" });
    else tabLater = true;
    return reply;
  };
  let agent: unknown;
  try {
    agent = await PRODUCT_DESCRIPTION.write!((await storeForEmail(owner))!, owner, id, "The agent's accepted words.", kept);
  } finally { redis.pipeline = plain; }
  tab ??= await save({ ...form, rev: opened6, title: "Agent title", about: "the tab's words" });
  is("the agent's write is taken", agent, true);
  is("the tab opened before it is refused", [tab.status, tab.body.error], [409, "stale"]);
  is("the agent's words are kept", await readAbout((await storeForEmail(owner))!.statsId, id), "The agent's accepted words.");
  is("and their room counts them", Number((await plain([["HGET", room, slot]]))[0]) >= dataBytes(["The agent's accepted words."], 1), true);

  part("7. The description's slot is read in its exact shape (Claude 4 3rC's LOW 1 on 5bb7b1a78e, rule 24)");
  // Only nil or a string of digits is a count; String() would read ["12"] and the number 12 as "12".
  for (const odd of [["12"], 12, "", "12x", true]) {
    const aboutNow = await readAbout((await storeForEmail(owner))!.statsId, id);
    redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === room && commands[0][2] === slot ? [odd] : plain(commands));
    let answer: Answer;
    try { answer = await save({ ...form, rev: await revNow(), title: "Agent title", about: "words after an odd count" }); } finally { redis.pipeline = plain; }
    is(`a count read as ${JSON.stringify(odd)} saves nothing`, [answer.body.ok === true, await readAbout((await storeForEmail(owner))!.statsId, id)], [false, aboutNow]);
  }

  part("8. The description's slot is read before anything moves to the beside pool (Claude 4 3rC's LOW 2 on 5bb7b1a78e)");
  const order: string[] = [];
  let hgetFails = true;
  redis.pipeline = async (commands) => {
    for (const c of commands) {
      if (c[0] === "HGET" && c[1] === room && c[2] === slot) order.push("about-slot");
      else if (c.some((part) => part === `${room}:b`)) order.push("beside");
    }
    if (hgetFails && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === room && commands[0][2] === slot) {
      hgetFails = false;
      throw Error("synthetic lost read of the description's slot");
    }
    return plain(commands);
  };
  let lostRead: Answer;
  try { lostRead = await save({ ...form, rev: await revNow(), title: "Agent title", about: "words after a lost read" }); } finally { redis.pipeline = plain; }
  is("a lost read of the slot saves nothing", lostRead.body.ok === true, false);
  is("the slot was read, and the beside pool was not touched at all", [order.includes("about-slot"), order.includes("beside")], [true, false]);

  part("9. A save whose fenced write landed but whose answer was lost does not hold the next save as stale (triple audit, LEVE 4)");
  const shownRev = await revNow();
  let loseAnswer = true;
  redis.pipeline = async (commands) => {
    const fencedWrite = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:product-with-about:"));
    if (fencedWrite && loseAnswer) {
      loseAnswer = false;
      await plain(commands);
      throw Error("synthetic lost answer of the product's record and description");
    }
    return plain(commands);
  };
  let half: Answer;
  try { half = await save({ ...form, rev: shownRev, title: "Half-written title", about: "half-written words" }); } finally { redis.pipeline = plain; }
  is("the half-written save is answered as failed", half.body.ok === true, false);
  is("the store still lists the revision the form was opened at", await revNow(), shownRev);
  const next = await save({ ...form, rev: shownRev, title: "The next save's title", about: "the next save's words" });
  is("the next save from the revision the store lists goes through", [next.status, next.body.ok], [200, true]);
  is("and its words are what is kept", [(await readListing((await storeForEmail(owner))!, id))!.title, await readAbout((await storeForEmail(owner))!.statsId, id)], ["The next save's title", "the next save's words"]);
  const late = await save({ ...form, rev: shownRev, title: "A tab opened before both" });
  is("a form opened before a save that went through is still refused as stale", [late.status, late.body.error], [409, "stale"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
