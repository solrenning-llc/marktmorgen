/**
 * Regression: an event notice (the email telling everyone coming that an event was called off) whose batch cannot
 * go because Amazon SES has no bulk room left and the Resend fallback is refused must wait in its queue and go out
 * later, never be dropped (owner, 309 [EM1] unit 2: the email waits in the queue, never discarded; lib/mail.ts
 * SENDER_WAIT_NOTE: "Nothing is lost."). It used sendBatch, whose "retry" for that known no-send counted as a
 * failure; after five runs the notice was marked failed and nobody else was told. While it waits, the store's email
 * figure taken for the batch is given back, so waiting never drains it. Synthetic data only.
 */
import { freshConfig, saveConfig, touchMember } from "@/lib/community";
import { createEvent } from "@/lib/community-events";
import { queueEventNotice, readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.RESEND_API_KEY = "re_test_event_notice_wait";

const OWNER = "event-wait-owner@example.com";
const GOING = ["ann@example.com", "bo@example.com"];
const mail = installSesMailFixture({
  // The fallback is at its paid quota: Resend refuses anything handed to it.
  onResend: () => new Response(JSON.stringify({ message: "Too many requests" }), { status: 429, headers: { "content-type": "application/json" } }),
});

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  // No bulk room on Amazon's day.
  await mail.setReady(true, { max24: 0, rate: 100 });
  await claimHandle(OWNER, "eventwait", "Event wait", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const members = await Promise.all(GOING.map((email) => touchMember(id, email, null, store)));
  const start = Math.floor((Date.now() + 3 * 86_400_000) / 3_600_000) * 3_600_000;
  const made = await createEvent(store, { title: "Wait night", about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 });
  if (!made.ok) throw new Error("no synthetic event");
  await redis.pipeline([["HSET", `nl:cm:${id}:ev:${made.event.id}:r`, members[0]!.k, "100", members[1]!.k, "200"]]);
  const used = await allowanceUsed(store, "email");

  part("a notice over the sender's room waits, never dropped");
  const queued = await queueEventNotice(store, made.event, "cancelled", null);
  is("the notice is queued", Boolean(queued), true);
  for (let run = 0; run < 6; run += 1) await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
  const waiting = await readEventJob(queued!.id);
  is("nothing was handed over to anyone", mail.sent.length, 0);
  is("the notice is not marked failed", waiting?.status === "failed", false);
  is("nobody was skipped past", waiting?.done, 0);
  is("waiting did not use up the store's email figure", await allowanceUsed(store, "email"), used);

  part("once Amazon has room, each of them is told once");
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
  await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
  is("each one got the notice once, by Amazon", mail.sent.filter((m) => m.provider === "ses").flatMap((m) => m.to).sort(), GOING);
  is("the notice is sent", (await readEventJob(queued!.id))?.status, "sent");

  mail.restore();
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
