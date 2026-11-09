/**
 * The buyer help (lib/buyer-help.ts) promises only what the code does
 * (Codex L on #1898, C3-132), against the in-memory Redis double and
 * synthetic HTTP only:
 *
 *   - the library lists the stores bought from up to MAX_LIBRARY_STORES, so
 *     the help never says "every store" and says the real reach;
 *   - an email that reaches the store when replied to is only the order
 *     confirmation (its replyTo is the store's address); a sign-in link for
 *     the orders or a membership comes from the site with no replyTo, so the
 *     help never says a reply to "any email" reaches the creator.
 */
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { MAX_LIBRARY_STORES, rememberBuyers, storesBoughtFrom } from "@/lib/buyer-library";
import { requestManageLink } from "@/lib/membership-manage";
import { BUYER_HELP } from "@/lib/buyer-help";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_help_promises_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_leave_only_a_stand_in";
  redis.clear();
  let captured: { from?: string; reply_to?: string } | undefined;
  let unexpected = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com") {
      // Each customer row with its own address, the one asked for, as Stripe's exact filter gives it (rule 23: fixture only; findMembers counts a customer only when its own address is the one typed, ignoring capitals, since manage-email-case).
      if (url.pathname.endsWith("/customers")) return Response.json({ data: [{ id: "cus_Member000001", created: 1, email: url.searchParams.get("email") }], has_more: false });
      // Each row with its id, as Stripe gives it (rule 23: fixture only; findMember reads lists exactly since sweep APP2).
      if (url.pathname.endsWith("/subscriptions")) return Response.json({ data: [{ id: "sub_Member0000001", status: "active", metadata: { store: "help-promise0" }, created: 1 }], has_more: false });
    }
    if (url.hostname === "api.resend.com") {
      captured = JSON.parse(String(init?.body));
      return Response.json({ id: "email_synthetic" });
    }
    unexpected += 1;
    throw new Error("No outside service in this test");
  }) as typeof fetch;
  const all = (item: string) => BUYER_HELP.find((entry) => entry.id === item)!.a.join(" ");

  part("The library's reach, as the help says it");
  const recorded: string[] = [];
  for (let i = 0; i < MAX_LIBRARY_STORES + 1; i += 1) {
    const owner = `help-promise${i}@example.test`;
    const made = await claimHandle(owner, `help-promise${i}`, "Synthetic help store", "");
    if (!made.ok) throw new Error("no synthetic store");
    await ensureStoreId(owner);
    const store = (await storeForEmail(owner))!;
    recorded.push(store.sid);
    await rememberBuyers(store.sid, ["buyer@example.test"]);
  }
  const listed = await storesBoughtFrom("buyer@example.test");
  is("(one store more than the library lists, recorded)", [recorded.length, listed.length], [MAX_LIBRARY_STORES + 1, MAX_LIBRARY_STORES]);
  is("the help never promises every store", all("find").includes("every store"), false);
  is("it says the real reach, and the store's own orders page for the rest", [all("find").includes(`up to the ${MAX_LIBRARY_STORES} most recent`), all("find").includes("/orders")], [true, true]);

  part("Which replies reach the creator, as the help says it");
  const owner = "help-promise0@example.test";
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const store = (await storeForEmail(owner))!;
  const outcome = await requestManageLink({ store, email: "buyer@example.test", ip: "203.0.113.1", origin: "https://marktmorgen.com" });
  is("(the real membership-link email went, through synthetic HTTP)", [outcome, Boolean(captured)], ["sent", true]);
  is("it carries no reply-to of the store's", (captured?.reply_to ?? "").includes(owner), false);
  is("so no answer promises a reply to any email reaches them", BUYER_HELP.some((entry) => entry.a.some((text) => /any email/i.test(text))), false);
  is("the contact answer names the order confirmation, and says the sign-in emails do not reach the store", [all("contact").includes("Reply to the order confirmation"), all("contact").includes("A reply to those does not reach the store.")], [true, true]);
  is("nothing reached an outside service", unexpected, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
