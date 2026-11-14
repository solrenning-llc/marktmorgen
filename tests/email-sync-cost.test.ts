/**
 * What handing one person to the creator's email platform costs at its worst (lib/email-sync.ts, queuePerson and the
 * tries after it), measured with the real code against the in-memory Redis double and a synthetic platform
 * (tests/email-sync-cost-world.ts: nothing leaves the process). CI audit of the cost registry, 14 November 2026: until
 * then no line of tests/plan-cost-registry.ts named lib/email-sync.ts at all, though every order, free copy and
 * confirmed sign-up of a store with a platform connected runs it.
 *
 * The worst person: a buyer of two products, each with MAX_TAGS_PER_PRODUCT tags at MAX_TAG_LENGTH, none known to the
 * platform yet, so every tag is looked up, made and kept; and every try but the last refused by the platform, so it
 * is tried MAX_ATTEMPTS times. Each try waits at most its budget (JOB_MS the first, after the answer; JOB_MS_IN_RUN each
 * retry, in the five-minute job). Held to EMAIL_SYNC_PERSON_* in the registry, which prices it.
 */
import { MAX_ATTEMPTS, MAX_TAGS_PER_PRODUCT, RETRY_MINUTES, MAX_TAG_LENGTH, QUEUE_KEY, queuePerson, syncDue } from "@/lib/email-sync";
import { seal } from "@/lib/secret-box";
import type { Store } from "@/lib/store";
import { platform } from "./email-sync-cost-world";
import { CART_STOCK_SHARE_OF_ORDER_COMPUTE, COMMAND, DB_BYTE, EMAIL_SYNC_PERSON, EMAIL_SYNC_PERSON_COST, ORDER_COMPUTE, ORDER_COST, UNIT_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const STATS = "costsync000001";
const store = { statsId: STATS } as Store;
const cfgKey = `nl:esync:cfg:${STATS}`;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
const seen = { commands: 0, bytes: 0 };
let measuring = false;
redis.pipeline = (async (batch: Batch) => {
  const [command] = batch;
  let replies: unknown[];
  // The queue's lease (a script the in-memory double does not run), emulated as it reads.
  if (batch.length === 1 && command?.[0] === "EVAL" && String(command[1]).includes("ZSCORE")) {
    const [, , , key, member, now, until] = command;
    const due = redis.run(["ZSCORE", String(key), String(member)]);
    if (due === null || Number(due) > Number(now)) replies = [0];
    else {
      redis.run(["ZADD", String(key), Number(until), String(member)]);
      replies = [1];
    }
  } else replies = await original(batch);
  if (measuring) {
    seen.commands += batch.length;
    seen.bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(replies));
  }
  return replies;
}) as typeof redis.pipeline;

async function measured(run: () => Promise<unknown>): Promise<{ commands: number; bytes: number; calls: number }> {
  Object.assign(seen, { commands: 0, bytes: 0 });
  platform.calls = 0;
  measuring = true;
  try {
    await run();
  } finally {
    measuring = false;
  }
  return { commands: seen.commands, bytes: seen.bytes, calls: platform.calls };
}

const tag = (product: number, n: number, suffix: string) => `${suffix}p${product}n${n}`.padEnd(MAX_TAG_LENGTH, "t");
const products = [
  { id: "prodaaaa01", title: "A".repeat(120) },
  { id: "prodbbbb02", title: "B".repeat(120) },
];

function connect(tagSuffix: string): void {
  const now = Date.now();
  const tags: Record<string, string[]> = {};
  products.forEach((p, i) => (tags[p.id] = Array.from({ length: MAX_TAGS_PER_PRODUCT }, (_, n) => tag(i, n, tagSuffix))));
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "costsync", provider: "kit", key: seal("kit_synthetic_key_0000", `email-sync|${STATS}|kit`), last4: "0000", target: { id: "form1", name: "Synthetic form" }, free: true, buyers: "all", products: [], tags, since: now - 60_000, connectedAt: now - 60_000 })]);
}

