/**
 * A membership import's invitation is marked kept by the paid thank-you page, the checkout sweep or the reminder job
 * (lib/move-members.ts noteKept), which reads the invitation and writes it back with `kept`. A person's erasure
 * (forgetInvitesPerson) that deletes the invitation while that write waits must leave it deleted: the old row holds the
 * buyer's address, their link token and the membership, with no expiry (#4668, Codex L). The write is made only over
 * the invitation as read (HASH_SWAP_IF). Controls: a live invitation is marked kept and its reminder dropped; one
 * already kept is left alone. Every store, person and identifier here is a synthetic stand-in.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { forgetInvitesPerson, inviteField, noteKept, readInvite } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "move-kept-owner@example.com";
const BUYER = "pending-invite@example.com";
const PRODUCT = "p_member_plan01";

async function shop(): Promise<Store> {
  redis.clear();
  const claimed = await claimHandle(OWNER, "move-kept", "Move kept shop", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

/** An invitation as inviteMembers writes it: not kept yet, with its reminder due. */
async function invited(store: Store, kept = 0): Promise<string> {
  const field = inviteField(BUYER, PRODUCT);
  const at = Math.floor(Date.now() / 1000);
  const invite = { e: BUYER, p: PRODUCT, o: "", r: at + 20 * 86_400, job: "synthetic-import", at, t: "8789f3b5ba133e7beb519ec335dbf678296fe0ed", kept };
  await redis.pipeline([
    ["HSET", `nl:mv:${store.statsId}`, field, JSON.stringify(invite)],
    ["ZADD", "nl:mv:due", String(at + 3 * 86_400), `${store.sid}|${field}`],
  ]);
  return field;
}

const row = async (store: Store, field: string) => (await redis.pipeline([["HGET", `nl:mv:${store.statsId}`, field]]))[0];
const due = async (store: Store, field: string) => (await redis.pipeline([["ZSCORE", "nl:mv:due", `${store.sid}|${field}`]]))[0];

/** Runs `during` once, just before noteKept's write reaches Redis, as an erasure landing between its read and write. */
function beforeWrite(statsId: string, during: () => Promise<unknown>): () => void {
  const pipeline = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const writes = commands.some((c) => (c[0] === "HSET" || c[0] === "EVAL") && c.includes(`nl:mv:${statsId}`));
    if (!fired && writes) {
      fired = true;
      await during();
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = pipeline as typeof redis.pipeline;
  };
}

async function main(): Promise<void> {
  part("a person erased while the invitation is being marked kept is not written back");
  {
    const store = await shop();
    const field = await invited(store);
    const restore = beforeWrite(store.statsId!, () => forgetInvitesPerson(store, [PRODUCT], BUYER));
    try {
      await noteKept(store, BUYER, PRODUCT);
    } finally {
      restore();
    }
    is("the invitation stays deleted", await row(store, field), null);
    is("its reminder stays deleted", await due(store, field), null);
    is("readInvite finds nothing", await readInvite(store.statsId!, field), null);
  }

  part("control: a live invitation is marked kept and its reminder dropped");
  {
    const store = await shop();
    const field = await invited(store);
    await noteKept(store, BUYER, PRODUCT, 1_800_000_000_000);
    is("kept is the time it was marked", (await readInvite(store.statsId!, field))?.kept, 1_800_000_000);
    is("the reminder is gone", await due(store, field), null);
  }

  part("control: an invitation already kept is left as it is");
  {
    const store = await shop();
    const field = await invited(store, 1_700_000_000);
    const before = await row(store, field);
    await noteKept(store, BUYER, PRODUCT);
    is("the row is unchanged", await row(store, field), before);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
