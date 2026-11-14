/**
 * Joining a waitlist reads two things before it keeps an address (rule 24):
 * whether the address is already on the list (HGET) and how long the list is
 * (HLEN), against MAX_WAITLIST. Both were read loosely: a length that came
 * back in another shape became NaN, and `NaN >= MAX_WAITLIST` is false, so an
 * unknown length was taken for "room left" and the address was kept and
 * emailed past the cap; a place that came back in another shape was taken for
 * "not on the list", so a confirmed place was written over as a fresh,
 * unconfirmed one (its confirmation lost) and a second confirm email went out.
 *
 * Now either unknown read answers "error": nothing is kept, nothing is
 * written over and no email goes out. Controls: a known length under the cap
 * still takes the address and sends one email; a known length at the cap still
 * answers "full"; an address already on the list is still emailed again with
 * its place kept as it was. Synthetic data; no provider is called.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { MAX_WAITLIST } from "@/lib/waitlist-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    mails += 1;
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_harbor", subscriptionId: "sub_harbor", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  await setSoon((await storeForEmail(OWNER))!, made.product.id, true);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  const list = `nl:wl:${store.statsId}:${product.id}`;
  let ip = 0;
  const join = (email: string) => joinWaitlist({ store, product, email, consent: false, ip: `10.0.0.${++ip}`, origin: "https://marktmorgen.com" });

  const real = redis.pipeline.bind(redis);
  /** Answers the join's HGET + HLEN read with `shape(real replies)`; everything else as it is. */
  const answering = (shape: (replies: unknown[]) => unknown[]) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      return commands[0]?.[0] === "HGET" && commands[1]?.[0] === "HLEN" ? shape(replies) : replies;
    }) as typeof redis.pipeline;
  };
  const restore = () => {
    redis.pipeline = real;
  };

  part("Control: a known length under the cap takes the address");
  mails = 0;
  is("sent", await join("first@example.com"), "sent");
  is("one email", mails, 1);
  is("kept", typeof redis.run(["HGET", list, "first@example.com"]), "string");

  part("An unknown length is never read as room on the list");
  for (const [label, length] of [["no reply", undefined], ["a word", "OK"], ["a list", [3]], ["a negative number", -1], ["a fraction", 1.5]] as [string, unknown][]) {
    mails = 0;
    const email = `size-${label.replace(/\W/g, "")}@example.com`;
    answering((replies) => [replies[0], length]);
    const result = await join(email);
    restore();
    is(`(${label}) answered as an error`, result, "error");
    is(`(${label}) no email`, mails, 0);
    is(`(${label}) nothing kept`, redis.run(["HGET", list, email]), null);
  }

  part("An unknown place is never read as \"not on the list\"");
  const confirmed = JSON.stringify({ at: 1, ok: 2, c: true, t: "a".repeat(48) });
  redis.run(["HSET", list, "kept@example.com", confirmed]);
  for (const [label, place] of [["a number", 7], ["a list", ["x"]], ["no reply", undefined]] as [string, unknown][]) {
    mails = 0;
    answering((replies) => [place, replies[1]]);
    const result = await join("kept@example.com");
    restore();
    is(`(${label}) answered as an error`, result, "error");
    is(`(${label}) no email`, mails, 0);
    is(`(${label}) the confirmed place is not written over`, redis.run(["HGET", list, "kept@example.com"]), confirmed);
  }

  part("Control: an address already on the list is emailed again, its place kept");
  mails = 0;
  is("sent", await join("kept@example.com"), "sent");
  is("one email", mails, 1);
  const again = JSON.parse(String(redis.run(["HGET", list, "kept@example.com"]))) as { ok: number; at: number };
  is("still confirmed, same join time", [again.ok, again.at], [2, 1]);

  part("Control: a known length at the cap answers full");
  mails = 0;
  answering((replies) => [replies[0], MAX_WAITLIST]);
  const full = await join("late@example.com");
  restore();
  is("full", full, "full");
  is("no email", mails, 0);
  is("nothing kept", redis.run(["HGET", list, "late@example.com"]), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
