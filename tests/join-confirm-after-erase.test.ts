/**
 * A sign-up confirmation pressed before the person was deleted from the store,
 * but written after (Codex L's HIGH, Defect 4219): the button was pressed, the
 * link read, then the store deleted the person (lib/person-erasure.ts writes the
 * deleted mark first), and only then was the contact written. The yes was
 * stamped with the moment of that write, after the deletion, so it counted as
 * their own yes given since: the address came back as someone who may be
 * written to, and the deleted mark was lifted. A yes counts from the moment the
 * button was pressed; one pressed before the deletion is never written after it.
 * The same for a waitlist spot whose box asked to join the list (confirmSpot).
 * Synthetic in-memory Redis and a test clock only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, setSoon } from "@/lib/waitlist";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { askToJoin, confirmJoin } from "@/lib/store-join";
import { leadsKey, parseContact } from "@/lib/contacts";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const RealDate = Date;
let fakeNow: number | null = null;
class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow ?? RealDate.now());
    else super(...(args as [string | number]));
  }
  static now(): number {
    return fakeNow ?? RealDate.now();
  }
}
globalThis.Date = TestDate as DateConstructor;

const single: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as { text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin("owner@example.com", { on: true });
  const store = (await storeForEmail("owner@example.com"))!;
  const listId = store.listId!;
  const origin = "https://marktmorgen.com";
  const row = (email: string) => parseContact(redis.run(["HGET", leadsKey(listId), email]));
  const marked = (email: string) => redis.run(["HEXISTS", suppressedKey(listId), suppressionPrint(listId, email)]);

  // The store deletes the person right after the link was read: the mark, on Redis's clock, two seconds after the
  // press; the write that follows runs five seconds after it.
  const pressThenErase = async (email: string, isLinkRead: (c: (string | number)[]) => boolean, press: () => Promise<unknown>) => {
    const pressed = RealDate.now();
    fakeNow = pressed;
    const pipeline = redis.pipeline.bind(redis);
    let erased = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      if (!erased && commands.some((c) => c[0] === "GET" && isLinkRead(c))) {
        erased = true;
        await pipeline([suppressCommand(listId, email, Math.floor(pressed / 1000) + 2)]);
        fakeNow = pressed + 5000;
      }
      return replies;
    }) as typeof redis.pipeline;
    try {
      await press();
    } finally {
      redis.pipeline = pipeline;
      fakeNow = null;
    }
    return erased;
  };

  part("Pressed before the deletion, written after it: nothing comes back");
  const email = "dana@example.com";
  await askToJoin({ store, email, ip: "1.1.1.1", origin });
  const token = tokenIn(single.at(-1)!.text);
  is("the deletion did land between the read and the write", await pressThenErase(email, (c) => String(c[1]).startsWith("nl:join:t:"), () => confirmJoin(token, store)), true);
  is("the address is not put back on the list", row(email), null);
  is("and the deleted mark stays", marked(email), 1);

  part("A sign-up asked for and pressed after the deletion still joins");
  const again = "eli@example.com";
  await redis.pipeline([suppressCommand(listId, again, Math.floor(RealDate.now() / 1000) - 60)]);
  await askToJoin({ store, email: again, ip: "1.1.1.2", origin });
  const fresh = await confirmJoin(tokenIn(single.at(-1)!.text), store);
  is("their own yes, given since, puts them back as someone who agreed", [fresh.ok, row(again)?.agreed], [true, true]);
  is("and lifts the mark", marked(again), 0);

  part("The same for a waitlist spot that asked to join the list");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const withProduct = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(withProduct, made.product.id))!;
  await setSoon(withProduct, product.id, true);
  const waiting = "fay@example.com";
  is("they join the waitlist, box checked", await joinWaitlist({ store: withProduct, product, email: waiting, consent: true, ip: "1.1.1.3", origin }), "sent");
  const spot = tokenIn(single.at(-1)!.text);
  is("the deletion lands between the read and the write", await pressThenErase(waiting, (c) => c[1] === waitlistTokenKey(spot), () => confirmSpot(spot, withProduct)), true);
  is("the address is not put on the list", row(waiting), null);
  is("and the deleted mark stays", marked(waiting), 1);

  done();
}

void main();
