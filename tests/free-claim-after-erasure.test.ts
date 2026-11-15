/**
 * #4683: a free copy request admitted before a person's erasure never writes
 * the claim (with their address) or its erasure note after the erasure has
 * finished: the claim is written only where the person is not suppressed, in
 * one step with its note. Synthetic only: the Redis stub and a stand-in mailer.
 */
import { readListing } from "@/lib/catalog";
import { forgetNoted } from "@/lib/erasure-index";
import { requestCopy } from "@/lib/free";
import { suppressCommand } from "@/lib/suppression";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async () => Response.json({ id: "email_1" })) as typeof fetch;

const owner = "owner@example.com";
const buyer = "buyer@example.com";
const real = redis.pipeline.bind(redis);
let erase: (() => Promise<void>) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  // The claim's write, whatever command carries it: the erasure runs just before it reaches Redis.
  if (erase && commands.some((c) => c.some((arg) => String(arg).startsWith("nl:free:claim:")))) {
    const run = erase;
    erase = null;
    await run();
  }
  return real(commands);
}) as typeof redis.pipeline;

const claims = async () => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:free:claim:"));

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId({ email: owner } as never).catch(() => null);
  await setSubscription(owner, { customerId: "cus_Free0001", subscriptionId: "sub_Free0001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pantry Guide", "", "0", null);
  if (!made.ok) throw new Error("setup");
  await setProductLink(owner, made.product.id, "https://example.com/pantry-guide.pdf");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;

  part("Erasure completes after admission but before the free claim is stored");
  erase = async () => {
    await real([suppressCommand(store.listId as string, buyer)]);
    await forgetNoted(store.statsId, buyer);
  };
  await requestCopy({ store, product, email: buyer, consent: false, ip: "192.0.2.1", origin: "https://example.com" });
  is("no email-bearing free claim is recreated", await claims(), []);
  is("a repeat erasure finds nothing that the completed one missed", await forgetNoted(store.statsId, buyer), 0);

  part("Without an erasure, the claim and its note are written as before");
  const other = "reader@example.com";
  await requestCopy({ store, product, email: other, consent: false, ip: "192.0.2.2", origin: "https://example.com" });
  is("one claim kept", (await claims()).length, 1);
  is("and an erasure finds it through its note", await forgetNoted(store.statsId, other), 1);

  part("A person deleted before may ask again: the mark found at the start is no refusal");
  const back = "returning@example.com";
  await real([suppressCommand(store.listId as string, back)]);
  const answer = await requestCopy({ store, product, email: back, consent: true, ip: "192.0.2.3", origin: "https://example.com" });
  is("asked again: the same answer as anybody's", answer, await requestCopy({ store, product, email: "first-time@example.com", consent: true, ip: "192.0.2.4", origin: "https://example.com" }));
  is("and their claim is kept beside the other one, for the link to lift the mark with their yes", (await claims()).length, 2);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
