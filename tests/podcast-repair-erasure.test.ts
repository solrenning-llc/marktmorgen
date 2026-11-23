/**
 * A feed's index found without its grant is repaired by writing the grant again (withGrant, lib/podcast-access.ts).
 * That repair reads the index first: when the person's deletion (forgetPodcastPerson takes the index and the grant in
 * one DEL) lands between the read and the write, the write must not put back a grant holding their address that no
 * index leads to any more, which a later deletion could never find (#3968, Codex L). The grant is written again only
 * while its index is still there (ORDER_WRITE_IF_KEY, lib/order-data.ts). Control: a live repair still works.
 *
 * Synthetic only: an in-memory Redis, no provider.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, forgetPodcastPerson } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const OWNER = "podcast-repair-erasure@example.test";
const EMAIL = "listener@example.test";
const original: Pipeline = redis.pipeline.bind(redis);

async function world() {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podrepair", "Podcast Repair", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodRepair", subscriptionId: "sub_PodRepair", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  const store = (await storeForEmail(OWNER))!;
  // An index left without its grant, as the two separate writes before #4471 could leave it.
  const address = createHash("sha256").update(`nimbus-podcast:${EMAIL}`).digest("hex").slice(0, 32);
  await original([["SET", `nl:pod:by:${store.statsId}:${made.product.id}:${address}`, randomBytes(24).toString("hex")]]);
  return { id: made.product.id, store };
}

const grants = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:"));
const indexes = () => redis.keys().filter((k) => k.startsWith("nl:pod:by:"));
const isGrantWrite = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && c.some((x) => String(x).startsWith("nl:pod:t:")));

test("a deletion between the repair's read and its write leaves no grant behind", async () => {
  const { id, store } = await world();
  let fired = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!fired && isGrantWrite(commands)) {
      fired = true;
      await forgetPodcastPerson(store, [id], EMAIL);
    }
    return original(commands);
  }) as Pipeline;
  let link: string | null;
  try {
    link = await feedToken(store, id, EMAIL).catch(() => null);
  } finally {
    redis.pipeline = original;
  }
  assert.ok(fired, "the repair reached its write");
  assert.equal(link, null, "no link is handed out to a feed that was deleted");
  assert.deepEqual(indexes(), [], "the index stays deleted");
  assert.deepEqual(grants(), [], "no grant holding the address is written back");
  assert.equal(await forgetPodcastPerson(store, [id], EMAIL), 0, "a later deletion finds nothing left");
});

test("control: with no deletion, the repair writes the grant and hands out the indexed token", async () => {
  const { id, store } = await world();
  const indexed = (await original([["GET", indexes()[0]]]))[0];
  const link = await feedToken(store, id, EMAIL);
  assert.equal(link, indexed);
  assert.equal(grants().length, 1);
});
