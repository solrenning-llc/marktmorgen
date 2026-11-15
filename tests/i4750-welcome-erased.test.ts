/**
 * Issue #4750 (erasure, MEDIUM; Codex L, transcribed by Claude 2): the welcome offer's reminder (lib/welcome-offer-send.ts,
 * scheduleReminder) claimed the person's reminder mark, then queued the reminder in another step. An erasure in
 * between deleted the mark and found nothing queued yet; the late ZADD then kept the plain address and the free copy's
 * token in the queue, with no mark left to find it by. Now the reminder is queued only while the mark still holds this
 * claim's own value, in one step. Transcribed from the issue; synthetic data, in-memory Redis.
 */
import { remindAt } from "@/lib/welcome-offer";
import { scheduleReminder } from "@/lib/welcome-offer-send";
import { readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { erasePerson } from "@/lib/person-erasure";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";
const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return json({ id: "email_1" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const HOUR = 3600;

async function main(): Promise<void> {

  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWelcome001", true);
  await setSubscription(OWNER, { customerId: "cus_Welcome0001", subscriptionId: "sub_Welcome0001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });

  let store = (await storeForEmail(OWNER))!;
  const email = "late@example.com";
  const product = (await readListing(store, free.product.id))!;
  const before = sent.length;
  const result = await requestCopy({ store, product, email, consent: true, ip: "10.0.0.0", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(sent[before].text)?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  const began = Math.floor(Date.parse(claim.at) / 1000);
  await recordLead(store, claim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;

  const waitingFor = async () => {
    const [flat] = await redis.pipeline([["ZRANGEBYSCORE", "nl:wo:due", "-inf", "+inf", "WITHSCORES"]]);
    const list = (flat as string[]) ?? [];
    const out: unknown[] = [];
    for (let i = 0; i + 1 < list.length; i += 2) if ((JSON.parse(list[i]) as { e?: string }).e === email) out.push(list[i]);
    return out;
  };

  // The first ZADD to the queue pauses before it applies; the erasure runs in that gap.
  const real = redis.pipeline.bind(redis);
  let reached!: () => void;
  const queueWriteReached = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The queue's write: a ZADD, or since #4750 the step that queues only while the mark is this claim's.
    const queueWrite = (commands[0]?.[0] === "ZADD" && commands[0]?.[1] === "nl:wo:due") || (commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:zadd-if-mark:"));
    if (!paused && queueWrite) {
      paused = true;
      reached();
      await released;
    }
    return real(commands);
  }) as typeof redis.pipeline;

  part("An in-flight welcome reminder scheduled before a buyer's erasure");
  const pending = scheduleReminder(store, claim, token, began + HOUR);
  await queueWriteReached;
  try {
    is("erasure completes", (await erasePerson(store, email, { kind: "person" })).ok, true);
    is("no reminder when erasure finishes", (await waitingFor()).length, 0);
  } finally {
    release();
  }
  await pending;
  is("the old scheduler leaves no reminder with the address", (await waitingFor()).length, 0);
  is("(control) a due time exists", remindAt(began, 48) > began, true);

  part("Control: a consented request nobody erased is queued as before");
  const kept = "kept@example.com";
  const keptBefore = sent.length;
  const keptResult = await requestCopy({ store, product, email: kept, consent: true, ip: "10.0.0.1", origin: "https://marktmorgen.com" });
  if (keptResult !== "sent") throw new Error(`not sent: ${keptResult}`);
  const keptToken = /token=([0-9a-f]{64})/.exec(sent[keptBefore].text)?.[1] ?? "";
  const keptClaim = (await readClaimFull(keptToken))!;
  await recordLead(store, keptClaim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  const keptBegan = Math.floor(Date.parse(keptClaim.at) / 1000);
  const runOne = redis.run.bind(redis);
  let commands = 0;
  redis.run = ((c: (string | number)[]) => { commands += 1; return runOne(c); }) as typeof redis.run;
  const scheduled = await scheduleReminder(store, keptClaim, keptToken, keptBegan + HOUR).finally(() => { redis.run = runOne; });
  console.log(`  a reminder scheduled: ${commands} commands, a script's own counted`);
  is("scheduled", scheduled, true);
  is("in at most 7 commands, inside the free copy's order (line orders)", commands <= 7, true);
  const [flatKept] = await redis.pipeline([["ZRANGEBYSCORE", "nl:wo:due", "-inf", "+inf"]]);
  is("and queued", (flatKept as string[]).filter((m) => (JSON.parse(m) as { e?: string }).e === kept).length, 1);
  done();
}
main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
