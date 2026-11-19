/** A form opened while another saves its description must never receive a usable revision for partial content. */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, editProduct, ensureStatsId, ensureStoreId, ownerKey, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = async () => { throw Error("No external provider in this test"); };

async function main() {
  redis.clear();
  const owner = "open-during-save@example.test";
  await claimHandle(owner, "open-during-save", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_OpenDuringSave", true);
  await setSubscription(owner, { customerId: "cus_OpenDuringSave", subscriptionId: "sub_OpenDuringSave", active: true, tier: "pro", period: paidPeriod() });
  const session = await openSession(owner);
  const headers = { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` };
  const form = { title: "Weekly letters", summary: "One letter a week.", price: "20", every: "month", intro: null, yearly: { price: "200" }, about: "" };
  const save = async (id: string, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "edit", id, ...body }) }));
    return { status: response.status, body: await response.json() as { ok?: boolean; error?: string } };
  };

  part("A form opens before the first description or a replacement finishes");
  for (const beforeWords of ["", "The earlier description."]) {
    const made = await addProduct(owner, "Weekly letters", form.summary, "20", { interval: "month", trialDays: 0, payments: 0 });
    if (!made.ok) throw Error("The product fixture failed");
    const id = made.product.id;
    const prepared = await save(id, { ...form, rev: made.product.rev ?? 0, about: beforeWords });
    if (!prepared.body.ok) throw Error("Could not prepare the saved description");
    const before = (await readListing((await storeForEmail(owner))!, id))!;
    const wordsB = "The complete new description from B.";
    const pipeline = redis.pipeline.bind(redis);
    let reached!: () => void;
    let release!: () => void;
    const atDescription = new Promise<void>(resolve => { reached = resolve; });
    const continueB = new Promise<void>(resolve => { release = resolve; });
    let paused = false;
    redis.pipeline = async commands => {
      if (!paused && commands.some(command => command[0] === "SET" && String(command[1]).startsWith("nl:product:about:") && command[2] === wordsB)) {
        paused = true;
        reached();
        await continueB;
      }
      return pipeline(commands);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("The form never reached its description write")), 10_000); });
    const savingB = save(id, { ...form, rev: before.rev, yearly: { price: "210" }, about: wordsB });
    let snapshot: typeof before;
    let aboutAnswer: { status: number; words: string };
    try {
      await Promise.race([atDescription, waiting]);
      // Opening reads are real reads and do not acquire the writer's lock. Exercise the actual description GET too.
      snapshot = (await readListing((await storeForEmail(owner))!, id))!;
      const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/product?about=${id}`, { headers }));
      aboutAnswer = { status: response.status, words: ((await response.json()) as { about: string }).about };
    } finally {
      clearTimeout(timer);
      release();
    }
    const savedB = await savingB;
    redis.pipeline = pipeline;
    const label = beforeWords ? "replacement" : "first description";
    is(`${label}: the read and B's complete save succeed`, [aboutAnswer.status, savedB.status, savedB.body.ok], [200, 200, true]);
    const savingA = await save(id, { ...form, title: "A title from the newly opened form", rev: snapshot.rev, yearly: snapshot.yearly ? { price: String(snapshot.yearly.cents / 100) } : null, about: aboutAnswer.words });
    is(`${label}: the newly opened partial form is refused after B finishes`, [savingA.status, savingA.body.error], [409, "stale"]);
    const kept = (await readListing((await storeForEmail(owner))!, id))!;
    is(`${label}: B's acknowledged price and description survive`, [kept.yearly, await readAbout((await storeForEmail(owner))!.statsId, id)], [{ cents: 21000 }, wordsB]);
  }

  part("A legacy namespace is reachable before any text is written");
  const legacyOwner = "open-during-save-legacy@example.test";
  await claimHandle(legacyOwner, "open-save-legacy", "Synthetic legacy store", "");
  const legacy = await addProduct(legacyOwner, "Legacy letters", "Letters.", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!legacy.ok) throw Error("The legacy fixture failed");
  const legacyKey = await ownerKey(legacyOwner);
  const record = JSON.parse(String(redis.run(["GET", legacyKey])));
  record.statsId = null;
  redis.run(["SET", legacyKey, JSON.stringify(record)]);
  is("the legacy fixture has no description namespace", (await storeForEmail(legacyOwner))?.statsId, null);
  const pipeline = redis.pipeline.bind(redis);
  let refusedNamespace = false;
  let descriptionWrites = 0;
  redis.pipeline = async commands => {
    descriptionWrites += commands.filter(command => command[0] === "SET" && String(command[1]).startsWith("nl:product:about:")).length;
    if (!refusedNamespace && commands.some(command => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:fenced-set:v1") && String(command[4]).startsWith("nl:store:owner:") && String(command[6]).includes('"statsId":"'))) {
      refusedNamespace = true;
      return [0];
    }
    return pipeline(commands);
  };
  let namespaceFailed = false;
  try { await editProduct(legacyOwner, legacy.product.id, "Legacy letters", "Letters.", "20", legacy.product.recurring, null, legacy.product.rev ?? 0, { about: "A reachable description." }); }
  catch { namespaceFailed = true; }
  finally { redis.pipeline = pipeline; }
  is("an unconfirmed namespace creates no orphan description", [refusedNamespace, namespaceFailed, descriptionWrites], [true, true, 0]);
  // Re-read the revision: even an unconfirmed record write may have applied part of its product pipeline.
  const current = (await readProduct((await storeForEmail(legacyOwner))!, legacy.product.id))!;
  const saved = await editProduct(legacyOwner, legacy.product.id, "Legacy letters", "Letters.", "20", legacy.product.recurring, null, current.rev ?? 0, { about: "A reachable description." });
  if (!saved.ok) throw Error("The legacy retry failed");
  const shop = (await storeForEmail(legacyOwner))!;
  is("a successful retry leaves the description findable", [typeof shop.statsId, await readAbout(shop.statsId, legacy.product.id)], ["string", "A reachable description."]);
  done();
}

void main();
