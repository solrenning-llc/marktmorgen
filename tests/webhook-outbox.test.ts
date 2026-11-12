/**
 * A creator's webhook event noticed only once is never lost to one failure while it is queued (#4284, #4275;
 * Codex P's hidden #4106 and #4053, transcribed by Claude 1).
 *
 * The free download route (lead.captured) and the join confirmation (list.joined) awaited emitEvent and only logged
 * its failure: the link was used, the lead or sign-up recorded, and nothing ever tried the event again. Now the
 * event is kept (lib/webhook-outbox.ts) and the five-minute job gives it to emitEvent again until it is queued,
 * once (the event's id comes from its seed). It is never sent about a person deleted from the store since, nor for
 * a store that is gone.
 *
 * Synthetic store, in-memory Redis, stand-ins for the email sender; nothing real is reached.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as download } from "@/app/api/store/free/download/route";
import { POST as confirm } from "@/app/api/store/join/confirm/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setJoin, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { askToJoin } from "@/lib/store-join";
import { addEndpoint, QUEUE_KEY } from "@/lib/webhooks";
import * as outbox from "@/lib/webhook-outbox";
import { emitOrKeep, replayKept } from "@/lib/webhook-outbox";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(String(JSON.parse(String(init?.body)).text));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Fails the next write of a webhook delivery (nl:hooks:d:) once, as a Redis timeout would. */
let failDeliveryWrites = 0;
redis.pipeline = (async (commands: Cmd[]) => {
  if (failDeliveryWrites > 0 && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:hooks:d:"))) {
    failDeliveryWrites -= 1;
    throw new Error("synthetic: Redis request timed out");
  }
  return original(commands);
}) as typeof redis.pipeline;

const drainAfter = async () => {
  for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
};
const queued = async () => Number((await original([["ZCARD", QUEUE_KEY]]))[0]);
const later = (minutes: number) => Date.now() + minutes * 60_000;
const quietly = async <T>(body: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.error = log;
  }
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  const OWNER = "outbox@example.com";
  await claimHandle(OWNER, "outboxshop", "Outbox", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Outbox00001", subscriptionId: "sub_Outbox00001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin(OWNER, { on: true });
  const made = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide.pdf");
  const store = (await storeForEmail(OWNER))!;
  const free = (await readListing(store, made.product.id))!;
  is("an endpoint listens to both events", (await addEndpoint(store, "https://hooks.example.com/in", ["lead.captured", "list.joined"])).ok, true);

  // The claim requestCopy (lib/free.ts) keeps after emailing the link, written as it writes it (claimKey).
  let seq = 0;
  const freeLink = async (email: string) => {
    seq += 1;
    const token = createHash("sha256").update(`outbox-token-${seq}`).digest("hex");
    const key = `nl:free:claim:${createHash("sha256").update(`nimbus-free-claim:${token}`).digest("hex").slice(0, 40)}`;
    await original([["SET", key, JSON.stringify({ h: store.handle, p: free.id, e: email, c: true, at: new Date().toISOString() }), "EX", 604800]]);
    return token;
  };
  const press = (token: string) => {
    const form = new FormData();
    form.set("token", token);
    return download(new NextRequest("https://marktmorgen.com/api/store/free/download", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  };
  const askJoin = async (email: string) => {
    is(`a confirmation goes to ${email}`, await askToJoin({ store, email, ip: "192.0.2.9", origin: "https://marktmorgen.com" }), "sent");
    return sent.at(-1)?.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";
  };
  const join = (token: string) => {
    const form = new FormData();
    form.set("token", token);
    return confirm(new NextRequest("https://marktmorgen.com/api/store/join/confirm", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  };

  const joinToken = await askJoin("eli@example.com");
  part("A free copy: the delivery write fails once, the buyer gets the file, and the job queues the event");
  const token = await freeLink("dana@example.com");
  failDeliveryWrites = 1;
  const handed = await quietly(() => press(token));
  await quietly(drainAfter);
  is("the buyer gets the link", handed.status, 303);
  is("nothing queued yet", await queued(), 0);
  const first = await replayKept(later(1), later(6));
  is("the job queues it", [first.sent, await queued()], [1, 1]);
  const again = await replayKept(later(1), later(60));
  is("and never twice", [again.tried, await queued()], [0, 1]);
  await original([["DEL", QUEUE_KEY]]);

  part("A sign-up: the delivery write fails once in the after() work, and the job queues the event");
  failDeliveryWrites = 1;
  const joined = await quietly(() => join(joinToken));
  await quietly(drainAfter);
  is("the sign-up is confirmed", joined.headers.get("location")?.includes("status=joined"), true);
  is("nothing queued yet", await queued(), 0);
  is("the job queues it", [(await replayKept(later(1), later(6))).sent, await queued()], [1, 1]);
  await original([["DEL", QUEUE_KEY]]);

  part("Still failing: tried again later, never dropped while its week lasts");
  const stubborn = await freeLink("fay@example.com");
  failDeliveryWrites = 2;
  await quietly(() => press(stubborn));
  await quietly(drainAfter);
  const failed = await quietly(() => replayKept(later(1), later(6)));
  is("the second try fails too: kept for later", [failed.later, await queued()], [1, 0]);
  is("then it goes", [(await replayKept(later(1), later(60))).sent, await queued()], [1, 1]);
  await original([["DEL", QUEUE_KEY]]);

  part("A person deleted from the store before the retry is never sent");
  const erased = await freeLink("gus@example.com");
  failDeliveryWrites = 1;
  await quietly(() => press(erased));
  await quietly(drainAfter);
  await original([suppressCommand(store.listId!, "gus@example.com", Math.floor(Date.now() / 1000))]);
  const dropped = await replayKept(later(1), later(6));
  is("let go, nothing queued", [dropped.dropped, dropped.sent, await queued()], [1, 0, 0]);

  part("A full outbox admits nothing more: kept events never pass the company's ceiling (Codex X5 on #4319)");
  const CAP = 1_000;
  is("the ceiling is the one priced", (outbox as Record<string, unknown>).OUTBOX_MAX_KEPT, CAP);
  for (let i = 0; i < CAP; i += 1) await original([["ZADD", "nl:hookout:due", later(60 * 24) / 1000, `evt_${createHash("md5").update(`filler-${i}`).digest("hex")}`]]);
  const full = await freeLink("ida@example.com");
  failDeliveryWrites = 1;
  const pressed = await quietly(() => press(full));
  await quietly(drainAfter);
  is("the buyer still gets the link", pressed.status, 303);
  is("nothing more in line", Number((await original([["ZCARD", "nl:hookout:due"]]))[0]), CAP);
  is("and no record written past it", (await original([["SCAN", 0, "MATCH", "nl:hookout:evt_*", "COUNT", 1000]]))[0], ["0", []]);
  failDeliveryWrites = 1;
  is("said as lost, never as kept", await quietly(() => emitOrKeep(store, "lead.captured", "ceiling-seed", { email: "jo@example.com" })), "lost");
  is("still at the ceiling", Number((await original([["ZCARD", "nl:hookout:due"]]))[0]), CAP);
  await original([["DEL", "nl:hookout:due"]]);

  part("Control: with no failure the event is queued at once and nothing is kept");
  await press(await freeLink("hal@example.com"));
  await drainAfter();
  is("queued at once", await queued(), 1);
  is("nothing left for the job", (await replayKept(later(1), later(6))).tried, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