let n = 0;
const person = () => ({ source: "purchase" as const, email: `buyer${(n += 1)}@example.com`, name: "Dana Reyes-Longname", products, consent: true, seed: `cs_test_costsync_${n}`, at: Date.now() });

async function main(): Promise<void> {
  redis.clear();

  part("1. Queued, and tried at once: every tag new to the platform");
  connect("a");
  platform.fail = false;
  const first = await measured(() => queuePerson(store, person()));
  console.log(`  queued and tried: ${first.commands} commands, ${first.bytes} bytes, ${first.calls} platform calls`);
  is("it was tried at once (the platform was called)", first.calls > 0, true);

  part("2. Queued, and the first try refused: the retry waits on the queue");
  connect("b");
  platform.fail = true;
  const refused = await measured(() => queuePerson(store, person()));
  console.log(`  queued, first try refused: ${refused.commands} commands, ${refused.bytes} bytes, ${refused.calls} calls`);
  is("a retry is waiting", (redis.run(["ZCARD", QUEUE_KEY]) as number) >= 1, true);

  part("3. Each retry of the five-minute job, refused, and the last one taking every new tag");
  const later = Date.now() + 2 * 86_400_000;
  const retry = await measured(() => syncDue(later + 60_000, later));
  console.log(`  a refused retry: ${retry.commands} commands, ${retry.bytes} bytes, ${retry.calls} calls`);
  platform.fail = false;
  const last = await measured(() => syncDue(later + 4 * 86_400_000 + 60_000, later + 4 * 86_400_000));
  console.log(`  the last retry, every tag new: ${last.commands} commands, ${last.bytes} bytes, ${last.calls} calls`);
  is("the last retry ran", last.calls > 0, true);

  part("4. The registry prices a person at least at the worst measured");
  // The first try at its dearest (part 1), then every other try at the dearest retry measured.
  const worstCommands = Math.max(first.commands, refused.commands) + (MAX_ATTEMPTS - 1) * Math.max(retry.commands, last.commands);
  const worstBytes = Math.max(first.bytes, refused.bytes) + (MAX_ATTEMPTS - 1) * Math.max(retry.bytes, last.bytes);
  console.log(`  worst person: ${worstCommands} commands, ${worstBytes} bytes over ${MAX_ATTEMPTS} tries; priced at ${EMAIL_SYNC_PERSON.commands} commands, ${EMAIL_SYNC_PERSON.bytes} bytes`);
  is("commands inside the priced figure", worstCommands <= EMAIL_SYNC_PERSON.commands, true);
  is("bytes inside the priced figure", worstBytes <= EMAIL_SYNC_PERSON.bytes, true);
  is("every try priced", EMAIL_SYNC_PERSON.tries >= MAX_ATTEMPTS && MAX_ATTEMPTS === RETRY_MINUTES.length + 1, true);
  is("the person's cost counts every command and byte", EMAIL_SYNC_PERSON_COST >= worstCommands * COMMAND + worstBytes * DB_BYTE, true);
  console.log(`  a person: $${EMAIL_SYNC_PERSON_COST.toFixed(6)}; left of an order's compute beside the cart's stock work: $${((1 - CART_STOCK_SHARE_OF_ORDER_COMPUTE) * ORDER_COMPUTE).toFixed(6)}`);
  is("it does not fit in what is left of an order's compute, so it is counted on its own", EMAIL_SYNC_PERSON_COST > (1 - CART_STOCK_SHARE_OF_ORDER_COMPUTE) * ORDER_COMPUTE, true);
  is("in every order's cost (an order or a free copy hands over one person)", ORDER_COST >= ORDER_COMPUTE + EMAIL_SYNC_PERSON_COST, true);
  is("in every access email's cost (a confirmed sign-up was one)", UNIT_COST.transactional >= EMAIL_SYNC_PERSON_COST, true);
  done();
}

main();
