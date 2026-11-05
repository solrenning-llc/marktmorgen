/** Independent review evidence for #1898/7478983d. All identities and HTTP are synthetic. */
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { rememberBuyers, storesBoughtFrom, MAX_LIBRARY_STORES } from "@/lib/buyer-library";
import { requestManageLink } from "@/lib/membership-manage";
import { BUYER_HELP } from "@/lib/buyer-help";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_leave_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_library_only_a_stand_in";
  redis.clear();
  let captured: { from?: string; reply_to?: string } | undefined;
  let unexpected = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com") {
      if (url.pathname.endsWith("/customers")) return Response.json({ data: [{ id: "cus_Member000001", created: 1 }], has_more: false });
      if (url.pathname.endsWith("/subscriptions")) return Response.json({ data: [{ status: "active", metadata: { store: "help-review0" }, created: 1 }], has_more: false });
    }
    if (url.hostname === "api.resend.com") {
      captured = JSON.parse(String(init?.body));
      return Response.json({ id: "email_synthetic" });
    }
    unexpected++;
    throw new Error("No outside service is used by this proof");
  }) as typeof fetch;

  const recorded: string[] = [];
  for (let i = 0; i < MAX_LIBRARY_STORES + 1; i++) {
    const owner = `help-review${i}@example.test`;
    const made = await claimHandle(owner, `help-review${i}`, "Synthetic help store", "");
    if (!made.ok) throw new Error("Synthetic store could not be created");
    await ensureStoreId(owner);
    const store = (await storeForEmail(owner))!;
    recorded.push(store.sid);
    await rememberBuyers(store.sid, ["buyer@example.test"]);
  }
  const listed = await storesBoughtFrom("buyer@example.test");
  is("all synthetic purchases were recorded", recorded.length, MAX_LIBRARY_STORES + 1);
  is("the real library reader is bounded", listed.length, MAX_LIBRARY_STORES);
  const allStoresClaim = BUYER_HELP.find((item) => item.id === "find")!.a.some((text) => text.includes("every store"));
  is("help does not promise every store when the real reader omits a recorded store", !allStoresClaim || listed.length === recorded.length, true);

  const owner = "help-review0@example.test";
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const store = (await storeForEmail(owner))!;
  const outcome = await requestManageLink({ store, email: "buyer@example.test", ip: "203.0.113.1", origin: "https://marktmorgen.com" });
  is("the real membership-link code sends its actual message through synthetic HTTP", [outcome, Boolean(captured)], ["sent", true]);
  const anyMailClaim = BUYER_HELP.find((item) => item.id === "contact")!.a.some((text) => text.includes("any email"));
  const replyAddress = captured?.reply_to ?? captured?.from ?? "";
  is("a universal reply-to-creator promise covers this real store message", !anyMailClaim || replyAddress.includes(owner), true);
  is("nothing reached an outside service", unexpected, 0);
  done();
}
void main();
