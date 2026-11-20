/**
 * An RSVP admitted before a person's erasure cannot write their place back after the erasure finished (L-20261120-1245,
 * Codex L, MEDIUM, privacy): the write checks the store's one-way erasure print in the same Redis step, so either the
 * RSVP lands first and the eraser deletes it, or the erasure lands first and the RSVP writes nothing. Synthetic only.
 */
import { createEvent, forgetRsvpsPerson, rsvp, rsvpsOf } from "@/lib/community-events";
import { memberKey } from "@/lib/community";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription } from "@/lib/store";
import { suppressCommand } from "@/lib/suppression";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "club@rsvp-race.example";
  await claimHandle(owner, "rsvpraceclub", "RSVP race club", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, {
    customerId: "cus_RsvpRace1",
    subscriptionId: "sub_RsvpRace1",
    active: true,
    tier: "pro",
    period: paidPeriod(),
  });
  const club = (await setCommunity(owner, true))!;
  const id = club.community!.id;
  const made = await createEvent(club, {
    title: "Bread night",
    about: "Synthetic only.",
    start: Date.now() + 86_400_000,
    minutes: 60,
    tz: "UTC",
    cap: 0,
    where: "room",
    link: "",
    meet: null,
    only: [],
  });
  if (!made.ok || !club.listId) throw new Error("event/list unavailable");

  const email = "pending-rsvp@example.test";
  const who = memberKey(email);
  const original = redis.pipeline.bind(redis);
  let reached!: () => void;
  const writeReached = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  redis.pipeline = (async (commands: Command[]) => {
    const admission = commands.some(
      (command) => command[0] === "HSETNX" || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:event-rsvp-add:v1\n")),
    );
    if (!paused && admission) {
      paused = true;
      reached();
      await hold;
    }
    return original(commands);
  }) as typeof redis.pipeline;

  part("An in-flight RSVP cannot restore a person after erasure finishes");
  const pending = rsvp(id, made.event, who, club, Date.now(), { listId: club.listId, email });
  await writeReached;
  try {
    await original([suppressCommand(club.listId, email)]);
    await forgetRsvpsPerson(id, who, email);
    is("erasure completes while no RSVP is visible", await rsvpsOf(id, who), []);
  } finally {
    release();
  }
  const result = await pending;
  redis.pipeline = original;
  is("the older RSVP is refused", result, "closed");
  is("the erased person is absent from the export", await rsvpsOf(id, who), []);
  done();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
