/**
 * #4639: an event's emails (the day-before and hour-before reminders, and every move or cancel notice) never go to an
 * address the store's list took off for a hard bounce, a spam complaint or a refusal (`gone` with `unsub`, written by
 * lib/contacts.ts stopWriting), as announcements already do (keptOnList, lib/community-mail.ts). A plain list
 * unsubscribe is not read here; a list row in no known shape holds the batch (rule 24). Synthetic only, on
 * tests/r30-event-members.test.ts's setup.
 */
import { freshConfig, saveConfig, touchMember, type Member } from "@/lib/community";
import { createEvent, type CommunityEvent } from "@/lib/community-events";
import { queueEventNotice, readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { leadsKey } from "@/lib/contact-rules";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const OWNER = "gone-owner@example.com";
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const to = (subject: string) => mail.sent.filter((m) => m.subject === subject).flatMap((m) => m.to).sort();

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "goneevents", "Gone events", "A community.");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  if (!store.listId) throw new Error("no synthetic list");
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const everyone = ["member000@example.com", "member001@example.com", "member002@example.com"];
  const MEMBERS = `nl:cm:${id}:m`;
  const members: Member[] = [];
  for (const [i, email] of everyone.entries()) members.push({ ...(await touchMember(id, email, null, store))!, mail: true, t: String(i).repeat(40) });
  for (const m of members) await original([["HSET", MEMBERS, m.k, JSON.stringify(m)]]);
  const rsvps = (e: CommunityEvent) => `nl:cm:${id}:ev:${e.id}:r`;
  // The list's rows: the first marked a broadcast as spam, the second's address bounced hard, the third only left
  // the list (a plain unsubscribe, which the community's own stop link decides for its emails).
  const row = (gone?: string) => JSON.stringify({ unsub: true, ...(gone ? { gone } : {}) });
  await original([["HSET", leadsKey(store.listId), everyone[0], row("complained"), everyone[1], row("bounced"), everyone[2], row()]]);

  async function event(title: string): Promise<CommunityEvent> {
    const start = Math.floor((realNow() + 3 * DAY) / HOUR) * HOUR;
    const made = await createEvent(store, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 }, realNow());
    if (!made.ok) throw new Error("no synthetic event");
    await original([["HSET", rsvps(made.event), ...members.flatMap((m, i) => [m.k, String(100 + i)])]]);
    return made.event;
  }
  async function run(): Promise<void> {
    await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
  }

  part("A move's notice skips the addresses the list took off for a complaint or a bounce");
  {
    const e = await event("Gone night");
    const job = await queueEventNotice(store, { ...e, moves: 1 }, "moved", { start: e.start - DAY, minutes: 60 });
    if (!job) throw new Error("no synthetic send");
    await run();
    await run();
    is("only the address that merely left the list gets it", to("New time: Gone night"), [everyone[2]]);
    is("and the send finishes", (await readEventJob(job.id))?.status, "sent");
  }

  part("A list row in no known shape holds the batch, never read as kept");
  {
    const e = await event("Odd row night");
    const job = await queueEventNotice(store, { ...e, moves: 1 }, "moved", { start: e.start - DAY, minutes: 60 });
    if (!job) throw new Error("no synthetic send");
    const key = leadsKey(store.listId);
    redis.pipeline = (async (c: Commands) => (c.length === 1 && c[0][0] === "HMGET" && c[0][1] === key ? [["{", null, null]] : original(c))) as typeof redis.pipeline;
    try {
      await run();
    } finally {
      redis.pipeline = original;
    }
    is("nobody emailed while the row does not read", to("New time: Odd row night"), []);
    await run();
    await run();
    is("once it reads, the kept address gets it", to("New time: Odd row night"), [everyone[2]]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
