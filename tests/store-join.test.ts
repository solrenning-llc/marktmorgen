/**
 * The sign-up box on a store page (lib/store-join.ts; added 9 October 2026).
 * Linktree, Stan and Beacons all have an email sign-up block; this one keeps
 * the list clean. Checked:
 *
 *   - the box only takes sign-ups when the creator switched it on;
 *   - a sign-up emails a confirmation in the store's language and adds
 *     nothing to the list until the button is pressed;
 *   - pressed, the address joins as someone who agreed, and the link is
 *     used up, so a forwarded email cannot sign anybody else up;
 *   - a link for another store does nothing here;
 *   - one inbox cannot be flooded through the form;
 *   - the settings are kept safe.
 */
import { claimHandle, ensureListId, ensureStatsId, parseJoin, setJoin, setSubscription, storeForEmail } from "@/lib/store";
import { HOUSE_OWNER } from "@/lib/house-store";
import { askToJoin, confirmJoin, joinOpen, readJoinToken } from "@/lib/store-join";
import { leadsKey, parseContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string };
const single: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/join\?token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_join_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const origin = "https://marktmorgen.com";
  const fresh = async () => (await storeForEmail("owner@example.com"))!;

  part("Only when switched on");
  let store = await fresh();
  is("a new store has no box", [store.join, joinOpen(store)], [{ on: false, heading: "", line: "", recommend: [] }, false]);
  is("and takes no sign-ups", await askToJoin({ store, email: "dana@example.com", ip: "1.1.1.1", origin }), "closed");
  is("switched on without a subscription in good standing, it still takes none", await setJoin("owner@example.com", { on: true }).then((s) => joinOpen(s!)), false);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  await setJoin("owner@example.com", { on: true, heading: "  Weekly   recipes  ", line: "One email on Sundays." });
  store = await fresh();
  is("switched on, with the creator's words tidied", [joinOpen(store), store.join.heading, store.join.line], [true, "Weekly recipes", "One email on Sundays."]);

  is("never on the demo store, which writes to nobody", joinOpen({ ...store, email: HOUSE_OWNER }), false);

  part("A sign-up is confirmed by email before it counts");
  is("a typo is refused before anything is sent", await askToJoin({ store, email: "dana@", ip: "1.1.1.1", origin }), "email");
  is("a real one is sent a confirmation", await askToJoin({ store, email: "Dana@Example.com", ip: "1.1.1.1", origin }), "sent");
  const mail = single.at(-1)!;
  const token = tokenIn(mail.text);
  is("to that address, from the store, with a link to the store's join page", [mail.subject, Boolean(token), mail.text.includes(`${origin}/@harbor/join?token=`)], ["Confirm: emails from Harbor Kitchen", true, true]);
  const listed = async () => parseContact(redis.run(["HGET", leadsKey(store.listId!), "dana@example.com"]));
  is("nothing is on the list yet", await listed(), null);

  part("Pressed, it joins, and the link is used up");
  const confirmed = await confirmJoin(token, store);
  is("it joins as someone who agreed", [confirmed.ok, (await listed())?.agreed], [true, true]);
  is("the same link does nothing a second time", [await readJoinToken(token), (await confirmJoin(token, store)).ok], [null, false]);

  part("A link for another store does nothing here");
  await claimHandle("other@example.com", "other", "Other", "");
  await ensureStatsId("other@example.com");
  await ensureListId("other@example.com");
  await askToJoin({ store, email: "eli@example.com", ip: "1.1.1.2", origin });
  const elsewhere = tokenIn(single.at(-1)!.text);
  is("refused", (await confirmJoin(elsewhere, (await storeForEmail("other@example.com"))!)).ok, false);

  part("Nobody's inbox can be flooded through it");
  const results: string[] = [];
  for (let i = 0; i < 6; i++) results.push(await askToJoin({ store, email: "fay@example.com", ip: `2.2.2.${i}`, origin }));
  is("five an hour for one inbox, from anywhere", results, ["sent", "sent", "sent", "sent", "sent", "limited"]);

  part("A confirmation is sent only after its token is saved");
  const run = redis.run.bind(redis);
  try {
    for (const [index, acknowledgment] of [undefined, null, false, 0, "", "ok"].entries()) {
      let refusedKey = "";
      redis.run = (command) => {
        if (command[0] === "SET" && String(command[1]).startsWith("nl:join:t:")) {
          refusedKey = String(command[1]);
          return acknowledgment;
        }
        return run(command);
      };
      const before = single.length;
      is("an unconfirmed token write reports an error", await askToJoin({ store, email: `unsaved${index}@example.com`, ip: `3.3.3.${index}`, origin }), "error");
      is("no unusable confirmation email is sent", single.length, before);
      is("the missing grant was actually exercised", [Boolean(refusedKey), run(["GET", refusedKey])], [true, null]);
    }
  } finally {
    redis.run = run;
  }
  is("a later confirmed write still sends its confirmation", await askToJoin({ store, email: "saved-again@example.com", ip: "3.3.4.1", origin }), "sent");
  is("that confirmation has a readable grant", (await readJoinToken(tokenIn(single.at(-1)!.text)))?.e, "saved-again@example.com");

  part("Settings kept safe");
  is("anything else is off with no words", parseJoin({ on: "yes", heading: 5 }), { on: false, heading: "", line: "" });
  is("long words are cut to size", [parseJoin({ heading: "x".repeat(99) }).heading.length, parseJoin({ line: "y".repeat(999) }).line.length], [60, 200]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
