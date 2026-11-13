/**
 * A person's data copy (lib/person-copy.ts) holds every payment request the store keeps
 * for them, as their erasure deletes it: read from the person's own set. Before, the copy
 * read only the store's newest requests up to its current plan's kept figure (20 once a
 * plan has ended or in a trial) and filtered them by address, so a request kept for its
 * days fell out of the copy as soon as newer ones for other people pushed it past that
 * figure, while the erasure still found and deleted it. Synthetic data only.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_x";
const LINE = { text: "Coaching", quantity: 1, amount: "480" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const draft = (email: string, now: number) => (readDraft({ email, name: "X", lines: [LINE], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as any).draft;
const copy = COPIERS["lib/payment-request-store.ts"];

async function main(): Promise<void> {
  redis.clear();
  const owner = "owner@example.com";
  await claimHandle(owner, "reqshop", "Req Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1Reqreqshopxx", true);
  const at = Math.floor(Date.now() / 1000);
  const period = { start: at - 864_000, end: at + 1_728_000, renews: true };
  await setSubscription(owner, { customerId: "cus_reqshopabc", subscriptionId: "sub_reqshopabc", active: true, tier: "pro", period });
  let store = (await storeForEmail(owner))!;
  const now = Date.now();
  const ada = await createRequest(store, draft("ada@example.com", now - 5 * 86_400_000), now - 5 * 86_400_000);
  is("Ada's request is kept", ada.ok, true);
  let others = 0;
  for (let i = 0; i < 25; i += 1) if ((await createRequest(store, draft(`p${i}@example.com`, now - 1000), now - 1000)).ok) others += 1;
  is("newer requests for other people", others, 25);

  const whileRunning = await copy((await erasureScope(store, "ada@example.com"))!);
  is("in her copy while the plan runs", whileRunning.length, 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await setSubscription(owner, { customerId: "cus_reqshopabc", subscriptionId: "sub_reqshopabc", active: false, tier: "pro", period: { start: at - 864_000, end: at - 10, renews: false } } as any);
  store = (await storeForEmail(owner))!;
  const ended = await copy((await erasureScope(store, "ada@example.com"))!);
  is("still in her copy once the plan has ended", ended.length, 1);
  is("and it is hers", ended.map((r) => (r as { email: string }).email), ["ada@example.com"]);

  const nobody = await copy((await erasureScope(store, "zed@example.com"))!);
  is("nobody else's request is in a copy", nobody, []);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
